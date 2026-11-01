const mongoose = require('mongoose');

const webhookEventSchema = new mongoose.Schema({
    eventId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    event: {
        type: String,
        required: true
    },
    status: {
        type: String,
        enum: ['processing', 'processed', 'failed'],
        default: 'processing',
        index: true
    },
    attempts: {
        type: Number,
        default: 1
    },
    lockedAt: {
        type: Date,
        default: Date.now
    },
    processedAt: {
        type: Date,
        default: null
    },
    lastError: {
        type: String,
        default: null
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('WebhookEvent', webhookEventSchema);
