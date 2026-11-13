/**
 * The Saturn P2P bot kit (build spec section 6.3): run your own maker or
 * taker bot against the public P2P board, with your own keys on your own
 * machine. Saturn never holds a key: the kit signs locally, and only after
 * every check of section 6.4 passes.
 *
 *   const kit = await createKit({ network: 'devnet', phaKeyFile, baseKeyFile, dataDir: './data/mybot' });
 *   const report = await kit.preflight();
 *   // A token the escrow does not take here yet passes the report (item code TOKEN_OFF): stop when it is yours.
 *   if (!report.ok || report.items.some((i) => i.code === 'TOKEN_OFF' && i.name === 'escrow TAZ')) process.exit(1);
 *   // run() keeps the store's open offers listed across restarts: post an offer once, not at every start.
 *   if (!(await kit.store.listOffers()).some((o) => o.closedAt == null)) {
 *     await kit.postOffer({ side: 'sell', symbol: 'TAZ', total: '30', min: '1', max: '5', price: '1.08' });
 *   }
 *   await kit.run({ acceptAfterS: 15 }, abortSignal);
 *
 * README.md ("Write your own bot") has the full sample, with a clean stop.
 *
 * Instant offers (build spec section 3.10): postOffer({ ..., side: 'sell',
 * mode: 'instant' }) lists a sell offer whose buyer locks the USDC first;
 * run() then locks the bot's tokens only after checking that lock on chain,
 * and claims the USDC only once the buyer's claim on Phantasma has made its
 * code public (flows/instant.ts). Devnet only in this release, and only with
 * an API key the owner flagged instant.
 *
 * createKit refuses before it reads anything when the network is not open in
 * this release (networkProblem), or an RPC is off the network's allowlist
 * (check 67); then it reads the board's /config (display only: its keeper
 * addresses may only add a key refusal, check 68), loads the two key files
 * (mode 0600, never from argv), checks that the Base RPC serves the pinned
 * chain, and opens the crash-safe store (one process per data directory).
 */
import { P2P_CONFIG, DEFAULT_API, PHA_HASH_VECTORS, MAX_FEE_BPS, P2P_TOKENS, SOUL_RESERVE, CLOCK_SKEW_MAX, networkProblem, phaRpcProblem, baseRpcProblem, type P2PNetConfig } from './pins.js';
import { SafetyError, SAFETY } from './errors.js';
import { redactedLog, errorText, redact, type LogFn } from './redact.js';
import { loadKeys, readSecretFile, knownRoleProblem, type LoadedKeys } from './keys.js';
import { openStore, type KitStore } from './store.js';
import { BoardClient, BoardSession, sleep as realSleep, type SleepFn } from './board.js';
import { devnetFaucet, type FaucetOutcome } from './faucet.js';
import { phaRpc, PhaReader, balanceOf, type PhaRpc } from './pha.js';
import { baseClient, BaseReader, type BaseClient } from './base.js';
import * as checks from './checks.js';
import { createSigner, type SignerDeps } from './signer.js';
import { amountText } from './rules.js';
import { Engine, flowError, type ClaimMode, type OfferInput, type Policy, type StepResult } from './flows/maker.js';
import { Taker } from './flows/taker.js';
import type { Network, LocalOffer, LocalTrade, Trade, P2PConfig } from './types.js';

// ── Options ──────────────────────────────────────────────────────────────────

export interface KitOptions {
  network: 'devnet' | 'mainnet';
  /** The board's API (default https://apiops.saturnx.cc). */
  api?: string;
  /** X-API-Key (sat_…). Prefer apiKeyFile: a key in code or config ends up in shells and logs. */
  apiKey?: string;
  /** A file holding the API key (mode 0600, like the key files). */
  apiKeyFile?: string;
  /** JSON {"wif": "..."}: mode 0600 required. */
  phaKeyFile: string;
  /** JSON {"privateKey": "0x..."}: mode 0600 required. */
  baseKeyFile: string;
  /** The bot's state (created 0700); one running bot per directory and network. */
  dataDir: string;
  /** Default from the pins; its host must be on the network's allowlist (check 67). */
  phaRpc?: string;
  /** Default from the pins; https, and its chain id must equal the pin (84532 on devnet, 8453 on mainnet; check 67). */
  baseRpc?: string;
  /** Default 'self': the kit claims its USDC itself and never sends its secret to the board. */
  claimMode?: ClaimMode;
  /** Default true: lockWithPermit (one transaction); false: approve exactly the amount, then lock. */
  usePermit?: boolean;
  /** Receives redacted lines only. */
  log?: (line: string) => void;
  /** Default false. Mainnet also needs env KIT_ALLOW_MAINNET=1 and a kit release with mainnet pins (this release has them). */
  allowMainnet?: boolean;
  /** The environment the kit reads (KIT_ALLOW_MAINNET, KIT_STORE_KEY_FILE). Default process.env. */
  env?: Record<string, string | undefined>;
  /**
   * For tests and for custom transports. The checks of check 67 still run on
   * `phaRpc`/`baseRpc`, and the Base chain id is still read through the
   * transport given here; nothing else of the safety model changes.
   */
  internals?: KitInternals;
}

export interface KitInternals {
  /** The board's fetch. */
  fetch?: typeof fetch;
  /** The Phantasma node (replaces phaRpc()). */
  pha?: PhaRpc;
  /** The Base node (replaces baseClient()). */
  base?: BaseClient;
  /** ms clock. */
  now?: () => number;
  /** How the kit waits (loops, retries). */
  sleep?: SleepFn;
  /** How the signer waits for outcomes. */
  signerSleep?: SignerDeps['sleep'];
  signerWait?: SignerDeps['wait'];
  /** Checked for key material instead of process.argv. */
  argv?: readonly string[];
  /** The store's key file (null: no sealing); default env KIT_STORE_KEY_FILE. */
  storeKeyFile?: string | null;
  /** Long-poll wait, seconds (default 25). */
  pollWaitS?: number;
}

// ── The kit ──────────────────────────────────────────────────────────────────

export interface PreflightItem {
  readonly name: string;
  /**
   * The item passed. An item with code TOKEN_OFF passes too: the escrow
   * takes no locks of that token on this network (its admin has not allowed
   * it yet, its largest lock reads 0), which is a state, not a failure. The
   * kit cannot trade that token here, and its lock checks refuse it before
   * anything is signed; a bot that trades it should not start (the example
   * bots do not).
   */
  readonly ok: boolean;
  readonly text: string;
  readonly code?: string;
}

export interface PreflightReport {
  readonly network: Network;
  /**
   * Every item passed. A token the escrow does not take on this network
   * (an item with code TOKEN_OFF) does not make this false, so
   * `if (!report.ok) process.exit(1)` does not stop a bot that never
   * trades it; a bot that does trades it should look for that item.
   */
  readonly ok: boolean;
  readonly address: Readonly<{ pha: string; base: `0x${string}` }>;
  readonly items: readonly PreflightItem[];
  /** Raw balances as text: Phantasma by symbol; Base USDC and ETH. Null when they could not be read. */
  readonly balances: Readonly<{ pha: Readonly<Record<string, string>> | null; base: Readonly<{ usdc: string; eth: string }> | null }>;
  /** This machine's clock minus the newest Base block's, seconds (null when not read). */
  readonly clockSkewS: number | null;
}

export interface Kit {
  readonly network: Network;
  readonly address: Readonly<{ pha: string; base: `0x${string}` }>;
  readonly board: BoardClient;
  /** Reads only; sends live in signer.ts. */
  readonly pha: PhaReader;
  readonly base: BaseReader;
  readonly store: KitStore;
  /** Pins, vectors, paused, fee, bounds, caps, balances, clock skew. Reads only. */
  preflight(): Promise<PreflightReport>;
  /**
   * Amounts in whole units as decimal text ("30", "1.08"). A failed post is a
   * CreateError: with `mayExist` the offer may be listed all the same, so do
   * not post it again; run() or resume() records it if the board made it.
   * `mode: 'instant'` lists a sell offer whose buyer locks first (devnet, while
   * the board's /config says instant trades are on, with an API key flagged
   * instant; MODE_NOT_SUPPORTED otherwise, nothing posted).
   */
  postOffer(o: OfferInput): Promise<LocalOffer>;
  cancelOffer(offerId: number): Promise<void>;
  repriceOffer(offerId: number, change: { price: string } | { follow: { offsetBps: number; limitPrice: string; dailyMax?: string } }): Promise<void>;
  /**
   * Sends the price it read; LocalTrade.price is that price. `amount` in whole
   * tokens. Board refusals were already retried where they may be; a failed
   * take is a CreateError: with `mayExist` the take may exist, so do not take
   * again (a new call makes a second take); run() or resume() records it.
   */
  take(offerId: number, amount: string): Promise<LocalTrade>;
  /** Both refuse to lock (PRICE_LIMIT) a trade priced past the limit. Amounts and prices in whole units. */
  buyUpTo(o: { symbol: string; amount: string; maxPrice: string; maxLegs?: number }): Promise<LocalTrade[]>;
  sellDownTo(o: { symbol: string; amount: string; minPrice: string; maxLegs?: number }): Promise<LocalTrade[]>;
  /** Accept or decline a take on one of the bot's offers by the bot's own decision (signs nothing). */
  acceptTake(tradeId: number): Promise<Trade>;
  declineTake(tradeId: number): Promise<Trade>;
  /** Resumes from the store, then loops until aborted. */
  run(policy?: Policy, signal?: AbortSignal): Promise<void>;
  /** Advances one trade once (custom loops, tests). */
  step(tradeId: number, policy?: Policy): Promise<StepResult>;
  /**
   * What run() does first and then once a minute, for bots with a loop of
   * their own: asks the board about every offer or take whose answer was
   * lost (replayOnly, only to a board that keeps client hashes; it never
   * creates anything), records the takes it finds, and resolves every open
   * send from the chains. Call it before the first step() and about once a
   * minute; run() needs no call.
   */
  resume(signal?: AbortSignal): Promise<{ recorded: number; resolved: number; open: number }>;
  /** Devnet only. */
  devnetFaucet(): Promise<FaucetOutcome>;
  /** Release the data directory (stop run() first). */
  close(): Promise<void>;
}

/** Board calls of createKit and preflight: a few retries, no long waits. */
const SETUP_CALL = Object.freeze({ retries: 2, maxRetryAfter: 10 });

/** The keeper's addresses from /config (display only: they may only add a refusal). */
function keeperForbid(c: P2PConfig | null): { pha: string[]; base: string[] } {
  const k = (c?.keeper ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v ? [v] : []);
  return { pha: str(k.phaAddress), base: [...str(k.baseAddress), ...str(k.claimAddress)] };
}

/**
 * Build a kit (build spec section 6.3). See the file comment for the order
 * of its refusals; every refusal is a SafetyError and nothing is sent.
 */
export async function createKit(o: KitOptions): Promise<Kit> {
  if (!o || typeof o !== 'object') throw flowError('BAD_INPUT', 'createKit takes an options object.');
  const env = o.env ?? process.env;
  // Before any read: the network is open in this release (mainnet only with both switches), and both RPCs are allowed (check 67).
  const netBad = networkProblem(o.network, { allowMainnet: o.allowMainnet, env });
  if (netBad) throw new SafetyError(SAFETY.NETWORK_OFF, netBad);
  const network = o.network;
  const cfg = P2P_CONFIG[network];
  const phaUrl = o.phaRpc ?? cfg.pha.rpcUrl;
  const baseUrl = o.baseRpc ?? cfg.base.rpcUrl;
  const phaBad = phaRpcProblem(network, phaUrl);
  if (phaBad) throw new SafetyError(SAFETY.RPC_NOT_ALLOWED, phaBad);
  const baseBad = baseRpcProblem(baseUrl);
  if (baseBad) throw new SafetyError(SAFETY.RPC_NOT_ALLOWED, baseBad);
  const claimMode: ClaimMode = o.claimMode ?? 'self';
  if (claimMode !== 'self' && claimMode !== 'reveal-then-self') throw flowError('BAD_INPUT', 'claimMode is "self" or "reveal-then-self".');
  if (o.usePermit !== undefined && typeof o.usePermit !== 'boolean') throw flowError('BAD_INPUT', 'usePermit is true or false.');
  if (typeof o.dataDir !== 'string' || !o.dataDir) throw flowError('BAD_INPUT', 'dataDir names the bot\'s data directory.');
  const log = redactedLog(o.log);
  const io = o.internals ?? {};
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? realSleep;

  // The API key: from its 0600 file, or as given; never both.
  if (o.apiKey && o.apiKeyFile) throw flowError('BAD_INPUT', 'Give apiKey or apiKeyFile, not both.');
  let apiKey: string | undefined = o.apiKey || undefined;
  if (o.apiKeyFile) {
    const buf = await readSecretFile(o.apiKeyFile, 'API key');
    try {
      apiKey = buf.toString('utf8').trim();
    } finally {
      buf.fill(0);
    }
    if (!apiKey) throw new SafetyError(SAFETY.KEY_FILE, `The API key file ${o.apiKeyFile} is empty.`);
  }
  const board = new BoardClient({ network, api: o.api ?? DEFAULT_API, apiKey, fetch: io.fetch, log, sleep });

  // /config is display only: its keeper addresses can only add a refusal of the bot's own key (check 68).
  let config: P2PConfig | null = null;
  try {
    config = await board.config(SETUP_CALL);
  } catch (e) {
    log(`[kit] ${network}: the board's /config could not be read (${errorText(e)}); keys are checked against the pinned roles now and against the keeper's addresses when run() starts`);
  }
  const keys: LoadedKeys = await loadKeys({ network, phaKeyFile: o.phaKeyFile, baseKeyFile: o.baseKeyFile, forbid: keeperForbid(config), log, argv: io.argv });

  // The chains: Phantasma on the allowlist (checked above), Base on the pinned chain (check 67).
  const phaT = io.pha ?? phaRpc(network, { url: phaUrl });
  const baseT = io.base ?? baseClient(network, { url: baseUrl });
  const pha = new PhaReader(phaT, network);
  const base = new BaseReader(baseT, network);
  const chainBad = await base.chainIdProblem();
  if (chainBad) throw new SafetyError(SAFETY.RPC_NOT_ALLOWED, chainBad);

  const store = await openStore({ dataDir: o.dataDir, network, ...(io.storeKeyFile !== undefined ? { keyFile: io.storeKeyFile } : {}), env, log, now });
  try {
    const signer = createSigner({ keys, pha: phaT, base: baseT, store, now, log, ...(io.signerSleep ? { sleep: io.signerSleep } : {}), ...(io.signerWait ? { wait: io.signerWait } : {}) });
    const session = new BoardSession({ board, store, log, now });
    // The checks read the board's trade with a short retry budget: an intent is good for 60 s.
    const deps: checks.CheckDeps = {
      network, pha, base, store, address: keys.address, now, log,
      board: { trade: (id: number) => board.trade(id, { retries: 2, maxRetryAfter: 10 }) }
    };
    const beforeRun = async () => {
      // The keeper's addresses from /config, read again: a bot never holds a keeper or admin key (check 68).
      let c: P2PConfig | null = null;
      try { c = await board.config(SETUP_CALL); } catch { /* display only; the pinned roles were checked at start */ }
      const role = c ? knownRoleProblem(keys.address, keeperForbid(c)) : null;
      if (role) throw new SafetyError(SAFETY.KEY_ROLE, role);
    };
    const engine = new Engine({
      network, address: keys.address, session, signer, deps, claimMode, usePermit: o.usePermit !== false, log, now, sleep, beforeRun,
      ...(io.pollWaitS !== undefined ? { pollWaitS: io.pollWaitS } : {})
    });
    const taker = new Taker({ network, address: keys.address, session, engine, deps, log });
    log(`[kit] ${network}: ready (board ${board.api}${board.keyed ? ', with an API key' : ''}; claim mode ${claimMode}; ${o.usePermit !== false ? 'permit' : 'approve then lock'})`);
    return makeKit({ network, keys, board, pha, base, store, engine, taker, deps, log, cfg, now });
  } catch (e) {
    await store.close().catch(() => undefined);
    throw e;
  }
}

function makeKit(x: {
  network: Network; keys: LoadedKeys; board: BoardClient; pha: PhaReader; base: BaseReader; store: KitStore; engine: Engine; taker: Taker;
  deps: checks.CheckDeps; log: LogFn; cfg: P2PNetConfig; now: () => number;
}): Kit {
  const kit: Kit = {
    network: x.network,
    address: x.keys.address,
    board: x.board,
    pha: x.pha,
    base: x.base,
    store: x.store,
    preflight: () => preflight(x),
    postOffer: (o) => x.engine.postOffer(o),
    cancelOffer: (id) => x.engine.cancelOffer(id),
    repriceOffer: async (id, change) => { await x.engine.repriceOffer(id, change); },
    take: (id, amount) => x.taker.take(id, amount),
    buyUpTo: (o) => x.taker.buyUpTo(o),
    sellDownTo: (o) => x.taker.sellDownTo(o),
    acceptTake: (id) => x.engine.acceptTake(id),
    declineTake: (id) => x.engine.declineTake(id),
    run: (policy, signal) => x.engine.run(policy, signal),
    step: (id, policy) => x.engine.step(id, policy),
    resume: (signal) => x.engine.resume(signal),
    devnetFaucet: async () => {
      if (x.network !== 'devnet') throw new SafetyError(SAFETY.NETWORK_OFF, 'The faucet runs on devnet only; mainnet has none.');
      return devnetFaucet(x.board, { pha: x.keys.address.pha, base: x.keys.address.base.toLowerCase() }, { log: x.log });
    },
    close: async () => {
      if (x.engine.running) throw flowError('ALREADY_RUNNING', 'Stop run() (abort its signal) before closing the kit.');
      await x.store.close();
    }
  };
  return Object.freeze(kit);
}

/**
 * Pins, vectors, paused, fee, bounds, caps, balances, clock skew (section 6.3). Reads only; a failed read is a failed
 * item. A token the escrow takes no locks of on this network is an item that passes, with code TOKEN_OFF.
 */
async function preflight(x: { network: Network; keys: LoadedKeys; board: BoardClient; pha: PhaReader; base: BaseReader; deps: checks.CheckDeps; cfg: P2PNetConfig; now: () => number }): Promise<PreflightReport> {
  const items: PreflightItem[] = [];
  const add = (name: string, p: checks.Problem | null, okText: string) => items.push(Object.freeze(p ? { name, ok: false, text: p.text, code: p.code } : { name, ok: true, text: okText }));
  const fail = (name: string, text: string, code?: string) => items.push(Object.freeze({ name, ok: false, text, ...(code ? { code } : {}) }));
  const cfg = x.cfg;
  add('pins', checks.pinned(x.network) ?? checks.baseDeployedProblem(x.network), `The ${x.network} escrow and SaturnSwap are pinned in this kit release.`);
  add('code pin', await checks.codePin(x.deps, cfg), 'The escrow on Phantasma runs the pinned code under the pinned admin.');
  add('hash vectors', await checks.hashVectors(x.deps, cfg), `Phantasma's SHA-256 agrees with Base on all ${PHA_HASH_VECTORS.length} vectors.`);
  const chain = await x.base.chainIdProblem();
  if (chain) fail('base chain', chain, 'RPC_NOT_ALLOWED'); else items.push(Object.freeze({ name: 'base chain', ok: true, text: `The Base RPC serves ${cfg.base.name} (${cfg.base.chainId}).` }));
  try {
    const sp = await x.base.readSwapParams();
    const bad = sp.paused ? 'New USDC locks are paused on Base.' : !sp.allowed ? 'SaturnSwap does not take the pinned USDC.' : sp.feeBps > MAX_FEE_BPS ? `SaturnSwap's fee (${sp.feeBps} bps) is above ${MAX_FEE_BPS} bps.` : null;
    if (bad) fail('saturnswap', bad);
    else items.push(Object.freeze({ name: 'saturnswap', ok: true, text: `Fee ${sp.feeBps} bps; USDC per lock ${amountText(sp.minAmount, 6)} to ${amountText(sp.maxAmount, 6)}; lock length ${sp.minLock} to ${sp.maxLock} s.` }));
  } catch (e) {
    fail('saturnswap', `Could not read SaturnSwap (${errorText(e)}).`);
  }
  for (const t of P2P_TOKENS) {
    if (!t.enabled) continue;
    try {
      const [pp, cap] = await Promise.all([x.pha.readParams(cfg, t.symbol), x.pha.readOpenCap(cfg, t.symbol)]);
      // A token the escrow's admin has not allowed on this network yet (its largest lock reads 0) is a state, not a
      // failure: a new token joins the kit's table before every network takes it, and bots that never trade it must
      // still start. Paused locks and bounds other than the table's stay failures.
      const off = !pp.paused && pp.maxAmount === 0n;
      const bad = pp.paused ? 'New locks are paused.' : (pp.minAmount !== t.min || pp.maxAmount !== t.max) ? 'The escrow\'s bounds are not the ones this kit checks for.' : null;
      const room = cap.maxOpen > cap.openAmount ? cap.maxOpen - cap.openAmount : 0n;
      if (off) items.push(Object.freeze({ name: `escrow ${t.symbol}`, ok: true, code: 'TOKEN_OFF', text: `The escrow takes no locks of ${t.symbol} on this network, so the kit cannot trade it here. Other tokens are not affected.` }));
      else if (bad) fail(`escrow ${t.symbol}`, bad);
      else items.push(Object.freeze({ name: `escrow ${t.symbol}`, ok: true, text: `Per lock ${amountText(t.min, t.decimals)} to ${amountText(t.max, t.decimals)} ${t.symbol}; open-cap room ${amountText(room, t.decimals)} ${t.symbol}.` }));
    } catch (e) {
      fail(`escrow ${t.symbol}`, `Could not read the escrow's settings for ${t.symbol} (${errorText(e)}).`);
    }
  }
  let phaBal: Record<string, string> | null = null;
  try {
    const bal = await x.pha.balances(x.keys.address.pha);
    phaBal = {};
    for (const t of P2P_TOKENS) phaBal[t.symbol] = (balanceOf(bal, t.symbol) ?? 0n).toString();
    const soul = balanceOf(bal, 'SOUL') ?? 0n;
    if (soul < SOUL_RESERVE) fail('phantasma balance', `The Phantasma address holds ${amountText(soul, 8)} SOUL free; a seller keeps at least ${amountText(SOUL_RESERVE, 8)} SOUL for Phantasma's fees.`);
    else items.push(Object.freeze({ name: 'phantasma balance', ok: true, text: P2P_TOKENS.map((t) => `${amountText(BigInt(phaBal![t.symbol]!), t.decimals)} ${t.symbol}`).join(', ') }));
  } catch (e) {
    fail('phantasma balance', `Could not read the Phantasma balances (${errorText(e)}).`);
  }
  let baseBal: { usdc: string; eth: string } | null = null;
  try {
    const f = await x.base.readFunds(x.keys.address.base);
    baseBal = { usdc: f.usdc.toString(), eth: f.eth.toString() };
    items.push(Object.freeze({ name: 'base balance', ok: true, text: `${amountText(f.usdc, 6)} ${cfg.base.usdcSymbol}, ${amountText(f.eth, 18, 6)} ETH` }));
  } catch (e) {
    fail('base balance', `Could not read the Base balances (${errorText(e)}).`);
  }
  let clockSkewS: number | null = null;
  try {
    const head = await x.base.head();
    clockSkewS = Math.floor(x.now() / 1000) - head.time;
  } catch { /* reported by the clock item */ }
  const clock = await checks.chainClock(x.deps);
  add('clock', clock.ok ? null : clock.problem, `This machine's clock is within ${CLOCK_SKEW_MAX / 60} minutes of Base's newest block.`);
  try {
    const c = await x.board.config(SETUP_CALL);
    if (!c.enabled) fail('board', `P2P is off on ${x.network} at this board.`);
    else items.push(Object.freeze({ name: 'board', ok: true, text: `The board at ${x.board.api} has P2P on for ${x.network}.` }));
    const role = knownRoleProblem(x.keys.address, keeperForbid(c));
    if (role) fail('keys', role, SAFETY.KEY_ROLE);
  } catch (e) {
    fail('board', `Could not read the board's /config (${errorText(e)}).`);
  }
  if (x.board.keyed) {
    try {
      const me = await x.board.me(SETUP_CALL);
      const paused = [me.noShows.taker.pausedUntil, me.noShows.maker.pausedUntil].filter((v): v is number => v != null && v * 1000 > x.now());
      if (paused.length) fail('api key', `This API key's takes or offers are paused until ${new Date(Math.max(...paused) * 1000).toISOString()} (no-shows).`);
      else items.push(Object.freeze({ name: 'api key', ok: true, text: `API key ${redact(me.key.label, 60)}: ${me.key.p2pCreateRpm} creates and ${me.key.p2pWriteRpm} writes per minute; instant offers ${me.key.instant === true ? 'allowed' : 'not allowed'}.` }));
    } catch (e) {
      fail('api key', `Could not read /me (${errorText(e)}).`);
    }
  }
  return Object.freeze({
    network: x.network, ok: items.every((i) => i.ok), address: x.keys.address, items: Object.freeze(items),
    balances: Object.freeze({ pha: phaBal ? Object.freeze(phaBal) : null, base: baseBal ? Object.freeze(baseBal) : null }), clockSkewS
  });
}

// ── Public exports ───────────────────────────────────────────────────────────

export { Engine, FLOW_CODES, flowError, resolvePolicy, toRaw, tokenToRaw, usdcToRaw, fromRaw, echoProblem } from './flows/maker.js';
export type { Policy, ResolvedPolicy, StepResult, StepAction, StepOutcome, ClaimMode, OfferInput, AcceptChecks, FlowCode } from './flows/maker.js';
export { Taker, planFill, MAX_LEGS, MAX_TAKES } from './flows/taker.js';
export { InstantSeller } from './flows/instant.js';
export type { FillLeg, FillPlan } from './flows/taker.js';
export { BoardClient, BoardSession, OfferPoller, TradePoller, CreateError, BOARD_ERRORS, retryRuleOf } from './board.js';
export { devnetFaucet, faucetClaimLines } from './faucet.js';
export type { FaucetOutcome, FaucetClaim } from './faucet.js';
export { SafetyError, BoardError, SAFETY, isSafetyError, isBoardError } from './errors.js';
export { CHECK_CODES, DONE_ELSEWHERE, instantBuyerLockProblem, instantWindowProblem, instantSwapReadsProblem } from './checks.js';
export type { Problem, CheckId } from './checks.js';
export { SIGNER_CODES } from './signer.js';
export { redact, shortHex } from './redact.js';
export { P2P_TOKENS, P2P_CONFIG, BOARD, INSTANT, INSTANT_NETWORKS, INSTANT_RULES, instantTiming, instantBaseSpan, tokenOf, networkProblem, phaRpcProblem, baseRpcProblem } from './pins.js';
export type { InstantTiming } from './pins.js';
export { PhaReader } from './pha.js';
export { BaseReader } from './base.js';
export type { KitStore } from './store.js';
export type {
  Network, Side, Offer, Trade, TradeStatus, FeedTrade, P2PConfig, Reference, Me, LocalOffer, LocalTrade, FollowSettings, FollowState, OfferMode
} from './types.js';
