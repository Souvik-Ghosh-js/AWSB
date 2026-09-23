import express from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/error.js';
import { validate, idParamSchema, paginationSchema } from '../../middleware/validate.js';
import { requireAdmin } from '../../middleware/auth.js';
import {
  listOrders, getOrderDetail, markPacked, shipOrder, markDelivered, cancelOrder, deleteOrder,
} from './orders.service.js';

export const adminOrdersRouter = express.Router();

adminOrdersRouter.use(requireAdmin('staff'));

adminOrdersRouter.get(
  '/',
  validate({
    query: paginationSchema.extend({
      status: z.enum(['pending_payment', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled', 'refunded']).optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      q: z.string().trim().max(80).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json(await listOrders(req.validatedQuery));
  })
);

adminOrdersRouter.get(
  '/:id',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    res.json(await getOrderDetail(req.params.id));
  })
);

adminOrdersRouter.post(
  '/:id/pack',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    res.json(await markPacked(req.params.id, req.admin.id));
  })
);

const shipSchema = z.object({
  courierId: z.coerce.number().int().positive(),
  trackingNumber: z.string().trim().min(5).max(80),
  scannedImageUrl: z.string().url().optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
  // Echoed back from the scan endpoint so we can record whether the admin
  // corrected the OCR suggestion.
  ocr: z
    .object({
      suggested: z.string().trim().max(80).optional().nullable(),
      confidence: z.coerce.number().min(0).max(1).optional().nullable(),
      rawText: z.string().max(10000).optional().nullable(),
    })
    .optional()
    .nullable(),
});

adminOrdersRouter.post(
  '/:id/ship',
  validate({ params: idParamSchema, body: shipSchema }),
  asyncHandler(async (req, res) => {
    res.json(
      await shipOrder({
        orderId: req.params.id,
        adminId: req.admin.id,
        ...req.body,
      })
    );
  })
);

adminOrdersRouter.post(
  '/:id/deliver',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    res.json(await markDelivered(req.params.id, req.admin.id));
  })
);

adminOrdersRouter.post(
  '/:id/cancel',
  requireAdmin('manager'), // staff cannot cancel a paid order
  validate({
    params: idParamSchema,
    body: z.object({ reason: z.string().trim().min(3).max(255) }),
  }),
  asyncHandler(async (req, res) => {
    res.json(
      await cancelOrder({
        orderId: req.params.id,
        reason: req.body.reason,
        adminId: req.admin.id,
      })
    );
  })
);

// Permanent, irreversible delete — owner only, stricter than cancel's
// manager gate. Only pending_payment or cancelled orders qualify; see
// deleteOrder's own guard for why.
adminOrdersRouter.delete(
  '/:id',
  requireAdmin('owner'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    res.json(await deleteOrder(req.params.id, req.admin.id));
  })
);
