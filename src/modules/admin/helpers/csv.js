// CSV writing for the accounting export.
//
// The shop is NOT GST registered, so this export carries no tax, GSTIN or HSN
// columns anywhere — prices are final and invoices are plain receipts.
//
// Pure: no pool import, so the escaping rules are unit-testable.

/**
 * Escape one CSV field per RFC 4180.
 * A field is quoted when it contains a comma, a quote, a newline or leading/
 * trailing whitespace; embedded quotes are doubled. Attar names regularly
 * contain commas ('Oud, Royal') and quotes, which is exactly what corrupts a
 * naive export when the accountant opens it.
 */
export function escapeCsvField(value) {
  if (value == null) return '';
  const s = String(value);
  const needsQuoting = /[",\r\n]/.test(s) || /^\s|\s$/.test(s);
  if (!needsQuoting) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/** Join one row of already-raw values into a CSV line (no trailing newline). */
export function toCsvRow(values) {
  return (values ?? []).map(escapeCsvField).join(',');
}

/** Column order for the sales export. Deliberately tax-free. */
export const SALES_CSV_COLUMNS = [
  'order_number',
  'placed_at',
  'status',
  'payment_status',
  'customer_name',
  'customer_email',
  'customer_phone',
  'ship_city',
  'ship_state',
  'ship_pincode',
  'ship_zone',
  'items',
  'subtotal_inr',
  'discount_inr',
  'coupon_code',
  'shipping_inr',
  'total_inr',
  'currency',
];

/** Paise -> a plain decimal string for a spreadsheet: 45050 -> '450.50'. */
export function paiseToCsvAmount(paise) {
  const n = Number(paise ?? 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(Math.round(n));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Map an orders row (joined to its items summary) onto SALES_CSV_COLUMNS. */
export function salesCsvRow(order) {
  return toCsvRow([
    order.order_number,
    order.placed_at ?? order.created_at,
    order.status,
    order.payment_status,
    order.ship_full_name,
    order.ship_email,
    order.ship_phone,
    order.ship_city,
    order.ship_state,
    order.ship_pincode,
    order.ship_zone,
    order.items_summary,
    paiseToCsvAmount(order.subtotal_paise),
    paiseToCsvAmount(order.discount_paise),
    order.coupon_code,
    paiseToCsvAmount(order.shipping_paise),
    paiseToCsvAmount(order.total_paise),
    order.currency,
  ]);
}
