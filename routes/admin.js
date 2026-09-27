const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const User = require('../models/User');
const CandidateVerification = require('../models/CandidateVerification');
const { isAuthenticated, authorize } = require('../middleware/auth');
const {
    applyCompanyVerificationDecision,
    normalizeVerificationReason,
    unpublishCompanyListings
} = require('../utils/companyVerification');
const {
    VERIFICATION_STATUSES,
    CandidateVerificationError,
    applyCandidateVerificationDecision,
    normalizeReviewReason,
    statusLabel
} = require('../utils/candidateVerification');

const pendingCompanyQuery = {
    role: 'company',
    $or: [
        { 'companyDetails.verificationStatus': 'pending' },
        {
            'companyDetails.verificationStatus': { $exists: false },
            $or: [
                { 'companyDetails.isVerified': false },
                { 'companyDetails.isVerified': { $exists: false } }
            ]
        }
    ]
};

const approvedCompanyQuery = {
    role: 'company',
    $or: [
        { 'companyDetails.verificationStatus': 'approved' },
        {
            'companyDetails.verificationStatus': { $exists: false },
            'companyDetails.isVerified': true
        }
    ]
};

function redirectWithReviewError(req, res, message) {
    if (req.flash) req.flash('error_msg', message);
    return res.redirect('/admin/dashboard');
}

async function reviewCompany(req, res, status) {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return redirectWithReviewError(req, res, 'Invalid company ID.');
    }

    const reason = normalizeVerificationReason(req.body?.reason);
    if (['rejected', 'suspended'].includes(status) && !reason) {
        return redirectWithReviewError(req, res, 'A review reason is required when rejecting or suspending a company.');
    }

    let outcome = null;
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            const company = await User.findOne({ _id: req.params.id, role: 'company' }).session(session);
            if (!company) return;

            applyCompanyVerificationDecision(company, status, {
                reviewerId: req.user._id,
                reason
            });
            await company.save({ session });

            let unpublishedCount = 0;
            if (status === 'rejected' || status === 'suspended') {
                const result = await unpublishCompanyListings(company._id, { session });
                unpublishedCount = result.modifiedCount || result.nModified || 0;
            }
            outcome = { unpublishedCount };
        });
    } finally {
        await session.endSession();
    }

    if (!outcome) return redirectWithReviewError(req, res, 'Company not found.');

    const label = status === 'approved' ? 'approved' : status;
    const suffix = outcome.unpublishedCount ? ` ${outcome.unpublishedCount} listing(s) were closed.` : '';
    if (req.flash) req.flash('success_msg', `Company ${label} successfully.${suffix}`);
    return res.redirect('/admin/dashboard');
}

router.get('/dashboard', isAuthenticated, authorize('admin'), async (req, res) => {
    try {
        const totalCandidates = await User.countDocuments({ role: 'candidate' });
        const totalCompanies = await User.countDocuments({ role: 'company' });

        const [pendingCompanies, approvedCompanies, pendingCandidateVerifications] = await Promise.all([
            User.find(pendingCompanyQuery).sort({ 'companyDetails.verificationSubmittedAt': 1, createdAt: 1 }),
            User.find(approvedCompanyQuery).sort({ 'companyDetails.verificationReviewedAt': -1, createdAt: -1 }).limit(20),
            CandidateVerification.countDocuments({ status: 'pending' })
        ]);

        const allUsers = await User.find().sort({ createdAt: -1 }).limit(10);

        res.render('admin/dashboard', {
            user: req.user,
            stats: {
                candidates: totalCandidates,
                companies: totalCompanies,
                pendingVerifications: pendingCompanies.length,
                pendingCandidateVerifications
            },
            pendingCompanies,
            approvedCompanies,
            recentUsers: allUsers
        });
    } catch (err) {
        console.error('Error loading admin dashboard:', err);
        res.status(500).send('Server Error');
    }
});

router.get('/candidate-verifications', isAuthenticated, authorize('admin'), async (req, res) => {
    try {
        const status = VERIFICATION_STATUSES.includes(req.query?.status) ? req.query.status : 'pending';
        const filter = req.query?.status === 'all' ? {} : { status };
        const verifications = await CandidateVerification.find(filter)
            .sort({ submittedAt: 1, updatedAt: -1 })
            .populate('candidate', 'name email age familyIncome education location')
            .populate('reviewedBy', 'name email')
            .populate('history.changedBy', 'name email')
            .lean();
        return res.render('admin/candidate-verifications', {
            verifications,
            currentStatus: req.query?.status === 'all' ? 'all' : status,
            verificationStatuses: VERIFICATION_STATUSES,
            statusLabel
        });
    } catch (error) {
        console.error('Error loading candidate verifications:', error);
        if (req.flash) req.flash('error_msg', 'Unable to load candidate verifications.');
        return res.redirect('/admin/dashboard');
    }
});

async function reviewCandidateVerification(req, res, status) {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        if (req.flash) req.flash('error_msg', 'Invalid candidate verification ID.');
        return res.redirect('/admin/candidate-verifications');
    }

    const reason = normalizeReviewReason(req.body?.reason);
    if (!reason) {
        if (req.flash) req.flash('error_msg', 'A review reason is required for every candidate verification decision.');
        return res.redirect('/admin/candidate-verifications');
    }

    const verification = await CandidateVerification.findById(req.params.id).populate('candidate', 'name email');
    if (!verification || !verification.candidate) {
        if (req.flash) req.flash('error_msg', 'Candidate verification not found.');
        return res.redirect('/admin/candidate-verifications');
    }

    applyCandidateVerificationDecision(verification, status, {
        reviewerId: req.user._id,
        reason
    });
    await verification.save();

    if (req.flash) req.flash('success_msg', `${verification.candidate.name}'s verification was ${statusLabel(status).toLowerCase()}.`);
    return res.redirect('/admin/candidate-verifications');
}

router.post('/candidate-verifications/:id/approve', isAuthenticated, authorize('admin'), async (req, res) => {
    try {
        return await reviewCandidateVerification(req, res, 'approved');
    } catch (error) {
        console.error('Candidate verification approval failed:', error);
        if (req.flash) req.flash('error_msg', error instanceof CandidateVerificationError ? error.message : 'Unable to approve candidate verification.');
        return res.redirect('/admin/candidate-verifications');
    }
});

router.post('/candidate-verifications/:id/reject', isAuthenticated, authorize('admin'), async (req, res) => {
    try {
        return await reviewCandidateVerification(req, res, 'rejected');
    } catch (error) {
        console.error('Candidate verification rejection failed:', error);
        if (req.flash) req.flash('error_msg', error instanceof CandidateVerificationError ? error.message : 'Unable to reject candidate verification.');
        return res.redirect('/admin/candidate-verifications');
    }
});

router.post('/candidate-verifications/:id/suspend', isAuthenticated, authorize('admin'), async (req, res) => {
    try {
        return await reviewCandidateVerification(req, res, 'suspended');
    } catch (error) {
        console.error('Candidate verification suspension failed:', error);
        if (req.flash) req.flash('error_msg', error instanceof CandidateVerificationError ? error.message : 'Unable to suspend candidate verification.');
        return res.redirect('/admin/candidate-verifications');
    }
});

router.post('/approve-company/:id', isAuthenticated, authorize('admin'), async (req, res) => {
    try {
        return await reviewCompany(req, res, 'approved');
    } catch (err) {
        console.error('Approve error:', err);
        req.flash('error_msg', 'Failed to approve company.');
        res.redirect('/admin/dashboard');
    }
});

router.post('/reject-company/:id', isAuthenticated, authorize('admin'), async (req, res) => {
    try {
        return await reviewCompany(req, res, 'rejected');
    } catch (err) {
        console.error('Reject error:', err);
        req.flash('error_msg', 'Failed to reject company.');
        res.redirect('/admin/dashboard');
    }
});

router.post('/suspend-company/:id', isAuthenticated, authorize('admin'), async (req, res) => {
    try {
        return await reviewCompany(req, res, 'suspended');
    } catch (err) {
        console.error('Suspend error:', err);
        return redirectWithReviewError(req, res, 'Failed to suspend company.');
    }
});

module.exports = router;
module.exports.pendingCompanyQuery = pendingCompanyQuery;
module.exports.approvedCompanyQuery = approvedCompanyQuery;
