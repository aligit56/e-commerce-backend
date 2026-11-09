const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { once } = require('node:events');
const { createApp } = require('../server');
const { initializeDB, getDb, closeDB } = require('../config/db');
const User = require('../models/User');
const Order = require('../models/Order');
const { processStripeEvent } = require('../controllers/paymentController');
const { expirePendingOrders } = require('../services/orderExpiryWorker');

test('SQLite API supports verified auth, product CRUD, transactional orders and expiry', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ecommerce-integration-'));
  process.env.DB_PATH = path.join(directory, 'test.sqlite');
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  process.env.NODE_ENV = 'test';
  initializeDB();

  const email = `integration-${crypto.randomUUID()}@example.test`;
  const adminEmail = `admin-${crypto.randomUUID()}@example.test`;
  let server;

  try {
    server = createApp().listen(0);
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const registration = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Integration Customer',
        email,
        password: 'a-secure-test-password',
      }),
    });
    const registrationBody = await registration.json();
    assert.equal(registration.status, 201);
    assert.ok(registrationBody.development.token);

    const verification = await fetch(`${baseUrl}/api/auth/verify-email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: registrationBody.development.token }),
    });
    assert.equal(verification.status, 200);

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'a-secure-test-password' }),
    });
    const loginBody = await login.json();
    assert.equal(login.status, 200);

    const admin = User.create({
      name: 'Integration Admin',
      email: adminEmail,
      password: 'a-secure-test-password',
      isAdmin: true,
      isEmailVerified: true,
    });
    const adminToken = jwt.sign(
      { ver: admin.tokenVersion },
      process.env.JWT_SECRET,
      { subject: admin.id, algorithm: 'HS256' },
    );

    const createProduct = await fetch(`${baseUrl}/api/products`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Integration Widget',
        description: 'A product for integration testing.',
        price: 12.34,
        category: 'Testing',
        stock: 5,
      }),
    });
    const productBody = await createProduct.json();
    assert.equal(createProduct.status, 201);

    const updatedProduct = await fetch(`${baseUrl}/api/products/${productBody.data.id}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Updated Integration Widget' }),
    });
    assert.equal(updatedProduct.status, 200);
    assert.equal((await updatedProduct.json()).data.name, 'Updated Integration Widget');

    const cartHeaders = {
      authorization: `Bearer ${loginBody.token}`,
      'content-type': 'application/json',
    };
    const emptyCart = await fetch(`${baseUrl}/api/cart`, { headers: cartHeaders });
    assert.equal(emptyCart.status, 200);
    assert.deepEqual((await emptyCart.json()).data.items, []);

    const addCartItem = await fetch(`${baseUrl}/api/cart/items`, {
      method: 'POST',
      headers: cartHeaders,
      body: JSON.stringify({ productId: productBody.data.id, quantity: 1 }),
    });
    assert.equal(addCartItem.status, 200);
    assert.equal((await addCartItem.json()).data.totalPrice, 12.34);

    const updateCartItem = await fetch(
      `${baseUrl}/api/cart/items/${productBody.data.id}`,
      {
        method: 'PATCH',
        headers: cartHeaders,
        body: JSON.stringify({ quantity: 2 }),
      },
    );
    assert.equal(updateCartItem.status, 200);
    assert.equal((await updateCartItem.json()).data.items[0].quantity, 2);

    const unavailableCartQuantity = await fetch(
      `${baseUrl}/api/cart/items/${productBody.data.id}`,
      {
        method: 'PATCH',
        headers: cartHeaders,
        body: JSON.stringify({ quantity: 6 }),
      },
    );
    assert.equal(unavailableCartQuantity.status, 409);

    const removeCartItem = await fetch(
      `${baseUrl}/api/cart/items/${productBody.data.id}`,
      { method: 'DELETE', headers: cartHeaders },
    );
    assert.equal(removeCartItem.status, 200);
    assert.deepEqual((await removeCartItem.json()).data.items, []);

    const addCartForClear = await fetch(`${baseUrl}/api/cart/items`, {
      method: 'POST',
      headers: cartHeaders,
      body: JSON.stringify({ productId: productBody.data.id, quantity: 1 }),
    });
    assert.equal(addCartForClear.status, 200);
    const clearCart = await fetch(`${baseUrl}/api/cart`, {
      method: 'DELETE',
      headers: cartHeaders,
    });
    assert.equal(clearCart.status, 200);
    assert.deepEqual((await clearCart.json()).data.items, []);

    const addCheckoutItem = await fetch(`${baseUrl}/api/cart/items`, {
      method: 'POST',
      headers: cartHeaders,
      body: JSON.stringify({ productId: productBody.data.id, quantity: 1 }),
    });
    assert.equal(addCheckoutItem.status, 200);

    const checkout = await fetch(`${baseUrl}/api/orders/from-cart`, {
      method: 'POST',
      headers: cartHeaders,
    });
    const checkoutBody = await checkout.json();
    assert.equal(checkout.status, 201);
    assert.equal(checkoutBody.data.totalPrice, 12.34);
    const clearedCart = await fetch(`${baseUrl}/api/cart`, { headers: cartHeaders });
    assert.deepEqual((await clearedCart.json()).data.items, []);

    const orderResponse = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${loginBody.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        orderItems: [{ product: productBody.data.id, quantity: 2 }],
      }),
    });
    const orderBody = await orderResponse.json();
    assert.equal(orderResponse.status, 201);
    assert.equal(orderBody.data.totalPrice, 24.68);
    assert.equal(orderBody.data.orderItems[0].price, 12.34);
    assert.ok(orderBody.data.expiresAt);

    const event = {
      id: `evt_${crypto.randomUUID().replaceAll('-', '')}`,
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_integration_test',
          amount: 2468,
          currency: 'usd',
          metadata: {
            orderId: orderBody.data.id,
            application: 'ecommerce-api',
          },
        },
      },
    };
    getDb().prepare('UPDATE orders SET stripe_payment_intent_id = ? WHERE id = ?')
      .run(event.data.object.id, orderBody.data.id);
    processStripeEvent(event);
    assert.equal(Order.findById(orderBody.data.id).paymentStatus, 'paid');
    assert.equal(Order.findById(orderBody.data.id).status, 'processing');
    assert.throws(() => processStripeEvent(event), { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' });

    const deletionOrder = Order.create({
      userId: loginBody.user.id,
      items: [{ product: productBody.data.id, quantity: 1, priceCents: 1234 }],
      totalCents: 1234,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    getDb().prepare('UPDATE products SET stock = stock - 1 WHERE id = ?')
      .run(productBody.data.id);
    const deleteResponse = await fetch(`${baseUrl}/api/orders/${deletionOrder.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${loginBody.token}` },
    });
    assert.equal(deleteResponse.status, 200);

    const cancellationOrder = Order.create({
      userId: loginBody.user.id,
      items: [{ product: productBody.data.id, quantity: 1, priceCents: 1234 }],
      totalCents: 1234,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    getDb().prepare('UPDATE products SET stock = stock - 1 WHERE id = ?')
      .run(productBody.data.id);
    const cancelResponse = await fetch(
      `${baseUrl}/api/orders/${cancellationOrder.id}/cancel`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${loginBody.token}` },
      },
    );
    assert.equal(cancelResponse.status, 200);
    assert.equal(Order.findById(cancellationOrder.id).status, 'cancelled');

    const expiring = Order.create({
      userId: loginBody.user.id,
      items: [{ product: productBody.data.id, quantity: 1, priceCents: 1234 }],
      totalCents: 1234,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    getDb().prepare(`
      UPDATE products SET stock = stock - 1 WHERE id = ?
    `).run(productBody.data.id);
    await expirePendingOrders(new Date());
    assert.equal(Order.findById(expiring.id).status, 'cancelled');

    const stock = getDb().prepare('SELECT stock FROM products WHERE id = ?')
      .get(productBody.data.id).stock;
    assert.equal(stock, 2);
    const rejectedProductDelete = await fetch(`${baseUrl}/api/products/${productBody.data.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(rejectedProductDelete.status, 409);

    const searchResponse = await fetch(`${baseUrl}/api/products?page=1&limit=5&search=Integration`);
    assert.equal(searchResponse.status, 200);
    assert.equal((await searchResponse.json()).data.length, 1);

    const resetRequest = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const resetRequestBody = await resetRequest.json();
    assert.equal(resetRequest.status, 202);
    assert.ok(resetRequestBody.development.token);
    const reset = await fetch(`${baseUrl}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: resetRequestBody.development.token,
        password: 'a-new-secure-test-password',
      }),
    });
    assert.equal(reset.status, 200);

    const revokedResponse = await fetch(`${baseUrl}/api/orders/mine`, {
      headers: { authorization: `Bearer ${loginBody.token}` },
    });
    assert.equal(revokedResponse.status, 401);
  } finally {
    if (server) {
      server.close();
      await once(server, 'close');
    }
    closeDB();
    delete process.env.DB_PATH;
    delete process.env.JWT_SECRET;
    delete process.env.NODE_ENV;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
