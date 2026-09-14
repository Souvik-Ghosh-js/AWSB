// Extract the AWB / tracking number from a photo of a courier label.
//
// The heuristic: on virtually every Indian courier label the AWB is the
// largest text on the page, because delivery staff have to read it by eye —
// usually set directly under the barcode. So we rank OCR words by rendered
// glyph height and take the tallest plausible candidate.
//
// The result is ALWAYS a suggestion. It is pre-filled into an editable field
// for the admin to confirm against the label photo, never submitted blind:
// OCR routinely confuses 0/O, 1/I/7, 5/S and 8/B on smudged thermal labels,
// and a wrong AWB emails a customer someone else's tracking link with nothing
// downstream to catch it.

// Words that appear near the AWB on labels and must never be mistaken for it.
const LABEL_NOISE = new Set([
  'AWB', 'AWBNO', 'NO', 'NUMBER', 'TRACKING', 'TRACK', 'CONSIGNMENT', 'CN',
  'DOCKET', 'WAYBILL', 'ORDER', 'ORDERNO', 'REF', 'REFERENCE', 'INVOICE',
  'DATE', 'WEIGHT', 'PCS', 'QTY', 'COD', 'PREPAID', 'FROM', 'TO', 'PIN',
  'PINCODE', 'PHONE', 'MOB', 'MOBILE', 'GST', 'GSTIN', 'RS', 'INR',
]);

/** Strip the decoration OCR picks up around the number itself. */
export function normaliseCandidate(text) {
  return String(text ?? '')
    .toUpperCase()
    // Drop a leading label like "AWB NO:" or "DOCKET#".
    .replace(/^(AWB|CN|DOCKET|WAYBILL|TRACKING)\s*(NO\.?|NUMBER|#)?\s*[:\-]?\s*/i, '')
    // Couriers print AWBs with spaces or hyphens for legibility.
    .replace(/[\s\-–—]/g, '')
    .trim();
}

/**
 * Does this look like an AWB at all?
 * Deliberately loose — this filters obvious noise, it does not validate
 * against a specific courier. Format checking warns, it never blocks.
 */
export function isPlausibleAwb(value) {
  const v = normaliseCandidate(value);
  if (v.length < 8 || v.length > 20) return false;
  if (LABEL_NOISE.has(v)) return false;
  // Must be alphanumeric, and must contain digits — no courier uses a
  // purely alphabetic AWB.
  if (!/^[A-Z0-9]+$/.test(v)) return false;
  if (!/[0-9]/.test(v)) return false;
  // A pincode is 6 digits; an AWB this short is almost certainly the pincode.
  if (/^[0-9]{6}$/.test(v)) return false;
  // Indian mobile numbers are 10 digits starting 6-9 — a common false positive.
  if (/^[6-9][0-9]{9}$/.test(v)) return false;
  return true;
}

/** Height of an OCR bounding box, in pixels. */
function glyphHeight(word) {
  const b = word?.bbox;
  if (!b) return 0;
  return Math.max(0, Number(b.y1) - Number(b.y0));
}

/**
 * Pick the AWB from Tesseract's word list.
 *
 * @param {Array} words  Tesseract words: { text, confidence, bbox:{x0,y0,x1,y1} }
 * @returns {{value:string, confidence:number, height:number, alternatives:string[]}|null}
 */
export function pickLargestFontAwb(words) {
  if (!Array.isArray(words) || words.length === 0) return null;

  const candidates = words
    .map((w) => ({
      raw: w.text,
      value: normaliseCandidate(w.text),
      height: glyphHeight(w),
      // Tesseract reports 0-100; we expose 0-1.
      confidence: Number(w.confidence ?? 0) / 100,
    }))
    .filter((c) => isPlausibleAwb(c.value) && c.height > 0);

  if (candidates.length === 0) return null;

  // Tallest wins. Ties break toward higher OCR confidence, then toward the
  // longer string — a truncated read is more likely than an over-long one.
  candidates.sort(
    (a, b) =>
      b.height - a.height ||
      b.confidence - a.confidence ||
      b.value.length - a.value.length
  );

  const [best, ...rest] = candidates;

  return {
    value: best.value,
    confidence: best.confidence,
    height: best.height,
    // Shown to the admin as one-tap alternatives when the top pick is wrong.
    alternatives: rest
      .filter((c) => c.value !== best.value)
      .slice(0, 4)
      .map((c) => c.value),
  };
}

/**
 * Check a number against a courier's expected format.
 * Returns a WARNING, never a rejection — a blocked legitimate AWB is worse
 * than a typo, and the admin is looking at the physical label anyway.
 */
export function checkAwbFormat(value, awbPattern) {
  if (!awbPattern) return { ok: true, warning: null };
  const v = normaliseCandidate(value);
  try {
    if (new RegExp(awbPattern).test(v)) return { ok: true, warning: null };
  } catch {
    // A malformed pattern in the couriers table must not break shipping.
    return { ok: true, warning: null };
  }
  return {
    ok: true,
    warning: "This doesn't match the usual format for this courier. Check it against the label before sending.",
  };
}
