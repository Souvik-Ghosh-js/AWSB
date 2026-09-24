import { pool } from '../../db/pool.js';
import { priceLine, summariseCart, mergeRequestedItems, normaliseVariantId } from './cart.pure.js';

/**
 * Re-price and stock-check a cart.
 *
 * The client sends only {variantId, quantity}. Prices are read from the
 * database every time — a cart posted from a browser is attacker-controlled,
 * and a client-supplied price is never trusted for any purpose.
 *
 * Problems are returned as per-line `issues` rather than thrown, so a cart with
 * one sold-out size still renders with the other lines intact.
 */
export async function validateCart(items, conn = pool) {
  const requested = mergeRequestedItems(items);

  if (requested.length === 0) {
    return { items: [], subtotalPaise: 0, hasIssues: false };
  }

  const ids = requested.map((item) => item.variantId);

  // The product columns come along so purchasability (active, not soft-deleted)
  // is decided from the same snapshot as the price — two queries could disagree
  // if an admin archives a product between them.
  const [rows] = await conn.query(
    `SELECT v.id, v.size_ml, v.size_unit, v.sku, v.price_paise, v.stock_qty, v.is_enabled,
            p.name AS product_name, p.slug AS product_slug,
            p.status AS product_status, p.deleted_at AS product_deleted_at
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
      WHERE v.id IN (?)`,
    [ids]
  );

  const byId = new Map(rows.map((row) => [normaliseVariantId(row.id), row]));

  // Map over the REQUESTED items, not the rows: a variant id that matched
  // nothing must still appear in the response as an unavailable line, or the
  // shopper's cart silently loses an item with no explanation.
  const priced = requested.map((item) => priceLine(item, byId.get(item.variantId)));

  return summariseCart(priced);
}
