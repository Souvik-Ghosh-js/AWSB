// SKU generation for product variants.
//
// Pure: imports nothing, so it is unit-testable without a database or .env.
// Format: AWSB-<3-letter-slug>-<zero-padded size>, e.g. 'AWSB-WSH-03'.

export const VARIANT_SIZES_ML = [3, 6, 12];

/**
 * Condense a product name to a 3-letter code.
 *
 * Initials lead, because they stay distinct across a catalogue of
 * similar-sounding attars:
 *   'Waalid Shamama Oud' -> 'WSO'   (three words: one initial each)
 *   'Waalid Shamama'     -> 'WSH'   (two words: W + the second word's 'SH')
 *   'Mogra'              -> 'MOG'   (one word: its first three letters)
 * The two-word form matches the worked example in docs/01-architecture.md
 * ('Waalid Shamama' -> 'AWSB-WSH-03').
 */
export function slugCode(name) {
  const words = String(name ?? '')
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return 'XXX';

  if (words.length >= 3) {
    return words.slice(0, 3).map((w) => w[0]).join('');
  }

  if (words.length === 2) {
    // First word's initial, then enough of the second word to reach 3 chars.
    return `${words[0][0]}${words[1].slice(0, 2)}`.padEnd(3, 'X');
  }

  return words[0].slice(0, 3).padEnd(3, 'X');
}

/** 3 -> '03', 12 -> '12'. Keeps SKUs sorting correctly as text. */
export function sizeCode(sizeMl) {
  return String(Number(sizeMl)).padStart(2, '0');
}

/** 'Waalid Shamama', 3 -> 'AWSB-WSH-03' */
export function generateSku(productName, sizeMl) {
  return `AWSB-${slugCode(productName)}-${sizeCode(sizeMl)}`;
}

/**
 * SKUs are UNIQUE in the schema, and two products can easily condense to the
 * same 3-letter code ('Waalid Shamama' and 'White Saffron Heart' -> 'WSH').
 * Suffix a counter until the SKU is unused.
 *
 * @param {string} base      the SKU from generateSku
 * @param {Set<string>|Array<string>} taken  existing SKUs
 */
export function dedupeSku(base, taken) {
  const used = taken instanceof Set ? taken : new Set(taken ?? []);
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  // Practically unreachable; better than looping forever.
  return `${base}-${Date.now()}`;
}

/** URL slug for the product itself: 'Waalid Shamama' -> 'waalid-shamama'. */
export function slugify(name) {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);
}
