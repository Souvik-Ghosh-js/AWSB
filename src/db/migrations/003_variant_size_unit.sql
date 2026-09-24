-- Not every product is sold in millilitres. Attars are; powders (Ashtagandha,
-- Javadhu) are sold by the gram; bakhoor and dhoopbatti are sold by the gram
-- or by stick-count. Those 9 products were force-fit into the 3/6/12 ml slots
-- as a stopgap, which is why the storefront has been printing "12 ml" on a
-- gram product. size_ml keeps its name (touches far less code than a rename)
-- but now means "the numeric size, whatever size_unit says it's a size of".
ALTER TABLE product_variants
  ADD COLUMN size_unit ENUM('ml', 'g', 'sticks') NOT NULL DEFAULT 'ml' AFTER size_ml;

-- The old (product_id, size_ml) key assumed size alone disambiguates a
-- variant. Once a product can have a "12 ml" AND, hypothetically, a "12 g"
-- variant, size_unit has to be part of the uniqueness check too.
ALTER TABLE product_variants
  DROP INDEX uniq_product_size,
  ADD UNIQUE KEY uniq_product_size_unit (product_id, size_ml, size_unit);

-- order_items snapshots size_ml at purchase time (see fk_item_variant's
-- ON DELETE SET NULL — a past order must stay readable after its variant is
-- gone). Every existing row predates this column and was genuinely sold in
-- ml, so the DEFAULT 'ml' backfill here is correct, not a placeholder.
ALTER TABLE order_items
  ADD COLUMN size_unit ENUM('ml', 'g', 'sticks') NOT NULL DEFAULT 'ml' AFTER size_ml;
