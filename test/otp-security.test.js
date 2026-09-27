const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');

const User = require('../models/User');
const authRouter = require('../routes/auth');
const {
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
} = require('../utils/otpSecurity');

function routeLayer(router, pathName, method) {
    return router.stack.find(layer => layer.route
        && layer.route.path === pathName
        && layer.route.methods[method]);
}

test('OTP security fields validate and events never contain a code or IP address', async () => {
    const user = new User({
        name: 'Asha Rao',
        email: 'asha@example.test',
        password: 'secure-password',
        otp: '123456',
        otpVerificationAttempts: 4,
        otpResendCount: 2,
        otpSecurityEvents: [{ type: 'otp_verification_failed', at: new Date('2026-09-27T10:00:00Z') }]
    });

    await assert.doesNotReject(user.validate());
    assert.equal(User.schema.path('otpVerificationAttempts').instance, 'Number');
    assert.equal(User.schema.path('otpResendCount').instance, 'Number');
    assert.equal(User.schema.path('otpSecurityEvents').schema.path('code'), undefined);
    assert.equal(User.schema.path('otpSecurityEvents').schema.path('ip'), undefined);
});

test('OTP configuration uses conservative defaults and safely bounds overrides', () => {
    assert.equal(otpSecurityConfig({}).maxVerificationAttempts, 5);
    assert.equal(otpSecurityConfig({}).maxResendsPerWindow, 3);
    assert.deepEqual(
        otpSecurityConfig({ OTP_VERIFY_MAX_ATTEMPTS: '7', OTP_RESEND_MAX_PER_HOUR: '4' }),
        {
            ttlMs: 10 * 60 * 1000,
            resendCooldownMs: 60 * 1000,
            resendWindowMs: 60 * 60 * 1000,
            maxVerificationAttempts: 7,
            maxResendsPerWindow: 4
        }
    );
    assert.equal(otpSecurityConfig({ OTP_VERIFY_MAX_ATTEMPTS: '0' }).maxVerificationAttempts, 5);
    assert.equal(otpSecurityConfig({ OTP_RESEND_MAX_PER_HOUR: '99' }).maxResendsPerWindow, 3);
});

test('fresh OTPs reset brute-force counters while retaining no raw data in audit events', () => {
    const now = new Date('2026-09-27T10:00:00Z');
    const state = freshOtpState('654321', now);
    assert.equal(state.otp, '654321');
    assert.equal(state.otpVerificationAttempts, 0);
    assert.equal(state.otpResendCount, 0);
    assert.equal(state.otpExpires.getTime(), now.getTime() + 10 * 60 * 1000);
    assert.equal(state.otpResendWindowStartedAt.getTime(), now.getTime());
});

test('resends have one atomic cooldown-and-hourly-quota condition and reset a fresh code safely', () => {
    const now = new Date('2026-09-27T10:00:00Z');
    const config = otpSecurityConfig({ OTP_RESEND_MAX_PER_HOUR: '3' });
    const query = resendEligibilityQuery('asha@example.test', now, config);
    const update = resendOtpUpdate('654321', now, config);

    assert.equal(query.email, 'asha@example.test');
    assert.equal(query.isEmailVerified, false);
    assert.equal(query.$and.length, 2, 'the single conditional query combines cooldown and quota');
    assert.equal(query.$and[0].$or[2].lastOtpSentAt.$lte.getTime(), now.getTime() - 60 * 1000);
    assert.equal(query.$and[1].$or.at(-1).otpResendCount.$lt, 3);
    assert.equal(Array.isArray(update), true, 'a pipeline update atomically resets or increments the rolling window');
    assert.equal(update[0].$set.otpVerificationAttempts, 0);
    assert.equal(update[0].$set.otpResendCount.$add[1], 1);
    assert.equal(update[0].$set.otpSecurityEvents.$slice[1], -OTP_SECURITY_EVENT_LIMIT);
});

test('failed verification updates are capped, invalidate the OTP at the threshold, and keep a bounded audit history', () => {
    const now = new Date('2026-09-27T10:00:00Z');
    const config = otpSecurityConfig({ OTP_VERIFY_MAX_ATTEMPTS: '5' });
    const failureQuery = activeOtpFailureQuery('asha@example.test', '000000', now, config);
    const successQuery = activeOtpSuccessQuery('asha@example.test', '123456', now, config);
    const update = failedVerificationUpdate(now, config)[0].$set;

    assert.equal(failureQuery.otp.$ne, '000000');
    assert.equal(failureQuery.$expr.$lt[1], 5);
    assert.equal(successQuery.otp, '123456');
    assert.equal(successQuery.$expr.$lt[1], 5);
    assert.equal(update.otp.$cond[0].$gte[1], 5, 'the fifth failed attempt deletes the active code');
    assert.equal(update.otp.$cond[1], '$$REMOVE');
    assert.equal(update.otpSecurityEvents.$slice[1], -OTP_SECURITY_EVENT_LIMIT);
});

test('verification completion clears OTP state and rate-limit denials append a bounded account audit event', () => {
    const completed = successfulOtpVerificationUpdate(new Date('2026-09-27T10:00:00Z'));
    assert.equal(completed.$set.isEmailVerified, true);
    assert.ok(completed.$unset.otp);
    assert.ok(completed.$unset.otpExpires);
    assert.equal(completed.$push.otpSecurityEvents.$each[0].type, 'otp_verified');

    const rateLimited = resendRateLimitAuditUpdate(new Date('2026-09-27T10:00:00Z'));
    assert.equal(rateLimited.$push.otpSecurityEvents.$each[0].type, 'otp_resend_rate_limited');
    assert.equal(rateLimited.$push.otpSecurityEvents.$slice, -OTP_SECURITY_EVENT_LIMIT);

    const events = Array.from({ length: OTP_SECURITY_EVENT_LIMIT }, (_, index) => ({ type: `event-${index}` }));
    const bounded = limitedEvents(events, { type: 'latest' });
    assert.equal(bounded.length, OTP_SECURITY_EVENT_LIMIT);
    assert.equal(bounded[0].type, 'event-1');
    assert.equal(bounded.at(-1).type, 'latest');
});

test('OTP inputs are primitive and generic responses do not disclose account existence', () => {
    assert.equal(normalizeEmail(' ASHA@example.test '), 'asha@example.test');
    assert.equal(normalizeEmail({ $gt: '' }), '');
    assert.equal(normalizeOtp('123456'), '123456');
    assert.equal(normalizeOtp('12345'), '');
    assert.equal(normalizeOtp({ $ne: '' }), '');
    assert.doesNotMatch(GENERIC_RESEND_MESSAGE, /not found|already verified|does not exist/i);
    assert.doesNotMatch(GENERIC_VERIFICATION_ERROR, /not found|already verified|does not exist/i);
});

test('verification and resend endpoints are registered', () => {
    assert.ok(routeLayer(authRouter, '/verify-otp', 'post'));
    assert.ok(routeLayer(authRouter, '/resend-otp', 'post'));
});

test('the admin account detail exposes OTP security history without a code or IP field', () => {
    const viewPath = path.join(__dirname, '..', 'views', 'admin-console', 'user-detail.ejs');
    const template = fs.readFileSync(viewPath, 'utf8').replace("<% layout('layouts/boilerplate') %>", '');
    const html = ejs.render(template, {
        user: {
            _id: new mongoose.Types.ObjectId(), name: 'Asha Rao', email: 'asha@example.test', role: 'candidate', createdAt: new Date(),
            otpSecurityEvents: [{ type: 'otp_invalidated_after_failures', at: new Date('2026-09-27T10:00:00Z') }]
        },
        suspension: null,
        applications: [],
        listings: [],
        canSuspend: false
    }, { filename: viewPath });

    assert.match(html, /OTP security history/);
    assert.match(html, /otp invalidated after failures/);
    assert.match(html, /OTP values and IP addresses are never stored here/);
});
