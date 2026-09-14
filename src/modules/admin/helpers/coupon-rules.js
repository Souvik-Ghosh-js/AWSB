// Coupon validation rules, kept pure so they can be unit-tested and also
// reused by the storefront's coupon preview without dragging in the pool.

/** Codes are stored UPPERCASE; the schema's UNIQUE index depends on it. */
export function normaliseCode(code) {
  return String(code ?? '').trim().toUpperCase();
}

/**
 * Validate a coupon payload before it reaches the database.
 * Returns { ok, errors: string[] } — the caller turns errors into a 422.
 *
 * The rules that actually bite in practice:
 *  - A percent discount without a cap can hand away an unbounded amount on a
 *    large order, so max_discount_paise is required and must be positive.
 *  - A percent value above 100 is always a typo (someone meaning paise).
 *  - expires_at before starts_at creates a coupon that can never be used.
 */
export function validateCouponInput(input = {}) {
  const errors = [];
  const {
    code,
    discount_type: discountType,
    discount_value: discountValue,
    max_discount_paise: maxDiscountPaise,
    min_order_paise: minOrderPaise,
    starts_at: startsAt,
    expires_at: expiresAt,
    usage_limit: usageLimit,
    usage_limit_per_customer: usageLimitPerCustomer,
  } = input;

  const normalised = normaliseCode(code);
  if (!normalised) {
    errors.push('Code is required.');
  } else if (!/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(normalised)) {
    errors.push('Code must be 2-40 characters: letters, digits, hyphen or underscore.');
  }

  if (discountType !== 'percent' && discountType !== 'fixed') {
    errors.push("Discount type must be 'percent' or 'fixed'.");
  }

  const value = Number(discountValue);
  if (!Number.isInteger(value) || value <= 0) {
    errors.push('Discount value must be a positive integer.');
  }

  if (discountType === 'percent') {
    if (Number.isInteger(value) && value > 100) {
      errors.push('A percent discount cannot exceed 100.');
    }
    // A percent coupon with no ceiling is an open-ended liability.
    if (maxDiscountPaise == null) {
      errors.push('A percent discount needs a max_discount_paise cap.');
    } else if (!Number.isInteger(Number(maxDiscountPaise)) || Number(maxDiscountPaise) <= 0) {
      errors.push('max_discount_paise must be a positive integer number of paise.');
    }
  }

  if (discountType === 'fixed' && maxDiscountPaise != null) {
    errors.push('max_discount_paise only applies to percent discounts.');
  }

  if (minOrderPaise != null) {
    const min = Number(minOrderPaise);
    if (!Number.isInteger(min) || min < 0) {
      errors.push('min_order_paise must be a non-negative integer.');
    } else if (discountType === 'fixed' && Number.isInteger(value) && value > 0 && min > 0 && value > min) {
      errors.push('A fixed discount larger than the minimum order value would zero out the order.');
    }
  }

  for (const [label, limit] of [
    ['usage_limit', usageLimit],
    ['usage_limit_per_customer', usageLimitPerCustomer],
  ]) {
    if (limit != null && (!Number.isInteger(Number(limit)) || Number(limit) <= 0)) {
      errors.push(`${label} must be a positive integer when set.`);
    }
  }

  if (startsAt && expiresAt) {
    const start = new Date(startsAt).getTime();
    const end = new Date(expiresAt).getTime();
    if (Number.isNaN(start)) errors.push('starts_at is not a valid date.');
    if (Number.isNaN(end)) errors.push('expires_at is not a valid date.');
    if (!Number.isNaN(start) && !Number.isNaN(end) && end <= start) {
      errors.push('expires_at must be after starts_at.');
    }
  }

  return { ok: errors.length === 0, errors };
}

/** MySQL reports a duplicate code as ER_DUP_ENTRY; turn it into plain English. */
export function isDuplicateCodeError(err) {
  return err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062;
}

export function duplicateCodeMessage(code) {
  return `The coupon code ${normaliseCode(code)} already exists. Pick a different code.`;
}
