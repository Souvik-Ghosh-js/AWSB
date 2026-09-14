// Releases stock held by orders that were never paid.
// Run every 10 minutes from cron: `npm run sweep`.

import { env } from '../config/env.js';
import { closePool } from '../db/pool.js';
import { releaseStaleReservations } from '../modules/checkout/reservation.service.js';

try {
  const released = await releaseStaleReservations(env.RESERVATION_MINUTES);
  if (released.length > 0) {
    console.log(`Released stock for ${released.length} unpaid order(s): ${released.join(', ')}`);
  }
} catch (err) {
  console.error('Sweeper failed:', err);
  process.exitCode = 1;
} finally {
  await closePool().catch(() => {});
}
