import { Router } from 'express';
import { z } from 'zod';

import { pool } from '../../db/pool.js';
import { asyncHandler, ApiError } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { requireAdmin } from '../../middleware/auth.js';
import { sendMail } from '../../services/mail/mailer.js';

// Replacement request moderation. Mirrors /admin/reviews: a request lands
// 'pending' and only an admin decision moves it to 'approved'/'rejected'.
// Approving here does NOT create a replacement order or touch stock — that is
// deliberately manual for now, same as how a cancel-order refund can need a
// human follow-up. The evidence (photos/video of the defect) arrives by
// email, quoting the request number, and is reviewed outside this system;
// there is no attempt here to verify it was received.

const router = Router();

const idParam = z.object({ id: z.coerce.number().int().positive() });

router.get(
  '/replacement-requests',
  requireAdmin('owner', 'manager', 'staff'),
  validate({
    query: z.object({
      status: z.enum(['pending', 'approved', 'rejected']).optional(),
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
      where.push('rr.status = :status');
      params.status = req.query.status;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [data] = await pool.execute(
      `SELECT rr.id, rr.order_id, rr.order_item_id, rr.customer_id, rr.reason, rr.status,
              rr.admin_note, rr.decided_at, rr.created_at,
              o.order_number, o.ship_email, o.ship_full_name,
              oi.product_name, oi.sku, oi.quantity
         FROM replacement_requests rr
         JOIN orders o ON o.id = rr.order_id
         JOIN order_items oi ON oi.id = rr.order_item_id
         ${whereSql}
        ORDER BY FIELD(rr.status, 'pending', 'approved', 'rejected'), rr.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    const [[counts]] = await pool.execute(
      `SELECT COUNT(*) AS total FROM replacement_requests rr ${whereSql}`,
      params
    );
    const [[pending]] = await pool.execute(
      "SELECT COUNT(*) AS n FROM replacement_requests WHERE status = 'pending'"
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
  '/replacement-requests/:id/status',
  requireAdmin('owner', 'manager'),
  validate({
    params: idParam,
    body: z.object({
      status: z.enum(['approved', 'rejected']),
      admin_note: z.string().trim().max(2000).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const [[existing]] = await pool.execute(
      `SELECT rr.*, o.order_number, o.ship_email, oi.product_name
         FROM replacement_requests rr
         JOIN orders o ON o.id = rr.order_id
         JOIN order_items oi ON oi.id = rr.order_item_id
        WHERE rr.id = :id`,
      { id: req.params.id }
    );
    if (!existing) throw ApiError.notFound('Replacement request not found.');
    if (existing.status !== 'pending') {
      throw ApiError.conflict('This request has already been decided.', 'ALREADY_DECIDED');
    }

    await pool.execute(
      `UPDATE replacement_requests
          SET status = :status, admin_note = :admin_note, decided_by = :decided_by, decided_at = UTC_TIMESTAMP()
        WHERE id = :id`,
      {
        id: req.params.id,
        status: req.body.status,
        admin_note: req.body.admin_note ?? null,
        decided_by: req.admin.id,
      }
    );

    await pool.execute(
      `INSERT INTO audit_log (actor_id, actor_email, action, entity_type, entity_id, before_json, after_json)
       VALUES (:actor_id, :actor_email, 'replacement.decided', 'order', :order_id, :before, :after)`,
      {
        actor_id: req.admin.id,
        actor_email: req.admin.email,
        order_id: existing.order_id,
        before: JSON.stringify({ status: existing.status }),
        after: JSON.stringify({ status: req.body.status, admin_note: req.body.admin_note ?? null }),
      }
    );

    const requestNumber = `RR-${existing.id}`;
    await sendMail({
      to: existing.ship_email,
      template: 'replacementDecided',
      subject: `Your replacement request ${requestNumber} — ${req.body.status}`,
      data: {
        args: [
          {
            requestNumber,
            orderNumber: existing.order_number,
            productName: existing.product_name,
            status: req.body.status,
            adminNote: req.body.admin_note ?? null,
          },
        ],
      },
      orderId: existing.order_id,
    });

    const [rows] = await pool.execute(
      `SELECT id, order_id, order_item_id, customer_id, reason, status, admin_note, decided_at, created_at
         FROM replacement_requests WHERE id = :id`,
      { id: req.params.id }
    );
    res.json(rows[0]);
  })
);

export default router;
