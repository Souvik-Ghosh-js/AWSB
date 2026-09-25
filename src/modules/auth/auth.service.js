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

// Email OTP sign-in. No password: the code itself is the proof of the email,
// which is enough for "see my order history" — this app never stores a card
// or anything else worth a stronger gate. Reuses the same settings-table
// hashed-token trick as password reset rather than a new table for six
// short-lived rows' worth of state.
const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;

function otpKey(email) {
  return `otp:${email}`;
}

function generateOtp() {
  // crypto.randomInt is uniform, unlike Math.random() % 1_000_000.
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Always reports success whether or not sending actually happened, so this
 * is not an account-enumeration oracle — same reasoning as password reset,
 * except here EVERY email gets a code, because signing in should not require
 * having registered first (guest checkouts never did).
 */
export async function requestLoginOtp(email) {
  const code = generateOtp();
  const hash = hashToken(code);

  await pool.query(
    `INSERT INTO settings (key_name, value_json)
     VALUES (?, JSON_OBJECT(
       'hash', ?,
       'expires_at', DATE_FORMAT(UTC_TIMESTAMP() + INTERVAL ${OTP_TTL_MINUTES} MINUTE, '%Y-%m-%dT%H:%i:%sZ'),
       'attempts', 0
     ))
     ON DUPLICATE KEY UPDATE value_json = VALUES(value_json)`,
    [otpKey(email), hash]
  );

  await sendMail({
    to: email,
    template: 'loginOtp',
    subject: `${code} is your sign-in code`,
    data: { args: [code] },
  });

  return { sent: true };
}

export async function verifyLoginOtp({ email, code }) {
  const key = otpKey(email);
  const [[row]] = await pool.query('SELECT value_json FROM settings WHERE key_name = ? LIMIT 1', [key]);

  const invalid = ApiError.badRequest('That code is incorrect or has expired.', 'OTP_INVALID');
  if (!row) throw invalid;

  const payload = typeof row.value_json === 'string' ? JSON.parse(row.value_json) : row.value_json;
  if (!payload?.hash || new Date(payload.expires_at) < new Date()) {
    await pool.query('DELETE FROM settings WHERE key_name = ?', [key]);
    throw invalid;
  }

  if (payload.attempts >= OTP_MAX_ATTEMPTS) {
    await pool.query('DELETE FROM settings WHERE key_name = ?', [key]);
    throw ApiError.badRequest('Too many incorrect attempts. Request a new code.', 'OTP_LOCKED');
  }

  if (hashToken(code) !== payload.hash) {
    await pool.query(
      `UPDATE settings SET value_json = JSON_SET(value_json, '$.attempts', ?) WHERE key_name = ?`,
      [payload.attempts + 1, key]
    );
    throw invalid;
  }

  // Single use, same as a password-reset token.
  await pool.query('DELETE FROM settings WHERE key_name = ?', [key]);

  // A code that verified means this inbox is genuinely reachable at this
  // address, which is exactly what email_verified_at is for — set it here
  // even for a brand-new row, since OTP itself is the verification.
  const [[existing]] = await pool.query('SELECT id, full_name FROM customers WHERE email = ? LIMIT 1', [email]);

  let customer;
  if (existing) {
    await pool.query('UPDATE customers SET email_verified_at = COALESCE(email_verified_at, UTC_TIMESTAMP()) WHERE id = ?', [existing.id]);
    customer = { id: Number(existing.id), email, full_name: existing.full_name };
  } else {
    const [result] = await pool.query(
      'INSERT INTO customers (email, email_verified_at) VALUES (?, UTC_TIMESTAMP())',
      [email]
    );
    customer = { id: Number(result.insertId), email, full_name: null };
  }

  return { token: signCustomerToken(customer), customer };
}

export async function getMe(customerId) {
  const [[customer]] = await pool.query(
    'SELECT id, email, full_name, phone, marketing_opt_in, created_at FROM customers WHERE id = ?',
    [customerId]
  );
  if (!customer) throw ApiError.notFound('Account not found.');
  return customer;
}

// Matches orders linked to this account AND guest orders placed with the same
// email before the customer ever signed in — OTP login has no registration
// step, so "my orders" needs to include checkouts that predate the account.
export async function listMyOrders(customerId, { page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;
  const [[customer]] = await pool.query('SELECT email FROM customers WHERE id = ? LIMIT 1', [customerId]);
  if (!customer) throw ApiError.notFound('Account not found.');

  const where = 'WHERE customer_id = ? OR LOWER(ship_email) = LOWER(?)';
  const params = [customerId, customer.email];

  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM orders ${where}`, params);
  const [items] = await pool.query(
    `SELECT id, order_number, status, payment_status, total_paise,
            created_at, placed_at, shipped_at, delivered_at
       FROM orders ${where}
      ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return { items, page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) };
}

// Item-level detail for one of the customer's own orders — the list above
// deliberately stays light, but requesting a replacement needs an
// order_item_id to key off, which the list does not carry.
export async function getMyOrderDetail(customerId, orderId) {
  const [[customer]] = await pool.query('SELECT email FROM customers WHERE id = ? LIMIT 1', [customerId]);
  if (!customer) throw ApiError.notFound('Account not found.');

  const [[order]] = await pool.query(
    `SELECT id, order_number, status, payment_status, total_paise,
            created_at, placed_at, shipped_at, delivered_at
       FROM orders
      WHERE id = ? AND (customer_id = ? OR LOWER(ship_email) = LOWER(?))
      LIMIT 1`,
    [orderId, customerId, customer.email]
  );
  if (!order) throw ApiError.notFound('Order not found.');

  const [items] = await pool.query(
    `SELECT id, product_name, size_ml, size_unit, sku, unit_price_paise, quantity, line_total_paise
       FROM order_items WHERE order_id = ?`,
    [order.id]
  );

  return { ...order, items };
}
