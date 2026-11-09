const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const { getDb } = require('../config/db');

function publicUser(row) {
  if (!row) {
    return null;
  }
  return {
    _id: row.id,
    id: row.id,
    name: row.name,
    email: row.email,
    isAdmin: Boolean(row.is_admin),
    isEmailVerified: Boolean(row.is_email_verified),
    tokenVersion: row.token_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function create({ name, email, password, isAdmin = false, isEmailVerified = false,
  emailVerificationTokenHash = null, emailVerificationExpiresAt = null }) {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const normalizedEmail = email.trim().toLowerCase();
  const result = db.prepare(`
    INSERT INTO users (
      id, name, email, password_hash, is_admin, is_email_verified,
      email_verification_token_hash, email_verification_expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    name.trim(),
    normalizedEmail,
    bcrypt.hashSync(password, 12),
    isAdmin ? 1 : 0,
    isEmailVerified ? 1 : 0,
    emailVerificationTokenHash,
    emailVerificationExpiresAt,
    now,
    now,
  );

  if (result.changes !== 1) {
    throw new Error('Failed to create user.');
  }
  return findById(id);
}

function findById(id) {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
  return publicUser(row);
}

function findByEmail(email) {
  return publicUser(getDb().prepare('SELECT * FROM users WHERE email = ?')
    .get(email.trim().toLowerCase()));
}

function findForLogin(email) {
  const row = getDb().prepare('SELECT * FROM users WHERE email = ?')
    .get(email.trim().toLowerCase());
  if (!row) {
    return null;
  }
  return { ...publicUser(row), passwordHash: row.password_hash };
}

function findByVerificationToken(tokenHash) {
  const row = getDb().prepare(`
    SELECT * FROM users
    WHERE email_verification_token_hash = ? AND email_verification_expires_at > ?
  `).get(tokenHash, new Date().toISOString());
  return publicUser(row);
}

function verifyEmail(id) {
  getDb().prepare(`
    UPDATE users SET is_email_verified = 1, email_verification_token_hash = NULL,
      email_verification_expires_at = NULL, updated_at = ? WHERE id = ?
  `).run(new Date().toISOString(), id);
}

function setVerificationToken(id, tokenHash, expiresAt) {
  getDb().prepare(`
    UPDATE users SET email_verification_token_hash = ?, email_verification_expires_at = ?,
      updated_at = ? WHERE id = ?
  `).run(tokenHash, expiresAt, new Date().toISOString(), id);
}

function findByPasswordResetToken(tokenHash) {
  const row = getDb().prepare(`
    SELECT * FROM users WHERE password_reset_token_hash = ? AND password_reset_expires_at > ?
  `).get(tokenHash, new Date().toISOString());
  return publicUser(row);
}

function setPasswordResetToken(id, tokenHash, expiresAt) {
  getDb().prepare(`
    UPDATE users SET password_reset_token_hash = ?, password_reset_expires_at = ?,
      updated_at = ? WHERE id = ?
  `).run(tokenHash, expiresAt, new Date().toISOString(), id);
}

function resetPassword(id, password) {
  getDb().prepare(`
    UPDATE users SET password_hash = ?, password_reset_token_hash = NULL,
      password_reset_expires_at = NULL, token_version = token_version + 1,
      updated_at = ? WHERE id = ?
  `).run(bcrypt.hashSync(password, 12), new Date().toISOString(), id);
}

function comparePassword(password, passwordHash) {
  return bcrypt.compareSync(password, passwordHash);
}

function promoteAdmin(email) {
  return getDb().prepare(`
    UPDATE users SET is_admin = 1, updated_at = ?
    WHERE email = ? AND is_email_verified = 1
  `).run(new Date().toISOString(), email.trim().toLowerCase()).changes;
}

module.exports = {
  create,
  findById,
  findByEmail,
  findForLogin,
  findByVerificationToken,
  verifyEmail,
  setVerificationToken,
  findByPasswordResetToken,
  setPasswordResetToken,
  resetPassword,
  comparePassword,
  promoteAdmin,
};
