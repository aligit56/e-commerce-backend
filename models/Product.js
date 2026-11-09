const crypto = require('node:crypto');
const { getDb } = require('../config/db');
const AppError = require('../utils/AppError');

const editableFields = ['name', 'description', 'price', 'category', 'stock'];

function fromRow(row) {
  if (!row) {
    return null;
  }
  return {
    _id: row.id,
    id: row.id,
    name: row.name,
    description: row.description,
    price: row.price_cents / 100,
    category: row.category,
    stock: row.stock,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validate(data, partial = false) {
  const issues = [];
  if (!partial || data.name !== undefined) {
    if (typeof data.name !== 'string' || data.name.trim().length < 2 || data.name.trim().length > 160) {
      issues.push('Name must be between 2 and 160 characters.');
    }
  }
  if (!partial || data.description !== undefined) {
    if (typeof data.description !== 'string' || data.description.trim().length > 5000) {
      issues.push('Description is required and cannot exceed 5000 characters.');
    }
  }
  if (!partial || data.price !== undefined) {
    if (!Number.isFinite(data.price) || !Number.isSafeInteger(Math.round(data.price * 100)) ||
      data.price < 0 || Math.round(data.price * 100) / 100 !== data.price) {
      issues.push('Price must be a non-negative USD amount with up to two decimals.');
    }
  }
  if (!partial || data.category !== undefined) {
    if (typeof data.category !== 'string' || !data.category.trim() || data.category.trim().length > 100) {
      issues.push('Category is required and cannot exceed 100 characters.');
    }
  }
  if (!partial || data.stock !== undefined) {
    if (!Number.isSafeInteger(data.stock) || data.stock < 0) {
      issues.push('Stock must be a non-negative whole number.');
    }
  }
  if (issues.length) {
    throw new AppError(issues.join(' '), 400);
  }
}

function create(data) {
  validate(data);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  getDb().prepare(`
    INSERT INTO products (id, name, description, price_cents, category, stock, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.name.trim(),
    data.description.trim(),
    Math.round(data.price * 100),
    data.category.trim(),
    data.stock,
    now,
    now,
  );
  return findById(id);
}

function update(id, updates) {
  validate(updates, true);
  const product = findById(id);
  if (!product) {
    return null;
  }
  const next = { ...product, ...updates };
  getDb().prepare(`
    UPDATE products SET name = ?, description = ?, price_cents = ?, category = ?, stock = ?,
      updated_at = ? WHERE id = ?
  `).run(
    next.name.trim(),
    next.description.trim(),
    Math.round(next.price * 100),
    next.category.trim(),
    next.stock,
    new Date().toISOString(),
    id,
  );
  return findById(id);
}

function findById(id) {
  return fromRow(getDb().prepare('SELECT * FROM products WHERE id = ?').get(id));
}

function deleteById(id) {
  return getDb().prepare('DELETE FROM products WHERE id = ?').run(id).changes > 0;
}

function list({ page, limit, category, search }) {
  const db = getDb();
  const clauses = [];
  const params = [];

  if (category) {
    clauses.push('category = ?');
    params.push(category);
  }
  if (search) {
    clauses.push('(name LIKE ? ESCAPE \'\\\' OR description LIKE ? ESCAPE \'\\\')');
    const escaped = search.replace(/[\\%_]/g, '\\$&');
    params.push(`%${escaped}%`, `%${escaped}%`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS count FROM products ${where}`).get(...params).count;
  const rows = db.prepare(`
    SELECT * FROM products ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, (page - 1) * limit);

  return { products: rows.map(fromRow), total };
}

function decrementStock(id, quantity) {
  return getDb().prepare(`
    UPDATE products SET stock = stock - ?, updated_at = ?
    WHERE id = ? AND stock >= ?
  `).run(quantity, new Date().toISOString(), id, quantity).changes === 1;
}

function incrementStock(id, quantity) {
  getDb().prepare(`
    UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ?
  `).run(quantity, new Date().toISOString(), id);
}

module.exports = { editableFields, validate, create, update, findById, deleteById, list, decrementStock, incrementStock };
