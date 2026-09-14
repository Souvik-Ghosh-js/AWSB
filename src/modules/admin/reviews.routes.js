import { Router } from 'express';
import { z } from 'zod';

import { pool } from '../../db/pool.js';
import { asyncHandler, ApiError } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { requireAdmin } from '../../middleware/auth.js';

// Review moderation. Reviews land as 'pending' and only an approved one is
// ever shown on the storefront, so this queue is the gate between a customer
// writing something and it appearing under a product.

const router = Router();

const idParam = z.object({ id: z.coerce.number().int().positive() });

router.get(
  '/reviews',
  requireAdmin('owner', 'manager', 'staff'),
  validate({
    query: z.object({
      status: z.enum(['pending', 'approved', 'rejected']).optional(),
      product_id: z.coerce.number().int().positive().optional(),
      rating: z.coerce.number().int().min(1).max(5).optional(),
      verified_only: z.coerce.boolean().optional(),
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
      where.push('r.status = :status');
      params.status = req.query.status;
    }
    if (req.query.product_id) {
      where.push('r.product_id = :product_id');
      params.product_id = req.query.product_id;
    }
    if (req.query.rating) {
      where.push('r.rating = :rating');
      params.rating = req.query.rating;
    }
    if (req.query.verified_only === true) where.push('r.is_verified_purchase = TRUE');
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [data] = await pool.execute(
      `SELECT r.id, r.product_id, r.customer_id, r.order_id, r.rating, r.title, r.body,
              r.author_name, r.status, r.is_verified_purchase, r.created_at,
              p.name AS product_name, p.slug AS product_slug,
              o.order_number
         FROM reviews r
         JOIN products p ON p.id = r.product_id
         LEFT JOIN orders o ON o.id = r.order_id
         ${whereSql}
        ORDER BY FIELD(r.status, 'pending', 'approved', 'rejected'), r.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    const [[counts]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM reviews r ${whereSql}`,
      params
    );
    const [[pending]] = await pool.execute(
      "SELECT COUNT(*) AS n FROM reviews WHERE status = 'pending'"
    );

    res.json({
      data,
      page: Math.max(Number(req.query.page) || 1, 1),
      per_page: limit,
      total: Number(counts.total),
      pending_count: Number(pending.n),
    });
  })
);

router.patch(
  '/reviews/:id/status',
  requireAdmin('owner', 'manager'),
  validate({
    params: idParam,
    body: z.object({ status: z.enum(['pending', 'approved', 'rejected']) }),
  }),
  asyncHandler(async (req, res) => {
    const [result] = await pool.execute(
      'UPDATE reviews SET status = :status WHERE id = :id',
      { id: req.params.id, status: req.body.status }
    );
    if (result.affectedRows === 0) throw new ApiError(404, 'Review not found.');

    const [rows] = await pool.execute(
      `SELECT id, product_id, rating, title, body, author_name, status, is_verified_purchase, created_at
         FROM reviews WHERE id = :id`,
      { id: req.params.id }
    );
    res.json(rows[0]);
  })
);

router.delete(
  '/reviews/:id',
  requireAdmin('owner', 'manager'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const [result] = await pool.execute('DELETE FROM reviews WHERE id = :id', { id: req.params.id });
    if (result.affectedRows === 0) throw new ApiError(404, 'Review not found.');
    res.json({ id: String(req.params.id), deleted: true });
  })
);

export default router;
