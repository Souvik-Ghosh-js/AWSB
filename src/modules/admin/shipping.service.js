import { pool, withTransaction } from '../../db/pool.js';
import { ApiError } from '../../middleware/error.js';
import { isValidPincode, normalisePincode } from '../../services/shipping/pincode.js';

// Shipping zones are what src/services/shipping/zones.js actually charges at
// checkout — this is the admin-facing CRUD for the same tables. A zone is a
// flat rate (Kolkata ₹49, rest of India ₹99 today) with an optional free-
// above threshold, resolved by matching the delivery pincode against one or
// more ranges owned by the zone.

async function getZonePincodes(conn, zoneId) {
  const [rows] = await conn.execute(
    'SELECT id, pincode_start, pincode_end FROM shipping_zone_pincodes WHERE zone_id = :zone_id ORDER BY pincode_start ASC',
    { zone_id: zoneId }
  );
  return rows;
}

export async function listZones() {
  const [zones] = await pool.query(
    `SELECT id, slug, name, rate_paise, free_above_paise, is_fallback, is_active, sort_order
       FROM shipping_zones
      ORDER BY sort_order ASC, name ASC`
  );
  if (zones.length === 0) return [];

  const [ranges] = await pool.query(
    `SELECT id, zone_id, pincode_start, pincode_end
       FROM shipping_zone_pincodes
      WHERE zone_id IN (?)
      ORDER BY pincode_start ASC`,
    [zones.map((z) => z.id)]
  );
  const byZone = new Map();
  for (const r of ranges) {
    const key = String(r.zone_id);
    if (!byZone.has(key)) byZone.set(key, []);
    byZone.get(key).push(r);
  }

  return zones.map((z) => ({ ...z, pincode_ranges: byZone.get(String(z.id)) ?? [] }));
}

export async function getZone(id) {
  const [rows] = await pool.execute(
    `SELECT id, slug, name, rate_paise, free_above_paise, is_fallback, is_active, sort_order
       FROM shipping_zones WHERE id = :id LIMIT 1`,
    { id }
  );
  const zone = rows[0];
  if (!zone) throw new ApiError(404, 'Shipping zone not found.');
  zone.pincode_ranges = await getZonePincodes(pool, id);
  return zone;
}

/** Slugs are UNIQUE; suffix a counter rather than failing the admin's save. */
async function uniqueSlug(conn, name, excludeId = null) {
  const base = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'zone';
  let candidate = base;
  for (let n = 2; n < 1000; n += 1) {
    const [rows] = await conn.execute(
      'SELECT id FROM shipping_zones WHERE slug = :slug AND (:id IS NULL OR id <> :id) LIMIT 1',
      { slug: candidate, id: excludeId }
    );
    if (rows.length === 0) return candidate;
    candidate = `${base}_${n}`;
  }
  return `${base}_${Date.now()}`;
}

function validateRanges(ranges) {
  for (const r of ranges ?? []) {
    if (!isValidPincode(r.pincode_start) || !isValidPincode(r.pincode_end)) {
      throw new ApiError(422, 'Each pincode range needs two valid 6-digit pincodes.');
    }
    if (normalisePincode(r.pincode_start) > normalisePincode(r.pincode_end)) {
      throw new ApiError(422, 'A pincode range\'s start must not be after its end.');
    }
  }
}

export async function createZone(input) {
  validateRanges(input.pincode_ranges);
  return withTransaction(async (conn) => {
    const slug = input.slug ? String(input.slug) : await uniqueSlug(conn, input.name);

    // Only one zone can be the fallback (resolveZone picks the first active
    // one it finds); making a new zone the fallback demotes any existing one
    // rather than leaving two fallbacks that silently pick by row order.
    if (input.is_fallback) {
      await conn.execute('UPDATE shipping_zones SET is_fallback = FALSE WHERE is_fallback = TRUE');
    }

    const [result] = await conn.execute(
      `INSERT INTO shipping_zones (slug, name, rate_paise, free_above_paise, is_fallback, is_active, sort_order)
       VALUES (:slug, :name, :rate_paise, :free_above_paise, :is_fallback, :is_active, :sort_order)`,
      {
        slug,
        name: input.name,
        rate_paise: input.rate_paise,
        free_above_paise: input.free_above_paise ?? null,
        is_fallback: input.is_fallback ?? false,
        is_active: input.is_active ?? true,
        sort_order: input.sort_order ?? 0,
      }
    );
    const zoneId = String(result.insertId);

    for (const r of input.pincode_ranges ?? []) {
      await conn.execute(
        'INSERT INTO shipping_zone_pincodes (zone_id, pincode_start, pincode_end) VALUES (:zone_id, :start, :end)',
        { zone_id: zoneId, start: normalisePincode(r.pincode_start), end: normalisePincode(r.pincode_end) }
      );
    }

    return zoneId;
  }).then((id) => getZone(id));
}

const UPDATABLE = ['name', 'rate_paise', 'free_above_paise', 'is_active', 'sort_order'];

export async function updateZone(id, input) {
  if (input.pincode_ranges !== undefined) validateRanges(input.pincode_ranges);

  return withTransaction(async (conn) => {
    const [existing] = await conn.execute(
      'SELECT id, is_fallback FROM shipping_zones WHERE id = :id FOR UPDATE',
      { id }
    );
    if (!existing[0]) throw new ApiError(404, 'Shipping zone not found.');

    const sets = [];
    const params = { id };
    for (const key of UPDATABLE) {
      if (input[key] !== undefined) {
        sets.push(`${key} = :${key}`);
        params[key] = input[key];
      }
    }
    if (input.slug !== undefined) {
      sets.push('slug = :slug');
      params.slug = String(input.slug);
    }
    if (input.is_fallback !== undefined) {
      if (input.is_fallback) {
        await conn.execute('UPDATE shipping_zones SET is_fallback = FALSE WHERE is_fallback = TRUE AND id <> :id', { id });
      }
      sets.push('is_fallback = :is_fallback');
      params.is_fallback = input.is_fallback;
    }
    if (sets.length > 0) {
      await conn.execute(`UPDATE shipping_zones SET ${sets.join(', ')} WHERE id = :id`, params);
    }

    // Ranges are replaced wholesale when sent — simpler and safer than diffing
    // individual rows, and the admin form always submits the full list anyway.
    if (input.pincode_ranges !== undefined) {
      await conn.execute('DELETE FROM shipping_zone_pincodes WHERE zone_id = :id', { id });
      for (const r of input.pincode_ranges) {
        await conn.execute(
          'INSERT INTO shipping_zone_pincodes (zone_id, pincode_start, pincode_end) VALUES (:zone_id, :start, :end)',
          { zone_id: id, start: normalisePincode(r.pincode_start), end: normalisePincode(r.pincode_end) }
        );
      }
    }

    return id;
  }).then(() => getZone(id));
}

/**
 * Deleting the fallback zone would leave resolveZone with no catch-all for
 * an unmatched pincode, which it treats as a hard 500 rather than silently
 * shipping for free — so that case is refused outright rather than letting
 * checkout break for every out-of-range address.
 */
export async function deleteZone(id) {
  const zone = await getZone(id);
  if (zone.is_fallback) {
    throw new ApiError(
      409,
      'This is the fallback zone — every pincode with no other match uses it. Make another zone the fallback first.'
    );
  }
  const [result] = await pool.execute('DELETE FROM shipping_zones WHERE id = :id', { id });
  if (result.affectedRows === 0) throw new ApiError(404, 'Shipping zone not found.');
  return { id: String(id), deleted: true };
}
