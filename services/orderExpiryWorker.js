const { getDb } = require('../config/db');
const Order = require('../models/Order');
const logger = require('../utils/logger');
const { getStripeClient } = require('../utils/stripeClient');
const restoreOrderStock = require('../utils/restoreOrderStock');

let sweepInProgress = false;

async function cancelStripeIntent(order) {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    logger.warn('orders.expiry_waiting_for_stripe', { orderId: order.id });
    return false;
  }

  const stripe = getStripeClient();
  try {
    const intent = await stripe.paymentIntents.cancel(order.stripe_payment_intent_id);
    return intent.status === 'canceled';
  } catch (cancelError) {
    try {
      const intent = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id);
      if (intent.status === 'canceled') {
        return true;
      }
      logger.warn('orders.expiry_stripe_cancel_pending', {
        orderId: order.id,
        stripeStatus: intent.status,
      });
      return false;
    } catch (retrieveError) {
      logger.error('orders.expiry_stripe_cancel_failed', {
        orderId: order.id,
        error: retrieveError.message || cancelError.message,
      });
      return false;
    }
  }
}

async function expirePendingOrders(now = new Date()) {
  if (sweepInProgress) {
    return;
  }
  sweepInProgress = true;

  try {
    const db = getDb();
    const candidates = db.prepare(`
      SELECT * FROM orders WHERE status = 'pending' AND payment_status = 'unpaid'
        AND expires_at <= ?
        AND (payment_intent_in_progress = 0 OR payment_intent_started_at <= ?)
      ORDER BY expires_at LIMIT 50
    `).all(
      now.toISOString(),
      new Date(now.getTime() - 2 * 60 * 1000).toISOString(),
    );

    for (const candidate of candidates) {
      try {
        if (candidate.stripe_payment_intent_id &&
          !(await cancelStripeIntent(candidate))) {
          continue;
        }

        const expire = db.transaction(() => {
          const current = db.prepare('SELECT * FROM orders WHERE id = ?').get(candidate.id);
          if (!current || current.status !== 'pending' ||
            current.payment_status !== 'unpaid' || current.expires_at > now.toISOString() ||
            current.stripe_payment_intent_id !== candidate.stripe_payment_intent_id) {
            return;
          }
          const stalePaymentClaim = current.payment_intent_in_progress &&
            current.payment_intent_started_at <= new Date(now.getTime() - 2 * 60 * 1000).toISOString();
          if (current.payment_intent_in_progress && !stalePaymentClaim) {
            return;
          }

          const order = Order.findById(current.id, db);
          restoreOrderStock(order, db);
          db.prepare(`
            UPDATE orders SET status = 'cancelled', payment_intent_in_progress = 0,
              payment_intent_started_at = NULL, updated_at = ? WHERE id = ?
          `).run(now.toISOString(), current.id);
        });
        expire.immediate();
      } catch (error) {
        logger.error('orders.expiry_failed', {
          orderId: candidate.id,
          error: error.message,
        });
      }
    }
  } finally {
    sweepInProgress = false;
  }
}

module.exports = { expirePendingOrders };
