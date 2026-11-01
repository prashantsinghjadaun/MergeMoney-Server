const mongoose = require('mongoose');

const settlementPaymentSchema = new mongoose.Schema({
    groupId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Group',
        required: true,
        index: true
    },
    payerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    payeeId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    payerEmail: {
        type: String,
        required: true,
        trim: true,
        lowercase: true
    },
    payeeEmail: {
        type: String,
        required: true,
        trim: true,
        lowercase: true
    },
    amount: {
        type: Number,
        required: true,
        min: 0.01
    },
    currency: {
        type: String,
        default: 'INR'
    },
    status: {
        type: String,
        enum: ['pending', 'submitted', 'confirmed', 'rejected'],
        default: 'pending',
        index: true
    },
    upiTransactionRef: {
        type: String,
        trim: true,
        unique: true,
        sparse: true
    },
    upiLink: {
        type: String,
        required: false
    },
    rejectionReason: {
        type: String,
        trim: true,
        required: false
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    submittedAt: {
        type: Date,
        default: null
    },
    confirmedAt: {
        type: Date,
        default: null
    }
});

settlementPaymentSchema.index({ groupId: 1, payerEmail: 1, payeeEmail: 1, status: 1 });

module.exports = mongoose.model('SettlementPayment', settlementPaymentSchema);

