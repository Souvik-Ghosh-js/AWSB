import { pool } from '../../db/pool.js';
import {
  resolveSort,
  paginate,
  buildPage,
  shapeVariant,
  normaliseRating,
} from './catalog.pure.js';

// Only these products are ever public. Repeated verbatim in every query rather
// than hidden behind a helper, because forgetting it leaks draft products and
// soft-deleted ones — it should be visible at every call site.
const PUBLIC_PRODUCT = "p.status = 'active' AND p.deleted_at IS NULL";

/**
 * Paginated product list with enabled variants, primary image and avg rating.
 *
 * Two queries rather than one big join: the count must not be inflated by the
 * variant/image fan-out, and fetching children for the page's 24 ids is cheaper
 * than de-duplicating a cartesian product in JS.
 */
export async function listProducts({ category, search, sort, page, limit } = {}, conn = pool) {
  const { page: safePage, limit: safeLimit, offset } = paginate({ page, limit });
  const orderBy = resolveSort(sort); // whitelist lookup — never interpolated user input

  const where = [PUBLIC_PRODUCT];
  const params = {};

  if (category) {
    where.push(`EXISTS (
      SELECT 1 FROM product_categories pc
        JOIN categories c ON c.id = pc.category_id
       WHERE pc.product_id = p.id AND c.slug = :category
    )`);
    params.category = String(category);
  }

  if (search) {
    where.push('(p.name LIKE :search OR p.tagline LIKE :search OR p.scent_family LIKE :search)');
    // Escape LIKE wildcards so a search for "50%" is a literal, not a scan.
    params.search = `%${escapeLike(String(search))}%`;
  }

  const whereSql = where.join(' AND ');

  const [countRows] = await conn.query(
    `SELECT COUNT(*) AS total FROM products p WHERE ${whereSql}`,
    params
  );
  const total = Number(countRows[0]?.total ?? 0);

  if (total === 0) {
    return buildPage([], { page: safePage, limit: safeLimit, total: 0 });
  }

  // min_price_paise is selected (not just ordered by) so price_asc/price_desc
  // have a real column to sort on, and the storefront can show "from ₹X".
  const [rows] = await conn.query(
    `SELECT p.id, p.slug, p.name, p.tagline, p.scent_family, p.is_featured,
            p.created_at,
            (SELECT MIN(v.price_paise) FROM product_variants v
              WHERE v.product_id = p.id AND v.is_enabled = TRUE) AS min_price_paise,
            (SELECT i.url FROM product_images i
              WHERE i.product_id = p.id
              ORDER BY i.is_primary DESC, i.sort_order ASC, i.id ASC
              LIMIT 1) AS primary_image_url,
            (SELECT i.alt_text FROM product_images i
              WHERE i.product_id = p.id
              ORDER BY i.is_primary DESC, i.sort_order ASC, i.id ASC
              LIMIT 1) AS primary_image_alt,
            (SELECT AVG(r.rating) FROM reviews r
              WHERE r.product_id = p.id AND r.status = 'approved') AS rating_avg,
            (SELECT COUNT(*) FROM reviews r
              WHERE r.product_id = p.id AND r.status = 'approved') AS rating_count
       FROM products p
      WHERE ${whereSql}
      ORDER BY ${orderBy}
      LIMIT :limit OFFSET :offset`,
    { ...params, limit: safeLimit, offset }
  );

  const variantsByProduct = await fetchVariants(rows.map((r) => r.id), conn);

  const items = rows.map((row) => ({
    id: Number(row.id),
    slug: row.slug,
    name: row.name,
    tagline: row.tagline,
    scentFamily: row.scent_family,
    isFeatured: Boolean(row.is_featured),
    fromPricePaise: row.min_price_paise == null ? null : Number(row.min_price_paise),
    primaryImage: row.primary_image_url
      ? { url: row.primary_image_url, altText: row.primary_image_alt ?? row.name }
      : null,
    ...normaliseRating(row.rating_avg, row.rating_count),
    variants: variantsByProduct.get(String(row.id)) ?? [],
  }));

  return buildPage(items, { page: safePage, limit: safeLimit, total });
}

/** Enabled variants for a set of product ids, grouped by product. */
async function fetchVariants(productIds, conn) {
  const grouped = new Map();
  if (productIds.length === 0) return grouped;

  // IN (?) with an array expands positionally; this query therefore uses `?`
  // rather than the named placeholders used elsewhere.
  const [rows] = await conn.query(
    `SELECT id, product_id, size_ml, size_unit, sku, price_paise, compare_at_paise,
            stock_qty, low_stock_threshold
       FROM product_variants
      WHERE product_id IN (?) AND is_enabled = TRUE
      ORDER BY size_ml ASC`,
    [productIds]
  );

  for (const row of rows) {
    const key = String(row.product_id);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(shapeVariant(row));
  }
  return grouped;
}

/**
 * Full public detail for one product: all enabled variants, all images in
 * sort_order, and APPROVED reviews only.
 * Returns null when there is no publicly visible product with that slug — the
 * route turns that into a 404.
 */
export async function getProductBySlug(slug, conn = pool) {
  const [rows] = await conn.query(
    `SELECT p.id, p.slug, p.name, p.tagline, p.description, p.scent_family,
            p.scent_notes, p.is_featured, p.meta_title, p.meta_description,
            p.created_at
       FROM products p
      WHERE p.slug = :slug AND ${PUBLIC_PRODUCT}
      LIMIT 1`,
    { slug: String(slug ?? '') }
  );

  const product = rows[0];
  if (!product) return null;

  const [variants, images, reviews, ratings, categories] = await Promise.all([
    conn.query(
      `SELECT id, size_ml, size_unit, sku, price_paise, compare_at_paise, stock_qty,
              low_stock_threshold
         FROM product_variants
        WHERE product_id = :id AND is_enabled = TRUE
        ORDER BY size_ml ASC`,
      { id: product.id }
    ),
    conn.query(
      `SELECT url, alt_text, is_primary
         FROM product_images
        WHERE product_id = :id
        ORDER BY sort_order ASC, id ASC`,
      { id: product.id }
    ),
    conn.query(
      `SELECT id, rating, title, body, author_name, is_verified_purchase, created_at
         FROM reviews
        WHERE product_id = :id AND status = 'approved'
        ORDER BY created_at DESC
        LIMIT 20`,
      { id: product.id }
    ),
    conn.query(
      `SELECT AVG(rating) AS rating_avg, COUNT(*) AS rating_count
         FROM reviews
        WHERE product_id = :id AND status = 'approved'`,
      { id: product.id }
    ),
    conn.query(
      `SELECT c.id, c.slug, c.name
         FROM product_categories pc
         JOIN categories c ON c.id = pc.category_id
        WHERE pc.product_id = :id
        ORDER BY c.sort_order ASC, c.name ASC`,
      { id: product.id }
    ),
  ]);

  return {
    id: Number(product.id),
    slug: product.slug,
    name: product.name,
    tagline: product.tagline,
    description: product.description,
    scentFamily: product.scent_family,
    // JSON columns come back parsed from mysql2; guard anyway in case the
    // column holds a string from an older write path.
    scentNotes: parseJson(product.scent_notes),
    isFeatured: Boolean(product.is_featured),
    meta: {
      title: product.meta_title ?? product.name,
      description: product.meta_description ?? product.tagline,
    },
    variants: variants[0].map(shapeVariant),
    images: images[0].map((img) => ({
      url: img.url,
      altText: img.alt_text ?? product.name,
      isPrimary: Boolean(img.is_primary),
    })),
    ...normaliseRating(ratings[0][0]?.rating_avg, ratings[0][0]?.rating_count),
    reviews: reviews[0].map(shapeReview),
    categories: categories[0].map((c) => ({ id: Number(c.id), slug: c.slug, name: c.name })),
  };
}

/** Categories that actually have something to show. */
export async function listCategories(conn = pool) {
  const [rows] = await conn.query(
    `SELECT c.id, c.slug, c.name, c.description, c.sort_order,
            COUNT(pc.product_id) AS product_count
       FROM categories c
       LEFT JOIN product_categories pc ON pc.category_id = c.id
       LEFT JOIN products p ON p.id = pc.product_id
            AND p.status = 'active' AND p.deleted_at IS NULL
      GROUP BY c.id, c.slug, c.name, c.description, c.sort_order
      ORDER BY c.sort_order ASC, c.name ASC`
  );

  return rows.map((row) => ({
    id: Number(row.id),
    slug: row.slug,
    name: row.name,
    description: row.description,
    productCount: Number(row.product_count ?? 0),
  }));
}

export function shapeReview(row) {
  return {
    id: Number(row.id),
    rating: Number(row.rating),
    title: row.title,
    body: row.body,
    authorName: row.author_name,
    isVerifiedPurchase: Boolean(row.is_verified_purchase),
    createdAt: row.created_at,
  };
}

function parseJson(value) {
  if (value == null || typeof value === 'object') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Escape LIKE metacharacters so user input stays a literal substring. */
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
