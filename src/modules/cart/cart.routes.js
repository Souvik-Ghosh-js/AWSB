import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { validateCart } from './cart.service.js';
import { calculateShipping } from '../../services/shipping/zones.js';
import { MAX_QUANTITY_PER_LINE } from './cart.pure.js';

const router = Router();

const cartItem = z.object({
  // BIGINT ids arrive as strings from mysql2; accept either and compare as
  // strings so a 17-digit id never loses precision through Number().
  variantId: z.union([z.string().trim().min(1), z.number().int().positive()]),
  quantity: z.coerce.number().int().min(1).max(MAX_QUANTITY_PER_LINE),
});

const validateBody = z.object({
  items: z.array(cartItem).max(50),
});

const shippingQuoteBody = z.object({
  pincode: z.string().trim().regex(/^[1-9][0-9]{5}$/, 'Enter a valid 6-digit pincode.'),
  subtotalPaise: z.coerce.number().int().min(0),
});

router.post(
  '/cart/validate',
  validate({ body: validateBody }),
  asyncHandler(async (req, res) => {
    res.json(await validateCart(req.body.items));
  })
);

router.post(
  '/cart/shipping-quote',
  validate({ body: shippingQuoteBody }),
  asyncHandler(async (req, res) => {
    const { pincode, subtotalPaise } = req.body;
    const quote = await calculateShipping(pincode, subtotalPaise);
    // No tax line anywhere: the shop is not GST registered.
    res.json({
      pincode,
      subtotalPaise,
      ...quote,
      totalPaise: subtotalPaise + quote.shippingPaise,
    });
  })
);

export default router;
