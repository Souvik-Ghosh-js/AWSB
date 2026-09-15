import express from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { pool } from '../../db/pool.js';
import { ApiError, asyncHandler } from '../../middleware/error.js';
import { validate, emailSchema, pincodeSchema } from '../../middleware/validate.js';
import { requireAdmin } from '../../middleware/auth.js';
import { loginAdmin } from '../auth/auth.service.js';
import { calculateDiscount } from '../../utils/money.js';
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

/**
 * Mirrors the limiter in auth.routes.js, which is module-private there.
 *
 * It MUST be as strict as the original: an alias that skipped rate limiting
 * would hand an attacker an unthrottled password-guessing endpoint against the
 * same admin accounts. Same window, same ceiling.
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in a few minutes.' } },
});

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

// ---------------------------------------------------------------- coupons

/**
 * POST /coupons/validate — preview a coupon before paying.
 *
 * The storefront's "Apply" button at checkout calls this. It did not exist:
 * only the admin CRUD routes did, so entering any code returned a 404 and the
 * button could never succeed.
 *
 * This is a PREVIEW, never an authority. The binding discount is recalculated
 * inside createCheckoutSession() from the database when the order is actually
 * created, so a stale or tampered preview cannot change what anyone is charged.
 * The rules below are deliberately the same ones loadCoupon() applies there —
 * if they diverge, a shopper sees a discount here that vanishes at payment.
 *
 * Failure is reported as `valid: false` with a reason, NOT as an HTTP error:
 * the client renders `message` beside the field, and a 400 would surface as a
 * generic "something went wrong" instead of "this needs a minimum order of ₹X".
 */
router.post(
  '/coupons/validate',
  validate({
    body: z.object({
      code: z.string().trim().min(1).max(64),
      items: z
        .array(
          z.object({
            variantId: z.coerce.number().int().positive(),
            quantity: z.coerce.number().int().positive(),
          })
        )
        .min(1),
    }),
  }),
  asyncHandler(async (req, res) => {
    const code = String(req.body.code).toUpperCase().trim();

    const invalid = (message) =>
      res.json({
        code,
        description: null,
        discountType: 'percent',
        discountValue: 0,
        discountPaise: 0,
        valid: false,
        message,
      });

    const [[coupon]] = await pool.query(
      `SELECT * FROM coupons
        WHERE code = ? AND is_active = TRUE
          AND (starts_at IS NULL OR starts_at <= UTC_TIMESTAMP())
          AND (expires_at IS NULL OR expires_at >= UTC_TIMESTAMP())
        LIMIT 1`,
      [code]
    );

    if (!coupon) return invalid('That code is not valid.');

    // Price the cart from the DATABASE, not from what the client sent. A
    // client-supplied subtotal would let anyone clear a minimum-order rule by
    // lying about their cart.
    const variantIds = req.body.items.map((i) => i.variantId);
    const [rows] = await pool.query(
      `SELECT v.id, v.price_paise
         FROM product_variants v
         JOIN products p ON p.id = v.product_id
        WHERE v.id IN (?) AND v.is_enabled = TRUE AND p.is_active = TRUE`,
      [variantIds]
    );

    const priceById = new Map(rows.map((r) => [Number(r.id), Number(r.price_paise)]));
    let subtotalPaise = 0;
    for (const item of req.body.items) {
      const unit = priceById.get(Number(item.variantId));
      if (unit == null) continue; // A line that no longer exists simply does not count.
      subtotalPaise += unit * Number(item.quantity);
    }

    if (subtotalPaise < Number(coupon.min_order_paise)) {
      return invalid(
        `This coupon needs a minimum order of ₹${Number(coupon.min_order_paise) / 100}.`
      );
    }

    if (coupon.usage_limit != null && Number(coupon.used_count) >= Number(coupon.usage_limit)) {
      return invalid('This coupon has been fully used.');
    }

    const discountPaise = calculateDiscount(subtotalPaise, coupon);

    res.json({
      code: coupon.code,
      description: coupon.description ?? null,
      discountType: coupon.discount_type,
      discountValue: Number(coupon.discount_value),
      discountPaise,
      valid: discountPaise > 0,
      ...(discountPaise > 0 ? {} : { message: 'This code gives no discount on this order.' }),
    });
  })
);

// ---------------------------------------------------------------- admin aliases

/**
 * POST /admin/auth/login — sign in to the admin panel.
 *
 * The real implementation is POST /api/v1/auth/admin/login (auth.routes.js,
 * mounted at /api/v1/auth). The panel asks for /admin/auth/login, which is the
 * spelling that matches every OTHER admin endpoint it calls — /admin/auth/me,
 * /admin/dashboard, /admin/products — so the two segments were simply
 * transposed on one route out of eighteen.
 *
 * Without this alias the panel deploys, loads and renders, and then every sign
 * in fails with a 404 that never reaches a handler: the shop looks fine and
 * staff cannot get in. This is a thin alias to the same service function, not
 * a second credential path — authLimiter and the identical validation still
 * apply, so it is not a weaker way in.
 */
router.post(
  '/admin/auth/login',
  authLimiter,
  validate({ body: z.object({ email: emailSchema, password: z.string().min(1) }) }),
  asyncHandler(async (req, res) => {
    res.json(await loginAdmin(req.body));
  })
);

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
