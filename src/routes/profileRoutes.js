const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware');
const usersController = require('../controllers/profileController');

router.use(authMiddleware.protect);

router.get('/get-user-info', usersController.getUserInfo);
router.put('/update', usersController.updateProfile);
router.patch('/update', usersController.updateProfile);
router.put('/upi', usersController.updateProfile);
router.patch('/upi', usersController.updateProfile);
router.put('/', usersController.updateProfile);
router.patch('/', usersController.updateProfile);

module.exports = router;
