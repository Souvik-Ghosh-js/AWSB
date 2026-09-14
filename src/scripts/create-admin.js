// Create the first admin user. Interactive so the password is never stored in
// shell history or a script file.
//   npm run create-admin

import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import argon2 from 'argon2';
import { pool, closePool } from '../db/pool.js';

const rl = readline.createInterface({ input: stdin, output: stdout });

try {
  const email = (await rl.question('Email: ')).trim().toLowerCase();
  const fullName = (await rl.question('Full name: ')).trim();
  const password = (await rl.question('Password (min 12 chars): ')).trim();

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('That is not a valid email address.');
  if (!fullName) throw new Error('Full name is required.');
  if (password.length < 12) throw new Error('Use at least 12 characters.');

  const [[existing]] = await pool.query('SELECT id FROM admin_users WHERE email = ?', [email]);
  if (existing) throw new Error(`${email} already has an admin account.`);

  const [[owner]] = await pool.query(
    "SELECT COUNT(*) AS n FROM admin_users WHERE role = 'owner' AND is_active = TRUE"
  );
  const role = Number(owner.n) === 0 ? 'owner' : 'manager';

  const hash = await argon2.hash(password, { type: argon2.argon2id });

  await pool.query(
    'INSERT INTO admin_users (email, full_name, password_hash, role) VALUES (?, ?, ?, ?)',
    [email, fullName, hash, role]
  );

  console.log(`\nCreated ${role} account for ${email}.`);
  if (role === 'owner') console.log('This is the first account, so it has owner access.');
} catch (err) {
  console.error(`\n${err.message}`);
  process.exitCode = 1;
} finally {
  rl.close();
  await closePool().catch(() => {});
}
