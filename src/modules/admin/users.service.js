import argon2 from 'argon2';

import { pool, withTransaction } from '../../db/pool.js';
import { ApiError } from '../../middleware/error.js';
import { canModifyAdmin, countActiveOwners } from './helpers/owner-guard.js';

// Admin user accounts.
//
// password_hash NEVER appears in a response. Every read goes through the
// explicit column list below rather than SELECT *, so adding a column later
// cannot accidentally start leaking the hash.

const SAFE_FIELDS = `
  id, email, full_name, role, is_active, last_login_at, created_at
`;

// argon2id with deliberately chosen parameters: the default argon2i is weaker
// against GPU attack, and the id variant is what the schema comment specifies.
const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB — OWASP's floor for argon2id
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plain) {
  return argon2.hash(plain, HASH_OPTIONS);
}

export async function listUsers({ includeInactive = true } = {}) {
  const [rows] = await pool.execute(
    `SELECT ${SAFE_FIELDS} FROM admin_users
      ${includeInactive ? '' : 'WHERE is_active = TRUE'}
      ORDER BY FIELD(role, 'owner', 'manager', 'staff'), full_name ASC`
  );
  return rows;
}

export async function getUser(id) {
  const [rows] = await pool.execute(
    `SELECT ${SAFE_FIELDS} FROM admin_users WHERE id = :id LIMIT 1`,
    { id }
  );
  if (!rows[0]) throw new ApiError(404, 'Admin user not found.');
  return rows[0];
}

export async function createUser(input) {
  const email = String(input.email).trim().toLowerCase();

  const [existing] = await pool.execute(
    'SELECT id FROM admin_users WHERE email = :email LIMIT 1',
    { email }
  );
  if (existing[0]) throw new ApiError(409, `An admin with the email ${email} already exists.`);

  const passwordHash = await hashPassword(input.password);

  const [result] = await pool.execute(
    `INSERT INTO admin_users (email, full_name, password_hash, role, is_active)
     VALUES (:email, :full_name, :password_hash, :role, :is_active)`,
    {
      email,
      full_name: input.full_name,
      password_hash: passwordHash,
      role: input.role ?? 'staff',
      is_active: input.is_active ?? true,
    }
  );

  return getUser(String(result.insertId));
}

/**
 * Update an admin.
 *
 * Role and is_active changes run through the last-owner guard inside a
 * transaction: the owner count must be read under a lock, or two concurrent
 * demotions can each see two owners and both succeed, leaving zero.
 */
export async function updateUser(id, input) {
  return withTransaction(async (conn) => {
    const [targetRows] = await conn.execute(
      `SELECT id, email, role, is_active FROM admin_users WHERE id = :id FOR UPDATE`,
      { id }
    );
    const target = targetRows[0];
    if (!target) throw new ApiError(404, 'Admin user not found.');

    const touchesOwnership = input.role !== undefined || input.is_active !== undefined;
    if (touchesOwnership) {
      const [owners] = await conn.execute(
        `SELECT id, role, is_active FROM admin_users WHERE role = 'owner' FOR UPDATE`
      );
      const guard = canModifyAdmin(
        target,
        { role: input.role, is_active: input.is_active },
        countActiveOwners(owners)
      );
      if (!guard.allowed) throw new ApiError(409, guard.reason);
    }

    const sets = [];
    const params = { id };

    for (const key of ['full_name', 'role', 'is_active']) {
      if (input[key] !== undefined) {
        sets.push(`${key} = :${key}`);
        params[key] = input[key];
      }
    }
    if (input.email !== undefined) {
      sets.push('email = :email');
      params.email = String(input.email).trim().toLowerCase();
    }
    if (input.password !== undefined) {
      sets.push('password_hash = :password_hash');
      params.password_hash = await hashPassword(input.password);
    }

    if (sets.length) {
      try {
        await conn.execute(`UPDATE admin_users SET ${sets.join(', ')} WHERE id = :id`, params);
      } catch (err) {
        if (err?.code === 'ER_DUP_ENTRY') {
          throw new ApiError(409, 'Another admin already uses that email address.');
        }
        throw err;
      }
    }

    const [updated] = await conn.execute(
      `SELECT ${SAFE_FIELDS} FROM admin_users WHERE id = :id`,
      { id }
    );
    return updated[0];
  });
}

/**
 * Delete an admin. Refused for the last active owner — locking every owner out
 * of the panel can only be undone with direct database access.
 */
export async function deleteUser(id, { actorId = null } = {}) {
  if (String(actorId) === String(id)) {
    throw new ApiError(409, 'You cannot delete your own account.');
  }

  return withTransaction(async (conn) => {
    const [targetRows] = await conn.execute(
      'SELECT id, email, role, is_active FROM admin_users WHERE id = :id FOR UPDATE',
      { id }
    );
    const target = targetRows[0];
    if (!target) throw new ApiError(404, 'Admin user not found.');

    const [owners] = await conn.execute(
      `SELECT id, role, is_active FROM admin_users WHERE role = 'owner' FOR UPDATE`
    );
    const guard = canModifyAdmin(target, { action: 'delete' }, countActiveOwners(owners));
    if (!guard.allowed) throw new ApiError(409, guard.reason);

    // audit_log.actor_id, refunds.initiated_by, shipments.created_by and
    // inventory_movements.actor_id are all ON DELETE SET NULL, and audit_log
    // keeps a denormalised actor_email, so history survives the deletion.
    await conn.execute('DELETE FROM admin_users WHERE id = :id', { id });
    return { id: String(id), deleted: true };
  });
}
