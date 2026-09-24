-- Ashtagandha Powder is sold in 12.5g packets — a real, meaningful size that
-- SMALLINT UNSIGNED cannot represent. DECIMAL(6,1) holds one decimal place
-- (12.5, 25.0, 750.0) and is exact — never a float, so no 12.5000000001
-- surprise. Every existing value (3, 6, 12, 25, 35...) round-trips unchanged.
ALTER TABLE product_variants
  MODIFY COLUMN size_ml DECIMAL(6,1) UNSIGNED NOT NULL;

ALTER TABLE order_items
  MODIFY COLUMN size_ml DECIMAL(6,1) UNSIGNED NOT NULL;
