/**
 * A test Worker for `npm run test:workerd` (run.mjs): the real fleet
 * (src/fleet.ts) on a real Durable Object in workerd (its alarm, its
 * key-value storage, its SQLite), with a fake kit that trades nothing but
 * keeps its offers in the real kit store (openStore on SqlBackend, on this
 * object's SQLite), and sessions of seconds, with a watchdog of 3 s moved
 * on every second. /crash resets the object in the middle of a session
 * (ctx.abort), as an eviction or a deploy would. For the first seconds of
 * the first session its store says that a take was sent and not answered:
 * the runner then holds its order back, and must let everything else run.
 * Test only: never deployed.
 */
import { DurableObject } from 'cloudflare:workers';
import { Fleet, loadBots, type FleetKit } from '../../src/fleet.js';
import { handle } from '../../src/http.js';
import { P2P_TOKENS, tokenToRaw, usdcToRaw, type HostedKitOptions, type LocalOffer, type OfferInput } from '../../../src/index.js';
import { openStore } from '../../../src/store.js';
import { sleep } from '../../../src/board.js';

const BOTS = { fake: { network: 'devnet', offers: [{ symbol: 'TAZ', total: '6', min: '1', max: '2', price: '1.08' }], take: { symbol: 'TAZ', minPrice: '1.05', amount: '1', everyS: 600 } } };
const ADDRESS = { pha: 'P2K' + 'F'.repeat(44), base: `0x${'f1'.repeat(20)}` as `0x${string}` };
let runs = 0;
let orders = 0;
/** When the first run() started: for HELD_MS from then on the store holds a take as sent and not answered. */
let heldSince = 0;
const HELD_MS = 8_000;

/** A kit that trades nothing and keeps its offers in the real store. */
async function fakeKit(o: HostedKitOptions): Promise<FleetKit> {
  const log = o.log ?? (() => {});
  const store = await openStore({ backend: o.store, network: o.network, key: o.storeKey ?? null, log });
  let running = false;
  const kit = {
    network: o.network, address: ADDRESS,
    board: { offers: async () => [], recent: async () => ({ trades: [], next: null }), reference: async () => { throw new Error('none'); } },
    store: {
      listOffers: () => store.listOffers(), listTrades: () => store.listTrades(),
      // Answered without any I/O, as the real store on this object's SQLite answers: a loop that asked this again
      // and again without ever waiting would let nothing else run in the object.
      listPending: async () => (heldSince && Date.now() - heldSince < HELD_MS ? [{ kind: 'take', sentAt: heldSince }] : []) as never
    },
    pha: { balances: async () => new Map(P2P_TOKENS.map((t) => [t.symbol, { raw: 10n ** 15n, decimals: t.decimals }])) },
    base: { readFunds: async () => ({ usdc: 10n ** 12n, allowance: 0n, eth: 10n ** 18n }) },
    async preflight() { return { network: o.network, ok: true, address: ADDRESS, items: [{ name: 'pins', ok: true, text: 'pinned' }], balances: { pha: null, base: null }, clockSkewS: 0 }; },
    async postOffer(w: OfferInput): Promise<LocalOffer> {
      const id = (await store.listOffers()).length + 1;
      const raw = (v: string) => tokenToRaw(w.symbol, v).toString();
      const rec: LocalOffer = {
        id, network: o.network, side: w.side, symbol: w.symbol, makerPha: ADDRESS.pha, makerBase: ADDRESS.base, tazTotal: raw(w.total), tazMin: raw(w.min), tazMax: raw(w.max),
        price: usdcToRaw(w.price!).toString(), makerToken: 'ab'.repeat(32), tokenSource: 'client', priceHistory: [], follow: null,
        acceptOnTheirOwn: w.acceptOnTheirOwn !== false, mode: w.mode ?? 'standard', createdAt: Date.now(), closedAt: null
      };
      await store.addOffer(rec);
      return rec;
    },
    async cancelOffer(id: number) { await store.patchOffer(id, { closedAt: Date.now() }); },
    async buyUpTo() { return []; },
    async sellDownTo() { log(`[kit] fake order #${++orders}`); return []; },
    async run(_p: unknown, signal?: AbortSignal) {
      running = true;
      log(`[kit] fake run #${++runs}`);
      if (!heldSince) heldSince = Date.now();
      await new Promise<void>((r) => { if (!signal || signal.aborted) r(); else signal.addEventListener('abort', () => r(), { once: true }); });
      running = false;
    },
    async close() { if (running) throw new Error('close while running'); await store.close(); }
  };
  return kit as unknown as FleetKit;
}

interface Env { FLEET: DurableObjectNamespace<TestFleet>; CONTROL_TOKEN?: string }

export class TestFleet extends DurableObject<Env> {
  readonly #fleet: Fleet;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const s = ctx.storage;
    const vars = { ...(env as unknown as Record<string, unknown>), FAKE_PHA_KEY: '{}', FAKE_BASE_KEY: '{}' };
    this.#fleet = new Fleet({
      sql: s.sql,
      kv: { get: (k) => s.kv.get(k), put: (k, v) => s.kv.put(k, v), delete: (k) => s.kv.delete(k), keys: (prefix) => [...s.kv.list({ prefix })].map(([k]) => k) },
      setAlarm: (at) => s.setAlarm(at), getAlarm: () => s.getAlarm(), deleteAlarm: () => s.deleteAlarm(),
      env: vars, makeKit: fakeKit, now: () => Date.now(), sleep, print: (l) => console.log(l),
      timing: { sessionMs: 6_000, deadmanMs: 3_000, watchEveryMs: 1_000, nextMs: 300, minJoinMs: 1_000, joinPollMs: 300, backoffMs: 2_000, backoffMaxMs: 8_000 }
    }, loadBots(BOTS));
  }
  status() { return this.#fleet.status(); }
  logs(name: string, n?: number) { return this.#fleet.logs(name, n); }
  dryRun(name: string) { return this.#fleet.dryRun(name); }
  start(name: string, mainnet: boolean) { return this.#fleet.start(name, { mainnet }); }
  stop(name: string) { return this.#fleet.stop(name); }
  halt(name: string) { return this.#fleet.halt(name); }
  /** Test only: reset this object now, as an eviction or a deploy would (the alarm its watchdog left set runs the next session). */
  crash() { this.ctx.abort('test: an eviction in the middle of a session'); }
  override async alarm() { await this.#fleet.alarm(); }
}

export default {
  async fetch(request, env) {
    const stub = env.FLEET.getByName('fleet');
    if (new URL(request.url).pathname === '/crash') {
      try { await stub.crash(); } catch { /* the reset ends the call */ }
      return new Response('reset\n');
    }
    return handle(request, env.CONTROL_TOKEN, stub as never);
  }
} satisfies ExportedHandler<Env>;
