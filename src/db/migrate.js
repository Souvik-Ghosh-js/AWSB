// Minimal forward-only migration runner.
// Applies every .sql file in migrations/ in filename order, exactly once,
// tracked in a _migrations table. No rollback: on a live shop, forward fixes
// are safer than automated down-migrations.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
// DB credentials only — this runs before payment/SMTP secrets exist on a new box.
import { dbEnv as env } from '../config/db-env.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, 'migrations');

async function main() {
  // multipleStatements is needed because each migration file holds many
  // CREATE TABLEs. It is enabled ONLY here, never on the app pool, since the
  // app pool handles user input and this one does not.
  const conn = await mysql.createConnection({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    multipleStatements: true,
  });

  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name       VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const [applied] = await conn.query('SELECT name FROM _migrations');
    const done = new Set(applied.map((r) => r.name));

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const pending = files.filter((f) => !done.has(f));

    if (pending.length === 0) {
      console.log('No pending migrations.');
      return;
    }

    for (const file of pending) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      process.stdout.write(`Applying ${file} ... `);
      try {
        await conn.query(sql);
        await conn.query('INSERT INTO _migrations (name) VALUES (?)', [file]);
        console.log('ok');
      } catch (err) {
        console.log('FAILED');
        console.error(`\n${file}: ${err.message}\n`);
        // DDL in MySQL auto-commits, so a partially applied file cannot be
        // rolled back. Stop immediately so the failure is obvious rather than
        // cascading into later migrations.
        process.exitCode = 1;
        return;
      }
    }

    console.log(`Applied ${pending.length} migration(s).`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
