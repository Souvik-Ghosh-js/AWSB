import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler, ApiError } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { requireAdmin } from '../../middleware/auth.js';
import * as inventory from './inventory.service.js';
import { MOVEMENT_REASONS } from './helpers/inventory-math.js';

const router = Router();

const idParam = z.object({ id: z.coerce.number().int().positive() });

// Manual adjustment accepts EITHER a signed delta ('+12 arrived from the
// distiller') or an absolute target ('the shelf count says 40'). Both end up
// as a ledger row; the absolute form is converted to a delta first.
const stockBody = z
  .object({
    delta: z.number().int().optional(),
    stock_qty: z.number().int().nonnegative().optional(),
    reason: z.enum(MOVEMENT_REASONS).default('manual_adjustment'),
    note: z.string().max(255).optional(),
  })
  .refine(
    (b) => (b.delta === undefined) !== (b.stock_qty === undefined),
    { message: 'Send exactly one of delta (adjustment) or stock_qty (absolute count).' }
  );

router.patch(
  '/variants/:id/stock',
  requireAdmin('owner', 'manager', 'staff'),
  validate({ params: idParam, body: stockBody }),
  asyncHandler(async (req, res) => {
    const { delta, stock_qty: stockQty, reason, note } = req.body;

    const result =
      delta !== undefined
        ? await inventory.adjustStock({
            variantId: req.params.id,
            delta,
            reason,
            note: note ?? null,
            actorId: req.admin.id,
          })
        : await inventory.setStock({
            variantId: req.params.id,
            targetQty: stockQty,
            reason,
            note: note ?? null,
            actorId: req.admin.id,
          });

    res.json(result);
  })
);

router.get(
  '/inventory/low-stock',
  requireAdmin('owner', 'manager', 'staff'),
  validate({ query: z.object({ include_disabled: z.coerce.boolean().optional() }) }),
  asyncHandler(async (req, res) => {
    const data = await inventory.listLowStock({
      includeDisabled: req.query.include_disabled === true,
    });
    res.json({ data, total: data.length });
  })
);

router.get(
  '/inventory/movements',
  requireAdmin('owner', 'manager', 'staff'),
  validate({
    query: z.object({
      variant_id: z.coerce.number().int().positive().optional(),
      reason: z.enum(MOVEMENT_REASONS).optional(),
      page: z.coerce.number().int().positive().optional(),
      per_page: z.coerce.number().int().positive().max(200).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json(
      await inventory.listMovements({
        variantId: req.query.variant_id,
        reason: req.query.reason,
        page: req.query.page,
        perPage: req.query.per_page,
      })
    );
  })
);

export default router;
