import express from 'express';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import { verifyWebhookSignature } from '../../services/payments/signature.js';
import { findOrderByRazorpayOrderId } from '../checkout/checkout.service.js';
import { fulfilOrder, recordPaymentFailure } from './fulfillment.service.js';

export const webhookRouter = express.Router();

// CRITICAL: express.raw MUST be mounted here, and this router MUST be mounted
// before any global express.json(). The signature is computed over the exact
// bytes Razorpay sent; re-stringifying a parsed body does not reproduce them.
webhookRouter.post(
  '/razorpay',
  express.raw({ type: 'application/json', limit: '1mb' }),
  async (req, res) => {
    const signature = req.headers['x-razorpay-signature'];
    const eventId = req.headers['x-razorpay-event-id'];

    // Note the webhook secret, NOT the API key secret.
    if (!verifyWebhookSignature(req.body, signature, env.RAZORPAY_WEBHOOK_SECRET)) {
      req.log?.warn({ eventId }, 'razorpay webhook signature mismatch');
      return res.status(400).json({ error: 'invalid signature' });
    }

    let event;
    try {
      event = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'invalid json' });
    }

    // Acknowledge fast. Razorpay requires 2xx within 5 seconds and retries with
    // backoff for 24h, disabling the endpoint after that.
    res.status(200).json({ ok: true });

    // Everything past this point is best-effort and must not throw into Express.
    try {
      // Idempotency gate: the unique index on event_id makes a duplicate
      // delivery a no-op rather than a second fulfilment.
      if (eventId) {
        try {
          await pool.query(
            'INSERT INTO payment_webhook_events (event_id, event_type, payload) VALUES (?, ?, ?)',
            [eventId, event.event, JSON.stringify(event)]
          );
        } catch (err) {
          if (err.code === 'ER_DUP_ENTRY') {
            req.log?.info({ eventId }, 'duplicate webhook ignored');
            return;
          }
          throw err;
        }
      }

      await handleEvent(event, req);

      if (eventId) {
        await pool.query(
          'UPDATE payment_webhook_events SET processed_at = UTC_TIMESTAMP() WHERE event_id = ?',
          [eventId]
        );
      }
    } catch (err) {
      req.log?.error({ err, eventId, type: event?.event }, 'webhook processing failed');
      if (eventId) {
        await pool
          .query('UPDATE payment_webhook_events SET error = ? WHERE event_id = ?', [
            String(err?.message ?? err).slice(0, 2000),
            eventId,
          ])
          .catch(() => {});
      }
    }
  }
);

async function handleEvent(event, req) {
  const type = event.event;
  const paymentEntity = event.payload?.payment?.entity;
  const orderEntity = event.payload?.order?.entity;

  const razorpayOrderId = orderEntity?.id ?? paymentEntity?.order_id;
  if (!razorpayOrderId) return;

  const order = await findOrderByRazorpayOrderId(razorpayOrderId);
  if (!order) {
    req.log?.warn({ razorpayOrderId, type }, 'webhook for unknown order');
    return;
  }

  switch (type) {
    // order.paid is the authoritative fulfilment trigger: it carries both the
    // order and payment entities and fires once the order is fully paid.
    case 'order.paid':
    case 'payment.captured': {
      const paid = Number(orderEntity?.amount_paid ?? paymentEntity?.amount ?? 0);
      const expected = Number(order.expected_amount_paise);

      // Never fulfil an underpaid order, whatever the client claimed.
      if (paid < expected) {
        req.log?.error({ paid, expected, order: order.order_number }, 'amount mismatch');
        await pool.query(
          `INSERT INTO notifications (type, title, body, entity_type, entity_id)
           VALUES ('payment.mismatch', 'Payment amount mismatch', ?, 'order', ?)`,
          [`${order.order_number}: received ₹${paid / 100}, expected ₹${expected / 100}`, order.id]
        );
        return;
      }

      await fulfilOrder({
        orderId: Number(order.id),
        razorpayPaymentId: paymentEntity?.id ?? null,
        method: paymentEntity?.method ?? null,
        rawPayload: event,
      });
      break;
    }

    case 'payment.failed':
      await recordPaymentFailure({
        orderId: Number(order.id),
        razorpayPaymentId: paymentEntity?.id ?? null,
        errorCode: paymentEntity?.error_code ?? null,
        errorDescription: paymentEntity?.error_description ?? null,
        rawPayload: event,
      });
      break;

    case 'refund.processed':
    case 'refund.failed': {
      const refund = event.payload?.refund?.entity;
      if (!refund?.id) break;
      await pool.query(
        `UPDATE refunds SET status = ? WHERE razorpay_refund_id = ?`,
        [type === 'refund.processed' ? 'processed' : 'failed', refund.id]
      );
      break;
    }

    default:
      // Logged above; no action needed.
      break;
  }
}
