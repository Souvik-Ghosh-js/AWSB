import { pool } from '../../db/pool.js';
import { isValidPincode, normalisePincode } from './pincode.js';

// Shipping is a flat rate per zone, resolved from the delivery pincode:
//   Kolkata (700001-700199, incl. Salt Lake, New Town, Rajarhat) -> ₹49
//   Everywhere else                                              -> ₹99
// Ranges live in the DB so the owner can adjust them from the admin panel
// without a deploy.

export { isValidPincode } from './pincode.js';

/**
 * Resolve a pincode to its zone. Falls back to the is_fallback zone
 * (rest_of_india) when no range matches.
 *
 * Comparison is string-based on CHAR(6), which is correct here because all
 * Indian pincodes are the same length — '700199' > '700099' lexicographically
 * and numerically alike.
 */
export async function resolveZone(pincode, conn = pool) {
  if (!isValidPincode(pincode)) {
    throw Object.assign(new Error('Enter a valid 6-digit pincode.'), {
      status: 400,
      code: 'INVALID_PINCODE',
    });
  }

  const pin = normalisePincode(pincode);

  const [matched] = await conn.query(
    `SELECT z.id, z.slug, z.name, z.rate_paise, z.free_above_paise
       FROM shipping_zone_pincodes p
       JOIN shipping_zones z ON z.id = p.zone_id
      WHERE z.is_active = TRUE
        AND :pin BETWEEN p.pincode_start AND p.pincode_end
      ORDER BY z.sort_order
      LIMIT 1`,
    { pin }
  );

  if (matched.length > 0) return matched[0];

  const [fallback] = await conn.query(
    `SELECT id, slug, name, rate_paise, free_above_paise
       FROM shipping_zones
      WHERE is_fallback = TRUE AND is_active = TRUE
      LIMIT 1`
  );

  if (fallback.length === 0) {
    // Misconfiguration rather than user error — refusing is better than
    // silently shipping for free.
    throw Object.assign(new Error('No shipping zone is configured for this address.'), {
      status: 500,
      code: 'NO_FALLBACK_ZONE',
    });
  }

  return fallback[0];
}

/**
 * Shipping cost for a cart going to a pincode.
 * Returns the zone too, because the order snapshots both.
 */
export async function calculateShipping(pincode, subtotalPaise, conn = pool) {
  const zone = await resolveZone(pincode, conn);

  const freeAbove = zone.free_above_paise;
  const isFree = freeAbove != null && Number(subtotalPaise) >= Number(freeAbove);

  return {
    zoneId: Number(zone.id),
    zoneSlug: zone.slug,
    zoneName: zone.name,
    shippingPaise: isFree ? 0 : Number(zone.rate_paise),
    isFree,
  };
}
