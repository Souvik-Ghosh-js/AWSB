import { withTransaction } from '../../db/pool.js';
import { ApiError } from '../../middleware/error.js';

// Stock is reserved when the Razorpay order is CREATED, not when payment
// succeeds. Otherwise two buyers can both pay for the last 3ml bottle and one
// of them gets a refund and a bad memory of the shop.
//
// A sweeper (scripts/release-stale-reservations.js) returns stock from
// pending_payment orders that were never paid.

/**
 * Lock variant rows and decrement stock atomically.
 *
 * Rows are locked in ascending id order. Two concurrent checkouts holding each
 * other's rows in the opposite order would deadlock; consistent ordering makes
 * that impossible.
 *
 * @param {import('mysql2/promise').PoolConnection} conn  inside a transaction
 * @param {Array<{variantId:number, quantity:number}>} lines
 * @param {number|null} orderId
 */
export async function reserveStock(conn, lines, orderId = null) {
  const ids = [...new Set(lines.map((l) => Number(l.variantId)))].sort((a, b) => a - b);
  if (ids.length === 0) throw ApiError.badRequest('Your cart is empty.', 'EMPTY_CART');

  const [locked] = await conn.query(
    `SELECT v.id, v.sku, v.size_ml, v.stock_qty, v.is_enabled, v.price_paise,
            p.name AS product_name, p.status AS product_status
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
      WHERE v.id IN (?)
      ORDER BY v.id
      FOR UPDATE`,
    [ids]
  );

  const byId = new Map(locked.map((r) => [Number(r.id), r]));
  const problems = [];

  for (const line of lines) {
    const v = byId.get(Number(line.variantId));
    const qty = Number(line.quantity);

    if (!v) {
      problems.push({ variantId: line.variantId, issue: 'not_found', message: 'This item is no longer available.' });
      continue;
    }
    if (!v.is_enabled || v.product_status !== 'active') {
      problems.push({
        variantId: line.variantId,
        issue: 'unavailable',
        message: `${v.product_name} ${v.size_ml}ml is not available right now.`,
      });
      continue;
    }
    if (v.stock_qty < qty) {
      problems.push({
        variantId: line.variantId,
        issue: 'insufficient_stock',
        available: Number(v.stock_qty),
        message:
          v.stock_qty === 0
            ? `${v.product_name} ${v.size_ml}ml has just sold out.`
            : `Only ${v.stock_qty} left of ${v.product_name} ${v.size_ml}ml.`,
      });
    }
  }

  if (problems.length > 0) {
    throw new ApiError(409, 'STOCK_UNAVAILABLE', 'Some items are no longer available.', problems);
  }

  for (const line of lines) {
    const qty = Number(line.quantity);
    const v = byId.get(Number(line.variantId));

    // The WHERE clause repeats the stock check. Combined with the row lock and
    // the chk_stock_nonneg constraint, stock cannot go negative even under a race.
    const [result] = await conn.query(
      `UPDATE product_variants
          SET stock_qty = stock_qty - ?
        WHERE id = ? AND stock_qty >= ?`,
      [qty, v.id, qty]
    );

    if (result.affectedRows !== 1) {
      throw new ApiError(409, 'STOCK_UNAVAILABLE', 'Someone just bought the last one. Please review your cart.');
    }

    await conn.query(
      `INSERT INTO inventory_movements
         (variant_id, delta, reason, order_id, balance_after, note)
       VALUES (?, ?, 'sale', ?, ?, ?)`,
      [v.id, -qty, orderId, Number(v.stock_qty) - qty, 'Reserved at checkout']
    );
  }

  return locked;
}

/**
 * Return reserved stock to the shelf. Used by cancellation, refunds and the
 * stale-reservation sweeper.
 */
export async function releaseStock(conn, orderId, reason = 'cancellation', actorId = null) {
  const [items] = await conn.query(
    `SELECT variant_id, quantity FROM order_items
      WHERE order_id = ? AND variant_id IS NOT NULL`,
    [orderId]
  );
  if (items.length === 0) return 0;

  const ids = [...new Set(items.map((i) => Number(i.variant_id)))].sort((a, b) => a - b);
  const [locked] = await conn.query(
    'SELECT id, stock_qty FROM product_variants WHERE id IN (?) ORDER BY id FOR UPDATE',
    [ids]
  );
  const stockById = new Map(locked.map((r) => [Number(r.id), Number(r.stock_qty)]));

  for (const item of items) {
    const variantId = Number(item.variant_id);
    const qty = Number(item.quantity);
    const current = stockById.get(variantId);
    if (current === undefined) continue; // variant deleted since the order

    await conn.query('UPDATE product_variants SET stock_qty = stock_qty + ? WHERE id = ?', [qty, variantId]);
    await conn.query(
      `INSERT INTO inventory_movements
         (variant_id, delta, reason, order_id, actor_id, balance_after, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [variantId, qty, reason, orderId, actorId, current + qty, 'Stock returned']
    );
    stockById.set(variantId, current + qty);
  }

  return items.length;
}

/**
 * Release stock for orders that were never paid.
 * Run on a schedule; see deploy/cron.
 */
export async function releaseStaleReservations(minutes) {
  return withTransaction(async (conn) => {
    const [stale] = await conn.query(
      `SELECT id, order_number FROM orders
        WHERE status = 'pending_payment'
          AND created_at < (UTC_TIMESTAMP() - INTERVAL ? MINUTE)
        ORDER BY id
        LIMIT 200
        FOR UPDATE`,
      [minutes]
    );

    for (const order of stale) {
      await releaseStock(conn, order.id, 'reservation_release');
      await conn.query(
        `UPDATE orders
            SET status = 'cancelled',
                cancelled_at = UTC_TIMESTAMP(),
                cancel_reason = 'Payment not completed'
          WHERE id = ?`,
        [order.id]
      );
    }

    return stale.map((o) => o.order_number);
  });
}
