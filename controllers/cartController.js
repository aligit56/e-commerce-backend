const Cart = require('../models/Cart');
const AppError = require('../utils/AppError');

async function getCart(req, res, next) {
  try {
    return res.status(200).json({ success: true, data: Cart.getByUser(req.user.id) });
  } catch (error) {
    return next(error);
  }
}

async function addCartItem(req, res, next) {
  try {
    const { productId, quantity } = req.body || {};
    if (typeof productId !== 'string' || !productId.trim()) {
      throw new AppError('A productId is required.', 400);
    }
    const cart = Cart.addItem(req.user.id, productId, quantity);
    return res.status(200).json({ success: true, data: cart });
  } catch (error) {
    return next(error);
  }
}

async function updateCartItem(req, res, next) {
  try {
    const cart = Cart.setItemQuantity(req.user.id, req.params.productId, req.body?.quantity);
    return res.status(200).json({ success: true, data: cart });
  } catch (error) {
    return next(error);
  }
}

async function removeCartItem(req, res, next) {
  try {
    if (!Cart.removeItem(req.user.id, req.params.productId)) {
      throw new AppError('Product is not in this cart.', 404);
    }
    return res.status(200).json({
      success: true,
      message: 'Product removed from cart.',
      data: Cart.getByUser(req.user.id),
    });
  } catch (error) {
    return next(error);
  }
}

async function clearCart(req, res, next) {
  try {
    Cart.clear(req.user.id);
    return res.status(200).json({
      success: true,
      message: 'Cart cleared.',
      data: Cart.getByUser(req.user.id),
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = { getCart, addCartItem, updateCartItem, removeCartItem, clearCart };
