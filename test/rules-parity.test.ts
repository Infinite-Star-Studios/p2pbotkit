/**
 * rules-parity (build spec section 6.8): fixed vectors run through the kit's
 * src/rules.ts and the site's src/lib/p2p/rules.js give identical results,
 * sentence for sentence, for the twelve functions of section 6.8
 * (phaLockProblem, buyerT2, storedT2Problem, baseLockProblem,
 * baseLockTimeProblem, swapReadsProblem, selfClaimProblem, tradeMismatch,
 * offerProblem, takeProblem, openCapProblem, lockStartProblem), plus the
 * helpers the kit's checks and flows use. Section 4.10 adds offers that
 * follow the reference price: tradeMismatch with the maker's own offer (a
 * fixed price the kit set, priceHistory included, or at or past a following
 * offer's limit price), offerPriceProblem, followOfferProblem with each
 * side's FOLLOW_TAKE_USD_MAX, and their helpers.
 *
 * Each side gets its own pinned timing and bounds (the site's from
 * constants.js, the kit's from pins.ts), so a drift in either the rules or the
 * constants fails here. Skipped only when the site is not checked out beside
 * the kit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as kit from '../src/rules.js';
import * as pins from '../src/pins.js';

const SITE_RULES = new URL('../../frontend/src/lib/p2p/rules.js', import.meta.url);
const SITE_CONSTANTS = new URL('../../frontend/src/lib/p2p/constants.js', import.meta.url);
const SITE_FORMAT = new URL('../../frontend/src/lib/p2p/format.js', import.meta.url);
/** The board's defaults of the per-take cap of a following offer (read as text). */
const BACKEND_FOLLOW = new URL('../../backend/src/p2p/follow.ts', import.meta.url);
const here = existsSync(SITE_RULES) && existsSync(SITE_CONSTANTS) && existsSync(SITE_FORMAT);
const skip = here ? false : 'the site (frontend/) is not checked out beside the kit';

type Net = 'devnet' | 'mainnet';
/** One vector: a function name, the network whose timing and bounds it uses, and the arguments before them. */
interface Vector { fn: string; net?: Net; args: unknown[]; note: string }

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = 1_800_000_000;
const MIN = 60;
const S_P = 'P2K' + 'S'.repeat(44);
const B_P = 'P2K' + 'B'.repeat(44);
const X_P = 'P2K' + 'X'.repeat(44);
const S_B = '0x' + '5a'.repeat(20);
const B_B = '0x' + 'b7'.repeat(20);
const X_B = '0x' + 'c3'.repeat(20);
const USDC_DEV = pins.P2P_CONFIG.devnet.base.usdc;
const H1 = '0x' + '1f'.repeat(32);
const H2 = '0x' + '2e'.repeat(32);
const TAZ_1 = 1_000_000_000n;
const devT = pins.P2P_CONFIG.devnet.timing;
const mainT = pins.P2P_CONFIG.mainnet.timing;

const phaLock = (o: Partial<kit.PhaLock> = {}): kit.PhaLock => ({
  state: 1, sender: S_P, recipient: B_P, symbol: 'TAZ', amount: 5n * TAZ_1, deadline: NOW + devT.phaLock - 60, created: NOW - 60, ...o
});
const swap = (o: Partial<kit.BaseSwap> = {}): kit.BaseSwap => ({
  state: 1, token: USDC_DEV, sender: B_B, claimer: S_B, amount: 8_200_000n, deadline: NOW + 20 * MIN, feeBps: 100, ...o
});
const wantPha = (o: Record<string, unknown> = {}) => ({ symbol: 'TAZ', taz: 5n * TAZ_1, bPha: B_P, sPha: S_P, ...o });
const wantBase = (o: Record<string, unknown> = {}) => ({ usdcToken: USDC_DEV, usdc: 8_200_000n, sBase: S_B, bBase: B_B, t1: NOW + devT.phaLock - 60, maxFeeBps: 100, ...o });
const wantClaim = (o: Record<string, unknown> = {}) => ({ symbol: 'TAZ', taz: 5n * TAZ_1, sPha: S_P, bPha: B_P, usdcToken: USDC_DEV, usdc: 8_200_000n, sBase: S_B, bBase: B_B, ...o });
const swapReads = (o: Record<string, unknown> = {}) => ({ paused: false, allowed: true, minAmount: 1_000_000n, maxAmount: 100_000_000_000n, minLock: 60, maxLock: 86_400, ...o });
/** A board trade: a TAZ sell offer, 5 TAZ at 1.64 USDC. */
const boardTrade = (o: Record<string, unknown> = {}) => ({
  id: 42, network: 'devnet', offerId: 7, side: 'sell', symbol: 'TAZ', taz: '5000000000', usdc: '8200000', price: '1640000',
  seller: { pha: S_P, base: S_B }, buyer: { pha: B_P, base: B_B }, h: null, phaContract: null, status: 'accepted', lockBy: NOW + 300, ...o
});
/** The kit's record of that trade as its seller and maker. */
const record = (o: Record<string, unknown> = {}) => ({
  id: 42, role: 'S', maker: true, symbol: 'TAZ', taz: '5000000000', usdc: '8200000', price: '1640000', myPha: S_P, myBase: S_B, ...o
});
const offer = (o: Record<string, unknown> = {}) => ({ symbol: 'TAZ', tazTotal: 30n * TAZ_1, tazMin: TAZ_1, tazMax: 5n * TAZ_1, price: 1_080_000n, ...o });
const takeOffer = (o: Record<string, unknown> = {}) => ({ symbol: 'TAZ', tazMin: TAZ_1, tazMax: 5n * TAZ_1, remaining: 30n * TAZ_1, price: 1_080_000n, ...o });
/**
 * Section 4.10: a board trade of 5 TAZ at `price` on offer #7 and the kit's
 * record of it as the maker (a sell offer: the kit is S; a buy offer: the kit
 * is B), both with the USDC that price gives.
 */
const atPrice = (price: bigint, side: 'sell' | 'buy' = 'sell', o: { symbol?: string; taz?: bigint } = {}) => {
  const symbol = o.symbol ?? 'TAZ', taz = o.taz ?? 5n * TAZ_1;
  const usdc = (taz * price) / pins.unitOf(symbol);
  const t = boardTrade({ side, symbol, taz: taz.toString(), usdc: usdc.toString(), price: price.toString() });
  const r = side === 'sell'
    ? record({ symbol, taz: taz.toString(), usdc: usdc.toString(), price: price.toString() })
    : record({ role: 'B', maker: true, myPha: B_P, myBase: B_B, symbol, taz: taz.toString(), usdc: usdc.toString(), price: price.toString() });
  return [t, r] as const;
};
/** The kit's own offer #7 as tradeMismatch's third argument (LocalOffer's pricing fields). */
const myOffer = (o: Record<string, unknown> = {}) => ({ id: 7, side: 'sell', price: '1640000', priceHistory: [], follow: null, ...o });
const FOLLOW = { offsetBps: 200, limitPrice: '1600000', dailyMax: '30000000000' };
/** A market-following offer's form figures (followOfferProblem): 100 TAZ, 10 to 50 a trade, +2%, never past 4.90, 100 a day. */
const followForm = (follow: Record<string, unknown> = {}, o: Record<string, unknown> = {}) => ({
  symbol: 'TAZ', side: 'sell', tazTotal: 100n * TAZ_1, tazMin: 10n * TAZ_1, tazMax: 50n * TAZ_1,
  follow: { offsetBps: 200, limitPrice: 4_900_000n, dailyMax: 100n * TAZ_1, ...follow }, ...o
});

// ── The vectors ──────────────────────────────────────────────────────────────

const V: Vector[] = [];
const add = (fn: string, note: string, args: unknown[], net?: Net) => V.push({ fn, note, args, ...(net ? { net } : {}) });

// phaLockProblem(lock, want, now, timing)
add('phaLockProblem', 'a good lock', [phaLock(), wantPha(), NOW], 'devnet');
add('phaLockProblem', 'no lock read', [null, wantPha(), NOW], 'devnet');
add('phaLockProblem', 'state 0', [phaLock({ state: 0 }), wantPha(), NOW], 'devnet');
add('phaLockProblem', 'claimed', [phaLock({ state: 2 }), wantPha(), NOW], 'devnet');
add('phaLockProblem', 'refunded', [phaLock({ state: 3 }), wantPha(), NOW], 'devnet');
add('phaLockProblem', 'unknown state', [phaLock({ state: 7 }), wantPha(), NOW], 'devnet');
add('phaLockProblem', 'another token with the same raw amount', [phaLock({ symbol: 'SOUL' }), wantPha(), NOW], 'devnet');
add('phaLockProblem', 'lower-case symbol on chain', [phaLock({ symbol: 'taz' }), wantPha(), NOW], 'devnet');
add('phaLockProblem', 'one raw unit more', [phaLock({ amount: 5n * TAZ_1 + 1n }), wantPha(), NOW], 'devnet');
add('phaLockProblem', 'pays someone else', [phaLock({ recipient: X_P }), wantPha(), NOW], 'devnet');
add('phaLockProblem', 'no buyer address in the record', [phaLock(), wantPha({ bPha: '' }), NOW], 'devnet');
add('phaLockProblem', 'made by another seller', [phaLock({ sender: X_P }), wantPha(), NOW], 'devnet');
add('phaLockProblem', 'seller unknown: any sender', [phaLock({ sender: X_P }), wantPha({ sPha: undefined }), NOW], 'devnet');
add('phaLockProblem', 'no end time', [phaLock({ deadline: 0 }), wantPha(), NOW], 'devnet');
add('phaLockProblem', 'fractional end time', [phaLock({ deadline: NOW + 1000.5 }), wantPha(), NOW], 'devnet');
add('phaLockProblem', 'no start time', [phaLock({ created: 0 }), wantPha(), NOW], 'devnet');
add('phaLockProblem', 'window closed for signing', [phaLock({ created: NOW - 11 * MIN }), wantPha(), NOW], 'devnet');
add('phaLockProblem', 'window exactly at its last second', [phaLock({ created: NOW - 10 * MIN }), wantPha(), NOW], 'devnet');
add('phaLockProblem', 'too little time before T1', [phaLock({ deadline: NOW + devT.safety + devT.revealMin + devT.baseLockLead - 1 }), wantPha(), NOW], 'devnet');
add('phaLockProblem', 'runs far longer than the site\'s locks', [phaLock({ deadline: NOW + devT.phaLock + devT.lockSlack + 1 }), wantPha(), NOW], 'devnet');
add('phaLockProblem', 'a token the kit does not trade', [phaLock({ symbol: 'DOGE' }), wantPha({ symbol: 'DOGE' }), NOW], 'devnet');
add('phaLockProblem', 'RA, good', [phaLock({ symbol: 'RA', amount: 2n * TAZ_1 }), wantPha({ symbol: 'RA', taz: 2n * TAZ_1 }), NOW], 'devnet');
add('phaLockProblem', 'mainnet timing, good', [phaLock({ deadline: NOW + mainT.phaLock - 60 }), wantPha(), NOW], 'mainnet');
add('phaLockProblem', 'mainnet window closed', [phaLock({ deadline: NOW + mainT.phaLock - 60, created: NOW - 26 * MIN }), wantPha(), NOW], 'mainnet');

// buyerT2(t1, now, timing)
add('buyerT2', 'T1 far: the allowance bound', [NOW + devT.phaLock, NOW], 'devnet');
add('buyerT2', 'T1 near: the safety bound', [NOW + devT.safety + 10 * MIN, NOW], 'devnet');
add('buyerT2', 'equal bounds', [NOW + devT.safety + devT.revealMin + devT.baseLockLead + devT.revealAllowance, NOW], 'devnet');
add('buyerT2', 'mainnet T1 far', [NOW + mainT.phaLock, NOW], 'mainnet');
add('buyerT2', 'mainnet T1 near', [NOW + mainT.safety + MIN, NOW], 'mainnet');
add('buyerT2', 'T1 in the past', [NOW - 100, NOW], 'devnet');

// storedT2Problem(t2, t1, now, timing)
const T1 = NOW + devT.phaLock - 60;
add('storedT2Problem', 'good', [NOW + 20 * MIN, T1, NOW], 'devnet');
add('storedT2Problem', 'none stored (null)', [null, T1, NOW], 'devnet');
add('storedT2Problem', 'none stored (undefined)', [undefined, T1, NOW], 'devnet');
add('storedT2Problem', 'zero', [0, T1, NOW], 'devnet');
add('storedT2Problem', 'fraction', [NOW + 1200.5, T1, NOW], 'devnet');
add('storedT2Problem', 'past T1 - safety', [T1 - devT.safety + 1, T1, NOW], 'devnet');
add('storedT2Problem', 'exactly T1 - safety', [T1 - devT.safety, T1, NOW], 'devnet');
add('storedT2Problem', 'T1 unreadable', [NOW + 20 * MIN, 0, NOW], 'devnet');
add('storedT2Problem', 'too little time left', [NOW + devT.revealMin + devT.baseLockLead - 1, T1, NOW], 'devnet');
add('storedT2Problem', 'exactly enough time', [NOW + devT.revealMin + devT.baseLockLead, T1, NOW], 'devnet');

// baseLockProblem(latest, confirmed, want, now, timing[, minLeft])
add('baseLockProblem', 'good', [swap(), swap(), wantBase(), NOW], 'devnet');
add('baseLockProblem', 'not locked', [null, null, wantBase(), NOW], 'devnet');
add('baseLockProblem', 'state 0', [swap({ state: 0 }), swap(), wantBase(), NOW], 'devnet');
add('baseLockProblem', 'claimed', [swap({ state: 2 }), swap(), wantBase(), NOW], 'devnet');
add('baseLockProblem', 'refunded', [swap({ state: 3 }), swap(), wantBase(), NOW], 'devnet');
add('baseLockProblem', 'unknown state', [swap({ state: 9 }), swap(), wantBase(), NOW], 'devnet');
add('baseLockProblem', 'another token', [swap({ token: X_B }), swap(), wantBase(), NOW], 'devnet');
add('baseLockProblem', 'another amount', [swap({ amount: 8_199_999n }), swap(), wantBase(), NOW], 'devnet');
add('baseLockProblem', 'pays someone else', [swap({ claimer: X_B }), swap(), wantBase(), NOW], 'devnet');
add('baseLockProblem', 'made by someone else', [swap({ sender: X_B }), swap(), wantBase(), NOW], 'devnet');
add('baseLockProblem', 'addresses in another case', [swap({ claimer: S_B.toUpperCase().replace('0X', '0x') }), swap(), wantBase(), NOW], 'devnet');
add('baseLockProblem', 'not confirmed yet', [swap(), null, wantBase(), NOW], 'devnet');
add('baseLockProblem', 'confirmed state 0', [swap(), swap({ state: 0 }), wantBase(), NOW], 'devnet');
add('baseLockProblem', 'confirmed state 2', [swap(), swap({ state: 2 }), wantBase(), NOW], 'devnet');
add('baseLockProblem', 'confirmed another amount', [swap(), swap({ amount: 1n }), wantBase(), NOW], 'devnet');
add('baseLockProblem', 'deadlines differ', [swap(), swap({ deadline: NOW + 21 * MIN }), wantBase(), NOW], 'devnet');
add('baseLockProblem', 'fees differ', [swap(), swap({ feeBps: 50 }), wantBase(), NOW], 'devnet');
add('baseLockProblem', 'T1 unreadable', [swap(), swap(), wantBase({ t1: 0 }), NOW], 'devnet');
add('baseLockProblem', 'ends too close to T1', [swap({ deadline: NOW + 30 * MIN }), swap({ deadline: NOW + 30 * MIN }), wantBase({ t1: NOW + 40 * MIN }), NOW], 'devnet');
add('baseLockProblem', 'too little time left', [swap({ deadline: NOW + devT.revealMin - 1 }), swap({ deadline: NOW + devT.revealMin - 1 }), wantBase(), NOW], 'devnet');
add('baseLockProblem', 'a custom minLeft', [swap({ deadline: NOW + 4 * MIN }), swap({ deadline: NOW + 4 * MIN }), wantBase(), NOW, 'MINLEFT:180'], 'devnet');
add('baseLockProblem', 'fee above the one shown', [swap({ feeBps: 150 }), swap({ feeBps: 150 }), wantBase(), NOW], 'devnet');
add('baseLockProblem', 'fee shown above MAX_FEE_BPS', [swap({ feeBps: 201 }), swap({ feeBps: 201 }), wantBase({ maxFeeBps: 500 }), NOW], 'devnet');
add('baseLockProblem', 'negative fee', [swap({ feeBps: -1 }), swap({ feeBps: -1 }), wantBase(), NOW], 'devnet');
add('baseLockProblem', 'mainnet, good', [swap({ deadline: NOW + 3 * 3600 }), swap({ deadline: NOW + 3 * 3600 }), wantBase({ t1: NOW + mainT.phaLock }), NOW], 'mainnet');

// baseLockTimeProblem(lockedAt, created, timing)
add('baseLockTimeProblem', 'in time', [{ time: NOW + 5 * MIN }, NOW], 'devnet');
add('baseLockTimeProblem', 'exactly at the window', [{ time: NOW + devT.baseLockWindow }, NOW], 'devnet');
add('baseLockTimeProblem', 'one second late', [{ time: NOW + devT.baseLockWindow + 1 }, NOW], 'devnet');
add('baseLockTimeProblem', 'an hour late', [{ time: NOW + 3600 }, NOW], 'devnet');
add('baseLockTimeProblem', 'lock time not read', [null, NOW], 'devnet');
add('baseLockTimeProblem', 'lock time zero', [{ time: 0 }, NOW], 'devnet');
add('baseLockTimeProblem', 'created unreadable', [{ time: NOW }, 0], 'devnet');
add('baseLockTimeProblem', 'mainnet late', [{ time: NOW + 31 * MIN }, NOW], 'mainnet');

// swapReadsProblem(bp, usdc, timing)
add('swapReadsProblem', 'good', [swapReads(), 8_200_000n], 'devnet');
add('swapReadsProblem', 'paused', [swapReads({ paused: true }), 8_200_000n], 'devnet');
add('swapReadsProblem', 'USDC not allowed', [swapReads({ allowed: false }), 8_200_000n], 'devnet');
add('swapReadsProblem', 'below the contract minimum', [swapReads(), 999_999n], 'devnet');
add('swapReadsProblem', 'above the contract maximum', [swapReads({ maxAmount: 5_000_000n }), 8_200_000n], 'devnet');
add('swapReadsProblem', 'shortest lock too long', [swapReads({ minLock: devT.revealMin + 1 }), 8_200_000n], 'devnet');
add('swapReadsProblem', 'longest lock too short', [swapReads({ maxLock: devT.phaLock + devT.lockSlack - devT.safety - 1 }), 8_200_000n], 'devnet');
add('swapReadsProblem', 'minLock not an integer', [swapReads({ minLock: 1.5 }), 8_200_000n], 'devnet');
add('swapReadsProblem', 'mainnet longest lock too short', [swapReads({ maxLock: 86_400 / 4 }), 8_200_000n], 'mainnet');

// selfClaimProblem(lock, latest, confirmed, want, now, timing)
add('selfClaimProblem', 'good, Phantasma lock still open', [phaLock(), swap(), swap(), wantClaim(), NOW], 'devnet');
add('selfClaimProblem', 'good, Phantasma lock already claimed', [phaLock({ state: 2 }), swap(), swap(), wantClaim(), NOW], 'devnet');
add('selfClaimProblem', 'a token the kit does not trade', [phaLock(), swap(), swap(), wantClaim({ symbol: 'DOGE' }), NOW], 'devnet');
add('selfClaimProblem', 'no Phantasma lock', [null, swap(), swap(), wantClaim(), NOW], 'devnet');
add('selfClaimProblem', 'Phantasma lock refunded', [phaLock({ state: 3 }), swap(), swap(), wantClaim(), NOW], 'devnet');
add('selfClaimProblem', 'Phantasma lock unknown state', [phaLock({ state: 5 }), swap(), swap(), wantClaim(), NOW], 'devnet');
add('selfClaimProblem', 'not this trade\'s lock (sender)', [phaLock({ sender: X_P }), swap(), swap(), wantClaim(), NOW], 'devnet');
add('selfClaimProblem', 'not this trade\'s lock (token)', [phaLock({ symbol: 'KCAL' }), swap(), swap(), wantClaim(), NOW], 'devnet');
add('selfClaimProblem', 'not this trade\'s lock (amount)', [phaLock({ amount: 1n }), swap(), swap(), wantClaim(), NOW], 'devnet');
add('selfClaimProblem', 'no USDC lock', [phaLock(), null, swap(), wantClaim(), NOW], 'devnet');
add('selfClaimProblem', 'USDC already claimed', [phaLock(), swap({ state: 2 }), swap(), wantClaim(), NOW], 'devnet');
add('selfClaimProblem', 'USDC refunded', [phaLock(), swap({ state: 3 }), swap(), wantClaim(), NOW], 'devnet');
add('selfClaimProblem', 'USDC lock pays someone else', [phaLock(), swap({ claimer: X_B }), swap(), wantClaim(), NOW], 'devnet');
add('selfClaimProblem', 'not confirmed', [phaLock(), swap(), null, wantClaim(), NOW], 'devnet');
add('selfClaimProblem', 'confirmed changed', [phaLock(), swap(), swap({ state: 3 }), wantClaim(), NOW], 'devnet');
add('selfClaimProblem', 'confirmed deadline differs', [phaLock(), swap(), swap({ deadline: NOW + 1 }), wantClaim(), NOW], 'devnet');
add('selfClaimProblem', 'Phantasma end time unreadable', [phaLock({ deadline: 0 }), swap(), swap(), wantClaim(), NOW], 'devnet');
add('selfClaimProblem', 'USDC lock ends too close to T1', [phaLock({ deadline: NOW + 30 * MIN }), swap(), swap(), wantClaim(), NOW], 'devnet');
add('selfClaimProblem', 'inside the claim margin', [phaLock(), swap({ deadline: NOW + devT.claimMargin - 1 }), swap({ deadline: NOW + devT.claimMargin - 1 }), wantClaim(), NOW], 'devnet');
add('selfClaimProblem', 'mainnet claim margin', [phaLock({ deadline: NOW + mainT.phaLock }), swap({ deadline: NOW + 20 * MIN }), swap({ deadline: NOW + 20 * MIN }), wantClaim(), NOW], 'mainnet');

// tradeMismatch(t, rec)
add('tradeMismatch', 'the same trade (seller, maker)', [boardTrade(), record()]);
add('tradeMismatch', 'the same trade (buyer, taker)', [boardTrade(), record({ role: 'B', maker: false, myPha: B_P, myBase: B_B })]);
add('tradeMismatch', 'buy offer, seller is the taker', [boardTrade({ side: 'buy' }), record({ maker: false })]);
add('tradeMismatch', 'another id', [boardTrade({ id: 43 }), record()]);
add('tradeMismatch', 'record names no traded token', [boardTrade(), record({ symbol: 'DOGE' })]);
add('tradeMismatch', 'another token on the board', [boardTrade({ symbol: 'SOUL' }), record()]);
add('tradeMismatch', 'another amount', [boardTrade({ taz: '5000000001' }), record()]);
add('tradeMismatch', 'another USDC', [boardTrade({ usdc: '8200001' }), record()]);
add('tradeMismatch', 'USDC does not match the price the kit sent', [boardTrade({ usdc: '8300000' }), record({ usdc: '8300000' })]);
add('tradeMismatch', 'record price not a positive integer', [boardTrade(), record({ price: '0' })]);
add('tradeMismatch', 'board amount not an integer', [boardTrade({ taz: '5e9' }), record({ taz: '5e9' })]);
add('tradeMismatch', 'own Phantasma address changed', [boardTrade({ seller: { pha: X_P, base: S_B } }), record()]);
add('tradeMismatch', 'own Base address changed', [boardTrade({ seller: { pha: S_P, base: X_B } }), record()]);
add('tradeMismatch', 'own Base address checksummed', [boardTrade({ seller: { pha: S_P, base: S_B.toUpperCase().replace('0X', '0x') } }), record()]);
add('tradeMismatch', 'counterparty Phantasma changed', [boardTrade(), record({ counterPha: X_P })]);
add('tradeMismatch', 'counterparty Base changed', [boardTrade(), record({ counterBase: X_B })]);
add('tradeMismatch', 'counterparty unchanged', [boardTrade(), record({ counterPha: B_P, counterBase: B_B })]);
add('tradeMismatch', 'wrong side', [boardTrade(), record({ maker: false })]);
add('tradeMismatch', 'another h', [boardTrade({ h: H2 }), record({ h: H1 })]);
add('tradeMismatch', 'same h, other case', [boardTrade({ h: H1.toUpperCase().replace('0X', '0x') }), record({ h: H1 })]);
add('tradeMismatch', 'board has no h yet', [boardTrade({ h: null }), record({ h: H1 })]);
add('tradeMismatch', 'another escrow', [boardTrade({ phaContract: 'saturnp2p' }), record({ phaContract: 'saturnescrow' })]);
add('tradeMismatch', 'RA trade, good', [boardTrade({ symbol: 'RA', taz: '2000000000', usdc: '4000000', price: '2000000' }), record({ symbol: 'RA', taz: '2000000000', usdc: '4000000', price: '2000000' })]);
add('tradeMismatch', 'SOUL decimals (8)', [boardTrade({ symbol: 'SOUL', taz: '500000000', usdc: '56000', price: '11200' }), record({ symbol: 'SOUL', taz: '500000000', usdc: '56000', price: '11200' })]);
add('tradeMismatch', 'the board\'s price is not the one the kit sent', [boardTrade({ price: '1640001' }), record()]);
add('tradeMismatch', 'the board\'s price does not read (leading zero)', [boardTrade({ price: '01640000' }), record()]);
add('tradeMismatch', 'the board sends no price', [boardTrade({ price: undefined }), record()]);

// tradeMismatch(t, rec, offer): section 4.10, the maker's own offer
add('tradeMismatch', '4.10 fixed offer, its single price', [...atPrice(1_640_000n), myOffer()]);
add('tradeMismatch', '4.10 fixed offer, a record from before the history', [...atPrice(1_640_000n), myOffer({ priceHistory: undefined })]);
add('tradeMismatch', '4.10 fixed offer, a price the kit never set', [...atPrice(1_640_000n), myOffer({ price: '1650000' })]);
add('tradeMismatch', '4.10 fixed offer, an older price in the history', [...atPrice(1_640_000n), myOffer({ price: '1700000', priceHistory: [{ price: '1640000', at: 1 }, { price: '1660000', at: 2 }] })]);
add('tradeMismatch', '4.10 fixed offer, the current price after a change', [...atPrice(1_700_000n), myOffer({ price: '1700000', priceHistory: [{ price: '1640000', at: 1 }] })]);
add('tradeMismatch', '4.10 fixed offer, between two prices the kit set', [...atPrice(1_650_000n), myOffer({ price: '1700000', priceHistory: [{ price: '1640000', at: 1 }] })]);
add('tradeMismatch', '4.10 fixed offer, history entries that do not read', [...atPrice(1_640_000n), myOffer({ price: 'x', priceHistory: [{ price: '0' }, { price: 'abc' }, { price: '1640000' }] })]);
add('tradeMismatch', '4.10 fixed offer, nothing reads', [...atPrice(1_640_000n), myOffer({ price: '', priceHistory: [{ price: '-1' }] })]);
add('tradeMismatch', '4.10 the offer is another one', [...atPrice(1_640_000n), myOffer({ id: 8 })]);
add('tradeMismatch', '4.10 a taker\'s record ignores any offer', [boardTrade(), record({ role: 'B', maker: false, myPha: B_P, myBase: B_B }), myOffer({ price: '999999' })]);
add('tradeMismatch', '4.10 a taker\'s record ignores another offer id', [boardTrade(), record({ role: 'B', maker: false, myPha: B_P, myBase: B_B }), myOffer({ id: 99 })]);
add('tradeMismatch', '4.10 the USDC is refused before the offer\'s price', [boardTrade({ usdc: '8250000', price: '1650000' }), record({ usdc: '8250000' }), myOffer({ price: '1650000' })]);
add('tradeMismatch', '4.10 the board\'s price is refused before the offer\'s', [boardTrade({ price: '1650000' }), record(), myOffer({ price: '1650000' })]);
add('tradeMismatch', '4.10 following sell, exactly at the limit', [...atPrice(1_600_000n), myOffer({ price: '1640000', follow: FOLLOW })]);
add('tradeMismatch', '4.10 following sell, above the limit', [...atPrice(2_400_000n), myOffer({ price: '1640000', follow: FOLLOW })]);
add('tradeMismatch', '4.10 following sell, one unit under the limit', [...atPrice(1_599_999n), myOffer({ price: '1640000', follow: FOLLOW })]);
add('tradeMismatch', '4.10 following buy, exactly at the limit', [...atPrice(1_600_000n, 'buy'), myOffer({ side: 'buy', price: '1580000', follow: FOLLOW })]);
add('tradeMismatch', '4.10 following buy, under the limit', [...atPrice(1_100_000n, 'buy'), myOffer({ side: 'buy', price: '1580000', follow: FOLLOW })]);
add('tradeMismatch', '4.10 following buy, one unit over the limit', [...atPrice(1_600_001n, 'buy'), myOffer({ side: 'buy', price: '1580000', follow: FOLLOW })]);
add('tradeMismatch', '4.10 following, the limit as a bigint', [...atPrice(1_610_000n), myOffer({ follow: { offsetBps: -150, limitPrice: 1_600_000n, dailyMax: 30n * TAZ_1 } })]);
add('tradeMismatch', '4.10 following, a whole limit price in the text', [...atPrice(1_999_999n), myOffer({ follow: { offsetBps: 0, limitPrice: '2000000', dailyMax: '1' } })]);
add('tradeMismatch', '4.10 following, an offset past 20% counts as fixed', [...atPrice(1_700_000n), myOffer({ follow: { ...FOLLOW, offsetBps: 2001 } })]);
add('tradeMismatch', '4.10 following, a fractional offset counts as fixed', [...atPrice(1_700_000n), myOffer({ follow: { ...FOLLOW, offsetBps: 1.5 } })]);
add('tradeMismatch', '4.10 following, a limit of 0 counts as fixed', [...atPrice(1_640_000n), myOffer({ follow: { ...FOLLOW, limitPrice: '0' } })]);
add('tradeMismatch', '4.10 following, no daily amount counts as fixed', [...atPrice(1_700_000n), myOffer({ follow: { offsetBps: 200, limitPrice: '1600000' } })]);
add('tradeMismatch', '4.10 following, unreadable settings still allow a fixed price the kit set', [...atPrice(1_640_000n), myOffer({ follow: { offsetBps: 9999, limitPrice: '1', dailyMax: '1' } })]);
add('tradeMismatch', '4.10 following, the offer\'s side does not read', [...atPrice(1_640_000n), myOffer({ side: 'x', follow: FOLLOW })]);
add('tradeMismatch', '4.10 following RA (9 decimals), past the limit', [...atPrice(1_890_000n, 'sell', { symbol: 'RA', taz: 2n * TAZ_1 }), myOffer({ follow: { offsetBps: 200, limitPrice: '1900000', dailyMax: '6000000000' } })]);
add('tradeMismatch', '4.10 following SOUL (8 decimals), at the limit', [...atPrice(11_200n, 'sell', { symbol: 'SOUL', taz: 500_000_000n }), myOffer({ follow: { offsetBps: 0, limitPrice: '11200', dailyMax: '500000000' } })]);
add('tradeMismatch', '4.10 following, a counterparty change is still refused', [boardTrade({ price: '1700000', usdc: '8500000' }), record({ price: '1700000', usdc: '8500000', counterBase: X_B }), myOffer({ follow: FOLLOW })]);

// offerPriceProblem(price, offer)
add('offerPriceProblem', 'a fixed price the kit set', [1_640_000n, myOffer()]);
add('offerPriceProblem', 'a fixed price as text', ['1640000', myOffer()]);
add('offerPriceProblem', 'a price that does not read', ['abc', myOffer()]);
add('offerPriceProblem', 'zero', ['0', myOffer()]);
add('offerPriceProblem', 'a number, not text', [1640000, myOffer()]);
add('offerPriceProblem', 'not a price the kit set', ['1640001', myOffer()]);
add('offerPriceProblem', 'following sell at its limit', ['1600000', myOffer({ follow: FOLLOW })]);
add('offerPriceProblem', 'following sell under its limit (4.90 shown with two decimals)', ['4899999', myOffer({ follow: { ...FOLLOW, limitPrice: '4900000' } })]);
add('offerPriceProblem', 'following buy over its limit', ['4900001', myOffer({ side: 'buy', follow: { ...FOLLOW, limitPrice: '4900000' } })]);
add('offerPriceProblem', 'following buy with a sub-cent limit', ['162301', myOffer({ side: 'buy', follow: { ...FOLLOW, limitPrice: '162300' } })]);
add('offerPriceProblem', 'following, the side does not read', ['1600000', myOffer({ side: 'x', follow: FOLLOW })]);

// followOfferProblem(o, bounds, takeMax): each side's own bounds and FOLLOW_TAKE_USD_MAX
add('followOfferProblem', 'good (devnet)', [followForm()], 'devnet');
add('followOfferProblem', 'good (mainnet)', [followForm()], 'mainnet');
add('followOfferProblem', 'good, a buy', [followForm({}, { side: 'buy' })], 'devnet');
add('followOfferProblem', 'a token the kit does not trade', [followForm({}, { symbol: 'GOATI' })], 'devnet');
add('followOfferProblem', 'no offset', [followForm({ offsetBps: null })], 'devnet');
add('followOfferProblem', 'a fractional offset', [followForm({ offsetBps: 1.5 })], 'devnet');
add('followOfferProblem', 'offset past 20%', [followForm({ offsetBps: 2001 })], 'devnet');
add('followOfferProblem', 'offset exactly -20%', [followForm({ offsetBps: -2000 })], 'devnet');
add('followOfferProblem', 'no limit price, a sell', [followForm({ limitPrice: null })], 'devnet');
add('followOfferProblem', 'no limit price, a buy', [followForm({ limitPrice: null }, { side: 'buy' })], 'devnet');
add('followOfferProblem', 'limit price above priceMax', [followForm({ limitPrice: 1_000_000_000_001n })], 'devnet');
add('followOfferProblem', 'amounts missing', [followForm({}, { tazMin: null })], 'devnet');
add('followOfferProblem', 'smallest trade under 1 USDC at the limit', [followForm({ limitPrice: 1n })], 'devnet');
add('followOfferProblem', 'largest trade over the mainnet lock maximum at the limit', [followForm({ limitPrice: 250_000_000n })], 'mainnet');
add('followOfferProblem', 'no amount per day', [followForm({ dailyMax: null })], 'devnet');
add('followOfferProblem', 'per day above the total', [followForm({ dailyMax: 101n * TAZ_1 })], 'devnet');
add('followOfferProblem', 'per day under the smallest trade', [followForm({ dailyMax: 9n * TAZ_1 })], 'devnet');
add('followOfferProblem', 'per day exactly the smallest trade', [followForm({ dailyMax: 10n * TAZ_1 })], 'devnet');
add('followOfferProblem', 'per day exactly the total', [followForm({ dailyMax: 100n * TAZ_1 })], 'devnet');
add('followOfferProblem', 'a per-take cap of 200 USDC', [followForm(), 'TAKEMAX:200000000'], 'devnet');
add('followOfferProblem', 'over the mainnet per-take cap, under devnet\'s', [followForm({ limitPrice: 25_000_000n })], 'mainnet');
add('followOfferProblem', 'the same offer on devnet', [followForm({ limitPrice: 25_000_000n })], 'devnet');
add('followOfferProblem', 'exactly the mainnet per-take cap', [followForm({ limitPrice: 20_000_000n })], 'mainnet');
add('followOfferProblem', 'RA with its own maximum', [followForm({ limitPrice: 2_000_000n, dailyMax: 6_000n * TAZ_1 }, { symbol: 'RA', tazTotal: 6_000n * TAZ_1, tazMax: 5_001n * TAZ_1 })], 'devnet');

// offerProblem(o, bounds?)
add('offerProblem', 'good, default bounds', [offer()]);
add('offerProblem', 'good, devnet bounds', [offer()], 'devnet');
add('offerProblem', 'a token the kit does not trade', [offer({ symbol: 'DOGE' })], 'devnet');
add('offerProblem', 'amounts missing', [offer({ tazTotal: null })], 'devnet');
add('offerProblem', 'price missing', [offer({ price: null })], 'devnet');
add('offerProblem', 'price above priceMax', [offer({ price: 1_000_000_000_001n })], 'devnet');
add('offerProblem', 'min below the token minimum', [offer({ tazMin: TAZ_1 - 1n })], 'devnet');
add('offerProblem', 'max above the token maximum', [offer({ tazMax: 100_001n * TAZ_1, tazTotal: 200_000n * TAZ_1 })], 'devnet');
add('offerProblem', 'total above offerMax', [offer({ tazTotal: 10_000_001n * TAZ_1 })], 'devnet');
add('offerProblem', 'min above max', [offer({ tazMin: 6n * TAZ_1 })], 'devnet');
add('offerProblem', 'max above total', [offer({ tazTotal: 4n * TAZ_1 })], 'devnet');
add('offerProblem', 'smallest trade under 1 USDC', [offer({ price: 900_000n })], 'devnet');
add('offerProblem', 'largest trade over the network maximum', [offer({ tazMax: 100_000n * TAZ_1, tazTotal: 100_000n * TAZ_1, price: 2_000_000n })], 'mainnet');
add('offerProblem', 'largest trade over devnet maximum', [offer({ tazMax: 100_000n * TAZ_1, tazTotal: 100_000n * TAZ_1, price: 2_000_000_000n })], 'devnet');
add('offerProblem', 'KCAL with its 10 decimals', [offer({ symbol: 'KCAL', tazTotal: 1_000n * 10_000_000_000n, tazMin: 100n * 10_000_000_000n, tazMax: 500n * 10_000_000_000n, price: 30_000n })], 'devnet');
add('offerProblem', 'RA above its own maximum', [offer({ symbol: 'RA', tazMax: 5_001n * TAZ_1, tazTotal: 6_000n * TAZ_1, price: 2_000_000n })], 'devnet');

// takeProblem(taz, offer, bounds?)
add('takeProblem', 'good', [2n * TAZ_1, takeOffer()], 'devnet');
add('takeProblem', 'good, default bounds', [2n * TAZ_1, takeOffer()]);
add('takeProblem', 'a token the kit does not trade', [2n * TAZ_1, takeOffer({ symbol: 'DOGE' })], 'devnet');
add('takeProblem', 'no amount', [null, takeOffer()], 'devnet');
add('takeProblem', 'below the offer minimum', [TAZ_1 / 2n, takeOffer()], 'devnet');
add('takeProblem', 'above the offer maximum', [6n * TAZ_1, takeOffer()], 'devnet');
add('takeProblem', 'above what remains', [4n * TAZ_1, takeOffer({ remaining: 3n * TAZ_1 })], 'devnet');
add('takeProblem', 'below the token minimum', [TAZ_1 / 2n, takeOffer({ tazMin: 1n })], 'devnet');
add('takeProblem', 'price above priceMax', [2n * TAZ_1, takeOffer({ price: 1_000_000_000_001n })], 'devnet');
add('takeProblem', 'under 1 USDC', [TAZ_1, takeOffer({ price: 500_000n })], 'devnet');
add('takeProblem', 'over the mainnet maximum', [5n * TAZ_1, takeOffer({ price: 3_000_000_000n })], 'mainnet');
add('takeProblem', 'SOUL', [2n * 100_000_000n, takeOffer({ symbol: 'SOUL', tazMin: 100_000_000n, tazMax: 50n * 100_000_000n, price: 11_200_000n })], 'devnet');

// openCapProblem(cap, amount, symbol)
add('openCapProblem', 'cap not read', [null, 5n * TAZ_1, 'TAZ']);
add('openCapProblem', 'room', [{ openAmount: 0n, maxOpen: 10n * TAZ_1 }, 5n * TAZ_1, 'TAZ']);
add('openCapProblem', 'exactly full after', [{ openAmount: 5n * TAZ_1, maxOpen: 10n * TAZ_1 }, 5n * TAZ_1, 'TAZ']);
add('openCapProblem', 'one unit over', [{ openAmount: 5n * TAZ_1 + 1n, maxOpen: 10n * TAZ_1 }, 5n * TAZ_1, 'TAZ']);
add('openCapProblem', 'token not enabled', [{ openAmount: 0n, maxOpen: 0n }, 5n * TAZ_1, 'SOUL']);
add('openCapProblem', 'cap 0 with open locks', [{ openAmount: 3n, maxOpen: 0n }, 1n, 'RA']);
add('openCapProblem', 'unknown symbol in the text', [{ openAmount: 9n, maxOpen: 10n }, 5n, 'DOGE']);

// lockStartProblem(t, now)
add('lockStartProblem', 'accepted, time left', [boardTrade(), NOW]);
add('lockStartProblem', 'already locked', [boardTrade({ h: H1 }), NOW]);
add('lockStartProblem', 'ended (refunded)', [boardTrade({ status: 'refunded' }), NOW]);
add('lockStartProblem', 'ended (expired)', [boardTrade({ status: 'expired' }), NOW]);
add('lockStartProblem', 'requested, sell offer', [boardTrade({ status: 'requested' }), NOW]);
add('lockStartProblem', 'requested, buy offer', [boardTrade({ status: 'requested', side: 'buy' }), NOW]);
add('lockStartProblem', 'another step', [boardTrade({ status: 'pha_locked' }), NOW]);
add('lockStartProblem', 'unknown status', [boardTrade({ status: 'weird' }), NOW]);
add('lockStartProblem', 'about to expire', [boardTrade({ lockBy: NOW + pins.BOARD.lockStartMargin - 1 }), NOW]);
add('lockStartProblem', 'exactly the start margin', [boardTrade({ lockBy: NOW + pins.BOARD.lockStartMargin }), NOW]);
add('lockStartProblem', 'no lockBy', [boardTrade({ lockBy: null }), NOW]);

/** The twelve functions of build spec section 6.8 and where each takes timing or bounds. */
const TWELVE: Record<string, 'timing' | 'bounds' | 'none'> = {
  phaLockProblem: 'timing', buyerT2: 'timing', storedT2Problem: 'timing', baseLockProblem: 'timing', baseLockTimeProblem: 'timing',
  swapReadsProblem: 'timing', selfClaimProblem: 'timing', tradeMismatch: 'none', offerProblem: 'bounds', takeProblem: 'bounds',
  openCapProblem: 'none', lockStartProblem: 'none'
};
/** Section 4.10's functions: followOfferProblem takes bounds, then the per-take cap of a following offer. */
const FOLLOW_FNS: Record<string, 'follow' | 'none'> = { offerPriceProblem: 'none', followOfferProblem: 'follow' };
const KINDS: Record<string, 'timing' | 'bounds' | 'follow' | 'none'> = { ...TWELVE, ...FOLLOW_FNS };

/** One side's constants: its P2P_CONFIG for a network, and its FOLLOW_TAKE_USD_MAX. */
interface Side { cfgOf: (n: Net) => any; takeMaxOf: (n: Net) => bigint }

/**
 * The arguments one side gets: the vector's, then that side's own timing,
 * bounds, or bounds and per-take cap for the vector's network. A trailing
 * 'MINLEFT:<s>' or 'TAKEMAX:<raw>' replaces the side's value with the same
 * one for both sides.
 */
function argsFor(v: Vector, side: Side): unknown[] {
  const args = [...v.args];
  let minLeft: number | undefined;
  let takeMax: bigint | undefined;
  const last = args[args.length - 1];
  if (typeof last === 'string' && last.startsWith('MINLEFT:')) minLeft = Number(String(args.pop()).slice(8));
  else if (typeof last === 'string' && last.startsWith('TAKEMAX:')) takeMax = BigInt(String(args.pop()).slice(8));
  const kind = KINDS[v.fn];
  if (kind === 'timing') args.push(side.cfgOf(v.net ?? 'devnet').timing);
  if ((kind === 'bounds' && v.net) || kind === 'follow') {
    const net = v.net ?? 'devnet';
    args.push({ usdcMin: side.cfgOf(net).base.usdcMin, usdcMax: side.cfgOf(net).base.usdcMax });
  }
  if (kind === 'follow') args.push(takeMax ?? side.takeMaxOf(v.net ?? 'devnet'));
  if (minLeft !== undefined) args.push(minLeft);
  return args;
}

/** A result for an assertion message. */
const show = (x: unknown) => (typeof x === 'string' ? JSON.stringify(x) : String(x));

test('rules-parity: about 120 fixed vectors over the twelve functions, plus the section 4.10 vectors, give identical results in the kit and the site', { skip }, async () => {
  const site: any = await import(SITE_RULES.href);
  const siteC: any = await import(SITE_CONSTANTS.href);
  const twelve = V.filter((v) => v.fn in TWELVE && !v.note.startsWith('4.10 '));
  assert.ok(twelve.length >= 120, `${twelve.length} vectors over the twelve`);
  assert.ok(V.length - twelve.length >= 60, `${V.length - twelve.length} section 4.10 vectors`);
  assert.deepEqual([...new Set(V.map((v) => v.fn))].sort(), Object.keys(KINDS).sort(), 'every one of the twelve and of section 4.10 is covered');
  assert.ok(V.filter((v) => v.fn === 'tradeMismatch' && v.args.length === 3).length >= 25, 'tradeMismatch with the maker\'s offer');
  const kitSide: Side = { cfgOf: (n) => pins.P2P_CONFIG[n], takeMaxOf: (n) => kit.FOLLOW_TAKE_USD_MAX[n] };
  const siteSide: Side = { cfgOf: (n) => siteC.P2P_CONFIG[n], takeMaxOf: (n) => siteC.FOLLOW_TAKE_USD_MAX[n] };
  const per = new Map<string, { pass: number; fail: number }>();
  for (const v of V) {
    const k = (kit as any)[v.fn], s = site[v.fn];
    assert.equal(typeof k, 'function', `kit rules.ts exports ${v.fn}`);
    assert.equal(typeof s, 'function', `site rules.js exports ${v.fn}`);
    const kr = k(...argsFor(v, kitSide));
    const sr = s(...argsFor(v, siteSide));
    assert.deepEqual(kr, sr, `${v.fn} (${v.note}): kit ${show(kr)} vs site ${show(sr)}`);
    const c = per.get(v.fn) ?? { pass: 0, fail: 0 };
    if (kr === null) c.pass++; else c.fail++;
    per.set(v.fn, c);
  }
  // Every function except buyerT2 (a number) is exercised both ways: at least one vector passes and one refuses.
  for (const [fn, c] of per) if (fn !== 'buyerT2') assert.ok(c.pass >= 1 && c.fail >= 1, `${fn}: ${c.pass} passing and ${c.fail} refusing vectors`);
});

test('rules-parity: the decision helpers and the small helpers agree too', { skip }, async () => {
  const site: any = await import(SITE_RULES.href);
  const fmt: any = await import(SITE_FORMAT.href);
  const siteC: any = await import(SITE_CONSTANTS.href);
  const sT = siteC.P2P_CONFIG.devnet.timing;
  const facts = (o: Record<string, unknown>, timing: unknown) => ({
    role: 'S', trade: boardTrade(), boardOk: true, pha: null, base: null, haveSecret: false, revealed: false, now: NOW, timing, ...o
  });
  const factCases: Array<Record<string, unknown>> = [
    {},
    { capFull: true },
    { boardOk: false },
    { role: 'B', trade: boardTrade({ h: H1, status: 'pha_locked' }), pha: phaLock(), base: swap({ state: 0 }) },
    { role: 'B', trade: boardTrade({ h: H1, status: 'pha_locked' }), pha: phaLock({ created: NOW - 11 * MIN }), base: swap({ state: 0 }) },
    { trade: boardTrade({ h: H1, status: 'base_locked' }), pha: phaLock(), base: swap(), haveSecret: true },
    { trade: boardTrade({ h: H1, status: 'base_locked' }), pha: phaLock(), base: swap(), haveSecret: true, revealed: true, revealedAt: NOW - 30 },
    { trade: boardTrade({ h: H1, status: 'revealed' }), pha: phaLock(), base: swap(), haveSecret: true, revealed: true, revealedAt: NOW - 61 },
    { trade: boardTrade({ h: H1, status: 'revealed' }), pha: phaLock(), base: swap(), haveSecret: true, revealed: true, keeperDown: true },
    { trade: boardTrade({ h: H1, status: 'base_claimed' }), pha: phaLock({ state: 2 }), base: swap(), haveSecret: true },
    { trade: boardTrade({ h: H1, status: 'base_claimed' }), pha: phaLock(), base: swap({ state: 2 }) },
    { trade: boardTrade({ h: H1, status: 'refunding' }), pha: phaLock({ deadline: NOW - 31 }), base: swap({ state: 0 }) },
    { trade: boardTrade({ h: H1, status: 'refunding' }), pha: phaLock({ deadline: NOW - 31 }), base: swap({ state: 2 }) },
    { trade: boardTrade({ h: H1, status: 'refunding' }), pha: phaLock({ deadline: NOW - 31 }), base: null },
    { role: 'B', trade: boardTrade({ h: H1, status: 'refunding' }), pha: phaLock(), base: swap({ deadline: NOW - 31 }) },
    { trade: boardTrade({ h: H1, status: 'base_locked' }), pha: phaLock(), base: swap({ deadline: NOW + devT.claimMargin - 1 }), haveSecret: true, revealed: true }
  ];
  for (const c of factCases) {
    for (const fn of ['nextActions', 'claimAlert', 'claimBlock', 'tazRefundHeld']) {
      assert.deepEqual((kit as any)[fn](facts(c, devT)), site[fn](facts(c, sT)), `${fn} ${JSON.stringify(Object.keys(c))}`);
    }
  }
  for (const [rec, trade, sw] of [
    [null, null, null], [{ secretSentAt: 1_790_000_000_500 }, { status: 'base_locked' }, { state: 1 }], [{ revealedAt: 1_790_000_000_000 }, null, null],
    [{}, { status: 'revealed' }, { state: 1 }], [{}, { status: 'done' }, { state: 2 }], [undefined, { status: 'payout_pending' }, undefined],
    [{ secretSentAt: 1_790_000_000_500, keeperRefused: true }, { status: 'base_locked' }, { state: 1 }], [{ secretSentAt: 1_790_000_000_500, keeperRefused: true }, { status: 'revealed' }, { state: 1 }]
  ] as const) {
    assert.deepEqual(kit.revealFacts(rec as any, trade as any, sw as any), site.revealFacts(rec, trade, sw));
  }
  const lockCases = [phaLock(), phaLock({ state: 0 }), phaLock({ state: 3 }), phaLock({ symbol: 'SOUL' }), phaLock({ sender: X_P }), null];
  for (const l of lockCases) {
    assert.equal(kit.lockFits(l, wantPha()), site.lockFits(l, wantPha()));
    assert.equal(kit.lockFits(l, wantPha({ sPha: undefined })), site.lockFits(l, wantPha({ sPha: undefined })));
    if (l) assert.equal(kit.lockWindowClosed(l, NOW, devT), site.lockWindowClosed(l, NOW, sT));
    assert.equal(kit.buyerLockBy(l, devT), site.buyerLockBy(l, sT));
  }
  for (const st of [null, { maxOpen: 0n, minAmount: TAZ_1, maxAmount: 0n }, { maxOpen: 10n, minAmount: TAZ_1, maxAmount: 100_000n * TAZ_1 }, { maxOpen: 10n, minAmount: 2n, maxAmount: 100_000n * TAZ_1 }]) {
    for (const sym of ['TAZ', 'DOGE']) assert.equal(kit.tokenStateProblem(sym, st), site.tokenStateProblem(sym, st));
  }
  for (const cap of [null, { openAmount: 3n, maxOpen: 10n }, { openAmount: 12n, maxOpen: 10n }]) assert.equal(kit.capRoom(cap), site.capRoom(cap));
  for (const f of [null, undefined, {}, { feeBps: 0 }, { feeBps: 100 }, { feeBps: 200 }, { feeBps: 201 }, { feeBps: -1 }, { feeBps: 1.5 }, { feeBps: null }]) assert.equal(kit.tradeFee(f as any), site.tradeFee(f));
  for (const v of ['1', '0', '01', ' 5 ', '-3', '1e3', 7n, 0n, 7, null, '9'.repeat(40), '9'.repeat(41)]) assert.equal(kit.posInt(v), site.posInt(v), `posInt(${String(v)})`);
  for (const a of [S_B, S_B.toUpperCase().replace('0X', '0x'), '0x' + '0'.repeat(40), '0x123', null, 'P2K']) {
    assert.equal(kit.evmLower(a), site.evmLower(a));
    assert.equal(kit.sameEvm(a, S_B), site.sameEvm(a, S_B));
  }
  for (const a of [S_P, 'P2K' + 'S'.repeat(39), 'P2K' + 'S'.repeat(51), 'P2K' + '0'.repeat(44), null]) assert.equal(kit.isPhaAddress(a), site.isPhaAddress(a));
  for (const s of [0, 29, 30, 59 * 60, 3600, 5400, 12 * 3600, -5]) assert.equal(kit.minutesText(s), site.minutesText(s));
  for (const s of ['TAZ', 'RA', 'taz', null]) {
    assert.equal(kit.symName(s), site.symName(s));
    assert.equal(kit.openCapText(s), site.openCapText(s));
    assert.equal(kit.tokenOffText(s), site.tokenOffText(s));
  }
  for (const st of [...kit.TRADE_STATUSES, 'unknown', 'weird', '__proto__']) assert.equal(kit.statusText(st), site.statusText(st));
  assert.deepEqual([...kit.TERMINAL], [...site.TERMINAL]);
  assert.deepEqual([...kit.TRADE_STATUSES], [...site.TRADE_STATUSES]);
  assert.deepEqual({ ...kit.STATUS_TEXT }, { ...fmt.STATUS_TEXT });
  assert.equal(kit.usdcFor(5n * TAZ_1, 1_640_000n, 'TAZ'), site.usdcFor(5n * TAZ_1, 1_640_000n, 'TAZ'));
  assert.equal(kit.usdcFor(123_456_789n, 11_200n, 'SOUL'), site.usdcFor(123_456_789n, 11_200n, 'SOUL'));
  assert.throws(() => kit.usdcFor(1n, 1n, 'DOGE'));
  assert.throws(() => site.usdcFor(1n, 1n, 'DOGE'));
  assert.equal(kit.feeOf(8_200_000n, 100), site.feeOf(8_200_000n, 100));
  assert.equal(kit.netOf(8_200_000n, 100), site.netOf(8_200_000n, 100));
  assert.equal(kit.revealBy({ deadline: NOW }, devT), site.revealBy({ deadline: NOW }, sT));
  assert.equal(kit.claimWindowProblem(NOW + 10, NOW, devT), site.claimWindowProblem(NOW + 10, NOW, sT));
  assert.equal(kit.claimWindowProblem(NOW + 3600, NOW, devT), site.claimWindowProblem(NOW + 3600, NOW, sT));
  assert.equal(kit.lockWindowText(devT), site.lockWindowText(sT));
  for (const [raw, d, m] of [[0n, 9, 9], [1_234_567_890_123n, 9, 9], [-5_000_000n, 6, 6], [100n, 8, 2], [10n ** 30n, 10, 10]] as const) {
    assert.equal(kit.amountText(raw, d, m), fmt.amountText(raw, d, m));
  }
  assert.equal(kit.usdcText(8_200_000n), fmt.usdcText(8_200_000n));
  assert.equal(kit.usdcText(8_200_000n, 'mUSDC'), fmt.usdcText(8_200_000n, 'mUSDC'));
});

test('rules-parity, section 4.10: the follow helpers and constants agree with the site, and the per-take cap with the board\'s defaults', { skip }, async () => {
  const site: any = await import(SITE_RULES.href);
  const siteC: any = await import(SITE_CONSTANTS.href);
  // The constants: the per-take cap per network and the offset range.
  assert.deepEqual({ ...kit.FOLLOW_TAKE_USD_MAX }, { ...siteC.FOLLOW_TAKE_USD_MAX });
  assert.deepEqual({ ...kit.FOLLOW_TAKE_USD_MAX }, { devnet: 10_000_000_000n, mainnet: 1_000_000_000n });
  assert.ok(Object.isFrozen(kit.FOLLOW_TAKE_USD_MAX));
  assert.equal(kit.FOLLOW_OFFSET_MAX_BPS, siteC.FOLLOW_OFFSET_MAX_BPS);
  // The board's own defaults (P2P_FOLLOW_TAKE_USD_MAX_MAINNET and _DEVNET, whole USDC), read as text, when the backend is beside the kit.
  if (existsSync(BACKEND_FOLLOW)) {
    const src = readFileSync(BACKEND_FOLLOW, 'utf8');
    const m = /FOLLOW_TAKE_USD_MAX_DEFAULT[^=]*=\s*Object\.freeze\(\{\s*mainnet:\s*([\d_]+),\s*devnet:\s*([\d_]+)\s*\}\)/.exec(src);
    assert.ok(m, 'the backend states FOLLOW_TAKE_USD_MAX_DEFAULT');
    const whole = (x: string) => BigInt(x.replace(/_/g, '')) * 1_000_000n;
    assert.equal(kit.FOLLOW_TAKE_USD_MAX.mainnet, whole(m![1]!));
    assert.equal(kit.FOLLOW_TAKE_USD_MAX.devnet, whole(m![2]!));
  }
  const follows: unknown[] = [
    FOLLOW, { offsetBps: -150, limitPrice: '4900000', dailyMax: '10' }, { offsetBps: 2000, limitPrice: 1n, dailyMax: 1n }, { offsetBps: -2000, limitPrice: '1', dailyMax: '1' },
    { ...FOLLOW, offsetBps: 2001 }, { ...FOLLOW, offsetBps: -2001 }, { ...FOLLOW, offsetBps: 1.5 }, { ...FOLLOW, offsetBps: '200' }, { ...FOLLOW, limitPrice: '0' },
    { ...FOLLOW, limitPrice: 4.9 }, { ...FOLLOW, limitPrice: ' 5 ' }, { ...FOLLOW, dailyMax: '' }, { offsetBps: 200, limitPrice: '1600000' }, { ...FOLLOW, dailyMax: '01' },
    null, undefined, 'x', 7, []
  ];
  for (const f of follows) assert.deepEqual(kit.followOf(f), site.followOf(f), `followOf(${JSON.stringify(f, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))})`);
  for (const a of follows) for (const b of follows) assert.equal(kit.sameFollow(a, b), site.sameFollow(a, b));
  assert.equal(kit.sameFollow(FOLLOW, { offsetBps: 200, limitPrice: 1_600_000n, dailyMax: 30_000_000_000n }), true, 'text and bigint figures are the same settings');
  for (const o of [
    myOffer(), myOffer({ priceHistory: [{ price: '1' }, { price: 'x' }, { price: '2' }, { price: '1' }], price: '3' }), myOffer({ priceHistory: undefined }),
    myOffer({ price: 1_640_000n, priceHistory: [{ price: 1_600_000n }] }), myOffer({ price: '', priceHistory: [null, { price: '-1' }] }), null, undefined, {}
  ]) assert.deepEqual(kit.offerPrices(o as any), site.offerPrices(o));
  for (const raw of [4_900_000n, 5_120_000n, 162_300n, 5_000_000n, 1n, 0n, 1_234_567_890n, 10n ** 12n, 100n, 10_000n]) assert.equal(kit.usdcPriceText(raw), site.usdcPriceText(raw));
});

test('rules.ts keeps the site\'s names: every function it exports is the site\'s rules.js or format.js export of the same name', { skip }, async () => {
  const site: any = await import(SITE_RULES.href);
  const fmt: any = await import(SITE_FORMAT.href);
  for (const [name, v] of Object.entries(kit)) {
    if (typeof v !== 'function') continue;
    assert.ok(typeof site[name] === 'function' || typeof fmt[name] === 'function', `${name} exists on the site under the same name`);
  }
});
