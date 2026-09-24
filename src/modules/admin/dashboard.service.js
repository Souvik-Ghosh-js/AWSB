import { pool } from '../../db/pool.js';
import { countLowStock } from './inventory.service.js';
import { SALES_CSV_COLUMNS, salesCsvRow, toCsvRow } from './helpers/csv.js';

// Dashboard aggregates and the accounting export.
//
// Revenue counts PAID orders only (payment_status = 'paid'). Counting
// pending_payment orders would inflate every number with abandoned checkouts,
// which is the fastest way to make a dashboard nobody trusts.

const PAID = "payment_status = 'paid'";

async function revenueSince(days) {
  // Windows are measured from the start of the day, so 'today' means today,
  // not the last 24 hours — matching what the shop owner means by the word.
  const [[row]] = await pool.execute(
    `SELECT COALESCE(SUM(total_paise), 0) AS revenue_paise, COUNT(*) AS orders
       FROM orders
      WHERE ${PAID}
        AND COALESCE(placed_at, created_at) >= DATE_SUB(CURDATE(), INTERVAL :days DAY)`,
    { days }
  );
  return { revenue_paise: Number(row.revenue_paise), orders: Number(row.orders) };
}

export async function getDashboard() {
  const [today, last7, last30] = await Promise.all([
    revenueSince(0),
    revenueSince(6),   // today plus the previous 6 days = a 7-day window
    revenueSince(29),
  ]);

  const [statusCounts] = await pool.execute(
    `SELECT status, COUNT(*) AS n FROM orders GROUP BY status`
  );

  // Top sellers by units moved, across paid orders in the last 30 days.
  // Grouped by variant so '12ml sells, 3ml does not' stays visible.
  const [topProducts] = await pool.execute(
    `SELECT oi.product_name,
            oi.size_ml,
            oi.sku,
            SUM(oi.quantity) AS qty_sold,
            SUM(oi.line_total_paise) AS revenue_paise
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE o.${PAID}
        AND COALESCE(o.placed_at, o.created_at) >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
      GROUP BY oi.product_name, oi.size_ml, oi.sku
      ORDER BY qty_sold DESC
      LIMIT 5`
  );

  const [recentOrders] = await pool.execute(
    `SELECT id, order_number, status, payment_status, total_paise,
            ship_full_name, ship_city, ship_zone,
            COALESCE(placed_at, created_at) AS placed_at, created_at
       FROM orders
      ORDER BY created_at DESC
      LIMIT 10`
  );

  const [[notifications]] = await pool.execute(
    'SELECT COUNT(*) AS n FROM notifications WHERE is_read = FALSE'
  );

  const lowStockCount = await countLowStock();

  return {
    revenue: {
      today,
      last_7_days: last7,
      last_30_days: last30,
      // No tax block: the shop is not GST registered. Prices are final.
      currency: 'INR',
    },
    orders_by_status: Object.fromEntries(statusCounts.map((r) => [r.status, Number(r.n)])),
    top_products: topProducts.map((p) => ({
      ...p,
      qty_sold: Number(p.qty_sold),
      revenue_paise: Number(p.revenue_paise),
    })),
    low_stock_count: lowStockCount,
    recent_orders: recentOrders,
    unread_notifications: Number(notifications.n),
  };
}

/**
 * Stream the sales CSV for accounting.
 *
 * Streamed row by row rather than built in memory: a year of orders is a large
 * string, and the accountant's export should not be able to exhaust the 2 GB
 * instance's heap.
 *
 * NO tax columns anywhere — the shop is not GST registered, so there is no
 * GSTIN, no HSN code and no tax breakdown to report. Prices are final.
 */
export async function streamSalesCsv({ from, to }, writable) {
  writable.write(`${toCsvRow(SALES_CSV_COLUMNS)}\r\n`);

  const where = [PAID];
  const params = {};
  if (from) {
    where.push('COALESCE(o.placed_at, o.created_at) >= :from');
    params.from = from;
  }
  if (to) {
    // Inclusive of the whole end day: '2026-09-14' should include that day's
    // orders, not stop at midnight.
    where.push('COALESCE(o.placed_at, o.created_at) < DATE_ADD(:to, INTERVAL 1 DAY)');
    params.to = to;
  }

  const sql = `
    SELECT o.order_number, o.placed_at, o.created_at, o.status, o.payment_status,
           o.ship_full_name, o.ship_email, o.ship_phone, o.ship_city, o.ship_state,
           o.ship_pincode, o.ship_zone, o.subtotal_paise, o.discount_paise,
           o.coupon_code, o.shipping_paise, o.total_paise, o.currency,
           (SELECT GROUP_CONCAT(
                     CONCAT(oi.product_name, ' ', oi.size_ml, oi.size_unit, ' x', oi.quantity)
                     ORDER BY oi.id SEPARATOR '; ')
              FROM order_items oi WHERE oi.order_id = o.id) AS items_summary
      FROM orders o
     WHERE ${where.join(' AND ')}
     ORDER BY COALESCE(o.placed_at, o.created_at) ASC`;

  const connection = await pool.getConnection();
  try {
    const stream = connection.connection.query(sql, params).stream();
    for await (const row of stream) {
      writable.write(`${salesCsvRow(row)}\r\n`);
    }
  } finally {
    connection.release();
  }
}
