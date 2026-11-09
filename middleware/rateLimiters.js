const { rateLimit } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { getRedisClient } = require('../utils/redisClient');

function createStore(prefix) {
  if (!process.env.REDIS_URL) {
    return undefined;
  }

  return new RedisStore({
    prefix,
    sendCommand: (...args) => {
      const client = getRedisClient();
      if (!client || !client.isReady) {
        throw new Error('Redis rate-limit storage is not connected.');
      }
      return client.sendCommand(args);
    },
  });
}

const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  store: createStore('rl:auth:'),
  message: { success: false, message: 'Too many authentication requests. Try again later.' },
});

const recoveryRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  store: createStore('rl:recovery:'),
  message: { success: false, message: 'Too many account recovery requests. Try again later.' },
});

module.exports = { authRateLimiter, recoveryRateLimiter };
