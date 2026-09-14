import { pool } from '../../db/pool.js';
import { ApiError } from '../../middleware/error.js';
import {
  normaliseCode,
  validateCouponInput,
  isDuplicateCodeError,
  duplicateCodeMessage,
} from './helpers/coupon-rules.js';

// Coupons. Codes are stored UPPERCASE so the UNIQUE index actually prevents
// 'DIWALI10' and 'diwali10' coexisting, and the storefront can look one up
// without a case-insensitive scan.

const FIELDS = `
  id, code, description, discount_type, discount_value, max_discount_paise,
  min_order_paise, usage_limit, usage_limit_per_customer, used_count,
  starts_at, expires_at, is_active, created_at
`;

export async function listCoupons({ q, active, page = 1, perPage = 20 } = {}) {
  const limit = Math.min(Math.max(Number(perPage) || 20, 1), 100);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

  const where = [];
  const params = {};
  if (q) {
    where.push('(code LIKE :q OR description LIKE :q)');
    params.q = `%${String(q).toUpperCase()}%`;
  }
  if (active !== undefined) {
    where.push('is_active = :active');
    params.active = active;
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [rows] = await pool.execute(
    `SELECT ${FIELDS} FROM coupons ${whereSql}
      ORDER BY is_active DESC, created_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  const [[{ total }]] = await pool.execute(
    `SELECT COUNT(*) AS total FROM coupons ${whereSql}`,
    params
  );

  return { data: rows, page: Number(page) || 1, per_page: limit, total: Number(total) };
}

export async function getCoupon(id) {
  const [rows] = await pool.execute(`SELECT ${FIELDS} FROM coupons WHERE id = :id LIMIT 1`, { id });
  if (!rows[0]) throw new ApiError(404, 'Coupon not found.');

  // Redemption history answers 'is this campaign working?' without a join in
  // every list query.
  const [[stats]] = await pool.execute(
    `SELECT COUNT(*) AS redemptions, COALESCE(SUM(amount_paise), 0) AS total_discount_paise
       FROM coupon_redemptions WHERE coupon_id = :id`,
    { id }
  );

  return {
    ...rows[0],
    redemptions: Number(stats.redemptions),
    total_discount_paise: Number(stats.total_discount_paise),
  };
}

function assertValid(input) {
  const { ok, errors } = validateCouponInput(input);
  if (!ok) throw new ApiError(422, errors.join(' '), { errors });
}

export async function createCoupon(input) {
  assertValid(input);
  const code = normaliseCode(input.code);

  try {
    const [result] = await pool.execute(
      `INSERT INTO coupons
         (code, description, discount_type, discount_value, max_discount_paise,
          min_order_paise, usage_limit, usage_limit_per_customer, starts_at, expires_at, is_active)
       VALUES
         (:code, :description, :discount_type, :discount_value, :max_discount_paise,
          :min_order_paise, :usage_limit, :usage_limit_per_customer, :starts_at, :expires_at, :is_active)`,
      {
        code,
        description: input.description ?? null,
        discount_type: input.discount_type,
        discount_value: input.discount_value,
        max_discount_paise: input.max_discount_paise ?? null,
        min_order_paise: input.min_order_paise ?? 0,
        usage_limit: input.usage_limit ?? null,
        usage_limit_per_customer: input.usage_limit_per_customer ?? null,
        starts_at: input.starts_at ?? null,
        expires_at: input.expires_at ?? null,
        is_active: input.is_active ?? true,
      }
    );
    return getCoupon(String(result.insertId));
  } catch (err) {
    if (isDuplicateCodeError(err)) throw new ApiError(409, duplicateCodeMessage(code));
    throw err;
  }
}

export async function updateCoupon(id, input) {
  const [existingRows] = await pool.execute(`SELECT ${FIELDS} FROM coupons WHERE id = :id LIMIT 1`, { id });
  const existing = existingRows[0];
  if (!existing) throw new ApiError(404, 'Coupon not found.');

  // Validate the MERGED coupon: changing discount_type alone can invalidate a
  // cap that was fine before, and a partial payload would hide that.
  const merged = { ...existing, ...input };
  assertValid(merged);

  const fields = [
    'description', 'discount_type', 'discount_value', 'max_discount_paise',
    'min_order_paise', 'usage_limit', 'usage_limit_per_customer',
    'starts_at', 'expires_at', 'is_active',
  ];
  const sets = [];
  const params = { id };
  for (const key of fields) {
    if (input[key] !== undefined) {
      sets.push(`${key} = :${key}`);
      params[key] = input[key];
    }
  }
  if (input.code !== undefined) {
    sets.push('code = :code');
    params.code = normaliseCode(input.code);
  }
  if (sets.length === 0) return getCoupon(id);

  try {
    await pool.execute(`UPDATE coupons SET ${sets.join(', ')} WHERE id = :id`, params);
  } catch (err) {
    if (isDuplicateCodeError(err)) throw new ApiError(409, duplicateCodeMessage(input.code));
    throw err;
  }

  return getCoupon(id);
}

/**
 * Coupons that have been redeemed are deactivated rather than deleted:
 * coupon_redemptions and orders.coupon_id reference them, and an order must
 * still be able to explain the discount it was given.
 */
export async function deleteCoupon(id) {
  const [[stats]] = await pool.execute(
    'SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = :id',
    { id }
  );

  if (Number(stats.n) > 0) {
    const [result] = await pool.execute(
      'UPDATE coupons SET is_active = FALSE WHERE id = :id',
      { id }
    );
    if (result.affectedRows === 0) throw new ApiError(404, 'Coupon not found.');
    return {
      id: String(id),
      deleted: false,
      deactivated: true,
      message: 'This coupon has been used on real orders, so it was deactivated rather than deleted.',
    };
  }

  const [result] = await pool.execute('DELETE FROM coupons WHERE id = :id', { id });
  if (result.affectedRows === 0) throw new ApiError(404, 'Coupon not found.');
  return { id: String(id), deleted: true };
}
