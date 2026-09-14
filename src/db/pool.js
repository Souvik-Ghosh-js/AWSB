import mysql from 'mysql2/promise';
import { env } from '../config/env.js';

export const pool = mysql.createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  waitForConnections: true,
  connectionLimit: env.DB_CONNECTION_LIMIT,
  queueLimit: 0,
  // Money is integer paise and never exceeds 2^53, but order/product ids are
  // BIGINT. Returning them as strings avoids silent precision loss if the
  // shop ever grows past Number.MAX_SAFE_INTEGER.
  supportBigNumbers: true,
  bigNumberStrings: true,
  // Keep DECIMAL (ocr_confidence) as a string rather than a lossy float.
  decimalNumbers: false,
  timezone: 'Z',
  dateStrings: false,
  namedPlaceholders: true,
});

/**
 * Run a function inside a transaction, releasing the connection either way.
 * Every caller that touches stock must use this — the reservation logic
 * depends on SELECT ... FOR UPDATE holding for the whole unit of work.
 */
export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      // Rollback can fail if the connection died; the original error matters more.
    }
    throw err;
  } finally {
    conn.release();
  }
}

export async function healthcheck() {
  const [rows] = await pool.query('SELECT 1 AS ok');
  // Loose compare on purpose: bigNumberStrings makes MySQL hand back "1" as a
  // string, so a strict === 1 reports a perfectly healthy database as dead.
  return Number(rows[0]?.ok) === 1;
}

export async function closePool() {
  await pool.end();
}
