// Unit tests for the admin modules.
//
// PURE ONLY: no database, no network, no environment. Every import below
// resolves to a file that does not reach src/db/pool.js — and therefore not
// src/config/env.js, which calls process.exit(1) when a .env is absent. That
// constraint is why the rules under test live in src/modules/admin/helpers/
// rather than inside the service files that own the SQL.

import test from 'node:test';
import assert from 'node:assert/strict';

import { generateSku, slugCode, sizeCode, dedupeSku, slugify } from '../src/modules/admin/helpers/sku.js';
import { validateCouponInput, normaliseCode, isDuplicateCodeError } from '../src/modules/admin/helpers/coupon-rules.js';
import { balanceAfter, isLowStock, wouldGoNegative, deltaForTarget } from '../src/modules/admin/helpers/inventory-math.js';
import { escapeCsvField, toCsvRow, paiseToCsvAmount } from '../src/modules/admin/helpers/csv.js';
import { canModifyAdmin, countActiveOwners } from '../src/modules/admin/helpers/owner-guard.js';

// ------------------------------------------------------------------ SKU

test('sku: generates AWSB-<3 letters>-<padded size>', () => {
  assert.equal(generateSku('Waalid Shamama', 3), 'AWSB-WSH-03');
  assert.equal(generateSku('Waalid Shamama', 6), 'AWSB-WSH-06');
  assert.equal(generateSku('Waalid Shamama', 12), 'AWSB-WSH-12');
});

test('sku: three or more words use initials, keeping similar attars distinct', () => {
  assert.equal(slugCode('Waalid Shamama Oud'), 'WSO');
  assert.equal(slugCode('Royal Oud Attar Deluxe'), 'ROA'); // first three only
});

test('sku: two-word names take the first initial plus the second word', () => {
  // The worked example in docs/01-architecture.md: 'Waalid Shamama' -> WSH.
  assert.equal(slugCode('Waalid Shamama'), 'WSH');
  assert.equal(slugCode('Ruh Khus'), 'RKH');
});

test('sku: one-word and degenerate names stay well-formed', () => {
  assert.equal(slugCode('Mogra'), 'MOG');
  assert.equal(slugCode('Ag'), 'AGX');      // padded to three
  assert.equal(slugCode(''), 'XXX');        // never empty
  assert.equal(slugCode('123 456'), 'XXX'); // digits are not letters
});

test('sku: size code is zero-padded so SKUs sort as text', () => {
  assert.equal(sizeCode(3), '03');
  assert.equal(sizeCode(6), '06');
  assert.equal(sizeCode(12), '12');
});

test('sku: collisions are suffixed, because the column is UNIQUE', () => {
  // Two real products both condensing to 'WSH'.
  assert.equal(generateSku('Waalid Shamama', 3), generateSku('White Saffron Heart', 3));

  const taken = new Set(['AWSB-WSH-03']);
  assert.equal(dedupeSku('AWSB-WSH-03', taken), 'AWSB-WSH-03-2');

  taken.add('AWSB-WSH-03-2');
  assert.equal(dedupeSku('AWSB-WSH-03', taken), 'AWSB-WSH-03-3');

  // An unused SKU is returned untouched.
  assert.equal(dedupeSku('AWSB-MOG-12', taken), 'AWSB-MOG-12');
});

test('sku: product slugs are URL-safe', () => {
  assert.equal(slugify('Waalid Shamama'), 'waalid-shamama');
  assert.equal(slugify('  Oud —  Royal!  '), 'oud-royal');
  assert.equal(slugify('Attar 24 Karat'), 'attar-24-karat');
});

// --------------------------------------------------------------- coupons

test('coupon: codes are upper-cased for the UNIQUE index', () => {
  assert.equal(normaliseCode('diwali10'), 'DIWALI10');
  assert.equal(normaliseCode('  festive-25  '), 'FESTIVE-25');
});

test('coupon: a valid percent coupon passes', () => {
  const { ok, errors } = validateCouponInput({
    code: 'DIWALI10',
    discount_type: 'percent',
    discount_value: 10,
    max_discount_paise: 20000,
  });
  assert.ok(ok, errors.join(' '));
});

test('coupon: a percent discount must be capped', () => {
  const { ok, errors } = validateCouponInput({
    code: 'DIWALI10',
    discount_type: 'percent',
    discount_value: 10,
  });
  assert.ok(!ok);
  assert.ok(errors.some((e) => e.includes('max_discount_paise')));
});

test('coupon: a percent cap must be a positive amount', () => {
  const { ok } = validateCouponInput({
    code: 'DIWALI10',
    discount_type: 'percent',
    discount_value: 10,
    max_discount_paise: 0,
  });
  assert.ok(!ok);
});

test('coupon: a percent value above 100 is rejected', () => {
  const { ok, errors } = validateCouponInput({
    code: 'OOPS',
    discount_type: 'percent',
    discount_value: 5000, // someone meaning ₹50
    max_discount_paise: 20000,
  });
  assert.ok(!ok);
  assert.ok(errors.some((e) => e.includes('cannot exceed 100')));
});

test('coupon: a fixed discount takes no percent cap', () => {
  const { ok, errors } = validateCouponInput({
    code: 'FLAT50',
    discount_type: 'fixed',
    discount_value: 5000,
    max_discount_paise: 10000,
  });
  assert.ok(!ok);
  assert.ok(errors.some((e) => e.includes('only applies to percent')));
});

test('coupon: expires_at must be after starts_at', () => {
  const { ok, errors } = validateCouponInput({
    code: 'BACKWARDS',
    discount_type: 'fixed',
    discount_value: 5000,
    starts_at: '2026-10-01T00:00:00Z',
    expires_at: '2026-09-01T00:00:00Z',
  });
  assert.ok(!ok);
  assert.ok(errors.some((e) => e.includes('expires_at must be after starts_at')));

  // Equal timestamps are also useless — the window is empty.
  const equal = validateCouponInput({
    code: 'EMPTY',
    discount_type: 'fixed',
    discount_value: 5000,
    starts_at: '2026-10-01T00:00:00Z',
    expires_at: '2026-10-01T00:00:00Z',
  });
  assert.ok(!equal.ok);

  // The correct ordering passes.
  const good = validateCouponInput({
    code: 'FESTIVE',
    discount_type: 'fixed',
    discount_value: 5000,
    starts_at: '2026-09-01T00:00:00Z',
    expires_at: '2026-10-01T00:00:00Z',
  });
  assert.ok(good.ok, good.errors.join(' '));
});

test('coupon: a blank or malformed code is rejected', () => {
  assert.ok(!validateCouponInput({ code: '', discount_type: 'fixed', discount_value: 100 }).ok);
  assert.ok(!validateCouponInput({ code: 'A B', discount_type: 'fixed', discount_value: 100 }).ok);
});

test('coupon: duplicate codes are recognised from the MySQL error', () => {
  assert.ok(isDuplicateCodeError({ code: 'ER_DUP_ENTRY' }));
  assert.ok(isDuplicateCodeError({ errno: 1062 }));
  assert.ok(!isDuplicateCodeError({ code: 'ER_NO_SUCH_TABLE' }));
});

// ------------------------------------------------------------- inventory

test('inventory: balance_after is the stock level AFTER a positive delta', () => {
  assert.equal(balanceAfter(10, 50), 60);   // restock
  assert.equal(balanceAfter(0, 12), 12);    // opening stock
});

test('inventory: balance_after is the stock level AFTER a negative delta', () => {
  assert.equal(balanceAfter(10, -2), 8);    // sale
  assert.equal(balanceAfter(3, -3), 0);     // sold out exactly
});

test('inventory: balance_after over a sequence stays consistent with the ledger', () => {
  // What the movements table should read after restock, sale, damage.
  let stock = 0;
  const ledger = [];
  for (const delta of [50, -2, -1, 25]) {
    stock = balanceAfter(stock, delta);
    ledger.push(stock);
  }
  assert.deepEqual(ledger, [50, 48, 47, 72]);
  assert.equal(stock, 72);
});

test('inventory: an adjustment past zero is caught before the CHECK constraint', () => {
  assert.ok(wouldGoNegative(2, -3));
  assert.ok(!wouldGoNegative(3, -3));
  assert.ok(!wouldGoNegative(0, 5));
});

test('inventory: an absolute count converts to the right delta', () => {
  assert.equal(deltaForTarget(10, 40), 30);   // shelf count is higher
  assert.equal(deltaForTarget(40, 10), -30);  // shrinkage
  assert.equal(deltaForTarget(10, 10), 0);    // nothing to record
});

test('inventory: low stock is stock_qty <= low_stock_threshold, inclusive', () => {
  assert.ok(isLowStock({ stock_qty: 3, low_stock_threshold: 5 }));
  assert.ok(isLowStock({ stock_qty: 5, low_stock_threshold: 5 }));  // the boundary counts as low
  assert.ok(isLowStock({ stock_qty: 0, low_stock_threshold: 5 }));  // sold out
  assert.ok(!isLowStock({ stock_qty: 6, low_stock_threshold: 5 }));
  assert.ok(!isLowStock(null));
});

// ------------------------------------------------------------------- CSV

test('csv: a product name containing a comma is quoted', () => {
  assert.equal(escapeCsvField('Oud, Royal'), '"Oud, Royal"');
});

test('csv: a quote inside a field is doubled and the field quoted', () => {
  assert.equal(escapeCsvField('Ruh "Khus" Attar'), '"Ruh ""Khus"" Attar"');
});

test('csv: a name with both a comma and a quote survives a round trip', () => {
  const name = 'Shamama, "Royal" Edition';
  const field = escapeCsvField(name);
  assert.equal(field, '"Shamama, ""Royal"" Edition"');

  // Unquote the way any CSV reader would, and the original must come back
  // byte for byte — this is the case that corrupts a naive export.
  const decoded = field.slice(1, -1).replace(/""/g, '"');
  assert.equal(decoded, name);
});

test('csv: plain fields are left unquoted, and null becomes empty', () => {
  assert.equal(escapeCsvField('AWSB-2026-00417'), 'AWSB-2026-00417');
  assert.equal(escapeCsvField(null), '');
  assert.equal(escapeCsvField(undefined), '');
  assert.equal(escapeCsvField(0), '0');
});

test('csv: newlines and edge whitespace force quoting', () => {
  assert.equal(escapeCsvField('line1\nline2'), '"line1\nline2"');
  assert.equal(escapeCsvField(' padded '), '" padded "');
});

test('csv: a row joins escaped fields with commas', () => {
  const row = toCsvRow(['AWSB-2026-00417', 'Oud, Royal', 'Ruh "Khus"', '450.00']);
  assert.equal(row, 'AWSB-2026-00417,"Oud, Royal","Ruh ""Khus""",450.00');
  // The separator count proves the embedded comma did not split the row.
  assert.equal(row.split('"').length % 2, 1);
});

test('csv: paise render as a plain decimal for the accountant', () => {
  assert.equal(paiseToCsvAmount(45050), '450.50');
  assert.equal(paiseToCsvAmount(4900), '49.00');
  assert.equal(paiseToCsvAmount(0), '0.00');
  assert.equal(paiseToCsvAmount(5), '0.05');
});

// ------------------------------------------------------------ last owner

const owner = { id: 1, role: 'owner', is_active: true };
const secondOwner = { id: 2, role: 'owner', is_active: true };
const manager = { id: 3, role: 'manager', is_active: true };

test('owner guard: counts only ACTIVE owners', () => {
  assert.equal(countActiveOwners([owner, secondOwner, manager]), 2);
  assert.equal(countActiveOwners([owner, { id: 9, role: 'owner', is_active: false }]), 1);
  // mysql2 returns BOOLEAN as 1/0, which must count the same as true.
  assert.equal(countActiveOwners([{ id: 4, role: 'owner', is_active: 1 }]), 1);
  assert.equal(countActiveOwners([]), 0);
});

test('owner guard: the last active owner cannot be deleted', () => {
  const result = canModifyAdmin(owner, { action: 'delete' }, 1);
  assert.ok(!result.allowed);
  assert.match(result.reason, /last active owner/);
});

test('owner guard: the last active owner cannot be deactivated', () => {
  const result = canModifyAdmin(owner, { is_active: false }, 1);
  assert.ok(!result.allowed);
  assert.match(result.reason, /deactivate/);
});

test('owner guard: the last active owner cannot be demoted', () => {
  const result = canModifyAdmin(owner, { role: 'manager' }, 1);
  assert.ok(!result.allowed);
  assert.match(result.reason, /change the role of/);
});

test('owner guard: with a second owner, either may be removed', () => {
  assert.ok(canModifyAdmin(owner, { action: 'delete' }, 2).allowed);
  assert.ok(canModifyAdmin(owner, { is_active: false }, 2).allowed);
  assert.ok(canModifyAdmin(owner, { role: 'staff' }, 2).allowed);
});

test('owner guard: harmless edits to the last owner are allowed', () => {
  // Renaming or re-activating the last owner removes nobody.
  assert.ok(canModifyAdmin(owner, { full_name: 'New Name' }, 1).allowed);
  assert.ok(canModifyAdmin(owner, { is_active: true }, 1).allowed);
  assert.ok(canModifyAdmin(owner, { role: 'owner' }, 1).allowed);
});

test('owner guard: non-owners are never protected by this rule', () => {
  assert.ok(canModifyAdmin(manager, { action: 'delete' }, 1).allowed);
  assert.ok(canModifyAdmin({ id: 5, role: 'staff', is_active: true }, { is_active: false }, 1).allowed);
  // An already-inactive owner is not the last ACTIVE owner.
  assert.ok(canModifyAdmin({ id: 6, role: 'owner', is_active: false }, { action: 'delete' }, 1).allowed);
});

// ------------------------------------------------------------------ variant patch
// PATCH /admin/products/:id used to drop `variants` silently (the body schema
// omitted it), so a price change from the admin form returned 200 and changed
// nothing. These rules back the fix.

import { variantPatchSets, variantsBySize, VARIANT_PATCH_FIELDS } from '../src/modules/admin/helpers/variant-patch.js';

test('variant patch: only the allowed columns become SET fragments', () => {
  const { sets, params } = variantPatchSets({
    size_ml: 3, price_paise: 170000, low_stock_threshold: 3, is_enabled: true, product_id: 99,
  });
  assert.deepEqual(sets, ['price_paise = :price_paise', 'low_stock_threshold = :low_stock_threshold', 'is_enabled = :is_enabled']);
  assert.deepEqual(params, { price_paise: 170000, low_stock_threshold: 3, is_enabled: true });
});

test('variant patch: a null compare_at price clears the column rather than being skipped', () => {
  const { sets, params } = variantPatchSets({ compare_at_paise: null });
  assert.deepEqual(sets, ['compare_at_paise = :compare_at_paise']);
  assert.equal(params.compare_at_paise, null);
});

test('variant patch: an entry with nothing to change yields no SET', () => {
  assert.deepEqual(variantPatchSets({ size_ml: 6 }).sets, []);
});

test('variant patch: stock_qty is refused so it cannot bypass the ledger', () => {
  assert.throws(() => variantPatchSets({ price_paise: 1, stock_qty: 5 }), /ledger/);
});

test('variant patch: every allowed field is a real product_variants column', () => {
  for (const f of VARIANT_PATCH_FIELDS) assert.match(f, /^[a-z_]+$/);
});

test('variants by size: indexes entries by size + unit', () => {
  const m = variantsBySize([{ size_ml: 3, price_paise: 1 }, { size_ml: '12', price_paise: 2 }]);
  assert.equal(m.get('3:ml').price_paise, 1);
  assert.equal(m.get('12:ml').price_paise, 2);
  assert.equal(variantsBySize(undefined).size, 0);
});

test('variants by size: the same number in two different units is not a collision', () => {
  const m = variantsBySize([
    { size_ml: 12, price_paise: 1 },
    { size_ml: 12, size_unit: 'g', price_paise: 2 },
  ]);
  assert.equal(m.size, 2);
  assert.equal(m.get('12:ml').price_paise, 1);
  assert.equal(m.get('12:g').price_paise, 2);
});

test('variants by size: a duplicated size is rejected instead of silently overwriting', () => {
  assert.throws(() => variantsBySize([{ size_ml: 6 }, { size_ml: 6 }]), /more than once/);
  assert.throws(
    () => variantsBySize([{ size_ml: 25, size_unit: 'g' }, { size_ml: 25, size_unit: 'g' }]),
    /more than once/
  );
});
