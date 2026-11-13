/**
 * The kit's trade engine (build spec sections 6.3, 6.5 and 6.6): it posts
 * the bot's offers, keeps them listed with the long-poll heartbeat, adopts
 * and accepts takes, and drives every trade the bot made or took through its
 * locks, claims and refunds, resuming from the store after a crash. The
 * taker side (take, buyUpTo, sellDownTo) is flows/taker.ts; createKit
 * (index.ts) wires both.
 *
 * It decides only WHICH step is due. Every step that signs goes through
 * checks.ts (which issues an intent only when every check of section 6.4
 * passes) and signer.ts (the only module that signs, which re-checks right
 * before it does). The board's word never decides an amount, a token, an
 * address or a lock: the engine reads the chains and the bot's own records.
 *
 * The checks that live here:
 *    9  the board's echo of a posted offer equals what was posted; otherwise
 *       the offer is cancelled at once (OFFER_ECHO). An answer the kit cannot
 *       read is cancelled with its token by BoardSession.postOffer;
 *   16  a take is accepted only once it was seen for Policy.acceptAfterS
 *       (default 15 s, minimum 0), and a decline wins (ACCEPT_TOO_SOON,
 *       TAKE_DECLINED);
 *   35  after its Phantasma lock the seller reads the lock under h, reports it
 *       to the board only when it is this trade's own (isOurLock), and records
 *       h, the escrow and T1 first (LOCK_NOT_OURS otherwise).
 *
 * Instant offers (build spec section 3.10; flows/instant.ts): a sell offer
 * posted with `mode: 'instant'` (devnet only in this release, with an API
 * key the owner flagged instant) is traded the other way round: the buyer
 * locks the USDC first, and the kit locks its tokens behind the buyer's
 * hash. Every trade on such an offer goes to InstantSeller; a trade the
 * board calls by another mode than the kit agreed to is a mismatch (check
 * 14) and is never accepted, locked or reported. run() steps these trades on
 * the instant lane, each on its own and apart from the trade loop, so no
 * other trade's step holds up an instant lock's start window or its
 * getState(h) watch; accepts still run one at a time across both
 * (#committing), so the tokens one take needs are never promised twice.
 * Check 14's limit part for buyUpTo/sellDownTo (PRICE_LIMIT) is enforced here
 * too, before any lock of a trade those calls took.
 *
 * Resume (section 6.5): run() first asks the board about every pending
 * create (BoardSession.reconcilePending, which probes GET /v1/p2p/recent
 * before it ever sends replayOnly), then resolves every open journal intent
 * from the chains before any new send; there is never a blind resend. Each
 * step resolves its own trade's open intents first as well.
 *
 * Long-polls are bounded under the board's caps (20 held requests per IP,
 * 100 per API key): one heartbeat request for all the bot's offers (the
 * batch carries 40), plus at most 4 trade long-polls (12 with an API key) for
 * the trades waiting on the other side. Every other trade is read plainly at
 * the cadence its next step needs.
 *
 * Nothing here logs a key, a token or a secret: every line goes through
 * redact(), and hashes are shortened (shortHex).
 */
import { P2P_CONFIG, BOARD, SOUL_RESERVE, USDC_DECIMALS, INSTANT_NETWORKS, tokenOf, instantTiming, type P2PNetConfig } from '../pins.js';
import { SafetyError, BoardError, SAFETY } from '../errors.js';
import { redactedLog, errorText, shortHex, type LogFn } from '../redact.js';
import { TERMINAL, FOLLOW_TAKE_USD_MAX, amountText, sameEvm, offerPriceProblem, followOfferProblem, type BaseSwap } from '../rules.js';
import * as checks from '../checks.js';
import { SignRefusal, type Signer, type SendResult, type FollowedKind } from '../signer.js';
import { BoardSession, BoardClient, TradePoller, CreateError, sleep as realSleep, type SleepFn, type CallOptions } from '../board.js';
import { REPLACE_AFTER_MS, type Hex } from '../base.js';
import { InstantSeller } from './instant.js';
import { balanceOf, type PhaLockRead } from '../pha.js';
import type { KitStore } from '../store.js';
import type { CheckId, Problem, CheckDeps, Outcome, CheckResult } from '../checks.js';
import type { Network, Side, Trade, Offer, LocalOffer, LocalTrade, TradeStatus, FollowSettings, NewOffer, Intent, IntentOutcome, OfferMode, Journal } from '../types.js';

// ── Codes ────────────────────────────────────────────────────────────────────

/**
 * The refusal codes of the flows and createKit, with the section 6.4 check
 * each belongs to (null: not a check of section 6.4, a rule of the flows).
 * checks.CHECK_CODES and signer.SIGNER_CODES hold the others.
 */
export const FLOW_CODES = Object.freeze({
  /** Check 9: the board listed a posted offer differently from what was posted; it was cancelled. */
  OFFER_ECHO: 9,
  /** Check 16: the take has been seen for less than Policy.acceptAfterS. */
  ACCEPT_TOO_SOON: 16,
  /** Check 16: the take was declined; a decline wins over an accept. */
  TAKE_DECLINED: 16,
  /** Check 35: the lock under h is not this trade's own lock, so it is not reported. */
  LOCK_NOT_OURS: 35,
  /** Check 67: an RPC host off the network's allowlist, or a Base RPC of another chain. */
  RPC_NOT_ALLOWED: 67,
  /** Check 14 (buyUpTo/sellDownTo): the trade's price is past the order's limit; it is never locked. */
  PRICE_LIMIT: 14,
  /** The take waits: accepting on its own is off for the offer, the policy said no, or the offer has its most open trades. */
  ACCEPT_HELD: null,
  /** A trade, offer or option the call does not accept (nothing was sent). */
  BAD_INPUT: null,
  /** An amount or a price that is not a plain decimal number of the right precision. */
  BAD_AMOUNT: null,
  /** A Policy value out of range. */
  BAD_POLICY: null,
  /** run() is already running in this kit. */
  ALREADY_RUNNING: null,
  /** The store keeps no record of this trade or offer. */
  NOT_KEPT: null,
  /** The offer is not listed on the board (or not takeable now). */
  OFFER_NOT_LISTED: null,
  /** The offer is this bot's own. */
  OWN_OFFER: null,
  /**
   * The offer's mode cannot be used here, and nothing was sent: an instant
   * offer is a sell offer, on a network this release runs instant trades on
   * (devnet) and the board's /config says they are on, posted with an API
   * key the owner flagged instant (read from /me first); and this kit takes
   * standard offers only (an instant offer's buyer locks first, which the
   * site does).
   */
  MODE_NOT_SUPPORTED: null
} as const satisfies Record<string, CheckId | null>);

export type FlowCode = keyof typeof FLOW_CODES;

/** A refusal of the flows: nothing was sent. */
export function flowError(code: FlowCode, text: string): SafetyError {
  return new SafetyError(code, text);
}

/** A check's refusal as a thrown error (nothing was sent). */
export function problemError(p: Problem): SafetyError {
  return new SafetyError(p.code, p.text);
}

// ── Amounts: decimal text in, raw units out ─────────────────────────────────

const DECIMAL = /^(\d{1,30})(?:\.(\d{1,30}))?$/;

/**
 * A decimal amount ("30", "2.5", "1.08") as raw units of `decimals` places.
 * Only digits and one dot: no sign, no exponent, no spaces, and no more
 * fractional digits than the unit has (nothing is rounded). Zero refuses.
 * Throws SafetyError BAD_AMOUNT naming `what`.
 */
export function toRaw(text: unknown, decimals: number, what: string): bigint {
  const m = typeof text === 'string' ? DECIMAL.exec(text) : null;
  if (!m) throw flowError('BAD_AMOUNT', `${what} is a decimal number written as text, such as "2.5" (digits and one dot; no sign, exponent or spaces).`);
  const frac = m[2] ?? '';
  if (frac.length > decimals) throw flowError('BAD_AMOUNT', `${what} has more than ${decimals} decimal places.`);
  const raw = BigInt(m[1]!) * 10n ** BigInt(decimals) + (decimals > 0 ? BigInt(frac.padEnd(decimals, '0')) : 0n);
  if (raw <= 0n) throw flowError('BAD_AMOUNT', `${what} must be more than zero.`);
  return raw;
}

/** Whole tokens of `symbol` ("2.5") as raw units, with the decimals of the kit's own token table only (check 1). */
export function tokenToRaw(symbol: string, text: unknown, what = 'The amount'): bigint {
  const t = tokenOf(symbol);
  if (!t) throw problemError(checks.problem('TOKEN_NOT_TRADED', 'This names no token this kit trades (C, RA, TAZ, SOUL or KCAL, written exactly so).'));
  return toRaw(text, t.decimals, what);
}

/** USDC per whole token ("1.08") as raw USDC (6 decimals). */
export function usdcToRaw(text: unknown, what = 'The price'): bigint {
  return toRaw(text, USDC_DECIMALS, what);
}

/** Raw units back to decimal text ("2.5"), for logs and reports. */
export function fromRaw(raw: bigint | string, decimals: number): string {
  return amountText(BigInt(raw), decimals);
}

// ── Policy ───────────────────────────────────────────────────────────────────

/** What a Policy.accept is shown: check 17's result (accepting signs nothing). */
export type AcceptChecks = Outcome;

/** How run() and step() decide (build spec section 6.3). */
export interface Policy {
  /**
   * Whether to accept a take on one of the bot's offers, once it was seen for
   * acceptAfterS and its hard checks passed (check 14, the open cap, the bot's
   * own readiness). `checks` is check 17's answer on the other side's funds.
   * Default: accept when the checks pass. Accepting signs nothing; every lock
   * runs its own full checks later.
   */
  accept?(t: Trade, ctx: { offer: LocalOffer; checks: AcceptChecks }): boolean | Promise<boolean>;
  /** Lock USDC even when the bot's Phantasma address holds less KCAL than one claim needs (check 47). Default false. */
  lockWithLowKcal?: boolean;
  /** Trades of one offer that may run at once (accepted and not finished). Default 3, the board's own limit. */
  maxOpenTrades?: number;
  /** How long a take is seen before it is accepted, seconds (check 16). Default 15, minimum 0. */
  acceptAfterS?: number;
  /**
   * How long a buyer waits for the keeper to claim its tokens before it
   * claims them itself, seconds (section 6.6). Default CLAIM_WATCH, minimum 0.
   * The wait always ends CLAIM_MARGIN before the seller's lock does, so the
   * bot's own claim still lands in time.
   */
  claimWatchS?: number;
}

/** A Policy with its defaults filled in. */
export interface ResolvedPolicy {
  accept: Policy['accept'] | null;
  lockWithLowKcal: boolean;
  maxOpenTrades: number;
  acceptAfterS: number;
  claimWatchS: number;
}

/** The policy's defaults and bounds; throws BAD_POLICY for a value out of range. */
export function resolvePolicy(p: Policy | undefined | null, network: Network): ResolvedPolicy {
  const timing = P2P_CONFIG[network].timing;
  const o = p ?? {};
  if (typeof o !== 'object') throw flowError('BAD_POLICY', 'A policy is an object.');
  const secs = (v: unknown, dflt: number, what: string): number => {
    if (v === undefined) return dflt;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 86_400) throw flowError('BAD_POLICY', `${what} is a number of seconds from 0 to 86400.`);
    return v;
  };
  const maxOpen = o.maxOpenTrades === undefined ? BOARD_WAITING_PER_OFFER : o.maxOpenTrades;
  if (typeof maxOpen !== 'number' || !Number.isSafeInteger(maxOpen) || maxOpen < 1 || maxOpen > 100) throw flowError('BAD_POLICY', 'maxOpenTrades is a whole number from 1 to 100.');
  if (o.accept !== undefined && typeof o.accept !== 'function') throw flowError('BAD_POLICY', 'accept is a function.');
  return Object.freeze({
    accept: o.accept ?? null,
    lockWithLowKcal: o.lockWithLowKcal === true,
    maxOpenTrades: maxOpen,
    acceptAfterS: secs(o.acceptAfterS, BOARD.acceptDelay, 'acceptAfterS'),
    claimWatchS: secs(o.claimWatchS, timing.claimWatch, 'claimWatchS')
  });
}

/** The board's limit of takes waiting on one offer (/config limits.waitingPerOffer). */
const BOARD_WAITING_PER_OFFER = 3;

// ── Steps ────────────────────────────────────────────────────────────────────

/** What a step did or waits for. */
export type StepAction =
  | 'none' | 'accept' | 'decline' | 'lockPha' | 'reportPhaLock' | 'lockBase' | 'reportBaseLock'
  | 'reveal' | 'claimBase' | 'claimPha' | 'refundPha' | 'refundBase' | 'withdrawOwed'
  /** The nonce of a claim, refund or withdrawal not mined was taken back with a 0-value transfer (it may no longer go through). */
  | 'cancelBase';

/**
 *   done      the action went through (doneElsewhere: the chain shows it done by someone else, which is a success);
 *   pending   sent, its outcome is not known yet (the journal keeps it open; the next step resolves it from the chain);
 *   waiting   nothing to do now: the other side, a time limit or a confirmation;
 *   refused   a check refused (code, check, text); nothing was sent;
 *   failed    sent and refused on chain, or the board refused a report;
 *   finished  the bot has nothing more to do for this trade.
 */
export type StepOutcome = 'done' | 'pending' | 'waiting' | 'refused' | 'failed' | 'finished';

export interface StepResult {
  readonly tradeId: number;
  readonly action: StepAction;
  readonly outcome: StepOutcome;
  /** The board's status as read in this step (null when it could not be read). */
  readonly status: TradeStatus | null;
  /** The refusal's code (checks.CHECK_CODES, FLOW_CODES, signer.SIGNER_CODES) or a board code. */
  readonly code?: string;
  /** The section 6.4 check behind the code, when it is one. */
  readonly check?: CheckId | null;
  /** A plain sentence (redacted). */
  readonly text?: string;
  /** Whether the same step may pass on a later try. */
  readonly retry?: boolean;
  readonly txHash?: string | null;
  /** The keeper (or someone else) did it first; the payee has it. */
  readonly doneElsewhere?: boolean;
  /** What a waiting step waits for. */
  readonly waitingFor?: 'board' | 'chain' | 'time';
  /** ms: run this trade's next step no later than this. */
  readonly nextAt: number;
}

/** How a seller claims its USDC (section 6.6). */
export type ClaimMode = 'self' | 'reveal-then-self';

/** A new offer, in whole units (decimal text): build spec section 6.3, Kit.postOffer. */
export interface OfferInput {
  side: Side;
  symbol: string;
  /** Whole tokens: the offer's total, and the smallest and largest trade ("30", "1", "5"). */
  total: string;
  min: string;
  max: string;
  /** USDC per whole token ("1.08"). Required unless `follow` is given. */
  price?: string;
  /** Follow the reference price: the offset in basis points, the limit price ("never below" a sell, "never above" a buy), and the most filled per 24 h (whole tokens; default the total). */
  follow?: { offsetBps: number; limitPrice: string; dailyMax?: string };
  /**
   * 'standard' (the default), or 'instant': the buyer locks the USDC first
   * and the bot locks its tokens after checking that lock (build spec section
   * 3.10). Instant offers are sell offers only, on devnet in this release,
   * and need an API key the owner flagged instant (`apiKeyFile`).
   */
  mode?: OfferMode;
  /** Accept takes on their own once their checks pass (it signs nothing). Default true; false leaves every take to acceptTake/declineTake. */
  acceptOnTheirOwn?: boolean;
}

// ── Timing of the loops ──────────────────────────────────────────────────────

/** A trade waiting on the other side's board move is read again this often without a long-poll. */
const BOARD_WAIT_MS = 5_000;
/** ... and this often while one of the trade long-polls watches it. */
const POLLED_WAIT_MS = 30_000;
/** A trade waiting on the chains (a confirmation, the other side's claim) is read again this often. */
const CHAIN_WAIT_MS = 15_000;
/** A step refused for a reason that may pass later is tried again this soon. */
const RETRY_MS = 10_000;
/** A step refused for good (it never passes as things stand) is looked at again this rarely: a refund may still come due. */
const STUCK_MS = 60_000;
/** The trade loop sleeps at most this long. */
const IDLE_MS = 15_000;
/** Pending creates are asked about again this often while run() runs. */
const RECONCILE_EVERY_MS = 60_000;
/** The long-poll slots are chosen again this often. */
const RESELECT_MS = 10_000;
/** Trade long-polls at once without an API key (the board holds 20 per IP), and with one (100 per key). */
const TRADE_POLLS_ANON = 4;
const TRADE_POLLS_KEYED = 12;
/** Board calls inside a step wait at most this long for a retry the board asks for (s), and are sent again at most this often. */
const STEP_CALL: CallOptions = Object.freeze({ maxRetryAfter: 10, retries: 2 });
/**
 * A step of an instant trade's watch (its own lock recorded) reads the board once and waits at most 3 s for it: there
 * the board is needed only for the lock report, so a board that does not answer never holds up the getState(h) watch,
 * the USDC claim or the refund, which run on the chains.
 */
const WATCH_CALL: CallOptions = Object.freeze({ retries: 0, timeoutMs: 3_000 });
/** Statuses where the next move is the other side's, visible on the board. */
const OTHER_SIDE: readonly string[] = Object.freeze(['requested', 'accepted', 'pha_locked', 'base_locked']);
/** Statuses of a trade past its accept and not ended. */
const RUNNING: readonly string[] = Object.freeze(['accepted', 'pha_locked', 'base_locked', 'revealed', 'base_claimed', 'payout_pending', 'refunding']);
/** check codes after which an accept never goes out, whatever the policy says. */
const HARD_ACCEPT: ReadonlySet<string> = new Set(['TRADE_MISMATCH', 'OPEN_CAP', 'BUYER_NOT_READY', 'NOT_PINNED', 'BASE_NOT_DEPLOYED']);
/** Errors that stop run(): the store is no longer this process's, or the bot's key must not trade. */
const FATAL: ReadonlySet<string> = new Set([SAFETY.STORE_LOCK_LOST, SAFETY.STORE_CLOSED, SAFETY.KEY_ROLE, SAFETY.STORE_CORRUPT]);

const isFatal = (e: unknown) => e instanceof SafetyError && FATAL.has(e.code);

// ── The engine ───────────────────────────────────────────────────────────────

export interface EngineOptions {
  network: Network;
  /** The bot's own addresses (from its key files). */
  address: Readonly<{ pha: string; base: string }>;
  session: BoardSession;
  signer: Signer;
  /** What the checks read (the same clock as the signer). */
  deps: CheckDeps;
  claimMode: ClaimMode;
  usePermit: boolean;
  /** Receives redacted lines only. */
  log?: LogFn;
  /** ms clock (default Date.now; the same as deps.now and the signer's). */
  now?: () => number;
  /** How waits happen (default: timers). */
  sleep?: SleepFn;
  /** Seconds each long-poll waits at the board (default 25; 0 polls plainly). */
  pollWaitS?: number;
  /** Runs at the start of run(), before anything else (createKit re-checks the board's keeper addresses there). */
  beforeRun?: () => Promise<void>;
}

/** Trades the price limit of buyUpTo/sellDownTo applies to (check 14). */
interface PriceLimit { side: 'buy' | 'sell'; price: bigint }

/**
 * The engine behind a Kit: one per kit (and per store). See the file
 * comment. createKit builds it; Kit forwards postOffer, cancelOffer,
 * repriceOffer, run and step to it.
 */
export class Engine {
  readonly network: Network;
  readonly cfg: Readonly<P2PNetConfig>;
  readonly session: BoardSession;
  readonly board: BoardClient;
  readonly store: KitStore;
  readonly deps: CheckDeps;
  readonly address: Readonly<{ pha: string; base: string }>;
  readonly claimMode: ClaimMode;
  readonly usePermit: boolean;
  readonly #signer: Signer;
  readonly #log: LogFn;
  readonly #now: () => number;
  readonly #sleep: SleepFn;
  readonly #pollWaitS: number;
  readonly #beforeRun: (() => Promise<void>) | null;
  #policy: ResolvedPolicy;
  /** First sight of a take on one of the bot's offers (check 16's clock), ms. */
  readonly #seen = new Map<number, number>();
  /** Takes the bot declined: a decline wins (check 16). */
  readonly #declined = new Set<number>();
  /** Price limits of the trades buyUpTo/sellDownTo took (check 14). */
  readonly #limits = new Map<number, PriceLimit>();
  /** Trades that must never be locked (a price past the order's limit), with why. */
  readonly #blocked = new Map<number, string>();
  /** When a buyer first saw its USDC claimed (claimWatchS counts from it), ms. */
  readonly #claimSeen = new Map<number, number>();
  /** One log line per repeated reason. */
  readonly #noted = new Map<string, string>();
  /** When each trade's next step is due, ms. */
  readonly #due = new Map<number, number>();
  /** One step per trade at a time. */
  readonly #chains = new Map<number, Promise<void>>();
  /** Trades one of the trade long-polls watches. */
  readonly #polled = new Set<number>();
  #running = false;
  /** Wakes the trade loop, and the instant lane, from their idle waits. */
  readonly #tradeAlarm: Alarm;
  readonly #laneAlarm: Alarm;
  /** The mode of each of the bot's offers, as kept (an offer's mode never changes): which trades the instant lane steps. */
  readonly #offerModes = new Map<number, OfferMode>();
  /** The instant lane's steps that are running, by trade. */
  readonly #laneSteps = new Map<number, Promise<void>>();
  /** The last accept queued: accepts run one at a time, whichever loop runs them (#committing). */
  #commitTail: Promise<void> = Promise.resolve();
  /** The seller's side of the bot's instant offers (flows/instant.ts). */
  readonly #instant: InstantSeller;

  constructor(o: EngineOptions) {
    if (o.network !== 'devnet' && o.network !== 'mainnet') throw flowError('BAD_INPUT', 'The network is devnet or mainnet.');
    if (!(o.session instanceof BoardSession) || o.session.network !== o.network) throw flowError('BAD_INPUT', 'The engine needs a board session of its network.');
    this.network = o.network;
    this.cfg = P2P_CONFIG[o.network];
    this.session = o.session;
    this.board = o.session.board;
    this.store = o.session.store;
    this.deps = o.deps;
    this.address = Object.freeze({ pha: o.address.pha, base: o.address.base.toLowerCase() });
    this.claimMode = o.claimMode;
    this.usePermit = o.usePermit;
    this.#signer = o.signer;
    this.#log = redactedLog(o.log);
    this.#now = o.now ?? Date.now;
    this.#sleep = o.sleep ?? realSleep;
    this.#tradeAlarm = new Alarm(this.#sleep);
    this.#laneAlarm = new Alarm(this.#sleep);
    this.#pollWaitS = typeof o.pollWaitS === 'number' && Number.isSafeInteger(o.pollWaitS) && o.pollWaitS >= 0 ? Math.min(o.pollWaitS, 25) : 25;
    this.#beforeRun = o.beforeRun ?? null;
    this.#policy = resolvePolicy(undefined, o.network);
    this.#instant = new InstantSeller({
      network: this.network, deps: this.deps, store: this.store, session: this.session, signer: this.#signer, log: this.#log,
      now: () => this.#now(),
      result: (rec, status, action, outcome, extra) => this.#result(rec, status, action, outcome, extra),
      refused: (rec, status, action, p, nextAt) => this.#refused(rec, status, action, p, nextAt),
      fromSign: (rec, status, action, e) => this.#fromSign(rec, status, action, e),
      fromSend: (rec, status, action, out) => this.#fromSend(rec, status, action, out),
      finish: (rec, status, why) => this.#finish(rec, status, why),
      keepStatus: (rec, t) => this.#keepStatus(rec, t),
      accept: (rec, trade) => this.#accept(rec, trade),
      waitBoard: (rec, trade, text) => this.#waitBoard(rec, trade, text),
      followSend: (rec, status, kind, open) => this.#followSend(rec, status, kind, open, true),
      refundPha: (rec, status) => this.#refundPha(rec, status),
      sellerPaid: (rec, trade, status, why) => this.#sellerPaid(rec, trade, status, why),
      flowProblem: (code, text, retry) => flowProblem(code, text, retry)
    });
  }

  /** The policy step() uses (the last one run() was given, else the defaults). */
  get policy(): ResolvedPolicy {
    return this.#policy;
  }

  /** Whether run() is running. */
  get running(): boolean {
    return this.#running;
  }

  #note(key: string, line: string): void {
    if (this.#noted.get(key) === line) return;
    this.#noted.set(key, line);
    this.#log(line);
  }

  // ── Offers ────────────────────────────────────────────────────────────────

  /**
   * Post an offer (build spec sections 6.3 and 6.4): checks 1, 2, 6, 7 and 8
   * before anything is sent; the control token kept before the POST
   * (BoardSession); then check 9 on the board's echo, cancelling an offer
   * listed differently (OFFER_ECHO). Amounts are whole units as decimal text.
   * An instant offer (section 3.10.5) also needs a sell, a network this
   * release runs instant trades on, a board whose /config says instant trades
   * are on, and an API key whose /me shows the instant flag
   * (MODE_NOT_SUPPORTED otherwise, nothing posted).
   * Returns the kept record.
   */
  async postOffer(o: OfferInput): Promise<LocalOffer> {
    const net = this.network;
    if (!o || typeof o !== 'object') throw flowError('BAD_INPUT', 'An offer is an object.');
    if (o.side !== 'sell' && o.side !== 'buy') throw flowError('BAD_INPUT', 'side is "sell" or "buy".');
    const p1 = checks.checkToken(o.symbol);
    if (p1) throw problemError(p1);
    if (o.mode !== undefined && o.mode !== 'standard' && o.mode !== 'instant') throw flowError('BAD_INPUT', 'mode is "standard" or "instant".');
    const instant = o.mode === 'instant';
    // Build spec section 3.10.5: an instant offer is a sell offer, on a network this release runs instant trades on,
    // posted with an API key the owner flagged instant. Refused here, before anything is sent.
    if (instant) {
      if (o.side !== 'sell') throw flowError('MODE_NOT_SUPPORTED', 'An instant offer is a sell offer: its buyer locks the USDC first, then this bot locks its tokens. Post a buy offer as a standard offer.');
      if (!instantTiming(net)) throw flowError('MODE_NOT_SUPPORTED', `This kit release posts instant offers on ${INSTANT_NETWORKS.join(' and ') || 'no network'} only, not on ${net}.`);
      if (!this.board.keyed) throw flowError('MODE_NOT_SUPPORTED', 'Instant offers need an API key the owner flagged for instant offers (pass it as apiKeyFile). Nothing was posted.');
    }
    const p2 = checks.pinned(net) ?? checks.baseDeployedProblem(net);
    if (p2) throw problemError(p2);
    const tok = tokenOf(o.symbol)!;
    const total = toRaw(o.total, tok.decimals, 'total');
    const min = toRaw(o.min, tok.decimals, 'min');
    const max = toRaw(o.max, tok.decimals, 'max');
    let price: bigint | null = null;
    let follow: FollowSettings | null = null;
    if (o.follow !== undefined && o.follow !== null) {
      if (o.price !== undefined) throw flowError('BAD_INPUT', 'Give a price or follow settings, not both.');
      const f = o.follow;
      if (typeof f !== 'object' || typeof f.offsetBps !== 'number' || !Number.isInteger(f.offsetBps) || Math.abs(f.offsetBps) > 2000) {
        throw flowError('BAD_INPUT', 'follow.offsetBps is a whole number of basis points from -2000 to 2000.');
      }
      const limit = usdcToRaw(f.limitPrice, 'follow.limitPrice');
      const daily = f.dailyMax === undefined ? total : toRaw(f.dailyMax, tok.decimals, 'follow.dailyMax');
      follow = { offsetBps: f.offsetBps, limitPrice: limit.toString(), dailyMax: daily.toString() };
    } else {
      price = usdcToRaw(o.price, 'price');
    }
    // Check 7 against the kit's own table; a following offer is checked at its limit price, the worst it trades at,
    // and as the site's form checks it (offset, the amount per day, the most one take may cost on this network).
    const p7 = checks.offerCheck(net, { symbol: tok.symbol, tazTotal: total, tazMin: min, tazMax: max, price: price ?? BigInt(follow!.limitPrice) });
    if (p7) throw problemError(p7);
    if (follow) this.#followCheck({ symbol: tok.symbol, side: o.side, tazTotal: total, tazMin: min, tazMax: max }, follow);
    // Check 8: the bot's own Base address is a wallet, never the swap contract or the token.
    const p8 = checks.baseAddressOk(net, this.address.base);
    if (p8) throw problemError(p8);
    if (instant) {
      // Off unless the board's /config says instant trades are on for this network. /config is display only: it can
      // add this refusal, never turn instant trades on where the kit's pins have them off (an older board, or one
      // where the owner has not listed the network, answers 404 INSTANT_OFF to the POST anyway).
      const c = await this.board.config({ maxRetryAfter: 10, retries: 2 });
      if (c.instant?.enabled !== true) throw flowError('MODE_NOT_SUPPORTED', `The board does not run instant trades on ${net} right now (its /config says they are off). Nothing was posted.`);
      // The board refuses an instant offer from a key without the flag (403 NOT_ELIGIBLE); the kit reads /me first and
      // refuses in plain words. A /config or /me that cannot be read throws its BoardError: nothing was posted.
      const me = await this.board.me({ maxRetryAfter: 10, retries: 2 });
      if (me.key?.instant !== true) throw flowError('MODE_NOT_SUPPORTED', 'This API key is not flagged for instant offers (the owner grants the flag to makers with a record). Nothing was posted.');
    }
    const body: NewOffer = {
      side: o.side, symbol: tok.symbol, makerPha: this.address.pha, makerBase: this.address.base,
      tazTotal: total.toString(), tazMin: min.toString(), tazMax: max.toString(),
      ...(follow ? { follow } : { price: price!.toString() }),
      ...(instant ? { mode: 'instant' as const } : {})
    };
    const posted = await this.session.postOffer(body, { acceptOnTheirOwn: o.acceptOnTheirOwn !== false, maxRetryAfter: 10 });
    const why = echoProblem(posted.offer, body);
    if (why) {
      // Check 9: listed differently from what was posted (another token, side, amount, maker or price): taken down at once.
      const id = posted.record.id;
      const down = await this.session.cancel(id, { retries: 2 }).then(() => true, () => false);
      if (!down) await this.store.patchOffer(id, { closedAt: this.#now() }).catch(() => undefined);
      this.#log(`[kit] ${net}: offer #${id} was listed differently from what was posted (${why}); ${down ? 'it was cancelled' : 'the cancel failed, and it stops being listed without heartbeats'}`);
      throw flowError('OFFER_ECHO', `The board listed offer #${id} differently from what was posted (${why}), so the kit ${down ? 'cancelled it' : 'stopped its heartbeats; it stops being listed within 90 seconds'}. Nothing was traded.`);
    }
    this.#log(`[kit] ${net}: ${instant ? 'instant ' : ''}offer #${posted.record.id} listed: ${o.side} ${amountText(total, tok.decimals)} ${tok.symbol} ${follow ? `following the reference price (${follow.offsetBps} bps, limit ${amountText(BigInt(follow.limitPrice), USDC_DECIMALS)} USDC)` : `at ${amountText(price!, USDC_DECIMALS)} USDC`}${instant ? ' (the buyer locks first)' : ''}`);
    this.#wakeUp();
    return posted.record;
  }

  /**
   * A market-following offer as the board takes it (section 2.4.6, the
   * site's followOfferProblem): the offset within ±20%, the amount per day
   * from the smallest trade to the total, and the largest trade at the limit
   * price no more than one take of such an offer may cost on this network
   * (FOLLOW_TAKE_USD_MAX). Throws OFFER_INVALID (check 7) before anything is
   * sent.
   */
  #followCheck(o: { symbol: string; side: Side; tazTotal: bigint; tazMin: bigint; tazMax: bigint }, f: FollowSettings): void {
    const why = followOfferProblem(
      { ...o, follow: { offsetBps: f.offsetBps, limitPrice: BigInt(f.limitPrice), dailyMax: BigInt(f.dailyMax ?? o.tazTotal) } },
      this.cfg.base, FOLLOW_TAKE_USD_MAX[this.network]
    );
    if (why) throw problemError(checks.problem('OFFER_INVALID', why));
  }

  /** Cancel one of the bot's offers (its token from the store) and record it closed. */
  async cancelOffer(offerId: number): Promise<void> {
    const id = needId(offerId, 'An offer id');
    if (!(await this.store.getOffer(id))) throw flowError('NOT_KEPT', `This kit keeps no offer #${id}.`);
    await this.session.cancel(id, { maxRetryAfter: 10 });
    this.#log(`[kit] ${this.network}: offer #${id} cancelled`);
  }

  /**
   * Change the price of one of the bot's offers (section 2.4.7): a fixed
   * price (decimal USDC per whole token), or new follow settings. A fixed
   * price joins the offer's price history before the board is asked, so a
   * take at it is one the bot agreed to (check 14, section 4.10).
   */
  async repriceOffer(offerId: number, change: { price: string } | { follow: { offsetBps: number; limitPrice: string; dailyMax?: string } }): Promise<Offer> {
    const id = needId(offerId, 'An offer id');
    const rec = await this.store.getOffer(id);
    if (!rec) throw flowError('NOT_KEPT', `This kit keeps no offer #${id}.`);
    if (!change || typeof change !== 'object') throw flowError('BAD_INPUT', 'A price change is { price } or { follow }.');
    if ('follow' in change && change.follow) {
      const f = change.follow;
      if (typeof f.offsetBps !== 'number' || !Number.isInteger(f.offsetBps) || Math.abs(f.offsetBps) > 2000) throw flowError('BAD_INPUT', 'follow.offsetBps is a whole number from -2000 to 2000.');
      const limit = usdcToRaw(f.limitPrice, 'follow.limitPrice');
      const p7 = checks.offerCheck(this.network, { symbol: rec.symbol, tazTotal: rec.tazTotal, tazMin: rec.tazMin, tazMax: rec.tazMax, price: limit });
      if (p7) throw problemError(p7);
      const daily = f.dailyMax === undefined ? undefined : tokenToRaw(rec.symbol, f.dailyMax, 'follow.dailyMax').toString();
      this.#followCheck({ symbol: rec.symbol, side: rec.side, tazTotal: BigInt(rec.tazTotal), tazMin: BigInt(rec.tazMin), tazMax: BigInt(rec.tazMax) },
        { offsetBps: f.offsetBps, limitPrice: limit.toString(), dailyMax: daily ?? rec.follow?.dailyMax ?? rec.tazTotal });
      return this.session.reprice(id, { follow: { offsetBps: f.offsetBps, limitPrice: limit.toString(), ...(daily ? { dailyMax: daily } : {}) } }, { maxRetryAfter: 15 });
    }
    if (!('price' in change)) throw flowError('BAD_INPUT', 'A price change is { price } or { follow }.');
    const price = usdcToRaw(change.price, 'price');
    const p7 = checks.offerCheck(this.network, { symbol: rec.symbol, tazTotal: rec.tazTotal, tazMin: rec.tazMin, tazMax: rec.tazMax, price });
    if (p7) throw problemError(p7);
    return this.session.reprice(id, { price: price.toString() }, { maxRetryAfter: 15 });
  }

  // ── Accept and decline ────────────────────────────────────────────────────

  /**
   * Accept a take on one of the bot's offers now, by the bot's own decision
   * (an offer posted with acceptOnTheirOwn: false). No wait and no check of
   * the other side's funds (the caller's call), but check 14, the open cap
   * and the bot's own readiness (as a buyer its USDC, as a seller the tokens
   * and reserves its lock needs) still refuse; a declined take stays declined.
   */
  async acceptTake(tradeId: number): Promise<Trade> {
    const id = needId(tradeId, 'A trade id');
    return this.#serial(id, async () => {
      const rec = await this.store.getTrade(id);
      if (!rec || !rec.maker) throw flowError('NOT_KEPT', `Trade #${id} is not a take on one of this kit's offers.`);
      if (this.#declined.has(id)) throw flowError('TAKE_DECLINED', `Trade #${id} was declined; a decline wins.`);
      const trade = await this.board.trade(id, STEP_CALL);
      const offer = await this.store.getOffer(rec.offerId);
      const c = await checks.acceptChecks(this.deps, trade, rec, { offer });
      if (!c.ok && HARD_ACCEPT.has(c.problem.code)) throw problemError(c.problem);
      if (!c.ok && c.problem.code === 'ACCEPT_REFUSED' && trade.status !== 'requested') throw problemError(c.problem);
      // One commit (#committing): the tokens this take adds are counted, and the board's accept kept, before any other
      // accept of this kit's counts them.
      const t = await this.#committing(async () => {
        if (rec.role === 'S') {
          // The seller's own part, as the automatic accept checks it: an accepted take the bot cannot lock is a no-show.
          const own = await this.#sellerFunds(rec.symbol, BigInt(rec.taz), rec.id);
          if (own) throw problemError(checks.problem('SELLER_FUNDS', `Take #${id} was not accepted: ${own}`, { retry: true }));
        }
        if (this.#declined.has(id)) throw flowError('TAKE_DECLINED', `Trade #${id} was declined; a decline wins.`);
        const accepted = await this.session.accept(id, STEP_CALL);
        await this.#keepStatus(rec, accepted);
        return accepted;
      });
      this.#log(`[kit] ${this.network}: trade #${id} accepted`);
      this.#wake(id);
      return t;
    });
  }

  /** Decline a take on one of the bot's offers (requested -> cancelled). A decline wins over a later accept (check 16). */
  async declineTake(tradeId: number): Promise<Trade> {
    const id = needId(tradeId, 'A trade id');
    this.#declined.add(id);
    return this.#serial(id, async () => {
      const rec = await this.store.getTrade(id);
      if (!rec || !rec.maker) throw flowError('NOT_KEPT', `Trade #${id} is not a take on one of this kit's offers.`);
      const t = await this.session.decline(id, STEP_CALL);
      await this.#keepStatus(rec, t);
      this.#log(`[kit] ${this.network}: trade #${id} declined`);
      return t;
    });
  }

  // ── Price limits (buyUpTo / sellDownTo) ───────────────────────────────────

  /** The limit an order of buyUpTo/sellDownTo set for a trade it took (check 14). */
  setPriceLimit(tradeId: number, limit: PriceLimit): void {
    this.#limits.set(tradeId, { side: limit.side, price: limit.price });
  }

  /** Make a trade due now (a take just made, or a change seen elsewhere) and wake run()'s trade loop. */
  wakeTrade(tradeId: number): void {
    this.#wake(tradeId);
  }

  /** Never lock this trade (a price past its order's limit). */
  block(tradeId: number, why: string): void {
    this.#blocked.set(tradeId, why);
  }

  /** Why this trade must not be locked (check 14's limit), or null. */
  #limitProblem(rec: LocalTrade, trade: Trade | null): Problem | null {
    const blocked = this.#blocked.get(rec.id);
    if (blocked) return limitProblem(blocked);
    const lim = this.#limits.get(rec.id);
    if (!lim) return null;
    const prices = [BigInt(rec.price), ...(trade ? [BigInt(trade.price)] : [])];
    const usdc = (p: bigint) => `${amountText(p, USDC_DECIMALS)} USDC`;
    if (lim.side === 'buy' && prices.some((p) => p > lim.price)) return limitProblem(`This trade's price is above the order's maximum price (${usdc(lim.price)}), so the kit never locks USDC for it.`);
    if (lim.side === 'sell' && prices.some((p) => p < lim.price)) return limitProblem(`This trade's price is below the order's minimum price (${usdc(lim.price)}), so the kit never locks tokens for it.`);
    return null;
  }

  // ── One step of one trade ─────────────────────────────────────────────────

  /**
   * Advance one trade once (build spec section 6.3): resolve its open
   * intents from the chains, read the board's trade, then do the one step
   * that is due (accept, lock, report, reveal, claim, refund, withdraw) or
   * say what it waits for. A `policy` given here replaces the engine's.
   */
  async step(tradeId: number, policy?: Policy): Promise<StepResult> {
    const id = needId(tradeId, 'A trade id');
    if (policy !== undefined) this.#policy = resolvePolicy(policy, this.network);
    return this.#serial(id, () => this.#stepOnce(id));
  }

  async #serial<T>(id: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.#chains.get(id) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    const tail = prev.then(() => mine);
    this.#chains.set(id, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.#chains.get(id) === tail) this.#chains.delete(id);
    }
  }

  #result(rec: Pick<LocalTrade, 'id'>, status: TradeStatus | null, action: StepAction, outcome: StepOutcome, extra: Partial<Omit<StepResult, 'tradeId' | 'action' | 'outcome' | 'status'>> = {}): StepResult {
    const now = this.#now();
    const nextAt = extra.nextAt ?? (outcome === 'done' ? now : outcome === 'pending' ? now + CHAIN_WAIT_MS : outcome === 'finished' ? Number.MAX_SAFE_INTEGER
      : outcome === 'waiting' ? now + (extra.waitingFor === 'board' ? BOARD_WAIT_MS : CHAIN_WAIT_MS) : now + (extra.retry ? RETRY_MS : STUCK_MS));
    return Object.freeze({ tradeId: rec.id, action, outcome, status, ...extra, nextAt });
  }

  #refused(rec: Pick<LocalTrade, 'id'>, status: TradeStatus | null, action: StepAction, p: Problem, nextAt?: number): StepResult {
    this.#note(`refuse:${rec.id}`, `[kit] ${this.network}: trade #${rec.id}: ${action} refused (${p.code}): ${p.text}`);
    return this.#result(rec, status, action, 'refused', { code: p.code, check: p.check, text: p.text, retry: p.retry, ...(nextAt ? { nextAt } : {}) });
  }

  #fromSign(rec: Pick<LocalTrade, 'id'>, status: TradeStatus | null, action: StepAction, e: SignRefusal): StepResult {
    this.#note(`refuse:${rec.id}`, `[kit] ${this.network}: trade #${rec.id}: the signer refused ${action} (${e.code}): ${e.detail}`);
    return this.#result(rec, status, action, 'refused', { code: e.code, check: e.check, text: e.detail, retry: e.retry });
  }

  #fromSend(rec: Pick<LocalTrade, 'id'>, status: TradeStatus | null, action: StepAction, out: SendResult): StepResult {
    const tx = out.txHash ? ` (${shortHex(out.txHash)})` : '';
    switch (out.outcome) {
      case 'confirmed':
        this.#log(`[kit] ${this.network}: trade #${rec.id}: ${action} confirmed${tx}`);
        return this.#result(rec, status, action, 'done', { txHash: out.txHash });
      case 'done_elsewhere':
        this.#log(`[kit] ${this.network}: trade #${rec.id}: ${action} was done by someone else first; the payee has it`);
        return this.#result(rec, status, action, 'done', { txHash: out.txHash, doneElsewhere: true, ...(out.reason ? { text: out.reason } : {}) });
      case 'pending':
        this.#log(`[kit] ${this.network}: trade #${rec.id}: ${action} sent${tx}; its outcome is not known yet`);
        return this.#result(rec, status, action, 'pending', { txHash: out.txHash, ...(out.reason ? { text: out.reason } : {}) });
      default:
        this.#log(`[kit] ${this.network}: trade #${rec.id}: ${action} failed${tx}: ${out.reason ?? 'refused on chain'}`);
        return this.#result(rec, status, action, 'failed', { txHash: out.txHash, text: out.reason ?? 'Refused on chain.', retry: true, nextAt: this.#now() + RETRY_MS });
    }
  }

  async #finish(rec: LocalTrade, status: TradeStatus | null, why: string): Promise<StepResult> {
    const patch = { endedAt: this.#now(), ...(status ? { status } : {}) };
    await this.store.patchTrade(rec.id, patch);
    this.#log(`[kit] ${this.network}: trade #${rec.id} finished: ${why}`);
    this.#seen.delete(rec.id);
    this.#claimSeen.delete(rec.id);
    return this.#result(rec, status, 'none', 'finished', { text: why });
  }

  async #keepStatus(rec: LocalTrade, t: Trade | null): Promise<LocalTrade> {
    if (!t || rec.status === t.status) return rec;
    return this.store.patchTrade(rec.id, { status: t.status });
  }

  async #stepOnce(id: number): Promise<StepResult> {
    let rec = await this.store.getTrade(id);
    if (!rec) {
      // A take on one of the bot's offers that no heartbeat brought yet (a custom loop): adopted as run() would (checks 15, 13).
      let t: Trade | null = null;
      try { t = await this.board.trade(id, STEP_CALL); } catch { /* not readable: not kept */ }
      if (t && (await this.store.getOffer(t.offerId)) && (await this.adopt(t))) rec = await this.store.getTrade(id);
      if (!rec) return this.#result({ id }, null, 'none', 'refused', { code: 'NOT_KEPT', check: null, text: `This kit keeps no trade #${id}.`, retry: false, nextAt: Number.MAX_SAFE_INTEGER });
    }
    if (rec.endedAt) return this.#result(rec, rec.status ?? null, 'none', 'finished', { text: 'This trade is finished for this kit.' });
    // Section 6.5: an intent with no outcome is resolved from the chains before anything is sent again.
    await this.#resolveIntents(rec);
    rec = (await this.store.getTrade(id))!;
    // The trade's mode is the kit's own record's: its offer's for a maker (instant offers are sells), standard for a take.
    const offer = rec.maker ? await this.store.getOffer(rec.offerId) : null;
    const instant = rec.role === 'S' && rec.maker && offer?.mode === 'instant';
    // An instant trade with its own lock recorded (h and T_P) needs the board only for the lock report: one short read,
    // so a board that does not answer never stretches its getState(h) watch past INSTANT_RULES.watchEvery.
    const watched = instant && !!rec.h && rec.t1 !== undefined;
    let raw: Trade | null = null;
    try {
      raw = await this.board.trade(id, watched ? WATCH_CALL : STEP_CALL);
    } catch (e) {
      this.#note(`board:${id}`, `[kit] ${this.network}: trade #${id}: the board could not be read (${errorText(e)}); only steps on the chains run`);
    }
    // Check 14 before anything leans on the board's word: a trade that does not fit (its mode included) is never
    // accepted, locked or reported.
    let mismatch: Problem | null = null;
    if (raw) {
      mismatch = checks.tradeMismatch(raw, rec, offer) ?? checks.modeMismatch(raw, instant ? 'instant' : 'standard');
      if (mismatch) this.#note(`mm:${id}`, `[kit] ${this.network}: trade #${id} does not fit what this kit agreed to (${mismatch.text}); nothing is accepted, locked or reported for it`);
      else rec = await this.#keepStatus(rec, raw);
    }
    const trade = mismatch ? null : raw;
    const status = raw?.status ?? null;
    if (instant) return this.#instant.step(rec, trade, raw, status, mismatch, offer);
    return rec.role === 'S' ? this.#seller(rec, trade, raw, status, mismatch) : this.#buyer(rec, trade, raw, status, mismatch);
  }

  // ── The seller (role S) ───────────────────────────────────────────────────

  async #seller(rec: LocalTrade, trade: Trade | null, raw: Trade | null, status: TradeStatus | null, mismatch: Problem | null): Promise<StepResult> {
    const ec = checks.escrowFor(this.network, rec.phaContract ?? null);
    if (!ec.ok) return this.#refused(rec, status, 'none', ec.problem);
    const cfg = ec.cfg;
    const bPha = rec.counterPha || trade?.buyer.pha || '';
    // This trade's own lock: under the recorded h, else under a kept secret (a lock sent but not reported before a crash).
    let h = rec.h ?? null;
    let lock: PhaLockRead | null = null;
    try {
      if (h) {
        lock = await this.deps.pha.readLock(cfg, h);
      } else {
        const kept = (await this.store.secretsOfTrade(rec.id)).filter((s) => s.role === 'S').reverse();
        for (const s of kept) {
          const l = await this.deps.pha.readLock(cfg, s.h);
          if (checks.isOurLock(l, rec, bPha)) { h = s.h; lock = l; break; }
        }
      }
    } catch {
      return this.#result(rec, status, 'none', 'waiting', { waitingFor: 'chain', text: 'Could not read Phantasma.', retry: true, nextAt: this.#now() + RETRY_MS });
    }

    if (!h || !lock) {
      // Nothing locked yet.
      const openLock = (await this.store.getJournal(rec.id)).intents.some((i) => i.kind === 'phaLock' && i.outcome === undefined);
      if (openLock) return this.#result(rec, status, 'lockPha', 'pending', { text: 'A Phantasma lock of this trade went out and its outcome is not known yet.' });
      // Check 14 for an order's limit first (buyUpTo/sellDownTo): a trade past it is never locked, whatever else the board says.
      const lim = this.#limitProblem(rec, raw);
      if (lim) return this.#refused(rec, status, rec.role === 'S' ? 'lockPha' : 'lockBase', lim);
      if (!trade) {
        if (mismatch) return this.#refused(rec, status, 'none', mismatch);
        return this.#result(rec, status, 'none', 'waiting', { waitingFor: 'board', text: 'The board could not be read.', retry: true });
      }
      if (trade.status === 'requested') {
        if (rec.maker) return this.#accept(rec, trade);
        return this.#waitBoard(rec, trade, 'Waiting for the maker to accept the take.');
      }
      if (trade.status === 'accepted') return this.#lockPha(rec, trade);
      if (TERMINAL.includes(trade.status)) return this.#finish(rec, trade.status, `the trade ended (${trade.status}) before this kit locked anything`);
      return this.#waitBoard(rec, trade, `The trade is at ${trade.status}.`);
    }

    // Locked under h, and the lock is this trade's own (or was, before it ended): recorded, and reported while the
    // board still waits for it. A report the board does not take yet never holds up a claim or a refund.
    let reported: StepResult | null = null;
    if (!rec.h || (lock.state === 1 && trade && !trade.h && trade.status === 'accepted')) {
      const r = await this.#reportPhaLock(rec, trade, h, null);
      // One action per step: a report that went through is this step's result (the next step follows at once).
      if (r.outcome === 'done' && lock.state === 1) return r;
      if (r.outcome !== 'done') reported = r;
      rec = (await this.store.getTrade(rec.id))!;
    }
    const bBase = rec.counterBase || trade?.buyer.base.toLowerCase() || '';
    // Every decision reads the newest block; the trade finishes only on a claim seen at the confirmed block (a claim
    // only the newest block shows may still be dropped by a reorg, and then the USDC must be claimed again).
    let swap: BaseSwap;
    let paidConfirmed = false;
    try {
      const r = await this.deps.base.readSwapConfirmed(h, bBase);
      swap = r.latest;
      paidConfirmed = r.confirmed.state === 2;
    } catch {
      return this.#result(rec, status, 'none', 'waiting', { waitingFor: 'chain', text: 'Could not read Base.', retry: true, nextAt: this.#now() + RETRY_MS });
    }
    const claimSeen = (why: string): Promise<StepResult> => (paidConfirmed
      ? this.#sellerPaid(rec, trade, status, why)
      : Promise.resolve(this.#result(rec, status, 'none', 'waiting', {
          waitingFor: 'chain', retry: true, nextAt: this.#now() + RETRY_MS,
          text: 'The USDC claim shows on Base but not at the confirmed block yet; the trade is finished once it is confirmed.'
        })));
    if (lock.state === 1) {
      if (swap.state === 2) return claimSeen('the USDC was claimed');
      // Past T1 (+ the keeper's grace) the buyer's USDC lock has ended too (T2 <= T1 - SAFETY), so it can no longer be
      // claimed: the tokens come back. Before that, a USDC lock in place is claimed (its own checks decide whether it may be).
      const refundAt = (lock.deadline + cfg.timing.phaRefundGrace) * 1000;
      if (this.#now() >= refundAt) return this.#refundPha(rec, status);
      if (swap.state === 1) return this.#sellerClaim(rec, trade, status, swap, false);
      if (reported) return reported;
      return this.#result(rec, status, 'none', 'waiting', {
        waitingFor: swap.state === 0 && trade && OTHER_SIDE.includes(trade.status) ? 'board' : 'time',
        text: swap.state === 0 ? 'Waiting for the buyer to lock the USDC (or for the time limit, then the tokens are refunded).' : 'The USDC lock was refunded; the tokens are refunded after their time limit.',
        nextAt: Math.min(refundAt, this.#now() + CHAIN_WAIT_MS)
      });
    }
    if (lock.state === 2) {
      // The buyer claimed the tokens, so the secret is public: the USDC is the seller's to claim.
      if (swap.state === 1) return this.#sellerClaim(rec, trade, status, swap, true);
      if (swap.state === 2) return claimSeen('both sides claimed');
      return this.#finish(rec, status, `the tokens were claimed and the USDC lock reads ${swap.state === 3 ? 'refunded' : 'empty'}; check this trade by hand`);
    }
    if (lock.state === 3) return this.#finish(rec, status, 'the tokens were refunded to this kit');
    return this.#result(rec, status, 'none', 'waiting', { waitingFor: 'chain', text: 'Phantasma does not show the lock yet.', retry: true, nextAt: this.#now() + RETRY_MS });
  }

  #waitBoard(rec: LocalTrade, trade: Trade, text: string): StepResult {
    const nextAt = this.#now() + (this.#polled.has(rec.id) ? POLLED_WAIT_MS : BOARD_WAIT_MS);
    return this.#result(rec, trade.status, 'none', 'waiting', { waitingFor: 'board', text, nextAt });
  }

  /** The seller's Phantasma lock: sellerLock (checks 18-34, the fee and escrow stored first), then the signer; then check 35. */
  async #lockPha(rec: LocalTrade, trade: Trade): Promise<StepResult> {
    const lim = this.#limitProblem(rec, trade);
    if (lim) return this.#refused(rec, trade.status, 'lockPha', lim);
    const r = await checks.sellerLock(this.deps, trade, rec);
    if (!r.ok) {
      // Our own lock already exists under this kit's secret: only reported (check 35), never locked again.
      if (r.problem.code === 'LOCKED_ALREADY' && r.problem.h) return this.#reportPhaLock(rec, trade, r.problem.h, null);
      return this.#refused(rec, trade.status, 'lockPha', r.problem);
    }
    let out: SendResult;
    try {
      out = await this.#signer.lockPha(r.intent);
    } catch (e) {
      if (e instanceof SignRefusal) {
        if (e.code === 'LOCKED_ALREADY' && e.h) return this.#reportPhaLock(rec, trade, e.h, null);
        return this.#fromSign(rec, trade.status, 'lockPha', e);
      }
      throw e;
    }
    if (out.outcome === 'confirmed') {
      this.#log(`[kit] ${this.network}: trade #${rec.id}: ${rec.symbol} locked on Phantasma (${shortHex(out.txHash)})`);
      return this.#reportPhaLock(rec, trade, r.intent.facts.h, out.txHash);
    }
    return this.#fromSend(rec, trade.status, 'lockPha', out);
  }

  /**
   * Check 35: read the lock under h; only when it is this trade's own lock
   * (made by the bot, paying the buyer, exactly the trade's token and amount)
   * are h, the escrow and T1 recorded, and then reported (POST /pha-locked),
   * only while the board's trade was read and matched the record (check 14;
   * `trade` is null otherwise).
   */
  async #reportPhaLock(rec: LocalTrade, trade: Trade | null, h: string, txHash: string | null): Promise<StepResult> {
    const status = trade?.status ?? rec.status ?? null;
    const ec = checks.escrowFor(this.network, rec.phaContract ?? null);
    if (!ec.ok) return this.#refused(rec, status, 'reportPhaLock', ec.problem);
    const bPha = rec.counterPha || trade?.buyer.pha || '';
    let lock: PhaLockRead;
    try {
      lock = await this.deps.pha.readLock(ec.cfg, h);
    } catch {
      return this.#result(rec, status, 'reportPhaLock', 'waiting', { waitingFor: 'chain', text: 'Could not read the lock on Phantasma.', retry: true, nextAt: this.#now() + RETRY_MS });
    }
    if (!checks.isOurLock(lock, rec, bPha)) {
      return this.#refused(rec, status, 'reportPhaLock', flowProblem('LOCK_NOT_OURS', lock.state === 0
        ? 'Phantasma does not show this trade\'s lock yet, so it is not reported.'
        : 'The lock under this hash is not this trade\'s own lock (sender, buyer, token or amount differ), so it is not reported.', lock.state === 0));
    }
    // Recorded before the report: the claim and the refund never need the board.
    rec = await this.store.patchTrade(rec.id, { h, phaContract: ec.cfg.phaContract, t1: lock.deadline });
    if (!trade) {
      // Check 14 before every action: the board's trade could not be read, or it does not match what this kit agreed
      // to, so nothing is reported to it. The next step reports once it reads and matches.
      return this.#result(rec, status, 'reportPhaLock', 'waiting', {
        waitingFor: 'board', retry: true, nextAt: this.#now() + RETRY_MS,
        text: 'The lock is recorded; it is reported once the board\'s trade can be read and matches what this kit agreed to.'
      });
    }
    if (trade.h || trade.status !== 'accepted') {
      // The board already holds a lock for it (or the trade moved on): nothing to report.
      return this.#result(rec, status, 'reportPhaLock', 'done', { text: 'The lock is recorded.' });
    }
    const tx = txHash ?? rec.txs.phaLock ?? undefined;
    try {
      const t = await this.session.phaLocked(rec.id, { h, ...(tx ? { txHash: tx.replace(/^0x/i, '') } : {}) }, STEP_CALL);
      await this.#keepStatus(rec, t);
      this.#log(`[kit] ${this.network}: trade #${rec.id}: the Phantasma lock ${shortHex(h)} was reported`);
      return this.#result(rec, t.status, 'reportPhaLock', 'done', { txHash: tx ?? null });
    } catch (e) {
      const be = e instanceof BoardError ? e : null;
      this.#note(`report:${rec.id}`, `[kit] ${this.network}: trade #${rec.id}: the board did not take the lock report yet (${errorText(e)}); it is sent again`);
      return this.#result(rec, status, 'reportPhaLock', 'failed', { code: be?.code ?? 'BOARD', text: errorText(e), retry: true, nextAt: this.#now() + (be?.retryAfter ? Math.min(be.retryAfter, 60) * 1000 : RETRY_MS) });
    }
  }

  /**
   * The seller's USDC: its own claim (claimMode 'self'), or the reveal first
   * and its own claim after CLAIM_WATCH. A claim of the kit's own that is not
   * mined is followed at its nonce first (#followSend). In
   * 'reveal-then-self', a reveal that cannot be made in time (the board
   * cannot be read or does not match, or the reveal's checks refuse) gives way
   * to the kit's own claim CLAIM_WATCH before the reveal's last moment (T2 -
   * REVEAL_MIN): the board never decides whether the seller is paid. Once the
   * tokens read claimed (`phaClaimed`) the secret is public: no reveal, the
   * kit claims at once.
   */
  async #sellerClaim(rec: LocalTrade, trade: Trade | null, status: TradeStatus | null, swap: BaseSwap, phaClaimed: boolean): Promise<StepResult> {
    const journal = await this.store.getJournal(rec.id);
    const open = openBaseSend(journal, 'claimBase');
    if (open) return this.#followSend(rec, status, 'claimBase', open);
    // A claim of its own already went out (and failed or was dropped): the secret is out, the kit claims again at once.
    const ownClaim = journal.intents.some((i) => i.kind === 'claimBase');
    if (this.claimMode === 'reveal-then-self' && !phaClaimed && !ownClaim) {
      const sentAt = rec.secretSentAt ?? rec.revealedAt;
      // The kit's own claim takes over from here when no reveal went out: check 60 runs 55-57 before it, and 55 needs
      // REVEAL_MIN left, so it starts CLAIM_WATCH earlier.
      const selfAt = (swap.deadline - this.cfg.timing.revealMin - this.cfg.timing.claimWatch) * 1000;
      if (sentAt == null && this.#now() < selfAt) {
        if (!trade) {
          return this.#result(rec, status, 'reveal', 'waiting', {
            waitingFor: 'board', retry: true, nextAt: Math.min(this.#now() + BOARD_WAIT_MS, selfAt),
            text: 'The secret is shared only through the board, which could not be read; the kit claims the USDC itself if it cannot share it in time.'
          });
        }
        const r = await checks.reveal(this.deps, trade, rec);
        if (!r.ok) return this.#refused(rec, status, 'reveal', r.problem, Math.min(this.#now() + (r.problem.retry ? RETRY_MS : STUCK_MS), selfAt));
        try {
          const out = await this.#signer.reveal(r.intent, (id, secret) => this.board.reveal(id, secret, STEP_CALL));
          return this.#fromSend(rec, status, 'reveal', out);
        } catch (e) {
          if (e instanceof SignRefusal) return this.#fromSign(rec, status, 'reveal', e);
          // The POST failed after secretSentAt was kept: the keeper may hold it; the kit's own claim follows after CLAIM_WATCH.
          this.#note(`reveal:${rec.id}`, `[kit] ${this.network}: trade #${rec.id}: the reveal got no clear answer (${errorText(e)}); this kit claims itself after ${this.cfg.timing.claimWatch} s`);
          return this.#result(rec, status, 'reveal', 'pending', { text: errorText(e) });
        }
      }
      // A reveal that went out: the keeper is given CLAIM_WATCH. None went out: no keeper holds the secret, no wait.
      const watchEnd = sentAt == null ? 0 : sentAt + this.cfg.timing.claimWatch * 1000;
      if (this.#now() < watchEnd) {
        return this.#result(rec, status, 'claimBase', 'waiting', { waitingFor: 'time', text: 'The keeper claims the USDC for this kit; the kit claims it itself if it has not by then.', nextAt: Math.min(watchEnd, this.#now() + CHAIN_WAIT_MS) });
      }
    }
    // Default claimMode 'self': the kit claims the USDC itself and never POSTs /reveal.
    const r = await checks.selfClaim(this.deps, rec);
    if (!r.ok) {
      if (r.problem.code === checks.DONE_ELSEWHERE) return this.#result(rec, status, 'claimBase', 'done', { doneElsewhere: true, text: r.problem.text });
      return this.#refused(rec, status, 'claimBase', r.problem, r.problem.retry ? this.#now() + RETRY_MS : undefined);
    }
    try {
      return this.#fromSend(rec, status, 'claimBase', await this.#signer.claimBase(r.intent));
    } catch (e) {
      if (e instanceof SignRefusal) return this.#fromSign(rec, status, 'claimBase', e);
      throw e;
    }
  }

  /** The USDC is claimed: withdraw a deferred payout (check 65), else the seller is done. */
  async #sellerPaid(rec: LocalTrade, trade: Trade | null, status: TradeStatus | null, why: string): Promise<StepResult> {
    const open = openBaseSend(await this.store.getJournal(rec.id), 'withdrawOwed');
    if (open) return this.#followSend(rec, status, 'withdrawOwed', open);
    let owed = 0n;
    try {
      owed = await this.deps.base.readOwed(rec.myBase);
    } catch {
      return this.#result(rec, status, 'withdrawOwed', 'waiting', { waitingFor: 'chain', text: 'Could not read what SaturnSwap owes this address.', retry: true, nextAt: this.#now() + RETRY_MS });
    }
    if (owed > 0n) {
      const r = await checks.withdrawOwed(this.deps, rec);
      if (!r.ok) return this.#refused(rec, status, 'withdrawOwed', r.problem);
      try {
        return this.#fromSend(rec, status, 'withdrawOwed', await this.#signer.withdrawOwed(r.intent));
      } catch (e) {
        if (e instanceof SignRefusal) return this.#fromSign(rec, status, 'withdrawOwed', e);
        throw e;
      }
    }
    return this.#finish(rec, trade ? trade.status : null, why);
  }

  async #refundPha(rec: LocalTrade, status: TradeStatus | null): Promise<StepResult> {
    const wait = await this.#phaInFlight(rec, status, 'refundPha');
    if (wait) return wait;
    const r = await checks.refundPha(this.deps, rec);
    if (!r.ok) {
      if (r.problem.code === checks.DONE_ELSEWHERE) return this.#result(rec, status, 'refundPha', 'done', { doneElsewhere: true, text: r.problem.text });
      return this.#refused(rec, status, 'refundPha', r.problem);
    }
    try {
      return this.#fromSend(rec, status, 'refundPha', await this.#signer.refundPha(r.intent));
    } catch (e) {
      if (e instanceof SignRefusal) return this.#fromSign(rec, status, 'refundPha', e);
      throw e;
    }
  }

  // ── The buyer (role B) ────────────────────────────────────────────────────

  async #buyer(rec: LocalTrade, trade: Trade | null, raw: Trade | null, status: TradeStatus | null, mismatch: Problem | null): Promise<StepResult> {
    // h is stored before the USDC lock is signed (check 48): without it, nothing of the bot's is locked on Base.
    const h = rec.h ?? null;
    let swap: BaseSwap | null = null;
    if (h) {
      try {
        swap = (await this.deps.base.readSwap(h, rec.myBase)).swap;
      } catch {
        return this.#result(rec, status, 'none', 'waiting', { waitingFor: 'chain', text: 'Could not read Base.', retry: true, nextAt: this.#now() + RETRY_MS });
      }
    }
    if (!swap || swap.state === 0) {
      const openLock = (await this.store.getJournal(rec.id)).intents.some((i) => (i.kind === 'baseLock' || i.kind === 'approve') && i.outcome === undefined);
      if (openLock) return this.#result(rec, status, 'lockBase', 'pending', { text: 'A USDC lock of this trade went out and its outcome is not known yet.' });
      // Check 14 for an order's limit first (buyUpTo/sellDownTo): a trade past it is never locked, whatever else the board says.
      const lim = this.#limitProblem(rec, raw);
      if (lim) return this.#refused(rec, status, rec.role === 'S' ? 'lockPha' : 'lockBase', lim);
      if (!trade) {
        if (mismatch) return this.#refused(rec, status, 'none', mismatch);
        return this.#result(rec, status, 'none', 'waiting', { waitingFor: 'board', text: 'The board could not be read.', retry: true });
      }
      if (trade.status === 'requested') {
        if (rec.maker) return this.#accept(rec, trade);
        return this.#waitBoard(rec, trade, 'Waiting for the maker to accept the take.');
      }
      if (trade.status === 'accepted') return this.#waitBoard(rec, trade, `Waiting for the seller to lock the ${rec.symbol}.`);
      if (trade.status === 'pha_locked') return this.#lockBase(rec, trade);
      if (TERMINAL.includes(trade.status)) return this.#finish(rec, trade.status, `the trade ended (${trade.status}) before this kit locked any USDC`);
      return this.#waitBoard(rec, trade, `The trade is at ${trade.status}.`);
    }
    const cfg = this.cfg;
    if (swap.state === 1) {
      const refundAt = (swap.deadline + cfg.timing.baseRefundGrace) * 1000;
      if (this.#now() >= refundAt) return this.#refundBase(rec, status);
      // Our USDC is locked. The board learns of it from this kit's report (a refused report never holds up the refund above).
      if (trade && trade.status === 'pha_locked' && rec.txs.baseLock) {
        return this.#reportBaseLock(rec, trade, rec.txs.baseLock);
      }
      return this.#result(rec, status, 'none', 'waiting', { waitingFor: 'chain', text: 'Waiting for the seller to claim the USDC (or for the time limit, then the USDC is refunded).', nextAt: Math.min(refundAt, this.#now() + CHAIN_WAIT_MS) });
    }
    if (swap.state === 3) return this.#finish(rec, status, 'the USDC was refunded to this kit');
    // swap.state 2: the seller claimed the USDC, so the secret is public; the tokens are the bot's to claim.
    const ec = checks.escrowFor(this.network, rec.phaContract ?? null);
    if (!ec.ok) return this.#refused(rec, status, 'claimPha', ec.problem);
    let lock: PhaLockRead;
    try {
      lock = await this.deps.pha.readLock(ec.cfg, h!);
    } catch {
      return this.#result(rec, status, 'claimPha', 'waiting', { waitingFor: 'chain', text: 'Could not read Phantasma.', retry: true, nextAt: this.#now() + RETRY_MS });
    }
    if (lock.state === 2) return this.#finish(rec, status, `the ${rec.symbol} was claimed for this kit`);
    if (lock.state === 3) return this.#finish(rec, status, `the USDC was claimed but the ${rec.symbol} went back to the seller; check this trade by hand`);
    if (lock.state !== 1) return this.#result(rec, status, 'claimPha', 'waiting', { waitingFor: 'chain', text: 'Phantasma does not show the lock.', retry: true, nextAt: this.#now() + RETRY_MS });
    const now = this.#now();
    const first = this.#claimSeen.get(rec.id) ?? now;
    this.#claimSeen.set(rec.id, first);
    // The keeper is waited for claimWatchS at most, and never closer than CLAIM_MARGIN to T1: the bot's own claim
    // must still land before the lock ends (check 62 refuses within 60 s of T1, and then the tokens go back to the seller).
    const watchEnd = Math.min(first + this.#policy.claimWatchS * 1000, (lock.deadline - ec.cfg.timing.claimMargin) * 1000);
    if (now < watchEnd) {
      return this.#result(rec, status, 'claimPha', 'waiting', { waitingFor: 'time', text: `The keeper claims the ${rec.symbol} for this kit; the kit claims it itself if it has not by then.`, nextAt: Math.min(watchEnd, now + CHAIN_WAIT_MS) });
    }
    const wait = await this.#phaInFlight(rec, status, 'claimPha');
    if (wait) return wait;
    const r = await checks.claimPhaFor(this.deps, rec);
    if (!r.ok) {
      if (r.problem.code === checks.DONE_ELSEWHERE) return this.#result(rec, status, 'claimPha', 'done', { doneElsewhere: true, text: r.problem.text });
      return this.#refused(rec, status, 'claimPha', r.problem);
    }
    try {
      return this.#fromSend(rec, status, 'claimPha', await this.#signer.claimPha(r.intent));
    } catch (e) {
      if (e instanceof SignRefusal) return this.#fromSign(rec, status, 'claimPha', e);
      throw e;
    }
  }

  /** The buyer's USDC lock: buyerLock (checks 36-48, h, escrow, T1 and T2 stored first), then the signer; then the report. */
  async #lockBase(rec: LocalTrade, trade: Trade): Promise<StepResult> {
    const lim = this.#limitProblem(rec, trade);
    if (lim) return this.#refused(rec, trade.status, 'lockBase', lim);
    const r = await checks.buyerLock(this.deps, trade, rec, { usePermit: this.usePermit, lockWithLowKcal: this.#policy.lockWithLowKcal });
    if (!r.ok) {
      // This kit's own USDC lock already exists: only reported, never locked again.
      if (r.problem.code === 'USDC_LOCKED_ALREADY' && r.problem.txHash) return this.#reportBaseLock(rec, trade, r.problem.txHash);
      return this.#refused(rec, trade.status, 'lockBase', r.problem);
    }
    let out: SendResult;
    try {
      out = await this.#signer.lockBase(r.intent);
    } catch (e) {
      if (e instanceof SignRefusal) {
        if (e.code === 'USDC_LOCKED_ALREADY' && e.txHash) return this.#reportBaseLock(rec, trade, e.txHash);
        return this.#fromSign(rec, trade.status, 'lockBase', e);
      }
      throw e;
    }
    if (out.outcome === 'confirmed' && out.txHash) {
      this.#log(`[kit] ${this.network}: trade #${rec.id}: USDC locked on Base (${shortHex(out.txHash)})`);
      return this.#reportBaseLock((await this.store.getTrade(rec.id)) ?? rec, trade, out.txHash);
    }
    return this.#fromSend(rec, trade.status, 'lockBase', out);
  }

  /** POST /base-locked with the lock's transaction. */
  async #reportBaseLock(rec: LocalTrade, trade: Trade, txHash: string | null): Promise<StepResult> {
    if (!txHash) {
      return this.#result(rec, trade.status, 'reportBaseLock', 'refused', { code: 'NO_TX', check: null, text: 'This kit keeps no transaction of its USDC lock to report; the board learns of it from the chain or not at all.', retry: false });
    }
    try {
      const t = await this.session.baseLocked(rec.id, { txHash }, STEP_CALL);
      await this.#keepStatus(rec, t);
      this.#log(`[kit] ${this.network}: trade #${rec.id}: the USDC lock was reported`);
      return this.#result(rec, t.status, 'reportBaseLock', 'done', { txHash });
    } catch (e) {
      const be = e instanceof BoardError ? e : null;
      this.#note(`report:${rec.id}`, `[kit] ${this.network}: trade #${rec.id}: the board did not take the USDC lock report yet (${errorText(e)}); it is sent again`);
      return this.#result(rec, trade.status, 'reportBaseLock', 'failed', { code: be?.code ?? 'BOARD', text: errorText(e), retry: true, nextAt: this.#now() + (be?.retryAfter ? Math.min(be.retryAfter, 60) * 1000 : RETRY_MS) });
    }
  }

  async #refundBase(rec: LocalTrade, status: TradeStatus | null): Promise<StepResult> {
    const open = openBaseSend(await this.store.getJournal(rec.id), 'refundBase');
    if (open) return this.#followSend(rec, status, 'refundBase', open);
    const r = await checks.refundBase(this.deps, rec);
    if (!r.ok) {
      if (r.problem.code === checks.DONE_ELSEWHERE) return this.#result(rec, status, 'refundBase', 'done', { doneElsewhere: true, text: r.problem.text });
      return this.#refused(rec, status, 'refundBase', r.problem);
    }
    try {
      return this.#fromSend(rec, status, 'refundBase', await this.#signer.refundBase(r.intent));
    } catch (e) {
      if (e instanceof SignRefusal) return this.#fromSign(rec, status, 'refundBase', e);
      throw e;
    }
  }

  // ── Sends not mined yet (one per step in flight) ──────────────────────────

  /**
   * A claim, refund or withdrawal of this trade that went out and is not
   * settled (checks 51 and 61): a new one at the next nonce could not be
   * mined before it, so it is followed at its own nonce instead. While that
   * nonce is not used:
   *   - once REPLACE_AFTER has passed since the newest send there, and while
   *     the step's checks still pass, it is replaced with the same step at
   *     that nonce, fees 25% higher (under the pinned caps);
   *   - when the checks refuse for good (a claim too close to its deadline,
   *     which mined late would publish the secret in a failed transaction;
   *     a refund or withdrawal no longer due), the nonce is taken back with
   *     a 0-value transfer, again higher after REPLACE_AFTER while none is
   *     mined.
   * Whichever transaction is mined settles the journal intent (#baseTx).
   * An instant trade's claim (`instant`) is re-checked with instantClaim:
   * the Phantasma lock still claimed, and at least 60 s left on the USDC
   * lock, not CLAIM_MARGIN. Its secret is already public, so one that may no
   * longer be replaced is still left in flight until T_B (it can only be
   * mined in time or revert); its nonce is taken back only after T_B.
   */
  async #followSend(rec: LocalTrade, status: TradeStatus | null, kind: FollowedKind, open: Intent, instant = false): Promise<StepResult> {
    const now = this.#now();
    const what = kind === 'claimBase' ? 'USDC claim' : kind === 'refundBase' ? 'USDC refund' : 'payout withdrawal';
    if (!(open.hashes?.length || open.txHash)) {
      // Recorded, but no transaction known (a crash around the send): settled from the chain first (#baseTx).
      return this.#result(rec, status, kind, 'pending', { text: `A ${what} of this trade was about to go out at nonce ${open.nonce}; it is settled from the chain before anything is sent again.` });
    }
    let latest: number;
    try {
      latest = await this.deps.base.client.nonce(this.address.base as Hex, 'latest');
    } catch {
      return this.#result(rec, status, kind, 'waiting', { waitingFor: 'chain', text: 'Could not read Base.', retry: true, nextAt: now + RETRY_MS });
    }
    if (latest > open.nonce!) {
      return this.#result(rec, status, kind, 'pending', { text: `The nonce of this trade's ${what} is used; it is settled from the chain at the next step.`, nextAt: now + RETRY_MS });
    }
    const dueAt = (open.lastSentAt ?? open.sentAt ?? open.at) + REPLACE_AFTER_MS;
    const cancelling = !!open.cancelHashes?.length;
    const r: CheckResult<FollowedKind> = cancelling ? { ok: false, problem: checks.problem('SEND_IN_FLIGHT', 'A cancel was sent at this nonce.') }
      : kind === 'claimBase' ? await (instant ? checks.instantClaim(this.deps, rec, { follow: open }) : checks.selfClaim(this.deps, rec, { follow: open }))
      : kind === 'refundBase' ? await checks.refundBase(this.deps, rec, { follow: open })
      : await checks.withdrawOwed(this.deps, rec, { follow: open });
    if (r.ok) {
      if (now < dueAt) {
        return this.#result(rec, status, kind, 'pending', {
          txHash: open.txHash ?? null, nextAt: Math.min(dueAt, now + CHAIN_WAIT_MS),
          text: `This trade's ${what} is not mined yet; it is replaced at its nonce (${open.nonce}) with higher fees if it still is not by then.`
        });
      }
      try {
        const out = kind === 'claimBase' ? await this.#signer.claimBase(r.intent as Parameters<Signer['claimBase']>[0])
          : kind === 'refundBase' ? await this.#signer.refundBase(r.intent as Parameters<Signer['refundBase']>[0])
          : await this.#signer.withdrawOwed(r.intent as Parameters<Signer['withdrawOwed']>[0]);
        return this.#fromSend(rec, status, kind, out);
      } catch (e) {
        if (e instanceof SignRefusal) return { ...this.#fromSign(rec, status, kind, e), nextAt: now + RETRY_MS };
        throw e;
      }
    }
    // A read that failed, or a time not come: the send stays in flight, untouched.
    if (!cancelling && r.problem.retry && r.problem.code !== checks.DONE_ELSEWHERE) return this.#refused(rec, status, kind, r.problem, now + RETRY_MS);
    // An instant claim spends a secret that is already public on Phantasma (section 3.10.3 step 4): mined late, it only
    // reverts. So while the USDC lock (T_B, kept as t2) has not ended, a claim in flight is left to be mined in time
    // even when no new one may go out (under 60 s left); only after T_B is its nonce taken back.
    if (instant && kind === 'claimBase' && !cancelling && r.problem.code !== checks.DONE_ELSEWHERE && rec.t2 !== undefined && now < rec.t2 * 1000) {
      return this.#result(rec, status, kind, 'pending', {
        txHash: open.txHash ?? null, nextAt: Math.min(rec.t2 * 1000, now + CHAIN_WAIT_MS),
        text: `This trade's USDC claim at nonce ${open.nonce} is not mined yet (${r.problem.text}). Its secret is already public, so it is left to be mined before the USDC lock ends; its nonce is taken back only after that.`
      });
    }
    // The step may no longer go through (or the chain shows it done): its nonce is taken back.
    if (cancelling && now < dueAt) {
      return this.#result(rec, status, 'cancelBase', 'pending', { text: `The nonce of this trade's ${what} is being taken back by a 0-value transfer; it is sent again higher if neither is mined.`, nextAt: Math.min(dueAt, now + CHAIN_WAIT_MS) });
    }
    if (!cancelling) this.#log(`[kit] ${this.network}: trade #${rec.id}: the ${what} at nonce ${open.nonce} is not mined and may no longer go through (${r.problem.text}); its nonce is taken back`);
    const c = await checks.cancelBase(this.deps, rec, open.id);
    if (!c.ok) return this.#refused(rec, status, 'cancelBase', c.problem, now + RETRY_MS);
    try {
      return this.#fromSend(rec, status, 'cancelBase', await this.#signer.cancelBase(c.intent));
    } catch (e) {
      if (e instanceof SignRefusal) return { ...this.#fromSign(rec, status, 'cancelBase', e), nextAt: now + RETRY_MS };
      throw e;
    }
  }

  /**
   * A Phantasma claim or refund of this trade that went out and is not
   * settled: nothing is sent again while it may still run (Phantasma has no
   * nonce to replace it at; #resolveIntents settles it from the chain).
   */
  async #phaInFlight(rec: LocalTrade, status: TradeStatus | null, kind: 'claimPha' | 'refundPha'): Promise<StepResult | null> {
    const open = (await this.store.getJournal(rec.id)).intents.find((i) => i.kind === kind && i.outcome === undefined);
    if (!open) return null;
    return this.#result(rec, status, kind, 'pending', { txHash: open.txHash ?? null, text: `This trade's ${kind === 'claimPha' ? 'claim' : 'refund'} on Phantasma went out and is not settled yet; nothing is sent again until it is.` });
  }

  // ── Accepting a take on the bot's own offer ───────────────────────────────

  /** When this take was first seen (its accept clock starts on the first call). */
  #seenAt(id: number): number {
    const first = this.#seen.get(id);
    if (first != null) return first;
    const now = this.#now();
    this.#seen.set(id, now);
    return now;
  }

  /**
   * Check 16 and the accept (section 6.4 C; accepting signs nothing): the
   * take seen for acceptAfterS and not declined; the offer accepts on its own
   * and has room for another running trade; the bot can do its own part (a
   * seller's funds); check 17 (check 14, the open cap, the bot's readiness as
   * a buyer, and the other side's funds); then the policy decides.
   */
  async #accept(rec: LocalTrade, trade: Trade): Promise<StepResult> {
    const id = rec.id;
    if (this.#declined.has(id)) {
      return this.#result(rec, trade.status, 'accept', 'refused', { code: 'TAKE_DECLINED', check: FLOW_CODES.TAKE_DECLINED, text: 'This take was declined; a decline wins.', retry: false });
    }
    const policy = this.#policy;
    const dueAt = this.#seenAt(id) + policy.acceptAfterS * 1000;
    if (this.#now() < dueAt) {
      return this.#result(rec, trade.status, 'accept', 'refused', {
        code: 'ACCEPT_TOO_SOON', check: FLOW_CODES.ACCEPT_TOO_SOON, retry: true, nextAt: dueAt,
        text: `This take is accepted only once it has been seen for ${policy.acceptAfterS} s, so it can still be declined.`
      });
    }
    const offer = await this.store.getOffer(rec.offerId);
    const held = (text: string, code = 'ACCEPT_HELD'): StepResult => {
      this.#note(`held:${id}`, `[kit] ${this.network}: take #${id} is not accepted on its own: ${text}`);
      return this.#result(rec, trade.status, 'accept', 'waiting', { waitingFor: 'board', code, check: null, text, nextAt: this.#now() + BOARD_WAIT_MS });
    };
    if (!offer) return held('this kit keeps no record of its offer.');
    if (!offer.acceptOnTheirOwn) return held('accepting takes on their own is off for this offer. Accept or decline it with acceptTake or declineTake.');
    const room = await this.#acceptRoom(rec, offer, policy);
    if (room) return held(room);
    const c = await checks.acceptChecks(this.deps, trade, rec, { offer });
    if (!c.ok && HARD_ACCEPT.has(c.problem.code)) return this.#refused(rec, trade.status, 'accept', c.problem, this.#now() + BOARD_WAIT_MS);
    let yes: boolean;
    try {
      yes = policy.accept ? (await policy.accept(structuredClone(trade), { offer, checks: c })) === true : c.ok;
    } catch (e) {
      this.#note(`policy:${id}`, `[kit] ${this.network}: Policy.accept threw for take #${id} (${errorText(e)}); it is not accepted`);
      yes = false;
    }
    if (!yes) return held(c.ok ? 'the policy did not accept it.' : `${c.problem.text}`);
    // One commit (#committing): the open trades and the tokens are counted again, and the board's accept is kept, before
    // any other accept of this kit's (the instant lane runs beside the trade loop) counts them.
    return this.#committing(async () => {
      const again = await this.#acceptRoom(rec, offer, policy);
      if (again) return held(again);
      // Declined while the checks read the chains: not accepted.
      if (this.#declined.has(id)) return this.#result(rec, trade.status, 'accept', 'refused', { code: 'TAKE_DECLINED', check: FLOW_CODES.TAKE_DECLINED, text: 'This take was declined; a decline wins.', retry: false });
      try {
        const t = await this.session.accept(id, STEP_CALL);
        await this.#keepStatus(rec, t);
        this.#log(`[kit] ${this.network}: take #${id} on offer #${offer.id} accepted (${amountText(BigInt(rec.taz), tokenOf(rec.symbol)!.decimals)} ${rec.symbol})`);
        return this.#result(rec, t.status, 'accept', 'done');
      } catch (e) {
        const be = e instanceof BoardError ? e : null;
        return this.#result(rec, trade.status, 'accept', 'failed', { code: be?.code ?? 'BOARD', text: errorText(e), retry: be ? be.retryable : true, nextAt: this.#now() + RETRY_MS });
      }
    });
  }

  /**
   * Why a take on `offer` cannot be accepted now as far as this kit's own
   * side goes, or null: the offer's running trades (Policy.maxOpenTrades),
   * and as the seller the tokens and the KCAL or SOUL reserve its lock needs
   * on top of its other trades (otherwise the bot would not lock and would
   * count as a no-show).
   */
  async #acceptRoom(rec: LocalTrade, offer: LocalOffer, policy: ResolvedPolicy): Promise<string | null> {
    const open = (await this.store.listTrades()).filter((t) => t.maker && t.offerId === offer.id && t.id !== rec.id && !t.endedAt && RUNNING.includes(t.status ?? '')).length;
    if (open >= policy.maxOpenTrades) return `the offer already has ${open} running trades (maxOpenTrades ${policy.maxOpenTrades}).`;
    return rec.role === 'S' ? this.#sellerFunds(rec.symbol, BigInt(rec.taz), rec.id) : null;
  }

  /**
   * Run `fn` as one commit of this kit's tokens: an accept, from its counts
   * (the offer's running trades, the tokens the bot's other trades still
   * need) to the board's answer kept in the store. Accepts run one at a
   * time, whichever loop runs them (the trade loop, the instant lane, or
   * acceptTake), so two takes never count the same room. Never nested.
   */
  async #committing<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.#commitTail;
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    this.#commitTail = prev.then(() => mine);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Why the bot's own Phantasma address cannot lock `amount` of `symbol` with
   * its reserves, on top of what its other trades as the seller still need
   * (sellerCommitted, without trade `exceptTradeId`), or null.
   */
  async #sellerFunds(symbol: string, amount: bigint, exceptTradeId: number | null = null): Promise<string | null> {
    // The other trades' share first, then the balance: a lock that lands in between (the instant lane locks beside the
    // trade loop) is then counted twice, in the share and gone from the balance, and never not at all.
    const committed = await this.sellerCommitted(symbol, exceptTradeId);
    let bal;
    try {
      bal = await this.deps.pha.balances(this.address.pha);
    } catch {
      return 'this kit\'s Phantasma balances could not be read.';
    }
    const soul = balanceOf(bal, 'SOUL');
    if (soul == null || soul < SOUL_RESERVE) return `this kit's Phantasma address keeps less than ${amountText(SOUL_RESERVE, 8)} SOUL free for Phantasma's fees.`;
    const why = checks.sellerFundsProblem(this.cfg, bal, symbol, amount + committed, 'this kit\'s Phantasma address');
    if (!why || committed === 0n) return why;
    const t = tokenOf(symbol)!;
    return `${why} (${amountText(committed, t.decimals)} ${t.symbol} of it is for this kit's other trades that are not locked yet.)`;
  }

  /**
   * The tokens of `symbol` this kit's own trades as the seller still need
   * from its balance (the seller's side of the sum of section 2.3.5): every
   * record where the kit is S whose tokens are not locked yet and that is
   * accepted (or, on an instant offer, base_locked: the buyer locked first),
   * or is a take the kit made that waits for the maker's accept. Without
   * `exceptTradeId`. An accepted take the bot could not lock would count as
   * its no-show.
   */
  async sellerCommitted(symbol: string, exceptTradeId: number | null = null): Promise<bigint> {
    let sum = 0n;
    for (const r of await this.store.listTrades()) {
      if (r.role !== 'S' || r.symbol !== symbol || r.myPha !== this.address.pha || r.endedAt || r.id === exceptTradeId) continue;
      if (r.h) {
        // A standard lock records h once it is on chain. An instant trade records the buyer's h right before the kit
        // signs its lock, and its T_P once the lock reads on chain as its own: its tokens count until then (a lock that
        // was sent may not have landed yet when the balance is read).
        const instant = r.maker && (await this.store.getOffer(r.offerId))?.mode === 'instant';
        if (!instant || r.t1 !== undefined) continue;
      }
      if (r.status === 'accepted' || r.status === 'base_locked' || (!r.maker && (r.status === 'requested' || r.status === undefined))) sum += BigInt(r.taz);
    }
    return sum;
  }

  // ── Takes on the bot's offers (heartbeat answers) ─────────────────────────

  /**
   * Adopt a take on one of the bot's offers: check 15 (adoptTake: it fits the
   * offer exactly) and check 13 (keepTrade: the id is not another trade's).
   * A take that does not fit is never kept or accepted; while it waits for
   * an answer it is declined. Returns whether a new record was kept.
   */
  async adopt(t: Trade): Promise<boolean> {
    if (await this.store.getTrade(t.id)) return false;
    const offer = await this.store.getOffer(t.offerId);
    if (!offer) return false;
    const a = checks.adoptTake(t, offer, this.#now());
    if (!a.ok) {
      this.#note(`adopt:${t.id}`, `[kit] ${this.network}: take #${t.id} on offer #${offer.id} does not fit the offer (${a.problem.text})`);
      if (t.status === 'requested' && !this.#declined.has(t.id)) {
        this.#declined.add(t.id);
        await this.board.decline(t.id, offer.makerToken, STEP_CALL).then(
          () => this.#log(`[kit] ${this.network}: take #${t.id} declined (it does not fit the offer)`),
          (e) => this.#log(`[kit] ${this.network}: take #${t.id} could not be declined (${errorText(e)}); it times out unanswered`)
        );
      }
      return false;
    }
    const k = await checks.keepTrade(this.store, a.record);
    if (!k.ok) {
      this.#note(`adopt:${t.id}`, `[kit] ${this.network}: take #${t.id}: ${k.problem.text}`);
      return false;
    }
    this.#seenAt(t.id);
    this.#log(`[kit] ${this.network}: take #${t.id} on offer #${offer.id}: ${amountText(BigInt(a.record.taz), tokenOf(a.record.symbol)!.decimals)} ${a.record.symbol} at ${amountText(BigInt(a.record.price), USDC_DECIMALS)} USDC`);
    this.#wake(t.id);
    return true;
  }

  // ── Resume (section 6.5) ──────────────────────────────────────────────────

  /**
   * What run() does first, before any new send: ask the board about every
   * pending create (replayOnly only to a board that keeps client hashes, as
   * the GET /recent probe tells), then resolve every open intent of every
   * running trade from the chains.
   */
  async resume(signal?: AbortSignal): Promise<{ recorded: number; resolved: number; open: number }> {
    let recorded = 0;
    try {
      const rep = await this.session.reconcilePending({ signal });
      recorded = rep.recorded.length;
      for (const r of rep.recorded) if (r.kind === 'take') this.#wake(r.id);
    } catch (e) {
      if (isFatal(e)) throw e;
      this.#log(`[kit] ${this.network}: pending creates could not be settled yet (${errorText(e)}); they are asked about again later`);
    }
    let resolved = 0;
    for (const t of await this.store.listTrades()) {
      if (t.endedAt) continue;
      resolved += await this.#serial(t.id, () => this.#resolveIntents(t));
    }
    const open = (await this.store.openIntents()).length;
    if (resolved || open) this.#log(`[kit] ${this.network}: resume: ${resolved} intent(s) resolved from the chains, ${open} still open`);
    return { recorded, resolved, open };
  }

  /** Resolve a trade's open journal intents from the chains (never a blind resend). Returns how many were resolved. */
  async #resolveIntents(rec: LocalTrade): Promise<number> {
    const j = await this.store.getJournal(rec.id);
    let n = 0;
    for (const i of j.intents) {
      if (i.outcome !== undefined) continue;
      let out: { outcome: IntentOutcome; note?: string } | null = null;
      try {
        out = await this.#intentOutcome(rec, i);
      } catch (e) {
        this.#note(`intent:${rec.id}:${i.id}`, `[kit] ${this.network}: trade #${rec.id}: intent ${i.id} could not be resolved yet (${errorText(e)})`);
      }
      if (!out) continue;
      await this.store.resolveIntent(rec.id, i.id, out.outcome, out.note);
      this.#log(`[kit] ${this.network}: trade #${rec.id}: intent ${i.id} resolved from the chain: ${out.outcome}${out.note ? ` (${out.note})` : ''}`);
      n++;
    }
    return n;
  }

  /** One open intent's outcome as the chains show it, or null while it cannot be told. */
  async #intentOutcome(rec: LocalTrade, i: Intent): Promise<{ outcome: IntentOutcome; note?: string } | null> {
    // A replacement or a cancel at the same nonce starts the clock again.
    const age = this.#now() - (i.lastSentAt ?? i.sentAt ?? i.at);
    const old = age >= checks.LOCK_RESEND_AFTER_MS;
    const ec = checks.escrowFor(this.network, rec.phaContract ?? null);
    const cfg = ec.ok ? ec.cfg : this.cfg;
    const phaTx = async (): Promise<{ outcome: IntentOutcome; note?: string } | null> => {
      if (i.txHash) {
        const st = await this.deps.pha.txState(i.txHash);
        if (st && st.state !== 'Halt' && st.state !== 'Pending') return { outcome: 'failed', note: st.reason || st.state };
        if (st?.state === 'Halt') return null; // ran, but the lock does not show it yet: the node is behind
        // Known to the node and not run yet: left open until it has surely expired (5 minutes after it was built,
        // with room for a clock that runs ahead of Phantasma's).
        if (st?.state === 'Pending') return age >= 2 * checks.LOCK_RESEND_AFTER_MS ? { outcome: 'not_sent', note: 'still not run ten minutes after it was sent; the transaction has expired' } : null;
      }
      return old ? { outcome: 'not_sent', note: 'not on Phantasma five minutes after it was sent; the transaction has expired' } : null;
    };
    switch (i.kind) {
      case 'phaLock': {
        if (!i.h) return old ? { outcome: 'not_sent', note: 'no lock hash was recorded with it' } : null;
        const l = await this.deps.pha.readLock(cfg, i.h);
        if (l.state >= 1) return checks.isOurLock(l, rec, rec.counterPha ?? '') ? { outcome: 'confirmed' } : { outcome: 'failed', note: 'another lock holds this hash' };
        return phaTx();
      }
      case 'claimPha':
      case 'refundPha': {
        if (!i.h) return old ? { outcome: 'not_sent' } : null;
        const l = await this.deps.pha.readLock(cfg, i.h);
        const want = i.kind === 'claimPha' ? 2 : 3;
        if (l.state === want) {
          const mine = i.txHash ? (await this.deps.pha.txState(i.txHash))?.state === 'Halt' : false;
          return mine ? { outcome: 'confirmed' } : { outcome: 'done_elsewhere', note: 'the chain shows it done by someone else' };
        }
        if (l.state !== 1) return { outcome: 'failed', note: `the lock reads ${l.state === 2 ? 'claimed' : l.state === 3 ? 'refunded' : 'empty'}` };
        return phaTx();
      }
      case 'baseLock': {
        if (!i.h) return this.#baseTx(i, old);
        const s = await this.deps.base.readSwap(i.h, rec.myBase);
        if (s.swap.state >= 1) return { outcome: 'confirmed' };
        return this.#baseTx(i, old);
      }
      case 'claimBase': {
        const sender = rec.counterBase;
        if (!i.h || !sender) return this.#baseTx(i, old);
        const s = await this.deps.base.readSwap(i.h, sender);
        if (s.swap.state === 2) {
          return (await this.#minedOurs(i)) ? { outcome: 'confirmed' } : { outcome: 'done_elsewhere', note: 'the chain shows the USDC claimed by someone else (the keeper)' };
        }
        if (s.swap.state === 3) return { outcome: 'failed', note: 'the USDC lock was refunded' };
        return this.#baseTx(i, old);
      }
      case 'refundBase': {
        if (!i.h) return this.#baseTx(i, old);
        const s = await this.deps.base.readSwap(i.h, rec.myBase);
        if (s.swap.state === 3) {
          return (await this.#minedOurs(i)) ? { outcome: 'confirmed' } : { outcome: 'done_elsewhere', note: 'the chain shows the USDC refunded by someone else (the keeper)' };
        }
        if (s.swap.state === 2) return { outcome: 'failed', note: 'the USDC lock was claimed' };
        return this.#baseTx(i, old);
      }
      default:
        return this.#baseTx(i, old);
    }
  }

  /** Whether one of the transactions sent for this intent's step (the first or a replacement) was mined and ran. */
  async #minedOurs(i: Intent): Promise<boolean> {
    for (const h of sentHashes(i)) if ((await this.deps.base.client.receipt(h as Hex))?.status === 'success') return true;
    return false;
  }

  /**
   * A Base intent's outcome from the receipts of every transaction sent at its
   * nonce (the first, each replacement, each cancel); one the node never saw,
   * five minutes after the newest send (or whose nonce another transaction
   * used), was not sent.
   */
  async #baseTx(i: Intent, old: boolean): Promise<{ outcome: IntentOutcome; note?: string } | null> {
    const client = this.deps.base.client;
    const hashes = sentHashes(i);
    for (const h of hashes) {
      const r = await client.receipt(h as Hex);
      if (r) return r.status === 'success' ? { outcome: 'confirmed' } : { outcome: 'failed', note: 'reverted on Base' };
    }
    for (const h of i.cancelHashes ?? []) {
      if (await client.receipt(h as Hex)) return { outcome: 'not_sent', note: `its nonce was taken back by a 0-value transfer (${shortHex(h)}); the step was not mined` };
    }
    for (const h of [...hashes, ...(i.cancelHashes ?? [])]) if (await client.seen(h as Hex)) return null;
    if (i.nonce !== undefined) {
      const latest = await client.nonce(this.address.base as `0x${string}`, 'latest');
      if (latest > i.nonce) return { outcome: 'not_sent', note: 'its nonce was used by another transaction' };
    }
    return old ? { outcome: 'not_sent', note: 'Base did not know it five minutes after it was sent' } : null;
  }

  // ── run() ─────────────────────────────────────────────────────────────────

  /**
   * Resume from the store, then run until `signal` aborts (build spec
   * section 6.3): the heartbeat loop keeps the bot's open offers listed and
   * adopts their takes; the trade loop steps every running trade when it is
   * due, one at a time; the instant lane steps the trades of the bot's
   * instant offers apart from it, each on its own (#laneLoop); the trade
   * long-polls wake the trades waiting on the other side. Throws only when
   * the store is no longer this process's or the bot's key must not trade
   * (it stops then); every other failure is logged and tried again. It
   * returns only once no step of its runs any more.
   */
  async run(policy?: Policy, signal?: AbortSignal): Promise<void> {
    const resolved = resolvePolicy(policy, this.network);
    if (this.#running) throw flowError('ALREADY_RUNNING', 'run() is already running for this kit.');
    this.#running = true;
    this.#policy = resolved;
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    if (signal?.aborted) stop.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let failure: unknown = null;
    const guard = (p: Promise<void>) => p.catch((e) => {
      failure ??= e;
      stop.abort();
    });
    try {
      if (this.#beforeRun) await this.#beforeRun();
      if (!stop.signal.aborted) await this.resume(stop.signal);
      this.#log(`[kit] ${this.network}: running (acceptAfterS ${resolved.acceptAfterS} s, claimWatchS ${resolved.claimWatchS} s, claim mode ${this.claimMode})`);
      await Promise.all([guard(this.#offerLoop(stop.signal)), guard(this.#tradeLoop(stop.signal)), guard(this.#laneLoop(stop.signal)), guard(this.#pollLoop(stop.signal))]);
      if (failure) throw failure;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.#running = false;
      this.#polled.clear();
      this.#log(`[kit] ${this.network}: stopped`);
    }
  }

  /** Wake the trade loop and the instant lane now, and make `tradeId` due. */
  #wake(tradeId?: number): void {
    if (tradeId !== undefined) this.#due.set(tradeId, 0);
    this.#wakeUp();
  }

  #wakeUp(): void {
    this.#tradeAlarm.ring();
    this.#laneAlarm.ring();
  }

  /**
   * Whether the instant lane steps this trade rather than the trade loop:
   * the kit sells on its own instant offer (InstantSeller).
   */
  async #onLane(t: LocalTrade): Promise<boolean> {
    if (!t.maker || t.role !== 'S') return false;
    let mode = this.#offerModes.get(t.offerId);
    if (mode === undefined) {
      const o = await this.store.getOffer(t.offerId);
      if (!o) return false;
      mode = o.mode ?? 'standard';
      this.#offerModes.set(t.offerId, mode);
    }
    return mode === 'instant';
  }

  /** The heartbeats of the bot's open offers (one long-poll for up to 40), and the takes they bring. */
  async #offerLoop(signal: AbortSignal): Promise<void> {
    const poller = this.session.poller({ wait: this.#pollWaitS, sleep: this.#sleep, now: this.#now, log: this.#log });
    while (!signal.aborted) {
      const items = await this.session.openOffers();
      if (items.length === 0) {
        await this.#sleep(BOARD_WAIT_MS, signal);
        continue;
      }
      let round;
      try {
        round = await poller.next(items, signal);
      } catch (e) {
        if (signal.aborted) break;
        if (isFatal(e)) throw e;
        this.#note('heartbeat', `[kit] ${this.network}: heartbeat failed (${errorText(e)}); trying again`);
        await this.#sleep(BOARD_WAIT_MS, signal);
        continue;
      }
      this.#noted.delete('heartbeat');
      const now = this.#now();
      for (const [id, e] of round.errors) {
        if (e.code === 'CLOSED' || e.code === 'NOT_FOUND' || e.code === 'UNAUTHORIZED') {
          await this.store.patchOffer(id, { closedAt: now });
          this.#log(`[kit] ${this.network}: offer #${id} is no longer listed (${e.code}); its heartbeats stop`);
        } else {
          this.#note(`hb:${id}`, `[kit] ${this.network}: offer #${id}: heartbeat refused (${e.code})`);
        }
      }
      for (const [id, o] of round.offers) {
        if (o.status !== 'open') {
          await this.store.patchOffer(id, { closedAt: now });
          this.#log(`[kit] ${this.network}: offer #${id} closed (${o.status}); its heartbeats stop`);
        }
      }
      for (const t of round.trades) {
        try {
          await this.adopt(t);
        } catch (e) {
          if (isFatal(e)) throw e;
          this.#note(`adopt:${t.id}`, `[kit] ${this.network}: take #${t.id} could not be kept (${errorText(e)})`);
        }
      }
      for (const t of round.changed) this.#wake(t.id);
    }
  }

  /** Step every running trade when it is due (the instant lane's apart); settle pending creates now and then. */
  async #tradeLoop(signal: AbortSignal): Promise<void> {
    let lastReconcile = this.#now();
    while (!signal.aborted) {
      const all: LocalTrade[] = [];
      for (const t of await this.store.listTrades()) if (!t.endedAt && !(await this.#onLane(t))) all.push(t);
      // Takes waiting for this kit's accept first (the board cancels them after 2 minutes), then the rest by due time.
      all.sort((a, b) => Number(b.status === 'requested' && b.maker) - Number(a.status === 'requested' && a.maker) || (this.#due.get(a.id) ?? 0) - (this.#due.get(b.id) ?? 0));
      for (const t of all) {
        if (signal.aborted) break;
        if ((this.#due.get(t.id) ?? 0) > this.#now()) continue;
        const r = await this.#stepSafe(t.id);
        this.#due.set(t.id, r.nextAt);
      }
      if (this.#now() - lastReconcile >= RECONCILE_EVERY_MS) {
        lastReconcile = this.#now();
        try {
          const rep = await this.session.reconcilePending({ signal });
          for (const r of rep.recorded) if (r.kind === 'take') this.#due.set(r.id, 0);
        } catch (e) {
          if (isFatal(e)) throw e;
        }
      }
      if (signal.aborted) break;
      const now = this.#now();
      let next = now + IDLE_MS;
      for (const t of await this.store.listTrades()) if (!t.endedAt && !(await this.#onLane(t))) next = Math.min(next, this.#due.get(t.id) ?? now);
      await this.#tradeAlarm.idle(next - now, signal);
    }
  }

  /**
   * The instant lane (build spec section 3.10.3): the trades of the bot's
   * instant offers, each stepped as soon as it is due, on its own, apart from
   * the trade loop and from each other. Another trade's slow step (a Base
   * send waits up to 3 minutes to be mined) then never holds up an instant
   * lock's start window (now - t_B <= I_WIN - I_WIN_LEAD) or its getState(h)
   * watch (at least every INSTANT_RULES.watchEvery), which S's USDC claim
   * depends on when nobody else claims it. Running beside the trade loop is
   * safe: one step per trade at a time (#serial), one signing flow per trade
   * (the signer), accepts one at a time (#committing), a funds count that
   * never misses a lock landing meanwhile (#sellerFunds), and a Base
   * send that would wait behind another not on Base yet is refused and tried
   * again (notSendable). Returns once its running steps have ended.
   */
  async #laneLoop(signal: AbortSignal): Promise<void> {
    const failure: { error: unknown; failed: boolean } = { error: null, failed: false };
    try {
      while (!signal.aborted && !failure.failed) {
        let next = this.#now() + IDLE_MS;
        for (const t of await this.store.listTrades()) {
          if (signal.aborted || failure.failed) break;
          if (t.endedAt || this.#laneSteps.has(t.id) || !(await this.#onLane(t))) continue;
          const due = this.#due.get(t.id) ?? 0;
          if (due > this.#now()) {
            next = Math.min(next, due);
            continue;
          }
          const id = t.id;
          this.#laneSteps.set(id, this.#stepSafe(id).then(
            (r) => { this.#due.set(id, r.nextAt); },
            (e: unknown) => {
              if (failure.failed) return;
              failure.failed = true;
              failure.error = e;
            }
          ).finally(() => {
            this.#laneSteps.delete(id);
            this.#laneAlarm.ring();
          }));
        }
        if (signal.aborted || failure.failed) break;
        await this.#laneAlarm.idle(next - this.#now(), signal);
      }
    } finally {
      // run() returns (and the store may close) only once no step of the lane runs any more.
      await Promise.allSettled([...this.#laneSteps.values()]);
    }
    if (failure.failed) throw failure.error;
  }

  async #stepSafe(id: number): Promise<StepResult> {
    try {
      return await this.step(id);
    } catch (e) {
      if (isFatal(e)) throw e;
      this.#note(`step:${id}`, `[kit] ${this.network}: trade #${id}: the step failed (${errorText(e)}); it is tried again`);
      return this.#result({ id }, null, 'none', 'waiting', { text: errorText(e), retry: true, nextAt: this.#now() + RETRY_MS });
    }
  }

  /**
   * Trade long-polls for the trades waiting on the other side's move (taker
   * trades, and maker trades whose offer is closed: an open offer's
   * heartbeat already carries its trades), at most 4 at once (12 with an API
   * key), well under the board's caps.
   */
  async #pollLoop(signal: AbortSignal): Promise<void> {
    if (this.#pollWaitS === 0) return;
    const slots = new Map<number, AbortController>();
    const max = this.board.keyed ? TRADE_POLLS_KEYED : TRADE_POLLS_ANON;
    try {
      while (!signal.aborted) {
        const openOffers = new Set((await this.session.openOffers()).map((o) => o.id));
        const want = (await this.store.listTrades())
          .filter((t) => !t.endedAt && OTHER_SIDE.includes(t.status ?? '') && (!t.maker || !openOffers.has(t.offerId)))
          .slice(0, max)
          .map((t) => t.id);
        for (const [id, ctl] of slots) {
          if (!want.includes(id)) {
            ctl.abort();
            slots.delete(id);
            this.#polled.delete(id);
          }
        }
        for (const id of want) {
          if (slots.has(id) || slots.size >= max) continue;
          const ctl = new AbortController();
          slots.set(id, ctl);
          this.#polled.add(id);
          void this.#pollTrade(id, ctl.signal).finally(() => {
            if (slots.get(id) === ctl) {
              slots.delete(id);
              this.#polled.delete(id);
            }
          });
        }
        await this.#sleep(RESELECT_MS, signal);
      }
    } finally {
      for (const ctl of slots.values()) ctl.abort();
      slots.clear();
    }
  }

  async #pollTrade(id: number, signal: AbortSignal): Promise<void> {
    const poller = new TradePoller(this.board, id, { wait: this.#pollWaitS, sleep: this.#sleep, log: this.#log });
    while (!signal.aborted) {
      try {
        const r = await poller.next(signal);
        if (r.changed) this.#wake(id);
      } catch {
        if (signal.aborted) return;
        await this.#sleep(BOARD_WAIT_MS, signal);
      }
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A loop's idle wait that ring() cuts short; a ring while the loop is not waiting cuts its next wait. */
class Alarm {
  readonly #sleep: SleepFn;
  #waiter: (() => void) | null = null;
  #rung = false;

  constructor(sleep: SleepFn) {
    this.#sleep = sleep;
  }

  ring(): void {
    if (this.#waiter) this.#waiter();
    else this.#rung = true;
  }

  /** Wait up to `ms`, or until rung or stopped. */
  async idle(ms: number, signal: AbortSignal): Promise<void> {
    // Stopped while the loop read the store: an 'abort' listener added now would never fire, and the stop would wait
    // out the whole idle time.
    if (signal.aborted) return;
    if (this.#rung) {
      this.#rung = false;
      return;
    }
    const ctl = new AbortController();
    const off = () => ctl.abort();
    signal.addEventListener('abort', off, { once: true });
    this.#waiter = off;
    try {
      await this.#sleep(Math.max(0, ms), ctl.signal);
    } finally {
      if (this.#waiter === off) this.#waiter = null;
      signal.removeEventListener('abort', off);
      this.#rung = false;
    }
  }
}

/** Every transaction sent for an intent's step at its nonce (the first and each replacement), oldest first. */
function sentHashes(i: Intent): string[] {
  const out = [...(i.hashes ?? [])];
  if (i.txHash && !out.includes(i.txHash)) out.push(i.txHash);
  return out;
}

/** The open Base send of `kind` in a trade's journal (recorded with its nonce, outcome not known yet), or null. */
function openBaseSend(j: Journal, kind: FollowedKind): Intent | null {
  return j.intents.find((i) => i.kind === kind && i.outcome === undefined && i.nonce !== undefined) ?? null;
}

function needId(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw flowError('BAD_INPUT', `${what} is a positive whole number.`);
  return v;
}

/** The flow codes that belong to a check of section 6.4. */
export type CheckedFlowCode = 'OFFER_ECHO' | 'ACCEPT_TOO_SOON' | 'TAKE_DECLINED' | 'LOCK_NOT_OURS' | 'RPC_NOT_ALLOWED' | 'PRICE_LIMIT';

/** A refusal of the flows in the shape of a check's Problem. */
export function flowProblem(code: CheckedFlowCode, text: string, retry = false): Problem {
  return Object.freeze({ check: FLOW_CODES[code], code, text, retry });
}

function limitProblem(text: string): Problem {
  return flowProblem('PRICE_LIMIT', text);
}

/**
 * Check 9: why the board's echo of a posted offer is not what was posted, or
 * null. Token, side, amounts, maker addresses and mode; a fixed offer at
 * exactly its price, a following one with the same settings at a price its
 * limit allows.
 */
export function echoProblem(listed: Offer, posted: NewOffer): string | null {
  if (listed.symbol !== posted.symbol) return 'token';
  if (listed.side !== posted.side) return 'side';
  if (listed.tazTotal !== posted.tazTotal || listed.tazMin !== posted.tazMin || listed.tazMax !== posted.tazMax) return 'amounts';
  if (listed.makerPha !== posted.makerPha || !sameEvm(listed.makerBase, posted.makerBase)) return 'maker addresses';
  // An instant offer must be listed as one: a board that drops the mode would list a standard offer instead.
  if (posted.mode === 'instant' ? listed.mode !== 'instant' : listed.mode !== undefined && listed.mode !== 'standard') return 'mode';
  if (posted.follow) {
    const f = listed.follow;
    if (!f || f.offsetBps !== posted.follow.offsetBps || f.limitPrice !== posted.follow.limitPrice || f.dailyMax !== (posted.follow.dailyMax ?? posted.tazTotal)) return 'follow settings';
    if (offerPriceProblem(listed.price, { side: posted.side, price: listed.price, priceHistory: [], follow: posted.follow })) return 'price past the limit';
    return null;
  }
  if (listed.follow) return 'follow settings';
  return listed.price === posted.price ? null : 'price';
}

/** Whether `e` is the failure of a create that may still have made its row (BoardSession keeps its token). */
export function createMayExist(e: unknown): boolean {
  return e instanceof CreateError && e.mayExist;
}
