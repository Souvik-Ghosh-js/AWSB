-- Attar World Sonar Bangla — initial schema
-- MySQL 8, InnoDB, utf8mb4. Money is integer paise. Timestamps UTC.
-- Created in dependency order: parents before children.

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- ---------------------------------------------------------------- catalogue

CREATE TABLE products (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  slug             VARCHAR(160) NOT NULL UNIQUE,
  name             VARCHAR(160) NOT NULL,
  tagline          VARCHAR(255) NULL,
  description      MEDIUMTEXT NULL,
  scent_family     VARCHAR(80) NULL,
  scent_notes      JSON NULL,
  status           ENUM('draft','active','archived') NOT NULL DEFAULT 'draft',
  is_featured      BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order       INT NOT NULL DEFAULT 0,
  meta_title       VARCHAR(180) NULL,
  meta_description VARCHAR(320) NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at       TIMESTAMP NULL,
  INDEX idx_status_featured (status, is_featured),
  INDEX idx_sort (sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3ml / 6ml / 12ml. Independent price AND stock per size.
CREATE TABLE product_variants (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  product_id          BIGINT UNSIGNED NOT NULL,
  size_ml             SMALLINT UNSIGNED NOT NULL,
  sku                 VARCHAR(64) NOT NULL UNIQUE,
  price_paise         INT UNSIGNED NOT NULL,
  compare_at_paise    INT UNSIGNED NULL,
  stock_qty           INT NOT NULL DEFAULT 0,
  low_stock_threshold INT NOT NULL DEFAULT 5,
  is_enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  weight_grams        SMALLINT UNSIGNED NULL,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_product_size (product_id, size_ml),
  CONSTRAINT fk_variant_product FOREIGN KEY (product_id)
    REFERENCES products(id) ON DELETE CASCADE,
  -- Last line of defence against overselling, even if app logic loses a race.
  CONSTRAINT chk_stock_nonneg CHECK (stock_qty >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE product_images (
  id         BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  product_id BIGINT UNSIGNED NOT NULL,
  url        VARCHAR(512) NOT NULL,
  alt_text   VARCHAR(255) NULL,
  sort_order TINYINT UNSIGNED NOT NULL DEFAULT 0,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_image_product FOREIGN KEY (product_id)
    REFERENCES products(id) ON DELETE CASCADE,
  INDEX idx_product_sort (product_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE categories (
  id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  slug        VARCHAR(120) NOT NULL UNIQUE,
  name        VARCHAR(120) NOT NULL,
  description TEXT NULL,
  sort_order  INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE product_categories (
  product_id  BIGINT UNSIGNED NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (product_id, category_id),
  CONSTRAINT fk_pc_product  FOREIGN KEY (product_id)  REFERENCES products(id)   ON DELETE CASCADE,
  CONSTRAINT fk_pc_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- customers

CREATE TABLE customers (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  email             VARCHAR(255) NOT NULL UNIQUE,
  phone             VARCHAR(20) NULL,
  full_name         VARCHAR(160) NULL,
  password_hash     VARCHAR(255) NULL,   -- NULL = guest, never registered
  email_verified_at TIMESTAMP NULL,
  marketing_opt_in  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE customer_addresses (
  id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  customer_id BIGINT UNSIGNED NOT NULL,
  full_name   VARCHAR(160) NOT NULL,
  phone       VARCHAR(20) NOT NULL,
  alt_phone   VARCHAR(20) NULL,
  line1       VARCHAR(255) NOT NULL,
  line2       VARCHAR(255) NULL,
  landmark    VARCHAR(160) NULL,
  city        VARCHAR(120) NOT NULL,
  district    VARCHAR(120) NULL,
  state       VARCHAR(120) NOT NULL,
  pincode     CHAR(6) NOT NULL,
  country     CHAR(2) NOT NULL DEFAULT 'IN',
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_addr_customer FOREIGN KEY (customer_id)
    REFERENCES customers(id) ON DELETE CASCADE,
  INDEX idx_customer (customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- shipping zones

CREATE TABLE shipping_zones (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  slug             VARCHAR(40) NOT NULL UNIQUE,
  name             VARCHAR(120) NOT NULL,
  rate_paise       INT UNSIGNED NOT NULL,
  free_above_paise INT UNSIGNED NULL,
  is_fallback      BOOLEAN NOT NULL DEFAULT FALSE,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order       INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE shipping_zone_pincodes (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  zone_id       BIGINT UNSIGNED NOT NULL,
  pincode_start CHAR(6) NOT NULL,
  pincode_end   CHAR(6) NOT NULL,
  CONSTRAINT fk_zp_zone FOREIGN KEY (zone_id)
    REFERENCES shipping_zones(id) ON DELETE CASCADE,
  INDEX idx_range (pincode_start, pincode_end)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- coupons

CREATE TABLE coupons (
  id                       BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  code                     VARCHAR(40) NOT NULL UNIQUE,  -- stored UPPERCASE
  description              VARCHAR(255) NULL,
  discount_type            ENUM('percent','fixed') NOT NULL,
  discount_value           INT UNSIGNED NOT NULL,        -- percent: 10 = 10%; fixed: paise
  max_discount_paise       INT UNSIGNED NULL,
  min_order_paise          INT UNSIGNED NOT NULL DEFAULT 0,
  usage_limit              INT UNSIGNED NULL,
  usage_limit_per_customer INT UNSIGNED NULL,
  used_count               INT UNSIGNED NOT NULL DEFAULT 0,
  starts_at                TIMESTAMP NULL,
  expires_at               TIMESTAMP NULL,
  is_active                BOOLEAN NOT NULL DEFAULT TRUE,
  created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_active_code (is_active, code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- admin

CREATE TABLE admin_users (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  email         VARCHAR(255) NOT NULL UNIQUE,
  full_name     VARCHAR(160) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,   -- argon2id
  role          ENUM('owner','manager','staff') NOT NULL DEFAULT 'staff',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMP NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- orders

CREATE TABLE orders (
  id             BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  order_number   VARCHAR(20) NOT NULL UNIQUE,   -- 'AWSB-2026-00417'
  customer_id    BIGINT UNSIGNED NULL,          -- NULL for guest checkout

  status         ENUM('pending_payment','confirmed','packed','shipped',
                      'delivered','cancelled','refunded') NOT NULL DEFAULT 'pending_payment',
  payment_status ENUM('pending','paid','failed','refunded','partially_refunded')
                      NOT NULL DEFAULT 'pending',

  subtotal_paise INT UNSIGNED NOT NULL,
  discount_paise INT UNSIGNED NOT NULL DEFAULT 0,
  shipping_paise INT UNSIGNED NOT NULL DEFAULT 0,
  total_paise    INT UNSIGNED NOT NULL,
  currency       CHAR(3) NOT NULL DEFAULT 'INR',
  coupon_id      BIGINT UNSIGNED NULL,
  coupon_code    VARCHAR(40) NULL,              -- snapshot

  -- Address SNAPSHOT. Never a FK: editing a saved address must not rewrite
  -- where last year's parcel was sent.
  ship_full_name VARCHAR(160) NOT NULL,
  ship_phone     VARCHAR(20) NOT NULL,
  ship_alt_phone VARCHAR(20) NULL,
  ship_email     VARCHAR(255) NOT NULL,
  ship_line1     VARCHAR(255) NOT NULL,
  ship_line2     VARCHAR(255) NULL,
  ship_landmark  VARCHAR(160) NULL,
  ship_city      VARCHAR(120) NOT NULL,
  ship_district  VARCHAR(120) NULL,
  ship_state     VARCHAR(120) NOT NULL,
  ship_pincode   CHAR(6) NOT NULL,
  ship_country   CHAR(2) NOT NULL DEFAULT 'IN',
  ship_zone      ENUM('kolkata','rest_of_india') NOT NULL,

  customer_note  TEXT NULL,
  admin_note     TEXT NULL,                     -- internal, never shown to customer
  cancel_reason  VARCHAR(255) NULL,

  placed_at      TIMESTAMP NULL,
  shipped_at     TIMESTAMP NULL,
  delivered_at   TIMESTAMP NULL,
  cancelled_at   TIMESTAMP NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_order_customer FOREIGN KEY (customer_id)
    REFERENCES customers(id) ON DELETE SET NULL,
  CONSTRAINT fk_order_coupon FOREIGN KEY (coupon_id)
    REFERENCES coupons(id) ON DELETE SET NULL,
  INDEX idx_status (status),
  INDEX idx_payment_status (payment_status),
  INDEX idx_created (created_at),
  INDEX idx_customer (customer_id),
  INDEX idx_email (ship_email),
  -- Sweeper: find abandoned pending_payment orders to release stock.
  INDEX idx_sweep (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE order_items (
  id               BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  order_id         BIGINT UNSIGNED NOT NULL,
  variant_id       BIGINT UNSIGNED NULL,
  -- Snapshots: the order must read correctly even if the product is renamed or deleted.
  product_name     VARCHAR(160) NOT NULL,
  size_ml          SMALLINT UNSIGNED NOT NULL,
  sku              VARCHAR(64) NOT NULL,
  unit_price_paise INT UNSIGNED NOT NULL,
  quantity         SMALLINT UNSIGNED NOT NULL,
  line_total_paise INT UNSIGNED NOT NULL,
  CONSTRAINT fk_item_order FOREIGN KEY (order_id)
    REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_item_variant FOREIGN KEY (variant_id)
    REFERENCES product_variants(id) ON DELETE SET NULL,
  INDEX idx_order (order_id),
  INDEX idx_variant (variant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE coupon_redemptions (
  id           BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  coupon_id    BIGINT UNSIGNED NOT NULL,
  order_id     BIGINT UNSIGNED NOT NULL,
  customer_id  BIGINT UNSIGNED NULL,
  amount_paise INT UNSIGNED NOT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_redeem_coupon   FOREIGN KEY (coupon_id)   REFERENCES coupons(id)   ON DELETE CASCADE,
  CONSTRAINT fk_redeem_order    FOREIGN KEY (order_id)    REFERENCES orders(id)    ON DELETE CASCADE,
  CONSTRAINT fk_redeem_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
  UNIQUE KEY uniq_coupon_order (coupon_id, order_id),
  INDEX idx_coupon_customer (coupon_id, customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- payments

CREATE TABLE payments (
  id                  BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  order_id            BIGINT UNSIGNED NOT NULL,
  razorpay_order_id   VARCHAR(64) NOT NULL,
  razorpay_payment_id VARCHAR(64) NULL,
  razorpay_signature  VARCHAR(255) NULL,
  amount_paise        INT UNSIGNED NOT NULL,
  status              ENUM('created','authorized','captured','failed','refunded')
                        NOT NULL DEFAULT 'created',
  method              VARCHAR(32) NULL,
  error_code          VARCHAR(64) NULL,
  error_description   VARCHAR(512) NULL,
  raw_payload         JSON NULL,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_payment_order FOREIGN KEY (order_id)
    REFERENCES orders(id) ON DELETE RESTRICT,
  UNIQUE KEY uniq_rzp_order (razorpay_order_id),
  INDEX idx_rzp_payment (razorpay_payment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Every webhook logged before processing: makes fulfilment idempotent and
-- gives an audit trail when Razorpay and our DB disagree.
CREATE TABLE payment_webhook_events (
  id           BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  event_id     VARCHAR(64) NOT NULL UNIQUE,   -- x-razorpay-event-id
  event_type   VARCHAR(64) NOT NULL,
  payload      JSON NOT NULL,
  processed_at TIMESTAMP NULL,
  error        TEXT NULL,
  received_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_type_processed (event_type, processed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE refunds (
  id                 BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  order_id           BIGINT UNSIGNED NOT NULL,
  payment_id         BIGINT UNSIGNED NOT NULL,
  razorpay_refund_id VARCHAR(64) NULL UNIQUE,
  amount_paise       INT UNSIGNED NOT NULL,
  status             ENUM('pending','processed','failed') NOT NULL DEFAULT 'pending',
  reason             VARCHAR(255) NULL,
  initiated_by       BIGINT UNSIGNED NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_refund_order   FOREIGN KEY (order_id)     REFERENCES orders(id)      ON DELETE RESTRICT,
  CONSTRAINT fk_refund_payment FOREIGN KEY (payment_id)   REFERENCES payments(id)    ON DELETE RESTRICT,
  CONSTRAINT fk_refund_actor   FOREIGN KEY (initiated_by) REFERENCES admin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- shipping

CREATE TABLE couriers (
  id                    BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  name                  VARCHAR(120) NOT NULL,
  slug                  VARCHAR(60) NOT NULL UNIQUE,
  tracking_url_template VARCHAR(512) NULL,   -- {TRACKING_NUMBER} substituted at send time
  supports_deep_link    BOOLEAN NOT NULL DEFAULT TRUE,
  awb_pattern           VARCHAR(160) NULL,   -- regex; WARNS, never blocks
  phone                 VARCHAR(40) NULL,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order            INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE shipments (
  id                BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  order_id          BIGINT UNSIGNED NOT NULL,
  courier_id        BIGINT UNSIGNED NOT NULL,
  tracking_number   VARCHAR(80) NOT NULL,
  tracking_url      VARCHAR(512) NULL,       -- resolved at creation, snapshotted
  scanned_image_url VARCHAR(512) NULL,       -- the label photo, kept as evidence
  ocr_raw_text      TEXT NULL,               -- full OCR dump, for debugging misreads
  ocr_suggested     VARCHAR(80) NULL,        -- largest-font candidate OCR proposed
  ocr_confidence    DECIMAL(4,3) NULL,       -- 0..1
  was_ocr_edited    BOOLEAN NOT NULL DEFAULT FALSE,
  entry_method      ENUM('manual','scan') NOT NULL DEFAULT 'manual',
  shipped_at        TIMESTAMP NULL,
  delivered_at      TIMESTAMP NULL,
  notes             VARCHAR(512) NULL,
  created_by        BIGINT UNSIGNED NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ship_order   FOREIGN KEY (order_id)   REFERENCES orders(id)       ON DELETE CASCADE,
  CONSTRAINT fk_ship_courier FOREIGN KEY (courier_id) REFERENCES couriers(id)     ON DELETE RESTRICT,
  CONSTRAINT fk_ship_actor   FOREIGN KEY (created_by) REFERENCES admin_users(id)  ON DELETE SET NULL,
  INDEX idx_order (order_id),
  INDEX idx_tracking (tracking_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- inventory

-- Append-only ledger. Never UPDATE stock without writing a row here.
CREATE TABLE inventory_movements (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  variant_id    BIGINT UNSIGNED NOT NULL,
  delta         INT NOT NULL,            -- -2 sold, +50 restock
  reason        ENUM('sale','restock','cancellation','refund',
                     'manual_adjustment','damage','reservation_release') NOT NULL,
  order_id      BIGINT UNSIGNED NULL,
  note          VARCHAR(255) NULL,
  actor_id      BIGINT UNSIGNED NULL,
  balance_after INT NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_move_variant FOREIGN KEY (variant_id)
    REFERENCES product_variants(id) ON DELETE CASCADE,
  CONSTRAINT fk_move_order FOREIGN KEY (order_id)
    REFERENCES orders(id) ON DELETE SET NULL,
  CONSTRAINT fk_move_actor FOREIGN KEY (actor_id)
    REFERENCES admin_users(id) ON DELETE SET NULL,
  INDEX idx_variant_time (variant_id, created_at),
  INDEX idx_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- reviews & feedback

CREATE TABLE reviews (
  id                   BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  product_id           BIGINT UNSIGNED NOT NULL,
  customer_id          BIGINT UNSIGNED NULL,
  order_id             BIGINT UNSIGNED NULL,   -- proves verified purchase
  rating               TINYINT UNSIGNED NOT NULL,
  title                VARCHAR(160) NULL,
  body                 TEXT NULL,
  author_name          VARCHAR(120) NOT NULL,
  status               ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  is_verified_purchase BOOLEAN NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_review_product  FOREIGN KEY (product_id)  REFERENCES products(id)  ON DELETE CASCADE,
  CONSTRAINT fk_review_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
  CONSTRAINT fk_review_order    FOREIGN KEY (order_id)    REFERENCES orders(id)    ON DELETE SET NULL,
  CONSTRAINT chk_rating CHECK (rating BETWEEN 1 AND 5),
  -- One review per product per order.
  UNIQUE KEY uniq_order_product (order_id, product_id),
  INDEX idx_product_status (product_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE feedback (
  id         BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  name       VARCHAR(120) NULL,
  email      VARCHAR(255) NULL,
  subject    VARCHAR(200) NULL,
  message    TEXT NOT NULL,
  order_id   BIGINT UNSIGNED NULL,
  status     ENUM('new','read','responded','closed') NOT NULL DEFAULT 'new',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_feedback_order FOREIGN KEY (order_id)
    REFERENCES orders(id) ON DELETE SET NULL,
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------- back office

CREATE TABLE audit_log (
  id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  actor_id    BIGINT UNSIGNED NULL,
  actor_email VARCHAR(255) NULL,   -- denormalised: survives user deletion
  action      VARCHAR(80) NOT NULL,
  entity_type VARCHAR(60) NOT NULL,
  entity_id   BIGINT UNSIGNED NULL,
  before_json JSON NULL,
  after_json  JSON NULL,
  ip_address  VARCHAR(45) NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_entity (entity_type, entity_id),
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE notifications (
  id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  type        VARCHAR(60) NOT NULL,   -- order.new / stock.low / payment.failed
  title       VARCHAR(200) NOT NULL,
  body        VARCHAR(512) NULL,
  entity_type VARCHAR(60) NULL,
  entity_id   BIGINT UNSIGNED NULL,
  is_read     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_unread (is_read, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE email_log (
  id        BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  to_email  VARCHAR(255) NOT NULL,
  template  VARCHAR(80) NOT NULL,
  subject   VARCHAR(255) NOT NULL,
  order_id  BIGINT UNSIGNED NULL,
  status    ENUM('queued','sent','failed') NOT NULL DEFAULT 'queued',
  error     TEXT NULL,
  attempts  TINYINT UNSIGNED NOT NULL DEFAULT 0,
  sent_at   TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_email_order FOREIGN KEY (order_id)
    REFERENCES orders(id) ON DELETE SET NULL,
  INDEX idx_status (status, attempts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE settings (
  key_name   VARCHAR(80) PRIMARY KEY,
  value_json JSON NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Counter for human-facing order numbers (AWSB-2026-00001).
CREATE TABLE order_number_seq (
  year_part  SMALLINT UNSIGNED PRIMARY KEY,
  seq_value INT UNSIGNED NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
