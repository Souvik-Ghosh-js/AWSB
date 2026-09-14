import { Router } from 'express';
import { z } from 'zod';

import { pool, withTransaction } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { requireAdmin } from '../../middleware/auth.js';

// Admin-editable key/value settings: shipping rates, free-shipping threshold,
// store address, contact details. Kept in a table precisely so changing one is
// an admin edit rather than a deploy.

const router = Router();

/**
 * value_json is a JSON column, so mysql2 may hand back either a parsed value
 * or a string depending on driver version and column type. Normalise both.
 */
function parseValue(raw) {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

router.get(
  '/settings',
  requireAdmin('owner', 'manager', 'staff'),
  asyncHandler(async (_req, res) => {
    const [rows] = await pool.execute(
      'SELECT key_name, value_json, updated_at FROM settings ORDER BY key_name ASC'
    );

    // Returned as a flat object because that is how the admin form consumes
    // it; updated_at is kept alongside for anyone auditing a rate change.
    const settings = {};
    const updatedAt = {};
    for (const row of rows) {
      settings[row.key_name] = parseValue(row.value_json);
      updatedAt[row.key_name] = row.updated_at;
    }

    res.json({ settings, updated_at: updatedAt });
  })
);

/**
 * PUT replaces the named keys only — it is not a whole-table replace. Omitting
 * a key leaves it untouched, so two admins editing different sections of the
 * settings screen cannot wipe each other's work.
 */
router.put(
  '/settings',
  requireAdmin('owner', 'manager'),
  validate({
    body: z.object({
      settings: z.record(z.string().max(80), z.unknown()).refine(
        (s) => Object.keys(s).length > 0,
        { message: 'Send at least one setting to update.' }
      ),
    }),
  }),
  asyncHandler(async (req, res) => {
    const entries = Object.entries(req.body.settings);

    await withTransaction(async (conn) => {
      for (const [key, value] of entries) {
        await conn.execute(
          `INSERT INTO settings (key_name, value_json)
           VALUES (:key_name, CAST(:value_json AS JSON))
           ON DUPLICATE KEY UPDATE value_json = VALUES(value_json)`,
          { key_name: key, value_json: JSON.stringify(value ?? null) }
        );
      }
    });

    const [rows] = await pool.execute(
      'SELECT key_name, value_json, updated_at FROM settings ORDER BY key_name ASC'
    );
    const settings = {};
    for (const row of rows) settings[row.key_name] = parseValue(row.value_json);

    res.json({ settings, updated: entries.map(([k]) => k) });
  })
);

export default router;
