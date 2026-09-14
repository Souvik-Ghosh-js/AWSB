import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';

import { asyncHandler, ApiError } from '../../middleware/error.js';
import { requireAdmin } from '../../middleware/auth.js';
import { uploadFile } from '../../services/storage/index.js';
import { pickLargestFontAwb } from '../../services/ocr/awb.js';

// Read the AWB off a photo of a courier label.
//
// ============================ READ THIS ============================
// The value this endpoint returns is a SUGGESTION, never a decision. It is
// pre-filled into an editable field beside the label photo shown at full size,
// and the admin confirms it before anything is saved or emailed. The route
// deliberately does NOT create a shipment or touch an order.
//
// Why the confirmation step is non-negotiable: a wrong AWB emails the customer
// a tracking link for somebody else's parcel, and nothing downstream will ever
// catch it. Tesseract routinely confuses 0/O, 1/I/7, 5/S and 8/B on thermal
// labels that arrive smudged, skewed or half-scratched.
// ===================================================================

const router = Router();

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    if (!/^image\//.test(file.mimetype)) {
      cb(new ApiError(422, 'Upload a photo of the label — JPEG, PNG, WebP, HEIC or TIFF.'));
      return;
    }
    cb(null, true);
  },
});

/**
 * Pre-process for OCR.
 *
 * Phone photos of labels are 12 MP and colour; Tesseract neither needs nor
 * benefits from that. Downscaling to ~1600px wide and converting to greyscale
 * cuts OCR time by roughly an order of magnitude AND improves accuracy, since
 * the binariser stops chasing JPEG colour fringing around thermal print.
 * Normalising stretches contrast on the washed-out labels that are the whole
 * problem here.
 */
async function preprocess(buffer) {
  return sharp(buffer)
    .rotate() // honour EXIF orientation; a sideways label OCRs as noise
    .resize({ width: 1600, withoutEnlargement: true })
    .greyscale()
    .normalise()
    .sharpen()
    .png()
    .toBuffer();
}

/**
 * Run Tesseract and return WORD-level results with bounding boxes — the
 * 'largest font wins' heuristic is built on glyph height, so the word boxes
 * are the entire point of doing OCR locally rather than calling a service
 * that only returns flat text.
 */
async function recogniseWords(buffer) {
  const worker = await createWorker('eng');
  try {
    const { data } = await worker.recognize(buffer, {}, { blocks: true });

    // tesseract.js v5 may expose words on data.words or nested in blocks
    // depending on the output options, so flatten defensively.
    let words = Array.isArray(data?.words) ? data.words : [];
    if (words.length === 0 && Array.isArray(data?.blocks)) {
      words = data.blocks.flatMap((b) =>
        (b.paragraphs ?? []).flatMap((p) => (p.lines ?? []).flatMap((l) => l.words ?? []))
      );
    }

    return { words, text: data?.text ?? '' };
  } finally {
    await worker.terminate();
  }
}

// Two paths, one handler. The storefront calls this scan-awb; the API named it
// scan-label. Declaring both here keeps label OCR in exactly one place —
// aliasing it at mount time does not work, because Express strips the mount
// prefix before a router's own matcher runs.
router.post(
  ['/shipments/scan-label', '/shipments/scan-awb'],
  requireAdmin('owner', 'manager', 'staff'),
  upload.single('image'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      throw new ApiError(422, 'No image uploaded. Send the label photo in the "image" field.');
    }

    // Keep the photo as evidence regardless of how OCR goes: shipments.
    // scanned_image_url stores it so a misread can be reviewed against the
    // actual label months later.
    let imageUrl = null;
    try {
      const { url } = await uploadFile(req.file.buffer, {
        filename: `labels/${Date.now()}-${req.file.originalname || 'label'}`,
        contentType: req.file.mimetype,
      });
      imageUrl = url;
    } catch {
      // Storage being down must not block the admin from shipping. They can
      // still read the number off the label in front of them.
      imageUrl = null;
    }

    let words = [];
    let rawText = '';
    try {
      const processed = await preprocess(req.file.buffer);
      const result = await recogniseWords(processed);
      words = result.words;
      rawText = result.text;
    } catch {
      // A corrupt image, an unsupported codec, or a Tesseract crash is an
      // ordinary outcome here, not a server fault. The admin types the number
      // manually, which is always available as the fallback.
      return res.json({
        suggested: null,
        confidence: null,
        alternatives: [],
        rawText: '',
        imageUrl,
        message: "Could not read this image. Type the tracking number from the label instead.",
      });
    }

    const picked = pickLargestFontAwb(words);

    // Nothing on the label looked like an AWB. That is a normal result — a
    // blurred photo, a label face-down — so answer honestly with a null
    // suggestion rather than a 500.
    if (!picked) {
      return res.json({
        suggested: null,
        confidence: null,
        alternatives: [],
        rawText,
        imageUrl,
        message: "No tracking number found in this photo. Check the label is in frame, or type the number in.",
      });
    }

    res.json({
      // SUGGESTION ONLY — the admin confirms this against the photo before it
      // is saved to a shipment or emailed to a customer.
      suggested: picked.value,
      confidence: picked.confidence,
      alternatives: picked.alternatives,
      rawText,
      imageUrl,
    });
  })
);

export default router;
