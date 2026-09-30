import { env } from '../config/env.js';

// Tells the storefront to drop its cached copy of a product (and the shop
// grid) the moment stock actually changes, instead of waiting out the
// 5-minute ISR window. This is presentation-layer freshness only — checkout
// always re-checks live stock server-side regardless of what any cached page
// shows, so a missed or failed call here is never a correctness problem,
// only a stale badge for a few minutes. That is why every failure here is
// swallowed rather than thrown: revalidation must never fail the request
// that changed the stock.
export async function notifyStockChanged(productSlug) {
  if (!env.REVALIDATE_SECRET || !productSlug) return;

  try {
    const res = await fetch(`${env.SITE_URL}/api/revalidate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.REVALIDATE_SECRET}`,
      },
      body: JSON.stringify({ slug: productSlug }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.error(`[revalidate] storefront rejected the request (${res.status}) for ${productSlug}`);
    }
  } catch (err) {
    console.error(`[revalidate] could not reach the storefront for ${productSlug}:`, err?.message ?? err);
  }
}
