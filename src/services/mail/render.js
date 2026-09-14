// A dependency-free email renderer. No Handlebars, no MJML, no EJS.
//
// Email HTML is not web HTML. Outlook renders with Word's engine, Gmail strips
// <style> blocks in some clients and all of them in forwarded mail, and float/
// flex/grid are unreliable across the set. So: nested tables for layout, inline
// styles only, and a hard 600px cap that every client honours.
//
// This file deliberately imports nothing from ../config/env.js. env.js calls
// process.exit(1) on a missing variable, which would kill the test runner when
// no .env is present. The site URL is read lazily instead - see siteUrl().

const BRAND = {
  bg: '#FAF7F0',        // warm ivory page ground
  surface: '#FFFFFF',
  panel: '#F3EEE3',     // raised panel on ivory
  ink: '#1F2A24',       // near-black green, body text
  brand: '#14432A',     // deep forest green
  brandSoft: '#2D6A4F',
  accent: '#B08D3F',    // antique gold - accent ONLY, never a large fill
  muted: '#7A8079',
  rule: '#E3DACA',
};

const SERIF = "'Cormorant Garamond', 'Playfair Display', Georgia, 'Times New Roman', serif";
const SANS = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif";
const MONO = "'SF Mono', 'Courier New', Courier, monospace";

// Shop identity. Not GST registered, so there is no GSTIN/HSN line anywhere
// in this layer - see docs/01-architecture.md section 8.
const SHOP = {
  name: 'Attar World Sonar Bangla',
  addressLines: ['Dashadrone, Rajarhat', 'Kolkata 700136, West Bengal'],
  email: 'sangatdutta65@gmail.com',
  phones: ['7003356210', '9038571860'],
};

export { BRAND, SHOP, SERIF, SANS, MONO };

/**
 * Escape a value for interpolation into HTML.
 *
 * Every customer-supplied string - names, addresses, notes, review text - goes
 * through this. Order data is attacker-influenced: a customer can type
 * anything into the address form, and that text is echoed back into an email
 * that the shop owner also reads in the admin alert.
 *
 * Quotes are escaped too, not just angle brackets, because these values are
 * also interpolated into attributes (href, alt, title).
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The site URL, read lazily from the environment with a safe fallback.
 *
 * Callers may pass an explicit siteUrl (the tests do). Otherwise we read
 * process.env directly rather than importing the validated env module, so that
 * rendering a template never depends on a fully configured environment.
 * Trailing slashes are stripped so `${siteUrl()}/cart` never doubles up.
 */
export function siteUrl(explicit) {
  const raw = explicit || process.env.SITE_URL || 'http://localhost:3000';
  return String(raw).replace(/\/+$/, '');
}

/** Join a base URL and a path without doubling or dropping the separator. */
export function url(path, explicitSiteUrl) {
  const base = siteUrl(explicitSiteUrl);
  if (!path) return base;
  return `${base}/${String(path).replace(/^\/+/, '')}`;
}

/**
 * Wrap body HTML in the shared responsive layout.
 *
 * `preheader` is the grey snippet inbox lists show beside the subject. Left
 * unset, clients scrape the first visible text, which is usually the shop name
 * repeated - a wasted line in every inbox.
 */
export function layout({ title, preheader = '', bodyHtml }) {
  const safeTitle = escapeHtml(title);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${safeTitle}</title>
</head>
<body style="margin:0; padding:0; width:100%; background-color:${BRAND.bg}; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%;">
<div style="display:none; font-size:1px; color:${BRAND.bg}; line-height:1px; max-height:0; max-width:0; opacity:0; overflow:hidden;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BRAND.bg};">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; background-color:${BRAND.surface}; border:1px solid ${BRAND.rule};">
        <tr>
          <td align="center" style="background-color:${BRAND.brand}; padding:28px 24px 24px 24px;">
            <div style="font-family:${SERIF}; font-size:27px; line-height:32px; color:${BRAND.bg}; letter-spacing:0.5px;">${escapeHtml(SHOP.name)}</div>
            <div style="height:1px; width:56px; background-color:${BRAND.accent}; margin:12px auto 0 auto; font-size:0; line-height:0;">&nbsp;</div>
            <div style="font-family:${SANS}; font-size:11px; line-height:16px; color:${BRAND.accent}; letter-spacing:2px; text-transform:uppercase; padding-top:10px;">Attars &amp; Fine Fragrance</div>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 24px 8px 24px; font-family:${SANS}; font-size:15px; line-height:23px; color:${BRAND.ink};">
${bodyHtml}
          </td>
        </tr>
        <tr>
          <td style="padding:8px 24px 28px 24px;">
            <div style="height:1px; background-color:${BRAND.rule}; font-size:0; line-height:0; margin-bottom:16px;">&nbsp;</div>
            <div style="font-family:${SANS}; font-size:12px; line-height:19px; color:${BRAND.muted};">
              <strong style="color:${BRAND.ink};">${escapeHtml(SHOP.name)}</strong><br>
              ${SHOP.addressLines.map((l) => escapeHtml(l)).join('<br>')}<br>
              ${SHOP.phones.map((p) => escapeHtml(p)).join(' &middot; ')} &middot;
              <a href="mailto:${escapeHtml(SHOP.email)}" style="color:${BRAND.brandSoft}; text-decoration:underline;">${escapeHtml(SHOP.email)}</a>
            </div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/** A serif section heading. */
export function heading(text) {
  return `<h1 style="margin:0 0 14px 0; font-family:${SERIF}; font-size:25px; line-height:31px; font-weight:600; color:${BRAND.brand};">${escapeHtml(text)}</h1>`;
}

/** A body paragraph. `html` is emitted verbatim - escape before calling. */
export function paragraph(html, { muted = false } = {}) {
  const color = muted ? BRAND.muted : BRAND.ink;
  const size = muted ? '13px' : '15px';
  const lh = muted ? '20px' : '23px';
  return `<p style="margin:0 0 14px 0; font-family:${SANS}; font-size:${size}; line-height:${lh}; color:${color};">${html}</p>`;
}

/**
 * A call-to-action button, built as a table cell rather than a styled <a>.
 * Outlook ignores padding on inline anchors, which collapses a styled link
 * into unclickable text.
 */
export function button(label, href) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 18px 0;">
  <tr>
    <td align="center" bgcolor="${BRAND.brand}" style="border-radius:2px;">
      <a href="${escapeHtml(href)}" style="display:inline-block; padding:14px 30px; font-family:${SANS}; font-size:15px; font-weight:600; line-height:18px; color:${BRAND.bg}; text-decoration:none; border-radius:2px;">${escapeHtml(label)}</a>
    </td>
  </tr>
</table>`;
}

/** A tinted panel used for addresses, refund notes and tracking numbers. */
export function panel(innerHtml, { accent = false } = {}) {
  const border = accent ? BRAND.accent : BRAND.rule;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px 0; background-color:${BRAND.panel}; border-left:3px solid ${border};">
  <tr><td style="padding:16px 18px; font-family:${SANS}; font-size:14px; line-height:22px; color:${BRAND.ink};">${innerHtml}</td></tr>
</table>`;
}

/**
 * The line-items table plus money summary.
 *
 * `rows` are [label, value] pairs already formatted and escaped by the caller.
 * There is deliberately no tax row: the shop is not GST registered, so a
 * "Tax: 0.00" line would be both wrong and a compliance claim we cannot make.
 */
export function itemsTable(items, summaryRows) {
  const head = `<tr>
    <th align="left" style="padding:0 0 8px 0; font-family:${SANS}; font-size:11px; letter-spacing:1px; text-transform:uppercase; color:${BRAND.muted}; font-weight:600; border-bottom:1px solid ${BRAND.rule};">Item</th>
    <th align="center" style="padding:0 0 8px 0; font-family:${SANS}; font-size:11px; letter-spacing:1px; text-transform:uppercase; color:${BRAND.muted}; font-weight:600; border-bottom:1px solid ${BRAND.rule};">Qty</th>
    <th align="right" style="padding:0 0 8px 0; font-family:${SANS}; font-size:11px; letter-spacing:1px; text-transform:uppercase; color:${BRAND.muted}; font-weight:600; border-bottom:1px solid ${BRAND.rule};">Amount</th>
  </tr>`;

  const body = items.map((it) => `<tr>
    <td align="left" style="padding:12px 8px 12px 0; font-family:${SANS}; font-size:14px; line-height:20px; color:${BRAND.ink}; border-bottom:1px solid ${BRAND.rule};">
      ${escapeHtml(it.name)}<br><span style="font-size:12px; color:${BRAND.muted};">${escapeHtml(it.size)}</span>
    </td>
    <td align="center" style="padding:12px 8px; font-family:${SANS}; font-size:14px; color:${BRAND.ink}; border-bottom:1px solid ${BRAND.rule};">${escapeHtml(it.qty)}</td>
    <td align="right" style="padding:12px 0 12px 8px; font-family:${SANS}; font-size:14px; color:${BRAND.ink}; white-space:nowrap; border-bottom:1px solid ${BRAND.rule};">${escapeHtml(it.amount)}</td>
  </tr>`).join('\n');

  const summary = summaryRows.map(([label, value, opts = {}]) => {
    const strong = opts.strong === true;
    const size = strong ? '16px' : '14px';
    const color = strong ? BRAND.brand : BRAND.ink;
    const weight = strong ? '600' : '400';
    const family = strong ? SERIF : SANS;
    const pad = strong ? '14px 0 4px 0' : '6px 0 0 0';
    const borderTop = strong ? `border-top:2px solid ${BRAND.accent};` : '';
    return `<tr>
    <td colspan="2" align="right" style="padding:${pad}; ${borderTop} font-family:${family}; font-size:${size}; font-weight:${weight}; color:${color};">${escapeHtml(label)}</td>
    <td align="right" style="padding:${pad}; ${borderTop} font-family:${family}; font-size:${size}; font-weight:${weight}; color:${color}; white-space:nowrap;">${escapeHtml(value)}</td>
  </tr>`;
  }).join('\n');

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px 0; border-collapse:collapse;">
${head}
${body}
${summary}
</table>`;
}

/**
 * Generate a plaintext fallback from the same structured content.
 *
 * Not an HTML-to-text conversion - stripping tags from email HTML yields a
 * soup of table whitespace. Templates pass explicit text blocks instead, and
 * this only handles the framing and tidies blank lines.
 *
 * A real text/plain part matters beyond accessibility: a multipart message
 * with an empty or missing text alternative scores worse with spam filters,
 * which is a live concern when sending from a gmail.com identity.
 */
export function textLayout(blocks) {
  const body = blocks
    .filter((b) => b !== null && b !== undefined && String(b).trim() !== '')
    .map((b) => String(b).trim())
    .join('\n\n');

  const footer = [
    SHOP.name,
    ...SHOP.addressLines,
    `${SHOP.phones.join(' / ')}  ${SHOP.email}`,
  ].join('\n');

  return `${SHOP.name}\n${'='.repeat(SHOP.name.length)}\n\n${body}\n\n--\n${footer}\n`
    .replace(/\n{3,}/g, '\n\n');
}

/** A plaintext key/value line, skipped entirely when the value is empty. */
export function textLine(label, value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  return `${label}: ${value}`;
}
