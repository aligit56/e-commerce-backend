const jwt = require('jsonwebtoken');
const User = require('../models/User');
const AppError = require('../utils/AppError');

async function protect(req, res, next) {
  const authorization = req.headers.authorization;
  const [scheme, token] = authorization ? authorization.split(' ') : [];
  if (scheme !== 'Bearer' || !token) {
    return next(new AppError('Authentication token required.', 401));
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (!payload.sub) {
      return next(new AppError('Invalid authentication token.', 401));
    }

    const user = User.findById(payload.sub);
    if (!user || payload.ver !== user.tokenVersion) {
      return next(new AppError('Invalid or revoked authentication token.', 401));
    }
    if (!user.isEmailVerified) {
      return next(new AppError('Verify your email address before using this account.', 403));
    }

    req.user = user;
    return next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError || error instanceof jwt.JsonWebTokenError) {
      return next(new AppError('Invalid or expired authentication token.', 401));
    }
    return next(error);
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return next(new AppError('Administrator access required.', 403));
  }
  return next();
}

module.exports = { protect, requireAdmin };
