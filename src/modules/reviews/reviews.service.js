import { pool } from '../../db/pool.js';
import { ApiError } from '../../middleware/error.js';
import { paginate, buildPage } from '../catalog/catalog.pure.js';
import { shapeReview } from '../catalog/catalog.service.js';

/**
 * Create a review. No proof of purchase required, and no moderation queue —
 * it goes live immediately. An admin can still pull a review down after the
 * fact from /admin/reviews (reject or delete), which is now the only
 * moderation that exists for this.
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
       (:productId, :rating, :title, :body, :authorName, 'approved', FALSE)`,
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
    status: 'approved',
    isVerifiedPurchase: false,
    message: 'Thank you — your review is live.',
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
