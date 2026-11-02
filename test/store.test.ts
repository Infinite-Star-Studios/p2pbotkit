/**
 * The crash-safe store and the key files (build spec sections 6.5 and 6.8):
 *   - atomic writes: a child process killed between the temp write and the
 *     rename (and right after it, and at random moments) leaves the old file
 *     or the new one, never a torn one;
 *   - 'wx' secrets are never overwritten (SECRET_CONFLICT);
 *   - a read-back mismatch throws;
 *   - the single-instance lock refuses a live pid and takes over a dead one;
 *   - modes 0700 and 0600; optional AES-256-GCM sealing;
 *   - key files: never from argv, mode & 0o077 refused, check 68.
 *
 * Keys here are generated on the spot, never funded, and never printed:
 * assertions about them use fixed messages, never the key as a value.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, readdir, stat, chmod, utimes, mkdir, rename } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { randomBytes } from 'node:crypto';
import { PhantasmaKeys } from 'phantasma-sdk-ts';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { openStore, tradeShapeProblem, type KitStore } from '../src/store.js';
import { loadKeys, readSecretFile, wifOk, knownRoleProblem, argvKeyProblem, secretShapedArg } from '../src/keys.js';
import { SafetyError } from '../src/errors.js';
import { makeSecretRecord, newControlToken, tokenHashOf, hashOfSecret } from '../src/codec.js';
import type { LocalTrade, LocalOffer, PendingCreate, SecretRecord } from '../src/types.js';

const KIT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const STORE_URL = new URL('../src/store.ts', import.meta.url).href;
const S_P = 'P2K' + 'S'.repeat(44);
const B_P = 'P2K' + 'B'.repeat(44);
const X_P = 'P2K' + 'X'.repeat(44);
const S_B = '0x' + '5a'.repeat(20);
const B_B = '0x' + 'b7'.repeat(20);

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'kit-store-'));
  dirs.push(d);
  return d;
}
after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

/** Whether `p` rejects with a SafetyError of `code`. */
async function refuses(p: Promise<unknown> | (() => Promise<unknown>), code: string, re?: RegExp): Promise<SafetyError> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    assert.ok(e instanceof SafetyError, `a SafetyError, got ${(e as Error)?.name}: ${(e as Error)?.message}`);
    assert.equal(e.code, code, e.message);
    if (re) assert.match(e.message, re);
    return e;
  }
  assert.fail(`expected SafetyError ${code}`);
}

const trade = (o: Partial<LocalTrade> = {}): LocalTrade => ({
  id: 1, network: 'devnet', offerId: 7, role: 'B', maker: false, symbol: 'TAZ', taz: '5000000000', usdc: '8200000', price: '1640000',
  myPha: B_P, myBase: B_B, takerToken: 'a'.repeat(64), tokenSource: 'client', txs: {}, createdAt: 1_790_000_000_000, updatedAt: 1_790_000_000_000, ...o
});
const offer = (o: Partial<LocalOffer> = {}): LocalOffer => ({
  id: 7, network: 'devnet', side: 'sell', symbol: 'TAZ', makerPha: S_P, makerBase: S_B, tazTotal: '30000000000', tazMin: '1000000000', tazMax: '5000000000',
  price: '1080000', makerToken: 'b'.repeat(64), tokenSource: 'client', priceHistory: [{ price: '1080000', at: 1_790_000_000_000 }], follow: null,
  acceptOnTheirOwn: true, mode: 'standard', createdAt: 1_790_000_000_000, closedAt: null, ...o
});
const pending = (token = newControlToken(), o: Partial<PendingCreate> = {}): PendingCreate => ({
  kind: 'take', network: 'devnet', token, tokenHash: tokenHashOf(token), offerId: 7,
  body: { taz: '5000000000', takerPha: B_P, takerBase: B_B, symbol: 'TAZ', price: '1640000' }, seen: { side: 'sell', makerPha: S_P, makerBase: S_B },
  createdAt: 1_790_000_000_000, sentAt: null, ...o
});
const secret = (o: Partial<Parameters<typeof makeSecretRecord>[0]> = {}): SecretRecord =>
  makeSecretRecord({ tradeId: 1, network: 'devnet', symbol: 'TAZ', taz: '5000000000', sPha: S_P, bPha: B_P, role: 'S', ...o }, 1_790_000_000_000);

const open = (dataDir: string, extra: Record<string, unknown> = {}) => openStore({ dataDir, network: 'devnet', keyFile: null, ...extra });

/** Run kit code in a child process (tsx), so it can be killed mid-write. */
function child(code: string) {
  const p = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `const { openStore } = await import(${JSON.stringify(STORE_URL)});\n${code}`], { cwd: KIT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string; err: string }>((resolve) => p.on('exit', (code, signal) => resolve({ code, signal, out, err })));
  const ready = new Promise<void>((resolve, reject) => {
    const t = setInterval(() => { if (out.includes('ready')) { clearInterval(t); resolve(); } }, 5);
    void exited.then((r) => { clearInterval(t); if (!out.includes('ready')) reject(new Error(`child exited early: ${r.code} ${r.signal} ${r.err.slice(0, 500)}`)); });
  });
  // Only the tests that wait for 'ready' care whether it came.
  ready.catch(() => {});
  return { p, exited, ready };
}

const modeOf = async (p: string) => (await stat(p)).mode & 0o777;

describe('store.ts: layout, modes and atomic writes', () => {
  test('creates dataDir/<network> and its folders 0700, and every file 0600, even with umask 000', async () => {
    const old = process.umask(0o000);
    try {
      const d = join(await tempDir(), 'bot-data');
      const s = await open(d);
      assert.equal(await modeOf(d), 0o700, 'dataDir created 0700');
      assert.equal(await modeOf(s.dir), 0o700);
      for (const k of ['pending', 'offers', 'trades', 'secrets', 'journal']) assert.equal(await modeOf(join(s.dir, k)), 0o700, k);
      await s.addTrade(trade());
      await s.addOffer(offer());
      await s.putPending(pending());
      await s.putSecret(secret());
      await s.addIntent(1, { kind: 'baseLock' });
      for (const k of ['pending', 'offers', 'trades', 'secrets', 'journal']) {
        for (const f of await readdir(join(s.dir, k))) assert.equal(await modeOf(join(s.dir, k, f)), 0o600, `${k}/${f}`);
      }
      assert.equal(await modeOf(join(s.dir, '.lock')), 0o600);
      assert.equal(await modeOf(join(s.dir, 'meta.json')), 0o600);
      await s.close();
      // A data directory whose parents do not exist yet (the examples use ./data/seller).
      const nested = join(await tempDir(), 'data', 'seller');
      const n = await open(nested);
      assert.equal(await modeOf(nested), 0o700);
      assert.equal(await modeOf(join(nested, '..')), 0o700, 'a created parent is private too');
      await n.close();
    } finally {
      process.umask(old);
    }
  });

  test('an existing network folder or file readable by others is made private again when the store opens', async () => {
    const d = await tempDir();
    const s = await open(d);
    await s.addTrade(trade());
    await s.close();
    await chmod(join(d, 'devnet', 'trades'), 0o755);
    await chmod(join(d, 'devnet', 'trades', '1.json'), 0o644);
    const lines: string[] = [];
    const s2 = await open(d, { log: (l: string) => lines.push(l) });
    assert.equal(await modeOf(join(d, 'devnet', 'trades')), 0o700);
    assert.equal(await modeOf(join(d, 'devnet', 'trades', '1.json')), 0o600);
    assert.ok(lines.some((l) => /readable by others; set to 0600/.test(l)));
    await s2.close();
  });

  test('a write that does not read back as written throws STORE_READBACK', async () => {
    const d = await tempDir();
    let corrupt = false;
    const s = await open(d, { hooks: { afterPublish: async (f: string) => { if (corrupt) await writeFile(f, '{"tampered":true}\n'); } } });
    await s.addTrade(trade());
    corrupt = true;
    await refuses(s.patchTrade(1, { status: 'accepted' }), 'STORE_READBACK');
    await refuses(s.addOffer(offer()), 'STORE_READBACK');
    await refuses(s.putSecret(secret()), 'STORE_READBACK');
    await s.close();
  });

  test('a write killed between the temp write and the rename leaves the old file whole; the temp file is removed at the next start', async () => {
    const d = await tempDir();
    const v2 = { status: 'pha_locked', t2: 1_800_001_234 };
    const c = child(`
      let arm = false;
      const s = await openStore({ dataDir: ${JSON.stringify(d)}, network: 'devnet', keyFile: null,
        hooks: { beforeRename: () => { if (arm) process.kill(process.pid, 'SIGKILL'); } } });
      await s.addTrade(${JSON.stringify(trade())});
      arm = true;
      await s.patchTrade(1, ${JSON.stringify(v2)});
      process.stdout.write('not killed');`);
    const r = await c.exited;
    assert.equal(r.signal, 'SIGKILL', r.err.slice(0, 500));
    assert.ok(!r.out.includes('not killed'));
    const names = await readdir(join(d, 'devnet', 'trades'));
    const tmp = names.filter((n) => n.includes('.tmp.'));
    assert.equal(tmp.length, 1, 'the new version was written to its temp file');
    const tmpText = JSON.parse(await readFile(join(d, 'devnet', 'trades', tmp[0]!), 'utf8'));
    assert.equal(tmpText.status, 'pha_locked', 'the temp file holds the whole new version (fsynced before the kill)');
    const onDisk = JSON.parse(await readFile(join(d, 'devnet', 'trades', '1.json'), 'utf8'));
    assert.deepEqual(onDisk, JSON.parse(JSON.stringify(trade())), 'the old version, whole');
    const lines: string[] = [];
    const s = await open(d, { log: (l: string) => lines.push(l) });
    assert.ok(lines.some((l) => /is no longer running; taking over its lock/.test(l)), 'the dead process\'s lock was taken over and logged');
    assert.ok(lines.some((l) => /left by an interrupted write/.test(l)));
    assert.deepEqual(await s.getTrade(1), JSON.parse(JSON.stringify(trade())));
    assert.deepEqual((await readdir(join(d, 'devnet', 'trades'))).sort(), ['1.json']);
    await s.close();
  });

  test('a write killed right after the rename leaves the new file whole', async () => {
    const d = await tempDir();
    const c = child(`
      let arm = false;
      const s = await openStore({ dataDir: ${JSON.stringify(d)}, network: 'devnet', keyFile: null,
        hooks: { afterPublish: () => { if (arm) process.kill(process.pid, 'SIGKILL'); } } });
      await s.addTrade(${JSON.stringify(trade())});
      arm = true;
      await s.patchTrade(1, { status: 'pha_locked', t2: 1800001234 });`);
    const r = await c.exited;
    assert.equal(r.signal, 'SIGKILL', r.err.slice(0, 500));
    const s = await open(d);
    const t = await s.getTrade(1);
    assert.equal(t?.status, 'pha_locked');
    assert.equal(t?.t2, 1_800_001_234);
    await s.close();
  });

  test('killed at random moments while rewriting a record in a loop: the file always parses as one whole version', async () => {
    const d = await tempDir();
    for (let round = 0; round < 6; round++) {
      const c = child(`
        const s = await openStore({ dataDir: ${JSON.stringify(d)}, network: 'devnet', keyFile: null });
        await s.addTrade(${JSON.stringify(trade())});
        process.stdout.write('ready\\n');
        for (let i = 1; ; i++) await s.patchTrade(1, { t2: 1800000000 + i, feeShown: i % 200 });`);
      await c.ready;
      await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 60)));
      c.p.kill('SIGKILL');
      const r = await c.exited;
      assert.equal(r.signal, 'SIGKILL');
      const raw = JSON.parse(await readFile(join(d, 'devnet', 'trades', '1.json'), 'utf8'));
      assert.equal(tradeShapeProblem(raw, 'devnet'), null, `round ${round}: a whole record`);
      if (raw.t2 !== undefined) assert.equal(raw.feeShown, (raw.t2 - 1_800_000_000) % 200, `round ${round}: one version, not a mix`);
      const s = await open(d);
      assert.ok(await s.getTrade(1));
      assert.ok(!(await readdir(join(d, 'devnet', 'trades'))).some((n) => n.includes('.tmp.')), 'no temp file left after a start');
      await s.close();
    }
  });
});

describe('store.ts: the single-instance lock', () => {
  test('a second store on the same folder in this process is refused; close releases it', async () => {
    const d = await tempDir();
    const a = await open(d);
    await refuses(open(d), 'STORE_LOCKED', new RegExp(`process ${process.pid}`));
    await a.close();
    await assert.rejects(stat(join(d, 'devnet', '.lock')), { code: 'ENOENT' });
    await refuses(a.addTrade(trade()), 'STORE_CLOSED');
    const b = await open(d);
    await b.close();
  });

  test('a live process holding the folder refuses the start; once it is dead, the lock is taken over and logged', async () => {
    const d = await tempDir();
    const c = child(`
      const s = await openStore({ dataDir: ${JSON.stringify(d)}, network: 'devnet', keyFile: null });
      process.stdout.write('ready\\n');
      setInterval(() => {}, 1000);`);
    await c.ready;
    await refuses(open(d), 'STORE_LOCKED', new RegExp(`process ${c.p.pid}`));
    c.p.kill('SIGKILL');
    await c.exited;
    const lines: string[] = [];
    const s = await open(d, { log: (l: string) => lines.push(l) });
    assert.ok(lines.some((l) => l.includes(`process ${c.p.pid}`) && /no longer running; taking over/.test(l)));
    await s.close();
  });

  test('a store that lost its lock writes nothing more (STORE_LOCK_LOST)', async () => {
    const d = await tempDir();
    const s = await open(d);
    await s.addTrade(trade());
    const lock = join(s.dir, '.lock');
    const held = JSON.parse(await readFile(lock, 'utf8'));
    await writeFile(lock, JSON.stringify({ ...held, nonce: 'someone-else' }), { mode: 0o600 });
    await refuses(s.patchTrade(1, { status: 'accepted' }), 'STORE_LOCK_LOST');
    await refuses(s.putSecret(secret()), 'STORE_LOCK_LOST');
    assert.equal((await s.getTrade(1))?.status, undefined, 'nothing was written');
    await s.close();
    assert.ok(JSON.parse(await readFile(lock, 'utf8')).nonce === 'someone-else', 'close never removes a lock that is not its own');
  });

  test('an unreadable lock file is refused while fresh (another process may be writing it) and taken over once old', async () => {
    const d = await tempDir();
    await mkdir(join(d, 'devnet'), { recursive: true, mode: 0o700 });
    const lock = join(d, 'devnet', '.lock');
    await writeFile(lock, '', { mode: 0o600 });
    await refuses(open(d), 'STORE_LOCKED', /being opened/);
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    const lines: string[] = [];
    const s = await open(d, { log: (l: string) => lines.push(l) });
    assert.ok(lines.some((l) => /cannot be read/.test(l)));
    await s.close();
  });

  test('a lock left by an earlier run under this same process id (a restarted container) is taken over; one this process may hold is refused', async () => {
    const d = await tempDir();
    await mkdir(join(d, 'devnet'), { recursive: true, mode: 0o700 });
    const lock = join(d, 'devnet', '.lock');
    // The bot ran as this same pid an hour ago (node is pid 1 again after `docker restart`) and was killed.
    await writeFile(lock, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: Date.now() - 3_600_000, nonce: 'earlier-run' }), { mode: 0o600 });
    const lines: string[] = [];
    const s = await open(d, { log: (l: string) => lines.push(l) });
    assert.ok(lines.some((l) => l.includes(`process id ${process.pid}`) && /earlier run .* has ended; taking over/.test(l)), 'taken over and logged');
    assert.notEqual(JSON.parse(await readFile(lock, 'utf8')).nonce, 'earlier-run');
    await refuses(open(d), 'STORE_LOCKED', /already open here/);
    await s.addTrade(trade());
    await s.close();
    // A lock naming this process and written after it started (another copy of the store in this process): refused.
    await writeFile(lock, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: Date.now(), nonce: 'another-copy' }), { mode: 0o600 });
    await refuses(open(d), 'STORE_LOCKED', /already open here/);
    assert.equal(JSON.parse(await readFile(lock, 'utf8')).nonce, 'another-copy', 'left as it was');
  });

  test('a lock held on another machine is never taken over', async () => {
    const d = await tempDir();
    await mkdir(join(d, 'devnet'), { recursive: true, mode: 0o700 });
    await writeFile(join(d, 'devnet', '.lock'), JSON.stringify({ pid: 999_999, host: 'another-machine', startedAt: 1_790_000_000_000, nonce: 'x' }), { mode: 0o600 });
    await refuses(open(d), 'STORE_LOCKED', /another-machine/);
  });
});

describe('store.ts: records', () => {
  let d: string;
  let s: KitStore;
  before(async () => { d = await tempDir(); s = await open(d); });
  after(async () => { await s.close(); });

  test('secrets: written once with \'wx\' semantics; the same record again is a no-op; a different one under that h is SECRET_CONFLICT and changes nothing', async () => {
    const a = secret();
    assert.deepEqual(await s.putSecret(a), a);
    const file = s.fileOf('secrets', a.h);
    const before = await readFile(file, 'utf8');
    assert.deepEqual(await s.putSecret(a), a, 'idempotent');
    await refuses(s.putSecret({ ...a, tradeId: 2 }), 'SECRET_CONFLICT');
    await refuses(s.putSecret({ ...a, createdAt: a.createdAt + 1 }), 'SECRET_CONFLICT');
    assert.equal(await readFile(file, 'utf8'), before, 'never overwritten');
    assert.deepEqual(await s.getSecret(a.h), a);
    await refuses(s.putSecret({ ...a, h: hashOfSecret('0x' + '01'.repeat(32)) }), 'SECRET_INVALID', /does not open h/);
    await refuses(s.putSecret({ ...a, network: 'mainnet' }), 'SECRET_INVALID');
    // A replaced secret for the same trade is a second file; the first one is kept.
    const b = secret();
    await s.putSecret(b);
    assert.deepEqual((await s.secretsOfTrade(1)).map((x) => x.h).sort(), [a.h, b.h].sort());
    assert.equal(await s.hashUsedElsewhere(a.h, 1), false);
    assert.equal(await s.hashUsedElsewhere(a.h, 2), true, 'check 38: another trade must not use this h');
    assert.equal(await s.pruneSecret(b.h), true, 'only an explicit prune removes one');
    assert.equal(await s.getSecret(b.h), null);
  });

  test('trades (check 13): saved and read back; the same trade again is a no-op; another trade under that id is refused', async () => {
    const t = trade({ id: 5 });
    assert.deepEqual(await s.addTrade(t), t);
    assert.deepEqual(await s.addTrade({ ...t, createdAt: t.createdAt + 5000, updatedAt: t.updatedAt + 5000 }), t, 'a replay after a restart keeps the first record');
    await refuses(s.addTrade({ ...t, taz: '6000000000' }), 'RECORD_CONFLICT', /already kept for another trade/);
    await refuses(s.addTrade({ ...t, myBase: '0x' + 'c3'.repeat(20) }), 'RECORD_CONFLICT');
    await refuses(s.addTrade({ ...t, takerToken: 'c'.repeat(64) }), 'RECORD_CONFLICT');
    await refuses(s.addTrade({ ...t, id: 6, symbol: 'DOGE' }), 'RECORD_INVALID');
    await refuses(s.addTrade({ ...t, id: 6, myBase: S_B.toUpperCase() }), 'RECORD_INVALID');
    await refuses(s.addTrade({ ...t, id: 6, network: 'mainnet' }), 'RECORD_INVALID');
    await refuses(s.addTrade({ ...t, id: 6, takerToken: undefined }), 'RECORD_INVALID');
  });

  test('trades: write-once fields never change, first-kept fields keep their first value, the rest is replaced', async () => {
    const h = '0x' + '1f'.repeat(32);
    let t = await s.patchTrade(5, { h: h.toUpperCase().replace('0X', '0x'), phaContract: 'saturnescrow', t1: 1_800_002_400, counterPha: S_P, counterBase: S_B.toUpperCase().replace('0X', '0x') });
    assert.equal(t.h, h);
    assert.equal(t.counterBase, S_B);
    t = await s.patchTrade(5, { h, t1: 1_800_002_400 });
    await refuses(s.patchTrade(5, { h: '0x' + '2e'.repeat(32) }), 'RECORD_CONFLICT', /another h/);
    await refuses(s.patchTrade(5, { t1: 1_800_002_401 }), 'RECORD_CONFLICT');
    await refuses(s.patchTrade(5, { counterPha: X_P }), 'RECORD_CONFLICT');
    t = await s.patchTrade(5, { secretSentAt: 1_790_000_100_000, t2: 1_800_001_000, feeShown: 100, txs: { baseLock: '0x' + 'ab'.repeat(32) }, status: 'base_locked' });
    t = await s.patchTrade(5, { secretSentAt: 1_790_000_200_000, t2: 1_800_001_100, txs: { claimPha: 'AB'.repeat(32) } });
    assert.equal(t.secretSentAt, 1_790_000_100_000, 'the first send time is kept');
    assert.equal(t.t2, 1_800_001_100);
    assert.deepEqual(t.txs, { baseLock: '0x' + 'ab'.repeat(32), claimPha: 'AB'.repeat(32) });
    await refuses(s.patchTrade(5, { feeShown: 150 }), 'RECORD_CONFLICT', /fee shown/);
    await refuses(s.patchTrade(5, { txs: { baseLock: 'nope' } }), 'RECORD_INVALID');
    await refuses(s.patchTrade(99, { status: 'accepted' }), 'RECORD_CONFLICT', /No trade #99/);
    assert.deepEqual(await s.getTrade(5), t);
    assert.ok((await s.listTrades()).some((x) => x.id === 5));
    assert.equal(await s.hashUsedElsewhere(h, 6), true);
    assert.equal(await s.hashUsedElsewhere(h, 5), false);
  });

  test('trades: the fee shown is replaced until h is recorded, and never changes after (checks 32 and 54)', async () => {
    await s.addTrade(trade({ id: 8, role: 'S', maker: true, myPha: S_P, myBase: S_B, takerToken: undefined }));
    await s.patchTrade(8, { feeShown: 100 });
    assert.equal((await s.patchTrade(8, { feeShown: 120 })).feeShown, 120, 'no lock yet: replaced');
    await refuses(s.patchTrade(8, { feeShown: -1 }), 'RECORD_INVALID');
    await s.patchTrade(8, { h: '0x' + '3d'.repeat(32), phaContract: 'saturnescrow', t1: 1_800_002_400 });
    await refuses(s.patchTrade(8, { feeShown: 150 }), 'RECORD_CONFLICT', /fee shown/);
    await refuses(s.patchTrade(8, { feeShown: 0, status: 'pha_locked' }), 'RECORD_CONFLICT');
    assert.equal((await s.getTrade(8))?.status, undefined, 'a refused patch writes nothing');
    assert.equal((await s.patchTrade(8, { feeShown: 120, status: 'pha_locked' })).feeShown, 120, 'the same fee again is fine');
    // A record that has h but no fee yet (the buyer stores h before its lock) may still record one.
    await s.addTrade(trade({ id: 9 }));
    await s.patchTrade(9, { h: '0x' + '4c'.repeat(32) });
    assert.equal((await s.patchTrade(9, { feeShown: 100 })).feeShown, 100);
  });

  test('offers: saved once; the price history only grows; closedAt keeps its first value', async () => {
    const o = offer();
    assert.deepEqual(await s.addOffer(o), o);
    assert.deepEqual(await s.addOffer({ ...o, createdAt: o.createdAt + 1 }), o);
    await refuses(s.addOffer({ ...o, makerToken: 'c'.repeat(64) }), 'RECORD_CONFLICT');
    let x = await s.patchOffer(7, { price: '1100000' });
    x = await s.patchOffer(7, { follow: { offsetBps: 200, limitPrice: '1050000' }, acceptOnTheirOwn: false, closedAt: 1_790_000_500_000 });
    x = await s.patchOffer(7, { closedAt: 1_790_000_600_000 });
    assert.equal(x.price, '1100000');
    assert.deepEqual(x.priceHistory.map((p) => p.price), ['1080000', '1100000']);
    assert.deepEqual(x.follow, { offsetBps: 200, limitPrice: '1050000' });
    assert.equal(x.closedAt, 1_790_000_500_000);
    await refuses(s.patchOffer(7, { follow: { offsetBps: 2001, limitPrice: '1' } }), 'RECORD_INVALID');
    assert.deepEqual((await s.listOffers()).map((y) => y.id), [7]);
  });

  test('pending creates: kept before the POST under their token hash; never replaced; the send time is recorded; deleted once recorded', async () => {
    const p = pending();
    assert.deepEqual(await s.putPending(p), p);
    assert.deepEqual(await s.putPending(p), p, 'idempotent');
    await refuses(s.putPending({ ...p, body: { ...(p.body as object), taz: '1000000000' } as PendingCreate['body'] }), 'RECORD_CONFLICT');
    await refuses(s.putPending({ ...p, tokenHash: tokenHashOf(newControlToken()) }), 'RECORD_INVALID', /tokenHash/);
    await refuses(s.putPending({ ...p, token: p.token.toUpperCase(), tokenHash: p.tokenHash }), 'RECORD_INVALID', /token/);
    const sent = await s.markPendingSent(p.tokenHash, 1_790_000_001_000);
    assert.equal(sent.sentAt, 1_790_000_001_000);
    assert.equal(sent.token, p.token);
    assert.deepEqual(await s.putPending(p), sent, 'the same create again after its send: a no-op that returns the kept entry');
    assert.deepEqual(await s.putPending({ ...p, createdAt: p.createdAt + 5 }), sent, 'its times aside');
    await refuses(s.putPending({ ...p, offerId: 8 }), 'RECORD_CONFLICT');
    await refuses(s.putPending({ ...p, seen: { side: 'buy', makerPha: S_P, makerBase: S_B } }), 'RECORD_CONFLICT');
    assert.deepEqual((await s.listPending()).map((x) => x.tokenHash), [p.tokenHash]);
    assert.equal(await s.deletePending(p.tokenHash), true);
    assert.equal(await s.deletePending(p.tokenHash), false);
    assert.equal(await s.getPending(p.tokenHash), null);
  });

  test('the journal: an intent before the send, the tx hash right after, the outcome once; open intents for the restart', async () => {
    const a = await s.addIntent(5, { kind: 'baseLock', h: '0x' + '1F'.repeat(32), nonce: 3 });
    const b = await s.addIntent(5, { kind: 'claimPha' });
    assert.notEqual(a.id, b.id);
    assert.equal(a.h, '0x' + '1f'.repeat(32));
    await s.recordSent(5, a.id, { txHash: '0x' + 'cd'.repeat(32), nonce: 3 });
    await refuses(s.recordSent(5, a.id, { txHash: '0x' + 'ef'.repeat(32) }), 'RECORD_CONFLICT');
    assert.deepEqual((await s.openIntents()).map((x) => x.intent.id), [a.id, b.id]);
    await s.resolveIntent(5, a.id, 'confirmed');
    await s.resolveIntent(5, a.id, 'confirmed');
    await refuses(s.resolveIntent(5, a.id, 'failed'), 'RECORD_CONFLICT');
    assert.deepEqual((await s.openIntents()).map((x) => x.intent.id), [b.id]);
    const j = await s.getJournal(5);
    assert.equal(j.intents[0]!.txHash, '0x' + 'cd'.repeat(32));
    assert.equal(j.intents[0]!.outcome, 'confirmed');
    await refuses(s.resolveIntent(5, 'nope-1', 'failed'), 'RECORD_CONFLICT');
  });

  test('the journal: a Base send keeps its fees, and every transaction later sent at its nonce (a replacement, a cancel) while it is open', async () => {
    const a = await s.addIntent(6, { kind: 'claimBase', h: '0x' + '2a'.repeat(32), nonce: 4 });
    const h1 = '0x' + '11'.repeat(32), h2 = '0x' + '22'.repeat(32), c1 = '0x' + '33'.repeat(32);
    await s.recordSent(6, a.id, { txHash: h1, nonce: 4, maxFee: 21_000_000n, maxPrio: 1_000_000n });
    let i = (await s.getJournal(6)).intents[0]!;
    assert.deepEqual([i.hashes, i.maxFee, i.maxPrio, typeof i.lastSentAt], [[h1], '21000000', '1000000', 'number']);
    await s.recordResend(6, a.id, { txHash: h2, nonce: 4, maxFee: 30_000_000n, maxPrio: 1_250_000n });
    await s.recordResend(6, a.id, { txHash: h2, nonce: 4, maxFee: 30_000_000n, maxPrio: 1_250_000n });
    await s.recordResend(6, a.id, { txHash: c1, nonce: 4, maxFee: 40_000_000n, maxPrio: 1_600_000n, cancel: true });
    i = (await s.getJournal(6)).intents[0]!;
    assert.deepEqual(i.hashes, [h1, h2], 'the replacement joins the first, once');
    assert.equal(i.txHash, h2, 'txHash is the newest step transaction');
    assert.deepEqual(i.cancelHashes, [c1]);
    assert.deepEqual([i.maxFee, i.maxPrio], ['40000000', '1600000'], 'the fees the next one must outbid');
    // Another nonce, or an intent already settled: refused.
    await refuses(s.recordResend(6, a.id, { txHash: '0x' + '44'.repeat(32), nonce: 5, maxFee: 1n, maxPrio: 1n }), 'RECORD_CONFLICT');
    await s.resolveIntent(6, a.id, 'confirmed');
    await refuses(s.recordResend(6, a.id, { txHash: '0x' + '44'.repeat(32), nonce: 4, maxFee: 1n, maxPrio: 1n }), 'RECORD_CONFLICT');
    // A journal file whose hashes do not read is STORE_CORRUPT.
    const j = await s.getJournal(6);
    await writeFile(join(s.dir, 'journal', '6.json'), JSON.stringify({ ...j, intents: [{ ...j.intents[0], hashes: ['0x12'] }] }), { mode: 0o600 });
    await refuses(s.getJournal(6), 'STORE_CORRUPT');
    await writeFile(join(s.dir, 'journal', '6.json'), JSON.stringify({ ...j, intents: [{ ...j.intents[0], maxFee: '-1' }] }), { mode: 0o600 });
    await refuses(s.getJournal(6), 'STORE_CORRUPT');
    await rm(join(s.dir, 'journal', '6.json'));
  });

  test('ids stay unique across a restart, and concurrent writes to one file are serialised', async () => {
    await s.close();
    s = await open(d);
    const ids = await Promise.all(Array.from({ length: 8 }, (_, i) => s.addIntent(5, { kind: i % 2 ? 'claimBase' : 'refundPha' })));
    const all = (await s.getJournal(5)).intents.map((i) => i.id);
    assert.equal(new Set(all).size, all.length, 'unique ids');
    assert.equal(all.length, 10, 'no lost update');
    assert.ok(ids.every((x) => all.includes(x.id)));
  });

  test('a damaged file is STORE_CORRUPT, never silently skipped', async () => {
    await writeFile(join(s.dir, 'trades', '77.json'), '{"id": 77, "half', { mode: 0o600 });
    await refuses(s.getTrade(77), 'STORE_CORRUPT');
    await refuses(s.listTrades(), 'STORE_CORRUPT');
    await writeFile(join(s.dir, 'trades', '77.json'), JSON.stringify(trade({ id: 78 })), { mode: 0o600 });
    await refuses(s.getTrade(77), 'STORE_CORRUPT', /not a valid record/);
    await rm(join(s.dir, 'trades', '77.json'));
  });
});

describe('store.ts: optional AES-256-GCM sealing (KIT_STORE_KEY_FILE)', () => {
  test('tokens and secrets are sealed at rest and read back; the journal stays plain', async () => {
    const d = await tempDir();
    const keyFile = join(d, 'store.key');
    await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
    const s = await openStore({ dataDir: d, network: 'devnet', env: { KIT_STORE_KEY_FILE: keyFile } });
    assert.equal(s.sealed, true);
    const sec = secret();
    const p = pending();
    await s.putSecret(sec);
    await s.putPending(p);
    await s.addTrade(trade());
    await s.addOffer(offer());
    await s.addIntent(1, { kind: 'phaLock' });
    for (const [kind, name, plain] of [['secrets', sec.h, sec.secret.slice(2)], ['pending', p.tokenHash, p.token], ['trades', '1', 'a'.repeat(64)], ['offers', '7', 'b'.repeat(64)]] as const) {
      const text = await readFile(join(s.dir, kind, `${name}.json`), 'utf8');
      assert.ok(!text.includes(plain), `${kind}: the token or secret is not in the file`);
      assert.match(text, /"sealed":"aes-256-gcm"/);
    }
    assert.match(await readFile(join(s.dir, 'journal', '1.json'), 'utf8'), /"phaLock"/);
    assert.deepEqual(await s.getSecret(sec.h), sec);
    assert.deepEqual(await s.getPending(p.tokenHash), p);
    await s.close();
    // The same key as 64 hex digits opens it too.
    await writeFile(keyFile + '.hex', (await readFile(keyFile)).toString('hex') + '\n', { mode: 0o600 });
    const s2 = await openStore({ dataDir: d, network: 'devnet', keyFile: keyFile + '.hex' });
    assert.deepEqual(await s2.getSecret(sec.h), sec);
    // A sealed file moved to another name does not open (its path is bound in).
    await rename(join(s2.dir, 'trades', '1.json'), join(s2.dir, 'trades', '2.json'));
    await refuses(s2.getTrade(2), 'STORE_CORRUPT', /does not open/);
    // A changed byte does not open.
    const f = join(s2.dir, 'secrets', `${sec.h}.json`);
    const sealed = JSON.parse(await readFile(f, 'utf8'));
    const data = Buffer.from(sealed.data, 'base64');
    data[0] = (data[0]! ^ 1) & 0xff;
    await writeFile(f, JSON.stringify({ ...sealed, data: data.toString('base64') }), { mode: 0o600 });
    await refuses(s2.getSecret(sec.h), 'STORE_CORRUPT');
    // The right tag cut to 4 bytes (which Node accepts unless told the tag length), or another IV length, does not open.
    const pf = s2.fileOf('pending', p.tokenHash);
    const sealedP = JSON.parse(await readFile(pf, 'utf8'));
    await writeFile(pf, JSON.stringify({ ...sealedP, tag: Buffer.from(sealedP.tag, 'base64').subarray(0, 4).toString('base64') }), { mode: 0o600 });
    await refuses(s2.getPending(p.tokenHash), 'STORE_CORRUPT', /does not open/);
    await writeFile(pf, JSON.stringify({ ...sealedP, iv: Buffer.concat([Buffer.from(sealedP.iv, 'base64'), Buffer.alloc(4)]).toString('base64') }), { mode: 0o600 });
    await refuses(s2.getPending(p.tokenHash), 'STORE_CORRUPT', /does not open/);
    await writeFile(pf, JSON.stringify(sealedP), { mode: 0o600 });
    assert.deepEqual(await s2.getPending(p.tokenHash), p, 'the untouched file still opens');
    await s2.close();
    // Without the key, or with another key, the sealed store refuses to open.
    await refuses(openStore({ dataDir: d, network: 'devnet', keyFile: null }), 'STORE_KEY', /sealed/);
    const other = join(d, 'other.key');
    await writeFile(other, randomBytes(32), { mode: 0o600 });
    await refuses(openStore({ dataDir: d, network: 'devnet', keyFile: other }), 'STORE_KEY', /not the key/);
    // The key file follows the key-file rules.
    await chmod(keyFile, 0o644);
    await refuses(openStore({ dataDir: d, network: 'devnet', keyFile }), 'KEY_FILE_MODE');
    const short = join(d, 'short.key');
    await writeFile(short, randomBytes(16), { mode: 0o600 });
    await refuses(openStore({ dataDir: d, network: 'devnet', keyFile: short }), 'STORE_KEY', /32 bytes/);
  });
});

describe('keys.ts: key files, argv and check 68', () => {
  let d: string;
  let wif: string;
  let pk: `0x${string}`;
  let phaFile: string;
  let baseFile: string;
  let addr: { pha: string; base: string };
  before(async () => {
    d = await tempDir();
    const k = PhantasmaKeys.generate();
    wif = k.toWIF();
    pk = generatePrivateKey();
    addr = { pha: k.Address.Text, base: privateKeyToAccount(pk).address };
    phaFile = join(d, 'pha.json');
    baseFile = join(d, 'base.json');
    await writeFile(phaFile, JSON.stringify({ wif }), { mode: 0o600 });
    await writeFile(baseFile, JSON.stringify({ privateKey: pk }), { mode: 0o600 });
    await chmod(phaFile, 0o600);
    await chmod(baseFile, 0o600);
  });
  const load = (o: Record<string, unknown> = {}) => loadKeys({ network: 'devnet', phaKeyFile: phaFile, baseKeyFile: baseFile, argv: ['node', 'bot.ts'], ...o });
  const noKeyIn = (s: string, what: string) => {
    assert.ok(!s.includes(wif), `${what}: no WIF`);
    assert.ok(!s.toLowerCase().includes(pk.slice(2).toLowerCase()), `${what}: no Base key`);
  };

  test('loads both keys from 0600 files, derives the addresses, logs only the addresses, and never shows a key when printed', async () => {
    const lines: string[] = [];
    const k = await load({ log: (l: string) => lines.push(l) });
    assert.equal(k.address.pha, addr.pha);
    assert.equal(k.address.base, addr.base);
    assert.equal(k.pha.Address.Text, addr.pha);
    assert.equal(k.base.address, addr.base);
    assert.ok(lines.some((l) => l.includes(addr.pha) && l.includes(addr.base)), 'the addresses are logged');
    for (const l of lines) noKeyIn(l, 'log');
    noKeyIn(JSON.stringify(k), 'JSON');
    noKeyIn(inspect(k, { depth: 10, showHidden: false }), 'inspect');
    noKeyIn(String(k), 'String');
    noKeyIn(`${JSON.stringify({ keys: k })}`, 'nested JSON');
    assert.deepEqual(Object.keys(k).sort(), ['address', 'network']);
  });

  test('a key file readable or writable by group or others is refused before it is parsed (mode & 0o077)', async () => {
    for (const mode of [0o644, 0o640, 0o604, 0o620, 0o602, 0o610]) {
      await chmod(phaFile, mode);
      const e = await refuses(load(), 'KEY_FILE_MODE', /chmod 600/);
      noKeyIn(e.message, `mode ${mode.toString(8)}`);
    }
    await chmod(phaFile, 0o400);
    await load();
    await chmod(phaFile, 0o600);
    await chmod(baseFile, 0o660);
    await refuses(load(), 'KEY_FILE_MODE');
    await chmod(baseFile, 0o600);
    await refuses(readSecretFile(d, 'test'), 'KEY_FILE', /not a regular file/);
    await refuses(readSecretFile(join(d, 'missing.json'), 'test'), 'KEY_FILE', /cannot be opened/);
  });

  test('keys never come from the command line: a key found on argv refuses the start', async () => {
    for (const argv of [['node', 'bot.ts', wif], ['node', 'bot.ts', `--key=${pk}`], ['node', 'bot.ts', pk.slice(2).toUpperCase()]]) {
      const e = await refuses(load({ argv }), 'KEY_ARGV', /command line/);
      noKeyIn(e.message, 'KEY_ARGV');
    }
    assert.equal(argvKeyProblem(['node', 'bot.ts', '--pha', addr.pha], [wif, pk]), null, 'addresses are fine');
    assert.equal(secretShapedArg(['--pha', addr.pha, '--base', addr.base]), false);
    assert.equal(secretShapedArg([wif]), true);
    assert.equal(secretShapedArg([`--x=${pk}`]), true);
    assert.equal(secretShapedArg(['sat_' + 'A'.repeat(43)]), true);
  });

  test('malformed key files are refused without quoting them', async () => {
    const bad = join(d, 'bad.json');
    const cases: Array<[string, RegExp]> = [
      ['not json ' + wif, /not JSON/],
      ['[1,2]', /not a JSON object/],
      [JSON.stringify({ privateKey: pk }), /no "wif"/],
      [JSON.stringify({ wif: wif.slice(0, -1) + (wif.endsWith('1') ? '2' : '1') }), /checksum/],
      [JSON.stringify({ wif: 'K' + '1'.repeat(51) }), /checksum or shape/]
    ];
    for (const [text, re] of cases) {
      await writeFile(bad, text, { mode: 0o600 });
      const e = await refuses(loadKeys({ network: 'devnet', phaKeyFile: bad, baseKeyFile: baseFile, argv: [] }), 'KEY_FILE', re);
      noKeyIn(e.message, String(re));
    }
    for (const text of [JSON.stringify({ wif }), JSON.stringify({ privateKey: pk.slice(0, -1) }), JSON.stringify({ privateKey: '0x' + '0'.repeat(64) })]) {
      await writeFile(bad, text, { mode: 0o600 });
      const e = await refuses(loadKeys({ network: 'devnet', phaKeyFile: phaFile, baseKeyFile: bad, argv: [] }), 'KEY_FILE');
      noKeyIn(e.message, 'base');
    }
    assert.equal(wifOk(wif), true);
    assert.equal(wifOk(PhantasmaKeys.generate().toWIF()), true);
    assert.equal(wifOk('5' + '1'.repeat(50)), false);
  });

  test('check 68: an admin, owner or keeper address is never a bot\'s key', async () => {
    assert.match(knownRoleProblem({ pha: 'P2KBPHBKq1xuoSajuKxQCd7RfCfGFyoczoHQdVxacEUc9As' }) ?? '', /Saturn's admin key/);
    assert.match(knownRoleProblem({ pha: 'P2KBNc6TpAqLi5LEBHgX62BA3uqa6d87NefwRmJ825fbJ8D' }) ?? '', /escrow admin/);
    assert.match(knownRoleProblem({ pha: 'P2KJBzzwGWLkDz5HUtuHQ7ydUWmbyAtFukwytu8qFtbRkuX' }) ?? '', /keeper/);
    assert.match(knownRoleProblem({ base: '0x941536821262b424997cb212bddfc97cad7fd6f6' }) ?? '', /SaturnSwap owner/, 'any case');
    assert.match(knownRoleProblem({ base: '0x6EC2A535685D5cE5f143B8C0d9bF5F612295b703' }) ?? '', /keeper/);
    // The keeper's key sets: K0's, retired (they leaked), stay refused; K1's, the devnet keeper's since 26 October 2026
    // (the board's /config keeper.phaAddress, baseAddress and claimAddress), are refused too, in any case.
    const sets: Array<[{ pha?: string; base?: string }, string]> = [
      [{ pha: 'P2KJBzzwGWLkDz5HUtuHQ7ydUWmbyAtFukwytu8qFtbRkuX' }, 'the retired devnet keeper'],
      [{ base: '0xe16fE62e009961682F3a7F42642F36F5E46962F8' }, 'the retired devnet keeper (refunds)'],
      [{ base: '0x6EC2A535685D5cE5f143B8C0d9bF5F612295b703' }, 'the retired devnet keeper (claims)'],
      [{ pha: 'P2KKFuFZNpiFdtgWQ68DHuTtwqnjBMgTv2hArZrmQYmf4gx' }, 'the devnet keeper (Phantasma claims and refunds)'],
      [{ base: '0xa93Bc149Ff1DE9f20Fa1198e2edB4FFb69ECE58A' }, 'the devnet keeper (refunds and withdrawOwed)'],
      [{ base: '0xa93bc149ff1de9f20fa1198e2edb4ffb69ece58a' }, 'the devnet keeper (refunds and withdrawOwed)'],
      [{ base: '0x8701a821221266800a6dF354701E79Fdb5Ab80A6' }, 'the devnet keeper (claims)'],
      [{ base: '0x8701A821221266800A6DF354701E79FDB5AB80A6' }, 'the devnet keeper (claims)']
    ];
    for (const [a, role] of sets) {
      const which = a.pha ? 'Phantasma' : 'Base';
      assert.equal(knownRoleProblem(a), `The ${which} key is ${role} (${a.pha ?? a.base}). A bot must never hold an admin, owner or keeper key: use a key of its own.`);
    }
    assert.equal(knownRoleProblem(addr), null);
    // A key whose address the caller was told to refuse (for example a keeper address from /config).
    await refuses(load({ forbid: { pha: [addr.pha] } }), 'KEY_ROLE', /told to refuse/);
    await refuses(load({ forbid: { base: [addr.base.toLowerCase()] } }), 'KEY_ROLE');
  });
});
