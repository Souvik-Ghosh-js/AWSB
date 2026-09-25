import express from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error.js';
import { validate, paginationSchema } from '../../middleware/validate.js';
import { requireCustomer } from '../../middleware/auth.js';
import { getMe, listMyOrders, getMyOrderDetail } from './auth.service.js';

// Split out of auth.routes.js deliberately.
//
// /me and /me/orders belong at the bare /api/v1, while the credential routes
// belong under /api/v1/auth. Mounting one router at both prefixes exposed
// /api/v1/login and /api/v1/register as a second, unintended public surface —
// each with its own rate-limiter instance, which doubled the attempts an
// attacker gets. Two routers, one prefix each.

const router = express.Router();

router.get(
  '/me',
  requireCustomer,
  asyncHandler(async (req, res) => {
    res.json(await getMe(req.customer.id));
  })
);

router.get(
  '/me/orders',
  requireCustomer,
  validate({ query: paginationSchema }),
  asyncHandler(async (req, res) => {
    res.json(await listMyOrders(req.customer.id, req.validatedQuery));
  })
);

router.get(
  '/me/orders/:id',
  requireCustomer,
  validate({ params: z.object({ id: z.coerce.number().int().positive() }) }),
  asyncHandler(async (req, res) => {
    res.json(await getMyOrderDetail(req.customer.id, req.params.id));
  })
);

export default router;
