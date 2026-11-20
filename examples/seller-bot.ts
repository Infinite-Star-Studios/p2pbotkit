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
 *      lists is cancelled. With `sizeFromBalances`, each offer is listed at
 *      what the bot holds, at most its `total`, and the bot looks again every
 *      `sizeEveryS` seconds ("Offers sized from the balances", below);
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
  type Kit, type KitOptions, type KitInternals, type Policy, type OfferInput, type LocalOffer, type LocalTrade, type Offer, type Reference,
  type PreflightReport, type Network, type Side
} from '../src/index.js';
import { checkToken, offerCheck, sellerNeeds } from '../src/checks.js';
import { secretShapedArg } from '../src/keys.js';
import { phaRpc, balanceOf, type PhaRpc, type PhaBalances } from '../src/pha.js';
import { baseClient, type BaseClient } from '../src/base.js';
import { DEFAULT_API, USDC_DECIMALS, INSTANT_NETWORKS, SOUL_RESERVE, PHA_LOCK_KCAL, instantTiming, phaPinned, baseDeployed } from '../src/pins.js';
import { usdcFor, amountText, followOfferProblem, FOLLOW_TAKE_USD_MAX } from '../src/rules.js';
import { errorText } from '../src/redact.js';
import { sleep as realSleep, CreateError, type SleepFn } from '../src/board.js';

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
  /** List each offer at what the bot holds, at most its total ("Offers sized from the balances", below). false: at the config's totals. */
  sizeFromBalances: boolean;
  /** Seconds between two looks at the balances; null: SIZE_EVERY_S. */
  sizeEveryS: number | null;
  /** What the sizing holds back from the offers, by symbol (a token of the kit, or "USDC" for the buy offers): whole units, decimal text. */
  holdBack: Record<string, string>;
}

const CONFIG_KEYS = ['network', 'api', 'apiKeyFile', 'keys', 'dataDir', 'phaRpc', 'baseRpc', 'offers', 'bids', 'take',
  'acceptOnTheirOwn', 'acceptAfterS', 'claimWatchS', 'claimMode', 'usePermit', 'sizeFromBalances', 'sizeEveryS', 'holdBack'] as const;
const OFFER_KEYS = ['symbol', 'total', 'min', 'max', 'price', 'follow', 'mode'] as const;
const FOLLOW_KEYS = ['offsetBps', 'limitPrice', 'dailyMax'] as const;
const TAKE_KEYS = ['symbol', 'amount', 'minPrice', 'maxPrice', 'everyS', 'maxLegs'] as const;
/** The shortest pause between two recurring orders: each one reads the book and may take, so seconds apart is plenty. */
const MIN_EVERY_S = 10;
/** Seconds between two looks at the balances (sizeFromBalances) when the config's sizeEveryS is null: an hour. */
export const SIZE_EVERY_S = 3600;
/** The shortest time between two looks: each one reads both chains, and may cancel an offer and list it again. */
const MIN_SIZE_EVERY_S = 300;
/** The key of `holdBack` for the USDC on Base, whatever the network calls its USDC. */
const HOLD_USDC = 'USDC';

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
  if (checkToken(s)) throw configError(`${where}.symbol is C, RA, TAZ, SOUL or KCAL, written exactly so.`);
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

/** The config's `holdBack`: what the sizing holds back from the offers, by symbol ("0": nothing). */
function parseHoldBack(v: unknown): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) throw configError('holdBack is an object such as {"KCAL": "100", "USDC": "20"}: what the bot holds back from its offers, by token.');
  const out: Record<string, string> = {};
  for (const [k, amount] of Object.entries(v)) {
    if (k !== HOLD_USDC && checkToken(k)) throw configError(`holdBack has an unknown key "${k}" (allowed: C, RA, TAZ, SOUL, KCAL, ${HOLD_USDC}).`);
    if (typeof amount !== 'string' || !amount.trim()) throw configError(`holdBack.${k} is an amount, as text.`);
    if (!/^0+(\.0+)?$/.test(amount)) asConfigError(`holdBack.${k}`, () => (k === HOLD_USDC ? usdcToRaw(amount, 'The amount') : tokenToRaw(k, amount)));
    out[k] = amount;
  }
  return out;
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
  const every = raw.sizeEveryS;
  if (every !== undefined && every !== null && (typeof every !== 'number' || !Number.isInteger(every) || every < MIN_SIZE_EVERY_S || every > 86_400)) {
    throw configError(`sizeEveryS is a whole number of seconds from ${MIN_SIZE_EVERY_S} to 86400, or null for ${SIZE_EVERY_S} (an hour).`);
  }
  const sizeFromBalances = bool('sizeFromBalances', false);
  const holdBack = parseHoldBack(raw.holdBack);
  // Sized from the balance, an offer that sells KCAL or SOUL would sell them down to what one lock needs, and the bot
  // pays the gas of every Phantasma transaction in KCAL and keeps SOUL free as a seller: the config says what it holds back.
  for (const [i, w] of (sizeFromBalances ? offers : []).entries()) {
    const t = tokenOf(w.symbol);
    if (w.side !== 'sell' || !(t?.gas || t?.stake) || holdBack[w.symbol] !== undefined) continue;
    throw configError(`offers[${i}] sells ${w.symbol} with sizeFromBalances on: say in holdBack.${w.symbol} how much ${w.symbol} the bot holds back (${t.gas ? 'it pays the gas of every Phantasma transaction in KCAL' : 'a seller keeps SOUL free for the fees of Phantasma'}).`);
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
    usePermit: bool('usePermit', true),
    sizeFromBalances,
    sizeEveryS: every ?? null,
    holdBack
  };
}

/**
 * A bot config for a host that keeps the keys, the state and the API key
 * itself (a Cloudflare Durable Object, cloudflare/): a config without
 * "keys", "dataDir" or "apiKeyFile", which name files on a machine. Its keys
 * are the host's secrets and its records live in the host's own store.
 */
export type HostedBotConfig = Omit<BotConfig, 'keys' | 'dataDir' | 'apiKeyFile'>;

/** The keys a hosted config may not have: they name files, and a host keeps those things itself. */
const HOST_KEPT = ['keys', 'dataDir', 'apiKeyFile'] as const;

/**
 * Check a hosted bot config (HostedBotConfig) as parseBotConfig checks a
 * config: the same rules for every offer, bid and order, and the same
 * defaults. `apiKey`: whether the host has an API key for this bot (instant
 * offers need one); `apiKeyName` names where it comes from, for the message.
 */
export function parseHostedConfig(raw: unknown, o: { apiKey: boolean; apiKeyName?: string }): HostedBotConfig {
  if (!isObj(raw)) throw configError('A bot config is a JSON object.');
  // null names no file (the example configs say "apiKeyFile": null): it is left out like an absent key.
  for (const k of HOST_KEPT) {
    if (raw[k] !== undefined && raw[k] !== null) throw configError(`The config has "${k}", which names a file on a machine. Here the keys, the state and the API key are kept by the host (its secrets and its own store): remove "${k}".`);
  }
  const rest = Object.fromEntries(Object.entries(raw).filter(([k]) => !(HOST_KEPT as readonly string[]).includes(k)));
  onlyKeys(rest, CONFIG_KEYS.filter((k) => !(HOST_KEPT as readonly string[]).includes(k)), 'The config');
  // The rest is checked exactly as parseBotConfig checks it; the three host-kept fields are only placeholders here.
  const { keys: _keys, dataDir: _dataDir, apiKeyFile: _apiKeyFile, ...cfg } = parseBotConfig({ ...rest, keys: { pha: '(host)', base: '(host)' }, dataDir: '(host)', apiKeyFile: '(host)' });
  const instantAt = cfg.offers.findIndex((w) => w.mode === 'instant');
  if (instantAt >= 0 && !o.apiKey) {
    throw configError(`offers[${instantAt}].mode "instant" needs an API key the owner flagged for instant offers${o.apiKeyName ? `: set ${o.apiKeyName}` : ''}.`);
  }
  return cfg;
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
export function botPolicy(cfg: Pick<HostedBotConfig, 'acceptAfterS' | 'claimWatchS'>, stopping: () => boolean = () => false): Policy {
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
  const rpcFetch = given?.rpcFetch ? { fetch: given.rpcFetch } : {};
  const p: PhaRpc = given?.pha ?? phaRpc(network, { ...(rpc.pha ? { url: rpc.pha } : {}), ...rpcFetch });
  const b: BaseClient = given?.base ?? baseClient(network, { ...(rpc.base ? { url: rpc.base } : {}), ...rpcFetch });
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
  readonly board: Pick<Kit['board'], 'offers' | 'recent' | 'reference' | 'heartbeat'>;
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
/** With sizeFromBalances: an offer the bot holds too little for, and a look that could not finish, are taken up again this often, not at every sync (each look reads the chains). */
const SHORT_AGAIN_MS = 300_000;
/** A listing whose answer from the board was lost is not sent again for this long: run() first settles whether it was made. */
const SETTLE_MS = 120_000;
/** A take that waits on an offer holds that offer's sizing back for this many looks in a row at most; then the offer is cancelled with the take, which the bot had not answered in all that time. */
const MAX_WAITS = 3;
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

// ── Offers sized from the balances (cfg.sizeFromBalances) ────────────────────
//
// The board has no call that changes an open offer's amounts: another size is a cancel and a new listing. So the bot
// lists an offer at what it holds when it lists it, and looks again every sizeEveryS seconds. An offer that then
// promises more than the bot can fill, that has less than its smallest trade left, or that differs from what the bot
// could list by one smallest trade or more, is cancelled and listed again. A sale lowers what is left of an offer and
// the balance alike, so it changes nothing here.

/** Raw units as the decimal text the kit takes for an amount ("1234.5": no separators, no trailing zeros). */
export function plainAmount(raw: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const frac = (raw % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${raw / unit}${frac ? `.${frac}` : ''}`;
}

/** `raw` rounded down to hundredths of a whole token: an amount a person can read, and never more than `raw`. */
function roundedDown(raw: bigint, decimals: number): bigint {
  const step = 10n ** BigInt(Math.max(0, decimals - 2));
  return raw - (raw % step);
}

/**
 * A config entry at another total (raw units, at most the entry's own): its
 * largest trade, and a following offer's amount per day, are lowered to that
 * total when they are larger. The entry itself at its own total.
 */
export function sizedOffer(w: OfferInput, total: bigint): OfferInput {
  const raw = (v: string) => tokenToRaw(w.symbol, v);
  if (total === raw(w.total)) return w;
  const as = plainAmount(total, tokenOf(w.symbol)!.decimals);
  const out: OfferInput = { ...w, total: as, max: raw(w.max) > total ? as : w.max };
  if (w.follow?.dailyMax !== undefined && raw(w.follow.dailyMax) > total) out.follow = { ...w.follow, dailyMax: as };
  return out;
}

/**
 * Whether a kept open offer is this config entry as the sizing lists it: the
 * entry at the kept offer's own total, which is at most the config's. So an
 * offer listed at 163.28 is still this entry at the next start, whatever the
 * balance is by then.
 */
export function sizedSame(k: LocalOffer, w: OfferInput, acceptOnTheirOwn: boolean): boolean {
  if (k.side !== w.side || k.symbol !== w.symbol) return false;
  const total = BigInt(k.tazTotal);
  return total <= tokenToRaw(w.symbol, w.total) && sameOffer(k, sizedOffer(w, total), acceptOnTheirOwn);
}

/** Why the kit's own checks would refuse to list this offer (check 7, and a following offer's own rules), or null. */
function listingProblem(network: Network, o: OfferInput): string | null {
  const raw = (v: string) => tokenToRaw(o.symbol, v);
  const amounts = { symbol: o.symbol, tazTotal: raw(o.total), tazMin: raw(o.min), tazMax: raw(o.max) };
  if (!o.follow) return offerCheck(network, { ...amounts, price: usdcToRaw(o.price!) })?.text ?? null;
  const follow = { offsetBps: o.follow.offsetBps, limitPrice: usdcToRaw(o.follow.limitPrice), dailyMax: raw(o.follow.dailyMax ?? o.total) };
  return followOfferProblem({ ...amounts, side: o.side, follow }, P2P_CONFIG[network].base, FOLLOW_TAKE_USD_MAX[network]);
}

/** What a sizing knows of the open listing of one config entry. */
export interface SizedListing {
  id: number;
  /** Raw units listed (the kept offer's total). */
  total: bigint;
  /** Raw units it can still take (the board's `remaining`); null when the board was not asked, or did not answer. */
  left: bigint | null;
  /** 'take': a take on it waits for its answer, and a cancel would cancel that take. 'paused': the board has paused it (a following offer it cannot price now). */
  hold: 'take' | 'paused' | null;
}

/**
 * What a sizing does with one config entry (planSizes). `more`: raw units
 * the bot could list for this entry were its `total` not the limit (set when
 * that is at least one smallest trade above the total).
 */
export type SizeStep =
  /** Listed, and left as it is; `why` when the bot would have listed it again but does not. */
  | { do: 'keep'; why?: string; more?: bigint }
  /** Not listed: list this. */
  | { do: 'list'; offer: OfferInput; more?: bigint }
  /** Cancel offer `id`, which has `left` left, then list this. */
  | { do: 'relist'; id: number; left: bigint; offer: OfferInput; more?: bigint }
  /** Cancel offer `id`: the bot cannot fill its smallest trade now. */
  | { do: 'unlist'; id: number; left: bigint; why: string }
  /** A take waits on offer `id`: decided at the next sync. */
  | { do: 'wait'; id: number }
  /** Not listed, and nothing to list now. */
  | { do: 'none'; why: string };

export interface SizeInput {
  network: Network;
  /** The config's offers, in its order. */
  offers: readonly OfferInput[];
  /** The config's recurring orders: one order of each is held back from the balance it spends. */
  take: readonly TakeOrder[];
  /** Per entry of `offers`: its open listing, or null. */
  listed: ReadonlyArray<SizedListing | null>;
  /** Per entry of `offers`: whether its listing may be replaced now (the timed look, or a look at that entry). An entry without a listing is listed either way. */
  look: readonly boolean[];
  /** The bot's liquid Phantasma balances; null when they could not be read. */
  pha: PhaBalances | null;
  /** The bot's raw USDC and its wei on Base; null when they could not be read. */
  base: { usdc: bigint; eth: bigint } | null;
  /** The bot's own trades (the store's), for what the running ones still need from the balances. */
  trades: readonly LocalTrade[];
  /** The bot's kept offers, open and closed (the trades of an instant offer count differently). */
  kept: readonly LocalOffer[];
  address: { pha: string; base: string };
  holdBack: Readonly<Record<string, string>>;
  /** The network's name for its USDC, for the reasons. */
  usdcSymbol: string;
}

export interface SizePlan {
  /** One step per entry of `offers`, in its order. */
  steps: SizeStep[];
  /** Every balance and every listing a look needed was known (a listing that waits for a take is a step of its own). */
  complete: boolean;
}

/**
 * What to list from the balances. Sell offers of one token share that
 * token's balance, and every buy offer shares the USDC: within such a group
 * the config's order decides, the first entry taking what it asks for and
 * the next what is left.
 *
 * What the bot can fill is what an accept would let it (Engine.#sellerFunds,
 * checks.buyerReady) and its lock would need: a token's liquid balance
 * without the KCAL or SOUL its lock needs on top, only while the address
 * keeps the SOUL every seller needs and the KCAL of a lock's gas; the USDC
 * on Base, only while the bot holds the KCAL a buyer keeps for its claim and
 * some ETH for its lock's gas. Each without what the bot's own trades that
 * are not locked yet still take, and without one order of each recurring
 * order that spends the same balance. `keep` holds more back.
 */
export function planSizes(x: SizeInput): SizePlan {
  const net = P2P_CONFIG[x.network];
  const pos = (v: bigint) => (v > 0n ? v : 0n);
  const instant = new Set(x.kept.filter((k) => k.mode === 'instant').map((k) => k.id));
  const myBase = x.address.base.toLowerCase();
  // As Engine.sellerCommitted, and counting a take still waiting for the bot's own answer too: the tokens of the bot's
  // trades as the seller that are not locked yet (an instant trade's until its lock reads as its own).
  const owedTokens = (symbol: string): bigint => {
    let sum = 0n;
    for (const r of x.trades) {
      if (r.role !== 'S' || r.symbol !== symbol || r.myPha !== x.address.pha || r.endedAt) continue;
      if (r.h && !(r.maker && instant.has(r.offerId) && r.t1 === undefined)) continue;
      if (r.status === undefined || r.status === 'requested' || r.status === 'accepted' || r.status === 'base_locked') sum += BigInt(r.taz);
    }
    return sum;
  };
  // As checks.waitingUsdc, counting a take still waiting for the bot's own answer too, and a trade whose USDC lock was
  // sent but is not reported yet: its USDC may still be in the balance (then counted twice for a moment, never not at all).
  const owedUsdc = (): bigint => {
    let sum = 0n;
    for (const r of x.trades) {
      if (r.role !== 'B' || r.myBase !== myBase || r.endedAt) continue;
      if (r.status === undefined || r.status === 'requested' || r.status === 'accepted' || r.status === 'pha_locked') sum += BigInt(r.usdc);
    }
    return sum;
  };
  /** What a group of offers can still draw on: `hard` is all the bot could fill, `soft` that without `holdBack`; `have` is the balance itself. */
  interface Pool { hard: bigint; soft: bigint; have: bigint; short: string | null }
  const none = (short: string): Pool => ({ hard: 0n, soft: 0n, have: 0n, short });
  /** The config's `holdBack` of a token, or of the USDC, in raw units. */
  const heldBack = (key: string): bigint => {
    const v = x.holdBack[key];
    if (v === undefined || /^0+(\.0+)?$/.test(v)) return 0n;
    return key === HOLD_USDC ? usdcToRaw(v) : tokenToRaw(key, v);
  };
  const pools = new Map<string, Pool | null>();
  const poolOf = (w: OfferInput): Pool | null => {
    const key = w.side === 'sell' ? `sell ${w.symbol}` : 'buy';
    if (pools.has(key)) return pools.get(key)!;
    let p: Pool | null = null;
    const kcal = balanceOf(x.pha, 'KCAL') ?? 0n;
    const kcalText = (raw: bigint) => `${amountText(raw, tokenOf('KCAL')!.decimals)} KCAL`;
    if (w.side === 'sell' && x.pha) {
      const soul = balanceOf(x.pha, 'SOUL') ?? 0n;
      if (soul < SOUL_RESERVE) {
        p = none(`this bot's Phantasma address keeps ${amountText(soul, 8)} SOUL free, less than the ${amountText(SOUL_RESERVE, 8)} SOUL every seller needs for Phantasma's fees`);
      } else if (kcal < PHA_LOCK_KCAL) {
        p = none(`this bot's Phantasma address holds ${kcalText(kcal)}, less than the ${kcalText(PHA_LOCK_KCAL)} a lock's gas may take`);
      } else {
        const orders = x.take.filter((o) => o.side === 'sell' && o.symbol === w.symbol).reduce((sum, o) => sum + tokenToRaw(o.symbol, o.amount), 0n);
        const have = balanceOf(x.pha, w.symbol) ?? 0n;
        const hard = pos(have - sellerNeeds(net, w.symbol, 0n) - owedTokens(w.symbol) - orders);
        p = { hard, soft: pos(hard - heldBack(w.symbol)), have, short: null };
      }
    } else if (w.side === 'buy' && x.base && x.pha) {
      if (kcal < net.phaClaimKcal) {
        p = none(`this bot's Phantasma address holds ${kcalText(kcal)}, less than the ${kcalText(net.phaClaimKcal)} a buyer keeps to claim its tokens`);
      } else if (x.base.eth <= 0n) {
        p = none('this bot\'s Base address holds no ETH for the gas of its USDC lock');
      } else {
        const orders = x.take.filter((o) => o.side === 'buy').reduce((sum, o) => sum + usdcFor(tokenToRaw(o.symbol, o.amount), usdcToRaw(o.limit), o.symbol), 0n);
        const hard = pos(x.base.usdc - owedUsdc() - orders);
        p = { hard, soft: pos(hard - heldBack(HOLD_USDC)), have: x.base.usdc, short: null };
      }
    }
    pools.set(key, p);
    return p;
  };

  // A buy offer draws on the USDC at its price; one that follows the reference price at its limit, the most it pays.
  const priceOf = (w: OfferInput): bigint | null => (w.side === 'buy' ? usdcToRaw(w.price ?? w.follow!.limitPrice) : null);
  /** What `tokens` of an entry take from its group: tokens of a sell, the USDC of a buy. */
  const takesOf = (w: OfferInput, tokens: bigint): bigint => {
    const price = priceOf(w);
    return price === null ? tokens : usdcFor(tokens, price, w.symbol);
  };
  const useOf = (pool: Pool, amount: bigint): void => {
    pool.hard = pos(pool.hard - amount);
    pool.soft = pos(pool.soft - amount);
  };
  // A listing that is not looked at now stays as it is, wherever its entry stands in the config: what it can still
  // take (its total, when the board was not asked) is set aside before anything else is sized.
  x.offers.forEach((w, i) => {
    const listing = x.listed[i] ?? null;
    const pool = listing && x.look[i] !== true ? poolOf(w) : null;
    if (listing && pool) useOf(pool, takesOf(w, listing.left ?? listing.total));
  });

  const steps: SizeStep[] = [];
  let complete = true;
  x.offers.forEach((w, i) => {
    const t = tokenOf(w.symbol)!;
    const raw = (v: string) => tokenToRaw(w.symbol, v);
    const min = raw(w.min);
    const price = priceOf(w);
    const takes = (tokens: bigint): bigint => takesOf(w, tokens);
    const listing = x.listed[i] ?? null;
    const looked = x.look[i] === true;
    const pool = poolOf(w);
    if (!pool) {
      // A balance is not known now: nothing is listed, and nothing is replaced, on a guess.
      if (looked || !listing) complete = false;
      const unread = w.side === 'sell' || !x.pha ? 'Phantasma balances' : `${x.usdcSymbol} balance`;
      steps.push(listing ? { do: 'keep' } : { do: 'none', why: `its ${unread} could not be read` });
      return;
    }
    const use = (amount: bigint): void => useOf(pool, amount);
    const room = price === null ? pool.soft : (pool.soft * 10n ** BigInt(t.decimals)) / price;
    const cap = raw(w.total);
    const most = room < cap ? room : cap;
    // Rounded down; but the smallest trade itself when the bot holds that and the rounding fell under it.
    let want = roundedDown(most, t.decimals);
    if (want < min) want = most >= min ? min : 0n;
    // The balance, and what of it is left for this entry when its other offers, its trades, its orders, a lock's
    // KCAL or SOUL, or holdBack take a part.
    const short = (): string => {
      if (pool.short) return pool.short;
      const what = w.side === 'sell' ? t.symbol : x.usdcSymbol;
      const decimals = w.side === 'sell' ? t.decimals : USDC_DECIMALS;
      const part = pool.soft === pool.have ? '' : `, of which ${amountText(pool.soft, decimals)} ${what} are free for this offer`;
      return w.side === 'sell'
        ? `this bot's Phantasma address holds ${amountText(pool.have, decimals)} ${what}${part}, less than the smallest trade (${w.min} ${what})`
        : `this bot's Base address holds ${amountText(pool.have, decimals)} ${what}${part}, less than the smallest trade needs (${amountText(takes(min), decimals)} ${what})`;
    };
    const sized = want > 0n ? sizedOffer(w, want) : null;
    // The entry's own total is what holds it under what the bot could list: said, so that a total written for an
    // earlier balance does not look like a sizing that does nothing.
    const more = most === cap && roundedDown(room, t.decimals) >= cap + min ? { more: roundedDown(room, t.decimals) } : {};
    // The kit's own checks of a listing, before anything is cancelled for it (a following offer's largest trade has a
    // cap of its own, which an offer passes while it is small and can fail once it is larger).
    const refused = sized ? listingProblem(x.network, sized) : null;
    if (!listing) {
      if (sized && !refused) {
        steps.push({ do: 'list', offer: sized, ...more });
        use(takes(want));
      } else {
        steps.push({ do: 'none', why: refused ? `the kit would refuse it at ${sized!.total} ${t.symbol} (${refused})` : short() });
      }
      return;
    }
    // Not looked at now: left as listed, and already set aside above.
    if (!looked) {
      steps.push({ do: 'keep' });
      return;
    }
    // Left as listed too: a listing the board said nothing of; one the board has paused (it could not be listed
    // again now).
    if (listing.left === null || listing.hold === 'paused') {
      if (listing.left === null) complete = false;
      steps.push({ do: 'keep' });
      use(takes(listing.left ?? listing.total));
      return;
    }
    const left = listing.left;
    const spent = left < min;
    const over = takes(left) > pool.hard;
    const apart = (want > left ? want - left : left - want) >= min;
    // A following offer with an amount per day is never listed again by the sizing: a new listing would start its
    // 24 hours again, and the day's amount with it.
    if (w.follow?.dailyMax !== undefined) {
      const why = spent || over || apart ? { why: 'it has an amount per day (dailyMax), and a new listing would start its 24 hours again; to list it again, change its entry in the config' } : {};
      steps.push({ do: 'keep', ...why });
      use(takes(left));
      return;
    }
    if (!spent && !over && !apart) {
      steps.push({ do: 'keep', ...more });
      use(takes(left));
      return;
    }
    if (listing.hold === 'take') {
      steps.push({ do: 'wait', id: listing.id });
      use(takes(left));
      return;
    }
    if (refused) {
      steps.push({ do: 'keep', why: `listed again at ${sized!.total} ${t.symbol} the kit would refuse it (${refused})` });
      use(takes(left));
    } else if (sized) {
      steps.push({ do: 'relist', id: listing.id, left, offer: sized, ...more });
      use(takes(want));
    } else {
      steps.push({ do: 'unlist', id: listing.id, left, why: short() });
    }
  });
  return { steps, complete };
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
      say(`Not starting: ${blocking.join(', ')} (above) stops the start. Nothing was sent.`);
      return 1;
    }
    return await trade(kit, cfg, { say, usdc, now, sleep, signals: o.signals ?? process });
  } finally {
    await kit.close().catch((e) => say(`The data directory could not be released cleanly (${explain(e)}).`));
  }
}

/**
 * Print the preflight; returns the names of the items that stop a start: a
 * failed item, and a token the escrow does not take on this network
 * (TOKEN_OFF, which the kit's report counts as passed) when this config
 * trades it. A failed or off escrow item of a token the config does not
 * trade stops nothing.
 */
export function printPreflight(report: PreflightReport, cfg: Pick<HostedBotConfig, 'offers' | 'take'>, say: (l: string) => void): string[] {
  say(`Addresses: Phantasma ${report.address.pha}, Base ${report.address.base}`);
  const used = new Set([...cfg.offers.map((x) => x.symbol), ...cfg.take.map((x) => x.symbol)]);
  const blocking: string[] = [];
  for (const i of report.items) {
    const off = i.code === 'TOKEN_OFF';
    say(`preflight ${off ? 'off' : i.ok ? 'ok' : 'FAIL'} ${i.name}: ${i.text}`);
    if ((i.ok && !off) || WARN_ONLY.has(i.name)) continue;
    const m = /^escrow (\S+)$/.exec(i.name);
    if (m && !used.has(m[1]!)) continue;
    blocking.push(i.name);
  }
  return blocking;
}

/** The rest of a dry run: the board's GETs and the plan. Sends nothing. */
export async function dryRunRest(kit: BotKit, cfg: Pick<HostedBotConfig, 'offers' | 'take' | 'acceptOnTheirOwn'> & Partial<Pick<HostedBotConfig, 'sizeFromBalances' | 'sizeEveryS' | 'holdBack'>>, x: { say: (l: string) => void; usdc: string; blocking: string[]; refused: () => { boardWrites: number; chainSends: number } }): Promise<number> {
  const { say, usdc } = x;
  let book: Offer[] | null = null;
  try {
    const offers = await kit.board.offers();
    book = offers;
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
  if (cfg.sizeFromBalances === true) {
    await sizedDryRun(kit, cfg, { say, usdc, book });
  } else {
    for (const w of cfg.offers) {
      const same = kept.find((k) => sameOffer(k, w, cfg.acceptOnTheirOwn));
      if (same) {
        say(`Would keep offer #${same.id} listed: ${describeOffer(w, usdc)}.`);
        continue;
      }
      const short = await fundsShort(kit, w, usdc);
      say(short ? `Would not list ${describeOffer(w, usdc)} yet: ${short}.` : `Would list: ${describeOffer(w, usdc)}.`);
    }
  }
  for (const t of cfg.take) {
    say(`Would ${t.side} up to ${t.amount} ${t.symbol} every ${t.everyS} s, at ${t.side === 'buy' ? 'most' : 'least'} ${t.limit} ${usdc} per ${t.symbol}.`);
  }
  const r = x.refused();
  say(`Dry run done: nothing was sent (board writes refused: ${r.boardWrites}, chain sends refused: ${r.chainSends}).`);
  if (x.blocking.length) say(`A real start would stop here: ${x.blocking.join(', ')} (above).`);
  return x.blocking.length ? 1 : 0;
}

/** The option in words, for a start, a dry run and check-config: what is listed, how often the bot looks, what it holds back. */
export function sizingWords(cfg: Partial<Pick<HostedBotConfig, 'sizeEveryS' | 'holdBack'>>, usdc = 'USDC'): string {
  const held = Object.entries(cfg.holdBack ?? {}).filter(([, v]) => !/^0+(\.0+)?$/.test(v)).map(([k, v]) => `${v} ${k === HOLD_USDC ? usdc : k}`);
  return `Sizes its offers from the balances, looking every ${cfg.sizeEveryS ?? SIZE_EVERY_S} s: each offer lists what the bot holds (a buy offer: what its ${usdc} covers), at most its total${held.length ? `; it holds back ${held.join(', ')}` : ''}`;
}

/** The words after a sized offer that lists less than its config entry allows. */
const underTotal = (w: OfferInput, sized: OfferInput, usdc: string): string => (sized === w ? '' : ` (${w.side === 'sell' ? 'what the bot holds' : `what its ${usdc} covers`}; the config allows up to ${w.total} ${w.symbol})`);

/** The kept open offer of each config entry as the sizing matches them (sizedSame), and the open offers no entry lists. */
function sizedMatch(open: readonly LocalOffer[], cfg: Pick<HostedBotConfig, 'offers' | 'acceptOnTheirOwn'>): { mine: Array<LocalOffer | null>; others: LocalOffer[] } {
  const used = new Set<number>();
  const mine = cfg.offers.map((w) => {
    const k = open.find((o) => !used.has(o.id) && sizedSame(o, w, cfg.acceptOnTheirOwn)) ?? null;
    if (k) used.add(k.id);
    return k;
  });
  return { mine, others: open.filter((k) => !used.has(k.id)) };
}

/**
 * A dry run's offers with sizeFromBalances: what a look at the balances would
 * do now. It reads the balances and the board's public list only (a
 * heartbeat is a write, which a dry run never sends), so it knows what is
 * left of an offer only while the board lists it.
 */
async function sizedDryRun(kit: BotKit, cfg: Pick<HostedBotConfig, 'offers' | 'take' | 'acceptOnTheirOwn'> & Partial<Pick<HostedBotConfig, 'sizeEveryS' | 'holdBack'>>, x: { say: (l: string) => void; usdc: string; book: readonly Offer[] | null }): Promise<void> {
  const { say, usdc } = x;
  say(`${sizingWords(cfg, usdc)}.`);
  const all = await kit.store.listOffers();
  const { mine, others } = sizedMatch(all.filter((k) => k.closedAt == null), cfg);
  for (const k of others) say(`Would cancel offer #${k.id}: the config no longer lists it.`);
  const trades = await kit.store.listTrades();
  const pha = cfg.offers.length ? await kit.pha.balances(kit.address.pha).catch(() => null) : null;
  const base = cfg.offers.some((w) => w.side === 'buy') ? await kit.base.readFunds(kit.address.base).catch(() => null) : null;
  const listed = mine.map((k): SizedListing | null => {
    if (!k) return null;
    const shown = x.book?.find((o) => o.id === k.id);
    return { id: k.id, total: BigInt(k.tazTotal), left: shown ? BigInt(shown.remaining) : null, hold: null };
  });
  const plan = planSizes({ network: kit.network, offers: cfg.offers, take: cfg.take, listed, look: cfg.offers.map(() => true), pha, base, trades, kept: all, address: kit.address, holdBack: cfg.holdBack ?? {}, usdcSymbol: usdc });
  plan.steps.forEach((step, i) => {
    const w = cfg.offers[i]!;
    const k = mine[i];
    const t = tokenOf(w.symbol)!;
    if (step.do === 'list') say(`Would list: ${describeOffer(step.offer, usdc)}${underTotal(w, step.offer, usdc)}.`);
    else if (step.do === 'relist') say(`Would cancel offer #${step.id}, which has ${units(step.left, t.decimals)} ${t.symbol} left, and list it again at ${w.side === 'sell' ? 'what the bot holds' : `what its ${usdc} covers`}: ${describeOffer(step.offer, usdc)}${underTotal(w, step.offer, usdc)}.`);
    else if (step.do === 'unlist') say(`Would cancel offer #${step.id}: ${step.why}.`);
    else if (step.do === 'none') say(`Would not list ${describeOffer(w, usdc)} yet: ${step.why}.`);
    else if (k) say(`Would keep offer #${k.id} listed: ${describeOffer(sizedOffer(w, BigInt(k.tazTotal)), usdc)}${step.do === 'keep' && step.why ? ` (${step.why})` : ''}.`);
  });
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

/**
 * For a host that runs the bot in sessions rather than as one long process:
 * a Cloudflare Durable Object, whose alarms run for minutes at a time
 * (cloudflare/). Each session builds the kit, runs trade() until `until`
 * aborts, and closes the kit; the next session carries on from the store.
 */
export interface TradeSession {
  /**
   * Aborting it ends the session at once, as a second Ctrl-C ends a run, but
   * as a pause: nothing is cancelled, the offers stay listed (the next
   * session's heartbeats come well inside their 90 s), and every trade stays
   * in the store for the next session. trade() then returns SESSION_PAUSED.
   */
  readonly until: AbortSignal;
  /** The bot was told to stop before this session: it cancels its offers and finishes its trades, as after a first Ctrl-C. */
  readonly stopping?: boolean;
  /** When each recurring order (cfg.take[i]) is next due, kept by the host across sessions: read at the start, written after each order. */
  readonly takeDue?: { load(): number[] | Promise<number[]>; save(due: readonly number[]): void | Promise<void> };
  /**
   * When the offers were last sized from the balances (cfg.sizeFromBalances;
   * ms, or null for never), kept by the host across sessions: read at the
   * start, written after each timed look with that look's sentence (for the
   * host's status). Without it every session would size its offers at its
   * start.
   */
  readonly sized?: { load(): number | null | Promise<number | null>; save(at: number, said?: string): void | Promise<void> };
}

/** What trade() returns when its session ended (TradeSession.until): nothing was stopped, and the next session carries on. */
export const SESSION_PAUSED = 75;

export interface TradeOptions {
  /** Receives the bot's lines (redacted). */
  say: (l: string) => void;
  /** The USDC symbol of the network, for lines. */
  usdc: string;
  now: () => number;
  sleep: SleepFn;
  /** The first SIGINT or SIGTERM stops gracefully (offers cancelled, trades finished); a second one ends at once. */
  signals: SignalSource;
  /** Run as one session of a host (TradeSession) rather than until a Ctrl-C. */
  session?: TradeSession;
}

/**
 * The trading part of a run, until a Ctrl-C (see the file comment), or for
 * one session of a host (TradeOptions.session). Returns 0 once a stop has
 * finished every trade, 1 when run() stopped on a failure, 130 after a
 * second Ctrl-C, and SESSION_PAUSED when the session's `until` ended it.
 */
export async function trade(kit: BotKit, cfg: HostedBotConfig, x: TradeOptions): Promise<number> {
  const { say, usdc, now, sleep, signals, session } = x;
  const notes = new Map<string, string>();
  const note = (key: string, line: string) => {
    if (notes.get(key) === line) return;
    notes.set(key, line);
    say(line);
  };
  const runCtl = new AbortController();
  let stopping = session?.stopping === true;
  let forced = false;
  let paused = false;
  let finished = false;
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
      say(session
        ? 'Stopping: no new offers or takes. The bot cancels its offers and finishes its running trades, then stops (its state is kept).'
        : 'Stopping: no new offers or takes. The bot cancels its offers and finishes its running trades, then exits. Press Ctrl-C again to exit now (its state is kept; the next start resumes the trades).');
    } else {
      forced = true;
      say('Exiting now. The bot\'s state is kept: run it again to resume its trades.');
      runCtl.abort();
    }
    wakeUp();
  };
  signals.on('SIGINT', onSignal);
  signals.on('SIGTERM', onSignal);
  // A host's session ends at `until`: a pause, not a stop (nothing is cancelled; the next session carries on).
  const onUntil = () => {
    if (finished) return;
    paused = true;
    runCtl.abort();
    wakeUp();
  };
  if (session?.until.aborted) onUntil();
  else session?.until.addEventListener('abort', onUntil, { once: true });

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

  // ── Offers sized from the balances (cfg.sizeFromBalances) ───────────────────
  const sizing = cfg.sizeFromBalances === true;
  const sizeEveryMs = (cfg.sizeEveryS ?? SIZE_EVERY_S) * 1000;
  /** A look that left something undecided is made again after this long, not after the whole sizeEveryS. */
  const sizeAgainMs = Math.min(SHORT_AGAIN_MS, sizeEveryMs);
  /** The time the next look is counted from (ms; what the host keeps): null, never looked, so the first sync looks. */
  let sizedAt: number | null = null;
  /** When this session last looked at every offer, and whether that look left something undecided other than a waiting take. */
  let lookedAt: number | null = null;
  let loose = false;
  /** The entries a take waited on: looked at again at each sync, until decided; and how many looks in a row each has waited. */
  let again = new Set<number>();
  const waited = new Map<number, number>();
  /** Per kept offer: what its own trades had taken when the bot last looked at it for being used up. */
  const usedUp = new Map<number, bigint>();
  /** Per entry: until when it is not listed, after a listing whose answer from the board was lost. */
  const settling = new Map<number, number>();
  /** The entries that had no listing and nothing to list at the last look, and until when they are not read again. */
  let shortOf = '';
  let shortUntil = 0;

  /**
   * The sync with sizeFromBalances. Every time: an offer no entry lists is
   * cancelled, and an entry without a listing is listed at what the bot
   * holds. When the timed look is due as well: every listing is compared
   * with the balances and, where planSizes says so, cancelled and listed
   * again. An offer whose own trades have used it up is looked at without
   * waiting for the timed look, and so is one a take waited on.
   *
   * A look compares what is listed with what the bot holds, so making it
   * twice changes nothing the second time: a session cut in the middle only
   * makes it again.
   */
  const syncSized = async (): Promise<void> => {
    const halted = (): boolean => stopping || runCtl.signal.aborted;
    const all = await kit.store.listOffers();
    const { mine, others } = sizedMatch(all.filter((k) => k.closedAt == null), cfg);
    // An offer no entry lists goes first: what it promised is then free for the entries.
    for (const k of others) {
      if (halted()) return;
      try {
        await kit.cancelOffer(k.id);
        say(`Offer #${k.id} cancelled: the config no longer lists it.`);
      } catch (e) {
        note(`cancel:${k.id}`, `Offer #${k.id}, which the config no longer lists, could not be cancelled yet (${explain(e)}).`);
      }
    }
    if (cfg.offers.length === 0) return;
    // The trades first, then the balances: a lock that lands in between is counted twice (still owed, and gone from
    // the balance), never not at all.
    const trades = await kit.store.listTrades();
    const known = new Set(trades.map((t) => t.id));
    const full = sizedAt === null || now() >= sizedAt + sizeEveryMs || now() < sizedAt;
    // What each listing's own trades have taken from it, as the board counts it: a take is given back only when it was
    // never accepted. Under one smallest trade left, the board no longer shows the offer.
    const taken = mine.map((k) => (k ? trades.reduce((sum, r) => {
      const givenBack = r.status === 'cancelled' || (r.endedAt !== undefined && (r.status === undefined || r.status === 'requested'));
      return r.maker && r.offerId === k.id && !givenBack ? sum + BigInt(r.taz) : sum;
    }, 0n) : 0n));
    const look = cfg.offers.map((w, i) => {
      const k = mine[i];
      if (!k) return false;
      if (full || again.has(i)) return true;
      return w.follow?.dailyMax === undefined && BigInt(k.tazTotal) - taken[i]! < tokenToRaw(w.symbol, w.min) && usedUp.get(k.id) !== taken[i];
    });
    const unlisted = cfg.offers.map((_, i) => !mine[i] && now() >= (settling.get(i) ?? 0));
    const missing = unlisted.map((u, i) => (u ? String(i) : '')).join(',');
    if (!look.some(Boolean) && (!unlisted.some(Boolean) || (missing === shortOf && now() < shortUntil))) return;
    if (halted()) return;
    const groupOf = (w: OfferInput): string => (w.side === 'sell' ? `sell ${w.symbol}` : 'buy');
    const active = new Set(cfg.offers.filter((_, i) => look[i] || unlisted[i]).map(groupOf));
    let pha: PhaBalances | null = null;
    let base: { usdc: bigint; eth: bigint } | null = null;
    try {
      pha = await kit.pha.balances(kit.address.pha);
      notes.delete('size:pha');
    } catch (e) {
      note('size:pha', `The bot's Phantasma balances could not be read (${explain(e)}): its offers stay as they are, and it looks again later.`);
    }
    if (pha && active.has('buy')) {
      try {
        base = await kit.base.readFunds(kit.address.base);
        notes.delete('size:base');
      } catch (e) {
        note('size:base', `The bot's ${usdc} balance could not be read (${explain(e)}): its buy offers stay as they are, and it looks again later.`);
      }
    }
    /** What the board says of one of the bot's listings now: 'gone' when it is no longer open there, null when it did not say. */
    const heard = async (k: LocalOffer): Promise<{ left: bigint; taking: boolean; paused: boolean } | 'gone' | null> => {
      try {
        const a = await kit.board.heartbeat(k.id, k.makerToken, { retries: 1, maxRetryAfter: 10 });
        notes.delete(`size:left:${k.id}`);
        if (a.offer.status !== 'open') return 'gone';
        // A take that waits for its answer, or one the bot has not kept yet: a cancel now would cancel it.
        return { left: BigInt(a.offer.remaining), taking: a.trades.some((t) => t.status === 'requested' || !known.has(t.id)), paused: a.offer.follow?.state === 'paused' };
      } catch (e) {
        if (e instanceof BoardError && e.code === 'CLOSED') return 'gone';
        note(`size:left:${k.id}`, `The board did not say what is left of offer #${k.id} (${explain(e)}): it stays as it is, and the bot looks again later.`);
        return null;
      }
    };
    /** Whether a take that waits on entry `i` still holds its sizing back (MAX_WAITS looks in a row at most). */
    const patient = (i: number): boolean => (waited.get(i) ?? 0) < MAX_WAITS;
    // The board last, right before deciding: what is left of each listing that shares a balance with an entry to
    // decide, and whether a take waits on it.
    const listed: Array<SizedListing | null> = [];
    for (const [i, k] of mine.entries()) {
      if (!k) {
        listed.push(null);
        continue;
      }
      const w = cfg.offers[i]!;
      const read = w.side === 'sell' ? pha !== null : base !== null;
      const said = active.has(groupOf(w)) && read && !halted() ? await heard(k) : null;
      if (said === 'gone') {
        // Closed on the board (filled, or cancelled where the bot's record missed it): recorded, and its entry is
        // listed afresh in this same sync.
        try {
          await kit.cancelOffer(k.id);
          say(`Offer #${k.id} is closed on the board: the bot lists its entry afresh.`);
          mine[i] = null;
          listed.push(null);
          continue;
        } catch (e) {
          note(`cancel:${k.id}`, `Offer #${k.id}, which the board has closed, could not be recorded as closed yet (${explain(e)}).`);
        }
      }
      const facts = said && said !== 'gone' ? said : null;
      listed.push({ id: k.id, total: BigInt(k.tazTotal), left: facts?.left ?? null, hold: facts?.taking && patient(i) ? 'take' : facts?.paused ? 'paused' : null });
    }
    if (halted()) return;
    const plan = planSizes({ network: cfg.network, offers: cfg.offers, take: cfg.take, listed, look, pha, base, trades, kept: all, address: kit.address, holdBack: cfg.holdBack ?? {}, usdcSymbol: usdc });
    let undecided = !plan.complete;
    let refusedNow = false;
    let onlyShort = true;
    const waits = new Set<number>();
    const did = { listed: 0, again: 0, cancelled: 0, same: 0 };
    const atTotal: string[] = [];
    for (const [i, step] of plan.steps.entries()) {
      const w = cfg.offers[i]!;
      const t = tokenOf(w.symbol)!;
      const k = mine[i];
      const key = `post:${i}:${describeOffer(w)}`;
      if (halted()) return;
      if ('more' in step && step.more !== undefined) atTotal.push(`${w.side} ${w.symbol} (its total is ${w.total} ${w.symbol}; ${w.side === 'sell' ? 'the bot holds' : `its ${usdc} covers`} ${units(step.more, t.decimals)} ${w.symbol})`);
      if (step.do === 'keep') {
        did.same++;
        if (look[i] && k) usedUp.set(k.id, taken[i]!);
        if (step.why && k) note(key, `Offer #${k.id} stays as it is: ${step.why}.`);
        else notes.delete(key);
        continue;
      }
      if (step.do === 'none') {
        if (w.side === 'sell' ? pha === null : base === null) onlyShort = false;
        note(key, `Not listing ${describeOffer(w, usdc)} now: ${step.why}.`);
        continue;
      }
      if (step.do === 'wait') {
        waits.add(i);
        note(`size:wait:${step.id}`, `Offer #${step.id} is not sized now: a take on it waits for its answer, and a cancel would cancel that take. The bot looks again at the next sync.`);
        continue;
      }
      // After a cancel or a listing the board refused, nothing more is cancelled or listed in this look: what is
      // listed stays listed.
      if (refusedNow) {
        undecided = true;
        onlyShort = false;
        continue;
      }
      if (step.do === 'unlist' || step.do === 'relist') {
        // The board once more, right before the cancel, with nothing sent in between: a take that came in since the
        // plan was made would be cancelled with the offer.
        const said = await heard(k!);
        if (!said) {
          undecided = true;
          continue;
        }
        if (said === 'gone' || (said.taking && patient(i)) || said.left !== step.left) {
          waits.add(i);
          continue;
        }
        if (halted()) return;
        try {
          await kit.cancelOffer(step.id);
          notes.delete(`size:wait:${step.id}`);
          say(step.do === 'unlist'
            ? `Offer #${step.id} cancelled: ${step.why}.`
            : `Offer #${step.id} cancelled to list it again at ${w.side === 'sell' ? 'what the bot holds' : `what its ${usdc} covers`} (it had ${units(step.left, t.decimals)} ${t.symbol} left).`);
        } catch (e) {
          refusedNow = true;
          undecided = true;
          note(`cancel:${step.id}`, `Offer #${step.id} could not be cancelled yet to size it (${explain(e)}); the bot looks again later.`);
          continue;
        }
        if (step.do === 'unlist') {
          did.cancelled++;
          continue;
        }
        // The bot stops, or its session ended, between the two: the next sync or session lists it.
        if (halted()) return;
      }
      try {
        const rec = await kit.postOffer({ ...step.offer, acceptOnTheirOwn: cfg.acceptOnTheirOwn });
        notes.delete(key);
        if (step.do === 'relist') did.again++;
        else did.listed++;
        say(`Listed offer #${rec.id}: ${describeOffer(step.offer, usdc)}${underTotal(w, step.offer, usdc)}.`);
      } catch (e) {
        // It is listed at a later sync, as any entry without a listing; the look itself goes on without it.
        refusedNow = true;
        onlyShort = false;
        if (e instanceof CreateError && e.mayExist) settling.set(i, now() + SETTLE_MS);
        note(key, `Could not list ${describeOffer(step.offer, usdc)}: ${explain(e)}`);
      }
    }
    for (const i of cfg.offers.keys()) {
      if (waits.has(i)) waited.set(i, (waited.get(i) ?? 0) + 1);
      else if (look[i]) waited.delete(i);
    }
    const none = plan.steps.map((step, i) => (step.do === 'none' ? String(i) : '')).join(',');
    shortOf = onlyShort && plan.steps.some((step) => step.do === 'none') ? none : '';
    shortUntil = shortOf ? now() + SHORT_AGAIN_MS : 0;
    if (full) {
      lookedAt = now();
      loose = undecided;
      again = waits;
      const open = undecided || waits.size > 0;
      // Something undecided: the next look comes after sizeAgainMs, not after the whole sizeEveryS.
      sizedAt = open ? lookedAt - (sizeEveryMs - sizeAgainMs) : lookedAt;
      const parts = [
        did.again ? `${did.again} listed again` : '', did.listed ? `${did.listed} listed` : '', did.cancelled ? `${did.cancelled} cancelled` : '',
        did.same ? `${did.same} left as listed` : '', waits.size ? `${waits.size} waiting for a take's answer` : ''
      ].filter(Boolean);
      const limited = atTotal.length ? ` The config's total is the limit for: ${atTotal.join('; ')}. Raise total and max there to list more.` : '';
      const line = `Sized the offers from the balances: ${parts.join(', ') || 'nothing to list now'}.${limited} The next look is in ${(open ? sizeAgainMs : sizeEveryMs) / 1000} s${open ? ' (not every offer could be decided now)' : ''}.`;
      await session?.sized?.save(sizedAt, line);
      say(line);
      return;
    }
    const had = again.size > 0;
    again = undecided ? new Set([...again, ...waits]) : waits;
    // Every offer a take had waited on is decided now: the next look is a whole sizeEveryS after the last one.
    if (had && again.size === 0 && !loose && lookedAt !== null && sizedAt !== lookedAt) {
      sizedAt = lookedAt;
      const line = `Every offer is sized now. The next look is in ${Math.max(0, Math.round((lookedAt + sizeEveryMs - now()) / 1000))} s.`;
      await session?.sized?.save(sizedAt, line);
      say(line);
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
    // As section 6.7 orders it: the offers first, then run(). With sizeFromBalances the first sync comes right after
    // run() has started instead: a look reads both chains and asks the board about every offer, and the trades that
    // are running, with their takes to answer and their locks to send, do not wait behind that.
    const sync = sizing ? syncSized : syncOffers;
    if (sizing) {
      const at = session?.sized ? await session.sized.load() : null;
      sizedAt = typeof at === 'number' && Number.isFinite(at) ? at : null;
      if (!session && !stopping) say(`${sizingWords(cfg, usdc)}.`);
    } else {
      await sync();
    }
    running = kit.run(botPolicy(cfg, () => stopping), runCtl.signal).catch((e) => { failure = e; }).finally(() => {
      runCtl.abort();
      wakeUp();
    });
    let nextSync = sizing ? now() : now() + SYNC_EVERY_MS;
    let nextNote = 0;
    let cancelled = false;
    // When each order is next due: kept by a host across its sessions, so a session's start does not take early.
    const keptDue = session?.takeDue ? await session.takeDue.load() : [];
    const due = cfg.take.map((_, i) => (Number.isFinite(keptDue[i]) ? keptDue[i]! : now()));
    while (!runCtl.signal.aborted) {
      if (stopping) {
        if (!cancelled) cancelled = await cancelAll();
        const open = (await kit.store.listTrades()).filter((t) => !t.endedAt);
        if (cancelled && open.length === 0) {
          finished = true;
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
          await sync();
          nextSync = now() + SYNC_EVERY_MS;
        }
        for (let i = 0; i < cfg.take.length && !stopping && !runCtl.signal.aborted; i++) {
          if (now() < due[i]!) continue;
          // A host's session can be cut at any moment (a deploy, an eviction): the order's next time is kept before
          // the order goes out, so that a cut never sends one order twice.
          if (session?.takeDue) {
            due[i] = now() + cfg.take[i]!.everyS * 1000;
            await session.takeDue.save(due);
          }
          await runTake(cfg.take[i]!, i);
          due[i] = now() + cfg.take[i]!.everyS * 1000;
          await session?.takeDue?.save(due);
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
    session?.until.removeEventListener('abort', onUntil);
    // run() returns once its signal aborts; the kit is closed only after that.
    if (!runCtl.signal.aborted) runCtl.abort();
    if (running) await running;
  }
  if (failure) {
    say(`The bot stopped: ${explain(failure)}`);
    return 1;
  }
  if (forced) return 130;
  return paused && !finished ? SESSION_PAUSED : 0;
}

/** Run a role's bot as the process's main script, and exit with its code. */
/** What guardProcess needs of a process: the real one, or a test's. */
export interface GuardableProcess {
  readonly pid: number;
  readonly stdin: { readonly isTTY?: boolean };
  readonly stdout: { on(event: 'error', fn: (e: Error) => void): unknown };
  readonly stderr: { on(event: 'error', fn: (e: Error) => void): unknown };
  on(event: 'SIGHUP', fn: () => void): unknown;
  kill(pid: number, signal: 'SIGTERM'): unknown;
}

/**
 * Before a bot starts (mainOf): a lost output or a hangup never cuts its
 * clean stop short.
 * - Its lines are best effort. A log pipe that closed (EPIPE: `| tee`, which
 *   the same Ctrl-C ends) or a terminal that is gone (EIO) no longer throws
 *   out of a stop that is cancelling offers and finishing trades.
 * - A hangup (the terminal closed, an SSH connection dropped) no longer kills
 *   it mid-trade; Node undoes the ignored SIGHUP that nohup leaves. With no
 *   terminal on its input (a service, `</dev/null`), nobody reads that
 *   terminal and the bot carries on. With one, the person's terminal is
 *   gone, and the bot stops cleanly, as on Ctrl-C (SIGTERM, which the runner
 *   handles).
 */
export function guardProcess(p: GuardableProcess = process): void {
  const lost = (e: Error): void => {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EPIPE' && code !== 'EIO') throw e;
  };
  p.stdout.on('error', lost);
  p.stderr.on('error', lost);
  const attended = p.stdin.isTTY === true;
  // The kernel and the shell each send their own SIGHUP when a terminal closes: one hangup, one clean stop (a second
  // SIGTERM half a second later would be a second Ctrl-C, which exits at once).
  let hungUp = false;
  p.on('SIGHUP', () => {
    if (!attended || hungUp) return;
    hungUp = true;
    p.kill(p.pid, 'SIGTERM');
  });
}

export async function mainOf(role: Role): Promise<void> {
  guardProcess();
  const code = await runBot({ role });
  process.exitCode = code;
  // Exit even when a transport keeps a socket open after the kit closed.
  setTimeout(() => process.exit(code), 2_000).unref();
}

if (isMain(import.meta.url)) await mainOf('seller');
