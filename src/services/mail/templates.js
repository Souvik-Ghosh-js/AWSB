// One function per transactional email. Each returns { subject, html, text }.
//
// These are pure: no DB, no network, no env import at module load. Callers pass
// rows straight from MySQL. That purity is what lets tests/mail.test.js render
// every template without a .env file or a database.
//
// Money arrives as integer paise and is formatted with formatPaise. Nothing in
// this file prints a tax, GST or HSN line: the shop is not GST registered, so
// prices are final and invoices are plain receipts.

import { formatPaise } from '../../utils/money.js';
import {
  BRAND,
  SANS,
  MONO,
  escapeHtml,
  layout,
  textLayout,
  textLine,
  heading,
  paragraph,
  button,
  panel,
  itemsTable,
  url,
  siteUrl,
} from './render.js';

const SHOP_NAME = 'Attar World Sonar Bangla';
const REFUND_WORKING_DAYS = '5-7 working days';

/** '3 ml' from a size_ml of 3. Sizes are 3/6/12 per the catalogue. */
function sizeLabel(sizeMl) {
  return `${Number(sizeMl)} ml`;
}

/** Normalise an order_items row into what itemsTable expects. */
function toDisplayItem(item) {
  const qty = Number(item.quantity ?? item.qty ?? 1);
  const lineTotal = Number(
    item.line_total_paise ?? Number(item.unit_price_paise ?? 0) * qty
  );
  return {
    name: item.product_name ?? item.name ?? 'Item',
    size: sizeLabel(item.size_ml),
    qty: String(qty),
    amount: formatPaise(lineTotal),
    unit: formatPaise(Number(item.unit_price_paise ?? 0)),
    lineTotalPaise: lineTotal,
  };
}

/**
 * The money summary rows, built to skip what does not apply.
 *
 * A discount row only appears when a coupon was used, and shipping prints
 * "Free" at zero rather than an odd-looking ₹0.00. No tax row - see file header.
 */
function summaryRows(order) {
  const rows = [['Subtotal', formatPaise(Number(order.subtotal_paise ?? 0))]];

  const discount = Number(order.discount_paise ?? 0);
  if (discount > 0) {
    const label = order.coupon_code ? `Discount (${order.coupon_code})` : 'Discount';
    rows.push([label, `-${formatPaise(discount)}`]);
  }

  const shipping = Number(order.shipping_paise ?? 0);
  rows.push(['Shipping', shipping > 0 ? formatPaise(shipping) : 'Free']);
  rows.push(['Total', formatPaise(Number(order.total_paise ?? 0)), { strong: true }]);
  return rows;
}

/** The same summary as plaintext. */
function summaryText(order) {
  return summaryRows(order)
    .map(([label, value]) => `${label}: ${value}`)
    .join('\n');
}

/** The shipping address snapshot, as escaped HTML. */
function addressHtml(order) {
  const parts = [
    order.ship_full_name,
    order.ship_line1,
    order.ship_line2,
    order.ship_landmark ? `Near ${order.ship_landmark}` : null,
    [order.ship_city, order.ship_district].filter(Boolean).join(', '),
    `${order.ship_state ?? ''} ${order.ship_pincode ?? ''}`.trim(),
    order.ship_phone,
  ].filter((p) => p !== null && p !== undefined && String(p).trim() !== '');

  return parts.map((p) => escapeHtml(p)).join('<br>');
}

/** The shipping address snapshot, as plaintext. */
function addressText(order) {
  return [
    order.ship_full_name,
    order.ship_line1,
    order.ship_line2,
    order.ship_landmark ? `Near ${order.ship_landmark}` : null,
    [order.ship_city, order.ship_district].filter(Boolean).join(', '),
    `${order.ship_state ?? ''} ${order.ship_pincode ?? ''}`.trim(),
    order.ship_phone,
  ].filter((p) => p !== null && p !== undefined && String(p).trim() !== '').join('\n');
}

/** Plaintext rendering of the line items. */
function itemsText(displayItems) {
  return displayItems
    .map((it) => `  ${it.name} (${it.size}) x${it.qty}  ${it.amount}`)
    .join('\n');
}

/** First name only, for a greeting. Falls back to a neutral form. */
function greetingName(order) {
  const full = String(order.ship_full_name ?? order.full_name ?? '').trim();
  if (!full) return 'there';
  return full.split(/\s+/)[0];
}

/**
 * Resolve a courier tracking URL for a shipment.
 *
 * Returns null unless the courier genuinely supports deep linking. This is the
 * single decision point behind the shipped email's two shapes, and it is
 * deliberately conservative: docs/02-couriers.md found that several widely
 * published "tracking URL formats" are fabricated - Trackon's 404s, the cited
 * Shiprocket pattern returns HTTP 400, and India Post/TPC are CAPTCHA gated.
 * Emailing a customer a link that lands on an error page or an empty form
 * reads exactly like a phishing attempt, which is worse than no link at all.
 *
 * The snapshotted shipments.tracking_url wins when present; otherwise the
 * courier template has {TRACKING_NUMBER} substituted.
 */
export function resolveTrackingUrl(shipment, courier) {
  if (!courier || courier.supports_deep_link !== true) return null;

  const snapshot = shipment?.tracking_url;
  if (snapshot && String(snapshot).trim() !== '') return String(snapshot);

  const template = courier.tracking_url_template;
  const number = shipment?.tracking_number;
  if (!template || !number) return null;
  if (!String(template).includes('{TRACKING_NUMBER}')) return null;

  return String(template).replace('{TRACKING_NUMBER}', encodeURIComponent(String(number)));
}

/** The courier's tracking landing page, used when we cannot deep link. */
function landingPage(courier) {
  const template = courier?.tracking_url_template;
  if (!template) return null;
  // A template still carrying the placeholder is not a usable landing page.
  if (String(template).includes('{TRACKING_NUMBER}')) return null;
  return String(template);
}

// ---------------------------------------------------------------------------
// Customer emails
// ---------------------------------------------------------------------------

/**
 * Sent when payment is confirmed. Doubles as the receipt - the shop issues no
 * separate invoice, and being unregistered for GST there is no tax document to
 * issue either.
 */
export function orderConfirmation(order, items = [], shipment = null, opts = {}) {
  const base = opts.siteUrl;
  const displayItems = items.map(toDisplayItem);
  const orderNumber = order.order_number ?? '';
  const orderUrl = url(`order/${encodeURIComponent(orderNumber)}`, base);

  const subject = `Order ${orderNumber} confirmed - ${SHOP_NAME}`;

  const bodyHtml = [
    heading('Thank you for your order'),
    paragraph(`Dear ${escapeHtml(greetingName(order))}, we have received your order and begun preparing it. Your attars are decanted and packed by hand, so please allow a little care in the making.`),
    panel(`<strong style="font-family:${SANS};">Order ${escapeHtml(orderNumber)}</strong>`, { accent: true }),
    itemsTable(displayItems, summaryRows(order)),
    `<div style="font-family:${SANS}; font-size:11px; letter-spacing:1px; text-transform:uppercase; color:${BRAND.muted}; padding-bottom:8px;">Delivery address</div>`,
    panel(addressHtml(order)),
    order.customer_note
      ? panel(`<span style="color:${BRAND.muted};">Your note:</span><br>${escapeHtml(order.customer_note)}`)
      : '',
    button('View your order', orderUrl),
    paragraph('We will write to you again with tracking details the moment your parcel is on its way.', { muted: true }),
  ].join('\n');

  const text = textLayout([
    `Thank you for your order`,
    `Dear ${greetingName(order)}, we have received your order and begun preparing it.`,
    textLine('Order', orderNumber),
    `Items:\n${itemsText(displayItems)}`,
    summaryText(order),
    `Delivery address:\n${addressText(order)}`,
    order.customer_note ? `Your note: ${order.customer_note}` : null,
    `View your order: ${orderUrl}`,
    'We will write to you again with tracking details the moment your parcel is on its way.',
  ]);

  return {
    subject,
    html: layout({
      title: subject,
      preheader: `Order ${orderNumber} is confirmed. Total ${formatPaise(Number(order.total_paise ?? 0))}.`,
      bodyHtml,
    }),
    text,
  };
}

/**
 * Sent when the admin enters an AWB and picks a courier.
 *
 * Two shapes, chosen by courier.supports_deep_link:
 *
 *   TRUE  - a prominent "Track your parcel" button to the resolved URL.
 *   FALSE - the tracking number rendered large, monospace and copyable, plus a
 *           plain link to the courier's tracking landing page and an
 *           instruction to paste the number there. Never a fabricated deep
 *           link. See docs/02-couriers.md Tier 3.
 *
 * Monospace matters for the non-deep-link case specifically: the customer has
 * to transcribe the number by eye, and a proportional font makes 0/O and 1/I/l
 * genuinely ambiguous on a thermal-printed AWB.
 */
export function orderShipped(order, items = [], shipment = {}, courier = {}, opts = {}) {
  const base = opts.siteUrl;
  const displayItems = items.map(toDisplayItem);
  const orderNumber = order.order_number ?? '';
  const trackingNumber = shipment?.tracking_number ?? '';
  const courierName = courier?.name ?? 'our courier partner';
  const deepLink = resolveTrackingUrl(shipment, courier);
  const landing = landingPage(courier);

  const subject = `Your order ${orderNumber} has shipped`;

  const trackingBlock = deepLink
    ? [
      paragraph(`Your parcel is on its way with <strong>${escapeHtml(courierName)}</strong>.`),
      panel(
        `<span style="font-family:${SANS}; font-size:11px; letter-spacing:1px; text-transform:uppercase; color:${BRAND.muted};">Tracking number</span><br>
         <span style="font-family:${MONO}; font-size:19px; letter-spacing:1px; color:${BRAND.ink};">${escapeHtml(trackingNumber)}</span>`,
        { accent: true }
      ),
      button('Track your parcel', deepLink),
    ].join('\n')
    : [
      paragraph(`Your parcel is on its way with <strong>${escapeHtml(courierName)}</strong>. Please use the tracking number below.`),
      // Large, monospace, selectable. user-select is set explicitly because a
      // few mobile clients suppress selection inside table cells.
      panel(
        `<span style="font-family:${SANS}; font-size:11px; letter-spacing:1px; text-transform:uppercase; color:${BRAND.muted};">Tracking number</span><br>
         <span style="font-family:${MONO}; font-size:26px; line-height:36px; font-weight:700; letter-spacing:2px; color:${BRAND.brand}; -webkit-user-select:all; user-select:all; word-break:break-all;">${escapeHtml(trackingNumber)}</span>`,
        { accent: true }
      ),
      landing
        ? paragraph(`${escapeHtml(courierName)} does not support direct tracking links, so please copy the number above and paste it into their tracking page: <a href="${escapeHtml(landing)}" style="color:${BRAND.brandSoft}; text-decoration:underline;">${escapeHtml(landing)}</a>`)
        : paragraph(`Please copy the number above and enter it on the ${escapeHtml(courierName)} tracking page.`),
    ].join('\n');

  const bodyHtml = [
    heading('Your parcel is on its way'),
    paragraph(`Dear ${escapeHtml(greetingName(order))}, order <strong>${escapeHtml(orderNumber)}</strong> has been handed to the courier.`),
    trackingBlock,
    `<div style="font-family:${SANS}; font-size:11px; letter-spacing:1px; text-transform:uppercase; color:${BRAND.muted}; padding-bottom:8px;">In this parcel</div>`,
    itemsTable(displayItems, summaryRows(order)),
    `<div style="font-family:${SANS}; font-size:11px; letter-spacing:1px; text-transform:uppercase; color:${BRAND.muted}; padding-bottom:8px;">Delivering to</div>`,
    panel(addressHtml(order)),
    paragraph('Couriers typically attempt two calls before returning a parcel, so please keep your phone reachable.', { muted: true }),
  ].join('\n');

  const trackingText = deepLink
    ? [
      `Your parcel is on its way with ${courierName}.`,
      `Tracking number: ${trackingNumber}`,
      `Track your parcel: ${deepLink}`,
    ]
    : [
      `Your parcel is on its way with ${courierName}.`,
      `Tracking number: ${trackingNumber}`,
      landing
        ? `${courierName} does not support direct tracking links. Please copy the number above and paste it into their tracking page:\n${landing}`
        : `Please copy the number above and enter it on the ${courierName} tracking page.`,
    ];

  const text = textLayout([
    'Your parcel is on its way',
    `Dear ${greetingName(order)}, order ${orderNumber} has been handed to the courier.`,
    ...trackingText,
    `In this parcel:\n${itemsText(displayItems)}`,
    summaryText(order),
    `Delivering to:\n${addressText(order)}`,
    'Couriers typically attempt two calls before returning a parcel, so please keep your phone reachable.',
  ]);

  return {
    subject,
    html: layout({
      title: subject,
      preheader: `${courierName} - tracking number ${trackingNumber}`,
      bodyHtml,
    }),
    text,
  };
}

/**
 * Terminal state. The review invite is the point of this email: reviews are
 * restricted to customers with a delivered order, so this is the only moment
 * the invitation is valid.
 */
export function orderDelivered(order, items = [], opts = {}) {
  const base = opts.siteUrl;
  const orderNumber = order.order_number ?? '';
  const subject = `Your order ${orderNumber} has been delivered`;

  // Review links need a product slug. Items carry one when the caller joins it
  // in; those that do not are simply omitted rather than linked to a 404.
  const reviewable = (items ?? []).filter((it) => it.slug || it.product_slug);
  const reviewLinks = reviewable.map((it) => {
    const slug = it.slug ?? it.product_slug;
    const href = url(`product/${encodeURIComponent(slug)}`, base);
    const name = it.product_name ?? it.name ?? slug;
    return `<li style="margin-bottom:6px;"><a href="${escapeHtml(href)}" style="color:${BRAND.brandSoft}; text-decoration:underline;">${escapeHtml(name)}</a></li>`;
  });

  const bodyHtml = [
    heading('Delivered - we hope you love it'),
    paragraph(`Dear ${escapeHtml(greetingName(order))}, your order <strong>${escapeHtml(orderNumber)}</strong> has been delivered. Thank you for letting us be part of your collection.`),
    paragraph('An attar unfolds over hours rather than minutes. Give it a little time on the skin before you judge it - and then, if you would, tell us what you found.'),
    reviewLinks.length
      ? `<div style="font-family:${SANS}; font-size:11px; letter-spacing:1px; text-transform:uppercase; color:${BRAND.muted}; padding-bottom:8px;">Review what you bought</div>
<ul style="margin:0 0 18px 0; padding-left:20px; font-family:${SANS}; font-size:15px; line-height:23px; color:${BRAND.ink};">${reviewLinks.join('')}</ul>`
      : button('Write a review', url('shop', base)),
    paragraph(`Something not right? Reply to this email or call us on ${escapeHtml('7003356210')} and we will put it right.`, { muted: true }),
  ].join('\n');

  const text = textLayout([
    'Delivered - we hope you love it',
    `Dear ${greetingName(order)}, your order ${orderNumber} has been delivered. Thank you for letting us be part of your collection.`,
    'An attar unfolds over hours rather than minutes. Give it a little time on the skin before you judge it - and then, if you would, tell us what you found.',
    reviewable.length
      ? `Review what you bought:\n${reviewable.map((it) => `  ${it.product_name ?? it.name}: ${url(`product/${encodeURIComponent(it.slug ?? it.product_slug)}`, base)}`).join('\n')}`
      : `Write a review: ${url('shop', base)}`,
    'Something not right? Reply to this email or call us on 7003356210 and we will put it right.',
  ]);

  return {
    subject,
    html: layout({ title: subject, preheader: `Order ${orderNumber} delivered. We would love your thoughts.`, bodyHtml }),
    text,
  };
}

/**
 * Sent on cancellation. The refund expectation is stated plainly and up front:
 * the single most common support question after a cancellation is "where is my
 * money", and answering it here costs nothing.
 */
export function orderCancelled(order, refundInfo = null, opts = {}) {
  const base = opts.siteUrl;
  const orderNumber = order.order_number ?? '';
  const subject = `Order ${orderNumber} has been cancelled`;

  const refundPaise = Number(
    refundInfo?.amount_paise ?? refundInfo?.amountPaise ?? order.total_paise ?? 0
  );
  const wasPaid = refundInfo != null && refundPaise > 0;

  const refundBlock = wasPaid
    ? panel(
      `<strong>Refund of ${escapeHtml(formatPaise(refundPaise))}</strong><br>
       This has been initiated to your original payment method. Banks typically take ${REFUND_WORKING_DAYS} to post it to your account.
       ${refundInfo?.razorpay_refund_id ? `<br><span style="color:${BRAND.muted}; font-size:13px;">Reference: ${escapeHtml(refundInfo.razorpay_refund_id)}</span>` : ''}`,
      { accent: true }
    )
    : panel('No payment was captured for this order, so there is nothing to refund.');

  const bodyHtml = [
    heading('Your order has been cancelled'),
    paragraph(`Dear ${escapeHtml(greetingName(order))}, order <strong>${escapeHtml(orderNumber)}</strong> has been cancelled.`),
    order.cancel_reason ? paragraph(`Reason: ${escapeHtml(order.cancel_reason)}`) : '',
    refundBlock,
    paragraph('If this was not what you intended, reply to this email and we will help you reorder.'),
    button('Continue shopping', url('shop', base)),
  ].join('\n');

  const text = textLayout([
    'Your order has been cancelled',
    `Dear ${greetingName(order)}, order ${orderNumber} has been cancelled.`,
    order.cancel_reason ? `Reason: ${order.cancel_reason}` : null,
    wasPaid
      ? `Refund of ${formatPaise(refundPaise)} has been initiated to your original payment method. Banks typically take ${REFUND_WORKING_DAYS} to post it to your account.${refundInfo?.razorpay_refund_id ? `\nReference: ${refundInfo.razorpay_refund_id}` : ''}`
      : 'No payment was captured for this order, so there is nothing to refund.',
    'If this was not what you intended, reply to this email and we will help you reorder.',
    `Continue shopping: ${url('shop', base)}`,
  ]);

  return {
    subject,
    html: layout({ title: subject, preheader: wasPaid ? `Refund of ${formatPaise(refundPaise)} initiated.` : 'Your order has been cancelled.', bodyHtml }),
    text,
  };
}

/** Password reset. The link carries a single-use token generated by the caller. */
export function passwordReset(customer, resetUrl, opts = {}) {
  const base = opts.siteUrl;
  const name = String(customer?.full_name ?? '').trim().split(/\s+/)[0] || 'there';
  const subject = 'Reset your password';

  const bodyHtml = [
    heading('Reset your password'),
    paragraph(`Dear ${escapeHtml(name)}, we received a request to reset the password for your ${escapeHtml(SHOP_NAME)} account.`),
    button('Choose a new password', resetUrl),
    paragraph(`This link expires in one hour and can be used once. If the button does not work, copy this address into your browser:<br><span style="font-family:${MONO}; font-size:12px; word-break:break-all; color:${BRAND.muted};">${escapeHtml(resetUrl)}</span>`, { muted: true }),
    paragraph('If you did not request this, you can safely ignore this email - your password has not been changed.', { muted: true }),
  ].join('\n');

  const text = textLayout([
    'Reset your password',
    `Dear ${name}, we received a request to reset the password for your ${SHOP_NAME} account.`,
    `Choose a new password:\n${resetUrl}`,
    'This link expires in one hour and can be used once.',
    'If you did not request this, you can safely ignore this email - your password has not been changed.',
    `Store: ${siteUrl(base)}`,
  ]);

  return {
    subject,
    html: layout({ title: subject, preheader: 'A link to choose a new password.', bodyHtml }),
    text,
  };
}

// ---------------------------------------------------------------------------
// Internal alerts (ADMIN_ALERT_EMAIL)
// ---------------------------------------------------------------------------

/**
 * New-order alert for the shop owner.
 *
 * Customer-supplied fields are escaped exactly as in customer-facing mail. The
 * admin inbox is not a trusted rendering context - if anything, it matters more
 * here, since this is the one email that echoes back the raw customer note.
 */
export function adminNewOrder(order, items = [], opts = {}) {
  const base = opts.siteUrl;
  const displayItems = items.map(toDisplayItem);
  const orderNumber = order.order_number ?? '';
  const total = formatPaise(Number(order.total_paise ?? 0));
  const subject = `New order ${orderNumber} - ${total}`;
  const adminUrl = url(`admin/orders/${encodeURIComponent(order.id ?? orderNumber)}`, base);

  const bodyHtml = [
    heading('New order received'),
    panel(
      `<strong>${escapeHtml(orderNumber)}</strong> &middot; ${escapeHtml(total)}<br>
       <span style="color:${BRAND.muted};">Payment: ${escapeHtml(order.payment_status ?? 'pending')} &middot; Zone: ${escapeHtml(order.ship_zone ?? '-')}</span>`,
      { accent: true }
    ),
    itemsTable(displayItems, summaryRows(order)),
    `<div style="font-family:${SANS}; font-size:11px; letter-spacing:1px; text-transform:uppercase; color:${BRAND.muted}; padding-bottom:8px;">Ship to</div>`,
    panel(`${addressHtml(order)}<br><span style="color:${BRAND.muted};">${escapeHtml(order.ship_email ?? '')}</span>`),
    order.customer_note
      ? panel(`<span style="color:${BRAND.muted};">Customer note:</span><br>${escapeHtml(order.customer_note)}`)
      : '',
    button('Open in admin', adminUrl),
  ].join('\n');

  const text = textLayout([
    'New order received',
    textLine('Order', orderNumber),
    textLine('Total', total),
    textLine('Payment', order.payment_status ?? 'pending'),
    textLine('Zone', order.ship_zone ?? '-'),
    `Items:\n${itemsText(displayItems)}`,
    summaryText(order),
    `Ship to:\n${addressText(order)}\n${order.ship_email ?? ''}`,
    order.customer_note ? `Customer note: ${order.customer_note}` : null,
    `Open in admin: ${adminUrl}`,
  ]);

  return {
    subject,
    html: layout({ title: subject, preheader: `${orderNumber} - ${total}`, bodyHtml }),
    text,
  };
}

/**
 * Low-stock alert. Lists product name, size and remaining quantity so the owner
 * can act from the email without opening the panel.
 */
export function adminLowStock(variants = [], opts = {}) {
  const base = opts.siteUrl;
  const count = variants.length;
  const subject = count === 1
    ? '1 variant is low on stock'
    : `${count} variants are low on stock`;

  const rows = variants.map((v) => {
    const qty = Number(v.stock_qty ?? 0);
    // Zero is a different problem from merely low: it is already lost revenue.
    const danger = qty <= 0;
    const qtyColor = danger ? '#8C2F1E' : BRAND.ink;
    return `<tr>
      <td style="padding:10px 8px 10px 0; font-family:${SANS}; font-size:14px; color:${BRAND.ink}; border-bottom:1px solid ${BRAND.rule};">${escapeHtml(v.product_name ?? v.name ?? '-')}</td>
      <td align="center" style="padding:10px 8px; font-family:${SANS}; font-size:14px; color:${BRAND.muted}; border-bottom:1px solid ${BRAND.rule};">${escapeHtml(sizeLabel(v.size_ml))}</td>
      <td align="right" style="padding:10px 0 10px 8px; font-family:${SANS}; font-size:14px; font-weight:600; color:${qtyColor}; border-bottom:1px solid ${BRAND.rule};">${escapeHtml(String(qty))}${danger ? ' (out)' : ''}</td>
    </tr>`;
  }).join('\n');

  const bodyHtml = [
    heading('Low stock'),
    paragraph('The following variants have reached their alert threshold.'),
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px 0; border-collapse:collapse;">
      <tr>
        <th align="left" style="padding:0 0 8px 0; font-family:${SANS}; font-size:11px; letter-spacing:1px; text-transform:uppercase; color:${BRAND.muted}; border-bottom:1px solid ${BRAND.rule};">Product</th>
        <th align="center" style="padding:0 0 8px 0; font-family:${SANS}; font-size:11px; letter-spacing:1px; text-transform:uppercase; color:${BRAND.muted}; border-bottom:1px solid ${BRAND.rule};">Size</th>
        <th align="right" style="padding:0 0 8px 0; font-family:${SANS}; font-size:11px; letter-spacing:1px; text-transform:uppercase; color:${BRAND.muted}; border-bottom:1px solid ${BRAND.rule};">Remaining</th>
      </tr>
${rows}
    </table>`,
    button('Open inventory', url('admin/inventory', base)),
  ].join('\n');

  const text = textLayout([
    'Low stock',
    'The following variants have reached their alert threshold.',
    variants
      .map((v) => `  ${v.product_name ?? v.name ?? '-'} (${sizeLabel(v.size_ml)}): ${Number(v.stock_qty ?? 0)} remaining`)
      .join('\n'),
    `Open inventory: ${url('admin/inventory', base)}`,
  ]);

  return {
    subject,
    html: layout({ title: subject, preheader: `${count} variant(s) at or below threshold.`, bodyHtml }),
    text,
  };
}
