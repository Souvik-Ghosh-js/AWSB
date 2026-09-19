import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { requireAdmin } from '../../middleware/auth.js';
import * as categories from './categories.service.js';

const router = Router();

const idParam = z.object({ id: z.coerce.number().int().positive() });

const createBody = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  sort_order: z.number().int().optional(),
});

const updateBody = createBody.partial();

router.get(
  '/categories',
  requireAdmin('owner', 'manager', 'staff'),
  asyncHandler(async (_req, res) => {
    res.json({ items: await categories.listCategories() });
  })
);

router.get(
  '/categories/:id',
  requireAdmin('owner', 'manager', 'staff'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await categories.getCategory(req.params.id));
  })
);

router.post(
  '/categories',
  requireAdmin('owner', 'manager'),
  validate({ body: createBody }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await categories.createCategory(req.body));
  })
);

router.patch(
  '/categories/:id',
  requireAdmin('owner', 'manager'),
  validate({ params: idParam, body: updateBody }),
  asyncHandler(async (req, res) => {
    res.json(await categories.updateCategory(req.params.id, req.body));
  })
);

router.delete(
  '/categories/:id',
  requireAdmin('owner', 'manager'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await categories.deleteCategory(req.params.id));
  })
);

export default router;
