// Stock arithmetic and the low-stock predicate.
//
// Pure by design: the ledger invariant (balance_after must equal the stock
// level AFTER applying delta) is the thing most worth unit-testing, and it
// must not require a database to verify.

/** Reasons the schema's inventory_movements.reason ENUM accepts. */
export const MOVEMENT_REASONS = [
  'sale',
  'restock',
  'cancellation',
  'refund',
  'manual_adjustment',
  'damage',
  'reservation_release',
];

/**
 * The balance a movement must record.
 * delta is signed: +50 restock, -2 damage. Works identically either way.
 */
export function balanceAfter(currentStock, delta) {
  return Number(currentStock) + Number(delta);
}

/**
 * Would this adjustment drive stock negative?
 * product_variants has CHECK (stock_qty >= 0), so the database would reject it
 * anyway — catching it here turns a raw constraint error into a clear message.
 */
export function wouldGoNegative(currentStock, delta) {
  return balanceAfter(currentStock, delta) < 0;
}

/**
 * Derive the delta when the admin types an absolute target quantity rather
 * than an adjustment ('set stock to 40' vs '+15').
 */
export function deltaForTarget(currentStock, targetQty) {
  return Number(targetQty) - Number(currentStock);
}

/**
 * Low-stock predicate, matching the SQL in inventory.service.js exactly:
 *   stock_qty <= low_stock_threshold
 * Kept here so the boundary (equal counts as low) is pinned by a test.
 */
export function isLowStock(variant) {
  if (!variant) return false;
  const qty = Number(variant.stock_qty);
  const threshold = Number(variant.low_stock_threshold);
  if (!Number.isFinite(qty) || !Number.isFinite(threshold)) return false;
  return qty <= threshold;
}
