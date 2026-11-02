/**
 * The board client and the durable layer (build spec sections 2.1.4, 2.3.3,
 * 2.4.3-2.4.7, 2.6, 6.3 and 6.8), against a local fake board: a node:http
 * server on 127.0.0.1 that keeps offers and trades the way the real board
 * does (client token hashes, replayOnly, the price check, IDEMPOTENCY_MISMATCH,
 * bearer tokens checked as sha256Hex of the token string), and can play an
 * older board (no hashes, its own tokens, no feed, no batch, no long-poll).
 *
 *   - the section 2.1.4 hash vector, and the token persisted before the POST;
 *   - `price` sent on every take, PRICE_CHANGED never sent again;
 *   - a fake old board's own token adopted, persisted, read back after a
 *     restart, and used for the next heartbeat and lock report;
 *   - restart reconciliation of `pending/` sends replayOnly, and a lost take
 *     makes no trade;
 *   - retries on retryable/retryAfter (at most 60 s, +-20%, 5 times), the
 *     section 2.6 table for an older board, the 200 replay,
 *     IDEMPOTENCY_MISMATCH surfaced;
 *   - the long-poll with since = the previous server time, the dedupe, the
 *     1 s pause after an unchanged answer that did not wait, symbol=all on
 *     trade reads; the first round after a start or a restart sent without a
 *     wait, so a take made while the kit was down is seen at once (the fake
 *     can hold heartbeats as the real board does);
 *   - the devnet faucet client.
 *
 * No key is used: the tokens are made by the code under test and never
 * printed; assertions about them compare values, never print them.
 */
import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BoardClient, BoardSession, CreateError, OfferPoller, TradePoller, BOARD_ERRORS, BOARD_SAFETY, retryRuleOf, parseOffer, parseTrade,
  RETRY_AFTER_MAX, REPLAY_MIN_AGE_MS, UNCHANGED_PAUSE_MS
} from '../src/board.js';
import { devnetFaucet, faucetClaimLines } from '../src/faucet.js';
import { openStore, type KitStore } from '../src/store.js';
import { BoardError, SafetyError } from '../src/errors.js';
import { tokenHashOf, sha256Hex, newControlToken } from '../src/codec.js';
import type { LocalTrade, Offer, PendingCreate } from '../src/types.js';

const S_P = 'P2K' + 'S'.repeat(44);
const B_P = 'P2K' + 'B'.repeat(44);
const M_P = 'P2K' + 'M'.repeat(44);
const S_B = '0x' + '5a'.repeat(20);
const B_B = '0x' + 'b7'.repeat(20);
const M_B = '0x' + 'c3'.repeat(20);
/** 1.08 USDC per TAZ, raw. */
const PRICE = '1080000';
/** 2 TAZ, raw (9 decimals). */
const TWO_TAZ = '2000000000';

// ── The fake board ───────────────────────────────────────────────────────────

interface Rec { method: string; path: string; query: URLSearchParams; headers: Record<string, string | string[] | undefined>; body: any }
type Reply = { status: number; json?: unknown; text?: string; headers?: Record<string, string> };
/** A scripted answer: a reply, 'drop' (close the connection unanswered), 'process-then-drop' (do the work, then close unanswered), or undefined (the default). */
type Script = (r: Rec) => Reply | 'drop' | 'process-then-drop' | undefined;

interface FOffer {
  id: number; side: 'sell' | 'buy'; symbol: string; makerPha: string; makerBase: string; tazTotal: string; tazMin: string; tazMax: string;
  price: string; remaining: string; status: string; tokenHash: string; createdAt: number; heartbeatAt: number; closedAt: number | null; fields: string;
}
interface FTrade {
  id: number; offerId: number; side: 'sell' | 'buy'; symbol: string; taz: string; usdc: string; price: string; sPha: string; sBase: string; bPha: string; bBase: string;
  status: string; h: string | null; takerHash: string; createdAt: number; updatedAt: number; fields: string;
}

class FakeBoard {
  server!: Server;
  url = '';
  requests: Rec[] = [];
  script: Script[] = [];
  /** Before wave A: ignores client hashes, replayOnly and price, makes its own tokens; no feed, no batch, no long-poll. */
  old = false;
  /** A wave-A board: hashes and the feed, but no batch heartbeat and no long-poll. */
  noLongPoll = false;
  /** The board's clock, unix seconds. */
  clock = 1_800_000_000;
  /**
   * Heartbeats held as the real board holds them (hold() in backend/src/routes/p2p.ts): a call with a wait,
   * a `since` not older than 2 minutes (a missing `since` is now) and no trade of its offers written at or
   * after that `since` is held for the whole wait. The fake plays the hold by moving its clock on by the
   * wait (no real time passes) and noting the seconds in `held`. Off: every call with a wait says it waited.
   */
  holds = false;
  held: number[] = [];
  offers = new Map<number, FOffer>();
  trades = new Map<number, FTrade>();
  #nextOffer = 41;
  #nextTrade = 900;
  /** Runs inside a request, before its default handling (to look at the store while the POST is at the board). */
  onRequest: ((r: Rec) => void) | null = null;

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.#serve(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const a = this.server.address();
    this.url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  reset(): void {
    this.requests = []; this.script = []; this.old = false; this.noLongPoll = false; this.onRequest = null; this.holds = false; this.held = []; this.clock = 1_800_000_000;
    this.offers.clear(); this.trades.clear();
    this.#nextOffer = 41; this.#nextTrade = 900;
  }

  /** Requests to a path (without the query). */
  to(method: string, path: string | RegExp): Rec[] {
    return this.requests.filter((r) => r.method === method && (typeof path === 'string' ? r.path === path : path.test(r.path)));
  }

  addOffer(o: Partial<FOffer> & { tokenHash: string }): FOffer {
    const id = this.#nextOffer++;
    const f: FOffer = {
      id, side: 'sell', symbol: 'TAZ', makerPha: M_P, makerBase: M_B, tazTotal: '10000000000', tazMin: '1000000000', tazMax: '5000000000',
      price: PRICE, remaining: '10000000000', status: 'open', createdAt: this.clock, heartbeatAt: this.clock, closedAt: null, fields: '', ...o
    };
    this.offers.set(id, f);
    return f;
  }

  offerJson(o: FOffer) {
    return {
      id: o.id, network: 'devnet', side: o.side, makerPha: o.makerPha, makerBase: o.makerBase, symbol: o.symbol, tazTotal: o.tazTotal, tazMin: o.tazMin,
      tazMax: o.tazMax, price: o.price, remaining: o.remaining, status: o.status, online: o.status === 'open', createdAt: o.createdAt,
      heartbeatAt: o.heartbeatAt, closedAt: o.closedAt
    };
  }

  tradeJson(t: FTrade) {
    return {
      id: t.id, network: 'devnet', offerId: t.offerId, side: t.side, symbol: t.symbol, taz: t.taz, usdc: t.usdc, price: t.price,
      seller: { pha: t.sPha, base: t.sBase }, buyer: { pha: t.bPha, base: t.bBase }, h: t.h, phaContract: t.h ? 'saturnescrow' : null,
      phaLockTx: null, baseLockTx: null, baseClaimTx: null, phaClaimTx: null, baseRefundTx: null, phaRefundTx: null, phaDeadline: null, baseDeadline: null,
      feeBps: t.status === 'requested' ? null : 100, payoutDeferred: false, status: t.status, acceptBy: null, lockBy: null, createdAt: t.createdAt,
      acceptedAt: null, updatedAt: t.updatedAt, endedAt: null, lastError: null
    };
  }

  async #serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: any = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    const u = new URL(req.url ?? '/', 'http://x');
    const r: Rec = { method: req.method ?? 'GET', path: u.pathname, query: u.searchParams, headers: req.headers, body };
    this.requests.push(r);
    this.onRequest?.(r);
    // Each scripted answer is asked once per request; the first that answers is used up.
    let s: ReturnType<Script>;
    for (let k = 0; k < this.script.length; k++) {
      s = this.script[k]!(r);
      if (s !== undefined) { this.script.splice(k, 1); break; }
    }
    if (s === 'drop') { res.destroy(); return; }
    const reply = this.#route(r);
    if (s === 'process-then-drop') { res.destroy(); return; }
    const out = s && typeof s === 'object' ? s : reply;
    for (const [h, v] of Object.entries(out.headers ?? {})) res.setHeader(h, v);
    res.statusCode = out.status;
    if (out.text !== undefined) { res.setHeader('Content-Type', 'text/plain'); res.end(out.text); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(out.json ?? null));
  }

  #err(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Reply {
    return { status, json: { error: this.old ? { code, message } : { code, message, retryable: retryRuleOf(code, status).retryable, ...extra } } };
  }

  #ok(data: unknown, status = 200, headers?: Record<string, string>): Reply {
    return { status, json: { data, meta: { network: 'devnet', cachedAt: 0, ttl: 0 } }, ...(headers ? { headers } : {}) };
  }

  /** The bearer token's hash as the real board compares it: sha256Hex of the token string. */
  #bearerHash(r: Rec): string | null {
    const m = /^Bearer ([0-9a-f]{64})$/.exec(String(r.headers.authorization ?? ''));
    return m ? sha256Hex(m[1]!) : null;
  }

  #route(r: Rec): Reply {
    const p = r.path;
    let m: RegExpExecArray | null;
    if (r.query.get('network') !== 'devnet') return this.#err(400, 'BAD_REQUEST', 'network is devnet or mainnet');
    if (r.method === 'GET' && p === '/v1/p2p/recent') {
      if (this.old) return { status: 404, text: '404 Not Found' };
      return this.#ok({ trades: [], next: null });
    }
    if (r.method === 'GET' && p === '/v1/p2p/offers') return this.#ok([...this.offers.values()].filter((o) => o.status === 'open').map((o) => this.offerJson(o)));
    if (r.method === 'POST' && p === '/v1/p2p/offers') return this.#createOffer(r);
    if ((m = /^\/v1\/p2p\/offers\/(\d+)\/heartbeat$/.exec(p)) && r.method === 'POST') {
      const o = this.offers.get(Number(m[1]));
      if (!o) return this.#err(404, 'NOT_FOUND', 'No such offer');
      if (this.#bearerHash(r) !== o.tokenHash) return this.#err(401, 'UNAUTHORIZED', 'This needs the offer\'s maker token');
      if (o.status !== 'open') return this.#err(409, 'CLOSED', 'This offer is closed', { reason: 'offer_closed' });
      o.heartbeatAt = this.clock;
      const held = this.#hold([o.id], r.body);
      return this.#ok(this.#heartbeatData(o, r.body, held));
    }
    if (r.method === 'POST' && p === '/v1/p2p/heartbeats') {
      if (this.old || this.noLongPoll) return { status: 404, text: '404 Not Found' };
      const list: Array<{ id: number; token: string }> = r.body?.offers ?? [];
      const live = list.filter((x) => { const o = this.offers.get(x.id); return !!o && sha256Hex(x.token) === o.tokenHash; }).map((x) => x.id);
      const held = this.#hold(live, r.body);
      const results = list.map((x) => {
        const o = this.offers.get(x.id);
        if (!o || !live.includes(x.id)) return { id: x.id, ok: false, error: { code: 'UNAUTHORIZED', message: 'no', retryable: false } };
        const { offer, trades } = this.#heartbeatData(o, {});
        return { id: x.id, ok: true, offer, trades };
      });
      return this.#ok({ results, serverTime: this.clock, waited: this.holds ? held > 0 : !!r.body?.wait });
    }
    if ((m = /^\/v1\/p2p\/offers\/(\d+)\/cancel$/.exec(p)) && r.method === 'POST') {
      const o = this.offers.get(Number(m[1]));
      if (!o) return this.#err(404, 'NOT_FOUND', 'No such offer');
      if (this.#bearerHash(r) !== o.tokenHash) return this.#err(401, 'UNAUTHORIZED', 'no');
      if (o.status !== 'open') return this.#err(409, 'CLOSED', 'This offer is already closed', { reason: 'offer_closed' });
      o.status = 'closed'; o.closedAt = this.clock;
      return this.#ok({ ok: true });
    }
    if ((m = /^\/v1\/p2p\/offers\/(\d+)\/reprice$/.exec(p)) && r.method === 'POST') {
      const o = this.offers.get(Number(m[1]));
      if (!o) return this.#err(404, 'NOT_FOUND', 'No such offer');
      if (this.#bearerHash(r) !== o.tokenHash) return this.#err(401, 'UNAUTHORIZED', 'no');
      if (typeof r.body?.price === 'string') o.price = r.body.price;
      return this.#ok({ offer: this.offerJson(o) });
    }
    if ((m = /^\/v1\/p2p\/offers\/(\d+)\/take$/.exec(p)) && r.method === 'POST') return this.#take(Number(m[1]), r);
    if ((m = /^\/v1\/p2p\/trades\/(\d+)$/.exec(p)) && r.method === 'GET') {
      const t = this.trades.get(Number(m[1]));
      if (!t || (r.query.get('symbol') !== 'all' && r.query.get('symbol') !== t.symbol)) return this.#err(404, 'NOT_FOUND', 'No such trade');
      const headers: Record<string, string> = this.old || this.noLongPoll ? {} : { 'X-Server-Time': String(this.clock), 'X-Waited': r.query.get('wait') ? '1' : '0' };
      return this.#ok(this.tradeJson(t), 200, headers);
    }
    if (r.method === 'GET' && p === '/v1/p2p/trades') return this.#ok([...this.trades.values()].map((t) => this.tradeJson(t)));
    if ((m = /^\/v1\/p2p\/trades\/(\d+)\/(pha-locked|base-locked|accept|decline)$/.exec(p)) && r.method === 'POST') {
      const t = this.trades.get(Number(m[1]));
      if (!t) return this.#err(404, 'NOT_FOUND', 'No such trade');
      const o = this.offers.get(t.offerId)!;
      // The side that reports: S on pha-locked, B on base-locked, the maker on accept/decline.
      const makerSide = m[2] === 'accept' || m[2] === 'decline' || (m[2] === 'pha-locked' ? t.side === 'sell' : t.side === 'buy');
      if (this.#bearerHash(r) !== (makerSide ? o.tokenHash : t.takerHash)) return this.#err(401, 'UNAUTHORIZED', 'This needs the token of this trade');
      if (m[2] === 'pha-locked') { t.h = String(r.body?.h); t.status = 'pha_locked'; t.updatedAt = this.clock; }
      if (m[2] === 'accept') { t.status = 'accepted'; t.updatedAt = this.clock; }
      return this.#ok(this.tradeJson(t));
    }
    if (p === '/v1/p2p/faucet') {
      if (r.method === 'GET') return this.#ok({ enabled: true, amounts: { TAZ: '20', mUSDC: '500', ETH: '0.0005' }, perAddressHours: 24, leftToday: 180, low: false, parts: { pha: true, base: true } });
      return this.#ok({ pha: r.body?.pha ? { txHash: 'AB'.repeat(32), amounts: { TAZ: '20' }, state: 'confirmed' } : null, base: r.body?.base ? { usdcTx: '0x' + 'cd'.repeat(32), ethTx: null, amounts: { mUSDC: '500' }, state: 'partial', error: 'ETH: not sent' } : null }, 202);
    }
    return { status: 404, text: '404 Not Found' };
  }

  #heartbeatData(o: FOffer, body: any, held = 0) {
    o.heartbeatAt = this.clock;
    const trades = [...this.trades.values()].filter((t) => t.offerId === o.id).map((t) => this.tradeJson(t));
    const data: Record<string, unknown> = { offer: this.offerJson(o), trades };
    if (!this.old && !this.noLongPoll) { data.serverTime = this.clock; data.waited = this.holds ? held > 0 : !!body?.wait; }
    return data;
  }

  /** With `holds`: the seconds the real board would hold this call (0: answered at once). */
  #hold(offerIds: readonly number[], body: any): number {
    const wait = typeof body?.wait === 'number' ? body.wait : 0;
    if (!this.holds || this.old || this.noLongPoll || wait <= 0 || offerIds.length === 0) return 0;
    const since = typeof body?.since === 'number' ? Math.min(body.since, this.clock) : this.clock;
    if (since < this.clock - 120) return 0;
    if ([...this.trades.values()].some((t) => offerIds.includes(t.offerId) && t.updatedAt >= since)) return 0;
    this.held.push(wait);
    this.clock += wait;
    return wait;
  }

  #createOffer(r: Rec): Reply {
    const b = r.body ?? {};
    const fields = JSON.stringify([b.side, b.symbol, b.makerPha, b.makerBase, b.tazTotal, b.tazMin, b.tazMax, b.price ?? null]);
    const hash: string | undefined = this.old ? undefined : b.makerTokenHash;
    if (hash) {
      const have = [...this.offers.values()].find((o) => o.tokenHash === hash);
      if (have) {
        if (have.fields !== fields) return this.#err(409, 'IDEMPOTENCY_MISMATCH', 'This makerTokenHash was already used for another offer');
        return this.#ok({ offer: this.offerJson(have), replayed: true });
      }
      if (b.replayOnly === true) return this.#err(404, 'NOT_FOUND', 'No offer was made with this makerTokenHash', { reason: 'no_such_request' });
    }
    const made = hash ? null : newControlToken();
    const o = this.addOffer({
      side: b.side, symbol: b.symbol, makerPha: b.makerPha, makerBase: b.makerBase, tazTotal: b.tazTotal, tazMin: b.tazMin, tazMax: b.tazMax,
      price: b.price ?? '1100000', remaining: b.tazTotal, tokenHash: hash ?? sha256Hex(made!), fields
    });
    return this.#ok({ offer: this.offerJson(o), ...(made ? { makerToken: made } : {}), replayed: false }, 201);
  }

  #take(offerId: number, r: Rec): Reply {
    const o = this.offers.get(offerId);
    if (!o) return this.#err(404, 'NOT_FOUND', 'No such offer');
    const b = r.body ?? {};
    const fields = JSON.stringify([offerId, b.taz, b.takerPha, b.takerBase]);
    const hash: string | undefined = this.old ? undefined : b.takerTokenHash;
    if (hash) {
      const have = [...this.trades.values()].find((t) => t.takerHash === hash);
      if (have) {
        if (have.fields !== fields || (b.price !== undefined && b.price !== have.price)) return this.#err(409, 'IDEMPOTENCY_MISMATCH', 'This takerTokenHash was already used for another take');
        return this.#ok({ trade: this.tradeJson(have), replayed: true });
      }
      if (b.replayOnly === true) return this.#err(404, 'NOT_FOUND', 'No take was made with this takerTokenHash', { reason: 'no_such_request' });
    }
    if (!this.old && b.price !== undefined && b.price !== o.price) return this.#err(409, 'PRICE_CHANGED', 'The offer\'s price changed; read the offer again');
    const made = hash ? null : newControlToken();
    const usdc = (BigInt(b.taz) * BigInt(o.price) / 1_000_000_000n).toString();
    const t: FTrade = {
      id: this.#nextTrade++, offerId, side: o.side, symbol: o.symbol, taz: b.taz, usdc, price: o.price,
      sPha: o.side === 'sell' ? o.makerPha : b.takerPha, sBase: o.side === 'sell' ? o.makerBase : b.takerBase,
      bPha: o.side === 'sell' ? b.takerPha : o.makerPha, bBase: o.side === 'sell' ? b.takerBase : o.makerBase,
      status: 'requested', h: null, takerHash: hash ?? sha256Hex(made!), createdAt: this.clock, updatedAt: this.clock, fields
    };
    this.trades.set(t.id, t);
    return this.#ok({ trade: this.tradeJson(t), ...(made ? { takerToken: made } : {}), replayed: false }, 201);
  }
}

// ── Harness ──────────────────────────────────────────────────────────────────

const fake = new FakeBoard();
await fake.start();
const dirs: string[] = [];
const stores: KitStore[] = [];
after(async () => {
  for (const s of stores) await s.close().catch(() => undefined);
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  await fake.stop();
});
beforeEach(() => fake.reset());

async function newStore(dir?: string): Promise<{ store: KitStore; dir: string }> {
  const d = dir ?? await mkdtemp(join(tmpdir(), 'kit-board-'));
  if (!dir) dirs.push(d);
  const store = await openStore({ dataDir: d, network: 'devnet', keyFile: null });
  stores.push(store);
  return { store, dir: d };
}

/** A client that never really waits: the waits it asks for are recorded. */
function client(o: { random?: number; apiKey?: string; retries?: number; log?: string[] } = {}) {
  const sleeps: number[] = [];
  const board = new BoardClient({
    network: 'devnet', api: fake.url, sleep: async (ms) => { sleeps.push(ms); }, random: () => o.random ?? 0.5,
    ...(o.apiKey ? { apiKey: o.apiKey } : {}), ...(o.retries !== undefined ? { retries: o.retries } : {}),
    ...(o.log ? { log: (l: string) => o.log!.push(l) } : {})
  });
  return { board, sleeps };
}

async function session(o: { now?: () => number; log?: string[]; dir?: string } = {}) {
  const { board, sleeps } = client({ log: o.log });
  const { store, dir } = await newStore(o.dir);
  const s = new BoardSession({ board, store, ...(o.now ? { now: o.now } : {}), ...(o.log ? { log: (l: string) => o.log!.push(l) } : {}) });
  return { s, board, store, dir, sleeps };
}

const sellOffer = { side: 'sell' as const, symbol: 'TAZ', makerPha: S_P, makerBase: S_B, tazTotal: '10000000000', tazMin: '1000000000', tazMax: '5000000000', price: PRICE };

/** The offer as the kit reads it from the list. */
async function readOffer(board: BoardClient, id: number): Promise<Offer> {
  const o = (await board.offers()).find((x) => x.id === id);
  assert.ok(o, `offer #${id} is listed`);
  return o;
}

async function rejects<T extends Error>(p: Promise<unknown>, cls: new (...a: any[]) => T, code: string): Promise<T> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof cls, `a ${cls.name}, got ${(e as Error)?.name}: ${(e as Error)?.message}`);
    assert.equal((e as unknown as { code: string }).code, code, (e as Error).message);
    return e as T;
  }
  assert.fail(`expected ${cls.name} ${code}`);
}

/** The pending files on disk (unsealed store). */
function pendingOnDisk(dir: string): Array<{ name: string; value: any }> {
  const p = join(dir, 'devnet', 'pending');
  return readdirSync(p).filter((n) => n.endsWith('.json')).map((n) => ({ name: n, value: JSON.parse(readFileSync(join(p, n), 'utf8')) }));
}

// ── Section 2.1.4: the token hash ────────────────────────────────────────────

describe('control tokens (section 2.1.4)', () => {
  test('the shared vector: 64 x "0" hashes to 60e05bd1…; the raw-bytes hash is another value', () => {
    const zero = '0'.repeat(64);
    assert.equal(tokenHashOf(zero), '60e05bd1b195af2f94112fa7197a5c88289058840ce7c6df9693756bc6250f55');
    const rawBytes = createHash('sha256').update(Buffer.alloc(32)).digest('hex');
    assert.equal(rawBytes, '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925');
    assert.notEqual(tokenHashOf(zero), rawBytes);
  });

  test('a board that checks sha256Hex(token) accepts the kit\'s hash; the raw-bytes hash would not authenticate', async () => {
    const { board } = client();
    const token = '0'.repeat(64);
    const good = await board.createOffer({ ...sellOffer, makerTokenHash: tokenHashOf(token) });
    assert.equal((await board.heartbeat(good.offer.id, token)).offer.id, good.offer.id);
    const rawHash = createHash('sha256').update(Buffer.alloc(32)).digest('hex');
    const badOffer = await board.createOffer({ ...sellOffer, tazTotal: '9000000000', makerTokenHash: rawHash });
    const e = await rejects(board.heartbeat(badOffer.offer.id, token), BoardError, 'UNAUTHORIZED');
    assert.equal(e.status, 401);
  });

  test('the token is kept (and its send time) before the POST; the record holds it after, and the entry is gone', async () => {
    const { s, store, dir } = await session();
    let seen: any = null;
    fake.onRequest = (r) => {
      if (r.method !== 'POST' || r.path !== '/v1/p2p/offers') return;
      // While the POST is at the board: exactly one pending file, under the hash the body carries.
      const files = pendingOnDisk(dir);
      seen = { files, hash: r.body.makerTokenHash };
    };
    const posted = await s.postOffer(sellOffer, { acceptOnTheirOwn: true });
    assert.ok(seen, 'the board saw the POST');
    assert.equal(seen.files.length, 1);
    assert.equal(seen.files[0].name, `${seen.hash}.json`);
    assert.equal(tokenHashOf(seen.files[0].value.token), seen.hash, 'the kept token is the one whose hash was sent');
    assert.equal(typeof seen.files[0].value.sentAt, 'number', 'the send time is kept before the send');
    assert.equal(posted.record.makerToken, seen.files[0].value.token);
    assert.equal(posted.record.tokenSource, 'client');
    assert.equal(posted.record.acceptOnTheirOwn, true);
    assert.deepEqual(posted.record.priceHistory.map((x) => x.price), [PRICE]);
    assert.equal(posted.replayed, false);
    assert.equal(posted.adopted, false);
    assert.equal(pendingOnDisk(dir).length, 0, 'the entry is dropped once the record holds the token');
    assert.equal((await store.getOffer(posted.offer.id))?.makerToken, posted.record.makerToken);
    // The board never got the token itself.
    assert.ok(!JSON.stringify(fake.requests.map((r) => r.body)).includes(posted.record.makerToken));
  });

  test('a take keeps its token before the POST too, and the trade record keeps the price the kit sent', async () => {
    const { s, board, dir, store } = await session();
    const o = fake.addOffer({ tokenHash: sha256Hex(newControlToken()) });
    const offer = await readOffer(board, o.id);
    let atBoard: any = null;
    fake.onRequest = (r) => { if (r.path.endsWith('/take')) atBoard = { files: pendingOnDisk(dir), body: r.body }; };
    const t = await s.take(offer, { taz: TWO_TAZ, takerPha: B_P, takerBase: B_B });
    assert.equal(atBoard.files.length, 1);
    assert.equal(tokenHashOf(atBoard.files[0].value.token), atBoard.body.takerTokenHash);
    assert.equal(atBoard.files[0].value.kind, 'take');
    assert.deepEqual(atBoard.files[0].value.seen, { side: 'sell', makerPha: M_P, makerBase: M_B });
    assert.equal(t.record.price, PRICE);
    assert.equal(t.record.role, 'B');
    assert.equal(t.record.maker, false);
    assert.equal(t.record.usdc, '2160000');
    assert.equal(t.record.takerToken, atBoard.files[0].value.token);
    assert.equal(t.mismatch, null);
    assert.equal(pendingOnDisk(dir).length, 0);
    assert.equal((await store.getTrade(t.record.id))?.takerToken, t.record.takerToken);
  });
});

// ── Section 2.3.3: price on every take ───────────────────────────────────────

describe('price on every take (section 2.3.3)', () => {
  test('every take sends the price the kit read, and its symbol', async () => {
    const { s, board } = await session();
    const o = fake.addOffer({ tokenHash: sha256Hex(newControlToken()), price: '1234567' });
    await s.take(await readOffer(board, o.id), { taz: TWO_TAZ, takerPha: B_P, takerBase: B_B });
    const takes = fake.to('POST', /\/take$/);
    assert.equal(takes.length, 1);
    assert.equal(takes[0]!.body.price, '1234567');
    assert.equal(takes[0]!.body.symbol, 'TAZ');
  });

  test('BoardClient.take refuses to send a take without a price (nothing is sent)', async () => {
    const { board } = client();
    const e = await rejects(board.take(41, { taz: TWO_TAZ, takerPha: B_P, takerBase: B_B, symbol: 'TAZ', takerTokenHash: tokenHashOf(newControlToken()) } as any), SafetyError, BOARD_SAFETY.BAD_INPUT);
    assert.match(e.message, /price/);
    assert.equal(fake.requests.length, 0);
  });

  test('PRICE_CHANGED is never sent again: one POST, no trade, the entry dropped', async () => {
    const { s, board, store, dir, sleeps } = await session();
    const o = fake.addOffer({ tokenHash: sha256Hex(newControlToken()) });
    const offer = await readOffer(board, o.id);
    o.price = '1200000'; // the maker repriced after the kit read the offer
    const e = await rejects(s.take(offer, { taz: TWO_TAZ, takerPha: B_P, takerBase: B_B }), CreateError, 'PRICE_CHANGED');
    assert.equal(e.mayExist, false);
    assert.equal(e.retryable, false);
    assert.equal(fake.to('POST', /\/take$/).length, 1);
    assert.equal(sleeps.length, 0);
    assert.equal(fake.trades.size, 0);
    assert.equal(pendingOnDisk(dir).length, 0);
    assert.equal((await store.listTrades()).length, 0);
  });

  test('a trade fixed at another price is a mismatch even when the USDC rounds to the same figure (check 14)', async () => {
    const { s, board } = await session();
    const o = fake.addOffer({ tokenHash: sha256Hex(newControlToken()) });
    const offer = await readOffer(board, o.id);
    // 0.5 TAZ at 1080000 and at 1080001 both give 540000 raw USDC (rounded down): only the price itself differs.
    fake.script.push((r) => {
      if (!r.path.endsWith('/take')) return undefined;
      const ft: FTrade = {
        id: 900, offerId: o.id, side: 'sell', symbol: 'TAZ', taz: '500000000', usdc: '540000', price: '1080001', sPha: M_P, sBase: M_B, bPha: B_P, bBase: B_B,
        status: 'requested', h: null, takerHash: r.body.takerTokenHash, createdAt: fake.clock, updatedAt: fake.clock, fields: ''
      };
      return { status: 201, json: { data: { trade: fake.tradeJson(ft), replayed: false } } };
    });
    const t = await s.take(offer, { taz: '500000000', takerPha: B_P, takerBase: B_B });
    assert.equal(t.record.price, PRICE, 'the record keeps the price the kit sent');
    assert.equal(t.record.usdc, '540000');
    assert.equal(t.mismatch, 'The price of this trade is not what you agreed to.');
  });

  test('a take of an offer listed on another network is refused before anything is kept or sent', async () => {
    const { s, board, dir } = await session();
    const o = fake.addOffer({ tokenHash: sha256Hex(newControlToken()) });
    const offer = await readOffer(board, o.id);
    fake.requests = [];
    await rejects(s.take({ ...offer, network: 'mainnet' }, { taz: TWO_TAZ, takerPha: B_P, takerBase: B_B }), SafetyError, BOARD_SAFETY.BAD_INPUT);
    assert.equal(fake.requests.length, 0);
    assert.equal(pendingOnDisk(dir).length, 0);
  });

  test('PRICE_CHANGED is not sent again even when a board marks it retryable', async () => {
    const { board, sleeps } = client();
    fake.addOffer({ tokenHash: 'a'.repeat(64) });
    fake.script.push((r) => (r.path.endsWith('/take') ? { status: 409, json: { error: { code: 'PRICE_CHANGED', message: 'x', retryable: true, retryAfter: 1 } } } : undefined));
    await rejects(board.take(41, { taz: TWO_TAZ, takerPha: B_P, takerBase: B_B, symbol: 'TAZ', price: PRICE, takerTokenHash: tokenHashOf(newControlToken()) }), CreateError, 'PRICE_CHANGED');
    assert.equal(fake.to('POST', /\/take$/).length, 1);
    assert.equal(sleeps.length, 0);
  });
});

// ── An older board's own token (section 2.1.4, EN8) ─────────────────────────

describe('a fake old board that ignores the hash', () => {
  test('its makerToken is adopted, kept, read back after a restart, and used for the next heartbeat', async () => {
    fake.old = true;
    const log: string[] = [];
    const first = await session({ log });
    const posted = await first.s.postOffer(sellOffer);
    assert.equal(posted.adopted, true);
    assert.equal(posted.record.tokenSource, 'server');
    const serverToken = posted.record.makerToken;
    assert.equal(sha256Hex(serverToken), fake.offers.get(posted.offer.id)!.tokenHash, 'the board\'s own token is kept');
    assert.equal(pendingOnDisk(first.dir).length, 0, 'the client token is dropped');
    assert.ok(log.some((l) => /not idempotent/.test(l)), 'the log says the create was not idempotent');
    assert.ok(!log.join('\n').includes(serverToken), 'the token never reaches the log');
    // A restart: the store is opened again and the token read back from disk.
    await first.store.close();
    const second = await session({ dir: first.dir });
    assert.equal((await second.store.getOffer(posted.offer.id))?.makerToken, serverToken);
    fake.requests = [];
    const hb = await second.s.heartbeat(posted.offer.id);
    assert.equal(hb.offer.id, posted.offer.id);
    assert.equal(fake.requests[0]!.headers.authorization, `Bearer ${serverToken}`);
  });

  test('its takerToken is adopted, kept, read back after a restart, and used for the next lock report', async () => {
    fake.old = true;
    const first = await session();
    // A buy offer: the taker is S and reports the Phantasma lock with the taker token.
    const o = fake.addOffer({ side: 'buy', tokenHash: sha256Hex(newControlToken()) });
    const taken = await first.s.take(await readOffer(first.board, o.id), { taz: TWO_TAZ, takerPha: S_P, takerBase: S_B });
    assert.equal(taken.adopted, true);
    assert.equal(taken.record.role, 'S');
    assert.equal(taken.record.tokenSource, 'server');
    const serverToken = taken.record.takerToken!;
    assert.equal(sha256Hex(serverToken), fake.trades.get(taken.record.id)!.takerHash);
    await first.store.close();
    const second = await session({ dir: first.dir });
    assert.equal((await second.store.getTrade(taken.record.id))?.takerToken, serverToken);
    fake.requests = [];
    const h = '0x' + 'ab'.repeat(32);
    const t = await second.s.phaLocked(taken.record.id, { h });
    assert.equal(t.status, 'pha_locked');
    assert.equal(fake.requests[0]!.headers.authorization, `Bearer ${serverToken}`);
    assert.deepEqual(fake.requests[0]!.body, { h });
  });

  test('a maker\'s lock report uses the offer\'s adopted token', async () => {
    fake.old = true;
    const { s, store } = await session();
    const posted = await s.postOffer(sellOffer);
    // A take on the kit's sell offer (made by someone else), adopted by the maker flow as a maker record.
    const ft = { id: 777, offerId: posted.offer.id, side: 'sell' as const, symbol: 'TAZ', taz: TWO_TAZ, usdc: '2160000', price: PRICE, sPha: S_P, sBase: S_B, bPha: B_P, bBase: B_B, status: 'accepted', h: null, takerHash: 'f'.repeat(64), createdAt: fake.clock, updatedAt: fake.clock, fields: '' };
    fake.trades.set(777, ft);
    const rec: LocalTrade = { id: 777, network: 'devnet', offerId: posted.offer.id, role: 'S', maker: true, symbol: 'TAZ', taz: TWO_TAZ, usdc: '2160000', price: PRICE, myPha: S_P, myBase: S_B, txs: {}, createdAt: Date.now(), updatedAt: Date.now() };
    await store.addTrade(rec);
    fake.requests = [];
    await s.phaLocked(777, { h: '0x' + 'cd'.repeat(32) });
    assert.equal(fake.requests[0]!.headers.authorization, `Bearer ${posted.record.makerToken}`);
    assert.equal(sha256Hex(posted.record.makerToken), fake.offers.get(posted.offer.id)!.tokenHash);
  });

  test('a session refuses a call for a row it keeps no token for (NO_TOKEN), sending nothing', async () => {
    const { s } = await session();
    await rejects(s.heartbeat(41), SafetyError, BOARD_SAFETY.NO_TOKEN);
    await rejects(s.phaLocked(900, { h: '0x' + 'ab'.repeat(32) }), SafetyError, BOARD_SAFETY.NO_TOKEN);
    assert.equal(fake.requests.length, 0);
  });
});

// ── Restart reconciliation (sections 2.1.4, 6.3, 6.5) ────────────────────────

describe('restart reconciliation of pending/', () => {
  test('a take that never reached the board is asked with replayOnly after a restart, and makes no trade', async () => {
    let now = 1_800_000_000_000;
    const first = await session({ now: () => now });
    const o = fake.addOffer({ tokenHash: sha256Hex(newControlToken()) });
    const offer = await readOffer(first.board, o.id);
    // The request never reaches the board (the connection drops before it is handled), and the bot dies.
    fake.script.push((r) => (r.path.endsWith('/take') ? 'drop' : undefined));
    const e = await rejects(first.s.take(offer, { taz: TWO_TAZ, takerPha: B_P, takerBase: B_B, retries: 0 }), CreateError, 'NETWORK');
    assert.equal(e.mayExist, true, 'no answer: the take may exist, so its entry is kept');
    assert.equal(pendingOnDisk(first.dir).length, 1);
    await first.store.close();
    // Restart, 30 s later: too young to ask (a send may still be on its way).
    now += 30_000;
    const second = await session({ now: () => now, dir: first.dir });
    fake.requests = [];
    const young = await second.s.reconcilePending();
    assert.equal(young.kept, 1);
    assert.equal(fake.to('POST', /\/take$/).length, 0);
    // 61 s after the send: asked with its own hash and replayOnly; the board never saw it, so nothing is made.
    now += 31_000;
    const r = await second.s.reconcilePending();
    const asks = fake.to('POST', /\/take$/);
    assert.equal(asks.length, 1);
    assert.equal(asks[0]!.body.replayOnly, true);
    assert.equal(asks[0]!.body.takerTokenHash, e.tokenHash);
    assert.equal(asks[0]!.body.price, PRICE);
    assert.equal(fake.trades.size, 0, 'a lost take creates no trade');
    assert.equal(r.cleared, 1);
    assert.equal(r.boardKeepsHashes, true);
    assert.equal(pendingOnDisk(first.dir).length, 0);
    assert.equal((await second.store.listTrades()).length, 0);
    assert.ok(r.notes.some((n) => /never reached the board/.test(n)));
  });

  test('a take whose answer was lost is found by the replayOnly ask (200 replay) and recorded with the client token', async () => {
    let now = 1_800_000_000_000;
    const first = await session({ now: () => now });
    const o = fake.addOffer({ tokenHash: sha256Hex(newControlToken()) });
    const offer = await readOffer(first.board, o.id);
    fake.script.push((r) => (r.path.endsWith('/take') ? 'process-then-drop' : undefined));
    const e = await rejects(first.s.take(offer, { taz: TWO_TAZ, takerPha: B_P, takerBase: B_B, retries: 0 }), CreateError, 'NETWORK');
    assert.equal(e.mayExist, true);
    const token = pendingOnDisk(first.dir)[0]!.value.token;
    assert.equal(fake.trades.size, 1);
    await first.store.close();
    now += REPLAY_MIN_AGE_MS + 1_000;
    const second = await session({ now: () => now, dir: first.dir });
    const r = await second.s.reconcilePending();
    assert.deepEqual(r.recorded, [{ kind: 'take', id: 900 }]);
    assert.equal(fake.trades.size, 1, 'no second trade');
    const rec = await second.store.getTrade(900);
    assert.equal(rec?.takerToken, token);
    assert.equal(rec?.price, PRICE);
    assert.equal(pendingOnDisk(first.dir).length, 0);
  });

  test('an offer whose answer was lost is recorded and cancelled (nobody saw it listed); with offers:"keep" it stays', async () => {
    let now = 1_800_000_000_000;
    const { s, store, dir } = await session({ now: () => now });
    fake.script.push((r) => (r.path === '/v1/p2p/offers' && r.method === 'POST' ? 'process-then-drop' : undefined));
    await rejects(s.postOffer(sellOffer, { retries: 0 }), CreateError, 'NETWORK');
    now += REPLAY_MIN_AGE_MS;
    const r = await s.reconcilePending();
    const id = r.recorded[0]!.id;
    assert.equal(fake.offers.get(id)!.status, 'closed');
    assert.ok((await store.getOffer(id))?.closedAt);
    assert.equal(pendingOnDisk(dir).length, 0);

    fake.script.push((x) => (x.path === '/v1/p2p/offers' && x.method === 'POST' ? 'process-then-drop' : undefined));
    await rejects(s.postOffer({ ...sellOffer, tazTotal: '8000000000' }, { retries: 0 }), CreateError, 'NETWORK');
    now += REPLAY_MIN_AGE_MS;
    const k = await s.reconcilePending({ offers: 'keep' });
    const kept = k.recorded[0]!.id;
    assert.equal(fake.offers.get(kept)!.status, 'open');
    assert.equal((await store.getOffer(kept))?.closedAt, null);
    assert.deepEqual(await s.openOffers(), [{ id: kept, token: (await store.getOffer(kept))!.makerToken }]);
  });

  test('an entry never sent is cleared without asking; one already recorded is cleared', async () => {
    const { s, store } = await session();
    const token = newControlToken();
    await store.putPending({ kind: 'take', network: 'devnet', token, tokenHash: tokenHashOf(token), offerId: 41, body: { taz: TWO_TAZ, takerPha: B_P, takerBase: B_B, symbol: 'TAZ', price: PRICE }, seen: { side: 'sell', makerPha: M_P, makerBase: M_B }, createdAt: 1, sentAt: null });
    const r = await s.reconcilePending();
    assert.equal(r.cleared, 1);
    assert.equal(fake.requests.length, 0);
  });

  test('a board that does not keep client hashes is never asked (it would make a new take); its entries are cleared', async () => {
    let now = 1_800_000_000_000;
    const { s, store } = await session({ now: () => now });
    const token = newControlToken();
    await store.putPending({ kind: 'take', network: 'devnet', token, tokenHash: tokenHashOf(token), offerId: 41, body: { taz: TWO_TAZ, takerPha: B_P, takerBase: B_B, symbol: 'TAZ', price: PRICE }, seen: { side: 'sell', makerPha: M_P, makerBase: M_B }, createdAt: now, sentAt: now });
    fake.old = true;
    fake.addOffer({ tokenHash: 'a'.repeat(64) });
    now += REPLAY_MIN_AGE_MS;
    const r = await s.reconcilePending();
    assert.equal(r.boardKeepsHashes, false);
    assert.equal(fake.to('POST', /\/take$/).length, 0);
    assert.equal(fake.trades.size, 0);
    assert.equal(r.cleared, 1);
  });

  test('a reconcile that runs between keeping a new token and its first send leaves the entry alone', async () => {
    const { store, dir } = await newStore();
    const { board } = client();
    let s!: BoardSession;
    const inside: Array<{ cleared: number; kept: number }> = [];
    // The store answers putPending, then (before the session can send) a reconcile runs on the same session.
    const wrapped = new Proxy(store, {
      get(t, k) {
        if (k === 'putPending') {
          return async (p: PendingCreate) => {
            const kept = await t.putPending(p);
            const r = await s.reconcilePending();
            inside.push({ cleared: r.cleared, kept: r.kept });
            return kept;
          };
        }
        const v = Reflect.get(t, k, t);
        return typeof v === 'function' ? v.bind(t) : v;
      }
    }) as KitStore;
    s = new BoardSession({ board, store: wrapped });
    const posted = await s.postOffer(sellOffer);
    const o = fake.addOffer({ tokenHash: sha256Hex(newControlToken()) });
    const taken = await s.take(await readOffer(board, o.id), { taz: TWO_TAZ, takerPha: B_P, takerBase: B_B });
    assert.deepEqual(inside, [{ cleared: 0, kept: 0 }, { cleared: 0, kept: 0 }], 'the in-flight entries were not touched');
    assert.equal(fake.to('POST', '/v1/p2p/offers').length, 1);
    assert.equal(fake.to('POST', /\/take$/).length, 1);
    assert.equal((await store.getOffer(posted.offer.id))?.makerToken, posted.record.makerToken);
    assert.equal((await store.getTrade(taken.record.id))?.takerToken, taken.record.takerToken);
    assert.equal(pendingOnDisk(dir).length, 0);
  });

  test('an entry the kit cannot send again exactly is kept for the operator; the other entries are still asked about', async () => {
    let now = 1_800_000_000_000;
    const { s, store, dir } = await session({ now: () => now });
    fake.addOffer({ tokenHash: 'a'.repeat(64) });
    const body = { taz: TWO_TAZ, takerPha: B_P, takerBase: B_B, symbol: 'TAZ', price: PRICE };
    // A take kept without the offer it read (the store allows it): its row exists at the board.
    const odd = newControlToken();
    await store.putPending({ kind: 'take', network: 'devnet', token: odd, tokenHash: tokenHashOf(odd), offerId: 41, body, createdAt: now - 2, sentAt: now });
    fake.trades.set(900, { id: 900, offerId: 41, side: 'sell', symbol: 'TAZ', taz: TWO_TAZ, usdc: '2160000', price: PRICE, sPha: M_P, sBase: M_B, bPha: B_P, bBase: B_B, status: 'requested', h: null, takerHash: tokenHashOf(odd), createdAt: fake.clock, updatedAt: fake.clock, fields: JSON.stringify([41, TWO_TAZ, B_P, B_B]) });
    // A take whose body has no price (the kit never sends one): it cannot be asked about either.
    const noPrice = newControlToken();
    await store.putPending({ kind: 'take', network: 'devnet', token: noPrice, tokenHash: tokenHashOf(noPrice), offerId: 41, body: { taz: TWO_TAZ, takerPha: B_P, takerBase: B_B, symbol: 'TAZ' }, seen: { side: 'sell', makerPha: M_P, makerBase: M_B }, createdAt: now - 1, sentAt: now });
    // A well-formed take that never reached the board.
    const good = newControlToken();
    await store.putPending({ kind: 'take', network: 'devnet', token: good, tokenHash: tokenHashOf(good), offerId: 41, body, seen: { side: 'sell', makerPha: M_P, makerBase: M_B }, createdAt: now, sentAt: now });
    now += REPLAY_MIN_AGE_MS;
    const r = await s.reconcilePending();
    assert.equal(r.kept, 2);
    assert.equal(r.cleared, 1);
    assert.equal(r.notes.filter((n) => /cannot be asked about/.test(n)).length, 2);
    const asks = fake.to('POST', /\/take$/);
    assert.equal(asks.length, 1, 'only the well-formed entry is asked');
    assert.equal(asks[0]!.body.takerTokenHash, tokenHashOf(good));
    assert.deepEqual(pendingOnDisk(dir).map((x) => x.name).sort(), [`${tokenHashOf(odd)}.json`, `${tokenHashOf(noPrice)}.json`].sort());
  });

  test('a row answered under an id the store keeps for another row is cleared, and the pass goes on', async () => {
    let now = 1_800_000_000_000;
    const { s, store, dir } = await session({ now: () => now });
    fake.addOffer({ tokenHash: 'a'.repeat(64) });
    const seen = { side: 'sell' as const, makerPha: M_P, makerBase: M_B };
    const body = { taz: TWO_TAZ, takerPha: B_P, takerBase: B_B, symbol: 'TAZ', price: PRICE };
    // The store already keeps trade #900 for another trade (a maker record of some other offer).
    await store.addTrade({ id: 900, network: 'devnet', offerId: 7, role: 'S', maker: true, symbol: 'TAZ', taz: TWO_TAZ, usdc: '2160000', price: PRICE, myPha: S_P, myBase: S_B, txs: {}, createdAt: now, updatedAt: now });
    const clash = newControlToken();
    await store.putPending({ kind: 'take', network: 'devnet', token: clash, tokenHash: tokenHashOf(clash), offerId: 41, body, seen, createdAt: now - 1, sentAt: now });
    fake.trades.set(900, { id: 900, offerId: 41, side: 'sell', symbol: 'TAZ', taz: TWO_TAZ, usdc: '2160000', price: PRICE, sPha: M_P, sBase: M_B, bPha: B_P, bBase: B_B, status: 'requested', h: null, takerHash: tokenHashOf(clash), createdAt: fake.clock, updatedAt: fake.clock, fields: JSON.stringify([41, TWO_TAZ, B_P, B_B]) });
    const lost = newControlToken();
    await store.putPending({ kind: 'take', network: 'devnet', token: lost, tokenHash: tokenHashOf(lost), offerId: 41, body, seen, createdAt: now, sentAt: now });
    now += REPLAY_MIN_AGE_MS;
    const r = await s.reconcilePending();
    assert.equal(r.cleared, 2);
    assert.deepEqual(r.recorded, []);
    assert.ok(r.notes.some((n) => /another row/.test(n)));
    assert.equal(fake.to('POST', /\/take$/).length, 2, 'the second entry was still asked about');
    assert.equal((await store.getTrade(900))?.offerId, 7, 'the kept trade is untouched');
    assert.equal(pendingOnDisk(dir).length, 0);
  });

  test('when the board cannot be asked, every entry is kept', async () => {
    let now = 1_800_000_000_000;
    const { s, store } = await session({ now: () => now });
    const token = newControlToken();
    await store.putPending({ kind: 'take', network: 'devnet', token, tokenHash: tokenHashOf(token), offerId: 41, body: { taz: TWO_TAZ, takerPha: B_P, takerBase: B_B, symbol: 'TAZ', price: PRICE }, seen: { side: 'sell', makerPha: M_P, makerBase: M_B }, createdAt: now, sentAt: now });
    now += REPLAY_MIN_AGE_MS;
    fake.script.push((r) => (r.path === '/v1/p2p/recent' ? 'drop' : undefined));
    const r = await s.reconcilePending();
    assert.equal(r.kept, 1);
    assert.equal(r.boardKeepsHashes, null);
    assert.equal(fake.to('POST', /\/take$/).length, 0);
  });
});

// ── Retries (sections 2.1.2, 2.6, 6.3) ───────────────────────────────────────

describe('retries', () => {
  const offersList = (r: Rec) => r.method === 'GET' && r.path === '/v1/p2p/offers';

  test('a retryable refusal is sent again with the same body after retryAfter', async () => {
    const { board, sleeps } = client();
    fake.addOffer({ tokenHash: 'a'.repeat(64) });
    for (let i = 0; i < 2; i++) fake.script.push((r) => (r.path.endsWith('/take') ? { status: 409, json: { error: { code: 'BUSY', message: 'busy', retryable: true, retryAfter: 7 } } } : undefined));
    const hash = tokenHashOf(newControlToken());
    const a = await board.take(41, { taz: TWO_TAZ, takerPha: B_P, takerBase: B_B, symbol: 'TAZ', price: PRICE, takerTokenHash: hash });
    assert.equal(a.trade.offerId, 41);
    const sends = fake.to('POST', /\/take$/);
    assert.equal(sends.length, 3);
    assert.deepEqual(sends[2]!.body, sends[0]!.body, 'the same body');
    assert.deepEqual(sleeps, [7000, 7000]);
  });

  test('the wait is jittered by +-20% and capped at 60 s', async () => {
    for (const [random, want] of [[0, 4000], [0.999999, 6000]] as const) {
      fake.reset();
      const { board, sleeps } = client({ random });
      fake.script.push((r) => (offersList(r) ? { status: 503, json: { error: { code: 'UNAVAILABLE', message: 'x', retryable: true, retryAfter: 5 } } } : undefined));
      await board.offers();
      assert.ok(Math.abs(sleeps[0]! - want) <= 1, `random ${random}: ${sleeps[0]} ms`);
    }
    fake.reset();
    const { board, sleeps } = client({ random: 0.5 });
    fake.script.push((r) => (offersList(r) ? { status: 409, json: { error: { code: 'CAP_SHARE', message: 'x', retryable: true, retryAfter: 300 } } } : undefined));
    await board.offers();
    assert.deepEqual(sleeps, [RETRY_AFTER_MAX * 1000]);
  });

  test('at most 5 times: a request that keeps failing is sent 6 times in all, then the error is thrown', async () => {
    const { board, sleeps } = client();
    for (let i = 0; i < 10; i++) fake.script.push((r) => (offersList(r) ? { status: 503, json: { error: { code: 'UNAVAILABLE', message: 'x', retryable: true, retryAfter: 10, reason: 'warming' } } } : undefined));
    const e = await rejects(board.offers(), BoardError, 'UNAVAILABLE');
    assert.equal(e.reason, 'warming');
    assert.equal(fake.to('GET', '/v1/p2p/offers').length, 6);
    assert.equal(sleeps.length, 5);
  });

  test('no answer is retried with a growing wait (1, 2, 4, 8, 16 s)', async () => {
    const { board, sleeps } = client();
    for (let i = 0; i < 10; i++) fake.script.push((r) => (offersList(r) ? 'drop' : undefined));
    await rejects(board.offers(), BoardError, 'NETWORK');
    assert.deepEqual(sleeps, [1000, 2000, 4000, 8000, 16000]);
  });

  test('a refusal that is not retryable is thrown at once', async () => {
    const { board, sleeps } = client();
    fake.addOffer({ tokenHash: 'a'.repeat(64) });
    fake.script.push((r) => (r.path.endsWith('/take') ? { status: 409, json: { error: { code: 'FUNDS', message: 'x', retryable: false, reason: 'buyer_usdc' } } } : undefined));
    const e = await rejects(board.take(41, { taz: TWO_TAZ, takerPha: B_P, takerBase: B_B, symbol: 'TAZ', price: PRICE, takerTokenHash: tokenHashOf(newControlToken()) }), CreateError, 'FUNDS');
    assert.equal(e.reason, 'buyer_usdc');
    assert.equal(e.mayExist, false);
    assert.equal(sleeps.length, 0);
  });

  test('maxRetryAfter: a refusal asking for a longer wait is thrown at once', async () => {
    const { board, sleeps } = client();
    fake.script.push((r) => (offersList(r) ? { status: 409, json: { error: { code: 'CAP_SHARE', message: 'x', retryable: true, retryAfter: 300 } } } : undefined));
    const e = await rejects(board.offers({}, { maxRetryAfter: 10 }), BoardError, 'CAP_SHARE');
    assert.equal(e.retryAfter, 300);
    assert.equal(sleeps.length, 0);
  });

  test('an older board (no `retryable`) follows the table of section 2.6', async () => {
    const cases: Array<[Reply, number | null]> = [
      [{ status: 409, json: { error: { code: 'BUSY', message: 'x' } } }, 60_000],
      [{ status: 409, json: { error: { code: 'OFFLINE', message: 'x' } } }, 30_000],
      [{ status: 409, json: { error: { code: 'NOT_YET', message: 'x' } } }, 3_000],
      [{ status: 429, json: { error: { code: 'RATE_LIMITED', message: 'x' } }, headers: { 'Retry-After': '4' } }, 4_000],
      [{ status: 502, text: 'Bad gateway' }, 10_000],
      [{ status: 409, json: { error: { code: 'FUNDS', message: 'x' } } }, null],
      [{ status: 409, json: { error: { code: 'NO_SHOW_LIMIT', message: 'x', retryAfter: 3600 } } }, null],
      [{ status: 503, json: { error: { code: 'ESCROW_NOT_PINNED', message: 'x' } } }, null],
      [{ status: 404, text: '404 Not Found' }, null],
      [{ status: 409, json: { error: { code: 'SOMETHING_NEW', message: 'x' } } }, null]
    ];
    for (const [reply, wait] of cases) {
      fake.reset();
      const { board, sleeps } = client();
      fake.script.push((r) => (offersList(r) ? reply : undefined));
      if (wait == null) {
        await assert.rejects(board.offers(), BoardError);
        assert.deepEqual(sleeps, [], JSON.stringify(reply));
      } else {
        await board.offers();
        assert.deepEqual(sleeps, [wait], JSON.stringify(reply));
      }
    }
  });

  test('the fallback table is the backend\'s section 2.6 table (backend/src/http/errors.ts)', async (t) => {
    const url = new URL('../../backend/src/http/errors.ts', import.meta.url);
    if (!existsSync(url)) { t.skip('the backend (backend/) is not checked out beside the kit'); return; }
    const be = await import(url.href) as { ERROR_CODES: Record<string, { http: number[]; retryable: boolean; retryAfter?: number }> };
    assert.deepEqual(Object.keys(BOARD_ERRORS).sort(), Object.keys(be.ERROR_CODES).sort());
    for (const [code, r] of Object.entries(be.ERROR_CODES)) {
      const k = BOARD_ERRORS[code]!;
      assert.equal(k.retryable, r.retryable, code);
      assert.equal(k.retryAfter, r.retryAfter, code);
      assert.equal(k.http, r.http[0], code);
    }
  });

  test('a create whose answer was lost is sent again to a board that keeps hashes: the 200 replay is the same row', async () => {
    const { s, dir } = await session();
    fake.script.push((r) => (r.path === '/v1/p2p/offers' && r.method === 'POST' ? 'process-then-drop' : undefined));
    const posted = await s.postOffer(sellOffer);
    assert.equal(posted.replayed, true);
    assert.equal(fake.offers.size, 1, 'one offer, not two');
    const posts = fake.to('POST', '/v1/p2p/offers');
    assert.equal(posts.length, 2);
    assert.equal(posts[1]!.body.makerTokenHash, posts[0]!.body.makerTokenHash);
    assert.equal(fake.to('GET', '/v1/p2p/recent').length, 1, 'the board was asked whether it keeps hashes');
    assert.equal(pendingOnDisk(dir).length, 0);
  });

  test('a create whose answer was lost is NOT sent again to a board that does not keep hashes; its entry stays', async () => {
    fake.old = true;
    const { s, dir } = await session();
    fake.script.push((r) => (r.path === '/v1/p2p/offers' && r.method === 'POST' ? 'process-then-drop' : undefined));
    const e = await rejects(s.postOffer(sellOffer), CreateError, 'NETWORK');
    assert.equal(e.mayExist, true);
    assert.equal(fake.to('POST', '/v1/p2p/offers').length, 1);
    assert.equal(fake.offers.size, 1);
    assert.equal(pendingOnDisk(dir).length, 1);
  });

  test('a 200 replay of the same create answers the same row; IDEMPOTENCY_MISMATCH surfaces and is not sent again', async () => {
    const { board, sleeps } = client();
    const hash = tokenHashOf(newControlToken());
    const a = await board.createOffer({ ...sellOffer, makerTokenHash: hash });
    const b = await board.createOffer({ ...sellOffer, makerTokenHash: hash });
    assert.equal(a.replayed, false);
    assert.equal(b.replayed, true);
    assert.equal(b.offer.id, a.offer.id);
    const e = await rejects(board.createOffer({ ...sellOffer, tazTotal: '9000000000', makerTokenHash: hash }), CreateError, 'IDEMPOTENCY_MISMATCH');
    assert.equal(e.retryable, false);
    assert.equal(e.mayExist, false);
    assert.equal(fake.to('POST', '/v1/p2p/offers').length, 3);
    assert.equal(sleeps.length, 0);
  });

  test('a session surfaces IDEMPOTENCY_MISMATCH on a take: no record, the entry dropped', async () => {
    const { s, board, store, dir } = await session();
    const o = fake.addOffer({ tokenHash: 'a'.repeat(64) });
    const offer = await readOffer(board, o.id);
    fake.script.push((r) => (r.path.endsWith('/take') ? { status: 409, json: { error: { code: 'IDEMPOTENCY_MISMATCH', message: 'x', retryable: false } } } : undefined));
    await rejects(s.take(offer, { taz: TWO_TAZ, takerPha: B_P, takerBase: B_B }), CreateError, 'IDEMPOTENCY_MISMATCH');
    assert.equal((await store.listTrades()).length, 0);
    assert.equal(pendingOnDisk(dir).length, 0);
  });

  test('an offer answered in a form the kit cannot read is cancelled at once with its token', async () => {
    const { s, dir } = await session();
    fake.script.push((r) => {
      if (r.path !== '/v1/p2p/offers' || r.method !== 'POST') return undefined;
      const made = fake.addOffer({ tokenHash: r.body.makerTokenHash, side: 'sell' });
      return { status: 201, json: { data: { offer: { id: made.id, network: 'devnet', side: 'sell' }, replayed: false } } };
    });
    const e = await rejects(s.postOffer(sellOffer), CreateError, 'BAD_ANSWER');
    assert.equal(e.mayExist, false);
    assert.equal([...fake.offers.values()][0]!.status, 'closed');
    assert.equal(pendingOnDisk(dir).length, 0);
  });

  test('a following offer sends no price and its dailyMax written out; the record keeps the settings and the board\'s first price', async () => {
    const { s } = await session();
    const posted = await s.postOffer({ ...sellOffer, price: undefined, follow: { offsetBps: 200, limitPrice: '1000000' } });
    const sent = fake.to('POST', '/v1/p2p/offers')[0]!.body;
    assert.equal(sent.price, undefined);
    assert.deepEqual(sent.follow, { offsetBps: 200, limitPrice: '1000000', dailyMax: sellOffer.tazTotal });
    assert.deepEqual(posted.record.follow, { offsetBps: 200, limitPrice: '1000000', dailyMax: sellOffer.tazTotal });
    assert.deepEqual(posted.record.priceHistory, []);
    assert.equal(posted.record.price, posted.offer.price);
  });

  test('reprice: a fixed price joins the history before the board is asked; following turns off once the board took it', async () => {
    const { s, store } = await session();
    const posted = await s.postOffer({ ...sellOffer, price: undefined, follow: { offsetBps: -100, limitPrice: '1000000' } });
    const id = posted.offer.id;
    let historyAtBoard: string[] = [];
    fake.onRequest = (r) => {
      if (r.path.endsWith('/reprice')) historyAtBoard = JSON.parse(readFileSync(store.fileOf('offers', id), 'utf8')).priceHistory.map((x: { price: string }) => x.price);
    };
    const listed = await s.reprice(id, { price: '1150000' });
    assert.equal(listed.price, '1150000');
    assert.deepEqual(historyAtBoard, ['1150000'], 'the price was kept before the board was asked');
    const rec = await store.getOffer(id);
    assert.equal(rec?.follow, null);
    assert.equal(rec?.price, '1150000');
    const req = fake.to('POST', /\/reprice$/)[0]!;
    assert.equal(req.headers.authorization, `Bearer ${posted.record.makerToken}`);
    assert.deepEqual(req.body, { price: '1150000' });
    await s.reprice(id, { follow: { offsetBps: 50, limitPrice: '1100000' } });
    assert.deepEqual((await store.getOffer(id))?.follow, { offsetBps: 50, limitPrice: '1100000', dailyMax: sellOffer.tazTotal });
  });

  test('cancel counts an offer already closed as cancelled (a resend after a lost answer gets CLOSED)', async () => {
    const { s, store } = await session();
    const posted = await s.postOffer(sellOffer);
    fake.script.push((r) => (r.path.endsWith('/cancel') ? 'process-then-drop' : undefined));
    await s.cancel(posted.offer.id);
    assert.equal(fake.to('POST', /\/cancel$/).length, 2);
    assert.ok((await store.getOffer(posted.offer.id))?.closedAt);
  });
});

// ── Long-polls (sections 2.4.3-2.4.5) ────────────────────────────────────────

describe('long-polls', () => {
  function pollerFor(board: BoardClient) {
    const sleeps: number[] = [];
    return { sleeps, poller: new OfferPoller(board, { sleep: async (ms) => { sleeps.push(ms); }, plainEveryMs: 5000 }) };
  }

  test('since = the previous server time; trades are deduplicated; an unchanged answer that did not wait is followed by a 1 s pause', async () => {
    const { s, board, store } = await session();
    const posted = await s.postOffer(sellOffer);
    const token = (await store.getOffer(posted.offer.id))!.makerToken;
    const o = fake.offers.get(posted.offer.id)!;
    fake.trades.set(900, { id: 900, offerId: o.id, side: 'sell', symbol: 'TAZ', taz: TWO_TAZ, usdc: '2160000', price: PRICE, sPha: S_P, sBase: S_B, bPha: B_P, bBase: B_B, status: 'requested', h: null, takerHash: 'f'.repeat(64), createdAt: fake.clock, updatedAt: fake.clock, fields: '' });
    const { poller, sleeps } = pollerFor(board);
    fake.requests = [];

    const r1 = await poller.next([{ id: o.id, token }]);
    assert.equal(r1.mode, 'single');
    assert.equal(fake.requests[0]!.body.wait, undefined, 'the first round (no answer yet) is answered at once');
    assert.equal(fake.requests[0]!.body.since, undefined, 'no since before the first answer');
    assert.deepEqual(r1.changed.map((t) => t.id), [900]);
    assert.equal(r1.serverTime, fake.clock);
    assert.equal(r1.waited, false);
    assert.equal(poller.pauseMs, 0, 'the next round long-polls at once, not after the plain interval');

    // The same trade again, answered at once (the inclusive bound): not "changed", and the next round pauses 1 s.
    fake.script.push((r) => (r.path.endsWith('/heartbeat') ? { status: 200, json: { data: { offer: fake.offerJson(o), trades: [fake.tradeJson(fake.trades.get(900)!)], serverTime: fake.clock + 1, waited: false } } } : undefined));
    const r2 = await poller.next([{ id: o.id, token }]);
    assert.equal(fake.requests[1]!.body.wait, 25);
    assert.equal(fake.requests[1]!.body.since, fake.clock, 'since is the previous answer\'s server time');
    assert.deepEqual(r2.changed, []);
    assert.equal(r2.waited, false);
    assert.equal(poller.pauseMs, UNCHANGED_PAUSE_MS);
    assert.deepEqual(sleeps, []);

    // The next round waits 1 s first; the trade then moved on, so it is "changed" and no pause follows.
    fake.trades.get(900)!.status = 'accepted';
    fake.trades.get(900)!.updatedAt = fake.clock + 2;
    fake.script.push((r) => (r.path.endsWith('/heartbeat') ? { status: 200, json: { data: { offer: fake.offerJson(o), trades: [fake.tradeJson(fake.trades.get(900)!)], serverTime: fake.clock + 2, waited: false } } } : undefined));
    const r3 = await poller.next([{ id: o.id, token }]);
    assert.deepEqual(sleeps, [1000]);
    assert.equal(fake.requests[2]!.body.since, fake.clock + 1);
    assert.deepEqual(r3.changed.map((t) => `${t.id}:${t.status}`), ['900:accepted']);
    assert.equal(poller.pauseMs, 0);

    // An answer that waited and brought the same trades: no pause (the board held it).
    const r4 = await poller.next([{ id: o.id, token }]);
    assert.equal(r4.waited, true);
    assert.deepEqual(r4.changed, []);
    assert.equal(poller.pauseMs, 0);
  });

  test('after a start or a restart the first round sends no wait: a take made while the kit was down comes back at once, not after the board\'s 25 s hold', async () => {
    fake.holds = true;
    // The kit runs: its first round is answered at once; the next one long-polls from that answer, and the board holds it (nothing changed).
    const first = await session();
    const posted = await first.s.postOffer(sellOffer);
    const id = posted.offer.id;
    const before = first.s.poller({ sleep: async () => {} });
    assert.equal((await before.next(await first.s.openOffers())).waited, false);
    assert.equal((await before.next(await first.s.openOffers())).waited, true);
    assert.deepEqual(fake.held, [25], 'a round with a since and nothing new is held for its wait');
    // The kit stops, and a take arrives while it is down (take #32 of the wave C proof came 37 s before the restart).
    await first.store.close();
    const taker = await session();
    const taken = await taker.s.take(await readOffer(taker.board, id), { taz: TWO_TAZ, takerPha: B_P, takerBase: B_B });
    assert.equal(taken.trade.status, 'requested');
    fake.clock += 37;
    // The restart: the store is opened again, and a new poller has no since yet.
    const second = await session({ dir: first.dir });
    const sleeps: number[] = [];
    const after = second.s.poller({ sleep: async (ms) => { sleeps.push(ms); } });
    assert.equal(after.since, null);
    fake.requests = [];
    fake.held = [];
    const restartedAt = fake.clock;
    const r1 = await after.next(await second.s.openOffers());
    const hb = fake.to('POST', `/v1/p2p/offers/${id}/heartbeat`);
    assert.equal(hb.length, 1);
    assert.equal(hb[0]!.body.wait, undefined, 'the first round sends no wait');
    assert.equal(hb[0]!.body.since, undefined);
    assert.deepEqual(fake.held, [], 'the board answered at once');
    assert.equal(fake.clock, restartedAt, 'no board time passed');
    assert.equal(r1.waited, false);
    assert.deepEqual(r1.changed.map((t) => `${t.id}:${t.status}`), [`${taken.trade.id}:requested`], 'the take made while the kit was down is seen on the first round');
    assert.equal(after.pauseMs, 0);
    assert.deepEqual(sleeps, []);
    // The second round long-polls from the first answer's server time: nothing new, so the board holds it.
    const r2 = await after.next(await second.s.openOffers());
    const hb2 = fake.to('POST', `/v1/p2p/offers/${id}/heartbeat`)[1]!;
    assert.equal(hb2.body.wait, 25);
    assert.equal(hb2.body.since, restartedAt);
    assert.equal(r2.waited, true);
    assert.deepEqual(r2.changed, []);
    assert.deepEqual(fake.held, [25]);
    // What the first round sent before (a wait and no since, which the board reads as now) is held for the whole wait.
    fake.held = [];
    const old = await second.s.heartbeat(id, { wait: 25 });
    assert.deepEqual(fake.held, [25], 'a held call without since answers an older take only when its wait ends');
    assert.deepEqual(old.trades.map((t) => t.id), [taken.trade.id]);
  });

  test('several offers go in one batch heartbeat; a per-offer refusal does not stop the round', async () => {
    const { s, board, store } = await session();
    const a = await s.postOffer(sellOffer);
    const b = await s.postOffer({ ...sellOffer, tazTotal: '7000000000' });
    const items = [{ id: a.offer.id, token: (await store.getOffer(a.offer.id))!.makerToken }, { id: b.offer.id, token: newControlToken() }];
    const { poller } = pollerFor(board);
    fake.requests = [];
    const r = await poller.next(items);
    assert.equal(r.mode, 'batch');
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0]!.path, '/v1/p2p/heartbeats');
    assert.equal(fake.requests[0]!.body.wait, undefined, 'the first round is answered at once');
    assert.equal(fake.requests[0]!.body.offers.length, 2);
    assert.equal(fake.requests[0]!.headers.authorization, undefined, 'batch tokens go in the body only');
    assert.ok(r.offers.has(a.offer.id));
    assert.equal(r.errors.get(b.offer.id)?.code, 'UNAUTHORIZED');
    assert.equal(r.serverTime, fake.clock);
    assert.equal(poller.pauseMs, 0);
    // The next round long-polls the batch from that answer's server time.
    await poller.next(items);
    assert.equal(fake.requests.length, 2);
    assert.equal(fake.requests[1]!.path, '/v1/p2p/heartbeats');
    assert.equal(fake.requests[1]!.body.wait, 25);
    assert.equal(fake.requests[1]!.body.since, fake.clock);
  });

  test('a board without the batch route (plain 404) gets one plain heartbeat per offer, polled every 5 s', async () => {
    const { s, board, store } = await session();
    const a = await s.postOffer(sellOffer);
    const b = await s.postOffer({ ...sellOffer, tazTotal: '7000000000' });
    fake.noLongPoll = true;
    const items = await s.openOffers();
    assert.equal(items.length, 2);
    const { poller, sleeps } = pollerFor(board);
    fake.requests = [];
    const r = await poller.next(items);
    assert.equal(r.mode, 'each');
    assert.deepEqual(fake.requests.map((x) => x.path), ['/v1/p2p/heartbeats', `/v1/p2p/offers/${a.offer.id}/heartbeat`, `/v1/p2p/offers/${b.offer.id}/heartbeat`]);
    assert.equal(poller.pauseMs, 5000);
    fake.requests = [];
    await poller.next(items);
    assert.deepEqual(sleeps, [5000]);
    assert.ok(!fake.requests.some((x) => x.path === '/v1/p2p/heartbeats'), 'not asked again for 10 minutes');
    void store;
  });

  test('more than 40 offers go out in batches of 40 without a wait, and are polled every plainEveryMs, never in a tight loop', async () => {
    const { board } = client();
    const items = Array.from({ length: 41 }, () => {
      const token = newControlToken();
      return { id: fake.addOffer({ tokenHash: sha256Hex(token) }).id, token };
    });
    const { poller, sleeps } = pollerFor(board);
    fake.requests = [];
    const r = await poller.next(items);
    assert.equal(r.mode, 'batch');
    const posts = fake.to('POST', '/v1/p2p/heartbeats');
    assert.deepEqual(posts.map((x) => x.body.offers.length), [40, 1]);
    assert.ok(posts.every((x) => x.body.wait === undefined), 'no wait: one held request cannot carry them all');
    assert.equal(r.offers.size, 41);
    assert.equal(poller.pauseMs, 5000, 'a round without a wait is a plain poll');
    await poller.next(items);
    await poller.next(items);
    assert.deepEqual(sleeps, [5000, 5000]);
  });

  test('a board that keeps answering at once with nothing new (over its long-poll cap) is asked less often: 1, 2, 4 s, up to the plain interval', async () => {
    const { board } = client();
    fake.addOffer({ tokenHash: 'a'.repeat(64) });
    fake.trades.set(900, { id: 900, offerId: 41, side: 'sell', symbol: 'TAZ', taz: TWO_TAZ, usdc: '2160000', price: PRICE, sPha: S_P, sBase: S_B, bPha: B_P, bBase: B_B, status: 'accepted', h: null, takerHash: 'f'.repeat(64), createdAt: fake.clock, updatedAt: fake.clock, fields: '' });
    // Every answer at once (X-Waited 0), with the same trade: what a board over its concurrency cap sends.
    for (let i = 0; i < 6; i++) {
      fake.script.push((r) => (r.path === '/v1/p2p/trades/900' ? { status: 200, json: { data: fake.tradeJson(fake.trades.get(900)!) }, headers: { 'X-Server-Time': String(fake.clock), 'X-Waited': '0' } } : undefined));
    }
    const sleeps: number[] = [];
    const p = new TradePoller(board, 900, { sleep: async (ms) => { sleeps.push(ms); }, plainEveryMs: 5000 });
    for (let i = 0; i < 6; i++) await p.next();
    // The first answer is new (no pause); then 1 s (the client rule), 2 s, 4 s, then the plain interval.
    assert.deepEqual(sleeps, [1000, 2000, 4000, 5000]);
    assert.equal(p.pauseMs, 5000);
    // An answer the board held (the default fake: X-Waited 1) starts again from no pause.
    await p.next();
    assert.equal(p.pauseMs, 0);
    // A change starts again from no pause too, and the next unchanged answer that did not wait pauses 1 s.
    fake.trades.get(900)!.status = 'pha_locked';
    fake.trades.get(900)!.updatedAt = fake.clock + 1;
    fake.script.push((r) => (r.path === '/v1/p2p/trades/900' ? { status: 200, json: { data: fake.tradeJson(fake.trades.get(900)!) }, headers: { 'X-Server-Time': String(fake.clock + 1), 'X-Waited': '0' } } : undefined));
    fake.script.push((r) => (r.path === '/v1/p2p/trades/900' ? { status: 200, json: { data: fake.tradeJson(fake.trades.get(900)!) }, headers: { 'X-Server-Time': String(fake.clock + 1), 'X-Waited': '0' } } : undefined));
    assert.equal((await p.next()).changed, true);
    assert.equal(p.pauseMs, 0);
    await p.next();
    assert.equal(p.pauseMs, UNCHANGED_PAUSE_MS);
  });

  test('P2P off on a network is an error, not a fallback', async () => {
    const { board } = client();
    fake.script.push((r) => (r.path === '/v1/p2p/heartbeats' ? { status: 404, json: { error: { code: 'P2P_OFF', message: 'off', retryable: false } } } : undefined));
    const poller = new OfferPoller(board, { sleep: async () => {} });
    await rejects(poller.next([{ id: 1, token: newControlToken() }, { id: 2, token: newControlToken() }]), BoardError, 'P2P_OFF');
  });

  test('a trade long-poll sends symbol=all, wait and since = the previous X-Server-Time, with the same client rule', async () => {
    const { board } = client();
    fake.addOffer({ tokenHash: 'a'.repeat(64) });
    fake.trades.set(900, { id: 900, offerId: 41, side: 'sell', symbol: 'RA', taz: TWO_TAZ, usdc: '4000000', price: '2000000', sPha: S_P, sBase: S_B, bPha: B_P, bBase: B_B, status: 'accepted', h: null, takerHash: 'f'.repeat(64), createdAt: fake.clock, updatedAt: fake.clock, fields: '' });
    const sleeps: number[] = [];
    const p = new TradePoller(board, 900, { sleep: async (ms) => { sleeps.push(ms); } });
    const r1 = await p.next();
    assert.equal(r1.changed, true);
    assert.equal(r1.trade.symbol, 'RA');
    assert.equal(r1.serverTime, fake.clock);
    let q = fake.requests[0]!.query;
    assert.equal(q.get('symbol'), 'all');
    assert.equal(q.get('wait'), null, 'the first round (no answer yet) is answered at once');
    assert.equal(q.get('since'), null);
    assert.equal(p.pauseMs, 0);
    fake.script.push((r) => (r.path === '/v1/p2p/trades/900' ? { status: 200, json: { data: fake.tradeJson(fake.trades.get(900)!) }, headers: { 'X-Server-Time': String(fake.clock + 1), 'X-Waited': '0' } } : undefined));
    const r2 = await p.next();
    q = fake.requests[1]!.query;
    assert.equal(q.get('wait'), '25');
    assert.equal(q.get('since'), String(fake.clock));
    assert.equal(r2.changed, false);
    assert.equal(r2.waited, false);
    assert.equal(p.pauseMs, UNCHANGED_PAUSE_MS);
    await p.next();
    assert.deepEqual(sleeps, [1000]);
    assert.equal(fake.requests[2]!.query.get('since'), String(fake.clock + 1));
  });

  test('every trade read sends symbol=all (one trade, an address\'s trades); offer lists default to all', async () => {
    const { board } = client();
    fake.addOffer({ tokenHash: 'a'.repeat(64) });
    fake.trades.set(901, { id: 901, offerId: 41, side: 'sell', symbol: 'KCAL', taz: '20000000000', usdc: '2000000', price: '1000000', sPha: S_P, sBase: S_B, bPha: B_P, bBase: B_B, status: 'requested', h: null, takerHash: 'f'.repeat(64), createdAt: fake.clock, updatedAt: fake.clock, fields: '' });
    assert.equal((await board.trade(901)).symbol, 'KCAL');
    assert.equal((await board.tradesOf(B_P)).length, 1);
    await board.offers();
    for (const r of fake.requests) assert.equal(r.query.get('symbol'), 'all', r.path);
  });
});

// ── Headers, shapes and logs ─────────────────────────────────────────────────

describe('headers, shapes and logs', () => {
  test('X-API-Key on every request when configured; Bearer only on control calls; neither in a log line', async () => {
    const log: string[] = [];
    const key = 'sat_' + 'K'.repeat(43);
    const { board } = client({ apiKey: key, log });
    const token = newControlToken();
    const a = await board.createOffer({ ...sellOffer, makerTokenHash: tokenHashOf(token) });
    fake.script.push((r) => (r.path.endsWith('/heartbeat') ? { status: 503, json: { error: { code: 'UNAVAILABLE', message: `echo ${token} ${key}`, retryable: true, retryAfter: 1 } } } : undefined));
    await board.heartbeat(a.offer.id, token);
    await board.offers();
    for (const r of fake.requests) assert.equal(r.headers['x-api-key'], key, r.path);
    assert.equal(fake.to('POST', '/v1/p2p/offers')[0]!.headers.authorization, undefined);
    assert.equal(fake.to('GET', '/v1/p2p/offers')[0]!.headers.authorization, undefined);
    assert.equal(fake.to('POST', /\/heartbeat$/)[1]!.headers.authorization, `Bearer ${token}`);
    assert.ok(log.length > 0, 'the retry was logged');
    const all = log.join('\n');
    assert.ok(!all.includes(token) && !all.includes(key), 'no token or key in a log line');
    assert.equal(board.keyed, true);
  });

  test('the API base must be https (or http on this machine), without a user part or a query', () => {
    for (const api of ['http://example.com', 'https://user:pw@example.com', 'https://example.com/?k=1', 'ftp://example.com', 'nonsense']) {
      assert.throws(() => new BoardClient({ network: 'devnet', api }), (e: unknown) => e instanceof SafetyError && e.code === BOARD_SAFETY.API_NOT_ALLOWED, api);
    }
    assert.equal(new BoardClient({ network: 'devnet', api: 'https://apiops.saturnx.cc/' }).api, 'https://apiops.saturnx.cc');
    assert.equal(new BoardClient({ network: 'devnet' }).api, 'https://apiops.saturnx.cc');
    assert.throws(() => new BoardClient({ network: 'testnet' as any }), SafetyError);
  });

  test('answers the kit cannot read are left out of lists, and refused for one row', async () => {
    const { board } = client();
    fake.addOffer({ tokenHash: 'a'.repeat(64) });
    fake.script.push((r) => (r.path === '/v1/p2p/offers' ? { status: 200, json: { data: [fake.offerJson(fake.offers.get(41)!), { ...fake.offerJson(fake.offers.get(41)!), id: 42, symbol: 'DOGE' }, { ...fake.offerJson(fake.offers.get(41)!), id: 43, network: 'mainnet' }] } } : undefined));
    assert.deepEqual((await board.offers()).map((o) => o.id), [41]);
    fake.script.push((r) => (r.path === '/v1/p2p/trades/5' ? { status: 200, json: { data: { id: 5, network: 'devnet', status: 'weird' } } } : undefined));
    await rejects(board.trade(5), BoardError, 'BAD_ANSWER');
    assert.equal(parseOffer({ ...fake.offerJson(fake.offers.get(41)!), symbol: 'taz' }, 'devnet'), null, 'the symbol must be the table\'s exactly');
    assert.equal(parseTrade(null, 'devnet'), null);
  });
});

// ── The devnet faucet (section 2.4.10) ───────────────────────────────────────

describe('the devnet faucet client', () => {
  test('devnet only: a mainnet client is refused before anything is sent', async () => {
    const board = new BoardClient({ network: 'mainnet', api: fake.url });
    await rejects(devnetFaucet(board, { pha: B_P }), SafetyError, 'NETWORK_OFF');
    assert.equal(fake.requests.length, 0);
  });

  test('a claim answers what each part sent; the lines carry amounts and short hashes', async () => {
    const { board } = client();
    const info = await board.faucetInfo();
    assert.equal(info.enabled, true);
    assert.deepEqual(info.parts, { pha: true, base: true });
    const out = await devnetFaucet(board, { pha: B_P, base: B_B }, { sleep: async () => {} });
    assert.equal(out.alreadyServed, false);
    assert.equal(out.claim?.pha?.state, 'confirmed');
    assert.equal(out.claim?.base?.ethTx, null);
    assert.equal(out.claim?.base?.error, 'ETH: not sent');
    const lines = faucetClaimLines(out.claim!).join('\n');
    assert.match(lines, /20 TAZ/);
    assert.match(lines, /500 mUSDC/);
    assert.ok(!lines.includes('AB'.repeat(32)), 'hashes are shortened');
    assert.deepEqual(fake.to('POST', '/v1/p2p/faucet')[0]!.body, { pha: B_P, base: B_B });
  });

  test('a lost answer is asked again once; the faucet then saying "address" means it was already served', async () => {
    const { board } = client();
    fake.script.push((r) => (r.path === '/v1/p2p/faucet' && r.method === 'POST' ? 'process-then-drop' : undefined));
    fake.script.push((r) => (r.path === '/v1/p2p/faucet' && r.method === 'POST' ? { status: 429, json: { error: { code: 'FAUCET_LIMIT', message: 'x', retryable: false, retryAfter: 86000, reason: 'address' } } } : undefined));
    const waits: number[] = [];
    const out = await devnetFaucet(board, { base: B_B }, { sleep: async (ms) => { waits.push(ms); } });
    assert.equal(out.alreadyServed, true);
    assert.equal(out.claim, null);
    assert.equal(out.retryAfter, 86000);
    assert.deepEqual(waits, [5000]);
    assert.equal(fake.to('POST', '/v1/p2p/faucet').length, 2);
  });

  test('FAUCET_EMPTY is not asked again (nothing was sent, and it asks for an hour); a mainnet client never sends a faucet POST', async () => {
    const { board, sleeps } = client();
    fake.script.push((r) => (r.path === '/v1/p2p/faucet' && r.method === 'POST' ? { status: 503, json: { error: { code: 'FAUCET_EMPTY', message: 'low', retryable: true, retryAfter: 3600 } }, headers: { 'Retry-After': '3600' } } : undefined));
    const waits: number[] = [];
    const e = await rejects(devnetFaucet(board, { pha: B_P }, { sleep: async (ms) => { waits.push(ms); } }), BoardError, 'FAUCET_EMPTY');
    assert.equal(e.retryAfter, 3600);
    assert.equal(fake.to('POST', '/v1/p2p/faucet').length, 1);
    assert.deepEqual(waits, []);
    assert.deepEqual(sleeps, []);
    // A server error that may have sent something is still asked again once the faucet can tell (the lost-answer rule).
    fake.script.push((r) => (r.path === '/v1/p2p/faucet' && r.method === 'POST' ? { status: 502, text: 'Bad gateway' } : undefined));
    const later: number[] = [];
    const ok = await devnetFaucet(board, { pha: B_P }, { sleep: async (ms) => { later.push(ms); } });
    assert.equal(ok.claim?.pha?.state, 'confirmed');
    assert.deepEqual(later, [5000]);
    const main = new BoardClient({ network: 'mainnet', api: fake.url });
    fake.requests = [];
    await rejects(main.faucet({ pha: B_P }), SafetyError, 'NETWORK_OFF');
    assert.equal(fake.requests.length, 0);
  });

  test('BoardClient.faucet never resends after a lost answer itself; FAUCET_LIMIT without a lost answer is an error', async () => {
    const { board, sleeps } = client();
    fake.script.push((r) => (r.path === '/v1/p2p/faucet' && r.method === 'POST' ? 'drop' : undefined));
    await rejects(board.faucet({ pha: B_P }), BoardError, 'NETWORK');
    assert.equal(fake.to('POST', '/v1/p2p/faucet').length, 1);
    assert.deepEqual(sleeps, []);
    fake.script.push((r) => (r.path === '/v1/p2p/faucet' && r.method === 'POST' ? { status: 429, json: { error: { code: 'FAUCET_LIMIT', message: 'x', retryable: false, retryAfter: 100, reason: 'address' } } } : undefined));
    const e = await rejects(devnetFaucet(board, { pha: B_P }), BoardError, 'FAUCET_LIMIT');
    assert.equal(e.reason, 'address');
    await rejects(devnetFaucet(board, {}), SafetyError, 'BAD_INPUT');
    await rejects(devnetFaucet(board, { base: '0x' + '0'.repeat(40) }), SafetyError, 'BAD_INPUT');
  });
});
