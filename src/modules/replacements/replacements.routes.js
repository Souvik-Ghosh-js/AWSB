import express from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';

import { asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { requireCustomer } from '../../middleware/auth.js';
import { requestReplacement, listMyReplacementRequests } from './replacements.service.js';

const router = express.Router();

// A handful of legitimate defects a day is normal; a burst of requests from
// one signed-in account is not, so this gets its own tight limit rather than
// the generous general one.
const replacementLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again in a few minutes.' } },
});

router.get(
  '/me/replacement-requests',
  requireCustomer,
  asyncHandler(async (req, res) => {
    res.json({ items: await listMyReplacementRequests(req.customer.id) });
  })
);

router.post(
  '/me/replacement-requests',
  requireCustomer,
  replacementLimiter,
  validate({
    body: z.object({
      orderItemId: z.coerce.number().int().positive(),
      reason: z.string().trim().min(20, 'Please describe the defect in a bit more detail.').max(2000),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await requestReplacement({
      customerId: req.customer.id,
      orderItemId: req.body.orderItemId,
      reason: req.body.reason,
    });
    res.status(201).json(result);
  })
);

export default router;
