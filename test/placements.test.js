const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Placement = require('../models/Placement');
const Notification = require('../models/Notification');
const placementsRouter = require('../routes/placements');
const { acceptOffer } = require('../utils/offers');
const {
    PlacementLifecycleError,
    createPlacementForAcceptedOffer,
    confirmJoining,
    startPlacement,
    addProgressUpdate,
    submitCompanyEvaluation,
    submitCandidateFeedback,
    completePlacement,
    terminatePlacement,
    runPlacementReminders
} = require('../utils/placements');

const id = () => new mongoose.Types.ObjectId().toString();
const now = new Date('2026-09-27T10:00:00.000Z');

function activePlacement(overrides = {}) {
    return {
        _id: id(),
        offer: id(),
        application: id(),
        internship: { _id: id(), title: 'Backend Intern', duration: '3 Months', requiredSkills: ['Node.js'] },
        candidate: { _id: id(), name: 'Aarav', email: 'aarav@example.test' },
        company: { _id: id(), name: 'Acme Labs' },
        status: 'in_progress',
        startDate: new Date('2026-06-01T00:00:00.000Z'),
        startedAt: new Date('2026-06-01T00:00:00.000Z'),
        lastProgressAt: new Date('2026-09-01T00:00:00.000Z'),
        progressUpdates: [],
        companyEvaluation: { rating: 5, submittedAt: new Date('2026-09-25T00:00:00.000Z') },
        candidateFeedback: { rating: 4, submittedAt: new Date('2026-09-26T00:00:00.000Z') },
        ...overrides
    };
}

test('Placement model enforces its lifecycle and source references', () => {
    const invalid = new Placement({});
    const error = invalid.validateSync();
    assert.ok(error?.errors?.offer);
    assert.ok(error?.errors?.candidate);
    assert.ok(error?.errors?.startDate);

    const valid = new Placement({
        offer: new mongoose.Types.ObjectId(),
        application: new mongoose.Types.ObjectId(),
        internship: new mongoose.Types.ObjectId(),
        candidate: new mongoose.Types.ObjectId(),
        company: new mongoose.Types.ObjectId(),
        startDate: now,
        status: 'joining_pending',
        events: [{ status: 'joining_pending', action: 'offer_accepted', actorRole: 'candidate' }]
    });
    assert.equal(valid.validateSync(), undefined);
    valid.status = 'unknown';
    assert.ok(valid.validateSync()?.errors?.status);
});

test('an accepted offer creates one idempotent joining-pending placement', async () => {
    const offer = {
        _id: id(), application: id(), internship: id(), candidate: id(), company: id(), status: 'accepted',
        terms: { startDate: '2026-10-01', duration: '3 Months' }
    };
    let filter;
    let update;
    const PlacementModel = {
        async findOneAndUpdate(actualFilter, actualUpdate) {
            filter = actualFilter;
            update = actualUpdate;
            return { _id: id(), ...actualUpdate.$setOnInsert };
        }
    };
    const placement = await createPlacementForAcceptedOffer({ offer, now, PlacementModel });
    assert.equal(String(filter.offer), offer._id);
    assert.equal(placement.status, 'joining_pending');
    assert.equal(new Date(update.$setOnInsert.startDate).toISOString(), '2026-10-01T00:00:00.000Z');
    assert.equal(new Date(update.$setOnInsert.endDate).toISOString(), '2027-01-01T00:00:00.000Z');
    await assert.rejects(
        createPlacementForAcceptedOffer({ offer: { ...offer, status: 'issued' }, PlacementModel }),
        error => error instanceof PlacementLifecycleError && error.code === 'OFFER_NOT_ACCEPTED'
    );
});

test('offer acceptance creates the placement after the offer is accepted', async () => {
    const offer = {
        _id: id(), application: id(), internship: id(), candidate: id(), company: id(), status: 'issued', isActive: true,
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000), seatReserved: false, events: [],
        terms: { startDate: new Date('2026-10-01'), duration: '3 Months' }
    };
    const application = { _id: offer.application, candidate: offer.candidate, internship: offer.internship, status: 'Interview', statusHistory: [], notes: [] };
    const listing = { _id: offer.internship, status: 'published', isPaused: false, vacancies: 2, filledSeats: 0 };
    let placementPayload;
    const result = await acceptOffer({
        offerId: offer._id,
        candidateId: offer.candidate,
        now,
        CandidateVerificationModel: {
            async findOne() { return { status: 'approved' }; }
        },
        OfferModel: {
            async findOneAndUpdate(filter, update) {
                if (filter.status && filter.status !== offer.status) return null;
                Object.assign(offer, update.$set || {});
                if (update.$push?.events) offer.events.push(update.$push.events);
                return { ...offer };
            },
            async findOne() { return { ...offer }; },
            async updateOne() { return { modifiedCount: 1 }; }
        },
        ApplicationModel: {
            async findOne() { return { ...application }; },
            async findOneAndUpdate(filter, update) {
                Object.assign(application, update.$set || {});
                Object.entries(update.$push || {}).forEach(([key, value]) => {
                    application[key] = Array.isArray(application[key]) ? application[key] : [];
                    application[key].push(value);
                });
                return { ...application };
            }
        },
        InternshipModel: {
            async findOneAndUpdate() { listing.filledSeats += 1; return { ...listing }; },
            async updateOne() { return { modifiedCount: 1 }; }
        },
        PlacementModel: {
            async findOneAndUpdate(filter, update) {
                placementPayload = update.$setOnInsert;
                assert.equal(offer.status, 'accepted');
                return { _id: id(), ...placementPayload };
            }
        }
    });
    assert.equal(result.offer.status, 'accepted');
    assert.equal(result.placement.status, 'joining_pending');
    assert.equal(placementPayload.offer, offer._id);
});

test('joining can only be confirmed on or after the agreed start date', async () => {
    const placement = activePlacement({ status: 'joining_pending', startDate: new Date('2026-10-01T00:00:00.000Z') });
    const PlacementModel = {
        async findOne() { return placement; },
        async findOneAndUpdate(filter, update) { return { ...placement, ...update.$set, events: [update.$push.events] }; }
    };
    await assert.rejects(
        confirmJoining({ placementId: placement._id, candidateId: placement.candidate._id, now, PlacementModel }),
        error => error.code === 'JOINING_TOO_EARLY'
    );
    const joined = await confirmJoining({
        placementId: placement._id,
        candidateId: placement.candidate._id,
        now: new Date('2026-10-01T00:00:00.000Z'),
        PlacementModel
    });
    assert.equal(joined.status, 'joined');
    assert.equal(joined.events[0].action, 'joining_confirmed');
});

test('progress updates require an in-progress placement and are recorded with the actor', async () => {
    const placement = activePlacement();
    let update;
    const PlacementModel = {
        async findOneAndUpdate(filter, actualUpdate) { update = actualUpdate; return { ...placement, lastProgressAt: now, progressUpdates: [actualUpdate.$push.progressUpdates] }; }
    };
    const result = await addProgressUpdate({
        placementId: placement._id,
        actorId: placement.candidate._id,
        actorRole: 'candidate',
        input: { title: 'API endpoint complete', details: 'Implemented and tested the first service.', milestoneDate: '2026-09-27' },
        now,
        PlacementModel
    });
    assert.equal(result.progressUpdates[0].title, 'API endpoint complete');
    assert.equal(update.$push.progressUpdates.createdBy, placement.candidate._id);
    await assert.rejects(
        addProgressUpdate({ placementId: placement._id, actorId: placement.candidate._id, actorRole: 'candidate', input: { title: '', details: '' }, PlacementModel }),
        error => error.code === 'INVALID_PROGRESS_UPDATE'
    );
});

test('evaluation and feedback validate ratings before completion', async () => {
    const placement = activePlacement();
    const PlacementModel = { async findOneAndUpdate(filter, update) { return { ...placement, ...update.$set }; } };
    await assert.rejects(
        submitCompanyEvaluation({ placementId: placement._id, companyId: placement.company._id, actorId: placement.company._id, input: { rating: 6 }, PlacementModel }),
        error => error.code === 'INVALID_RATING'
    );
    const evaluation = await submitCompanyEvaluation({ placementId: placement._id, companyId: placement.company._id, actorId: placement.company._id, input: { rating: 5, comments: 'Excellent work.' }, now, PlacementModel });
    assert.equal(evaluation.companyEvaluation.rating, 5);
    const feedback = await submitCandidateFeedback({ placementId: placement._id, candidateId: placement.candidate._id, input: { rating: 4, comments: 'Strong mentoring.' }, now, PlacementModel });
    assert.equal(feedback.candidateFeedback.rating, 4);
});

test('completion requires both final inputs and generates a unique placement certificate', async () => {
    const placement = activePlacement();
    const PlacementModel = {
        async findOne() { return placement; },
        async findOneAndUpdate(filter, update) { return { ...placement, ...update.$set, events: [update.$push.events] }; }
    };
    let certificatePayload;
    const CertificateModel = {
        async create(payload) { certificatePayload = payload; return { _id: id(), ...payload }; },
        async findOne() { return null; }
    };
    const result = await completePlacement({
        placementId: placement._id,
        companyId: placement.company._id,
        actorId: placement.company._id,
        now,
        PlacementModel,
        CertificateModel,
        verificationBaseUrl: 'https://internpilot.example'
    });
    assert.equal(result.placement.status, 'completed');
    assert.equal(certificatePayload.placement, placement._id);
    assert.match(certificatePayload.certificateId, /^IP-\d{4}-/);
    assert.match(certificatePayload.verificationUrl, /^https:\/\/internpilot\.example\/verify\/certificate\//);

    const withoutFeedback = activePlacement({ candidateFeedback: {} });
    await assert.rejects(
        completePlacement({ placementId: withoutFeedback._id, companyId: withoutFeedback.company._id, actorId: withoutFeedback.company._id, PlacementModel: { async findOne() { return withoutFeedback; } }, CertificateModel }),
        error => error.code === 'COMPLETION_REQUIREMENTS_MISSING'
    );
});

test('termination needs a reason and only affects active placements', async () => {
    const placement = activePlacement();
    const PlacementModel = { async findOneAndUpdate(filter, update) { return { ...placement, ...update.$set, events: [update.$push.events] }; } };
    await assert.rejects(
        terminatePlacement({ placementId: placement._id, actorId: placement.company._id, actorRole: 'company', reason: '', PlacementModel }),
        error => error.code === 'TERMINATION_REASON_REQUIRED'
    );
    const result = await terminatePlacement({ placementId: placement._id, actorId: placement.company._id, actorRole: 'company', reason: 'Candidate withdrew before completion.', now, PlacementModel });
    assert.equal(result.status, 'terminated');
    assert.equal(result.terminationReason, 'Candidate withdrew before completion.');
});

test('overdue placement actions produce appropriate reminders', async () => {
    const waitingToJoin = activePlacement({ status: 'joining_pending', startDate: new Date('2026-09-20'), endDate: undefined });
    const overdueCompletion = activePlacement({
        status: 'in_progress',
        startDate: new Date('2026-06-01'),
        lastProgressAt: new Date('2026-08-01'),
        endDate: new Date('2026-09-01'),
        companyEvaluation: {},
        candidateFeedback: {}
    });
    const notifications = [];
    const total = await runPlacementReminders({
        now,
        PlacementModel: { async find() { return [waitingToJoin, overdueCompletion]; } },
        NotificationModel: { async findOneAndUpdate(filter, update) { notifications.push(update.$setOnInsert); return update.$setOnInsert; } }
    });
    assert.equal(total, 4);
    assert.deepEqual(notifications.map(notification => notification.type).sort(), [
        'placement_evaluation_reminder',
        'placement_feedback_reminder',
        'placement_joining_reminder',
        'placement_progress_reminder'
    ]);
});

test('placement notifications and route surface are registered', async () => {
    await assert.doesNotReject(new Notification({ recipient: new mongoose.Types.ObjectId(), type: 'placement_joining_reminder', title: 'Reminder', message: 'Confirm joining.' }).validate());
    const routes = placementsRouter.stack.filter(layer => layer.route).map(layer => ({ path: layer.route.path, methods: Object.keys(layer.route.methods) }));
    const has = (path, method) => routes.some(route => route.path === path && route.methods.includes(method));
    assert.ok(has('/candidate/placements/:id/confirm-joining', 'post'));
    assert.ok(has('/candidate/placements/:id/progress', 'post'));
    assert.ok(has('/company/placements/:id/evaluation', 'post'));
    assert.ok(has('/company/placements/:id/complete', 'post'));
    assert.ok(has('/company/placements/:id/terminate', 'post'));
});
