const express = require('express');
const router = express.Router();
const passport = require('passport');
const crypto = require('crypto');
const User = require('../models/User');
const { sendOTPEmail } = require('../utils/sendEmail');
const {
    GENERIC_RESEND_MESSAGE,
    GENERIC_VERIFICATION_ERROR,
    otpSecurityConfig,
    normalizeEmail,
    normalizeOtp,
    freshOtpState,
    resendEligibilityQuery,
    resendOtpUpdate,
    activeOtpSuccessQuery,
    activeOtpFailureQuery,
    failedVerificationUpdate,
    successfulOtpVerificationUpdate,
    resendRateLimitAuditUpdate
} = require('../utils/otpSecurity');

const generateSecureOTP = () => {
    return crypto.randomInt(100000, 1000000).toString();
};

const redirectIfAuthenticated = (req, res, next) => {
    if (req.isAuthenticated && req.isAuthenticated()) {
        if (req.user.role === 'admin') return res.redirect('/admin/dashboard');
        if (['company', 'recruiter', 'hiring_manager'].includes(req.user.role)) return res.redirect('/company/dashboard');
        return res.redirect('/');
    }
    next();
};

router.get('/login', redirectIfAuthenticated, (req, res) => res.render('auth/login'));
router.get('/register', redirectIfAuthenticated, (req, res) => res.render('auth/register'));

router.post('/register', async (req, res) => {
    const { name, email, password, role, adminSecretKey, companyName, cin, industry } = req.body || {};
    const normalizedEmail = normalizeEmail(email);
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    const trimmedCompanyName = typeof companyName === 'string' ? companyName.trim() : '';
    const trimmedCin = typeof cin === 'string' ? cin.trim() : '';
    const trimmedIndustry = typeof industry === 'string' ? industry.trim() : '';

    console.log('\n--- New Registration Request ---');
    console.log('Received Payload Email:', normalizedEmail);

    try {
        if (!trimmedName) {
            req.flash('error_msg', 'Full name is required.');
            return res.redirect('/auth/register');
        }

        if (!normalizedEmail || !/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
            console.error('ERROR: Email field is empty or invalid format in req.body!');
            req.flash('error_msg', 'A valid email address is required.');
            return res.redirect('/auth/register');
        }

        if (!password || typeof password !== 'string' || password.length < 6) {
            req.flash('error_msg', 'Password must be at least 6 characters long.');
            return res.redirect('/auth/register');
        }

        let selectedRole = 'candidate';

        if (role === 'admin') {
            const SYSTEM_ADMIN_SECRET = process.env.ADMIN_SECRET || process.env.ADMIN_CODE;

            if (!SYSTEM_ADMIN_SECRET) {
                req.flash('error_msg', 'Admin registration is not configured on this server.');
                return res.redirect('/auth/register');
            }

            if (!adminSecretKey || adminSecretKey !== SYSTEM_ADMIN_SECRET) {
                req.flash('error_msg', 'Invalid Admin Security Key. Access denied.');
                return res.redirect('/auth/register');
            }
            selectedRole = 'admin';
        } else if (role === 'company') {
            if (!trimmedCompanyName) {
                req.flash('error_msg', 'Company name is required for company registration.');
                return res.redirect('/auth/register');
            }
            selectedRole = 'company';
        }

        const existing = await User.findOne({ email: normalizedEmail });

        // An existing, unverified account only receives a new code through the
        // same atomic cooldown and hourly-limit path as /resend-otp. Never
        // reset its counters or overwrite its pending profile/password from a
        // public registration request.
        if (existing) {
            if (existing.isEmailVerified) {
                console.log('Status: User exists and is already verified.');
                req.flash('error_msg', 'Email already registered. Please log in.');
                return res.redirect('/auth/register');
            }

            const now = new Date();
            const config = otpSecurityConfig();
            const otp = generateSecureOTP();
            const updatedUser = await User.findOneAndUpdate(
                resendEligibilityQuery(normalizedEmail, now, config),
                resendOtpUpdate(otp, now, config),
                { new: true, updatePipeline: true }
            );

            if (!updatedUser) {
                await User.updateOne(
                    { email: normalizedEmail, isEmailVerified: false },
                    resendRateLimitAuditUpdate(now)
                );
                req.flash('success_msg', GENERIC_RESEND_MESSAGE);
                return res.redirect(`/auth/verify-otp?email=${encodeURIComponent(normalizedEmail)}`);
            }

            try {
                await sendOTPEmail(normalizedEmail, otp);
            } catch (emailErr) {
                console.error('Registration resend OTP delivery failed:', emailErr);
            }

            req.flash('success_msg', GENERIC_RESEND_MESSAGE);
            return res.redirect(`/auth/verify-otp?email=${encodeURIComponent(normalizedEmail)}`);
        }

        const otp = generateSecureOTP();
        const otpState = freshOtpState(otp, new Date(), otpSecurityConfig());

        const userData = {
            name: trimmedName,
            email: normalizedEmail,
            password,
            role: selectedRole,
            isEmailVerified: false,
            ...otpState
        };

        if (userData.role === 'company') {
            userData.companyDetails = {
                companyName: trimmedCompanyName,
                cin: trimmedCin,
                industry: trimmedIndustry,
                isVerified: false,
                verificationStatus: 'pending',
                verificationSubmittedAt: new Date(),
                verificationHistory: [{
                    status: 'pending',
                    reason: 'Company account registered.',
                    changedAt: new Date()
                }]
            };
        }

        // Create pending user record before dispatching email to guarantee persistence
        const newUser = await User.create(userData);

        // Company owners need companyId set to their own _id
        // so requireCompanyRole middleware allows access
        if (newUser.role === 'company') {
            newUser.companyId = newUser._id;
            await newUser.save();
        }

        console.log('--> User account created in MongoDB.');
        console.log(`--> Dispatching verification code via Nodemailer to ${normalizedEmail}...`);

        try {
            await sendOTPEmail(normalizedEmail, otp);
            console.log('--> Email sent successfully!');
            req.flash('success_msg', 'Verification code sent to your email!');
        } catch (emailErr) {
            console.error('--> Failed to send initial OTP email:', emailErr.message);
            req.flash('error_msg', "Account created, but we couldn't send the code. Please click Resend OTP.");
        }

        res.redirect(`/auth/verify-otp?email=${encodeURIComponent(normalizedEmail)}`);
    } catch (err) {
        console.error('--> REGISTRATION / EMAIL ERROR:', err);
        req.flash('error_msg', "We couldn't complete registration. Please try again in a moment.");
        res.redirect('/auth/register');
    }
});

router.get('/verify-otp', (req, res) => {
    const email = normalizeEmail(req.query.email);
    res.render('extras/verify-otp', { email });
});

router.post('/verify-otp', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const otp = normalizeOtp(req.body?.otp);
    const redirectPath = `/auth/verify-otp?email=${encodeURIComponent(email)}`;

    try {
        if (!email || !otp) {
            req.flash('error_msg', GENERIC_VERIFICATION_ERROR);
            return res.redirect(redirectPath);
        }

        const now = new Date();
        const config = otpSecurityConfig();
        // This conditional update makes a valid code single-use even if two
        // requests race, and refuses a code once its bad-attempt ceiling is hit.
        const verifiedUser = await User.findOneAndUpdate(
            activeOtpSuccessQuery(email, otp, now, config),
            successfulOtpVerificationUpdate(now),
            { new: true }
        );

        if (!verifiedUser) {
            // Only an active account with a different code is updated. The
            // response remains identical for unknown emails, expired codes,
            // and locked OTPs, preventing account enumeration.
            await User.findOneAndUpdate(
                activeOtpFailureQuery(email, otp, now, config),
                failedVerificationUpdate(now, config),
                { new: true, updatePipeline: true }
            );
            req.flash('error_msg', GENERIC_VERIFICATION_ERROR);
            return res.redirect(redirectPath);
        }

        console.log(`User ${email} verified successfully.`);
        req.flash('success_msg', 'Account verified successfully! You can now log in.');
        res.redirect('/auth/login');
    } catch (err) {
        console.error('Verification error:', err);
        req.flash('error_msg', GENERIC_VERIFICATION_ERROR);
        res.redirect(redirectPath);
    }
});

router.post('/resend-otp', async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const redirectPath = `/auth/verify-otp?email=${encodeURIComponent(email)}`;

    try {
        if (!email) {
            req.flash('success_msg', GENERIC_RESEND_MESSAGE);
            return res.redirect(redirectPath);
        }

        const now = new Date();
        const config = otpSecurityConfig();
        const otp = generateSecureOTP();

        // Atomically reserve both the cooldown and hourly account quota before
        // dispatching email. This prevents concurrent requests from bypassing
        // either limit.
        const updatedUser = await User.findOneAndUpdate(
            resendEligibilityQuery(email, now, config),
            resendOtpUpdate(otp, now, config),
            { new: true, updatePipeline: true }
        );

        if (!updatedUser) {
            // Record the pattern for an existing unverified account without
            // exposing whether this email exists to the requester.
            await User.updateOne(
                { email, isEmailVerified: false },
                resendRateLimitAuditUpdate(now)
            );
            req.flash('success_msg', GENERIC_RESEND_MESSAGE);
            return res.redirect(redirectPath);
        }

        try {
            await sendOTPEmail(email, otp);
        } catch (emailError) {
            console.error('Resend OTP delivery failed:', emailError);
        }

        req.flash('success_msg', GENERIC_RESEND_MESSAGE);
        res.redirect(redirectPath);
    } catch (err) {
        console.error('Resend OTP error:', err);
        req.flash('success_msg', GENERIC_RESEND_MESSAGE);
        res.redirect(redirectPath);
    }
});

router.post('/login', (req, res, next) => {
    passport.authenticate('local', async (err, user, info) => {
        if (err) return next(err);
        if (!user) {
            req.flash('error_msg', info ? info.message : 'Invalid email or password.');
            return res.redirect('/auth/login');
        }

        if (!user.isEmailVerified) {
            req.flash('error_msg', 'Please verify your email via OTP before logging in.');
            return res.redirect(`/auth/verify-otp?email=${encodeURIComponent(user.email)}`);
        }

        req.logIn(user, (err) => {
            if (err) return next(err);

            // Handle "Remember Me"
            if (req.body.remember) {
                req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
            }

            req.flash('success_msg', `Welcome back, ${user.name}!`);

            if (user.role === 'admin') {
                return res.redirect('/admin/dashboard');
            } else if (['company', 'recruiter', 'hiring_manager'].includes(user.role)) {
                return res.redirect('/company/dashboard');
            } else {
                return res.redirect('/');
            }
        });
    })(req, res, next);
});

router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

router.get('/google/callback', (req, res, next) => {
    passport.authenticate('google', (err, user) => {
        if (err || !user) {
            req.flash('error_msg', 'Google authentication failed or account deactivated.');
            return res.redirect('/auth/login');
        }

        if (!user.isEmailVerified) {
            user.isEmailVerified = true;
            user.save().catch(console.error);
        }

        req.logIn(user, (err) => {
            if (err) return next(err);
            req.flash('success_msg', `Welcome back, ${user.name}!`);

            if (user.role === 'admin') {
                return res.redirect('/admin/dashboard');
            } else if (['company', 'recruiter', 'hiring_manager'].includes(user.role)) {
                return res.redirect('/company/dashboard');
            } else {
                return res.redirect('/');
            }
        });
    })(req, res, next);
});

// Forgot & Reset Password Flow
router.get('/forgot-password', redirectIfAuthenticated, (req, res) => {
    res.render('auth/forgot-password');
});

router.post('/forgot-password', async (req, res) => {
    const email = (req.body.email || '').trim().toLowerCase();

    try {
        if (!email) {
            req.flash('error_msg', 'Email address is required.');
            return res.redirect('/auth/forgot-password');
        }

        const user = await User.findOne({ email });
        if (!user) {
            req.flash('error_msg', 'No account found with that email address.');
            return res.redirect('/auth/forgot-password');
        }

        const now = Date.now();
        const COOLDOWN_SECONDS = 60;
        if (user.lastOtpSentAt) {
            const elapsedSeconds = Math.floor((now - new Date(user.lastOtpSentAt).getTime()) / 1000);
            if (elapsedSeconds < COOLDOWN_SECONDS) {
                const remainingSeconds = COOLDOWN_SECONDS - elapsedSeconds;
                req.flash('error_msg', `Please wait ${remainingSeconds}s before requesting a new code.`);
                return res.redirect(`/auth/reset-password?email=${encodeURIComponent(email)}`);
            }
        }

        const otp = generateSecureOTP();
        user.otp = otp;
        user.otpExpires = new Date(now + 10 * 60 * 1000);
        user.lastOtpSentAt = new Date(now);
        await user.save();

        try {
            await sendOTPEmail(email, otp);
            req.flash('success_msg', 'Password reset code sent to your email.');
        } catch (emailErr) {
            console.error('Failed to send reset OTP email:', emailErr);
            req.flash('error_msg', 'Could not send verification code. Please check your email configuration.');
        }

        res.redirect(`/auth/reset-password?email=${encodeURIComponent(email)}`);
    } catch (err) {
        console.error('Forgot password error:', err);
        req.flash('error_msg', 'Something went wrong. Please try again.');
        res.redirect('/auth/forgot-password');
    }
});

router.get('/reset-password', redirectIfAuthenticated, (req, res) => {
    const email = (req.query.email || '').trim().toLowerCase();
    res.render('auth/reset-password', { email });
});

router.post('/reset-password', async (req, res) => {
    const email = (req.body.email || '').trim().toLowerCase();
    const otp = (req.body.otp || '').trim();
    const newPassword = req.body.password;
    const confirmPassword = req.body.confirmPassword;

    try {
        if (!email || !otp || !newPassword) {
            req.flash('error_msg', 'All fields are required.');
            return res.redirect(`/auth/reset-password?email=${encodeURIComponent(email)}`);
        }

        if (newPassword !== confirmPassword) {
            req.flash('error_msg', 'Passwords do not match.');
            return res.redirect(`/auth/reset-password?email=${encodeURIComponent(email)}`);
        }

        if (newPassword.length < 6) {
            req.flash('error_msg', 'Password must be at least 6 characters long.');
            return res.redirect(`/auth/reset-password?email=${encodeURIComponent(email)}`);
        }

        const user = await User.findOne({ email });
        if (!user || user.otp !== otp || !user.otpExpires || new Date(user.otpExpires).getTime() < Date.now()) {
            req.flash('error_msg', 'Invalid or expired OTP code.');
            return res.redirect(`/auth/reset-password?email=${encodeURIComponent(email)}`);
        }

        user.password = newPassword;
        user.isEmailVerified = true;
        user.otp = undefined;
        user.otpExpires = undefined;
        user.lastOtpSentAt = undefined;
        await user.save();

        req.flash('success_msg', 'Password reset successfully! You can now log in.');
        res.redirect('/auth/login');
    } catch (err) {
        console.error('Reset password error:', err);
        req.flash('error_msg', 'An error occurred while resetting your password.');
        res.redirect(`/auth/reset-password?email=${encodeURIComponent(email)}`);
    }
});

router.get('/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) return next(err);
        req.flash('success_msg', 'Logged out successfully.');
        if (req.session && typeof req.session.save === 'function') {
            req.session.save(() => {
                res.redirect('/auth/login');
            });
        } else {
            res.redirect('/auth/login');
        }
    });
});

module.exports = router;
