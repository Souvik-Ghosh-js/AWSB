// Seed runner. Unlike migrations, seeds are safe to re-run: every insert in
// seeds/*.sql uses ON DUPLICATE KEY UPDATE or a NOT EXISTS guard.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
// DB credentials only — see db-env.js for why this is not the full env.
import { dbEnv as env } from '../config/db-env.js';

const here = dirname(fileURLToPath(import.meta.url));
const SEEDS_DIR = join(here, 'seeds');

async function main() {
  const conn = await mysql.createConnection({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    multipleStatements: true,
  });

  try {
    const files = (await readdir(SEEDS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      const sql = await readFile(join(SEEDS_DIR, file), 'utf8');
      process.stdout.write(`Seeding ${file} ... `);
      await conn.query(sql);
      console.log('ok');
    }

    const [[zones]] = await conn.query('SELECT COUNT(*) AS n FROM shipping_zones');
    const [[couriers]] = await conn.query('SELECT COUNT(*) AS n FROM couriers');
    console.log(`Done. ${zones.n} shipping zone(s), ${couriers.n} courier(s).`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
