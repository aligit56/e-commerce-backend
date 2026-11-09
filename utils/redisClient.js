const { createClient } = require('redis');
const logger = require('./logger');

let client;

async function connectRedis() {
  if (!process.env.REDIS_URL) {
    return null;
  }

  client = createClient({ url: process.env.REDIS_URL });
  client.on('error', (error) => {
    logger.error('redis.connection_error', { error: error.message });
  });
  await client.connect();
  logger.info('redis.connected');
  return client;
}

function getRedisClient() {
  return client;
}

async function closeRedis() {
  if (client && client.isOpen) {
    await client.quit();
    client = undefined;
  }
}

module.exports = { connectRedis, getRedisClient, closeRedis };
