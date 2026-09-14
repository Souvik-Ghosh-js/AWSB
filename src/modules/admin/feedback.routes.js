import { Router } from 'express';
import { z } from 'zod';

import { pool } from '../../db/pool.js';
import { asyncHandler, ApiError } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { requireAdmin } from '../../middleware/auth.js';

// General site feedback — the contact form — kept separate from product
// reviews because it is a conversation to answer, not content to publish.

const router = Router();

const idParam = z.object({ id: z.coerce.number().int().positive() });

router.get(
  '/feedback',
  requireAdmin('owner', 'manager', 'staff'),
  validate({
    query: z.object({
      status: z.enum(['new', 'read', 'responded', 'closed']).optional(),
      q: z.string().optional(),
      page: z.coerce.number().int().positive().optional(),
      per_page: z.coerce.number().int().positive().max(100).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.per_page) || 25, 100);
    const offset = (Math.max(Number(req.query.page) || 1, 1) - 1) * limit;

    const where = [];
    const params = {};
    if (req.query.status) {
      where.push('f.status = :status');
      params.status = req.query.status;
    }
    if (req.query.q) {
      where.push('(f.name LIKE :q OR f.email LIKE :q OR f.subject LIKE :q OR f.message LIKE :q)');
      params.q = `%${req.query.q}%`;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [data] = await pool.execute(
      `SELECT f.id, f.name, f.email, f.subject, f.message, f.order_id, f.status, f.created_at,
              o.order_number
         FROM feedback f
         LEFT JOIN orders o ON o.id = f.order_id
         ${whereSql}
        ORDER BY FIELD(f.status, 'new', 'read', 'responded', 'closed'), f.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    const [[counts]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM feedback f ${whereSql}`,
      params
    );
    const [[unread]] = await pool.execute(
      "SELECT COUNT(*) AS n FROM feedback WHERE status = 'new'"
    );

    res.json({
      data,
      page: Math.max(Number(req.query.page) || 1, 1),
      per_page: limit,
      total: Number(counts.total),
      new_count: Number(unread.n),
    });
  })
);

router.get(
  '/feedback/:id',
  requireAdmin('owner', 'manager', 'staff'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const [rows] = await pool.execute(
      `SELECT f.id, f.name, f.email, f.subject, f.message, f.order_id, f.status, f.created_at,
              o.order_number
         FROM feedback f
         LEFT JOIN orders o ON o.id = f.order_id
        WHERE f.id = :id LIMIT 1`,
      { id: req.params.id }
    );
    if (!rows[0]) throw new ApiError(404, 'Feedback not found.');
    res.json(rows[0]);
  })
);

router.patch(
  '/feedback/:id/status',
  requireAdmin('owner', 'manager', 'staff'),
  validate({
    params: idParam,
    body: z.object({ status: z.enum(['new', 'read', 'responded', 'closed']) }),
  }),
  asyncHandler(async (req, res) => {
    const [result] = await pool.execute(
      'UPDATE feedback SET status = :status WHERE id = :id',
      { id: req.params.id, status: req.body.status }
    );
    if (result.affectedRows === 0) throw new ApiError(404, 'Feedback not found.');
    res.json({ id: String(req.params.id), status: req.body.status });
  })
);

export default router;
