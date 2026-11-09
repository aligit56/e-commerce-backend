const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Product = require('../models/Product');
const { initializeDB, closeDB } = require('../config/db');

test('SQLite enforces product validation and stores monetary values in cents', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ecommerce-product-test-'));
  process.env.DB_PATH = path.join(directory, 'test.sqlite');
  initializeDB();

  try {
    assert.throws(() => Product.create({
      name: 'Invalid price',
      description: 'Price has more than two decimals.',
      price: 1.234,
      category: 'Test',
      stock: 5,
    }), /Price must be/);

    const product = Product.create({
      name: 'Cent-priced product',
      description: 'A valid decimal price.',
      price: 1.15,
      category: 'Test',
      stock: 5,
    });

    assert.equal(product.price, 1.15);
    assert.equal(product.stock, 5);
    assert.throws(() => Product.update(product.id, { stock: -1 }), /Stock must be/);
  } finally {
    closeDB();
    delete process.env.DB_PATH;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
