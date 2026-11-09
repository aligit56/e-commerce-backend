const express = require('express');
const {
  createOrder,
  createOrderFromCart,
  getMyOrders,
  getOrderById,
  getAllOrders,
  updateOrderStatus,
  deleteOrder,
  cancelOrder,
} = require('../controllers/orderController');
const { createPaymentIntent, refundOrder } = require('../controllers/paymentController');
const { protect, requireAdmin } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);
router.get('/mine', getMyOrders);
router.get('/', requireAdmin, getAllOrders);
router.post('/from-cart', createOrderFromCart);
router.post('/', createOrder);
router.post('/:id/payment-intent', createPaymentIntent);
router.post('/:id/refund', requireAdmin, refundOrder);
router.post('/:id/cancel', cancelOrder);
router.get('/:id', getOrderById);
router.patch('/:id/status', requireAdmin, updateOrderStatus);
router.delete('/:id', deleteOrder);

module.exports = router;
