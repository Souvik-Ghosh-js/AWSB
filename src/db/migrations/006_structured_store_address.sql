-- store.address is a single free-text line, fine for the settings page and
-- emails, but a printed shipping label needs the "from" address broken into
-- the same line1/city/state/pincode shape the "to" address already has on
-- every order — see orders.ship_line1/ship_city/ship_state/ship_pincode.
-- Seeded once here from the values already used across the app (frontend's
-- SHOP constant and the existing store.address string); admin-editable
-- afterwards from the Settings page like every other store.* key.
INSERT INTO settings (key_name, value_json) VALUES
  ('store.address_line1',   JSON_QUOTE('Dashadrone, Rajarhat')),
  ('store.address_city',    JSON_QUOTE('Kolkata')),
  ('store.address_state',   JSON_QUOTE('West Bengal')),
  ('store.address_pincode', JSON_QUOTE('700136'))
ON DUPLICATE KEY UPDATE value_json = value_json;
