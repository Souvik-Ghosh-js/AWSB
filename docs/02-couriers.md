# Courier tracking links — verified reference

Verified 2026-09-14 by actually requesting each URL and checking whether the courier consumed the tracking number server-side, not by trusting published formats. **Several widely-cited "tracking URL formats" are wrong** — see Tier 3.

This is why `couriers.supports_deep_link` exists in the schema: for couriers that can't be deep-linked, the email shows a prominent, copyable tracking number plus a link to the tracking page, rather than dropping the customer on an empty form.

---

## Tier 1 — Verified working deep links

Confirmed: server renders a number-specific response.

| Courier | Template | Number format |
|---|---|---|
| **Blue Dart** | `https://www.bluedart.com/web/guest/trackdartresultthirdparty?trackFor=0&trackNo={TRACKING_NUMBER}` | numeric, 8–11 digits (usually 9 or 11) |
| **Amazon Shipping** | `https://track.amazon.in/tracking/{TRACKING_NUMBER}` | `TBA` + digits, ~12–15 alphanumeric |

## Tier 2 — Number carried, but results render client-side

The URL parameters are real and preserved across redirects, but the results paint via JavaScript, so the final state couldn't be confirmed headlessly. Almost certainly fine in a real browser. **Click-test each once with a live AWB before go-live.**

| Courier | Template | Number format |
|---|---|---|
| **Delhivery** | `https://www.delhivery.com/tracking?trackingId={TRACKING_NUMBER}` | 11–15 digits, sometimes `DRV`/`WPC` prefix |
| **XpressBees** | `https://www.xpressbees.com/track?isawb=Yes&trackid={TRACKING_NUMBER}` | 13–14 digits, or 2 letters + 12 digits |
| **Ekart** | `https://ekartlogistics.com/shipmenttrack/{TRACKING_NUMBER}` | `FMPC`/`FMPP` + 10 digits |

XpressBees uses `isawb` / `trackid` — **not** the `awb=` parameter most sources publish.

## Tier 3 — Cannot be deep-linked (`supports_deep_link = FALSE`)

| Courier | Landing page | Why |
|---|---|---|
| **India Post** | `https://www.indiapost.gov.in/_layouts/15/DOP.Portal.Tracking/TrackConsignment.aspx` | CAPTCHA on every lookup, by design |
| **Professional Couriers** | `https://www.tpcindia.com/track-info.aspx` | `?id={N}` *looks* like it works and echoes the number back, but it's a CAPTCHA gate |
| **Trackon** | `https://www.trackon.in/courier-tracking` | The widely-cited `trackon.in/track?awb=` **404s**. No working pattern found. |
| **Shiprocket** | `https://www.shiprocket.in/shipment-tracking/` | The cited `shiprocket.co/tracking/{AWB}` returns **HTTP 400** — the format is invented |
| **DTDC** | `https://www.dtdc.com/track-your-shipment/` | Legacy `tracking.dtdc.com/ctbs-tracking/…` host unreachable; verify from an Indian IP before trusting it |

**Shiprocket note:** a Shiprocket AWB normally belongs to an underlying carrier (Delhivery, XpressBees…). Prefer selecting that carrier directly so the customer gets a Tier 1/2 link.

---

## Seed SQL

```sql
INSERT INTO couriers (name, slug, tracking_url_template, supports_deep_link, sort_order) VALUES
('Blue Dart',             'bluedart',    'https://www.bluedart.com/web/guest/trackdartresultthirdparty?trackFor=0&trackNo={TRACKING_NUMBER}', TRUE,  10),
('Delhivery',             'delhivery',   'https://www.delhivery.com/tracking?trackingId={TRACKING_NUMBER}',                                       TRUE,  20),
('XpressBees',            'xpressbees',  'https://www.xpressbees.com/track?isawb=Yes&trackid={TRACKING_NUMBER}',                                  TRUE,  30),
('Ekart',                 'ekart',       'https://ekartlogistics.com/shipmenttrack/{TRACKING_NUMBER}',                                            TRUE,  40),
('Amazon Shipping',       'amazon',      'https://track.amazon.in/tracking/{TRACKING_NUMBER}',                                                    TRUE,  50),
('India Post',            'indiapost',   'https://www.indiapost.gov.in/_layouts/15/DOP.Portal.Tracking/TrackConsignment.aspx',                    FALSE, 60),
('DTDC',                  'dtdc',        'https://www.dtdc.com/track-your-shipment/',                                                             FALSE, 70),
('Professional Couriers', 'tpc',         'https://www.tpcindia.com/track-info.aspx',                                                              FALSE, 80),
('Trackon',               'trackon',     'https://www.trackon.in/courier-tracking',                                                               FALSE, 90);
```

## Validation

Safe to enforce: India Post `^[A-Z]{2}\d{9}IN$`, Blue Dart `^\d{8,11}$`. Other couriers vary enough that the admin UI should **warn, not block**, on format mismatch — a blocked legitimate AWB is worse than a typo.

## Maintenance

Courier sites change these URLs without notice, and aggregator sites confidently propagate stale patterns (the Trackon and Shiprocket cases). Templates live in the `couriers` table precisely so a dead link is fixed from the admin panel, with no deploy. Worth re-testing every few months.
