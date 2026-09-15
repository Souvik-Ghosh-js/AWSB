/**
 * pm2 process definition for the Attar World Sonar Bangla API.
 *
 * .cjs, not .js: backend/package.json declares "type": "module", so a plain .js
 * file here would be parsed as an ES module and module.exports would throw.
 *
 * Installed by deploy/install.sh; started with:
 *   pm2 start /home/<user>/awsb/deploy/ecosystem.config.cjs
 * Reloaded with zero downtime by deploy/update.sh:
 *   pm2 reload awsb-api --update-env
 */

const os = require('node:os');
const path = require('node:path');

const fs = require('node:fs');

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Two layouts, detected rather than assumed — see the same note in update.sh.
 *
 *   MONOREPO (legacy): backend/, frontend/ and admin/ are siblings one level
 *                      up from deploy/. Boxes provisioned before the repo split
 *                      still look like this on disk.
 *   SPLIT    (current): this repo IS the API; deploy/ sits beside src/. The
 *                      storefront and admin panel are separate repositories
 *                      deployed elsewhere, so only awsb-api is startable here.
 *
 * Getting this wrong is not a subtle failure: pm2 would be handed a cwd of
 * <repo>/backend that does not exist, and the API would refuse to start.
 */
const IS_MONOREPO = fs.existsSync(path.join(REPO_ROOT, 'backend', 'package.json'));

const API_DIR = IS_MONOREPO ? path.join(REPO_ROOT, 'backend') : REPO_ROOT;
const WEB_DIR = path.join(REPO_ROOT, 'frontend');
const ADMIN_DIR = path.join(REPO_ROOT, 'admin');
const LOG_DIR = path.join(os.homedir(), 'awsb-logs');

/**
 * Cluster sizing.
 *
 * One worker per vCPU is the usual advice, but this box also runs MySQL,
 * nginx and — on a 2 GB Lightsail instance — sharp and tesseract.js, both of
 * which are memory-hungry. Each Node worker costs roughly 80-120 MB at rest
 * and considerably more mid-OCR. So: one worker per CPU, but never more than
 * 2 on a machine with under 4 GB of RAM, or the workers fight each other for
 * memory and the OOM killer starts reaping them.
 *
 * Override explicitly with PM2_INSTANCES if you know better for your box.
 */
function instanceCount() {
  const override = Number.parseInt(process.env.PM2_INSTANCES ?? '', 10);
  if (Number.isInteger(override) && override > 0) return override;

  const cpus = os.cpus()?.length || 1;
  const totalGb = os.totalmem() / 1024 ** 3;

  if (totalGb < 1.5) return 1;
  if (totalGb < 4) return Math.min(cpus, 2);
  return cpus;
}

module.exports = {
  apps: [
    {
      name: 'awsb-api',
      cwd: API_DIR,
      script: 'src/server.js',

      // Cluster mode: pm2 load-balances across workers on the same port and
      // can restart them one at a time, which is what makes `pm2 reload` a
      // zero-downtime operation.
      exec_mode: 'cluster',
      instances: instanceCount(),

      env: {
        NODE_ENV: 'production',
        // PORT also lives in backend/.env; this is belt and braces so the process
        // cannot come up on the dev default if .env is ever mangled.
        PORT: 4000,
      },

      // --- Restarts -------------------------------------------------------
      // A worker that creeps past this is restarted. sharp and tesseract.js
      // both leak native memory slowly under sustained load; this bounds it
      // rather than waiting for the kernel OOM killer, which would take the
      // whole box down instead of one worker.
      max_memory_restart: '400M',

      autorestart: true,
      // Crash-loop guard: after 10 failed restarts pm2 gives up rather than
      // hammering a broken deploy forever. Check `pm2 logs` when this trips.
      max_restarts: 10,
      min_uptime: '20s',
      restart_delay: 2000,
      exp_backoff_restart_delay: 200,

      // --- Graceful shutdown ----------------------------------------------
      // On reload pm2 sends SIGINT, waits for the process to say it is ready
      // to die, then SIGKILLs after kill_timeout. The API must close the HTTP
      // server and drain the MySQL pool inside that window, or an in-flight
      // payment write can be cut mid-transaction.
      kill_timeout: 8000,
      listen_timeout: 10000,

      // MUST stay false unless backend/src/server.js is changed to call
      // process.send('ready') inside its app.listen() callback.
      //
      // wait_ready:true makes pm2 hold each worker in a "launching" state
      // until the process sends that message. server.js does not send it, so
      // turning this on would make pm2 time out after listen_timeout, mark
      // every worker failed, and crash-loop the API — while the app itself is
      // actually healthy and listening. Verified against the current
      // server.js, which handles SIGTERM/SIGINT but never calls process.send.
      //
      // Reloads are still zero-downtime without it: pm2 replaces workers one
      // at a time and the old worker keeps serving until the new one binds.
      wait_ready: false,
      shutdown_with_message: false,

      // --- Logs -----------------------------------------------------------
      error_file: path.join(LOG_DIR, 'api-error.log'),
      out_file: path.join(LOG_DIR, 'api-out.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      // The app logs structured JSON via pino; let pino own the format and do
      // not let pm2 wrap it in a second timestamp on the raw stream.
      time: false,

      // Never let pm2 watch files in production — an editor writing a temp
      // file would restart the payment API.
      watch: false,
    },

    // -------------------------------------------------------------------
    // OPTIONAL storefront, only when Next.js runs on this same box.
    // Start it explicitly:  pm2 start ecosystem.config.cjs --only awsb-web
    // install.sh does this automatically when run with --with-web.
    // -------------------------------------------------------------------
    {
      name: 'awsb-web',
      cwd: WEB_DIR,
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3000',

      // Next.js is kept in fork mode with a single instance. Its own server
      // is already efficient, and a second copy on a 2 GB box competes with
      // the API workers for memory for very little gain.
      exec_mode: 'fork',
      instances: 1,

      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },

      max_memory_restart: '500M',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '20s',
      kill_timeout: 8000,
      wait_ready: false,

      error_file: path.join(LOG_DIR, 'web-error.log'),
      out_file: path.join(LOG_DIR, 'web-out.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      watch: false,
    },

    // -------------------------------------------------------------------
    // Admin panel — a SEPARATE Next.js app on its own subdomain.
    // Start it explicitly:  pm2 start ecosystem.config.cjs --only awsb-admin
    //
    // Kept apart from the storefront on purpose: an XSS bug in the shop
    // cannot reach an admin token held on a different origin, and customers
    // never download the admin bundle.
    // -------------------------------------------------------------------
    {
      name: 'awsb-admin',
      cwd: ADMIN_DIR,
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3001',

      exec_mode: 'fork',
      instances: 1,

      env: {
        NODE_ENV: 'production',
        PORT: 3001,
      },

      // Lower ceiling than the storefront: a handful of staff, not the public.
      max_memory_restart: '350M',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '20s',
      kill_timeout: 8000,
      wait_ready: false,

      error_file: path.join(LOG_DIR, 'admin-error.log'),
      out_file: path.join(LOG_DIR, 'admin-out.log'),
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      watch: false,
    },
  ],
};

// In the split layout frontend/ and admin/ are not on this box at all, so
// advertising awsb-web and awsb-admin would let a stray
// `pm2 start ecosystem.config.cjs` try to launch two apps whose cwd does not
// exist. Only offer what can actually run.
if (!IS_MONOREPO) {
  module.exports.apps = module.exports.apps.filter((app) => app.name === 'awsb-api');
}
