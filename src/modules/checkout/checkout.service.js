import Razorpay from 'razorpay';
import { env } from '../../config/env.js';
import { pool, withTransaction } from '../../db/pool.js';
import { ApiError } from '../../middleware/error.js';
import { calculateDiscount } from '../../utils/money.js';
import { calculateShipping } from '../../services/shipping/zones.js';
import { reserveStock } from './reservation.service.js';

const razorpay = new Razorpay({
  key_id: env.RAZORPAY_KEY_ID,
  key_secret: env.RAZORPAY_KEY_SECRET,
});

/** AWSB-2026-00417. Sequence is per-year and allocated under a row lock. */
async function nextOrderNumber(conn) {
  const year = new Date().getUTCFullYear();
  await conn.query(
    `INSERT INTO order_number_seq (year_part, last_value) VALUES (?, 1)
     ON DUPLICATE KEY UPDATE last_value = last_value + 1`,
    [year]
  );
  const [[row]] = await conn.query(
    'SELECT last_value FROM order_number_seq WHERE year_part = ? FOR UPDATE',
    [year]
  );
  return `AWSB-${year}-${String(row.last_value).padStart(5, '0')}`;
}

async function loadCoupon(conn, code, customerId, subtotalPaise) {
  if (!code) return null;

  const [[coupon]] = await conn.query(
    `SELECT * FROM coupons
      WHERE code = ? AND is_active = TRUE
        AND (starts_at IS NULL OR starts_at <= UTC_TIMESTAMP())
        AND (expires_at IS NULL OR expires_at >= UTC_TIMESTAMP())
      LIMIT 1`,
    [String(code).toUpperCase().trim()]
  );

  if (!coupon) throw ApiError.badRequest('That coupon code is not valid.', 'COUPON_INVALID');

  if (subtotalPaise < Number(coupon.min_order_paise)) {
    throw ApiError.badRequest(
      `This coupon needs a minimum order of ₹${Number(coupon.min_order_paise) / 100}.`,
      'COUPON_MIN_ORDER'
    );
  }

  if (coupon.usage_limit != null && Number(coupon.used_count) >= Number(coupon.usage_limit)) {
    throw ApiError.badRequest('This coupon has been fully used.', 'COUPON_EXHAUSTED');
  }

  if (coupon.usage_limit_per_customer != null && customerId) {
    const [[used]] = await conn.query(
      'SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = ? AND customer_id = ?',
      [coupon.id, customerId]
    );
    if (Number(used.n) >= Number(coupon.usage_limit_per_customer)) {
      throw ApiError.badRequest('You have already used this coupon.', 'COUPON_USED');
    }
  }

  return coupon;
}

/**
 * Create an order and its Razorpay counterpart.
 *
 * Every price is re-read from the database. The client's numbers are used only
 * to say WHAT is being bought, never WHAT IT COSTS.
 */
export async function createCheckoutSession({ items, address, couponCode, customerId, customerNote }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw ApiError.badRequest('Your cart is empty.', 'EMPTY_CART');
  }

  return withTransaction(async (conn) => {
    // Locks rows and decrements stock, or throws with per-item problems.
    const variants = await reserveStock(conn, items);
    const byId = new Map(variants.map((v) => [Number(v.id), v]));

    const lines = items.map((item) => {
      const v = byId.get(Number(item.variantId));
      const qty = Number(item.quantity);
      const unit = Number(v.price_paise);
      return {
        variantId: Number(v.id),
        productName: v.product_name,
        sizeMl: Number(v.size_ml),
        sku: v.sku,
        unitPricePaise: unit,
        quantity: qty,
        lineTotalPaise: unit * qty,
      };
    });

    const subtotalPaise = lines.reduce((sum, l) => sum + l.lineTotalPaise, 0);

    const coupon = await loadCoupon(conn, couponCode, customerId, subtotalPaise);
    const discountPaise = calculateDiscount(subtotalPaise, coupon);

    const shipping = await calculateShipping(address.pincode, subtotalPaise - discountPaise, conn);
    const totalPaise = subtotalPaise - discountPaise + shipping.shippingPaise;

    if (totalPaise < 100) {
      // Razorpay rejects anything under ₹1.
      throw ApiError.badRequest('Order total is too low to process.', 'TOTAL_TOO_LOW');
    }

    const orderNumber = await nextOrderNumber(conn);

    const [orderResult] = await conn.query(
      `INSERT INTO orders (
         order_number, customer_id, status, payment_status,
         subtotal_paise, discount_paise, shipping_paise, total_paise, currency,
         coupon_id, coupon_code,
         ship_full_name, ship_phone, ship_alt_phone, ship_email,
         ship_line1, ship_line2, ship_landmark,
         ship_city, ship_district, ship_state, ship_pincode, ship_country, ship_zone,
         customer_note
       ) VALUES (?, ?, 'pending_payment', 'pending', ?, ?, ?, ?, 'INR', ?, ?,
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'IN', ?, ?)`,
      [
        orderNumber, customerId ?? null,
        subtotalPaise, discountPaise, shipping.shippingPaise, totalPaise,
        coupon?.id ?? null, coupon?.code ?? null,
        address.fullName, address.phone, address.altPhone ?? null, address.email,
        address.line1, address.line2 ?? null, address.landmark ?? null,
        address.city, address.district ?? null, address.state, address.pincode,
        shipping.zoneSlug, customerNote ?? null,
      ]
    );
    const orderId = Number(orderResult.insertId);

    for (const l of lines) {
      await conn.query(
        `INSERT INTO order_items
           (order_id, variant_id, product_name, size_ml, sku, unit_price_paise, quantity, line_total_paise)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [orderId, l.variantId, l.productName, l.sizeMl, l.sku, l.unitPricePaise, l.quantity, l.lineTotalPaise]
      );
    }

    // Attribute the reservation rows to the order now that it has an id.
    await conn.query(
      `UPDATE inventory_movements SET order_id = ?
        WHERE order_id IS NULL AND reason = 'sale'
          AND created_at >= (UTC_TIMESTAMP() - INTERVAL 1 MINUTE)
          AND variant_id IN (?)`,
      [orderId, lines.map((l) => l.variantId)]
    );

    if (coupon) {
      await conn.query(
        `INSERT INTO coupon_redemptions (coupon_id, order_id, customer_id, amount_paise)
         VALUES (?, ?, ?, ?)`,
        [coupon.id, orderId, customerId ?? null, discountPaise]
      );
      await conn.query('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?', [coupon.id]);
    }

    // receipt is capped at 40 chars by Razorpay.
    const rzpOrder = await razorpay.orders.create({
      amount: totalPaise,
      currency: 'INR',
      receipt: orderNumber.slice(0, 40),
      notes: { order_number: orderNumber, pincode: address.pincode },
    });

    await conn.query(
      `INSERT INTO payments (order_id, razorpay_order_id, amount_paise, status)
       VALUES (?, ?, ?, 'created')`,
      [orderId, rzpOrder.id, totalPaise]
    );

    return {
      orderNumber,
      razorpayOrderId: rzpOrder.id,
      razorpayKeyId: env.RAZORPAY_KEY_ID,
      amountPaise: totalPaise,
      currency: 'INR',
      breakdown: {
        subtotalPaise,
        discountPaise,
        shippingPaise: shipping.shippingPaise,
        totalPaise,
        shippingZone: shipping.zoneName,
      },
      prefill: {
        name: address.fullName,
        email: address.email,
        contact: address.phone,
      },
    };
  });
}

/** Look up our order id from a Razorpay order id. */
export async function findOrderByRazorpayOrderId(razorpayOrderId, conn = pool) {
  const [[row]] = await conn.query(
    `SELECT o.*, p.id AS payment_id, p.amount_paise AS expected_amount_paise
       FROM payments p
       JOIN orders o ON o.id = p.order_id
      WHERE p.razorpay_order_id = ?
      LIMIT 1`,
    [razorpayOrderId]
  );
  return row ?? null;
}
