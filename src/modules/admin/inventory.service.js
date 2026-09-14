import { pool, withTransaction } from '../../db/pool.js';
import { ApiError } from '../../middleware/error.js';
import { balanceAfter, wouldGoNegative, deltaForTarget } from './helpers/inventory-math.js';

// Stock movement.
//
// THE INVARIANT: product_variants.stock_qty is never UPDATEd without an
// inventory_movements row written in the SAME transaction. stock_qty is the
// fast current value; the ledger is the explanation. Any code path that
// changes one without the other makes "where did my stock go?" unanswerable,
// so every write goes through adjustStock below.

/**
 * Apply a signed stock delta and record it in the ledger, atomically.
 *
 * @param {object}  args
 * @param {number}  args.variantId
 * @param {number}  args.delta      signed: +50 restock, -2 damage
 * @param {string}  args.reason     inventory_movements.reason ENUM
 * @param {number?} args.actorId    admin_users.id
 * @param {string?} args.note
 * @param {number?} args.orderId
 * @param {object?} args.conn       join a caller's transaction instead of opening one
 */
export async function adjustStock({
  variantId,
  delta,
  reason = 'manual_adjustment',
  actorId = null,
  note = null,
  orderId = null,
  conn: existingConn = null,
}) {
  const run = async (conn) => {
    // FOR UPDATE: the balance we write must be the balance that results from
    // OUR delta. Without the row lock two concurrent adjustments both read the
    // same starting quantity and the ledger records a balance that never
    // existed.
    const [rows] = await conn.execute(
      `SELECT v.id, v.stock_qty, v.low_stock_threshold, v.sku, v.size_ml, p.name AS product_name
         FROM product_variants v
         JOIN products p ON p.id = v.product_id
        WHERE v.id = :id FOR UPDATE`,
      { id: variantId }
    );
    const variant = rows[0];
    if (!variant) throw new ApiError(404, 'Variant not found.');

    const numericDelta = Number(delta);
    if (!Number.isInteger(numericDelta) || numericDelta === 0) {
      throw new ApiError(422, 'Stock adjustment must be a non-zero whole number.');
    }

    const current = Number(variant.stock_qty);
    if (wouldGoNegative(current, numericDelta)) {
      throw new ApiError(
        422,
        `Cannot remove ${Math.abs(numericDelta)} from ${variant.sku}: only ${current} in stock.`
      );
    }

    const newBalance = balanceAfter(current, numericDelta);

    const [result] = await conn.execute(
      `UPDATE product_variants
          SET stock_qty = stock_qty + :delta
        WHERE id = :id AND stock_qty + :delta >= 0`,
      { id: variantId, delta: numericDelta }
    );
    // Zero rows means the guard caught a race the lock should have prevented;
    // abort rather than write a ledger row for a change that did not happen.
    if (result.affectedRows === 0) {
      throw new ApiError(409, 'Stock changed concurrently. Retry the adjustment.');
    }

    await conn.execute(
      `INSERT INTO inventory_movements
         (variant_id, delta, reason, order_id, note, actor_id, balance_after)
       VALUES
         (:variant_id, :delta, :reason, :order_id, :note, :actor_id, :balance_after)`,
      {
        variant_id: variantId,
        delta: numericDelta,
        reason,
        order_id: orderId,
        note,
        actor_id: actorId,
        balance_after: newBalance,
      }
    );

    return {
      variant_id: String(variantId),
      sku: variant.sku,
      product_name: variant.product_name,
      size_ml: variant.size_ml,
      previous_qty: current,
      delta: numericDelta,
      stock_qty: newBalance,
      low_stock_threshold: Number(variant.low_stock_threshold),
      is_low_stock: newBalance <= Number(variant.low_stock_threshold),
      reason,
    };
  };

  return existingConn ? run(existingConn) : withTransaction(run);
}

/**
 * Set stock to an absolute number ('count says 40'), converted to a delta so
 * it still flows through the ledger like every other change.
 */
export async function setStock({ variantId, targetQty, reason = 'manual_adjustment', actorId = null, note = null }) {
  return withTransaction(async (conn) => {
    const [rows] = await conn.execute(
      'SELECT stock_qty FROM product_variants WHERE id = :id FOR UPDATE',
      { id: variantId }
    );
    if (!rows[0]) throw new ApiError(404, 'Variant not found.');

    const delta = deltaForTarget(rows[0].stock_qty, targetQty);
    if (delta === 0) {
      throw new ApiError(422, `Stock is already ${targetQty}. Nothing to adjust.`);
    }
    return adjustStock({ variantId, delta, reason, actorId, note, conn });
  });
}

/**
 * Variants at or below their own alert level.
 * The threshold is per-variant because a 3ml tester turns over far faster than
 * a 12ml bottle and should warn at a different level.
 */
export async function listLowStock({ includeDisabled = false } = {}) {
  const [rows] = await pool.execute(
    `SELECT v.id AS variant_id, v.sku, v.size_ml, v.stock_qty, v.low_stock_threshold,
            v.is_enabled, v.price_paise,
            p.id AS product_id, p.name AS product_name, p.slug AS product_slug, p.status AS product_status
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
      WHERE v.stock_qty <= v.low_stock_threshold
        AND p.deleted_at IS NULL
        ${includeDisabled ? '' : 'AND v.is_enabled = TRUE'}
      ORDER BY (v.stock_qty - v.low_stock_threshold) ASC, v.stock_qty ASC, p.name ASC`
  );
  return rows;
}

export async function countLowStock() {
  const [[row]] = await pool.execute(
    `SELECT COUNT(*) AS n
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
      WHERE v.stock_qty <= v.low_stock_threshold
        AND v.is_enabled = TRUE
        AND p.deleted_at IS NULL`
  );
  return Number(row.n);
}

/** Paginated ledger history, newest first. */
export async function listMovements({ variantId, reason, page = 1, perPage = 50 } = {}) {
  const limit = Math.min(Math.max(Number(perPage) || 50, 1), 200);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

  const where = [];
  const params = {};
  if (variantId) {
    where.push('m.variant_id = :variant_id');
    params.variant_id = variantId;
  }
  if (reason) {
    where.push('m.reason = :reason');
    params.reason = reason;
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [rows] = await pool.execute(
    `SELECT m.id, m.variant_id, m.delta, m.reason, m.order_id, m.note, m.actor_id,
            m.balance_after, m.created_at,
            v.sku, v.size_ml,
            p.name AS product_name,
            a.full_name AS actor_name, a.email AS actor_email,
            o.order_number
       FROM inventory_movements m
       JOIN product_variants v ON v.id = m.variant_id
       JOIN products p ON p.id = v.product_id
       LEFT JOIN admin_users a ON a.id = m.actor_id
       LEFT JOIN orders o ON o.id = m.order_id
       ${whereSql}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params
  );

  const [[{ total }]] = await pool.execute(
    `SELECT COUNT(*) AS total FROM inventory_movements m ${whereSql}`,
    params
  );

  return { data: rows, page: Number(page) || 1, per_page: limit, total: Number(total) };
}
