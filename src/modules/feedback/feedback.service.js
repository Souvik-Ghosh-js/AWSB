import { pool } from '../../db/pool.js';

/**
 * Store a contact-form message.
 *
 * An order_number is optional and is resolved to an order_id on a best-effort
 * basis: a typo in the reference should not lose the message, so an unmatched
 * number is simply stored as NULL and the text still reaches the owner.
 */
export async function createFeedback({ name, email, subject, message, orderNumber }, conn = pool) {
  let orderId = null;

  if (orderNumber) {
    const [rows] = await conn.query(
      'SELECT id FROM orders WHERE order_number = :orderNumber LIMIT 1',
      { orderNumber: String(orderNumber).trim().toUpperCase() }
    );
    orderId = rows[0]?.id ?? null;
  }

  const [result] = await conn.query(
    `INSERT INTO feedback (name, email, subject, message, order_id, status)
     VALUES (:name, :email, :subject, :message, :orderId, 'new')`,
    {
      name: name ?? null,
      email: email ?? null,
      subject: subject ?? null,
      message,
      orderId,
    }
  );

  return {
    id: Number(result.insertId),
    status: 'new',
    message: 'Thank you for writing in. We read every message and will reply soon.',
  };
}
