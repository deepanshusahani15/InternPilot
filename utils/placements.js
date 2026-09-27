const Placement = require('../models/Placement');
const Certificate = require('../models/Certificate');
const Notification = require('../models/Notification');
const { generateCertificateId } = require('./certificateId');

const PLACEMENT_STATUSES = ['joining_pending', 'joined', 'in_progress', 'completed', 'terminated'];
const PROGRESS_REMINDER_DAYS = Math.max(1, Number.parseInt(process.env.PLACEMENT_PROGRESS_REMINDER_DAYS, 10) || 14);

class PlacementLifecycleError extends Error {
    constructor(message, code = 'PLACEMENT_LIFECYCLE_ERROR', statusCode = 400) {
        super(message);
        this.name = 'PlacementLifecycleError';
        this.code = code;
        this.statusCode = statusCode;
    }
}

function asId(value) {
    return value && value._id ? value._id : value;
}

function sameId(left, right) {
    return String(asId(left) || '') === String(asId(right) || '');
}

function cleanText(value, maxLength = 4000) {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function parseRating(value, label = 'Rating') {
    const rating = Number(value);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        throw new PlacementLifecycleError(`${label} must be a whole number from 1 to 5.`, 'INVALID_RATING');
    }
    return rating;
}

function parseBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
    return Boolean(value);
}

function placementEvent(status, action, actor, actorRole, at, note = '') {
    return { status, action, actor: actor || undefined, actorRole, at, note: cleanText(note, 1000) };
}

function endDateFromDuration(startDate, duration) {
    const match = String(duration || '').match(/^\s*(\d+)\s*(day|week|month|year)s?\s*$/i);
    if (!match) return undefined;
    const count = Number(match[1]);
    const unit = match[2].toLowerCase();
    const endDate = new Date(startDate);
    if (unit === 'day') endDate.setDate(endDate.getDate() + count);
    if (unit === 'week') endDate.setDate(endDate.getDate() + (count * 7));
    if (unit === 'month') endDate.setMonth(endDate.getMonth() + count);
    if (unit === 'year') endDate.setFullYear(endDate.getFullYear() + count);
    return endDate;
}

async function createPlacementForAcceptedOffer({
    offer,
    now = new Date(),
    PlacementModel = Placement
}) {
    if (!offer || offer.status !== 'accepted') {
        throw new PlacementLifecycleError('A placement can only be created for an accepted offer.', 'OFFER_NOT_ACCEPTED', 409);
    }
    const startDate = offer.terms?.startDate ? new Date(offer.terms.startDate) : new Date(now);
    if (Number.isNaN(startDate.getTime())) {
        throw new PlacementLifecycleError('The accepted offer has an invalid start date.', 'INVALID_START_DATE');
    }
    const payload = {
        offer: offer._id,
        application: offer.application,
        internship: offer.internship,
        candidate: offer.candidate,
        company: offer.company,
        status: 'joining_pending',
        startDate,
        endDate: endDateFromDuration(startDate, offer.terms?.duration),
        events: [placementEvent('joining_pending', 'offer_accepted', offer.candidate, 'candidate', now)]
    };

    // The unique offer index plus this upsert makes offer acceptance retries
    // safe: an accepted offer always maps to exactly one placement.
    if (typeof PlacementModel.findOneAndUpdate === 'function') {
        return PlacementModel.findOneAndUpdate(
            { offer: offer._id },
            { $setOnInsert: payload },
            { new: true, upsert: true, setDefaultsOnInsert: true }
        );
    }
    return PlacementModel.create(payload);
}

async function confirmJoining({ placementId, candidateId, now = new Date(), PlacementModel = Placement }) {
    const placement = await PlacementModel.findOne({ _id: placementId, candidate: candidateId });
    if (!placement) throw new PlacementLifecycleError('Placement not found.', 'PLACEMENT_NOT_FOUND', 404);
    if (placement.status !== 'joining_pending') {
        throw new PlacementLifecycleError('Joining can only be confirmed while it is pending.', 'INVALID_STATUS_TRANSITION', 409);
    }
    if (new Date(placement.startDate) > now) {
        throw new PlacementLifecycleError('Joining can only be confirmed on or after the agreed start date.', 'JOINING_TOO_EARLY', 409);
    }
    const updated = await PlacementModel.findOneAndUpdate(
        { _id: placementId, candidate: candidateId, status: 'joining_pending', startDate: { $lte: now } },
        {
            $set: { status: 'joined', joinedAt: now },
            $push: { events: placementEvent('joined', 'joining_confirmed', candidateId, 'candidate', now) }
        },
        { new: true }
    );
    if (!updated) throw new PlacementLifecycleError('This placement changed before joining could be confirmed.', 'PLACEMENT_CHANGED', 409);
    return updated;
}

async function startPlacement({ placementId, actorId, actorRole = 'candidate', ownerId = actorId, PlacementModel = Placement, now = new Date() }) {
    const query = actorRole === 'company'
        ? { _id: placementId, company: ownerId, status: 'joined' }
        : { _id: placementId, candidate: ownerId, status: 'joined' };
    const updated = await PlacementModel.findOneAndUpdate(
        query,
        {
            $set: { status: 'in_progress', startedAt: now, lastProgressAt: now },
            $push: { events: placementEvent('in_progress', 'internship_started', actorId, actorRole, now) }
        },
        { new: true }
    );
    if (!updated) throw new PlacementLifecycleError('Only a joined placement can be started.', 'INVALID_STATUS_TRANSITION', 409);
    return updated;
}

function progressPayload(input, actorId, actorRole, now) {
    const title = cleanText(input?.title, 160);
    const details = cleanText(input?.details, 4000);
    if (!title || !details) {
        throw new PlacementLifecycleError('A progress update needs both a title and details.', 'INVALID_PROGRESS_UPDATE');
    }
    const rawMilestoneDate = input?.milestoneDate ? new Date(input.milestoneDate) : now;
    if (Number.isNaN(rawMilestoneDate.getTime())) {
        throw new PlacementLifecycleError('Milestone date must be valid.', 'INVALID_PROGRESS_DATE');
    }
    return { title, details, milestoneDate: rawMilestoneDate, createdBy: actorId, authorRole: actorRole, createdAt: now };
}

async function addProgressUpdate({ placementId, actorId, actorRole, ownerId = actorId, input, now = new Date(), PlacementModel = Placement }) {
    const ownership = actorRole === 'company' ? { company: ownerId } : { candidate: ownerId };
    const update = progressPayload(input, actorId, actorRole, now);
    const placement = await PlacementModel.findOneAndUpdate(
        { _id: placementId, ...ownership, status: 'in_progress' },
        { $push: { progressUpdates: update }, $set: { lastProgressAt: now } },
        { new: true }
    );
    if (!placement) throw new PlacementLifecycleError('Progress updates are only available while the internship is in progress.', 'INVALID_STATUS_TRANSITION', 409);
    return placement;
}

function evaluationPayload(input, actorId, now) {
    return {
        rating: parseRating(input?.rating, 'Company evaluation rating'),
        strengths: cleanText(input?.strengths, 2000),
        improvementAreas: cleanText(input?.improvementAreas, 2000),
        comments: cleanText(input?.comments, 4000),
        recommendForFutureRoles: parseBoolean(input?.recommendForFutureRoles),
        submittedBy: actorId,
        submittedAt: now
    };
}

async function submitCompanyEvaluation({ placementId, companyId, actorId, input, now = new Date(), PlacementModel = Placement }) {
    const placement = await PlacementModel.findOneAndUpdate(
        { _id: placementId, company: companyId, status: { $in: ['joined', 'in_progress'] } },
        { $set: { companyEvaluation: evaluationPayload(input, actorId, now) } },
        { new: true }
    );
    if (!placement) throw new PlacementLifecycleError('This placement cannot be evaluated yet.', 'INVALID_STATUS_TRANSITION', 409);
    return placement;
}

function feedbackPayload(input, now) {
    return {
        rating: parseRating(input?.rating, 'Feedback rating'),
        comments: cleanText(input?.comments, 4000),
        wouldRecommend: parseBoolean(input?.wouldRecommend),
        submittedAt: now
    };
}

async function submitCandidateFeedback({ placementId, candidateId, input, now = new Date(), PlacementModel = Placement }) {
    const placement = await PlacementModel.findOneAndUpdate(
        { _id: placementId, candidate: candidateId, status: { $in: ['joined', 'in_progress'] } },
        { $set: { candidateFeedback: feedbackPayload(input, now) } },
        { new: true }
    );
    if (!placement) throw new PlacementLifecycleError('Feedback can only be submitted for an active placement.', 'INVALID_STATUS_TRANSITION', 409);
    return placement;
}

function ratingLabel(rating) {
    if (rating >= 5) return 'Outstanding';
    if (rating >= 4) return 'Exceeds Expectations';
    if (rating >= 3) return 'Very Good';
    return 'Good';
}

function displayName(user, fallback) {
    return user?.companyDetails?.companyName || user?.name || fallback;
}

async function createCompletionCertificate({ placement, issuerId, now, CertificateModel = Certificate, verificationBaseUrl = '' }) {
    if (placement.certificate) return CertificateModel.findById(placement.certificate);
    const candidate = placement.candidate || {};
    const company = placement.company || {};
    const internship = placement.internship || {};
    const certificateId = generateCertificateId();
    const verificationPath = `/verify/certificate/${certificateId}`;
    const certificate = await CertificateModel.create({
        placement: placement._id,
        certificateId,
        application: asId(placement.application),
        candidate: asId(candidate),
        company: asId(company),
        issuedBy: issuerId,
        internship: asId(internship),
        candidateName: displayName(candidate, 'Intern'),
        candidateEmail: candidate.email || '',
        companyName: displayName(company, internship.companyName || 'Company'),
        internshipTitle: internship.title || 'Internship',
        startDate: placement.startDate,
        completionDate: now,
        duration: placement.offer?.terms?.duration || internship.duration || 'Internship placement',
        skills: Array.isArray(internship.requiredSkills) ? internship.requiredSkills : [],
        performanceRating: ratingLabel(placement.companyEvaluation?.rating || 1),
        letterOfRecommendation: placement.companyEvaluation?.comments || '',
        verificationUrl: verificationBaseUrl ? `${verificationBaseUrl}${verificationPath}` : verificationPath
    });
    return certificate;
}

async function completePlacement({
    placementId,
    companyId,
    actorId,
    now = new Date(),
    PlacementModel = Placement,
    CertificateModel = Certificate,
    verificationBaseUrl = ''
}) {
    let placementQuery = PlacementModel.findOne({ _id: placementId, company: companyId });
    if (placementQuery && typeof placementQuery.populate === 'function') {
        placementQuery = placementQuery.populate('candidate company internship offer');
    }
    const placement = await placementQuery;
    if (!placement) throw new PlacementLifecycleError('Placement not found.', 'PLACEMENT_NOT_FOUND', 404);
    if (placement.status !== 'in_progress') {
        throw new PlacementLifecycleError('Only an in-progress placement can be completed.', 'INVALID_STATUS_TRANSITION', 409);
    }
    if (!placement.companyEvaluation?.submittedAt || !placement.candidateFeedback?.submittedAt) {
        throw new PlacementLifecycleError('Company evaluation and candidate feedback are required before completion.', 'COMPLETION_REQUIREMENTS_MISSING', 409);
    }

    let certificate;
    try {
        certificate = await createCompletionCertificate({ placement, issuerId: actorId, now, CertificateModel, verificationBaseUrl });
    } catch (error) {
        if (error?.code !== 11000) throw error;
        certificate = await CertificateModel.findOne({ placement: placement._id });
        if (!certificate) throw error;
    }
    const completed = await PlacementModel.findOneAndUpdate(
        { _id: placementId, company: companyId, status: 'in_progress' },
        {
            $set: { status: 'completed', completedAt: now, certificate: certificate._id },
            $push: { events: placementEvent('completed', 'completed', actorId, 'company', now) }
        },
        { new: true }
    );
    if (!completed) throw new PlacementLifecycleError('This placement changed before it could be completed.', 'PLACEMENT_CHANGED', 409);
    return { placement: completed, certificate };
}

async function terminatePlacement({ placementId, actorId, actorRole, ownerId = actorId, reason, PlacementModel = Placement, now = new Date() }) {
    const terminationReason = cleanText(reason, 1000);
    if (!terminationReason) throw new PlacementLifecycleError('A reason is required to terminate a placement.', 'TERMINATION_REASON_REQUIRED');
    const ownership = actorRole === 'company' ? { company: ownerId } : actorRole === 'candidate' ? { candidate: ownerId } : {};
    const placement = await PlacementModel.findOneAndUpdate(
        { _id: placementId, ...ownership, status: { $in: ['joining_pending', 'joined', 'in_progress'] } },
        {
            $set: { status: 'terminated', terminatedAt: now, terminationReason, terminatedBy: actorId },
            $push: { events: placementEvent('terminated', 'terminated', actorId, actorRole, now, terminationReason) }
        },
        { new: true }
    );
    if (!placement) throw new PlacementLifecycleError('This placement cannot be terminated.', 'INVALID_STATUS_TRANSITION', 409);
    return placement;
}

function dayKey(date) {
    return new Date(date).toISOString().slice(0, 10);
}

async function upsertReminder(NotificationModel, payload) {
    const filter = payload.recipient
        ? { recipient: payload.recipient, type: payload.type, 'metadata.reminderKey': payload.metadata.reminderKey }
        : { companyId: payload.companyId, type: payload.type, 'metadata.reminderKey': payload.metadata.reminderKey };
    if (typeof NotificationModel.findOneAndUpdate === 'function') {
        return NotificationModel.findOneAndUpdate(filter, { $setOnInsert: payload }, { new: true, upsert: true });
    }
    return NotificationModel.create(payload);
}

async function runPlacementReminders({ now = new Date(), PlacementModel = Placement, NotificationModel = Notification } = {}) {
    const placements = await PlacementModel.find({ status: { $in: ['joining_pending', 'joined', 'in_progress'] } });
    const reminders = [];
    for (const placement of placements) {
        const base = {
            placement: placement._id,
            internship: asId(placement.internship),
            application: asId(placement.application),
            link: `/placements/${placement._id}`
        };
        if (placement.status === 'joining_pending' && new Date(placement.startDate) <= now) {
            reminders.push(upsertReminder(NotificationModel, {
                ...base,
                recipient: asId(placement.candidate),
                type: 'placement_joining_reminder',
                title: 'Confirm your internship joining',
                message: 'Your internship start date has arrived. Confirm that you have joined.',
                metadata: { placementId: placement._id, reminderKey: `joining:${placement._id}:${dayKey(now)}` }
            }));
        }
        if (placement.status === 'in_progress') {
            const lastProgress = new Date(placement.lastProgressAt || placement.startedAt || placement.startDate);
            const dueAt = new Date(now.getTime() - (PROGRESS_REMINDER_DAYS * 24 * 60 * 60 * 1000));
            if (lastProgress <= dueAt) {
                reminders.push(upsertReminder(NotificationModel, {
                    ...base,
                    recipient: asId(placement.candidate),
                    type: 'placement_progress_reminder',
                    title: 'Share an internship progress update',
                    message: `No progress update has been recorded in ${PROGRESS_REMINDER_DAYS} days.`,
                    metadata: { placementId: placement._id, reminderKey: `progress:${placement._id}:${dayKey(now)}` }
                }));
            }
        }
        if (placement.endDate && new Date(placement.endDate) <= now) {
            if (!placement.companyEvaluation?.submittedAt) {
                reminders.push(upsertReminder(NotificationModel, {
                    ...base,
                    companyId: asId(placement.company),
                    type: 'placement_evaluation_reminder',
                    title: 'Submit final internship evaluation',
                    message: 'This internship has reached its end date and needs a final evaluation.',
                    metadata: { placementId: placement._id, reminderKey: `evaluation:${placement._id}:${dayKey(now)}` }
                }));
            }
            if (!placement.candidateFeedback?.submittedAt) {
                reminders.push(upsertReminder(NotificationModel, {
                    ...base,
                    recipient: asId(placement.candidate),
                    type: 'placement_feedback_reminder',
                    title: 'Share your internship feedback',
                    message: 'This internship has reached its end date. Your feedback is needed to complete it.',
                    metadata: { placementId: placement._id, reminderKey: `feedback:${placement._id}:${dayKey(now)}` }
                }));
            }
        }
    }
    await Promise.all(reminders);
    return reminders.length;
}

module.exports = {
    PLACEMENT_STATUSES,
    PROGRESS_REMINDER_DAYS,
    PlacementLifecycleError,
    sameId,
    endDateFromDuration,
    createPlacementForAcceptedOffer,
    confirmJoining,
    startPlacement,
    addProgressUpdate,
    submitCompanyEvaluation,
    submitCandidateFeedback,
    completePlacement,
    terminatePlacement,
    runPlacementReminders
};
