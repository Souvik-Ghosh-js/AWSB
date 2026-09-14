import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { env, isProd } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { healthcheck } from './db/pool.js';

// Routers
import { webhookRouter } from './modules/payments/webhook.routes.js';
import { checkoutRouter } from './modules/checkout/checkout.routes.js';
import { adminOrdersRouter } from './modules/orders/orders.routes.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1); // behind nginx
  app.disable('x-powered-by');

  app.use(
    pinoHttp({
      level: isProd ? 'info' : 'debug',
      transport: isProd ? undefined : { target: 'pino-pretty', options: { colorize: true } },
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body.password'],
    })
  );

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

  app.use(
    cors({
      origin: [env.SITE_URL, ...(isProd ? [] : ['http://localhost:3000'])],
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    })
  );

  // ------------------------------------------------------------------
  // The Razorpay webhook MUST be mounted before express.json().
  // Its signature is verified over the exact bytes Razorpay sent, and a global
  // JSON parser would consume the stream and make those bytes unrecoverable.
  // This ordering is load-bearing — do not move it below.
  // ------------------------------------------------------------------
  app.use('/api/v1/webhooks', webhookRouter);

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());

  app.use(
    '/api/v1',
    rateLimit({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' } },
    })
  );

  app.get('/api/v1/health', async (req, res) => {
    const db = await healthcheck().catch(() => false);
    res.status(db ? 200 : 503).json({ ok: db, service: 'awsb-api', db });
  });

  if (env.STORAGE_DRIVER === 'local') {
    app.use('/uploads', express.static('uploads', { maxAge: '1y', immutable: true }));
  }

  app.use('/api/v1/checkout', checkoutRouter);
  app.use('/api/v1/admin/orders', adminOrdersRouter);

  // Routers written by other modules are mounted here as they land:
  //   /api/v1/products, /api/v1/cart, /api/v1/reviews, /api/v1/feedback,
  //   /api/v1/auth, /api/v1/me, /api/v1/admin/*
  // See mountOptional() below.

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * Mount a router only if its module exists. Lets the app boot while sibling
 * modules are still being written, instead of crashing on a missing import.
 */
export async function mountOptional(app, mountPath, modulePath, exportName) {
  try {
    const mod = await import(modulePath);
    // Modules use either a named export or `export default`; accept both so a
    // router is never silently left unmounted.
    const router = (exportName && mod[exportName]) ?? mod.default;
    if (router) {
      // Insert before the 404/error handlers, which are always last two.
      const stack = app._router.stack;
      const tail = stack.splice(stack.length - 2, 2);
      app.use(mountPath, router);
      stack.push(...tail);
      return true;
    }
  } catch (err) {
    if (err.code !== 'ERR_MODULE_NOT_FOUND') throw err;
  }
  return false;
}
