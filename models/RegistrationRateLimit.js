const mongoose = require('mongoose');

// A short-lived, hashed registration-attempt counter. Keeping this in MongoDB
// makes the registration limit consistent across application processes and
// deploy restarts; the TTL index removes finished windows automatically.
const registrationRateLimitSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true, maxlength: 160 },
    totalHits: { type: Number, required: true, default: 0, min: 0 },
    expiresAt: { type: Date, required: true }
}, { versionKey: false });

registrationRateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('RegistrationRateLimit', registrationRateLimitSchema);
