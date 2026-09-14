import 'dotenv/config';
import { z } from 'zod';

// Database credentials ONLY.
//
// migrate.js and seed.js run on a fresh Lightsail box before the owner has any
// Razorpay keys or a Gmail App Password. Importing the full env.js there would
// demand those secrets and exit(1), so the one-command installer could never
// create the schema. Worse, the workaround is to write REPLACE_ME placeholders
// into a production .env — and a forgotten placeholder means payments that
// silently fail rather than an error at boot.
//
// So the schema tools validate only what they actually use. The API server
// still imports the full env.js and still refuses to start without every
// secret, which is exactly where that check belongs.

const schema = z.object({
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string(),
  DB_NAME: z.string().min(1),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`Cannot reach the database — missing configuration:\n${issues}\n`);
  console.error('Set DB_HOST, DB_USER, DB_PASSWORD and DB_NAME in .env, then try again.');
  process.exit(1);
}

export const dbEnv = parsed.data;
