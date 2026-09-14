import { createApp, mountOptional } from './app.js';
import { env } from './config/env.js';
import { closePool, healthcheck } from './db/pool.js';

const app = createApp();

// Sibling modules are mounted if present, so the server boots even while parts
// of the codebase are still landing.
const optional = [
  // Public routers also declare their own full sub-paths ('/products',
  // '/cart/validate', '/orders/track'), so they mount at the bare '/api/v1'.
  // Mounting catalog at '/api/v1/products' would yield '/api/v1/products/products'.
  ['/api/v1', './modules/catalog/catalog.routes.js', 'catalogRouter'],
  ['/api/v1', './modules/catalog/tracking.routes.js', 'trackingRouter'],
  ['/api/v1', './modules/cart/cart.routes.js', 'cartRouter'],
  ['/api/v1', './modules/reviews/reviews.routes.js', 'reviewsRouter'],
  ['/api/v1', './modules/feedback/feedback.routes.js', 'feedbackRouter'],
  ['/api/v1/auth', './modules/auth/auth.routes.js', 'authRouter'],
  ['/api/v1', './modules/auth/me.routes.js', 'meRouter'],
  // Endpoints the storefront calls that the original contract omitted:
  // GET /shipping/quote, /shipping/pincode, /admin/auth/me, /admin/categories,
  // PATCH /admin/settings/:key. Declares its own full sub-paths.
  ['/api/v1', './modules/compat/frontend-compat.routes.js', 'compatRouter'],
  // Admin routers declare their OWN full sub-paths ('/products', '/coupons',
  // '/variants/:id/stock', '/reports/sales.csv'), so every one mounts at the
  // same base. Mounting them at '/api/v1/admin/products' etc. would produce
  // '/api/v1/admin/products/products' and 404 the entire admin panel.
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

for (const [mountPath, modulePath, exportName] of optional) {
  const ok = await mountOptional(app, mountPath, modulePath, exportName);
  if (!ok) console.warn(`[boot] skipped ${mountPath} (module not present yet)`);
}

// The scan-awb alias the storefront calls is declared in the compat router
// alongside the other frontend-contract endpoints, so there is exactly one
// place to look for "routes that exist because the frontend asks for them".

const dbOk = await healthcheck().catch((err) => {
  console.error('[boot] database unreachable:', err.message);
  return false;
});
if (!dbOk) {
  console.error('[boot] refusing to start without a database. Check DB_* in .env.');
  process.exit(1);
}

const server = app.listen(env.PORT, () => {
  console.log(`[boot] awsb-api listening on :${env.PORT} (${env.NODE_ENV})`);
});

// Graceful shutdown so pm2 reloads don't drop in-flight payments.
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received, draining…`);
    server.close(async () => {
      await closePool().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 15_000).unref();
  });
}

process.on('unhandledRejection', (err) => {
  console.error('[fatal] unhandled rejection:', err);
});
