const mongoose = require('mongoose');

const PLACEMENT_STATUSES = [
    'joining_pending',
    'joined',
    'in_progress',
    'completed',
    'terminated'
];

const placementEventSchema = new mongoose.Schema({
    status: { type: String, enum: PLACEMENT_STATUSES, required: true },
    action: { type: String, trim: true, maxlength: 80, default: '' },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    actorRole: { type: String, enum: ['candidate', 'company', 'admin', 'system'], required: true },
    at: { type: Date, default: Date.now },
    note: { type: String, trim: true, maxlength: 1000, default: '' }
}, { _id: false });

const placementSchema = new mongoose.Schema({
    offer: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Offer',
        required: true,
        unique: true,
        index: true
    },
    application: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Application',
        required: true,
        index: true
    },
    internship: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Internship',
        required: true,
        index: true
    },
    candidate: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    company: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    status: {
        type: String,
        enum: PLACEMENT_STATUSES,
        default: 'joining_pending',
        index: true
    },
    startDate: { type: Date, required: true, index: true },
    endDate: { type: Date, index: true },
    joinedAt: { type: Date },
    startedAt: { type: Date },
    completedAt: { type: Date },
    terminatedAt: { type: Date },
    terminationReason: { type: String, trim: true, maxlength: 1000, default: '' },
    terminatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    lastProgressAt: { type: Date, index: true },
    progressUpdates: [{
        title: { type: String, trim: true, maxlength: 160, required: true },
        details: { type: String, trim: true, maxlength: 4000, required: true },
        milestoneDate: { type: Date, default: Date.now },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        authorRole: { type: String, enum: ['candidate', 'company'], required: true },
        createdAt: { type: Date, default: Date.now }
    }],
    companyEvaluation: {
        rating: { type: Number, min: 1, max: 5 },
        strengths: { type: String, trim: true, maxlength: 2000, default: '' },
        improvementAreas: { type: String, trim: true, maxlength: 2000, default: '' },
        comments: { type: String, trim: true, maxlength: 4000, default: '' },
        recommendForFutureRoles: { type: Boolean },
        submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        submittedAt: { type: Date }
    },
    candidateFeedback: {
        rating: { type: Number, min: 1, max: 5 },
        comments: { type: String, trim: true, maxlength: 4000, default: '' },
        wouldRecommend: { type: Boolean },
        submittedAt: { type: Date }
    },
    certificate: { type: mongoose.Schema.Types.ObjectId, ref: 'Certificate', index: true },
    events: [placementEventSchema]
}, { timestamps: true });

placementSchema.index({ candidate: 1, status: 1, startDate: 1 });
placementSchema.index({ company: 1, status: 1, endDate: 1 });
placementSchema.statics.STATUSES = PLACEMENT_STATUSES;

module.exports = mongoose.model('Placement', placementSchema);
