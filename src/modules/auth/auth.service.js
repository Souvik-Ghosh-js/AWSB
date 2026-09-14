import crypto from 'node:crypto';
import argon2 from 'argon2';
import { pool, withTransaction } from '../../db/pool.js';
import { ApiError } from '../../middleware/error.js';
import { signCustomerToken, signAdminToken } from '../../middleware/auth.js';
import { sendMail } from '../../services/mail/mailer.js';
import { env } from '../../config/env.js';

// Password reset tokens are stored hashed. A leaked database must not hand an
// attacker working reset links.
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function registerCustomer({ email, password, fullName, phone }) {
  const [[existing]] = await pool.query('SELECT id, password_hash FROM customers WHERE email = ?', [email]);

  // Guest checkout creates customer rows with a NULL password_hash. Claiming
  // such a row is an upgrade, not a duplicate signup.
  if (existing && existing.password_hash) {
    throw ApiError.conflict('An account with this email already exists. Try signing in.', 'EMAIL_TAKEN');
  }

  const hash = await argon2.hash(password, { type: argon2.argon2id });

  if (existing) {
    await pool.query(
      'UPDATE customers SET password_hash = ?, full_name = COALESCE(?, full_name), phone = COALESCE(?, phone) WHERE id = ?',
      [hash, fullName ?? null, phone ?? null, existing.id]
    );
    const [[row]] = await pool.query('SELECT id, email, full_name FROM customers WHERE id = ?', [existing.id]);
    return { token: signCustomerToken(row), customer: row };
  }

  const [result] = await pool.query(
    'INSERT INTO customers (email, password_hash, full_name, phone) VALUES (?, ?, ?, ?)',
    [email, hash, fullName ?? null, phone ?? null]
  );
  const customer = { id: Number(result.insertId), email, full_name: fullName ?? null };
  return { token: signCustomerToken(customer), customer };
}

export async function loginCustomer({ email, password }) {
  const [[row]] = await pool.query(
    'SELECT id, email, full_name, password_hash FROM customers WHERE email = ? LIMIT 1',
    [email]
  );

  // Same message whether the email is unknown or the password is wrong, so
  // this endpoint cannot be used to enumerate customers.
  const invalid = ApiError.unauthorized('Email or password is incorrect.', 'BAD_CREDENTIALS');
  if (!row?.password_hash) {
    // Spend comparable time so a missing account is not detectable by timing.
    await argon2.hash(password, { type: argon2.argon2id }).catch(() => {});
    throw invalid;
  }

  const ok = await argon2.verify(row.password_hash, password).catch(() => false);
  if (!ok) throw invalid;

  const customer = { id: Number(row.id), email: row.email, full_name: row.full_name };
  return { token: signCustomerToken(customer), customer };
}

export async function loginAdmin({ email, password }) {
  const [[row]] = await pool.query(
    'SELECT id, email, full_name, role, is_active, password_hash FROM admin_users WHERE email = ? LIMIT 1',
    [email]
  );

  const invalid = ApiError.unauthorized('Email or password is incorrect.', 'BAD_CREDENTIALS');
  if (!row) {
    await argon2.hash(password, { type: argon2.argon2id }).catch(() => {});
    throw invalid;
  }

  const ok = await argon2.verify(row.password_hash, password).catch(() => false);
  if (!ok) throw invalid;

  if (!row.is_active) {
    throw ApiError.forbidden('This account has been deactivated.', 'ACCOUNT_INACTIVE');
  }

  await pool.query('UPDATE admin_users SET last_login_at = UTC_TIMESTAMP() WHERE id = ?', [row.id]);

  const admin = { id: Number(row.id), email: row.email, fullName: row.full_name, role: row.role };
  return { token: signAdminToken({ ...admin, role: row.role }), admin };
}

/**
 * Always reports success, whether or not the email exists — otherwise this is
 * an account-enumeration oracle.
 */
export async function requestPasswordReset(email) {
  const [[row]] = await pool.query('SELECT id, email, full_name FROM customers WHERE email = ? LIMIT 1', [email]);
  if (!row) return { sent: true };

  const token = crypto.randomBytes(32).toString('hex');

  await withTransaction(async (conn) => {
    await conn.query(
      `INSERT INTO settings (key_name, value_json)
       VALUES (?, JSON_OBJECT('customer_id', ?, 'expires_at', DATE_FORMAT(UTC_TIMESTAMP() + INTERVAL 1 HOUR, '%Y-%m-%dT%H:%i:%sZ')))
       ON DUPLICATE KEY UPDATE value_json = VALUES(value_json)`,
      [`pwreset:${hashToken(token)}`, row.id]
    );
  });

  await sendMail({
    to: row.email,
    template: 'passwordReset',
    subject: 'Reset your password',
    data: { args: [row, `${env.SITE_URL}/reset-password?token=${token}`] },
  });

  return { sent: true };
}

export async function resetPassword({ token, password }) {
  const key = `pwreset:${hashToken(token)}`;
  const [[row]] = await pool.query('SELECT value_json FROM settings WHERE key_name = ? LIMIT 1', [key]);

  const invalid = ApiError.badRequest('This reset link is invalid or has expired.', 'RESET_INVALID');
  if (!row) throw invalid;

  const payload = typeof row.value_json === 'string' ? JSON.parse(row.value_json) : row.value_json;
  if (!payload?.customer_id || new Date(payload.expires_at) < new Date()) {
    await pool.query('DELETE FROM settings WHERE key_name = ?', [key]);
    throw invalid;
  }

  const hash = await argon2.hash(password, { type: argon2.argon2id });
  await pool.query('UPDATE customers SET password_hash = ? WHERE id = ?', [hash, payload.customer_id]);
  // Single use.
  await pool.query('DELETE FROM settings WHERE key_name = ?', [key]);

  return { reset: true };
}

export async function getMe(customerId) {
  const [[customer]] = await pool.query(
    'SELECT id, email, full_name, phone, marketing_opt_in, created_at FROM customers WHERE id = ?',
    [customerId]
  );
  if (!customer) throw ApiError.notFound('Account not found.');
  return customer;
}

export async function listMyOrders(customerId, { page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;
  const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM orders WHERE customer_id = ?', [customerId]);
  const [items] = await pool.query(
    `SELECT id, order_number, status, payment_status, total_paise,
            created_at, placed_at, shipped_at, delivered_at
       FROM orders WHERE customer_id = ?
      ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [customerId, limit, offset]
  );
  return { items, page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) };
}
