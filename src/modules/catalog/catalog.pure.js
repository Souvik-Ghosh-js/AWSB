// Pure catalogue helpers: sort whitelisting, pagination maths, row shaping.
//
// Deliberately free of any import chain — no pool, no env. Same reasoning as
// services/shipping/pincode.js: this is the logic most worth unit-testing, and
// it must stay testable without a database or a populated .env.

/**
 * Sort key -> ORDER BY fragment.
 *
 * This map IS the security boundary for sorting. The `sort` query parameter is
 * never interpolated into SQL; it is only ever used to look up a key here, so
 * an injection attempt ('name; DROP TABLE products--') simply misses and falls
 * back to the default. Never change this to build SQL from user input.
 */
const SORT_OPTIONS = Object.freeze({
  newest: 'p.created_at DESC, p.id DESC',
  price_asc: 'min_price_paise ASC, p.id ASC',
  price_desc: 'min_price_paise DESC, p.id DESC',
  name: 'p.name ASC, p.id ASC',
});

export const SORT_KEYS = Object.freeze(Object.keys(SORT_OPTIONS));

export const DEFAULT_SORT = 'newest';

/**
 * Resolve a client-supplied sort key to a trusted ORDER BY fragment.
 * Anything unrecognised — including injection attempts — yields the default.
 */
export function resolveSort(sort) {
  // Object.hasOwn keeps inherited keys ('constructor', '__proto__') from
  // resolving to a truthy value on the prototype chain.
  if (typeof sort === 'string' && Object.hasOwn(SORT_OPTIONS, sort)) {
    return SORT_OPTIONS[sort];
  }
  return SORT_OPTIONS[DEFAULT_SORT];
}

/** True only for a sort key the whitelist actually knows. */
export function isValidSort(sort) {
  return typeof sort === 'string' && Object.hasOwn(SORT_OPTIONS, sort);
}

export const MAX_LIMIT = 60;
export const DEFAULT_LIMIT = 24;

/**
 * Clamp page/limit and derive the LIMIT/OFFSET window.
 * Garbage in (0, -3, 'abc', 10_000) yields a sane window rather than an error:
 * a bad page number should show page 1, not a 500.
 */
export function paginate({ page, limit } = {}) {
  const safePage = toPositiveInt(page, 1);
  const safeLimit = Math.min(toPositiveInt(limit, DEFAULT_LIMIT), MAX_LIMIT);
  return {
    page: safePage,
    limit: safeLimit,
    offset: (safePage - 1) * safeLimit,
  };
}

/** Build the paginated envelope every list endpoint returns. */
export function buildPage(items, { page, limit, total }) {
  const safeTotal = Math.max(0, Number(total) || 0);
  // Guard and divisor must be the SAME validated number: dividing by an
  // unvalidated `limit` after checking a different value yields Infinity/NaN
  // in totalPages for limit = 0 or 'abc'.
  const perPage = toPositiveInt(limit, 0);
  return {
    items,
    page,
    limit,
    total: safeTotal,
    // Ceil handles the partial last page; an empty result set reports 0 pages
    // so a client can say "no products found" without special-casing.
    totalPages: perPage === 0 ? 0 : Math.ceil(safeTotal / perPage),
  };
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i >= 1 ? i : fallback;
}

/**
 * Shape a variant row for public output. `in_stock` is derived rather than
 * stored so the client never has to know the stock rules.
 */
/**
 * "12 ml" / "25 g" / "35 sticks" — the one place a variant's size and unit
 * become a display string. Used in customer-facing stock/error messages and
 * emails; the storefront has its own copy for anything rendered in React,
 * since these are plain strings destined for JSON/plaintext, not JSX.
 */
export function formatVariantSize(sizeValue, sizeUnit) {
  const n = Number(sizeValue);
  const unit = sizeUnit ?? 'ml';
  if (unit === 'sticks') return `${n} stick${n === 1 ? '' : 's'}`;
  return `${n} ${unit}`;
}

export function shapeVariant(row) {
  const stockQty = Number(row.stock_qty ?? 0);
  return {
    id: Number(row.id),
    sizeMl: Number(row.size_ml),
    // Most products are ml, and old rows (migrated with DEFAULT 'ml') have
    // no other value — default here rather than trust every caller's SELECT
    // to have asked for the column.
    sizeUnit: row.size_unit ?? 'ml',
    sku: row.sku,
    pricePaise: Number(row.price_paise),
    compareAtPaise: row.compare_at_paise == null ? null : Number(row.compare_at_paise),
    // Stock is never exposed as a raw number on public endpoints — knowing a
    // competitor holds 3 units is not the shopper's business, and it invites
    // scraping. The boolean is all the storefront needs.
    inStock: stockQty > 0,
    isLowStock: stockQty > 0 && stockQty <= Number(row.low_stock_threshold ?? 0),
  };
}

/** Average rating comes back from MySQL as a DECIMAL string; round to 1dp. */
export function normaliseRating(avg, count) {
  const n = Number(count) || 0;
  if (n === 0) return { ratingAvg: null, ratingCount: 0 };
  return { ratingAvg: Math.round(Number(avg) * 10) / 10, ratingCount: n };
}

/**
 * Guest order tracking must be gated on the order number PLUS at least one
 * matching contact detail (email or phone). order_number alone is guessable
 * — they are sequential ('AWSB-2026-00417') — so requiring a match on
 * ship_email or ship_phone is what stops one customer from reading another's
 * address and phone number. Either contact detail is an equally strong
 * guard; the customer just picks whichever they remember from checkout.
 *
 * Pure so the guard itself is unit-testable without a DB.
 */
export function isTrackingLookupComplete({ order_number, email, phone } = {}) {
  return isNonEmptyString(order_number) && (isNonEmptyString(email) || isNonEmptyString(phone));
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Emails are compared case-insensitively; addresses are not case-sensitive. */
export function normaliseEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

/** Order numbers are stored uppercase ('AWSB-2026-00417'). */
export function normaliseOrderNumber(orderNumber) {
  return String(orderNumber ?? '').trim().toUpperCase();
}

/**
 * Phones are stored as the bare 10-digit number (see phoneSchema in
 * middleware/validate.js), but a customer typing it back in at tracking time
 * may include a +91, spaces or dashes. Strip the same way checkout does so
 * the two sides of the comparison are guaranteed to line up.
 */
export function normalisePhone(phone) {
  return String(phone ?? '')
    .trim()
    .replace(/[\s\-()]/g, '')
    .replace(/^(\+?91)/, '');
}

/**
 * Resolve the tracking link for a shipment row.
 * `supports_deep_link = FALSE` means the courier CAPTCHA-gates its tracking
 * page, so the customer gets a copyable number plus the landing page rather
 * than a deep link that would 404 and read as a scam.
 */
export function resolveTrackingUrl({ tracking_url, tracking_url_template, tracking_number }) {
  if (tracking_url) return tracking_url;
  if (!tracking_url_template) return null;
  return tracking_url_template.replace('{TRACKING_NUMBER}', encodeURIComponent(tracking_number ?? ''));
}
