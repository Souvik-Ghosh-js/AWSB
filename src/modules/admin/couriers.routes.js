import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { requireAdmin } from '../../middleware/auth.js';
import * as couriers from './couriers.service.js';

const router = Router();

const idParam = z.object({ id: z.coerce.number().int().positive() });

const courierBody = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().max(60).optional(),
  // Contains {TRACKING_NUMBER}, substituted when the shipping email is sent.
  tracking_url_template: z.string().max(512).nullable().optional(),
  // FALSE for couriers that cannot be deep-linked at all (India Post, DTDC,
  // TPC, Trackon) — see docs/02-couriers.md.
  supports_deep_link: z.boolean().optional(),
  awb_pattern: z.string().max(160).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  is_active: z.boolean().optional(),
  sort_order: z.number().int().optional(),
});

router.get(
  '/couriers',
  requireAdmin('owner', 'manager', 'staff'),
  validate({ query: z.object({ active_only: z.coerce.boolean().optional() }) }),
  asyncHandler(async (req, res) => {
    const data = await couriers.listCouriers({ activeOnly: req.query.active_only === true });
    res.json({ data, total: data.length });
  })
);

router.get(
  '/couriers/:id',
  requireAdmin('owner', 'manager', 'staff'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await couriers.getCourier(req.params.id));
  })
);

// A missing {TRACKING_NUMBER} placeholder comes back in `warnings`, not as a
// rejection: the admin may be pasting the URL in two steps, and losing their
// edit is worse than a template they can see is flagged.
router.post(
  '/couriers',
  requireAdmin('owner', 'manager'),
  validate({ body: courierBody }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await couriers.createCourier(req.body));
  })
);

router.patch(
  '/couriers/:id',
  requireAdmin('owner', 'manager'),
  validate({ params: idParam, body: courierBody.partial() }),
  asyncHandler(async (req, res) => {
    res.json(await couriers.updateCourier(req.params.id, req.body));
  })
);

router.delete(
  '/couriers/:id',
  requireAdmin('owner', 'manager'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await couriers.deleteCourier(req.params.id));
  })
);

export default router;
