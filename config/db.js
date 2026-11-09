const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const logger = require('../utils/logger');

let db;

function getDb() {
  if (!db) {
    throw new Error('Database has not been initialized.');
  }
  return db;
}

function initializeDB() {
  if (db) {
    return db;
  }

  const databasePath = path.resolve(process.env.DB_PATH || 'data/ecommerce.sqlite');
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK(length(name) BETWEEN 2 AND 100),
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0 CHECK(is_admin IN (0, 1)),
      is_email_verified INTEGER NOT NULL DEFAULT 0 CHECK(is_email_verified IN (0, 1)),
      email_verification_token_hash TEXT,
      email_verification_expires_at TEXT,
      password_reset_token_hash TEXT,
      password_reset_expires_at TEXT,
      token_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK(length(name) BETWEEN 2 AND 160),
      description TEXT NOT NULL CHECK(length(description) <= 5000),
      price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
      category TEXT NOT NULL CHECK(length(category) BETWEEN 1 AND 100),
      stock INTEGER NOT NULL CHECK(stock >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS products_category_idx ON products(category);
    CREATE INDEX IF NOT EXISTS products_created_at_idx ON products(created_at);

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      total_cents INTEGER NOT NULL CHECK(total_cents >= 0),
      status TEXT NOT NULL CHECK(status IN (
        'pending', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'
      )),
      payment_status TEXT NOT NULL CHECK(payment_status IN (
        'unpaid', 'paid', 'partially_refunded', 'refunded'
      )),
      expires_at TEXT,
      stripe_payment_intent_id TEXT UNIQUE,
      payment_intent_in_progress INTEGER NOT NULL DEFAULT 0,
      payment_intent_started_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS orders_user_created_idx ON orders(user_id, created_at);
    CREATE INDEX IF NOT EXISTS orders_expiry_idx ON orders(status, payment_status, expires_at);

    CREATE TABLE IF NOT EXISTS order_items (
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
      PRIMARY KEY(order_id, product_id)
    );

    CREATE TABLE IF NOT EXISTS cart_items (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id, product_id)
    );

    CREATE INDEX IF NOT EXISTS cart_items_product_idx ON cart_items(product_id);

    CREATE TABLE IF NOT EXISTS payment_events (
      event_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  logger.info('sqlite.connected', { path: databasePath });
  return db;
}

function closeDB() {
  if (db) {
    db.close();
    db = undefined;
  }
}

function isDBReady() {
  return Boolean(db && db.open);
}

module.exports = { getDb, initializeDB, closeDB, isDBReady };
