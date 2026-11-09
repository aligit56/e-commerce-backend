require('dotenv').config();

const { initializeDB, closeDB } = require('../config/db');
const User = require('../models/User');
const logger = require('../utils/logger');

function main() {
  const email = process.argv[2];
  if (!email || process.argv.length !== 3 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Usage: npm run promote-admin -- verified-user@example.com');
  }

  initializeDB();
  const updated = User.promoteAdmin(email);
  if (updated !== 1) {
    throw new Error('No verified account with that email was found.');
  }
  logger.info('admin.promoted', { email: email.trim().toLowerCase() });
}

try {
  main();
} catch (error) {
  logger.error('admin.promotion_failed', { error: error.message });
  process.exitCode = 1;
} finally {
  closeDB();
}
