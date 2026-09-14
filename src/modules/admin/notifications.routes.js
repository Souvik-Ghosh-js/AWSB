import { Router } from 'express';
import { z } from 'zod';

import { pool } from '../../db/pool.js';
import { asyncHandler, ApiError } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { requireAdmin } from '../../middleware/auth.js';

// The admin bell: new order, low stock, payment failed.
//
// Notifications are shop-wide rather than per-admin — the schema has no
// recipient column — so 'read' means somebody in the shop has dealt with it.
// With an owner and one or two staff that is the behaviour you want; it would
// need a join table before it worked for a larger team.

const router = Router();

const anyAdmin = requireAdmin('owner', 'manager', 'staff');

router.get(
  '/notifications',
  anyAdmin,
  validate({
    query: z.object({
      unread_only: z.coerce.boolean().optional(),
      type: z.string().max(60).optional(),
      page: z.coerce.number().int().positive().optional(),
      per_page: z.coerce.number().int().positive().max(100).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.per_page) || 25, 100);
    const offset = (Math.max(Number(req.query.page) || 1, 1) - 1) * limit;

    const where = [];
    const params = {};
    if (req.query.unread_only === true) where.push('is_read = FALSE');
    if (req.query.type) {
      where.push('type = :type');
      params.type = req.query.type;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [data] = await pool.execute(
      `SELECT id, type, title, body, entity_type, entity_id, is_read, created_at
         FROM notifications
         ${whereSql}
        ORDER BY is_read ASC, created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    const [[counts]] = await pool.execute(
      `SELECT COUNT(*) AS total, SUM(is_read = FALSE) AS unread FROM notifications ${whereSql}`,
      params
    );

    res.json({
      data,
      page: Math.max(Number(req.query.page) || 1, 1),
      per_page: limit,
      total: Number(counts.total),
      unread: Number(counts.unread ?? 0),
    });
  })
);

router.post(
  '/notifications/:id/read',
  anyAdmin,
  validate({ params: z.object({ id: z.coerce.number().int().positive() }) }),
  asyncHandler(async (req, res) => {
    const [result] = await pool.execute(
      'UPDATE notifications SET is_read = TRUE WHERE id = :id',
      { id: req.params.id }
    );
    if (result.affectedRows === 0) throw new ApiError(404, 'Notification not found.');
    res.json({ id: String(req.params.id), is_read: true });
  })
);

router.post(
  '/notifications/read-all',
  anyAdmin,
  asyncHandler(async (_req, res) => {
    const [result] = await pool.execute(
      'UPDATE notifications SET is_read = TRUE WHERE is_read = FALSE'
    );
    res.json({ marked_read: result.affectedRows });
  })
);

export default router;
