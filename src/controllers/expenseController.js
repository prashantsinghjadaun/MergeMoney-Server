const expenseDao = require('../dao/expenseDao');
const Group = require('../model/group');
const { validationResult } = require('express-validator');

const isGroupMember = (group, email) => {
    if (!group || !email) return false;
    const lower = email.toLowerCase();
    const isAdmin = group.adminEmail && group.adminEmail.toLowerCase() === lower;
    const isMember = Array.isArray(group.membersEmail) && group.membersEmail.some(m => m && m.toLowerCase() === lower);
    return Boolean(isAdmin || isMember);
};

const canModifyExpense = (group, expense, email) => {
    if (!group || !expense || !email) return false;
    const lower = email.toLowerCase();
    const isAdmin = group.adminEmail && group.adminEmail.toLowerCase() === lower;
    const isCreator = expense.createdBy && expense.createdBy.toLowerCase() === lower;
    const isPayer = expense.paidBy && expense.paidBy.toLowerCase() === lower;
    return Boolean(isAdmin || isCreator || isPayer);
};

const expenseController = {
    /**
     * Create a new expense in a group
     * @route POST /expenses/create
     * @access Private
     */
    create: async (request, response) => {
        try {
            // Check for validation errors
            const errors = validationResult(request);
            if (!errors.isEmpty()) {
                return response.status(400).json({
                    message: 'Validation error',
                    errors: errors.array()
                });
            }

            const user = request.user;
            const { groupId, title, description, amount, currency, paidBy, splits } = request.body;

            const group = await Group.findById(groupId);
            if (!group) {
                return response.status(404).json({
                    message: 'Group not found'
                });
            }

            if (!isGroupMember(group, user.email)) {
                return response.status(403).json({
                    message: 'Access denied: You are not a member of this group'
                });
            }

            // Validate that paidBy exists in splits
            const paidBySplit = splits.find(s => s.memberEmail === paidBy);
            if (!paidBySplit) {
                return response.status(400).json({
                    message: 'Person who paid must also be in the split'
                });
            }

            // Validate that splits add up correctly (with minor floating point tolerance)
            const totalSplit = splits.reduce((sum, s) => sum + s.amountOwed, 0);
            if (Math.abs(totalSplit - amount) > 0.01) {
                return response.status(400).json({
                    message: 'Split amounts must sum to total expense amount'
                });
            }

            const newExpense = await expenseDao.createExpense({
                groupId,
                title,
                description,
                amount,
                currency: currency || 'INR',
                paidBy,
                splits,
                createdBy: user.email
            });

            return response.status(201).json({
                message: 'Expense created successfully',
                expense: newExpense
            });
        } catch (error) {
            console.error('Expense creation error:', error);
            return response.status(500).json({
                message: 'Internal server error: ' + error.message
            });
        }
    },

    /**
     * Get all expenses for a specific group
     * @route GET /expenses/group/:groupId
     * @access Private
     */
    getByGroup: async (request, response) => {
        try {
            const { groupId } = request.params;

            const group = await Group.findById(groupId);
            if (!group) {
                return response.status(404).json({
                    message: 'Group not found'
                });
            }

            if (!isGroupMember(group, request.user.email)) {
                return response.status(403).json({
                    message: 'Access denied: You are not a member of this group'
                });
            }

            const expenses = await expenseDao.getExpensesByGroup(groupId);

            return response.status(200).json({
                expenses
            });
        } catch (error) {
            console.error(error);
            return response.status(500).json({
                message: 'Error fetching expenses'
            });
        }
    },

    /**
     * Get a specific expense by ID
     * @route GET /expenses/:expenseId
     * @access Private
     */
    getById: async (request, response) => {
        try {
            const { expenseId } = request.params;

            const expense = await expenseDao.getExpenseById(expenseId);
            if (!expense) {
                return response.status(404).json({
                    message: 'Expense not found'
                });
            }

            const group = await Group.findById(expense.groupId);
            if (!group || !isGroupMember(group, request.user.email)) {
                return response.status(403).json({
                    message: 'Access denied: You are not a member of this group'
                });
            }

            return response.status(200).json(expense);
        } catch (error) {
            console.error(error);
            return response.status(500).json({
                message: 'Error fetching expense'
            });
        }
    },

    /**
     * Update an expense
     * @route PUT /expenses/:expenseId
     * @access Private
     */
    update: async (request, response) => {
        try {
            const { expenseId } = request.params;
            const { title, description, amount, currency, paidBy, splits } = request.body;

            const expense = await expenseDao.getExpenseById(expenseId);
            if (!expense) {
                return response.status(404).json({
                    message: 'Expense not found'
                });
            }

            const group = await Group.findById(expense.groupId);
            if (!group) {
                return response.status(404).json({
                    message: 'Group not found'
                });
            }

            if (!isGroupMember(group, request.user.email)) {
                return response.status(403).json({
                    message: 'Access denied: You are not a member of this group'
                });
            }

            if (!canModifyExpense(group, expense, request.user.email)) {
                return response.status(403).json({
                    message: 'Access denied: Only the expense creator, payer, or group admin can update this expense'
                });
            }

            // Validate splits sum
            if (splits) {
                const totalSplit = splits.reduce((sum, s) => sum + s.amountOwed, 0);
                if (Math.abs(totalSplit - amount) > 0.01) {
                    return response.status(400).json({
                        message: 'Split amounts must sum to total expense amount'
                    });
                }
            }

            const updatedExpense = await expenseDao.updateExpense(expenseId, {
                title,
                description,
                amount,
                currency,
                paidBy,
                splits
            });

            if (!updatedExpense) {
                return response.status(404).json({
                    message: 'Expense not found'
                });
            }

            return response.status(200).json({
                message: 'Expense updated successfully',
                expense: updatedExpense
            });
        } catch (error) {
            console.error(error);
            return response.status(500).json({
                message: 'Error updating expense'
            });
        }
    },

    /**
     * Delete an expense
     * @route DELETE /expenses/:expenseId
     * @access Private
     */
    delete: async (request, response) => {
        try {
            const { expenseId } = request.params;

            const expense = await expenseDao.getExpenseById(expenseId);
            if (!expense) {
                return response.status(404).json({
                    message: 'Expense not found'
                });
            }

            const group = await Group.findById(expense.groupId);
            if (!group) {
                return response.status(404).json({
                    message: 'Group not found'
                });
            }

            if (!isGroupMember(group, request.user.email)) {
                return response.status(403).json({
                    message: 'Access denied: You are not a member of this group'
                });
            }

            if (!canModifyExpense(group, expense, request.user.email)) {
                return response.status(403).json({
                    message: 'Access denied: Only the expense creator, payer, or group admin can delete this expense'
                });
            }

            const deleted = await expenseDao.deleteExpense(expenseId);
            if (!deleted) {
                return response.status(404).json({
                    message: 'Expense not found'
                });
            }

            return response.status(200).json({
                message: 'Expense deleted successfully'
            });
        } catch (error) {
            console.error(error);
            return response.status(500).json({
                message: 'Error deleting expense'
            });
        }
    },

    /**
     * Get settlement summary for a group
     * Shows who owes what to whom in the group
     * @route GET /expenses/settlement/:groupId
     * @access Private
     */
    getSettlement: async (request, response) => {
        try {
            const { groupId } = request.params;

            const group = await Group.findById(groupId);
            if (!group) {
                return response.status(404).json({
                    message: 'Group not found'
                });
            }

            if (!isGroupMember(group, request.user.email)) {
                return response.status(403).json({
                    message: 'Access denied: You are not a member of this group'
                });
            }

            const settlement = await expenseDao.calculateGroupSettlement(groupId);

            return response.status(200).json({
                settlement
            });
        } catch (error) {
            console.error(error);
            return response.status(500).json({
                message: 'Error calculating settlement'
            });
        }
    },

    /**
     * Settle a group - deprecated legacy bypass
     * @route POST /expenses/settle/:groupId
     * @access Private
     */
    settleGroup: async (request, response) => {
        return response.status(410).json({
            message: 'Direct group settlement has been deprecated. Please settle balances individually using peer-to-peer UPI payments with creditor confirmation.'
        });
    }
};

module.exports = expenseController;
