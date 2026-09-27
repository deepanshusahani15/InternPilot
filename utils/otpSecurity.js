const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_RESEND_WINDOW_MS = 60 * 60 * 1000;
const OTP_SECURITY_EVENT_LIMIT = 50;

const GENERIC_RESEND_MESSAGE = 'If an unverified account matches that email and is eligible for a new code, a verification code will be sent shortly.';
const GENERIC_VERIFICATION_ERROR = 'The verification code is invalid, expired, or unavailable. Request a new code to continue.';

function boundedInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function otpSecurityConfig(env = process.env) {
    return {
        ttlMs: OTP_TTL_MS,
        resendCooldownMs: OTP_RESEND_COOLDOWN_MS,
        resendWindowMs: OTP_RESEND_WINDOW_MS,
        maxResendsPerWindow: boundedInteger(env.OTP_RESEND_MAX_PER_HOUR, 3, { min: 1, max: 20 }),
        maxVerificationAttempts: boundedInteger(env.OTP_VERIFY_MAX_ATTEMPTS, 5, { min: 1, max: 20 })
    };
}

function normalizeEmail(value) {
    if (typeof value !== 'string') return '';
    const email = value.trim().toLowerCase();
    return /^\S+@\S+\.\S+$/.test(email) ? email : '';
}

function normalizeOtp(value) {
    return typeof value === 'string' && /^\d{6}$/.test(value.trim()) ? value.trim() : '';
}

function otpEvent(type, at = new Date()) {
    return { type, at };
}

function limitedEvents(events, event) {
    return [...(Array.isArray(events) ? events : []), event].slice(-OTP_SECURITY_EVENT_LIMIT);
}

function freshOtpState(otp, now = new Date(), config = otpSecurityConfig()) {
    const issuedAt = new Date(now);
    return {
        otp,
        otpExpires: new Date(issuedAt.getTime() + config.ttlMs),
        lastOtpSentAt: issuedAt,
        otpVerificationAttempts: 0,
        otpLastVerificationFailureAt: undefined,
        otpResendWindowStartedAt: issuedAt,
        otpResendCount: 0
    };
}

function resendEligibilityQuery(email, now = new Date(), config = otpSecurityConfig()) {
    const cooldownThreshold = new Date(now.getTime() - config.resendCooldownMs);
    const windowThreshold = new Date(now.getTime() - config.resendWindowMs);
    return {
        email,
        isEmailVerified: false,
        $and: [
            {
                $or: [
                    { lastOtpSentAt: { $exists: false } },
                    { lastOtpSentAt: null },
                    { lastOtpSentAt: { $lte: cooldownThreshold } }
                ]
            },
            {
                $or: [
                    { otpResendWindowStartedAt: { $exists: false } },
                    { otpResendWindowStartedAt: null },
                    { otpResendWindowStartedAt: { $lte: windowThreshold } },
                    { otpResendCount: { $lt: config.maxResendsPerWindow } }
                ]
            }
        ]
    };
}

function resendOtpUpdate(otp, now = new Date(), config = otpSecurityConfig()) {
    const windowThreshold = new Date(now.getTime() - config.resendWindowMs);
    const newWindow = {
        $or: [
            { $eq: [{ $ifNull: ['$otpResendWindowStartedAt', null] }, null] },
            { $lte: ['$otpResendWindowStartedAt', windowThreshold] }
        ]
    };

    return [{
        $set: {
            otp,
            otpExpires: new Date(now.getTime() + config.ttlMs),
            lastOtpSentAt: now,
            otpVerificationAttempts: 0,
            otpLastVerificationFailureAt: '$$REMOVE',
            otpResendWindowStartedAt: { $cond: [newWindow, now, '$otpResendWindowStartedAt'] },
            otpResendCount: {
                $add: [
                    { $cond: [newWindow, 0, { $ifNull: ['$otpResendCount', 0] }] },
                    1
                ]
            },
            otpSecurityEvents: {
                $slice: [
                    { $concatArrays: [{ $ifNull: ['$otpSecurityEvents', []] }, [otpEvent('otp_resent', now)]] },
                    -OTP_SECURITY_EVENT_LIMIT
                ]
            }
        }
    }];
}

function failedVerificationUpdate(now = new Date(), config = otpSecurityConfig()) {
    const nextAttempts = { $add: [{ $ifNull: ['$otpVerificationAttempts', 0] }, 1] };
    const locked = { $gte: [nextAttempts, config.maxVerificationAttempts] };
    const event = {
        type: { $cond: [locked, 'otp_invalidated_after_failures', 'otp_verification_failed'] },
        at: now
    };

    return [{
        $set: {
            otpVerificationAttempts: nextAttempts,
            otpLastVerificationFailureAt: now,
            otp: { $cond: [locked, '$$REMOVE', '$otp'] },
            otpExpires: { $cond: [locked, '$$REMOVE', '$otpExpires'] },
            otpSecurityEvents: {
                $slice: [
                    { $concatArrays: [{ $ifNull: ['$otpSecurityEvents', []] }, [event]] },
                    -OTP_SECURITY_EVENT_LIMIT
                ]
            }
        }
    }];
}

function activeOtpFailureQuery(email, otp, now = new Date(), config = otpSecurityConfig()) {
    return {
        email,
        isEmailVerified: false,
        otp: { $exists: true, $ne: otp },
        otpExpires: { $gte: now },
        $expr: { $lt: [{ $ifNull: ['$otpVerificationAttempts', 0] }, config.maxVerificationAttempts] }
    };
}

function activeOtpSuccessQuery(email, otp, now = new Date(), config = otpSecurityConfig()) {
    return {
        email,
        isEmailVerified: false,
        otp,
        otpExpires: { $gte: now },
        $expr: { $lt: [{ $ifNull: ['$otpVerificationAttempts', 0] }, config.maxVerificationAttempts] }
    };
}

function successfulOtpVerificationUpdate(now = new Date()) {
    return {
        $set: {
            isEmailVerified: true,
            otpVerificationAttempts: 0
        },
        $unset: {
            otp: 1,
            otpExpires: 1,
            lastOtpSentAt: 1,
            otpLastVerificationFailureAt: 1,
            otpResendWindowStartedAt: 1,
            otpResendCount: 1
        },
        $push: {
            otpSecurityEvents: {
                $each: [otpEvent('otp_verified', now)],
                $slice: -OTP_SECURITY_EVENT_LIMIT
            }
        }
    };
}

function resendRateLimitAuditUpdate(now = new Date()) {
    return {
        $push: {
            otpSecurityEvents: {
                $each: [otpEvent('otp_resend_rate_limited', now)],
                $slice: -OTP_SECURITY_EVENT_LIMIT
            }
        }
    };
}

module.exports = {
    OTP_TTL_MS,
    OTP_RESEND_COOLDOWN_MS,
    OTP_RESEND_WINDOW_MS,
    OTP_SECURITY_EVENT_LIMIT,
    GENERIC_RESEND_MESSAGE,
    GENERIC_VERIFICATION_ERROR,
    otpSecurityConfig,
    normalizeEmail,
    normalizeOtp,
    limitedEvents,
    freshOtpState,
    resendEligibilityQuery,
    resendOtpUpdate,
    activeOtpSuccessQuery,
    activeOtpFailureQuery,
    failedVerificationUpdate,
    successfulOtpVerificationUpdate,
    resendRateLimitAuditUpdate
};
