const userDao = require('../dao/userDao');

const UPI_REGEX = /^[\w.\-_]{2,256}@[a-zA-Z0-9.\-_]{2,64}$/;

const usersController = {
  getUserInfo: async (request, response) => {
    try {
      const email = request.user.email;

      const user = await userDao.findByEmail(email);

      return response.json({ user });
    } catch (error) {
      return response.status(500).json({ message: 'Internal server error' });
    }
  },

  updateProfile: async (request, response) => {
    try {
      // Users can only update their own profile via authenticated session
      const email = request.user.email;
      const { upiId, name } = request.body;

      const user = await userDao.findByEmail(email);
      if (!user) {
        return response.status(404).json({ message: 'User not found' });
      }

      if (upiId !== undefined) {
        if (typeof upiId !== 'string') {
          return response.status(400).json({ message: 'UPI ID must be a string' });
        }

        const trimmedUpi = upiId.trim();

        if (trimmedUpi === '') {
          // Allow clearing UPI ID if sent empty
          user.upiId = undefined;
        } else {
          if (trimmedUpi.length < 5 || trimmedUpi.length > 100 || !UPI_REGEX.test(trimmedUpi)) {
            return response.status(400).json({
              message: 'Invalid UPI ID format. Expected format: username@bank (e.g. user@okhdfcbank)'
            });
          }
          user.upiId = trimmedUpi;
        }
      }

      if (name !== undefined) {
        if (typeof name !== 'string' || name.trim().length === 0) {
          return response.status(400).json({ message: 'Name cannot be empty' });
        }
        user.name = name.trim();
      }

      await user.save();

      // Return sanitized user object (omit password, etc.)
      const safeUser = {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        upiId: user.upiId,
        credits: user.credits,
        subscription: user.subscription
      };

      return response.status(200).json({
        message: 'Profile updated successfully',
        user: safeUser
      });
    } catch (error) {
      console.error('Error updating profile:', error);
      return response.status(500).json({ message: 'Internal server error' });
    }
  }
};

module.exports = usersController;
