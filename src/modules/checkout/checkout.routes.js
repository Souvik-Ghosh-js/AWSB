import express from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import { ApiError, asyncHandler } from '../../middleware/error.js';
import { validate, addressSchema } from '../../middleware/validate.js';
import { optionalCustomer } from '../../middleware/auth.js';
import { verifyCheckoutSignature } from '../../services/payments/signature.js';
import { createCheckoutSession, findOrderByRazorpayOrderId } from './checkout.service.js';
import { fulfilOrder } from '../payments/fulfillment.service.js';

export const checkoutRouter = express.Router();

const sessionSchema = z.object({
  items: z
    .array(
      z.object({
        variantId: z.coerce.number().int().positive(),
        quantity: z.coerce.number().int().min(1).max(20),
      })
    )
    .min(1, 'Your cart is empty.')
    .max(50),
  address: addressSchema,
  couponCode: z.string().trim().max(40).optional().nullable(),
  customerNote: z.string().trim().max(1000).optional().nullable(),
});

checkoutRouter.post(
  '/session',
  optionalCustomer,
  validate({ body: sessionSchema }),
  asyncHandler(async (req, res) => {
    const session = await createCheckoutSession({
      items: req.body.items,
      address: req.body.address,
      couponCode: req.body.couponCode,
      customerNote: req.body.customerNote,
      customerId: req.customer?.id ?? null,
    });
    res.status(201).json(session);
  })
);

const verifySchema = z.object({
  razorpay_order_id: z.string().trim().min(1),
  razorpay_payment_id: z.string().trim().min(1),
  razorpay_signature: z.string().trim().min(1),
});

/**
 * Called from Razorpay Checkout's browser handler.
 *
 * This exists to show the shopper a fast confirmation. It is NOT the
 * authoritative fulfilment path — the order.paid webhook is, because the
 * browser can close mid-redirect. Both are idempotent, so whichever arrives
 * first wins and the second is a no-op.
 */
checkoutRouter.post(
  '/verify',
  validate({ body: verifySchema }),
  asyncHandler(async (req, res) => {
    const { razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body;

    const order = await findOrderByRazorpayOrderId(rzpOrderId);
    if (!order) throw ApiError.notFound('We could not find that order.');

    // The order id is read from OUR database, never taken from the browser.
    const ok = verifyCheckoutSignature({
      orderId: order.razorpay_order_id ?? rzpOrderId,
      paymentId,
      signature,
      keySecret: env.RAZORPAY_KEY_SECRET,
    });

    if (!ok) {
      req.log?.error({ order: order.order_number }, 'checkout signature mismatch');
      throw ApiError.badRequest('We could not verify this payment.', 'SIGNATURE_INVALID');
    }

    await fulfilOrder({
      orderId: Number(order.id),
      razorpayPaymentId: paymentId,
    });

    res.json({
      orderNumber: order.order_number,
      status: 'confirmed',
      message: 'Payment received. A confirmation email is on its way.',
    });
  })
);

// Guest order lookup lives in modules/catalog/tracking.routes.js as
// GET /api/v1/orders/track. A second implementation here would be two things
// to keep in step; there was briefly one, and it is deliberately gone.
