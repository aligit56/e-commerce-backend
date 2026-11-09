const Product = require('../models/Product');
const AppError = require('../utils/AppError');

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

async function getProducts(req, res, next) {
  try {
    const page = parsePage(req.query.page, 1);
    const limit = parsePage(req.query.limit, 20, 100);
    const { products, total } = Product.list({
      page,
      limit,
      category: typeof req.query.category === 'string' ? req.query.category.trim() : '',
      search: typeof req.query.search === 'string' ? req.query.search.trim() : '',
    });
    return res.status(200).json({
      success: true,
      data: products,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return next(error);
  }
}

async function getProductById(req, res, next) {
  try {
    const product = Product.findById(req.params.id);
    if (!product) {
      throw new AppError('Product not found.', 404);
    }
    return res.status(200).json({ success: true, data: product });
  } catch (error) {
    return next(error);
  }
}

async function createProduct(req, res, next) {
  try {
    const product = Product.create(req.body);
    return res.status(201).json({ success: true, data: product });
  } catch (error) {
    return next(error);
  }
}

async function updateProduct(req, res, next) {
  try {
    const updates = Object.fromEntries(
      Product.editableFields
        .filter((field) => req.body[field] !== undefined)
        .map((field) => [field, req.body[field]]),
    );
    if (Object.keys(updates).length === 0) {
      throw new AppError('Provide at least one valid product field to update.', 400);
    }
    const product = Product.update(req.params.id, updates);
    if (!product) {
      throw new AppError('Product not found.', 404);
    }
    return res.status(200).json({ success: true, data: product });
  } catch (error) {
    return next(error);
  }
}

async function deleteProduct(req, res, next) {
  try {
    if (!Product.deleteById(req.params.id)) {
      throw new AppError('Product not found or already referenced by an order.', 404);
    }
    return res.status(200).json({ success: true, message: 'Product deleted.' });
  } catch (error) {
    return next(error);
  }
}

module.exports = { getProducts, getProductById, createProduct, updateProduct, deleteProduct };
