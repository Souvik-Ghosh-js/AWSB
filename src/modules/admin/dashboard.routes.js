import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { requireAdmin } from '../../middleware/auth.js';
import * as dashboard from './dashboard.service.js';

const router = Router();

router.get(
  '/dashboard',
  requireAdmin('owner', 'manager', 'staff'),
  asyncHandler(async (_req, res) => {
    res.json(await dashboard.getDashboard());
  })
);

// Accounting export. Not a GST return — the shop is not registered — so the
// file carries no tax, GSTIN or HSN columns.
router.get(
  '/reports/sales.csv',
  requireAdmin('owner', 'manager'),
  validate({
    query: z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { from, to } = req.query;
    const stamp = [from ?? 'all', to ?? 'todate'].join('_');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="awsb-sales-${stamp}.csv"`);
    // Excel on Windows assumes the system codepage without a BOM, which
    // mangles the rupee sign and any Bengali text in a customer's name.
    res.write('﻿');

    await dashboard.streamSalesCsv({ from, to }, res);
    res.end();
  })
);

export default router;
