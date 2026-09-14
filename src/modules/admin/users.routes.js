import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { requireAdmin } from '../../middleware/auth.js';
import * as users from './users.service.js';

const router = Router();

const idParam = z.object({ id: z.coerce.number().int().positive() });

// Managing other admins is an owner-only power. A manager who could create
// owners could promote themselves, which makes the role boundary decorative.
const ownerOnly = requireAdmin('owner');

const password = z.string().min(12, 'Use at least 12 characters.').max(200);

router.get(
  '/users',
  ownerOnly,
  validate({ query: z.object({ include_inactive: z.coerce.boolean().optional() }) }),
  asyncHandler(async (req, res) => {
    const data = await users.listUsers({ includeInactive: req.query.include_inactive !== false });
    res.json({ data, total: data.length });
  })
);

router.get(
  '/users/:id',
  ownerOnly,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await users.getUser(req.params.id));
  })
);

router.post(
  '/users',
  ownerOnly,
  validate({
    body: z.object({
      email: z.string().email().max(255),
      full_name: z.string().min(1).max(160),
      password,
      role: z.enum(['owner', 'manager', 'staff']).optional(),
      is_active: z.boolean().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await users.createUser(req.body));
  })
);

router.patch(
  '/users/:id',
  ownerOnly,
  validate({
    params: idParam,
    body: z.object({
      email: z.string().email().max(255).optional(),
      full_name: z.string().min(1).max(160).optional(),
      password: password.optional(),
      role: z.enum(['owner', 'manager', 'staff']).optional(),
      is_active: z.boolean().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json(await users.updateUser(req.params.id, req.body));
  })
);

router.delete(
  '/users/:id',
  ownerOnly,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await users.deleteUser(req.params.id, { actorId: req.admin.id }));
  })
);

export default router;
