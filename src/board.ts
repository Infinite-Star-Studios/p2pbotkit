/**
 * The P2P board's REST client (build spec section 6.3), and the durable layer
 * the kit's flows use on top of it.
 *
 * BoardClient is the wire: one method per route, every answer checked for
 * shape before it is returned, every refusal a BoardError with the board's
 * retry hints. It never decides anything about money: every figure it
 * returns is display data until the checks (checks.ts) have read the chains.
 *
 *   - Retries (section 6.3): a request that got no answer, and a refusal the
 *     board marks `retryable`, is sent again with the same body after
 *     `retryAfter` seconds (at most 60, jittered by +-20%; 1, 2, 4, 8, 16 s
 *     when the board names no wait), at most 5 times. An error body without
 *     `retryable` (a board from before wave B) follows the table of section
 *     2.6 (BOARD_ERRORS). PRICE_CHANGED and IDEMPOTENCY_MISMATCH are never
 *     sent again.
 *   - Creates (offers and takes) always carry a client token hash (section
 *     2.1.4). A create whose answer was lost (no answer, or a 5xx) is sent
 *     again only to a board that keeps client hashes (keepsHashes(): it
 *     serves the feed), asked once per create: a board from before them makes
 *     a new row for every send. The failure of a create is a CreateError that
 *     says whether the row may exist all the same (`mayExist`).
 *   - Every take sends `price`, the price the kit read (section 2.3.3).
 *   - Trade reads send `symbol=all`; offer lists default to `symbol=all`.
 *   - Headers: `X-API-Key` when configured, `Authorization: Bearer` for a
 *     control token. Neither is ever logged, and no body is.
 *
 * BoardSession adds the kit's store (section 6.5) and is what the flows use:
 *
 *   - postOffer and take make the control token themselves (64 lowercase
 *     hex; the hash the board keeps is sha256Hex of that string, codec.ts),
 *     keep it in `pending/` (durable write 1, read back) and record each send
 *     time BEFORE the POST, then keep the offer or trade record with its
 *     token (read back) and only then drop the pending entry;
 *   - a 201 that carries `makerToken`/`takerToken` (an older board that
 *     ignored the hash) is adopted: that token is kept in the record, read
 *     back, and used for every later call on that row; the client token is
 *     dropped, and the log says the create was not idempotent;
 *   - reconcilePending (on restart, and from the flows' loop) asks the board
 *     about every entry last sent 60 s or more ago with `replayOnly: true`,
 *     so a request that never reached the board is never made late: a 404
 *     `no_such_request` just clears the entry. It never asks a board that
 *     does not keep client hashes (that board would make a new row);
 *   - every later call on a row (heartbeat, cancel, reprice, accept,
 *     decline, the lock reports) takes its token from the store: the offer's
 *     maker token, or the trade's taker token, as the store keeps it.
 *
 * OfferPoller and TradePoller follow the long-poll client rule of sections
 * 2.4.3-2.4.5: `since` is the previous answer's server time (inclusive at the
 * board), trades are deduplicated by (id, updatedAt, status), and an answer
 * that did not wait and brought the same trades as the one before is
 * followed by a 1 s pause (doubling, up to the plain interval, while the
 * board keeps answering that way, as it does over its concurrency cap). A
 * board without the long-poll, and a round sent without a wait, are polled
 * plainly (every 5 s). A poller's first round (no answer yet, so no `since`:
 * after a start or a restart) is sent without a wait, so a take or a change
 * made while the kit was down comes back at once; the next round long-polls
 * from that answer's server time.
 */
import { BoardError, SafetyError, SAFETY } from './errors.js';
import { redactedLog, type LogFn } from './redact.js';
import { TOKEN_RE, isHex32, newControlToken, tokenHashOf } from './codec.js';
import { DEFAULT_API, tokenOf, isContractName } from './pins.js';
import { TRADE_STATUSES, evmLower, isPhaAddress, tradeMismatch, usdcFor } from './rules.js';
import { parseFaucetClaim, parseFaucetInfo, type FaucetClaim, type FaucetInfoAnswer } from './faucet.js';
import type { KitStore } from './store.js';
import type {
  BatchAnswer, BatchResult, BoardErrorBody, CreateOfferAnswer, FeedTrade, FollowSettings, FollowState, HeartbeatAnswer, LocalOffer, LocalTrade,
  Me, Network, NewOffer, Offer, P2PConfig, Party, PendingCreate, RecentPage, Reference, RepriceBody, Side, TakeAnswer, TakeBody, Trade, TradeRef
} from './types.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** How long one request may take before it counts as unanswered, ms (a long-poll gets its wait on top). */
export const REQUEST_TIMEOUT_MS = 15_000;
/** The longest wait the kit honours before sending a request again, seconds (section 6.3). */
export const RETRY_AFTER_MAX = 60;
/** Each wait is jittered by this much either way (section 6.3: +-20%). */
export const RETRY_JITTER = 0.2;
/** How many times a request is sent again, at most (section 6.3). */
export const MAX_RETRIES = 5;
/** The longest a long-poll waits at the board for a change, seconds (sections 2.4.3-2.4.5). */
export const LONG_POLL_MAX = 25;
/** The most offers one batch heartbeat carries (section 2.4.5). */
export const HEARTBEATS_MAX = 40;
/** A pending create is asked about (replayOnly) only once its last send is this old, ms (section 2.1.4). */
export const REPLAY_MIN_AGE_MS = 60_000;
/** The pause after a long-poll answer that did not wait and brought nothing new, ms (the client rule of section 2.4.3). */
export const UNCHANGED_PAUSE_MS = 1_000;
/** The poll interval against a board without the long-poll, ms. */
export const PLAIN_POLL_MS = 5_000;
/** After a board answered that it has no batch heartbeat, it is asked again this much later, ms. */
const BATCH_RECHECK_MS = 10 * 60_000;
/** The largest answer body the kit reads, bytes. */
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

/** The SafetyError codes of this file (nothing was sent). */
export const BOARD_SAFETY = Object.freeze({
  /** A request the kit would not send: a malformed id, amount, address, token or option. */
  BAD_INPUT: 'BAD_INPUT',
  /** The API base URL is not one the kit talks to (https, or http on this machine). */
  API_NOT_ALLOWED: 'API_NOT_ALLOWED',
  /** The store keeps no control token for this offer or trade. */
  NO_TOKEN: 'NO_TOKEN'
} as const);

/** One row of the error table of build spec section 2.6. */
export interface ErrorRule {
  /** The code's HTTP status (CLOSED: 409 for an offer; it is 422 for a Phantasma lock). */
  readonly http: number;
  readonly retryable: boolean;
  /** The default wait, seconds, where the table gives one. */
  readonly retryAfter?: number;
}

const row = (http: number, retryable: boolean, retryAfter?: number): ErrorRule =>
  Object.freeze(retryAfter === undefined ? { http, retryable } : { http, retryable, retryAfter });

/**
 * Build spec section 2.6, row by row: what an error body WITHOUT `retryable`
 * (a board from before wave B) means. A body that says `retryable` is taken
 * at its word, except that PRICE_CHANGED and IDEMPOTENCY_MISMATCH are never
 * sent again. board.test.ts checks this table against the backend's own
 * (backend/src/http/errors.ts) when the backend is checked out beside the kit.
 */
export const BOARD_ERRORS: Readonly<Record<string, ErrorRule>> = Object.freeze({
  BAD_REQUEST: row(400, false),
  TOO_LARGE: row(413, false),
  UNAUTHORIZED: row(401, false),
  BAD_API_KEY: row(401, false),
  ADMIN_UNAUTHORIZED: row(401, false),
  WRONG_SECRET: row(403, false),
  /** The request did not come through the board's public address (a deployment that reaches the API only through it). */
  ORIGIN_REQUIRED: row(403, false),
  NOT_ELIGIBLE: row(403, false),
  P2P_OFF: row(404, false),
  NOT_FOUND: row(404, false),
  ALERTS_OFF: row(404, false),
  FAUCET_OFF: row(404, false),
  ADMIN_DISABLED: row(404, false),
  INSTANT_OFF: row(404, false),
  CLOSED: row(409, false),
  OFFLINE: row(409, true, 30),
  TOKEN: row(409, false),
  AMOUNT: row(409, false),
  BUSY: row(409, true, 60),
  FUNDS: row(409, false),
  STATE: row(409, false),
  LATE: row(409, false),
  NOT_YET: row(409, true, 3),
  NOT_CONFIRMED: row(409, true, 5),
  USED: row(409, false),
  IDEMPOTENCY_MISMATCH: row(409, false),
  PRICE_CHANGED: row(409, false),
  NO_SHOW_LIMIT: row(409, false),
  CAP_SHARE: row(409, true, 300),
  FOLLOW_PAUSED: row(409, true, 60),
  TOO_SOON: row(409, true),
  SQUATTED: row(409, false),
  /** Admin only (POST /v1/admin/p2p/rewards/paid): the automatic rewards payer owns that payout. */
  AUTO_PAYOUT: row(409, false),
  TX_FAILED: row(422, false),
  NO_LOCK: row(422, false),
  MISMATCH: row(422, false),
  OLD_LOCK: row(422, false),
  RATE_LIMITED: row(429, true),
  FAUCET_LIMIT: row(429, false),
  INTERNAL: row(500, true, 10),
  UPSTREAM: row(502, true, 5),
  UNAVAILABLE: row(503, true, 10),
  ESCROW_NOT_PINNED: row(503, false),
  TOKEN_NOT_READY: row(503, true, 60),
  KEEPER_UNAVAILABLE: row(503, true, 30),
  FAUCET_EMPTY: row(503, true, 3600)
});

/** Never sent again, whatever the board says: the same body can only get the same refusal (or worse). */
const NEVER_RETRY: ReadonlySet<string> = new Set(['PRICE_CHANGED', 'IDEMPOTENCY_MISMATCH', 'BAD_ANSWER', 'ABORTED']);

/** HTTP statuses of an answer without a code of the table (a proxy's or Cloudflare's page) that are worth sending again. */
const RETRY_STATUS: ReadonlySet<number> = new Set([429, 502, 503, 504, 520, 521, 522, 523, 524]);

/**
 * What an error without `retryable` means (section 2.6): the table's row for
 * a code it lists; for anything else, a rate limit or a gateway error is
 * worth retrying (in 10 s unless the answer says), and the rest is not.
 */
export function retryRuleOf(code: string, status: number): { retryable: boolean; retryAfter?: number } {
  if (Object.hasOwn(BOARD_ERRORS, code)) {
    const r = BOARD_ERRORS[code]!;
    return r.retryAfter === undefined ? { retryable: r.retryable } : { retryable: r.retryable, retryAfter: r.retryAfter };
  }
  if (!RETRY_STATUS.has(status)) return { retryable: false };
  return status === 429 ? { retryable: true } : { retryable: true, retryAfter: 10 };
}

/** Whether a failed request may have done its work all the same: it got no answer, or a server error. */
export function outcomeUnknown(e: unknown): boolean {
  return e instanceof BoardError && (e.code === 'NETWORK' || e.status >= 500);
}

/**
 * A create (an offer or a take) that failed. `mayExist`: a send of it got no
 * answer, or a server error, or an answer the kit cannot read, so the board
 * may have made the row all the same; the store keeps its pending entry, and
 * BoardSession.reconcilePending settles it later. Otherwise nothing was made.
 */
export class CreateError extends BoardError {
  readonly kind: 'offer' | 'take';
  /** sha256Hex of the create's control token: the pending entry's name. */
  readonly tokenHash: string;
  readonly mayExist: boolean;
  /** An answer the kit could not read that still named the row: its id, and the board's own token if it sent one. */
  readonly created: { id: number; token: string | null } | null;

  constructor(from: BoardError, o: { kind: 'offer' | 'take'; tokenHash: string; mayExist: boolean; created?: { id: number; token: string | null } | null }) {
    const prefix = `${from.code}: `;
    super(from.code, from.status, from.retryable, from.retryAfter, from.reason, from.message.startsWith(prefix) ? from.message.slice(prefix.length) : from.message);
    this.name = 'CreateError';
    this.kind = o.kind;
    this.tokenHash = o.tokenHash;
    this.mayExist = o.mayExist;
    this.created = o.created ?? null;
  }
}

// ── Shapes ───────────────────────────────────────────────────────────────────

const RAW = /^[1-9]\d{0,39}$/;
const RAW0 = /^(0|[1-9]\d{0,39})$/;
const PHA_TX = /^[0-9a-fA-F]{64}$/;
const BASE_TX = /^0x[0-9a-fA-F]{64}$/;
const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const intOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);
const numOr0 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const finiteOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** A symbol of the kit's table, exactly as the table writes it. */
const tableSymbol = (v: unknown): string | null => (typeof v === 'string' && tokenOf(v)?.symbol === v ? v : null);
const txOrNull = (v: unknown, re: RegExp): string | null => (typeof v === 'string' && re.test(v) ? v : null);
const textOrNull = (v: unknown, max = 300): string | null => (typeof v === 'string' ? v.slice(0, max) : null);

function party(v: unknown): Party | null {
  if (!isRec(v) || !isPhaAddress(v.pha) || !evmLower(v.base)) return null;
  return { pha: v.pha, base: v.base as string };
}

function followState(v: unknown): FollowState | null {
  if (!isRec(v)) return null;
  const off = v.offsetBps;
  if (typeof off !== 'number' || !Number.isInteger(off) || Math.abs(off) > 2000) return null;
  if (typeof v.limitPrice !== 'string' || !RAW.test(v.limitPrice) || typeof v.dailyMax !== 'string' || !RAW.test(v.dailyMax)) return null;
  return {
    offsetBps: off, limitPrice: v.limitPrice, dailyMax: v.dailyMax,
    state: v.state === 'live' ? 'live' : 'paused',
    filled24h: typeof v.filled24h === 'string' && RAW0.test(v.filled24h) ? v.filled24h : '0'
  };
}

/**
 * A board offer (offerJson) the kit can read, or null: an id, a side, a
 * symbol of the kit's table (exactly), valid maker addresses, integer
 * amounts and price, on `network`. Only the known fields are kept.
 */
export function parseOffer(v: unknown, network: Network): Offer | null {
  if (!isRec(v) || !isId(v.id) || (v.side !== 'sell' && v.side !== 'buy') || v.network !== network) return null;
  const symbol = tableSymbol(v.symbol);
  if (!symbol || !isPhaAddress(v.makerPha) || !evmLower(v.makerBase)) return null;
  for (const k of ['tazTotal', 'tazMin', 'tazMax', 'price'] as const) if (typeof v[k] !== 'string' || !RAW.test(v[k] as string)) return null;
  if (typeof v.remaining !== 'string' || !RAW0.test(v.remaining)) return null;
  const o: Offer = {
    id: v.id, network, side: v.side, makerPha: v.makerPha, makerBase: v.makerBase as string, symbol,
    tazTotal: v.tazTotal as string, tazMin: v.tazMin as string, tazMax: v.tazMax as string, price: v.price as string, remaining: v.remaining,
    status: typeof v.status === 'string' ? v.status.slice(0, 40) : '', online: v.online === true,
    createdAt: numOr0(v.createdAt), heartbeatAt: numOr0(v.heartbeatAt), closedAt: intOrNull(v.closedAt)
  };
  if (v.priceAt !== undefined) o.priceAt = intOrNull(v.priceAt);
  if (v.follow !== undefined) o.follow = followState(v.follow);
  if (v.mode === 'standard' || v.mode === 'instant') o.mode = v.mode;
  return o;
}

/**
 * A board trade (tradeJson) the kit can read, or null: ids, a side, a symbol
 * of the kit's table (exactly), integer amounts, both parties' addresses, a
 * status of P2P/SPEC.md section 7, on `network`. h is lowercased; a
 * malformed transaction hash, fee or contract name reads as null.
 */
export function parseTrade(v: unknown, network: Network): Trade | null {
  if (!isRec(v) || !isId(v.id) || !isId(v.offerId) || (v.side !== 'sell' && v.side !== 'buy') || v.network !== network) return null;
  const symbol = tableSymbol(v.symbol);
  if (!symbol) return null;
  for (const k of ['taz', 'usdc', 'price'] as const) if (typeof v[k] !== 'string' || !RAW.test(v[k] as string)) return null;
  if (typeof v.status !== 'string' || !TRADE_STATUSES.includes(v.status)) return null;
  const seller = party(v.seller), buyer = party(v.buyer);
  if (!seller || !buyer) return null;
  const fee = v.feeBps;
  const t: Trade = {
    id: v.id, network, offerId: v.offerId, side: v.side, symbol,
    taz: v.taz as string, usdc: v.usdc as string, price: v.price as string, seller, buyer,
    h: isHex32(v.h) ? v.h.toLowerCase() : null,
    phaContract: isContractName(v.phaContract) ? v.phaContract : null,
    phaLockTx: txOrNull(v.phaLockTx, PHA_TX), baseLockTx: txOrNull(v.baseLockTx, BASE_TX), baseClaimTx: txOrNull(v.baseClaimTx, BASE_TX),
    phaClaimTx: txOrNull(v.phaClaimTx, PHA_TX), baseRefundTx: txOrNull(v.baseRefundTx, BASE_TX), phaRefundTx: txOrNull(v.phaRefundTx, PHA_TX),
    phaDeadline: intOrNull(v.phaDeadline), baseDeadline: intOrNull(v.baseDeadline),
    feeBps: typeof fee === 'number' && Number.isInteger(fee) && fee >= 0 && fee <= 10_000 ? fee : null,
    payoutDeferred: v.payoutDeferred === true,
    status: v.status as Trade['status'],
    acceptBy: intOrNull(v.acceptBy), lockBy: intOrNull(v.lockBy),
    createdAt: numOr0(v.createdAt), acceptedAt: intOrNull(v.acceptedAt), updatedAt: numOr0(v.updatedAt), endedAt: intOrNull(v.endedAt),
    lastError: textOrNull(v.lastError)
  };
  if (v.mode === 'standard' || v.mode === 'instant') t.mode = v.mode;
  return t;
}

function tradeRef(v: unknown): TradeRef | null {
  if (!isRec(v)) return null;
  const basis = v.basis === 'p2p' || v.basis === 'via_soul' || v.basis === 'feed' ? v.basis : null;
  return {
    soulUsd: finiteOrNull(v.soulUsd), dexUsd: finiteOrNull(v.dexUsd), lineUsd: finiteOrNull(v.lineUsd), basis,
    tazPerRa: finiteOrNull(v.tazPerRa), at: numOr0(v.at)
  };
}

/** A trade of the public feed (section 2.3.1) the kit can read, or null. */
export function parseFeedTrade(v: unknown, network: Network): FeedTrade | null {
  if (!isRec(v) || !isId(v.id) || v.network !== network) return null;
  const symbol = tableSymbol(v.symbol);
  if (!symbol || (v.offerSide !== 'sell' && v.offerSide !== 'buy') || (v.takerSide !== 'sell' && v.takerSide !== 'buy')) return null;
  for (const k of ['taz', 'usdc', 'price'] as const) if (typeof v[k] !== 'string' || !RAW.test(v[k] as string)) return null;
  const seller = party(v.seller), buyer = party(v.buyer);
  if (!seller || !buyer) return null;
  const p = isRec(v.proof) ? v.proof : {};
  const fee = v.feeBps;
  return {
    id: v.id, network, symbol, offerSide: v.offerSide, takerSide: v.takerSide,
    taz: v.taz as string, usdc: v.usdc as string, price: v.price as string,
    feeBps: typeof fee === 'number' && Number.isInteger(fee) && fee >= 0 && fee <= 10_000 ? fee : null,
    createdAt: numOr0(v.createdAt), acceptedAt: intOrNull(v.acceptedAt), endedAt: intOrNull(v.endedAt), seller, buyer,
    proof: {
      h: isHex32(p.h) ? p.h.toLowerCase() : null, phaContract: isContractName(p.phaContract) ? p.phaContract : null,
      phaLockTx: txOrNull(p.phaLockTx, PHA_TX), baseLockTx: txOrNull(p.baseLockTx, BASE_TX),
      baseClaimTx: txOrNull(p.baseClaimTx, BASE_TX), phaClaimTx: txOrNull(p.phaClaimTx, PHA_TX)
    },
    ref: tradeRef(v.ref)
  };
}

/** What makes a trade "changed" for the long-poll client rule (section 2.4.3): its id, updatedAt and status. */
export const tradeKey = (t: Pick<Trade, 'id' | 'updatedAt' | 'status'>): string => `${t.id}:${t.updatedAt}:${t.status}`;

// ── Errors from answers ──────────────────────────────────────────────────────

/** The retry hints of an error body (section 2.1.2), each kept only when well formed, with the section 2.6 fallback. */
function errorOf(status: number, json: unknown, retryAfterHeader: string | null): BoardError {
  const e = isRec(json) && isRec(json.error) ? json.error : null;
  const raw = typeof e?.code === 'string' ? e.code : '';
  const code = /^[A-Z][A-Z0-9_]{0,39}$/.test(raw) ? raw : `HTTP_${status}`;
  const reason = typeof e?.reason === 'string' && /^[a-z0-9_]{1,40}$/.test(e.reason) ? e.reason : null;
  const message = typeof e?.message === 'string' ? e.message.slice(0, 300) : `The board answered ${status}`;
  const head = (retryAfterHeader ?? '').trim();
  const fromHeader = /^\d{1,6}$/.test(head) && Number(head) <= 86_400 ? Number(head) : null;
  const given = typeof e?.retryAfter === 'number' && Number.isSafeInteger(e.retryAfter) && e.retryAfter >= 0 && e.retryAfter <= 86_400 ? e.retryAfter : null;
  if (typeof e?.retryable === 'boolean') {
    return new BoardError(code, status, e.retryable, given ?? fromHeader, reason, message);
  }
  // An older board: the table decides (section 2.6).
  const rule = retryRuleOf(code, status);
  return new BoardError(code, status, rule.retryable, given ?? fromHeader ?? (rule.retryable ? rule.retryAfter ?? null : null), reason, message);
}

const badAnswer = (what: string, status = 0): BoardError => new BoardError('BAD_ANSWER', status, false, null, null, `The board sent ${what} the kit cannot read`);
const aborted = (): BoardError => new BoardError('ABORTED', 0, false, null, null, 'Stopped');

// ── Waiting ──────────────────────────────────────────────────────────────────

/** Wait `ms`, or less when `signal` stops it (never rejects). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted || !(ms > 0)) { resolve(); return; }
    const done = () => { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); };
    const t = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

// ── The client ───────────────────────────────────────────────────────────────

export interface BoardClientOptions {
  network: Network;
  /** The API's base URL (default https://apiops.saturnx.cc): https, or http on this machine. */
  api?: string;
  /** X-API-Key (sat_…), sent with every request; never logged. */
  apiKey?: string;
  fetch?: typeof fetch;
  /** Receives redacted lines only. */
  log?: LogFn;
  /** How long one request may take, ms (default 15 s; a long-poll adds its wait). */
  timeoutMs?: number;
  /** How many times a request is sent again, at most (default 5). */
  retries?: number;
  /** For tests: how the client waits between sends, and its jitter source (0 <= x < 1). */
  sleep?: SleepFn;
  random?: () => number;
}

export interface CallOptions {
  /** Stops waiting and sending (the call then throws BoardError ABORTED). */
  signal?: AbortSignal;
  /** How many times this call is sent again, at most (default: the client's, 5); 0 sends it once. */
  retries?: number;
  /** A retryable refusal that asks for a longer wait than this (seconds) is thrown at once instead of waited out. */
  maxRetryAfter?: number;
  /** How long each send may take before it counts as unanswered, ms (default the client's, REQUEST_TIMEOUT_MS; a long-poll gets its wait on top). */
  timeoutMs?: number;
}

export interface LongPollOptions extends CallOptions {
  /** 1..25 s: the board holds the answer until something changes (0 or none: it answers at once). */
  wait?: number;
  /** The previous answer's server time (unix s): the board compares inclusively. */
  since?: number | null;
}

/** A trade read with its long-poll facts (section 2.4.4). */
export interface TradeAnswer {
  trade: Trade;
  /** X-Server-Time: the next call's `since`; null from a board without the long-poll. */
  serverTime: number | null;
  /** X-Waited: whether the board held the request. */
  waited: boolean;
}

interface Req {
  method: 'GET' | 'POST';
  /** Under the API base: '/v1/…'. */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  /** A control token (64 lowercase hex), sent only as Authorization: Bearer. */
  token?: string;
  timeoutMs?: number;
}

interface Answer { status: number; data: unknown; headers: Headers }

/**
 * How a call treats a send whose outcome is unknown (no answer, or a 5xx):
 *   'always'  send it again (an idempotent call);
 *   'never'   throw at once (a call that must not run twice, the faucet);
 *   a function asked before each such resend: true sends it, false throws,
 *   null skips this send (it counts as one) and asks again before the next.
 */
type Resend = 'always' | 'never' | (() => Promise<boolean | null>);

interface Policy extends CallOptions {
  resend?: Resend;
  /** Runs (and must succeed) right before every send, the first included. */
  beforeSend?: () => Promise<void>;
  /** Filled with the last send whose outcome was unknown. */
  track?: { unknown: BoardError | null };
}

/** The API base: https (or http on this machine's loopback), no user part, no query; trailing slashes dropped. */
function apiBase(api: unknown): string {
  let u: URL;
  try { u = new URL(String(api)); } catch { throw new SafetyError(BOARD_SAFETY.API_NOT_ALLOWED, 'The board API is not a URL.'); }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new SafetyError(BOARD_SAFETY.API_NOT_ALLOWED, 'The board API must use https (or http on 127.0.0.1).');
  if (u.username || u.password) throw new SafetyError(BOARD_SAFETY.API_NOT_ALLOWED, 'The board API URL must not carry a user name or password.');
  if (u.search || u.hash) throw new SafetyError(BOARD_SAFETY.API_NOT_ALLOWED, 'The board API URL must not carry a query or a fragment.');
  return u.origin + u.pathname.replace(/\/+$/, '');
}

const bad = (what: string): SafetyError => new SafetyError(BOARD_SAFETY.BAD_INPUT, what);
function needId(v: unknown, what: string): number {
  if (!isId(v)) throw bad(`${what} is a positive whole number.`);
  return v;
}
function needToken(v: unknown): string {
  if (typeof v !== 'string' || !TOKEN_RE.test(v)) throw bad('A control token is 64 lowercase hex characters.');
  return v;
}
function needHash(v: unknown, what: string): string {
  if (typeof v !== 'string' || !TOKEN_RE.test(v)) throw bad(`${what} is the SHA-256 of the control token, as 64 lowercase hex characters.`);
  return v;
}
function needRaw(v: unknown, what: string): string {
  if (typeof v !== 'string' || !RAW.test(v)) throw bad(`${what} is a positive whole number of raw units, as a string.`);
  return v;
}

/** The long-poll body of a heartbeat: `wait` 1..25 whole seconds and `since` when known; and the request's timeout. */
function longPoll(o: LongPollOptions, base: number): { body: { wait?: number; since?: number }; timeoutMs: number } {
  const wait = typeof o.wait === 'number' && Number.isSafeInteger(o.wait) && o.wait > 0 ? Math.min(o.wait, LONG_POLL_MAX) : 0;
  const since = typeof o.since === 'number' && Number.isSafeInteger(o.since) && o.since >= 0 ? o.since : null;
  const body: { wait?: number; since?: number } = {};
  if (wait > 0) body.wait = wait;
  if (since != null) body.since = since;
  return { body, timeoutMs: base + wait * 1000 };
}

/** A call's own answer timeout (CallOptions.timeoutMs), ms, or null for the client's. */
function callTimeout(o: CallOptions): number | null {
  return typeof o.timeoutMs === 'number' && Number.isSafeInteger(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : null;
}

const serverTimeOf = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null);

/** The query value of a list's token: one of the table, or 'all'. */
function listSymbol(symbol: unknown): string {
  if (symbol === undefined || symbol === 'all') return 'all';
  const s = tableSymbol(symbol);
  if (!s) throw bad('symbol is one of the kit\'s tokens (TAZ, SOUL, KCAL, RA) or "all".');
  return s;
}

/** A NewOffer as the board takes it, checked for shape (check 7 itself is the flows'). */
function offerBody(b: NewOffer): NewOffer {
  if (!isRec(b)) throw bad('An offer is an object.');
  if (b.side !== 'sell' && b.side !== 'buy') throw bad('side is sell or buy.');
  const symbol = tableSymbol(b.symbol);
  if (!symbol) throw bad('symbol is one of the kit\'s tokens (TAZ, SOUL, KCAL, RA).');
  if (!isPhaAddress(b.makerPha)) throw bad('makerPha is a Phantasma address (P2K…).');
  const makerBase = evmLower(b.makerBase);
  if (!makerBase) throw bad('makerBase is a Base address (0x + 40 hex).');
  const out: NewOffer = {
    side: b.side, symbol, makerPha: b.makerPha, makerBase,
    tazTotal: needRaw(b.tazTotal, 'tazTotal'), tazMin: needRaw(b.tazMin, 'tazMin'), tazMax: needRaw(b.tazMax, 'tazMax')
  };
  if (b.follow !== undefined && b.follow !== null) {
    const f = b.follow as FollowSettings;
    if (!isRec(f) || typeof f.offsetBps !== 'number' || !Number.isInteger(f.offsetBps) || Math.abs(f.offsetBps) > 2000) throw bad('follow.offsetBps is a whole number from -2000 to 2000.');
    // dailyMax defaults to the offer's total (section 2.4.6), sent explicitly so a replay compares the same figures.
    out.follow = { offsetBps: f.offsetBps, limitPrice: needRaw(f.limitPrice, 'follow.limitPrice'), dailyMax: f.dailyMax === undefined ? out.tazTotal : needRaw(f.dailyMax, 'follow.dailyMax') };
  } else {
    out.price = needRaw(b.price, 'price');
  }
  if (b.mode === 'instant') out.mode = 'instant';
  else if (b.mode !== undefined && b.mode !== 'standard') throw bad('mode is standard or instant.');
  return out;
}

/** A take body as the board takes it: the amount, the taker's addresses, the offer's token and the price the kit read. */
function takeBody(b: TakeBody & { price?: string }): Required<Pick<TakeBody, 'taz' | 'takerPha' | 'takerBase' | 'symbol' | 'price'>> {
  if (!isRec(b)) throw bad('A take is an object.');
  const symbol = tableSymbol(b.symbol);
  if (!symbol) throw bad('A take names the offer\'s token (symbol).');
  if (!isPhaAddress(b.takerPha)) throw bad('takerPha is a Phantasma address (P2K…).');
  const takerBase = evmLower(b.takerBase);
  if (!takerBase) throw bad('takerBase is a Base address (0x + 40 hex).');
  // Every take names the price the kit read (section 2.3.3): no trade is fixed at a price the kit did not see.
  return { taz: needRaw(b.taz, 'taz'), takerPha: b.takerPha, takerBase, symbol, price: needRaw(b.price, 'price (the offer\'s price the kit read)') };
}

/**
 * Why a pending create cannot be asked about again with exactly what was
 * sent (its body is not one the kit sends, or a take lacks the offer it read,
 * which its record needs), or null.
 */
function pendingAskProblem(p: PendingCreate): string | null {
  try {
    if (p.kind === 'offer') {
      offerBody(p.body as NewOffer);
      return null;
    }
    takeBody(p.body as TakeBody & { price?: string });
    const s = p.seen;
    if (!isRec(s) || (s.side !== 'sell' && s.side !== 'buy') || !isPhaAddress(s.makerPha) || !evmLower(s.makerBase)) return 'the offer it takes is not kept with it';
    return null;
  } catch (e) {
    if (e instanceof SafetyError) return e.detail;
    throw e;
  }
}

/** The REST client of the P2P board (build spec section 6.3). See the file comment. */
export class BoardClient {
  readonly network: Network;
  /** The API base, for messages (no secret: a URL with a user part or a query is refused). */
  readonly api: string;
  readonly #apiKey: string | null;
  readonly #fetch: typeof fetch;
  readonly #log: LogFn;
  readonly #timeoutMs: number;
  readonly #retries: number;
  readonly #sleep: SleepFn;
  readonly #random: () => number;

  constructor(o: BoardClientOptions) {
    if (!isRec(o) || (o.network !== 'devnet' && o.network !== 'mainnet')) throw bad('The network is devnet or mainnet.');
    this.network = o.network;
    this.api = apiBase(o.api ?? DEFAULT_API);
    if (o.apiKey !== undefined && o.apiKey !== null && o.apiKey !== '') {
      if (typeof o.apiKey !== 'string' || !/^[\x21-\x7e]{8,256}$/.test(o.apiKey)) throw bad('The API key is 8 to 256 visible characters (sat_…).');
      this.#apiKey = o.apiKey;
    } else {
      this.#apiKey = null;
    }
    const f = o.fetch ?? globalThis.fetch;
    if (typeof f !== 'function') throw bad('No fetch is available (Node 22 or later has one).');
    this.#fetch = f;
    this.#log = redactedLog(o.log);
    this.#timeoutMs = typeof o.timeoutMs === 'number' && Number.isSafeInteger(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : REQUEST_TIMEOUT_MS;
    this.#retries = typeof o.retries === 'number' && Number.isSafeInteger(o.retries) ? Math.max(0, Math.min(o.retries, 10)) : MAX_RETRIES;
    this.#sleep = o.sleep ?? sleep;
    this.#random = o.random ?? Math.random;
  }

  /** Whether an API key is configured (the key itself is never exposed). */
  get keyed(): boolean {
    return this.#apiKey !== null;
  }

  // ── Transport ────────────────────────────────────────────────────────────

  /** One send: the answer, or a BoardError (NETWORK when there was no answer). */
  async #once(req: Req, signal?: AbortSignal): Promise<Answer> {
    const url = new URL(this.api + req.path);
    url.searchParams.set('network', this.network);
    for (const [k, v] of Object.entries(req.query ?? {})) if (k !== 'network') url.searchParams.set(k, v);
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'saturn-p2p-bot-kit' };
    if (req.body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.#apiKey) headers['X-API-Key'] = this.#apiKey;
    if (req.token !== undefined) headers.Authorization = `Bearer ${needToken(req.token)}`;
    if (signal?.aborted) throw aborted();
    const ctl = new AbortController();
    const stop = () => ctl.abort();
    const timer = setTimeout(stop, req.timeoutMs ?? this.#timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    let res: Response;
    let text: string;
    try {
      res = await this.#fetch(url, {
        method: req.method, headers, signal: ctl.signal, redirect: 'error',
        body: req.body === undefined ? undefined : JSON.stringify(req.body)
      });
      text = await res.text();
    } catch {
      if (signal?.aborted) throw aborted();
      throw new BoardError('NETWORK', 0, true, null, null, ctl.signal.aborted ? 'The board did not answer in time' : 'Could not reach the board');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    }
    if (text.length > MAX_ANSWER_BYTES) throw badAnswer('an answer too large', res.status);
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON: a proxy's page, or a plain-text 404 */ }
    if (!res.ok) throw errorOf(res.status, json, res.headers.get('retry-after'));
    const data = isRec(json) && 'data' in json ? json.data : json;
    return { status: res.status, data, headers: res.headers };
  }

  /** The wait before the next send after `e` (attempt `i`, 0-based), ms, or null for "do not send it again". */
  #delayOf(e: BoardError, i: number, p: Policy): number | null {
    if (NEVER_RETRY.has(e.code)) return null;
    let s: number;
    if (e.code === 'NETWORK') {
      s = 2 ** i;
    } else if (e.retryable) {
      if (e.retryAfter != null && p.maxRetryAfter != null && e.retryAfter > p.maxRetryAfter) return null;
      s = e.retryAfter ?? 2 ** i;
    } else {
      return null;
    }
    const jitter = 1 - RETRY_JITTER + 2 * RETRY_JITTER * Math.min(Math.max(this.#random(), 0), 1);
    return Math.round(Math.min(s, RETRY_AFTER_MAX) * 1000 * jitter);
  }

  /** A request under the retry policy (section 6.3). */
  async #call(req: Req, p: Policy = {}): Promise<Answer> {
    const retries = typeof p.retries === 'number' && Number.isSafeInteger(p.retries) ? Math.max(0, Math.min(p.retries, 10)) : this.#retries;
    const resend = p.resend ?? 'always';
    const what = `${req.method} ${req.path}`;
    const own = req.timeoutMs === undefined ? callTimeout(p) : null;
    const one: Req = own === null ? req : { ...req, timeoutMs: own };
    for (let i = 0; ;) {
      let last: BoardError;
      try {
        await p.beforeSend?.();
        return await this.#once(one, p.signal);
      } catch (e) {
        if (!(e instanceof BoardError)) throw e;
        last = e;
      }
      const unknown = outcomeUnknown(last);
      if (unknown && p.track) p.track.unknown = last;
      if (unknown && resend === 'never') throw last;
      // Find the next send: wait, and (for an unknown outcome) make sure sending again is safe.
      for (;;) {
        const ms = i < retries ? this.#delayOf(last, i, p) : null;
        if (ms == null) throw last;
        i++;
        this.#log(`board: ${what} failed (${last.code}${last.status ? `, ${last.status}` : ''}); sending it again in ${(ms / 1000).toFixed(1)} s (retry ${i} of ${retries})`);
        await this.#sleep(ms, p.signal);
        if (p.signal?.aborted) throw aborted();
        if (!unknown || resend === 'always') break;
        const ok = await (resend as () => Promise<boolean | null>)();
        if (ok === true) break;
        if (ok === false) throw last;
        // Not known yet: this send is skipped and counts as one.
        this.#log(`board: ${what} is not sent again yet: whether the board keeps client tokens is not known`);
      }
    }
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  /** GET /config: display only (the kit trusts its own pins, section 0.4). */
  async config(o: CallOptions = {}): Promise<P2PConfig> {
    const a = await this.#call({ method: 'GET', path: '/v1/p2p/config' }, o);
    if (!isRec(a.data) || a.data.network !== this.network) throw badAnswer('a /config', a.status);
    return a.data as unknown as P2PConfig;
  }

  /** GET /offers: open offers, of every token unless `symbol` names one. Offers the kit cannot read are left out. */
  async offers(q: { side?: Side; symbol?: string } = {}, o: CallOptions = {}): Promise<Offer[]> {
    const query: Record<string, string> = { symbol: listSymbol(q.symbol) };
    if (q.side !== undefined) {
      if (q.side !== 'sell' && q.side !== 'buy') throw bad('side is sell or buy.');
      query.side = q.side;
    }
    const a = await this.#call({ method: 'GET', path: '/v1/p2p/offers', query }, o);
    if (!Array.isArray(a.data)) throw badAnswer('an offer list', a.status);
    const out = a.data.map((x) => parseOffer(x, this.network)).filter((x): x is Offer => x != null);
    if (out.length < a.data.length) this.#log(`board: ${a.data.length - out.length} offer(s) the kit cannot read were left out`);
    return out;
  }

  /** GET /recent: the public feed of done trades, newest first (section 2.3.1). */
  async recent(q: { symbol?: string; limit?: number; before?: string } = {}, o: CallOptions = {}): Promise<RecentPage> {
    const query: Record<string, string> = { symbol: listSymbol(q.symbol) };
    if (q.limit !== undefined) {
      if (!Number.isSafeInteger(q.limit) || q.limit < 1 || q.limit > 100) throw bad('limit is a whole number from 1 to 100.');
      query.limit = String(q.limit);
    }
    if (q.before !== undefined) {
      if (typeof q.before !== 'string' || !/^[A-Za-z0-9_-]{1,44}$/.test(q.before)) throw bad('before is the `next` of an earlier page.');
      query.before = q.before;
    }
    const a = await this.#call({ method: 'GET', path: '/v1/p2p/recent', query }, o);
    if (!isRec(a.data) || !Array.isArray(a.data.trades)) throw badAnswer('a feed page', a.status);
    const next = typeof a.data.next === 'string' && /^[A-Za-z0-9_-]{1,44}$/.test(a.data.next) ? a.data.next : null;
    return { trades: a.data.trades.map((x) => parseFeedTrade(x, this.network)).filter((x): x is FeedTrade => x != null), next };
  }

  /** GET /v1/prices/reference: display only, never feeds a signature (section 0.1, invariant 4). */
  async reference(o: CallOptions = {}): Promise<Reference> {
    const a = await this.#call({ method: 'GET', path: '/v1/prices/reference' }, o);
    if (!isRec(a.data) || !isRec(a.data.tokens)) throw badAnswer('a reference', a.status);
    return a.data as unknown as Reference;
  }

  /** GET /me: this API key's limits, no-shows and cap share (needs an API key; 401 otherwise). */
  async me(o: CallOptions = {}): Promise<Me> {
    const a = await this.#call({ method: 'GET', path: '/v1/p2p/me' }, o);
    if (!isRec(a.data) || !isRec(a.data.key) || !isRec(a.data.noShows) || !isRec(a.data.capShare)) throw badAnswer('a /me answer', a.status);
    return a.data as unknown as Me;
  }

  /**
   * Whether the board keeps client token hashes, and so honours `replayOnly`
   * (section 2.1.4): a board from before them has no feed (404). null when it
   * could not be told (no answer, P2P off on the network, another refusal).
   * Asked once, never cached: a cache would outlive a rollback of the board.
   */
  async keepsHashes(o: { signal?: AbortSignal } = {}): Promise<boolean | null> {
    try {
      await this.#call({ method: 'GET', path: '/v1/p2p/recent', query: { symbol: 'all', limit: '1' } }, { retries: 0, signal: o.signal });
      return true;
    } catch (e) {
      if (!(e instanceof BoardError)) return null;
      if (e.status === 404) return e.code === 'P2P_OFF' ? null : false;
      // The feed's own 503 while the database is upgraded: this board has the feed.
      if (e.code === 'UNAVAILABLE' && e.reason === 'migrating') return true;
      return null;
    }
  }

  /** GET /trades/:id with `symbol=all` (section 6.3), and the long-poll of section 2.4.4 when `wait` is given. */
  async tradeAnswer(id: number, o: LongPollOptions = {}): Promise<TradeAnswer> {
    needId(id, 'A trade id');
    const lp = longPoll(o, callTimeout(o) ?? this.#timeoutMs);
    const query: Record<string, string> = { symbol: 'all' };
    if (lp.body.wait) query.wait = String(lp.body.wait);
    if (lp.body.since != null) query.since = String(lp.body.since);
    const a = await this.#call({ method: 'GET', path: `/v1/p2p/trades/${id}`, query, timeoutMs: lp.timeoutMs }, o);
    const trade = parseTrade(a.data, this.network);
    if (!trade || trade.id !== id) throw badAnswer('a trade', a.status);
    const st = (a.headers.get('x-server-time') ?? '').trim();
    return { trade, serverTime: /^[1-9]\d{0,15}$/.test(st) ? Number(st) : null, waited: (a.headers.get('x-waited') ?? '').trim() === '1' };
  }

  /** GET /trades/:id?symbol=all (section 6.3). */
  async trade(id: number, o: LongPollOptions = {}): Promise<Trade> {
    return (await this.tradeAnswer(id, o)).trade;
  }

  /** GET /trades?address=…&symbol=all: the trades of a Phantasma or Base address (at most 100, newest first). */
  async tradesOf(address: string, q: { symbol?: string } = {}, o: CallOptions = {}): Promise<Trade[]> {
    if (!isPhaAddress(address) && !evmLower(address)) throw bad('address is a Phantasma address (P2K…) or a Base address (0x…).');
    const a = await this.#call({ method: 'GET', path: '/v1/p2p/trades', query: { address, symbol: listSymbol(q.symbol) } }, o);
    if (!Array.isArray(a.data)) throw badAnswer('a trade list', a.status);
    return a.data.map((x) => parseTrade(x, this.network)).filter((x): x is Trade => x != null);
  }

  // ── Creates ──────────────────────────────────────────────────────────────

  /**
   * Run a create (offer or take) under the create rules: a send whose
   * outcome is unknown is sent again only to a board that keeps client
   * hashes, asked once per create. Every failure is a CreateError.
   */
  async #create<T>(kind: 'offer' | 'take', tokenHash: string, req: Req, p: Policy, read: (a: Answer) => T): Promise<T> {
    const track = { unknown: null as BoardError | null };
    let keeps: boolean | null = null;
    const resend = async (): Promise<boolean | null> => {
      keeps ??= await this.keepsHashes({ signal: p.signal });
      return keeps;
    };
    let a: Answer;
    try {
      // A replayOnly ask never makes anything, so sending it again is always safe.
      a = await this.#call(req, { ...p, track, resend: (req.body as { replayOnly?: boolean }).replayOnly === true ? 'always' : resend });
    } catch (e) {
      if (!(e instanceof BoardError)) throw e;
      throw new CreateError(e, { kind, tokenHash, mayExist: track.unknown != null });
    }
    return read(a);
  }

  /**
   * POST /offers (sections 2.1.4, 2.3.2, 2.4.6). `makerTokenHash` is
   * required (the kit always makes its own token). Answers 201 (made) or 200
   * (`replayed`); `makerToken` is set only when the board ignored the hash
   * and made a token of its own (an older board). `replayOnly`: only ask
   * whether an earlier send arrived (404 `no_such_request` otherwise; nothing
   * is made). A board from before client hashes ignores `replayOnly` and
   * makes the offer, so ask only a board that keeps them (keepsHashes(), as
   * BoardSession.reconcilePending does). Failures are CreateError.
   */
  async createOffer(body: NewOffer & { makerTokenHash: string; replayOnly?: boolean }, o: CallOptions & { beforeSend?: () => Promise<void> } = {}): Promise<CreateOfferAnswer> {
    const hash = needHash(body?.makerTokenHash, 'makerTokenHash');
    const send: Record<string, unknown> = { ...offerBody(body), makerTokenHash: hash };
    if (body.replayOnly === true) send.replayOnly = true;
    return this.#create('offer', hash, { method: 'POST', path: '/v1/p2p/offers', body: send }, o, (a) => {
      const d = isRec(a.data) ? a.data : {};
      const token = d.makerToken === undefined || d.makerToken === null ? null : typeof d.makerToken === 'string' && TOKEN_RE.test(d.makerToken) ? d.makerToken : undefined;
      const offer = parseOffer(d.offer, this.network);
      if (!offer || token === undefined) {
        const id = isRec(d.offer) && isId(d.offer.id) ? d.offer.id : null;
        throw new CreateError(badAnswer('an offer', a.status), { kind: 'offer', tokenHash: hash, mayExist: true, created: id ? { id, token: token ?? null } : null });
      }
      const out: CreateOfferAnswer = { offer, replayed: a.status === 200 || d.replayed === true };
      if (token) out.makerToken = token;
      return out;
    });
  }

  /**
   * POST /offers/:id/take (sections 2.1.4, 2.3.3). `price` is required: the
   * offer's price the kit read; a board whose offer has another price now
   * answers 409 PRICE_CHANGED, which is never sent again (read the offer and
   * decide anew). `symbol` is required too (409 TOKEN for another token).
   * Answers 201 (made) or 200 (`replayed`, the trade as it is now);
   * `takerToken` only from a board that ignored the hash. `replayOnly` as in
   * createOffer: ask only a board that keeps client hashes. Failures are
   * CreateError.
   */
  async take(offerId: number, body: TakeBody & { price: string; takerTokenHash: string; replayOnly?: boolean }, o: CallOptions & { beforeSend?: () => Promise<void> } = {}): Promise<TakeAnswer> {
    needId(offerId, 'An offer id');
    const hash = needHash(body?.takerTokenHash, 'takerTokenHash');
    const send: Record<string, unknown> = { ...takeBody(body), takerTokenHash: hash };
    if (body.replayOnly === true) send.replayOnly = true;
    return this.#create('take', hash, { method: 'POST', path: `/v1/p2p/offers/${offerId}/take`, body: send }, o, (a) => {
      const d = isRec(a.data) ? a.data : {};
      const token = d.takerToken === undefined || d.takerToken === null ? null : typeof d.takerToken === 'string' && TOKEN_RE.test(d.takerToken) ? d.takerToken : undefined;
      const trade = parseTrade(d.trade, this.network);
      if (!trade || token === undefined || trade.offerId !== offerId) {
        const id = isRec(d.trade) && isId(d.trade.id) ? d.trade.id : null;
        throw new CreateError(badAnswer('a trade', a.status), { kind: 'take', tokenHash: hash, mayExist: true, created: id ? { id, token: token ?? null } : null });
      }
      const out: TakeAnswer = { trade, replayed: a.status === 200 || d.replayed === true };
      if (token) out.takerToken = token;
      return out;
    });
  }

  // ── The maker's calls ────────────────────────────────────────────────────

  /**
   * POST /offers/:id/heartbeat, with the long-poll of section 2.4.3 when
   * `wait` is given. `serverTime` is set only by a board with the long-poll;
   * `waited` is false otherwise.
   */
  async heartbeat(id: number, token: string, o: LongPollOptions = {}): Promise<HeartbeatAnswer & { waited: boolean }> {
    needId(id, 'An offer id');
    needToken(token);
    const lp = longPoll(o, callTimeout(o) ?? this.#timeoutMs);
    const a = await this.#call({ method: 'POST', path: `/v1/p2p/offers/${id}/heartbeat`, token, body: lp.body, timeoutMs: lp.timeoutMs }, o);
    const d = isRec(a.data) ? a.data : {};
    const offer = parseOffer(d.offer, this.network);
    if (!offer || offer.id !== id) throw badAnswer('a heartbeat answer', a.status);
    const trades = (Array.isArray(d.trades) ? d.trades : []).map((x) => parseTrade(x, this.network)).filter((t): t is Trade => t != null && t.offerId === id);
    const out: HeartbeatAnswer & { waited: boolean } = { offer, trades, waited: d.waited === true };
    const st = serverTimeOf(d.serverTime);
    if (st != null) out.serverTime = st;
    return out;
  }

  /**
   * POST /heartbeats (section 2.4.5): up to 40 offers in one request, charged
   * as one write, with the same long-poll. Each result is the offer's answer
   * or its own error. A board without the route answers 404 (not P2P_OFF):
   * the caller then sends one heartbeat per offer (OfferPoller does).
   */
  async heartbeats(items: ReadonlyArray<{ id: number; token: string }>, o: LongPollOptions = {}): Promise<BatchAnswer> {
    const ids = new Map<number, string>();
    for (const it of Array.isArray(items) ? items : []) {
      needId(it?.id, 'An offer id');
      needToken(it.token);
      if (ids.has(it.id) && ids.get(it.id) !== it.token) throw bad(`Offer #${it.id} is listed twice with different tokens.`);
      ids.set(it.id, it.token);
    }
    if (ids.size < 1 || ids.size > HEARTBEATS_MAX) throw bad(`One batch heartbeat carries 1 to ${HEARTBEATS_MAX} offers.`);
    const lp = longPoll(o, callTimeout(o) ?? this.#timeoutMs);
    const a = await this.#call({
      method: 'POST', path: '/v1/p2p/heartbeats', body: { offers: [...ids].map(([id, token]) => ({ id, token })), ...lp.body }, timeoutMs: lp.timeoutMs
    }, o);
    const d = isRec(a.data) ? a.data : {};
    const serverTime = serverTimeOf(d.serverTime);
    if (!Array.isArray(d.results) || serverTime == null) throw badAnswer('a batch heartbeat answer', a.status);
    const results: BatchResult[] = [];
    const seen = new Set<number>();
    for (const x of d.results) {
      if (!isRec(x) || !isId(x.id) || !ids.has(x.id) || seen.has(x.id)) continue;
      seen.add(x.id);
      const id = x.id;
      if (x.ok === true) {
        const offer = parseOffer(x.offer, this.network);
        if (!offer || offer.id !== id) {
          results.push({ id, ok: false, error: { code: 'BAD_ANSWER', message: 'The board sent an offer the kit cannot read', retryable: false } });
          continue;
        }
        const trades = (Array.isArray(x.trades) ? x.trades : []).map((t) => parseTrade(t, this.network)).filter((t): t is Trade => t != null && t.offerId === id);
        results.push({ id, ok: true, offer, trades });
      } else {
        const e = isRec(x.error) ? x.error : {};
        const code = typeof e.code === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(e.code) ? e.code : 'BAD_ANSWER';
        const err: BoardErrorBody['error'] = { code, message: typeof e.message === 'string' ? e.message.slice(0, 300) : '' };
        if (typeof e.retryable === 'boolean') err.retryable = e.retryable;
        if (typeof e.retryAfter === 'number' && Number.isSafeInteger(e.retryAfter) && e.retryAfter >= 0) err.retryAfter = e.retryAfter;
        if (typeof e.reason === 'string' && /^[a-z0-9_]{1,40}$/.test(e.reason)) err.reason = e.reason;
        results.push({ id, ok: false, error: err });
      }
    }
    return { results, serverTime, waited: d.waited === true };
  }

  /** POST /offers/:id/cancel. An offer already closed (CLOSED) counts as cancelled: a resend after a lost answer gets that. */
  async cancel(id: number, token: string, o: CallOptions = {}): Promise<void> {
    needId(id, 'An offer id');
    try {
      await this.#call({ method: 'POST', path: `/v1/p2p/offers/${id}/cancel`, token: needToken(token), body: {} }, o);
    } catch (e) {
      if (e instanceof BoardError && e.code === 'CLOSED') return;
      throw e;
    }
  }

  /**
   * POST /offers/:id/reprice (section 2.4.7): a fixed `price` (which also
   * turns following off) or new `follow` settings. Trades already taken keep
   * their price. TOO_SOON (within 10 s of the last change) is waited out.
   */
  async reprice(id: number, token: string, change: RepriceBody, o: CallOptions = {}): Promise<Offer> {
    needId(id, 'An offer id');
    let body: RepriceBody;
    if (isRec(change) && 'follow' in change && change.follow !== undefined) {
      const f = change.follow;
      if (!isRec(f) || typeof f.offsetBps !== 'number' || !Number.isInteger(f.offsetBps) || Math.abs(f.offsetBps) > 2000) throw bad('follow.offsetBps is a whole number from -2000 to 2000.');
      body = { follow: { offsetBps: f.offsetBps, limitPrice: needRaw(f.limitPrice, 'follow.limitPrice'), ...(f.dailyMax !== undefined ? { dailyMax: needRaw(f.dailyMax, 'follow.dailyMax') } : {}) } };
    } else if (isRec(change) && 'price' in change) {
      body = { price: needRaw((change as { price: unknown }).price, 'price') };
    } else {
      throw bad('A price change is { price } or { follow }.');
    }
    const a = await this.#call({ method: 'POST', path: `/v1/p2p/offers/${id}/reprice`, token: needToken(token), body }, o);
    const offer = parseOffer(isRec(a.data) ? a.data.offer : null, this.network);
    if (!offer || offer.id !== id) throw badAnswer('an offer', a.status);
    return offer;
  }

  /** POST /trades/:id/accept (the maker's token). Accepting twice answers the trade as it is. */
  async accept(id: number, token: string, o: CallOptions = {}): Promise<Trade> {
    return this.#tradeCall(id, 'accept', token, {}, o);
  }

  /** POST /trades/:id/decline (the maker's token). */
  async decline(id: number, token: string, o: CallOptions = {}): Promise<Trade> {
    return this.#tradeCall(id, 'decline', token, {}, o);
  }

  /** POST /trades/:id/pha-locked (S's token): h, and the lock's transaction when known. NOT_YET and NOT_CONFIRMED are waited out. */
  async phaLocked(id: number, token: string, b: { h: string; txHash?: string }, o: CallOptions = {}): Promise<Trade> {
    if (!isHex32(b?.h)) throw bad('h is 0x + 64 hex characters.');
    const body: { h: string; txHash?: string } = { h: b.h.toLowerCase() };
    if (b.txHash !== undefined) {
      if (typeof b.txHash !== 'string' || !PHA_TX.test(b.txHash)) throw bad('txHash is a Phantasma transaction hash (64 hex characters).');
      body.txHash = b.txHash;
    }
    return this.#tradeCall(id, 'pha-locked', token, body, o);
  }

  /** POST /trades/:id/base-locked (B's token): the lock's transaction (and h in instant mode, wave C). */
  async baseLocked(id: number, token: string, b: { txHash: string; h?: string }, o: CallOptions = {}): Promise<Trade> {
    if (typeof b?.txHash !== 'string' || !BASE_TX.test(b.txHash)) throw bad('txHash is 0x + 64 hex characters.');
    const body: { txHash: string; h?: string } = { txHash: b.txHash };
    if (b.h !== undefined) {
      if (!isHex32(b.h)) throw bad('h is 0x + 64 hex characters.');
      body.h = b.h.toLowerCase();
    }
    return this.#tradeCall(id, 'base-locked', token, body, o);
  }

  async #tradeCall(id: number, step: string, token: string, body: object, o: CallOptions): Promise<Trade> {
    needId(id, 'A trade id');
    const a = await this.#call({ method: 'POST', path: `/v1/p2p/trades/${id}/${step}`, token: needToken(token), body }, o);
    const trade = parseTrade(a.data, this.network);
    if (!trade || trade.id !== id) throw badAnswer('a trade', a.status);
    return trade;
  }

  /**
   * POST /trades/:id/reveal: hand the secret to Saturn's keeper. Only for
   * `claimMode: 'reveal-then-self'`, and only after checks 52-58 (the flows'
   * job). The board answers only `{ok: true}`.
   */
  async reveal(id: number, secret: string, o: CallOptions = {}): Promise<void> {
    needId(id, 'A trade id');
    if (!isHex32(secret)) throw bad('A secret is 0x + 64 hex characters.');
    const a = await this.#call({ method: 'POST', path: `/v1/p2p/trades/${id}/reveal`, body: { secret: secret.toLowerCase() } }, o);
    if (!isRec(a.data) || a.data.ok !== true) throw badAnswer('a reveal answer', a.status);
  }

  // ── The devnet faucet (section 2.4.10; the rules are in faucet.ts) ───────

  /** GET /faucet: whether it is on, what one claim sends, which parts are on. */
  async faucetInfo(o: CallOptions = {}): Promise<FaucetInfoAnswer> {
    const a = await this.#call({ method: 'GET', path: '/v1/p2p/faucet' }, o);
    const info = parseFaucetInfo(a.data);
    if (!info) throw badAnswer('a faucet answer', a.status);
    return info;
  }

  /**
   * POST /faucet (202). Not idempotent: a send whose answer was lost is
   * never sent again here (faucet.ts devnetFaucet decides), and a refusal
   * that asks for a long wait (FAUCET_EMPTY) is not waited out.
   */
  async faucet(b: { pha?: string; base?: string }, o: CallOptions = {}): Promise<FaucetClaim> {
    // Devnet only, before anything is sent (section 7 invariant 12): mainnet has no faucet.
    if (this.network !== 'devnet') throw new SafetyError(SAFETY.NETWORK_OFF, 'The faucet runs on devnet only; mainnet has none.');
    const body: { pha?: string; base?: string } = {};
    if (b?.pha !== undefined) {
      if (!isPhaAddress(b.pha)) throw bad('pha is a Phantasma address (P2K…).');
      body.pha = b.pha;
    }
    if (b?.base !== undefined) {
      if (!evmLower(b.base)) throw bad('base is a Base address (0x + 40 hex).');
      body.base = b.base;
    }
    if (!body.pha && !body.base) throw bad('Name a Phantasma address, a Base address or both.');
    const a = await this.#call({ method: 'POST', path: '/v1/p2p/faucet', body }, { maxRetryAfter: 10, ...o, resend: 'never' });
    const claim = parseFaucetClaim(a.data);
    if (!claim) throw badAnswer('a faucet answer', a.status);
    return claim;
  }
}

// ── Long-polls (sections 2.4.3-2.4.5) ────────────────────────────────────────

/**
 * The client rule of section 2.4.3, for one stream of answers: the next
 * `since` is the previous answer's server time; trades are deduplicated by
 * (id, updatedAt, status); an answer that did not wait and brought the same
 * trades as the one before is followed by a 1 s pause. A board without the
 * long-poll (no server time), or a round sent without a wait, is polled every
 * `plainMs`.
 *
 * The 1 s pause bounds the inclusive bound's echo to one extra call per
 * change. A board that keeps answering at once with nothing new (this client
 * is over the board's long-poll concurrency cap, section 2.1.5) would be
 * asked every second for as long as that lasts, so such answers in a row
 * double the pause, 1, 2, 4 s, up to `plainMs`. An answer the board held, or
 * one that brought something new, starts again from no pause.
 */
class PollRule {
  since: number | null = null;
  pauseMs = 0;
  #lastKeys: string | null = null;
  #seen = new Map<number, string>();
  /** Unchanged answers in a row that the board did not hold. */
  #idle = 0;

  constructor(readonly plainMs: number, readonly waits: boolean) {}

  /**
   * Record an answer; returns its trades that are new or changed since the
   * previous one. `longPolled`: whether this round asked the board to wait
   * (a round sent without a wait is a plain poll).
   */
  observe(trades: readonly Trade[], serverTime: number | null, waited: boolean, longPolled = this.waits): Trade[] {
    const changed = trades.filter((t) => this.#seen.get(t.id) !== tradeKey(t));
    // Only the trades of this answer are remembered: one that comes back later counts as changed again (harmless).
    this.#seen = new Map(trades.map((t) => [t.id, tradeKey(t)]));
    const keys = trades.map(tradeKey).sort().join('|');
    if (serverTime == null || !longPolled) {
      this.pauseMs = this.plainMs;
      this.#idle = 0;
    } else if (waited || keys !== this.#lastKeys) {
      this.pauseMs = 0;
      this.#idle = 0;
    } else {
      this.#idle++;
      this.pauseMs = Math.max(UNCHANGED_PAUSE_MS, Math.min(UNCHANGED_PAUSE_MS * 2 ** Math.min(this.#idle - 1, 16), this.plainMs));
    }
    this.#lastKeys = keys;
    if (serverTime != null) this.since = serverTime;
    return changed;
  }
}

export interface PollerOptions {
  /** Seconds each long-poll may wait at the board (default 25; 0 polls plainly). The first round sends no wait. */
  wait?: number;
  /** The interval against a board without the long-poll, or with `wait` 0, ms (default 5 s). */
  plainEveryMs?: number;
  /** For tests. */
  sleep?: SleepFn;
  now?: () => number;
  log?: LogFn;
}

/** One round of the maker's heartbeats. */
export interface OfferRound {
  /** The offers the board answered for, by id, as it lists them now. */
  offers: Map<number, Offer>;
  /** Every trade in this round's answers (the offers' trades that are not finished). */
  trades: Trade[];
  /** The trades new or changed since the previous round (by id, updatedAt and status). */
  changed: Trade[];
  /** Per-offer refusals: CLOSED, UNAUTHORIZED, NOT_FOUND and the like. */
  errors: Map<number, BoardError>;
  /** The board's clock (the next round's `since`), or null from a board without the long-poll. */
  serverTime: number | null;
  waited: boolean;
  /** 'single': one offer's long-poll; 'batch': POST /heartbeats; 'each': a board without the batch, one heartbeat per offer. */
  mode: 'single' | 'batch' | 'each';
}

/** Per-offer refusals of a heartbeat: the round goes on for the other offers. */
const PER_OFFER = (e: BoardError) => e.code === 'CLOSED' || e.code === 'UNAUTHORIZED' || (e.code === 'NOT_FOUND' && e.status === 404) || e.code === 'BAD_ANSWER';

const errorFromItem = (e: BoardErrorBody['error']): BoardError => {
  const rule = retryRuleOf(e.code, BOARD_ERRORS[e.code]?.http ?? 0);
  return new BoardError(e.code, BOARD_ERRORS[e.code]?.http ?? 0, e.retryable ?? rule.retryable, e.retryAfter ?? null, e.reason ?? null, e.message);
};

/**
 * The maker's heartbeats with the long-poll (sections 2.4.3 and 2.4.5): one
 * offer is long-polled by its own heartbeat, more by the batch (40 at most
 * per request; more than 40 are polled without a wait, every
 * `plainEveryMs`). A board without the batch route (404, not P2P_OFF) gets
 * one plain heartbeat per offer, and is asked again 10 minutes later.
 *
 * A heartbeat lists only the offer's running trades: a trade that ends
 * (done, refunded, cancelled, expired) drops out of the answers without
 * being reported as changed. Read its end with TradePoller or
 * BoardClient.trade.
 */
export class OfferPoller {
  readonly #board: BoardClient;
  readonly #wait: number;
  readonly #rule: PollRule;
  readonly #sleep: SleepFn;
  readonly #now: () => number;
  readonly #log: LogFn;
  #noBatchUntil = 0;

  constructor(board: BoardClient, o: PollerOptions = {}) {
    this.#board = board;
    this.#wait = typeof o.wait === 'number' && Number.isSafeInteger(o.wait) && o.wait >= 0 ? Math.min(o.wait, LONG_POLL_MAX) : LONG_POLL_MAX;
    const plain = typeof o.plainEveryMs === 'number' && Number.isSafeInteger(o.plainEveryMs) && o.plainEveryMs >= 0 ? o.plainEveryMs : PLAIN_POLL_MS;
    this.#rule = new PollRule(plain, this.#wait > 0);
    this.#sleep = o.sleep ?? sleep;
    this.#now = o.now ?? Date.now;
    this.#log = redactedLog(o.log);
  }

  /** The `since` the next round sends (the previous answer's server time), or null. */
  get since(): number | null {
    return this.#rule.since;
  }

  /** How long the next round waits before it sends (the client rule), ms. */
  get pauseMs(): number {
    return this.#rule.pauseMs;
  }

  /** Send one round of heartbeats for `items` (their tokens) and return what changed. */
  async next(items: ReadonlyArray<{ id: number; token: string }>, signal?: AbortSignal): Promise<OfferRound> {
    if (!Array.isArray(items) || items.length === 0) throw bad('A heartbeat round needs at least one offer.');
    if (this.#rule.pauseMs > 0) await this.#sleep(this.#rule.pauseMs, signal);
    if (signal?.aborted) throw aborted();
    // This stream long-polls: up to 40 offers, with a wait. Its first round (no answer yet, so no `since`: after a
    // start or a restart) is sent without a wait, so takes made while the kit was down come back at once; a held
    // call without `since` would only count changes from now and keep them for the whole wait.
    const longPolls = items.length <= HEARTBEATS_MAX && this.#wait > 0;
    const wait = longPolls && this.#rule.since != null ? this.#wait : 0;
    const lp = { wait, since: this.#rule.since, signal };
    const offers = new Map<number, Offer>();
    const errors = new Map<number, BoardError>();
    const trades: Trade[] = [];
    let serverTime: number | null = null;
    let waited = false;
    let mode: OfferRound['mode'];
    const one = async (id: number, token: string, opts: LongPollOptions) => {
      try {
        const a = await this.#board.heartbeat(id, token, opts);
        offers.set(id, a.offer);
        trades.push(...a.trades);
        serverTime = a.serverTime ?? serverTime;
        waited ||= a.waited;
      } catch (e) {
        if (e instanceof BoardError && PER_OFFER(e)) errors.set(id, e);
        else throw e;
      }
    };
    if (items.length === 1) {
      mode = 'single';
      await one(items[0]!.id, items[0]!.token, lp);
    } else {
      mode = this.#now() < this.#noBatchUntil ? 'each' : 'batch';
      if (mode === 'batch') {
        try {
          for (let k = 0; k < items.length; k += HEARTBEATS_MAX) {
            const a = await this.#board.heartbeats(items.slice(k, k + HEARTBEATS_MAX), lp);
            for (const r of a.results) {
              if (r.ok && r.offer) {
                offers.set(r.id, r.offer);
                trades.push(...(r.trades ?? []));
              } else if (r.error) {
                errors.set(r.id, errorFromItem(r.error));
              }
            }
            serverTime = a.serverTime;
            waited ||= a.waited;
          }
        } catch (e) {
          if (!(e instanceof BoardError && e.status === 404 && e.code !== 'P2P_OFF')) throw e;
          this.#log('board: this board has no batch heartbeat; sending one heartbeat per offer');
          this.#noBatchUntil = this.#now() + BATCH_RECHECK_MS;
          mode = 'each';
          offers.clear(); errors.clear(); trades.length = 0;
        }
      }
      if (mode === 'each') {
        for (const it of items) await one(it.id, it.token, { signal });
        // One heartbeat per offer cannot wait for all of them: this round is a plain poll.
        serverTime = null;
        waited = false;
      }
    }
    // More than 40 offers go out without a wait (one held request cannot carry them), and so does the
    // per-offer fallback: those rounds are plain polls, every `plainEveryMs`, never a tight loop of writes.
    // The first round of a long-polling stream is not: the next round long-polls from its server time at once.
    const changed = this.#rule.observe(trades, serverTime, waited, longPolls && mode !== 'each');
    return { offers, trades, changed, errors, serverTime, waited, mode };
  }
}

/** One round of a trade's long-poll. */
export interface TradeRound extends TradeAnswer {
  /** Whether the trade is new or changed since the previous round (by updatedAt and status). */
  changed: boolean;
}

/** One trade's long-poll (section 2.4.4), with the same client rule. */
export class TradePoller {
  readonly #board: BoardClient;
  readonly #id: number;
  readonly #wait: number;
  readonly #rule: PollRule;
  readonly #sleep: SleepFn;

  constructor(board: BoardClient, tradeId: number, o: PollerOptions = {}) {
    this.#board = board;
    this.#id = needId(tradeId, 'A trade id');
    this.#wait = typeof o.wait === 'number' && Number.isSafeInteger(o.wait) && o.wait >= 0 ? Math.min(o.wait, LONG_POLL_MAX) : LONG_POLL_MAX;
    const plain = typeof o.plainEveryMs === 'number' && Number.isSafeInteger(o.plainEveryMs) && o.plainEveryMs >= 0 ? o.plainEveryMs : PLAIN_POLL_MS;
    this.#rule = new PollRule(plain, this.#wait > 0);
    this.#sleep = o.sleep ?? sleep;
  }

  get since(): number | null {
    return this.#rule.since;
  }

  get pauseMs(): number {
    return this.#rule.pauseMs;
  }

  async next(signal?: AbortSignal): Promise<TradeRound> {
    if (this.#rule.pauseMs > 0) await this.#sleep(this.#rule.pauseMs, signal);
    if (signal?.aborted) throw aborted();
    // The first round (no `since` yet) is sent without a wait, as OfferPoller's: a change made before it comes back at once.
    const wait = this.#rule.since != null ? this.#wait : 0;
    const a = await this.#board.tradeAnswer(this.#id, { wait, since: this.#rule.since, signal });
    const changed = this.#rule.observe([a.trade], a.serverTime, a.waited).length > 0;
    return { ...a, changed };
  }
}

// ── The durable layer ────────────────────────────────────────────────────────

export interface BoardSessionOptions {
  board: BoardClient;
  /** The kit's store, for the same network as the board. */
  store: KitStore;
  /** Receives redacted lines only. */
  log?: LogFn;
  /** ms clock, for tests. */
  now?: () => number;
}

/** A posted offer: the board's echo (check 9 compares it with what was posted) and the kept record. */
export interface PostedOffer {
  offer: Offer;
  record: LocalOffer;
  replayed: boolean;
  /** An older board ignored the client hash; its own token was adopted (the create was not idempotent). */
  adopted: boolean;
}

/** A take: the board's trade, the kept record (with the price the kit sent), and check 14 on the answer. */
export interface TakenTrade {
  trade: Trade;
  record: LocalTrade;
  replayed: boolean;
  adopted: boolean;
  /** rules.tradeMismatch of the board's trade against the record, or null. Nothing may be signed for a trade that mismatches. */
  mismatch: string | null;
}

/** What reconcilePending did. */
export interface ReconcileReport {
  /** Rows the board made for a pending create (now recorded; offers also cancelled unless kept). */
  recorded: Array<{ kind: 'offer' | 'take'; id: number }>;
  /** Entries cleared: never sent, 404 `no_such_request` (nothing was made), refused, or not safe to ask. */
  cleared: number;
  /** Entries kept for a later call: sent less than 60 s ago, unanswered, rate limited, or the board could not be asked. */
  kept: number;
  /** Whether the board keeps client hashes, or null when it was not asked or could not be told. */
  boardKeepsHashes: boolean | null;
  /** Redacted lines for the operator. */
  notes: string[];
}

/**
 * The board with the kit's store: tokens made, kept and used by the kit
 * (see the file comment). One session per store; the flows use it for every
 * call that needs a control token.
 */
export class BoardSession {
  readonly board: BoardClient;
  readonly store: KitStore;
  readonly #log: LogFn;
  readonly #now: () => number;
  /** Token hashes of creates being sent right now: reconcilePending leaves them alone. */
  readonly #inFlight = new Set<string>();

  constructor(o: BoardSessionOptions) {
    if (!(o?.board instanceof BoardClient)) throw bad('A session needs a BoardClient.');
    if (!o.store || o.store.network !== o.board.network) throw bad('The store and the board must be for the same network.');
    this.board = o.board;
    this.store = o.store;
    this.#log = redactedLog(o.log);
    this.#now = o.now ?? Date.now;
  }

  get network(): Network {
    return this.board.network;
  }

  // ── Creates ──────────────────────────────────────────────────────────────

  /**
   * Post an offer (sections 2.1.4 and 6.3): make its token, keep it (durable
   * write 1) and the send time before every send, POST with the token's
   * hash, then keep the offer record with its token (an older board's own
   * token adopted), read back, and drop the pending entry. `acceptOnTheirOwn`
   * goes into the record (default false). Check 7 (offerProblem) and check 9
   * (the echo) are the caller's: the record is kept first, so an offer listed
   * otherwise can be cancelled with its token.
   *
   * Throws CreateError: `mayExist` keeps the pending entry (reconcilePending
   * settles it), otherwise nothing was made and the entry is gone. An answer
   * the kit cannot read that names the offer is cancelled at once.
   */
  async postOffer(offer: NewOffer, o: CallOptions & { acceptOnTheirOwn?: boolean } = {}): Promise<PostedOffer> {
    const body = offerBody(offer);
    const token = newControlToken();
    const hash = tokenHashOf(token);
    // In flight from before its entry exists until the record holds its token: a reconcilePending running
    // meanwhile must not take the entry for one never sent (and drop it) between its write and the first send.
    this.#inFlight.add(hash);
    try {
      await this.store.putPending({ kind: 'offer', network: this.network, token, tokenHash: hash, body, createdAt: this.#now(), sentAt: null });
      let a: CreateOfferAnswer;
      try {
        a = await this.board.createOffer({ ...body, makerTokenHash: hash }, { signal: o.signal, retries: o.retries, maxRetryAfter: o.maxRetryAfter, beforeSend: () => this.#markSent(hash) });
      } catch (e) {
        if (!(e instanceof CreateError)) throw e;
        if (e.created) {
          // Listed, but answered in a form the kit cannot read: taken down at once with the token it carries.
          const down = await this.board.cancel(e.created.id, e.created.token ?? token, { retries: 2, signal: o.signal }).then(() => true, () => false);
          this.#log(`board: offer #${e.created.id} was answered in a form the kit cannot read; ${down ? 'it was cancelled' : 'cancelling it failed, it stops being listed without heartbeats'}`);
          if (down) {
            await this.store.deletePending(hash);
            throw new CreateError(e, { kind: 'offer', tokenHash: hash, mayExist: false, created: e.created });
          }
          throw e;
        }
        if (e.mayExist) {
          this.#log(`board: offer create ${hash.slice(0, 8)}… got no clear answer (${e.code}); its token is kept and the board is asked again later`);
          throw e;
        }
        await this.store.deletePending(hash);
        throw e;
      }
      const record = await this.#keepOffer(body, token, hash, a, o.acceptOnTheirOwn === true);
      return { offer: a.offer, record, replayed: a.replayed, adopted: !!a.makerToken };
    } finally {
      this.#inFlight.delete(hash);
    }
  }

  /**
   * Take `offer` (as the kit read it) for `taz` raw units (sections 2.1.4,
   * 2.3.3, 6.3): the take sends the offer's price the kit read and its
   * token; the token is kept (durable write 1) with the send time before
   * every send, then the trade record (the price the kit sent, its token, an
   * older board's own token adopted), read back, and the entry dropped.
   * PRICE_CHANGED is never sent again: read the offer and decide anew.
   * Checks 10-12 are the caller's; `mismatch` is check 14 on the answer.
   *
   * Throws CreateError as postOffer does.
   */
  async take(offer: Offer, o: CallOptions & { taz: string; takerPha: string; takerBase: string }): Promise<TakenTrade> {
    if (!isRec(offer) || !isId(offer.id) || (offer.side !== 'sell' && offer.side !== 'buy')) throw bad('Take an offer as the board listed it.');
    if (offer.network !== this.network) throw bad(`This offer is not on ${this.network}.`);
    if (!isPhaAddress(offer.makerPha) || !evmLower(offer.makerBase)) throw bad('This offer names no valid maker addresses.');
    const body = takeBody({ taz: o.taz, takerPha: o.takerPha, takerBase: o.takerBase, symbol: offer.symbol, price: offer.price });
    const seen = { side: offer.side, makerPha: offer.makerPha, makerBase: evmLower(offer.makerBase)! };
    const token = newControlToken();
    const hash = tokenHashOf(token);
    const pending: PendingCreate = { kind: 'take', network: this.network, token, tokenHash: hash, offerId: offer.id, body, seen, createdAt: this.#now(), sentAt: null };
    // In flight until the record holds the token, as in postOffer.
    this.#inFlight.add(hash);
    try {
      await this.store.putPending(pending);
      let a: TakeAnswer;
      try {
        a = await this.board.take(offer.id, { ...body, takerTokenHash: hash }, { signal: o.signal, retries: o.retries, maxRetryAfter: o.maxRetryAfter, beforeSend: () => this.#markSent(hash) });
      } catch (e) {
        if (e instanceof CreateError && !e.mayExist) await this.store.deletePending(hash);
        else if (e instanceof CreateError) this.#log(`board: take ${hash.slice(0, 8)}… of offer #${offer.id} got no clear answer (${e.code}); its token is kept and the board is asked again later`);
        throw e;
      }
      return await this.#keepTake(pending, a);
    } finally {
      this.#inFlight.delete(hash);
    }
  }

  /** Durable: the send time of a pending create, before each send (a restart asks about it 60 s after the last one). */
  async #markSent(hash: string): Promise<void> {
    await this.store.markPendingSent(hash, this.#now());
  }

  /** Keep the offer a create made (its token: the client's, or an older board's own), read back; then drop the entry. */
  async #keepOffer(body: NewOffer, token: string, hash: string, a: CreateOfferAnswer, acceptOnTheirOwn: boolean): Promise<LocalOffer> {
    const key = a.makerToken ?? token;
    if (a.makerToken) this.#log(`board: the board ignored the client token of offer #${a.offer.id} and sent its own; it is kept and used from now on (this create was not idempotent)`);
    const now = this.#now();
    const rec: LocalOffer = {
      id: a.offer.id, network: this.network, side: body.side, symbol: body.symbol, makerPha: body.makerPha, makerBase: evmLower(body.makerBase)!,
      tazTotal: body.tazTotal, tazMin: body.tazMin, tazMax: body.tazMax,
      // A fixed offer: the price posted. A following one: the board's first price (display only).
      price: body.follow ? a.offer.price : body.price!,
      makerToken: key, tokenSource: a.makerToken ? 'server' : 'client',
      priceHistory: body.follow ? [] : [{ price: body.price!, at: now }],
      follow: body.follow ?? null, acceptOnTheirOwn, mode: body.mode ?? 'standard', createdAt: now, closedAt: null
    };
    try {
      // An id the store keeps for another offer is refused (RECORD_CONFLICT); the same offer again returns the kept record.
      await this.store.addOffer(rec);
    } catch (e) {
      if (e instanceof SafetyError && e.code === SAFETY.RECORD_CONFLICT) {
        // The board made it, but the store cannot keep it: taken down with its token, so nothing runs on an offer the kit does not know.
        await this.board.cancel(rec.id, key, { retries: 2 }).catch(() => undefined);
        await this.store.deletePending(hash);
        this.#log(`board: the board answered offer #${rec.id}, but the store keeps another offer under that id; it was cancelled`);
      }
      throw e;
    }
    const back = await this.store.getOffer(rec.id);
    if (back?.makerToken !== key) throw new SafetyError(SAFETY.STORE_READBACK, `Offer #${rec.id} did not read back with its token.`);
    await this.store.deletePending(hash);
    return back;
  }

  /** Keep the trade a take made (its token, the price the kit sent), read back; then drop the entry. Returns check 14 on the answer. */
  async #keepTake(p: PendingCreate, a: TakeAnswer): Promise<TakenTrade> {
    const body = p.body as Required<Pick<TakeBody, 'taz' | 'takerPha' | 'takerBase' | 'symbol' | 'price'>>;
    const seen = p.seen!;
    const key = a.takerToken ?? p.token;
    if (a.takerToken) this.#log(`board: the board ignored the client token of trade #${a.trade.id} and sent its own; it is kept and used from now on (this take was not idempotent)`);
    const now = this.#now();
    const rec: LocalTrade = {
      id: a.trade.id, network: this.network, offerId: p.offerId!, role: seen.side === 'sell' ? 'B' : 'S', maker: false,
      symbol: body.symbol, taz: body.taz, usdc: usdcFor(BigInt(body.taz), BigInt(body.price), body.symbol).toString(), price: body.price,
      myPha: body.takerPha, myBase: evmLower(body.takerBase)!, counterPha: seen.makerPha, counterBase: evmLower(seen.makerBase)!,
      takerToken: key, tokenSource: a.takerToken ? 'server' : 'client', txs: {}, status: a.trade.status, createdAt: now, updatedAt: now
    };
    let kept: LocalTrade;
    try {
      // Check 13: an id the store keeps for another trade is refused (RECORD_CONFLICT); the same take again returns the kept record.
      kept = await this.store.addTrade(rec);
    } catch (e) {
      if (e instanceof SafetyError && e.code === SAFETY.RECORD_CONFLICT) {
        await this.store.deletePending(p.tokenHash);
        this.#log(`board: the board answered trade #${a.trade.id} for a take, but the store keeps another trade under that id; nothing is kept or signed for it`);
      }
      throw e;
    }
    const back = await this.store.getTrade(kept.id);
    if (back?.takerToken !== key) throw new SafetyError(SAFETY.STORE_READBACK, `Trade #${kept.id} did not read back with its token.`);
    await this.store.deletePending(p.tokenHash);
    // Check 14 with the price the kit sent (section 6.4): the USDC derived from it must match, and so must the
    // board's own price. Two prices can round to the same USDC for a small amount, so both are compared.
    const mismatch = tradeMismatch(a.trade, back) ?? (a.trade.price !== back.price ? 'The price of this trade is not what you agreed to.' : null);
    if (mismatch) this.#log(`board: trade #${back.id} is recorded at the board differently from the take: ${mismatch} Nothing is signed for it.`);
    return { trade: a.trade, record: back, replayed: a.replayed, adopted: !!a.takerToken, mismatch };
  }

  /**
   * Ask the board about every pending create (section 2.1.4, 6.3, 6.5):
   *   - an entry never sent is cleared (nothing can exist);
   *   - an entry last sent less than `minAgeMs` (60 s) ago waits, so a send
   *     still on its way lands first;
   *   - the rest are asked with their own token hash and `replayOnly: true`:
   *     the row the board made is recorded exactly as a create's answer is
   *     (an offer nobody saw listed is then cancelled, unless `offers: 'keep'`);
   *     404 `no_such_request` (the request never arrived; nothing is made) or
   *     another refusal clears the entry; no answer or RATE_LIMITED keeps it;
   *   - a board that does not keep client hashes is never asked (it would
   *     make a new row): its entries are cleared; when that cannot be told,
   *     every entry is kept.
   * Never makes an offer or a trade.
   */
  async reconcilePending(o: { minAgeMs?: number; offers?: 'cancel' | 'keep'; signal?: AbortSignal } = {}): Promise<ReconcileReport> {
    const minAge = typeof o.minAgeMs === 'number' && Number.isSafeInteger(o.minAgeMs) && o.minAgeMs >= REPLAY_MIN_AGE_MS ? o.minAgeMs : REPLAY_MIN_AGE_MS;
    const report: ReconcileReport = { recorded: [], cleared: 0, kept: 0, boardKeepsHashes: null, notes: [] };
    const note = (line: string) => { report.notes.push(line); this.#log(`board: ${line}`); };
    let keeps: boolean | null | undefined;
    const entries = (await this.store.listPending()).filter((p) => !this.#inFlight.has(p.tokenHash));
    // A crash between keeping a row's record and dropping its entry leaves an entry whose token a record already holds.
    const heldTokens = new Set<string>([
      ...(await this.store.listOffers()).map((x) => x.makerToken),
      ...(await this.store.listTrades()).flatMap((x) => (x.takerToken ? [x.takerToken] : []))
    ]);
    for (const p of entries) {
      // A create sent from this session after the listing (or another reconcile) owns its entry: left alone.
      if (this.#inFlight.has(p.tokenHash)) continue;
      this.#inFlight.add(p.tokenHash);
      try {
        await this.#reconcileOne(p, o, minAge, heldTokens, report, note, async () => {
          if (keeps === undefined) {
            keeps = await this.board.keepsHashes({ signal: o.signal });
            report.boardKeepsHashes = keeps;
          }
          return keeps;
        });
      } finally {
        this.#inFlight.delete(p.tokenHash);
      }
    }
    return report;
  }

  /** One entry of reconcilePending. */
  async #reconcileOne(p: PendingCreate, o: { offers?: 'cancel' | 'keep'; signal?: AbortSignal }, minAge: number, heldTokens: ReadonlySet<string>,
    report: ReconcileReport, note: (line: string) => void, boardKeeps: () => Promise<boolean | null>): Promise<void> {
    const tag = `${p.kind === 'offer' ? 'offer create' : `take of offer #${p.offerId}`} ${p.tokenHash.slice(0, 8)}…`;
    if (heldTokens.has(p.token)) {
      if (await this.store.deletePending(p.tokenHash)) report.cleared++;
      note(`${tag} is already recorded; cleared`);
      return;
    }
    if (p.sentAt == null) {
      // The send time is kept before every send: none means it was never sent.
      if (await this.store.deletePending(p.tokenHash)) report.cleared++;
      note(`${tag} was never sent; cleared`);
      return;
    }
    if (this.#now() - p.sentAt < minAge) { report.kept++; return; }
    // An entry the kit cannot send again exactly (a body it would not send, or a take without the offer it
    // read) cannot be asked about, and its row may exist: it is kept for the operator, and the pass goes on.
    const problem = pendingAskProblem(p);
    if (problem) {
      report.kept++;
      note(`${tag} cannot be asked about (${problem}); it is kept in pending/ for the operator`);
      return;
    }
    const keeps = await boardKeeps();
    if (keeps === null) { report.kept++; return; }
    if (keeps === false) {
      if (await this.store.deletePending(p.tokenHash)) report.cleared++;
      note(`${tag}: this board does not keep client tokens, so asking would make a new one; cleared (if it was made, it ends unanswered)`);
      return;
    }
    try {
      if (p.kind === 'offer') {
        const a = await this.board.createOffer({ ...(p.body as NewOffer), makerTokenHash: p.tokenHash, replayOnly: true }, { signal: o.signal });
        const rec = await this.#keepOffer(p.body as NewOffer, p.token, p.tokenHash, a, false);
        report.recorded.push({ kind: 'offer', id: rec.id });
        if (!a.replayed) note(`offer #${rec.id} was made by a board that ignored replayOnly`);
        if (o.offers !== 'keep' || !a.replayed) {
          // Nobody saw it listed: taken down, and kept closed with its token (closed here even when the cancel fails,
          // so the kit sends it no heartbeat and the board stops listing it within 90 s).
          let down = true;
          await this.board.cancel(rec.id, rec.makerToken, { signal: o.signal }).catch(() => { down = false; });
          await this.store.patchOffer(rec.id, { closedAt: this.#now() });
          note(`offer #${rec.id} had reached the board; it is recorded and ${down ? 'cancelled' : 'closed here (the cancel failed; it stops being listed without heartbeats)'}`);
        } else {
          note(`offer #${rec.id} had reached the board; it is recorded`);
        }
      } else {
        const a = await this.board.take(p.offerId!, { ...(p.body as TakeBody & { price: string }), takerTokenHash: p.tokenHash, replayOnly: true }, { signal: o.signal });
        const t = await this.#keepTake(p, a);
        report.recorded.push({ kind: 'take', id: t.record.id });
        note(`${tag} had reached the board as trade #${t.record.id} (${t.trade.status}); it is recorded${a.replayed ? '' : ' (a board that ignored replayOnly made it now)'}`);
      }
    } catch (e) {
      if (e instanceof BoardError && (outcomeUnknown(e) || e.code === 'RATE_LIMITED' || e.code === 'ABORTED' || e.code === 'BAD_ANSWER')) {
        report.kept++;
        return;
      }
      if (e instanceof BoardError) {
        if (await this.store.deletePending(p.tokenHash)) report.cleared++;
        note(e.code === 'NOT_FOUND' && e.reason === 'no_such_request'
          ? `${tag} never reached the board; nothing was made; cleared`
          : `${tag} was refused when asked again (${e.code}); cleared`);
        return;
      }
      if (e instanceof SafetyError && e.code === SAFETY.RECORD_CONFLICT) {
        // The board answered with an id the store keeps for another row: #keepOffer/#keepTake dropped the
        // entry (and cancelled an offer) and logged it; the other entries are still asked about.
        report.cleared++;
        note(`${tag} was answered with an id the store keeps for another row; nothing is kept or signed for it; cleared`);
        return;
      }
      throw e;
    }
  }

  // ── Calls with a kept token ──────────────────────────────────────────────

  /** The control token of one of the kit's offers. */
  async offerToken(offerId: number): Promise<string> {
    const rec = await this.store.getOffer(needId(offerId, 'An offer id'));
    if (!rec) throw new SafetyError(BOARD_SAFETY.NO_TOKEN, `The store keeps no offer #${offerId}.`);
    return rec.makerToken;
  }

  /** The control token of one of the kit's trades: the offer's maker token on the maker's side, the take's token otherwise. */
  async tradeToken(tradeId: number): Promise<string> {
    const rec = await this.store.getTrade(needId(tradeId, 'A trade id'));
    if (!rec) throw new SafetyError(BOARD_SAFETY.NO_TOKEN, `The store keeps no trade #${tradeId}.`);
    if (rec.maker) return this.offerToken(rec.offerId);
    if (!rec.takerToken) throw new SafetyError(BOARD_SAFETY.NO_TOKEN, `Trade #${tradeId} keeps no taker token.`);
    return rec.takerToken;
  }

  /** The kit's open offers with their tokens, for OfferPoller.next. */
  async openOffers(): Promise<Array<{ id: number; token: string }>> {
    return (await this.store.listOffers()).filter((x) => x.closedAt == null).map((x) => ({ id: x.id, token: x.makerToken }));
  }

  /** A heartbeat poller for this session's board. */
  poller(o: PollerOptions = {}): OfferPoller {
    return new OfferPoller(this.board, o);
  }

  async heartbeat(offerId: number, o: LongPollOptions = {}): Promise<HeartbeatAnswer & { waited: boolean }> {
    return this.board.heartbeat(offerId, await this.offerToken(offerId), o);
  }

  /** Cancel one of the kit's offers, and record it closed. */
  async cancel(offerId: number, o: CallOptions = {}): Promise<void> {
    await this.board.cancel(offerId, await this.offerToken(offerId), o);
    await this.store.patchOffer(offerId, { closedAt: this.#now() });
  }

  /**
   * Change the price of one of the kit's offers (sections 2.4.7 and 4.10). A
   * fixed price joins the record's price history before the board is asked,
   * so a take fixed at it right after the change is the maker's own price;
   * following turns off in the record once the board took the change. Follow
   * settings are kept once the board took them.
   */
  async reprice(offerId: number, change: RepriceBody, o: CallOptions = {}): Promise<Offer> {
    const token = await this.offerToken(offerId);
    if (!isRec(change)) throw bad('A price change is { price } or { follow }.');
    const follow = 'follow' in change ? change.follow : null;
    if (!follow) await this.store.patchOffer(offerId, { price: needRaw((change as { price: unknown }).price, 'price') });
    const offer = await this.board.reprice(offerId, token, change, o);
    if (follow) {
      const have = await this.store.getOffer(offerId);
      // dailyMax defaults to the offer's total at the board (section 2.4.6); the record keeps it written out.
      await this.store.patchOffer(offerId, { follow: { offsetBps: follow.offsetBps, limitPrice: follow.limitPrice, dailyMax: follow.dailyMax ?? have!.tazTotal } });
    } else {
      await this.store.patchOffer(offerId, { follow: null });
    }
    return offer;
  }

  async accept(tradeId: number, o: CallOptions = {}): Promise<Trade> {
    return this.board.accept(tradeId, await this.tradeToken(tradeId), o);
  }

  async decline(tradeId: number, o: CallOptions = {}): Promise<Trade> {
    return this.board.decline(tradeId, await this.tradeToken(tradeId), o);
  }

  /** The seller's lock report (check 35's send), with the trade's kept token. */
  async phaLocked(tradeId: number, b: { h: string; txHash?: string }, o: CallOptions = {}): Promise<Trade> {
    return this.board.phaLocked(tradeId, await this.tradeToken(tradeId), b, o);
  }

  /** The buyer's lock report, with the trade's kept token. */
  async baseLocked(tradeId: number, b: { txHash: string; h?: string }, o: CallOptions = {}): Promise<Trade> {
    return this.board.baseLocked(tradeId, await this.tradeToken(tradeId), b, o);
  }
}
