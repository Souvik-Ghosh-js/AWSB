// Rendering tests for the email layer. No SMTP, no database.
//
// These import templates.js and render.js ONLY - never mailer.js, which pulls
// in config/env.js (process.exit(1) on a missing var) and db/pool.js (opens a
// connection pool). That separation is the whole reason templates are pure,
// and it is what lets this suite run with no .env file present.
//
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  orderConfirmation,
  orderShipped,
  orderDelivered,
  orderCancelled,
  adminNewOrder,
  adminLowStock,
  passwordReset,
  resolveTrackingUrl,
} from '../src/services/mail/templates.js';
import { escapeHtml, siteUrl, url } from '../src/services/mail/render.js';

const SITE = 'https://attarworld.example';
const opts = { siteUrl: SITE };

const ORDER = {
  id: 417,
  order_number: 'AWSB-2026-00417',
  status: 'confirmed',
  payment_status: 'paid',
  subtotal_paise: 240000,
  discount_paise: 20000,
  shipping_paise: 4900,
  total_paise: 224900,
  coupon_code: 'ATTAR10',
  ship_full_name: 'Ritwik Chatterjee',
  ship_phone: '9038571860',
  ship_email: 'ritwik@example.com',
  ship_line1: 'Flat 3B, Sonar Bangla Apartments',
  ship_line2: 'Dashadrone, Rajarhat',
  ship_landmark: 'opposite the water tank',
  ship_city: 'Kolkata',
  ship_district: 'North 24 Parganas',
  ship_state: 'West Bengal',
  ship_pincode: '700136',
  ship_zone: 'kolkata',
  customer_note: 'Please pack the 12ml as a gift.',
};

const ITEMS = [
  {
    product_name: 'Waalid Shamama',
    slug: 'waalid-shamama',
    size_ml: 12,
    sku: 'AWSB-WSH-12',
    unit_price_paise: 180000,
    quantity: 1,
    line_total_paise: 180000,
  },
  {
    product_name: 'Ruh Khus',
    slug: 'ruh-khus',
    size_ml: 3,
    sku: 'AWSB-RKH-03',
    unit_price_paise: 30000,
    quantity: 2,
    line_total_paise: 60000,
  },
];

// Blue Dart: Tier 1, a verified working deep link.
const DEEP_LINK_COURIER = {
  name: 'Blue Dart',
  slug: 'bluedart',
  tracking_url_template:
    'https://www.bluedart.com/web/guest/trackdartresultthirdparty?trackFor=0&trackNo={TRACKING_NUMBER}',
  supports_deep_link: true,
};

// India Post: Tier 3, CAPTCHA-gated on every lookup. Cannot be deep linked.
const NO_DEEP_LINK_COURIER = {
  name: 'India Post',
  slug: 'indiapost',
  tracking_url_template:
    'https://www.indiapost.gov.in/_layouts/15/DOP.Portal.Tracking/TrackConsignment.aspx',
  supports_deep_link: false,
};

const TRACKING = 'EE123456789IN';
const SHIPMENT = { tracking_number: TRACKING, tracking_url: null };

/** Every template's common shape. */
function assertWellFormed(result, label) {
  assert.ok(result, `${label}: returned nothing`);
  assert.equal(typeof result.subject, 'string', `${label}: subject is not a string`);
  assert.ok(result.subject.trim().length > 0, `${label}: empty subject`);
  assert.equal(typeof result.html, 'string', `${label}: html is not a string`);
  assert.ok(result.html.trim().length > 0, `${label}: empty html`);
  assert.equal(typeof result.text, 'string', `${label}: text is not a string`);
  assert.ok(result.text.trim().length > 0, `${label}: empty text`);
}

/** Render one of each, for the suite-wide sweeps. */
function renderAll() {
  return {
    orderConfirmation: orderConfirmation(ORDER, ITEMS, null, opts),
    orderShippedDeep: orderShipped(ORDER, ITEMS, SHIPMENT, DEEP_LINK_COURIER, opts),
    orderShippedNoDeep: orderShipped(ORDER, ITEMS, SHIPMENT, NO_DEEP_LINK_COURIER, opts),
    orderDelivered: orderDelivered(ORDER, ITEMS, opts),
    orderCancelled: orderCancelled(ORDER, { amount_paise: 224900, razorpay_refund_id: 'rfnd_XYZ' }, opts),
    adminNewOrder: adminNewOrder(ORDER, ITEMS, opts),
    adminLowStock: adminLowStock(
      [
        { product_name: 'Waalid Shamama', size_ml: 3, stock_qty: 2 },
        { product_name: 'Ruh Khus', size_ml: 12, stock_qty: 0 },
      ],
      opts
    ),
    passwordReset: passwordReset({ full_name: 'Ritwik Chatterjee' }, `${SITE}/reset?token=abc123`, opts),
  };
}

test('every template produces a non-empty subject, html and text', () => {
  for (const [name, result] of Object.entries(renderAll())) {
    assertWellFormed(result, name);
  }
});

test('every template renders a complete HTML document capped at 600px', () => {
  for (const [name, result] of Object.entries(renderAll())) {
    assert.match(result.html, /^<!doctype html>/i, `${name}: not a full document`);
    assert.ok(result.html.includes('</html>'), `${name}: unterminated document`);
    assert.ok(result.html.includes('max-width:600px'), `${name}: missing the 600px cap`);
    // Brand ground and deep green must both be present.
    assert.ok(result.html.includes('#FAF7F0'), `${name}: missing cream ground`);
    assert.ok(result.html.includes('#14432A'), `${name}: missing deep green`);
  }
});

// --- The deep-link decision, which is the point of the shipped email --------

test('shipped email: deep-link courier gets a tracking button to the resolved URL', () => {
  const mail = orderShipped(ORDER, ITEMS, SHIPMENT, DEEP_LINK_COURIER, opts);
  const expected = DEEP_LINK_COURIER.tracking_url_template.replace('{TRACKING_NUMBER}', TRACKING);
  // In an href the ampersands are entity-encoded, which is the correct way to
  // put a query string into an HTML attribute - a bare & there is invalid markup.
  const expectedHref = expected.replace(/&/g, '&amp;');

  assert.ok(mail.html.includes(expectedHref), 'resolved tracking URL missing from html');
  assert.ok(mail.html.includes('Track your parcel'), 'missing the tracking button');
  assert.ok(mail.text.includes(expected), 'resolved tracking URL missing from text');
  assert.ok(mail.html.includes('Blue Dart'), 'courier name missing');
});

test('shipped email: non-deep-link courier never fabricates a tracking URL', () => {
  const mail = orderShipped(ORDER, ITEMS, SHIPMENT, NO_DEEP_LINK_COURIER, opts);

  // The core guarantee: the tracking number must not appear inside any URL.
  // A fabricated deep link is worse than no link - it lands the customer on an
  // error page or an empty form and reads as a phishing attempt.
  const urls = mail.html.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
  for (const u of urls) {
    assert.ok(
      !u.includes(TRACKING),
      `fabricated deep link containing the tracking number: ${u}`
    );
  }
  for (const u of mail.text.match(/https?:\/\/[^\s]+/g) ?? []) {
    assert.ok(!u.includes(TRACKING), `fabricated deep link in text: ${u}`);
  }

  // But the number itself must be present and prominent, plus the landing page.
  assert.ok(mail.html.includes(TRACKING), 'raw tracking number missing from html');
  assert.ok(mail.text.includes(TRACKING), 'raw tracking number missing from text');
  assert.ok(
    mail.html.includes(NO_DEEP_LINK_COURIER.tracking_url_template),
    'courier landing page link missing'
  );
  assert.ok(mail.html.includes('India Post'), 'courier name missing');
  assert.ok(!mail.html.includes('Track your parcel'), 'must not show a deep-link button');
  // Rendered monospace and large, because the customer must transcribe it.
  assert.match(mail.html, /monospace/i, 'tracking number is not monospace');
  // And told what to do with it.
  assert.match(mail.html, /paste|copy/i, 'no instruction to copy/paste the number');
});

test('shipped email: the two variants genuinely differ', () => {
  const deep = orderShipped(ORDER, ITEMS, SHIPMENT, DEEP_LINK_COURIER, opts);
  const flat = orderShipped(ORDER, ITEMS, SHIPMENT, NO_DEEP_LINK_COURIER, opts);
  assert.notEqual(deep.html, flat.html);
});

test('resolveTrackingUrl refuses to build a link for a non-deep-link courier', () => {
  assert.equal(resolveTrackingUrl(SHIPMENT, NO_DEEP_LINK_COURIER), null);
  assert.equal(
    resolveTrackingUrl(SHIPMENT, DEEP_LINK_COURIER),
    DEEP_LINK_COURIER.tracking_url_template.replace('{TRACKING_NUMBER}', TRACKING)
  );
  // A snapshotted URL on the shipment wins over the template.
  assert.equal(
    resolveTrackingUrl({ ...SHIPMENT, tracking_url: 'https://example.com/snapshot' }, DEEP_LINK_COURIER),
    'https://example.com/snapshot'
  );
  // Missing pieces must yield null rather than a half-built URL.
  assert.equal(resolveTrackingUrl({ tracking_number: null }, DEEP_LINK_COURIER), null);
  assert.equal(resolveTrackingUrl(SHIPMENT, null), null);
});

// --- Escaping ---------------------------------------------------------------

test('escapeHtml neutralises script tags and quotes', () => {
  assert.equal(
    escapeHtml('<script>alert("xss")</script>'),
    '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
  );
  assert.equal(escapeHtml(`O'Brien & "Sons"`), 'O&#39;Brien &amp; &quot;Sons&quot;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  // Ampersand must be escaped first, or the other entities get double-escaped.
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
});

test('a hostile customer name cannot inject markup into any template', () => {
  const hostile = '<script>alert("xss")</script>';
  const order = {
    ...ORDER,
    ship_full_name: hostile,
    customer_note: '"><img src=x onerror=alert(1)>',
    cancel_reason: '<b>reason</b>',
  };

  const rendered = [
    orderConfirmation(order, ITEMS, null, opts),
    orderShipped(order, ITEMS, SHIPMENT, NO_DEEP_LINK_COURIER, opts),
    orderDelivered(order, ITEMS, opts),
    orderCancelled(order, { amount_paise: 1000 }, opts),
    adminNewOrder(order, ITEMS, opts),
    passwordReset({ full_name: hostile }, `${SITE}/reset?token=x`, opts),
  ];

  for (const mail of rendered) {
    // The payload may still appear as inert escaped text - that is the point.
    // What must never appear is a live tag, so assert on the unescaped forms.
    assert.ok(!mail.html.includes('<script>'), 'raw <script> reached the output');
    assert.ok(!mail.html.includes('<img'), 'raw <img> tag reached the output');
    assert.ok(mail.html.includes('&lt;script&gt;'), 'the name was not escaped at all');
  }
});

test('the customer note is escaped in the admin alert too', () => {
  const order = { ...ORDER, customer_note: '<img src=x onerror=alert(1)>' };
  const mail = adminNewOrder(order, ITEMS, opts);
  assert.ok(!mail.html.includes('<img src=x'), 'admin inbox is not a trusted context');
  assert.ok(mail.html.includes('&lt;img'), 'note was not escaped');
});

// --- Money ------------------------------------------------------------------

test('money renders as grouped rupee amounts, never raw paise', () => {
  const mail = orderConfirmation(ORDER, ITEMS, null, opts);

  assert.ok(mail.html.includes('₹2,249.00'), 'grand total missing');   // 224900
  assert.ok(mail.html.includes('₹2,400.00'), 'subtotal missing');      // 240000
  assert.ok(mail.html.includes('₹1,800.00'), 'line total missing');    // 180000
  assert.ok(mail.html.includes('-₹200.00'), 'discount missing');       // 20000
  assert.ok(mail.html.includes('₹49.00'), 'Kolkata shipping missing'); // 4900
  assert.ok(mail.text.includes('₹2,249.00'), 'total missing from text');

  // The bare integer must never leak into the copy.
  assert.ok(!mail.text.includes('224900'), 'raw paise leaked into the text part');
});

test('free shipping prints as Free rather than a zero amount', () => {
  const mail = orderConfirmation({ ...ORDER, shipping_paise: 0 }, ITEMS, null, opts);
  assert.ok(mail.text.includes('Shipping: Free'));
  assert.ok(!mail.text.includes('Shipping: ₹0.00'));
});

test('an order without a coupon shows no discount row', () => {
  const mail = orderConfirmation(
    { ...ORDER, discount_paise: 0, coupon_code: null },
    ITEMS,
    null,
    opts
  );
  assert.ok(!mail.text.includes('Discount'), 'a zero discount row was rendered');
});

// --- Not GST registered -----------------------------------------------------

test('no template mentions GST, HSN or tax anywhere', () => {
  // The shop is not GST registered: no GSTIN, no HSN codes, no tax breakdown.
  // A "Tax: ₹0.00" line would be a compliance claim the shop cannot make.
  const forbidden = [/\bGST\b/i, /\bGSTIN\b/i, /\bHSN\b/i, /\btax(es|able|ation)?\b/i];

  for (const [name, mail] of Object.entries(renderAll())) {
    for (const part of ['subject', 'html', 'text']) {
      for (const pattern of forbidden) {
        assert.ok(
          !pattern.test(mail[part]),
          `${name}.${part} matches forbidden pattern ${pattern}`
        );
      }
    }
  }
});

// --- Content specifics ------------------------------------------------------

test('confirmation lists every item with its size and the delivery address', () => {
  const mail = orderConfirmation(ORDER, ITEMS, null, opts);

  assert.ok(mail.html.includes('Waalid Shamama'));
  assert.ok(mail.html.includes('Ruh Khus'));
  assert.ok(mail.html.includes('12 ml'), 'size label missing');
  assert.ok(mail.html.includes('3 ml'), 'size label missing');
  assert.ok(mail.html.includes('AWSB-2026-00417'), 'order number missing');
  assert.ok(mail.html.includes('700136'), 'pincode missing from address');
  assert.ok(mail.subject.includes('AWSB-2026-00417'), 'order number missing from subject');
});

test('delivered email invites a review and links to each product page', () => {
  const mail = orderDelivered(ORDER, ITEMS, opts);
  assert.ok(mail.html.includes(`${SITE}/product/waalid-shamama`), 'product link missing');
  assert.ok(mail.html.includes(`${SITE}/product/ruh-khus`), 'product link missing');
  assert.match(mail.html, /review/i, 'no review invitation');
});

test('cancellation states the refund amount and the 5-7 working day window', () => {
  const mail = orderCancelled(ORDER, { amount_paise: 224900 }, opts);
  assert.ok(mail.html.includes('₹2,249.00'), 'refund amount missing');
  assert.ok(mail.html.includes('5-7 working days'), 'refund window missing');

  // An unpaid order has nothing to refund and must not promise one.
  const unpaid = orderCancelled(ORDER, null, opts);
  assert.ok(!unpaid.html.includes('5-7 working days'));
  assert.match(unpaid.html, /nothing to refund/i);
});

test('low stock alert lists product, size and remaining quantity', () => {
  const mail = adminLowStock(
    [
      { product_name: 'Waalid Shamama', size_ml: 3, stock_qty: 2 },
      { product_name: 'Ruh Khus', size_ml: 12, stock_qty: 0 },
    ],
    opts
  );

  assert.ok(mail.html.includes('Waalid Shamama'));
  assert.ok(mail.html.includes('3 ml'));
  assert.ok(mail.text.includes('2 remaining'));
  assert.ok(mail.text.includes('0 remaining'));
  assert.ok(mail.subject.includes('2'), 'count missing from subject');
});

test('password reset carries the token link and no order data', () => {
  const resetUrl = `${SITE}/reset-password?token=abc123`;
  const mail = passwordReset({ full_name: 'Ritwik Chatterjee' }, resetUrl, opts);
  assert.ok(mail.html.includes(resetUrl), 'reset link missing');
  assert.ok(mail.text.includes(resetUrl), 'reset link missing from text');
  assert.ok(mail.html.includes('Ritwik'), 'greeting missing');
});

// --- Link building ----------------------------------------------------------

test('links are built from the supplied site URL without doubled slashes', () => {
  assert.equal(url('shop', 'https://example.com/'), 'https://example.com/shop');
  assert.equal(url('/shop', 'https://example.com'), 'https://example.com/shop');
  assert.equal(siteUrl('https://example.com///'), 'https://example.com');
});

test('templates render with no SITE_URL in the environment', () => {
  // The guarantee that keeps this suite runnable without a .env file: reading
  // the site URL must never reach config/env.js, which exits the process.
  const saved = process.env.SITE_URL;
  delete process.env.SITE_URL;
  try {
    const mail = orderConfirmation(ORDER, ITEMS);
    assertWellFormed(mail, 'orderConfirmation without SITE_URL');
    assert.ok(mail.html.includes('http://localhost:3000'), 'fallback site URL not used');
  } finally {
    if (saved !== undefined) process.env.SITE_URL = saved;
  }
});
