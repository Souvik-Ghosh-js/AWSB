import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';

import { asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { createFeedback } from './feedback.service.js';

const router = Router();

// A public, unauthenticated write endpoint is the obvious spam target. The
// limit is per-IP and deliberately generous: a real customer writes once or
// twice, so 5 in 15 minutes never inconveniences anyone genuine.
const feedbackLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'You have sent several messages already. Please give us a little time to reply.',
    },
  },
});

const createBody = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(255),
  subject: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(5000),
  orderNumber: z.string().trim().max(20).optional(),
});

router.post(
  '/feedback',
  feedbackLimiter,
  validate({ body: createBody }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await createFeedback(req.body));
  })
);

export default router;
