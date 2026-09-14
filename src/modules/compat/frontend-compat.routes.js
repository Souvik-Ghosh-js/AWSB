import express from 'express';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { ApiError, asyncHandler } from '../../middleware/error.js';
import { validate, pincodeSchema } from '../../middleware/validate.js';
import { requireAdmin } from '../../middleware/auth.js';
import { calculateShipping, resolveZone } from '../../services/shipping/zones.js';

// Endpoints the storefront calls that the original API surface did not define.
//
// The frontend was built against the documented contract and then needed a few
// things that contract left out — chiefly a GET shipping quote and pincode
// autofill, which checkout cannot work without. Rather than rewrite a verified,
// type-checked frontend to match names on this side, the API serves the names
// it asks for. Where a route here overlaps an existing one, this is a thin
// alias, never a second implementation.

const router = express.Router();

// ---------------------------------------------------------------- shipping

/**
 * GET /shipping/quote?pincode=700136&subtotal_paise=120000
 *
 * The frontend has a hardcoded ₹49/₹99 fallback for when this fails, but this
 * response is the authoritative one — rates and the Kolkata pincode range are
 * admin-editable, and a stale client constant must never decide what a
 * customer is charged.
 */
router.get(
  '/shipping/quote',
  validate({
    query: z.object({
      pincode: pincodeSchema,
      subtotal_paise: z.coerce.number().int().nonnegative().default(0),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { pincode, subtotal_paise: subtotalPaise } = req.validatedQuery;
    const quote = await calculateShipping(pincode, subtotalPaise);
    res.json({
      pincode,
      zoneSlug: quote.zoneSlug,
      zoneName: quote.zoneName,
      shippingPaise: quote.shippingPaise,
      isFree: quote.isFree,
      subtotalPaise,
      totalPaise: subtotalPaise + quote.shippingPaise,
    });
  })
);

/**
 * GET /shipping/pincode?pincode=700136
 *
 * Autofills city/district/state at checkout. There is no pincode table in this
 * schema, so this reports the serviceable zone and leaves the address fields
 * for the customer to type. Returning `serviceable` still catches the common
 * mistake of a wrong-state pincode before payment.
 */
router.get(
  '/shipping/pincode',
  validate({ query: z.object({ pincode: pincodeSchema }) }),
  asyncHandler(async (req, res) => {
    const { pincode } = req.validatedQuery;
    const zone = await resolveZone(pincode);

    // Kolkata pincodes are the one range we can name with confidence, because
    // the shop defined it. Everything else is left blank rather than guessed —
    // a wrong autofilled city is worse than an empty field the customer fills.
    const isKolkata = zone.slug === 'kolkata';

    res.json({
      pincode,
      serviceable: true,
      city: isKolkata ? 'Kolkata' : null,
      district: isKolkata ? 'Kolkata' : null,
      state: isKolkata ? 'West Bengal' : null,
      zoneSlug: zone.slug,
      zoneName: zone.name,
      shippingPaise: Number(zone.rate_paise),
    });
  })
);

// ---------------------------------------------------------------- admin aliases

/** GET /admin/auth/me — who the current admin token belongs to. */
router.get(
  '/admin/auth/me',
  requireAdmin('staff'),
  asyncHandler(async (req, res) => {
    res.json({
      id: req.admin.id,
      email: req.admin.email,
      fullName: req.admin.fullName,
      role: req.admin.role,
    });
  })
);

/** GET /admin/categories — the category picker in the product editor. */
router.get(
  '/admin/categories',
  requireAdmin('staff'),
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT c.id, c.slug, c.name, c.description, c.sort_order,
              (SELECT COUNT(*) FROM product_categories pc WHERE pc.category_id = c.id) AS product_count
         FROM categories c
        ORDER BY c.sort_order, c.name`
    );
    res.json({ items: rows });
  })
);

/**
 * PATCH /admin/settings/:key — update one setting.
 * The settings router only exposes a whole-object PUT; the admin UI edits
 * single keys.
 */
router.patch(
  '/admin/settings/:key',
  requireAdmin('manager'),
  validate({
    params: z.object({ key: z.string().trim().min(1).max(80) }),
    body: z.object({ value: z.unknown() }),
  }),
  asyncHandler(async (req, res) => {
    const { key } = req.params;
    const [result] = await pool.query(
      `INSERT INTO settings (key_name, value_json) VALUES (?, CAST(? AS JSON))
       ON DUPLICATE KEY UPDATE value_json = VALUES(value_json)`,
      [key, JSON.stringify(req.body.value)]
    );
    if (!result) throw ApiError.notFound('Setting not found.');
    res.json({ key, value: req.body.value });
  })
);

export default router;
