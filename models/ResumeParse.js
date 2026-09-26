const mongoose = require('mongoose');

// What the resume parser found on a candidate's latest upload. Kept apart from
// the profile so the student can see exactly what came from the file and what
// they typed in themselves. One document per candidate, replaced on upload.
const resumeParseSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    // The file this parse belongs to. The profile only shows the parse while
    // this is still the resume on file.
    resumeUrl: { type: String, default: '' },
    fileName: { type: String, default: '', trim: true },
    parsedAt: { type: Date, default: Date.now },
    status: {
        type: String,
        enum: ['ok', 'low_confidence', 'nothing_found', 'unreadable'],
        required: true
    },
    // Characters of text read from the file. Zero means nothing could be read.
    textLength: { type: Number, default: 0 },
    // Every skill the parser matched, and the ones the profile didn't have yet.
    skills: [{ type: String, trim: true }],
    newSkills: [{ type: String, trim: true }],
    qualification: { type: String, default: '', trim: true },
    // The profile's qualification before this upload.
    previousQualification: { type: String, default: '', trim: true }
}, { timestamps: true });

module.exports = mongoose.model('ResumeParse', resumeParseSchema);
