import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';

import { asyncHandler, ApiError } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { createReview, listReviewsForProduct } from './reviews.service.js';

const router = Router();

// No proof of purchase gates this anymore, so it is a public, unauthenticated
// write endpoint like feedback's — same per-IP limit for the same reason.
const reviewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'You have submitted several reviews already. Please try again later.',
    },
  },
});

const createBody = z.object({
  productSlug: z.string().trim().min(1).max(160),
  rating: z.coerce.number().int().min(1).max(5), // chk_rating enforces this too
  title: z.string().trim().max(160).optional(),
  body: z.string().trim().max(4000).optional(),
  authorName: z.string().trim().min(1).max(120).optional(),
});

const listParams = z.object({
  slug: z.string().trim().min(1).max(160),
});

const listQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(10),
});

router.post(
  '/reviews',
  reviewLimiter,
  validate({ body: createBody }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await createReview(req.body));
  })
);

router.get(
  '/products/:slug/reviews',
  validate({ params: listParams, query: listQuery }),
  asyncHandler(async (req, res) => {
    const result = await listReviewsForProduct(req.params.slug, req.query);
    if (!result) {
      throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'That fragrance is no longer available.');
    }
    res.json(result);
  })
);

export default router;
