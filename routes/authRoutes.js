const express = require('express');
const {
  registerUser,
  loginUser,
  verifyEmail,
  resendVerificationEmail,
  requestPasswordReset,
  resetPassword,
} = require('../controllers/authController');
const { authRateLimiter, recoveryRateLimiter } = require('../middleware/rateLimiters');

const router = express.Router();

router.post('/register', authRateLimiter, registerUser);
router.post('/login', authRateLimiter, loginUser);
router.post('/verify-email', recoveryRateLimiter, verifyEmail);
router.post('/resend-verification', recoveryRateLimiter, resendVerificationEmail);
router.post('/forgot-password', recoveryRateLimiter, requestPasswordReset);
router.post('/reset-password', recoveryRateLimiter, resetPassword);

module.exports = router;
