/**
 * The pure rules of a P2P trade (P2P/SPEC.md sections 6 and 7; build spec
 * section 6.4): a port of the site's src/lib/p2p/rules.js with the same
 * names, the same semantics and the same sentences, so a bot refuses exactly
 * what a person's page refuses. test/rules-parity.test.ts runs fixed vectors
 * through both and asserts identical results.
 *
 * Every check returns null when it passes, or a plain sentence saying why
 * not (the site's own wording; checks.ts adds a code). No network, no clock,
 * no store: callers pass `now` (unix seconds, never before the newest Base
 * block) and the reads.
 *
 * A trade is for one token (TAZ, SOUL, KCAL or RA). Lock amounts are raw
 * units and the tokens have different decimals, so every check of a lock
 * compares its symbol EXACTLY with the token the kit agreed to, from its own
 * record, never "any token the kit trades" and never the board's word.
 *
 * Offers that follow the reference price (build spec sections 2.4.6 and
 * 4.10): tradeMismatch takes the maker's own offer as a third argument, and
 * a trade on it must then be at a price that offer allows now
 * (offerPriceProblem: one of the fixed prices the kit set, or at or past a
 * following offer's limit price). followOfferProblem and FOLLOW_TAKE_USD_MAX
 * are the site's pre-post check of such an offer.
 */
import { MAX_FEE_BPS, MIN_TRADE_USDC, BOARD, USDC_DECIMALS, tokenOf, unitOf, type P2PTiming } from './pins.js';
import type { Role, Trade } from './types.js';

/** The timing fields the rules read (pins.ts P2PTiming has these and the refund graces). */
export type RuleTiming = Pick<P2PTiming, 'phaLock' | 'safety' | 'revealMin' | 'baseLockLead' | 'revealAllowance' | 'claimMargin' | 'claimWatch' | 'refundGrace' | 'lockSlack' | 'baseLockWindow' | 'baseLockSignLead'>;

/** An escrow lock on Phantasma as its getters return it. state: 0 none, 1 locked, 2 claimed, 3 refunded. */
export interface PhaLock {
  state: number;
  sender: string;
  recipient: string;
  symbol: string;
  amount: bigint;
  /** T1, unix seconds. */
  deadline: number;
  /** getCreated: the Phantasma block time of the lock (0 when state is 0). */
  created: number;
}

/** A SaturnSwap lock as getSwap returns it. state: 0 none, 1 locked, 2 claimed, 3 refunded. */
export interface BaseSwap {
  state: number;
  token: string;
  sender: string;
  claimer: string;
  amount: bigint;
  /** T2, unix seconds. */
  deadline: number;
  feeBps: number;
}

/**
 * The fields of the kit's own trade record that tradeMismatch compares with
 * the board's trade (types.ts LocalTrade has all of them, under these names).
 */
export interface AgreedTrade {
  id: number;
  role: Role;
  maker: boolean;
  symbol: string;
  taz: string;
  usdc: string;
  /** The price the kit saw and sent at take (a maker: the offer price it agreed to). */
  price: string;
  myPha: string;
  myBase: string;
  counterPha?: string;
  counterBase?: string;
  h?: string;
  phaContract?: string;
}

/** The board trade fields the rules read. */
export type BoardTrade = Pick<Trade, 'id' | 'offerId' | 'symbol' | 'taz' | 'usdc' | 'price' | 'side' | 'seller' | 'buyer' | 'h' | 'phaContract'>;

export const TERMINAL: readonly string[] = Object.freeze(['done', 'refunded', 'cancelled', 'expired']);

/** Every trade status the board may report (SPEC section 7). */
export const TRADE_STATUSES: readonly string[] = Object.freeze(['requested', 'accepted', 'pha_locked', 'base_locked', 'revealed', 'base_claimed', 'payout_pending', 'done', 'refunding', 'refunded', 'cancelled', 'expired']);

/** Plain status names (the site's format.js STATUS_TEXT). */
export const STATUS_TEXT: Readonly<Record<string, string>> = Object.freeze({
  requested: 'Waiting for the maker',
  accepted: 'Accepted',
  pha_locked: 'Locked on Phantasma',
  base_locked: 'USDC locked',
  revealed: 'Paying out',
  base_claimed: 'Seller paid',
  done: 'Done',
  refunding: 'Refunding',
  refunded: 'Refunded',
  cancelled: 'Cancelled',
  expired: 'Expired',
  payout_pending: 'Payout pending',
  unknown: 'Board not answering'
});

/** A status in the site's own words, never the board's text. */
export function statusText(status: string): string {
  return Object.prototype.hasOwnProperty.call(STATUS_TEXT, status) ? STATUS_TEXT[status]! : 'Unknown status';
}

// ── Amounts ──────────────────────────────────────────────────────────────────

/** Raw units -> "1,234.5" (trailing zeros dropped, at most `maxFrac` places): the site's format.js amountText. */
export function amountText(raw: bigint, decimals: number, maxFrac: number = decimals): string {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const unit = 10n ** BigInt(decimals);
  const whole = v / unit;
  const frac = (v % unit).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '');
  const text = whole.toLocaleString('en-US') + (frac ? `.${frac}` : '');
  return neg ? `-${text}` : text;
}

/** Raw USDC -> "1,234.5 USDC" (the site's format.js usdcText). */
export const usdcText = (raw: bigint, symbol: string = 'USDC'): string => `${amountText(raw, USDC_DECIMALS)} ${symbol}`;

/**
 * usdc = amount * price / 10^decimals(symbol), rounded down (SPEC section 7).
 * Throws for a symbol the kit does not trade (no guessed unit).
 */
export function usdcFor(amount: bigint, price: bigint, symbol: unknown): bigint {
  return (amount * price) / unitOf(symbol);
}

/** A symbol for a sentence: the table's symbol, or 'token' for anything else (never the board's own text). */
export function symName(symbol: unknown): string {
  return tokenOf(symbol)?.symbol ?? 'token';
}

/** "1 SOUL", "100,000 TAZ": a table amount for a sentence. */
const whole = (raw: bigint, t: { symbol: string; decimals: number }) => `${amountText(raw, t.decimals)} ${t.symbol}`;

/** The refusal for a token the kit does not trade (or no longer opens new trades for). */
const NOT_TRADED_TEXT = 'Pick one of the tokens this site trades: TAZ, SOUL, KCAL or RA.';

/** The fee SaturnSwap keeps on a claim. */
export function feeOf(usdc: bigint, bps: number): bigint {
  return (usdc * BigInt(bps)) / 10000n;
}

/** What the seller receives. */
export function netOf(usdc: bigint, bps: number): bigint {
  return usdc - feeOf(usdc, bps);
}

/** A positive integer string -> bigint, or null. */
export function posInt(v: unknown): bigint | null {
  const s = typeof v === 'string' ? v.trim() : typeof v === 'bigint' ? v.toString() : '';
  return /^[1-9]\d{0,39}$/.test(s) ? BigInt(s) : null;
}

// ── Addresses ────────────────────────────────────────────────────────────────

/** '0x' + 40 hex, lowercase; null for anything else or the zero address. */
export function evmLower(a: unknown): string | null {
  if (typeof a !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a)) return null;
  const s = a.toLowerCase();
  return /^0x0{40}$/.test(s) ? null : s;
}

/** Same EVM address, case aside. Never true for an invalid one. */
export function sameEvm(a: unknown, b: unknown): boolean {
  const x = evmLower(a);
  return x != null && x === evmLower(b);
}

/** A Phantasma user address as the chain writes it (shape only). */
export function isPhaAddress(a: unknown): a is string {
  return typeof a === 'string' && /^P2K[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(a);
}

// ── Chain checks (SPEC section 6) ────────────────────────────────────────────

/**
 * Step 2: the buyer checks the seller's Phantasma lock before locking USDC
 * (check 40). `want.symbol` is the token the buyer agreed to at take time,
 * from its own record: the lock must hold exactly that token, checked before
 * the amount.
 */
export function phaLockProblem(lock: PhaLock | null, want: { symbol: string; taz: bigint; bPha: string; sPha?: string }, now: number, timing: RuleTiming): string | null {
  const t = tokenOf(want.symbol);
  if (!t) return 'This trade names no token this site trades. Not locking.';
  const sym = t.symbol;
  if (!lock || lock.state === 0) return `The ${sym} is not locked on Phantasma yet.`;
  if (lock.state === 2) return 'This lock was already claimed.';
  if (lock.state === 3) return 'This lock was already refunded to the seller.';
  if (lock.state !== 1) return 'The lock is in a state this page does not know.';
  if (lock.symbol !== sym) return `The lock on Phantasma holds another token than this trade (${sym}).`;
  if (lock.amount !== want.taz) return `The ${sym} lock holds a different amount than this trade.`;
  if (!want.bPha || lock.recipient !== want.bPha) return `The ${sym} lock pays another address, not yours.`;
  if (want.sPha && lock.sender !== want.sPha) return `The ${sym} lock was made by another address than the seller in this trade.`;
  if (!Number.isSafeInteger(lock.deadline) || lock.deadline <= 0) return `The ${sym} lock has no valid end time.`;
  if (!Number.isSafeInteger(lock.created) || lock.created <= 0) return `The ${sym} lock's start time could not be read. Not locking.`;
  // The Base lock window: a USDC lock mined later than created + BASE_LOCK_WINDOW is refused by the
  // seller and the keeper, so the buyer signs only while baseLockSignLead of the window is left.
  if (lockWindowClosed(lock, now, timing)) return lockWindowText(timing);
  if (buyerT2(lock.deadline, now, timing) - now < timing.revealMin + timing.baseLockLead) return `Too little time is left on the ${sym} lock to lock USDC safely. The seller gets the ${sym} back after it ends.`;
  // LOCK_SLACK: a Phantasma lock far longer than the site's would keep the buyer's USDC locked that much longer.
  if (lock.deadline - now > timing.phaLock + timing.lockSlack) return `The ${sym} lock runs much longer than this site's locks, which would keep your USDC locked longer. Not locking.`;
  return null;
}

/**
 * The end of the buyer's USDC lock (SPEC section 6 step 2):
 * T2 = min(T1 - SAFETY, now + REVEAL_MIN + 10 min + REVEAL_ALLOWANCE).
 * Computed once, when the buyer starts the lock, and stored before anything is signed.
 */
export function buyerT2(t1: number, now: number, timing: RuleTiming): number {
  return Math.min(t1 - timing.safety, now + timing.revealMin + timing.baseLockLead + timing.revealAllowance);
}

/**
 * The re-check of a stored T2 right before the lock is signed (SPEC section 6
 * step 2): still T2 <= T1 - SAFETY and T2 - now >= REVEAL_MIN + 10 min.
 */
export function storedT2Problem(t2: number | null | undefined, t1: number, now: number, timing: RuleTiming): string | null {
  if (!Number.isSafeInteger(t2) || (t2 as number) <= 0) return 'This browser has no stored end time for your USDC lock. Nothing was locked; press Lock USDC again.';
  if (!Number.isSafeInteger(t1) || t1 <= 0 || (t2 as number) > t1 - timing.safety) return 'Your USDC lock would end too close to the end of the seller\'s Phantasma lock. Nothing was locked.';
  if ((t2 as number) - now < timing.revealMin + timing.baseLockLead) return 'Too little time is left to lock USDC safely. Nothing was locked; press Lock USDC again to start over.';
  return null;
}

/** The last moment the seller shares the secret for this USDC lock (SPEC section 6 step 3). */
export function revealBy(swap: { deadline: number }, timing: Pick<RuleTiming, 'revealMin'>): number {
  return swap.deadline - timing.revealMin;
}

// ── The open cap (SPEC section 4, "Open cap"; one cap per token) ────────────

/** The open-cap refusal for a token, word for word as SPEC section 6 step 1 gives it. */
export function openCapText(symbol: unknown): string {
  return `The P2P escrow is at its safety limit for open ${symName(symbol)} locks right now. Nothing was locked; try again later.`;
}

/** A token the escrow takes no lock of: its cap or its largest lock is 0. */
export function tokenOffText(symbol: unknown): string {
  return `${symName(symbol)} is not enabled in the P2P escrow on Phantasma right now, so it cannot be locked. Nothing was locked.`;
}

/**
 * Why no new offer or take of a token can be made right now, from the
 * escrow's reads for that symbol, or null. A state that was not read (null)
 * blocks nothing here; the seller re-reads its own token before every lock.
 */
export function tokenStateProblem(symbol: unknown, st: { maxOpen: bigint; minAmount: bigint; maxAmount: bigint } | null | undefined): string | null {
  const t = tokenOf(symbol);
  if (!t || !t.enabled) return NOT_TRADED_TEXT;
  if (!st) return null;
  if (st.maxAmount === 0n || st.maxOpen === 0n) return `${t.symbol} is not enabled in the P2P escrow on this network yet, so it cannot be traded here.`;
  if (st.minAmount !== t.min || st.maxAmount !== t.max) return `The P2P escrow's limits for ${t.symbol} on this network are not the ones this site checks for, so ${t.symbol} cannot be traded here until they match.`;
  return null;
}

/** How much more of the token the escrow takes in open locks now (never below 0), or null when the cap was not read. */
export function capRoom(cap: { openAmount: bigint; maxOpen: bigint } | null | undefined): bigint | null {
  if (!cap) return null;
  return cap.maxOpen > cap.openAmount ? cap.maxOpen - cap.openAmount : 0n;
}

/**
 * The token's open-cap text while a lock of `amount` would go over that
 * token's open cap, else null (check 11). A cap that was not read (null) is
 * null here: a take or an accept never blocks on a failed read; the seller's
 * check before the lock (check 21) refuses a failed read itself.
 */
export function openCapProblem(cap: { openAmount: bigint; maxOpen: bigint } | null | undefined, amount: bigint, symbol: unknown): string | null {
  if (!cap) return null;
  if (cap.maxOpen === 0n && cap.openAmount === 0n) return tokenOffText(symbol);
  return cap.openAmount + amount > cap.maxOpen ? openCapText(symbol) : null;
}

/** "15 min", "1 h", "1 h 30 min". */
export function minutesText(sec: number): string {
  const m = Math.max(0, Math.round(sec / 60));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

/** The text once the Base lock window has closed for signing. */
export function lockWindowText(timing: Pick<RuleTiming, 'baseLockWindow'>): string {
  return `Too late to lock USDC: a USDC lock counts only when it is mined within ${minutesText(timing.baseLockWindow)} of the seller's lock on Phantasma, so the seller's page and the keeper would refuse it. This trade can no longer complete; the seller's tokens return to the seller at T1. Nothing was locked.`;
}

/** Whether the buyer may no longer sign a USDC lock: now - created > BASE_LOCK_WINDOW - lead. An unreadable start counts as closed. */
export function lockWindowClosed(lock: { created: number }, now: number, timing: Pick<RuleTiming, 'baseLockWindow' | 'baseLockSignLead'>): boolean {
  if (!Number.isSafeInteger(lock.created) || lock.created <= 0) return true;
  return now - lock.created > timing.baseLockWindow - timing.baseLockSignLead;
}

/** The last moment the buyer may sign the USDC lock: the earlier of the window rule and the T2 rule. Null when the lock's times are not known. */
export function buyerLockBy(lock: { created: number; deadline: number } | null | undefined, timing: RuleTiming): number | null {
  if (!lock || !Number.isSafeInteger(lock.created) || lock.created <= 0 || !Number.isSafeInteger(lock.deadline) || lock.deadline <= 0) return null;
  const byWindow = lock.created + timing.baseLockWindow - timing.baseLockSignLead;
  const byT2 = lock.deadline - timing.safety - timing.revealMin - timing.baseLockLead;
  return Math.min(byWindow, byT2);
}

/**
 * Step 3, the Base lock window from the seller's side (check 55): the buyer's
 * lock counts only when the Base block holding its Locked event is at most
 * BASE_LOCK_WINDOW after the Phantasma lock's getCreated. A lock time that
 * could not be read refuses exactly as a late lock does.
 */
export function baseLockTimeProblem(lockedAt: { time: number } | null, created: number, timing: Pick<RuleTiming, 'baseLockWindow'>): string | null {
  if (!Number.isSafeInteger(created) || created <= 0) return 'Could not read when your Phantasma lock was made, so the buyer\'s lock time cannot be judged. Not sharing the secret.';
  if (!lockedAt || !Number.isSafeInteger(lockedAt.time) || lockedAt.time <= 0) return 'Could not read when the buyer\'s USDC lock was mined on Base. Not sharing the secret; trying again shortly.';
  if (lockedAt.time > created + timing.baseLockWindow) {
    return `The buyer locked USDC too late (${minutesText(lockedAt.time - created)} after your Phantasma lock; the limit is ${minutesText(timing.baseLockWindow)}). Your secret stays with you and both sides refund: the buyer's USDC after T2, your tokens after T1.`;
  }
  return null;
}

/**
 * The SaturnSwap reads of SPEC section 6 step 1 (checks 12, 17, 24, 43): new
 * locks not paused, USDC allowed with `usdc` inside its bounds, and lock
 * bounds that fit every T2 the buyer accepts. Null when the lock can succeed.
 */
export function swapReadsProblem(bp: { paused: boolean; allowed: boolean; minAmount: bigint; maxAmount: bigint; minLock: number; maxLock: number }, usdc: bigint, timing: RuleTiming): string | null {
  if (bp.paused) return 'New USDC locks are paused on Base right now, so the USDC could not be locked. Try again later.';
  if (!bp.allowed || usdc < bp.minAmount || usdc > bp.maxAmount) return 'The Base contract would not accept this USDC amount, so the USDC could not be locked.';
  if (!Number.isSafeInteger(bp.minLock) || bp.minLock > timing.revealMin) return 'The Base contract\'s shortest lock is longer than this site allows, so the USDC lock could fail.';
  if (!Number.isSafeInteger(bp.maxLock) || bp.maxLock < timing.phaLock + timing.lockSlack - timing.safety) return 'The Base contract\'s longest lock is shorter than this site needs, so the USDC lock could fail.';
  return null;
}

/** The trade's fee as the board fixed it at accept, or null when it is missing or above MAX_FEE_BPS (check 22). */
export function tradeFee(t: { feeBps?: number | null } | null | undefined): number | null {
  const f = t?.feeBps;
  return Number.isInteger(f) && (f as number) >= 0 && (f as number) <= MAX_FEE_BPS ? (f as number) : null;
}

function swapFitProblem(s: BaseSwap, want: { usdcToken: string; usdc: bigint; sBase: string; bBase: string }): string | null {
  if (!sameEvm(s.token, want.usdcToken)) return 'The lock on Base holds another token, not USDC.';
  if (s.amount !== want.usdc) return 'The USDC lock holds a different amount than this trade.';
  if (!sameEvm(s.claimer, want.sBase)) return 'The USDC lock pays another address, not yours.';
  if (!sameEvm(s.sender, want.bBase)) return 'The USDC lock was made by another address than the buyer.';
  return null;
}

/**
 * Step 3: the seller checks the buyer's Base lock before sharing the secret
 * or claiming with it (check 55). `latest` is getSwap at the newest block;
 * `confirmed` at the confirmed point, so a lock a reorg could undo does not count yet.
 */
export function baseLockProblem(
  latest: BaseSwap | null, confirmed: BaseSwap | null,
  want: { usdcToken: string; usdc: bigint; sBase: string; bBase: string; t1: number; maxFeeBps: number },
  now: number, timing: RuleTiming, minLeft: number = timing.revealMin
): string | null {
  if (!latest || latest.state === 0) return 'The USDC is not locked on Base yet.';
  if (latest.state === 2) return 'This USDC lock was already claimed.';
  if (latest.state === 3) return 'This USDC lock was already refunded to the buyer.';
  if (latest.state !== 1) return 'The USDC lock is in a state this page does not know.';
  const fit = swapFitProblem(latest, want);
  if (fit) return fit;
  if (!confirmed || confirmed.state === 0) return 'The USDC lock is waiting for confirmations on Base.';
  if (confirmed.state !== 1) return 'The USDC lock changed while it was being checked. Checking again.';
  const fitC = swapFitProblem(confirmed, want);
  if (fitC) return fitC;
  if (confirmed.deadline !== latest.deadline || confirmed.feeBps !== latest.feeBps) return 'The USDC lock changed while it was being checked. Checking again.';
  if (!Number.isSafeInteger(want.t1) || want.t1 <= 0) return 'The Phantasma lock\'s end time could not be read.';
  if (latest.deadline > want.t1 - timing.safety) return 'The USDC lock ends too close to the end of the Phantasma lock.';
  if (latest.deadline - now < minLeft) return 'Too little time is left on the USDC lock to finish safely. Both sides get their coins back after the time limits.';
  const shown = Math.min(want.maxFeeBps, MAX_FEE_BPS);
  if (!Number.isInteger(latest.feeBps) || latest.feeBps < 0 || latest.feeBps > shown) return 'The USDC lock charges a higher fee than you were shown.';
  return null;
}

/**
 * The seller's own USDC claim (check 59), from the kit's own record and
 * secret and the chain reads only, never the board:
 *   - the Phantasma lock at h is this trade's and reads locked (1) or claimed (2);
 *   - while it is still locked, the USDC lock ends at least SAFETY before it;
 *   - the USDC lock reads locked and fits at the newest and the confirmed block;
 *   - at least CLAIM_MARGIN is left before T2.
 */
export function selfClaimProblem(
  lock: PhaLock | null, latest: BaseSwap | null, confirmed: BaseSwap | null,
  want: { symbol: string; taz: bigint; sPha: string; bPha: string; usdcToken: string; usdc: bigint; sBase: string; bBase: string },
  now: number, timing: RuleTiming
): string | null {
  const t = tokenOf(want.symbol);
  if (!t) return 'This trade names no token this site trades. Not claiming the USDC.';
  const sym = t.symbol;
  if (!lock || lock.state === 0) return `Your ${sym} lock is not on Phantasma.`;
  if (lock.state === 3) return `Your ${sym} lock was refunded to you, so the buyer can no longer get the ${sym}. Not claiming the USDC.`;
  if (lock.state !== 1 && lock.state !== 2) return `Your ${sym} lock is in a state this page does not know.`;
  if (lock.sender !== want.sPha || !want.bPha || lock.recipient !== want.bPha || lock.symbol !== sym || lock.amount !== want.taz) {
    return `The lock with this hash on Phantasma is not your ${sym} lock for this trade.`;
  }
  if (!latest || latest.state === 0) return 'The USDC is not locked on Base.';
  if (latest.state === 2) return 'This USDC lock was already claimed.';
  if (latest.state === 3) return 'This USDC lock was already refunded to the buyer.';
  if (latest.state !== 1) return 'The USDC lock is in a state this page does not know.';
  const fit = swapFitProblem(latest, want);
  if (fit) return fit;
  if (!confirmed || confirmed.state === 0) return 'The USDC lock is waiting for confirmations on Base.';
  if (confirmed.state !== 1) return 'The USDC lock changed while it was being checked. Checking again.';
  const fitC = swapFitProblem(confirmed, want);
  if (fitC) return fitC;
  if (confirmed.deadline !== latest.deadline) return 'The USDC lock changed while it was being checked. Checking again.';
  if (lock.state === 1) {
    if (!Number.isSafeInteger(lock.deadline) || lock.deadline <= 0) return `The ${sym} lock's end time could not be read.`;
    if (latest.deadline > lock.deadline - timing.safety) return `The USDC lock ends too close to the end of the ${sym} lock.`;
  }
  return claimWindowProblem(latest.deadline, now, timing);
}

/** Whether there is still time to send a claim: a claim that lands after the deadline reverts but still publishes the secret (CLAIM_MARGIN). */
export function claimWindowProblem(deadline: number, now: number, timing: Pick<RuleTiming, 'claimMargin'>): string | null {
  if (deadline - now < timing.claimMargin) return 'Too close to the time limit to claim safely: a claim mined after the deadline fails and makes the secret public. Both locks now refund to their owners after their time limits.';
  return null;
}

/** Whether a Phantasma lock read from the chain is this trade's: exactly the record's token, amount, paying the buyer, made by the seller (when known). Any state but "none". */
export function lockFits(lock: PhaLock | null, want: { symbol: string; taz: bigint; bPha: string; sPha?: string }): boolean {
  return !!lock && !!tokenOf(want.symbol) && lock.state >= 1 && lock.state <= 3 && lock.symbol === want.symbol && lock.amount === want.taz
    && !!want.bPha && lock.recipient === want.bPha && (!want.sPha || lock.sender === want.sPha);
}

// ── The board's trade against what the kit agreed to ────────────────────────

/**
 * Null when the board's trade is the one the kit made or took (check 14): the
 * same token, the same amounts, `usdcFor(taz, price) == usdc` with the price
 * the kit saw and sent (the record's, never the board's), the board's price
 * equal to it, the kit's own addresses, the other side's addresses once
 * known, the side, and h and the escrow name once recorded.
 *
 * `offer`: the kit's own offer the trade was taken on (a maker's record),
 * when the caller holds it. The trade's price must then also be one that
 * offer allows now (build spec section 4.10, offerPriceProblem): one of the
 * fixed prices the kit set for it, or, for an offer that follows the
 * reference price, at or past the maker's limit price on the maker's side. A
 * board that fixes a take at another price never gets it accepted or locked.
 * A taker's record ignores any offer.
 */
export function tradeMismatch(t: BoardTrade, rec: AgreedTrade, offer: (OfferPricing & { id: number }) | null = null): string | null {
  if (t.id !== rec.id) return 'This is another trade.';
  const tok = tokenOf(rec.symbol);
  if (!tok) return 'This browser\'s record of the trade names no token this site trades.';
  if (t.symbol !== tok.symbol) return 'The token of this trade is not what you agreed to.';
  if (t.taz !== rec.taz) return `The ${tok.symbol} amount of this trade is not what you agreed to.`;
  if (t.usdc !== rec.usdc) return 'The USDC amount of this trade is not what you agreed to.';
  const taz = posInt(t.taz), usdc = posInt(t.usdc), price = posInt(rec.price);
  if (taz == null || usdc == null || price == null || usdcFor(taz, price, tok.symbol) !== usdc) return 'The USDC amount does not match the price you agreed to.';
  if (posInt(t.price) !== price) return 'The price of this trade is not what you agreed to.';
  if (offer && rec.maker) {
    if (offer.id !== t.offerId) return 'This trade is not on the offer you posted.';
    const bad = offerPriceProblem(t.price, offer);
    if (bad) return bad;
  }
  const mine = rec.role === 'S' ? t.seller : t.buyer;
  const theirs = rec.role === 'S' ? t.buyer : t.seller;
  if (mine.pha !== rec.myPha || !sameEvm(mine.base, rec.myBase)) return 'Your addresses in this trade are not the ones you gave.';
  if (rec.counterPha && theirs.pha !== rec.counterPha) return 'The other side\'s Phantasma address changed.';
  if (rec.counterBase && !sameEvm(theirs.base, rec.counterBase)) return 'The other side\'s Base address changed.';
  if ((rec.role === 'S') !== (t.side === 'sell' ? rec.maker : !rec.maker)) return 'Your side in this trade is not the one you chose.';
  // The lock hash the kit verified on chain. A board that has none yet is not a mismatch.
  if (rec.h && t.h && t.h.toLowerCase() !== rec.h.toLowerCase()) return 'The lock hash of this trade is not the one this browser recorded.';
  // The escrow contract the kit recorded for the lock, the same way.
  if (rec.phaContract && t.phaContract && t.phaContract !== rec.phaContract) return 'The board names another Phantasma contract for this trade\'s lock than the one this browser recorded.';
  return null;
}

/**
 * Whether the seller may start the Phantasma lock now (check 18: never before
 * the maker accepted, and not so late that the trade expires first).
 */
export function lockStartProblem(t: Pick<Trade, 'h' | 'status' | 'side' | 'lockBy' | 'symbol'>, now: number): string | null {
  if (t.h) return `The ${symName(t.symbol)} is already locked for this trade.`;
  if (TERMINAL.includes(t.status)) return `This trade has ended (${statusText(t.status)}).`;
  if (t.status === 'requested') return t.side === 'sell' ? 'Accepting the trade first.' : 'Waiting for the buyer to accept.';
  if (t.status !== 'accepted') return `This trade is at another step (${statusText(t.status)}).`;
  if (t.lockBy != null && t.lockBy - now < BOARD.lockStartMargin) return 'Too late to lock: the trade is about to expire.';
  return null;
}

// ── Offers and takes ─────────────────────────────────────────────────────────

/** USDC_MIN / USDC_MAX of a network, raw. */
export interface UsdcBounds {
  usdcMin: bigint;
  usdcMax: bigint;
}

/** Whole USDC, for the bound messages. */
const wholeUsdc = (raw: bigint) => (raw / 1_000_000n).toLocaleString('en-US');

/**
 * A new offer against the token's row of the kit's table (check 7): per lock
 * at least `min` and at most `max`, at most `offerMax` in total, a price up
 * to `priceMax`, and the network's USDC bounds at the token's decimals.
 */
export function offerProblem(o: { symbol: string; tazTotal: bigint | null; tazMin: bigint | null; tazMax: bigint | null; price: bigint | null }, bounds: UsdcBounds = { usdcMin: MIN_TRADE_USDC, usdcMax: 0n }): string | null {
  const t = tokenOf(o.symbol);
  if (!t || !t.enabled) return NOT_TRADED_TEXT;
  if (o.tazTotal == null || o.tazMin == null || o.tazMax == null) return `Enter the ${t.symbol} amounts.`;
  if (o.price == null) return 'Enter a price above zero.';
  if (o.price > t.priceMax) return `The price is at most ${wholeUsdc(t.priceMax)} USDC per ${t.symbol}.`;
  if (o.tazMin < t.min) return `The smallest trade is at least ${whole(t.min, t)}.`;
  if (o.tazMax > t.max) return `The largest trade is at most ${whole(t.max, t)}.`;
  if (o.tazTotal > t.offerMax) return `One offer holds at most ${whole(t.offerMax, t)}.`;
  if (o.tazMin > o.tazMax) return 'The smallest trade is more than the largest.';
  if (o.tazMax > o.tazTotal) return 'The largest trade is more than the total.';
  if (usdcFor(o.tazMin, o.price, t.symbol) < bounds.usdcMin) return `At this price the smallest trade is under ${wholeUsdc(bounds.usdcMin)} USDC. Raise the minimum or the price.`;
  if (bounds.usdcMax > 0n && usdcFor(o.tazMax, o.price, t.symbol) > bounds.usdcMax) return `At this price the largest trade is over ${wholeUsdc(bounds.usdcMax)} USDC, the most one lock takes on this network. Lower the maximum or the price.`;
  return null;
}

/**
 * A take of `taz` raw units of the offer's token (check 10): inside the
 * offer's bounds, inside the token's per-lock bounds of the kit's table, and
 * inside the network's USDC bounds at the token's decimals.
 */
export function takeProblem(taz: bigint | null, offer: { symbol: string; tazMin: bigint; tazMax: bigint; remaining: bigint; price: bigint }, bounds: UsdcBounds = { usdcMin: MIN_TRADE_USDC, usdcMax: 0n }): string | null {
  const t = tokenOf(offer.symbol);
  if (!t || !t.enabled) return 'This offer is for a token this site does not trade.';
  if (taz == null) return `Enter how much ${t.symbol}.`;
  if (taz < offer.tazMin) return 'Below this offer\'s minimum.';
  const most = offer.tazMax < offer.remaining ? offer.tazMax : offer.remaining;
  if (taz > most) return 'Above what this offer allows now.';
  if (taz < t.min || taz > t.max) return `One lock holds ${whole(t.min, t)} to ${whole(t.max, t)}.`;
  if (offer.price > t.priceMax) return 'This offer\'s price is above what this site accepts.';
  const usdc = usdcFor(taz, offer.price, t.symbol);
  if (usdc < bounds.usdcMin) return `A trade must cost at least ${wholeUsdc(bounds.usdcMin)} USDC.`;
  if (bounds.usdcMax > 0n && usdc > bounds.usdcMax) return `A trade may cost at most ${wholeUsdc(bounds.usdcMax)} USDC on this network.`;
  return null;
}

// ── Offers that follow the reference price (build spec sections 2.4.6, 3.6 and 4.10) ──
//
// The board sets such an offer's price from the token's published reference
// price, plus the maker's offset, and never past the maker's limit price (a
// minimum on a sell, a maximum on a buy). The kit checks the limit again
// before it accepts a take or locks (tradeMismatch with the offer), so a
// board that fixes a trade past it never gets it accepted.

/** The largest offset from the reference price, either way, in basis points (±20%): the site's constants.js FOLLOW_OFFSET_MAX_BPS. */
export const FOLLOW_OFFSET_MAX_BPS = 2000;

/**
 * The most one take of a market-following offer may cost, raw USDC, per
 * network: the offer's largest trade at its limit price (tazMax × limitPrice
 * / 10^decimals) must not exceed it. The board's defaults of
 * P2P_FOLLOW_TAKE_USD_MAX_MAINNET and _DEVNET (1,000 and 10,000 USDC), as the
 * site's constants.js has them. For the check before posting only: the board
 * decides (its `/config` limits.followTakeUsdMax), and nothing here feeds a
 * signature.
 */
export const FOLLOW_TAKE_USD_MAX: Readonly<Record<'devnet' | 'mainnet', bigint>> = Object.freeze({ devnet: 10_000_000_000n, mainnet: 1_000_000_000n });

/**
 * How one of the kit's offers is priced: `price` (its current price, raw USDC
 * per whole token), `priceHistory` (every fixed price the kit set for it,
 * oldest first) and `follow` (the maker's settings while it follows the
 * reference price, else null). types.ts LocalOffer has all three.
 */
export interface OfferPricing {
  side: 'sell' | 'buy';
  price: string | bigint;
  priceHistory?: ReadonlyArray<{ price: string | bigint; at?: number }>;
  follow?: { offsetBps: number; limitPrice: string | bigint; dailyMax?: string | bigint } | null;
}

/** Follow settings that read, as bigints (followOf). */
export interface FollowTerms {
  offsetBps: number;
  limitPrice: bigint;
  dailyMax: bigint;
}

/**
 * The follow settings of an offer (or of the board's offer), well formed, as
 * bigints: an integer offset within ±FOLLOW_OFFSET_MAX_BPS, a limit price
 * from 1 and a daily amount from 1. Null for none or anything else.
 */
export function followOf(f: unknown): FollowTerms | null {
  if (!f || typeof f !== 'object') return null;
  const x = f as Record<string, unknown>;
  const limitPrice = posInt(x.limitPrice), dailyMax = posInt(x.dailyMax);
  if (!Number.isInteger(x.offsetBps) || Math.abs(x.offsetBps as number) > FOLLOW_OFFSET_MAX_BPS || limitPrice == null || dailyMax == null) return null;
  return { offsetBps: x.offsetBps as number, limitPrice, dailyMax };
}

/** The same follow settings (offset, limit price and daily amount). */
export function sameFollow(a: unknown, b: unknown): boolean {
  const x = followOf(a), y = followOf(b);
  return !!x && !!y && x.offsetBps === y.offsetBps && x.limitPrice === y.limitPrice && x.dailyMax === y.dailyMax;
}

/**
 * Every fixed price the kit set for an offer: its price history and its
 * current price. Prices that do not read are left out.
 */
export function offerPrices(offer: OfferPricing | null | undefined): bigint[] {
  const out = new Set<bigint>();
  for (const h of Array.isArray(offer?.priceHistory) ? offer!.priceHistory! : []) {
    const p = posInt(h?.price);
    if (p != null) out.add(p);
  }
  const p = posInt(offer?.price);
  if (p != null) out.add(p);
  return [...out];
}

/**
 * Whether `price` (raw USDC per whole token, a board trade's) is one the
 * kit's offer may trade at now (build spec section 4.10): for an offer that
 * follows the reference price, at or above its limit price on a sell and at
 * or below it on a buy; for a fixed offer, one of the prices the kit set for
 * it (offerPrices). Settings that do not read count as a fixed offer, the
 * stricter rule. Null when it may; else why not.
 */
export function offerPriceProblem(price: unknown, offer: OfferPricing): string | null {
  const p = posInt(price);
  if (p == null) return 'This trade names no valid price.';
  const f = followOf(offer?.follow);
  if (f) {
    if (offer.side === 'sell') return p < f.limitPrice ? `The price of this trade is below your minimum price (${usdcPriceText(f.limitPrice)} USDC).` : null;
    if (offer.side === 'buy') return p > f.limitPrice ? `The price of this trade is above your maximum price (${usdcPriceText(f.limitPrice)} USDC).` : null;
    return 'Your offer\'s side could not be read.';
  }
  return offerPrices(offer).includes(p) ? null : 'The price of this trade is not a price you set for this offer.';
}

/** A price in raw USDC per whole token, with at least two decimals: "4.90", "5.12", "0.1623". */
export function usdcPriceText(raw: bigint): string {
  const t = amountText(raw, USDC_DECIMALS);
  const dot = t.indexOf('.');
  if (dot < 0) return `${t}.00`;
  return t.length - dot - 1 < 2 ? `${t}0` : t;
}

/**
 * A market-following offer against what the board takes (build spec section
 * 2.4.6), or null: the amounts and the network's USDC bounds as for a fixed
 * offer, at the limit price; an offset within ±20%; the limit price required
 * and at most the token's priceMax; the amount per day from the smallest
 * trade to the total; and the largest trade at the limit price within the
 * network's per-take cap for such offers (FOLLOW_TAKE_USD_MAX).
 */
export function followOfferProblem(
  o: { symbol: string; side: 'sell' | 'buy'; tazTotal: bigint | null; tazMin: bigint | null; tazMax: bigint | null;
       follow: { offsetBps: number | null; limitPrice: bigint | null; dailyMax: bigint | null } },
  bounds: UsdcBounds,
  takeMax: bigint
): string | null {
  const t = tokenOf(o.symbol);
  if (!t || !t.enabled) return NOT_TRADED_TEXT;
  const f = o.follow;
  if (f.offsetBps == null || !Number.isInteger(f.offsetBps)) return 'Enter the offset in percent (from −20 to +20, at most two decimals).';
  if (Math.abs(f.offsetBps) > FOLLOW_OFFSET_MAX_BPS) return 'The offset is at most 20% either way.';
  if (f.limitPrice == null) return o.side === 'sell' ? 'Enter the lowest price you sell at ("Never below").' : 'Enter the highest price you buy at ("Never above").';
  const base = offerProblem({ symbol: t.symbol, tazTotal: o.tazTotal, tazMin: o.tazMin, tazMax: o.tazMax, price: f.limitPrice }, bounds);
  if (base) return base;
  const total = o.tazTotal as bigint, min = o.tazMin as bigint, max = o.tazMax as bigint;
  if (f.dailyMax == null) return `Enter the most ${t.symbol} this offer may sell or buy in a day.`;
  if (f.dailyMax > total) return 'The amount per day is at most the total.';
  if (f.dailyMax < min) return 'The amount per day is at least the smallest trade.';
  if (usdcFor(max, f.limitPrice, t.symbol) > takeMax) return `At your limit price the largest trade costs over ${wholeUsdc(takeMax)} USDC, the most one take of an offer that follows the reference price may cost on this network. Lower the largest trade.`;
  return null;
}

// ── Which step is due ─────────────────────────────────────────────────────────

/** What the kit knows about one trade at one moment, for the decisions below. */
export interface TradeFacts {
  /** The kit's side (from its own record). */
  role: Role | null;
  symbol?: string;
  /** The board's trade (the fields the decisions read). */
  trade: Pick<Trade, 'h' | 'status' | 'side' | 'lockBy' | 'symbol'>;
  /** The board answered and its trade is the one the kit agreed to. */
  boardOk: boolean;
  /** This trade's Phantasma lock, read from the chain at the local h (null: not read or not this trade's). */
  pha: PhaLock | null;
  /** getSwap(h, buyer) at the newest block (null: not read). */
  base: BaseSwap | null;
  /** The seller holds the secret for this trade. */
  haveSecret: boolean;
  /** The secret left the kit (POST /reveal), or the USDC was claimed. Only the kit's own record or the chain, never the board. */
  revealed: boolean;
  /** Unix seconds the secret first left the kit; CLAIM_WATCH counts from it. */
  revealedAt?: number | null;
  /** The board answered that the keeper cannot claim now (KEEPER_UNAVAILABLE). */
  keeperDown?: boolean;
  /** The board confirmed it holds the secret; defaults to `revealed`. */
  revealConfirmed?: boolean;
  /** The escrow's open cap for this trade's token has no room for it. */
  capFull?: boolean;
  /** Unix seconds, never before the newest Base block. */
  now: number;
  timing: RuleTiming;
}

/** A step the kit may take now. */
export type ActionKind = 'lockTaz' | 'lockUsdc' | 'reveal' | 'claimUsdc' | 'claimTaz' | 'refundUsdc' | 'refundTaz';

/**
 * The actions open now, the most pressing first. They only say which step is
 * due; each step re-reads the chains and runs its full checks before it signs.
 */
export function nextActions(f: TradeFacts): ActionKind[] {
  const out: ActionKind[] = [];
  const t = f.trade, tm = f.timing, now = f.now;
  const p = f.pha, b = f.base;
  const status = t.status;
  if (f.boardOk && f.role === 'S' && !t.h && (!p || p.state === 0) && !f.capFull && !lockStartProblem(t, now)) out.push('lockTaz');
  const lockBy = buyerLockBy(p, tm);
  if (f.boardOk && f.role === 'B' && t.h && p?.state === 1 && b?.state === 0 && status === 'pha_locked'
    && lockBy != null && now <= lockBy && !lockWindowClosed(p, now, tm)) out.push('lockUsdc');
  if (f.boardOk && f.role === 'S' && f.haveSecret && p?.state === 1 && b?.state === 1 && !(f.revealConfirmed ?? f.revealed) && (status === 'pha_locked' || status === 'base_locked')
    && b.deadline - now >= tm.revealMin) out.push('reveal');
  if (f.role === 'S' && f.haveSecret && b?.state === 1 && (p?.state === 1 || p?.state === 2) && now < b.deadline
    && (f.revealed || p?.state === 2)) out.push('claimUsdc');
  if (p?.state === 1 && b?.state === 2 && now < p.deadline) out.push('claimTaz');
  if (b?.state === 1 && now >= b.deadline + tm.refundGrace) out.push('refundUsdc');
  // Never once the trade's USDC swap reads claimed, and not while the swap is not read either.
  if (p?.state === 1 && now >= p.deadline + tm.refundGrace && b != null && b.state !== 2) out.push('refundTaz');
  return out;
}

/** The Phantasma lock is past T1 and still open while the USDC swap reads claimed: the refund must not be sent (pha_claim_missed). */
export function tazRefundHeld(f: Pick<TradeFacts, 'pha' | 'base' | 'now'>): boolean {
  return f.pha?.state === 1 && f.base?.state === 2 && f.now >= f.pha.deadline;
}

/** Why the seller's own USDC claim cannot be sent right now, or null. */
export function claimBlock(f: Pick<TradeFacts, 'base' | 'now' | 'timing'>): string | null {
  const b = f.base;
  if (!b || b.state !== 1) return null;
  return claimWindowProblem(b.deadline, f.now, f.timing);
}

/**
 * The seller's alarm after the reveal (CLAIM_WATCH): 'urgent' when the
 * Phantasma lock already reads claimed while the USDC swap is unclaimed;
 * 'watch' when the swap is still unclaimed CLAIM_WATCH after the secret first
 * left (or at once when the keeper said it cannot claim); else null.
 */
export function claimAlert(f: Pick<TradeFacts, 'role' | 'base' | 'pha' | 'now' | 'revealed' | 'keeperDown' | 'revealedAt' | 'timing'>): 'urgent' | 'watch' | null {
  if (f.role !== 'S' || f.base?.state !== 1) return null;
  if (f.now >= f.base.deadline) return null;
  if (f.pha?.state === 2) return 'urgent';
  if (!f.revealed) return null;
  if (f.keeperDown) return 'watch';
  if (f.revealedAt != null && f.now - f.revealedAt >= f.timing.claimWatch) return 'watch';
  return null;
}

/** Board statuses that say the secret was shared. */
const BOARD_REVEALED: readonly string[] = Object.freeze(['revealed', 'base_claimed', 'payout_pending', 'done']);

/**
 * Whether the seller's secret counts as shared: `revealed` and `revealedAt`
 * only from the kit's own record (the send time, or the board's
 * confirmation) or the chain (the swap reads claimed), never the board's
 * status alone; `revealConfirmed` also from the board's status.
 * `keeperRefused` (the site's instant buyer: every send of its code ended in
 * the keeper's definite refusal, and nothing confirmed it since) is ported
 * for parity; the kit is never an instant buyer, so its records never set it.
 */
export function revealFacts(
  rec: { secretSentAt?: number; revealedAt?: number; keeperRefused?: true } | null | undefined,
  trade: { status: string } | null | undefined,
  swap: { state: number } | null | undefined
): { revealed: boolean; revealedAt: number | null; revealConfirmed: boolean; boardRevealed: boolean; keeperRefused: boolean } {
  const sentMs = rec?.secretSentAt || rec?.revealedAt || null;
  const boardRevealed = BOARD_REVEALED.includes(trade?.status ?? '');
  const claimed = swap?.state === 2;
  const revealConfirmed = !!rec?.revealedAt || boardRevealed || claimed;
  return {
    revealed: sentMs != null || claimed,
    revealedAt: sentMs != null ? Math.floor(sentMs / 1000) : null,
    revealConfirmed,
    boardRevealed,
    keeperRefused: rec?.keeperRefused === true && !revealConfirmed
  };
}
