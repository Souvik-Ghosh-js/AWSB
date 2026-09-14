// Pure unit tests for the public catalogue/cart/tracking logic.
//
// These import ONLY the *.pure.js modules. Importing a service would pull in
// db/pool.js -> config/env.js, which calls process.exit(1) when .env is absent
// and would kill the whole test run rather than fail one assertion.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveSort,
  isValidSort,
  paginate,
  buildPage,
  shapeVariant,
  normaliseRating,
  isTrackingLookupComplete,
  normaliseEmail,
  normaliseOrderNumber,
  resolveTrackingUrl,
  SORT_KEYS,
  MAX_LIMIT,
} from '../src/modules/catalog/catalog.pure.js';

import {
  priceLine,
  summariseCart,
  clampQuantity,
  mergeRequestedItems,
  ISSUE,
  MAX_QUANTITY_PER_LINE,
} from '../src/modules/cart/cart.pure.js';

// ---------------------------------------------------------------- cart maths

/** A 6ml variant of an active product, 5 in stock, ₹450.00. */
function variantRow(overrides = {}) {
  return {
    id: '42',
    size_ml: 6,
    sku: 'AWSB-WSH-06',
    price_paise: 45000,
    stock_qty: 5,
    is_enabled: 1,
    product_name: 'Waalid Shamama',
    product_status: 'active',
    product_deleted_at: null,
    ...overrides,
  };
}

test('cart: re-prices from the DB row, never from the client', () => {
  // The client claims ₹1. The priced line must ignore it entirely.
  const line = priceLine({ variantId: '42', quantity: 2, unitPricePaise: 100 }, variantRow());

  assert.equal(line.unitPricePaise, 45000);
  assert.equal(line.quantity, 2);
  assert.equal(line.lineTotalPaise, 90000);
  assert.deepEqual(line.issues, []);
});

test('cart: line total is exact integer paise', () => {
  const line = priceLine({ variantId: '42', quantity: 3 }, variantRow({ price_paise: 45050 }));
  assert.equal(line.lineTotalPaise, 135150);
  // Integer arithmetic only — no float ever enters the calculation.
  assert.ok(Number.isInteger(line.lineTotalPaise));
});

test('cart: subtotal sums the lines with no tax applied', () => {
  const lines = [
    priceLine({ variantId: '42', quantity: 2 }, variantRow({ price_paise: 45000 })),
    priceLine({ variantId: '43', quantity: 1 }, variantRow({ id: '43', price_paise: 30000 })),
  ];
  const cart = summariseCart(lines);

  // 90000 + 30000. The shop is not GST registered: the subtotal is the total
  // of the goods, full stop.
  assert.equal(cart.subtotalPaise, 120000);
  assert.equal(cart.hasIssues, false);
});

test('cart: out-of-stock line is flagged, not thrown', () => {
  const line = priceLine({ variantId: '42', quantity: 2 }, variantRow({ stock_qty: 0 }));

  assert.deepEqual(line.issues, [ISSUE.OUT_OF_STOCK]);
  assert.equal(line.quantity, 0);
  assert.equal(line.lineTotalPaise, 0);
  assert.equal(line.availableQty, 0);
});

test('cart: quantity is reduced to available stock and flagged', () => {
  const line = priceLine({ variantId: '42', quantity: 10 }, variantRow({ stock_qty: 3 }));

  assert.deepEqual(line.issues, [ISSUE.QUANTITY_REDUCED]);
  assert.equal(line.quantity, 3);
  assert.equal(line.lineTotalPaise, 135000); // 3 x 45000, not 10 x
  assert.equal(line.availableQty, 3);
});

test('cart: a disabled variant or hidden product is unavailable', () => {
  const disabled = priceLine({ variantId: '42', quantity: 1 }, variantRow({ is_enabled: 0 }));
  const draft = priceLine({ variantId: '42', quantity: 1 }, variantRow({ product_status: 'draft' }));
  const deleted = priceLine({ variantId: '42', quantity: 1 }, variantRow({ product_deleted_at: '2026-01-01' }));
  const missing = priceLine({ variantId: '999', quantity: 1 }, undefined);

  for (const line of [disabled, draft, deleted, missing]) {
    assert.deepEqual(line.issues, [ISSUE.UNAVAILABLE]);
    assert.equal(line.lineTotalPaise, 0);
  }
});

test('cart: hasIssues is true when any single line has a problem', () => {
  const cart = summariseCart([
    priceLine({ variantId: '42', quantity: 1 }, variantRow()),
    priceLine({ variantId: '43', quantity: 1 }, variantRow({ id: '43', stock_qty: 0 })),
  ]);

  assert.equal(cart.hasIssues, true);
  assert.equal(cart.subtotalPaise, 45000); // the good line still prices
});

test('cart: duplicate variant ids merge into one line', () => {
  // Two lines of 2 that each pass a 3-unit stock check would oversell.
  const merged = mergeRequestedItems([
    { variantId: '42', quantity: 2 },
    { variantId: '42', quantity: 2 },
    { variantId: '43', quantity: 1 },
  ]);

  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], { variantId: '42', quantity: 4 });

  const line = priceLine(merged[0], variantRow({ stock_qty: 3 }));
  assert.deepEqual(line.issues, [ISSUE.QUANTITY_REDUCED]);
  assert.equal(line.quantity, 3);
});

test('cart: quantity is clamped to a sane range', () => {
  assert.equal(clampQuantity(3), 3);
  assert.equal(clampQuantity('4'), 4);
  assert.equal(clampQuantity(2.7), 2);
  assert.equal(clampQuantity(-5), 0);
  assert.equal(clampQuantity('abc'), 0);
  assert.equal(clampQuantity(9999), MAX_QUANTITY_PER_LINE);
});

// ---------------------------------------------------------------- pagination

test('pagination: clamps page and limit, derives offset', () => {
  assert.deepEqual(paginate({ page: 1, limit: 24 }), { page: 1, limit: 24, offset: 0 });
  assert.deepEqual(paginate({ page: 3, limit: 24 }), { page: 3, limit: 24, offset: 48 });
  assert.deepEqual(paginate({ page: 2, limit: 10 }), { page: 2, limit: 10, offset: 10 });
});

test('pagination: garbage input falls back rather than erroring', () => {
  assert.equal(paginate({ page: 0 }).page, 1);
  assert.equal(paginate({ page: -4 }).page, 1);
  assert.equal(paginate({ page: 'abc' }).page, 1);
  assert.equal(paginate({}).page, 1);
  // An unbounded limit is a cheap way to scrape the whole catalogue.
  assert.equal(paginate({ limit: 10_000 }).limit, MAX_LIMIT);
});

test('pagination: totalPages ceilings the partial last page', () => {
  assert.equal(buildPage([], { page: 1, limit: 24, total: 0 }).totalPages, 0);
  assert.equal(buildPage([], { page: 1, limit: 24, total: 1 }).totalPages, 1);
  assert.equal(buildPage([], { page: 1, limit: 24, total: 24 }).totalPages, 1);
  assert.equal(buildPage([], { page: 1, limit: 24, total: 25 }).totalPages, 2);
  assert.equal(buildPage([], { page: 1, limit: 10, total: 95 }).totalPages, 10);
});

test('pagination: a zero limit cannot produce Infinity pages', () => {
  const page = buildPage([], { page: 1, limit: 0, total: 50 });
  assert.equal(page.totalPages, 0);
  assert.ok(Number.isFinite(page.totalPages));
});

test('pagination: envelope carries items and echoes the window', () => {
  const page = buildPage([{ id: 1 }], { page: 2, limit: 24, total: 30 });
  assert.deepEqual(page, { items: [{ id: 1 }], page: 2, limit: 24, total: 30, totalPages: 2 });
});

// ---------------------------------------------------------------- sort whitelist

test('sort: every advertised key resolves to a fragment', () => {
  assert.deepEqual(SORT_KEYS, ['newest', 'price_asc', 'price_desc', 'name']);
  for (const key of SORT_KEYS) {
    assert.ok(isValidSort(key));
    assert.equal(typeof resolveSort(key), 'string');
  }
});

test('sort: injection attempts never reach the ORDER BY clause', () => {
  const attacks = [
    "name; DROP TABLE products--",
    'price_asc; DELETE FROM orders',
    "1 UNION SELECT password_hash FROM admin_users",
    'p.created_at DESC, (SELECT 1)',
    "' OR 1=1--",
    'price_asc--',
  ];

  const safeDefault = resolveSort('newest');
  for (const attack of attacks) {
    assert.ok(!isValidSort(attack), `${attack} must not validate`);
    // The attack string is never echoed into the fragment; the lookup misses
    // and the default is used, so nothing user-controlled reaches the SQL.
    const fragment = resolveSort(attack);
    assert.equal(fragment, safeDefault);
    assert.ok(!fragment.includes('DROP'));
    assert.ok(!fragment.includes('UNION'));
    assert.ok(!fragment.includes('--'));
  }
});

test('sort: prototype keys do not resolve through the chain', () => {
  // A naive `SORT_OPTIONS[sort]` would return Object.prototype.constructor here.
  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.ok(!isValidSort(key));
    assert.equal(resolveSort(key), resolveSort('newest'));
  }
});

test('sort: non-string input falls back', () => {
  for (const value of [undefined, null, 42, {}, [], true]) {
    assert.equal(resolveSort(value), resolveSort('newest'));
  }
});

// ---------------------------------------------------------------- guest tracking guard

test('tracking: the lookup requires BOTH order number and email', () => {
  assert.ok(isTrackingLookupComplete({ order_number: 'AWSB-2026-00417', email: 'a@b.com' }));

  // Order numbers are sequential and guessable; the number alone must never
  // be enough to read someone else's order.
  assert.ok(!isTrackingLookupComplete({ order_number: 'AWSB-2026-00417' }));
  assert.ok(!isTrackingLookupComplete({ email: 'a@b.com' }));
  assert.ok(!isTrackingLookupComplete({}));
  assert.ok(!isTrackingLookupComplete());
});

test('tracking: blank and whitespace-only values do not satisfy the guard', () => {
  assert.ok(!isTrackingLookupComplete({ order_number: '', email: 'a@b.com' }));
  assert.ok(!isTrackingLookupComplete({ order_number: '   ', email: 'a@b.com' }));
  assert.ok(!isTrackingLookupComplete({ order_number: 'AWSB-2026-00417', email: '' }));
  assert.ok(!isTrackingLookupComplete({ order_number: 'AWSB-2026-00417', email: '  ' }));
  assert.ok(!isTrackingLookupComplete({ order_number: null, email: null }));
});

test('tracking: identifiers are normalised before comparison', () => {
  assert.equal(normaliseEmail('  Customer@Example.COM '), 'customer@example.com');
  assert.equal(normaliseOrderNumber(' awsb-2026-00417 '), 'AWSB-2026-00417');
  assert.equal(normaliseEmail(null), '');
  assert.equal(normaliseOrderNumber(undefined), '');
});

test('tracking: snapshotted URL wins, template fills in otherwise', () => {
  assert.equal(
    resolveTrackingUrl({ tracking_url: 'https://snapshot.example/x', tracking_number: '123' }),
    'https://snapshot.example/x'
  );
  assert.equal(
    resolveTrackingUrl({
      tracking_url: null,
      tracking_url_template: 'https://track.example/?awb={TRACKING_NUMBER}',
      tracking_number: '79876543210',
    }),
    'https://track.example/?awb=79876543210'
  );
  // CAPTCHA-gated couriers have no template: no deep link is offered at all.
  assert.equal(resolveTrackingUrl({ tracking_url: null, tracking_url_template: null }), null);
});

// ---------------------------------------------------------------- variant shaping

test('variant: in_stock is derived and raw stock is never exposed', () => {
  const inStock = shapeVariant({ id: '1', size_ml: 3, sku: 'A', price_paise: 30000, stock_qty: 7, low_stock_threshold: 5 });
  assert.equal(inStock.inStock, true);
  assert.equal(inStock.isLowStock, false);
  assert.ok(!('stockQty' in inStock), 'raw stock must not leak to the storefront');

  const low = shapeVariant({ id: '2', size_ml: 6, sku: 'B', price_paise: 45000, stock_qty: 2, low_stock_threshold: 5 });
  assert.equal(low.inStock, true);
  assert.equal(low.isLowStock, true);

  const none = shapeVariant({ id: '3', size_ml: 12, sku: 'C', price_paise: 80000, stock_qty: 0, low_stock_threshold: 5 });
  assert.equal(none.inStock, false);
  assert.equal(none.isLowStock, false);
});

test('rating: no approved reviews yields null, not zero stars', () => {
  assert.deepEqual(normaliseRating(null, 0), { ratingAvg: null, ratingCount: 0 });
  // MySQL returns AVG() as a DECIMAL string.
  assert.deepEqual(normaliseRating('4.6667', '3'), { ratingAvg: 4.7, ratingCount: 3 });
  assert.deepEqual(normaliseRating('5.0000', '1'), { ratingAvg: 5, ratingCount: 1 });
});
