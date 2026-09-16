import { pool, withTransaction } from '../../db/pool.js';
import { ApiError } from '../../middleware/error.js';
import { uploadFile } from '../../services/storage/index.js';
import { generateSku, dedupeSku, slugify, VARIANT_SIZES_ML } from './helpers/sku.js';

// Products, their 3ml/6ml/12ml variants, and their images.
//
// A product is never purchasable in itself — you buy a variant — so creating a
// product always materialises all three sizes at once. The admin then sets a
// price and stock per size independently, and switches off any size they do
// not fill by clearing is_enabled rather than deleting the row (deleting it
// would orphan the SKU that past order_items snapshotted).

export const MAX_IMAGES_PER_PRODUCT = 5;

const PRODUCT_FIELDS = `
  p.id, p.slug, p.name, p.tagline, p.description, p.scent_family, p.scent_notes,
  p.status, p.is_featured, p.sort_order, p.meta_title, p.meta_description,
  p.created_at, p.updated_at, p.deleted_at
`;

/** Slugs are UNIQUE; suffix a counter rather than failing the admin's save. */
async function uniqueSlug(conn, name, excludeId = null) {
  const base = slugify(name) || 'attar';
  let candidate = base;
  for (let n = 2; n < 1000; n += 1) {
    const [rows] = await conn.execute(
      'SELECT id FROM products WHERE slug = :slug AND (:id IS NULL OR id <> :id) LIMIT 1',
      { slug: candidate, id: excludeId }
    );
    if (rows.length === 0) return candidate;
    candidate = `${base}-${n}`;
  }
  return `${base}-${Date.now()}`;
}

/** Every SKU already in use, so generated ones can be de-duplicated. */
async function takenSkus(conn) {
  const [rows] = await conn.query('SELECT sku FROM product_variants');
  return new Set(rows.map((r) => r.sku));
}

export async function listProducts({
  q,
  status,
  includeDeleted = false,
  page = 1,
  perPage = 20,
} = {}) {
  const limit = Math.min(Math.max(Number(perPage) || 20, 1), 100);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

  const where = [];
  const params = {};
  if (!includeDeleted) where.push('p.deleted_at IS NULL');
  if (status) {
    where.push('p.status = :status');
    params.status = status;
  }
  if (q) {
    where.push('(p.name LIKE :q OR p.slug LIKE :q OR p.scent_family LIKE :q)');
    params.q = `%${q}%`;
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [rows] = await pool.execute(
    `SELECT ${PRODUCT_FIELDS},
            (SELECT COUNT(*) FROM product_variants v WHERE v.product_id = p.id) AS variant_count,
            (SELECT COALESCE(SUM(v.stock_qty), 0) FROM product_variants v WHERE v.product_id = p.id) AS total_stock,
            (SELECT i.url FROM product_images i
              WHERE i.product_id = p.id
              ORDER BY i.is_primary DESC, i.sort_order ASC, i.id ASC LIMIT 1) AS primary_image_url
       FROM products p
       ${whereSql}
      ORDER BY p.sort_order ASC, p.id DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params
  );

  const [[{ total }]] = await pool.execute(
    `SELECT COUNT(*) AS total FROM products p ${whereSql}`,
    params
  );

  // Attach each product's sizes. The admin list renders a pill per enabled
  // size on every row, read from `variants[]`; without this array every
  // product showed "No sizes enabled" no matter how it was configured. One
  // grouped query for the page, not one per product.
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const [variants] = await pool.query(
      `SELECT id, product_id, size_ml, sku, price_paise, compare_at_paise, stock_qty,
              low_stock_threshold, is_enabled, weight_grams
         FROM product_variants
        WHERE product_id IN (?)
        ORDER BY product_id ASC, size_ml ASC`,
      [ids]
    );
    const byProduct = new Map();
    for (const v of variants) {
      const key = String(v.product_id);
      if (!byProduct.has(key)) byProduct.set(key, []);
      byProduct.get(key).push(v);
    }
    for (const r of rows) r.variants = byProduct.get(String(r.id)) ?? [];
  }

  return { data: rows, page: Number(page) || 1, per_page: limit, total: Number(total) };
}

export async function getProduct(id, { includeDeleted = true } = {}) {
  const [rows] = await pool.execute(
    `SELECT ${PRODUCT_FIELDS} FROM products p
      WHERE p.id = :id ${includeDeleted ? '' : 'AND p.deleted_at IS NULL'} LIMIT 1`,
    { id }
  );
  const product = rows[0];
  if (!product) throw new ApiError(404, 'Product not found.');

  const [variants] = await pool.execute(
    `SELECT id, product_id, size_ml, sku, price_paise, compare_at_paise, stock_qty,
            low_stock_threshold, is_enabled, weight_grams, created_at, updated_at
       FROM product_variants WHERE product_id = :id ORDER BY size_ml ASC`,
    { id }
  );

  const [images] = await pool.execute(
    `SELECT id, product_id, url, alt_text, sort_order, is_primary, created_at
       FROM product_images WHERE product_id = :id
      ORDER BY is_primary DESC, sort_order ASC, id ASC`,
    { id }
  );

  return { ...product, variants, images };
}

/**
 * Create a product and auto-create its 3ml/6ml/12ml variants in one
 * transaction — a product with no variants is unsellable, so the two must
 * never be separately committed.
 *
 * `variants` may carry per-size overrides keyed by size:
 *   [{ size_ml: 3, price_paise: 45000, stock_qty: 10, is_enabled: true }, ...]
 * Any size not mentioned is created disabled at zero price for the admin to
 * fill in later.
 */
export async function createProduct(input) {
  return withTransaction(async (conn) => {
    const slug = input.slug ? slugify(input.slug) : await uniqueSlug(conn, input.name);

    const [result] = await conn.execute(
      `INSERT INTO products
         (slug, name, tagline, description, scent_family, scent_notes, status,
          is_featured, sort_order, meta_title, meta_description)
       VALUES
         (:slug, :name, :tagline, :description, :scent_family, :scent_notes, :status,
          :is_featured, :sort_order, :meta_title, :meta_description)`,
      {
        slug,
        name: input.name,
        tagline: input.tagline ?? null,
        description: input.description ?? null,
        scent_family: input.scent_family ?? null,
        scent_notes: input.scent_notes ? JSON.stringify(input.scent_notes) : null,
        status: input.status ?? 'draft',
        is_featured: input.is_featured ?? false,
        sort_order: input.sort_order ?? 0,
        meta_title: input.meta_title ?? null,
        meta_description: input.meta_description ?? null,
      }
    );

    const productId = String(result.insertId);
    const overrides = new Map(
      (input.variants ?? []).map((v) => [Number(v.size_ml), v])
    );
    const used = await takenSkus(conn);

    for (const sizeMl of VARIANT_SIZES_ML) {
      const v = overrides.get(sizeMl) ?? {};
      const sku = dedupeSku(v.sku ?? generateSku(input.name, sizeMl), used);
      used.add(sku);

      await conn.execute(
        `INSERT INTO product_variants
           (product_id, size_ml, sku, price_paise, compare_at_paise, stock_qty,
            low_stock_threshold, is_enabled, weight_grams)
         VALUES
           (:product_id, :size_ml, :sku, :price_paise, :compare_at_paise, :stock_qty,
            :low_stock_threshold, :is_enabled, :weight_grams)`,
        {
          product_id: productId,
          size_ml: sizeMl,
          sku,
          price_paise: v.price_paise ?? 0,
          compare_at_paise: v.compare_at_paise ?? null,
          stock_qty: v.stock_qty ?? 0,
          low_stock_threshold: v.low_stock_threshold ?? 5,
          // A size with no price set yet is disabled by default, so a ₹0
          // bottle can never appear on the storefront.
          is_enabled: v.is_enabled ?? (v.price_paise != null && v.price_paise > 0),
          weight_grams: v.weight_grams ?? null,
        }
      );

      // Opening stock is still a stock change: it gets a ledger row like any
      // other, so the variant's history starts from a real balance.
      if ((v.stock_qty ?? 0) > 0) {
        await conn.execute(
          `INSERT INTO inventory_movements
             (variant_id, delta, reason, note, actor_id, balance_after)
           VALUES
             (LAST_INSERT_ID(), :delta, 'restock', 'Opening stock', :actor_id, :balance_after)`,
          {
            delta: v.stock_qty,
            actor_id: input.actor_id ?? null,
            balance_after: v.stock_qty,
          }
        );
      }
    }

    return productId;
  }).then((id) => getProduct(id));
}

const UPDATABLE = [
  'name', 'tagline', 'description', 'scent_family', 'status',
  'is_featured', 'sort_order', 'meta_title', 'meta_description',
];

export async function updateProduct(id, input) {
  const sets = [];
  const params = { id };

  for (const key of UPDATABLE) {
    if (input[key] !== undefined) {
      sets.push(`${key} = :${key}`);
      params[key] = input[key];
    }
  }
  if (input.scent_notes !== undefined) {
    sets.push('scent_notes = :scent_notes');
    params.scent_notes = input.scent_notes ? JSON.stringify(input.scent_notes) : null;
  }
  if (input.slug !== undefined) {
    sets.push('slug = :slug');
    params.slug = slugify(input.slug);
  }

  if (sets.length === 0) return getProduct(id);

  const [result] = await pool.execute(
    `UPDATE products SET ${sets.join(', ')} WHERE id = :id AND deleted_at IS NULL`,
    params
  );
  if (result.affectedRows === 0) throw new ApiError(404, 'Product not found.');

  return getProduct(id);
}

/**
 * Soft delete. order_items snapshot the product name and SKU, so history
 * survives — but the row itself stays so the variant FKs and the ledger keep
 * resolving. Archiving the status too keeps it out of storefront queries that
 * filter on status rather than deleted_at.
 */
export async function softDeleteProduct(id) {
  const [result] = await pool.execute(
    `UPDATE products
        SET deleted_at = CURRENT_TIMESTAMP, status = 'archived'
      WHERE id = :id AND deleted_at IS NULL`,
    { id }
  );
  if (result.affectedRows === 0) throw new ApiError(404, 'Product not found or already deleted.');
  return { id: String(id), deleted: true };
}

export async function restoreProduct(id) {
  const [result] = await pool.execute(
    `UPDATE products SET deleted_at = NULL WHERE id = :id AND deleted_at IS NOT NULL`,
    { id }
  );
  if (result.affectedRows === 0) throw new ApiError(404, 'Product not found or not deleted.');
  return getProduct(id);
}

// ------------------------------------------------------------------ variants

/**
 * Update a variant's price/threshold/enabled flags.
 *
 * Note what is NOT here: stock_qty. Stock only ever moves through
 * inventory.service.js, which writes the ledger row in the same transaction.
 * Allowing a silent stock write here is exactly the hole the ledger exists to
 * close, so the field is rejected rather than ignored.
 */
export async function updateVariant(variantId, input) {
  if (input.stock_qty !== undefined) {
    throw new ApiError(
      400,
      'Stock cannot be changed here. Use PATCH /admin/variants/:id/stock so the movement is recorded in the ledger.'
    );
  }

  const fields = ['sku', 'price_paise', 'compare_at_paise', 'low_stock_threshold', 'is_enabled', 'weight_grams'];
  const sets = [];
  const params = { id: variantId };
  for (const key of fields) {
    if (input[key] !== undefined) {
      sets.push(`${key} = :${key}`);
      params[key] = input[key];
    }
  }
  if (sets.length === 0) return getVariant(variantId);

  const [result] = await pool.execute(
    `UPDATE product_variants SET ${sets.join(', ')} WHERE id = :id`,
    params
  );
  if (result.affectedRows === 0) throw new ApiError(404, 'Variant not found.');
  return getVariant(variantId);
}

export async function getVariant(variantId) {
  const [rows] = await pool.execute(
    `SELECT v.*, p.name AS product_name, p.slug AS product_slug
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
      WHERE v.id = :id LIMIT 1`,
    { id: variantId }
  );
  if (!rows[0]) throw new ApiError(404, 'Variant not found.');
  return rows[0];
}

// -------------------------------------------------------------------- images

export async function listImages(productId) {
  const [rows] = await pool.execute(
    `SELECT id, product_id, url, alt_text, sort_order, is_primary, created_at
       FROM product_images WHERE product_id = :id
      ORDER BY is_primary DESC, sort_order ASC, id ASC`,
    { id: productId }
  );
  return rows;
}

/**
 * Upload one image and attach it to a product.
 * The cap is enforced inside the transaction with a locking read, so two
 * concurrent uploads cannot both see four images and both insert a fifth.
 */
export async function addProductImage(productId, file, { altText = null, isPrimary = false } = {}) {
  const [productRows] = await pool.execute(
    'SELECT id, name FROM products WHERE id = :id AND deleted_at IS NULL LIMIT 1',
    { id: productId }
  );
  if (!productRows[0]) throw new ApiError(404, 'Product not found.');

  const [countRows] = await pool.execute(
    'SELECT COUNT(*) AS n FROM product_images WHERE product_id = :id',
    { id: productId }
  );
  if (Number(countRows[0].n) >= MAX_IMAGES_PER_PRODUCT) {
    throw new ApiError(
      422,
      `A product can have at most ${MAX_IMAGES_PER_PRODUCT} images. Delete one before adding another.`
    );
  }

  // Upload before opening the transaction: object storage is slow and must not
  // hold a row lock. A failed insert afterwards leaves an orphaned object,
  // which is cheap; a held lock across a network call is not.
  const safeName = `${slugify(productRows[0].name) || 'product'}-${Date.now()}`;
  const { url } = await uploadFile(file.buffer, {
    filename: `products/${productId}/${safeName}`,
    contentType: file.mimetype,
  });

  return withTransaction(async (conn) => {
    const [existing] = await conn.execute(
      'SELECT id, COUNT(*) OVER () AS n FROM product_images WHERE product_id = :id FOR UPDATE',
      { id: productId }
    );
    if (existing.length >= MAX_IMAGES_PER_PRODUCT) {
      throw new ApiError(422, `A product can have at most ${MAX_IMAGES_PER_PRODUCT} images.`);
    }

    // The first image uploaded is the primary one by default.
    const primary = isPrimary || existing.length === 0;
    if (primary) {
      await conn.execute(
        'UPDATE product_images SET is_primary = FALSE WHERE product_id = :id',
        { id: productId }
      );
    }

    const [result] = await conn.execute(
      `INSERT INTO product_images (product_id, url, alt_text, sort_order, is_primary)
       VALUES (:product_id, :url, :alt_text, :sort_order, :is_primary)`,
      {
        product_id: productId,
        url,
        alt_text: altText,
        sort_order: existing.length,
        is_primary: primary,
      }
    );

    return {
      id: String(result.insertId),
      product_id: String(productId),
      url,
      alt_text: altText,
      sort_order: existing.length,
      is_primary: primary,
    };
  });
}

export async function updateImage(imageId, { alt_text: altText, sort_order: sortOrder, is_primary: isPrimary }) {
  return withTransaction(async (conn) => {
    const [rows] = await conn.execute(
      'SELECT id, product_id FROM product_images WHERE id = :id LIMIT 1',
      { id: imageId }
    );
    const image = rows[0];
    if (!image) throw new ApiError(404, 'Image not found.');

    if (isPrimary === true) {
      await conn.execute(
        'UPDATE product_images SET is_primary = FALSE WHERE product_id = :pid',
        { pid: image.product_id }
      );
    }

    const sets = [];
    const params = { id: imageId };
    if (altText !== undefined) {
      sets.push('alt_text = :alt_text');
      params.alt_text = altText;
    }
    if (sortOrder !== undefined) {
      sets.push('sort_order = :sort_order');
      params.sort_order = sortOrder;
    }
    if (isPrimary !== undefined) {
      sets.push('is_primary = :is_primary');
      params.is_primary = isPrimary;
    }
    if (sets.length) {
      await conn.execute(`UPDATE product_images SET ${sets.join(', ')} WHERE id = :id`, params);
    }

    const [updated] = await conn.execute(
      'SELECT id, product_id, url, alt_text, sort_order, is_primary, created_at FROM product_images WHERE id = :id',
      { id: imageId }
    );
    return updated[0];
  });
}

export async function deleteImage(imageId) {
  return withTransaction(async (conn) => {
    const [rows] = await conn.execute(
      'SELECT id, product_id, is_primary FROM product_images WHERE id = :id LIMIT 1',
      { id: imageId }
    );
    const image = rows[0];
    if (!image) throw new ApiError(404, 'Image not found.');

    await conn.execute('DELETE FROM product_images WHERE id = :id', { id: imageId });

    // A product should never be left with images but no primary one.
    if (image.is_primary) {
      await conn.execute(
        `UPDATE product_images SET is_primary = TRUE
          WHERE product_id = :pid
          ORDER BY sort_order ASC, id ASC LIMIT 1`,
        { pid: image.product_id }
      );
    }

    return { id: String(imageId), deleted: true };
  });
}
