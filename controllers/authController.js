const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const { sendAccountEmail } = require('../utils/emailService');
const logger = require('../utils/logger');

function createToken(user) {
  return jwt.sign({ ver: user.tokenVersion }, process.env.JWT_SECRET, {
    subject: user.id,
    expiresIn: process.env.JWT_EXPIRES_IN || '1d',
    algorithm: 'HS256',
  });
}

function userResponse(user, token) {
  return {
    success: true,
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      isAdmin: user.isAdmin,
    },
  };
}

function createOneTimeToken() {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, tokenHash: crypto.createHash('sha256').update(token).digest('hex') };
}

function getFrontendUrl(path, token) {
  const url = new URL(path, process.env.APP_URL || 'http://localhost:3000');
  url.hash = new URLSearchParams({ token }).toString();
  return url.toString();
}

function isEmailConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_PORT &&
    process.env.SMTP_USER && process.env.SMTP_PASSWORD && process.env.EMAIL_FROM);
}

async function deliverOrReturnToken({ userId, email, token, path, subject, purpose }) {
  if (!isEmailConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('auth.email_not_configured', { purpose });
      return false;
    }
    return true;
  }

  try {
    await sendAccountEmail({
      to: email,
      subject,
      text: `Use this link to continue: ${getFrontendUrl(path, token)}`,
    });
    return true;
  } catch (error) {
    logger.error('auth.email_delivery_failed', {
      purpose,
      userId,
      error: error.message,
    });
    return false;
  }
}

function localTokenResponse(token, path) {
  return process.env.NODE_ENV === 'production'
    ? {}
    : { development: { token, frontendPath: path } };
}

async function registerUser(req, res, next) {
  try {
    const { name, email, password } = req.body;
    if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
      throw new AppError('Name, email, and password are required.', 400);
    }
    if (password.length < 8) {
      throw new AppError('Password must be at least 8 characters.', 400);
    }
    if (Buffer.byteLength(password, 'utf8') > 72) {
      throw new AppError('Password cannot exceed 72 UTF-8 bytes.', 400);
    }

    const { token, tokenHash } = createOneTimeToken();
    const user = User.create({
      name,
      email,
      password,
      emailVerificationTokenHash: tokenHash,
      emailVerificationExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    const delivered = await deliverOrReturnToken({
      userId: user.id,
      email: user.email,
      token,
      path: '/verify-email',
      subject: 'Verify your email address',
      purpose: 'email_verification',
    });

    return res.status(201).json({
      success: true,
      message: delivered
        ? 'Account created. Verify your email before logging in.'
        : 'Account created, but email delivery failed. Configure SMTP and request another verification email.',
      ...localTokenResponse(token, '/verify-email'),
    });
  } catch (error) {
    return next(error);
  }
}

async function loginUser(req, res, next) {
  try {
    const { email, password } = req.body;
    if (typeof email !== 'string' || typeof password !== 'string') {
      throw new AppError('Email and password are required.', 400);
    }
    const user = User.findForLogin(email);
    if (!user || Buffer.byteLength(password, 'utf8') > 72 ||
      !User.comparePassword(password, user.passwordHash)) {
      throw new AppError('Invalid email or password.', 401);
    }
    if (!user.isEmailVerified) {
      throw new AppError('Verify your email address before logging in.', 403);
    }
    return res.status(200).json(userResponse(user, createToken(user)));
  } catch (error) {
    return next(error);
  }
}

async function verifyEmail(req, res, next) {
  try {
    const { token } = req.body;
    if (typeof token !== 'string' || token.length !== 64) {
      throw new AppError('A valid verification token is required.', 400);
    }
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const user = User.findByVerificationToken(tokenHash);
    if (!user) {
      throw new AppError('Verification link is invalid or expired.', 400);
    }
    User.verifyEmail(user.id);
    return res.status(200).json({ success: true, message: 'Email address verified.' });
  } catch (error) {
    return next(error);
  }
}

async function resendVerificationEmail(req, res, next) {
  try {
    const { email } = req.body;
    if (typeof email !== 'string') {
      throw new AppError('A valid email address is required.', 400);
    }
    const user = User.findByEmail(email);
    let response = {};
    if (user && !user.isEmailVerified) {
      const { token, tokenHash } = createOneTimeToken();
      User.setVerificationToken(
        user.id,
        tokenHash,
        new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      );
      await deliverOrReturnToken({
        userId: user.id,
        email: user.email,
        token,
        path: '/verify-email',
        subject: 'Verify your email address',
        purpose: 'email_verification',
      });
      response = localTokenResponse(token, '/verify-email');
    }
    return res.status(202).json({
      success: true,
      message: 'If the account exists and needs verification, a verification email will be sent.',
      ...response,
    });
  } catch (error) {
    return next(error);
  }
}

async function requestPasswordReset(req, res, next) {
  try {
    const { email } = req.body;
    if (typeof email !== 'string') {
      throw new AppError('A valid email address is required.', 400);
    }
    const user = User.findByEmail(email);
    let response = {};
    if (user) {
      const { token, tokenHash } = createOneTimeToken();
      User.setPasswordResetToken(
        user.id,
        tokenHash,
        new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      );
      await deliverOrReturnToken({
        userId: user.id,
        email: user.email,
        token,
        path: '/reset-password',
        subject: 'Reset your password',
        purpose: 'password_reset',
      });
      response = localTokenResponse(token, '/reset-password');
    }
    return res.status(202).json({
      success: true,
      message: 'If the account exists, a password reset email will be sent.',
      ...response,
    });
  } catch (error) {
    return next(error);
  }
}

async function resetPassword(req, res, next) {
  try {
    const { token, password } = req.body;
    if (typeof token !== 'string' || token.length !== 64 ||
      typeof password !== 'string' || password.length < 8) {
      throw new AppError('A valid reset token and password of at least 8 characters are required.', 400);
    }
    if (Buffer.byteLength(password, 'utf8') > 72) {
      throw new AppError('Password cannot exceed 72 UTF-8 bytes.', 400);
    }
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const user = User.findByPasswordResetToken(tokenHash);
    if (!user) {
      throw new AppError('Password reset link is invalid or expired.', 400);
    }
    User.resetPassword(user.id, password);
    logger.info('auth.password_reset', { userId: user.id });
    return res.status(200).json({
      success: true,
      message: 'Password has been reset. Please log in.',
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  registerUser,
  loginUser,
  verifyEmail,
  resendVerificationEmail,
  requestPasswordReset,
  resetPassword,
};
