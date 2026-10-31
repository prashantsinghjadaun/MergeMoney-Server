const { body } = require('express-validator');

const loginValidators = [
    body('email')
        .notEmpty().withMessage("Email is required")
        .isEmail().withMessage("Provided email is not valid"),
    body('password')
        .notEmpty().withMessage("Password is required")
        .isLength({ min: 3 }).withMessage("Password must be atleast 3 character long")
];

const registerValidators = [
    body('name')
        .trim()
        .notEmpty().withMessage("Name is required")
        .isLength({ min: 2, max: 50 }).withMessage("Name must be between 2 and 50 characters"),
    body('email')
        .trim()
        .notEmpty().withMessage("Email is required")
        .isEmail().withMessage("Please enter a valid email"),
    body('password')
        .notEmpty().withMessage("Password is required")
        .isLength({ min: 6 }).withMessage("Password must be at least 6 characters")
];

module.exports = {
    loginValidators,
    registerValidators
};