import Razorpay from 'razorpay';
import { env } from '../../config/env.js';
import { pool, withTransaction } from '../../db/pool.js';
import { ApiError } from '../../middleware/error.js';
import { releaseStock } from '../checkout/reservation.service.js';
import { sendMail } from '../../services/mail/mailer.js';
import { canTransition, buildTrackingUrl } from './state.js';

const razorpay = new Razorpay({
  key_id: env.RAZORPAY_KEY_ID,
  key_secret: env.RAZORPAY_KEY_SECRET,
});

// The state machine and tracking-URL rules live in state.js so they stay
// testable without a database. Re-exported here for existing callers.
export { canTransition, buildTrackingUrl, isCancellable } from './state.js';

function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw ApiError.conflict(
      `An order that is ${from.replace('_', ' ')} cannot be marked ${to}.`,
      'INVALID_TRANSITION'
    );
  }
}

export async function markPacked(orderId, adminId) {
  return withTransaction(async (conn) => {
    const [[order]] = await conn.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
    if (!order) throw ApiError.notFound('Order not found.');
    assertTransition(order.status, 'packed');

    await conn.query("UPDATE orders SET status = 'packed' WHERE id = ?", [orderId]);
    await audit(conn, adminId, 'order.packed', orderId, { from: order.status }, { to: 'packed' });
    return { orderNumber: order.order_number, status: 'packed' };
  });
}

/**
 * Record the shipment and email the customer.
 *
 * For couriers that cannot be deep-linked (India Post, DTDC, TPC, Trackon), the
 * email shows a large copyable tracking number plus the courier's tracking page
 * — never a fabricated deep link, which reads as a scam.
 */
export async function shipOrder({ orderId, courierId, trackingNumber, adminId, scannedImageUrl = null, ocr = null, notes = null }) {
  const result = await withTransaction(async (conn) => {
    const [[order]] = await conn.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
    if (!order) throw ApiError.notFound('Order not found.');

    // Packing is optional in practice; allow shipping straight from confirmed.
    if (order.status === 'confirmed') {
      await conn.query("UPDATE orders SET status = 'packed' WHERE id = ?", [orderId]);
      order.status = 'packed';
    }
    assertTransition(order.status, 'shipped');

    const [[courier]] = await conn.query(
      'SELECT * FROM couriers WHERE id = ? AND is_active = TRUE LIMIT 1',
      [courierId]
    );
    if (!courier) throw ApiError.badRequest('Choose an active delivery partner.', 'COURIER_INVALID');

    const clean = String(trackingNumber).trim().toUpperCase().replace(/\s+/g, '');
    if (clean.length < 5) {
      throw ApiError.badRequest('Enter the tracking number from the label.', 'TRACKING_TOO_SHORT');
    }

    const trackingUrl = courier.supports_deep_link
      ? buildTrackingUrl(courier.tracking_url_template, clean)
      : courier.tracking_url_template; // landing page, customer pastes the number

    await conn.query(
      `INSERT INTO shipments
         (order_id, courier_id, tracking_number, tracking_url, scanned_image_url,
          ocr_raw_text, ocr_suggested, ocr_confidence, was_ocr_edited,
          entry_method, shipped_at, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?, ?)`,
      [
        orderId, courierId, clean, trackingUrl, scannedImageUrl,
        ocr?.rawText ?? null, ocr?.suggested ?? null, ocr?.confidence ?? null,
        ocr?.suggested ? ocr.suggested !== clean : false,
        scannedImageUrl ? 'scan' : 'manual',
        notes, adminId,
      ]
    );

    await conn.query(
      "UPDATE orders SET status = 'shipped', shipped_at = UTC_TIMESTAMP() WHERE id = ?",
      [orderId]
    );

    await audit(conn, adminId, 'order.shipped', orderId, null, {
      courier: courier.name,
      trackingNumber: clean,
    });

    const [items] = await conn.query('SELECT * FROM order_items WHERE order_id = ?', [orderId]);

    return {
      order: { ...order, status: 'shipped' },
      items,
      courier,
      shipment: { trackingNumber: clean, trackingUrl },
    };
  });

  // Positional args: orderShipped(order, items, shipment, courier).
  // The courier argument is what decides deep link vs copyable number.
  await sendMail({
    to: result.order.ship_email,
    template: 'orderShipped',
    subject: `Your order ${result.order.order_number} has shipped`,
    data: { args: [result.order, result.items, result.shipment, result.courier] },
    orderId: Number(result.order.id),
  });

  return {
    orderNumber: result.order.order_number,
    status: 'shipped',
    trackingNumber: result.shipment.trackingNumber,
    trackingUrl: result.shipment.trackingUrl,
    supportsDeepLink: Boolean(result.courier.supports_deep_link),
  };
}

export async function markDelivered(orderId, adminId) {
  const result = await withTransaction(async (conn) => {
    const [[order]] = await conn.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
    if (!order) throw ApiError.notFound('Order not found.');
    assertTransition(order.status, 'delivered');

    await conn.query(
      "UPDATE orders SET status = 'delivered', delivered_at = UTC_TIMESTAMP() WHERE id = ?",
      [orderId]
    );
    await conn.query(
      'UPDATE shipments SET delivered_at = UTC_TIMESTAMP() WHERE order_id = ?',
      [orderId]
    );
    await audit(conn, adminId, 'order.delivered', orderId, { from: order.status }, { to: 'delivered' });
    return order;
  });

  await sendMail({
    to: result.ship_email,
    template: 'orderDelivered',
    subject: `Thank you — ${result.order_number} delivered`,
    data: { args: [result, result.items ?? []] },
    orderId: Number(result.id),
  });

  return { orderNumber: result.order_number, status: 'delivered' };
}

/**
 * Cancel an order. If it was paid, a Razorpay refund is issued and the stock
 * is returned in the same transaction.
 */
export async function cancelOrder({ orderId, reason, adminId }) {
  const result = await withTransaction(async (conn) => {
    const [[order]] = await conn.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
    if (!order) throw ApiError.notFound('Order not found.');
    assertTransition(order.status, 'cancelled');

    await releaseStock(conn, orderId, 'cancellation', adminId);

    await conn.query(
      `UPDATE orders
          SET status = 'cancelled', cancelled_at = UTC_TIMESTAMP(), cancel_reason = ?
        WHERE id = ?`,
      [reason ?? null, orderId]
    );

    const [[payment]] = await conn.query(
      "SELECT * FROM payments WHERE order_id = ? AND status = 'captured' LIMIT 1",
      [orderId]
    );

    await audit(conn, adminId, 'order.cancelled', orderId, { from: order.status }, { reason });

    return { order, payment };
  });

  let refund = null;

  // The refund call happens outside the transaction: a slow or failing API call
  // must not hold locks or roll back the cancellation.
  if (result.payment?.razorpay_payment_id) {
    try {
      const created = await razorpay.payments.refund(result.payment.razorpay_payment_id, {
        amount: Number(result.order.total_paise),
        notes: { order_number: result.order.order_number, reason: reason ?? 'Cancelled by store' },
      });

      await pool.query(
        `INSERT INTO refunds (order_id, payment_id, razorpay_refund_id, amount_paise, status, reason, initiated_by)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
        [orderId, result.payment.id, created.id, Number(result.order.total_paise), reason ?? null, adminId]
      );
      await pool.query(
        "UPDATE orders SET payment_status = 'refunded' WHERE id = ?",
        [orderId]
      );

      refund = { id: created.id, amountPaise: Number(result.order.total_paise) };
    } catch (err) {
      // The order IS cancelled and stock IS back. Flag the refund for manual
      // handling rather than pretending the cancellation failed.
      await pool.query(
        `INSERT INTO notifications (type, title, body, entity_type, entity_id)
         VALUES ('refund.failed', 'Refund needs manual action', ?, 'order', ?)`,
        [`${result.order.order_number}: ${String(err?.message ?? err).slice(0, 300)}`, orderId]
      );
    }
  }

  // orderCancelled(order, refundInfo) — a null refund suppresses the
  // "5-7 working days" promise, which would be wrong for an unpaid order.
  await sendMail({
    to: result.order.ship_email,
    template: 'orderCancelled',
    subject: `Order ${result.order.order_number} cancelled`,
    data: { args: [result.order, refund] },
    orderId: Number(result.order.id),
  });

  return { orderNumber: result.order.order_number, status: 'cancelled', refund };
}

async function audit(conn, actorId, action, entityId, before, after) {
  await conn.query(
    `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_json, after_json)
     VALUES (?, ?, 'order', ?, ?, ?)`,
    [actorId ?? null, action, entityId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]
  );
}

export async function listOrders({ status, from, to, q, page = 1, limit = 20 }) {
  const where = [];
  const params = [];

  if (status) { where.push('o.status = ?'); params.push(status); }
  if (from) { where.push('o.created_at >= ?'); params.push(from); }
  if (to) { where.push('o.created_at <= ?'); params.push(to); }
  if (q) {
    where.push('(o.order_number LIKE ? OR o.ship_email LIKE ? OR o.ship_phone LIKE ? OR o.ship_full_name LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = (page - 1) * limit;

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM orders o ${clause}`,
    params
  );

  const [rows] = await pool.query(
    `SELECT o.id, o.order_number, o.status, o.payment_status, o.total_paise,
            o.ship_full_name, o.ship_city, o.ship_pincode, o.ship_zone,
            o.created_at, o.placed_at, o.shipped_at, o.delivered_at,
            (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS item_count
       FROM orders o
       ${clause}
      ORDER BY o.created_at DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  return { items: rows, page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) };
}

export async function getOrderDetail(orderId) {
  const [[order]] = await pool.query('SELECT * FROM orders WHERE id = ? LIMIT 1', [orderId]);
  if (!order) throw ApiError.notFound('Order not found.');

  const [items] = await pool.query('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
  const [payments] = await pool.query('SELECT * FROM payments WHERE order_id = ?', [orderId]);
  const [shipments] = await pool.query(
    `SELECT s.*, c.name AS courier_name, c.supports_deep_link
       FROM shipments s JOIN couriers c ON c.id = s.courier_id
      WHERE s.order_id = ? ORDER BY s.id DESC`,
    [orderId]
  );
  const [refunds] = await pool.query('SELECT * FROM refunds WHERE order_id = ?', [orderId]);

  return { order, items, payments, shipments, refunds };
}
