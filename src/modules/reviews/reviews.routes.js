import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler, ApiError } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { createReview, listReviewsForProduct } from './reviews.service.js';

const router = Router();

const createBody = z.object({
  orderNumber: z.string().trim().min(1).max(20),
  email: z.string().trim().email().max(255),
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
