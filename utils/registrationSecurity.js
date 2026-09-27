const crypto = require('crypto');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const RegistrationRateLimit = require('../models/RegistrationRateLimit');

const HCAPTCHA_VERIFY_URL = 'https://hcaptcha.com/siteverify';
const GENERIC_CAPTCHA_ERROR = 'We could not verify this registration request. Please complete the CAPTCHA and try again.';
const RATE_LIMIT_ERROR = 'Too many registration attempts. Please try again later.';

class RegistrationSecurityError extends Error {
    constructor(message, code, statusCode) {
        super(message);
        this.name = 'RegistrationSecurityError';
        this.code = code;
        this.statusCode = statusCode;
    }
}

function positiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function registrationRateLimitConfig(env = process.env) {
    return {
        // Five account-creation attempts per IP per hour is intentionally low:
        // each request can create a database record and send an OTP email.
        limit: positiveInteger(env.REGISTER_RATE_LIMIT_MAX, 5, { min: 1, max: 100 }),
        windowMs: positiveInteger(env.REGISTER_RATE_LIMIT_WINDOW_MS, 60 * 60 * 1000, {
            min: 60 * 1000,
            max: 24 * 60 * 60 * 1000
        })
    };
}

function captchaConfig(env = process.env) {
    return {
        provider: String(env.CAPTCHA_PROVIDER || 'hcaptcha').trim().toLowerCase(),
        siteKey: String(env.HCAPTCHA_SITE_KEY || '').trim(),
        secretKey: String(env.HCAPTCHA_SECRET_KEY || '').trim(),
        verifyUrl: String(env.HCAPTCHA_VERIFY_URL || HCAPTCHA_VERIFY_URL).trim(),
        timeoutMs: positiveInteger(env.HCAPTCHA_TIMEOUT_MS, 5000, { min: 1000, max: 15000 })
    };
}

function publicCaptchaConfig(env = process.env) {
    const { provider, siteKey, secretKey } = captchaConfig(env);
    return {
        provider,
        siteKey,
        // This value is rendered by the server, so it can safely account for
        // the secret's presence without ever sending that secret to browsers.
        configured: provider === 'hcaptcha' && Boolean(siteKey && secretKey)
    };
}

function isJsonRequest(req) {
    const accept = typeof req.get === 'function' ? req.get('accept') : req.headers?.accept;
    return Boolean(req.xhr || String(accept || '').includes('application/json'));
}

function sendRegistrationSecurityError(req, res, { statusCode, message, captcha } = {}) {
    const status = statusCode || 400;
    const safeMessage = message || GENERIC_CAPTCHA_ERROR;
    res.set('Cache-Control', 'no-store');

    if (isJsonRequest(req)) {
        return res.status(status).json({ error: safeMessage });
    }

    return res.status(status).render('auth/register', {
        captcha: captcha || publicCaptchaConfig(),
        registrationError: safeMessage
    });
}

function requestIp(req) {
    return req.ip || req.socket?.remoteAddress || 'unknown';
}

function registrationRateLimitKey(req, config, env = process.env, now = Date.now()) {
    const normalizedIp = ipKeyGenerator(requestIp(req));
    // SESSION_SECRET is already required by the application. A dedicated key
    // can be rotated independently in deployments that prefer it.
    const secret = String(env.REGISTRATION_RATE_LIMIT_SECRET || env.SESSION_SECRET || 'internpilot-registration-limit').trim();
    const fingerprint = crypto.createHash('sha256').update(`${secret}:${normalizedIp}`).digest('hex');
    const bucket = Math.floor(now / config.windowMs);
    return `${fingerprint}:${bucket}`;
}

class MongoRegistrationRateLimitStore {
    constructor({ Model = RegistrationRateLimit, windowMs, now = Date.now } = {}) {
        this.Model = Model;
        this.windowMs = windowMs || 60 * 60 * 1000;
        this.now = now;
        this.localKeys = false;
    }

    init(options = {}) {
        if (options.windowMs) this.windowMs = options.windowMs;
    }

    async increment(key) {
        const timestamp = this.now();
        const resetTime = new Date((Math.floor(timestamp / this.windowMs) + 1) * this.windowMs);
        const entry = await this.Model.findOneAndUpdate(
            { key },
            { $inc: { totalHits: 1 }, $setOnInsert: { expiresAt: resetTime } },
            { new: true, upsert: true }
        );
        return { totalHits: entry.totalHits, resetTime: entry.expiresAt };
    }

    async decrement(key) {
        await this.Model.updateOne({ key, totalHits: { $gt: 0 } }, { $inc: { totalHits: -1 } });
    }

    async resetKey(key) {
        await this.Model.deleteOne({ key });
    }

    async resetAll() {
        await this.Model.deleteMany({});
    }
}

function createRegistrationRateLimiter(options = {}) {
    const config = options.config || registrationRateLimitConfig(options.env);
    const store = options.store || new MongoRegistrationRateLimitStore({
        Model: options.Model,
        windowMs: config.windowMs,
        now: options.now
    });
    return rateLimit({
        windowMs: config.windowMs,
        limit: config.limit,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        store,
        keyGenerator: req => registrationRateLimitKey(req, config, options.env),
        handler: (req, res) => {
            const resetTime = req.rateLimit?.resetTime;
            const retryAfterSeconds = resetTime
                ? Math.max(1, Math.ceil((new Date(resetTime).getTime() - Date.now()) / 1000))
                : Math.max(1, Math.ceil(config.windowMs / 1000));
            res.set('Retry-After', String(retryAfterSeconds));
            return sendRegistrationSecurityError(req, res, {
                statusCode: 429,
                message: RATE_LIMIT_ERROR,
                captcha: publicCaptchaConfig(options.env)
            });
        }
    });
}

function captchaToken(req) {
    const token = req.body?.['h-captcha-response'];
    return typeof token === 'string' ? token.trim() : '';
}

async function verifyCaptcha({ token, remoteIp, config = captchaConfig(), fetchImpl = globalThis.fetch } = {}) {
    if (config.provider !== 'hcaptcha' || !config.siteKey || !config.secretKey) {
        throw new RegistrationSecurityError(GENERIC_CAPTCHA_ERROR, 'CAPTCHA_NOT_CONFIGURED', 503);
    }

    if (!token || token.length > 5000) {
        throw new RegistrationSecurityError(GENERIC_CAPTCHA_ERROR, 'CAPTCHA_REQUIRED', 400);
    }

    if (typeof fetchImpl !== 'function') {
        throw new RegistrationSecurityError(GENERIC_CAPTCHA_ERROR, 'CAPTCHA_UNAVAILABLE', 503);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
        const form = new URLSearchParams({
            secret: config.secretKey,
            response: token,
            sitekey: config.siteKey
        });
        if (remoteIp) form.set('remoteip', remoteIp);

        const response = await fetchImpl(config.verifyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form.toString(),
            signal: controller.signal
        });

        if (!response?.ok) {
            throw new RegistrationSecurityError(GENERIC_CAPTCHA_ERROR, 'CAPTCHA_UNAVAILABLE', 503);
        }

        // The timeout stays live through body parsing. A response that sends
        // headers but stalls its JSON body is therefore still fail-closed.
        const result = await response.json();

        if (result?.success !== true) {
            throw new RegistrationSecurityError(GENERIC_CAPTCHA_ERROR, 'CAPTCHA_REJECTED', 400);
        }

        return true;
    } catch (error) {
        if (error instanceof RegistrationSecurityError) throw error;
        throw new RegistrationSecurityError(GENERIC_CAPTCHA_ERROR, 'CAPTCHA_UNAVAILABLE', 503);
    } finally {
        clearTimeout(timeout);
    }
}

function createCaptchaVerificationMiddleware(options = {}) {
    const verifier = options.verifier || verifyCaptcha;
    const env = options.env;

    return async (req, res, next) => {
        try {
            await verifier({
                token: captchaToken(req),
                remoteIp: requestIp(req),
                config: captchaConfig(env)
            });
            return next();
        } catch (error) {
            const isSecurityError = error instanceof RegistrationSecurityError;
            return sendRegistrationSecurityError(req, res, {
                statusCode: isSecurityError ? error.statusCode : 503,
                message: GENERIC_CAPTCHA_ERROR,
                captcha: publicCaptchaConfig(env)
            });
        }
    };
}

module.exports = {
    GENERIC_CAPTCHA_ERROR,
    RATE_LIMIT_ERROR,
    RegistrationSecurityError,
    registrationRateLimitConfig,
    captchaConfig,
    publicCaptchaConfig,
    registrationRateLimitKey,
    MongoRegistrationRateLimitStore,
    createRegistrationRateLimiter,
    captchaToken,
    verifyCaptcha,
    createCaptchaVerificationMiddleware,
    sendRegistrationSecurityError
};
