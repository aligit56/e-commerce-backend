const crypto = require('node:crypto');
const { getDb } = require('../config/db');

function fromRow(row, includeItems = true) {
  if (!row) {
    return null;
  }
  const order = {
    _id: row.id,
    id: row.id,
    user: row.user_id,
    totalPrice: row.total_cents / 100,
    status: row.status,
    paymentStatus: row.payment_status,
    expiresAt: row.expires_at,
    stripePaymentIntentId: row.stripe_payment_intent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (includeItems) {
    order.orderItems = getDb().prepare(`
      SELECT oi.product_id AS product, oi.quantity, oi.price_cents / 100.0 AS price,
        p.name AS productName
      FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ? ORDER BY oi.rowid
    `).all(row.id);
  }
  if (row.user_name !== undefined) {
    order.userInfo = { name: row.user_name, email: row.user_email };
  }
  return order;
}

function create({ userId, items, totalCents, expiresAt }, db = getDb()) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO orders (id, user_id, total_cents, status, payment_status, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', 'unpaid', ?, ?, ?)
  `).run(id, userId, totalCents, expiresAt, now, now);

  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, product_id, quantity, price_cents) VALUES (?, ?, ?, ?)
  `);
  for (const item of items) {
    insertItem.run(id, item.product, item.quantity, item.priceCents);
  }
  return findById(id, db);
}

function findById(id, db = getDb()) {
  return fromRow(db.prepare('SELECT * FROM orders WHERE id = ?').get(id));
}

function findByIdWithUser(id) {
  return fromRow(getDb().prepare(`
    SELECT o.*, u.name AS user_name, u.email AS user_email FROM orders o
    JOIN users u ON u.id = o.user_id WHERE o.id = ?
  `).get(id));
}

function listForUser(userId, { page, limit }) {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) AS count FROM orders WHERE user_id = ?').get(userId).count;
  const rows = db.prepare(`
    SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(userId, limit, (page - 1) * limit);
  return { orders: rows.map((row) => fromRow(row)), total };
}

function listAll({ page, limit }) {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) AS count FROM orders').get().count;
  const rows = db.prepare(`
    SELECT o.*, u.name AS user_name, u.email AS user_email FROM orders o
    JOIN users u ON u.id = o.user_id ORDER BY o.created_at DESC LIMIT ? OFFSET ?
  `).all(limit, (page - 1) * limit);
  return { orders: rows.map((row) => fromRow(row)), total };
}

function setStatus(id, status, db = getDb()) {
  return db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), id).changes === 1;
}

function setPayment(id, paymentStatus, stripeIntentId, db = getDb()) {
  return db.prepare(`
    UPDATE orders SET payment_status = ?, stripe_payment_intent_id = COALESCE(?, stripe_payment_intent_id),
      updated_at = ? WHERE id = ?
  `).run(paymentStatus, stripeIntentId, new Date().toISOString(), id).changes === 1;
}

function deleteById(id, db = getDb()) {
  return db.prepare('DELETE FROM orders WHERE id = ?').run(id).changes === 1;
}

module.exports = { fromRow, create, findById, findByIdWithUser, listForUser, listAll, setStatus, setPayment, deleteById };
