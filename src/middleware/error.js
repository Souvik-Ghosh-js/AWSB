import { ZodError } from 'zod';
import { isProd } from '../config/env.js';

/**
 * An error we deliberately raised and are happy to show the customer.
 * Anything else is a bug and gets a generic message in production.
 */
export class ApiError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expected = true;
  }

  static badRequest(message, code = 'BAD_REQUEST', details = null) {
    return new ApiError(400, code, message, details);
  }

  static unauthorized(message = 'Please sign in to continue.', code = 'UNAUTHORIZED') {
    return new ApiError(401, code, message);
  }

  static forbidden(message = "You don't have access to this.", code = 'FORBIDDEN') {
    return new ApiError(403, code, message);
  }

  static notFound(message = 'Not found.', code = 'NOT_FOUND') {
    return new ApiError(404, code, message);
  }

  static conflict(message, code = 'CONFLICT', details = null) {
    return new ApiError(409, code, message, details);
  }
}

/** Wrap an async route so a rejected promise reaches the error handler. */
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` },
  });
}

/** Turn a MySQL driver error into something a person can act on. */
function fromMysql(err) {
  switch (err.code) {
    case 'ER_DUP_ENTRY':
      return new ApiError(409, 'DUPLICATE', 'That already exists.');
    case 'ER_NO_REFERENCED_ROW':
    case 'ER_NO_REFERENCED_ROW_2':
      return new ApiError(400, 'INVALID_REFERENCE', 'A referenced record does not exist.');
    case 'ER_ROW_IS_REFERENCED':
    case 'ER_ROW_IS_REFERENCED_2':
      return new ApiError(409, 'IN_USE', 'This is still referenced by other records.');
    case 'ER_CHECK_CONSTRAINT_VIOLATED':
      // chk_stock_nonneg is the one that matters: the DB refused to oversell.
      return new ApiError(409, 'CONSTRAINT', 'That change is not allowed by a data rule.');
    case 'ECONNREFUSED':
    case 'PROTOCOL_CONNECTION_LOST':
      return new ApiError(503, 'DB_UNAVAILABLE', 'The service is briefly unavailable. Try again.');
    default:
      return null;
  }
}

// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg signature.
export function errorHandler(err, req, res, next) {
  let e = err;

  if (e instanceof ZodError) {
    const details = e.issues.map((i) => ({
      field: i.path.join('.'),
      message: i.message,
    }));
    e = new ApiError(400, 'VALIDATION_FAILED', 'Please check the highlighted fields.', details);
  } else if (!(e instanceof ApiError)) {
    const mapped = fromMysql(e);
    if (mapped) e = mapped;
  }

  const status = e.status ?? 500;

  if (status >= 500) {
    req.log?.error({ err, path: req.path, method: req.method }, 'unhandled error');
  } else {
    req.log?.warn({ code: e.code, path: req.path }, e.message);
  }

  res.status(status).json({
    error: {
      code: e.code ?? 'INTERNAL',
      // Never leak an internal message or stack to a customer in production.
      message:
        status >= 500 && isProd
          ? 'Something went wrong on our side. Please try again.'
          : e.message,
      ...(e.details ? { details: e.details } : {}),
      ...(isProd ? {} : { stack: status >= 500 ? err.stack : undefined }),
    },
  });
}
