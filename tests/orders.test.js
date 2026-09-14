// Pure tests for the order state machine and tracking-URL building.
// No database, no env — see tests/pure.test.js for the same discipline.

import test from 'node:test';
import assert from 'node:assert/strict';

// These two are pure and must stay importable without the DB pool. If this
// import ever pulls in env.js, the suite fails loudly rather than silently
// requiring a .env.
const { canTransition, buildTrackingUrl } = await import('../src/modules/orders/state.js');

test('state machine: the happy path is allowed', () => {
  assert.ok(canTransition('pending_payment', 'confirmed'));
  assert.ok(canTransition('confirmed', 'packed'));
  assert.ok(canTransition('packed', 'shipped'));
  assert.ok(canTransition('shipped', 'delivered'));
});

test('state machine: terminal states are terminal', () => {
  assert.ok(!canTransition('delivered', 'shipped'));
  assert.ok(!canTransition('delivered', 'cancelled'));
  assert.ok(!canTransition('cancelled', 'confirmed'));
  assert.ok(!canTransition('refunded', 'shipped'));
});

test('state machine: a shipped order cannot be cancelled', () => {
  // The parcel is already with the courier; cancelling would be a lie.
  assert.ok(!canTransition('shipped', 'cancelled'));
  assert.ok(canTransition('confirmed', 'cancelled'));
  assert.ok(canTransition('packed', 'cancelled'));
});

test('state machine: no skipping straight to delivered', () => {
  assert.ok(!canTransition('confirmed', 'delivered'));
  assert.ok(!canTransition('pending_payment', 'shipped'));
});

test('tracking url: substitutes the number into a deep-link template', () => {
  const url = buildTrackingUrl(
    'https://www.bluedart.com/web/guest/trackdartresultthirdparty?trackFor=0&trackNo={TRACKING_NUMBER}',
    '78901234567'
  );
  assert.equal(
    url,
    'https://www.bluedart.com/web/guest/trackdartresultthirdparty?trackFor=0&trackNo=78901234567'
  );
});

test('tracking url: a landing page without a placeholder is returned unchanged', () => {
  // India Post, DTDC, TPC and Trackon cannot be deep-linked — the customer
  // pastes the number themselves, so we must NOT fabricate a URL.
  const url = buildTrackingUrl('https://www.trackon.in/courier-tracking', 'ABC123456');
  assert.equal(url, 'https://www.trackon.in/courier-tracking');
});

test('tracking url: encodes a number containing url-unsafe characters', () => {
  const url = buildTrackingUrl('https://x.test/t?awb={TRACKING_NUMBER}', 'AB/12 34');
  assert.ok(!url.includes(' '));
  assert.ok(url.includes('AB%2F12%2034'));
});

test('tracking url: null template yields null, never a broken link', () => {
  assert.equal(buildTrackingUrl(null, '123456789'), null);
});
