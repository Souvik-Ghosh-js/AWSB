import { pool } from '../../db/pool.js';
import { ApiError } from '../../middleware/error.js';
import { sendMail, sendAdminMail } from '../../services/mail/mailer.js';

// A replacement can only be requested for an item on a DELIVERED order — the
// same reasoning as product reviews: nothing to inspect for a defect until
// the parcel has actually arrived. Unlike reviews there is no separate
// "already requested" unique key at the database level; a customer re-filing
// after a rejection is legitimate, so the guard below only blocks a second
// PENDING request for the same item, checked at request time.
export async function requestReplacement({ customerId, orderItemId, reason }) {
  const [[row]] = await pool.query(
    `SELECT oi.id AS order_item_id, oi.product_name, o.id AS order_id, o.order_number,
            o.status, o.ship_email, c.email AS customer_email
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN customers c ON c.id = ?
      WHERE oi.id = ?
        AND (o.customer_id = c.id OR LOWER(o.ship_email) = LOWER(c.email))
      LIMIT 1`,
    [customerId, orderItemId]
  );

  if (!row) throw ApiError.notFound('That order item could not be found on your account.');
  if (row.status !== 'delivered') {
    throw ApiError.conflict(
      'A replacement can only be requested once the order has been delivered.',
      'ORDER_NOT_DELIVERED'
    );
  }

  const [[existing]] = await pool.query(
    "SELECT id FROM replacement_requests WHERE order_item_id = ? AND status = 'pending' LIMIT 1",
    [orderItemId]
  );
  if (existing) {
    throw ApiError.conflict(
      'There is already a pending replacement request for this item.',
      'REPLACEMENT_ALREADY_PENDING'
    );
  }

  const [result] = await pool.query(
    `INSERT INTO replacement_requests (order_id, order_item_id, customer_id, reason)
     VALUES (?, ?, ?, ?)`,
    [row.order_id, orderItemId, customerId, reason]
  );
  const requestId = Number(result.insertId);

  await pool.query(
    `INSERT INTO notifications (type, title, body, entity_type, entity_id)
     VALUES ('replacement.requested', 'Replacement requested', ?, 'order', ?)`,
    [`${row.order_number} — ${row.product_name}`, row.order_id]
  );

  const requestNumber = `RR-${requestId}`;

  await sendMail({
    to: row.customer_email,
    template: 'replacementRequested',
    subject: `We have your replacement request — ${requestNumber}`,
    data: { args: [{ requestNumber, orderNumber: row.order_number, productName: row.product_name, reason }] },
    orderId: row.order_id,
  });

  await sendAdminMail({
    template: 'adminReplacementRequested',
    data: {
      args: [
        {
          requestNumber,
          orderNumber: row.order_number,
          productName: row.product_name,
          reason,
          customerEmail: row.customer_email,
        },
      ],
    },
    orderId: row.order_id,
  });

  return { id: requestId, requestNumber, status: 'pending' };
}

export async function listMyReplacementRequests(customerId) {
  const [rows] = await pool.query(
    `SELECT rr.id, rr.status, rr.reason, rr.admin_note, rr.created_at, rr.decided_at,
            o.order_number, oi.product_name
       FROM replacement_requests rr
       JOIN orders o ON o.id = rr.order_id
       JOIN order_items oi ON oi.id = rr.order_item_id
      WHERE rr.customer_id = ?
      ORDER BY rr.created_at DESC`,
    [customerId]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    requestNumber: `RR-${r.id}`,
    status: r.status,
    reason: r.reason,
    adminNote: r.admin_note,
    orderNumber: r.order_number,
    productName: r.product_name,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  }));
}
