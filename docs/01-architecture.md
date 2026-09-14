# Attar World Sonar Bangla — Architecture

Version 0.1 · 2026-09-14 · status: draft for review

---

## 1. Shape of the system

Three deployables, deliberately separate so the storefront can scale and be cached independently of the admin/API.

```
┌─────────────────────┐        ┌──────────────────────────────────────┐
│  Storefront         │        │  AWS Lightsail instance              │
│  Next.js (App Rtr)  │ HTTPS  │  ┌────────────────────────────────┐  │
│  hosted separately  ├───────►│  │ Node + Express REST API        │  │
│  (Vercel/Amplify)   │        │  │ /api/v1/*                      │  │
└─────────────────────┘        │  └──────────┬─────────────────────┘  │
                               │             │                        │
┌─────────────────────┐        │  ┌──────────▼─────────────────────┐  │
│  Admin panel        │ HTTPS  │  │ MySQL 8 (Lightsail managed DB) │  │
│  Next.js, /admin    ├───────►│  └────────────────────────────────┘  │
│  (same app, gated)  │        │  ┌────────────────────────────────┐  │
└─────────────────────┘        │  │ nginx (TLS, reverse proxy)     │  │
                               │  └────────────────────────────────┘  │
       ┌───────────────────────┴──────────────────────────────────────┘
       │
       ├──► Razorpay (payments + webhooks)
       ├──► Gmail SMTP via Nodemailer (transactional email)
       └──► S3 or Lightsail object storage (product images)
```

**Why the API is separate from the storefront.** You asked to host the frontend separately. That means the storefront must never hold a DB connection or a Razorpay secret — it talks to the API over HTTPS like any other client. The admin panel lives in the same Next.js app under `/admin` but is gated by role, so there's one frontend build and one deployment pipeline rather than two.

> **Open decision:** admin panel as a route in the storefront app (simpler, one deploy) vs. a fully separate app (stricter isolation, no chance of leaking admin bundles to shoppers). Recommendation is the former with route-level code splitting; flag if you'd rather have hard separation.

---

## 2. Data model

MySQL 8, InnoDB, `utf8mb4`. All money is stored as **integer paise**, never floats — `₹450.00` is `45000`. All timestamps UTC.

### 2.1 Catalogue

```sql
-- A fragrance. Not directly purchasable; you buy a variant.
CREATE TABLE products (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  slug            VARCHAR(160) NOT NULL UNIQUE,   -- 'waalid-shamama'
  name            VARCHAR(160) NOT NULL,          -- 'Waalid Shamama'
  tagline         VARCHAR(255) NULL,
  description     MEDIUMTEXT NULL,                -- long copy, markdown
  scent_family    VARCHAR(80) NULL,               -- 'Oud', 'Floral', 'Musk'
  scent_notes     JSON NULL,                      -- {top:[],heart:[],base:[]}
  status          ENUM('draft','active','archived') NOT NULL DEFAULT 'draft',
  is_featured     BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order      INT NOT NULL DEFAULT 0,
  meta_title      VARCHAR(180) NULL,              -- SEO override
  meta_description VARCHAR(320) NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at      TIMESTAMP NULL,                 -- soft delete
  INDEX idx_status_featured (status, is_featured),
  INDEX idx_slug (slug)
) ENGINE=InnoDB;

-- 3ml / 6ml / 12ml. Independent price AND stock per size, as specified.
CREATE TABLE product_variants (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  product_id      BIGINT UNSIGNED NOT NULL,
  size_ml         SMALLINT UNSIGNED NOT NULL,     -- 3, 6, 12
  sku             VARCHAR(64) NOT NULL UNIQUE,    -- 'AWSB-WSH-03'
  price_paise     INT UNSIGNED NOT NULL,
  compare_at_paise INT UNSIGNED NULL,             -- struck-through 'was' price
  stock_qty       INT NOT NULL DEFAULT 0,
  low_stock_threshold INT NOT NULL DEFAULT 5,     -- per-variant alert level
  is_enabled      BOOLEAN NOT NULL DEFAULT TRUE,  -- hide one size w/o deleting
  weight_grams    SMALLINT UNSIGNED NULL,         -- for courier paperwork
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_product_size (product_id, size_ml),
  CONSTRAINT fk_variant_product FOREIGN KEY (product_id)
    REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT chk_stock_nonneg CHECK (stock_qty >= 0)
) ENGINE=InnoDB;
```

`chk_stock_nonneg` is load-bearing. It is the last line of defence against overselling — even if application logic has a race, the database refuses to go negative.

```sql
-- 2-3 images per product, ordered.
CREATE TABLE product_images (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  product_id      BIGINT UNSIGNED NOT NULL,
  url             VARCHAR(512) NOT NULL,
  alt_text        VARCHAR(255) NULL,              -- accessibility + SEO
  sort_order      TINYINT UNSIGNED NOT NULL DEFAULT 0,
  is_primary      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_image_product FOREIGN KEY (product_id)
    REFERENCES products(id) ON DELETE CASCADE,
  INDEX idx_product_sort (product_id, sort_order)
) ENGINE=InnoDB;

CREATE TABLE categories (
  id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  slug        VARCHAR(120) NOT NULL UNIQUE,
  name        VARCHAR(120) NOT NULL,
  description TEXT NULL,
  sort_order  INT NOT NULL DEFAULT 0
) ENGINE=InnoDB;

CREATE TABLE product_categories (
  product_id  BIGINT UNSIGNED NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (product_id, category_id),
  CONSTRAINT fk_pc_product  FOREIGN KEY (product_id)  REFERENCES products(id)   ON DELETE CASCADE,
  CONSTRAINT fk_pc_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
) ENGINE=InnoDB;
```

> **Terminology note.** You called 3ml/6ml/12ml "categories". In the schema they're **variants** (a size of one fragrance), and `categories` is kept for genuine grouping like "Oud", "Floral", "Gift Sets". Say the word if you'd rather drop `categories` entirely for v1.

### 2.2 Customers

```sql
CREATE TABLE customers (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  email           VARCHAR(255) NOT NULL UNIQUE,
  phone           VARCHAR(20) NULL,
  full_name       VARCHAR(160) NULL,
  password_hash   VARCHAR(255) NULL,      -- NULL = guest, never registered
  email_verified_at TIMESTAMP NULL,
  marketing_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_email (email)
) ENGINE=InnoDB;

-- Addresses are SNAPSHOTTED onto the order, not referenced. See §2.3.
CREATE TABLE customer_addresses (
  id           BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  customer_id  BIGINT UNSIGNED NOT NULL,
  full_name    VARCHAR(160) NOT NULL,
  phone        VARCHAR(20) NOT NULL,
  line1        VARCHAR(255) NOT NULL,
  line2        VARCHAR(255) NULL,
  city         VARCHAR(120) NOT NULL,
  state        VARCHAR(120) NOT NULL,
  pincode      VARCHAR(10) NOT NULL,
  country      CHAR(2) NOT NULL DEFAULT 'IN',
  is_default   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_addr_customer FOREIGN KEY (customer_id)
    REFERENCES customers(id) ON DELETE CASCADE
) ENGINE=InnoDB;
```

### 2.3 Orders

```sql
CREATE TABLE orders (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  order_number    VARCHAR(20) NOT NULL UNIQUE,    -- 'AWSB-2026-00417', human-facing
  customer_id     BIGINT UNSIGNED NULL,           -- NULL for pure guest checkout

  status          ENUM('pending_payment','confirmed','packed','shipped',
                       'delivered','cancelled','refunded') NOT NULL DEFAULT 'pending_payment',
  payment_status  ENUM('pending','paid','failed','refunded','partially_refunded')
                       NOT NULL DEFAULT 'pending',

  -- Money, all integer paise
  subtotal_paise  INT UNSIGNED NOT NULL,
  discount_paise  INT UNSIGNED NOT NULL DEFAULT 0,
  shipping_paise  INT UNSIGNED NOT NULL DEFAULT 0,
  total_paise     INT UNSIGNED NOT NULL,
  currency        CHAR(3) NOT NULL DEFAULT 'INR',
  coupon_id       BIGINT UNSIGNED NULL,
  coupon_code     VARCHAR(40) NULL,               -- snapshot

  -- Shipping address SNAPSHOT (never a FK — see note below)
  -- Every field below is REQUIRED except line2/landmark. See §3.3 on address quality.
  ship_full_name  VARCHAR(160) NOT NULL,
  ship_phone      VARCHAR(20) NOT NULL,
  ship_alt_phone  VARCHAR(20) NULL,               -- second number; couriers call twice
  ship_email      VARCHAR(255) NOT NULL,
  ship_line1      VARCHAR(255) NOT NULL,          -- house/flat no. + building
  ship_line2      VARCHAR(255) NULL,              -- area, street, sector
  ship_landmark   VARCHAR(160) NULL,              -- 'near …' — real delivery aid in IN
  ship_city       VARCHAR(120) NOT NULL,
  ship_district   VARCHAR(120) NULL,              -- autofilled from pincode
  ship_state      VARCHAR(120) NOT NULL,
  ship_pincode    CHAR(6) NOT NULL,               -- exactly 6 digits, validated
  ship_country    CHAR(2) NOT NULL DEFAULT 'IN',
  ship_zone       ENUM('kolkata','rest_of_india') NOT NULL,  -- decides shipping rate

  customer_note   TEXT NULL,
  admin_note      TEXT NULL,                      -- internal, never shown to customer
  cancel_reason   VARCHAR(255) NULL,

  placed_at       TIMESTAMP NULL,                 -- set when payment confirmed
  shipped_at      TIMESTAMP NULL,
  delivered_at    TIMESTAMP NULL,
  cancelled_at    TIMESTAMP NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_order_customer FOREIGN KEY (customer_id)
    REFERENCES customers(id) ON DELETE SET NULL,
  INDEX idx_status (status),
  INDEX idx_payment_status (payment_status),
  INDEX idx_created (created_at),
  INDEX idx_customer (customer_id)
) ENGINE=InnoDB;
```

**Why the address is copied, not linked.** If a customer edits their saved address next year, a FK would silently rewrite where last year's parcel was sent. Order records must be immutable history. Same reasoning applies to `order_items` below.

```sql
CREATE TABLE order_items (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  order_id        BIGINT UNSIGNED NOT NULL,
  variant_id      BIGINT UNSIGNED NULL,           -- SET NULL if product later deleted
  -- Snapshots: the order must read correctly even if the product is renamed/deleted
  product_name    VARCHAR(160) NOT NULL,
  size_ml         SMALLINT UNSIGNED NOT NULL,
  sku             VARCHAR(64) NOT NULL,
  unit_price_paise INT UNSIGNED NOT NULL,
  quantity        SMALLINT UNSIGNED NOT NULL,
  line_total_paise INT UNSIGNED NOT NULL,
  CONSTRAINT fk_item_order FOREIGN KEY (order_id)
    REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_item_variant FOREIGN KEY (variant_id)
    REFERENCES product_variants(id) ON DELETE SET NULL,
  INDEX idx_order (order_id)
) ENGINE=InnoDB;
```

### 2.4 Payments

```sql
CREATE TABLE payments (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  order_id            BIGINT UNSIGNED NOT NULL,
  razorpay_order_id   VARCHAR(64) NOT NULL,
  razorpay_payment_id VARCHAR(64) NULL,
  razorpay_signature  VARCHAR(255) NULL,
  amount_paise        INT UNSIGNED NOT NULL,
  status              ENUM('created','authorized','captured','failed','refunded')
                        NOT NULL DEFAULT 'created',
  method              VARCHAR(32) NULL,           -- upi / card / netbanking
  error_code          VARCHAR(64) NULL,
  error_description   VARCHAR(512) NULL,
  raw_payload         JSON NULL,                  -- full webhook body, for disputes
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_payment_order FOREIGN KEY (order_id)
    REFERENCES orders(id) ON DELETE RESTRICT,
  UNIQUE KEY uniq_rzp_order (razorpay_order_id),
  INDEX idx_rzp_payment (razorpay_payment_id)
) ENGINE=InnoDB;

-- Every webhook we receive, logged before processing. Makes fulfilment idempotent
-- and gives you an audit trail when Razorpay and your DB disagree.
CREATE TABLE payment_webhook_events (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  event_id      VARCHAR(64) NOT NULL UNIQUE,      -- Razorpay's x-razorpay-event-id
  event_type    VARCHAR(64) NOT NULL,
  payload       JSON NOT NULL,
  processed_at  TIMESTAMP NULL,
  error         TEXT NULL,
  received_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_type_processed (event_type, processed_at)
) ENGINE=InnoDB;

CREATE TABLE refunds (
  id                 BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  order_id           BIGINT UNSIGNED NOT NULL,
  payment_id         BIGINT UNSIGNED NOT NULL,
  razorpay_refund_id VARCHAR(64) NULL UNIQUE,
  amount_paise       INT UNSIGNED NOT NULL,
  status             ENUM('pending','processed','failed') NOT NULL DEFAULT 'pending',
  reason             VARCHAR(255) NULL,
  initiated_by       BIGINT UNSIGNED NULL,        -- admin_users.id
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_refund_order   FOREIGN KEY (order_id)   REFERENCES orders(id)   ON DELETE RESTRICT,
  CONSTRAINT fk_refund_payment FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE RESTRICT
) ENGINE=InnoDB;
```

### 2.5 Shipping

```sql
-- Admin-editable list. Tracking URL has {TRACKING_NUMBER} substituted at send time.
CREATE TABLE couriers (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  name                VARCHAR(120) NOT NULL,      -- 'Delhivery'
  slug                VARCHAR(60) NOT NULL UNIQUE,
  tracking_url_template VARCHAR(512) NULL,        -- 'https://…?awb={TRACKING_NUMBER}'
  supports_deep_link  BOOLEAN NOT NULL DEFAULT TRUE, -- FALSE = email shows number + site link only
  phone               VARCHAR(40) NULL,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order          INT NOT NULL DEFAULT 0
) ENGINE=InnoDB;

CREATE TABLE shipments (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  order_id        BIGINT UNSIGNED NOT NULL,
  courier_id      BIGINT UNSIGNED NOT NULL,
  tracking_number VARCHAR(80) NOT NULL,
  tracking_url    VARCHAR(512) NULL,              -- resolved at creation, snapshotted
  scanned_image_url VARCHAR(512) NULL,            -- the label photo, kept as evidence
  ocr_raw_text    TEXT NULL,                      -- full OCR dump, for debugging misreads
  ocr_suggested   VARCHAR(80) NULL,               -- largest-font candidate OCR proposed
  ocr_confidence  DECIMAL(4,3) NULL,              -- 0..1 from the OCR engine
  was_ocr_edited  BOOLEAN NOT NULL DEFAULT FALSE, -- admin corrected the suggestion
  entry_method    ENUM('manual','scan') NOT NULL DEFAULT 'manual',
  shipped_at      TIMESTAMP NULL,
  delivered_at    TIMESTAMP NULL,
  notes           VARCHAR(512) NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ship_order   FOREIGN KEY (order_id)   REFERENCES orders(id)   ON DELETE CASCADE,
  CONSTRAINT fk_ship_courier FOREIGN KEY (courier_id) REFERENCES couriers(id) ON DELETE RESTRICT,
  INDEX idx_order (order_id),
  INDEX idx_tracking (tracking_number)
) ENGINE=InnoDB;
```

Courier seed rows and verified tracking URL templates are in [`02-couriers.md`](02-couriers.md). Several widely-published patterns turned out to be fabricated or CAPTCHA-gated, so `supports_deep_link = FALSE` marks those: the email then shows a large copyable tracking number plus a link to the courier's tracking page, rather than a broken deep link that reads as a scam.

### 2.6 Inventory, coupons, reviews, admin

```sql
-- Append-only ledger. Never UPDATE stock without writing a row here.
CREATE TABLE inventory_movements (
  id           BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  variant_id   BIGINT UNSIGNED NOT NULL,
  delta        INT NOT NULL,                      -- -2 sold, +50 restock
  reason       ENUM('sale','restock','cancellation','refund',
                    'manual_adjustment','damage') NOT NULL,
  order_id     BIGINT UNSIGNED NULL,
  note         VARCHAR(255) NULL,
  actor_id     BIGINT UNSIGNED NULL,
  balance_after INT NOT NULL,                     -- stock level after this move
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_move_variant FOREIGN KEY (variant_id)
    REFERENCES product_variants(id) ON DELETE CASCADE,
  INDEX idx_variant_time (variant_id, created_at)
) ENGINE=InnoDB;
```

This ledger is what makes "where did my stock go?" answerable. `product_variants.stock_qty` is the fast current value; this table is the explanation.

```sql
CREATE TABLE coupons (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  code              VARCHAR(40) NOT NULL UNIQUE,  -- stored UPPERCASE
  description       VARCHAR(255) NULL,
  discount_type     ENUM('percent','fixed') NOT NULL,
  discount_value    INT UNSIGNED NOT NULL,        -- percent: 10 = 10%; fixed: paise
  max_discount_paise INT UNSIGNED NULL,           -- caps a percent discount
  min_order_paise   INT UNSIGNED NOT NULL DEFAULT 0,
  usage_limit       INT UNSIGNED NULL,            -- NULL = unlimited
  usage_limit_per_customer INT UNSIGNED NULL,
  used_count        INT UNSIGNED NOT NULL DEFAULT 0,
  starts_at         TIMESTAMP NULL,
  expires_at        TIMESTAMP NULL,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE coupon_redemptions (
  id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  coupon_id   BIGINT UNSIGNED NOT NULL,
  order_id    BIGINT UNSIGNED NOT NULL,
  customer_id BIGINT UNSIGNED NULL,
  amount_paise INT UNSIGNED NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_redeem_coupon FOREIGN KEY (coupon_id) REFERENCES coupons(id) ON DELETE CASCADE,
  CONSTRAINT fk_redeem_order  FOREIGN KEY (order_id)  REFERENCES orders(id)  ON DELETE CASCADE,
  UNIQUE KEY uniq_coupon_order (coupon_id, order_id)
) ENGINE=InnoDB;

-- Reviews: only from customers with a delivered order for that product.
CREATE TABLE reviews (
  id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  product_id  BIGINT UNSIGNED NOT NULL,
  customer_id BIGINT UNSIGNED NULL,
  order_id    BIGINT UNSIGNED NULL,               -- proves verified purchase
  rating      TINYINT UNSIGNED NOT NULL,          -- 1..5
  title       VARCHAR(160) NULL,
  body        TEXT NULL,
  author_name VARCHAR(120) NOT NULL,
  status      ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  is_verified_purchase BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_review_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT chk_rating CHECK (rating BETWEEN 1 AND 5),
  INDEX idx_product_status (product_id, status)
) ENGINE=InnoDB;

-- General site feedback, separate from product reviews.
CREATE TABLE feedback (
  id         BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  name       VARCHAR(120) NULL,
  email      VARCHAR(255) NULL,
  subject    VARCHAR(200) NULL,
  message    TEXT NOT NULL,
  order_id   BIGINT UNSIGNED NULL,
  status     ENUM('new','read','responded','closed') NOT NULL DEFAULT 'new',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_status (status)
) ENGINE=InnoDB;

CREATE TABLE admin_users (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  email         VARCHAR(255) NOT NULL UNIQUE,
  full_name     VARCHAR(160) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,            -- argon2id
  role          ENUM('owner','manager','staff') NOT NULL DEFAULT 'staff',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMP NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Who changed what. Essential once more than one person touches orders.
CREATE TABLE audit_log (
  id           BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  actor_id     BIGINT UNSIGNED NULL,
  actor_email  VARCHAR(255) NULL,
  action       VARCHAR(80) NOT NULL,              -- 'order.status_changed'
  entity_type  VARCHAR(60) NOT NULL,
  entity_id    BIGINT UNSIGNED NULL,
  before_json  JSON NULL,
  after_json   JSON NULL,
  ip_address   VARCHAR(45) NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_entity (entity_type, entity_id),
  INDEX idx_created (created_at)
) ENGINE=InnoDB;

-- Admin bell notifications: new order, low stock, payment failed.
CREATE TABLE notifications (
  id         BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  type       VARCHAR(60) NOT NULL,
  title      VARCHAR(200) NOT NULL,
  body       VARCHAR(512) NULL,
  entity_type VARCHAR(60) NULL,
  entity_id  BIGINT UNSIGNED NULL,
  is_read    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_unread (is_read, created_at)
) ENGINE=InnoDB;

-- Outbound email log: proof of what was sent, and retry for failures.
CREATE TABLE email_log (
  id           BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  to_email     VARCHAR(255) NOT NULL,
  template     VARCHAR(80) NOT NULL,
  subject      VARCHAR(255) NOT NULL,
  order_id     BIGINT UNSIGNED NULL,
  status       ENUM('queued','sent','failed') NOT NULL DEFAULT 'queued',
  error        TEXT NULL,
  attempts     TINYINT UNSIGNED NOT NULL DEFAULT 0,
  sent_at      TIMESTAMP NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_status (status)
) ENGINE=InnoDB;

-- Admin-editable key/value: shipping flat rate, free-ship threshold, store address.
CREATE TABLE settings (
  key_name   VARCHAR(80) PRIMARY KEY,
  value_json JSON NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;
```

---

## 3. Order lifecycle

```
                    ┌──────────────────┐
  Checkout starts   │ pending_payment  │  stock RESERVED here
  (Razorpay order   └────────┬─────────┘
   created)                  │
              order.paid ────┤──── payment fails / 30-min timeout
              (webhook)      │                    │
                             ▼                    ▼
                    ┌──────────────────┐   ┌─────────────┐
   auto-accepted →  │    confirmed     │   │  cancelled  │ stock RELEASED
                    └────────┬─────────┘   └─────────────┘
                             │                    ▲
             admin packs     │                    │ admin cancels
                             ▼                    │ (+ Razorpay refund)
                    ┌──────────────────┐          │
                    │      packed      │──────────┤
                    └────────┬─────────┘          │
      admin enters AWB       │                    │
      + picks courier        ▼                    │
                    ┌──────────────────┐          │
                    │     shipped      │──────────┘
                    └────────┬─────────┘   (rare; manual refund)
       admin marks           │
                             ▼
                    ┌──────────────────┐
                    │    delivered     │  ← terminal; review invite sent
                    └──────────────────┘
```

**Emails fired:** `confirmed` → order confirmation w/ invoice. `shipped` → tracking number + courier deep link. `delivered` → thanks + review invite. `cancelled` → cancellation + refund note.

**Admin notified:** on `confirmed` (new order), on any low-stock crossing, on payment failure.

### 3.1 Stock, and how overselling is prevented

Stock is decremented **when the Razorpay order is created** (checkout start), not at payment success. Otherwise two buyers can both pay for the last 3ml bottle and one gets a refund and a bad memory of your shop.

```sql
START TRANSACTION;
  SELECT id, stock_qty FROM product_variants
    WHERE id IN (…) FOR UPDATE;          -- row locks, ordered by id to avoid deadlock
  UPDATE product_variants
     SET stock_qty = stock_qty - :qty
   WHERE id = :id AND stock_qty >= :qty; -- 0 rows affected = insufficient stock → abort
  INSERT INTO inventory_movements (…);
  INSERT INTO orders (… status='pending_payment');
COMMIT;
```

A sweeper job releases stock for `pending_payment` orders older than 30 minutes. Cancellation and refund both write a compensating `+qty` movement.

### 3.2 Shipping charges

Flat rate by zone, resolved from the delivery pincode at checkout:

| Zone | Rate | Applies to |
|---|---|---|
| `kolkata` | **₹49** (`4900` paise) | Kolkata pincodes |
| `rest_of_india` | **₹99** (`9900` paise) | Everything else |

```sql
-- Editable from the admin panel; no deploy needed to change a rate or add a pincode.
CREATE TABLE shipping_zones (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  slug          VARCHAR(40) NOT NULL UNIQUE,      -- 'kolkata'
  name          VARCHAR(120) NOT NULL,            -- 'Kolkata'
  rate_paise    INT UNSIGNED NOT NULL,            -- 4900
  free_above_paise INT UNSIGNED NULL,             -- NULL = no free-shipping threshold
  is_fallback   BOOLEAN NOT NULL DEFAULT FALSE,   -- exactly one row: rest_of_india
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order    INT NOT NULL DEFAULT 0
) ENGINE=InnoDB;

-- Pincodes belonging to a non-fallback zone. Ranges keep this small and editable.
CREATE TABLE shipping_zone_pincodes (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  zone_id       BIGINT UNSIGNED NOT NULL,
  pincode_start CHAR(6) NOT NULL,
  pincode_end   CHAR(6) NOT NULL,                 -- same as start for a single pincode
  CONSTRAINT fk_zp_zone FOREIGN KEY (zone_id)
    REFERENCES shipping_zones(id) ON DELETE CASCADE,
  INDEX idx_range (pincode_start, pincode_end)
) ENGINE=InnoDB;

INSERT INTO shipping_zones (slug, name, rate_paise, is_fallback, sort_order) VALUES
  ('kolkata',       'Kolkata',        4900, FALSE, 10),
  ('rest_of_india', 'Rest of India',  9900, TRUE,  20);

-- Confirmed range: Kolkata proper through Salt Lake, New Town and Rajarhat.
INSERT INTO shipping_zone_pincodes (zone_id, pincode_start, pincode_end)
SELECT id, '700001', '700199' FROM shipping_zones WHERE slug = 'kolkata';
```

`700001`–`700199` covers Kolkata proper plus Salt Lake, New Town and Rajarhat — including the shop's own `700136`. Howrah (`711xxx`) falls outside it and pays ₹99. The range lives in a table, so adjusting it later is an admin-panel edit, not a deploy.

Resolution is deliberate: look up the pincode in `shipping_zone_pincodes`; on no match, fall back to the `is_fallback` zone. The resolved rate and zone are **snapshotted onto the order**, so a later rate change never alters an existing order's total.

### 3.3 Address quality

Failed deliveries and courier re-attempt fees almost always trace back to a vague address, so the checkout enforces a complete one rather than accepting whatever is typed:

- **Required:** full name, phone, house/flat number + building (`line1`), city, state, 6-digit pincode.
- **Optional:** `line2` (area/street), landmark, alternate phone.
- **Pincode is validated** as exactly 6 digits and **autofills city, district and state** — which catches the common mismatch of a Delhi pincode with "Kolkata" typed above it. Autofilled fields stay editable, but a pincode/state contradiction warns before payment.
- **Phone** is validated as a 10-digit Indian mobile. An alternate number is offered because couriers typically attempt two calls before returning a parcel.
- The Place Order button stays disabled until the address is complete — cheaper to block at checkout than to pay for a returned shipment.

### 3.4 Payment integrity (verified against Razorpay docs, 2026-09-14)

Three details that silently break this integration, all confirmed from official docs:

1. **Checkout signature is `order_id + "|" + payment_id`** — order id first. Reversing it yields a valid-looking hash that never matches. HMAC-SHA256, hex, keyed with the **API key secret**. Use the `order_id` from our own DB, not the value the browser posts back.
2. **Webhooks use a different secret** — the webhook secret configured in the Razorpay dashboard, signed over the **entire raw body**, header `X-Razorpay-Signature`.
3. **Mount the webhook route with `express.raw({type:'application/json'})` before any global `express.json()`.** A global JSON parser ahead of it is the most common cause of failed verification, because re-stringifying a parsed body doesn't reproduce the original bytes.

Fulfilment triggers on the **`order.paid` webhook**, idempotent by `razorpay_order_id`, not on the browser handler — the browser can close mid-redirect. The handler only gives the shopper a fast "thank you" screen. Auto-capture is on (an authorized-but-uncaptured payment auto-refunds after 3 days). `payment.failed` can arrive *before* `payment.captured` on UPI retries, so it never irreversibly fails an order on its own.

---

## 4. API surface

`/api/v1`, JSON, JWT bearer auth. Public read endpoints are cacheable.

### Public
```
GET    /products                  ?category&search&sort&page
GET    /products/:slug            full detail, variants, images, approved reviews
GET    /categories
POST   /cart/validate             re-price + stock-check a cart before checkout
POST   /coupons/validate          {code, cart} → discount preview
POST   /checkout/session          create order + Razorpay order → {razorpay_order_id, amount}
POST   /checkout/verify           handler callback → provisional confirmation
POST   /webhooks/razorpay         raw body; signature-verified; authoritative
GET    /orders/track              ?order_number&email → guest status lookup
POST   /feedback
POST   /reviews                   requires delivered order
```

### Customer (JWT)
```
POST   /auth/register  /auth/login  /auth/forgot-password  /auth/reset-password
GET    /me  /me/orders  /me/orders/:orderNumber  /me/addresses
```

### Admin (JWT, role-gated)
```
POST   /admin/auth/login
GET    /admin/dashboard              revenue, top scents, low stock, recent orders
CRUD   /admin/products               + /:id/variants, /:id/images
PATCH  /admin/variants/:id/stock     manual adjustment → writes inventory_movements
GET    /admin/orders                 ?status&from&to&q
GET    /admin/orders/:id
POST   /admin/orders/:id/cancel      {reason} → auto Razorpay refund if paid
POST   /admin/orders/:id/ship        {courier_id, tracking_number, image?} → email
POST   /admin/orders/:id/deliver
CRUD   /admin/coupons  /admin/couriers  /admin/categories
GET    /admin/reviews                + PATCH /:id/status (moderation)
GET    /admin/feedback
GET    /admin/reports/sales.csv      ?from&to  (accounting/GST)
GET    /admin/notifications          + POST /:id/read
GET    /admin/inventory/low-stock
CRUD   /admin/settings  /admin/users
```

---

## 4A. Shipping a parcel (admin flow)

### 5.1 Reading the AWB off the label

The admin photographs or uploads the courier label; OCR extracts **the number printed in the largest font**, which on virtually every Indian courier label is the AWB — set large, usually directly under the barcode, because the delivery staff have to read it by eye.

```
photo/upload ─▶ OCR with per-word bounding boxes
                      │
                      ▼
          rank candidates by glyph height
          (tallest box wins; ties → nearest the barcode)
                      │
                      ▼
          strip label noise: 'AWB', 'No.', ':', spaces, hyphens
                      │
                      ▼
          check against the chosen courier's format
                      │
                      ▼
   PRE-FILL an editable field ─▶ admin confirms ─▶ save + email customer
```

The extracted number is **never submitted blind**. It lands in a normal editable input with the label photo shown beside it at full size, so confirming takes one glance. Typing it manually stays available and is the fallback whenever OCR is unsure.

Why the confirmation step is non-negotiable: a wrong AWB emails the customer a tracking link for somebody else's parcel, and nothing in the system will catch it afterwards. OCR routinely confuses `0`/`O`, `1`/`I`/`7`, `5`/`S` and `8`/`B` on thermal labels that are often smudged or skewed.

We keep the photo, the raw OCR text, the suggestion, its confidence, and `was_ocr_edited`. If the admin is correcting most suggestions, that flag is the evidence to change the approach rather than a guess.

**Implementation:** Tesseract.js (`tesseract.js` on npm) server-side, which needs no third-party service or per-scan cost, and returns the word-level bounding boxes the "largest font" heuristic depends on. If accuracy proves poor on real labels, Google Cloud Vision or AWS Textract are drop-in replacements behind the same interface — but start free, and measure with `was_ocr_edited`.

Format checking **warns, it never blocks** — a rejected legitimate AWB is worse than a typo, and the admin is looking at the label anyway.

---

## 5. Frontend

**Storefront** (Next.js App Router, server components for catalogue pages so products are indexable):
`/` · `/shop` · `/product/[slug]` · `/cart` · `/checkout` · `/order/[orderNumber]` · `/track` · `/about` · `/contact` · `/policies/{terms,privacy,refund,shipping}` · `/sitemap.xml` · `/robots.txt`

The four policy pages aren't optional filler — Razorpay **requires** visible Terms, Privacy, Refund/Cancellation and Shipping policy pages before international cards can be enabled.

**Admin** under `/admin`, role-gated: dashboard · orders (+ detail w/ ship & cancel actions) · products (+ variant stock editor) · inventory · coupons · couriers · reviews · feedback · reports · settings · users.

### Design direction — "heritage apothecary"

Cream and deep green, as chosen. Concretely:

| Token | Value | Use |
|---|---|---|
| `--bg` | `#FAF7F0` | warm ivory page ground |
| `--surface` | `#FFFFFF` / `#F3EEE3` | cards, raised panels |
| `--ink` | `#1F2A24` | body text, near-black green |
| `--brand` | `#14432A` | deep forest green — headers, buttons |
| `--brand-soft` | `#2D6A4F` | hovers, secondary |
| `--accent` | `#B08D3F` | antique gold — prices, rules, small flourishes |
| `--muted` | `#7A8079` | captions, meta |

Type: a classical serif for display (Cormorant Garamond / Playfair) against a quiet humanist sans for UI (Inter). Generous whitespace, thin gold rules, restrained motion, large product photography on ivory. Gold is an *accent only* — used sparingly it reads expensive; used broadly it reads cheap.

---

## 6. Deployment

**Lightsail:** 2 GB instance (Ubuntu 22.04) running Node under `pm2`, nginx terminating TLS via Let's Encrypt, UFW allowing 22/80/443 only. Managed MySQL instance — **not** MySQL on the same box — so backups and failover are handled for you. API on a subdomain (`api.<domain>`), storefront on the apex, CORS locked to those origins.

**Secrets** via `.env` on the instance, never committed: DB creds, `RZP_KEY_ID` / `RZP_KEY_SECRET` / `RZP_WEBHOOK_SECRET`, `JWT_SECRET`, Gmail SMTP user + App Password.

**Email:** Nodemailer over Gmail SMTP (`smtp.gmail.com:465`, App Password — *not* the account password; requires 2FA enabled). Honest limits: ~500 mails/day and mail is sent from a gmail.com identity, which some inboxes will filter. The mailer is written behind a thin interface so moving to SES or Brevo later is a config change, not a rewrite.

**Backups:** automated Lightsail DB snapshots (7-day retention) + weekly `mysqldump` to S3.

> **Domain is undecided.** Every place a domain is needed — CORS origins, email `From`/links, `NEXT_PUBLIC_SITE_URL`, sitemap, Razorpay webhook URL — will use a single `SITE_URL` env var so there's exactly one place to change.

---

## 7. Deliberately not in v1

Recorded so they're choices, not oversights: multi-currency, COD (excluded by request), courier API auto-tracking (admin enters AWB manually by design), gift cards, wishlists, abandoned-cart recovery, blog/CMS, GST invoice PDFs (CSV export covers accounting for now), multi-warehouse stock.

---

## 8. Settled

- **Shipping** — flat ₹49 for Kolkata pincodes, ₹99 elsewhere. Zone tables in §3.2.
- **GST** — **not registered.** No GSTIN, HSN codes or tax breakdown anywhere; prices are final and invoices are plain receipts. Revisit only if registration happens later.
- **Addresses** — full address enforced at checkout, pincode-validated. See §3.3.
- **AWB scanning** — OCR the label photo, extract the largest-font number, pre-fill for confirmation. See §5.1.

- **Kolkata pincodes** — `700001`–`700199` at ₹49. Howrah and beyond pay ₹99.
- **Admin panel** — a role-gated `/admin` route inside the storefront app. One build, one deploy.
- **Guest checkout** — on. `customer_id` stays nullable; an optional account is offered after payment.
- **Product images** — Lightsail object storage (S3-compatible), so images survive an instance rebuild.

## 9. Still open

Nothing blocking. Raise any of the above and it changes cheaply — rates and pincode ranges are admin-editable, and image storage sits behind one adapter.
