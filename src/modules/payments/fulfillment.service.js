import { withTransaction } from '../../db/pool.js';
import { sendMail } from '../../services/mail/mailer.js';
import { env } from '../../config/env.js';

// Fulfilment is idempotent and keyed on the order. Both the browser handler and
// the order.paid webhook call it, and the webhook may be retried for 24 hours,
// so it must be safe to run many times for the same order.

/**
 * Mark an order paid and confirmed. Returns {changed:boolean} so callers can
 * avoid sending duplicate email.
 */
export async function fulfilOrder({ orderId, razorpayPaymentId, method = null, rawPayload = null }) {
  const result = await withTransaction(async (conn) => {
    const [[order]] = await conn.query(
      'SELECT * FROM orders WHERE id = ? FOR UPDATE',
      [orderId]
    );
    if (!order) return { changed: false, order: null };

    // Already fulfilled by the other path (handler vs webhook).
    if (order.payment_status === 'paid') {
      return { changed: false, order };
    }

    // A cancelled order that somehow gets paid must not silently ship. Record
    // the payment and leave it for the owner to refund manually.
    if (order.status === 'cancelled') {
      await conn.query(
        `UPDATE payments SET status = 'captured', razorpay_payment_id = ?, method = ?, raw_payload = ?
          WHERE order_id = ?`,
        [razorpayPaymentId ?? null, method, rawPayload ? JSON.stringify(rawPayload) : null, orderId]
      );
      await conn.query(
        `INSERT INTO notifications (type, title, body, entity_type, entity_id)
         VALUES ('payment.on_cancelled', 'Payment received for a cancelled order',
                 ?, 'order', ?)`,
        [`${order.order_number} was cancelled but a payment arrived. Refund it manually.`, orderId]
      );
      return { changed: false, order };
    }

    await conn.query(
      `UPDATE orders
          SET status = 'confirmed', payment_status = 'paid', placed_at = UTC_TIMESTAMP()
        WHERE id = ?`,
      [orderId]
    );

    await conn.query(
      `UPDATE payments
          SET status = 'captured', razorpay_payment_id = ?, method = ?, raw_payload = ?
        WHERE order_id = ?`,
      [razorpayPaymentId ?? null, method, rawPayload ? JSON.stringify(rawPayload) : null, orderId]
    );

    await conn.query(
      `INSERT INTO notifications (type, title, body, entity_type, entity_id)
       VALUES ('order.new', 'New order', ?, 'order', ?)`,
      [`${order.order_number} — ₹${(Number(order.total_paise) / 100).toFixed(2)}`, orderId]
    );

    const [items] = await conn.query('SELECT * FROM order_items WHERE order_id = ?', [orderId]);

    // Low-stock alerts, raised after the sale has been committed.
    const variantIds = items.map((i) => i.variant_id).filter(Boolean);
    const low = variantIds.length
      ? (
          await conn.query(
            `SELECT v.id, v.size_ml, v.stock_qty, v.low_stock_threshold, p.name AS product_name
               FROM product_variants v
               JOIN products p ON p.id = v.product_id
              WHERE v.id IN (?) AND v.stock_qty <= v.low_stock_threshold`,
            [variantIds]
          )
        )[0]
      : [];

    for (const v of low) {
      await conn.query(
        `INSERT INTO notifications (type, title, body, entity_type, entity_id)
         VALUES ('stock.low', 'Low stock', ?, 'variant', ?)`,
        [`${v.product_name} ${v.size_ml}ml — ${v.stock_qty} left`, v.id]
      );
    }

    return { changed: true, order: { ...order, status: 'confirmed', payment_status: 'paid' }, items, low };
  });

  // Email is sent outside the transaction: a slow SMTP call must never hold
  // database locks, and a mail failure must never roll back a paid order.
  if (result.changed && result.order) {
    const { order, items, low } = result;

    // Templates take POSITIONAL arguments, carried in data.args. Passing a flat
    // object would arrive as a single first argument and silently drop `items`.
    await sendMail({
      to: order.ship_email,
      template: 'orderConfirmation',
      subject: `Order confirmed — ${order.order_number}`,
      data: { args: [order, items] },
      orderId: order.id,
    });

    await sendMail({
      to: env.ADMIN_ALERT_EMAIL,
      template: 'adminNewOrder',
      subject: `New order ${order.order_number}`,
      data: { args: [order, items] },
      orderId: order.id,
    });

    if (low?.length) {
      await sendMail({
        to: env.ADMIN_ALERT_EMAIL,
        template: 'adminLowStock',
        subject: `Low stock on ${low.length} item(s)`,
        data: { args: [low] },
      });
    }
  }

  return { changed: result.changed, order: result.order };
}

/** Record a failed payment attempt without touching the order's stock. */
export async function recordPaymentFailure({ orderId, razorpayPaymentId, errorCode, errorDescription, rawPayload }) {
  await withTransaction(async (conn) => {
    await conn.query(
      `UPDATE payments
          SET status = 'failed', razorpay_payment_id = COALESCE(?, razorpay_payment_id),
              error_code = ?, error_description = ?, raw_payload = ?
        WHERE order_id = ? AND status <> 'captured'`,
      [razorpayPaymentId ?? null, errorCode ?? null, errorDescription ?? null,
       rawPayload ? JSON.stringify(rawPayload) : null, orderId]
    );

    // Deliberately NOT marking the order failed. On UPI retries payment.failed
    // can arrive BEFORE payment.captured, so the order stays pending_payment
    // and the sweeper decides its fate if no payment ever lands.
  });
}
