import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { phaRpc, PhaRpcError } from '../src/pha.js';
import { baseClient, BASE_FETCH_OPTIONS } from '../src/base.js';

/**
 * The JSON-RPC envelope of the real Phantasma client. A live node answers a
 * good invokeRawScript with "error": "" beside its results (devnet, read
 * 2026-10-14), which must read as success; only a non-empty error fails.
 *
 * Check 67 for every request: both RPC clients refuse a redirect instead of
 * following it to a host the allowlist never checked (local servers only).
 */

const answer = (body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

test('an empty "error" beside the results is a good answer, as the live node sends it', async () => {
  const rpc = phaRpc('devnet', { fetch: answer({ jsonrpc: '2.0', id: '1', result: { events: [], result: '030100', error: '', results: ['030100'], oracles: [] } }) });
  const out = await rpc.views([{ contract: 'saturnescrow', method: 'getVersion', args: [] }]);
  assert.equal(out.length, 1);
});

test('a non-empty error in the result, or at the top, still fails closed', async () => {
  const inResult = phaRpc('devnet', { fetch: answer({ jsonrpc: '2.0', id: '1', result: { error: 'script failed', results: [] } }) });
  await assert.rejects(inResult.views([{ contract: 'saturnescrow', method: 'getVersion', args: [] }]), PhaRpcError);
  const atTop = phaRpc('devnet', { fetch: answer({ jsonrpc: '2.0', id: '1', error: { message: 'bad request' } }) });
  await assert.rejects(atTop.views([{ contract: 'saturnescrow', method: 'getVersion', args: [] }]), PhaRpcError);
});

/** A server that answers every request with a 307 to `target`, and one that counts what reaches it. */
async function redirectPair(): Promise<{ from: string; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
  const target = createServer((req, res) => { hits++; req.resume(); res.writeHead(200, { 'content-type': 'application/json' }).end('{"jsonrpc":"2.0","id":"1","result":"0x14a34"}'); });
  const tPort = await listen(target);
  const origin = createServer((req, res) => { req.resume(); res.writeHead(307, { location: `http://127.0.0.1:${tPort}/rpc` }).end(); });
  const oPort = await listen(origin);
  return {
    from: `http://127.0.0.1:${oPort}/rpc`,
    hits: () => hits,
    close: async () => { await new Promise((r) => origin.close(r)); await new Promise((r) => target.close(r)); }
  };
}

test('67: the Phantasma client refuses a redirect from its node: views and sends fail, and the other host gets nothing', async () => {
  const pair = await redirectPair();
  try {
    const seen: RequestInit[] = [];
    // The allowlisted host, answered by a local server that redirects (the real fetch, so the redirect mode is real).
    const rpc = phaRpc('devnet', { fetch: (async (_u: string | URL | Request, init?: RequestInit) => { seen.push(init!); return fetch(pair.from, init); }) as typeof fetch });
    await assert.rejects(rpc.views([{ contract: 'saturnescrow', method: 'getVersion', args: [] }]), /no answer/);
    await assert.rejects(rpc.sendRaw('00'), /no answer/);
    assert.equal(pair.hits(), 0, 'nothing reached the host the redirect named');
    assert.ok(seen.length >= 2 && seen.every((i) => i.redirect === 'error'));
  } finally {
    await pair.close();
  }
});

test('67: the Base client refuses a redirect from its RPC: the chain id read fails, and the other host gets nothing', async () => {
  assert.equal(BASE_FETCH_OPTIONS.redirect, 'error');
  const pair = await redirectPair();
  try {
    const client = baseClient('devnet', { url: pair.from, timeoutMs: 5_000 });
    await assert.rejects(client.chainId());
    await assert.rejects(client.sendRaw('0x02'));
    assert.equal(pair.hits(), 0, 'nothing reached the host the redirect named');
  } finally {
    await pair.close();
  }
});
