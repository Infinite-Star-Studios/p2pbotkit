import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Address } from 'phantasma-sdk-ts';
import { phaRpc, PhaRpcError, PhaReader } from '../src/pha.js';
import { baseClient, BASE_FETCH_OPTIONS } from '../src/base.js';
import { escrowFor } from '../src/checks.js';
import { hexToDecimal } from '../src/codec.js';
import { readVectors } from './fixtures/sdk-vectors.js';

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

// ── What PhaReader reads from a node's answers ──────────────────────────────
//
// The escrow reads over a node that answers each invokeRawScript with the next
// list of VM values, as the live node does (one per call, in `results`), read
// by the kit's SDK and then by the kit's own readers.

const vm = {
  len: (n: number) => n.toString(16).padStart(2, '0'),
  num(n: bigint): string {
    if (n === 0n) return '030100';
    let h = n.toString(16);
    if (h.length % 2) h = '0' + h;
    let b = Buffer.from(h, 'hex').reverse();
    if (b[b.length - 1]! & 0x80) b = Buffer.concat([b, Buffer.from([0])]); // the node's 00 sign byte
    return '03' + vm.len(b.length) + b.toString('hex');
  },
  str: (t: string) => '04' + vm.len(Buffer.byteLength(t, 'latin1')) + Buffer.from(t, 'latin1').toString('hex'),
  bool: (x: boolean) => (x ? '0601' : '0600'),
  addr(text: string): string {
    const b = Buffer.from(Address.FromText(text).ToByteArray());
    return '08' + vm.len(b.length + 1) + vm.len(b.length) + b.toString('hex');
  }
};

/** A node that answers the kit's reads, in order, with these lists of VM values. */
function readsOver(...answers: string[][]): PhaReader {
  const left = [...answers];
  const nodeFetch = (async () => {
    const results = left.shift();
    if (!results) throw new Error('fake node: a read more than expected');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: '1', result: { events: [], result: results[0] ?? '', error: '', results, oracles: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return new PhaReader(phaRpc('devnet', { fetch: nodeFetch }), 'devnet');
}

const devnet = (() => { const r = escrowFor('devnet'); if (!r.ok) throw new Error('the devnet escrow'); return r.cfg; })();
const [S, R] = readVectors().keys.map((k) => k.address);
const H = '0x' + 'ab'.repeat(32);
const SECRET = '0x' + '12'.repeat(32);

test('PhaReader: a lock\'s symbol keeps its case and loses only its NUL padding; a secret sent as text with a NUL reads the same', async () => {
  const claimed = (symbol: string, secret: string) => readsOver([vm.num(2n)], [
    vm.addr(S!), vm.addr(R!), vm.str(symbol), vm.num(10n ** 8n), vm.num(1_795_000_000n), vm.num(1_794_990_000n), secret
  ]).readLock(devnet, H);
  const padded = await claimed('TAZ\u0000\u0000', vm.str(hexToDecimal(SECRET) + '\u0000'));
  assert.deepEqual(padded, { h: H, state: 2, sender: S, recipient: R, symbol: 'TAZ', amount: 10n ** 8n, deadline: 1_795_000_000, created: 1_794_990_000, secret: SECRET });
  // Never upper-cased: a lock of 'taz' is not TAZ's, so the exact compares of the checks refuse it.
  const lower = await claimed('taz', vm.num(BigInt(SECRET)));
  assert.equal(lower.symbol, 'taz');
  assert.equal(lower.secret, SECRET);
  // hashSecret's digest, as a number or as text with a NUL.
  const digest = '0x' + 'cd'.repeat(32);
  assert.deepEqual(await readsOver([vm.num(BigInt(digest))], [vm.str(hexToDecimal(digest) + '\u0000')]).hashSecrets(devnet, [SECRET, SECRET]), [digest, digest]);
});

test('PhaReader: getPaused reads paused from the number 1 or the Bool true, and open from 0 or false (check 23)', async () => {
  const params = (paused: string) => readsOver([paused, vm.num(600n), vm.num(7_200n), vm.num(10n ** 8n), vm.num(10n ** 12n)]).readParams(devnet, 'TAZ');
  assert.deepEqual(await params(vm.num(1n)), { paused: true, minLock: 600, maxLock: 7_200, minAmount: 10n ** 8n, maxAmount: 10n ** 12n });
  assert.equal((await params(vm.bool(true))).paused, true);
  assert.equal((await params(vm.num(0n))).paused, false);
  assert.equal((await params(vm.bool(false))).paused, false);
});
