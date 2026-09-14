import { pool } from '../../db/pool.js';
import { ApiError } from '../../middleware/error.js';
import { paginate, buildPage, normaliseEmail, normaliseOrderNumber } from '../catalog/catalog.pure.js';
import { shapeReview } from '../catalog/catalog.service.js';

// MySQL duplicate-key errno. uniq_order_product (order_id, product_id) enforces
// one review per product per order at the database level; catching this is how
// a race between two submits becomes a friendly message instead of a 500.
const ER_DUP_ENTRY = 1062;

/**
 * Create a review, but only from someone who actually received the product.
 *
 * Verification is by order_number + email rather than a session, because guest
 * checkout is allowed and most reviewers will never have an account. The email
 * must match the order's ship_email: order numbers are sequential and therefore
 * guessable, so the number alone would let anyone review any order.
 */
export async function createReview({ orderNumber, email, productSlug, rating, title, body, authorName }, conn = pool) {
  const [rows] = await conn.query(
    `SELECT o.id AS order_id, o.customer_id, o.ship_full_name, p.id AS product_id
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       JOIN product_variants v ON v.id = oi.variant_id
       JOIN products p ON p.id = v.product_id
      WHERE o.order_number = :orderNumber
        AND LOWER(o.ship_email) = :email
        AND o.status = 'delivered'
        AND p.slug = :productSlug
        AND p.deleted_at IS NULL
      LIMIT 1`,
    {
      orderNumber: normaliseOrderNumber(orderNumber),
      email: normaliseEmail(email),
      productSlug: String(productSlug ?? ''),
    }
  );

  const match = rows[0];
  if (!match) {
    // Deliberately one message for all three failure modes (no such order,
    // wrong email, not delivered yet, product not in the order). Distinguishing
    // them would turn this endpoint into an oracle for which order numbers and
    // emails exist.
    throw new ApiError(
      403,
      'PURCHASE_NOT_VERIFIED',
      'We could not find a delivered order with that order number and email containing this fragrance.'
    );
  }

  try {
    const [result] = await conn.query(
      `INSERT INTO reviews
         (product_id, customer_id, order_id, rating, title, body, author_name,
          status, is_verified_purchase)
       VALUES
         (:productId, :customerId, :orderId, :rating, :title, :body, :authorName,
          'pending', TRUE)`,
      {
        productId: match.product_id,
        customerId: match.customer_id ?? null,
        orderId: match.order_id,
        rating: Number(rating),
        title: title ?? null,
        body: body ?? null,
        // Fall back to the name on the parcel when none is supplied.
        authorName: (authorName ?? match.ship_full_name ?? 'Customer').slice(0, 120),
      }
    );

    return {
      id: Number(result.insertId),
      status: 'pending',
      isVerifiedPurchase: true,
      message: 'Thank you. Your review will appear once it has been checked.',
    };
  } catch (err) {
    if (err?.errno === ER_DUP_ENTRY) {
      throw new ApiError(
        409,
        'REVIEW_ALREADY_EXISTS',
        'You have already reviewed this fragrance for this order. Thank you.'
      );
    }
    throw err;
  }
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
