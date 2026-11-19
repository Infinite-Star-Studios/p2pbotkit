/**
 * The bot fleet: the bots of bots.json, run in sessions by one Durable Object
 * (worker.ts). Kept apart from the Durable Object, behind FleetHost, so that
 * it runs on Node with fakes in its tests (test/fleet.test.ts).
 *
 * What a session is. A Durable Object has no process that runs for days: it
 * runs while a request or an alarm is in flight, and an alarm may run for 15
 * minutes at most. So the fleet runs the bots in sessions of SESSION_MS: an
 * alarm first sets the next alarm (a backstop, should the session be cut
 * off by a deploy or a runtime update), then builds each running bot's kit
 * (createHostedKit: its keys from the Worker's secrets, its records in this
 * object's SQLite), runs the runner's trading loop (examples/seller-bot.ts
 * trade(), the very loop of `npm run market`) until the session ends, closes
 * the kit, and sets the alarm of the next session a second later. Ending a
 * session is a pause, not a stop: nothing is cancelled; run() finishes the
 * step it is in, every trade stays in the store, and the next session's run()
 * resumes from it (pending creates and open sends settled first, as after
 * any restart) and sends its offers' heartbeats well inside their 90 s.
 *
 * A session's end waits for each bot's last step (a Base transaction can
 * take minutes to be mined). Meanwhile a bot whose session has already
 * ended goes on in a short extra session, rather than wait idle for the
 * slowest bot (up to OVERLAP_MS after the end).
 *
 * Its state, per bot (this object's key-value storage, `bot:<name>`):
 *   stopped   no session; the bot holds no offer (or was halted)
 *   running   a session runs it, or will within seconds
 *   stopping  its sessions cancel its offers, take nothing, and finish its
 *             trades, as after one Ctrl-C; then it is stopped
 * A session that fails (an RPC that does not answer, a secret not set yet)
 * is tried again after a growing wait (BACKOFF_MS to BACKOFF_MAX_MS): the
 * bot's state does not change, so fixing the cause is enough.
 *
 * A running bot whose entry leaves bots.json, or whose config can no longer
 * be used, is never left with its trades unattended, nor resumed later
 * without a new start: it stops, with the config it last ran with (kept as
 * `cfg:<name>`), cancelling its offers and finishing its trades; then it
 * needs a new start, with its dry run and, on mainnet, its yes.
 *
 * The control calls (worker.ts serves them, behind the control token):
 *   status, logs     what each bot is doing, and its latest lines
 *   dryRun           what a bot would list and take; sends nothing (a stopped bot only)
 *   start            the preflight, then running (mainnet: only with the start's
 *                    own yes, {"mainnet": true}, and KIT_ALLOW_MAINNET = "1")
 *   stop             stopping: cancel the offers, finish the trades, then stopped
 *   halt             stopped at once, its trades left where they are (as two Ctrl-C)
 * No call changes a config: the configs are bots.json, deployed with the Worker.
 */
import { P2P_CONFIG, SqlBackend, networkProblem, type HostedKitOptions, type SqlDatabase } from '../../src/index.js';
import { redact } from '../../src/redact.js';
import {
  parseHostedConfig, trade, printPreflight, dryRunRest, readOnlyTransports, explain, describeOffer, SESSION_PAUSED,
  type BotKit, type HostedBotConfig, type SignalSource
} from '../../examples/seller-bot.js';

// ── Timing ───────────────────────────────────────────────────────────────────

/**
 * One session. An alarm runs for 15 minutes at most, and when a session ends,
 * run() first finishes the step it is in: a Base transaction waits up to
 * 3 minutes to be mined, and an approve then a lock up to twice that. Six
 * minutes leaves room for that inside the limit.
 */
export const SESSION_MS = 6 * 60_000;
/**
 * After a session's end, while a bot still finishes its last step, the bots
 * whose session has ended go on in extra sessions, up to this long after
 * the end: the alarm's work stays well inside its 15 minutes.
 */
export const OVERLAP_MS = 2 * 60_000;
/** The alarm a session sets first: should the session be cut off, the next one still comes (the limit, and a little). */
export const DEADMAN_MS = 15 * 60_000 + 30_000;
/** The next session starts this soon after one ends. */
export const NEXT_MS = 1_000;
/** A bot started while a session runs joins it, while at least this much of it is left. */
export const MIN_JOIN_MS = 30_000;
/** How often a running session looks for bots to join it. */
export const JOIN_POLL_MS = 2_000;
/** After a failed session the bot waits this long, doubled after each further failure, up to BACKOFF_MAX_MS. */
export const BACKOFF_MS = 60_000;
export const BACKOFF_MAX_MS = 15 * 60_000;
/** Lines kept per bot for status and logs (the platform's logs keep them all). */
export const LOG_LINES = 400;

// ── The host ─────────────────────────────────────────────────────────────────

/** The fleet's timing (the constants above); a test may shorten it. */
export interface FleetTiming {
  sessionMs: number;
  overlapMs: number;
  deadmanMs: number;
  nextMs: number;
  minJoinMs: number;
  joinPollMs: number;
  backoffMs: number;
  backoffMaxMs: number;
}

const TIMING: FleetTiming = Object.freeze({
  sessionMs: SESSION_MS, overlapMs: OVERLAP_MS, deadmanMs: DEADMAN_MS, nextMs: NEXT_MS, minJoinMs: MIN_JOIN_MS, joinPollMs: JOIN_POLL_MS, backoffMs: BACKOFF_MS, backoffMaxMs: BACKOFF_MAX_MS
});

/** What the fleet needs of a kit: what the runner uses (BotKit), and the kit's addresses. */
export type FleetKit = BotKit;

/** What the fleet needs of its Durable Object (worker.ts), or of a test. */
export interface FleetHost {
  /** The object's SQLite: the bots' stores (ctx.storage.sql). */
  readonly sql: SqlDatabase;
  /** The object's key-value storage, for the fleet's own small state (ctx.storage.kv). */
  readonly kv: { get(key: string): unknown; put(key: string, value: unknown): void; delete(key: string): boolean; keys(prefix: string): string[] };
  setAlarm(at: number): void | Promise<void>;
  getAlarm(): number | null | Promise<number | null>;
  deleteAlarm(): void | Promise<void>;
  /** The Worker's vars and secrets. */
  readonly env: Readonly<Record<string, unknown>>;
  /** Builds a bot's kit: createHostedKit (tests: a fake). */
  makeKit(o: HostedKitOptions): Promise<FleetKit>;
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Every line, for the platform's logs (console.log). */
  print(line: string): void;
  /** The fetch of every request a kit sends (the board, both chains): worker.ts gives one that never follows a redirect (fetch.ts). */
  readonly fetch?: typeof fetch;
  /** For tests only: shorter sessions and waits (the defaults are the constants above). */
  readonly timing?: Partial<FleetTiming>;
}

// ── The bots of bots.json ────────────────────────────────────────────────────

/** A bot of bots.json: its config, or why it cannot run. */
export interface BotDef {
  readonly name: string;
  /** Its secrets' prefix: "market" -> MARKET_PHA_KEY, MARKET_BASE_KEY, MARKET_API_KEY, MARKET_STORE_KEY. */
  readonly prefix: string;
  readonly cfg: HostedBotConfig | null;
  readonly error: string | null;
  /** Not a bot of bots.json (or its config there cannot be used): it stops, with the config it last ran with. */
  readonly orphan?: boolean;
}

export interface Bots {
  readonly list: readonly BotDef[];
  /** Why bots.json as a whole cannot be used, or null. */
  readonly error: string | null;
}

const NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;

/** A bot's secrets' prefix: its name in capitals, "-" as "_". */
export const prefixOf = (name: string) => name.toUpperCase().replace(/-/g, '_');

/** A secret's value, or undefined when it is not set (or empty). */
function secret(env: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const v = env[name];
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/**
 * The bots of bots.json: an object of bot names (lower case letters, digits
 * and "-") and their configs, each checked as parseHostedConfig checks one.
 * A config that does not pass is kept with its error, so that status shows
 * it; that bot cannot start until bots.json is fixed and deployed again.
 * Whether a config can be used never depends on the secrets: an API key that
 * an instant offer needs is checked with the secrets (a start refuses, a
 * session waits), so npm run check-config and the Worker agree.
 */
export function loadBots(raw: unknown): Bots {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { list: [], error: 'bots.json is a JSON object of bot names and their configs: {"market": {...}}.' };
  const list: BotDef[] = [];
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!NAME_RE.test(name)) return { list: [], error: `bots.json: "${redact(name, 40)}" is not a bot name (a lower case letter, then up to 30 lower case letters, digits or "-").` };
    const prefix = prefixOf(name);
    try {
      const cfg = parseHostedConfig(v, { apiKey: true });
      list.push({ name, prefix, cfg, error: null });
    } catch (e) {
      list.push({ name, prefix, cfg: null, error: explain(e) });
    }
  }
  if (list.length === 0) return { list, error: 'bots.json names no bot.' };
  return { list, error: null };
}

/**
 * The bots as the Worker gets them: the text of its BOTS_CONFIG secret,
 * which npm run deploy uploads from your bots.json. bots.json stays on your
 * machine and out of the repository: it holds your prices, your limits and,
 * with a Base RPC of your own, that RPC's key.
 */
export function loadBotsConfig(text: unknown): Bots {
  if (typeof text !== 'string' || !text.trim()) {
    return { list: [], error: 'No bots yet: the BOTS_CONFIG secret is not set. Make bots.json from bots.example.json, then npm run deploy, which uploads it as BOTS_CONFIG.' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { list: [], error: 'The BOTS_CONFIG secret is not JSON. Check bots.json with npm run check-config, then npm run deploy.' };
  }
  return loadBots(raw);
}

// ── State ────────────────────────────────────────────────────────────────────

export type Mode = 'stopped' | 'running' | 'stopping';

export interface BotState {
  mode: Mode;
  /** When the mode last changed (ms). */
  since: number;
  /** Why it stopped: a clean stop, a halt. */
  note?: string;
  /** The start said yes to mainnet. */
  mainnet?: boolean;
  /** After a failed session: no session before this (ms). */
  retryAt?: number;
  /** Failed sessions in a row. */
  failures?: number;
  /** Why the last session failed. */
  lastError?: string;
  /** It left bots.json (or its config there cannot be used) while it ran. */
  orphan?: boolean;
}

interface Snapshot {
  at: number;
  address: { pha: string; base: string };
  openOffers: number[];
  trades: Array<{ id: number; status: string }>;
}

/** A control call's answer: worker.ts sends `body` as JSON with `status`. */
export interface Reply {
  status: number;
  body: { ok: boolean; [k: string]: unknown };
}

const reply = (status: number, body: Record<string, unknown>): Reply => ({ status, body: { ok: status < 400, ...body } });

/** Where trade() and the runner hear a stop: the fleet sends SIGTERM for a bot's stop. */
class Signals implements SignalSource {
  readonly #fns = new Set<() => void>();
  on(_e: 'SIGINT' | 'SIGTERM', fn: () => void): this { this.#fns.add(fn); return this; }
  off(_e: 'SIGINT' | 'SIGTERM', fn: () => void): this { this.#fns.delete(fn); return this; }
  emit(): void { for (const fn of [...this.#fns]) fn(); }
}

interface Live { readonly end: AbortController; readonly signals: Signals; readonly startedAt: number }

const usdcOf = (cfg: HostedBotConfig) => P2P_CONFIG[cfg.network].base.usdcSymbol;

/** A bot with a config to run. */
type Runnable = BotDef & { cfg: HostedBotConfig };

// ── The fleet ────────────────────────────────────────────────────────────────

export class Fleet {
  readonly #host: FleetHost;
  readonly #bots: Bots;
  /** Every bot the fleet knows: those of bots.json, then those that left it while running (orphans). */
  readonly #defs = new Map<string, BotDef>();
  /** Starts whose preflight runs now; a stop or a halt meanwhile cancels the start. */
  readonly #starting = new Map<string, { cancelled: 'stop' | 'halt' | null }>();
  readonly #logs = new Map<string, string[]>();
  readonly #live = new Map<string, Live>();
  readonly #snaps = new Map<string, Snapshot>();
  /** Bots whose store a control call (a dry run, a start's preflight) has open right now. */
  readonly #busy = new Set<string>();
  readonly #startedAt: number;
  readonly #t: FleetTiming;

  constructor(host: FleetHost, bots: Bots) {
    this.#host = host;
    this.#bots = bots;
    this.#startedAt = host.now();
    this.#t = { ...TIMING, ...(host.timing ?? {}) };
    for (const d of bots.list) this.#defs.set(d.name, d);
    this.#adoptOrphans();
  }

  /**
   * The bots that run (or stop) in this object's storage but have no usable
   * config in the bots.json deployed now: each stops with the config it last
   * ran with, and then needs a new start. One kept without any config (it
   * never ran a session) is stopped, and status says so.
   */
  #adoptOrphans(): void {
    for (const name of this.#host.kv.keys('bot:').map((k) => k.slice(4))) {
      const def = this.#defs.get(name);
      if (def?.cfg) continue;
      const st = this.#state(name);
      if (st.mode === 'stopped' && !st.orphan) continue;
      const why = def ? `its config in bots.json cannot be used (${def.error})` : 'its entry left bots.json';
      const last = this.#host.kv.get(`cfg:${name}`) as HostedBotConfig | undefined;
      this.#defs.set(name, { name, prefix: prefixOf(name), cfg: last ?? null, error: def?.error ?? 'not in bots.json', orphan: true });
      if (st.mode === 'stopped') continue;
      if (last) {
        if (st.mode === 'running' || !st.orphan) {
          this.#setState(name, { ...st, mode: 'stopping', since: this.#host.now(), orphan: true, note: `It was ${st.mode}, and ${why}: it stops with the config it last ran with (its offers cancelled, its trades finished), then needs a new start.` });
          this.#line(name, `[${name}] ${why[0]!.toUpperCase()}${why.slice(1)}: it stops with the config it last ran with, cancelling its offers and finishing its trades.`);
        }
      } else {
        this.#setState(name, { ...st, mode: 'stopped', since: this.#host.now(), orphan: true, note: `It was ${st.mode}, and ${why}; no config of it is kept, so it cannot stop cleanly: its trades wait in its store. Put its entry back (fixed), deploy, then start it again.` });
      }
    }
  }

  // ── Lines ────────────────────────────────────────────────────────────────

  #line(name: string, text: string): void {
    const line = `${new Date(this.#host.now()).toISOString().replace(/\.\d{3}Z$/, 'Z')} ${redact(text, 2000)}`;
    const ring = this.#logs.get(name) ?? [];
    ring.push(line);
    if (ring.length > LOG_LINES) ring.splice(0, ring.length - LOG_LINES);
    this.#logs.set(name, ring);
    this.#host.print(`[${name}] ${line}`);
  }

  /** The runner's lines (they say [<bot>]). */
  #sayer(name: string): (l: string) => void {
    return (l) => this.#line(name, `[${name}] ${l}`);
  }

  /** The kit's lines (they say [kit] or [store]). */
  #kitLog(name: string): (l: string) => void {
    return (l) => this.#line(name, l);
  }

  // ── State ────────────────────────────────────────────────────────────────

  #state(name: string): BotState {
    const v = this.#host.kv.get(`bot:${name}`) as BotState | undefined;
    return v && typeof v === 'object' && (v.mode === 'stopped' || v.mode === 'running' || v.mode === 'stopping') ? { ...v } : { mode: 'stopped', since: 0 };
  }

  #setState(name: string, s: BotState): void {
    this.#host.kv.put(`bot:${name}`, s);
  }

  /**
   * The bot, or why a call about it cannot go on. A start or a dry run needs
   * the bot's config in bots.json (`fromBotsJson`); a stop or a halt also
   * reaches a bot that left it while it ran (an orphan).
   */
  #usable(name: string, o: { fromBotsJson: boolean }): { def: Runnable } | { reply: Reply } {
    const def = this.#defs.get(name);
    if (!def) {
      if (this.#bots.error) return { reply: reply(500, { error: this.#bots.error }) };
      return { reply: reply(404, { error: `No bot "${redact(name, 40)}" in bots.json (it has: ${this.#bots.list.map((b) => b.name).join(', ')}).` }) };
    }
    if (def.orphan && o.fromBotsJson) {
      return { reply: reply(409, { error: `"${name}" is not in the bots.json deployed now, or its config there cannot be used (${def.error}). Put its entry back (fixed) and deploy first.` }) };
    }
    if (!def.cfg) return { reply: reply(409, { error: `The config of "${name}" in bots.json cannot be used: ${def.error}` }) };
    return { def: def as Runnable };
  }

  /** Why the bot's secrets cannot be used now, or null. */
  #secretsProblem(def: BotDef): string | null {
    const missing = [`${def.prefix}_PHA_KEY`, `${def.prefix}_BASE_KEY`].filter((n) => secret(this.#host.env, n) === undefined);
    if (missing.length) return `Set the secret${missing.length > 1 ? 's' : ''} ${missing.join(' and ')} first: the bot's key files, as they are (npx wrangler secret put ${missing[0]} < keys/...json).`;
    if (def.cfg?.offers.some((w) => w.mode === 'instant') && secret(this.#host.env, `${def.prefix}_API_KEY`) === undefined) {
      return `Set the secret ${def.prefix}_API_KEY first: an instant offer needs an API key the owner flagged for instant offers.`;
    }
    return null;
  }

  /** The kit's options for a bot: its keys, API key and store key from the secrets; its store in this object's SQLite. */
  #kitOptions(def: Runnable, o: { mainnet: boolean; log: (l: string) => void; internals?: HostedKitOptions['internals'] }): HostedKitOptions {
    const cfg = def.cfg;
    const env = this.#host.env;
    const p = def.prefix;
    const apiKey = secret(env, `${p}_API_KEY`);
    return {
      network: cfg.network,
      api: cfg.api,
      ...(cfg.phaRpc ? { phaRpc: cfg.phaRpc } : {}),
      ...(cfg.baseRpc ? { baseRpc: cfg.baseRpc } : {}),
      claimMode: cfg.claimMode,
      usePermit: cfg.usePermit,
      ...(o.mainnet ? { allowMainnet: true } : {}),
      env: { KIT_ALLOW_MAINNET: typeof env.KIT_ALLOW_MAINNET === 'string' ? env.KIT_ALLOW_MAINNET : undefined },
      keys: {
        pha: secret(env, `${p}_PHA_KEY`) ?? '', base: secret(env, `${p}_BASE_KEY`) ?? '',
        names: { pha: `${p}_PHA_KEY`, base: `${p}_BASE_KEY` }
      },
      store: new SqlBackend(this.#host.sql, { network: cfg.network, name: def.name, where: `durable-object:${def.name}/${cfg.network}` }),
      storeKey: secret(env, `${p}_STORE_KEY`)?.trim() ?? null,
      ...(apiKey ? { apiKey } : {}),
      log: o.log,
      // No long-polls: a Worker holds at most six requests waiting for their answer's headers at once, and a held
      // long-poll would make a chain read wait behind it. Plain polls every 5 s keep the offers listed (90 s).
      internals: { pollWaitS: 0, argv: [], ...this.#fetches(), ...(o.internals ?? {}) }
    };
  }

  /** The host's fetch for the board and both chains, when it gives one. */
  #fetches(): { fetch?: typeof fetch; rpcFetch?: typeof fetch } {
    return this.#host.fetch ? { fetch: this.#host.fetch, rpcFetch: this.#host.fetch } : {};
  }

  /** When each of the bot's recurring orders is next due, kept across sessions (for the config deployed now). */
  #takeDue(def: Runnable) {
    const key = `due:${def.name}`;
    const of = JSON.stringify(def.cfg.take);
    return {
      load: (): number[] => {
        const v = this.#host.kv.get(key) as { of?: string; due?: unknown } | undefined;
        return v && v.of === of && Array.isArray(v.due) ? v.due.filter((x): x is number => typeof x === 'number') : [];
      },
      save: (due: readonly number[]): void => { this.#host.kv.put(key, { of, due: [...due] }); }
    };
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  /** One bot's session, ending at `endAt` or when `stop` aborts (or sooner: a clean stop, a halt, a failure). Never throws. */
  async #session(def: Runnable, endAt: number, stop?: AbortSignal): Promise<void> {
    const name = def.name;
    const say = this.#sayer(name);
    const end = new AbortController();
    const onStop = () => end.abort();
    if (stop?.aborted) end.abort();
    else stop?.addEventListener('abort', onStop, { once: true });
    // The session's end, on the host's clock (a test's virtual one); its wait is cut short once the session is over.
    const over = new AbortController();
    void this.#host.sleep(Math.max(0, endAt - this.#host.now()), over.signal).then(() => { if (!over.signal.aborted) end.abort(); });
    const live: Live = { end, signals: new Signals(), startedAt: this.#host.now() };
    this.#live.set(name, live);
    let kit: FleetKit | null = null;
    let failed: string | null = null;
    try {
      const missing = this.#secretsProblem(def);
      if (missing) throw new Error(missing);
      const st = this.#state(name);
      // The config this session runs with: should the bot leave bots.json, it stops with it (#adoptOrphans).
      if (!def.orphan) this.#host.kv.put(`cfg:${name}`, def.cfg);
      kit = await this.#host.makeKit(this.#kitOptions(def, { mainnet: st.mainnet === true, log: this.#kitLog(name) }));
      const code = await trade(kit, def.cfg, {
        say, usdc: usdcOf(def.cfg), now: () => this.#host.now(), sleep: (ms, signal) => this.#host.sleep(ms, signal), signals: live.signals,
        // The mode is read as trade() starts: a stop asked while the kit was being built is not lost.
        session: { until: end.signal, stopping: this.#state(name).mode === 'stopping', takeDue: this.#takeDue(def) }
      });
      await this.#snapshot(name, kit);
      const now = this.#host.now();
      const after = this.#state(name);
      if (code === SESSION_PAUSED || code === 0) {
        delete after.retryAt;
        delete after.failures;
        delete after.lastError;
      }
      if (code === 0 && after.mode !== 'stopped') {
        const note = after.orphan
          ? 'Stopped cleanly after it left bots.json: its offers are cancelled and every trade of it is finished. Put its entry back and start it to run it again.'
          : 'Stopped cleanly: its offers are cancelled and every trade of it is finished.';
        Object.assign(after, { mode: 'stopped', since: now, note } satisfies Partial<BotState>);
      }
      this.#setState(name, after);
      if (code !== 0 && code !== SESSION_PAUSED) failed = 'run() stopped on a failure (its lines above say why)';
    } catch (e) {
      failed = explain(e);
      say(`This session could not run: ${failed}`);
    } finally {
      over.abort();
      stop?.removeEventListener('abort', onStop);
      if (this.#live.get(name) === live) this.#live.delete(name);
      if (kit) await kit.close().catch((e: unknown) => say(`The kit could not be closed cleanly (${explain(e)}).`));
    }
    if (failed) {
      const st = this.#state(name);
      if (st.mode !== 'stopped') {
        const failures = (st.failures ?? 0) + 1;
        const wait = Math.min(this.#t.backoffMaxMs, this.#t.backoffMs * 2 ** (failures - 1));
        this.#setState(name, { ...st, failures, lastError: failed, retryAt: this.#host.now() + wait });
        say(`The next session tries again in ${Math.round(wait / 1000)} s.`);
      }
    }
  }

  async #snapshot(name: string, kit: FleetKit): Promise<void> {
    try {
      const [offers, trades] = await Promise.all([kit.store.listOffers(), kit.store.listTrades()]);
      this.#snaps.set(name, {
        at: this.#host.now(),
        address: { pha: kit.address.pha, base: kit.address.base },
        openOffers: offers.filter((o) => o.closedAt == null).map((o) => o.id),
        trades: trades.filter((t) => !t.endedAt).map((t) => ({ id: t.id, status: t.status ?? 'new' }))
      });
    } catch { /* status shows the previous one */ }
  }

  /** The bots that may start a session ending at `endAt`: running or stopping, not waiting, and with no session (or control call) of theirs running. */
  #joinable(endAt: number): Runnable[] {
    const now = this.#host.now();
    if (endAt - now < this.#t.minJoinMs) return [];
    return [...this.#defs.values()].filter((d): d is Runnable => {
      if (!d.cfg || this.#live.has(d.name) || this.#busy.has(d.name) || this.#starting.has(d.name)) return false;
      const st = this.#state(d.name);
      return st.mode !== 'stopped' && (st.retryAt ?? 0) <= now;
    });
  }

  /** The next alarm: a second from now while a bot runs (or when its wait ends), none while every bot is stopped. */
  async #schedule(): Promise<void> {
    const now = this.#host.now();
    let next: number | null = null;
    for (const d of this.#defs.values()) {
      if (!d.cfg) continue;
      const st = this.#state(d.name);
      if (st.mode === 'stopped') continue;
      const at = Math.max(st.retryAt ?? 0, now + this.#t.nextMs);
      next = next === null ? at : Math.min(next, at);
    }
    if (next === null) await this.#host.deleteAlarm();
    else await this.#host.setAlarm(next);
  }

  /**
   * The alarm: one session of every bot that runs. Until the session's end
   * (`endAt`) every bot that may run joins it. After it, while a bot still
   * finishes its last step, the bots whose session has ended go on in extra
   * sessions, which end once every regular session has ended, and at
   * `endAt + overlapMs` at the latest: no bot waits idle for another.
   */
  async alarm(): Promise<void> {
    const startedAt = this.#host.now();
    // The backstop first: should this session be cut off (a deploy, a runtime update), the next one comes anyway.
    await this.#host.setAlarm(startedAt + this.#t.deadmanMs);
    const endAt = startedAt + this.#t.sessionMs;
    const lastEnd = endAt + this.#t.overlapMs;
    const regularOver = new AbortController();
    const regular = new Set<Promise<void>>();
    const extra = new Set<Promise<void>>();
    const track = (set: Set<Promise<void>>, p: Promise<void>) => {
      const q: Promise<void> = p.finally(() => { set.delete(q); });
      set.add(q);
    };
    for (;;) {
      if (this.#host.now() < endAt) {
        for (const def of this.#joinable(endAt)) track(regular, this.#session(def, endAt));
      } else if (regular.size > 0) {
        for (const def of this.#joinable(lastEnd)) track(extra, this.#session(def, lastEnd, regularOver.signal));
      }
      if (regular.size === 0) regularOver.abort();
      if (regular.size === 0 && extra.size === 0) break;
      await Promise.race([...regular, ...extra, this.#host.sleep(this.#t.joinPollMs)]);
    }
    await this.#schedule();
  }

  /** The cron's call: an alarm for the bots that should run, should none be set. */
  async wake(): Promise<void> {
    if ((await this.#host.getAlarm()) === null) await this.#schedule();
  }

  // ── Control calls ────────────────────────────────────────────────────────

  status(): Reply {
    const bots = [...this.#defs.values()].map((d) => {
      const st = this.#state(d.name);
      const snap = this.#snaps.get(d.name);
      return {
        name: d.name,
        network: d.cfg?.network ?? null,
        mode: st.mode,
        since: st.since ? new Date(st.since).toISOString() : null,
        ...(st.note ? { note: st.note } : {}),
        ...(st.lastError ? { lastError: st.lastError, failures: st.failures ?? 0, retryAt: st.retryAt ? new Date(st.retryAt).toISOString() : null } : {}),
        sessionRunning: this.#live.has(d.name),
        ...(d.orphan ? { orphan: true } : {}),
        configError: d.error,
        secrets: this.#secretsProblem(d) ?? 'set',
        offers: d.cfg ? d.cfg.offers.map((w) => describeOffer(w, usdcOf(d.cfg!))) : [],
        ...(snap ? {
          address: snap.address, openOffers: snap.openOffers, runningTrades: snap.trades,
          seenAt: new Date(snap.at).toISOString()
        } : {}),
        lastLines: (this.#logs.get(d.name) ?? []).slice(-20)
      };
    });
    return reply(this.#bots.error ? 500 : 200, {
      ...(this.#bots.error ? { error: this.#bots.error } : {}),
      instanceSince: new Date(this.#startedAt).toISOString(),
      kitAllowMainnet: this.#host.env.KIT_ALLOW_MAINNET === '1',
      bots
    });
  }

  logs(name: string, n = 200): Reply {
    if (!this.#defs.has(name)) return reply(404, { error: `No bot "${redact(name, 40)}" here (it has: ${[...this.#defs.keys()].join(', ')}).` });
    const lines = this.#logs.get(name) ?? [];
    return reply(200, { name, since: new Date(this.#startedAt).toISOString(), lines: lines.slice(-Math.max(1, Math.min(LOG_LINES, Math.floor(n) || 200))) });
  }

  /** Open a bot's kit for a control call (a dry run, a start's preflight): the bot must not be running or busy. */
  async #withKit<T>(def: Runnable, o: { mainnet: boolean; internals?: HostedKitOptions['internals']; log: (l: string) => void }, fn: (kit: FleetKit) => Promise<T>): Promise<T> {
    this.#busy.add(def.name);
    let kit: FleetKit | null = null;
    try {
      kit = await this.#host.makeKit(this.#kitOptions(def, o));
      return await fn(kit);
    } finally {
      this.#busy.delete(def.name);
      if (kit) await kit.close().catch(() => undefined);
    }
  }

  /** What the bot would list and take now, as `npm run market -- --dry-run` shows it. Sends nothing. */
  async dryRun(name: string): Promise<Reply> {
    const u = this.#usable(name, { fromBotsJson: true });
    if ('reply' in u) return u.reply;
    const def = u.def;
    if (this.#state(name).mode !== 'stopped' || this.#live.has(name)) {
      return reply(409, { error: `"${name}" is running: a dry run is for a stopped bot (it opens the bot's store, which the running bot holds). GET /status shows what it does.` });
    }
    if (this.#busy.has(name)) return reply(409, { error: `"${name}" is busy with another call; try again in a moment.` });
    const missing = this.#secretsProblem(def);
    if (missing) return reply(409, { error: missing });
    const lines: string[] = [];
    const say = (l: string) => { lines.push(`[${name}] ${redact(l, 2000)}`); this.#line(name, `[${name}] dry run: ${l}`); };
    const kitLog = (l: string) => { lines.push(redact(l, 2000)); this.#line(name, `dry run: ${l}`); };
    const guard = readOnlyTransports(def.cfg.network, this.#fetches(), { pha: def.cfg.phaRpc, base: def.cfg.baseRpc });
    try {
      const code = await this.#withKit(def, { mainnet: def.cfg.network === 'mainnet', internals: guard.internals, log: kitLog }, async (kit) => {
        const report = await kit.preflight();
        const blocking = printPreflight(report, def.cfg, say);
        return dryRunRest(kit, def.cfg, { say, usdc: usdcOf(def.cfg), blocking, refused: guard.refused });
      });
      return reply(200, { name, wouldStart: code === 0, lines });
    } catch (e) {
      return reply(409, { name, error: `The dry run did not run: ${explain(e)}`, lines });
    }
  }

  /** Start a stopped bot: the preflight, then running (mainnet only with `mainnet: true`, the start's own yes). */
  async start(name: string, o: { mainnet?: boolean } = {}): Promise<Reply> {
    const u = this.#usable(name, { fromBotsJson: true });
    if ('reply' in u) return u.reply;
    const def = u.def;
    const cfg = def.cfg;
    const st = this.#state(name);
    if (st.mode === 'running') return reply(200, { name, mode: 'running', note: 'It is already running.' });
    if (st.mode === 'stopping') return reply(409, { name, mode: 'stopping', error: 'It is stopping: wait until it has stopped (GET /status), or halt it.' });
    if (this.#live.has(name) || this.#busy.has(name) || this.#starting.has(name)) return reply(409, { error: `"${name}" is busy with another call; try again in a moment.` });
    const yes = o.mainnet === true;
    if (cfg.network === 'mainnet' && !yes) {
      return reply(409, { name, error: 'This bot trades on mainnet, with real funds. Look at its dry run first; then start it with {"mainnet": true} as the request\'s body: that is your yes.' });
    }
    if (yes && cfg.network !== 'mainnet') return reply(409, { name, error: `{"mainnet": true} was given, but this bot's config is for ${cfg.network}.` });
    if (cfg.network === 'mainnet' && this.#host.env.KIT_ALLOW_MAINNET !== '1') {
      return reply(409, { name, error: 'Mainnet also needs KIT_ALLOW_MAINNET = "1" in the vars of wrangler.jsonc (then deploy again). Both switches, as for `npm run market`.' });
    }
    const off = networkProblem(cfg.network, { allowMainnet: yes, env: { KIT_ALLOW_MAINNET: '1' } });
    if (off) return reply(409, { name, error: off });
    const missing = this.#secretsProblem(def);
    if (missing) return reply(409, { name, error: missing });
    const lines: string[] = [];
    const say = (l: string) => { lines.push(`[${name}] ${redact(l, 2000)}`); this.#line(name, `[${name}] ${l}`); };
    const kitLog = (l: string) => { lines.push(redact(l, 2000)); this.#line(name, l); };
    // A stop or a halt that comes while the preflight runs cancels the start (stop() and halt() mark it).
    const starting = { cancelled: null as 'stop' | 'halt' | null };
    this.#starting.set(name, starting);
    let blocking: string[];
    try {
      blocking = await this.#withKit(def, { mainnet: yes, log: kitLog }, async (kit) => printPreflight(await kit.preflight(), cfg, say));
    } catch (e) {
      say(`Not starting: ${explain(e)}`);
      return reply(409, { name, error: `Not started: ${explain(e)}`, lines });
    } finally {
      this.#starting.delete(name);
    }
    if (starting.cancelled) {
      say(`Not starting: a ${starting.cancelled} was asked while its preflight ran. Nothing was sent.`);
      return reply(409, { name, mode: 'stopped', error: `Not started: a ${starting.cancelled} was asked while it was starting.`, lines });
    }
    if (blocking.length) {
      say(`Not starting: ${blocking.join(', ')} (above) stops the start. Nothing was sent.`);
      return reply(409, { name, error: `Not started: ${blocking.join(', ')} failed in the preflight.`, blocking, lines });
    }
    this.#setState(name, { mode: 'running', since: this.#host.now(), ...(yes ? { mainnet: true } : {}) });
    say(`Started${yes ? ' on mainnet' : ''}: its sessions run it from now on, each about ${Math.round(this.#t.sessionMs / 60_000)} minutes, one after the other.`);
    await this.#schedule();
    return reply(200, { name, mode: 'running', lines });
  }

  /** Stop a bot as one Ctrl-C does: no new offers or takes, its offers cancelled, its trades finished; then stopped. */
  async stop(name: string): Promise<Reply> {
    const pendingStart = this.#starting.get(name);
    if (pendingStart) {
      pendingStart.cancelled ??= 'stop';
      return reply(200, { name, mode: 'stopped', note: 'It was starting: the start is cancelled, and it stays stopped.' });
    }
    const u = this.#usable(name, { fromBotsJson: false });
    if ('reply' in u) return u.reply;
    const st = this.#state(name);
    if (st.mode === 'stopped') return reply(200, { name, mode: 'stopped', note: 'It is stopped.' });
    if (st.mode === 'stopping') return reply(200, { name, mode: 'stopping', note: 'It is already stopping.' });
    this.#setState(name, { ...st, mode: 'stopping', since: this.#host.now() });
    this.#line(name, `[${name}] A stop was asked: no new offers or takes; the bot cancels its offers and finishes its running trades, then stops.`);
    this.#live.get(name)?.signals.emit();
    await this.#schedule();
    return reply(200, { name, mode: 'stopping', note: 'It cancels its offers and finishes its running trades, then stops (on mainnet that can take hours when the other side never locks). GET /status shows when it has stopped.' });
  }

  /** Stop a bot at once, as a second Ctrl-C does: its offers and trades stay where they are until it is started again. */
  async halt(name: string): Promise<Reply> {
    const pendingStart = this.#starting.get(name);
    if (pendingStart) {
      pendingStart.cancelled = 'halt';
      return reply(200, { name, mode: 'stopped', note: 'It was starting: the start is cancelled, and it stays stopped.' });
    }
    const u = this.#usable(name, { fromBotsJson: false });
    if ('reply' in u) return u.reply;
    const st = this.#state(name);
    if (st.mode === 'stopped' && !this.#live.has(name)) return reply(200, { name, mode: 'stopped', note: 'It is stopped.' });
    const open = this.#snaps.get(name)?.trades ?? [];
    this.#setState(name, { mode: 'stopped', since: this.#host.now(), note: 'Halted: its state is kept; start it again to resume its trades.', ...(st.orphan ? { orphan: true } : {}) });
    this.#line(name, `[${name}] Halted: its state is kept. Start it again soon: a stopped bot sends no lock, claim or refund.`);
    this.#live.get(name)?.end.abort();
    await this.#schedule();
    return reply(200, {
      name, mode: 'stopped', wasMode: st.mode,
      note: 'Halted. Its offers stay listed until their heartbeats lapse (90 s), and its trades stay in its store. A stopped bot sends no lock, claim or refund: a lock it owes and does not send in time is its no-show, so start it again soon.',
      ...(open.length ? { runningTrades: open } : {})
    });
  }
}

