import { Router } from 'express';
import { z } from 'zod';

import { pool } from '../../db/pool.js';
import { asyncHandler, ApiError } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import {
  normaliseEmail,
  normaliseOrderNumber,
  resolveTrackingUrl,
  isTrackingLookupComplete,
} from './catalog.pure.js';

const router = Router();

// BOTH fields are required, and zod enforces it before the handler runs.
// Order numbers are sequential ('AWSB-2026-00417') and therefore trivially
// guessable: without the matching ship_email, anyone could enumerate orders and
// read another customer's name, address and phone number.
const trackQuery = z.object({
  order_number: z.string().trim().min(1).max(20),
  email: z.string().trim().email().max(255),
});

router.get(
  '/orders/track',
  validate({ query: trackQuery }),
  asyncHandler(async (req, res) => {
    // Defence in depth: the same guard the unit tests exercise, in case this
    // handler is ever mounted without its validator.
    if (!isTrackingLookupComplete(req.query)) {
      throw new ApiError(
        400,
        'TRACKING_LOOKUP_INCOMPLETE',
        'Enter both your order number and the email address used on the order.'
      );
    }

    const orderNumber = normaliseOrderNumber(req.query.order_number);
    const email = normaliseEmail(req.query.email);

    const [orders] = await pool.query(
      `SELECT o.id, o.order_number, o.status, o.payment_status,
              o.subtotal_paise, o.discount_paise, o.shipping_paise, o.total_paise,
              o.ship_full_name, o.ship_city, o.ship_state, o.ship_pincode,
              o.placed_at, o.shipped_at, o.delivered_at, o.created_at
         FROM orders o
        WHERE o.order_number = :orderNumber
          AND LOWER(o.ship_email) = :email
        LIMIT 1`,
      { orderNumber, email }
    );

    const order = orders[0];
    if (!order) {
      // One message whether the order does not exist or the email does not
      // match — anything more specific confirms which order numbers are real.
      throw new ApiError(
        404,
        'ORDER_NOT_FOUND',
        'We could not find an order with that number and email address.'
      );
    }

    const [items] = await pool.query(
      `SELECT product_name, size_ml, sku, unit_price_paise, quantity, line_total_paise
         FROM order_items
        WHERE order_id = :orderId
        ORDER BY id ASC`,
      { orderId: order.id }
    );

    const [shipments] = await pool.query(
      `SELECT s.tracking_number, s.tracking_url, s.shipped_at, s.delivered_at,
              c.name AS courier_name, c.slug AS courier_slug,
              c.tracking_url_template, c.supports_deep_link, c.phone AS courier_phone
         FROM shipments s
         JOIN couriers c ON c.id = s.courier_id
        WHERE s.order_id = :orderId
        ORDER BY s.id DESC
        LIMIT 1`,
      { orderId: order.id }
    );

    const shipment = shipments[0];

    res.json({
      orderNumber: order.order_number,
      status: order.status,
      paymentStatus: order.payment_status,
      placedAt: order.placed_at,
      shippedAt: order.shipped_at,
      deliveredAt: order.delivered_at,
      // Only the coarse destination, never the full address: this endpoint is
      // guarded by a guessable number plus an email, so it shows enough to
      // recognise your own order and no more.
      shippingTo: {
        name: order.ship_full_name,
        city: order.ship_city,
        state: order.ship_state,
        pincode: order.ship_pincode,
      },
      totals: {
        subtotalPaise: Number(order.subtotal_paise),
        discountPaise: Number(order.discount_paise),
        shippingPaise: Number(order.shipping_paise),
        totalPaise: Number(order.total_paise),
      },
      items: items.map((item) => ({
        productName: item.product_name,
        sizeMl: Number(item.size_ml),
        sku: item.sku,
        unitPricePaise: Number(item.unit_price_paise),
        quantity: Number(item.quantity),
        lineTotalPaise: Number(item.line_total_paise),
      })),
      tracking: shipment
        ? {
            courierName: shipment.courier_name,
            courierSlug: shipment.courier_slug,
            courierPhone: shipment.courier_phone,
            trackingNumber: shipment.tracking_number,
            trackingUrl: resolveTrackingUrl(shipment),
            // FALSE where the courier CAPTCHA-gates tracking: the UI then shows
            // a copyable number and the landing page instead of a deep link
            // that would 404 and read as a scam.
            supportsDeepLink: Boolean(shipment.supports_deep_link),
            shippedAt: shipment.shipped_at,
          }
        : null,
    });
  })
);

export default router;
