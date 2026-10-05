import { pool } from '../../db/pool.js';
import { ApiError } from '../../middleware/error.js';
import { paginate, buildPage } from '../catalog/catalog.pure.js';
import { shapeReview } from '../catalog/catalog.service.js';

/**
 * Create a review. No proof of purchase required — anyone can leave one,
 * same as most shops; it still lands 'pending' and is invisible until an
 * admin approves it, which is the real moderation gate.
 */
export async function createReview({ productSlug, rating, title, body, authorName }, conn = pool) {
  const [[product]] = await conn.query(
    'SELECT id FROM products WHERE slug = :slug AND deleted_at IS NULL LIMIT 1',
    { slug: String(productSlug ?? '') }
  );
  if (!product) {
    throw ApiError.notFound('That fragrance is no longer available.');
  }

  const [result] = await conn.query(
    `INSERT INTO reviews
       (product_id, rating, title, body, author_name, status, is_verified_purchase)
     VALUES
       (:productId, :rating, :title, :body, :authorName, 'pending', FALSE)`,
    {
      productId: product.id,
      rating: Number(rating),
      title: title ?? null,
      body: body ?? null,
      authorName: (authorName ?? 'Customer').slice(0, 120),
    }
  );

  return {
    id: Number(result.insertId),
    status: 'pending',
    isVerifiedPurchase: false,
    message: 'Thank you. Your review will appear once it has been checked.',
  };
}

/** Approved reviews for a product, newest first. Pending/rejected never leak. */
export async function listReviewsForProduct(slug, { page, limit } = {}, conn = pool) {
  const { page: safePage, limit: safeLimit, offset } = paginate({ page, limit });

  const [productRows] = await conn.query(
    `SELECT id FROM products
      WHERE slug = :slug AND status = 'active' AND deleted_at IS NULL
      LIMIT 1`,
    { slug: String(slug ?? '') }
  );

  const product = productRows[0];
  if (!product) return null; // route turns this into a 404

  const [countRows] = await conn.query(
    `SELECT COUNT(*) AS total FROM reviews
      WHERE product_id = :id AND status = 'approved'`,
    { id: product.id }
  );
  const total = Number(countRows[0]?.total ?? 0);

  const [rows] = await conn.query(
    `SELECT id, rating, title, body, author_name, is_verified_purchase, created_at
       FROM reviews
      WHERE product_id = :id AND status = 'approved'
      ORDER BY created_at DESC, id DESC
      LIMIT :limit OFFSET :offset`,
    { id: product.id, limit: safeLimit, offset }
  );

  return buildPage(rows.map(shapeReview), { page: safePage, limit: safeLimit, total });
}
