import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler, ApiError } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { listProducts, getProductBySlug, listCategories } from './catalog.service.js';
import { SORT_KEYS, DEFAULT_SORT, MAX_LIMIT, DEFAULT_LIMIT } from './catalog.pure.js';

const router = Router();

const listQuery = z.object({
  category: z.string().trim().min(1).max(120).optional(),
  search: z.string().trim().min(1).max(120).optional(),
  // Anything outside the whitelist is rejected at the edge with a 400 rather
  // than silently falling back, so a typo in the storefront is visible.
  sort: z.enum(SORT_KEYS).default(DEFAULT_SORT),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

const slugParams = z.object({
  slug: z.string().trim().min(1).max(160),
});

router.get(
  '/products',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const result = await listProducts(req.query);
    res.json(result);
  })
);

router.get(
  '/products/:slug',
  validate({ params: slugParams }),
  asyncHandler(async (req, res) => {
    const product = await getProductBySlug(req.params.slug);
    if (!product) {
      throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'That fragrance is no longer available.');
    }
    res.json(product);
  })
);

router.get(
  '/categories',
  asyncHandler(async (_req, res) => {
    res.json({ items: await listCategories() });
  })
);

export default router;
