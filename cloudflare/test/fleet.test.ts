/**
 * The fleet (src/fleet.ts) on Node, with a fake Durable Object (its SQLite is
 * node:sqlite, its key-value storage a map, its alarm a field), a fake kit
 * and a virtual clock: the starts and their gates, the sessions an alarm
 * runs (a pause at their end, never a stop), the stop and the halt, the
 * waits after a failed session, and the dry run.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Fleet, loadBots, SESSION_MS, DEADMAN_MS, NEXT_MS, JOIN_POLL_MS, BACKOFF_MS, type FleetHost, type FleetKit } from '../src/fleet.js';
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
    if (!(ms > 0)) { setImmediate(resolve); return; }
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
  #next = 1;
  constructor(readonly clock: () => number, network: 'devnet' | 'mainnet', readonly sleep: (ms: number) => Promise<void> = async () => {}) { this.network = network; }
  count(fn: string): number { return this.calls.filter((c) => c.fn === fn).length; }
  #call(fn: string, arg?: unknown) { this.calls.push({ fn, arg, at: this.clock() }); }
  readonly board = {
    offers: async () => [],
    recent: async () => ({ trades: [], next: null }),
    reference: async () => { throw new Error('no reference on the fake kit'); }
  };
  readonly store = {
    listOffers: async () => this.offers.map((o) => ({ ...o })),
    listTrades: async () => this.trades.map((t) => ({ ...t }))
  };
  readonly pha = { balances: async () => new Map(P2P_TOKENS.map((t) => [t.symbol, { raw: 10n ** 15n, decimals: t.decimals }])) };
  readonly base = { readFunds: async () => ({ usdc: 10n ** 12n, allowance: 0n, eth: 10n ** 18n }) };
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
  vt: VTime; fleet: Fleet; host: FleetHost & { alarmAt: number | null; lines: string[] };
  kits: Map<string, FakeKit>; opts: HostedKitOptions[]; failNext: Error[];
  db: DatabaseSync; kvMap: Map<string, unknown>;
}

/** A fleet on a fake Durable Object. `bots` is bots.json; `env` its vars and secrets; `redeployOf`: the same object's storage, after a deploy. */
function world(bots: Record<string, unknown>, env: Record<string, unknown> = {}, redeployOf?: World): World {
  const vt = redeployOf?.vt ?? new VTime();
  const db = redeployOf?.db ?? new DatabaseSync(':memory:');
  const kv = redeployOf?.kvMap ?? new Map<string, unknown>();
  const kits = redeployOf?.kits ?? new Map<string, FakeKit>();
  const opts: HostedKitOptions[] = [];
  const failNext: Error[] = [];
  const host = {
    alarmAt: null as number | null,
    lines: [] as string[],
    sql: { exec: (q: string, ...b: Array<string | number | null>) => { const rows = db.prepare(q).all(...b); return { toArray: () => rows }; } },
    kv: {
      get: (k: string) => (kv.has(k) ? structuredClone(kv.get(k)) : undefined),
      put: (k: string, v: unknown) => { kv.set(k, structuredClone(v)); },
      delete: (k: string) => kv.delete(k),
      keys: (prefix: string) => [...kv.keys()].filter((k) => k.startsWith(prefix)).sort()
    },
    setAlarm(at: number) { this.alarmAt = at; },
    getAlarm() { return this.alarmAt; },
    deleteAlarm() { this.alarmAt = null; },
    env: { CONTROL_TOKEN: 'c'.repeat(40), KIT_ALLOW_MAINNET: '0', MARKET_PHA_KEY: '{"wif":"x"}', MARKET_BASE_KEY: '{"privateKey":"y"}', ...env },
    async makeKit(o: HostedKitOptions): Promise<FleetKit> {
      opts.push(o);
      const failure = failNext.shift();
      if (failure) throw failure;
      const name = (o.store as unknown as { where: string }).where.replace(/^durable-object:/, '').split('/')[0]!;
      let k = kits.get(name);
      if (!k) { k = new FakeKit(vt.now, o.network, (ms) => vt.sleep(ms)); kits.set(name, k); }
      return k as unknown as FleetKit;
    },
    now: vt.now,
    sleep: vt.sleep,
    print(line: string) { this.lines.push(line); }
  };
  if (redeployOf) host.alarmAt = redeployOf.host.alarmAt;
  const fleet = new Fleet(host, loadBots(bots));
  return { vt, fleet, host, kits, opts, failNext, db, kvMap: kv };
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
    await w.vt.advance(5_000);
    await second;
    assert.equal(kit.count('run'), 1, 'no second session');
    const st = (w.fleet.status().body.bots as Array<Record<string, unknown>>)[0]!;
    assert.equal(st.lastError, undefined, 'and no failure (no store lock fought over)');
    assert.equal(st.sessionRunning, true, 'the first session is still the one stop and halt reach');
    await w.fleet.halt('market');
    await w.vt.advance(5_000);
    await first;
    assert.equal(kit.running, false);
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
