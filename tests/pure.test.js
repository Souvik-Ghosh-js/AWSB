// Tests for the logic that can run without a database or network.
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { formatPaise, groupIndian, calculateDiscount, rupeesToPaise } from '../src/utils/money.js';
import { isValidPincode } from '../src/services/shipping/pincode.js';
import { verifyCheckoutSignature, verifyWebhookSignature } from '../src/services/payments/signature.js';
import { pickLargestFontAwb, isPlausibleAwb, normaliseCandidate } from '../src/services/ocr/awb.js';

test('money: paise conversion avoids float drift', () => {
  assert.equal(rupeesToPaise(450.5), 45050);
  assert.equal(rupeesToPaise(0.1) + rupeesToPaise(0.2), 30);
});

test('money: Indian digit grouping', () => {
  assert.equal(groupIndian(999), '999');
  assert.equal(groupIndian(1234), '1,234');
  assert.equal(groupIndian(1234567), '12,34,567');
});

test('money: formats paise as rupees', () => {
  assert.equal(formatPaise(45050), '₹450.50');
  assert.equal(formatPaise(4900), '₹49.00');
  assert.equal(formatPaise(123456789), '₹12,34,567.89');
});

test('money: percent discount honours its cap', () => {
  const coupon = { discount_type: 'percent', discount_value: 20, max_discount_paise: 10000 };
  assert.equal(calculateDiscount(100000, coupon), 10000); // 20% = 20000, capped to 10000
});

test('money: discount never exceeds the subtotal', () => {
  const coupon = { discount_type: 'fixed', discount_value: 500000 };
  assert.equal(calculateDiscount(45050, coupon), 45050);
});

test('shipping: pincode validation', () => {
  assert.ok(isValidPincode('700136'));   // the shop's own
  assert.ok(isValidPincode('700001'));
  assert.ok(!isValidPincode('070013'));  // leading zero
  assert.ok(!isValidPincode('70013'));   // too short
  assert.ok(!isValidPincode('7001366')); // too long
  assert.ok(!isValidPincode('abcdef'));
});

test('shipping: Kolkata range boundaries behave as strings', () => {
  // resolveZone compares CHAR(6) lexicographically; confirm the intended
  // 700001-700199 window includes Rajarhat and excludes Howrah.
  const inRange = (p) => p >= '700001' && p <= '700199';
  assert.ok(inRange('700136'));  // Rajarhat — the shop
  assert.ok(inRange('700091'));  // Salt Lake
  assert.ok(inRange('700199'));  // upper bound
  assert.ok(!inRange('700200'));
  assert.ok(!inRange('711101')); // Howrah pays ₹99
});

test('razorpay: checkout signature is order_id|payment_id, not the reverse', () => {
  const secret = 'test_secret_value';
  const orderId = 'order_ABC123';
  const paymentId = 'pay_XYZ789';

  const correct = crypto.createHmac('sha256', secret)
    .update(`${orderId}|${paymentId}`).digest('hex');
  const reversed = crypto.createHmac('sha256', secret)
    .update(`${paymentId}|${orderId}`).digest('hex');

  assert.ok(verifyCheckoutSignature({ orderId, paymentId, signature: correct, keySecret: secret }));
  // The reversed string is the classic bug: a valid-looking hash that never matches.
  assert.ok(!verifyCheckoutSignature({ orderId, paymentId, signature: reversed, keySecret: secret }));
});

test('razorpay: checkout signature rejects missing input', () => {
  assert.ok(!verifyCheckoutSignature({ orderId: 'order_1', paymentId: 'pay_1', signature: '', keySecret: 's' }));
  assert.ok(!verifyCheckoutSignature({ orderId: null, paymentId: 'pay_1', signature: 'x', keySecret: 's' }));
});

test('razorpay: webhook signature is computed over the raw body', () => {
  const webhookSecret = 'webhook_secret_value';
  const keySecret = 'api_key_secret_value';
  const raw = Buffer.from(JSON.stringify({ event: 'order.paid', payload: {} }), 'utf8');

  const good = crypto.createHmac('sha256', webhookSecret).update(raw).digest('hex');
  assert.ok(verifyWebhookSignature(raw, good, webhookSecret));

  // Signing with the API key secret instead of the webhook secret must fail.
  const wrongSecret = crypto.createHmac('sha256', keySecret).update(raw).digest('hex');
  assert.ok(!verifyWebhookSignature(raw, wrongSecret, webhookSecret));
});

test('razorpay: webhook verification refuses a parsed object', () => {
  assert.throws(
    () => verifyWebhookSignature({ event: 'order.paid' }, 'sig', 'secret'),
    TypeError
  );
});

test('ocr: normalises label decoration around the number', () => {
  assert.equal(normaliseCandidate('AWB No: 1234-5678-90'), '1234567890');
  assert.equal(normaliseCandidate(' 7d 0177 8899 '), '7D01778899');
});

test('ocr: rejects pincodes and mobile numbers as AWB candidates', () => {
  assert.ok(!isPlausibleAwb('700136'));      // pincode
  assert.ok(!isPlausibleAwb('7003356210'));  // the shop's own mobile
  assert.ok(!isPlausibleAwb('AWB'));         // label noise
  assert.ok(!isPlausibleAwb('ABCDEFGH'));    // no digits
  assert.ok(isPlausibleAwb('79876543210'));  // plausible Delhivery AWB
});

test('ocr: picks the number set in the largest font', () => {
  const words = [
    { text: 'AWB',          confidence: 96, bbox: { x0: 10, y0: 10, x1: 60,  y1: 24 } },
    { text: '700136',       confidence: 95, bbox: { x0: 10, y0: 40, x1: 90,  y1: 56 } },
    { text: '79876543210',  confidence: 88, bbox: { x0: 10, y0: 70, x1: 300, y1: 130 } }, // tallest
    { text: '7003356210',   confidence: 93, bbox: { x0: 10, y0: 150, x1: 180, y1: 168 } },
  ];
  const picked = pickLargestFontAwb(words);
  assert.equal(picked.value, '79876543210');
  assert.ok(picked.confidence > 0.8 && picked.confidence <= 1);
});

test('ocr: returns null when nothing on the label looks like an AWB', () => {
  const words = [
    { text: 'FROM', confidence: 90, bbox: { x0: 0, y0: 0, x1: 40, y1: 14 } },
    { text: '700136', confidence: 90, bbox: { x0: 0, y0: 20, x1: 60, y1: 34 } },
  ];
  assert.equal(pickLargestFontAwb(words), null);
});
