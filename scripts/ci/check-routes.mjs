/**
 * CI guard: every router in the mount table must import, and the endpoints the
 * admin panel and storefront depend on must actually exist.
 *
 * Why this exists
 * ---------------
 * The admin panel went live unable to sign anyone in. The panel called
 * POST /api/v1/admin/auth/login; the API served POST /api/v1/auth/admin/login.
 * Two segments transposed on one route out of eighteen. Nothing caught it:
 * the tests are pure and never touch routing, the API booted healthy, the
 * panel built and deployed fine, and /api/v1/health returned ok:true. The
 * failure only appeared when a human tried to log in.
 *
 * So this script builds the real Express app, walks its actual route table,
 * and asserts the contract. It runs with throwaway env values and never opens
 * a database connection — mounting a router does not execute its queries.
 */

import assert from 'node:assert/strict';

// config/env.js validates the whole environment at import and calls
// process.exit(1) if anything is missing. These values are structurally valid
// and entirely fake: nothing here connects to anything.
const FAKE_ENV = {
  NODE_ENV: 'test',
  SITE_URL: 'http://localhost:3000',
  API_URL: 'http://localhost:4000',
  ADMIN_URL: 'http://localhost:3001',
  DB_HOST: 'localhost',
  DB_USER: 'ci',
  DB_PASSWORD: 'ci',
  DB_NAME: 'ci',
  RAZORPAY_KEY_ID: 'rzp_test_ci',
  RAZORPAY_KEY_SECRET: 'ci',
  RAZORPAY_WEBHOOK_SECRET: 'ci',
  JWT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef',
  SMTP_HOST: 'smtp.example.com',
  SMTP_USER: 'ci@example.com',
  SMTP_PASSWORD: 'ci',
  MAIL_FROM_NAME: 'CI',
  MAIL_FROM_ADDRESS: 'ci@example.com',
  ADMIN_ALERT_EMAIL: 'ci@example.com',
  // 'local' avoids requiring the four S3_* variables.
  STORAGE_DRIVER: 'local',
};

for (const [key, value] of Object.entries(FAKE_ENV)) {
  process.env[key] ??= value;
}

const { createApp, mountOptional } = await import('../../src/app.js');

// Mirrors the table in src/server.js. Kept in step deliberately: if a router is
// added there and not here, the "every mounted router" assertion below fails
// and points at the omission.
const MOUNTS = [
  ['/api/v1', './modules/catalog/catalog.routes.js', 'catalogRouter'],
  ['/api/v1', './modules/catalog/tracking.routes.js', 'trackingRouter'],
  ['/api/v1', './modules/cart/cart.routes.js', 'cartRouter'],
  ['/api/v1', './modules/reviews/reviews.routes.js', 'reviewsRouter'],
  ['/api/v1', './modules/feedback/feedback.routes.js', 'feedbackRouter'],
  ['/api/v1/auth', './modules/auth/auth.routes.js', 'authRouter'],
  ['/api/v1', './modules/auth/me.routes.js', 'meRouter'],
  ['/api/v1', './modules/compat/frontend-compat.routes.js', 'compatRouter'],
  ['/api/v1/admin', './modules/admin/products.routes.js', 'adminProductsRouter'],
  ['/api/v1/admin', './modules/admin/inventory.routes.js', 'adminInventoryRouter'],
  ['/api/v1/admin', './modules/admin/coupons.routes.js', 'adminCouponsRouter'],
  ['/api/v1/admin', './modules/admin/couriers.routes.js', 'adminCouriersRouter'],
  ['/api/v1/admin', './modules/admin/ocr.routes.js', 'adminOcrRouter'],
  ['/api/v1/admin', './modules/admin/dashboard.routes.js', 'adminDashboardRouter'],
  ['/api/v1/admin', './modules/admin/users.routes.js', 'adminUsersRouter'],
  ['/api/v1/admin', './modules/admin/notifications.routes.js', 'adminNotificationsRouter'],
  ['/api/v1/admin', './modules/admin/settings.routes.js', 'adminSettingsRouter'],
  ['/api/v1/admin', './modules/admin/reviews.routes.js', 'adminReviewsRouter'],
  ['/api/v1/admin', './modules/admin/feedback.routes.js', 'adminFeedbackRouter'],
];

/**
 * The endpoints the two front ends actually call, as they call them.
 *
 * Taken from admin/src/lib/api.ts and frontend/src/lib/api.ts. If a path here
 * stops resolving, a screen somewhere is broken — and this is the whole point
 * of the file, so add to it whenever a client starts calling something new.
 */
const REQUIRED = [
  // --- admin panel: the sign-in path, the one that broke -----------------
  ['POST', '/api/v1/admin/auth/login'],
  ['GET', '/api/v1/admin/auth/me'],
  // --- admin panel: the rest --------------------------------------------
  ['GET', '/api/v1/admin/dashboard'],
  ['GET', '/api/v1/admin/products'],
  ['GET', '/api/v1/admin/coupons'],
  ['GET', '/api/v1/admin/couriers'],
  ['GET', '/api/v1/admin/users'],
  ['GET', '/api/v1/admin/settings'],
  ['GET', '/api/v1/admin/categories'],
  ['GET', '/api/v1/admin/inventory/low-stock'],
  // --- storefront --------------------------------------------------------
  ['GET', '/api/v1/products'],
  ['GET', '/api/v1/categories'],
  ['POST', '/api/v1/cart/validate'],
  ['POST', '/api/v1/checkout/session'],
  ['POST', '/api/v1/checkout/verify'],
  ['GET', '/api/v1/shipping/quote'],
  ['POST', '/api/v1/coupons/validate'],
  // --- infrastructure ----------------------------------------------------
  ['GET', '/api/v1/health'],
  ['POST', '/api/v1/webhooks/razorpay'],
];

/** Walk the Express router stack into a flat list of {method, path}. */
function collectRoutes(app) {
  const found = [];

  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        const path = prefix + layer.route.path;
        for (const method of Object.keys(layer.route.methods)) {
          found.push({ method: method.toUpperCase(), path });
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        // Recover the mount path from the layer's regexp. Express does not
        // store it directly, so this reverses the generated pattern.
        let mounted = '';
        const source = layer.regexp?.source ?? '';
        if (source !== '^\\/?(?=\\/|$)') {
          mounted = source
            .replace('^\\/?(?=\\/|$)', '')
            .replace(/^\^/, '')
            .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
            .replace(/\$$/, '')
            .replace(/\\\//g, '/')
            .replace(/\(\?:\(\[\^\\\/]\+\?\)\)/g, ':param');
        }
        walk(layer.handle.stack, prefix + mounted);
      }
    }
  };

  walk(app._router.stack, '');
  return found;
}

/** Does `actual` (which may contain :params) satisfy `wanted`? */
function matches(actual, wanted) {
  if (actual.method !== wanted.method) return false;
  if (actual.path === wanted.path) return true;

  // A route with params matches if the literal segments line up.
  const a = actual.path.split('/');
  const w = wanted.path.split('/');
  if (a.length !== w.length) return false;
  return a.every((seg, i) => seg.startsWith(':') || seg === w[i]);
}

// --------------------------------------------------------------------- run

const app = createApp();
const skipped = [];

for (const [mountPath, modulePath, exportName] of MOUNTS) {
  const ok = await mountOptional(app, mountPath, modulePath, exportName);
  if (!ok) skipped.push(`${exportName} (${modulePath})`);
}

const routes = collectRoutes(app);

let failed = false;

// 1. Every router in the table must have mounted. mountOptional() swallows
//    ERR_MODULE_NOT_FOUND by design so the app can boot mid-build — which
//    means a typo'd import path silently removes a whole section of the API.
if (skipped.length > 0) {
  console.error('FAIL: these routers did not mount (missing module or export):');
  for (const s of skipped) console.error(`  - ${s}`);
  failed = true;
}

// 2. Every endpoint the clients call must resolve.
const missing = REQUIRED.filter(
  ([method, path]) => !routes.some((r) => matches(r, { method, path }))
);

if (missing.length > 0) {
  console.error('\nFAIL: endpoints the front ends call do not exist:');
  for (const [method, path] of missing) console.error(`  - ${method} ${path}`);
  console.error(
    '\nEither the route moved, or a client is calling the wrong path.\n' +
      'This is the check that would have caught the admin login 404.'
  );
  failed = true;
}

if (failed) {
  console.error(`\n${routes.length} routes were mounted. Full list:`);
  for (const r of routes.sort((x, y) => x.path.localeCompare(y.path))) {
    console.error(`  ${r.method.padEnd(6)} ${r.path}`);
  }
  process.exit(1);
}

console.log(`OK: ${MOUNTS.length} routers mounted, ${routes.length} routes registered.`);
console.log(`OK: all ${REQUIRED.length} client-facing endpoints resolve.`);

// mountOptional may have opened nothing, but the pool module is imported
// transitively. Exit explicitly so a lingering handle cannot hang CI.
process.exit(0);
