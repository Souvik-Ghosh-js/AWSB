import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { requireAdmin } from '../../middleware/auth.js';
import * as shipping from './shipping.service.js';

const router = Router();

const idParam = z.object({ id: z.coerce.number().int().positive() });

const pincodeRange = z.object({
  pincode_start: z.string().trim().length(6),
  pincode_end: z.string().trim().length(6),
});

const createBody = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().max(40).optional(),
  rate_paise: z.number().int().nonnegative(),
  free_above_paise: z.number().int().positive().nullable().optional(),
  is_fallback: z.boolean().optional(),
  is_active: z.boolean().optional(),
  sort_order: z.number().int().optional(),
  pincode_ranges: z.array(pincodeRange).max(50).optional(),
});

const updateBody = createBody.partial();

router.get(
  '/shipping/zones',
  requireAdmin('owner', 'manager', 'staff'),
  asyncHandler(async (_req, res) => {
    res.json({ items: await shipping.listZones() });
  })
);

router.get(
  '/shipping/zones/:id',
  requireAdmin('owner', 'manager', 'staff'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await shipping.getZone(req.params.id));
  })
);

router.post(
  '/shipping/zones',
  requireAdmin('owner', 'manager'),
  validate({ body: createBody }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await shipping.createZone(req.body));
  })
);

router.patch(
  '/shipping/zones/:id',
  requireAdmin('owner', 'manager'),
  validate({ params: idParam, body: updateBody }),
  asyncHandler(async (req, res) => {
    res.json(await shipping.updateZone(req.params.id, req.body));
  })
);

router.delete(
  '/shipping/zones/:id',
  requireAdmin('owner', 'manager'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await shipping.deleteZone(req.params.id));
  })
);

export default router;
