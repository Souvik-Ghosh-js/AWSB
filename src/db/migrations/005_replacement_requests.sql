-- Replacement requests: a customer complains about a specific item on a
-- delivered order. Evidence (defect description + unboxing video) is emailed
-- separately to the shop inbox, not uploaded here — see project notes. This
-- table only tracks the request and the admin's decision, mirroring the
-- reviews table's pending/approved/rejected shape.
CREATE TABLE replacement_requests (
  id             BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  order_id       BIGINT UNSIGNED NOT NULL,
  order_item_id  BIGINT UNSIGNED NOT NULL,
  customer_id    BIGINT UNSIGNED NOT NULL,
  reason         TEXT NOT NULL,
  status         ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  admin_note     TEXT NULL,
  decided_by     BIGINT UNSIGNED NULL,
  decided_at     TIMESTAMP NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_replacement_order      FOREIGN KEY (order_id)      REFERENCES orders(id)        ON DELETE CASCADE,
  CONSTRAINT fk_replacement_order_item FOREIGN KEY (order_item_id) REFERENCES order_items(id)   ON DELETE CASCADE,
  CONSTRAINT fk_replacement_customer   FOREIGN KEY (customer_id)   REFERENCES customers(id)     ON DELETE CASCADE,
  CONSTRAINT fk_replacement_admin      FOREIGN KEY (decided_by)    REFERENCES admin_users(id)   ON DELETE SET NULL,
  INDEX idx_order (order_id),
  INDEX idx_status (status),
  INDEX idx_customer (customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
