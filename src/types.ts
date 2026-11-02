/**
 * The P2P board's wire types (build spec sections 2.1-2.5) and the kit's own
 * records (section 6.5), shared by board.ts, checks.ts, the flows and the
 * store. No code here, only shapes.
 *
 * Everything the board sends is display data until the kit has checked it:
 * amounts are raw-unit strings read with the decimals of the kit's own token
 * table (pins.ts tokenOf), never with anything from the board, and every lock
 * a trade names is read from the chains before anything is signed (section
 * 6.4). Fields marked "wave B" or "wave C" are absent on an older board.
 */

export type Network = 'devnet' | 'mainnet';
export type Side = 'sell' | 'buy';
/** S locks the Phantasma token; B locks USDC on Base. */
export type Role = 'S' | 'B';
/** Standard: the seller locks first. Instant (wave C): the buyer locks first. */
export type OfferMode = 'standard' | 'instant';

// ── Envelope and errors (section 2.1) ──────────────────────────────────────

export interface Meta {
  network: string;
  cachedAt: number;
  ttl: number;
}

/** Every answer is `{ data, meta? }`; `/reveal` answers a bare `{ ok: true }`. */
export interface Envelope<T> {
  data: T;
  meta?: Meta;
}

/** Every error code the board may send (section 2.6, complete after wave C). Unknown codes are kept as strings. */
export type BoardErrorCode =
  | 'BAD_REQUEST' | 'TOO_LARGE' | 'UNAUTHORIZED' | 'BAD_API_KEY' | 'ADMIN_UNAUTHORIZED' | 'WRONG_SECRET' | 'ORIGIN_REQUIRED' | 'NOT_ELIGIBLE'
  | 'P2P_OFF' | 'NOT_FOUND' | 'ALERTS_OFF' | 'FAUCET_OFF' | 'ADMIN_DISABLED' | 'INSTANT_OFF'
  | 'CLOSED' | 'OFFLINE' | 'TOKEN' | 'AMOUNT' | 'BUSY' | 'FUNDS' | 'STATE' | 'LATE' | 'NOT_YET' | 'NOT_CONFIRMED' | 'USED'
  | 'IDEMPOTENCY_MISMATCH' | 'PRICE_CHANGED' | 'NO_SHOW_LIMIT' | 'CAP_SHARE' | 'FOLLOW_PAUSED' | 'TOO_SOON' | 'SQUATTED' | 'AUTO_PAYOUT'
  | 'TX_FAILED' | 'NO_LOCK' | 'MISMATCH' | 'OLD_LOCK' | 'RATE_LIMITED' | 'FAUCET_LIMIT'
  | 'INTERNAL' | 'UPSTREAM' | 'UNAVAILABLE' | 'ESCROW_NOT_PINNED' | 'TOKEN_NOT_READY' | 'KEEPER_UNAVAILABLE' | 'FAUCET_EMPTY'
  | (string & {});

/**
 * The error body (section 2.1.2). `retryable` is always present from wave B;
 * an older board omits it, and the client then follows the table of section 2.6.
 */
export interface BoardErrorBody {
  error: {
    code: BoardErrorCode;
    message: string;
    retryable?: boolean;
    retryAfter?: number;
    reason?: string;
  };
}

// ── Offers (offerJson, sections 2.2, 2.4.6, 2.5.1) ─────────────────────────

export type OfferStatus = 'open' | 'closed' | (string & {});

/** A market-following offer's settings as the maker sends them (section 2.4.6). */
export interface FollowSettings {
  /** -2000 .. 2000: the price is the reference price times (1 + offsetBps / 10000). */
  offsetBps: number;
  /** Raw USDC per whole token: the lowest price of a sell, the highest of a buy. Required. */
  limitPrice: string;
  /** Raw token units the offer fills per 24 h at most (default: the offer's total). */
  dailyMax?: string;
}

/** A market-following offer as the board shows it (wave B). */
export interface FollowState {
  offsetBps: number;
  limitPrice: string;
  dailyMax: string;
  state: 'live' | 'paused';
  /** Raw token units filled in the last 24 h. */
  filled24h: string;
}

export interface Offer {
  id: number;
  network: Network;
  side: Side;
  makerPha: string;
  /** Checksummed. */
  makerBase: string;
  symbol: string;
  /** Raw units of `symbol`; the fields keep their TAZ-era names. */
  tazTotal: string;
  tazMin: string;
  tazMax: string;
  /** Raw USDC per one whole token. */
  price: string;
  remaining: string;
  status: OfferStatus;
  online: boolean;
  createdAt: number;
  heartbeatAt: number;
  closedAt: number | null;
  /** Wave B: when the current price was set (unix s). */
  priceAt?: number | null;
  /** Wave B: the follow settings and state, or null for a fixed price. */
  follow?: FollowState | null;
  /** Wave C. */
  mode?: OfferMode;
}

/** POST /offers body without the idempotency fields (sections 2.3.2, 2.4.6, 2.5.1). */
export interface NewOffer {
  side: Side;
  symbol: string;
  makerPha: string;
  makerBase: string;
  tazTotal: string;
  tazMin: string;
  tazMax: string;
  /** Required for a fixed price; ignored when `follow` is present. */
  price?: string;
  /** Wave B. */
  follow?: FollowSettings;
  /** Wave C. */
  mode?: OfferMode;
}

/** The answer to POST /offers: 201 (made) or 200 (`replayed`). `makerToken` only from a board that ignored the client hash. */
export interface CreateOfferAnswer {
  offer: Offer;
  replayed: boolean;
  makerToken?: string;
}

/** POST /offers/:id/reprice (wave B, section 2.4.7): a fixed price (which turns following off) or new follow settings. */
export type RepriceBody = { price: string } | { follow: FollowSettings };

// ── Trades (tradeJson, sections 2.2, 2.4.4, 2.5.1) ─────────────────────────

/** Every status the board may report (P2P/SPEC.md section 7). */
export type TradeStatus =
  | 'requested' | 'accepted' | 'pha_locked' | 'base_locked' | 'revealed' | 'base_claimed' | 'payout_pending'
  | 'done' | 'refunding' | 'refunded' | 'cancelled' | 'expired';

export interface Party {
  pha: string;
  /** Checksummed. */
  base: string;
}

export interface Trade {
  id: number;
  network: Network;
  offerId: number;
  /** The offer's side: on a sell offer the maker is S. */
  side: Side;
  symbol: string;
  /** Raw units of `symbol`. */
  taz: string;
  /** Raw USDC the buyer pays. */
  usdc: string;
  /** Raw USDC per one whole token, fixed at take. */
  price: string;
  seller: Party;
  buyer: Party;
  /** '0x' + 64 hex once the seller's lock is reported. */
  h: string | null;
  phaContract: string | null;
  phaLockTx: string | null;
  baseLockTx: string | null;
  baseClaimTx: string | null;
  phaClaimTx: string | null;
  baseRefundTx: string | null;
  phaRefundTx: string | null;
  phaDeadline: number | null;
  baseDeadline: number | null;
  /** The trade's fee, fixed by the board at accept; null before. */
  feeBps: number | null;
  payoutDeferred: boolean;
  status: TradeStatus;
  acceptBy: number | null;
  lockBy: number | null;
  createdAt: number;
  acceptedAt: number | null;
  updatedAt: number;
  endedAt: number | null;
  lastError: string | null;
  /** Wave C. */
  mode?: OfferMode;
}

/** POST /offers/:id/take body without the idempotency fields (section 2.3.3). */
export interface TakeBody {
  /** Raw units of the offer's token. */
  taz: string;
  takerPha: string;
  takerBase: string;
  /**
   * The token the taker agreed to; a different offer token answers 409 TOKEN.
   * Optional on the wire (older pages omit it), but every kit take sends it,
   * and the store refuses a pending take without it.
   */
  symbol?: string;
  /** The price the taker saw. Every kit take sends it (409 PRICE_CHANGED when the offer's price differs). */
  price?: string;
}

/** The answer to a take: 201 (made) or 200 (`replayed`, the trade as it is now). `takerToken` only from a board that ignored the client hash. */
export interface TakeAnswer {
  trade: Trade;
  replayed: boolean;
  takerToken?: string;
}

/** Idempotency fields a create carries (section 2.1.4). */
export interface IdempotentFields {
  /** sha256Hex of the 64-hex control token (codec.tokenHashOf). */
  makerTokenHash?: string;
  takerTokenHash?: string;
  /** Only ask whether an earlier send arrived: a 404 `no_such_request` means nothing was made, and nothing is made now. */
  replayOnly?: boolean;
}

/** POST /offers/:id/heartbeat answer (wave B adds `serverTime` and `waited`, section 2.4.3). */
export interface HeartbeatAnswer {
  offer: Offer;
  /** The offer's trades that are not finished yet. */
  trades: Trade[];
  serverTime?: number;
  waited?: boolean;
}

/** POST /heartbeats (wave B, section 2.4.5). */
export interface BatchResult {
  id: number;
  ok: boolean;
  offer?: Offer;
  trades?: Trade[];
  error?: BoardErrorBody['error'];
}

export interface BatchAnswer {
  results: BatchResult[];
  serverTime: number;
  waited: boolean;
}

// ── The public feed (section 2.3.1) ────────────────────────────────────────

/** The prices saved with a trade at its take (section 2.3.4). */
export interface TradeRef {
  soulUsd: number | null;
  dexUsd: number | null;
  lineUsd: number | null;
  basis: 'p2p' | 'via_soul' | 'feed' | null;
  tazPerRa: number | null;
  at: number;
}

export interface FeedTrade {
  id: number;
  network: Network;
  symbol: string;
  offerSide: Side;
  takerSide: Side;
  taz: string;
  usdc: string;
  price: string;
  feeBps: number | null;
  createdAt: number;
  acceptedAt: number | null;
  endedAt: number | null;
  seller: Party;
  buyer: Party;
  proof: {
    h: string | null;
    phaContract: string | null;
    phaLockTx: string | null;
    baseLockTx: string | null;
    baseClaimTx: string | null;
    phaClaimTx: string | null;
  };
  ref: TradeRef | null;
}

export interface RecentPage {
  trades: FeedTrade[];
  /** The cursor of the next (older) page, or null at the end. */
  next: string | null;
}

// ── /config (display only: the kit trusts its own pins, section 0.4) ───────

export interface ConfigToken {
  symbol: string;
  decimals: number;
  min: string;
  max: string;
  offerMax: string;
  priceMax: string;
  enabled: boolean;
  gas: boolean;
  stake: boolean;
  ready: boolean | null;
  problem: string | null;
  openCap: { openAmount: string; maxOpen: string; tied?: string } | null;
}

/** GET /config. Display only: never read for decimals, limits, addresses, chain ids or timing. */
export interface P2PConfig {
  network: Network;
  enabled: boolean;
  displayOnly: true;
  note: string;
  phantasma: {
    nexus: string;
    contract: string;
    ready: boolean;
    problem: string | null;
    contracts: Array<{ name: string; current: boolean; codeSha256: string | null; admin: string | null }>;
  };
  tokens: ConfigToken[];
  base: {
    name: string;
    chainId: number;
    contract: string | null;
    usdc: string | null;
    usdcDecimals: number;
    confirmations: number | 'safe';
    ready: boolean;
  };
  timing: Record<string, number>;
  limits: {
    usdcMin: string;
    usdcMax: string;
    maxFeeBps: number;
    waitingPerOffer: number;
    claimGasBudget: string;
    openCapAlertPct: number;
    soulAlert: string;
    soulMin: string;
    /** Wave B. */
    capShareBps?: number;
    /** Wave B. */
    noShow?: { limit: number; windowH: number; pauseH: number };
  };
  addressesVerified: boolean;
  fee: unknown;
  refundAll: boolean;
  keeper: Record<string, unknown>;
  /** Wave B. */
  alerts?: { telegram: boolean; push: boolean };
  /** Wave C. */
  instant?: { enabled: boolean; timing: Record<string, number> };
}

// ── /me (wave B, section 2.4.1) ────────────────────────────────────────────

export interface NoShowState {
  count24h: number;
  /** Unix seconds, or null when not paused. */
  pausedUntil: number | null;
}

export interface Me {
  key: {
    id: string;
    label: string;
    rpm: number;
    p2pCreateRpm: number;
    p2pWriteRpm: number;
    capShareBps: number | null;
    instant: boolean;
  };
  noShows: { taker: NoShowState; maker: NoShowState };
  /** Per token, raw units: what this identity ties as a seller, its limit and the escrow's open cap. */
  capShare: Record<string, { tied: string; limit: string; maxOpen: string }>;
}

// ── /v1/prices/reference (section 2.3.6) ───────────────────────────────────

export type RefBasis = 'p2p' | 'via_soul' | 'feed';

export interface RefP2P {
  value: number | null;
  qualified: boolean;
  reasons: string[];
  effectiveUsd: number;
  trades: number;
  sellers: number;
  buyers: number;
  maxAddressShare: number;
  bookCheck: string;
  tazCrossCheck: string;
  windowH: number;
  tauH: number;
  minEffectiveUsd: number;
  minTrades: number;
}

export interface RefBook {
  bestBid: number | null;
  bestAsk: number | null;
  spreadPct: number | null;
  bidUsd: number;
  askUsd: number;
}

export interface RefToken {
  /** The published reference price in USD ("the reference price" in user text). */
  line: number | null;
  basis: RefBasis;
  viaSoul: number | null;
  p2p?: RefP2P | null;
  book?: RefBook;
  /** TAZ under the P2P basis: the RA reference and the pool's TAZ per RA it was derived with. */
  fromRa?: { raLine: number; tazPerRa: number } | null;
  /** Present when p2p is null: why (for example "p2p_off"). */
  reasons?: string[];
}

/** GET /v1/prices/reference. Display only: never feeds a signature. */
export interface Reference {
  network: Network;
  asOf: number;
  stale: boolean;
  anchor: {
    state: 'p2p' | 'via_soul';
    since: number;
    passing: boolean;
    reasons: string[];
    rule: Record<string, number>;
    depth: Record<string, unknown>;
    link: Record<string, unknown>;
  };
  twap: {
    poolId: number;
    pool: string;
    tazPerRa: number | null;
    spot: number | null;
    windowS: number;
    source: string;
    status: string;
    since: number | null;
  };
  tokens: Record<string, RefToken>;
}

// ── Devnet faucet (wave B, section 2.4.10) ─────────────────────────────────

/** GET /faucet. */
export interface FaucetInfo {
  enabled: boolean;
  /** Whole units per claim, by symbol (TAZ, RA, SOUL, KCAL, mUSDC, ETH). */
  amounts: Record<string, string>;
  perAddressHours: number;
  leftToday: number;
  low: boolean;
}

/** POST /faucet (202). */
export interface FaucetResult {
  pha: { txHash: string; amounts: Record<string, string> } | null;
  base: { usdcTx: string | null; ethTx: string | null; amounts: Record<string, string> } | null;
}

// ── The kit's own records (section 6.5) ────────────────────────────────────

/**
 * A control token made before its POST (`pending/<tokenHash>.json`), with
 * what a replay must send again. Deleted once the board's row is recorded.
 */
export interface PendingCreate {
  kind: 'offer' | 'take';
  network: Network;
  /** 64 lowercase hex: the token itself. */
  token: string;
  /** sha256Hex(token): the file's name and the hash the board stores. */
  tokenHash: string;
  /** The offer a take is for; absent for an offer. */
  offerId?: number;
  /** The exact body (without the idempotency fields) every send and every replay of this create carries. */
  body: NewOffer | TakeBody;
  /** For a take: the offer's side and maker as the kit saw them (the trade record needs them). */
  seen?: { side: Side; makerPha: string; makerBase: string } | null;
  /** ms: when the token was made. */
  createdAt: number;
  /** ms: when it was last sent, or null before the first send. Restart replays only entries last sent over 60 s ago. */
  sentAt: number | null;
}

/** One offer this kit made (`offers/<offerId>.json`). */
export interface LocalOffer {
  id: number;
  network: Network;
  side: Side;
  symbol: string;
  makerPha: string;
  /** Lowercase. */
  makerBase: string;
  tazTotal: string;
  tazMin: string;
  tazMax: string;
  /** The price posted (a following offer: its first price). */
  price: string;
  /** The offer's control token (64 lowercase hex). */
  makerToken: string;
  /** 'server' when an older board ignored the client hash and its own token was adopted. */
  tokenSource: 'client' | 'server';
  /** Every fixed price this kit set for the offer (build spec section 4.10). */
  priceHistory: Array<{ price: string; at: number }>;
  /** The follow settings, or null for a fixed price. */
  follow: FollowSettings | null;
  /** "Accept takes on their own": accept a take once its checks pass (it signs nothing). */
  acceptOnTheirOwn: boolean;
  mode: OfferMode;
  /** ms. */
  createdAt: number;
  /** ms, when the kit saw the offer closed (cancelled, filled or closed by the board). */
  closedAt: number | null;
}

/** The kinds of chain sends the journal records before they go out. */
export type IntentKind = 'phaLock' | 'baseLock' | 'approve' | 'claimBase' | 'claimPha' | 'refundPha' | 'refundBase' | 'withdrawOwed';

/**
 * How an intent ended, resolved from the send's answer or from the chain:
 *   confirmed       mined and done;
 *   failed          rejected or reverted: what it was for did not happen;
 *   not_sent        never broadcast (or dropped and provably not on chain);
 *   done_elsewhere  the chain shows it done by someone else (the keeper won a race).
 */
export type IntentOutcome = 'confirmed' | 'failed' | 'not_sent' | 'done_elsewhere';

/** One send, recorded before it goes out (`journal/<tradeId>.json`). */
export interface Intent {
  /** Unique within the trade's journal. */
  id: string;
  kind: IntentKind;
  /** ms, when it was recorded. */
  at: number;
  /** The h it is for, when it has one. */
  h?: string;
  /** Base: the nonce it was signed with. */
  nonce?: number;
  /** Set as soon as the send returns (Base: the newest transaction sent for the step at this nonce). */
  txHash?: string;
  /** ms, when the tx hash was recorded. */
  sentAt?: number;
  /**
   * Base: every transaction sent for the step at this nonce, oldest first:
   * the first send and each replacement with higher fees. At most one of
   * them is ever mined.
   */
  hashes?: string[];
  /** Base: the 0-value transfers to the kit's own address sent at this nonce to take it back from the step (a cancel). */
  cancelHashes?: string[];
  /** Base: the fees of the newest transaction at this nonce, wei per gas (decimal text); a replacement pays more. */
  maxFee?: string;
  maxPrio?: string;
  /** ms, when the newest transaction at this nonce was sent. */
  lastSentAt?: number;
  outcome?: IntentOutcome;
  /** ms, when the outcome was recorded. */
  resolvedAt?: number;
  /** A short redacted note (why it failed). */
  note?: string;
}

export interface Journal {
  tradeId: number;
  network: Network;
  intents: Intent[];
}

/** Transactions of one trade the kit saw or sent. Each is replaced only by a later send of the same kind. */
export interface TradeTxs {
  phaLock?: string;
  baseLock?: string;
  approve?: string;
  claimBase?: string;
  claimPha?: string;
  refundPha?: string;
  refundBase?: string;
  withdrawOwed?: string;
}

/**
 * One trade this kit made or took (`trades/<tradeId>.json`). The fields up to
 * `phaContract` keep the names of the site's local record (rules.ts
 * tradeMismatch compares them with the board's trade).
 *
 * Never change once created: id, network, offerId, role, maker, symbol, taz,
 * usdc, price, myPha, myBase, takerToken, tokenSource, createdAt.
 * Written once: counterPha, counterBase, h, phaContract, t1, secretSentAt, revealedAt.
 */
export interface LocalTrade {
  id: number;
  network: Network;
  offerId: number;
  role: Role;
  /** True on the maker's side of the trade. */
  maker: boolean;
  symbol: string;
  /** Raw units of `symbol`. */
  taz: string;
  /** Raw USDC the buyer pays. */
  usdc: string;
  /** Raw USDC per whole token: for a take, the price the kit saw and sent; for a maker, the offer's price it agreed to. */
  price: string;
  myPha: string;
  /** Lowercase. */
  myBase: string;
  counterPha?: string;
  /** Lowercase. */
  counterBase?: string;
  /** '0x' + 64 lowercase hex, once verified on chain. */
  h?: string;
  /** The escrow contract that holds the lock at h. */
  phaContract?: string;
  /** The Phantasma lock's end (unix s), from the chain. */
  t1?: number;
  /** The buyer's USDC lock end (unix s), computed once and stored before signing; replaced only while no USDC lock exists. */
  t2?: number;
  /** feeShown: the trade's fee the seller was shown and stored before locking (bps). Fixed once h is recorded. */
  feeShown?: number;
  /** The taker's control token (a take). A maker's trade uses its offer's makerToken. */
  takerToken?: string;
  tokenSource?: 'client' | 'server';
  /**
   * ms, written once right before the secret first leaves the kit: POSTed to
   * /reveal, or carried by the kit's own USDC claim (its simulation already
   * sends the secret to the Base node).
   */
  secretSentAt?: number;
  /** ms, when the board confirmed it holds the secret. */
  revealedAt?: number;
  txs: TradeTxs;
  /** The last board status the kit saw. */
  status?: TradeStatus;
  /** ms. */
  createdAt: number;
  /** ms. */
  updatedAt: number;
  /** ms, when the kit saw the trade finished and both locks final. */
  endedAt?: number;
}

/** A swap secret (`secrets/<h>.json`), bound to its trade. Never overwritten; removed only by examples/prune.ts. */
export interface SecretRecord {
  v: 1;
  /** '0x' + 64 lowercase hex. */
  secret: string;
  /** sha256(secret), '0x' + 64 lowercase hex. */
  h: string;
  tradeId: number;
  network: Network;
  symbol: string;
  /** Raw amount of `symbol`. */
  taz: string;
  sPha: string;
  bPha: string;
  /** Who made it: S in standard mode, B in instant mode (wave C). */
  role: Role;
  /** ms. */
  createdAt: number;
}
