const test = require('node:test');
const assert = require('node:assert/strict');
const ejs = require('ejs');
const fs = require('node:fs');
const path = require('node:path');

const authRouter = require('../routes/auth');
const {
    GENERIC_CAPTCHA_ERROR,
    RATE_LIMIT_ERROR,
    RegistrationSecurityError,
    registrationRateLimitConfig,
    publicCaptchaConfig,
    registrationRateLimitKey,
    MongoRegistrationRateLimitStore,
    createRegistrationRateLimiter,
    captchaToken,
    verifyCaptcha
} = require('../utils/registrationSecurity');

function routeLayer(router, pathName, method) {
    return router.stack.find(layer => layer.route
        && layer.route.path === pathName
        && layer.route.methods[method]);
}

test('registration rate-limit configuration is bounded and defaults to five attempts per hour', () => {
    assert.deepEqual(registrationRateLimitConfig({}), { limit: 5, windowMs: 60 * 60 * 1000 });
    assert.deepEqual(registrationRateLimitConfig({
        REGISTER_RATE_LIMIT_MAX: '8',
        REGISTER_RATE_LIMIT_WINDOW_MS: '120000'
    }), { limit: 8, windowMs: 120000 });
    assert.deepEqual(registrationRateLimitConfig({
        REGISTER_RATE_LIMIT_MAX: '0',
        REGISTER_RATE_LIMIT_WINDOW_MS: '1'
    }), { limit: 5, windowMs: 60 * 60 * 1000 });
});

test('only hCaptcha public configuration is exposed to the registration template', () => {
    const config = publicCaptchaConfig({
        HCAPTCHA_SITE_KEY: 'public-site-key',
        HCAPTCHA_SECRET_KEY: 'server-secret'
    });

    assert.deepEqual(config, { provider: 'hcaptcha', siteKey: 'public-site-key', configured: true });
    assert.equal(JSON.stringify(config).includes('server-secret'), false);
    assert.equal(publicCaptchaConfig({ HCAPTCHA_SITE_KEY: 'public-site-key' }).configured, false);
});

test('hCaptcha verification posts token and IP to the configured service', async () => {
    let request;
    await assert.doesNotReject(() => verifyCaptcha({
        token: 'signed-token',
        remoteIp: '203.0.113.42',
        config: {
            provider: 'hcaptcha',
            siteKey: 'site-key',
            secretKey: 'server-secret',
            verifyUrl: 'https://captcha.example.test/siteverify',
            timeoutMs: 1000
        },
        fetchImpl: async (url, options) => {
            request = { url, options };
            return { ok: true, json: async () => ({ success: true }) };
        }
    }));

    assert.equal(request.url, 'https://captcha.example.test/siteverify');
    assert.equal(request.options.method, 'POST');
    const form = new URLSearchParams(request.options.body);
    assert.equal(form.get('secret'), 'server-secret');
    assert.equal(form.get('response'), 'signed-token');
    assert.equal(form.get('sitekey'), 'site-key');
    assert.equal(form.get('remoteip'), '203.0.113.42');
});

test('CAPTCHA validation fails closed for missing configuration, rejected tokens, and unavailable services', async () => {
    await assert.rejects(
        () => verifyCaptcha({ token: 'token', config: { provider: 'hcaptcha', siteKey: '', secretKey: '', timeoutMs: 1000 } }),
        error => error instanceof RegistrationSecurityError
            && error.code === 'CAPTCHA_NOT_CONFIGURED'
            && error.statusCode === 503
            && error.message === GENERIC_CAPTCHA_ERROR
    );

    await assert.rejects(
        () => verifyCaptcha({
            token: 'token',
            config: { provider: 'hcaptcha', siteKey: 'site', secretKey: 'secret', verifyUrl: 'https://captcha.example.test', timeoutMs: 1000 },
            fetchImpl: async () => ({ ok: true, json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }) })
        }),
        error => error instanceof RegistrationSecurityError && error.code === 'CAPTCHA_REJECTED' && error.statusCode === 400
    );

    await assert.rejects(
        () => verifyCaptcha({
            token: 'token',
            config: { provider: 'hcaptcha', siteKey: 'site', secretKey: 'secret', verifyUrl: 'https://captcha.example.test', timeoutMs: 1000 },
            fetchImpl: async () => { throw new Error('network unavailable'); }
        }),
        error => error instanceof RegistrationSecurityError && error.code === 'CAPTCHA_UNAVAILABLE' && error.statusCode === 503
    );
});

test('CAPTCHA timeout remains active while its response body is being read', async () => {
    await assert.rejects(
        () => verifyCaptcha({
            token: 'token',
            config: {
                provider: 'hcaptcha',
                siteKey: 'site',
                secretKey: 'secret',
                verifyUrl: 'https://captcha.example.test',
                timeoutMs: 20
            },
            fetchImpl: async (_url, options) => ({
                ok: true,
                json: () => new Promise((resolve, reject) => {
                    options.signal.addEventListener('abort', () => reject(new Error('response body stalled')), { once: true });
                })
            })
        }),
        error => error instanceof RegistrationSecurityError
            && error.code === 'CAPTCHA_UNAVAILABLE'
            && error.statusCode === 503
    );
});

test('registration limit keys hash the IP and rotate with each fixed window', () => {
    const req = { ip: '203.0.113.42' };
    const config = { windowMs: 60_000 };
    const env = { REGISTRATION_RATE_LIMIT_SECRET: 'dedicated-secret' };
    const firstKey = registrationRateLimitKey(req, config, env, 125_000);

    assert.match(firstKey, /^[a-f0-9]{64}:2$/);
    assert.equal(firstKey.includes(req.ip), false);
    assert.notEqual(firstKey, registrationRateLimitKey(req, config, env, 180_000));
    assert.notEqual(firstKey, registrationRateLimitKey(req, config, { REGISTRATION_RATE_LIMIT_SECRET: 'other-secret' }, 125_000));
});

test('Mongo registration limiter increments a shared counter and sets a TTL window', async () => {
    const calls = [];
    const resetTime = new Date(180_000);
    const Model = {
        findOneAndUpdate: async (...args) => {
            calls.push(args);
            return { totalHits: 3, expiresAt: resetTime };
        },
        updateOne: async (...args) => calls.push(args),
        deleteOne: async (...args) => calls.push(args),
        deleteMany: async (...args) => calls.push(args)
    };
    const store = new MongoRegistrationRateLimitStore({ Model, windowMs: 60_000, now: () => 125_000 });

    assert.deepEqual(await store.increment('hashed-ip:2'), { totalHits: 3, resetTime });
    assert.deepEqual(calls[0], [
        { key: 'hashed-ip:2' },
        { $inc: { totalHits: 1 }, $setOnInsert: { expiresAt: resetTime } },
        { new: true, upsert: true }
    ]);

    await store.decrement('hashed-ip:2');
    await store.resetKey('hashed-ip:2');
    await store.resetAll();
    assert.deepEqual(calls.slice(1), [
        [{ key: 'hashed-ip:2', totalHits: { $gt: 0 } }, { $inc: { totalHits: -1 } }],
        [{ key: 'hashed-ip:2' }],
        [{}]
    ]);
});

test('registration limiter blocks an IP after its limit and supplies Retry-After', async () => {
    let hits = 0;
    const limiter = createRegistrationRateLimiter({
        config: { limit: 2, windowMs: 60_000 },
        store: {
            localKeys: true,
            init() {},
            async increment() {
                hits += 1;
                return { totalHits: hits, resetTime: new Date(Date.now() + 60_000) };
            },
            async decrement() {},
            async resetKey() {}
        }
    });

    const hit = () => new Promise(async (resolve, reject) => {
        const headers = {};
        const res = {
            headers,
            headersSent: false,
            setHeader(name, value) { headers[String(name).toLowerCase()] = String(value); },
            append(name, value) {
                const key = String(name).toLowerCase();
                headers[key] = headers[key] ? `${headers[key]}, ${value}` : String(value);
            },
            set(name, value) { this.setHeader(name, value); return this; },
            status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; resolve(this); },
            render(view, locals) { this.view = view; this.body = locals; resolve(this); }
        };
        const req = {
            ip: '127.0.0.1',
            socket: { remoteAddress: '127.0.0.1' },
            headers: { accept: 'application/json' },
            get(name) { return this.headers[String(name).toLowerCase()]; }
        };
        await limiter(req, res, error => error ? reject(error) : resolve(res));
    });

    assert.equal((await hit()).statusCode, undefined);
    assert.equal((await hit()).statusCode, undefined);
    const blocked = await hit();
    assert.equal(blocked.statusCode, 429);
    assert.ok(Number(blocked.headers['retry-after']) > 0);
    assert.deepEqual(blocked.body, { error: RATE_LIMIT_ERROR });
});

test('registration route applies IP limiting and CAPTCHA before the account creation handler', () => {
    const layer = routeLayer(authRouter, '/register', 'post');
    assert.ok(layer);
    assert.equal(layer.route.stack.length, 3);
    assert.equal(typeof layer.route.stack[0].handle, 'function');
    assert.equal(typeof layer.route.stack[1].handle, 'function');
});

test('registration form renders the hCaptcha widget and avoids exposing its secret', () => {
    const templatePath = path.join(__dirname, '..', 'views', 'auth', 'register.ejs');
    const template = fs.readFileSync(templatePath, 'utf8').replace("<% layout('layouts/boilerplate') %>", '');
    const html = ejs.render(template, {
        captcha: { provider: 'hcaptcha', siteKey: 'public-site-key', configured: true },
        registrationError: ''
    });

    assert.match(html, /js\.hcaptcha\.com\/1\/api\.js/);
    assert.match(html, /class="h-captcha" data-sitekey="public-site-key"/);
    assert.equal(html.includes('server-secret'), false);
    assert.equal(captchaToken({ body: { 'h-captcha-response': { $ne: '' } } }), '');

    const unavailableHtml = ejs.render(template, {
        captcha: { provider: 'hcaptcha', siteKey: 'public-site-key', configured: false },
        registrationError: ''
    });
    assert.match(unavailableHtml, /Registration is temporarily unavailable/);
    assert.match(unavailableHtml, /disabled aria-disabled="true"/);
});
