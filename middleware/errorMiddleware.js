const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

function notFound(req, res, next) {
  next(new AppError(`Route not found: ${req.method} ${req.path}`, 404));
}

function errorHandler(error, req, res, next) {
  let statusCode = error.statusCode || error.status || 500;
  let message = error.message || 'Internal server error.';

  if (!error.statusCode && error.status >= 400 && error.status < 500) {
    statusCode = error.status;
    message = statusCode === 413 ? 'Request body is too large.' : 'Invalid request.';
  }

  if (error.name === 'ValidationError') {
    statusCode = 400;
    message = Object.values(error.errors).map((item) => item.message).join(', ');
  } else if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error.code === 11000) {
    statusCode = 409;
    message = 'A record with that value already exists.';
  } else if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' ||
    (error.code === 'SQLITE_CONSTRAINT_TRIGGER' && error.message === 'FOREIGN KEY constraint failed')) {
    statusCode = 409;
    message = 'This record is referenced by another record and cannot be changed.';
  } else if (error.code === 'SQLITE_CONSTRAINT_CHECK') {
    statusCode = 400;
    message = 'One or more values are outside the allowed range.';
  } else if (error.name === 'CastError') {
    statusCode = 400;
    message = `Invalid value for ${error.path}.`;
  } else if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    statusCode = 400;
    message = 'Request body contains invalid JSON.';
  }

  if (statusCode >= 500) {
    logger.error('http.request_failed', {
      method: req.method,
      path: req.path,
      error: error.message,
      ...(process.env.NODE_ENV === 'production' ? {} : { stack: error.stack }),
    });
    if (process.env.NODE_ENV === 'production') {
      message = 'Internal server error.';
    }
  }

  res.status(statusCode).json({
    success: false,
    message,
  });
}

module.exports = { notFound, errorHandler };
