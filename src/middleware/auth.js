import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { ApiError } from './error.js';
import { pool } from '../db/pool.js';

const ROLE_RANK = { staff: 1, manager: 2, owner: 3 };

function readToken(req) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  return req.cookies?.token ?? null;
}

export function signCustomerToken(customer) {
  return jwt.sign(
    { sub: String(customer.id), email: customer.email, kind: 'customer' },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN }
  );
}

export function signAdminToken(admin) {
  return jwt.sign(
    { sub: String(admin.id), email: admin.email, role: admin.role, kind: 'admin' },
    env.JWT_SECRET,
    { expiresIn: env.ADMIN_JWT_EXPIRES_IN }
  );
}

function verify(token) {
  try {
    return jwt.verify(token, env.JWT_SECRET);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw ApiError.unauthorized('Your session has expired. Please sign in again.', 'TOKEN_EXPIRED');
    }
    throw ApiError.unauthorized('Invalid session. Please sign in again.', 'TOKEN_INVALID');
  }
}

/** Populates req.customer when a valid customer token is present; never rejects. */
export function optionalCustomer(req, res, next) {
  const token = readToken(req);
  if (!token) return next();
  try {
    const payload = verify(token);
    if (payload.kind === 'customer') {
      req.customer = { id: Number(payload.sub), email: payload.email };
    }
  } catch {
    // Guest checkout is supported, so a bad token is simply ignored here.
  }
  next();
}

export function requireCustomer(req, res, next) {
  const token = readToken(req);
  if (!token) return next(ApiError.unauthorized());
  try {
    const payload = verify(token);
    if (payload.kind !== 'customer') return next(ApiError.forbidden());
    req.customer = { id: Number(payload.sub), email: payload.email };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Admin gate. Re-checks the database on every request rather than trusting the
 * token alone, so deactivating an account takes effect immediately instead of
 * whenever their token happens to expire.
 */
export function requireAdmin(...allowedRoles) {
  return async (req, res, next) => {
    const token = readToken(req);
    if (!token) return next(ApiError.unauthorized());

    try {
      const payload = verify(token);
      if (payload.kind !== 'admin') return next(ApiError.forbidden());

      const [rows] = await pool.query(
        'SELECT id, email, full_name, role, is_active FROM admin_users WHERE id = ? LIMIT 1',
        [payload.sub]
      );
      const admin = rows[0];

      if (!admin || !admin.is_active) {
        return next(ApiError.forbidden('This account is no longer active.', 'ACCOUNT_INACTIVE'));
      }

      if (allowedRoles.length > 0) {
        const need = Math.min(...allowedRoles.map((r) => ROLE_RANK[r] ?? 99));
        if ((ROLE_RANK[admin.role] ?? 0) < need) {
          return next(ApiError.forbidden('You need a higher access level for this.'));
        }
      }

      req.admin = {
        id: Number(admin.id),
        email: admin.email,
        fullName: admin.full_name,
        role: admin.role,
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}
