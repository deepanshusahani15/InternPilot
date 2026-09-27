const express = require('express');
const mongoose = require('mongoose');

const Placement = require('../models/Placement');
const Offer = require('../models/Offer');
const Notification = require('../models/Notification');
const { isAuthenticated, authorize } = require('../middleware/auth');
const { requireCompanyPermission } = require('../middleware/companyAccess');
const {
    PlacementLifecycleError,
    confirmJoining,
    startPlacement,
    addProgressUpdate,
    submitCompanyEvaluation,
    submitCandidateFeedback,
    completePlacement,
    terminatePlacement
} = require('../utils/placements');
const { releaseSeatIfHeld } = require('../utils/offers');

const router = express.Router();

function wantsJson(req) {
    return Boolean(req.xhr || req.is('json') || req.headers.accept?.includes('application/json'));
}

function userId(req) {
    return req.user?._id || req.user?.id;
}

function errorResponse(req, res, error, fallbackPath) {
    const status = error.statusCode || 400;
    const message = error.message || 'Unable to update this placement.';
    if (wantsJson(req)) return res.status(status).json({ success: false, error: message, code: error.code });
    if (req.flash) req.flash('error_msg', message);
    return res.redirect(fallbackPath);
}

function validPlacementId(id) {
    return mongoose.Types.ObjectId.isValid(id);
}

function verificationBaseUrl(req) {
    const configured = String(process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
    if (configured) return configured;
    return `${req.protocol}://${req.get('host')}`;
}

async function notifyPlacement(NotificationModel, payload) {
    try {
        return await NotificationModel.create(payload);
    } catch (error) {
        // Notifications do not control the state transition. The scheduled
        // reminders still surface any action that needs attention.
        console.error('Failed to create placement notification:', error);
        return null;
    }
}

async function releaseSeatForTerminatedPlacement(placement) {
    try {
        const offer = await Offer.findById(placement.offer);
        await releaseSeatIfHeld(offer);
    } catch (seatError) {
        // The termination is authoritative even if capacity recovery has a
        // transient failure; it can safely be retried because the offer's
        // seatReserved flag is cleared atomically.
        console.error('Failed to release placement seat after termination:', seatError);
    }
}

async function candidatePlacement(req, id) {
    return Placement.findOne({ _id: id, candidate: userId(req) })
        .populate('internship')
        .populate('company', 'name companyDetails.companyName')
        .populate('certificate');
}

async function companyPlacement(req, id) {
    return Placement.findOne({ _id: id, company: req.company._id })
        .populate('candidate', 'name email')
        .populate('internship')
        .populate('certificate');
}

router.get('/placements/:id', isAuthenticated, async (req, res) => {
    if (!validPlacementId(req.params.id)) return res.status(404).render('extras/error', { message: 'Placement not found.', error: {} });
    if (req.user.role === 'candidate') return res.redirect(`/candidate/placements/${req.params.id}`);
    if (['company', 'recruiter', 'hiring_manager'].includes(req.user.role)) return res.redirect(`/company/placements/${req.params.id}`);
    return res.status(403).render('extras/error', { message: 'You do not have access to this placement.', error: {} });
});

router.get('/candidate/placements', isAuthenticated, authorize('candidate'), async (req, res) => {
    try {
        const placements = await Placement.find({ candidate: userId(req) })
            .populate('internship')
            .populate('company', 'name companyDetails.companyName')
            .populate('certificate')
            .sort({ startDate: -1 });
        return res.render('candidate/placements', { placements, currentUser: req.user });
    } catch (error) {
        console.error('Error loading candidate placements:', error);
        return res.status(500).render('extras/error', { message: 'Unable to load placements.', error: {} });
    }
});

router.get('/candidate/placements/:id', isAuthenticated, authorize('candidate'), async (req, res) => {
    try {
        if (!validPlacementId(req.params.id)) throw new PlacementLifecycleError('Placement not found.', 'PLACEMENT_NOT_FOUND', 404);
        const placement = await candidatePlacement(req, req.params.id);
        if (!placement) throw new PlacementLifecycleError('Placement not found.', 'PLACEMENT_NOT_FOUND', 404);
        return res.render('candidate/placement', { placement, currentUser: req.user });
    } catch (error) {
        return errorResponse(req, res, error, '/candidate/placements');
    }
});

router.post('/candidate/placements/:id/confirm-joining', isAuthenticated, authorize('candidate'), async (req, res) => {
    const fallbackPath = `/candidate/placements/${req.params.id}`;
    try {
        if (!validPlacementId(req.params.id)) throw new PlacementLifecycleError('Placement not found.', 'PLACEMENT_NOT_FOUND', 404);
        const placement = await confirmJoining({ placementId: req.params.id, candidateId: userId(req) });
        await notifyPlacement(Notification, {
            companyId: placement.company,
            type: 'placement_joined',
            title: 'Internship joining confirmed',
            message: 'The candidate has confirmed joining their internship.',
            link: `/company/placements/${placement._id}`,
            placement: placement._id,
            internship: placement.internship,
            application: placement.application,
            metadata: { placementId: placement._id }
        });
        if (wantsJson(req)) return res.json({ success: true, placement });
        if (req.flash) req.flash('success_msg', 'Joining confirmed. Start the internship when work begins.');
        return res.redirect(fallbackPath);
    } catch (error) {
        return errorResponse(req, res, error, fallbackPath);
    }
});

router.post('/candidate/placements/:id/start', isAuthenticated, authorize('candidate'), async (req, res) => {
    const fallbackPath = `/candidate/placements/${req.params.id}`;
    try {
        if (!validPlacementId(req.params.id)) throw new PlacementLifecycleError('Placement not found.', 'PLACEMENT_NOT_FOUND', 404);
        const placement = await startPlacement({ placementId: req.params.id, actorId: userId(req), actorRole: 'candidate' });
        if (wantsJson(req)) return res.json({ success: true, placement });
        if (req.flash) req.flash('success_msg', 'Internship progress is now being tracked.');
        return res.redirect(fallbackPath);
    } catch (error) {
        return errorResponse(req, res, error, fallbackPath);
    }
});

router.post('/candidate/placements/:id/progress', isAuthenticated, authorize('candidate'), async (req, res) => {
    const fallbackPath = `/candidate/placements/${req.params.id}`;
    try {
        if (!validPlacementId(req.params.id)) throw new PlacementLifecycleError('Placement not found.', 'PLACEMENT_NOT_FOUND', 404);
        const placement = await addProgressUpdate({ placementId: req.params.id, actorId: userId(req), actorRole: 'candidate', input: req.body });
        if (wantsJson(req)) return res.json({ success: true, placement });
        if (req.flash) req.flash('success_msg', 'Progress update recorded.');
        return res.redirect(fallbackPath);
    } catch (error) {
        return errorResponse(req, res, error, fallbackPath);
    }
});

router.post('/candidate/placements/:id/feedback', isAuthenticated, authorize('candidate'), async (req, res) => {
    const fallbackPath = `/candidate/placements/${req.params.id}`;
    try {
        if (!validPlacementId(req.params.id)) throw new PlacementLifecycleError('Placement not found.', 'PLACEMENT_NOT_FOUND', 404);
        const placement = await submitCandidateFeedback({ placementId: req.params.id, candidateId: userId(req), input: req.body });
        if (wantsJson(req)) return res.json({ success: true, placement });
        if (req.flash) req.flash('success_msg', 'Thank you for sharing your feedback.');
        return res.redirect(fallbackPath);
    } catch (error) {
        return errorResponse(req, res, error, fallbackPath);
    }
});

router.get('/company/placements', isAuthenticated, requireCompanyPermission('applications:view'), async (req, res) => {
    try {
        const placements = await Placement.find({ company: req.company._id })
            .populate('candidate', 'name email')
            .populate('internship')
            .populate('certificate')
            .sort({ startDate: -1 });
        return res.render('company/placements', { placements, currentUser: req.user, permissions: req.companyPermissions });
    } catch (error) {
        console.error('Error loading company placements:', error);
        return res.status(500).render('extras/error', { message: 'Unable to load placements.', error: {} });
    }
});

router.get('/company/placements/:id', isAuthenticated, requireCompanyPermission('applications:view'), async (req, res) => {
    try {
        if (!validPlacementId(req.params.id)) throw new PlacementLifecycleError('Placement not found.', 'PLACEMENT_NOT_FOUND', 404);
        const placement = await companyPlacement(req, req.params.id);
        if (!placement) throw new PlacementLifecycleError('Placement not found.', 'PLACEMENT_NOT_FOUND', 404);
        return res.render('company/placement', { placement, currentUser: req.user, permissions: req.companyPermissions });
    } catch (error) {
        return errorResponse(req, res, error, '/company/placements');
    }
});

router.post('/company/placements/:id/start', isAuthenticated, requireCompanyPermission('applications:review'), async (req, res) => {
    const fallbackPath = `/company/placements/${req.params.id}`;
    try {
        if (!validPlacementId(req.params.id)) throw new PlacementLifecycleError('Placement not found.', 'PLACEMENT_NOT_FOUND', 404);
        const placement = await startPlacement({ placementId: req.params.id, actorId: userId(req), ownerId: req.company._id, actorRole: 'company' });
        if (wantsJson(req)) return res.json({ success: true, placement });
        if (req.flash) req.flash('success_msg', 'Internship progress is now being tracked.');
        return res.redirect(fallbackPath);
    } catch (error) {
        return errorResponse(req, res, error, fallbackPath);
    }
});

router.post('/company/placements/:id/progress', isAuthenticated, requireCompanyPermission('applications:review'), async (req, res) => {
    const fallbackPath = `/company/placements/${req.params.id}`;
    try {
        if (!validPlacementId(req.params.id)) throw new PlacementLifecycleError('Placement not found.', 'PLACEMENT_NOT_FOUND', 404);
        const placement = await addProgressUpdate({ placementId: req.params.id, actorId: userId(req), ownerId: req.company._id, actorRole: 'company', input: req.body, PlacementModel: Placement });
        if (wantsJson(req)) return res.json({ success: true, placement });
        if (req.flash) req.flash('success_msg', 'Progress update recorded.');
        return res.redirect(fallbackPath);
    } catch (error) {
        return errorResponse(req, res, error, fallbackPath);
    }
});

router.post('/company/placements/:id/evaluation', isAuthenticated, requireCompanyPermission('applications:review'), async (req, res) => {
    const fallbackPath = `/company/placements/${req.params.id}`;
    try {
        if (!validPlacementId(req.params.id)) throw new PlacementLifecycleError('Placement not found.', 'PLACEMENT_NOT_FOUND', 404);
        const placement = await submitCompanyEvaluation({ placementId: req.params.id, companyId: req.company._id, actorId: userId(req), input: req.body });
        if (wantsJson(req)) return res.json({ success: true, placement });
        if (req.flash) req.flash('success_msg', 'Final evaluation saved.');
        return res.redirect(fallbackPath);
    } catch (error) {
        return errorResponse(req, res, error, fallbackPath);
    }
});

router.post('/company/placements/:id/complete', isAuthenticated, requireCompanyPermission('applications:review'), async (req, res) => {
    const fallbackPath = `/company/placements/${req.params.id}`;
    try {
        if (!validPlacementId(req.params.id)) throw new PlacementLifecycleError('Placement not found.', 'PLACEMENT_NOT_FOUND', 404);
        const result = await completePlacement({
            placementId: req.params.id,
            companyId: req.company._id,
            actorId: userId(req),
            verificationBaseUrl: verificationBaseUrl(req)
        });
        await notifyPlacement(Notification, {
            recipient: result.placement.candidate,
            type: 'placement_completed',
            title: 'Internship completed — certificate issued',
            message: 'Your internship has been completed and your verified certificate is ready.',
            link: `/certificates/${result.certificate.certificateId}/view`,
            placement: result.placement._id,
            internship: result.placement.internship,
            application: result.placement.application,
            metadata: { placementId: result.placement._id }
        });
        if (wantsJson(req)) return res.json({ success: true, placement: result.placement, certificate: result.certificate });
        if (req.flash) req.flash('success_msg', 'Placement completed and a verified certificate was issued.');
        return res.redirect(fallbackPath);
    } catch (error) {
        return errorResponse(req, res, error, fallbackPath);
    }
});

router.post('/company/placements/:id/terminate', isAuthenticated, requireCompanyPermission('applications:review'), async (req, res) => {
    const fallbackPath = `/company/placements/${req.params.id}`;
    try {
        if (!validPlacementId(req.params.id)) throw new PlacementLifecycleError('Placement not found.', 'PLACEMENT_NOT_FOUND', 404);
        const placement = await terminatePlacement({ placementId: req.params.id, actorId: userId(req), ownerId: req.company._id, actorRole: 'company', reason: req.body?.reason });
        await releaseSeatForTerminatedPlacement(placement);
        await notifyPlacement(Notification, {
            recipient: placement.candidate,
            type: 'placement_terminated',
            title: 'Internship placement ended',
            message: 'Your internship placement has been marked as terminated. Review the stated reason for details.',
            link: `/candidate/placements/${placement._id}`,
            placement: placement._id,
            internship: placement.internship,
            application: placement.application,
            metadata: { placementId: placement._id }
        });
        if (wantsJson(req)) return res.json({ success: true, placement });
        if (req.flash) req.flash('success_msg', 'Placement terminated. The candidate has been notified.');
        return res.redirect(fallbackPath);
    } catch (error) {
        return errorResponse(req, res, error, fallbackPath);
    }
});

// Admin termination is intentionally narrow: it provides a recovery path
// without exposing any company/candidate lifecycle controls to administrators.
router.post('/admin/placements/:id/terminate', isAuthenticated, authorize('admin'), async (req, res) => {
    try {
        if (!validPlacementId(req.params.id)) throw new PlacementLifecycleError('Placement not found.', 'PLACEMENT_NOT_FOUND', 404);
        const placement = await terminatePlacement({ placementId: req.params.id, actorId: userId(req), actorRole: 'admin', reason: req.body?.reason });
        await releaseSeatForTerminatedPlacement(placement);
        await notifyPlacement(Notification, {
            recipient: placement.candidate,
            type: 'placement_terminated',
            title: 'Internship placement ended',
            message: 'Your internship placement has been marked as terminated by an administrator.',
            link: `/candidate/placements/${placement._id}`,
            placement: placement._id,
            internship: placement.internship,
            application: placement.application,
            metadata: { placementId: placement._id }
        });
        if (wantsJson(req)) return res.json({ success: true, placement });
        if (req.flash) req.flash('success_msg', 'Placement terminated.');
        return res.redirect('/admin/dashboard');
    } catch (error) {
        return errorResponse(req, res, error, '/admin/dashboard');
    }
});

module.exports = router;
