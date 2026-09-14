-- Attar World Sonar Bangla — seed data
-- Safe to re-run: every insert is idempotent.

SET NAMES utf8mb4;

-- ---------------------------------------------------------------- shipping zones
-- ₹49 for Kolkata (700001-700199, incl. Salt Lake, New Town, Rajarhat).
-- ₹99 everywhere else. Howrah (711xxx) falls outside the cheap zone.

INSERT INTO shipping_zones (slug, name, rate_paise, is_fallback, sort_order) VALUES
  ('kolkata',       'Kolkata',       4900, FALSE, 10),
  ('rest_of_india', 'Rest of India', 9900, TRUE,  20)
ON DUPLICATE KEY UPDATE name = VALUES(name);

INSERT INTO shipping_zone_pincodes (zone_id, pincode_start, pincode_end)
SELECT z.id, '700001', '700199'
FROM shipping_zones z
WHERE z.slug = 'kolkata'
  AND NOT EXISTS (
    SELECT 1 FROM shipping_zone_pincodes p
    WHERE p.zone_id = z.id AND p.pincode_start = '700001'
  );

-- ---------------------------------------------------------------- couriers
-- Tracking URLs verified 2026-09-14 by request-testing each one.
-- supports_deep_link = FALSE where the courier CAPTCHA-gates or has no working
-- deep link: the email then shows a copyable number + landing page instead.
-- Full verification notes: docs/02-couriers.md

INSERT INTO couriers (name, slug, tracking_url_template, supports_deep_link, awb_pattern, sort_order) VALUES
  ('Blue Dart',             'bluedart',   'https://www.bluedart.com/web/guest/trackdartresultthirdparty?trackFor=0&trackNo={TRACKING_NUMBER}', TRUE,  '^[0-9]{8,11}$',        10),
  ('Delhivery',             'delhivery',  'https://www.delhivery.com/tracking?trackingId={TRACKING_NUMBER}',                                     TRUE,  '^[A-Z]{0,3}[0-9]{11,15}$', 20),
  ('XpressBees',            'xpressbees', 'https://www.xpressbees.com/track?isawb=Yes&trackid={TRACKING_NUMBER}',                                TRUE,  '^([0-9]{13,14}|[A-Z]{2}[0-9]{12})$', 30),
  ('Ekart',                 'ekart',      'https://ekartlogistics.com/shipmenttrack/{TRACKING_NUMBER}',                                          TRUE,  '^(FMPC|FMPP)[0-9]{10}$', 40),
  ('Amazon Shipping',       'amazon',     'https://track.amazon.in/tracking/{TRACKING_NUMBER}',                                                  TRUE,  '^TBA[0-9A-Z]{9,12}$',  50),
  ('India Post',            'indiapost',  'https://www.indiapost.gov.in/_layouts/15/DOP.Portal.Tracking/TrackConsignment.aspx',                  FALSE, '^[A-Z]{2}[0-9]{9}IN$', 60),
  ('DTDC',                  'dtdc',       'https://www.dtdc.com/track-your-shipment/',                                                           FALSE, NULL,                   70),
  ('Professional Couriers', 'tpc',        'https://www.tpcindia.com/track-info.aspx',                                                            FALSE, NULL,                   80),
  ('Trackon',               'trackon',    'https://www.trackon.in/courier-tracking',                                                             FALSE, NULL,                   90)
ON DUPLICATE KEY UPDATE
  tracking_url_template = VALUES(tracking_url_template),
  supports_deep_link    = VALUES(supports_deep_link),
  awb_pattern           = VALUES(awb_pattern);

-- ---------------------------------------------------------------- settings

INSERT INTO settings (key_name, value_json) VALUES
  ('store.name',            JSON_QUOTE('Attar World Sonar Bangla')),
  ('store.email',           JSON_QUOTE('sangatdutta65@gmail.com')),
  ('store.phone',           JSON_QUOTE('7003356210')),
  ('store.phone_alt',       JSON_QUOTE('9038571860')),
  ('store.address',         JSON_QUOTE('Dashadrone, Rajarhat, Kolkata - 700136')),
  ('checkout.reservation_minutes', CAST(30 AS JSON)),
  ('inventory.low_stock_default',  CAST(5 AS JSON)),
  ('reviews.auto_approve',  CAST(FALSE AS JSON)),
  -- No GST registration: no tax is calculated or displayed anywhere.
  ('tax.gst_registered',    CAST(FALSE AS JSON))
ON DUPLICATE KEY UPDATE value_json = VALUES(value_json);

-- ---------------------------------------------------------------- categories

INSERT INTO categories (slug, name, sort_order) VALUES
  ('oud',        'Oud',        10),
  ('floral',     'Floral',     20),
  ('musk',       'Musk',       30),
  ('amber',      'Amber',      40),
  ('gift-sets',  'Gift Sets',  50)
ON DUPLICATE KEY UPDATE name = VALUES(name);

-- ---------------------------------------------------------------- first admin
-- Password hash is set by `npm run create-admin`, never checked into git.
