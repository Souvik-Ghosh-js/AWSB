// Pincode validation, deliberately free of any import chain.
//
// This lives apart from zones.js because zones.js needs the DB pool, which
// needs validated env, which exits the process when env is absent. Pure rules
// like this one must stay testable and reusable without booting the whole app.

const PINCODE_RE = /^[1-9][0-9]{5}$/;

/** Indian pincodes are exactly 6 digits and never start with 0. */
export function isValidPincode(pincode) {
  return PINCODE_RE.test(String(pincode ?? '').trim());
}

/** Trim and stringify a pincode for CHAR(6) comparison. */
export function normalisePincode(pincode) {
  return String(pincode ?? '').trim();
}
