// Pure rules for updating a product variant through the admin API.
//
// Kept free of SQL and env so it can be unit-tested (see tests/admin.test.js).

/** Columns an admin may change on an existing variant. */
export const VARIANT_PATCH_FIELDS = [
  'sku', 'price_paise', 'compare_at_paise', 'low_stock_threshold', 'is_enabled', 'weight_grams',
];

/**
 * Sizes are unit-qualified — a "12" only means the same variant slot if both
 * the number AND the unit match. A product's variants are always all one
 * unit (an attar is all ml, a powder is all grams), so within one request
 * this key just has to distinguish rows, not describe every possible mix.
 */
function sizeKey(sizeMl, sizeUnit) {
  return `${Number(sizeMl)}:${sizeUnit ?? 'ml'}`;
}

/**
 * Turn a variant patch into SQL SET fragments and named params.
 *
 * `stock_qty` is refused outright: stock changes must go through the ledger
 * (PATCH /admin/variants/:id/stock) so every movement has a reason and an actor.
 *
 * @param {Record<string, unknown>} input
 * @returns {{ sets: string[], params: Record<string, unknown> }}
 */
export function variantPatchSets(input) {
  if (input.stock_qty !== undefined) {
    const err = new Error(
      'Stock cannot be changed here. Use PATCH /admin/variants/:id/stock so the movement is recorded in the ledger.'
    );
    err.status = 400;
    throw err;
  }
  const sets = [];
  const params = {};
  for (const key of VARIANT_PATCH_FIELDS) {
    if (input[key] !== undefined) {
      sets.push(`${key} = :${key}`);
      params[key] = input[key];
    }
  }
  return { sets, params };
}

/**
 * Index a PATCH body's `variants` array by size (+ unit) so each entry can be
 * matched to the existing row for that size. Duplicate sizes are rejected
 * because the second would silently overwrite the first.
 *
 * @param {Array<{size_ml:number, size_unit?:string}>|undefined} variants
 * @returns {Map<string, object>}
 */
export function variantsBySize(variants) {
  const map = new Map();
  for (const v of variants ?? []) {
    const key = sizeKey(v.size_ml, v.size_unit);
    if (map.has(key)) {
      const err = new Error(`Variant size ${v.size_ml}${v.size_unit ?? 'ml'} appears more than once in the request.`);
      err.status = 400;
      throw err;
    }
    map.set(key, v);
  }
  return map;
}
