/**
 * The store on SQLite (store-sql.ts), the backend a Cloudflare Durable
 * Object uses: the same records and rules as on files, through the same
 * KitStore, with the lock as a row:
 *   - every kind of record round-trips, and the write-once rules hold
 *     (SECRET_CONFLICT, RECORD_CONFLICT), as on files;
 *   - one open store per database and name in an isolate; a lock row an
 *     earlier instance left (a restart) is taken over and logged; a store
 *     that lost its lock writes nothing (STORE_LOCK_LOST);
 *   - sealing with the store key given as text (a host's secret);
 *   - a damaged row is STORE_CORRUPT; the state outlives the instance.
 *
 * The database is node:sqlite in memory, which runs each statement at once,
 * as a Durable Object's ctx.storage.sql does.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openStore, FileBackend, type KitStore } from '../src/store.js';
import { SqlBackend, type SqlDatabase } from '../src/store-sql.js';
import { SafetyError } from '../src/errors.js';
import { makeSecretRecord, newControlToken, tokenHashOf } from '../src/codec.js';
import type { LocalTrade, LocalOffer, PendingCreate, SecretRecord } from '../src/types.js';

const S_P = 'P2K' + 'S'.repeat(44);
const B_P = 'P2K' + 'B'.repeat(44);
const S_B = '0x' + '5a'.repeat(20);
const B_B = '0x' + 'b7'.repeat(20);

// node:sqlite runs without a flag from Node 22.13; on an older Node 22 these tests are skipped.
let DatabaseSync: typeof import('node:sqlite').DatabaseSync | null = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* Node 22 before 22.13 */ }
const skip = DatabaseSync ? false : 'node:sqlite needs Node 22.13 or later';
type Db = import('node:sqlite').DatabaseSync;

/** A database as a Durable Object hands it over: exec runs the statement at once and returns its rows. */
function database(db: Db = new DatabaseSync!(':memory:')): SqlDatabase & { db: Db } {
  return { db, exec: (q, ...b) => { const rows = db.prepare(q).all(...b); return { toArray: () => rows }; } };
}

async function refuses(p: Promise<unknown>, code: string, re?: RegExp): Promise<void> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof SafetyError, `a SafetyError, got ${(e as Error)?.name}: ${(e as Error)?.message}`);
    assert.equal(e.code, code, e.message);
    if (re) assert.match(e.message, re);
    return;
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
const pending = (token = newControlToken()): PendingCreate => ({
  kind: 'take', network: 'devnet', token, tokenHash: tokenHashOf(token), offerId: 7,
  body: { taz: '5000000000', takerPha: B_P, takerBase: B_B, symbol: 'TAZ', price: '1640000' }, seen: { side: 'sell', makerPha: S_P, makerBase: S_B },
  createdAt: 1_790_000_000_000, sentAt: null
});
const secret = (o: Partial<Parameters<typeof makeSecretRecord>[0]> = {}): SecretRecord =>
  makeSecretRecord({ tradeId: 1, network: 'devnet', symbol: 'TAZ', taz: '5000000000', sPha: S_P, bPha: B_P, role: 'S', ...o }, 1_790_000_000_000);

const open = (db: SqlDatabase, extra: { name?: string; network?: 'devnet' | 'mainnet'; key?: string | null; log?: (l: string) => void } = {}): Promise<KitStore> => {
  const network = extra.network ?? 'devnet';
  return openStore({ backend: new SqlBackend(db, { network, ...(extra.name ? { name: extra.name } : {}) }), network, key: extra.key ?? null, ...(extra.log ? { log: extra.log } : {}) });
};

/** The rows of one store, as stored. */
const rows = (d: { db: Db }, store: string) =>
  d.db.prepare('SELECT kind, name, text FROM kit_store WHERE store = ? ORDER BY kind, name').all(store) as Array<{ kind: string; name: string; text: string }>;

describe('store-sql.ts: records, as on files', { skip }, () => {
  test('every kind of record round-trips, with the write-once rules of the file store', async () => {
    const d = database();
    const s = await open(d);
    assert.equal(s.dir, 'sqlite:bot/devnet');
    assert.deepEqual(await s.addTrade(trade()), trade());
    await refuses(s.addTrade(trade({ taz: '6000000000' })), 'RECORD_CONFLICT');
    assert.equal((await s.patchTrade(1, { status: 'accepted', h: '0x' + 'C'.repeat(64) })).h, '0x' + 'c'.repeat(64));
    await refuses(s.patchTrade(1, { h: '0x' + 'd'.repeat(64) }), 'RECORD_CONFLICT', /never changes/);
    await s.addOffer(offer());
    assert.deepEqual((await s.patchOffer(7, { price: '1090000' })).priceHistory.map((p) => p.price), ['1080000', '1090000']);
    const p = pending();
    await s.putPending(p);
    assert.equal((await s.listPending()).length, 1);
    assert.equal(await s.deletePending(p.tokenHash), true);
    assert.equal(await s.deletePending(p.tokenHash), false, 'gone once deleted');
    const sec = secret();
    await s.putSecret(sec);
    assert.deepEqual(await s.putSecret(sec), sec, 'the same secret again is a no-op');
    await refuses(s.putSecret({ ...sec, tradeId: 2 }), 'SECRET_CONFLICT');
    await refuses(s.putSecret({ ...sec, createdAt: sec.createdAt + 1 }), 'SECRET_CONFLICT');
    assert.deepEqual(await s.getSecret(sec.h), sec, 'never overwritten');
    assert.equal(await s.hashUsedElsewhere(sec.h, 2), true, 'check 38 reads the same rows');
    const i = await s.addIntent(1, { kind: 'phaLock', h: sec.h });
    await s.recordSent(1, i.id, { txHash: 'f'.repeat(64) });
    assert.equal((await s.openIntents()).length, 1);
    await s.resolveIntent(1, i.id, 'confirmed');
    assert.equal((await s.openIntents()).length, 0);
    assert.deepEqual((await s.listTrades()).map((t) => t.id), [1]);
    assert.equal(s.fileOf('trades', 1), 'sqlite:bot/devnet/trades/1.json');
    await s.close();
    await refuses(s.addTrade(trade({ id: 2 })), 'STORE_CLOSED');
  });

  test('concurrent writes to one record are serialised; the state outlives the instance', async () => {
    const d = database();
    const s = await open(d);
    await Promise.all(Array.from({ length: 8 }, (_, k) => s.addIntent(5, { kind: k % 2 ? 'claimBase' : 'refundPha' })));
    assert.equal(new Set((await s.getJournal(5)).intents.map((x) => x.id)).size, 8, 'no lost update, unique ids');
    await s.addTrade(trade({ id: 9 }));
    await s.close();
    // A new instance of the host (a restart): the same database, opened again.
    const again = await open(d);
    assert.equal((await again.getJournal(5)).intents.length, 8);
    assert.deepEqual((await again.listTrades()).map((t) => t.id), [9]);
    await again.close();
  });

  test('a damaged row is STORE_CORRUPT, never silently skipped', async () => {
    const d = database();
    const s = await open(d);
    d.db.prepare('INSERT INTO kit_store (store, kind, name, text) VALUES (?, ?, ?, ?)').run('bot/devnet', 'trades', '77', '{"id": 77, "half');
    await refuses(s.getTrade(77), 'STORE_CORRUPT', /not JSON/);
    await refuses(s.listTrades(), 'STORE_CORRUPT');
    d.db.prepare('UPDATE kit_store SET text = ? WHERE name = ?').run(JSON.stringify(trade({ id: 78 })), '77');
    await refuses(s.getTrade(77), 'STORE_CORRUPT', /not a valid record/);
    await s.close();
  });
});

describe('store-sql.ts: the lock', { skip }, () => {
  test('one open store per database and name; close releases it; other names and networks are apart', async () => {
    const d = database();
    const a = await open(d, { name: 'seller' });
    await refuses(open(d, { name: 'seller' }), 'STORE_LOCKED', /already open here/);
    const b = await open(d, { name: 'buyer' });
    const m = await open(d, { name: 'seller', network: 'mainnet' });
    await a.addTrade(trade({ id: 3 }));
    assert.deepEqual(await b.listTrades(), [], 'another bot\'s store does not see it');
    assert.deepEqual(await m.listTrades(), [], 'nor does the same bot\'s other network');
    await a.close();
    const again = await open(d, { name: 'seller' });
    assert.deepEqual((await again.listTrades()).map((t) => t.id), [3]);
    for (const s of [again, b, m]) await s.close();
    assert.equal(rows(d, 'seller/devnet').filter((r) => r.kind === 'lock').length, 0, 'a clean close leaves no lock row');
  });

  test('a lock row left by an earlier instance (a restart, a deploy) is taken over and logged', async () => {
    const d = database();
    const first = await open(d);
    await first.addTrade(trade());
    // The instance ends without closing; the next one gets its own handle on the same database.
    const lines: string[] = [];
    const next = await open(database(d.db), { log: (l) => lines.push(l) });
    assert.ok(lines.some((l) => /an earlier instance held sqlite:bot\/devnet .* taking over its lock/.test(l)), lines.join('\n'));
    assert.equal((await next.getTrade(1))?.id, 1);
    // The old handle, if anything of it still ran, writes nothing more.
    await refuses(first.patchTrade(1, { status: 'accepted' }), 'STORE_LOCK_LOST');
    assert.equal((await next.getTrade(1))?.status, undefined, 'nothing was written');
    await next.close();
  });

  test('a store whose lock row changed writes nothing more (STORE_LOCK_LOST), and close leaves the other lock', async () => {
    const d = database();
    const s = await open(d);
    await s.addTrade(trade());
    d.db.prepare('UPDATE kit_store SET text = ? WHERE kind = ?').run(JSON.stringify({ nonce: 'someone-else', startedAt: 1 }), 'lock');
    await refuses(s.patchTrade(1, { status: 'accepted' }), 'STORE_LOCK_LOST');
    await refuses(s.putSecret(secret()), 'STORE_LOCK_LOST');
    assert.equal((await s.getTrade(1))?.status, undefined);
    await s.close();
    assert.match(rows(d, 'bot/devnet').find((r) => r.kind === 'lock')!.text, /someone-else/, 'close never removes a lock that is not its own');
  });
});

describe('store-sql.ts: sealing with the store key as text (a host\'s secret)', { skip }, () => {
  test('tokens and secrets are sealed in their rows; the same key opens them, another key or none does not', async () => {
    const d = database();
    const key = randomBytes(32).toString('hex');
    const s = await open(d, { key });
    assert.equal(s.sealed, true);
    const sec = secret();
    const p = pending();
    await s.putSecret(sec);
    await s.putPending(p);
    await s.addTrade(trade());
    await s.addOffer(offer());
    await s.addIntent(1, { kind: 'phaLock' });
    const stored = rows(d, 'bot/devnet');
    for (const [kind, plain] of [['secrets', sec.secret.slice(2)], ['pending', p.token], ['trades', 'a'.repeat(64)], ['offers', 'b'.repeat(64)]] as const) {
      const r = stored.find((x) => x.kind === kind)!;
      assert.ok(!r.text.includes(plain), `${kind}: the token or secret is not in the row`);
      assert.match(r.text, /"sealed":"aes-256-gcm"/);
    }
    assert.match(stored.find((x) => x.kind === 'journal')!.text, /"phaLock"/, 'the journal stays plain');
    await s.close();
    const again = await open(d, { key: `  ${key.toUpperCase()}\n` });
    assert.deepEqual(await again.getSecret(sec.h), sec);
    assert.deepEqual(await again.getPending(p.tokenHash), p);
    // A sealed row moved to another name does not open (its name is bound in).
    d.db.prepare('UPDATE kit_store SET name = ? WHERE kind = ? AND name = ?').run('2', 'trades', '1');
    await refuses(again.getTrade(2), 'STORE_CORRUPT', /does not open/);
    await again.close();
    await refuses(open(d, { key: null }), 'STORE_KEY', /sealed/);
    await refuses(open(d, { key: randomBytes(32).toString('hex') }), 'STORE_KEY', /not the key/);
  });

  test('a store key that is not 32 bytes is refused, and so are a key and a key file together', async () => {
    const d = database();
    await refuses(open(d, { key: 'ab'.repeat(16) }), 'STORE_KEY', /32 bytes/);
    await refuses(open(d, { key: 'not hex at all, but long enough to be sixty-four characters long!' }), 'STORE_KEY', /32 bytes/);
    await refuses(openStore({ backend: new SqlBackend(d, { network: 'devnet' }), network: 'devnet', key: 'ab'.repeat(32), keyFile: '/nonexistent' }), 'STORE_KEY', /not both/);
    await refuses(openStore({ backend: new SqlBackend(d, { network: 'devnet' }), dataDir: '/tmp/x', network: 'devnet', key: null }), 'STORE_CORRUPT', /not both/);
    const raw = await openStore({ backend: new SqlBackend(d, { network: 'devnet' }), network: 'devnet', key: new Uint8Array(randomBytes(32)) });
    assert.equal(raw.sealed, true, '32 raw bytes are a key too');
    await raw.close();
  });
});

describe('store-sql.ts: the backend contract, beside the file backend', { skip }, () => {
  test('writeNew never overwrites, remove reports what it removed, names lists one kind of one store', async () => {
    const d = database();
    const b = new SqlBackend(d, { network: 'mainnet', name: 'market', where: 'durable-object:market/mainnet' });
    await b.open({ log: () => {} });
    assert.equal(await b.writeNew('trades', '5', 'one'), true);
    assert.equal(await b.writeNew('trades', '5', 'two'), false);
    assert.equal(await b.read('trades', '5'), 'one');
    await b.write('trades', '5', 'three');
    assert.equal(await b.read('trades', '5'), 'three');
    await b.write('trades', '12', 'x');
    await b.write('offers', '5', 'y');
    assert.deepEqual(await b.names('trades'), ['12', '5']);
    assert.equal(await b.remove('trades', '5'), true);
    assert.equal(await b.remove('trades', '5'), false);
    assert.equal(await b.read('trades', '5'), null);
    assert.equal(b.pathOf('offers', '5'), 'durable-object:market/mainnet/offers/5.json');
    await assert.rejects(b.read('meta' as never, 'meta'), /no record kind/);
    await b.close();
    assert.throws(() => new SqlBackend(d, { network: 'mainnet', name: '../x' }), /store name/);
    assert.equal(new FileBackend({ dataDir: '/data', network: 'devnet' }).pathOf('trades', '5'), '/data/devnet/trades/5.json');
  });
});
