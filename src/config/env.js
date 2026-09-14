import 'dotenv/config';
import { z } from 'zod';

// Validate the whole environment once, at boot. A missing secret should stop
// the process immediately with a readable message, not surface as a failed
// payment or an unsigned webhook hours later.

const bool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  SITE_URL: z.string().url(),
  API_URL: z.string().url(),

  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string(),
  DB_NAME: z.string().min(1),
  DB_CONNECTION_LIMIT: z.coerce.number().int().positive().default(10),

  RAZORPAY_KEY_ID: z.string().startsWith('rzp_'),
  RAZORPAY_KEY_SECRET: z.string().min(1),
  // Deliberately a separate value: the webhook secret is set in the Razorpay
  // dashboard and is NOT the API key secret. Reusing the key secret here makes
  // every webhook signature check fail silently.
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  ADMIN_JWT_EXPIRES_IN: z.string().default('12h'),

  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_SECURE: bool.default('true'),
  SMTP_USER: z.string().email(),
  SMTP_PASSWORD: z.string().min(1),
  MAIL_FROM_NAME: z.string().min(1),
  MAIL_FROM_ADDRESS: z.string().email(),
  ADMIN_ALERT_EMAIL: z.string().email(),

  STORAGE_DRIVER: z.enum(['s3', 'local']).default('s3'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_PUBLIC_BASE_URL: z.string().url().optional(),

  RESERVATION_MINUTES: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  console.error(`Invalid environment configuration:\n${issues}\n`);
  console.error('Copy .env.example to .env and fill in the missing values.');
  process.exit(1);
}

export const env = parsed.data;

// S3 is only usable if the whole set is present — fail at boot rather than on
// the first image upload.
if (env.STORAGE_DRIVER === 's3') {
  const required = ['S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) {
    console.error(`STORAGE_DRIVER=s3 but missing: ${missing.join(', ')}`);
    process.exit(1);
  }
}

export const isProd = env.NODE_ENV === 'production';
