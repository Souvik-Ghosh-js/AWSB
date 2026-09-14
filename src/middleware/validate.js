import { z } from 'zod';

/**
 * Validate and REPLACE req.body/query/params with the parsed result, so routes
 * only ever see coerced, trimmed, known fields. Unknown keys are stripped,
 * which is what stops a client sending `{price_paise: 1}` into an update.
 */
export function validate(schemas) {
  return (req, res, next) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.query) req.validatedQuery = schemas.query.parse(req.query);
      if (schemas.params) req.params = schemas.params.parse(req.params);
      next();
    } catch (err) {
      next(err); // ZodError is translated by errorHandler.
    }
  };
}

// ---- Reusable field schemas -------------------------------------------
// These encode the shop's real rules, so they stay consistent across
// checkout, admin and customer routes.

/** Indian mobile: 10 digits starting 6-9. Tolerates +91 and spacing. */
export const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s\-()]/g, '').replace(/^(\+?91)/, ''))
  .refine((v) => /^[6-9][0-9]{9}$/.test(v), 'Enter a valid 10-digit mobile number.');

/** Indian pincode: exactly 6 digits, never starting with 0. */
export const pincodeSchema = z
  .string()
  .trim()
  .refine((v) => /^[1-9][0-9]{5}$/.test(v), 'Enter a valid 6-digit pincode.');

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter a valid email address.')
  .max(255);

/**
 * A complete delivery address. The owner's rule is "always take proper
 * address": everything is required except the area line, landmark and the
 * second phone. Vague addresses are the main cause of failed deliveries and
 * courier re-attempt charges in India.
 */
export const addressSchema = z.object({
  fullName: z.string().trim().min(2, 'Enter the recipient name.').max(160),
  phone: phoneSchema,
  altPhone: phoneSchema.optional().nullable(),
  email: emailSchema,
  line1: z.string().trim().min(3, 'Enter the house/flat number and building.').max(255),
  line2: z.string().trim().max(255).optional().nullable(),
  landmark: z.string().trim().max(160).optional().nullable(),
  city: z.string().trim().min(2, 'Enter the city.').max(120),
  district: z.string().trim().max(120).optional().nullable(),
  state: z.string().trim().min(2, 'Enter the state.').max(120),
  pincode: pincodeSchema,
  country: z.literal('IN').default('IN'),
});

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/** Order numbers look like AWSB-2026-00417. */
export const orderNumberSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^AWSB-\d{4}-\d{5}$/, 'Enter a valid order number, e.g. AWSB-2026-00417.');
