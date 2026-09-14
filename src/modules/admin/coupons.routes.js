import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { requireAdmin } from '../../middleware/auth.js';
import * as coupons from './coupons.service.js';

const router = Router();

const idParam = z.object({ id: z.coerce.number().int().positive() });

// Deep validation (percent caps, date ordering) lives in helpers/coupon-rules.js
// so the same rules apply however a coupon is created. Zod here only enforces
// shapes and types.
const couponBody = z.object({
  code: z.string().min(2).max(40),
  description: z.string().max(255).nullable().optional(),
  discount_type: z.enum(['percent', 'fixed']),
  discount_value: z.number().int().positive(),
  max_discount_paise: z.number().int().positive().nullable().optional(),
  min_order_paise: z.number().int().nonnegative().optional(),
  usage_limit: z.number().int().positive().nullable().optional(),
  usage_limit_per_customer: z.number().int().positive().nullable().optional(),
  starts_at: z.string().datetime().nullable().optional(),
  expires_at: z.string().datetime().nullable().optional(),
  is_active: z.boolean().optional(),
});

router.get(
  '/coupons',
  requireAdmin('owner', 'manager', 'staff'),
  validate({
    query: z.object({
      q: z.string().optional(),
      active: z.coerce.boolean().optional(),
      page: z.coerce.number().int().positive().optional(),
      per_page: z.coerce.number().int().positive().max(100).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json(
      await coupons.listCoupons({
        q: req.query.q,
        active: req.query.active,
        page: req.query.page,
        perPage: req.query.per_page,
      })
    );
  })
);

router.get(
  '/coupons/:id',
  requireAdmin('owner', 'manager', 'staff'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await coupons.getCoupon(req.params.id));
  })
);

router.post(
  '/coupons',
  requireAdmin('owner', 'manager'),
  validate({ body: couponBody }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await coupons.createCoupon(req.body));
  })
);

router.patch(
  '/coupons/:id',
  requireAdmin('owner', 'manager'),
  validate({ params: idParam, body: couponBody.partial() }),
  asyncHandler(async (req, res) => {
    res.json(await coupons.updateCoupon(req.params.id, req.body));
  })
);

router.delete(
  '/coupons/:id',
  requireAdmin('owner', 'manager'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await coupons.deleteCoupon(req.params.id));
  })
);

export default router;
