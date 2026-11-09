const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp } = require('../server');

test('liveness endpoint reports the process is running without a database connection', async () => {
  const server = createApp().listen(0);
  await once(server, 'listening');

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/health/live`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.status, 'ok');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('readiness endpoint reports a missing database dependency', async () => {
  const server = createApp().listen(0);
  await once(server, 'listening');

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/health/ready`);
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.success, false);
    assert.equal(body.dependencies.database, 'disconnected');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('private routes reject requests without a bearer token', async () => {
  const server = createApp().listen(0);
  await once(server, 'listening');

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/orders/mine`);
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.equal(body.success, false);
    assert.match(body.message, /token required/i);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('registration rejects passwords exceeding bcrypt byte limits', async () => {
  const server = createApp().listen(0);
  await once(server, 'listening');

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Test User',
        email: 'long-password@example.test',
        password: '€'.repeat(25),
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.match(body.message, /72 UTF-8 bytes/);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('security headers are present on API responses', async () => {
  const server = createApp().listen(0);
  await once(server, 'listening');

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/health/live`);

    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(response.headers.has('x-powered-by'), false);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('requests from origins outside the configured allowlist are rejected', async () => {
  const previousOrigin = process.env.CLIENT_ORIGIN;
  process.env.CLIENT_ORIGIN = 'https://store.example.test';
  const server = createApp().listen(0);
  await once(server, 'listening');

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/health/live`, {
      headers: { origin: 'https://attacker.example.test' },
    });

    assert.equal(response.status, 403);
    assert.equal((await response.json()).success, false);
  } finally {
    server.close();
    await once(server, 'close');
    if (previousOrigin === undefined) {
      delete process.env.CLIENT_ORIGIN;
    } else {
      process.env.CLIENT_ORIGIN = previousOrigin;
    }
  }
});

test('authentication endpoints apply the configured request throttle', async () => {
  const server = createApp().listen(0);
  await once(server, 'listening');

  try {
    let response;
    for (let attempt = 0; attempt < 11; attempt += 1) {
      response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
    }

    assert.equal(response.status, 429);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('Stripe webhook rejects requests with an invalid signature', async () => {
  const previousSecretKey = process.env.STRIPE_SECRET_KEY;
  const previousWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_SECRET_KEY = 'sk_test_local_invalid_signature_test';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_local_invalid_signature_test';
  const server = createApp().listen(0);
  await once(server, 'listening');

  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/payments/stripe/webhook`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': 'invalid',
        },
        body: JSON.stringify({ type: 'payment_intent.succeeded' }),
      },
    );

    assert.equal(response.status, 400);
    assert.equal((await response.json()).success, false);
  } finally {
    server.close();
    await once(server, 'close');
    if (previousSecretKey === undefined) {
      delete process.env.STRIPE_SECRET_KEY;
    } else {
      process.env.STRIPE_SECRET_KEY = previousSecretKey;
    }
    if (previousWebhookSecret === undefined) {
      delete process.env.STRIPE_WEBHOOK_SECRET;
    } else {
      process.env.STRIPE_WEBHOOK_SECRET = previousWebhookSecret;
    }
  }
});

test('unknown routes use the standard JSON error response', async () => {
  const server = createApp().listen(0);
  await once(server, 'listening');

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/unknown`);
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(body.success, false);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
