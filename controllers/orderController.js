const { getDb } = require('../config/db');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Cart = require('../models/Cart');
const AppError = require('../utils/AppError');
const { getStripeClient } = require('../utils/stripeClient');
const restoreOrderStock = require('../utils/restoreOrderStock');

function parsePage(value, fallback, maximum) {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || (maximum && parsed > maximum)) {
    throw new AppError('Invalid pagination value.', 400);
  }
  return parsed;
}

function normalizeItems(orderItems) {
  if (!Array.isArray(orderItems) || orderItems.length === 0) {
    throw new AppError('orderItems must be a non-empty array.', 400);
  }
  const quantities = new Map();
  for (const item of orderItems) {
    if (!item || typeof item.product !== 'string' ||
      !Number.isSafeInteger(item.quantity) || item.quantity < 1) {
      throw new AppError('Each item needs a product ID and positive whole-number quantity.', 400);
    }
    const quantity = (quantities.get(item.product) || 0) + item.quantity;
    if (!Number.isSafeInteger(quantity)) {
      throw new AppError('Order quantity exceeds the supported range.', 400);
    }
    quantities.set(item.product, quantity);
  }
  return quantities;
}

function createOrderForQuantities(userId, quantities, db) {
  const items = [];
  let totalCents = 0;
  for (const [productId, quantity] of quantities) {
    const product = Product.findById(productId);
    if (!product) {
      throw new AppError('One or more products were not found.', 404);
    }
    if (!Product.decrementStock(productId, quantity)) {
      throw new AppError(`Insufficient stock for "${product.name}".`, 409);
    }
    const priceCents = Math.round(product.price * 100);
    const lineTotal = priceCents * quantity;
    if (!Number.isSafeInteger(lineTotal) || !Number.isSafeInteger(totalCents + lineTotal)) {
      throw new AppError('Order total exceeds the supported monetary range.', 400);
    }
    totalCents += lineTotal;
    items.push({ product: productId, quantity, priceCents });
  }

  const holdMinutes = Number(process.env.ORDER_HOLD_MINUTES || 30);
  return Order.create({
    userId,
    items,
    totalCents,
    expiresAt: new Date(Date.now() + holdMinutes * 60 * 1000).toISOString(),
  }, db);
}

async function createOrder(req, res, next) {
  try {
    const quantities = normalizeItems(req.body.orderItems);
    const db = getDb();
    const create = db.transaction(() => createOrderForQuantities(req.user.id, quantities, db));
    const order = create.immediate();
    return res.status(201).json({ success: true, data: order });
  } catch (error) {
    return next(error);
  }
}

async function createOrderFromCart(req, res, next) {
  try {
    const db = getDb();
    const checkout = db.transaction(() => {
      const cartItems = Cart.getQuantities(req.user.id, db);
      if (cartItems.length === 0) {
        throw new AppError('Your cart is empty.', 400);
      }
      const quantities = new Map(cartItems.map((item) => [item.product, item.quantity]));
      const order = createOrderForQuantities(req.user.id, quantities, db);
      Cart.clear(req.user.id, db);
      return order;
    });

    const order = checkout.immediate();
    return res.status(201).json({ success: true, data: order });
  } catch (error) {
    return next(error);
  }
}

async function getMyOrders(req, res, next) {
  try {
    const page = parsePage(req.query.page, 1);
    const limit = parsePage(req.query.limit, 20, 100);
    const { orders, total } = Order.listForUser(req.user.id, { page, limit });
    return res.status(200).json({
      success: true,
      data: orders,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return next(error);
  }
}

async function getOrderById(req, res, next) {
  try {
    const order = Order.findByIdWithUser(req.params.id);
    if (!order) {
      throw new AppError('Order not found.', 404);
    }
    if (!req.user.isAdmin && order.user !== req.user.id) {
      throw new AppError('You are not allowed to view this order.', 403);
    }
    return res.status(200).json({ success: true, data: order });
  } catch (error) {
    return next(error);
  }
}

async function getAllOrders(req, res, next) {
  try {
    const page = parsePage(req.query.page, 1);
    const limit = parsePage(req.query.limit, 20, 100);
    const { orders, total } = Order.listAll({ page, limit });
    return res.status(200).json({
      success: true,
      data: orders,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return next(error);
  }
}

async function updateOrderStatus(req, res, next) {
  try {
    const { status } = req.body;
    const validStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
    if (!validStatuses.includes(status)) {
      throw new AppError(`Status must be one of: ${validStatuses.join(', ')}.`, 400);
    }

    const db = getDb();
    const update = db.transaction(() => {
      const order = Order.findById(req.params.id, db);
      if (!order) {
        throw new AppError('Order not found.', 404);
      }
      if (order.status === status) {
        return order;
      }
      if (['cancelled', 'delivered', 'refunded'].includes(order.status)) {
        throw new AppError(`A ${order.status} order cannot be changed.`, 409);
      }

      if (status === 'cancelled') {
        if (order.stripePaymentIntentId ||
          db.prepare('SELECT payment_intent_in_progress FROM orders WHERE id = ?')
            .get(order.id).payment_intent_in_progress) {
          throw new AppError('Use the order cancellation endpoint to cancel a Stripe payment safely.', 409);
        }
        if (order.paymentStatus !== 'unpaid' ||
          !['pending', 'processing'].includes(order.status)) {
          throw new AppError('Only unpaid pending or processing orders can be cancelled.', 409);
        }
        restoreOrderStock(order, db);
      } else {
        if (order.paymentStatus !== 'paid') {
          throw new AppError('Only paid orders can move to fulfillment statuses.', 409);
        }
        const transitions = {
          pending: ['processing'],
          processing: ['shipped'],
          shipped: ['delivered'],
        };
        if (!transitions[order.status] || !transitions[order.status].includes(status)) {
          throw new AppError(`An order cannot move from ${order.status} to ${status}.`, 409);
        }
      }
      Order.setStatus(order.id, status, db);
      return Order.findById(order.id, db);
    });

    return res.status(200).json({ success: true, data: update.immediate() });
  } catch (error) {
    return next(error);
  }
}

async function deleteOrder(req, res, next) {
  try {
    const db = getDb();
    const remove = db.transaction(() => {
      const order = Order.findById(req.params.id, db);
      if (!order) {
        throw new AppError('Order not found.', 404);
      }
      if (!req.user.isAdmin && order.user !== req.user.id) {
        throw new AppError('You are not allowed to delete this order.', 403);
      }
      const payment = db.prepare(`
        SELECT payment_intent_in_progress FROM orders WHERE id = ?
      `).get(order.id);
      if (order.status !== 'pending' || order.paymentStatus !== 'unpaid' ||
        order.stripePaymentIntentId || payment.payment_intent_in_progress) {
        throw new AppError('Only unpaid pending orders without a payment attempt can be deleted.', 409);
      }
      restoreOrderStock(order, db);
      Order.deleteById(order.id, db);
      return order;
    });
    const order = remove.immediate();
    return res.status(200).json({
      success: true,
      message: 'Pending order deleted and stock restored.',
      data: order,
    });
  } catch (error) {
    return next(error);
  }
}

async function cancelOrder(req, res, next) {
  try {
    const order = Order.findById(req.params.id);
    if (!order) {
      throw new AppError('Order not found.', 404);
    }
    if (!req.user.isAdmin && order.user !== req.user.id) {
      throw new AppError('You are not allowed to cancel this order.', 403);
    }
    const db = getDb();
    const payment = db.prepare(`
      SELECT payment_intent_in_progress FROM orders WHERE id = ?
    `).get(order.id);
    if (order.status !== 'pending' || order.paymentStatus !== 'unpaid') {
      throw new AppError('Only unpaid pending orders can be cancelled.', 409);
    }
    if (payment.payment_intent_in_progress) {
      throw new AppError('A payment is being started. Retry after it completes.', 409);
    }

    if (order.stripePaymentIntentId) {
      const intent = await getStripeClient().paymentIntents.cancel(order.stripePaymentIntentId);
      if (intent.status !== 'canceled') {
        throw new AppError('Stripe has not confirmed payment cancellation.', 409);
      }
    }

    const cancel = db.transaction(() => {
      const current = Order.findById(order.id, db);
      if (!current || current.status === 'cancelled') {
        return;
      }
      if (current.status !== 'pending' || current.paymentStatus !== 'unpaid' ||
        current.stripePaymentIntentId !== order.stripePaymentIntentId) {
        throw new AppError('Order changed while cancellation was in progress.', 409);
      }
      const currentPayment = db.prepare(`
        SELECT payment_intent_in_progress FROM orders WHERE id = ?
      `).get(current.id);
      if (currentPayment.payment_intent_in_progress) {
        throw new AppError('A payment is being started. Retry cancellation.', 409);
      }
      restoreOrderStock(current, db);
      Order.setStatus(current.id, 'cancelled', db);
    });
    cancel.immediate();
    return res.status(200).json({ success: true, message: 'Order cancelled and stock restored.' });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  createOrder,
  createOrderFromCart,
  getMyOrders,
  getOrderById,
  getAllOrders,
  updateOrderStatus,
  deleteOrder,
  cancelOrder,
};
