// The one place that actually talks to SMTP.
//
// Two rules govern everything here:
//
//   1. Sending email must NEVER fail a request. A customer who has paid has an
//      order, whether or not Gmail accepted the receipt. Every public function
//      resolves - failures are logged to email_log and reported as `false`,
//      never thrown into the caller's path.
//   2. Every send is recorded. email_log is the proof of what left the system,
//      and the row is written BEFORE the attempt, so a crash mid-send leaves a
//      'queued' row rather than no trace at all.
//
// Gmail SMTP allows roughly 500 messages a day and sends from a gmail.com
// identity. The interface here is intentionally thin so that moving to SES or
// Brevo later is a transport swap, not a rewrite.

import nodemailer from 'nodemailer';

import { env } from '../../config/env.js';
import { pool } from '../../db/pool.js';
import * as templates from './templates.js';

const MAX_ATTEMPTS = 3;

// Backoff between attempts. Short on purpose: this runs inside a request or a
// webhook handler, and a minute of retries would hold the connection open.
const BACKOFF_MS = [500, 2000];

let cachedTransport = null;

/**
 * Build (once) the Nodemailer transport.
 *
 * Lazy rather than created at import so that loading this module does not open
 * a socket, and so a bad SMTP config surfaces at send or healthcheck time with
 * a readable error instead of at import.
 */
function getTransport() {
  if (cachedTransport) return cachedTransport;

  cachedTransport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // true for 465 (implicit TLS), false for 587 (STARTTLS).
    secure: env.SMTP_SECURE,
    auth: {
      user: env.SMTP_USER,
      // A Google App Password, not the account password.
      pass: env.SMTP_PASSWORD,
    },
    // Reuse one connection across a burst (order confirmation + admin alert)
    // rather than reconnecting per message.
    pool: true,
    maxConnections: 2,
    maxMessages: 50,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  return cachedTransport;
}

/**
 * Boot healthcheck. Verifies credentials and reachability without sending.
 * Returns a result object rather than throwing, so a failing mail server
 * degrades the service instead of preventing startup.
 */
export async function verifyTransport() {
  try {
    await getTransport().verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/** Test seam: drop the cached transport so the next send rebuilds it. */
export function resetTransport() {
  if (cachedTransport?.close) {
    try {
      cachedTransport.close();
    } catch {
      // Closing a pool that never connected can throw; nothing to do about it.
    }
  }
  cachedTransport = null;
}

/**
 * Which failures are worth retrying.
 *
 * Retrying a rejected recipient or a bad password just burns the daily quota
 * and delays the caller - those are permanent until a human intervenes. 4xx
 * SMTP codes, timeouts and socket errors are transient and worth another go.
 */
function isTransient(err) {
  const code = err?.responseCode;
  if (typeof code === 'number') {
    // 5xx is a permanent rejection: bad recipient, auth failure, message refused.
    if (code >= 500) return false;
    if (code >= 400) return true;
  }

  const netCodes = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ESOCKET', 'EDNS', 'EAI_AGAIN', 'ECONNECTION'];
  if (netCodes.includes(err?.code)) return true;

  // Nodemailer's own auth failure is permanent.
  if (err?.code === 'EAUTH') return false;

  // Unknown shape: one more attempt is cheaper than a silently lost receipt.
  return true;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Insert the queued row. Returns its id, or null if logging itself failed. */
async function logQueued({ to, template, subject, orderId }) {
  try {
    const [result] = await pool.query(
      `INSERT INTO email_log (to_email, template, subject, order_id, status, attempts)
       VALUES (:to_email, :template, :subject, :order_id, 'queued', 0)`,
      {
        to_email: String(to).slice(0, 255),
        template: String(template).slice(0, 80),
        subject: String(subject).slice(0, 255),
        order_id: orderId ?? null,
      }
    );
    return result?.insertId ?? null;
  } catch (err) {
    // A logging failure must not stop the mail going out.
    console.error('[mail] could not write email_log row:', err?.message ?? err);
    return null;
  }
}

/** Update the row with the outcome. Never throws. */
async function logOutcome(id, { status, attempts, error }) {
  if (!id) return;
  try {
    await pool.query(
      `UPDATE email_log
          SET status = :status,
              attempts = :attempts,
              error = :error,
              sent_at = CASE WHEN :status = 'sent' THEN CURRENT_TIMESTAMP ELSE sent_at END
        WHERE id = :id`,
      {
        id,
        status,
        attempts,
        // TEXT column, but there is no reason to store a megabyte of stack.
        error: error ? String(error).slice(0, 2000) : null,
      }
    );
  } catch (err) {
    console.error('[mail] could not update email_log row:', err?.message ?? err);
  }
}

/**
 * Render, send and log one email.
 *
 * @param {object}  args
 * @param {string}  args.to        recipient address
 * @param {string}  args.template  a named export of templates.js
 * @param {object}  [args.data]    arguments spread into the template function
 * @param {string}  [args.subject] overrides the template's own subject
 * @param {number|string} [args.orderId] FK for email_log
 * @returns {Promise<boolean>} true if SMTP accepted the message
 */
export async function sendMail({ to, template, subject, data = {}, orderId = null }) {
  let rendered;
  let resolvedSubject = subject ?? '(no subject)';
  let logId = null;

  try {
    const fn = templates[template];
    if (typeof fn !== 'function') {
      throw new Error(`Unknown email template: ${template}`);
    }
    if (!to || String(to).trim() === '') {
      throw new Error(`No recipient for template: ${template}`);
    }

    // Templates take positional arguments; `data.args` carries them. A plain
    // object is also accepted and passed through as a single argument, which
    // keeps simple call sites readable.
    const args = Array.isArray(data?.args) ? data.args : [data];
    rendered = fn(...args);
    resolvedSubject = subject ?? rendered.subject;

    logId = await logQueued({ to, template, subject: resolvedSubject, orderId });
  } catch (err) {
    // Rendering failed: log what we can and give up. There is nothing to retry.
    const message = err?.message ?? String(err);
    console.error(`[mail] render failed for template "${template}":`, message);
    if (!logId) {
      logId = await logQueued({ to: to ?? 'unknown', template, subject: resolvedSubject, orderId });
    }
    await logOutcome(logId, { status: 'failed', attempts: 0, error: message });
    return false;
  }

  const from = `"${env.MAIL_FROM_NAME}" <${env.MAIL_FROM_ADDRESS}>`;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await getTransport().sendMail({
        from,
        to,
        subject: resolvedSubject,
        text: rendered.text,
        html: rendered.html,
        // Replies to a transactional email are real customer support requests,
        // so they go to the shop inbox.
        replyTo: env.ADMIN_ALERT_EMAIL,
      });

      await logOutcome(logId, { status: 'sent', attempts: attempt, error: null });
      return true;
    } catch (err) {
      lastError = err;
      const message = err?.message ?? String(err);

      if (!isTransient(err) || attempt === MAX_ATTEMPTS) {
        console.error(`[mail] send failed (${template} -> ${to}) after ${attempt} attempt(s):`, message);
        await logOutcome(logId, { status: 'failed', attempts: attempt, error: message });
        return false;
      }

      console.warn(`[mail] attempt ${attempt} failed (${template} -> ${to}), retrying:`, message);
      // A dead pooled connection stays dead; rebuild it before retrying.
      resetTransport();
      await sleep(BACKOFF_MS[attempt - 1] ?? 2000);
    }
  }

  // Unreachable: the loop returns on both success and exhaustion. Kept as a
  // guard so a future edit to the loop cannot silently return undefined.
  await logOutcome(logId, {
    status: 'failed',
    attempts: MAX_ATTEMPTS,
    error: lastError?.message ?? 'unknown',
  });
  return false;
}

/** Convenience wrapper for the two internal alerts. */
export async function sendAdminMail({ template, data = {}, orderId = null }) {
  return sendMail({ to: env.ADMIN_ALERT_EMAIL, template, data, orderId });
}
