import { pool } from '../../db/pool.js';
import { ApiError } from '../../middleware/error.js';
import { slugify } from './helpers/sku.js';

// Couriers and their tracking-link templates.
//
// tracking_url_template holds a literal {TRACKING_NUMBER} placeholder that is
// substituted when the shipping email is composed. supports_deep_link = FALSE
// marks the couriers that CANNOT be deep-linked at all — India Post and
// Professional Couriers gate every lookup behind a CAPTCHA, Trackon's
// published pattern 404s, and DTDC's legacy tracking host is unreachable
// (docs/02-couriers.md). For those the email shows a large copyable tracking
// number plus a link to the courier's tracking page, which is far better than
// a dead deep link that reads to the customer as a scam.

export const TRACKING_PLACEHOLDER = '{TRACKING_NUMBER}';

const FIELDS = `
  id, name, slug, tracking_url_template, supports_deep_link, awb_pattern,
  phone, is_active, sort_order
`;

/**
 * A deep-linkable courier whose template has no placeholder would silently
 * email every customer the same generic page. That is worth flagging loudly —
 * but NOT rejecting: an admin may be mid-edit, pasting the landing page first
 * and the parameter second, and blocking the save loses their work.
 */
export function templateWarnings({ tracking_url_template: template, supports_deep_link: supportsDeepLink }) {
  const warnings = [];

  if (supportsDeepLink) {
    if (!template) {
      warnings.push(
        'This courier is marked as deep-linkable but has no tracking URL template, so shipping emails will show the tracking number without a link.'
      );
    } else if (!template.includes(TRACKING_PLACEHOLDER)) {
      warnings.push(
        `The tracking URL template does not contain ${TRACKING_PLACEHOLDER}, so every customer would get the same generic page. Add the placeholder where the number belongs.`
      );
    }
  }

  if (template && !/^https:\/\//i.test(template)) {
    warnings.push('Tracking URLs should be https:// — a plain http link may be blocked or flagged in email.');
  }

  return warnings;
}

/** Resolve a template against a real number. Used when a shipment is created. */
export function buildTrackingUrl(courier, trackingNumber) {
  if (!courier?.supports_deep_link || !courier.tracking_url_template) return null;
  if (!courier.tracking_url_template.includes(TRACKING_PLACEHOLDER)) return null;
  return courier.tracking_url_template.replaceAll(
    TRACKING_PLACEHOLDER,
    encodeURIComponent(String(trackingNumber).trim())
  );
}

export async function listCouriers({ activeOnly = false } = {}) {
  const [rows] = await pool.execute(
    `SELECT ${FIELDS} FROM couriers
      ${activeOnly ? 'WHERE is_active = TRUE' : ''}
      ORDER BY sort_order ASC, name ASC`
  );
  return rows.map((c) => ({ ...c, warnings: templateWarnings(c) }));
}

export async function getCourier(id) {
  const [rows] = await pool.execute(`SELECT ${FIELDS} FROM couriers WHERE id = :id LIMIT 1`, { id });
  if (!rows[0]) throw new ApiError(404, 'Courier not found.');
  return { ...rows[0], warnings: templateWarnings(rows[0]) };
}

export async function createCourier(input) {
  const slug = slugify(input.slug ?? input.name).slice(0, 60);

  const [existing] = await pool.execute('SELECT id FROM couriers WHERE slug = :slug LIMIT 1', { slug });
  if (existing[0]) {
    throw new ApiError(409, `A courier with the slug "${slug}" already exists.`);
  }

  const [result] = await pool.execute(
    `INSERT INTO couriers
       (name, slug, tracking_url_template, supports_deep_link, awb_pattern, phone, is_active, sort_order)
     VALUES
       (:name, :slug, :tracking_url_template, :supports_deep_link, :awb_pattern, :phone, :is_active, :sort_order)`,
    {
      name: input.name,
      slug,
      tracking_url_template: input.tracking_url_template ?? null,
      supports_deep_link: input.supports_deep_link ?? true,
      awb_pattern: input.awb_pattern ?? null,
      phone: input.phone ?? null,
      is_active: input.is_active ?? true,
      sort_order: input.sort_order ?? 0,
    }
  );

  return getCourier(String(result.insertId));
}

export async function updateCourier(id, input) {
  const [existingRows] = await pool.execute(`SELECT ${FIELDS} FROM couriers WHERE id = :id LIMIT 1`, { id });
  if (!existingRows[0]) throw new ApiError(404, 'Courier not found.');

  const fields = [
    'name', 'tracking_url_template', 'supports_deep_link',
    'awb_pattern', 'phone', 'is_active', 'sort_order',
  ];
  const sets = [];
  const params = { id };
  for (const key of fields) {
    if (input[key] !== undefined) {
      sets.push(`${key} = :${key}`);
      params[key] = input[key];
    }
  }
  if (input.slug !== undefined) {
    sets.push('slug = :slug');
    params.slug = slugify(input.slug).slice(0, 60);
  }

  if (sets.length) {
    await pool.execute(`UPDATE couriers SET ${sets.join(', ')} WHERE id = :id`, params);
  }
  return getCourier(id);
}

/**
 * shipments.courier_id is ON DELETE RESTRICT, so a courier that has carried a
 * parcel cannot be removed. Deactivate it instead: it disappears from the
 * shipping dropdown while old shipments keep resolving.
 */
export async function deleteCourier(id) {
  const [[stats]] = await pool.execute(
    'SELECT COUNT(*) AS n FROM shipments WHERE courier_id = :id',
    { id }
  );

  if (Number(stats.n) > 0) {
    const [result] = await pool.execute('UPDATE couriers SET is_active = FALSE WHERE id = :id', { id });
    if (result.affectedRows === 0) throw new ApiError(404, 'Courier not found.');
    return {
      id: String(id),
      deleted: false,
      deactivated: true,
      message: `This courier has ${stats.n} shipment(s) against it, so it was deactivated rather than deleted.`,
    };
  }

  const [result] = await pool.execute('DELETE FROM couriers WHERE id = :id', { id });
  if (result.affectedRows === 0) throw new ApiError(404, 'Courier not found.');
  return { id: String(id), deleted: true };
}
