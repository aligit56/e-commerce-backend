const Product = require('../models/Product');

function restoreOrderStock(order, db) {
  for (const item of order.orderItems) {
    Product.incrementStock(item.product, item.quantity, db);
  }
}

module.exports = restoreOrderStock;
