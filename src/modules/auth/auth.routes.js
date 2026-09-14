import express from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../../middleware/error.js';
import { validate, emailSchema, phoneSchema } from '../../middleware/validate.js';
import {
  registerCustomer, loginCustomer, loginAdmin,
  requestPasswordReset, resetPassword,
} from './auth.service.js';

const router = express.Router();

// Credential endpoints get their own tight limit, independent of the global one.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in a few minutes.' } },
});

const passwordSchema = z
  .string()
  .min(8, 'Use at least 8 characters.')
  .max(200);

router.post(
  '/register',
  authLimiter,
  validate({
    body: z.object({
      email: emailSchema,
      password: passwordSchema,
      fullName: z.string().trim().min(2).max(160).optional(),
      phone: phoneSchema.optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await registerCustomer(req.body));
  })
);

router.post(
  '/login',
  authLimiter,
  validate({ body: z.object({ email: emailSchema, password: z.string().min(1) }) }),
  asyncHandler(async (req, res) => {
    res.json(await loginCustomer(req.body));
  })
);

router.post(
  '/admin/login',
  authLimiter,
  validate({ body: z.object({ email: emailSchema, password: z.string().min(1) }) }),
  asyncHandler(async (req, res) => {
    res.json(await loginAdmin(req.body));
  })
);

router.post(
  '/forgot-password',
  authLimiter,
  validate({ body: z.object({ email: emailSchema }) }),
  asyncHandler(async (req, res) => {
    await requestPasswordReset(req.body.email);
    // Deliberately identical whether or not the account exists.
    res.json({ message: 'If that email is registered, a reset link is on its way.' });
  })
);

router.post(
  '/reset-password',
  authLimiter,
  validate({ body: z.object({ token: z.string().min(32).max(128), password: passwordSchema }) }),
  asyncHandler(async (req, res) => {
    await resetPassword(req.body);
    res.json({ message: 'Password updated. You can sign in now.' });
  })
);

// /me and /me/orders live in me.routes.js, mounted at the bare /api/v1.
// Keeping them here would mean mounting this router twice, which would also
// expose /api/v1/login and /api/v1/register as a duplicate credential surface.

export default router;
