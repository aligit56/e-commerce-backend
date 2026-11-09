const AppError = require('../utils/AppError');
const logger = require('../utils/logger');
const { getDb } = require('../config/db');
const Order = require('../models/Order');
const restoreOrderStock = require('../utils/restoreOrderStock');
const { getStripeClient } = require('../utils/stripeClient');

async function createPaymentIntent(req, res, next) {
  try {
    const db = getDb();
    const order = Order.findByIdWithUser(req.params.id);
    if (!order) {
      throw new AppError('Order not found.', 404);
    }
    if (!req.user.isAdmin && order.user !== req.user.id) {
      throw new AppError('You are not allowed to pay for this order.', 403);
    }
    if (order.status !== 'pending' || order.paymentStatus !== 'unpaid') {
      throw new AppError('Only unpaid pending orders can be paid.', 409);
    }
    if (order.expiresAt && order.expiresAt <= new Date().toISOString()) {
      throw new AppError('This order reservation has expired.', 409);
    }

    if (order.stripePaymentIntentId) {
      const intent = await getStripeClient().paymentIntents.retrieve(order.stripePaymentIntentId);
      if (intent.status === 'canceled') {
        throw new AppError('This payment attempt was cancelled. Cancel the order and create a new one.', 409);
      }
      return res.status(200).json({
        success: true,
        data: {
          orderId: order.id,
          clientSecret: intent.client_secret,
          paymentIntentId: intent.id,
        },
      });
    }

    const stripe = getStripeClient();
    const currency = (process.env.STRIPE_CURRENCY || 'usd').toLowerCase();
    if (currency !== 'usd') {
      throw new AppError('Only USD is supported.', 500);
    }
    const claimTime = new Date().toISOString();
    const claimed = db.prepare(`
      UPDATE orders SET payment_intent_in_progress = 1, payment_intent_started_at = ?
      WHERE id = ? AND status = 'pending' AND payment_status = 'unpaid'
        AND stripe_payment_intent_id IS NULL AND expires_at > ?
        AND (payment_intent_in_progress = 0 OR payment_intent_started_at <= ?)
    `).run(
      claimTime,
      order.id,
      claimTime,
      new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    );
    if (claimed.changes !== 1) {
      throw new AppError('A payment is already being started or the reservation expired.', 409);
    }

    let intent;
    try {
      intent = await stripe.paymentIntents.create(
        {
          amount: Math.round(order.totalPrice * 100),
          currency,
          receipt_email: order.userInfo.email,
          metadata: {
            orderId: order.id,
            userId: req.user.id,
            application: 'ecommerce-api',
          },
          automatic_payment_methods: { enabled: true },
        },
        { idempotencyKey: `order-payment-${order.id}` },
      );

      const attached = db.prepare(`
        UPDATE orders SET stripe_payment_intent_id = ?, payment_intent_in_progress = 0,
          payment_intent_started_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'pending' AND payment_status = 'unpaid'
          AND payment_intent_in_progress = 1
      `).run(intent.id, new Date().toISOString(), order.id);
      if (attached.changes !== 1) {
        const latest = Order.findById(order.id);
        if (!latest || latest.stripePaymentIntentId !== intent.id) {
          await stripe.paymentIntents.cancel(intent.id);
          throw new AppError('Order changed while payment was starting. Please retry.', 409);
        }
      }
    } catch (error) {
      db.prepare(`
        UPDATE orders SET payment_intent_in_progress = 0, payment_intent_started_at = NULL
        WHERE id = ? AND payment_intent_started_at = ?
      `).run(order.id, claimTime);
      throw error;
    }

    return res.status(201).json({
      success: true,
      data: { orderId: order.id, clientSecret: intent.client_secret, paymentIntentId: intent.id },
    });
  } catch (error) {
    return next(error);
  }
}

function processStripeEvent(event) {
  const db = getDb();
  const process = db.transaction(() => {
    db.prepare('INSERT INTO payment_events (event_id, type, created_at) VALUES (?, ?, ?)')
      .run(event.id, event.type, new Date().toISOString());

    if (event.type === 'payment_intent.succeeded') {
      const intent = event.data.object;
      if (intent.metadata?.application !== 'ecommerce-api') {
        return;
      }
      const order = Order.findById(intent.metadata.orderId, db);
      if (!order) {
        throw new Error('Order for successful Stripe payment was not found; retry webhook.');
      }
      if (order.stripePaymentIntentId && order.stripePaymentIntentId !== intent.id) {
        throw new Error('Stripe payment intent does not match the order.');
      }
      if (intent.amount !== Math.round(order.totalPrice * 100) || intent.currency !== 'usd') {
        throw new Error('Stripe payment amount or currency does not match the order.');
      }
      if (order.paymentStatus === 'unpaid' && order.status === 'pending') {
        db.prepare(`
          UPDATE orders SET payment_status = 'paid', status = 'processing',
            stripe_payment_intent_id = ?, updated_at = ? WHERE id = ?
        `).run(intent.id, new Date().toISOString(), order.id);
      }
    } else if (event.type === 'payment_intent.canceled') {
      const intent = event.data.object;
      if (intent.metadata?.application !== 'ecommerce-api') {
        return;
      }
      const order = Order.findById(intent.metadata.orderId, db);
      if (!order) {
        return;
      }
      if (order.stripePaymentIntentId && order.stripePaymentIntentId !== intent.id) {
        return;
      }
      if (order.paymentStatus === 'unpaid' && order.status === 'pending') {
        restoreOrderStock(order, db);
        db.prepare(`
          UPDATE orders SET status = 'cancelled', stripe_payment_intent_id = ?,
            payment_intent_in_progress = 0, payment_intent_started_at = NULL, updated_at = ?
          WHERE id = ?
        `).run(intent.id, new Date().toISOString(), order.id);
      }
    } else if (event.type === 'charge.refunded') {
      const charge = event.data.object;
      if (charge.payment_intent) {
        const order = db.prepare(`
          SELECT * FROM orders WHERE stripe_payment_intent_id = ?
        `).get(charge.payment_intent);
        if (order) {
          const fullyRefunded = charge.amount_refunded >= charge.amount;
          db.prepare(`
            UPDATE orders SET payment_status = ?, status = CASE
              WHEN ? = 1 AND status IN ('pending', 'processing') THEN 'refunded'
              ELSE status END, updated_at = ? WHERE id = ?
          `).run(
            fullyRefunded ? 'refunded' : 'partially_refunded',
            fullyRefunded ? 1 : 0,
            new Date().toISOString(),
            order.id,
          );
        }
      }
    }
  });
  process();
}

async function handleStripeWebhook(req, res) {
  if (!process.env.STRIPE_WEBHOOK_SECRET || !process.env.STRIPE_SECRET_KEY) {
    return res.status(503).json({
      success: false,
      message: 'Stripe webhook signing is not configured.',
    });
  }

  let event;
  try {
    event = getStripeClient().webhooks.constructEvent(
      req.body,
      req.get('stripe-signature'),
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (error) {
    logger.warn('stripe.webhook_signature_rejected', { error: error.message });
    return res.status(400).json({ success: false, message: 'Invalid Stripe webhook signature.' });
  }

  try {
    processStripeEvent(event);
    return res.status(200).json({ received: true });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
      error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(200).json({ received: true, duplicate: true });
    }
    logger.error('stripe.webhook_processing_failed', {
      eventId: event.id,
      eventType: event.type,
      error: error.message,
    });
    return res.status(500).json({ success: false, message: 'Webhook processing failed.' });
  }
}

async function refundOrder(req, res, next) {
  try {
    const order = Order.findById(req.params.id);
    if (!order) {
      throw new AppError('Order not found.', 404);
    }
    if (order.paymentStatus !== 'paid' || !order.stripePaymentIntentId) {
      throw new AppError('Only paid Stripe orders can be refunded.', 409);
    }
    const refund = await getStripeClient().refunds.create(
      { payment_intent: order.stripePaymentIntentId },
      { idempotencyKey: `order-refund-${order.id}` },
    );
    return res.status(202).json({
      success: true,
      message: 'Refund requested. Payment status will update when Stripe confirms it.',
      data: { refundId: refund.id, status: refund.status },
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = { createPaymentIntent, handleStripeWebhook, processStripeEvent, refundOrder };
