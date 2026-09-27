const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_RESEND_WINDOW_MS = 60 * 60 * 1000;
const OTP_SECURITY_EVENT_LIMIT = 50;

const GENERIC_RESEND_MESSAGE = 'If an unverified account matches that email and is eligible for a new code, a verification code will be sent shortly.';
const GENERIC_VERIFICATION_ERROR = 'The verification code is invalid, expired, or unavailable. Request a new code to continue.';

/**
 * Parses a bounded positive integer from configuration, falling back safely.
 * @returns {number} The accepted value or fallback.
 */
function boundedInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/**
 * Builds the configured OTP lifetime, resend, and verification limits.
 * @returns {object} Validated OTP security settings.
 */
function otpSecurityConfig(env = process.env) {
    return {
        ttlMs: OTP_TTL_MS,
        resendCooldownMs: OTP_RESEND_COOLDOWN_MS,
        resendWindowMs: OTP_RESEND_WINDOW_MS,
        maxResendsPerWindow: boundedInteger(env.OTP_RESEND_MAX_PER_HOUR, 3, { min: 1, max: 20 }),
        maxVerificationAttempts: boundedInteger(env.OTP_VERIFY_MAX_ATTEMPTS, 5, { min: 1, max: 20 })
    };
}

/**
 * Normalizes a primitive email address and rejects invalid values.
 * @returns {string} A lowercase email address or an empty string.
 */
function normalizeEmail(value) {
    if (typeof value !== 'string') return '';
    const email = value.trim().toLowerCase();
    return /^\S+@\S+\.\S+$/.test(email) ? email : '';
}

/**
 * Normalizes an exact six-digit OTP without coercing request values.
 * @returns {string} The OTP or an empty string.
 */
function normalizeOtp(value) {
    return typeof value === 'string' && /^\d{6}$/.test(value.trim()) ? value.trim() : '';
}

/**
 * Creates an audit event that deliberately excludes OTP values and IPs.
 * @returns {{type: string, at: Date}} A safe OTP security event.
 */
function otpEvent(type, at = new Date()) {
    return { type, at };
}

/**
 * Appends an event while retaining only the bounded audit history.
 * @returns {Array<object>} The retained events.
 */
function limitedEvents(events, event) {
    return [...(Array.isArray(events) ? events : []), event].slice(-OTP_SECURITY_EVENT_LIMIT);
}

/**
 * Creates initial OTP state for a newly registered account.
 * @returns {object} A fresh OTP state with cleared counters.
 */
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

/**
 * Builds the atomic eligibility filter for an OTP resend.
 * @returns {object} A query enforcing unverified status, cooldown, and quota.
 */
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

/**
 * Builds the aggregation update that issues an OTP and reserves resend quota.
 * @returns {Array<object>} A MongoDB update pipeline.
 */
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

/**
 * Builds the aggregation update for an incorrect OTP attempt.
 * @returns {Array<object>} A pipeline that records failure and locks at the limit.
 */
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

/**
 * Builds a query for an active OTP that does not match the submitted code.
 * @returns {object} A failure-update eligibility filter.
 */
function activeOtpFailureQuery(email, otp, now = new Date(), config = otpSecurityConfig()) {
    return {
        email,
        isEmailVerified: false,
        otp: { $exists: true, $ne: otp },
        otpExpires: { $gte: now },
        $expr: { $lt: [{ $ifNull: ['$otpVerificationAttempts', 0] }, config.maxVerificationAttempts] }
    };
}

/**
 * Builds a query for an active matching OTP that remains below its attempt cap.
 * @returns {object} A successful-verification eligibility filter.
 */
function activeOtpSuccessQuery(email, otp, now = new Date(), config = otpSecurityConfig()) {
    return {
        email,
        isEmailVerified: false,
        otp,
        otpExpires: { $gte: now },
        $expr: { $lt: [{ $ifNull: ['$otpVerificationAttempts', 0] }, config.maxVerificationAttempts] }
    };
}

/**
 * Builds the update that consumes an OTP and marks the account verified.
 * @returns {object} A single-use successful-verification update.
 */
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

/**
 * Builds a bounded audit update for an ineligible resend request.
 * @returns {object} An event-only database update.
 */
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
