require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { initializeDB, closeDB, isDBReady } = require('./config/db');
const authRoutes = require('./routes/authRoutes');
const cartRoutes = require('./routes/cartRoutes');
const productRoutes = require('./routes/productRoutes');
const orderRoutes = require('./routes/orderRoutes');
const { notFound, errorHandler } = require('./middleware/errorMiddleware');
const { handleStripeWebhook } = require('./controllers/paymentController');
const logger = require('./utils/logger');
const { RedisStore } = require('rate-limit-redis');
const { connectRedis, getRedisClient, closeRedis } = require('./utils/redisClient');
const AppError = require('./utils/AppError');

function validateEnvironment() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be set to a value at least 32 characters long.');
  }
  if (process.env.APP_URL) {
    try {
      const appUrl = new URL(process.env.APP_URL);
      if (!['http:', 'https:'].includes(appUrl.protocol)) {
        throw new Error();
      }
    } catch {
      throw new Error('APP_URL must be an absolute HTTP or HTTPS URL.');
    }
  }
  const smtpVariables = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'EMAIL_FROM'];
  const smtpConfigured = smtpVariables.every((name) => Boolean(process.env[name]));
  if (smtpVariables.some((name) => Boolean(process.env[name])) && !smtpConfigured) {
    throw new Error('Configure all SMTP variables or leave them blank for local development.');
  }
  if (smtpConfigured) {
    const smtpPort = Number(process.env.SMTP_PORT);
    if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
      throw new Error('SMTP_PORT must be a valid TCP port.');
    }
  }
  if (process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_WEBHOOK_SECRET) {
    throw new Error('STRIPE_WEBHOOK_SECRET is required when Stripe payments are enabled.');
  }
  if (process.env.STRIPE_WEBHOOK_SECRET && !process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is required when Stripe webhooks are enabled.');
  }
  if (process.env.STRIPE_CURRENCY && process.env.STRIPE_CURRENCY.toLowerCase() !== 'usd') {
    throw new Error('STRIPE_CURRENCY must be usd; other currencies require minor-unit configuration.');
  }
  if (process.env.API_RATE_LIMIT &&
    (!Number.isInteger(Number(process.env.API_RATE_LIMIT)) || Number(process.env.API_RATE_LIMIT) < 1)) {
    throw new Error('API_RATE_LIMIT must be a positive integer.');
  }
  const orderHoldMinutes = Number(process.env.ORDER_HOLD_MINUTES || 30);
  if (!Number.isInteger(orderHoldMinutes) || orderHoldMinutes < 1 || orderHoldMinutes > 1440) {
    throw new Error('ORDER_HOLD_MINUTES must be an integer between 1 and 1440.');
  }
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.CLIENT_ORIGIN) {
      throw new Error('CLIENT_ORIGIN must be explicitly configured in production.');
    }
    if (!smtpConfigured) {
      throw new Error('SMTP settings are required in production.');
    }
    if (process.env.DB_PATH === ':memory:') {
      throw new Error('A persistent DB_PATH is required in production.');
    }
  }

  const port = Number(process.env.PORT || 5000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be a valid TCP port between 1 and 65535.');
  }
  return port;
}

function createApp() {
  const app = express();
  const allowedOrigins = (process.env.CLIENT_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) {
    app.set('trust proxy', process.env.TRUST_PROXY);
  }
  app.use(helmet());
  app.use(cors({
    origin: allowedOrigins.length === 0
      ? false
      : (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
          return callback(null, true);
        }
        return callback(new AppError('Origin is not allowed by CORS.', 403));
      },
  }));
  app.use(morgan((tokens, req, res) => JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'info',
    message: 'http.request',
    method: tokens.method(req, res),
    path: req.originalUrl.split('?')[0],
    status: Number(tokens.status(req, res)),
    responseTimeMs: Number(tokens['response-time'](req, res)),
  })));
  app.get('/', (req, res) => {
    res.status(200).json({
      success: true,
      name: 'E-commerce REST API',
      message: 'The API is running. Use the documented API routes to access the service.',
      documentation: 'https://github.com/aligit56/e-commerce-backend#readme',
      health: {
        live: '/api/health/live',
        ready: '/api/health/ready',
      },
      routes: {
        authentication: '/api/auth',
        products: '/api/products',
        cart: '/api/cart',
        orders: '/api/orders',
      },
    });
  });
  app.get('/api/health/live', (req, res) => {
    res.status(200).json({
      success: true,
      status: 'ok',
    });
  });
  app.get('/api/health/ready', (req, res) => {
    const databaseReady = isDBReady();
    const redisReady = !process.env.REDIS_URL || Boolean(
      getRedisClient() && getRedisClient().isReady,
    );
    const ready = databaseReady && redisReady;
    res.status(ready ? 200 : 503).json({
      success: ready,
      status: ready ? 'ok' : 'unavailable',
      dependencies: {
        database: databaseReady ? 'connected' : 'disconnected',
        redis: process.env.REDIS_URL ? (redisReady ? 'connected' : 'disconnected') : 'not_configured',
      },
    });
  });
  app.get('/api/health', (req, res) => res.redirect(307, '/api/health/ready'));
  app.use('/api', rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: Number(process.env.API_RATE_LIMIT || 300),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    store: process.env.REDIS_URL
      ? new RedisStore({
        prefix: 'rl:api:',
        sendCommand: (...args) => {
          const client = getRedisClient();
          if (!client || !client.isReady) {
            throw new Error('Redis rate-limit storage is not connected.');
          }
          return client.sendCommand(args);
        },
      })
      : undefined,
    message: { success: false, message: 'Too many requests. Try again later.' },
  }));
  app.post(
    '/api/payments/stripe/webhook',
    express.raw({ type: 'application/json', limit: '1mb' }),
    handleStripeWebhook,
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use('/api/auth', authRoutes);
  app.use('/api/cart', cartRoutes);
  app.use('/api/products', productRoutes);
  app.use('/api/orders', orderRoutes);
  app.use(notFound);
  app.use(errorHandler);

  return app;
}

async function startServer() {
  const port = validateEnvironment();
  initializeDB();
  try {
    if (process.env.REDIS_URL) {
      await connectRedis();
    }
  } catch (error) {
    closeDB();
    throw error;
  }

  const app = createApp();
  const { expirePendingOrders } = require('./services/orderExpiryWorker');
  const runExpirySweep = () => {
    expirePendingOrders().catch((error) => {
      logger.error('orders.expiry_sweep_failed', { error: error.message });
    });
  };
  runExpirySweep();
  const expiryTimer = setInterval(runExpirySweep, 60 * 1000);
  expiryTimer.unref();
  const server = app.listen(port, () => {
    logger.info('server.listening', { port });
  });
  server.on('error', async (error) => {
    logger.error('server.listen_failed', { error: error.message });
    clearInterval(expiryTimer);
    process.exitCode = 1;
    try {
      closeDB();
      if (process.env.REDIS_URL) {
        await closeRedis();
      }
    } catch (closeError) {
      logger.error('server.startup_cleanup_failed', { error: closeError.message });
    }
  });

  const shutdown = (signal) => {
    logger.info('server.shutdown', { signal });
    clearInterval(expiryTimer);
    server.close(async (error) => {
      if (error) {
        logger.error('server.http_shutdown_failed', { error: error.message });
        process.exitCode = 1;
      }

      try {
        closeDB();
      } catch (closeError) {
        logger.error('server.database_shutdown_failed', { error: closeError.message });
        process.exitCode = 1;
      }
      try {
        if (process.env.REDIS_URL) {
          await closeRedis();
        }
      } catch (closeError) {
        logger.error('server.redis_shutdown_failed', { error: closeError.message });
        process.exitCode = 1;
      }
    });
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  startServer().catch((error) => {
    logger.error('server.start_failed', { error: error.message });
    process.exitCode = 1;
  });
}

module.exports = { createApp, startServer };
