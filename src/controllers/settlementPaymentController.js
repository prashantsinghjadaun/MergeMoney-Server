const SettlementPayment = require('../model/settlementPayment');
const Group = require('../model/group');
const User = require('../model/user');
const expenseDao = require('../dao/expenseDao');

// In-memory mutex per (groupId, payer, payee) to prevent race conditions during concurrent payment creation
const pairLocks = new Map();

async function withPairLock(lockKey, fn) {
    while (pairLocks.has(lockKey)) {
        await pairLocks.get(lockKey);
    }
    let resolveLock;
    const lockPromise = new Promise(resolve => { resolveLock = resolve; });
    pairLocks.set(lockKey, lockPromise);

    try {
        return await fn();
    } finally {
        pairLocks.delete(lockKey);
        resolveLock();
    }
}

const settlementPaymentController = {
    /**
     * Create a payment request for a suggested settlement
     * Generates a standard NPCI UPI intent deep link
     * @route POST /expenses/settlement-payment/create
     * @access Private
     */
    createPaymentRequest: async (request, response) => {
        try {
            const user = request.user;
            const { groupId, payeeEmail, amount } = request.body;

            if (!groupId || !payeeEmail || amount === undefined) {
                return response.status(400).json({
                    message: 'groupId, payeeEmail, and amount are required'
                });
            }

            const parsedAmount = Number(amount);
            if (isNaN(parsedAmount) || parsedAmount <= 0) {
                return response.status(400).json({
                    message: 'Amount must be a positive number greater than 0'
                });
            }

            const roundedAmount = Math.round(parsedAmount * 100) / 100;

            // Fetch group
            const group = await Group.findById(groupId);
            if (!group) {
                return response.status(404).json({
                    message: 'Group not found'
                });
            }

            const normalizedPayer = user.email.toLowerCase();
            const normalizedPayee = payeeEmail.toLowerCase();

            // Verify payer membership
            const isPayerMember = group.membersEmail.some(m => m.toLowerCase() === normalizedPayer);
            if (!isPayerMember) {
                return response.status(403).json({
                    message: 'You are not a member of this group'
                });
            }

            // Verify payee membership
            const isPayeeMember = group.membersEmail.some(m => m.toLowerCase() === normalizedPayee);
            if (!isPayeeMember) {
                return response.status(400).json({
                    message: 'Payee is not a member of this group'
                });
            }

            if (normalizedPayer === normalizedPayee) {
                return response.status(400).json({
                    message: 'Payer and payee cannot be the same member'
                });
            }

            // Fetch payee user details
            const payeeUser = await User.findOne({ email: normalizedPayee });
            if (!payeeUser) {
                return response.status(404).json({
                    message: 'Payee account not found'
                });
            }

            // Require payee to have a saved UPI ID
            if (!payeeUser.upiId || payeeUser.upiId.trim() === '') {
                return response.status(400).json({
                    message: 'Payee has not set up a UPI ID yet. They must add a UPI ID in their profile to receive payments.'
                });
            }

            // Fetch payer user document
            const payerUser = await User.findOne({ email: normalizedPayer });
            if (!payerUser) {
                return response.status(404).json({
                    message: 'Payer account not found'
                });
            }

            // Check outstanding balance to prevent overpayment
            const lockKey = `${groupId}:${normalizedPayer}:${normalizedPayee}`;
            const result = await withPairLock(lockKey, async () => {
                const settlementData = await expenseDao.calculateGroupSettlement(groupId);
                const suggested = settlementData.settlements.find(
                    s => s.from.toLowerCase() === normalizedPayer && s.to.toLowerCase() === normalizedPayee
                );

                const totalOwed = suggested ? suggested.amount : 0;

                // Subtract any in-flight (pending or submitted) payments for this pair
                const inFlightPayments = await SettlementPayment.find({
                    groupId,
                    payerEmail: normalizedPayer,
                    payeeEmail: normalizedPayee,
                    status: { $in: ['pending', 'submitted'] }
                });

                const inFlightAmount = inFlightPayments.reduce((sum, p) => sum + p.amount, 0);
                const maxPayable = Math.max(0, Math.round((totalOwed - inFlightAmount) * 100) / 100);

                if (maxPayable <= 0) {
                    return {
                        status: 400,
                        body: {
                            message: 'No outstanding balance owed to this payee, or remaining balance is already pending in an active payment request.'
                        }
                    };
                }

                if (roundedAmount > maxPayable + 0.005) {
                    return {
                        status: 400,
                        body: {
                            message: `Amount ₹${roundedAmount.toFixed(2)} exceeds the remaining payable balance of ₹${maxPayable.toFixed(2)}`
                        }
                    };
                }

                // Generate NPCI standard UPI deep link
                const upiParams = new URLSearchParams({
                    pa: payeeUser.upiId,
                    pn: payeeUser.name,
                    am: roundedAmount.toFixed(2),
                    cu: 'INR',
                    tn: `MergeMoney: ${group.name} settlement`
                });
                const upiLink = `upi://pay?${upiParams.toString()}`;

                // Create SettlementPayment in 'pending' status
                const newPayment = await SettlementPayment.create({
                    groupId,
                    payerId: payerUser._id,
                    payeeId: payeeUser._id,
                    payerEmail: normalizedPayer,
                    payeeEmail: normalizedPayee,
                    amount: roundedAmount,
                    currency: 'INR',
                    status: 'pending',
                    upiLink
                });

                return {
                    status: 201,
                    body: {
                        message: 'Payment request created. Complete the transfer using the UPI link and submit the reference number.',
                        payment: newPayment,
                        upiLink
                    }
                };
            });

            return response.status(result.status).json(result.body);
        } catch (error) {
            console.error('Error creating payment request:', error);
            return response.status(500).json({
                message: 'Internal server error while creating payment request'
            });
        }
    },

    /**
     * Payer submits the UPI transaction reference (UTR)
     * Status changes to 'submitted'
     * @route POST /expenses/settlement-payment/:paymentId/submit
     * @access Private
     */
    submitTransactionRef: async (request, response) => {
        try {
            const user = request.user;
            const { paymentId } = request.params;
            const { upiTransactionRef } = request.body;

            if (!upiTransactionRef || typeof upiTransactionRef !== 'string') {
                return response.status(400).json({
                    message: 'A valid upiTransactionRef string is required'
                });
            }

            const trimmedRef = upiTransactionRef.trim();
            // Validate UTR / transaction reference: alphanumeric, 6 to 50 characters
            if (!/^[a-zA-Z0-9\-]{6,50}$/.test(trimmedRef)) {
                return response.status(400).json({
                    message: 'Invalid UPI transaction reference format. Must be 6-50 alphanumeric characters.'
                });
            }

            const payment = await SettlementPayment.findById(paymentId);
            if (!payment) {
                return response.status(404).json({
                    message: 'Payment request not found'
                });
            }

            // Only payer can submit
            if (payment.payerEmail.toLowerCase() !== user.email.toLowerCase()) {
                return response.status(403).json({
                    message: 'Only the payer can submit the UPI transaction reference'
                });
            }

            if (payment.status !== 'pending') {
                return response.status(400).json({
                    message: `Payment is already in '${payment.status}' status and cannot be submitted`
                });
            }

            // Check for duplicate reference
            const existingRef = await SettlementPayment.findOne({
                upiTransactionRef: trimmedRef,
                _id: { $ne: payment._id }
            });

            if (existingRef) {
                return response.status(400).json({
                    message: 'This UPI transaction reference has already been submitted for another payment'
                });
            }

            payment.upiTransactionRef = trimmedRef;
            payment.status = 'submitted';
            payment.submittedAt = new Date();
            await payment.save();

            return response.status(200).json({
                message: 'UPI transaction reference submitted successfully. Awaiting recipient confirmation.',
                payment
            });
        } catch (error) {
            if (error.code === 11000) {
                return response.status(400).json({
                    message: 'This UPI transaction reference has already been submitted for another payment'
                });
            }
            console.error('Error submitting transaction reference:', error);
            return response.status(500).json({
                message: 'Internal server error while submitting transaction reference'
            });
        }
    },

    /**
     * Recipient confirms receipt of payment
     * Status changes from 'submitted' to 'confirmed'
     * @route POST /expenses/settlement-payment/:paymentId/confirm
     * @access Private
     */
    confirmPayment: async (request, response) => {
        try {
            const user = request.user;
            const { paymentId } = request.params;
            const normalizedEmail = user.email.toLowerCase();

            // Atomic findOneAndUpdate prevents race conditions and duplicate confirmations
            const confirmedPayment = await SettlementPayment.findOneAndUpdate(
                {
                    _id: paymentId,
                    payeeEmail: normalizedEmail,
                    status: 'submitted'
                },
                {
                    $set: {
                        status: 'confirmed',
                        confirmedAt: new Date()
                    }
                },
                { new: true }
            );

            if (confirmedPayment) {
                return response.status(200).json({
                    message: 'Payment confirmed successfully. Balances have been updated.',
                    payment: confirmedPayment
                });
            }

            // Determine specific error reason
            const existing = await SettlementPayment.findById(paymentId);
            if (!existing) {
                return response.status(404).json({
                    message: 'Payment request not found'
                });
            }

            if (existing.payeeEmail.toLowerCase() !== normalizedEmail) {
                return response.status(403).json({
                    message: 'Only the intended recipient can confirm this payment'
                });
            }

            if (existing.status === 'confirmed') {
                return response.status(400).json({
                    message: 'Payment has already been confirmed'
                });
            }

            if (existing.status === 'pending') {
                return response.status(400).json({
                    message: 'Payment is still in pending status. Payer must submit a transaction reference before confirmation.'
                });
            }

            if (existing.status === 'rejected') {
                return response.status(400).json({
                    message: 'Payment has already been rejected'
                });
            }

            return response.status(400).json({
                message: `Cannot confirm payment in '${existing.status}' status`
            });
        } catch (error) {
            console.error('Error confirming payment:', error);
            return response.status(500).json({
                message: 'Internal server error while confirming payment'
            });
        }
    },

    /**
     * Recipient rejects payment OR Payer cancels unsubmitted pending payment
     * @route POST /expenses/settlement-payment/:paymentId/reject
     * @access Private
     */
    rejectPayment: async (request, response) => {
        try {
            const user = request.user;
            const { paymentId } = request.params;
            const { reason } = request.body || {};
            const normalizedEmail = user.email.toLowerCase();

            const existing = await SettlementPayment.findById(paymentId);
            if (!existing) {
                return response.status(404).json({
                    message: 'Payment request not found'
                });
            }

            const isPayee = existing.payeeEmail.toLowerCase() === normalizedEmail;
            const isPayer = existing.payerEmail.toLowerCase() === normalizedEmail;

            if (!isPayee && !isPayer) {
                return response.status(403).json({
                    message: 'Only the recipient or payer can reject or cancel this payment'
                });
            }

            if (existing.status === 'confirmed') {
                return response.status(400).json({
                    message: 'Confirmed payments cannot be rejected'
                });
            }

            if (existing.status === 'rejected') {
                return response.status(400).json({
                    message: 'Payment has already been rejected'
                });
            }

            // Payer can only cancel if it's still unsubmitted ('pending')
            if (isPayer && !isPayee && existing.status !== 'pending') {
                return response.status(400).json({
                    message: 'Payer can only cancel an unsubmitted pending payment'
                });
            }

            const defaultReason = isPayer && !isPayee ? 'Cancelled by payer' : 'Payment rejected by recipient';
            const rejectionReason = reason ? String(reason).trim() : defaultReason;

            // Atomic update to avoid race conditions
            const query = {
                _id: paymentId,
                status: isPayer && !isPayee ? 'pending' : { $in: ['pending', 'submitted'] }
            };

            const rejectedPayment = await SettlementPayment.findOneAndUpdate(
                query,
                {
                    $set: {
                        status: 'rejected',
                        rejectionReason
                    }
                },
                { new: true }
            );

            if (rejectedPayment) {
                const message = isPayer && !isPayee ? 'Payment request cancelled successfully.' : 'Payment rejected.';
                return response.status(200).json({
                    message,
                    payment: rejectedPayment
                });
            }

            return response.status(400).json({
                message: `Cannot cancel or reject payment in '${existing.status}' status`
            });
        } catch (error) {
            console.error('Error rejecting payment:', error);
            return response.status(500).json({
                message: 'Internal server error while rejecting payment'
            });
        }
    },

    /**
     * Get all settlement payments for a group
     * @route GET /expenses/settlement-payment/group/:groupId
     * @access Private
     */
    getByGroup: async (request, response) => {
        try {
            const user = request.user;
            const { groupId } = request.params;

            const group = await Group.findById(groupId);
            if (!group) {
                return response.status(404).json({
                    message: 'Group not found'
                });
            }

            const isMember = group.membersEmail.some(
                m => m.toLowerCase() === user.email.toLowerCase()
            );

            if (!isMember) {
                return response.status(403).json({
                    message: 'You are not a member of this group'
                });
            }

            const payments = await SettlementPayment.find({ groupId })
                .sort({ createdAt: -1 });

            return response.status(200).json({
                payments
            });
        } catch (error) {
            console.error('Error fetching group settlement payments:', error);
            return response.status(500).json({
                message: 'Internal server error while fetching settlement payments'
            });
        }
    }
};

module.exports = settlementPaymentController;

