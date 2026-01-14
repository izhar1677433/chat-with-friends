const mongoose = require('mongoose');

const CallSchema = new mongoose.Schema({
    from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    to: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['ringing', 'in-progress', 'ended'], default: 'ringing' },
    metadata: { type: Object },
    createdAt: { type: Date, default: Date.now },
    acceptedAt: { type: Date },
    endedAt: { type: Date },
    reason: { type: String }
}, { timestamps: true });

module.exports = mongoose.models.Call || mongoose.model('Call', CallSchema);
