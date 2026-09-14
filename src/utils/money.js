// All money in this system is an integer number of paise. Never a float:
// 0.1 + 0.2 !== 0.3, and a fragrance shop should not lose a rupee to binary
// floating point. Razorpay also expects paise as an integer.

/** ₹450.50 -> 45050 */
export function rupeesToPaise(rupees) {
  return Math.round(Number(rupees) * 100);
}

/** 45050 -> 450.5 */
export function paiseToRupees(paise) {
  return Number(paise) / 100;
}

/** 45050 -> "₹450.50" */
export function formatPaise(paise, { symbol = '₹' } = {}) {
  const n = Number(paise);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}${symbol}${groupIndian(whole)}.${frac}`;
}

/**
 * Indian digit grouping: 1234567 -> "12,34,567".
 * Intl.NumberFormat('en-IN') does this too, but it is not guaranteed to be
 * available with full ICU on a minimal Node build, and this is used in emails
 * rendered server-side.
 */
export function groupIndian(n) {
  const s = String(n);
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

/**
 * Apply a coupon to a subtotal, in paise. Returns the discount, never the
 * total, so the caller decides how it interacts with shipping.
 * Percent discounts honour max_discount_paise; nothing exceeds the subtotal.
 */
export function calculateDiscount(subtotalPaise, coupon) {
  if (!coupon) return 0;

  let discount;
  if (coupon.discount_type === 'percent') {
    discount = Math.floor((subtotalPaise * Number(coupon.discount_value)) / 100);
    if (coupon.max_discount_paise != null) {
      discount = Math.min(discount, Number(coupon.max_discount_paise));
    }
  } else {
    discount = Number(coupon.discount_value);
  }

  // A discount must never exceed the subtotal, or the order total goes
  // negative and Razorpay rejects it.
  return Math.max(0, Math.min(discount, subtotalPaise));
}
