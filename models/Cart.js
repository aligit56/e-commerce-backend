const { getDb } = require('../config/db');
const AppError = require('../utils/AppError');

function getByUser(userId, db = getDb()) {
  const rows = db.prepare(`
    SELECT ci.product_id, ci.quantity, p.name, p.description, p.price_cents, p.category, p.stock
    FROM cart_items ci
    JOIN products p ON p.id = ci.product_id
    WHERE ci.user_id = ?
    ORDER BY ci.created_at ASC
  `).all(userId);
  const items = rows.map((row) => ({
    product: row.product_id,
    name: row.name,
    description: row.description,
    price: row.price_cents / 100,
    category: row.category,
    stock: row.stock,
    quantity: row.quantity,
    lineTotal: (row.price_cents * row.quantity) / 100,
  }));
  const totalCents = rows.reduce((total, row) => total + row.price_cents * row.quantity, 0);

  return {
    items,
    totalPrice: totalCents / 100,
  };
}

function getQuantities(userId, db = getDb()) {
  return db.prepare(`
    SELECT product_id AS product, quantity FROM cart_items
    WHERE user_id = ? ORDER BY created_at ASC
  `).all(userId);
}

function addItem(userId, productId, quantity) {
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new AppError('Quantity must be a positive whole number.', 400);
  }

  const db = getDb();
  const add = db.transaction(() => {
    const product = db.prepare('SELECT stock FROM products WHERE id = ?').get(productId);
    if (!product) {
      throw new AppError('Product not found.', 404);
    }

    const existing = db.prepare(`
      SELECT quantity FROM cart_items WHERE user_id = ? AND product_id = ?
    `).get(userId, productId);
    const nextQuantity = (existing ? existing.quantity : 0) + quantity;
    if (!Number.isSafeInteger(nextQuantity) || nextQuantity > product.stock) {
      throw new AppError('Requested quantity exceeds available stock.', 409);
    }

    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO cart_items (user_id, product_id, quantity, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, product_id) DO UPDATE SET
        quantity = excluded.quantity, updated_at = excluded.updated_at
    `).run(userId, productId, nextQuantity, now, now);
    return getByUser(userId, db);
  });

  return add.immediate();
}

function setItemQuantity(userId, productId, quantity) {
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new AppError('Quantity must be a positive whole number.', 400);
  }

  const db = getDb();
  const update = db.transaction(() => {
    const product = db.prepare('SELECT stock FROM products WHERE id = ?').get(productId);
    if (!product) {
      throw new AppError('Product not found.', 404);
    }
    if (quantity > product.stock) {
      throw new AppError('Requested quantity exceeds available stock.', 409);
    }

    const result = db.prepare(`
      UPDATE cart_items SET quantity = ?, updated_at = ?
      WHERE user_id = ? AND product_id = ?
    `).run(quantity, new Date().toISOString(), userId, productId);
    if (result.changes === 0) {
      throw new AppError('Product is not in this cart.', 404);
    }
    return getByUser(userId, db);
  });

  return update.immediate();
}

function removeItem(userId, productId) {
  return getDb().prepare(`
    DELETE FROM cart_items WHERE user_id = ? AND product_id = ?
  `).run(userId, productId).changes === 1;
}

function clear(userId, db = getDb()) {
  return db.prepare('DELETE FROM cart_items WHERE user_id = ?').run(userId).changes;
}

module.exports = { getByUser, getQuantities, addItem, setItemQuantity, removeItem, clear };
