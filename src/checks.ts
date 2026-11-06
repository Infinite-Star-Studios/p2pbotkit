/**
 * Every check before a signature (build spec section 6.4): the kit refuses
 * to sign when any one of them fails, exactly where a person's page on the
 * site refuses. Each check answers `{ ok: true, intent }` (a Checked intent
 * the signer accepts) or `{ ok: false, problem }`, where `problem` carries the
 * check's number, a stable code, a plain sentence and whether a later try
 * may pass (`retry`). Nothing here signs or sends: signer.ts is the only
 * module that does, and it accepts only intents issued here, at most 60 s
 * old, once each, and runs the re-checks marked R right before it signs.
 *
 * What a check trusts:
 *   - the kit's own pins (pins.ts: contracts, code hashes, admins, the token
 *     table, timing, fee caps), never the board's /config;
 *   - the chains, read fresh through pha.ts and base.ts;
 *   - the kit's own records in the store (the token, amount and price it
 *     agreed to, the h it verified, the fee it was shown).
 * The board's trade is only compared with the record (tradeMismatch, check
 * 14) and read for its status; its word never decides an amount, a token or
 * an address.
 *
 * Checks 9, 16 and 35 (flows/maker.ts) and 67 (createKit) live in B6d's
 * files; 26 (the terms dialog) is the operator's own config.
 *
 * Instant mode (section J, build spec section 3.10): on an instant sell
 * offer the buyer locks the USDC first. instantSellerLock runs the seller's
 * checks of section 3.10.3 step 2 before the kit locks its tokens behind the
 * buyer's hash, and instantClaim the checks of step 4 before its USDC
 * claim, which goes out only once the Phantasma lock reads claimed (the
 * buyer's code is public there). Their codes belong to the numbered check
 * they extend (INSTANT_START 18, INSTANT_BUYER_LOCK 24, INSTANT_LATE and
 * INSTANT_SHORT 25, HASH_TAKEN 30, INSTANT_CLAIM and PHA_NOT_CLAIMED 59).
 */
import {
  P2P_CONFIG, INSTANT_RULES, BOARD, tokenOf, phaPinned, escrowCfg, baseDeployed, instantTiming, instantBaseSpan, PHA_HASH_VECTORS, PHA_LOCK_KCAL, SOUL_RESERVE,
  CLOCK_SKEW_MAX, MAX_FEE_BPS, type P2PNetConfig, type InstantTiming
} from './pins.js';
import {
  tradeMismatch as tradeMismatchRule, offerPriceProblem, lockStartProblem, posInt, evmLower, sameEvm, isPhaAddress, tradeFee, swapReadsProblem, phaLockProblem, buyerT2,
  buyerLockBy, storedT2Problem, lockWindowClosed, lockWindowText, baseLockProblem, baseLockTimeProblem, selfClaimProblem, offerProblem, takeProblem,
  openCapProblem, tokenOffText, usdcFor, symName, amountText, minutesText, TERMINAL, type AgreedTrade, type PhaLock, type BaseSwap, type OfferPricing
} from './rules.js';
import { secretOpens, isHex32, makeSecretRecord } from './codec.js';
import { SafetyError, SAFETY } from './errors.js';
import { errorText, type LogFn } from './redact.js';
import { balanceOf, type PhaReader, type PhaLockRead, type PhaBalances } from './pha.js';
import { typedBaseAddress, type BaseReader, type SwapParams, type BaseFunds } from './base.js';
import { takeIssuer, FOLLOWED_KINDS, type Checked, type SignKind, type Recheck, type FollowedKind } from './signer.js';
import type { KitStore } from './store.js';
import type { Network, Trade, Offer, LocalTrade, LocalOffer, SecretRecord, TradeStatus, Intent, OfferMode } from './types.js';

/** The only way an intent comes to be: the signer hands its issuer to this module once, at load. */
const issue = takeIssuer();

// ── Problems and their codes ────────────────────────────────────────────────

/** A check's number in build spec section 6.4 ('59a' is the secret-binding check of the self-claim). */
export type CheckId = number | '59a';

/** Why the kit will not sign. */
export interface Problem {
  /** The check of section 6.4 that refused. */
  readonly check: CheckId;
  /** Stable and machine-readable (CHECK_CODES). */
  readonly code: string;
  /** A plain sentence for the operator's log (never a key, a token or a secret). */
  readonly text: string;
  /** True when the same step may pass on a later try (a read that failed, a node behind, too early); false: stop. */
  readonly retry: boolean;
  /** LOCKED_ALREADY / USDC_LOCKED_ALREADY: the lock that already exists (report it, never lock again). */
  readonly h?: string;
  readonly txHash?: string;
}

/**
 * Every refusal code and the check it belongs to. Codes are unique to their
 * check; a check that reuses another one (the code pin inside the seller's
 * lock checks, for example) refuses with that one's code.
 */
export const CHECK_CODES = Object.freeze({
  TOKEN_NOT_TRADED: 1,
  NOT_PINNED: 2,
  CODE_PIN: 3,
  HASH_VECTORS: 4,
  ESCROW_NOT_SERVED: 5,
  BASE_NOT_DEPLOYED: 6,
  OFFER_INVALID: 7,
  BASE_ADDRESS: 8,
  TAKE_INVALID: 10,
  OPEN_CAP: 11,
  BUYER_NOT_READY: 12,
  TRADE_ID_REUSED: 13,
  TRADE_MISMATCH: 14,
  TAKE_NOT_FIT: 15,
  ACCEPT_REFUSED: 17,
  LOCK_START: 18,
  INSTANT_START: 18,
  ESCROW_CHANGED: 19,
  ESCROW_NOT_DEPLOYED: 20,
  OPEN_CAP_UNREAD: 21,
  FEE_UNSET: 22,
  ESCROW_PARAMS: 23,
  SELLER_BASE: 24,
  INSTANT_BUYER_LOCK: 24,
  CLOCK_SKEW: 25,
  INSTANT_LATE: 25,
  INSTANT_SHORT: 25,
  LOCK_BUSY: 27,
  PHA_KEY: 28,
  SOUL_LOW: 28,
  SELLER_FUNDS: 29,
  LOCKED_ALREADY: 30,
  SECRET_UNUSABLE: 30,
  HASH_TAKEN: 30,
  TRADE_CHANGED: 31,
  FEE_SHOWN: 32,
  CLOCK_RECHECK: 33,
  HASH_USED: 34,
  BUYER_LOCK_START: 36,
  ESCROW_MISMATCH: 37,
  HASH_REUSED: 38,
  FEE_NOT_FIXED: 39,
  SELLER_LOCK: 40,
  BASE_KEY: 41,
  USDC_LOCKED_ALREADY: 42,
  USDC_LOCK_EXISTS: 42,
  SWAP_REFUSES: 43,
  LOCK_LENGTH: 44,
  BUYER_FUNDS: 45,
  PERMIT: 46,
  KCAL_LOW: 47,
  LOCK_DETAILS: 48,
  APPROVE: 49,
  USDC_RECHECK: 50,
  NOT_SENDABLE: 51,
  SEND_IN_FLIGHT: 51,
  REVEAL_START: 52,
  SECRET_BINDING: 53,
  FEE_SHOWN_MISSING: 54,
  BUYER_LOCK: 55,
  USDC_GUARD: 56,
  CLAIM_READINESS: 57,
  SECRET_SENT: 58,
  SELF_CLAIM: 59,
  INSTANT_CLAIM: 59,
  PHA_NOT_CLAIMED: 59,
  SECRET_NOT_THIS_TRADE: '59a',
  FIRST_CLAIM: 60,
  CLAIM_RECHECK: 61,
  CONTRACT_ACCOUNT: 61,
  CLAIM_IN_FLIGHT: 61,
  CLAIM_PHA: 62,
  REFUND_BASE: 63,
  REFUND_PHA: 64,
  NOTHING_OWED: 65,
  SIMULATION: 66,
  FEE_CAPS: 66,
  NO_ETH: 66,
  KEY_ROLE: 68
} as const satisfies Record<string, CheckId>);

export type CheckCode = keyof typeof CHECK_CODES;

/**
 * Not a refusal: the step is already done on the chain by someone else (the
 * keeper won the race), and the payee has it. Section 6.6 counts it as success.
 */
export const DONE_ELSEWHERE = 'DONE_ELSEWHERE';

/** A refusal of `code`. */
export function problem(code: CheckCode, text: string, o: { retry?: boolean; h?: string; txHash?: string } = {}): Problem {
  return Object.freeze({ check: CHECK_CODES[code], code, text, retry: o.retry === true, ...(o.h ? { h: o.h } : {}), ...(o.txHash ? { txHash: o.txHash } : {}) });
}

/** The step was already done on chain by someone else (a success for the flows). */
function doneElsewhere(check: CheckId, text: string): Problem {
  return Object.freeze({ check, code: DONE_ELSEWHERE, text, retry: false });
}

/** A check that signs nothing. */
export type Outcome = { ok: true } | { ok: false; problem: Problem };
/** A check before a signature: the intent the signer accepts, or why not. */
export type CheckResult<K extends SignKind> = { ok: true; intent: Checked<K> } | { ok: false; problem: Problem };

const refuse = (p: Problem): { ok: false; problem: Problem } => ({ ok: false, problem: p });
const OK: Outcome = Object.freeze({ ok: true });

// ── What the checks read ─────────────────────────────────────────────────────

/** The board's trade read fresh (with symbol=all); BoardClient.trade fits. Display data: only compared. */
export interface TradeReader {
  trade(id: number): Promise<Trade>;
}

export interface CheckDeps {
  readonly network: Network;
  readonly pha: PhaReader;
  readonly base: BaseReader;
  readonly store: KitStore;
  readonly board: TradeReader;
  /** The kit's own key addresses (keys.ts LoadedKeys.address): the only ones it signs for. */
  readonly address: { readonly pha: string; readonly base: string };
  /** Local clock, ms (default Date.now). */
  readonly now?: () => number;
  /** Receives redacted lines only. */
  readonly log?: LogFn;
}

/** The pins of the deps' network (never anything the board said). */
function cfgOf(d: CheckDeps): P2PNetConfig {
  const c = P2P_CONFIG[d.network];
  if (!c) throw new SafetyError(SAFETY.NETWORK_OFF, 'The network is devnet or mainnet.');
  return c;
}

const nowMs = (d: CheckDeps) => (d.now ?? Date.now)();
const localSec = (d: CheckDeps) => Math.floor(nowMs(d) / 1000);
const big = (v: string) => BigInt(v);

/**
 * "Now" for a time check: never earlier than the newest Base block, so a
 * clock that runs late cannot make a deadline look further away. Throws when
 * Base cannot be read (the caller refuses).
 */
async function trustedNow(d: CheckDeps): Promise<number> {
  const cfg = cfgOf(d);
  const local = localSec(d);
  if (!baseDeployed(cfg)) return local;
  return Math.max(local, (await d.base.head()).time);
}

/** The intent's common fields, issued now. */
function issued<K extends SignKind>(d: CheckDeps, kind: K, tradeId: number, signer: string, facts: Checked<K>['facts'], recheck: Recheck): Checked<K> {
  return issue<K>({ kind, network: d.network, tradeId, signer, issuedAt: nowMs(d), facts, recheck });
}

// ── A. Configuration and pins ────────────────────────────────────────────────

/** Check 1: a token of the kit's own table, the symbol matching exactly (decimals and bounds only from there). */
export function checkToken(symbol: unknown): Problem | null {
  const t = tokenOf(symbol);
  return t && t.enabled ? null : problem('TOKEN_NOT_TRADED', 'This names no token this kit trades (TAZ, SOUL, KCAL or RA, written exactly so).');
}

/** The plain words for a network whose escrow is not pinned in this release. */
export const NOT_PINNED_TEXT = 'P2P trading is not open on this network in this kit release: the Phantasma escrow is not pinned.';
export const PIN_MISMATCH_TEXT = 'The P2P contract on Phantasma is not the code this kit checks for. Nothing was locked or shared. Wait for a kit update.';
export const ADMIN_MISMATCH_TEXT = 'The P2P contract on Phantasma has another admin than the one this kit checks for. Nothing was locked or shared. Wait for a kit update.';

/** Check 2: the network has both escrow pins (code SHA-256 and admin). */
export function pinned(network: Network): Problem | null {
  return phaPinned(P2P_CONFIG[network] ?? null) ? null : problem('NOT_PINNED', NOT_PINNED_TEXT);
}

/**
 * Check 3, read fresh (never cached): the SHA-256 of the escrow's script as
 * the node serves it equals the pin, and getAdmin() equals the pinned admin.
 * Run before every lock, reveal, claim and refund. A failed read, an empty
 * script or an empty pin all refuse. Also answers whether the node lists the
 * escrow's getState (check 20).
 */
async function codePinRead(d: CheckDeps, cfg: P2PNetConfig): Promise<{ problem: Problem | null; deployed: boolean }> {
  if (!phaPinned(cfg)) return { problem: problem('NOT_PINNED', NOT_PINNED_TEXT), deployed: false };
  let code: Awaited<ReturnType<PhaReader['code']>>, admin: string;
  try {
    [code, admin] = await Promise.all([d.pha.code(cfg), d.pha.admin(cfg)]);
  } catch {
    return { problem: problem('CODE_PIN', 'Could not check the P2P contract\'s code on Phantasma. Nothing was locked or shared.', { retry: true }), deployed: false };
  }
  if (code.name !== cfg.phaContract || !code.sha256 || code.sha256 !== cfg.phaCodeSha256.toLowerCase()) return { problem: problem('CODE_PIN', PIN_MISMATCH_TEXT), deployed: false };
  if (!admin) return { problem: problem('CODE_PIN', 'Could not check the P2P contract\'s admin on Phantasma. Nothing was locked or shared.', { retry: true }), deployed: false };
  if (admin !== cfg.phaAdmin) return { problem: problem('CODE_PIN', ADMIN_MISMATCH_TEXT), deployed: false };
  return { problem: null, deployed: code.methods.includes('getState') };
}

/** Check 3 on its own. */
export async function codePin(d: CheckDeps, cfg: P2PNetConfig = cfgOf(d)): Promise<Problem | null> {
  return (await codePinRead(d, cfg)).problem;
}

/**
 * Check 4: hashSecret on the live node returns exactly PHA_HASH_VECTORS
 * (Phantasma's SHA-256 agrees with Base's). Before a USDC lock, a reveal and
 * a first self-claim; a mismatch or a failed read refuses.
 */
export async function hashVectors(d: CheckDeps, cfg: P2PNetConfig = cfgOf(d)): Promise<Problem | null> {
  let out: Array<string | null>;
  try {
    out = await d.pha.hashSecrets(cfg, PHA_HASH_VECTORS.map((v) => v.secret));
  } catch {
    return problem('HASH_VECTORS', 'Could not check the P2P contract\'s SHA-256 on Phantasma. Nothing was locked or shared.', { retry: true });
  }
  for (let i = 0; i < PHA_HASH_VECTORS.length; i++) {
    if (out[i] == null) return problem('HASH_VECTORS', 'Could not check the P2P contract\'s SHA-256 on Phantasma. Nothing was locked or shared.', { retry: true });
    if (out[i] !== PHA_HASH_VECTORS[i]!.digest) return problem('HASH_VECTORS', 'The P2P contract on Phantasma computes SHA-256 differently from Base right now, so a claim on Phantasma could fail. Nothing was locked or shared.');
  }
  return null;
}

/**
 * Check 5: the escrow a lock is read under is the one named in the record
 * (the network's current one for a record without a name); a contract this
 * release does not serve is refused.
 */
export function escrowFor(network: Network, name?: string | null): { ok: true; cfg: P2PNetConfig } | { ok: false; problem: Problem } {
  const c = escrowCfg(P2P_CONFIG[network], name ?? null);
  return c ? { ok: true, cfg: c } : refuse(problem('ESCROW_NOT_SERVED', `This trade's lock is on the Phantasma contract ${String(name)}, which this kit release does not serve. Nothing was sent.`));
}

/** Check 6: SaturnSwap and USDC are pinned for the network. */
export function baseDeployedProblem(network: Network): Problem | null {
  return baseDeployed(P2P_CONFIG[network] ?? null) ? null : problem('BASE_NOT_DEPLOYED', 'The Base contract is not pinned for this network in this kit release.');
}

// ── B. Offers and takes ──────────────────────────────────────────────────────

/** Check 7: a new offer against the token's row of the kit's table and the network's USDC bounds. */
export function offerCheck(network: Network, o: { symbol: string; tazTotal: string | bigint; tazMin: string | bigint; tazMax: string | bigint; price: string | bigint | null | undefined }): Problem | null {
  const bad = offerProblem({ symbol: o.symbol, tazTotal: posInt(o.tazTotal), tazMin: posInt(o.tazMin), tazMax: posInt(o.tazMax), price: posInt(o.price ?? '') }, P2P_CONFIG[network].base);
  return bad ? problem('OFFER_INVALID', bad) : null;
}

/** Check 8: a valid Base address (a mixed-case one with a valid checksum), not the swap contract nor USDC. */
export function baseAddressOk(network: Network, address: unknown): Problem | null {
  const cfg = P2P_CONFIG[network];
  const a = typedBaseAddress(address);
  if (!a) return problem('BASE_ADDRESS', 'Enter a valid Base address.');
  if (sameEvm(a, cfg.base.swap) || sameEvm(a, cfg.base.usdc)) return problem('BASE_ADDRESS', 'That Base address is the swap contract or the token, not a wallet.');
  return null;
}

/** Check 10: a take of `taz` raw units inside the offer's bounds, the table's per-lock bounds and the network's USDC bounds. */
export function takeCheck(network: Network, taz: string | bigint, offer: Pick<Offer, 'symbol' | 'tazMin' | 'tazMax' | 'remaining' | 'price'>): Problem | null {
  const min = posInt(offer.tazMin), max = posInt(offer.tazMax), rem = posInt(offer.remaining), price = posInt(offer.price);
  if (min == null || max == null || rem == null || price == null) return problem('TAKE_INVALID', 'This offer names no valid amounts or price.');
  const bad = takeProblem(posInt(taz), { symbol: offer.symbol, tazMin: min, tazMax: max, remaining: rem, price }, P2P_CONFIG[network].base);
  return bad ? problem('TAKE_INVALID', bad) : null;
}

/** Check 11: open-cap room for `amount` before a take or an accept. A cap that was not read (null) does not block here. */
export function openCapCheck(cap: { openAmount: bigint; maxOpen: bigint } | null | undefined, amount: bigint, symbol: string): Problem | null {
  const bad = openCapProblem(cap, amount, symbol);
  return bad ? problem('OPEN_CAP', bad, { retry: true }) : null;
}

/** Check 11 with its read (a failed read does not block a take or an accept). */
export async function openCapRoom(d: CheckDeps, symbol: string, amount: bigint): Promise<Problem | null> {
  return openCapCheck(await d.pha.readOpenCapOrNull(cfgOf(d), symbol), amount, symbol);
}

/** Board statuses at which a buyer's USDC is committed to a trade not yet locked on Base (build spec section 2.3.5). */
const COMMITTED: readonly string[] = Object.freeze(['accepted', 'pha_locked']);

/**
 * The USDC the kit's own open trades still need from `bBase` (check 12, the
 * kit's sum): every record where the kit is the buyer at that address, with
 * no USDC lock sent yet, whose last seen status is accepted or pha_locked, or
 * requested on a take the kit made (a take on its own buy offer is counted
 * once accepted). A record whose status was never seen counts when it is a
 * take of the last day.
 */
export async function waitingUsdc(store: KitStore, bBase: string, excludeTradeId?: number | null, nowMsNow: number = Date.now()): Promise<bigint> {
  const b = String(bBase).toLowerCase();
  let sum = 0n;
  for (const r of await store.listTrades()) {
    if (r.role !== 'B' || r.myBase !== b || r.id === excludeTradeId || r.txs.baseLock) continue;
    const st: TradeStatus | undefined = r.status;
    const counts = st === undefined ? !r.maker && nowMsNow - r.createdAt < 86_400_000 : COMMITTED.includes(st) || (st === 'requested' && !r.maker);
    if (counts) sum += big(r.usdc);
  }
  return sum;
}

const usdcAmount = (cfg: P2PNetConfig, raw: bigint) => `${amountText(raw, 6)} ${cfg.base.usdcSymbol}`;

/**
 * Check 12, the buyer's readiness before it takes a sell offer, accepts a
 * take on its own buy offer, or places an order of several takes: each
 * lock's USDC inside the network's bounds; SaturnSwap's reads (not paused,
 * USDC allowed, amount bounds, lock bounds); USDC at least this trade (or
 * `legs`), `extraUsdc` and every open trade of the kit still waiting for its
 * USDC lock from this address; ETH for each lock's network fee. A failed
 * read refuses.
 */
export async function buyerReady(d: CheckDeps, o: { bBase: string; usdc: bigint; legs?: readonly bigint[]; extraUsdc?: bigint; excludeTradeId?: number | null }): Promise<Problem | null> {
  const cfg = cfgOf(d);
  const nd = baseDeployedProblem(d.network);
  if (nd) return nd;
  const bBase = evmLower(o.bBase);
  if (!bBase) return problem('BUYER_NOT_READY', 'The buyer has no valid Base address.');
  const legs = o.legs?.length ? o.legs : [o.usdc];
  if (legs.some((u) => u < cfg.base.usdcMin || u > cfg.base.usdcMax)) return problem('BUYER_NOT_READY', 'This USDC amount is outside what one trade may cost on this network.');
  let bp: SwapParams, funds: BaseFunds, gas: bigint;
  try {
    [bp, funds, gas] = await Promise.all([d.base.readSwapParams(), d.base.readFunds(bBase), d.base.gasCostEstimate(cfg.base.lockWithPermitGas)]);
  } catch {
    return problem('BUYER_NOT_READY', 'Could not read Base, so nothing was started.', { retry: true });
  }
  for (const u of legs) {
    const reads = swapReadsProblem(bp, u, cfg.timing);
    if (reads) return problem('BUYER_NOT_READY', reads, { retry: bp.paused });
  }
  const extra = o.extraUsdc != null && o.extraUsdc > 0n ? o.extraUsdc : 0n;
  const need = legs.reduce((a, u) => a + u, 0n) + extra;
  const open = await waitingUsdc(d.store, bBase, o.excludeTradeId, nowMs(d));
  if (funds.usdc < need + open) {
    return problem('BUYER_NOT_READY', open > 0n
      ? `The Base address ${bBase} holds ${usdcAmount(cfg, funds.usdc)}; this kit's open trades need ${usdcAmount(cfg, open)} more and this one ${usdcAmount(cfg, need)}.`
      : `The Base address ${bBase} holds less than ${usdcAmount(cfg, need)}.`, { retry: true });
  }
  const allGas = gas * BigInt(legs.length);
  if (funds.eth < allGas) return problem('BUYER_NOT_READY', `The Base address ${bBase} holds too little ETH for the network fee (up to about ${allGas} wei for the lock).`, { retry: true });
  return null;
}

/**
 * Check 13: keep a trade record, refusing a trade id the store already keeps
 * for another trade (the record is saved and read back). The same trade again
 * answers the kept record.
 */
export async function keepTrade(store: KitStore, rec: LocalTrade): Promise<{ ok: true; record: LocalTrade } | { ok: false; problem: Problem }> {
  try {
    return { ok: true, record: await store.addTrade(rec) };
  } catch (e) {
    if (e instanceof SafetyError && e.code === SAFETY.RECORD_CONFLICT) return refuse(problem('TRADE_ID_REUSED', `The board answered with trade #${rec.id}, which this kit already keeps for another trade. Nothing is signed for it.`));
    throw e;
  }
}

/**
 * Check 14, before every action: the board's trade is the one the kit made
 * or took (rules.ts tradeMismatch, the site's rule). The token first, then
 * the amounts, `usdcFor(taz, price) == usdc` with the price the kit saw and
 * sent at take (the record's, never the board's), the board's price equal to
 * it, for a maker record with its offer a price the offer allows now
 * (section 4.10: a fixed price the kit set, or within a following offer's
 * limit), the kit's own addresses, the other side's addresses once known,
 * the side, and h and the escrow once recorded.
 */
export function tradeMismatch(t: Trade, rec: AgreedTrade, offer?: (Pick<LocalOffer, 'id' | 'side' | 'price' | 'priceHistory' | 'follow'>) | null): Problem | null {
  const mm = tradeMismatchRule(t, rec, offer && rec.maker ? offerPricing(offer) : null);
  return mm ? problem('TRADE_MISMATCH', mm) : null;
}

/** A kept offer as the section 4.10 rules read it. */
function offerPricing(o: Pick<LocalOffer, 'id' | 'side' | 'price' | 'priceHistory' | 'follow'>): OfferPricing & { id: number } {
  return { id: o.id, side: o.side, price: o.price, priceHistory: o.priceHistory, follow: o.follow };
}

/**
 * Check 15: a take on one of the kit's offers fits the offer exactly: its id
 * and side, the offer's own token, an amount within the offer's per-trade
 * bounds, a price the offer allows (section 4.10), `usdcFor(taz, price) ==
 * usdc`, the maker's own addresses, and valid taker addresses. Answers the
 * maker record to keep (check 13 keeps it), never stored here.
 */
export function adoptTake(t: Trade, offer: LocalOffer, nowMsNow: number = Date.now()): { ok: true; record: LocalTrade } | { ok: false; problem: Problem } {
  const no = (why: string) => refuse(problem('TAKE_NOT_FIT', `${why} Nothing is accepted or signed for this take.`));
  if (t.offerId !== offer.id || t.side !== offer.side) return no('This trade is not on this offer, or not on its side.');
  const tok = tokenOf(offer.symbol);
  if (!tok || t.symbol !== tok.symbol) return no('This trade is for another token than the offer.');
  const taz = posInt(t.taz), usdc = posInt(t.usdc), price = posInt(t.price), min = posInt(offer.tazMin), max = posInt(offer.tazMax);
  if (taz == null || usdc == null || price == null || min == null || max == null) return no('This trade names no valid amounts.');
  const bad = offerPriceProblem(price, offerPricing(offer));
  if (bad) return no(bad);
  if (taz < min || taz > max) return no('The amount of this trade is outside the offer\'s bounds.');
  if (usdcFor(taz, price, tok.symbol) !== usdc) return no('The USDC amount of this trade does not match its price.');
  const role = offer.side === 'sell' ? 'S' : 'B';
  const mine = role === 'S' ? t.seller : t.buyer;
  const theirs = role === 'S' ? t.buyer : t.seller;
  if (mine?.pha !== offer.makerPha || !sameEvm(mine?.base, offer.makerBase)) return no('The maker addresses of this trade are not the offer\'s.');
  const counterBase = evmLower(theirs?.base);
  if (!isPhaAddress(theirs?.pha) || !counterBase) return no('This trade names no valid taker addresses.');
  const record: LocalTrade = {
    id: t.id, network: offer.network, offerId: offer.id, role, maker: true, symbol: tok.symbol, taz: taz.toString(), usdc: usdc.toString(), price: price.toString(),
    myPha: offer.makerPha, myBase: offer.makerBase.toLowerCase(), counterPha: theirs.pha, counterBase,
    txs: {}, ...(isStatus(t.status) ? { status: t.status } : {}), createdAt: nowMsNow, updatedAt: nowMsNow
  };
  return { ok: true, record };
}

const STATUSES: ReadonlySet<string> = new Set(['requested', 'accepted', 'pha_locked', 'base_locked', 'revealed', 'base_claimed', 'payout_pending', 'done', 'refunding', 'refunded', 'cancelled', 'expired']);
const isStatus = (s: unknown): s is TradeStatus => typeof s === 'string' && STATUSES.has(s);

// ── C. Accepting (signs nothing) ─────────────────────────────────────────────

/**
 * What a seller of the trade's token must hold to lock `amount` (SPEC
 * "Tokens"): a KCAL seller also the lock's gas allowance and one claim's
 * worth (so it can still refund itself); a SOUL seller SOUL_RESERVE (1.1
 * SOUL) free on top; any other token, the amount.
 */
export function sellerNeeds(cfg: P2PNetConfig, symbol: string, amount: bigint): bigint {
  const t = tokenOf(symbol);
  if (t?.gas) return amount + PHA_LOCK_KCAL + cfg.phaClaimKcal;
  if (t?.stake) return amount + SOUL_RESERVE;
  return amount;
}

/**
 * Why a Phantasma address cannot lock `amount` of the trade's token (liquid
 * balance only; its decimals must be the table's), or null.
 */
export function sellerFundsProblem(cfg: P2PNetConfig, bal: PhaBalances | null, symbol: string, amount: bigint, who: string): string | null {
  const t = tokenOf(symbol);
  if (!t) return 'This trade names no token this kit trades.';
  const have = balanceOf(bal, t.symbol);
  const need = sellerNeeds(cfg, t.symbol, amount);
  const tok = (raw: bigint) => `${amountText(raw, t.decimals)} ${t.symbol}`;
  if (have == null) return `${who} shows no ${t.symbol} (or its balance could not be read).`;
  if (have >= need) return null;
  if (t.gas) return `${who} holds less than ${tok(need)}: the lock needs ${tok(amount)} plus ${tok(PHA_LOCK_KCAL)} for the lock's gas and ${tok(cfg.phaClaimKcal)} kept for a refund later.`;
  if (t.stake) return `${who} holds less than ${tok(need)} unstaked: the lock needs ${tok(amount)} plus ${tok(SOUL_RESERVE)} kept free for Phantasma's fees. Staked SOUL cannot be locked.`;
  return `${who} holds less than ${tok(amount)}.`;
}

/**
 * Check 17, the chain checks of accepting a take (accepting signs nothing):
 * the trade fits the record and the offer (check 14), it still waits for an
 * answer, the network is pinned, the token's open cap has room (a failed
 * read does not block), and then:
 *   - a sell offer (the kit is S): SaturnSwap allows the buyer's lock, and
 *     the buyer's Base address holds the USDC and ETH for the lock's fee;
 *   - a buy offer (the kit is B): the kit's own readiness (check 12), and the
 *     seller's Phantasma address holds the token with its KCAL or SOUL reserve.
 * A passing check says nothing about who the taker is: the balance may
 * belong to someone else. On an instant offer (the kit is S, the buyer locks
 * first) the take must be an instant trade, and SaturnSwap's lock bounds
 * must fit the buyer's instant lock (T_B - now = I_SLACK + I_WIN + I_PHA +
 * I_SAFETY); a standard offer's take is never an instant trade.
 */
export async function acceptChecks(d: CheckDeps, trade: Trade, rec: LocalTrade, o: { offer?: LocalOffer | null } = {}): Promise<Outcome> {
  const cfg = cfgOf(d);
  if (!rec.maker) return refuse(problem('ACCEPT_REFUSED', 'Only the maker accepts a take.'));
  const mm = tradeMismatch(trade, rec, o.offer ?? null);
  if (mm) return refuse(mm);
  // An instant offer's take is accepted as an instant trade only (the buyer locks first), and only where this
  // release runs instant trades; a standard offer's take never as an instant one.
  const instant = o.offer?.mode === 'instant';
  const mmMode = modeMismatch(trade, instant ? 'instant' : 'standard');
  if (mmMode) return refuse(mmMode);
  const itm = instant ? instantTiming(d.network) : null;
  if (instant && (!itm || rec.role !== 'S')) return refuse(problem('ACCEPT_REFUSED', `This kit release runs instant trades only as the seller, on ${instantNetworksText()}; this take is not accepted.`));
  if (trade.status !== 'requested') return refuse(problem('ACCEPT_REFUSED', 'This take was already answered.'));
  const np = pinned(d.network);
  if (np) return refuse(np);
  const amount = big(rec.taz), usdc = big(rec.usdc);
  const full = await openCapRoom(d, rec.symbol, amount);
  if (full) return refuse(full);
  if (rec.role === 'B') {
    const ready = await buyerReady(d, { bBase: rec.myBase, usdc, excludeTradeId: trade.id });
    if (ready) return refuse(ready);
    const sPha = rec.counterPha || trade.seller.pha;
    const bal = await d.pha.balances(sPha).catch(() => null);
    const why = sellerFundsProblem(cfg, bal, rec.symbol, amount, `The seller's Phantasma address ${sPha}`);
    return why ? refuse(problem('ACCEPT_REFUSED', why, { retry: true })) : OK;
  }
  const nd = baseDeployedProblem(d.network);
  if (nd) return refuse(nd);
  const bBase = rec.counterBase || trade.buyer.base;
  let bp: SwapParams, funds: BaseFunds, gas: bigint;
  try {
    [bp, funds, gas] = await Promise.all([d.base.readSwapParams(), d.base.readFunds(bBase), d.base.gasCostEstimate(cfg.base.lockWithPermitGas)]);
  } catch {
    return refuse(problem('ACCEPT_REFUSED', 'Could not read the buyer\'s USDC and SaturnSwap on Base.', { retry: true }));
  }
  const reads = itm ? instantSwapReadsProblem(bp, usdc, itm) : swapReadsProblem(bp, usdc, cfg.timing);
  if (reads) return refuse(problem('ACCEPT_REFUSED', reads, { retry: true }));
  if (funds.usdc < usdc) return refuse(problem('ACCEPT_REFUSED', `The buyer's Base address ${bBase} holds less than ${usdcAmount(cfg, usdc)}.`, { retry: true }));
  if (funds.eth < gas) return refuse(problem('ACCEPT_REFUSED', `The buyer's Base address ${bBase} has too little ETH for the network fee, so it could not lock the USDC.`, { retry: true }));
  return OK;
}

// ── D. The seller's Phantasma lock ───────────────────────────────────────────

/**
 * Check 25: this machine's clock against the newest Base block. Refused when
 * Base cannot be read or the two differ by more than CLOCK_SKEW_MAX; "now" is
 * the later of the two (T1 = now + phaLock counts from it).
 */
export async function chainClock(d: CheckDeps, code: 'CLOCK_SKEW' | 'CLOCK_RECHECK' = 'CLOCK_SKEW'): Promise<{ ok: true; now: number } | { ok: false; problem: Problem }> {
  let head: { time: number };
  try { head = await d.base.head(); } catch { return refuse(problem(code, 'Could not read the newest block on Base, so nothing was locked.', { retry: true })); }
  const local = localSec(d);
  if (!Number.isSafeInteger(head?.time) || head.time <= 0 || Math.abs(local - head.time) > CLOCK_SKEW_MAX) {
    return refuse(problem(code, `This machine's clock is off by more than ${minutesText(CLOCK_SKEW_MAX)} from Base's newest block (or Base has stalled). Fix the clock. Nothing was locked.`));
  }
  return { ok: true, now: Math.max(local, head.time) };
}

/** The seller's lock with this h is this trade's: made by the seller, paying the buyer, exactly the record's token and amount. */
export function isOurLock(l: PhaLock | null | undefined, rec: Pick<LocalTrade, 'symbol' | 'taz' | 'myPha'>, bPha: string): boolean {
  return !!l && l.state >= 1 && !!tokenOf(rec.symbol) && l.sender === rec.myPha && l.recipient === bPha && l.symbol === rec.symbol && l.amount === big(rec.taz);
}

/**
 * The Base side before the seller locks (check 24), at the newest block:
 * SaturnSwap's reads, feeBps() at most the trade's fee, and the buyer's USDC.
 */
async function sellerBaseProblem(d: CheckDeps, usdc: bigint, fee: number, bBase: string): Promise<Problem | null> {
  const cfg = cfgOf(d);
  let bp: SwapParams, funds: BaseFunds;
  try {
    [bp, funds] = await Promise.all([d.base.readSwapParams(), d.base.readFunds(bBase)]);
  } catch {
    return problem('SELLER_BASE', 'Could not read SaturnSwap and the buyer\'s USDC on Base. Nothing was locked.', { retry: true });
  }
  const reads = swapReadsProblem(bp, usdc, cfg.timing);
  if (reads) return problem('SELLER_BASE', reads, { retry: true });
  if (!Number.isInteger(bp.feeBps) || bp.feeBps > fee) return problem('SELLER_BASE', 'The fee on Base is higher than this trade\'s fee, so the buyer\'s lock would be refused. Nothing was locked.');
  if (funds.usdc < usdc) return problem('SELLER_BASE', `The buyer's Base address holds less than ${usdcAmount(cfg, usdc)}, so it could not lock the USDC. Nothing was locked.`, { retry: true });
  return null;
}

/** Check 21 (fresh; a failed read refuses here) with check 11's rule. */
async function sellerCapProblem(d: CheckDeps, cfg: P2PNetConfig, symbol: string, amount: bigint): Promise<Problem | null> {
  let cap;
  try { cap = await d.pha.readOpenCap(cfg, symbol); } catch {
    return problem('OPEN_CAP_UNREAD', `Could not read the P2P escrow's limit for open ${symName(symbol)} locks on Phantasma. Nothing was locked.`, { retry: true });
  }
  return openCapCheck(cap, amount, symbol);
}

/** A lock whose outcome is not known yet is not sent again before this long has passed since it was sent (section 6.5, "never a blind resend"). */
export const LOCK_RESEND_AFTER_MS = 5 * 60_000;

/**
 * Check 27 with the journal: a lock of this trade that was sent (or was
 * about to be) less than 5 minutes ago and whose outcome is not known yet is
 * not sent again; run() resolves it from the chain first. After that a new
 * send under the same h is safe: the escrow and SaturnSwap both refuse a
 * second lock under one h.
 */
async function lockInFlight(d: CheckDeps, tradeId: number, kind: 'phaLock' | 'baseLock'): Promise<Problem | null> {
  const j = await d.store.getJournal(tradeId);
  const now = nowMs(d);
  const open = j.intents.find((i) => i.kind === kind && i.outcome === undefined && now - (i.sentAt ?? i.at) < LOCK_RESEND_AFTER_MS);
  if (!open) return null;
  const ago = Math.max(0, Math.round((now - (open.sentAt ?? open.at)) / 1000));
  return problem('LOCK_BUSY', `A ${kind === 'phaLock' ? 'Phantasma' : 'USDC'} lock of this trade went out ${ago} s ago and its outcome is not known yet; nothing is sent again until it is resolved from the chain.`, { retry: true, ...(open.txHash ? { txHash: open.txHash } : {}) });
}

/**
 * Checks 51 and 61 with the journal: while a Base send of `kind` of this
 * trade (a claim, a refund, a withdrawal) is not settled, no new one is
 * issued: it would take the next nonce and wait behind the one not mined
 * (CLAIM_IN_FLIGHT, SEND_IN_FLIGHT). Unlike a lock there is no time limit:
 * the engine follows the open one at its own nonce instead (replaced with
 * higher fees, or taken back), passing it as `follow`. Answers the open
 * intent being followed (null for a fresh send), or why not.
 */
async function sendInFlight(d: CheckDeps, tradeId: number, kind: FollowedKind, follow: Intent | null | undefined): Promise<{ ok: true; follow: Intent | null } | { ok: false; problem: Problem }> {
  const j = await d.store.getJournal(tradeId);
  const open = j.intents.find((i) => i.kind === kind && i.outcome === undefined);
  const code = kind === 'claimBase' ? 'CLAIM_IN_FLIGHT' : 'SEND_IN_FLIGHT';
  const what = kind === 'claimBase' ? 'USDC claim' : kind === 'refundBase' ? 'USDC refund' : 'payout withdrawal';
  if (!follow) {
    if (!open) return { ok: true, follow: null };
    return refuse(problem(code, `This trade's ${what} went out${open.nonce !== undefined ? ` at nonce ${open.nonce}` : ''} and is not settled yet; it is followed at its nonce (replaced with higher fees, or taken back), never sent again behind it.`, { retry: true, ...(open.txHash ? { txHash: open.txHash } : {}) }));
  }
  if (!open || open.id !== follow.id || open.nonce === undefined || open.nonce !== follow.nonce) return refuse(problem(code, `The ${what} to replace is no longer open; it is settled from the chain first.`, { retry: true }));
  return { ok: true, follow: open };
}

/** The journal intent a step replaces, as the signer's facts carry it. */
const followFacts = (i: Intent | null): { follow?: { journalId: string; nonce: number } } => (i && i.nonce !== undefined ? { follow: { journalId: i.id, nonce: i.nonce } } : {});

/** The buyer's Phantasma address as the kit recorded it (the board's when the record never knew it). */
const buyerPhaOf = (rec: LocalTrade, trade: Trade | null) => (rec.role === 'B' ? rec.myPha : rec.counterPha || trade?.buyer.pha || '');

/** The secret binding of a trade (codec.SecretBinding). */
function bindingOf(d: CheckDeps, rec: LocalTrade, bPha: string) {
  return { tradeId: rec.id, network: d.network, symbol: rec.symbol, taz: rec.taz, sPha: rec.myPha, bPha };
}

/** A kept secret that is exactly this trade's (check 53 / 59a): its binding, and it opens its own h. */
function secretIsThisTrades(sec: SecretRecord, rec: LocalTrade, network: Network, bPha?: string | null): boolean {
  return sec.tradeId === rec.id && sec.network === network && sec.symbol === rec.symbol && sec.taz === rec.taz && sec.sPha === rec.myPha
    && (!bPha || sec.bPha === bPha) && secretOpens(sec.secret, sec.h);
}

/**
 * The seller's checks before its Phantasma lock (checks 18-25, 28-30, 32),
 * in the site's order: role and the board's trade against the record, the
 * lock's start, Base pinned, the record's escrow, the code pin (fresh), the
 * escrow deployed, the open cap (fresh, a failed read refuses), the trade's
 * fee, the escrow's own bounds for the token, the Base side, the clock; then
 * the signing key and its SOUL, the funds with the KCAL or SOUL reserve, the
 * secret (reused or made, saved, fsynced and read back; an h someone else
 * used is replaced, our own lock only reported), and feeShown and the escrow
 * name stored and read back. The intent carries the R re-checks (31, 33).
 */
export async function sellerLock(d: CheckDeps, trade: Trade, recIn: LocalTrade): Promise<CheckResult<'phaLock'>> {
  const cfg = cfgOf(d);
  const rec = (await d.store.getTrade(recIn.id)) ?? recIn;
  if (rec.role !== 'S') return refuse(problem('LOCK_START', 'Only the seller locks the tokens.'));
  const mm = tradeMismatch(trade, rec);
  if (mm) return refuse(mm);
  const tok = tokenOf(rec.symbol)!;
  const sym = tok.symbol;
  const late = lockStartProblem(trade, localSec(d));
  if (late) return refuse(problem('LOCK_START', late, { retry: !/has ended|another step|Too late|already locked/.test(late) }));
  const nd = baseDeployedProblem(d.network);
  if (nd) return refuse(nd);
  if (rec.phaContract && rec.phaContract !== cfg.phaContract) return refuse(problem('ESCROW_CHANGED', `This trade's record names the Phantasma contract ${rec.phaContract}, not ${cfg.phaContract}. Nothing was locked.`));
  const pin = await codePinRead(d, cfg);
  if (pin.problem) return refuse(pin.problem);
  if (!pin.deployed) return refuse(problem('ESCROW_NOT_DEPLOYED', 'The P2P contract is not deployed on Phantasma on this network.'));
  const taz = big(rec.taz), usdc = big(rec.usdc);
  const cap = await sellerCapProblem(d, cfg, sym, taz);
  if (cap) return refuse(cap);
  const fee = tradeFee(trade);
  if (fee == null) return refuse(problem('FEE_UNSET', 'The board has not fixed this trade\'s fee yet (or it is above 2%), so nothing was locked.', { retry: trade.feeBps == null }));
  const bBase = (rec.counterBase || trade.buyer.base).toLowerCase();
  const bPha = buyerPhaOf(rec, trade);

  // The escrow's own bounds for the token must be the kit's table (SPEC "Tokens"): a token never enabled reads 0.
  let pp;
  try { pp = await d.pha.readParams(cfg, sym); } catch { return refuse(problem('ESCROW_PARAMS', 'Could not read the P2P settings on Phantasma.', { retry: true })); }
  if (pp.paused) return refuse(problem('ESCROW_PARAMS', 'New P2P locks are paused on Phantasma right now.', { retry: true }));
  if (pp.maxAmount === 0n) return refuse(problem('ESCROW_PARAMS', tokenOffText(sym)));
  if (pp.minAmount !== tok.min || pp.maxAmount !== tok.max) return refuse(problem('ESCROW_PARAMS', `The P2P escrow's limits for ${sym} on Phantasma are not the ones this kit checks for. Nothing was locked. Wait for a kit update.`));
  if (taz < pp.minAmount || taz > pp.maxAmount) return refuse(problem('ESCROW_PARAMS', `This ${sym} amount is outside what one lock accepts.`));
  if (cfg.timing.phaLock < pp.minLock || cfg.timing.phaLock > pp.maxLock) return refuse(problem('ESCROW_PARAMS', 'The Phantasma contract does not accept this lock length right now.'));
  const baseProblem = await sellerBaseProblem(d, usdc, fee, bBase);
  if (baseProblem) return refuse(baseProblem);
  const clock = await chainClock(d);
  if (!clock.ok) return clock;

  // The key that signs, and its funds.
  if (d.address.pha !== rec.myPha) return refuse(problem('PHA_KEY', `This kit's Phantasma key is ${d.address.pha}, not ${rec.myPha}, the seller in this trade. Nothing was locked.`));
  let bal: PhaBalances;
  try { bal = await d.pha.balances(rec.myPha); } catch { return refuse(problem('SELLER_FUNDS', 'Could not read this kit\'s Phantasma balances. Nothing was locked.', { retry: true })); }
  const soul = balanceOf(bal, 'SOUL');
  if (soul == null || soul < SOUL_RESERVE) return refuse(problem('SOUL_LOW', `This kit's Phantasma address keeps less than ${amountText(SOUL_RESERVE, 8)} SOUL free for Phantasma's fees (the lock's own, and 1 SOUL for a refund later). Nothing was locked.`, { retry: true }));
  const funds = sellerFundsProblem(cfg, bal, sym, taz, 'This kit\'s Phantasma address');
  if (funds) return refuse(problem('SELLER_FUNDS', `${funds} Nothing was locked.`, { retry: true }));

  // The secret: the newest one kept for this trade and binding, else a new one, saved and read back before anything is signed.
  const binding = bindingOf(d, rec, bPha);
  const kept = (await d.store.secretsOfTrade(rec.id)).filter((s) => s.role === 'S' && secretIsThisTrades(s, rec, d.network, bPha));
  let sec: SecretRecord | null = kept.length ? kept[kept.length - 1]! : null;
  const fresh = async (): Promise<SecretRecord | Problem> => {
    try { return await d.store.putSecret(makeSecretRecord({ ...binding, role: 'S' }, nowMs(d))); } catch (e) {
      return problem('SECRET_UNUSABLE', `The secret could not be saved (${errorText(e)}), so nothing was locked.`);
    }
  };
  if (!sec) {
    const made = await fresh();
    if ('code' in made) return refuse(made);
    sec = made;
  }
  let lock: PhaLockRead;
  try { lock = await d.pha.readLock(cfg, sec.h); } catch { return refuse(problem('SECRET_UNUSABLE', 'Could not read Phantasma. Nothing was locked.', { retry: true })); }
  if (lock.state !== 0) {
    // Our own lock with this h: only reported (check 35), never locked again.
    if (isOurLock(lock, rec, bPha)) return refuse(problem('LOCKED_ALREADY', `This trade's ${sym} is already locked under this kit's secret; report the lock instead.`, { h: sec.h }));
    // Someone else used this h first. It never held our tokens: a new secret (the old one is kept).
    const made = await fresh();
    if ('code' in made) return refuse(made);
    sec = made;
    try { lock = await d.pha.readLock(cfg, sec.h); } catch { return refuse(problem('SECRET_UNUSABLE', 'Could not read Phantasma. Nothing was locked.', { retry: true })); }
    if (lock.state !== 0) return refuse(problem('SECRET_UNUSABLE', 'Could not make an unused secret. Nothing was locked.', { retry: true }));
  }
  const busy = await lockInFlight(d, rec.id, 'phaLock');
  if (busy) return refuse(busy);

  // feeShown and the escrow's name, stored before the lock is signed and read back (check 32).
  try {
    const back = await d.store.patchTrade(rec.id, { feeShown: fee, phaContract: cfg.phaContract });
    if (back.feeShown !== fee || back.phaContract !== cfg.phaContract) throw new Error('read back differently');
  } catch (e) {
    return refuse(problem('FEE_SHOWN', `The fee shown and the escrow could not be stored with the trade (${errorText(e)}), so nothing was locked.`));
  }

  const h = sec.h;
  const facts = {
    tradeId: rec.id, escrow: cfg.phaContract, h, symbol: sym, amount: taz, sender: rec.myPha, recipient: bPha, fee, usdc, bBase
  };
  const recheck: Recheck = async () => {
    // Check 31: a fresh trade read, the code pin, the cap, the Base side.
    const now = localSec(d);
    let t: Trade;
    try { t = await d.board.trade(rec.id); } catch { return refuse(problem('TRADE_CHANGED', 'Could not reload the trade. Nothing was locked.', { retry: true })); }
    const r2 = (await d.store.getTrade(rec.id)) ?? rec;
    const late2 = lockStartProblem(t, now);
    if (late2) return refuse(problem('TRADE_CHANGED', late2, { retry: !/has ended|another step|Too late|already locked/.test(late2) }));
    const mm2 = tradeMismatch(t, r2);
    if (mm2) return refuse(mm2);
    if (tradeFee(t) !== fee) return refuse(problem('TRADE_CHANGED', 'The trade\'s fee changed after it was checked. Nothing was locked.'));
    if (r2.feeShown !== fee || r2.phaContract !== cfg.phaContract) return refuse(problem('FEE_SHOWN', 'The fee shown is no longer stored with the trade. Nothing was locked.'));
    const s2 = await d.store.getSecret(h).catch(() => null);
    if (!s2 || !secretIsThisTrades(s2, r2, d.network, bPha)) return refuse(problem('SECRET_UNUSABLE', 'The secret for this lock is no longer kept. Nothing was locked.'));
    // Checks 30 and 27 again: still nothing locked under h, and no lock of this trade in flight. Two intents of one
    // trade (or a lock that landed after the checks) never send a second lock under one h.
    let l2: PhaLockRead;
    try { l2 = await d.pha.readLock(cfg, h); } catch { return refuse(problem('SECRET_UNUSABLE', 'Could not read Phantasma. Nothing was locked.', { retry: true })); }
    if (l2.state !== 0) {
      if (isOurLock(l2, r2, bPha)) return refuse(problem('LOCKED_ALREADY', `This trade's ${sym} is already locked under this kit's secret; report the lock instead.`, { h }));
      return refuse(problem('SECRET_UNUSABLE', 'Someone else locked under this secret\'s hash first. Nothing was locked; the next check makes a new secret.', { retry: true }));
    }
    const busy2 = await lockInFlight(d, rec.id, 'phaLock');
    if (busy2) return refuse(busy2);
    const pin2 = await codePin(d, cfg);
    if (pin2) return refuse(pin2);
    const cap2 = await sellerCapProblem(d, cfg, sym, taz);
    if (cap2) return refuse(cap2);
    const b2 = await sellerBaseProblem(d, usdc, fee, bBase);
    if (b2) return refuse(b2);
    // Check 33: the clock read again for the deadline.
    const c2 = await chainClock(d, 'CLOCK_RECHECK');
    if (!c2.ok) return c2;
    return { ok: true, deadline: c2.now + cfg.timing.phaLock };
  };
  return { ok: true, intent: issued(d, 'phaLock', rec.id, rec.myPha, facts, recheck) };
}

// ── E. The buyer's Base lock ─────────────────────────────────────────────────

/**
 * Check 40, the buyer's check of the seller's Phantasma lock (the site's
 * verify.js checkSellerLock): the code pin first; the lock read from the
 * chain; "now" never before the newest Base block; phaLockProblem (state 1,
 * exactly the record's token, the amount, the recipient and the sender, a
 * valid deadline and start, the signing window open, enough time for T2, not
 * longer than the site's locks); then the SHA-256 vectors; then
 * T2 = min(T1 - SAFETY, now + REVEAL_MIN + BASE_LOCK_LEAD + REVEAL_ALLOWANCE).
 */
export async function sellerLockOnChain(d: CheckDeps, cfg: P2PNetConfig, want: { h: string; symbol: string; taz: string; bPha: string; sPha?: string }):
  Promise<{ ok: true; t1: number; t2: number; now: number; created: number; lockBy: number } | { ok: false; problem: Problem }> {
  const tok = tokenOf(want.symbol);
  if (!tok) return refuse(problem('TOKEN_NOT_TRADED', 'This trade names no token this kit trades. Nothing was locked.'));
  if (!isHex32(want.h)) return refuse(problem('SELLER_LOCK', `The seller has not locked the ${tok.symbol} yet.`, { retry: true }));
  const taz = posInt(want.taz);
  if (taz == null) return refuse(problem('SELLER_LOCK', `This trade has no valid ${tok.symbol} amount.`));
  const pin = await codePin(d, cfg);
  if (pin) return refuse(pin);
  let lock: PhaLockRead;
  try { lock = await d.pha.readLock(cfg, want.h); } catch { return refuse(problem('SELLER_LOCK', `Could not read the ${tok.symbol} lock on Phantasma.`, { retry: true })); }
  let now: number;
  try { now = await trustedNow(d); } catch { return refuse(problem('SELLER_LOCK', 'Could not read Base. Nothing was locked.', { retry: true })); }
  const bad = phaLockProblem(lock, { symbol: tok.symbol, taz, bPha: want.bPha, sPha: want.sPha }, now, cfg.timing);
  // A node behind the board may not show the lock yet.
  if (bad) return refuse(problem('SELLER_LOCK', bad, { retry: lock.state === 0 }));
  const vec = await hashVectors(d, cfg);
  if (vec) return refuse(vec);
  return { ok: true, t1: lock.deadline, t2: buyerT2(lock.deadline, now, cfg.timing), now, created: lock.created, lockBy: buyerLockBy(lock, cfg.timing)! };
}

/**
 * Check 42: a swap (h, the kit's Base address) already exists. Only this
 * kit's key can make one, so it is reported when it is this trade's lock as
 * recorded (its transaction kept, the amount and the seller), and refused
 * otherwise; never locked again either way.
 */
function existingSwapProblem(s: BaseSwap, rec: LocalTrade, usdc: bigint, claimer: string, h: string): Problem {
  if (s.state === 1 && rec.txs.baseLock && s.amount === usdc && sameEvm(s.claimer, claimer)) {
    return problem('USDC_LOCKED_ALREADY', 'This kit already locked the USDC for this trade; report the lock instead.', { h, txHash: rec.txs.baseLock });
  }
  return problem('USDC_LOCK_EXISTS', 'A USDC lock for this trade and address already exists that this kit did not record. Nothing was locked.');
}

/** The text for a Base fee above the trade's fee (FeeTooHigh). */
const FEE_TOO_HIGH_TEXT = 'The fee on Base is now higher than this trade\'s fee, so the USDC lock would be refused (FeeTooHigh). This trade cannot complete; nothing was locked, and the seller\'s tokens return at T1.';

/**
 * Check 46, the permit path: the USDC token's DOMAIN_SEPARATOR equals the
 * permit domain pinned for the network (the nonce, the fee caps, the ETH and
 * the 30-minute permit are read and built by the signer right before it signs).
 */
export async function permitProblem(d: CheckDeps): Promise<Problem | null> {
  try {
    return (await d.base.permitDomainOk()) ? null : problem('PERMIT', 'The USDC token on Base does not match the permit details pinned in this kit, so it does not lock with a permit. Use usePermit: false (approve exactly the amount, then lock).');
  } catch {
    return problem('PERMIT', 'Could not read the USDC token\'s permit domain on Base.', { retry: true });
  }
}

/**
 * The buyer's checks before its USDC lock (checks 36-48, the site's
 * buyerLockChecks): role and the board's trade against the record, Base
 * pinned, the seller's lock reported, both escrows and h against the record,
 * no other local trade on this h, the trade's fee, the signing key, the
 * seller's lock on chain (40), an existing lock of the kit only reported, the
 * SaturnSwap reads with the fee no higher than the trade's, T2 within the
 * contract's lock bounds, USDC and ETH, the permit domain (when it uses one),
 * the KCAL for one Phantasma claim; then h, the escrow, T1 and T2 stored
 * before anything is signed (48). The intent carries usdcRecheck (50).
 */
export async function buyerLock(d: CheckDeps, trade: Trade, recIn: LocalTrade, o: { usePermit?: boolean; lockWithLowKcal?: boolean } = {}): Promise<CheckResult<'baseLock'>> {
  const cfg = cfgOf(d);
  const rec = (await d.store.getTrade(recIn.id)) ?? recIn;
  if (rec.role !== 'B') return refuse(problem('BUYER_LOCK_START', 'Only the buyer locks USDC.'));
  const mm = tradeMismatch(trade, rec);
  if (mm) return refuse(mm);
  const nd = baseDeployedProblem(d.network);
  if (nd) return refuse(nd);
  const sym = symName(rec.symbol);
  if (trade.status !== 'pha_locked' || !trade.h) return refuse(problem('BUYER_LOCK_START', `The seller has not locked the ${sym} for this trade yet.`, { retry: !TERMINAL.includes(trade.status) }));
  if (rec.phaContract && rec.phaContract !== cfg.phaContract) return refuse(problem('ESCROW_MISMATCH', `This trade's lock is on the Phantasma contract ${rec.phaContract}, which takes no new trades. Nothing was locked.`));
  if (trade.phaContract && trade.phaContract !== cfg.phaContract) return refuse(problem('ESCROW_MISMATCH', `The board ties this trade to the Phantasma contract ${trade.phaContract}, not ${cfg.phaContract}. Nothing was locked.`));
  const h = trade.h.toLowerCase();
  if (rec.h && rec.h !== h) return refuse(problem('ESCROW_MISMATCH', 'The lock hash of this trade is not the one this kit recorded. Nothing was locked.'));
  if (await d.store.hashUsedElsewhere(h, rec.id)) return refuse(problem('HASH_REUSED', 'This lock hash already belongs to another trade of this kit. Nothing was locked.'));
  const fee = tradeFee(trade);
  if (fee == null) return refuse(problem('FEE_NOT_FIXED', 'The board has not fixed this trade\'s fee yet, so the USDC cannot be locked safely.', { retry: trade.feeBps == null }));
  if (d.address.base.toLowerCase() !== rec.myBase) return refuse(problem('BASE_KEY', `This kit's Base key is ${d.address.base}, not ${rec.myBase}, the buyer in this trade. Nothing was locked.`));
  const sPha = rec.counterPha || trade.seller.pha;
  const claimer = (rec.counterBase || trade.seller.base).toLowerCase();
  const usdc = big(rec.usdc);

  const v = await sellerLockOnChain(d, cfg, { h, symbol: rec.symbol, taz: rec.taz, bPha: rec.myPha, sPha });
  if (!v.ok) return v;

  let bp: SwapParams, funds: BaseFunds, existing: { swap: BaseSwap; blockTime: number }, gas: bigint;
  try {
    [bp, funds, existing, gas] = await Promise.all([
      d.base.readSwapParams(), d.base.readFunds(rec.myBase), d.base.readSwap(h, rec.myBase), d.base.gasCostEstimate(cfg.base.lockWithPermitGas)
    ]);
  } catch {
    return refuse(problem('SWAP_REFUSES', 'Could not read Base. Nothing was locked.', { retry: true }));
  }
  if (existing.swap.state !== 0) return refuse(existingSwapProblem(existing.swap, rec, usdc, claimer, h));
  const busy = await lockInFlight(d, rec.id, 'baseLock');
  if (busy) return refuse(busy);
  if (bp.paused) return refuse(problem('SWAP_REFUSES', 'New USDC locks are paused on Base right now.', { retry: true }));
  if (!bp.allowed || usdc < bp.minAmount || usdc > bp.maxAmount) return refuse(problem('SWAP_REFUSES', 'The Base contract would not accept this USDC amount.'));
  if (!Number.isInteger(bp.feeBps) || bp.feeBps > fee) return refuse(problem('SWAP_REFUSES', FEE_TOO_HIGH_TEXT));
  const t2 = v.t2;
  const left = t2 - Math.max(localSec(d), bp.blockTime);
  if (left < bp.minLock || left > bp.maxLock) return refuse(problem('LOCK_LENGTH', 'The Base contract would not accept this lock\'s time limit.'));
  if (funds.usdc < usdc) return refuse(problem('BUYER_FUNDS', `Not enough ${cfg.base.usdcSymbol} at ${rec.myBase}: the lock needs ${usdcAmount(cfg, usdc)}.`, { retry: true }));
  if (funds.eth < gas) return refuse(problem('BUYER_FUNDS', `Not enough ETH on ${cfg.base.name} at ${rec.myBase} for the network fee (up to about ${gas} wei).`, { retry: true }));
  const usePermit = o.usePermit !== false;
  if (usePermit) {
    const pp = await permitProblem(d);
    if (pp) return refuse(pp);
  }
  // KCAL for one Phantasma claim of its own, in case the keeper's side fails (a KCAL buyer too: what it buys arrives only with the claim).
  if (!o.lockWithLowKcal) {
    const bal = await d.pha.balances(rec.myPha).catch(() => null);
    const kcal = balanceOf(bal, 'KCAL');
    if (kcal == null || kcal < cfg.phaClaimKcal) {
      return refuse(problem('KCAL_LOW', `This kit's Phantasma address holds ${kcal == null ? 'no KCAL (or it could not be read)' : `${amountText(kcal, 10)} KCAL`}, less than one claim on Phantasma needs (${amountText(cfg.phaClaimKcal, 10)} KCAL). It would depend on the keeper to claim the ${sym}. Get KCAL, or set lockWithLowKcal.`, { retry: true }));
    }
  }

  // h, the escrow, T1 and T2 stored before anything is signed (check 48): the claim and the refund never need the board.
  try {
    const back = await d.store.patchTrade(rec.id, { h, phaContract: cfg.phaContract, t1: v.t1, t2 });
    if (back.h !== h || back.phaContract !== cfg.phaContract || back.t1 !== v.t1 || back.t2 !== t2) throw new Error('read back differently');
  } catch (e) {
    return refuse(problem('LOCK_DETAILS', `The lock details could not be stored with the trade (${errorText(e)}), so nothing was locked.`));
  }

  const facts = { tradeId: rec.id, escrow: cfg.phaContract, h, amount: usdc, claimer, owner: rec.myBase, t1: v.t1, t2, fee, usePermit, created: v.created, sPha };
  const recheck: Recheck = async () => {
    // Check 50 (usdcRecheck): the seller's lock again, T1 unchanged, the stored T2 (never a new one), a fresh trade, the Base fee; then the window and T2 against the newest block.
    const r2 = (await d.store.getTrade(rec.id)) ?? rec;
    const v2 = await sellerLockOnChain(d, cfg, { h, symbol: r2.symbol, taz: r2.taz, bPha: r2.myPha, sPha });
    if (!v2.ok) return v2;
    if (v2.t1 !== v.t1) return refuse(problem('USDC_RECHECK', 'The seller\'s lock changed. Nothing was locked.'));
    if (r2.t2 !== t2) return refuse(problem('USDC_RECHECK', 'The stored time limit of this lock changed. Nothing was locked.'));
    const t2Bad = storedT2Problem(r2.t2, v2.t1, v2.now, cfg.timing);
    if (t2Bad) return refuse(problem('USDC_RECHECK', t2Bad));
    let fresh: Trade;
    try { fresh = await d.board.trade(rec.id); } catch { return refuse(problem('USDC_RECHECK', 'Could not reload the trade. Nothing was locked.', { retry: true })); }
    const mm2 = tradeMismatch(fresh, r2);
    if (mm2) return refuse(mm2);
    if (fresh.status !== 'pha_locked' || (fresh.h ?? '').toLowerCase() !== h) return refuse(problem('USDC_RECHECK', 'The trade changed on the board. Nothing was locked.', { retry: true }));
    if (tradeFee(fresh) !== fee) return refuse(problem('USDC_RECHECK', 'The trade\'s fee changed after it was checked. Nothing was locked.'));
    // Checks 42 and 27 again: no USDC lock of this trade landed or went out since the checks (a second intent of one
    // trade never sends a second lock; a lock still waiting in the mempool is not seen by the simulation).
    const busy2 = await lockInFlight(d, rec.id, 'baseLock');
    if (busy2) return refuse(busy2);
    let ex2: { swap: BaseSwap };
    try { ex2 = await d.base.readSwap(h, r2.myBase); } catch { return refuse(problem('USDC_RECHECK', 'Could not read Base. Nothing was locked.', { retry: true })); }
    if (ex2.swap.state !== 0) return refuse(existingSwapProblem(ex2.swap, r2, usdc, claimer, h));
    let bp2: SwapParams;
    try { bp2 = await d.base.readSwapParams(); } catch { return refuse(problem('USDC_RECHECK', 'Could not read Base. Nothing was locked.', { retry: true })); }
    if (!Number.isInteger(bp2.feeBps) || bp2.feeBps > fee) return refuse(problem('USDC_RECHECK', FEE_TOO_HIGH_TEXT));
    let head: { time: number };
    try { head = await d.base.head(); } catch { return refuse(problem('USDC_RECHECK', 'Could not read Base. Nothing was locked.', { retry: true })); }
    const t = Math.max(localSec(d), head.time);
    if (lockWindowClosed({ created: v2.created }, t, cfg.timing)) return refuse(problem('USDC_RECHECK', lockWindowText(cfg.timing)));
    const bad = storedT2Problem(t2, v2.t1, t, cfg.timing);
    if (bad) return refuse(problem('USDC_RECHECK', bad));
    return { ok: true };
  };
  return { ok: true, intent: issued(d, 'baseLock', rec.id, rec.myBase, facts, recheck) };
}

// ── F. Reveal, and the checks of the buyer's lock ───────────────────────────

/**
 * Check 55, the seller's check of the buyer's USDC lock (the site's
 * verify.js checkBuyerLock): the seller's own Phantasma lock still open and
 * exactly this trade's; the Base swap at the newest and at the confirmed
 * block (state, token, amount, claimer, sender; the two reads agree;
 * deadline <= T1 - SAFETY and at least `minLeft` left; fee <= feeShown);
 * then the Locked event mined within BASE_LOCK_WINDOW of the Phantasma
 * lock's getCreated, at or below the confirmed block.
 */
export async function buyerLockOnChain(d: CheckDeps, cfg: P2PNetConfig, want: { h: string; symbol: string; taz: string; usdc: string; sPha: string; bPha: string; sBase: string; bBase: string; maxFeeBps: number; baseLockTx?: string | null }, minLeft?: number):
  Promise<{ ok: true; swap: BaseSwap; lock: PhaLockRead; t1: number; now: number } | { ok: false; problem: Problem }> {
  const no = (text: string, retry = false) => refuse(problem('BUYER_LOCK', text, { retry }));
  if (!baseDeployed(cfg)) return refuse(problem('BASE_NOT_DEPLOYED', 'The Base contract is not pinned for this network in this kit release.'));
  const tok = tokenOf(want.symbol);
  if (!tok) return refuse(problem('TOKEN_NOT_TRADED', 'This trade names no token this kit trades. Not sharing the secret.'));
  const sym = tok.symbol;
  if (!isHex32(want.h)) return no('This trade has no lock hash yet.');
  const taz = posInt(want.taz), usdc = posInt(want.usdc);
  if (taz == null || usdc == null) return no('This trade has no valid amounts.');
  const sBase = evmLower(want.sBase), bBase = evmLower(want.bBase);
  if (!sBase || !bBase) return no('This trade has no valid Base addresses.');
  let lock: PhaLockRead;
  try { lock = await d.pha.readLock(cfg, want.h); } catch { return no(`Could not read your ${sym} lock on Phantasma.`, true); }
  if (lock.state === 0) return no(`Your ${sym} lock is not on Phantasma.`);
  if (lock.state === 2) return no(`Your ${sym} lock was already claimed.`);
  if (lock.state === 3) return no(`Your ${sym} lock was refunded to you.`);
  if (lock.state !== 1 || lock.sender !== want.sPha || lock.recipient !== want.bPha || lock.symbol !== sym || lock.amount !== taz) return no(`The lock with this hash on Phantasma is not your ${sym} lock for this trade.`);
  let r;
  try { r = await d.base.readSwapConfirmed(want.h, bBase); } catch { return no('Could not read the USDC lock on Base.', true); }
  const now = Math.max(localSec(d), r.blockTime);
  const bad = baseLockProblem(r.latest, r.confirmed, { usdcToken: cfg.base.usdc, usdc, sBase, bBase, t1: lock.deadline, maxFeeBps: want.maxFeeBps }, now, cfg.timing, minLeft);
  if (bad) return no(bad, /not locked on Base yet|waiting for confirmations|changed while it was being checked/.test(bad));
  // SPEC section 6, "The Base lock window": only a lock mined in time counts.
  if (!Number.isSafeInteger(lock.created) || lock.created <= 0) return no(baseLockTimeProblem(null, lock.created, cfg.timing)!);
  let at;
  try { at = await d.base.readLockedAt(want.h, bBase, { txHash: want.baseLockTx, fromTime: lock.created }); } catch { return no(baseLockTimeProblem(null, lock.created, cfg.timing)!, true); }
  if (at && at.blockNumber > at.confirmedBlock) return no('The USDC lock is waiting for confirmations on Base.', true);
  const late = baseLockTimeProblem(at, lock.created, cfg.timing);
  if (late) return no(late, at == null);
  return { ok: true, swap: r.latest, lock, t1: lock.deadline, now };
}

/** feeShown: the fee stored before the Phantasma lock, never above the contract's maximum; null when the kit has none (never read fresh). */
function feeShownOf(rec: LocalTrade): number | null {
  const f = tradeFee({ feeBps: rec.feeShown ?? null });
  return f == null ? null : Math.min(f, MAX_FEE_BPS);
}

/**
 * Checks 55 and 56 before the secret leaves the kit (the reveal, or a first
 * self-claim): the buyer's lock with at least REVEAL_MIN left and a fee no
 * higher than feeShown, mined in the window; for a token with a blacklist,
 * neither S_b nor SaturnSwap blacklisted and USDC not paused (a bot never
 * "asks": a pause refuses). A failed read refuses.
 */
async function sendChecks(d: CheckDeps, cfg: P2PNetConfig, sec: SecretRecord, rec: LocalTrade, bBase: string, baseLockTx: string | null | undefined): Promise<{ ok: true; swap: BaseSwap; lock: PhaLockRead } | { ok: false; problem: Problem }> {
  const fee = feeShownOf(rec);
  if (fee == null) return refuse(problem('FEE_SHOWN_MISSING', 'This kit has no record of the fee it was shown before locking, so it does not share the secret. Both sides get their coins back after the time limits.'));
  const v = await buyerLockOnChain(d, cfg, { h: sec.h, symbol: rec.symbol, taz: sec.taz, usdc: rec.usdc, sPha: rec.myPha, bPha: sec.bPha, sBase: rec.myBase, bBase, maxFeeBps: fee, baseLockTx });
  if (!v.ok) return v;
  if (cfg.base.usdcHasBlacklist) {
    const g = await usdcGuardProblem(d, rec.myBase, rec.symbol);
    if (g) return refuse(g);
  }
  return { ok: true, swap: v.swap, lock: v.lock };
}

/**
 * Check 56: USDC has not blacklisted `account` (S_b) nor SaturnSwap, and is
 * not paused (a bot never "asks": a pause refuses). FiatToken refuses a
 * blacklisted sender as well as a blacklisted recipient, so a blacklisted
 * SaturnSwap defers every payout. Read only where the network's token has
 * these switches (USDC on Base; devnet's MockUSDC has none). A failed read refuses.
 */
export async function usdcGuardProblem(d: CheckDeps, account: string, symbol?: string): Promise<Problem | null> {
  let g;
  try { g = await d.base.readUsdcGuard(account); } catch { return problem('USDC_GUARD', 'Could not read the USDC blacklist on Base, so the secret stays with the kit.', { retry: true }); }
  const sym = symName(symbol);
  if (g.blacklisted) return problem('USDC_GUARD', `USDC has blacklisted this kit's Base address. A claim would leave the USDC frozen in the contract while the buyer takes the ${sym}, so the secret stays with the kit and both sides get their coins back after the time limits.`);
  if (g.swapBlacklisted) return problem('USDC_GUARD', 'USDC has blacklisted the swap contract that pays the seller, so the secret stays with the kit and both sides get their coins back after the time limits.');
  if (g.paused) return problem('USDC_GUARD', 'USDC is paused right now, so the secret stays with the kit until it is not.', { retry: true });
  return null;
}

/** Check 57: the Phantasma claim readiness, fresh (the code pin and the SHA-256 vectors). */
async function claimReadiness(d: CheckDeps, cfg: P2PNetConfig): Promise<Problem | null> {
  const p = (await codePin(d, cfg)) ?? (await hashVectors(d, cfg));
  return p ? problem('CLAIM_READINESS', `The buyer could not claim on Phantasma right now: ${p.text}`, { retry: p.retry }) : null;
}

/** The kit's kept secret for `h` that is exactly this trade's (check 53), or null. */
async function sellerSecret(d: CheckDeps, rec: LocalTrade, h: string, bPha: string | null): Promise<SecretRecord | null> {
  if (!isHex32(h)) return null;
  const sec = await d.store.getSecret(h.toLowerCase()).catch(() => null);
  return sec && sec.h === h.toLowerCase() && secretIsThisTrades(sec, rec, d.network, bPha) ? sec : null;
}

/**
 * The checks before the secret is shared with the board's keeper (checks
 * 52-57, only with claimMode 'reveal-then-self'): role S, the board's trade
 * against the record, status pha_locked or base_locked, the record's h; the
 * kept secret opens h and is bound to this trade; feeShown stored (never read
 * fresh here); the buyer's lock (55); USDC's blacklist and pause (56); the
 * claim readiness, fresh (57). The signer stores secretSentAt before the
 * POST (58).
 */
export async function reveal(d: CheckDeps, trade: Trade, recIn: LocalTrade): Promise<CheckResult<'reveal'>> {
  const rec = (await d.store.getTrade(recIn.id)) ?? recIn;
  if (rec.role !== 'S') return refuse(problem('REVEAL_START', 'Only the seller shares the secret.'));
  const mm = tradeMismatch(trade, rec);
  if (mm) return refuse(mm);
  if (trade.status !== 'pha_locked' && trade.status !== 'base_locked') return refuse(problem('REVEAL_START', 'This trade is not at the step where the secret is shared.', { retry: trade.status === 'accepted' }));
  if (!trade.h) return refuse(problem('REVEAL_START', 'This trade has no lock hash yet.', { retry: true }));
  const h = trade.h.toLowerCase();
  if (rec.h && h !== rec.h) return refuse(problem('REVEAL_START', 'The lock hash of this trade is not the one this kit recorded.'));
  const bPha = buyerPhaOf(rec, trade);
  const sec = await sellerSecret(d, rec, h, bPha);
  if (!sec) return refuse(problem('SECRET_BINDING', 'This kit holds no secret that opens this trade\'s lock hash and was made for this trade.'));
  // Check 5: the lock is read under the escrow the record names (the kit stored it before its lock), never the board's.
  const ec = escrowFor(d.network, rec.phaContract);
  if (!ec.ok) return ec;
  const bBase = (rec.counterBase || trade.buyer.base).toLowerCase();
  const v = await sendChecks(d, ec.cfg, sec, rec, bBase, trade.baseLockTx);
  if (!v.ok) return v;
  const ready = await claimReadiness(d, ec.cfg);
  if (ready) return refuse(ready);
  const facts = { tradeId: rec.id, h, escrow: ec.cfg.phaContract };
  const recheck: Recheck = async () => {
    const s2 = await sellerSecret(d, (await d.store.getTrade(rec.id)) ?? rec, h, bPha);
    return s2 ? { ok: true } : refuse(problem('SECRET_BINDING', 'The secret for this trade is no longer kept.'));
  };
  return { ok: true, intent: issued(d, 'reveal', rec.id, '', facts, recheck) };
}

// ── G. The kit's own USDC claim ──────────────────────────────────────────────

/**
 * The seller's own USDC claim (checks 59, 59a, 60; the default claimMode
 * 'self'), from the kit's own data only (its record, its secret, the chains;
 * never the board):
 *   59a  the kept secret opens h, and its tradeId, sPha, taz and symbol equal
 *        the trade record: refused before any read or simulation;
 *   59   selfClaimProblem (the Phantasma lock is this trade's and reads
 *        locked or claimed; while locked the USDC lock ends SAFETY before it;
 *        the USDC lock fits at the newest and the confirmed block; at least
 *        CLAIM_MARGIN left);
 *   60   a first claim, while the secret never left the kit (no reveal, and
 *        no claim of its own sent or simulated yet) and the Phantasma lock is
 *        not claimed, also runs 55-57 fail-closed;
 *   61   one claim per h in flight: while a claim of this trade is not
 *        settled, only its replacement is issued (`o.follow`, the open
 *        journal intent), at its nonce; otherwise CLAIM_IN_FLIGHT.
 * The intent carries the claim's re-check (61: state, deadline, time left).
 */
export async function selfClaim(d: CheckDeps, recIn: LocalTrade, o: { follow?: Intent | null } = {}): Promise<CheckResult<'claimBase'>> {
  const rec = (await d.store.getTrade(recIn.id)) ?? recIn;
  if (rec.role !== 'S') return refuse(problem('SELF_CLAIM', 'Only the seller holds the secret.'));
  const inFlight = await sendInFlight(d, rec.id, 'claimBase', o.follow);
  if (!inFlight.ok) return inFlight;
  const ec = escrowFor(d.network, rec.phaContract);
  if (!ec.ok) return ec;
  const cfg = ec.cfg;
  const nd = baseDeployedProblem(d.network);
  if (nd) return refuse(nd);
  const mine = await d.store.secretsOfTrade(rec.id);
  const h = rec.h ?? (mine.length ? mine[mine.length - 1]!.h : null);
  if (!h) return refuse(problem('SELF_CLAIM', 'This kit holds no lock hash for this trade.'));
  const sec = await d.store.getSecret(h).catch(() => null);
  if (!sec) return refuse(problem('SELF_CLAIM', 'This kit does not hold the secret for this trade.'));
  // 59a: the secret is this trade's, before anything else is read.
  if (!secretOpens(sec.secret, h) || sec.tradeId !== rec.id || sec.sPha !== rec.myPha || sec.taz !== rec.taz || sec.symbol !== rec.symbol || sec.network !== d.network) {
    return refuse(problem('SECRET_NOT_THIS_TRADE', 'The secret kept under this lock hash was made for another trade, token, amount or seller. Nothing is claimed with it.'));
  }
  const bBase = evmLower(rec.counterBase);
  if (!bBase) return refuse(problem('SELF_CLAIM', 'This kit has no Base address of the buyer for this trade.'));
  const tok = tokenOf(rec.symbol)!;
  let lock: PhaLockRead, r;
  try { lock = await d.pha.readLock(cfg, h); } catch { return refuse(problem('SELF_CLAIM', `Could not read the ${tok.symbol} lock on Phantasma.`, { retry: true })); }
  try { r = await d.base.readSwapConfirmed(h, bBase); } catch { return refuse(problem('SELF_CLAIM', 'Could not read the USDC lock on Base.', { retry: true })); }
  const now = Math.max(localSec(d), r.blockTime);
  if (r.latest.state === 2) return refuse(doneElsewhere(59, 'The USDC lock was already claimed.'));
  const bad = selfClaimProblem(lock, r.latest, r.confirmed,
    { symbol: tok.symbol, taz: big(rec.taz), sPha: rec.myPha, bPha: sec.bPha, usdcToken: cfg.base.usdc, usdc: big(rec.usdc), sBase: rec.myBase, bBase }, now, cfg.timing);
  if (bad) return refuse(problem('SELF_CLAIM', bad, { retry: /waiting for confirmations|changed while it was being checked|not locked on Base/.test(bad) }));
  // 60: the first way out of the secret runs the reveal's checks, fail-closed. Once the kit's own claim went out (or
  // only its simulation, which carries the secret too) the secret has left: a later claim runs 59 and 61 only.
  const claimedBefore = !!rec.txs.claimBase || (await d.store.getJournal(rec.id)).intents.some((i) => i.kind === 'claimBase');
  if (lock.state === 1 && !rec.secretSentAt && !rec.revealedAt && !claimedBefore) {
    const c = await sendChecks(d, cfg, sec, rec, bBase, rec.txs.baseLock ?? null);
    const why = !c.ok ? c.problem : await claimReadiness(d, cfg);
    if (why) return refuse(problem('FIRST_CLAIM', `The secret has never left this kit, so the reveal's checks run first: ${why.text}`, { retry: why.retry }));
  }
  const sender = r.latest.sender;
  const deadline = r.latest.deadline;
  const minLeft = cfg.timing.claimMargin;
  const facts = { tradeId: rec.id, escrow: cfg.phaContract, h, sender, deadline, minLeft, ...followFacts(inFlight.follow) };
  const recheck: Recheck = async () => {
    // Check 61 (before the simulation and again before signing): still locked, the same deadline, CLAIM_MARGIN left.
    let s;
    try { s = await d.base.readSwap(h, sender); } catch { return refuse(problem('CLAIM_RECHECK', 'Could not read the USDC lock on Base. Nothing was sent.', { retry: true })); }
    const t = Math.max(localSec(d), s.blockTime);
    if (s.swap.state === 2) return refuse(doneElsewhere(61, 'The USDC lock was already claimed. Nothing was sent.'));
    if (s.swap.state !== 1) return refuse(problem('CLAIM_RECHECK', 'This USDC lock was refunded. Nothing was sent.'));
    if (s.swap.deadline !== deadline || s.swap.deadline - t < minLeft) return refuse(problem('CLAIM_RECHECK', 'Too close to the time limit to claim safely: a claim mined after the deadline fails and makes the secret public. Nothing was sent.'));
    const s2 = await d.store.getSecret(h).catch(() => null);
    if (!s2 || !secretOpens(s2.secret, h) || s2.tradeId !== rec.id) return refuse(problem('SECRET_NOT_THIS_TRADE', 'The secret for this claim is no longer kept. Nothing was sent.'));
    return { ok: true };
  };
  return { ok: true, intent: issued(d, 'claimBase', rec.id, d.address.base.toLowerCase(), facts, recheck) };
}

// ── H. The other side's claim, refunds, withdraw ─────────────────────────────

/** A claim on Phantasma must leave this much before T1 (check 62). */
const PHA_CLAIM_MARGIN = 60;

/**
 * Check 62, the buyer's own claim of the tokens on Phantasma (after the
 * keeper did not claim within claimWatchS): the record's h and escrow; the
 * lock still state 1, paying this kit's Phantasma address, exactly the
 * record's token and amount, with at least 60 s left before T1; the secret
 * public on Base for (h, B_b) at the confirmed block and opening h; the code
 * pin fresh (the signer is a witness of the call); KCAL >= 3 held for its gas.
 */
export async function claimPhaFor(d: CheckDeps, recIn: LocalTrade): Promise<CheckResult<'claimPha'>> {
  const rec = (await d.store.getTrade(recIn.id)) ?? recIn;
  const cfg0 = cfgOf(d);
  if (rec.role !== 'B') return refuse(problem('CLAIM_PHA', 'The kit claims tokens on Phantasma only for its own purchases.'));
  const ec = escrowFor(d.network, rec.phaContract);
  if (!ec.ok) return ec;
  const cfg = ec.cfg;
  if (!rec.h) return refuse(problem('CLAIM_PHA', 'This trade has no lock hash in the kit\'s record.'));
  const h = rec.h;
  const sym = symName(rec.symbol);
  let lock: PhaLockRead;
  try { lock = await d.pha.readLock(cfg, h); } catch { return refuse(problem('CLAIM_PHA', 'Could not read the lock on Phantasma.', { retry: true })); }
  if (lock.state === 2) return refuse(doneElsewhere(62, `The ${sym} was already claimed.`));
  if (lock.state !== 1) return refuse(problem('CLAIM_PHA', lock.state === 3 ? `The ${sym} went back to the seller.` : 'There is no lock with this hash on Phantasma.'));
  if (lock.recipient !== rec.myPha || lock.symbol !== rec.symbol || lock.amount !== big(rec.taz)) return refuse(problem('CLAIM_PHA', `The lock with this hash is not this trade's ${sym} for this kit.`));
  let now: number;
  try { now = await trustedNow(d); } catch { return refuse(problem('CLAIM_PHA', 'Could not read Base.', { retry: true })); }
  if (now >= lock.deadline - PHA_CLAIM_MARGIN) return refuse(problem('CLAIM_PHA', `The ${sym} lock ends too soon to claim safely; it refunds to the seller.`));
  const nd = baseDeployedProblem(d.network);
  if (nd) return refuse(nd);
  let secret: string | null;
  try {
    secret = await d.base.claimedSecret(h, rec.myBase, lock.deadline - cfg0.timing.phaLock - 600);
  } catch {
    return refuse(problem('CLAIM_PHA', 'Could not search Base for the secret.', { retry: true }));
  }
  if (!secret || !secretOpens(secret, h)) return refuse(problem('CLAIM_PHA', 'The secret is not public on Base yet (at the confirmed block).', { retry: true }));
  const pin = await codePin(d, cfg);
  if (pin) return refuse(pin);
  const bal = await d.pha.balances(d.address.pha).catch(() => null);
  const kcal = balanceOf(bal, 'KCAL');
  if (kcal == null || kcal < PHA_LOCK_KCAL) return refuse(problem('CLAIM_PHA', `This kit's Phantasma address holds less than ${amountText(PHA_LOCK_KCAL, 10)} KCAL for the claim's gas.`, { retry: true }));
  const deadline = lock.deadline;
  const facts = { tradeId: rec.id, escrow: cfg.phaContract, h, secret, deadline };
  const recheck: Recheck = async () => {
    let l2: PhaLockRead;
    try { l2 = await d.pha.readLock(cfg, h); } catch { return refuse(problem('CLAIM_PHA', 'Could not read the lock on Phantasma.', { retry: true })); }
    if (l2.state === 2) return refuse(doneElsewhere(62, `The ${sym} was already claimed.`));
    if (l2.state !== 1 || l2.deadline !== deadline) return refuse(problem('CLAIM_PHA', `The ${sym} lock changed.`));
    let n2: number;
    try { n2 = await trustedNow(d); } catch { return refuse(problem('CLAIM_PHA', 'Could not read Base.', { retry: true })); }
    if (n2 >= deadline - PHA_CLAIM_MARGIN) return refuse(problem('CLAIM_PHA', `The ${sym} lock ends too soon to claim safely.`));
    const p2 = await codePin(d, cfg);
    return p2 ? refuse(p2) : { ok: true };
  };
  return { ok: true, intent: issued(d, 'claimPha', rec.id, d.address.pha, facts, recheck) };
}

/**
 * Check 63, the buyer's Base refund: its own swap (h, B_b) still reads
 * locked and its deadline passed at least baseRefundGrace (30 s) ago. A swap
 * already claimed or refunded is done (the payee has it).
 */
export async function refundBase(d: CheckDeps, recIn: LocalTrade, o: { follow?: Intent | null } = {}): Promise<CheckResult<'refundBase'>> {
  const rec = (await d.store.getTrade(recIn.id)) ?? recIn;
  const cfg = cfgOf(d);
  if (rec.role !== 'B') return refuse(problem('REFUND_BASE', 'Only the buyer\'s USDC is refunded on Base by the kit.'));
  const nd = baseDeployedProblem(d.network);
  if (nd) return refuse(nd);
  const inFlight = await sendInFlight(d, rec.id, 'refundBase', o.follow);
  if (!inFlight.ok) return inFlight;
  if (!rec.h) return refuse(problem('REFUND_BASE', 'There is no USDC lock in the kit\'s record to refund.'));
  const h = rec.h, sender = rec.myBase;
  const read = async (): Promise<{ ok: true; deadline: number } | { ok: false; problem: Problem }> => {
    let s;
    try { s = await d.base.readSwap(h, sender); } catch { return refuse(problem('REFUND_BASE', 'Could not read the USDC lock on Base.', { retry: true })); }
    if (s.swap.state === 0) return refuse(problem('REFUND_BASE', 'There is no USDC lock to refund.'));
    if (s.swap.state === 2) return refuse(problem('REFUND_BASE', 'The USDC lock was claimed by the seller; there is nothing to refund.'));
    if (s.swap.state === 3) return refuse(doneElsewhere(63, 'The USDC lock was already refunded.'));
    if (s.swap.state !== 1) return refuse(problem('REFUND_BASE', 'The USDC lock is in a state this kit does not know.'));
    if (s.blockTime < s.swap.deadline + cfg.timing.baseRefundGrace) return refuse(problem('REFUND_BASE', 'The USDC lock has not ended yet.', { retry: true }));
    return { ok: true, deadline: s.swap.deadline };
  };
  const first = await read();
  if (!first.ok) return first;
  const recheck: Recheck = async () => {
    const again = await read();
    return again.ok ? { ok: true } : again;
  };
  return { ok: true, intent: issued(d, 'refundBase', rec.id, d.address.base.toLowerCase(), { tradeId: rec.id, h, sender, deadline: first.deadline, ...followFacts(inFlight.follow) }, recheck) };
}

/**
 * Check 64, the seller's Phantasma refund: its own lock still reads locked
 * and T1 passed at least phaRefundGrace (60 s) ago; never once the buyer's
 * swap reads claimed (the tokens were owed to the buyer; with no buyer
 * address in the record, any Claimed event with this h refuses); a failed
 * read refuses; the code pin fresh (the signer is a witness of the call).
 */
export async function refundPha(d: CheckDeps, recIn: LocalTrade): Promise<CheckResult<'refundPha'>> {
  const rec = (await d.store.getTrade(recIn.id)) ?? recIn;
  const cfg0 = cfgOf(d);
  if (rec.role !== 'S') return refuse(problem('REFUND_PHA', 'Only the seller\'s tokens are refunded on Phantasma by the kit.'));
  const ec = escrowFor(d.network, rec.phaContract);
  if (!ec.ok) return ec;
  const cfg = ec.cfg;
  const h = rec.h ?? (await d.store.secretsOfTrade(rec.id)).filter((s) => s.role === 'S').pop()?.h ?? null;
  if (!h) return refuse(problem('REFUND_PHA', 'There is no lock in the kit\'s record to refund.'));
  const bBase = evmLower(rec.counterBase);
  const sym = symName(rec.symbol);
  const read = async (): Promise<{ ok: true; lock: PhaLockRead } | { ok: false; problem: Problem }> => {
    let lock: PhaLockRead;
    try { lock = await d.pha.readLock(cfg, h); } catch { return refuse(problem('REFUND_PHA', 'Could not read the lock on Phantasma.', { retry: true })); }
    if (lock.state === 0) return refuse(problem('REFUND_PHA', 'There is no lock to refund.'));
    if (lock.state === 3) return refuse(doneElsewhere(64, `The ${sym} was already refunded.`));
    if (lock.state === 2) return refuse(problem('REFUND_PHA', `This ${sym} lock was claimed by the buyer; there is nothing to refund.`));
    if (lock.sender !== rec.myPha) return refuse(problem('REFUND_PHA', 'This lock was not made by this kit\'s Phantasma address.'));
    let now: number;
    try { now = await trustedNow(d); } catch { return refuse(problem('REFUND_PHA', 'Could not read Base.', { retry: true })); }
    if (now < lock.deadline + cfg0.timing.phaRefundGrace) return refuse(problem('REFUND_PHA', `The ${sym} lock has not ended yet.`, { retry: true }));
    if (!baseDeployed(cfg)) return refuse(problem('REFUND_PHA', `The kit cannot check the buyer's USDC lock on this network, so it does not refund the ${sym} (after a USDC claim it belongs to the buyer).`));
    const owed = `The buyer's USDC was claimed, so the buyer was owed this ${sym}. Its claim window has closed. Do not refund it: the trade needs manual handling.`;
    if (bBase) {
      let s;
      try { s = await d.base.readSwap(h, bBase); } catch { return refuse(problem('REFUND_PHA', `Could not read the buyer's USDC lock on Base, so the ${sym} was not refunded.`, { retry: true })); }
      if (s.swap.state === 2) return refuse(problem('REFUND_PHA', owed));
    } else {
      let claimed: boolean;
      try { claimed = await d.base.anyClaimedForH(h, lock.created > 0 ? lock.created : lock.deadline - cfg0.timing.phaLock - cfg0.timing.lockSlack); } catch {
        return refuse(problem('REFUND_PHA', `Could not search Base for a USDC claim with this hash, so the ${sym} was not refunded.`, { retry: true }));
      }
      if (claimed) return refuse(problem('REFUND_PHA', owed));
    }
    const pin = await codePin(d, cfg);
    return pin ? refuse(pin) : { ok: true, lock };
  };
  const first = await read();
  if (!first.ok) return first;
  const recheck: Recheck = async () => {
    const again = await read();
    return again.ok ? { ok: true } : again;
  };
  return { ok: true, intent: issued(d, 'refundPha', rec.id, d.address.pha, { tradeId: rec.id, escrow: cfg.phaContract, h, deadline: first.lock.deadline }, recheck) };
}

/**
 * Check 65: withdrawOwed(USDC, claimer) only for a payout the token deferred
 * to this kit's own address as the seller in this trade: owed(USDC, S_b) > 0
 * and the call would go through (it fails while USDC is paused or the address
 * is blacklisted).
 */
export async function withdrawOwed(d: CheckDeps, recIn: LocalTrade, o: { follow?: Intent | null } = {}): Promise<CheckResult<'withdrawOwed'>> {
  const rec = (await d.store.getTrade(recIn.id)) ?? recIn;
  if (rec.role !== 'S') return refuse(problem('NOTHING_OWED', 'Only a seller is paid a deferred USDC payout.'));
  const nd = baseDeployedProblem(d.network);
  if (nd) return refuse(nd);
  const inFlight = await sendInFlight(d, rec.id, 'withdrawOwed', o.follow);
  if (!inFlight.ok) return inFlight;
  const claimer = rec.myBase;
  const read = async (): Promise<Outcome> => {
    let owed: bigint;
    try { owed = await d.base.readOwed(claimer); } catch { return refuse(problem('NOTHING_OWED', 'Could not read what SaturnSwap owes this address.', { retry: true })); }
    if (owed <= 0n) return refuse(problem('NOTHING_OWED', 'Nothing is owed to this address.'));
    return OK;
  };
  const first = await read();
  if (!first.ok) return first;
  return { ok: true, intent: issued(d, 'withdrawOwed', rec.id, d.address.base.toLowerCase(), { tradeId: rec.id, claimer, ...followFacts(inFlight.follow) }, read) };
}

/**
 * Check 51 for a cancel: one of this trade's Base sends (a claim, a refund,
 * a withdrawal; journal intent `journalId`) went out, is not settled, and
 * its nonce is not used yet (its transaction is not mined; when an earlier
 * one still waits, the cancel takes the step's place behind it all the
 * same). The engine asks for it only when the send may no longer go through.
 * Its re-check reads the journal and the nonce again.
 */
export async function cancelBase(d: CheckDeps, recIn: LocalTrade, journalId: string): Promise<CheckResult<'cancelBase'>> {
  const rec = (await d.store.getTrade(recIn.id)) ?? recIn;
  const nd = baseDeployedProblem(d.network);
  if (nd) return refuse(nd);
  const me = d.address.base.toLowerCase();
  const read = async (): Promise<{ ok: true; intent: Intent & { nonce: number; kind: FollowedKind } } | { ok: false; problem: Problem }> => {
    const i = (await d.store.getJournal(rec.id)).intents.find((x) => x.id === journalId);
    if (!i || i.outcome !== undefined || i.nonce === undefined || !(FOLLOWED_KINDS as readonly string[]).includes(i.kind) || !(i.hashes?.length || i.txHash)) {
      return refuse(problem('SEND_IN_FLIGHT', 'This trade has no open Base send at that nonce to take back. Nothing was sent.'));
    }
    let latest: number;
    try { latest = await d.base.client.nonce(me as `0x${string}`, 'latest'); } catch { return refuse(problem('SEND_IN_FLIGHT', 'Could not read the nonce of this kit\'s Base address. Nothing was sent.', { retry: true })); }
    if (latest > i.nonce) return refuse(problem('SEND_IN_FLIGHT', 'The nonce is already used; the send is settled from the chain. Nothing was sent.', { retry: true }));
    return { ok: true, intent: i as Intent & { nonce: number; kind: FollowedKind } };
  };
  const first = await read();
  if (!first.ok) return first;
  const nonce = first.intent.nonce;
  const recheck: Recheck = async () => {
    const again = await read();
    if (!again.ok) return again;
    return again.intent.nonce === nonce ? { ok: true } : refuse(problem('SEND_IN_FLIGHT', 'The send to take back changed. Nothing was sent.', { retry: true }));
  };
  return { ok: true, intent: issued(d, 'cancelBase', rec.id, me, { tradeId: rec.id, journalId, nonce, of: first.intent.kind }, recheck) };
}

// ── J. Instant mode: the seller's lock and its USDC claim (build spec section 3.10) ──

/** The networks this release runs instant trades on, in words. */
function instantNetworksText(): string {
  const on = (['devnet', 'mainnet'] as const).filter((n) => instantTiming(n));
  return on.length ? on.join(' and ') : 'no network';
}

/**
 * Check 14 for the trade's mode: the board's trade is of the mode the kit
 * agreed to (its own offer's mode for a maker; a taker of this kit takes only
 * standard offers). A board from before wave C sends no mode: a standard
 * trade then, never an instant one.
 */
export function modeMismatch(t: Pick<Trade, 'mode'>, mode: OfferMode): Problem | null {
  if (t.mode === undefined) {
    return mode === 'instant' ? problem('TRADE_MISMATCH', 'The board sends no mode for this trade, so it is not the instant trade this kit offered. Nothing is accepted, locked or reported for it.') : null;
  }
  if (t.mode !== mode) return problem('TRADE_MISMATCH', `The board calls this trade ${t.mode}, but this kit agreed to a ${mode} trade. Nothing is accepted, locked or reported for it.`);
  return null;
}

/**
 * SaturnSwap's reads before an instant take is accepted (check 17 for an
 * instant offer): new locks not paused, USDC allowed with `usdc` inside its
 * bounds, and lock bounds that take the buyer's instant lock (T_B - now =
 * I_SLACK + I_WIN + I_PHA + I_SAFETY, up to the board's slack later). Null
 * when the buyer's lock can succeed.
 */
export function instantSwapReadsProblem(bp: { paused: boolean; allowed: boolean; minAmount: bigint; maxAmount: bigint; minLock: number; maxLock: number }, usdc: bigint, itm: InstantTiming): string | null {
  if (bp.paused) return 'New USDC locks are paused on Base right now, so the buyer could not lock the USDC. Try again later.';
  if (!bp.allowed || usdc < bp.minAmount || usdc > bp.maxAmount) return 'The Base contract would not accept this USDC amount, so the buyer could not lock it.';
  const span = instantBaseSpan(itm);
  if (!Number.isSafeInteger(bp.minLock) || bp.minLock > span) return 'The Base contract\'s shortest lock is longer than an instant trade\'s USDC lock, so the buyer\'s lock would fail.';
  if (!Number.isSafeInteger(bp.maxLock) || bp.maxLock < span + INSTANT_RULES.baseSpanSlack) return 'The Base contract\'s longest lock is shorter than an instant trade\'s USDC lock, so the buyer\'s lock would fail.';
  return null;
}

function instantSwapFit(s: BaseSwap, want: { usdcToken: string; usdc: bigint; sBase: string; bBase: string }): string | null {
  if (!sameEvm(s.token, want.usdcToken)) return 'The buyer\'s lock on Base holds another token, not USDC.';
  if (s.amount !== want.usdc) return 'The buyer\'s USDC lock holds a different amount than this trade.';
  if (!sameEvm(s.claimer, want.sBase)) return 'The buyer\'s USDC lock pays another address, not this kit\'s.';
  if (!sameEvm(s.sender, want.bBase)) return 'The USDC lock was made by another address than the buyer.';
  return null;
}

/**
 * Step 2 of build spec section 3.10.3, pure: why the buyer's USDC lock (h,
 * B_b) does not let the seller lock its tokens behind it, or null. `latest`
 * is getSwap at the newest block, `confirmed` at the confirmed point (a lock
 * a reorg could undo does not count yet): locked (1), the pinned USDC, the
 * trade's amount, paying S_b, made by B_b, both reads alike, and a fee no
 * higher than the trade's (the fee shown, `maxFeeBps`).
 */
export function instantBuyerLockProblem(
  latest: BaseSwap | null, confirmed: BaseSwap | null,
  want: { usdcToken: string; usdc: bigint; sBase: string; bBase: string; maxFeeBps: number }
): string | null {
  if (!latest || latest.state === 0) return 'The buyer has not locked the USDC on Base yet.';
  if (latest.state === 2) return 'The buyer\'s USDC lock was already claimed.';
  if (latest.state === 3) return 'The buyer\'s USDC lock was already refunded.';
  if (latest.state !== 1) return 'The buyer\'s USDC lock is in a state this kit does not know.';
  const fit = instantSwapFit(latest, want);
  if (fit) return fit;
  if (!confirmed || confirmed.state === 0) return 'The buyer\'s USDC lock is waiting for confirmations on Base.';
  if (confirmed.state !== 1) return 'The buyer\'s USDC lock changed while it was being checked. Checking again.';
  const fitC = instantSwapFit(confirmed, want);
  if (fitC) return fitC;
  if (confirmed.deadline !== latest.deadline || confirmed.feeBps !== latest.feeBps) return 'The buyer\'s USDC lock changed while it was being checked. Checking again.';
  if (!Number.isSafeInteger(latest.deadline) || latest.deadline <= 0) return 'The buyer\'s USDC lock has no valid time limit.';
  const shown = Math.min(want.maxFeeBps, MAX_FEE_BPS);
  if (!Number.isInteger(latest.feeBps) || latest.feeBps < 0 || latest.feeBps > shown) return 'The buyer\'s USDC lock charges a higher fee than this trade\'s.';
  return null;
}

/** A buyer-lock problem that a later read may clear. */
const INSTANT_LOCK_RETRY = /has not locked the USDC on Base yet|waiting for confirmations|changed while it was being checked/;

/**
 * The time rules of step 2, pure (build spec section 3.10.3; `now` is the
 * later of this machine's clock and Base's newest block, `tB` the block time
 * of the buyer's Locked event, `deadline` T_B):
 *   INSTANT_LATE   now - t_B > I_WIN - I_WIN_LEAD: the lock would land after
 *                  the I_WIN the board allows (devnet: 180 s; read 60 s
 *                  after t_B passes, 200 s refuses);
 *   INSTANT_SHORT  T_B - now < I_PHA + I_SAFETY: no room for the kit's own
 *                  lock and its USDC claim after the buyer's code is public.
 */
export function instantWindowProblem(tB: number, deadline: number, now: number, itm: InstantTiming): { code: 'INSTANT_LATE' | 'INSTANT_SHORT'; text: string } | null {
  const lead = itm.I_WIN - itm.I_WIN_LEAD;
  if (!Number.isSafeInteger(tB) || tB <= 0) return { code: 'INSTANT_LATE', text: 'The time of the buyer\'s USDC lock could not be read, so the kit cannot tell whether its own lock lands in time. Nothing was locked.' };
  const since = now - tB;
  if (since > lead) {
    return { code: 'INSTANT_LATE', text: `The buyer's USDC lock was mined ${since} s ago; this kit starts its lock only within ${lead} s of it, so that it lands inside the ${itm.I_WIN} s the board allows. Nothing was locked; the buyer's USDC is refunded after its time limit.` };
  }
  const left = deadline - now;
  if (left < itm.I_PHA + itm.I_SAFETY) {
    return { code: 'INSTANT_SHORT', text: `The buyer's USDC lock ends in ${left} s; this kit's lock needs at least ${itm.I_PHA + itm.I_SAFETY} s (its ${itm.I_PHA} s lock, then ${itm.I_SAFETY} s to claim the USDC once the buyer's code is public). Nothing was locked.` };
  }
  return null;
}

/**
 * Check 56 before an instant lock (step 2: S_b not blacklisted), where the
 * network's USDC has these switches (devnet's MockUSDC has none, so nothing
 * is read there): USDC has not blacklisted this kit's Base address (S_b) nor
 * SaturnSwap, and is not paused. A failed read refuses.
 */
export async function instantGuardProblem(d: CheckDeps, cfg: Pick<P2PNetConfig, 'base'>, sBase: string): Promise<Problem | null> {
  if (!cfg.base.usdcHasBlacklist) return null;
  let g;
  try { g = await d.base.readUsdcGuard(sBase); } catch { return problem('USDC_GUARD', 'Could not read the USDC blacklist on Base. Nothing was locked.', { retry: true }); }
  if (g.blacklisted) return problem('USDC_GUARD', 'USDC has blacklisted this kit\'s Base address: a claim would leave the USDC frozen in the contract while the buyer takes the tokens. Nothing was locked.');
  if (g.swapBlacklisted) return problem('USDC_GUARD', 'USDC has blacklisted the swap contract that pays the seller. Nothing was locked.');
  if (g.paused) return problem('USDC_GUARD', 'USDC is paused right now. Nothing was locked until it is not.', { retry: true });
  return null;
}

/** The kit's offer an instant step leans on (its kept record). */
export type InstantOffer = Pick<LocalOffer, 'id' | 'side' | 'mode' | 'price' | 'priceHistory' | 'follow'>;

/**
 * The seller's checks before its Phantasma lock in an instant trade (build
 * spec section 3.10.3 step 2, every one read fresh; a failed read refuses):
 *   - the kit is the maker of this instant sell offer, on a network this
 *     release runs instant trades on (INSTANT_START);
 *   - check 14 and the mode: the board's trade is the one the kit agreed to,
 *     an instant trade at base_locked with the buyer's h (INSTANT_START while
 *     the buyer has not locked);
 *   - Base pinned; the record's and the board's escrow are the current one
 *     (19); no other trade of the kit uses h (38);
 *   - the code pin, read fresh, and the escrow deployed (20);
 *   - the open cap, fresh (21); the trade's fee fixed (22); the escrow's
 *     settings with I_PHA inside its lock bounds (23);
 *   - the swap (h, B_b) at the newest and the confirmed block: locked, the
 *     pinned USDC, the trade's amount, paying S_b, a fee no higher than the
 *     trade's (INSTANT_BUYER_LOCK); its Locked event found, confirmed, and
 *     its block time is t_B;
 *   - the clock (25), then now - t_B <= I_WIN - I_WIN_LEAD (INSTANT_LATE)
 *     and T_B - now >= I_PHA + I_SAFETY (INSTANT_SHORT);
 *   - Phantasma getState(h) == 0: the kit's own lock there is only reported
 *     (LOCKED_ALREADY), anyone else's is a hash squat (HASH_TAKEN): never a
 *     lock behind it;
 *   - USDC's blacklist and pause where the token has them (56);
 *   - the signing key and its SOUL (28), the tokens with their reserve (29);
 *     no lock of this trade in flight (27);
 *   - h, the escrow, the fee shown and T_B stored with the trade before
 *     anything is signed, and read back (32, 48).
 * The intent's re-check (31, 33) reads the trade, Phantasma under h, the
 * code pin, the cap, the buyer's lock and the clock again, and sets the
 * lock's end T_P = now + I_PHA from that last clock read.
 */
export async function instantSellerLock(d: CheckDeps, trade: Trade, recIn: LocalTrade, offer: InstantOffer | null): Promise<CheckResult<'phaLock'>> {
  const cfg = cfgOf(d);
  const rec = (await d.store.getTrade(recIn.id)) ?? recIn;
  const start = (text: string, retry = false) => refuse(problem('INSTANT_START', text, { retry }));
  if (rec.role !== 'S' || !rec.maker) return start('Only the maker of an instant sell offer locks its tokens after the buyer. Nothing was locked.');
  if (!offer || offer.id !== rec.offerId || offer.mode !== 'instant' || offer.side !== 'sell') return start('This trade is not on one of this kit\'s instant sell offers. Nothing was locked.');
  const itm = instantTiming(d.network);
  if (!itm) return start(`This kit release runs instant trades on ${instantNetworksText()} only, not on ${d.network}. Nothing was locked.`);
  const mm = tradeMismatch(trade, rec, offer) ?? modeMismatch(trade, 'instant');
  if (mm) return refuse(mm);
  const sym = tokenOf(rec.symbol)!.symbol;
  if (trade.status !== 'base_locked' || !isHex32(trade.h)) {
    if (trade.status === 'requested' || trade.status === 'accepted') return start('The buyer has not locked the USDC yet: in an instant trade the buyer locks first.', true);
    return start(`This trade is ${trade.status}, not waiting for this kit's lock. Nothing was locked.`);
  }
  const h = trade.h.toLowerCase();
  const nd = baseDeployedProblem(d.network);
  if (nd) return refuse(nd);
  if (rec.phaContract && rec.phaContract !== cfg.phaContract) return refuse(problem('ESCROW_CHANGED', `This trade's record names the Phantasma contract ${rec.phaContract}, not ${cfg.phaContract}. Nothing was locked.`));
  if (trade.phaContract && trade.phaContract !== cfg.phaContract) return refuse(problem('ESCROW_CHANGED', `The board ties this trade to the Phantasma contract ${trade.phaContract}, not ${cfg.phaContract}. Nothing was locked.`));
  if (await d.store.hashUsedElsewhere(h, rec.id)) return refuse(problem('HASH_REUSED', 'The buyer\'s lock hash already belongs to another trade of this kit. Nothing was locked.'));
  const pin = await codePinRead(d, cfg);
  if (pin.problem) return refuse(pin.problem);
  if (!pin.deployed) return refuse(problem('ESCROW_NOT_DEPLOYED', 'The P2P contract is not deployed on Phantasma on this network.'));
  const taz = big(rec.taz), usdc = big(rec.usdc);
  const cap = await sellerCapProblem(d, cfg, sym, taz);
  if (cap) return refuse(cap);
  const fee = tradeFee(trade);
  if (fee == null) return refuse(problem('FEE_UNSET', 'The board has not fixed this trade\'s fee (or it is above 2%), so nothing was locked.', { retry: trade.feeBps == null }));
  let pp;
  try { pp = await d.pha.readParams(cfg, sym); } catch { return refuse(problem('ESCROW_PARAMS', 'Could not read the P2P settings on Phantasma.', { retry: true })); }
  if (pp.paused) return refuse(problem('ESCROW_PARAMS', 'New P2P locks are paused on Phantasma right now.', { retry: true }));
  if (pp.maxAmount === 0n) return refuse(problem('ESCROW_PARAMS', tokenOffText(sym)));
  const tok = tokenOf(sym)!;
  if (pp.minAmount !== tok.min || pp.maxAmount !== tok.max) return refuse(problem('ESCROW_PARAMS', `The P2P escrow's limits for ${sym} on Phantasma are not the ones this kit checks for. Nothing was locked. Wait for a kit update.`));
  if (taz < pp.minAmount || taz > pp.maxAmount) return refuse(problem('ESCROW_PARAMS', `This ${sym} amount is outside what one lock accepts.`));
  if (itm.I_PHA < pp.minLock || itm.I_PHA > pp.maxLock) return refuse(problem('ESCROW_PARAMS', 'The Phantasma contract does not accept an instant lock\'s length right now.'));
  const bBase = (rec.counterBase || trade.buyer.base).toLowerCase();
  const bPha = buyerPhaOf(rec, trade);

  // The buyer's USDC lock, at the newest and the confirmed block, and when it was mined (t_B).
  const want = { usdcToken: cfg.base.usdc, usdc, sBase: rec.myBase, bBase, maxFeeBps: fee };
  const readBuyerLock = async (): Promise<{ ok: true; deadline: number } | { ok: false; problem: Problem }> => {
    let r;
    try { r = await d.base.readSwapConfirmed(h, bBase); } catch { return refuse(problem('INSTANT_BUYER_LOCK', 'Could not read the buyer\'s USDC lock on Base. Nothing was locked.', { retry: true })); }
    const bad = instantBuyerLockProblem(r.latest, r.confirmed, want);
    if (bad) return refuse(problem('INSTANT_BUYER_LOCK', `${bad} Nothing was locked.`, { retry: INSTANT_LOCK_RETRY.test(bad) }));
    return { ok: true, deadline: r.latest.deadline };
  };
  const bl = await readBuyerLock();
  if (!bl.ok) return bl;
  const buyerEnd = bl.deadline;
  let at;
  try {
    at = await d.base.readLockedAt(h, bBase, { txHash: trade.baseLockTx, fromTime: localSec(d) - itm.I_WIN - BOARD.lockWait });
  } catch {
    return refuse(problem('INSTANT_BUYER_LOCK', 'Could not search Base for the block of the buyer\'s USDC lock. Nothing was locked.', { retry: true }));
  }
  if (!at) return refuse(problem('INSTANT_BUYER_LOCK', 'The block of the buyer\'s USDC lock (its Locked event) was not found on Base, so the time it was mined is not known. Nothing was locked.', { retry: true }));
  if (at.blockNumber > at.confirmedBlock) return refuse(problem('INSTANT_BUYER_LOCK', 'The buyer\'s USDC lock is waiting for confirmations on Base. Nothing was locked.', { retry: true }));
  const tB = at.time;
  const clock = await chainClock(d);
  if (!clock.ok) return clock;
  const win = instantWindowProblem(tB, buyerEnd, clock.now, itm);
  if (win) return refuse(problem(win.code, win.text));

  // Phantasma: nothing under the buyer's h yet (getState(h) == 0).
  const underH = async (): Promise<Problem | null> => {
    let l: PhaLockRead;
    try { l = await d.pha.readLock(cfg, h); } catch { return problem('HASH_TAKEN', 'Could not read Phantasma under the buyer\'s hash. Nothing was locked.', { retry: true }); }
    if (l.state === 0) return null;
    if (isOurLock(l, rec, bPha)) return problem('LOCKED_ALREADY', `This trade's ${sym} is already locked under the buyer's hash; report the lock instead.`, { h });
    return problem('HASH_TAKEN', `Someone else already locked on Phantasma under the buyer's hash (a hash squat), and Phantasma takes each hash once, so this kit cannot lock for this trade. Nothing was locked; the buyer's USDC is refunded after its time limit.`);
  };
  const taken = await underH();
  if (taken) return refuse(taken);
  const guard = await instantGuardProblem(d, cfg, rec.myBase);
  if (guard) return refuse(guard);

  // The key that signs, and its funds.
  if (d.address.pha !== rec.myPha) return refuse(problem('PHA_KEY', `This kit's Phantasma key is ${d.address.pha}, not ${rec.myPha}, the seller in this trade. Nothing was locked.`));
  let bal: PhaBalances;
  try { bal = await d.pha.balances(rec.myPha); } catch { return refuse(problem('SELLER_FUNDS', 'Could not read this kit\'s Phantasma balances. Nothing was locked.', { retry: true })); }
  const soul = balanceOf(bal, 'SOUL');
  if (soul == null || soul < SOUL_RESERVE) return refuse(problem('SOUL_LOW', `This kit's Phantasma address keeps less than ${amountText(SOUL_RESERVE, 8)} SOUL free for Phantasma's fees (the lock's own, and 1 SOUL for a refund later). Nothing was locked.`, { retry: true }));
  const funds = sellerFundsProblem(cfg, bal, sym, taz, 'This kit\'s Phantasma address');
  if (funds) return refuse(problem('SELLER_FUNDS', `${funds} Nothing was locked.`, { retry: true }));
  const busy = await lockInFlight(d, rec.id, 'phaLock');
  if (busy) return refuse(busy);

  // h, the escrow, the fee shown and T_B, stored before the lock is signed and read back (checks 32 and 48).
  try {
    const back = await d.store.patchTrade(rec.id, { h, phaContract: cfg.phaContract, feeShown: fee, t2: buyerEnd });
    if (back.h !== h || back.phaContract !== cfg.phaContract || back.feeShown !== fee || back.t2 !== buyerEnd) throw new Error('read back differently');
  } catch (e) {
    return refuse(problem('FEE_SHOWN', `The lock hash, the fee shown and the escrow could not be stored with the trade (${errorText(e)}), so nothing was locked.`));
  }

  const facts = { tradeId: rec.id, escrow: cfg.phaContract, h, symbol: sym, amount: taz, sender: rec.myPha, recipient: bPha, fee, usdc, bBase };
  const recheck: Recheck = async () => {
    // Check 31: a fresh trade read, Phantasma under h, no lock in flight, the code pin, the cap, the buyer's lock.
    let t: Trade;
    try { t = await d.board.trade(rec.id); } catch { return refuse(problem('TRADE_CHANGED', 'Could not reload the trade. Nothing was locked.', { retry: true })); }
    const r2 = (await d.store.getTrade(rec.id)) ?? rec;
    const mm2 = tradeMismatch(t, r2, offer) ?? modeMismatch(t, 'instant');
    if (mm2) return refuse(mm2);
    if (t.status !== 'base_locked' || (t.h ?? '').toLowerCase() !== h) return refuse(problem('TRADE_CHANGED', `The trade moved on the board (${t.status}) after it was checked. Nothing was locked.`));
    if (tradeFee(t) !== fee) return refuse(problem('TRADE_CHANGED', 'The trade\'s fee changed after it was checked. Nothing was locked.'));
    if (r2.feeShown !== fee || r2.phaContract !== cfg.phaContract || r2.h !== h) return refuse(problem('FEE_SHOWN', 'The lock hash and the fee shown are no longer stored with the trade. Nothing was locked.'));
    const taken2 = await underH();
    if (taken2) return refuse(taken2);
    const busy2 = await lockInFlight(d, rec.id, 'phaLock');
    if (busy2) return refuse(busy2);
    const pin2 = await codePin(d, cfg);
    if (pin2) return refuse(pin2);
    const cap2 = await sellerCapProblem(d, cfg, sym, taz);
    if (cap2) return refuse(cap2);
    const bl2 = await readBuyerLock();
    if (!bl2.ok) return bl2;
    if (bl2.deadline !== buyerEnd) return refuse(problem('INSTANT_BUYER_LOCK', 'The buyer\'s USDC lock changed after it was checked. Nothing was locked.'));
    const guard2 = await instantGuardProblem(d, cfg, rec.myBase);
    if (guard2) return refuse(guard2);
    // Check 33: the clock read again, the time rules with it, and T_P from it.
    const c2 = await chainClock(d, 'CLOCK_RECHECK');
    if (!c2.ok) return c2;
    const w2 = instantWindowProblem(tB, buyerEnd, c2.now, itm);
    if (w2) return refuse(problem(w2.code, w2.text));
    return { ok: true, deadline: c2.now + itm.I_PHA };
  };
  return { ok: true, intent: issued(d, 'phaLock', rec.id, rec.myPha, facts, recheck) };
}

/**
 * The public secret of an instant trade kept with the trade (check 59a for
 * the kit's USDC claim): the buyer's code, as Phantasma shows it once the
 * kit's lock reads claimed, bound to this trade (its id, network, token,
 * amount and both Phantasma addresses; made by the buyer, role B), kept
 * before anything is simulated. A secret already kept under h must be
 * exactly this trade's.
 */
async function keepPublicSecret(d: CheckDeps, rec: LocalTrade, h: string, secret: string, bPha: string): Promise<{ ok: true; secret: SecretRecord } | { ok: false; problem: Problem }> {
  const notThis = refuse(problem('SECRET_NOT_THIS_TRADE', 'A secret kept under this lock hash was made for another trade, token, amount or party. Nothing is claimed with it.'));
  let have: SecretRecord | null;
  try { have = await d.store.getSecret(h); } catch { return notThis; }
  if (have) return secretIsThisTrades(have, rec, d.network, bPha) && have.h === h ? { ok: true, secret: have } : notThis;
  const rec2: SecretRecord = {
    v: 1, secret: secret.toLowerCase(), h, tradeId: rec.id, network: d.network, symbol: rec.symbol, taz: rec.taz, sPha: rec.myPha, bPha, role: 'B', createdAt: nowMs(d)
  };
  try {
    return { ok: true, secret: await d.store.putSecret(rec2) };
  } catch (e) {
    return refuse(problem('INSTANT_CLAIM', `The buyer's code, public on Phantasma, could not be kept with the trade (${errorText(e)}). Nothing was sent.`, { retry: true }));
  }
}

/**
 * The seller's USDC claim in an instant trade (build spec sections 3.10.3
 * step 4 and 3.10.4: Phantasma is claimed first, always), from the kit's
 * own record, the chains and nothing the board says:
 *   - one claim per h in flight (61): while a claim of this trade is not
 *     settled, only its replacement is issued (`o.follow`), at its nonce;
 *   - the kit's Phantasma lock under h is this trade's and reads claimed (2):
 *     the buyer's code is public there (PHA_NOT_CLAIMED while it reads
 *     locked, INSTANT_CLAIM once refunded);
 *   - that code opens h, and is kept with the trade, bound to it (59a);
 *   - the buyer's USDC lock at the newest and the confirmed block: locked,
 *     the pinned USDC, the trade's amount, paying S_b, made by B_b, a fee no
 *     higher than the fee shown before the lock (INSTANT_CLAIM; claimed by
 *     someone else first: DONE_ELSEWHERE);
 *   - T_B - now >= INSTANT_RULES.claimMin (60 s). CLAIM_MARGIN does not
 *     apply: the code is already public on Phantasma.
 * The signer then simulates the claim (eth_call) before it signs, and the
 * intent's re-check reads the swap (still locked, the same T_B, 60 s left),
 * the Phantasma lock (still claimed) and the kept secret again.
 */
export async function instantClaim(d: CheckDeps, recIn: LocalTrade, o: { follow?: Intent | null } = {}): Promise<CheckResult<'claimBase'>> {
  const rec = (await d.store.getTrade(recIn.id)) ?? recIn;
  const no = (text: string, retry = false) => refuse(problem('INSTANT_CLAIM', text, { retry }));
  if (rec.role !== 'S' || !rec.maker) return no('Only the seller of an instant trade claims its USDC.');
  const inFlight = await sendInFlight(d, rec.id, 'claimBase', o.follow);
  if (!inFlight.ok) return inFlight;
  const ec = escrowFor(d.network, rec.phaContract);
  if (!ec.ok) return ec;
  const cfg = ec.cfg;
  const nd = baseDeployedProblem(d.network);
  if (nd) return refuse(nd);
  if (!rec.h) return no('This kit holds no lock hash for this trade.');
  const h = rec.h;
  const bBase = evmLower(rec.counterBase);
  const bPha = rec.counterPha;
  if (!bBase || !bPha) return no('This kit has no addresses of the buyer for this trade.');
  const sym = tokenOf(rec.symbol)!.symbol;
  const claimMin = INSTANT_RULES.claimMin;

  // Phantasma first, always: the kit's lock reads claimed, so the buyer's code is public there.
  const phaClaimed = async (): Promise<{ ok: true; lock: PhaLockRead } | { ok: false; problem: Problem }> => {
    let lock: PhaLockRead;
    try { lock = await d.pha.readLock(cfg, h); } catch { return no(`Could not read the ${sym} lock on Phantasma. Nothing was sent.`, true); }
    if (lock.state === 0) return no(`This kit's ${sym} lock is not on Phantasma. Nothing was sent.`, true);
    if (!isOurLock(lock, rec, bPha)) return no(`The lock under this hash on Phantasma is not this kit's ${sym} lock for this trade. Nothing was sent.`);
    if (lock.state === 3) return no(`This kit's ${sym} lock was refunded, so the buyer's code was never used on Phantasma. Nothing was sent.`);
    if (lock.state !== 2) {
      return refuse(problem('PHA_NOT_CLAIMED', `The ${sym} lock on Phantasma is not claimed yet. In an instant trade the USDC is claimed only once the buyer's claim on Phantasma has made its code public. Nothing was sent.`, { retry: true }));
    }
    if (!lock.secret || !secretOpens(lock.secret, h)) return no(`Phantasma shows the ${sym} lock claimed but no code that opens its hash. Nothing was sent.`, true);
    return { ok: true, lock };
  };
  const pc = await phaClaimed();
  if (!pc.ok) return pc;
  const kept = await keepPublicSecret(d, rec, h, pc.lock.secret!, bPha);
  if (!kept.ok) return kept;
  const fee = feeShownOf(rec);
  if (fee == null) return no('This kit has no record of the fee it was shown before locking, so it does not claim. Nothing was sent.');
  let r;
  try { r = await d.base.readSwapConfirmed(h, bBase); } catch { return no('Could not read the buyer\'s USDC lock on Base. Nothing was sent.', true); }
  if (r.latest.state === 2) return refuse(doneElsewhere(59, 'The USDC lock was already claimed.'));
  const bad = instantBuyerLockProblem(r.latest, r.confirmed, { usdcToken: cfg.base.usdc, usdc: big(rec.usdc), sBase: rec.myBase, bBase, maxFeeBps: fee });
  if (bad) return no(`${bad} Nothing was sent.`, INSTANT_LOCK_RETRY.test(bad));
  const now = Math.max(localSec(d), r.blockTime);
  const deadline = r.latest.deadline;
  if (deadline - now < claimMin) return no(`The buyer's USDC lock ends in ${deadline - now} s; a claim goes out only while at least ${claimMin} s are left, so it is mined before the time limit. Nothing was sent.`);
  const sender = bBase;
  const facts = { tradeId: rec.id, escrow: cfg.phaContract, h, sender, deadline, minLeft: claimMin, ...followFacts(inFlight.follow) };
  const recheck: Recheck = async () => {
    // Check 61 (before the simulation and again before signing): still locked, the same T_B, 60 s left; Phantasma still claimed.
    let s;
    try { s = await d.base.readSwap(h, sender); } catch { return refuse(problem('CLAIM_RECHECK', 'Could not read the USDC lock on Base. Nothing was sent.', { retry: true })); }
    const t = Math.max(localSec(d), s.blockTime);
    if (s.swap.state === 2) return refuse(doneElsewhere(61, 'The USDC lock was already claimed. Nothing was sent.'));
    if (s.swap.state !== 1) return refuse(problem('CLAIM_RECHECK', 'This USDC lock was refunded. Nothing was sent.'));
    if (s.swap.deadline !== deadline || s.swap.deadline - t < claimMin) return refuse(problem('CLAIM_RECHECK', 'Too close to the USDC lock\'s time limit to claim safely. Nothing was sent.'));
    const pc2 = await phaClaimed();
    if (!pc2.ok) return pc2;
    const s2 = await d.store.getSecret(h).catch(() => null);
    if (!s2 || !secretOpens(s2.secret, h) || s2.tradeId !== rec.id) return refuse(problem('SECRET_NOT_THIS_TRADE', 'The code for this claim is no longer kept. Nothing was sent.'));
    return { ok: true };
  };
  return { ok: true, intent: issued(d, 'claimBase', rec.id, d.address.base.toLowerCase(), facts, recheck) };
}
