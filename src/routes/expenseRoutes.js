const express = require('express');
const expenseController = require('../controllers/expenseController');
const settlementPaymentController = require('../controllers/settlementPaymentController');
const authMiddleware = require('../middlewares/authMiddleware');
const { createExpenseValidators, updateExpenseValidators } = require('../validators/expenseValidators');

const router = express.Router();

// Protect all expense routes - user must be logged in
router.use(authMiddleware.protect);

// Create a new expense
router.post('/create', createExpenseValidators, expenseController.create);

// Get all expenses for a group
router.get('/group/:groupId', expenseController.getByGroup);

// Get settlement summary for a group
router.get('/settlement/:groupId', expenseController.getSettlement);

// Individual Settlement Payment routes (UPI peer-to-peer tracking)
router.post('/settlement-payment/create', settlementPaymentController.createPaymentRequest);
router.post('/settlement-payment/:paymentId/submit', settlementPaymentController.submitTransactionRef);
router.post('/settlement-payment/:paymentId/confirm', settlementPaymentController.confirmPayment);
router.post('/settlement-payment/:paymentId/reject', settlementPaymentController.rejectPayment);
router.get('/settlement-payment/group/:groupId', settlementPaymentController.getByGroup);

// Get expense by ID
router.get('/:expenseId', expenseController.getById);

// Update an expense
router.put('/:expenseId', updateExpenseValidators, expenseController.update);

// Delete an expense
router.delete('/:expenseId', expenseController.delete);

// Settle a group
router.post('/settle/:groupId', expenseController.settleGroup);

module.exports = router;
