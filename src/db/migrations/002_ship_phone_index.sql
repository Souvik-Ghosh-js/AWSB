-- Guest order tracking can now match on ship_phone as well as ship_email
-- (see tracking.routes.js) — without an index this becomes a full table scan
-- as the orders table grows, same reasoning as idx_email.
CREATE INDEX idx_ship_phone ON orders (ship_phone);
