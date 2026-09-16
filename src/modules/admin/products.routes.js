import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';

import { asyncHandler, ApiError } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { requireAdmin } from '../../middleware/auth.js';
import * as products from './products.service.js';

const router = Router();

// Images go to object storage, never to disk on the instance — the Lightsail
// box is rebuildable and must hold no state.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    if (!/^image\/(jpe?g|png|webp|avif)$/.test(file.mimetype)) {
      cb(new ApiError(422, 'Product images must be JPEG, PNG, WebP or AVIF.'));
      return;
    }
    cb(null, true);
  },
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

const scentNotes = z.object({
  top: z.array(z.string()).optional(),
  heart: z.array(z.string()).optional(),
  base: z.array(z.string()).optional(),
});

const variantInput = z.object({
  size_ml: z.union([z.literal(3), z.literal(6), z.literal(12)]),
  price_paise: z.number().int().nonnegative().optional(),
  compare_at_paise: z.number().int().positive().nullable().optional(),
  stock_qty: z.number().int().nonnegative().optional(),
  low_stock_threshold: z.number().int().nonnegative().optional(),
  is_enabled: z.boolean().optional(),
  weight_grams: z.number().int().positive().nullable().optional(),
});

const createBody = z.object({
  name: z.string().min(1).max(160),
  slug: z.string().max(160).optional(),
  tagline: z.string().max(255).nullable().optional(),
  description: z.string().nullable().optional(),
  scent_family: z.string().max(80).nullable().optional(),
  scent_notes: scentNotes.nullable().optional(),
  status: z.enum(['draft', 'active', 'archived']).optional(),
  is_featured: z.boolean().optional(),
  sort_order: z.number().int().optional(),
  meta_title: z.string().max(180).nullable().optional(),
  meta_description: z.string().max(320).nullable().optional(),
  // Per-size price and stock. Independent by design: a 3ml tester and a 12ml
  // bottle have unrelated prices and unrelated stock levels.
  variants: z.array(variantInput).max(3).optional(),
});

// On update, per-size price/threshold/enabled flags may be sent alongside the
// product fields, matched to the existing variant by size_ml. Stock is NOT
// accepted here: it changes only through the inventory ledger.
const updateBody = createBody.partial().extend({
  variants: z.array(variantInput.omit({ stock_qty: true }).strict()).max(3).optional(),
});

router.get(
  '/products',
  requireAdmin('owner', 'manager', 'staff'),
  validate({
    query: z.object({
      q: z.string().optional(),
      status: z.enum(['draft', 'active', 'archived']).optional(),
      include_deleted: z.coerce.boolean().optional(),
      page: z.coerce.number().int().positive().optional(),
      per_page: z.coerce.number().int().positive().max(100).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await products.listProducts({
      q: req.query.q,
      status: req.query.status,
      includeDeleted: req.query.include_deleted === true,
      page: req.query.page,
      perPage: req.query.per_page,
    });
    res.json(result);
  })
);

router.get(
  '/products/:id',
  requireAdmin('owner', 'manager', 'staff'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await products.getProduct(req.params.id));
  })
);

router.post(
  '/products',
  requireAdmin('owner', 'manager'),
  validate({ body: createBody }),
  asyncHandler(async (req, res) => {
    const product = await products.createProduct({ ...req.body, actor_id: req.admin.id });
    res.status(201).json(product);
  })
);

router.patch(
  '/products/:id',
  requireAdmin('owner', 'manager'),
  validate({ params: idParam, body: updateBody }),
  asyncHandler(async (req, res) => {
    res.json(await products.updateProduct(req.params.id, req.body));
  })
);

router.delete(
  '/products/:id',
  requireAdmin('owner', 'manager'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await products.softDeleteProduct(req.params.id));
  })
);

router.post(
  '/products/:id/restore',
  requireAdmin('owner', 'manager'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await products.restoreProduct(req.params.id));
  })
);

// ------------------------------------------------------------------ variants

router.patch(
  '/variants/:id',
  requireAdmin('owner', 'manager'),
  validate({
    params: idParam,
    body: z.object({
      sku: z.string().max(64).optional(),
      price_paise: z.number().int().nonnegative().optional(),
      compare_at_paise: z.number().int().positive().nullable().optional(),
      low_stock_threshold: z.number().int().nonnegative().optional(),
      is_enabled: z.boolean().optional(),
      weight_grams: z.number().int().positive().nullable().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json(await products.updateVariant(req.params.id, req.body));
  })
);

// -------------------------------------------------------------------- images

router.get(
  '/products/:id/images',
  requireAdmin('owner', 'manager', 'staff'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json({ data: await products.listImages(req.params.id) });
  })
);

router.post(
  '/products/:id/images',
  requireAdmin('owner', 'manager'),
  upload.single('image'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ApiError(422, 'No image uploaded. Send one file in the "image" field.');
    const image = await products.addProductImage(req.params.id, req.file, {
      altText: req.body?.alt_text ?? null,
      isPrimary: req.body?.is_primary === 'true' || req.body?.is_primary === true,
    });
    res.status(201).json(image);
  })
);

router.patch(
  '/images/:id',
  requireAdmin('owner', 'manager'),
  validate({
    params: idParam,
    body: z.object({
      alt_text: z.string().max(255).nullable().optional(),
      sort_order: z.number().int().min(0).max(255).optional(),
      is_primary: z.boolean().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json(await products.updateImage(req.params.id, req.body));
  })
);

router.delete(
  '/images/:id',
  requireAdmin('owner', 'manager'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await products.deleteImage(req.params.id));
  })
);

export default router;
