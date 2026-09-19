import { pool, withTransaction } from '../../db/pool.js';
import { ApiError } from '../../middleware/error.js';
import { slugify } from './helpers/sku.js';

// Categories are a real product taxonomy (Attars, Powders, Bakhoor, Incense),
// distinct from scent_family (a free-text note like "Oud" or "Floral" that
// only ever applies to attars). A product can sit in more than one category
// in principle, but in practice each of ours has exactly one.

/** Slugs are UNIQUE; suffix a counter rather than failing the admin's save. */
async function uniqueSlug(conn, name, excludeId = null) {
  const base = slugify(name) || 'category';
  let candidate = base;
  for (let n = 2; n < 1000; n += 1) {
    const [rows] = await conn.execute(
      'SELECT id FROM categories WHERE slug = :slug AND (:id IS NULL OR id <> :id) LIMIT 1',
      { slug: candidate, id: excludeId }
    );
    if (rows.length === 0) return candidate;
    candidate = `${base}-${n}`;
  }
  return `${base}-${Date.now()}`;
}

export async function listCategories() {
  const [rows] = await pool.query(
    `SELECT c.id, c.slug, c.name, c.description, c.sort_order,
            (SELECT COUNT(*) FROM product_categories pc WHERE pc.category_id = c.id) AS product_count
       FROM categories c
      ORDER BY c.sort_order ASC, c.name ASC`
  );
  return rows;
}

export async function getCategory(id) {
  const [rows] = await pool.execute(
    `SELECT c.id, c.slug, c.name, c.description, c.sort_order,
            (SELECT COUNT(*) FROM product_categories pc WHERE pc.category_id = c.id) AS product_count
       FROM categories c WHERE c.id = :id LIMIT 1`,
    { id }
  );
  if (!rows[0]) throw new ApiError(404, 'Category not found.');
  return rows[0];
}

export async function createCategory(input) {
  return withTransaction(async (conn) => {
    const slug = input.slug ? slugify(input.slug) : await uniqueSlug(conn, input.name);
    const [result] = await conn.execute(
      `INSERT INTO categories (slug, name, description, sort_order)
       VALUES (:slug, :name, :description, :sort_order)`,
      {
        slug,
        name: input.name,
        description: input.description ?? null,
        sort_order: input.sort_order ?? 0,
      }
    );
    return String(result.insertId);
  }).then((id) => getCategory(id));
}

const UPDATABLE = ['name', 'description', 'sort_order'];

export async function updateCategory(id, input) {
  const sets = [];
  const params = { id };
  for (const key of UPDATABLE) {
    if (input[key] !== undefined) {
      sets.push(`${key} = :${key}`);
      params[key] = input[key];
    }
  }
  if (input.slug !== undefined) {
    sets.push('slug = :slug');
    params.slug = slugify(input.slug);
  }
  if (sets.length === 0) return getCategory(id);

  const [result] = await pool.execute(
    `UPDATE categories SET ${sets.join(', ')} WHERE id = :id`,
    params
  );
  if (result.affectedRows === 0) throw new ApiError(404, 'Category not found.');
  return getCategory(id);
}

/**
 * Delete a category. Blocked while any product is still assigned to it
 * rather than silently cascading (the FK is ON DELETE CASCADE) — an admin
 * deleting "Bakhoor" by mistake should not silently strip every bakhoor
 * product of its category with no warning.
 */
export async function deleteCategory(id) {
  const category = await getCategory(id);
  if (Number(category.product_count) > 0) {
    throw new ApiError(
      409,
      `Cannot delete "${category.name}": ${category.product_count} product(s) are still assigned to it. Reassign them first.`
    );
  }
  const [result] = await pool.execute('DELETE FROM categories WHERE id = :id', { id });
  if (result.affectedRows === 0) throw new ApiError(404, 'Category not found.');
  return { id: String(id), deleted: true };
}

/** Replace the full set of category assignments for a product, inside the caller's transaction. */
export async function setProductCategories(conn, productId, categoryIds) {
  await conn.execute('DELETE FROM product_categories WHERE product_id = :id', { id: productId });
  if (!categoryIds || categoryIds.length === 0) return;
  const values = categoryIds.map((cid) => [productId, cid]);
  await conn.query('INSERT INTO product_categories (product_id, category_id) VALUES ?', [values]);
}

/** Every category a product currently belongs to, for the admin product editor. */
export async function getProductCategories(conn, productId) {
  const [rows] = await conn.execute(
    `SELECT c.id, c.slug, c.name
       FROM product_categories pc
       JOIN categories c ON c.id = pc.category_id
      WHERE pc.product_id = :id
      ORDER BY c.sort_order ASC, c.name ASC`,
    { id: productId }
  );
  return rows;
}
