// The order state machine, kept free of any DB or env import so it stays
// testable and reusable on its own. orders.service.js imports from here.

/**
 * Legal transitions. Orders are accepted automatically once paid; the admin
 * only moves them forward from there, or cancels.
 *
 * A shipped order deliberately cannot be cancelled — the parcel is already
 * with the courier, so cancelling would tell the customer something untrue.
 * That case is handled as a refund after the fact instead.
 */
export const ALLOWED_TRANSITIONS = {
  pending_payment: ['confirmed', 'cancelled'],
  confirmed: ['packed', 'cancelled'],
  packed: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
  refunded: [],
};

export function canTransition(from, to) {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Build a customer-facing tracking URL.
 *
 * Couriers that cannot be deep-linked (India Post, DTDC, Professional
 * Couriers, Trackon) store a plain landing page with no {TRACKING_NUMBER}
 * placeholder. Those are returned unchanged: the customer pastes the number
 * themselves. Fabricating a deep link for them would send the customer to an
 * empty form, which reads as a scam in a transactional email.
 */
export function buildTrackingUrl(template, trackingNumber) {
  if (!template) return null;
  if (!template.includes('{TRACKING_NUMBER}')) return template;
  return template.replace(/\{TRACKING_NUMBER\}/g, encodeURIComponent(trackingNumber));
}

/** Statuses an order can still be cancelled from. */
export function isCancellable(status) {
  return canTransition(status, 'cancelled');
}
