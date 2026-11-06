/**
 * The example seller bot (build spec section 6.7), and the runner every bot
 * of the kit uses: buyer-bot.ts runs this same code with its own config, and
 * market-bot.ts with yours (market.mainnet.json, which sh start.sh mainnet
 * makes from examples/market.mainnet.example.json).
 *
 *   npm run seller                                 # examples/seller.devnet.example.json
 *   npm run seller -- --config ./my-seller.json    # a config of your own
 *   npm run seller -- --dry-run                    # reads only; sends nothing
 *
 * What a run does, in order:
 *   1. reads the config (JSON, checked strictly: an unknown key, an amount
 *      that is not decimal text, or an offer outside the kit's token table
 *      stops it before anything is read or sent);
 *   2. refuses mainnet unless --mainnet and KIT_ALLOW_MAINNET=1 are both
 *      given AND the kit release has mainnet pins (this release has them);
 *   3. createKit (the 0600 key files, the RPC allowlist, the pinned chain,
 *      the crash-safe store) and preflight (reads only); it does not start
 *      when a check its trading depends on fails;
 *   4. keeps the config's offers listed: `offers` are sell offers, `bids`
 *      buy offers. One the board closed or filled is listed again, while the
 *      bot holds what one smallest trade needs; an offer the config no longer
 *      lists is cancelled;
 *   5. every `take.everyS` seconds sells into bids (`minPrice`: sellDownTo)
 *      or buys from asks (`maxPrice`: buyUpTo);
 *   6. kit.run(): accepts takes whose checks pass once seen for acceptAfterS,
 *      locks, claims its own USDC (claimMode "self"), claims bought tokens
 *      itself when the keeper has not within claimWatchS, refunds after the
 *      time limits, and resumes every trade after a crash or a restart.
 *
 * The bot drives its trades with kit.run() only; it never calls step(), so
 * it needs no resume() of its own (run() resumes first and then once a
 * minute) and never mixes step(id, policy) with a running run().
 *
 * Ctrl-C once: no new offers or takes; the bot's offers are cancelled, a take
 * still waiting for an answer is left to time out, and every running trade is
 * finished; then it exits. Ctrl-C again: it exits at once. Its state is kept
 * either way, so the next start resumes every running trade.
 *
 * --dry-run makes the same start (keys, preflight), then the board's GETs
 * (offers, the feed of done trades, the reference price), and prints what it
 * would list and take. It sends nothing: its board calls can only be GETs, and
 * its chain transports refuse every send.
 *
 * Keys are read only from the 0600 files the config names, never from the
 * command line. Every line printed goes through redact(): no key, control
 * token or swap secret is ever printed.
 */
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  createKit, SafetyError, BoardError, P2P_CONFIG, MAX_TAKES, networkProblem, tokenOf, tokenToRaw, usdcToRaw, fromRaw, redact,
  type Kit, type KitOptions, type KitInternals, type Policy, type OfferInput, type LocalOffer, type Offer, type Reference,
  type PreflightReport, type Network, type Side
} from '../src/index.js';
import { checkToken, offerCheck } from '../src/checks.js';
import { secretShapedArg } from '../src/keys.js';
import { phaRpc, balanceOf, type PhaRpc } from '../src/pha.js';
import { baseClient, type BaseClient } from '../src/base.js';
import { DEFAULT_API, USDC_DECIMALS, INSTANT_NETWORKS, instantTiming, phaPinned, baseDeployed } from '../src/pins.js';
import { usdcFor, amountText } from '../src/rules.js';
import { errorText } from '../src/redact.js';
import { sleep as realSleep, type SleepFn } from '../src/board.js';

// ── The config ───────────────────────────────────────────────────────────────

/** seller and buyer: the two example bots, with their devnet configs in examples/; market: your own bot, with your own config. */
export type Role = 'seller' | 'buyer' | 'market';

/** A recurring order: `side` is the bot's own side (buy: buyUpTo at most `limit`; sell: sellDownTo at least `limit`). */
export interface TakeOrder {
  side: 'buy' | 'sell';
  symbol: string;
  /** Whole tokens (decimal text). */
  amount: string;
  /** USDC per whole token (decimal text): maxPrice of a buy, minPrice of a sell. */
  limit: string;
  /** Seconds between two orders. */
  everyS: number;
  maxLegs?: number;
}

/** A bot config, checked and with its defaults filled in. Paths are as written (relative to the working directory). */
export interface BotConfig {
  network: Network;
  api: string;
  apiKeyFile: string | null;
  keys: { pha: string; base: string };
  dataDir: string;
  phaRpc: string | null;
  baseRpc: string | null;
  /** The offers the bot keeps listed: the config's `offers` (side sell) then its `bids` (side buy). */
  offers: OfferInput[];
  take: TakeOrder[];
  acceptOnTheirOwn: boolean;
  /** null: the kit's default (15 s). */
  acceptAfterS: number | null;
  /** null: the network's claim watch (60 s on devnet). */
  claimWatchS: number | null;
  claimMode: 'self' | 'reveal-then-self';
  usePermit: boolean;
}

const CONFIG_KEYS = ['network', 'api', 'apiKeyFile', 'keys', 'dataDir', 'phaRpc', 'baseRpc', 'offers', 'bids', 'take',
  'acceptOnTheirOwn', 'acceptAfterS', 'claimWatchS', 'claimMode', 'usePermit'] as const;
const OFFER_KEYS = ['symbol', 'total', 'min', 'max', 'price', 'follow', 'mode'] as const;
const FOLLOW_KEYS = ['offsetBps', 'limitPrice', 'dailyMax'] as const;
const TAKE_KEYS = ['symbol', 'amount', 'minPrice', 'maxPrice', 'everyS', 'maxLegs'] as const;
/** The shortest pause between two recurring orders: each one reads the book and may take, so seconds apart is plenty. */
const MIN_EVERY_S = 10;

const configError = (text: string) => new SafetyError('BAD_CONFIG', text);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) throw configError(`${where} has an unknown key "${k}" (allowed: ${allowed.join(', ')}).`);
  }
}

function text(o: Record<string, unknown>, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== 'string' || !v.trim()) throw configError(`${where}.${key} is required, as text.`);
  return v;
}

function optText(o: Record<string, unknown>, key: string, where: string): string | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !v.trim()) throw configError(`${where}.${key} is text, or null.`);
  return v;
}

function seconds(o: Record<string, unknown>, key: string): number | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 86_400) throw configError(`${key} is a number of seconds from 0 to 86400, or null for the kit's default.`);
  return v;
}

/** A kit refusal of an amount (BAD_AMOUNT, TOKEN_NOT_TRADED) as a config error. */
function asConfigError<T>(where: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw configError(`${where}: ${e instanceof SafetyError ? e.detail : errorText(e)}`);
  }
}

function symbolOf(o: Record<string, unknown>, where: string): string {
  const s = o.symbol;
  if (checkToken(s)) throw configError(`${where}.symbol is TAZ, SOUL, KCAL or RA, written exactly so.`);
  return s as string;
}

function parseOffer(v: unknown, side: Side, where: string, network: Network): OfferInput {
  if (!isObj(v)) throw configError(`${where} is an object such as {"symbol": "TAZ", "total": "30", "min": "1", "max": "5", "price": "1.08"}.`);
  onlyKeys(v, OFFER_KEYS, where);
  const symbol = symbolOf(v, where);
  const total = text(v, 'total', where), min = text(v, 'min', where), max = text(v, 'max', where);
  const raw = asConfigError(where, () => ({
    total: tokenToRaw(symbol, total, 'total'), min: tokenToRaw(symbol, min, 'min'), max: tokenToRaw(symbol, max, 'max')
  }));
  const hasPrice = v.price !== undefined && v.price !== null;
  const hasFollow = v.follow !== undefined && v.follow !== null;
  if (hasPrice === hasFollow) throw configError(`${where} has a "price" or a "follow", exactly one.`);
  let out: OfferInput;
  let worst: bigint;
  if (hasPrice) {
    const price = text(v, 'price', where);
    worst = asConfigError(where, () => usdcToRaw(price, 'price'));
    out = { side, symbol, total, min, max, price };
  } else {
    const f = v.follow;
    if (!isObj(f)) throw configError(`${where}.follow is an object such as {"offsetBps": 200, "limitPrice": "1.90"}.`);
    onlyKeys(f, FOLLOW_KEYS, `${where}.follow`);
    if (typeof f.offsetBps !== 'number' || !Number.isInteger(f.offsetBps) || Math.abs(f.offsetBps) > 2000) {
      throw configError(`${where}.follow.offsetBps is a whole number of basis points from -2000 to 2000.`);
    }
    const limitPrice = text(f, 'limitPrice', `${where}.follow`);
    worst = asConfigError(`${where}.follow`, () => usdcToRaw(limitPrice, 'limitPrice'));
    const dailyMax = optText(f, 'dailyMax', `${where}.follow`);
    if (dailyMax !== null) asConfigError(`${where}.follow`, () => tokenToRaw(symbol, dailyMax, 'dailyMax'));
    out = { side, symbol, total, min, max, follow: { offsetBps: f.offsetBps, limitPrice, ...(dailyMax !== null ? { dailyMax } : {}) } };
  }
  // "mode": "instant" (build spec section 3.10): the buyer locks the USDC first, then the bot locks its tokens.
  // Sell offers only, and only where this kit release offers instant trades (devnet); the API key it needs is
  // checked with the whole config (parseBotConfig). "standard", or no mode, is a standard offer.
  const mode = v.mode;
  if (mode !== undefined && mode !== null && mode !== 'standard' && mode !== 'instant') throw configError(`${where}.mode is "standard" or "instant".`);
  if (mode === 'instant') {
    if (side !== 'sell') throw configError(`${where}.mode "instant" is for offers to sell only (its buyer locks the USDC first); list this one as a standard bid.`);
    if (!instantTiming(network)) throw configError(`${where}.mode "instant": this kit release offers instant trades on ${INSTANT_NETWORKS.join(' and ') || 'no network'} only, not on ${network}.`);
    out = { ...out, mode: 'instant' };
  }
  // Check 7 against the kit's own table now, so a bad offer stops the bot before anything is sent (a following one at its limit price).
  const p7 = offerCheck(network, { symbol, tazTotal: raw.total, tazMin: raw.min, tazMax: raw.max, price: worst });
  if (p7) throw configError(`${where}: ${p7.text}`);
  return out;
}

function parseTake(v: unknown, where: string): TakeOrder {
  if (!isObj(v)) throw configError(`${where} is an object such as {"symbol": "TAZ", "minPrice": "1.05", "amount": "2", "everyS": 120}.`);
  onlyKeys(v, TAKE_KEYS, where);
  const symbol = symbolOf(v, where);
  const amount = text(v, 'amount', where);
  asConfigError(where, () => tokenToRaw(symbol, amount, 'amount'));
  const hasMin = v.minPrice !== undefined && v.minPrice !== null;
  const hasMax = v.maxPrice !== undefined && v.maxPrice !== null;
  if (hasMin === hasMax) throw configError(`${where} has "minPrice" (sell into bids) or "maxPrice" (buy from asks), exactly one.`);
  const key = hasMax ? 'maxPrice' : 'minPrice';
  const limit = text(v, key, where);
  asConfigError(where, () => usdcToRaw(limit, key));
  const everyS = v.everyS;
  if (typeof everyS !== 'number' || !Number.isInteger(everyS) || everyS < MIN_EVERY_S || everyS > 86_400) {
    throw configError(`${where}.everyS is a whole number of seconds from ${MIN_EVERY_S} to 86400.`);
  }
  let maxLegs: number | undefined;
  if (v.maxLegs !== undefined && v.maxLegs !== null) {
    if (typeof v.maxLegs !== 'number' || !Number.isInteger(v.maxLegs) || v.maxLegs < 1 || v.maxLegs > MAX_TAKES) throw configError(`${where}.maxLegs is a whole number from 1 to ${MAX_TAKES}.`);
    maxLegs = v.maxLegs;
  }
  return { side: hasMax ? 'buy' : 'sell', symbol, amount, limit, everyS, ...(maxLegs !== undefined ? { maxLegs } : {}) };
}

/**
 * Check a bot config (parsed JSON) and fill in its defaults. Throws
 * SafetyError BAD_CONFIG naming the first problem; nothing is read or sent
 * before a config passes.
 */
export function parseBotConfig(raw: unknown): BotConfig {
  if (!isObj(raw)) throw configError('A bot config is a JSON object.');
  onlyKeys(raw, CONFIG_KEYS, 'The config');
  const network = raw.network;
  if (network !== 'devnet' && network !== 'mainnet') throw configError('network is "devnet" or "mainnet".');
  const keys = raw.keys;
  if (!isObj(keys)) throw configError('keys is an object: {"pha": "<Phantasma key file>", "base": "<Base key file>"}.');
  onlyKeys(keys, ['pha', 'base'], 'keys');
  const list = (key: 'offers' | 'bids', side: Side): OfferInput[] => {
    const v = raw[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw configError(`${key} is a list of offers.`);
    return v.map((x, i) => parseOffer(x, side, `${key}[${i}]`, network));
  };
  const offers = [...list('offers', 'sell'), ...list('bids', 'buy')];
  const takeRaw = raw.take;
  const take = takeRaw === undefined || takeRaw === null ? [] : Array.isArray(takeRaw) ? takeRaw.map((x, i) => parseTake(x, `take[${i}]`)) : [parseTake(takeRaw, 'take')];
  const bool = (key: string, dflt: boolean): boolean => {
    const v = raw[key];
    if (v === undefined || v === null) return dflt;
    if (typeof v !== 'boolean') throw configError(`${key} is true or false.`);
    return v;
  };
  const claimMode = raw.claimMode ?? 'self';
  if (claimMode !== 'self' && claimMode !== 'reveal-then-self') throw configError('claimMode is "self" or "reveal-then-self".');
  const apiKeyFile = optText(raw, 'apiKeyFile', 'The config');
  const instantAt = offers.findIndex((w) => w.mode === 'instant');
  if (instantAt >= 0 && !apiKeyFile) {
    throw configError(`offers[${instantAt}].mode "instant" needs an API key the owner flagged for instant offers: name its file as "apiKeyFile".`);
  }
  return {
    network,
    api: optText(raw, 'api', 'The config') ?? DEFAULT_API,
    apiKeyFile,
    keys: { pha: text(keys, 'pha', 'keys'), base: text(keys, 'base', 'keys') },
    dataDir: text(raw, 'dataDir', 'The config'),
    phaRpc: optText(raw, 'phaRpc', 'The config'),
    baseRpc: optText(raw, 'baseRpc', 'The config'),
    offers,
    take,
    acceptOnTheirOwn: bool('acceptOnTheirOwn', true),
    acceptAfterS: seconds(raw, 'acceptAfterS'),
    claimWatchS: seconds(raw, 'claimWatchS'),
    claimMode,
    usePermit: bool('usePermit', true)
  };
}

/** The example config of an example bot, next to this file. */
export function defaultConfigPath(role: Exclude<Role, 'market'>): string {
  return fileURLToPath(new URL(`./${role}.devnet.example.json`, import.meta.url));
}

/**
 * The market bot's config when --config names none: market.mainnet.json in
 * the folder the bot runs in (the kit's folder under npm run and start.sh).
 * It is your own file, outside examples/, whose files every version
 * replaces. sh start.sh mainnet makes it from
 * examples/market.mainnet.example.json, which lists no offer, bid or order.
 */
export const MARKET_CONFIG = 'market.mainnet.json';

/** The command that makes the key files examples/market.mainnet.example.json names. */
const MARKET_KEYS_COMMAND = 'npx tsx examples/new-keys.ts --dir keys/mainnet --name market';

/** Whether this kit release pins mainnet's escrow and SaturnSwap (this release: yes; a release without them refuses mainnet). */
const MAINNET_PINNED = phaPinned(P2P_CONFIG.mainnet) && baseDeployed(P2P_CONFIG.mainnet);

/**
 * Why this config may not run now, or null. Mainnet needs all three: the
 * --mainnet flag, KIT_ALLOW_MAINNET=1, and a kit release with mainnet pins
 * (this release has them).
 */
export function networkGate(cfg: Pick<BotConfig, 'network'>, o: { mainnet: boolean; env: Record<string, string | undefined> }): string | null {
  if (cfg.network === 'mainnet' && !o.mainnet) {
    return `This config is for mainnet. A bot trades on mainnet only with --mainnet and KIT_ALLOW_MAINNET=1, and only with a kit release that has mainnet pins${MAINNET_PINNED ? '' : ' (this release has none)'}.`;
  }
  if (o.mainnet && cfg.network !== 'mainnet') return `--mainnet was given, but this config is for ${cfg.network}.`;
  if (cfg.network === 'mainnet' && o.env.KIT_ALLOW_MAINNET !== '1') return '--mainnet also needs KIT_ALLOW_MAINNET=1 in the environment.';
  return networkProblem(cfg.network, { allowMainnet: o.mainnet, env: o.env });
}

/** The KitOptions of a config: its relative paths resolved against `cwd`. */
export function kitOptions(cfg: BotConfig, o: { cwd: string; mainnet?: boolean; env?: Record<string, string | undefined>; log?: (line: string) => void; internals?: KitInternals }): KitOptions {
  return {
    network: cfg.network,
    api: cfg.api,
    ...(cfg.apiKeyFile ? { apiKeyFile: resolve(o.cwd, cfg.apiKeyFile) } : {}),
    phaKeyFile: resolve(o.cwd, cfg.keys.pha),
    baseKeyFile: resolve(o.cwd, cfg.keys.base),
    dataDir: resolve(o.cwd, cfg.dataDir),
    ...(cfg.phaRpc ? { phaRpc: cfg.phaRpc } : {}),
    ...(cfg.baseRpc ? { baseRpc: cfg.baseRpc } : {}),
    claimMode: cfg.claimMode,
    usePermit: cfg.usePermit,
    ...(o.mainnet ? { allowMainnet: true } : {}),
    ...(o.env ? { env: o.env } : {}),
    ...(o.log ? { log: o.log } : {}),
    ...(o.internals ? { internals: o.internals } : {})
  };
}

/**
 * The Policy given to run(): the config's acceptAfterS and claimWatchS (the
 * kit's defaults when null), and the kit's own accept rule (accept when the
 * checks pass), except while the bot stops: a take then gets no answer and
 * the board cancels it after its accept time.
 */
export function botPolicy(cfg: Pick<BotConfig, 'acceptAfterS' | 'claimWatchS'>, stopping: () => boolean = () => false): Policy {
  return {
    ...(cfg.acceptAfterS !== null ? { acceptAfterS: cfg.acceptAfterS } : {}),
    ...(cfg.claimWatchS !== null ? { claimWatchS: cfg.claimWatchS } : {}),
    accept: (_t, ctx) => !stopping() && ctx.checks.ok
  };
}

// ── A dry run's transports: GETs only, no chain send ─────────────────────────

/** Read-only versions of the board's fetch and the two chain transports; every refused write is counted. */
export function readOnlyTransports(network: Network, given: KitInternals | undefined, rpc: { pha?: string | null; base?: string | null } = {}): {
  internals: KitInternals; refused: () => { boardWrites: number; chainSends: number };
} {
  let boardWrites = 0, chainSends = 0;
  const inner = given?.fetch ?? globalThis.fetch;
  const fetchGet = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      boardWrites++;
      throw new Error(`dry run: a ${method} to the board was refused (a dry run sends nothing)`);
    }
    return inner(input, init);
  }) as typeof fetch;
  const p: PhaRpc = given?.pha ?? phaRpc(network, rpc.pha ? { url: rpc.pha } : {});
  const b: BaseClient = given?.base ?? baseClient(network, rpc.base ? { url: rpc.base } : {});
  const pha: PhaRpc = {
    views: (c) => p.views(c), contract: (n) => p.contract(n), balances: (a) => p.balances(a), transaction: (h) => p.transaction(h),
    sendRaw: async () => { chainSends++; throw new Error('dry run: a Phantasma send was refused'); }
  };
  const base: BaseClient = {
    chainId: () => b.chainId(), block: (at) => b.block(at), read: (c) => b.read(c), logs: (q) => b.logs(q), receipt: (h) => b.receipt(h),
    seen: (h) => b.seen(h), code: (a) => b.code(a), balance: (a) => b.balance(a), nonce: (a, t) => b.nonce(a, t), priorityFee: () => b.priorityFee(),
    call: (c) => b.call(c), estimateGas: (c) => b.estimateGas(c),
    sendRaw: async () => { chainSends++; throw new Error('dry run: a Base send was refused'); }
  };
  return { internals: { ...given, fetch: fetchGet, pha, base }, refused: () => ({ boardWrites, chainSends }) };
}

// ── The runner ───────────────────────────────────────────────────────────────

/** What the runner uses of a Kit (createKit's Kit has all of it; tests pass a fake). */
export type BotKit = Pick<Kit, 'network' | 'address' | 'preflight' | 'postOffer' | 'cancelOffer' | 'buyUpTo' | 'sellDownTo' | 'run' | 'close'> & {
  readonly board: Pick<Kit['board'], 'offers' | 'recent' | 'reference'>;
  readonly store: Pick<Kit['store'], 'listOffers' | 'listTrades'>;
  readonly pha: Pick<Kit['pha'], 'balances'>;
  readonly base: Pick<Kit['base'], 'readFunds'>;
};

/** Where SIGINT and SIGTERM come from (the process by default). */
export interface SignalSource {
  on(event: 'SIGINT' | 'SIGTERM', fn: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', fn: () => void): unknown;
}

export interface RunBotOptions {
  role: Role;
  /** The command's arguments (default process.argv.slice(2)). */
  argv?: readonly string[];
  /** Default process.env (KIT_ALLOW_MAINNET, KIT_STORE_KEY_FILE). */
  env?: Record<string, string | undefined>;
  /** Relative paths in the config resolve against it (default process.cwd(): the kit's folder under npm run). */
  cwd?: string;
  /** Receives every output line (default console.log); lines are redacted. */
  out?: (line: string) => void;
  signals?: SignalSource;
  /** Builds the kit (default createKit). */
  makeKit?: (o: KitOptions) => Promise<BotKit>;
  /** Handed to createKit (tests: a fake board and fake chains with their clock). */
  internals?: KitInternals;
  /** The runner's clock and waits (default: internals.now/sleep, else real time). */
  now?: () => number;
  sleep?: SleepFn;
}

/** The runner's own loop wakes this often at most. */
const TICK_MS = 5_000;
/** The offers are checked against the config this often. */
const SYNC_EVERY_MS = 60_000;
/** While stopping, the running trades are named this often. */
const NOTE_EVERY_MS = 60_000;
/** One Ctrl-C that a wrapper delivers twice within this long counts once. */
const DOUBLE_SIGNAL_MS = 500;
/** Preflight items that do not stop a start (the bot reports them; each step checks its own funds again). */
const WARN_ONLY: ReadonlySet<string> = new Set(['phantasma balance', 'base balance', 'api key']);

const usage = (role: Role) => [
  `Usage: npm run ${role} [-- --config <file>] [--dry-run] [--mainnet]`,
  role === 'market'
    ? `  --config <file>  the bot's config (default ./${MARKET_CONFIG}, your own: sh start.sh mainnet makes it from examples/market.mainnet.example.json); relative paths in it resolve against the current folder`
    : `  --config <file>  the bot's config (default examples/${role}.devnet.example.json); relative paths in it resolve against the current folder`,
  '  --dry-run        start, run the preflight and read the board, print what it would list and take, and send nothing',
  `  --mainnet        allow a mainnet config (also needs KIT_ALLOW_MAINNET=1 and a kit release with mainnet pins${MAINNET_PINNED ? '' : '; this release has none'})`,
  `Keys are never given on the command line: the config names their 0600 files (make them with ${role === 'market' ? MARKET_KEYS_COMMAND : 'npx tsx examples/new-keys.ts'}).`
].join('\n');

/** A refusal or failure as one line: a SafetyError's code and sentence, a board error's code (redacted). */
export function explain(e: unknown): string {
  if (e instanceof SafetyError) return `${e.code}: ${e.detail}`;
  if (e instanceof BoardError) return `${e.message}${e.reason ? ` (${e.reason})` : ''}${e.retryAfter != null ? `; it may pass after ${e.retryAfter} s` : ''}`;
  return errorText(e);
}

/** Whole tokens or USDC for a line. */
const units = (raw: bigint | string, decimals: number) => fromRaw(raw, decimals);

/** An offer of the config, in words. */
export function describeOffer(w: OfferInput, usdc = 'USDC'): string {
  const what = `${w.side} ${w.total} ${w.symbol} (${w.min} to ${w.max} per trade)`;
  const mode = w.mode === 'instant' ? ' (instant: the buyer locks first)' : '';
  if (w.follow) {
    const pct = (w.follow.offsetBps / 100).toFixed(2).replace(/\.?0+$/, '');
    return `${what} following the reference price ${w.follow.offsetBps >= 0 ? '+' : ''}${pct}%, never ${w.side === 'sell' ? 'below' : 'above'} ${w.follow.limitPrice} ${usdc}${mode}`;
  }
  return `${what} at ${w.price} ${usdc}${mode}`;
}

/** Whether a kept open offer is this config entry, as listed (mode, amounts, price or follow settings, accept setting). */
export function sameOffer(k: LocalOffer, w: OfferInput, acceptOnTheirOwn: boolean): boolean {
  if (k.side !== w.side || k.symbol !== w.symbol || k.acceptOnTheirOwn !== acceptOnTheirOwn || k.mode !== (w.mode ?? 'standard')) return false;
  const raw = (v: string) => tokenToRaw(w.symbol, v).toString();
  if (k.tazTotal !== raw(w.total) || k.tazMin !== raw(w.min) || k.tazMax !== raw(w.max)) return false;
  if (w.follow) {
    const f = k.follow;
    return !!f && f.offsetBps === w.follow.offsetBps && f.limitPrice === usdcToRaw(w.follow.limitPrice).toString()
      && (f.dailyMax ?? k.tazTotal) === (w.follow.dailyMax !== undefined ? raw(w.follow.dailyMax) : k.tazTotal);
  }
  return k.follow === null && k.price === usdcToRaw(w.price!).toString();
}

/**
 * Why the bot cannot fill even the smallest trade of an offer now, or null
 * (a read that fails holds nothing back: every accept checks the funds again).
 */
async function fundsShort(kit: BotKit, w: OfferInput, usdcSymbol: string): Promise<string | null> {
  const t = tokenOf(w.symbol)!;
  const min = tokenToRaw(w.symbol, w.min);
  try {
    if (w.side === 'sell') {
      const have = balanceOf(await kit.pha.balances(kit.address.pha), w.symbol) ?? 0n;
      return have >= min ? null : `this bot's Phantasma address holds ${amountText(have, t.decimals)} ${t.symbol}, less than the smallest trade (${w.min} ${t.symbol})`;
    }
    const need = usdcFor(min, usdcToRaw(w.price ?? w.follow!.limitPrice), w.symbol);
    const have = (await kit.base.readFunds(kit.address.base)).usdc;
    return have >= need ? null : `this bot's Base address holds ${amountText(have, USDC_DECIMALS)} ${usdcSymbol}, less than the smallest trade needs (${amountText(need, USDC_DECIMALS)} ${usdcSymbol})`;
  } catch {
    return null;
  }
}

/** Whether `moduleUrl` is the script node was started with. */
export function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(resolve(entry));
  } catch {
    return false;
  }
}

/**
 * Run an example bot (see the file comment). Resolves with the exit code:
 * 0 after a clean stop (or a dry run whose checks passed), 1 when it did not
 * start or run() stopped on a failure, 2 for a bad command line, 130 when a
 * second Ctrl-C ended it at once.
 */
export async function runBot(o: RunBotOptions): Promise<number> {
  const role = o.role;
  const argv = [...(o.argv ?? process.argv.slice(2))];
  const env = o.env ?? process.env;
  const cwd = o.cwd ?? process.cwd();
  const now = o.now ?? o.internals?.now ?? Date.now;
  const sleep = o.sleep ?? o.internals?.sleep ?? realSleep;
  const write = o.out ?? ((l: string) => console.log(l));
  const stamp = () => new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const say = (line: string) => write(`${stamp()} [${role}] ${redact(line, 2000)}`);
  const kitLog = (line: string) => write(`${stamp()} ${redact(line, 2000)}`);

  // Keys are never arguments: one that looks like a key is refused before anything else.
  if (secretShapedArg(argv)) {
    say('Refused: an argument looks like a key or a secret. Keys are read only from the key files the config names; remove it from the command (and from your shell history).');
    return 2;
  }
  let flags: { config?: string; 'dry-run'?: boolean; mainnet?: boolean; help?: boolean };
  try {
    flags = parseArgs({
      args: argv, strict: true, allowPositionals: false,
      options: { config: { type: 'string' }, 'dry-run': { type: 'boolean' }, mainnet: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }
    }).values;
  } catch (e) {
    say(errorText(e));
    write(usage(role));
    return 2;
  }
  if (flags.help) {
    write(usage(role));
    return 0;
  }
  const configPath = flags.config ? resolve(cwd, flags.config) : role === 'market' ? resolve(cwd, MARKET_CONFIG) : defaultConfigPath(role);
  let cfg: BotConfig;
  try {
    cfg = parseBotConfig(JSON.parse(await readFile(configPath, 'utf8')));
  } catch (e) {
    const noMarketConfig = role === 'market' && !flags.config && (e as { code?: unknown } | null)?.code === 'ENOENT';
    const hint = noMarketConfig ? `. Make it with: sh start.sh mainnet setup (or copy examples/market.mainnet.example.json to ${MARKET_CONFIG}), then add your offers.` : '';
    say(`The config ${configPath} cannot be used: ${e instanceof SafetyError ? e.detail : errorText(e)}${hint}`);
    return 1;
  }
  const mainnet = flags.mainnet === true;
  const gate = networkGate(cfg, { mainnet, env });
  if (gate) {
    say(`Refused: ${gate}`);
    return 1;
  }
  const dryRun = flags['dry-run'] === true;
  let guard: ReturnType<typeof readOnlyTransports> | null = null;
  try {
    guard = dryRun ? readOnlyTransports(cfg.network, o.internals, { pha: cfg.phaRpc, base: cfg.baseRpc }) : null;
  } catch (e) {
    say(`The bot did not start: ${explain(e)}`);
    return 1;
  }
  say(`${dryRun ? 'Dry run' : 'Starting'} on ${cfg.network} with ${configPath}`);
  let kit: BotKit;
  try {
    kit = await (o.makeKit ?? createKit)(kitOptions(cfg, { cwd, mainnet, env, log: kitLog, internals: guard ? guard.internals : o.internals }));
  } catch (e) {
    const missing = e instanceof SafetyError && e.code === 'KEY_FILE' && /cannot be opened \(ENOENT\)/.test(e.detail);
    say(`The bot did not start: ${explain(e)}${missing ? ` Make the key files with: ${role === 'market' ? MARKET_KEYS_COMMAND : 'npx tsx examples/new-keys.ts'}` : ''}`);
    return 1;
  }
  try {
    const usdc = P2P_CONFIG[cfg.network].base.usdcSymbol;
    const report = await kit.preflight();
    const blocking = printPreflight(report, cfg, say);
    if (dryRun) return await dryRunRest(kit, cfg, { say, usdc, blocking, refused: guard!.refused });
    if (blocking.length) {
      say(`Not starting: ${blocking.join(', ')} failed (above). Nothing was sent.`);
      return 1;
    }
    return await trade(kit, cfg, { say, usdc, now, sleep, signals: o.signals ?? process });
  } finally {
    await kit.close().catch((e) => say(`The data directory could not be released cleanly (${explain(e)}).`));
  }
}

/** Print the preflight; returns the names of the failed items that stop a start. */
function printPreflight(report: PreflightReport, cfg: BotConfig, say: (l: string) => void): string[] {
  say(`Addresses: Phantasma ${report.address.pha}, Base ${report.address.base}`);
  const used = new Set([...cfg.offers.map((x) => x.symbol), ...cfg.take.map((x) => x.symbol)]);
  const blocking: string[] = [];
  for (const i of report.items) {
    say(`preflight ${i.ok ? 'ok' : 'FAIL'} ${i.name}: ${i.text}`);
    if (i.ok || WARN_ONLY.has(i.name)) continue;
    const m = /^escrow (\S+)$/.exec(i.name);
    if (m && !used.has(m[1]!)) continue;
    blocking.push(i.name);
  }
  return blocking;
}

/** The rest of a dry run: the board's GETs and the plan. Sends nothing. */
async function dryRunRest(kit: BotKit, cfg: BotConfig, x: { say: (l: string) => void; usdc: string; blocking: string[]; refused: () => { boardWrites: number; chainSends: number } }): Promise<number> {
  const { say, usdc } = x;
  try {
    const offers = await kit.board.offers();
    say(`Board: ${offers.length} open offer(s).`);
    for (const line of bookLines(offers, usdc)) say(`  ${line}`);
  } catch (e) {
    say(`Board: the offers could not be read (${explain(e)}).`);
  }
  try {
    const feed = await kit.board.recent({ limit: 20 });
    say(`Board: ${feed.trades.length} trade(s) in the latest page of the feed of done trades.`);
  } catch (e) {
    say(`Board: the feed could not be read (${explain(e)}).`);
  }
  try {
    for (const line of referenceLines(await kit.board.reference(), cfg, usdc)) say(line);
  } catch (e) {
    say(`Board: the reference price could not be read (${explain(e)}).`);
  }
  const kept = (await kit.store.listOffers()).filter((k) => k.closedAt == null);
  for (const w of cfg.offers) {
    const same = kept.find((k) => sameOffer(k, w, cfg.acceptOnTheirOwn));
    if (same) {
      say(`Would keep offer #${same.id} listed: ${describeOffer(w, usdc)}.`);
      continue;
    }
    const short = await fundsShort(kit, w, usdc);
    say(short ? `Would not list ${describeOffer(w, usdc)} yet: ${short}.` : `Would list: ${describeOffer(w, usdc)}.`);
  }
  for (const t of cfg.take) {
    say(`Would ${t.side} up to ${t.amount} ${t.symbol} every ${t.everyS} s, at ${t.side === 'buy' ? 'most' : 'least'} ${t.limit} ${usdc} per ${t.symbol}.`);
  }
  const r = x.refused();
  say(`Dry run done: nothing was sent (board writes refused: ${r.boardWrites}, chain sends refused: ${r.chainSends}).`);
  if (x.blocking.length) say(`A real start would stop here: ${x.blocking.join(', ')} failed.`);
  return x.blocking.length ? 1 : 0;
}

/** The book per token, in words: open asks and bids with the best price of each side. */
function bookLines(offers: readonly Offer[], usdc: string): string[] {
  const out: string[] = [];
  for (const sym of [...new Set(offers.map((o) => o.symbol))].sort()) {
    const asks = offers.filter((o) => o.symbol === sym && o.side === 'sell').map((o) => BigInt(o.price));
    const bids = offers.filter((o) => o.symbol === sym && o.side === 'buy').map((o) => BigInt(o.price));
    const best = (v: bigint[], hi: boolean) => (v.length ? units(v.reduce((a, b) => (hi ? (b > a ? b : a) : (b < a ? b : a))), USDC_DECIMALS) : '-');
    out.push(`${sym}: ${asks.length} ask(s), best ${best(asks, false)} ${usdc}; ${bids.length} bid(s), best ${best(bids, true)} ${usdc}`);
  }
  return out;
}

/** The most the P2P reference lets RA-priced and TAZ-priced trades disagree once TAZ is converted by the pool (build spec 3.2, tazCrossBand). */
const TAZ_CROSS_BAND = 0.15;
/** The most the P2P reference may sit outside the best bid and ask (build spec 3.2, bookBand). */
const BOOK_BAND = 0.1;

/**
 * The reference price of RA and TAZ (display only), and where the config's
 * fixed prices sit, in RA terms (a TAZ price times the reference pool's TAZ
 * per RA). The P2P reference built from trades compares the two tokens that
 * way (they may disagree by at most 15%) and drops trades priced far from
 * the others, so the two tokens' prices must keep one ratio. While the
 * reference price is "via SOUL", its level is information only: offers far
 * from it trade among themselves, but do not count as depth near it.
 */
export function referenceLines(ref: Reference, cfg: Pick<BotConfig, 'offers' | 'take'>, usdc = 'USDC'): string[] {
  const out: string[] = [];
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  const ra = ref.tokens?.RA, taz = ref.tokens?.TAZ;
  const usd = (v: number | null) => (v == null ? 'none' : `$${v.toFixed(4)}`);
  const fix = (v: number) => v.toFixed(3);
  out.push(`Reference price (display only): RA ${usd(num(ra?.line))} (${ra?.basis ?? 'none'}), TAZ ${usd(num(taz?.line))} (${taz?.basis ?? 'none'}); via SOUL: RA ${usd(num(ra?.viaSoul))}, TAZ ${usd(num(taz?.viaSoul))}${ref.stale ? '; stale' : ''}.`);
  const r = num(ref.twap?.tazPerRa);
  out.push(`Reference pool #${ref.twap?.poolId ?? '?'}: ${r == null ? 'no TAZ per RA average yet' : `${r.toFixed(4)} TAZ per RA`} (${ref.twap?.status ?? 'unknown'}).`);
  if (r == null) {
    out.push('Calibration: not possible now (the reference pool has no TAZ per RA average yet).');
    return out;
  }
  // The config's fixed prices and its orders' limits, in RA terms.
  const inRa = [
    ...cfg.offers.filter((o) => o.price).map((o) => ({ sym: o.symbol, price: Number(o.price) })),
    ...cfg.take.map((t) => ({ sym: t.symbol, price: Number(t.limit) }))
  ].filter((p) => p.sym === 'RA' || p.sym === 'TAZ').map((p) => (p.sym === 'RA' ? p.price : p.price * r));
  if (inRa.length === 0) return out;
  const sorted = [...inRa].sort((a, b) => a - b);
  const level = sorted[Math.floor(sorted.length / 2)]!;
  out.push(`Calibration: in RA terms (TAZ times ${r.toFixed(4)}), the config's prices sit at ${fix(sorted[0]!)} to ${fix(sorted.at(-1)!)} ${usdc} per RA, around ${fix(level)}.`);
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const raSide = [...cfg.offers.filter((o) => o.price && o.symbol === 'RA').map((o) => Number(o.price)), ...cfg.take.filter((t) => t.symbol === 'RA').map((t) => Number(t.limit))];
  const tazSide = [...cfg.offers.filter((o) => o.price && o.symbol === 'TAZ').map((o) => Number(o.price) * r), ...cfg.take.filter((t) => t.symbol === 'TAZ').map((t) => Number(t.limit) * r)];
  if (raSide.length && tazSide.length) {
    const apart = Math.abs(mean(raSide) / mean(tazSide) - 1);
    out.push(`Calibration: its RA and TAZ prices are ${(apart * 100).toFixed(1)}% apart in RA terms (the P2P reference allows ${TAZ_CROSS_BAND * 100}%)${apart > TAZ_CROSS_BAND ? ': recalibrate the config, or trades at these prices fail the reference\'s TAZ cross-check' : ''}.`);
  }
  const raRef = num(ra?.line) ?? num(ra?.viaSoul);
  if (raRef != null) {
    const pct = (level / raRef) * 100;
    const far = Math.abs(level / raRef - 1) > BOOK_BAND;
    const note = !far ? '' : ra?.basis === 'p2p'
      ? ': far from the P2P reference price; recalibrate the config'
      : ': offers this far from it trade with each other, but do not count as depth near the reference price';
    out.push(`Calibration: that level is ${pct.toFixed(1)}% of the reference price of RA (${usd(raRef)}, ${ra?.basis ?? 'via_soul'})${note}.`);
  }
  return out;
}

/** The trading part of a run, until a Ctrl-C (see the file comment). */
async function trade(kit: BotKit, cfg: BotConfig, x: { say: (l: string) => void; usdc: string; now: () => number; sleep: SleepFn; signals: SignalSource }): Promise<number> {
  const { say, usdc, now, sleep, signals } = x;
  const notes = new Map<string, string>();
  const note = (key: string, line: string) => {
    if (notes.get(key) === line) return;
    notes.set(key, line);
    say(line);
  };
  const runCtl = new AbortController();
  let stopping = false;
  let forced = false;
  let presses = 0;
  let lastPress = 0;
  let wake: (() => void) | null = null;
  const wakeUp = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  const onSignal = () => {
    const t = now();
    if (presses > 0 && t - lastPress < DOUBLE_SIGNAL_MS) return;
    presses++;
    lastPress = t;
    if (presses === 1) {
      stopping = true;
      say('Stopping: no new offers or takes. The bot cancels its offers and finishes its running trades, then exits. Press Ctrl-C again to exit now (its state is kept; the next start resumes the trades).');
    } else {
      forced = true;
      say('Exiting now. The bot\'s state is kept: run it again to resume its trades.');
      runCtl.abort();
    }
    wakeUp();
  };
  signals.on('SIGINT', onSignal);
  signals.on('SIGTERM', onSignal);

  const syncOffers = async (): Promise<void> => {
    const kept = (await kit.store.listOffers()).filter((k) => k.closedAt == null);
    const used = new Set<number>();
    for (const w of cfg.offers) {
      if (stopping || runCtl.signal.aborted) return;
      const key = `post:${describeOffer(w)}`;
      const same = kept.find((k) => !used.has(k.id) && sameOffer(k, w, cfg.acceptOnTheirOwn));
      if (same) {
        used.add(same.id);
        continue;
      }
      const short = await fundsShort(kit, w, usdc);
      if (short) {
        note(key, `Not listing ${describeOffer(w, usdc)} now: ${short}.`);
        continue;
      }
      try {
        const rec = await kit.postOffer({ ...w, acceptOnTheirOwn: cfg.acceptOnTheirOwn });
        used.add(rec.id);
        notes.delete(key);
        say(`Listed offer #${rec.id}: ${describeOffer(w, usdc)}.`);
      } catch (e) {
        note(key, `Could not list ${describeOffer(w, usdc)}: ${explain(e)}`);
      }
    }
    for (const k of kept) {
      if (used.has(k.id) || stopping || runCtl.signal.aborted) continue;
      try {
        await kit.cancelOffer(k.id);
        say(`Offer #${k.id} cancelled: the config no longer lists it.`);
      } catch (e) {
        note(`cancel:${k.id}`, `Offer #${k.id}, which the config no longer lists, could not be cancelled yet (${explain(e)}).`);
      }
    }
  };

  /** Cancel every open offer of the bot; true once none is left open. */
  const cancelAll = async (): Promise<boolean> => {
    let all = true;
    for (const k of (await kit.store.listOffers()).filter((o) => o.closedAt == null)) {
      try {
        await kit.cancelOffer(k.id);
        say(`Offer #${k.id} cancelled.`);
      } catch (e) {
        all = false;
        note(`cancel:${k.id}`, `Offer #${k.id} could not be cancelled yet (${explain(e)}); trying again.`);
      }
    }
    return all;
  };

  const runTake = async (t: TakeOrder, i: number): Promise<void> => {
    const tok = tokenOf(t.symbol)!;
    const key = `take:${i}`;
    try {
      const legs = t.maxLegs !== undefined ? { maxLegs: t.maxLegs } : {};
      const trades = t.side === 'buy'
        ? await kit.buyUpTo({ symbol: t.symbol, amount: t.amount, maxPrice: t.limit, ...legs })
        : await kit.sellDownTo({ symbol: t.symbol, amount: t.amount, minPrice: t.limit, ...legs });
      if (trades.length === 0) {
        note(key, `No ${t.side === 'buy' ? 'asks' : 'bids'} for ${t.symbol} at ${t.side === 'buy' ? 'or under' : 'or over'} ${t.limit} ${usdc} right now; looking again every ${t.everyS} s.`);
        return;
      }
      notes.delete(key);
      const sum = trades.reduce((a, b) => a + BigInt(b.taz), 0n);
      say(`${t.side === 'buy' ? 'Bought' : 'Sold'} ${units(sum, tok.decimals)} ${t.symbol} in ${trades.length} trade(s): ${trades.map((r) => `#${r.id} at ${units(r.price, USDC_DECIMALS)} ${usdc}`).join(', ')}. run() carries them on.`);
    } catch (e) {
      note(key, `The order to ${t.side} ${t.amount} ${t.symbol} took nothing: ${explain(e)}`);
    }
  };

  /** Sleep up to `ms`, until a signal or run()'s end wakes the loop. */
  const nap = async (ms: number): Promise<void> => {
    if (runCtl.signal.aborted) return;
    const ctl = new AbortController();
    const off = () => ctl.abort();
    runCtl.signal.addEventListener('abort', off, { once: true });
    wake = off;
    try {
      await sleep(ms, ctl.signal);
    } finally {
      runCtl.signal.removeEventListener('abort', off);
      if (wake === off) wake = null;
    }
  };

  let failure: unknown = null;
  let running: Promise<void> | null = null;
  try {
    // As section 6.7 orders it: the offers first, then run().
    await syncOffers();
    running = kit.run(botPolicy(cfg, () => stopping), runCtl.signal).catch((e) => { failure = e; }).finally(() => {
      runCtl.abort();
      wakeUp();
    });
    let nextSync = now() + SYNC_EVERY_MS;
    let nextNote = 0;
    let cancelled = false;
    const due = cfg.take.map(() => now());
    while (!runCtl.signal.aborted) {
      if (stopping) {
        if (!cancelled) cancelled = await cancelAll();
        const open = (await kit.store.listTrades()).filter((t) => !t.endedAt);
        if (cancelled && open.length === 0) {
          say('Every trade of this bot is finished, and its offers are cancelled. Stopped.');
          runCtl.abort();
          break;
        }
        if (now() >= nextNote && open.length) {
          nextNote = now() + NOTE_EVERY_MS;
          const named = open.slice(0, 8).map((t) => `#${t.id} (${t.status ?? 'new'})`).join(', ');
          say(`Waiting for ${open.length} running trade(s) to finish: ${named}${open.length > 8 ? ', and more' : ''}. Ctrl-C again exits now; the next start resumes them.`);
        }
      } else {
        if (now() >= nextSync) {
          await syncOffers();
          nextSync = now() + SYNC_EVERY_MS;
        }
        for (let i = 0; i < cfg.take.length && !stopping && !runCtl.signal.aborted; i++) {
          if (now() < due[i]!) continue;
          await runTake(cfg.take[i]!, i);
          due[i] = now() + cfg.take[i]!.everyS * 1000;
        }
      }
      if (runCtl.signal.aborted) break;
      const soonest = stopping ? TICK_MS : Math.min(nextSync, ...due) - now();
      await nap(Math.max(0, Math.min(TICK_MS, soonest)));
    }
  } catch (e) {
    // A failure of the loop itself (the store lost its lock, for one): reported like run()'s, once run() has ended.
    failure ??= e;
  } finally {
    signals.off('SIGINT', onSignal);
    signals.off('SIGTERM', onSignal);
    // run() returns once its signal aborts; the kit is closed only after that.
    if (!runCtl.signal.aborted) runCtl.abort();
    if (running) await running;
  }
  if (failure) {
    say(`The bot stopped: ${explain(failure)}`);
    return 1;
  }
  return forced ? 130 : 0;
}

/** Run a role's bot as the process's main script, and exit with its code. */
export async function mainOf(role: Role): Promise<void> {
  const code = await runBot({ role });
  process.exitCode = code;
  // Exit even when a transport keeps a socket open after the kit closed.
  setTimeout(() => process.exit(code), 2_000).unref();
}

if (isMain(import.meta.url)) await mainOf('seller');
