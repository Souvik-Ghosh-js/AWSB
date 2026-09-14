import crypto from 'node:crypto';

// The three things that silently break Razorpay integrations. Verified against
// razorpay.com/docs on 2026-09-14.
//
// 1. The checkout signature string is `order_id|payment_id` — ORDER ID FIRST.
//    Reversing it produces a valid-looking hex hash that simply never matches.
// 2. Checkout signatures use the API KEY SECRET; webhook signatures use the
//    separate WEBHOOK SECRET from the dashboard. They are not interchangeable.
// 3. Webhook signatures are computed over the RAW request body. Re-stringifying
//    a parsed JSON body does not reproduce the original bytes.

/**
 * Compare two hex digests without leaking timing information.
 * timingSafeEqual throws if the buffers differ in length, so check first.
 */
function safeEqualHex(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify the signature returned by Razorpay Checkout's handler.
 *
 * @param {object}  p
 * @param {string}  p.orderId    razorpay_order_id — read from OUR database,
 *                               not from the browser payload.
 * @param {string}  p.paymentId  razorpay_payment_id from the handler.
 * @param {string}  p.signature  razorpay_signature from the handler.
 * @param {string}  p.keySecret  RAZORPAY_KEY_SECRET.
 */
export function verifyCheckoutSignature({ orderId, paymentId, signature, keySecret }) {
  if (!orderId || !paymentId || !signature || !keySecret) return false;

  // order_id FIRST. This order is the single most common integration bug.
  const payload = `${orderId}|${paymentId}`;

  const expected = crypto
    .createHmac('sha256', keySecret)
    .update(payload)
    .digest('hex');

  return safeEqualHex(expected, signature);
}

/**
 * Verify an incoming webhook.
 *
 * @param {Buffer|string} rawBody  The UNPARSED body. Mount the route with
 *                                 express.raw({type:'application/json'}) BEFORE
 *                                 any global express.json().
 * @param {string} signature       The X-Razorpay-Signature header.
 * @param {string} webhookSecret   RAZORPAY_WEBHOOK_SECRET — NOT the key secret.
 */
export function verifyWebhookSignature(rawBody, signature, webhookSecret) {
  if (!rawBody || !signature || !webhookSecret) return false;

  if (!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string') {
    // Guards against a future refactor accidentally passing a parsed object,
    // which would stringify to something that never matches.
    throw new TypeError(
      'verifyWebhookSignature needs the raw body (Buffer or string), not a parsed object.'
    );
  }

  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');

  return safeEqualHex(expected, signature);
}
