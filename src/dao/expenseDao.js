const Expense = require('../model/expense');

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
            const expenses = await Expense.find({ groupId });

            if (expenses.length === 0) {
                return { balances: [], settlements: [] };
            }

            // Step 1: Calculate each member's net balance.
            // Positive = they are owed money (creditor), Negative = they owe money (debtor).
            const balanceMap = {};

            expenses.forEach(expense => {
                const payer = expense.paidBy;
                // The payer paid the full amount, so they are owed the total
                balanceMap[payer] = (balanceMap[payer] || 0) + expense.amount;

                expense.splits.forEach(split => {
                    // Each split member owes their share
                    balanceMap[split.memberEmail] = (balanceMap[split.memberEmail] || 0) - split.amountOwed;
                });
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

            const settlements = [];
            let di = 0;
            let ci = 0;

            while (di < debtors.length && ci < creditors.length) {
                const transferAmount = Math.min(debtors[di].amount, creditors[ci].amount);
                const rounded = Math.round(transferAmount * 100) / 100;

                if (rounded > 0) {
                    settlements.push({
                        from: debtors[di].member,
                        to: creditors[ci].member,
                        amount: rounded
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