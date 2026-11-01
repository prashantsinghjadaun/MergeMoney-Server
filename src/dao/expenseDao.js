const Expense = require('../model/expense');
const SettlementPayment = require('../model/settlementPayment');
const User = require('../model/user');
const Group = require('../model/group');

const expenseDao = {
    createExpense: async (expenseData) => {
        try {
            const newExpense = new Expense(expenseData);
            return await newExpense.save();
        } catch (error) {
            console.log(error);
            throw {
                error: 'Failed to create expense'
            };
        }
    },

    getExpenseById: async (expenseId) => {
        try {
            return await Expense.findById(expenseId);
        } catch (error) {
            console.log(error);
            throw {
                message: 'Internal server error'
            };
        }
    },

    getExpensesByGroup: async (groupId) => {
        try {
            return await Expense.find({ groupId }).sort({ createdAt: -1 });
        } catch (error) {
            console.log(error);
            throw {
                message: 'Failed to fetch expenses'
            };
        }
    },

    updateExpense: async (expenseId, updateData) => {
        try {
            return await Expense.findByIdAndUpdate(expenseId, updateData, { new: true });
        } catch (error) {
            console.log(error);
            throw {
                message: 'Failed to update expense'
            };
        }
    },

    deleteExpense: async (expenseId) => {
        try {
            const result = await Expense.findByIdAndDelete(expenseId);
            return result ? true : false;
        } catch (error) {
            console.log(error);
            throw {
                message: 'Failed to delete expense'
            };
        }
    },

    calculateGroupSettlement: async (groupId) => {
        try {
            const group = await Group.findById(groupId);
            const expenses = await Expense.find({ groupId });
            const confirmedPayments = await SettlementPayment.find({
                groupId,
                status: 'confirmed'
            });

            if (expenses.length === 0 && confirmedPayments.length === 0) {
                return { balances: [], settlements: [] };
            }

            // Step 1: Calculate each member's net balance.
            // Positive = they are owed money (creditor), Negative = they owe money (debtor).
            const balanceMap = {};

            // Initialize all group members with zero balance
            if (group?.membersEmail && Array.isArray(group.membersEmail)) {
                group.membersEmail.forEach(email => {
                    if (email) balanceMap[email] = 0;
                });
            }

            expenses.forEach(expense => {
                const payer = expense.paidBy;
                // The payer paid the full amount, so they are owed the total
                balanceMap[payer] = (balanceMap[payer] || 0) + expense.amount;

                expense.splits.forEach(split => {
                    // Each split member owes their share
                    balanceMap[split.memberEmail] = (balanceMap[split.memberEmail] || 0) - split.amountOwed;
                });
            });

            // Adjust net balances for confirmed peer settlements:
            // Payer transferred funds out (+ net balance), Payee received funds (- net balance)
            confirmedPayments.forEach(payment => {
                balanceMap[payment.payerEmail] = (balanceMap[payment.payerEmail] || 0) + payment.amount;
                balanceMap[payment.payeeEmail] = (balanceMap[payment.payeeEmail] || 0) - payment.amount;
            });

            // Build the balances array for the frontend
            const balances = Object.entries(balanceMap)
                .map(([member, rawBalance]) => {
                    const balance = Math.round(rawBalance * 100) / 100;
                    return {
                        member,
                        amount: Math.abs(balance),
                        owes: balance < -0.005,
                        balance
                    };
                })
                .sort((a, b) => a.balance - b.balance); // debtors first

            // Step 2: Generate simplified settlement suggestions using the
            // greedy algorithm: pair the largest debtor with the largest creditor.
            const debtors = []; // { member, amount } where amount > 0 means they owe
            const creditors = []; // { member, amount } where amount > 0 means they are owed

            for (const entry of balances) {
                if (entry.balance < -0.005) {
                    debtors.push({ member: entry.member, amount: Math.abs(entry.balance) });
                } else if (entry.balance > 0.005) {
                    creditors.push({ member: entry.member, amount: entry.balance });
                }
            }

            // Sort both descending by amount for greedy matching
            debtors.sort((a, b) => b.amount - a.amount);
            creditors.sort((a, b) => b.amount - a.amount);

            // Look up payee UPI details for the settlement suggestions
            const creditorEmails = creditors.map(c => c.member);
            const creditorUsers = await User.find({ email: { $in: creditorEmails } }, 'email name upiId');
            const userMap = {};
            creditorUsers.forEach(u => {
                if (u.email) userMap[u.email.toLowerCase()] = u;
            });

            const settlements = [];
            let di = 0;
            let ci = 0;

            while (di < debtors.length && ci < creditors.length) {
                const transferAmount = Math.min(debtors[di].amount, creditors[ci].amount);
                const rounded = Math.round(transferAmount * 100) / 100;

                if (rounded > 0) {
                    const toEmail = creditors[ci].member;
                    const payee = userMap[toEmail.toLowerCase()];
                    settlements.push({
                        from: debtors[di].member,
                        to: toEmail,
                        amount: rounded,
                        payeeName: payee?.name || toEmail,
                        payeeUpiId: payee?.upiId || null,
                        payeeHasUpi: Boolean(payee?.upiId && payee.upiId.trim().length > 0)
                    });
                }

                debtors[di].amount -= transferAmount;
                creditors[ci].amount -= transferAmount;

                if (debtors[di].amount < 0.005) di++;
                if (creditors[ci].amount < 0.005) ci++;
            }

            return { balances, settlements };
        } catch (error) {
            console.log(error);
            throw {
                message: 'Failed to calculate settlement'
            };
        }
    }
};

module.exports = expenseDao;