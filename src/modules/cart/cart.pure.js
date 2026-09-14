// Pure cart maths: re-pricing, stock reconciliation, line totals.
//
// No pool, no env — see catalog.pure.js for the reasoning. The cart is where a
// pricing mistake costs real money, so this logic is kept isolated and tested.

/** Quantity ceiling per line. Blunt anti-abuse guard for a small attar shop. */
export const MAX_QUANTITY_PER_LINE = 20;

export const ISSUE = Object.freeze({
  UNAVAILABLE: 'unavailable',
  OUT_OF_STOCK: 'out_of_stock',
  QUANTITY_REDUCED: 'quantity_reduced',
});

/**
 * Re-price one cart line against the authoritative variant row.
 *
 * The client sends ONLY {variantId, quantity}. Every rupee here comes from the
 * database row. A client-supplied price is never read, because a cart posted
 * from a browser is attacker-controlled input: trusting it is how a shop sells
 * 12ml attar for ₹1.
 *
 * Problems are reported as `issues`, never thrown — a cart with one sold-out
 * size should render with that line flagged, not fail wholesale and lose the
 * shopper's other four items.
 *
 * @param {{variantId: number|string, quantity: number}} requested
 * @param {object|undefined} row variant joined to its product, or undefined
 */
export function priceLine(requested, row) {
  const issues = [];
  const requestedQty = clampQuantity(requested?.quantity);

  // Missing row = variant id that does not exist, or whose product is not
  // publicly visible (draft/archived/soft-deleted). Same outcome either way:
  // it cannot be bought, and we must not leak which case it was.
  if (!row || !isPurchasable(row)) {
    return {
      variantId: toId(requested?.variantId),
      productName: row?.product_name ?? null,
      sizeMl: row ? Number(row.size_ml) : null,
      sku: row?.sku ?? null,
      unitPricePaise: 0,
      quantity: 0,
      lineTotalPaise: 0,
      availableQty: 0,
      issues: [ISSUE.UNAVAILABLE],
    };
  }

  const availableQty = Math.max(0, Number(row.stock_qty ?? 0));
  const unitPricePaise = Number(row.price_paise);

  let quantity = requestedQty;
  if (availableQty === 0) {
    quantity = 0;
    issues.push(ISSUE.OUT_OF_STOCK);
  } else if (requestedQty > availableQty) {
    // Reduce to what is actually on the shelf rather than rejecting. The
    // shopper sees "only 2 left" and can still check out with 2.
    quantity = availableQty;
    issues.push(ISSUE.QUANTITY_REDUCED);
  }

  return {
    variantId: toId(row.id),
    productName: row.product_name,
    sizeMl: Number(row.size_ml),
    sku: row.sku,
    unitPricePaise,
    quantity,
    // Integer paise throughout: an integer times an integer stays exact, so
    // there is no rounding step here and no float to drift.
    lineTotalPaise: unitPricePaise * quantity,
    availableQty,
    issues,
  };
}

/** A variant is buyable only if enabled and its product is active and alive. */
function isPurchasable(row) {
  return Boolean(row.is_enabled) && row.product_status === 'active' && row.product_deleted_at == null;
}

/**
 * Sum priced lines into the cart envelope.
 * No tax is applied anywhere: the shop is not GST registered.
 */
export function summariseCart(items) {
  const subtotalPaise = items.reduce((sum, item) => sum + Number(item.lineTotalPaise || 0), 0);
  return {
    items,
    subtotalPaise,
    hasIssues: items.some((item) => item.issues.length > 0),
  };
}

/** Clamp a requested quantity to [0, MAX_QUANTITY_PER_LINE]. */
export function clampQuantity(quantity) {
  const n = Number(quantity);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(Math.floor(n), 0), MAX_QUANTITY_PER_LINE);
}

/**
 * Collapse duplicate variant ids into one line, summing quantities.
 * A client that posts the same variant twice should get one line of 3, not two
 * lines that each pass the stock check but together oversell.
 */
export function mergeRequestedItems(items) {
  const merged = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const key = toId(item?.variantId);
    if (key == null) continue;
    const previous = merged.get(key);
    const quantity = Number(item?.quantity) || 0;
    merged.set(key, { variantId: key, quantity: (previous?.quantity ?? 0) + quantity });
  }
  return [...merged.values()];
}

/**
 * Variant ids are BIGINT and arrive from mysql2 as strings (bigNumberStrings).
 * Normalise to a string key so map lookups match regardless of which side the
 * value came from.
 */
function toId(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

export { toId as normaliseVariantId };
