/**
 * The token table on its own (SPEC "Tokens"): its order and C's row, pinned
 * here because test/pins-parity.test.ts compares the table with the site's
 * and the backend's only when they are checked out beside the kit. Runs
 * standalone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { P2P_TOKENS, P2P_SYMBOLS, P2P_CONFIG, tokenOf, unitOf } from '../src/pins.js';
import { usdcFor, offerProblem, amountText } from '../src/rules.js';
import { toRaw, tokenToRaw } from '../src/flows/maker.js';
import { SafetyError } from '../src/errors.js';

test('the table lists C, RA, TAZ, SOUL and KCAL, in that order (the site\'s order)', () => {
  assert.deepEqual([...P2P_SYMBOLS], ['C', 'RA', 'TAZ', 'SOUL', 'KCAL']);
  assert.deepEqual(P2P_TOKENS.map((t) => t.symbol), ['C', 'RA', 'TAZ', 'SOUL', 'KCAL']);
});

test('C\'s row: 6 decimals, 1 to 10,000 C a lock, 100,000 C an offer, neither gas nor stake', () => {
  const c = tokenOf('C');
  assert.ok(c);
  assert.deepEqual({ ...c }, {
    symbol: 'C', decimals: 6, min: 1_000_000n, max: 10_000_000_000n, offerMax: 100_000_000_000n,
    priceMax: 1_000_000_000_000n, gas: false, stake: false, enabled: true
  });
  assert.ok(Object.isFrozen(c));
  assert.equal(amountText(c.min, c.decimals), '1');
  assert.equal(amountText(c.max, c.decimals), '10,000');
  assert.equal(amountText(c.offerMax, c.decimals), '100,000');
  // Exact: no other case, no spaces.
  for (const s of ['c', ' C', 'C ', 'CC', 'Credits']) assert.equal(tokenOf(s), null, s);
});

test('C\'s maths: unitOf is 10^6, usdcFor divides by it, text to raw takes at most 6 decimals', () => {
  assert.equal(unitOf('C'), 1_000_000n);
  // 20 C at 0.05 USDC is 1.00 USDC (the smallest trade); 1 C at 1.08 is 1.08 USDC; rounded down.
  assert.equal(usdcFor(20_000_000n, 50_000n, 'C'), 1_000_000n);
  assert.equal(usdcFor(1_000_000n, 1_080_000n, 'C'), 1_080_000n);
  assert.equal(usdcFor(1n, 1_080_000n, 'C'), 1n);
  assert.equal(usdcFor(1n, 999_999n, 'C'), 0n);
  assert.equal(tokenToRaw('C', '2.5'), 2_500_000n);
  assert.equal(tokenToRaw('C', '0.000001'), 1n);
  assert.equal(toRaw('10000', 6, 'The amount'), tokenOf('C')!.max);
  for (const text of ['0.0000001', '1.1234567']) {
    assert.throws(() => tokenToRaw('C', text), (e: unknown) => e instanceof SafetyError && /more than 6 decimal places/.test(e.message), text);
  }
  assert.throws(() => tokenToRaw('c', '1'), /C, RA, TAZ, SOUL or KCAL, written exactly so/);
});

test('an offer of C inside its row passes check 7; one past its row is refused', () => {
  const b = { usdcMin: P2P_CONFIG.mainnet.base.usdcMin, usdcMax: P2P_CONFIG.mainnet.base.usdcMax };
  const ok = { symbol: 'C', tazTotal: 100_000_000n, tazMin: 1_000_000n, tazMax: 10_000_000n, price: 1_000_000n };
  assert.equal(offerProblem(ok, b), null);
  assert.notEqual(offerProblem({ ...ok, tazMax: 10_000_000_001n, tazTotal: 20_000_000_000n }, b), null, 'above 10,000 C a lock');
  assert.notEqual(offerProblem({ ...ok, tazTotal: 100_000_000_001n }, b), null, 'above 100,000 C an offer');
  assert.equal(offerProblem({ ...ok, symbol: 'DOGE' }, b), 'Pick one of the tokens this site trades: C, RA, TAZ, SOUL or KCAL.');
});
