/**
 * The fleet (src/fleet.ts) on Node, with a fake Durable Object (its SQLite is
 * node:sqlite, its key-value storage a map, its alarm a field), a fake kit
 * and a virtual clock: the starts and their gates, the sessions an alarm
 * runs (a pause at their end, never a stop), the stop and the halt, the
 * waits after a failed session, the dry run, and the watchdog: what follows
 * a session cut off in the middle (a deploy).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  Fleet, loadBots, loadBotsConfig, SESSION_MS, OVERLAP_MS, DEADMAN_MS, DEADMAN_MAX_MS, WATCH_EVERY_MS, CUTS_IN_A_ROW, PROVEN_MS, NEXT_MS, JOIN_POLL_MS, BACKOFF_MS,
  type FleetHost, type FleetKit
} from '../src/fleet.js';
import { tokenToRaw, usdcToRaw, P2P_TOKENS, type HostedKitOptions, type LocalOffer, type LocalTrade, type OfferInput, type Policy, type Trade } from '../../src/index.js';

const T0 = 1_790_000_000_000;
const settle = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/** Virtual time: waits last until advance() reaches them, or their signal aborts. */
class VTime {
  ms = T0;
  #timers: Array<{ at: number; done: () => void }> = [];
  now = (): number => this.ms;
  sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise<void>((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    // A wait of 0 ends at once, as the Worker's own does (src/board.ts sleep).
    if (!(ms > 0)) { resolve(); return; }
    const t = { at: this.ms + ms, done: () => { signal?.removeEventListener('abort', t.done); this.#timers = this.#timers.filter((x) => x !== t); resolve(); } };
    this.#timers.push(t);
    signal?.addEventListener('abort', t.done, { once: true });
  });
  async advance(ms: number): Promise<void> {
    const end = this.ms + ms;
    for (let guard = 0; guard < 100_000; guard++) {
      await settle(2);
      const due = this.#timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.ms = Math.max(this.ms, due.at);
      due.done();
    }
    this.ms = end;
    await settle();
  }
}

/** A kit as the runner sees it; its offers and trades outlive a session, as a store's do. */
class FakeKit {
  readonly network: 'devnet' | 'mainnet';
  readonly address = { pha: 'P2K' + 'F'.repeat(44), base: `0x${'f1'.repeat(20)}` as `0x${string}` };
  offers: LocalOffer[] = [];
  trades: LocalTrade[] = [];
  calls: Array<{ fn: string; arg?: unknown; at: number }> = [];
  running = false;
  policy: Policy | undefined;
  preflightItems: Array<{ name: string; ok: boolean; text: string; code?: string }> = [{ name: 'pins', ok: true, text: 'pinned' }];
  /** A preflight waits for this (a slow board or chain). */
  preflightGate: Promise<void> | null = null;
  /** After its signal aborts, run() takes this long to end: the step in flight finishing (a Base transaction being mined). */
  windDownMs = 0;
  /** Raw units of a token where it holds another amount than the default, and its raw USDC. */
  tokens = new Map<string, bigint>();
  usdc = 10n ** 12n;
  /** What the board says is left of an offer (raw units; its total when not set). */
  left = new Map<number, bigint>();
  /** How often the balances and the board's word on an offer were read. */
  reads = { balances: 0, readFunds: 0, heartbeat: 0 };
  #next = 1;
  /** How its run() waits (a last step finishing): the waits of the world that runs it, so that a cut stops them too. */
  constructor(readonly clock: () => number, network: 'devnet' | 'mainnet', public sleep: (ms: number) => Promise<void> = async () => {}) { this.network = network; }
  count(fn: string): number { return this.calls.filter((c) => c.fn === fn).length; }
  #call(fn: string, arg?: unknown) { this.calls.push({ fn, arg, at: this.clock() }); }
  readonly board = {
    offers: async () => [],
    recent: async () => ({ trades: [], next: null }),
    reference: async () => { throw new Error('no reference on the fake kit'); },
    heartbeat: async (id: number) => {
      this.reads.heartbeat++;
      const o = this.offers.find((x) => x.id === id && x.closedAt == null);
      if (!o) throw new Error(`the fake board has no open offer #${id}`);
      return { offer: { id, status: 'open', remaining: (this.left.get(id) ?? BigInt(o.tazTotal)).toString(), follow: null }, trades: [], waited: false };
    }
  };
  readonly store = {
    listOffers: async () => this.offers.map((o) => ({ ...o })),
    listTrades: async () => this.trades.map((t) => ({ ...t })),
    listPending: async () => []
  };
  readonly pha = {
    balances: async () => {
      this.reads.balances++;
      return new Map(P2P_TOKENS.map((t) => [t.symbol, { raw: this.tokens.get(t.symbol) ?? 10n ** 15n, decimals: t.decimals }]));
    }
  };
  readonly base = {
    readFunds: async () => {
      this.reads.readFunds++;
      return { usdc: this.usdc, allowance: 0n, eth: 10n ** 18n };
    }
  };
  async preflight() {
    this.#call('preflight');
    if (this.preflightGate) await this.preflightGate;
    return { network: this.network, ok: this.preflightItems.every((i) => i.ok), address: this.address, items: this.preflightItems, balances: { pha: null, base: null }, clockSkewS: 0 };
  }
  async postOffer(o: OfferInput): Promise<LocalOffer> {
    this.#call('postOffer', o);
    const raw = (v: string) => tokenToRaw(o.symbol, v).toString();
    const rec: LocalOffer = {
      id: this.#next++, network: this.network, side: o.side, symbol: o.symbol, makerPha: this.address.pha, makerBase: this.address.base,
      tazTotal: raw(o.total), tazMin: raw(o.min), tazMax: raw(o.max), price: usdcToRaw(o.price!).toString(), makerToken: 'ab'.repeat(32), tokenSource: 'client',
      priceHistory: [], follow: null, acceptOnTheirOwn: o.acceptOnTheirOwn !== false, mode: o.mode ?? 'standard', createdAt: this.clock(), closedAt: null
    };
    this.offers.push(rec);
    return rec;
  }
  async cancelOffer(id: number) {
    this.#call('cancelOffer', id);
    const o = this.offers.find((x) => x.id === id);
    if (o) o.closedAt = this.clock();
  }
  async buyUpTo(o: unknown) { this.#call('buyUpTo', o); return []; }
  async sellDownTo(o: unknown) { this.#call('sellDownTo', o); return []; }
  async run(policy?: Policy, signal?: AbortSignal) {
    this.#call('run');
    this.policy = policy;
    this.running = true;
    await new Promise<void>((r) => { if (!signal || signal.aborted) r(); else signal.addEventListener('abort', () => r(), { once: true }); });
    if (this.windDownMs > 0) await this.sleep(this.windDownMs);
    this.#call('ended');
    this.running = false;
  }
  async close() {
    this.#call('close');
    assert.equal(this.running, false, 'close() only once run() has ended');
  }
}

const SELL = { symbol: 'TAZ', total: '30', min: '1', max: '5', price: '1.08' };

interface World {
  vt: VTime; fleet: Fleet;
  /**
   * `alarms`: every time the alarm was set, in order. `failAlarms`: the next so many setAlarm calls fail. `puts`: every
   * key written to the key-value storage, in order. `failPuts`: the next so many writes of the key named fail.
   */
  host: FleetHost & { alarmAt: number | null; lines: string[]; alarms: number[]; failAlarms: number; puts: string[]; failPuts: { key: string; times: number } | null };
  kits: Map<string, FakeKit>; opts: HostedKitOptions[]; failNext: Error[];
  db: DatabaseSync; kvMap: Map<string, unknown>;
  /**
   * Cuts this world off in the middle of whatever it does, as a deploy cuts an object off: nothing of it runs on
   * (none of its waits ever ends, its kits' among them), and whatever of it still reached for the storage or the
   * alarm would throw, as it does for an object that was reset. Its storage and its alarm stay:
   * `world(bots, env, w)` is the object after it.
   */
  cut(): void;
}

/** A fleet on a fake Durable Object. `bots` is bots.json; `env` its vars and secrets; `redeployOf`: the same object's storage, after a deploy. */
function world(bots: Record<string, unknown>, env: Record<string, unknown> = {}, redeployOf?: World): World {
  const vt = redeployOf?.vt ?? new VTime();
  const db = redeployOf?.db ?? new DatabaseSync(':memory:');
  const kv = redeployOf?.kvMap ?? new Map<string, unknown>();
  const kits = redeployOf?.kits ?? new Map<string, FakeKit>();
  const opts: HostedKitOptions[] = [];
  const failNext: Error[] = [];
  let cutOff = false;
  const never = new Promise<void>(() => {});
  /** An object that was reset reaches its storage no more: a test in which it tries fails loudly. */
  const alive = () => { if (cutOff) throw new Error('this object was cut off: it reaches its storage no more'); };
  const host = {
    alarmAt: null as number | null,
    lines: [] as string[],
    alarms: [] as number[],
    failAlarms: 0,
    puts: [] as string[],
    failPuts: null as { key: string; times: number } | null,
    sql: { exec: (q: string, ...b: Array<string | number | null>) => { alive(); const rows = db.prepare(q).all(...b); return { toArray: () => rows }; } },
    kv: {
      get: (k: string) => { alive(); return kv.has(k) ? structuredClone(kv.get(k)) : undefined; },
      put: (k: string, v: unknown) => {
        alive();
        if (host.failPuts && host.failPuts.key === k && host.failPuts.times > 0) { host.failPuts.times--; throw new Error('the storage did not take the write'); }
        host.puts.push(k);
        kv.set(k, structuredClone(v));
      },
      delete: (k: string) => { alive(); return kv.delete(k); },
      keys: (prefix: string) => { alive(); return [...kv.keys()].filter((k) => k.startsWith(prefix)).sort(); }
    },
    setAlarm(at: number) {
      alive();
      if (this.failAlarms > 0) { this.failAlarms--; throw new Error('the storage did not answer'); }
      this.alarms.push(at);
      this.alarmAt = at;
    },
    getAlarm() { alive(); return this.alarmAt; },
    deleteAlarm() { alive(); this.alarmAt = null; },
    env: { CONTROL_TOKEN: 'c'.repeat(40), KIT_ALLOW_MAINNET: '0', MARKET_PHA_KEY: '{"wif":"x"}', MARKET_BASE_KEY: '{"privateKey":"y"}', ...env },
    async makeKit(o: HostedKitOptions): Promise<FleetKit> {
      opts.push(o);
      const failure = failNext.shift();
      if (failure) throw failure;
      const name = (o.store as unknown as { where: string }).where.replace(/^durable-object:/, '').split('/')[0]!;
      let k = kits.get(name);
      if (!k) { k = new FakeKit(vt.now, o.network, (ms) => host.sleep(ms)); kits.set(name, k); }
      return k as unknown as FleetKit;
    },
    now: vt.now,
    sleep: (ms: number, signal?: AbortSignal): Promise<void> => (cutOff ? never : vt.sleep(ms, signal).then(() => (cutOff ? never : undefined))),
    print(line: string) { this.lines.push(line); }
  };
  if (redeployOf) host.alarmAt = redeployOf.host.alarmAt;
  // The kits of the object before this one are this one's now: what they wait for from here on is this world's.
  for (const k of kits.values()) k.sleep = (ms) => host.sleep(ms);
  const fleet = new Fleet(host, loadBots(bots));
  const cut = () => {
    cutOff = true;
    // Its kits' run() ended with it, without a word.
    for (const k of kits.values()) k.running = false;
  };
  return { vt, fleet, host, kits, opts, failNext, db, kvMap: kv, cut };
}

const devnetBot = (o: Record<string, unknown> = {}) => ({ network: 'devnet', offers: [SELL], ...o });
const mainnetBot = (o: Record<string, unknown> = {}) => ({ network: 'mainnet', offers: [SELL], ...o });

/** Run one alarm while virtual time moves on: the session's whole length, and a little more. */
async function session(w: World, ms = SESSION_MS + 5_000): Promise<void> {
  const a = w.fleet.alarm();
  await w.vt.advance(ms);
  await a;
}

describe('bots.json', () => {
  test('bot names and their configs, each checked as a hosted config; a bad one is kept with its error', () => {
    const ok = loadBots({ market: mainnetBot(), 'dev-seller': devnetBot() });
    assert.equal(ok.error, null);
    assert.deepEqual(ok.list.map((b) => [b.name, b.prefix, b.error]), [['market', 'MARKET', null], ['dev-seller', 'DEV_SELLER', null]]);
    assert.match(loadBots({ Market: devnetBot() }).error!, /not a bot name/);
    assert.match(loadBots([]).error!, /JSON object/);
    assert.match(loadBots({}).error!, /names no bot/);
    const bad = loadBots({ market: { ...mainnetBot(), keys: { pha: 'a', base: 'b' } } });
    assert.equal(bad.error, null);
    assert.match(bad.list[0]!.error!, /"keys", which names a file/);
    // Whether a config can be used never depends on the secrets: npm run check-config and the Worker agree.
    const instant = { network: 'devnet', offers: [{ ...SELL, mode: 'instant' }] };
    assert.equal(loadBots({ seller: instant }).list[0]!.error, null);
  });

  test('the BOTS_CONFIG secret: not set, not JSON, or the bots of bots.json', () => {
    assert.match(loadBotsConfig(undefined).error!, /BOTS_CONFIG secret is not set.*npm run deploy/);
    assert.match(loadBotsConfig('  ').error!, /not set/);
    assert.match(loadBotsConfig('{"market": ').error!, /BOTS_CONFIG secret is not JSON/);
    const ok = loadBotsConfig(JSON.stringify({ market: mainnetBot() }));
    assert.equal(ok.error, null);
    assert.deepEqual(ok.list.map((b) => [b.name, b.error]), [['market', null]]);
  });

  test('an instant offer needs the bot\'s API key secret: without it the start is refused, as for a missing key', async () => {
    const w = world({ seller: { network: 'devnet', offers: [{ ...SELL, mode: 'instant' }] } }, { SELLER_PHA_KEY: '{}', SELLER_BASE_KEY: '{}' });
    const r = await w.fleet.start('seller');
    assert.equal(r.status, 409);
    assert.match(String(r.body.error), /Set the secret SELLER_API_KEY first: an instant offer needs an API key/);
    assert.match(String((w.fleet.status().body.bots as Array<{ secrets: string }>)[0]!.secrets), /SELLER_API_KEY/);
    const w2 = world({ seller: { network: 'devnet', offers: [{ ...SELL, mode: 'instant' }] } }, { SELLER_PHA_KEY: '{}', SELLER_BASE_KEY: '{}', SELLER_API_KEY: 'sat_y' });
    assert.equal((await w2.fleet.start('seller')).status, 200);
  });
});

describe('start: the gates, then running', () => {
  test('a mainnet bot needs its start\'s yes and KIT_ALLOW_MAINNET, as npm run market needs --mainnet and KIT_ALLOW_MAINNET=1', async () => {
    const w = world({ market: mainnetBot() });
    assert.equal((await w.fleet.start('market')).status, 409);
    assert.match(String((await w.fleet.start('market')).body.error), /\{"mainnet": true\}/);
    const r = await w.fleet.start('market', { mainnet: true });
    assert.equal(r.status, 409);
    assert.match(String(r.body.error), /KIT_ALLOW_MAINNET = "1"/);
    assert.equal(w.opts.length, 0, 'nothing built, nothing read');
    const w2 = world({ market: mainnetBot() }, { KIT_ALLOW_MAINNET: '1' });
    const ok = await w2.fleet.start('market', { mainnet: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(w2.opts[0]!.allowMainnet, true);
    assert.deepEqual(w2.opts[0]!.env, { KIT_ALLOW_MAINNET: '1' });
    assert.equal(w2.host.alarmAt, T0 + NEXT_MS, 'its first session within a second');
    // A devnet bot refuses the mainnet yes.
    const w3 = world({ seller: devnetBot() }, { SELLER_PHA_KEY: '{}', SELLER_BASE_KEY: '{}' });
    assert.match(String((await w3.fleet.start('seller', { mainnet: true })).body.error), /config is for devnet/);
  });

  test('missing secrets, a failed preflight item and an unknown bot refuse the start; nothing runs', async () => {
    const w = world({ seller: devnetBot() });
    const r = await w.fleet.start('seller');
    assert.equal(r.status, 409);
    assert.match(String(r.body.error), /SELLER_PHA_KEY and SELLER_BASE_KEY/);
    assert.equal((await w.fleet.start('nobody')).status, 404);
    const w2 = world({ market: devnetBot() });
    const kit = new FakeKit(w2.vt.now, 'devnet');
    kit.preflightItems = [{ name: 'board', ok: false, text: 'P2P is off on devnet at this board.' }];
    w2.kits.set('market', kit);
    const b = await w2.fleet.start('market');
    assert.equal(b.status, 409);
    assert.deepEqual(b.body.blocking, ['board']);
    assert.ok((b.body.lines as string[]).some((l) => /preflight FAIL board: P2P is off/.test(l)));
    assert.equal(w2.host.alarmAt, null);
    assert.equal(w2.fleet.status().body.bots instanceof Array && (w2.fleet.status().body.bots as Array<{ mode: string }>)[0]!.mode, 'stopped');
    assert.equal(kit.count('close'), 1, 'the preflight\'s kit closed');
  });

  test('the kit it builds: keys from the secrets, the store in the object\'s SQLite under the bot\'s name, no long-polls', async () => {
    const w = world({ market: devnetBot() }, { MARKET_API_KEY: '  sat_abc  ', MARKET_STORE_KEY: 'ab'.repeat(32) + '\n' });
    assert.equal((await w.fleet.start('market')).status, 200);
    const o = w.opts[0]!;
    assert.deepEqual(o.keys, { pha: '{"wif":"x"}', base: '{"privateKey":"y"}', names: { pha: 'MARKET_PHA_KEY', base: 'MARKET_BASE_KEY' } });
    assert.equal(o.store.where, 'durable-object:market/devnet');
    assert.equal(o.storeKey, 'ab'.repeat(32));
    assert.equal(o.apiKey, '  sat_abc  ', 'trimmed by the kit');
    assert.equal(o.internals?.pollWaitS, 0);
    assert.deepEqual(o.internals?.argv, []);
    assert.equal(o.allowMainnet, undefined);
  });
});

describe('sessions: an alarm runs every running bot for SESSION_MS, then sets the next', () => {
  test('a session lists the offers and runs run(); its end is a pause (nothing cancelled); the next session lists nothing twice', async () => {
    const w = world({ market: devnetBot() });
    await w.fleet.start('market');
    const a = w.fleet.alarm();
    await w.vt.advance(1_000);
    assert.equal(w.host.alarmAt, T0 + DEADMAN_MS, 'the backstop alarm, set as the session starts');
    const kit = w.kits.get('market')!;
    assert.equal(kit.count('postOffer'), 1);
    assert.equal(kit.running, true);
    assert.equal(w.fleet.status().body.bots instanceof Array && (w.fleet.status().body.bots as Array<{ sessionRunning: boolean }>)[0]!.sessionRunning, true);
    await w.vt.advance(SESSION_MS + 5_000);
    await a;
    assert.equal(kit.running, false, 'run() ended with the session');
    assert.equal(kit.count('cancelOffer'), 0, 'a pause cancels nothing');
    assert.ok(w.host.alarmAt !== null && w.host.alarmAt <= w.vt.now() + NEXT_MS, 'the next session within a second of this one\'s end');
    await session(w);
    assert.equal(kit.count('postOffer'), 1, 'its offer is still listed: nothing posted twice');
    assert.equal(kit.count('run'), 2);
    assert.equal(kit.count('close'), 3, 'the preflight\'s kit and each session\'s kit closed');
    const st = w.fleet.status().body.bots as Array<Record<string, unknown>>;
    assert.deepEqual(st[0]!.openOffers, [1]);
    assert.equal(st[0]!.mode, 'running');
  });

  test('sizeFromBalances: one look at the balances per sizeEveryS, however many sessions; a changed offer, turning it off and on, and a start look at once; status says when', async () => {
    const SIZED = { offers: [SELL], sizeFromBalances: true, sizeEveryS: 3_600 };
    const totals = (kit: FakeKit) => kit.calls.filter((c) => c.fn === 'postOffer').map((c) => (c.arg as OfferInput).total);
    const w = world({ market: devnetBot(SIZED) });
    await w.fleet.start('market');
    const kit = w.kits.get('market')!;
    kit.tokens.set('TAZ', tokenToRaw('TAZ', '12.345'));
    assert.equal(w.kvMap.has('size:market'), false);
    assert.deepEqual((w.fleet.status().body.bots as Array<Record<string, unknown>>)[0]!.sizing, { everyS: 3_600, lastLookAt: null, nextLookAt: null, lastLook: null }, 'no look yet: its next session looks');
    await session(w);
    assert.deepEqual(totals(kit), ['12.34'], 'listed at what it holds, under the config\'s 30');
    assert.equal(kit.reads.balances, 1);
    const kept = w.kvMap.get('size:market') as { of: string; at: number; lookedAt: number; said: string };
    assert.equal(kept.said, 'Sized the offers from the balances: 1 listed. The next look is in 3600 s.');
    assert.equal(kept.at, kept.lookedAt, 'a look that decided everything counts from its own time');
    // Eight more sessions, 55 minutes in all: the look is not due, and no session reads a balance at its start.
    for (let i = 0; i < 8; i++) await session(w);
    assert.equal(kit.count('run'), 9);
    assert.deepEqual(kit.reads, { balances: 1, readFunds: 0, heartbeat: 0 }, 'nine sessions, one look');
    const st = (w.fleet.status().body.bots as Array<Record<string, unknown>>)[0]!;
    assert.deepEqual(st.sizing, { everyS: 3_600, lastLookAt: new Date(kept.lookedAt).toISOString(), nextLookAt: new Date(kept.lookedAt + 3_600_000).toISOString(), lastLook: kept.said });
    assert.deepEqual(st.offers, ['at most sell 30 TAZ (1 to 5 per trade) at 1.08 mUSDC'], 'the config\'s total is the most it lists');
    assert.deepEqual(st.listedOffers, ['#1 sell 12.34 TAZ'], 'and status says what is listed');
    assert.deepEqual(st.openOffers, [1]);
    // The balance fell meanwhile. Once the hour is over the look comes, once, and the offer is listed again at what the bot holds.
    kit.tokens.set('TAZ', tokenToRaw('TAZ', '8'));
    for (let i = 0; i < 3; i++) await session(w);
    assert.equal(kit.reads.balances, 2);
    assert.deepEqual(totals(kit), ['12.34', '8']);
    assert.equal(kit.count('cancelOffer'), 1);
    assert.ok((w.kvMap.get('size:market') as { lookedAt: number }).lookedAt >= kept.lookedAt + 3_600_000);
    // A deploy with another total: what was kept is for another config, so the next session looks at once.
    const w2 = world({ market: devnetBot({ ...SIZED, offers: [{ ...SELL, total: '40' }] }) }, {}, w);
    assert.deepEqual((w2.fleet.status().body.bots as Array<Record<string, unknown>>)[0]!.sizing, { everyS: 3_600, lastLookAt: null, nextLookAt: null, lastLook: null });
    await session(w2);
    assert.equal(kit.reads.balances, 3);
    assert.deepEqual(totals(kit), ['12.34', '8'], 'the offer at 8 TAZ is still its entry: nothing listed again');
    // A deploy with the same config: nothing is read.
    const w3 = world({ market: devnetBot({ ...SIZED, offers: [{ ...SELL, total: '40' }] }) }, {}, w2);
    await session(w3);
    assert.equal(kit.reads.balances, 3);
    // Turned off: nothing is kept (and the offer goes back to the config's total, whatever the bot holds).
    const w4 = world({ market: devnetBot({ offers: [{ ...SELL, total: '40' }] }) }, {}, w3);
    await session(w4);
    assert.equal(w4.kvMap.has('size:market'), false);
    assert.deepEqual(totals(kit), ['12.34', '8', '40']);
    assert.equal((w4.fleet.status().body.bots as Array<Record<string, unknown>>)[0]!.sizing, undefined);
    // Turned on again: it looks at once, though the last look was minutes ago.
    const w5 = world({ market: devnetBot({ ...SIZED, offers: [{ ...SELL, total: '40' }] }) }, {}, w4);
    const before = kit.reads.balances;
    await session(w5);
    assert.equal(kit.reads.balances, before + 1);
    assert.deepEqual(totals(kit), ['12.34', '8', '40', '8']);
    assert.equal(w5.kvMap.has('size:market'), true);
    // A halt, then a start: the start forgets the last look, so its first session looks (whatever moved meanwhile).
    await w5.fleet.halt('market');
    const halted = (w5.fleet.status().body.bots as Array<{ sizing: { lastLookAt: string | null; nextLookAt: string | null } }>)[0]!.sizing;
    assert.ok(halted.lastLookAt !== null && halted.nextLookAt === null, 'a bot that does not run names no next look');
    assert.equal((await w5.fleet.start('market')).status, 200);
    assert.equal(w5.kvMap.has('size:market'), false);
    const read = kit.reads.balances;
    await session(w5);
    assert.equal(kit.reads.balances, read + 1);
  });

  test('a recurring order keeps its time across sessions: no early take when a session starts', async () => {
    const w = world({ market: devnetBot({ take: { symbol: 'TAZ', amount: '2', maxPrice: '1.10', everyS: 3_600 } }) });
    await w.fleet.start('market');
    await session(w);
    const kit = w.kits.get('market')!;
    assert.equal(kit.count('buyUpTo'), 1, 'the first order, in the first session');
    for (let i = 0; i < 4; i++) await session(w);
    assert.equal(kit.count('buyUpTo'), 1, 'five sessions later (30 minutes), not due yet');
    for (let i = 0; i < 6; i++) await session(w);
    assert.equal(kit.count('buyUpTo'), 2, 'an hour after the first');
  });

  test('stop: the running session cancels the offers and, once every trade has finished, the bot is stopped and no alarm is left', async () => {
    const w = world({ market: devnetBot() });
    await w.fleet.start('market');
    const kit = w.kits.get('market') ?? new FakeKit(w.vt.now, 'devnet');
    const a = w.fleet.alarm();
    await w.vt.advance(1_000);
    const k = w.kits.get('market')!;
    k.trades = [{ id: 7, status: 'pha_locked' } as unknown as LocalTrade];
    const r = await w.fleet.stop('market');
    assert.equal(r.body.mode, 'stopping');
    await w.vt.advance(10_000);
    assert.equal(k.count('cancelOffer'), 1, 'its offer cancelled at once');
    assert.equal(await k.policy!.accept!({} as Trade, { offer: {} as LocalOffer, checks: { ok: true } }), false, 'no take accepted while stopping');
    await w.vt.advance(SESSION_MS);
    await a;
    assert.equal((w.fleet.status().body.bots as Array<{ mode: string }>)[0]!.mode, 'stopping', 'a trade still runs: still stopping');
    assert.notEqual(w.host.alarmAt, null, 'so the sessions go on');
    // The next session finishes it.
    const b = w.fleet.alarm();
    await w.vt.advance(20_000);
    k.trades = [{ id: 7, status: 'done', endedAt: w.vt.now() } as unknown as LocalTrade];
    await w.vt.advance(20_000);
    await b;
    const st = (w.fleet.status().body.bots as Array<{ mode: string; note: string }>)[0]!;
    assert.equal(st.mode, 'stopped');
    assert.match(st.note, /Stopped cleanly/);
    assert.equal(w.host.alarmAt, null, 'no alarm while every bot is stopped');
    assert.equal(k.count('postOffer'), 1, 'never listed again');
    void kit;
  });

  test('halt: the session ends at once, nothing is cancelled, the bot is stopped', async () => {
    const w = world({ market: devnetBot() });
    await w.fleet.start('market');
    const a = w.fleet.alarm();
    await w.vt.advance(1_000);
    const k = w.kits.get('market')!;
    k.trades = [{ id: 9, status: 'base_locked' } as unknown as LocalTrade];
    const r = await w.fleet.halt('market');
    assert.equal(r.body.mode, 'stopped');
    assert.match(String(r.body.note), /start it again soon/);
    await w.vt.advance(5_000);
    await a;
    assert.equal(k.running, false);
    assert.equal(k.count('cancelOffer'), 0);
    assert.equal(w.host.alarmAt, null);
    assert.equal((await w.fleet.halt('market')).body.note, 'It is stopped.');
    // Started again, it resumes: the same store (the fake kit's offers), no offer posted twice.
    assert.equal((await w.fleet.start('market')).status, 200);
    await session(w);
    assert.equal(k.count('postOffer'), 1);
  });

  test('a session that cannot start waits 60 s, then twice as long after each failure; a session that runs clears the wait', async () => {
    const w = world({ market: devnetBot() });
    await w.fleet.start('market');
    w.failNext.push(new Error('Could not read the Base RPC\'s chain id.'), new Error('again'));
    await session(w, 1_000);
    let st = (w.fleet.status().body.bots as Array<Record<string, unknown>>)[0]!;
    assert.equal(st.mode, 'running', 'its state does not change');
    assert.equal(st.failures, 1);
    assert.match(String(st.lastError), /chain id/);
    assert.equal(w.host.alarmAt, w.vt.now() - 1_000 + BACKOFF_MS, 'the next try in 60 s');
    await w.vt.advance(BACKOFF_MS);
    await session(w, 1_000);
    st = (w.fleet.status().body.bots as Array<Record<string, unknown>>)[0]!;
    assert.equal(st.failures, 2);
    assert.equal(w.host.alarmAt, w.vt.now() - 1_000 + 2 * BACKOFF_MS);
    // An alarm that comes before the wait is over runs nothing for it.
    const built = w.opts.length;
    await session(w, 1_000);
    assert.equal(w.opts.length, built, 'no kit built before the wait is over');
    await w.vt.advance(2 * BACKOFF_MS);
    await session(w);
    st = (w.fleet.status().body.bots as Array<Record<string, unknown>>)[0]!;
    assert.equal(st.failures, undefined, 'cleared by a session that ran');
    assert.equal(st.lastError, undefined);
    assert.ok(w.host.lines.some((l) => /This session could not run: Could not read the Base RPC/.test(l)));
  });

  test('two bots in one session; a bot started while a session runs joins it; stopping one leaves the other running', async () => {
    const w = world({ seller: devnetBot(), buyer: devnetBot({ offers: [], bids: [SELL] }) },
      { SELLER_PHA_KEY: '{}', SELLER_BASE_KEY: '{}', BUYER_PHA_KEY: '{}', BUYER_BASE_KEY: '{}' });
    await w.fleet.start('seller');
    const a = w.fleet.alarm();
    await w.vt.advance(10_000);
    assert.equal(w.kits.get('buyer'), undefined);
    await w.fleet.start('buyer');
    await w.vt.advance(JOIN_POLL_MS + 1_000);
    assert.equal(w.kits.get('buyer')!.running, true, 'the buyer joined the running session');
    await w.fleet.stop('seller');
    await w.vt.advance(10_000);
    assert.equal(w.kits.get('seller')!.running, false, 'the seller stopped (no trade to finish)');
    assert.equal(w.kits.get('buyer')!.running, true, 'the buyer runs on');
    await w.vt.advance(SESSION_MS);
    await a;
    const modes = Object.fromEntries((w.fleet.status().body.bots as Array<{ name: string; mode: string }>).map((b) => [b.name, b.mode]));
    assert.deepEqual(modes, { seller: 'stopped', buyer: 'running' });
    assert.notEqual(w.host.alarmAt, null);
  });

  test('wake (the cron): an alarm for a running bot when none is set; none while every bot is stopped', async () => {
    const w = world({ market: devnetBot() });
    await w.fleet.wake();
    assert.equal(w.host.alarmAt, null);
    await w.fleet.start('market');
    w.host.alarmAt = null;
    await w.fleet.wake();
    assert.equal(w.host.alarmAt, T0 + NEXT_MS);
    w.host.alarmAt = T0 + 999_999;
    await w.fleet.wake();
    assert.equal(w.host.alarmAt, T0 + 999_999, 'an alarm already set is left as it is');
  });
});

describe('the watchdog: an alarm at work keeps the alarm ahead of itself, so a session cut off is soon followed', () => {
  const ahead = (w: World) => w.host.alarmAt! - w.vt.now();
  const cutLines = (w: World) => w.host.lines.filter((l) => /was cut off in the middle of a session/.test(l));

  test('the alarm is moved on every WATCH_EVERY_MS and is never more than DEADMAN_MS ahead; the session\'s end sets the next one', async () => {
    const w = world({ market: devnetBot() });
    await w.fleet.start('market');
    const a = w.fleet.alarm();
    await w.vt.advance(1_000);
    assert.equal(w.host.alarmAt, T0 + DEADMAN_MS);
    assert.deepEqual(w.kvMap.get('work'), { cuts: 0 }, 'its note, in storage while it is at work');
    for (let t = 1_000; t + 3_000 < SESSION_MS; t += 3_000) {
      await w.vt.advance(3_000);
      assert.ok(ahead(w) <= DEADMAN_MS, 'never further ahead than DEADMAN_MS');
      assert.ok(ahead(w) > DEADMAN_MS - WATCH_EVERY_MS - JOIN_POLL_MS, `never left behind (${ahead(w)} ms ahead)`);
    }
    // One move per WATCH_EVERY_MS, not one per turn of its loop: each is a write to the object's storage.
    const moves = w.host.alarms.filter((at) => at > T0 + DEADMAN_MS).length;
    assert.ok(moves >= SESSION_MS / WATCH_EVERY_MS - 2 && moves <= SESSION_MS / WATCH_EVERY_MS, `${moves} moves in one session`);
    // The start's alarm, the alarm's first, then one every WATCH_EVERY_MS.
    assert.deepEqual(w.host.alarms.slice(0, 5), [T0 + NEXT_MS, ...[0, 1, 2, 3].map((i) => T0 + i * WATCH_EVERY_MS + DEADMAN_MS)]);
    await w.vt.advance(10_000);
    await a;
    assert.ok(w.host.alarmAt !== null && w.host.alarmAt <= w.vt.now() + NEXT_MS, 'the next session within a second of this one\'s end');
    assert.equal(w.kvMap.has('work'), false, 'its note is gone: it reached its end');
    assert.equal(cutLines(w).length, 0);
    assert.equal(w.host.puts.filter((k) => k === 'work').length, 1, 'the note is written once: an alarm that follows no cut has no count to set back');
  });

  test('a session cut off (a deploy) is followed by the next within DEADMAN_MS: nothing is listed twice, and its lines say what happened', async () => {
    const bots = { market: devnetBot() };
    const w = world(bots);
    await w.fleet.start('market');
    void w.fleet.alarm();
    await w.vt.advance(95_000);
    const kit = w.kits.get('market')!;
    assert.equal(kit.count('postOffer'), 1);
    assert.equal(kit.running, true);
    // The cut: the object is gone in the middle of its session. Its storage stays, and the alarm in it.
    w.cut();
    const cutAt = w.vt.now();
    const w2 = world(bots, {}, w);
    assert.ok(w2.host.alarmAt! > cutAt + DEADMAN_MS - WATCH_EVERY_MS - JOIN_POLL_MS && w2.host.alarmAt! <= cutAt + DEADMAN_MS, 'the alarm in storage: at most DEADMAN_MS after the cut');
    await w2.vt.advance(w2.host.alarmAt! - cutAt);
    const b = w2.fleet.alarm();
    await w2.vt.advance(1_000);
    assert.equal(kit.count('run'), 2, 'the next session runs the bot again');
    assert.equal(kit.running, true);
    assert.equal(kit.count('postOffer'), 1, 'its offer is still listed: nothing posted twice');
    assert.equal(kit.count('cancelOffer'), 0);
    assert.equal(cutLines(w2).length, 1);
    assert.match(cutLines(w2)[0]!, /^\[market\] \S+ \[market\] The object was cut off in the middle of a session \(a deploy, or Cloudflare restarting it\): this session takes over\.$/);
    assert.equal(ahead(w2), DEADMAN_MS - 1_000, 'and it keeps its own watchdog, as long as the first');
    assert.deepEqual(w2.kvMap.get('work'), { cuts: 1 });
    await w2.vt.advance(PROVEN_MS - 3_000);
    assert.deepEqual(w2.kvMap.get('work'), { cuts: 1 }, 'still counted two seconds before it has run for PROVEN_MS');
    await w2.vt.advance(2_000);
    assert.deepEqual(w2.kvMap.get('work'), { cuts: 0 }, 'it has run for PROVEN_MS: the count starts again');
    assert.equal(w2.host.lines.filter((l) => /No cut for/.test(l)).length, 0, 'its watchdog was short all along: nothing to say');
    await w2.vt.advance(SESSION_MS + 5_000 - PROVEN_MS);
    await b;
    assert.equal(w2.kvMap.has('work'), false);
    // The session after it follows one that reached its end: it has nothing to say.
    await session(w2);
    assert.equal(cutLines(w2).length, 1);
    assert.equal(kit.count('run'), 3);
    assert.equal(kit.count('postOffer'), 1);
    assert.equal(w.host.alarms.length < 12, true, 'the object that was cut off set no alarm after its cut');
  });

  test('sessions cut off one after another come further apart, up to DEADMAN_MAX_MS; one that reaches its end clears the count', async () => {
    const bots = { market: devnetBot() };
    let w = world(bots);
    await w.fleet.start('market');
    const aheads: number[] = [];
    for (let i = 0; i < 10; i++) {
      void w.fleet.alarm();
      await w.vt.advance(1_000);
      aheads.push(ahead(w) + 1_000);
      // An alarm that came while this one is at work would move the watchdog on by the same distance, and no more.
      await w.fleet.alarm();
      assert.equal(ahead(w), aheads[i]);
      // Its moves keep that distance.
      await w.vt.advance(25_000);
      assert.ok(ahead(w) <= aheads[i]! && ahead(w) > aheads[i]! - WATCH_EVERY_MS - JOIN_POLL_MS, `alarm ${i}: ${ahead(w)} ms ahead`);
      w.cut();
      w = world(bots, {}, w);
    }
    const D = DEADMAN_MS;
    assert.equal(CUTS_IN_A_ROW, 3);
    assert.deepEqual(aheads, [D, D, D, 2 * D, 4 * D, 8 * D, 16 * D, DEADMAN_MAX_MS, DEADMAN_MAX_MS, DEADMAN_MAX_MS]);
    assert.equal(DEADMAN_MAX_MS > 15 * 60_000, true, 'past an alarm\'s 15 minutes');
    // The eleventh reaches its end.
    const a = w.fleet.alarm();
    await w.vt.advance(1_000);
    assert.equal(ahead(w) + 1_000, DEADMAN_MAX_MS);
    assert.match(cutLines(w)[0]!, /\[market\] The object was cut off in the middle of a session 10 times in a row: this session takes over\. Should it be cut off within the next 60 s too, the next session starts only within 930 s of that; after them, within 30 s again\.$/);
    await w.vt.advance(SESSION_MS + 5_000);
    await a;
    assert.ok(w.host.alarmAt !== null && w.host.alarmAt <= w.vt.now() + NEXT_MS);
    const b = w.fleet.alarm();
    await w.vt.advance(1_000);
    assert.equal(ahead(w) + 1_000, D, 'the count is cleared: the watchdog is short again');
    assert.equal(cutLines(w).length, 1);
    await w.vt.advance(SESSION_MS + 5_000);
    await b;
  });

  test('an alarm that has been at work for PROVEN_MS sets the count back: its long watchdog is short again at that very turn, and it says so', async () => {
    const bots = { market: devnetBot() };
    let w = world(bots);
    await w.fleet.start('market');
    // Four alarms cut off one after another, each 20 s in.
    for (let i = 0; i < 4; i++) {
      void w.fleet.alarm();
      await w.vt.advance(20_000);
      w.cut();
      w = world(bots, {}, w);
    }
    const startedAt = w.vt.now();
    void w.fleet.alarm();
    await w.vt.advance(1_000);
    assert.equal(ahead(w) + 1_000, 4 * DEADMAN_MS);
    assert.deepEqual(w.kvMap.get('work'), { cuts: 4 });
    assert.match(cutLines(w)[0]!, /The object was cut off in the middle of a session 4 times in a row: this session takes over\. Should it be cut off within the next 60 s too, the next session starts only within 120 s of that; after them, within 30 s again\.$/);
    const proven = (x: World) => x.host.lines.filter((l) => /No cut for/.test(l));
    // Two moves fail (at 10 s and 12 s), so the moves that follow come at 14 s, 24 s, ... 54 s, 64 s: none at 60 s.
    await w.vt.advance(8_000);
    w.host.failAlarms = 2;
    await w.vt.advance(6_000);
    assert.equal(w.host.alarmAt, startedAt + 14_000 + 4 * DEADMAN_MS);
    await w.vt.advance(PROVEN_MS - 3_000 - 14_000 - 4_000);
    assert.deepEqual(w.kvMap.get('work'), { cuts: 4 }, 'six seconds before PROVEN_MS it still counts');
    assert.ok(ahead(w) > 4 * DEADMAN_MS - WATCH_EVERY_MS - JOIN_POLL_MS, 'with its long watchdog');
    assert.equal(proven(w).length, 0);
    await w.vt.advance(4_000);
    assert.deepEqual(w.kvMap.get('work'), { cuts: 4 }, 'and two seconds before it');
    assert.equal(proven(w).length, 0);
    await w.vt.advance(2_000);
    assert.equal(w.vt.now(), startedAt + PROVEN_MS);
    assert.deepEqual(w.kvMap.get('work'), { cuts: 0 }, 'at PROVEN_MS the count starts again');
    assert.equal(ahead(w), DEADMAN_MS, 'and the alarm is moved to the short distance at that very turn');
    assert.equal(proven(w).length, 1);
    assert.match(proven(w)[0]!, /^\[market\] \S+ \[market\] No cut for 60 s: should the object be cut off now, the next session starts within 30 s again\.$/);
    // It stays short, and says it once.
    for (let i = 0; i < 10; i++) {
      await w.vt.advance(3_000);
      assert.ok(ahead(w) <= DEADMAN_MS && ahead(w) > DEADMAN_MS - WATCH_EVERY_MS - JOIN_POLL_MS, `${ahead(w)} ms ahead`);
    }
    assert.equal(proven(w).length, 1);
    assert.deepEqual(w.kvMap.get('work'), { cuts: 0 });
    assert.equal(w.host.puts.filter((k) => k === 'work').length, 2, 'the note was written twice: at the alarm\'s start, and when the count was set back');
    // An alarm that came meanwhile would move the watchdog on by the short distance too.
    await w.fleet.alarm();
    assert.equal(ahead(w), DEADMAN_MS);
    // Cut off now, it is the first of a new count.
    w.cut();
    const cutAt = w.vt.now();
    w = world(bots, {}, w);
    assert.ok(w.host.alarmAt! > cutAt && w.host.alarmAt! <= cutAt + DEADMAN_MS);
    void w.fleet.alarm();
    await w.vt.advance(1_000);
    assert.deepEqual(w.kvMap.get('work'), { cuts: 1 });
    assert.equal(ahead(w) + 1_000, DEADMAN_MS);
    assert.match(cutLines(w)[0]!, /The object was cut off in the middle of a session \(a deploy, or Cloudflare restarting it\): this session takes over\.$/);
  });

  test('a note that cannot be written when the count is to be set back changes nothing: the sessions run on, and the next turn sets it back', async () => {
    const bots = { market: devnetBot() };
    let w = world(bots);
    await w.fleet.start('market');
    for (let i = 0; i < 4; i++) {
      void w.fleet.alarm();
      await w.vt.advance(20_000);
      w.cut();
      w = world(bots, {}, w);
    }
    let failed: unknown = null;
    const a = w.fleet.alarm().catch((e: unknown) => { failed = e; });
    await w.vt.advance(PROVEN_MS - 1_000);
    w.host.failPuts = { key: 'work', times: 2 };
    await w.vt.advance(1_000);
    assert.deepEqual(w.kvMap.get('work'), { cuts: 4 }, 'the write at 60 s failed');
    assert.ok(ahead(w) > DEADMAN_MS, 'so its watchdog is still the long one');
    assert.equal(w.kits.get('market')!.running, true, 'and its session runs on');
    await w.vt.advance(2_000);
    assert.deepEqual(w.kvMap.get('work'), { cuts: 4 }, 'so did the one at 62 s');
    await w.vt.advance(2_000);
    assert.deepEqual(w.kvMap.get('work'), { cuts: 0 }, 'the one at 64 s is kept');
    assert.equal(ahead(w), DEADMAN_MS);
    assert.equal(w.host.lines.filter((l) => /No cut for/.test(l)).length, 1, 'said once, when it was so');
    assert.equal(failed, null);
    await w.vt.advance(SESSION_MS);
    await a;
    assert.equal(failed, null);
    assert.equal(w.kvMap.has('work'), false);
  });

  test('deploys a few minutes apart are each followed within DEADMAN_MS, however many: each cuts a session that had shown it runs', async () => {
    const bots = { market: devnetBot() };
    /** The object as the platform runs it, until `until`: its alarm fires when it is due, one at a time. */
    const drive = async (x: World, until: number): Promise<void> => {
      let atWork = false;
      while (x.vt.now() < until) {
        if (!atWork && x.host.alarmAt !== null && x.host.alarmAt <= x.vt.now()) {
          atWork = true;
          void x.fleet.alarm().then(() => { atWork = false; });
        }
        await x.vt.advance(1_000);
      }
    };
    let w = world(bots);
    await w.fleet.start('market');
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      await drive(w, w.vt.now() + 5 * 60_000);
      assert.deepEqual(w.kvMap.get('work'), { cuts: 0 }, `deploy ${i + 1} cuts a session that has run for over a minute: nothing is counted`);
      w.cut();
      const cutAt = w.vt.now();
      w = world(bots, {}, w);
      waits.push(w.host.alarmAt! - cutAt);
    }
    assert.ok(waits.every((ms) => ms > 0 && ms <= DEADMAN_MS), `the next session after each of 8 deploys: ${waits.map((ms) => ms / 1000).join(', ')} s`);
    const kit = w.kits.get('market')!;
    assert.equal(kit.count('run'), 8, 'one session per deploy so far');
    assert.equal(kit.count('postOffer'), 1, 'and its offer was listed once');
    await drive(w, w.vt.now() + 60_000);
    assert.equal(kit.count('run'), 9);
    assert.match(cutLines(w)[0]!, /The object was cut off in the middle of a session \(a deploy/);
  });

  test('the second cut in a row says so; its watchdog is as short as ever, so it says no more', async () => {
    const bots = { market: devnetBot() };
    let w = world(bots);
    await w.fleet.start('market');
    for (let i = 0; i < 2; i++) {
      void w.fleet.alarm();
      await w.vt.advance(40_000);
      w.cut();
      w = world(bots, {}, w);
    }
    void w.fleet.alarm();
    await w.vt.advance(1_000);
    assert.match(cutLines(w)[0]!, /\[market\] The object was cut off in the middle of a session 2 times in a row: this session takes over\.$/);
    assert.equal(ahead(w) + 1_000, DEADMAN_MS);
  });

  test('the watchdog is kept after the session\'s end too: through a last step of five minutes, and through an extra session\'s own last step', async () => {
    const held = (w: World, when: string) => assert.ok(ahead(w) <= DEADMAN_MS && ahead(w) > DEADMAN_MS - WATCH_EVERY_MS - JOIN_POLL_MS, `${when}: ${ahead(w)} ms ahead at +${w.vt.now() - T0} ms`);
    // One bot whose last step takes five minutes: far past the session's end, and past the extra sessions' time.
    const one = world({ market: devnetBot() });
    await one.fleet.start('market');
    const a = one.fleet.alarm();
    await one.vt.advance(1_000);
    one.kits.get('market')!.windDownMs = 5 * 60_000;
    let done = false;
    void a.then(() => { done = true; });
    await one.vt.advance(SESSION_MS - 1_000);
    for (let t = 0; t + 3_000 < 5 * 60_000; t += 3_000) {
      await one.vt.advance(3_000);
      assert.equal(done, false, 'the alarm is still at work');
      held(one, 'a last step');
    }
    assert.ok(one.vt.now() > T0 + SESSION_MS + OVERLAP_MS);
    await one.vt.advance(10_000);
    await a;
    assert.ok(one.host.alarmAt !== null && one.host.alarmAt <= one.vt.now() + NEXT_MS);
    assert.equal(one.kvMap.has('work'), false);
    // Two bots: the buyer's session ends, it goes on in an extra session while the seller finishes its last step
    // (90 s), and that extra session then has a last step of its own (60 s more), with no regular session left.
    const two = world({ seller: devnetBot(), buyer: devnetBot({ offers: [], bids: [SELL] }) },
      { SELLER_PHA_KEY: '{}', SELLER_BASE_KEY: '{}', BUYER_PHA_KEY: '{}', BUYER_BASE_KEY: '{}' });
    const t0 = two.vt.now();
    await two.fleet.start('seller');
    await two.fleet.start('buyer');
    const b = two.fleet.alarm();
    await two.vt.advance(5_000);
    two.kits.get('seller')!.windDownMs = 90_000;
    two.kits.get('buyer')!.windDownMs = 60_000;
    let over = false;
    void b.then(() => { over = true; });
    await two.vt.advance(SESSION_MS - 5_000);
    for (let t = 0; t + 3_000 < 150_000; t += 3_000) {
      await two.vt.advance(3_000);
      assert.equal(over, false, `still at work ${t + 3_000} ms after the session's end`);
      assert.ok(ahead(two) <= DEADMAN_MS && ahead(two) > DEADMAN_MS - WATCH_EVERY_MS - JOIN_POLL_MS, `${ahead(two)} ms ahead at +${two.vt.now() - t0} ms`);
    }
    assert.equal(two.kits.get('buyer')!.count('run'), 2, 'the buyer had an extra session');
    await two.vt.advance(10_000);
    await b;
    assert.ok(two.host.alarmAt !== null && two.host.alarmAt <= two.vt.now() + NEXT_MS);
  });

  test('a session cut off while a bot finishes its last step: the next takes over, and nothing of the one cut off runs on', async () => {
    const bots = { market: devnetBot() };
    const w = world(bots);
    await w.fleet.start('market');
    void w.fleet.alarm();
    await w.vt.advance(1_000);
    const kit = w.kits.get('market')!;
    kit.windDownMs = 3 * 60_000;
    await w.vt.advance(SESSION_MS + 20_000);
    assert.equal(kit.running, true, 'its last step is still under way, 21 s after the session\'s end');
    assert.ok(ahead(w) > 0 && ahead(w) <= DEADMAN_MS);
    w.cut();
    const cutAt = w.vt.now();
    const w2 = world(bots, {}, w);
    assert.ok(w2.host.alarmAt! > cutAt && w2.host.alarmAt! <= cutAt + DEADMAN_MS);
    await w2.vt.advance(w2.host.alarmAt! - cutAt);
    const b = w2.fleet.alarm();
    await w2.vt.advance(1_000);
    assert.deepEqual(w2.kvMap.get('work'), { cuts: 1 });
    assert.equal(kit.count('run'), 2);
    assert.equal(kit.count('ended'), 0, 'the run() that was cut off never ended');
    // Long after the last step of the session that was cut off would have ended, nothing of it has happened.
    await w2.vt.advance(4 * 60_000);
    assert.equal(kit.count('ended'), 0);
    assert.equal(kit.running, true);
    assert.deepEqual(w2.kvMap.get('work'), { cuts: 0 }, 'the note is the new alarm\'s own');
    assert.equal(w.host.alarmAt! <= cutAt + DEADMAN_MS, true, 'and the object that was cut off set no alarm after its cut');
    kit.windDownMs = 0;
    await w2.vt.advance(SESSION_MS);
    await b;
    assert.equal(kit.count('ended'), 1);
  });

  test('the kits\' marks of signing flows under way are the instance\'s own: one set for all its kits, a new one for the object after a cut', async () => {
    const bots = { market: devnetBot(), other: devnetBot() };
    const env = { OTHER_PHA_KEY: '{}', OTHER_BASE_KEY: '{}' };
    const w = world(bots, env);
    await w.fleet.start('market');
    assert.equal((await w.fleet.dryRun('other')).status, 200);
    void w.fleet.alarm();
    await w.vt.advance(20_000);
    assert.equal(w.opts.length, 3, 'the start\'s preflight, the dry run and the session each built a kit');
    const marks = w.opts[0]!.internals!.signGuards!;
    assert.ok(marks.busy instanceof Set && marks.claiming instanceof Set);
    assert.ok(w.opts.every((o) => o.internals!.signGuards === marks), 'every kit of the instance has the same marks');
    // A flow under way when the object is cut off leaves its mark in that instance's marks, and only there.
    marks.busy.add('devnet:7');
    w.cut();
    const w2 = world(bots, env, w);
    void w2.fleet.alarm();
    await w2.vt.advance(1_000);
    const next = w2.opts[0]!.internals!.signGuards!;
    assert.notEqual(next, marks, 'the object after the cut has marks of its own');
    assert.equal(next.busy.size + next.claiming.size, 0, 'with nothing under way');
    assert.ok(w2.opts.every((o) => o.internals!.signGuards === next));
  });

  test('a halt in the same turn as an alarm\'s start leaves the alarm to it', async () => {
    const w = world({ seller: devnetBot(), buyer: devnetBot({ offers: [], bids: [SELL] }) },
      { SELLER_PHA_KEY: '{}', SELLER_BASE_KEY: '{}', BUYER_PHA_KEY: '{}', BUYER_BASE_KEY: '{}' });
    await w.fleet.start('seller');
    await w.fleet.start('buyer');
    const a = w.fleet.alarm();
    await w.fleet.halt('buyer');
    assert.equal(w.host.alarmAt, T0 + DEADMAN_MS);
    await w.vt.advance(SESSION_MS + 5_000);
    await a;
    assert.equal(w.kits.get('seller')!.count('run'), 1);
  });

  test('a cut is told to the bots whose session starts with the alarm that follows it, and the short watchdog to those in a session then', async () => {
    const bots = { seller: devnetBot(), buyer: devnetBot({ offers: [], bids: [SELL] }), third: devnetBot() };
    const env = { SELLER_PHA_KEY: '{}', SELLER_BASE_KEY: '{}', BUYER_PHA_KEY: '{}', BUYER_BASE_KEY: '{}', THIRD_PHA_KEY: '{}', THIRD_BASE_KEY: '{}' };
    const of = (x: World, re: RegExp) => x.host.lines.filter((l) => re.test(l)).map((l) => l.slice(0, l.indexOf(']') + 1));
    let w = world(bots, env);
    await w.fleet.start('seller');
    await w.fleet.start('third');
    // Four cuts in a row, 20 s apart. The buyer is never started; the third bot's session fails in the fourth alarm,
    // so it waits a minute before its next try.
    for (let i = 0; i < 4; i++) {
      if (i === 3) w.failNext.push(new Error('the Base RPC does not answer'));
      void w.fleet.alarm();
      await w.vt.advance(20_000);
      w.cut();
      w = world(bots, env, w);
    }
    const st = () => Object.fromEntries((w.fleet.status().body.bots as Array<{ name: string; mode: string; retryAt?: string }>).map((b) => [b.name, b.retryAt ? 'waits' : b.mode]));
    assert.deepEqual(st(), { seller: 'waits', buyer: 'stopped', third: 'running' }, 'the kit that could not be built was the first one asked for: the seller\'s');
    void w.fleet.alarm();
    await w.vt.advance(1_000);
    assert.deepEqual(of(w, /was cut off in the middle of a session 4 times in a row/), ['[third]'], 'the buyer is stopped, and the seller has no session until its wait is over');
    // The seller's wait is over 60 s after its failure, 40 s into this alarm; its kit cannot be built again, so it
    // waits on. At 60 s the watchdog is short again: said to the bot that is in a session, and to no other.
    w.failNext.push(new Error('the Base RPC does not answer'));
    await w.vt.advance(59_000);
    assert.deepEqual(st(), { seller: 'waits', buyer: 'stopped', third: 'running' });
    assert.deepEqual(of(w, /No cut for 60 s/), ['[third]']);
    // Its second wait (two minutes) over, the seller joins the alarm at work: it is told nothing of the cuts, which
    // are no longer what this alarm follows.
    await w.vt.advance(120_000);
    assert.equal(w.kits.get('seller')!.running, true);
    assert.deepEqual(of(w, /was cut off in the middle/), ['[third]']);
    assert.deepEqual(of(w, /No cut for 60 s/), ['[third]']);
    assert.equal(w.kits.get('buyer'), undefined);
  });

  test('the short watchdog is said once the alarm has been moved to it, not before: a move that fails at that turn is tried again, and then it is said', async () => {
    const bots = { market: devnetBot() };
    let w = world(bots);
    await w.fleet.start('market');
    for (let i = 0; i < 4; i++) {
      void w.fleet.alarm();
      await w.vt.advance(20_000);
      w.cut();
      w = world(bots, {}, w);
    }
    void w.fleet.alarm();
    await w.vt.advance(PROVEN_MS - 1_000);
    const said = () => w.host.lines.filter((l) => /No cut for/.test(l)).length;
    w.host.failAlarms = 2;
    await w.vt.advance(1_000);
    assert.deepEqual(w.kvMap.get('work'), { cuts: 0 }, 'the count is set back at 60 s');
    assert.ok(ahead(w) > DEADMAN_MS, 'but the move failed: the alarm is still far');
    assert.equal(said(), 0, 'so nothing is said yet');
    await w.vt.advance(2_000);
    assert.ok(ahead(w) > DEADMAN_MS);
    assert.equal(said(), 0);
    await w.vt.advance(2_000);
    assert.equal(ahead(w), DEADMAN_MS, 'the move at 64 s is kept');
    assert.equal(said(), 1);
    await w.vt.advance(30_000);
    assert.equal(said(), 1);
  });

  test('while an alarm is at work a start, a stop, a halt and the cron leave the alarm to it; it sets the next one, or none, as it ends', async () => {
    const w = world({ seller: devnetBot(), buyer: devnetBot({ offers: [], bids: [SELL] }) },
      { SELLER_PHA_KEY: '{}', SELLER_BASE_KEY: '{}', BUYER_PHA_KEY: '{}', BUYER_BASE_KEY: '{}' });
    await w.fleet.start('seller');
    assert.equal(w.host.alarmAt, T0 + NEXT_MS, 'no alarm at work: the start sets the alarm');
    const a = w.fleet.alarm();
    await w.vt.advance(5_000);
    const watchdog = T0 + DEADMAN_MS;
    assert.equal(w.host.alarmAt, watchdog);
    await w.fleet.start('buyer');
    assert.equal(w.host.alarmAt, watchdog, 'a start leaves the alarm where it is');
    await w.vt.advance(JOIN_POLL_MS);
    assert.equal(w.kits.get('buyer')!.count('run'), 1, 'and the alarm at work takes the bot in');
    await w.fleet.stop('seller');
    assert.equal(w.host.alarmAt, watchdog, 'so does a stop');
    await w.fleet.wake();
    assert.equal(w.host.alarmAt, watchdog, 'and the cron');
    // Should the alarm ever read as none while one is at work, the cron still leaves it: the next move sets it.
    w.host.alarmAt = null;
    await w.fleet.wake();
    assert.equal(w.host.alarmAt, null);
    await w.vt.advance(WATCH_EVERY_MS);
    assert.ok(ahead(w) > DEADMAN_MS - WATCH_EVERY_MS - JOIN_POLL_MS && ahead(w) <= DEADMAN_MS);
    const before = w.host.alarmAt;
    await w.fleet.halt('buyer');
    assert.equal(w.host.alarmAt, before, 'and a halt');
    await w.vt.advance(5_000);
    await a;
    const modes = Object.fromEntries((w.fleet.status().body.bots as Array<{ name: string; mode: string }>).map((b) => [b.name, b.mode]));
    assert.deepEqual(modes, { seller: 'stopped', buyer: 'stopped' });
    assert.equal(w.host.alarmAt, null, 'every bot is stopped as it ends: no alarm');
    assert.equal(w.kvMap.has('work'), false);
    // With no alarm at work a start sets the alarm itself again.
    await w.fleet.start('seller');
    assert.equal(w.host.alarmAt, w.vt.now() + NEXT_MS);
  });

  test('a move of the watchdog that fails is tried again at the next turn; the session goes on', async () => {
    const w = world({ market: devnetBot() });
    await w.fleet.start('market');
    const a = w.fleet.alarm();
    await w.vt.advance(9_000);
    w.host.failAlarms = 2;
    await w.vt.advance(2_000);
    assert.equal(w.host.alarmAt, T0 + DEADMAN_MS, 'the move at 10 s failed: the alarm stays where it was');
    await w.vt.advance(2_000);
    assert.equal(w.host.alarmAt, T0 + DEADMAN_MS, 'and the one at 12 s');
    await w.vt.advance(2_000);
    assert.equal(w.host.failAlarms, 0);
    assert.equal(w.host.alarmAt, T0 + 14_000 + DEADMAN_MS, 'the one at 14 s moved it');
    assert.equal(w.kits.get('market')!.running, true);
    await w.vt.advance(SESSION_MS);
    await a;
    const st = (w.fleet.status().body.bots as Array<Record<string, unknown>>)[0]!;
    assert.equal(st.lastError, undefined);
    assert.equal(st.mode, 'running');
    assert.ok(w.host.alarmAt !== null && w.host.alarmAt <= w.vt.now() + NEXT_MS);
  });

  test('a halt after a cut: no session takes over, and a later start has nothing cut off before it', async () => {
    const bots = { market: devnetBot() };
    const w = world(bots);
    await w.fleet.start('market');
    void w.fleet.alarm();
    await w.vt.advance(20_000);
    w.cut();
    const w2 = world(bots, {}, w);
    assert.equal(w2.kvMap.has('work'), true, 'the note of the alarm that was cut off');
    await w2.fleet.halt('market');
    assert.equal(w2.host.alarmAt, null);
    assert.equal(w2.kvMap.has('work'), false, 'no bot runs: its note goes with the alarm');
    await w2.fleet.start('market');
    const b = w2.fleet.alarm();
    await w2.vt.advance(1_000);
    assert.equal(ahead(w2) + 1_000, DEADMAN_MS);
    assert.deepEqual(w2.kvMap.get('work'), { cuts: 0 });
    await w2.vt.advance(SESSION_MS + 5_000);
    await b;
    assert.equal(cutLines(w2).length, 0);
  });

  test('an alarm that cannot set its first alarm starts no session and counts as no cut: its note goes back to what it found', async () => {
    const bots = { market: devnetBot() };
    let w = world(bots);
    await w.fleet.start('market');
    // The storage fails as the alarm starts: its first setAlarm. Three times, as the platform tries an alarm that threw again.
    for (let i = 0; i < 3; i++) {
      w.host.failAlarms = 1;
      await assert.rejects(w.fleet.alarm(), /the storage did not answer/);
      assert.equal(w.kvMap.has('work'), false, 'no note: no session started');
    }
    assert.equal(w.opts.length, 1, 'no kit was built since the start\'s preflight');
    // The object is no longer at work: the cron, finding no alarm, sets one (here the start's is still set).
    assert.equal(w.host.alarmAt, T0 + NEXT_MS);
    w.host.alarmAt = null;
    await w.fleet.wake();
    assert.equal(w.host.alarmAt, T0 + NEXT_MS);
    void w.fleet.alarm();
    await w.vt.advance(1_000);
    assert.deepEqual(w.kvMap.get('work'), { cuts: 0 });
    assert.equal(cutLines(w).length, 0, 'and nothing is said of a cut');
    assert.equal(w.kits.get('market')!.count('run'), 1);
    // After real cuts the note it found is put back as it was: the count neither grows nor is lost.
    for (let i = 0; i < 2; i++) {
      await w.vt.advance(20_000);
      w.cut();
      w = world(bots, {}, w);
      if (i === 0) void w.fleet.alarm();
    }
    assert.deepEqual(w.kvMap.get('work'), { cuts: 1 });
    w.host.failAlarms = 1;
    await assert.rejects(w.fleet.alarm(), /the storage did not answer/);
    assert.deepEqual(w.kvMap.get('work'), { cuts: 1 });
    void w.fleet.alarm();
    await w.vt.advance(1_000);
    assert.deepEqual(w.kvMap.get('work'), { cuts: 2 });
    assert.match(cutLines(w)[0]!, /cut off in the middle of a session 2 times in a row/);
  });

  test('an alarm that cannot write its note starts no session either, and the next try comes within DEADMAN_MS, however long its watchdog would have been', async () => {
    const bots = { market: devnetBot() };
    for (const [found, aheadMs] of [[undefined, DEADMAN_MS], [{ cuts: 2 }, DEADMAN_MS], [{ cuts: 6 }, DEADMAN_MS]] as Array<[unknown, number]>) {
      const w = world(bots);
      await w.fleet.start('market');
      if (found !== undefined) w.kvMap.set('work', found);
      w.host.failPuts = { key: 'work', times: 1 };
      await assert.rejects(w.fleet.alarm(), /the storage did not take the write/);
      assert.equal(ahead(w), aheadMs, `a note of ${JSON.stringify(found)}: the next try`);
      assert.deepEqual(w.kvMap.get('work'), found, 'the note is as it was found');
      assert.equal(w.opts.length, 1, 'no kit was built: no session started');
      // The object is not left at work: the next alarm starts a session as ever.
      void w.fleet.alarm();
      await w.vt.advance(1_000);
      assert.equal(w.kits.get('market')!.count('run'), 1);
    }
  });

  test('whatever the note holds, it is a note: the alarm starts, and only a whole number in it counts', async () => {
    const bots = { market: devnetBot() };
    for (const [held, cuts] of [[null, 1], ['x', 1], [5, 1], [[], 1], [{}, 1], [{ cuts: 'a' }, 1], [{ cuts: -1 }, 1], [{ cuts: 1.5 }, 1], [{ cuts: 1e300 }, 1], [{ cuts: 2 }, 3], [{ cuts: 31 }, 30], [{ cuts: 0 }, 1]] as Array<[unknown, number]>) {
      const w = world(bots);
      await w.fleet.start('market');
      w.kvMap.set('work', held);
      const a = w.fleet.alarm();
      await w.vt.advance(1_000);
      assert.deepEqual(w.kvMap.get('work'), { cuts }, `a note of ${JSON.stringify(held)}`);
      assert.equal(w.kits.get('market')!.count('run'), 1);
      await w.fleet.halt('market');
      await w.vt.advance(5_000);
      await a;
    }
  });
});

describe('the dry run', () => {
  test('what a stopped bot would list and take, through read-only transports; refused while the bot runs', async () => {
    const w = world({ market: devnetBot({ take: { symbol: 'TAZ', amount: '2', maxPrice: '1.10', everyS: 120 } }) });
    const r = await w.fleet.dryRun('market');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const lines = (r.body.lines as string[]).join('\n');
    assert.match(lines, /preflight ok pins/);
    assert.match(lines, /Would list: sell 30 TAZ/);
    assert.match(lines, /Would buy up to 2 TAZ every 120 s/);
    assert.match(lines, /Dry run done: nothing was sent/);
    assert.equal(r.body.wouldStart, true);
    const o = w.opts[0]!;
    assert.equal(typeof o.internals?.fetch, 'function', 'the board\'s fetch is the read-only one');
    assert.equal(typeof o.internals?.pha?.sendRaw, 'function');
    await assert.rejects(o.internals!.pha!.sendRaw('00'), /dry run: a Phantasma send was refused/);
    const kit = w.kits.get('market')!;
    assert.equal(kit.count('postOffer'), 0);
    await w.fleet.start('market');
    assert.equal((await w.fleet.dryRun('market')).status, 409);
  });
});

describe('races and redeploys', () => {
  test('a stop or a halt that comes while a start\'s preflight runs cancels the start: the bot stays stopped, with no alarm', async () => {
    for (const call of ['halt', 'stop'] as const) {
      const w = world({ market: mainnetBot() }, { KIT_ALLOW_MAINNET: '1' });
      const kit = new FakeKit(w.vt.now, 'mainnet');
      let release!: () => void;
      kit.preflightGate = new Promise<void>((r) => { release = r; });
      w.kits.set('market', kit);
      const starting = w.fleet.start('market', { mainnet: true });
      await settle();
      assert.equal(kit.count('preflight'), 1, 'the preflight runs');
      const r = await w.fleet[call]('market');
      assert.equal(r.status, 200);
      assert.match(String(r.body.note), /It was starting: the start is cancelled/);
      release();
      const s = await starting;
      assert.equal(s.status, 409, `${call}: ${JSON.stringify(s.body)}`);
      assert.match(String(s.body.error), new RegExp(`a ${call} was asked while it was starting`));
      assert.equal((w.fleet.status().body.bots as Array<{ mode: string }>)[0]!.mode, 'stopped');
      assert.equal(w.host.alarmAt, null, 'no session will run');
      assert.equal(kit.count('close'), 1, 'the preflight\'s kit closed');
      assert.equal((await w.fleet.start('market', { mainnet: true })).status, 200, 'a later start works');
    }
  });

  test('a bot whose session has ended goes on in an extra session while another bot still finishes its last step', async () => {
    const w = world({ seller: devnetBot(), buyer: devnetBot({ offers: [], bids: [SELL] }) },
      { SELLER_PHA_KEY: '{}', SELLER_BASE_KEY: '{}', BUYER_PHA_KEY: '{}', BUYER_BASE_KEY: '{}' });
    await w.fleet.start('seller');
    await w.fleet.start('buyer');
    const a = w.fleet.alarm();
    await w.vt.advance(5_000);
    const slow = w.kits.get('seller')!, quick = w.kits.get('buyer')!;
    slow.windDownMs = 90_000;
    assert.equal(quick.count('run'), 1);
    let done = false;
    void a.then(() => { done = true; });
    await w.vt.advance(SESSION_MS + 10_000);
    assert.equal(slow.running, true, 'the seller still finishes its last step');
    assert.equal(quick.count('run'), 2, 'the buyer went on in an extra session meanwhile');
    assert.equal(quick.running, true);
    await w.vt.advance(90_000);
    assert.equal(slow.running, false);
    assert.equal(quick.running, false, 'the extra session ended with the seller\'s');
    await settle();
    assert.equal(done, true, 'the alarm is over, with no idle wait for anyone');
    assert.equal(slow.count('run'), 1, 'one session for the seller');
    assert.ok(w.host.alarmAt !== null && w.host.alarmAt <= w.vt.now() + NEXT_MS);
  });

  test('a bot that still has a session never gets a second one (an alarm that came while it ran)', async () => {
    const w = world({ market: devnetBot() });
    await w.fleet.start('market');
    const first = w.fleet.alarm();
    await w.vt.advance(5_000);
    const kit = w.kits.get('market')!;
    assert.equal(kit.running, true);
    const second = w.fleet.alarm();
    await second;
    assert.equal(w.host.alarmAt, w.vt.now() + DEADMAN_MS, 'it moved the watchdog on, and that is all');
    await w.vt.advance(5_000);
    assert.equal(kit.count('run'), 1, 'no second session');
    const st = (w.fleet.status().body.bots as Array<Record<string, unknown>>)[0]!;
    assert.equal(st.lastError, undefined, 'and no failure (no store lock fought over)');
    assert.equal(st.sessionRunning, true, 'the first session is still the one stop and halt reach');
    assert.equal(w.kvMap.has('work'), true, 'the note of the alarm at work is still there');
    // The first alarm is still the one at work: it keeps its watchdog, and a control call still leaves the alarm to it.
    await w.vt.advance(3 * WATCH_EVERY_MS);
    assert.ok(w.host.alarmAt! - w.vt.now() > DEADMAN_MS - WATCH_EVERY_MS - JOIN_POLL_MS);
    await w.fleet.halt('market');
    assert.ok(w.host.alarmAt! > w.vt.now() + NEXT_MS, 'the halt left the alarm to the alarm at work');
    await w.vt.advance(5_000);
    await first;
    assert.equal(kit.running, false);
    assert.equal(w.host.alarmAt, null, 'which ended with no bot running: no alarm');
    assert.equal(w.kvMap.has('work'), false);
  });

  test('a running bot whose entry leaves bots.json stops with the config it last ran with, then needs a new start; it never resumes on its own', async () => {
    const w = world({ market: mainnetBot() }, { KIT_ALLOW_MAINNET: '1' });
    assert.equal((await w.fleet.start('market', { mainnet: true })).status, 200);
    await session(w);
    const kit = w.kits.get('market')!;
    assert.equal(kit.count('postOffer'), 1);
    kit.trades = [{ id: 5, status: 'pha_locked' } as unknown as LocalTrade];
    // A deploy without it.
    const w2 = world({ other: devnetBot() }, { KIT_ALLOW_MAINNET: '1', OTHER_PHA_KEY: '{}', OTHER_BASE_KEY: '{}' }, w);
    const listed = (w2.fleet.status().body.bots as Array<Record<string, unknown>>).find((b) => b.name === 'market')!;
    assert.equal(listed.mode, 'stopping');
    assert.equal(listed.orphan, true);
    assert.match(String(listed.note), /its entry left bots\.json: it stops with the config it last ran with/);
    assert.equal((await w2.fleet.start('market', { mainnet: true })).status, 409, 'not startable while it is not in bots.json');
    assert.equal((await w2.fleet.dryRun('market')).status, 409);
    await session(w2);
    assert.equal(kit.count('cancelOffer'), 1, 'its offer cancelled');
    assert.equal(kit.count('postOffer'), 1, 'nothing listed');
    assert.equal((w2.fleet.status().body.bots as Array<{ name: string; mode: string }>).find((b) => b.name === 'market')!.mode, 'stopping', 'its trade still runs');
    kit.trades = [{ id: 5, status: 'done', endedAt: w2.vt.now() } as unknown as LocalTrade];
    await session(w2);
    const after = (w2.fleet.status().body.bots as Array<Record<string, unknown>>).find((b) => b.name === 'market')!;
    assert.equal(after.mode, 'stopped');
    assert.match(String(after.note), /Stopped cleanly after it left bots\.json/);
    // A deploy that brings it back: it stays stopped until a new start, with its dry run and its yes.
    const w3 = world({ market: mainnetBot() }, { KIT_ALLOW_MAINNET: '1' }, w2);
    await w3.fleet.wake();
    await session(w3);
    assert.equal(kit.count('run'), 3, 'no session of its own after it came back');
    assert.equal((w3.fleet.status().body.bots as Array<{ mode: string }>)[0]!.mode, 'stopped');
    assert.equal((await w3.fleet.start('market', { mainnet: true })).status, 200);
  });

  test('a running bot whose config can no longer be used stops the same way; one that never ran a session is stopped and says why', async () => {
    const w = world({ market: devnetBot() });
    await w.fleet.start('market');
    await session(w);
    const w2 = world({ market: { ...devnetBot(), price: 'bad' } }, {}, w);
    const listed = (w2.fleet.status().body.bots as Array<Record<string, unknown>>)[0]!;
    assert.equal(listed.mode, 'stopping');
    assert.match(String(listed.note), /its config in bots\.json cannot be used/);
    await session(w2);
    assert.equal((w2.fleet.status().body.bots as Array<{ mode: string }>)[0]!.mode, 'stopped');
    assert.equal(w2.kits.get('market')!.count('cancelOffer'), 1);
    // Started, but removed before its first session: no config of it is kept, so it is stopped, and status says so.
    const v = world({ market: devnetBot() });
    await v.fleet.start('market');
    const v2 = world({ other: devnetBot() }, { OTHER_PHA_KEY: '{}', OTHER_BASE_KEY: '{}' }, v);
    const orphan = (v2.fleet.status().body.bots as Array<Record<string, unknown>>).find((b) => b.name === 'market')!;
    assert.equal(orphan.mode, 'stopped');
    assert.match(String(orphan.note), /no config of it is kept/);
  });
});
