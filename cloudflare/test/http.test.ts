/**
 * The control API (src/http.ts): every call needs the control token (none
 * set: every call refused), the routes reach the fleet's calls, a start's
 * mainnet yes is only {"mainnet": true}, and ?text answers in lines.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handle, sameSecret, TOKEN_MIN, type FleetApi } from '../src/http.js';
import type { Reply } from '../src/fleet.js';

const TOKEN = 'k'.repeat(TOKEN_MIN);

function fake(o: { sized?: boolean } = {}): FleetApi & { calls: Array<[string, ...unknown[]]> } {
  const calls: Array<[string, ...unknown[]]> = [];
  const ok = (body: Record<string, unknown> = {}): Reply => ({ status: 200, body: { ok: true, ...body } });
  return {
    calls,
    status: () => {
      calls.push(['status']);
      const market = { name: 'market', network: 'mainnet', mode: 'running', since: '2026-11-18T00:00:00Z', secrets: 'set', openOffers: [3], runningTrades: [{ id: 40, status: 'pha_locked' }], lastLines: ['a line'] };
      // A bot with sizeFromBalances: one that has looked at its balances, and one whose next session will.
      const looked = { everyS: 3600, lastLookAt: '2026-11-18T01:00:00.000Z', nextLookAt: '2026-11-18T02:00:00.000Z', lastLook: 'Sized the offers from the balances: 1 listed again. The next look is in 3600 s.' };
      return ok({ bots: o.sized ? [market, { ...market, name: 'sized', sizing: looked }, { ...market, name: 'new', sizing: { everyS: 600, lastLookAt: null, nextLookAt: null, lastLook: null } }] : [market] });
    },
    logs: (name, n) => { calls.push(['logs', name, n]); return ok({ lines: ['one', 'two'] }); },
    dryRun: async (name) => { calls.push(['dryRun', name]); return ok({ lines: ['Dry run done: nothing was sent.'] }); },
    start: async (name, mainnet) => { calls.push(['start', name, mainnet]); return mainnet ? ok({ lines: ['Started on mainnet'] }) : { status: 409, body: { ok: false, error: 'no yes' } }; },
    stop: async (name) => { calls.push(['stop', name]); return ok({ note: 'stopping' }); },
    halt: async (name) => { calls.push(['halt', name]); return ok({ note: 'halted', runningTrades: [{ id: 40, status: 'pha_locked' }] }); }
  };
}

const req = (path: string, o: { method?: string; token?: string | null; body?: string } = {}) => new Request(`https://p2p-bots.example.workers.dev${path}`, {
  method: o.method ?? 'GET',
  headers: o.token === null ? {} : { authorization: `Bearer ${o.token ?? TOKEN}` },
  ...(o.body !== undefined ? { body: o.body } : {})
});

describe('the control token', () => {
  test('no CONTROL_TOKEN (or one too short): every call is refused, and nothing reaches the fleet', async () => {
    const f = fake();
    for (const token of [undefined, '', 'short']) {
      const r = await handle(req('/status'), token, f);
      assert.equal(r.status, 503);
      assert.match(await r.text(), /CONTROL_TOKEN secret is set/);
    }
    assert.equal(f.calls.length, 0);
  });

  test('a call without the token, or with another, is 401; the right one passes', async () => {
    const f = fake();
    assert.equal((await handle(req('/status', { token: null }), TOKEN, f)).status, 401);
    assert.equal((await handle(req('/status', { token: TOKEN + 'x' }), TOKEN, f)).status, 401);
    assert.equal((await handle(req('/bots/market/halt', { method: 'POST', token: 'nope' }), TOKEN, f)).status, 401);
    assert.equal(f.calls.length, 0, 'nothing reached the fleet');
    const r = await handle(req('/status'), TOKEN, f);
    assert.equal(r.status, 200);
    assert.equal((await r.json() as { bots: unknown[] }).bots.length, 1);
    assert.equal(await sameSecret('a', 'a'), true);
    assert.equal(await sameSecret('a', 'b'), false);
  });
});

describe('the routes', () => {
  test('each call reaches its fleet call; methods are checked; unknown paths are 404', async () => {
    const f = fake();
    assert.equal((await handle(req('/bots/market/logs?n=50'), TOKEN, f)).status, 200);
    assert.equal((await handle(req('/bots/market/dry-run', { method: 'POST' }), TOKEN, f)).status, 200);
    assert.equal((await handle(req('/bots/market/stop', { method: 'POST' }), TOKEN, f)).status, 200);
    assert.equal((await handle(req('/bots/market/halt', { method: 'POST' }), TOKEN, f)).status, 200);
    assert.deepEqual(f.calls, [['logs', 'market', 50], ['dryRun', 'market'], ['stop', 'market'], ['halt', 'market']]);
    assert.equal((await handle(req('/bots/market/stop'), TOKEN, f)).status, 405, 'a stop is a POST');
    assert.equal((await handle(req('/status', { method: 'POST' }), TOKEN, f)).status, 405);
    assert.equal((await handle(req('/bots/Market/stop', { method: 'POST' }), TOKEN, f)).status, 404);
    assert.equal((await handle(req('/elsewhere'), TOKEN, f)).status, 404);
  });

  test('a start is a mainnet yes only with the body {"mainnet": true}', async () => {
    const f = fake();
    for (const body of [undefined, '', 'yes', '{"mainnet":"true"}', '{"mainnet":1}', '[true]']) {
      await handle(req('/bots/market/start', { method: 'POST', ...(body !== undefined ? { body } : {}) }), TOKEN, f);
    }
    await handle(req('/bots/market/start', { method: 'POST', body: '{"mainnet": true}' }), TOKEN, f);
    assert.deepEqual(f.calls.map((c) => c[2]), [false, false, false, false, false, false, true]);
  });

  test('?text answers in lines: the status per bot, a call\'s lines, its note and error', async () => {
    const f = fake({ sized: true });
    const s = await (await handle(req('/status?text'), TOKEN, f)).text();
    assert.match(s, /^market \(mainnet\): running since 2026-11-18T00:00:00Z/);
    assert.match(s, /open offers: #3/);
    assert.match(s, /running trades: #40 \(pha_locked\)/);
    assert.equal(s.split('\n').filter((l) => l.includes('sized from the balances')).length, 2, 'only for a bot with the option');
    assert.match(s, /^  offers sized from the balances every 3600 s: last look 2026-11-18T01:00:00\.000Z, next 2026-11-18T02:00:00\.000Z\n  last look: Sized the offers from the balances: 1 listed again\. The next look is in 3600 s\.$/m);
    assert.match(s, /^  offers sized from the balances every 600 s: its next session looks$/m);
    assert.match(await (await handle(req('/bots/market/start?text', { method: 'POST' }), TOKEN, f)).text(), /^Error: no yes/m);
    assert.match(await (await handle(req('/bots/market/halt?text', { method: 'POST' }), TOKEN, f)).text(), /halted\nRunning trades: #40/);
  });
});
