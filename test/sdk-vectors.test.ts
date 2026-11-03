/**
 * The installed Phantasma SDK against the known answers in
 * test/fixtures/sdk-vectors.json, which phantasma-sdk-ts 0.4.0 gave: the
 * kit's key, its three escrow transactions byte for byte, its view scripts
 * and its readings of the node's answers (test/fixtures/sdk-vectors.ts says
 * how each is made). The kit's SDK (package.json) must give the same keys,
 * transactions and scripts, byte for byte, and read each answer as 0.4.0
 * did, or as the file records it reads it instead (`pinned`, with `why`).
 * A difference fails the test that names it, so an SDK upgrade cannot change
 * what the kit signs or reads without a test failing.
 *
 * The kit's escrow reads (readLock, readParams, readOpenCap, admin,
 * hashSecrets) also run over the devnet node's real answers, as recorded on
 * 3 Nov 2026, and must read exactly what they read with 0.4.0: a batch of up
 * to 7 answers maps to its calls in order.
 *
 * The file itself is held to SDK_VECTORS_SHA256, the digest of its inputs and
 * 0.4.0's answers (referenceDigest): adding, dropping or editing a vector
 * changes this test, not only the large JSON file.
 *
 * Also checked without the SDK: each signature in the file is an Ed25519
 * signature of its transaction's unsigned bytes by the key's public key
 * (node:crypto), each address is its public key's, and the file holds no
 * WIF-shaped string or key field (the site's pack refuses both).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { wifOk } from '../src/keys.js';
import {
  REFERENCE_SDK, VECTORS_FILE, DECODE_CHANGES, readVectors, installedSdk, pinnedSdk, privateKeyOf, wifOf, keysOf, escrowAnswer, viewScripts,
  decodeAnswer, changesOf, readAnswer, referenceDigest, type Answer
} from './fixtures/sdk-vectors.js';

/** The digest of test/fixtures/sdk-vectors.json's inputs and 0.4.0 answers (--write and --pinned print it). */
const SDK_VECTORS_SHA256 = '24a4d41b10478a7e29f13b7415bfe17d4b8a2bd078ad47af264e87a9c04106e4';

const v = readVectors();
const sdk = installedSdk();

test('sdk vectors: the file holds phantasma-sdk-ts 0.4.0 answers of every kind, and the kit\'s own SDK is installed', () => {
  assert.equal(v.sdk, REFERENCE_SDK);
  assert.equal(referenceDigest(v), SDK_VECTORS_SHA256, 'the vectors are the ones this test was written for: a changed vector changes SDK_VECTORS_SHA256 too');
  assert.equal(sdk, pinnedSdk(), 'the SDK package.json pins is the one installed (npm ci --ignore-scripts)');
  assert.ok(v.keys.length >= 8, 'keys');
  for (const m of ['lock', 'claim', 'refund']) assert.ok(v.escrow.filter((e) => e.method === m).length >= 8, m);
  for (const n of ['devnet', 'mainnet']) assert.ok(v.escrowConfigs.some((c) => c.network === n && v.escrow.some((e) => v.escrowConfigs[e.config] === c)), n);
  assert.ok(v.views.filter((x) => x.from === 'kit').length >= 25 && v.views.some((x) => x.scripts && x.scripts.length > 1), 'the kit\'s view call lists, one over a chunk');
  assert.ok(v.views.filter((x) => x.from === 'corpus').length >= 25, 'the corpus\'s view call lists');
  assert.ok(v.decode.filter((d) => d.mode === 'value').length >= 60 && v.decode.filter((d) => d.mode === 'stream').length >= 10, 'answers');
  const from = (f: string) => v.decode.filter((d) => d.from === f).length;
  assert.ok(from('kit') >= 30 && from('live') >= 30 && from('malformed') >= 15 && from('corpus') >= 50, 'answers of every origin');
  for (const read of ['readLock', 'readParams', 'readOpenCap', 'admin', 'hashSecrets']) assert.ok(v.reads.some((r) => r.read === read), read);
  const states = new Set(v.reads.filter((r) => r.read === 'readLock').map((r) => (r.result as { state?: number }).state));
  for (const state of [0, 2, 3]) assert.ok(states.has(state), `a lock read in state ${state}`);
  assert.ok(v.node.some((x) => x.results.length === 7), 'a recorded batch of 7 answers (a claimed lock\'s getters)');
});

test(`sdk vectors: ${sdk} reads each key's WIF (PhantasmaKeys.fromWIF) to the same public key and address`, () => {
  for (const k of v.keys) {
    const wif = wifOf(privateKeyOf(k.label));
    assert.ok(wifOk(wif), `${k.label}: the kit takes the WIF`);
    const keys = keysOf(k.label);
    assert.equal(Buffer.from(keys.PublicKey).toString('hex'), k.publicKey, `${k.label}: public key`);
    assert.equal(keys.Address.Text, k.address, `${k.label}: address`);
    assert.equal(keys.toWIF(), wif, `${k.label}: toWIF gives the same WIF back (the tests write key files with it)`);
  }
});

test(`sdk vectors: ${sdk} builds and signs the same escrow transactions, byte for byte`, () => {
  for (const e of v.escrow) {
    const name = `key ${e.key}, ${e.method} on ${v.escrowConfigs[e.config]!.network}`;
    const got = escrowAnswer(e, v.escrowConfigs, v.keys);
    assert.equal(got.unsigned, e.unsigned, `${name}: the unsigned transaction`);
    assert.equal(got.signed, e.signed, `${name}: the signed transaction the kit sends`);
  }
});

test('sdk vectors: each signature is Ed25519 over the unsigned bytes by the key, and each address is its key\'s (no SDK)', () => {
  const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const base58 = (b: Buffer) => {
    let n = BigInt('0x' + b.toString('hex'));
    let s = '';
    while (n > 0n) { s = B58[Number(n % 58n)]! + s; n /= 58n; }
    return s;
  };
  for (const k of v.keys) {
    // A user address: 'P' and the base58 of kind 1, 0 and the 32-byte public key.
    assert.equal(k.address, 'P' + base58(Buffer.concat([Buffer.from([1, 0]), Buffer.from(k.publicKey, 'hex')])), k.label);
  }
  for (const e of v.escrow) {
    const name = `key ${e.key}, ${e.method}`;
    const signed = Buffer.from(e.signed, 'hex');
    const unsigned = Buffer.from(e.unsigned, 'hex');
    assert.ok(signed.subarray(0, unsigned.length).equals(unsigned), `${name}: the signed transaction starts with the unsigned one`);
    const tail = signed.subarray(unsigned.length);
    assert.deepEqual([...tail.subarray(0, 3)], [1, 1, 64], `${name}: one signature, Ed25519, 64 bytes`);
    assert.equal(tail.length, 3 + 64, name);
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, Buffer.from(v.keys[e.key]!.publicKey, 'hex')]), format: 'der', type: 'spki' });
    assert.ok(verify(null, unsigned, key, tail.subarray(3)), `${name}: the signature verifies`);
  }
});

test(`sdk vectors: ${sdk} gives the same view scripts for every call list`, async () => {
  for (const [i, x] of v.views.entries()) {
    assert.deepEqual(await viewScripts(x.calls), x.scripts, `call list ${i}: ${x.calls.slice(0, 2).map((c) => `${c.contract}.${c.method}`).join(', ')}`);
  }
});

test(`sdk vectors: ${sdk} gives the kit's escrow reads over the devnet node's recorded answers exactly as 0.4.0 did`, async () => {
  for (const [i, r] of v.reads.entries()) {
    assert.deepEqual(await readAnswer(r, v.node, v.escrowConfigs[0]!), r.result, `read ${i}: ${r.read}(${r.args.map((a) => a.slice(0, 12)).join(', ')})`);
  }
});

test(`sdk vectors: ${sdk} reads every answer as 0.4.0 did, or as the file records`, async () => {
  for (const [i, d] of v.decode.entries()) {
    const got = await decodeAnswer(d.mode, d.hex);
    const want = d.pinned ?? { out: d.out, int: d.int, address: d.address };
    assert.deepEqual(got, want, `answer ${i} (${d.mode}, ${d.hex.slice(0, 24) || 'empty'})`);
  }
});

test('sdk vectors: only malformed answers read differently, each change a named kind; no well-formed answer does', async () => {
  // What the kit's SDK reads from a well-formed 0, empty text and empty struct: a cut-short value must read as one of them.
  const wellFormed0 = await Promise.all(['030100', '0400', '0100'].map((hex) => decodeAnswer('value', hex)));
  const changed = v.decode.filter((d) => d.pinned);
  for (const d of changed) {
    const was = { out: d.out, int: d.int, address: d.address };
    assert.notDeepEqual(d.pinned, was, `${d.hex.slice(0, 24)}: a change that changes nothing`);
    assert.deepEqual(d.why, changesOf(was, d.pinned!), `${d.hex.slice(0, 24)}: why`);
    for (const k of d.why!) assert.ok(k in DECODE_CHANGES, k);
    d.out.forEach((a, j) => {
      const b = d.pinned!.out[j];
      if (JSON.stringify(a) === JSON.stringify(b)) return;
      // Either no value (the kit refuses the read), a number viewInt refuses, or, where 0.4.0 had nothing, a cut-short
      // value: 0, '' or an empty struct, read exactly as the well-formed 030100, 0400 or 0100 read, so a node could send
      // the same reading anyway.
      const x = b as { nil?: boolean; s?: unknown; o?: unknown; e?: unknown[] };
      const refused = x?.nil === true;
      const negative = typeof x?.s === 'string' && /^-\d+$/.test(x.s) && d.pinned!.int[j] === null;
      const reading = JSON.stringify([b, d.pinned!.int[j], d.pinned!.address[j]]);
      const cutShort = (a as { nil?: boolean })?.nil === true && wellFormed0.some((w) => JSON.stringify([w.out[0], w.int[0], w.address[0]]) === reading);
      const inStruct = (a as { o?: unknown })?.o !== undefined && x?.o !== undefined;
      assert.ok(refused || negative || cutShort || inStruct, `${d.hex.slice(0, 24)} value ${j}`);
      assert.equal(d.pinned!.address[j], '', `${d.hex.slice(0, 24)} value ${j}: a changed value reads as no address`);
    });
  }
  // No well-formed answer reads differently: neither the kit's own (built) nor the devnet node's real ones (recorded).
  const wellFormed = v.decode.filter((d) => d.from === 'kit' || d.from === 'live');
  assert.ok(wellFormed.length >= 60, 'well-formed answers');
  assert.deepEqual(wellFormed.filter((d) => d.pinned).map((d) => d.hex), [], 'no well-formed answer reads differently');
  assert.ok(changed.every((d) => d.from === 'malformed' || d.from === 'corpus'), 'only malformed and corpus answers change');
});

test('sdk vectors: changesOf names a change only when it is exactly that kind (made-up answers)', () => {
  const one = (out: unknown, int: string | null, address = ''): Answer => ({ out: [out], int: [int], address: [address] });
  // negative-number: now = was - 256^k for was's k bytes, the top bit of its last byte set, and nothing the kit reads.
  assert.deepEqual(changesOf(one({ s: '200' }, '200'), one({ s: '-56' }, null)), ['negative-number']);
  assert.deepEqual(changesOf(one({ s: '200' }, '200'), one({ s: '-55' }, null)), ['unexplained'], 'off by one');
  assert.deepEqual(changesOf(one({ s: '100' }, '100'), one({ s: '-156' }, null)), ['unexplained'], 'the top bit is clear');
  assert.deepEqual(changesOf(one({ s: '200' }, '200'), one({ s: '-56' }, '-56')), ['unexplained'], 'a negative the kit would read');
  // cut-short: from no value to 0 (read as 0), '' or an empty struct, and nothing else.
  assert.deepEqual(changesOf(one({ nil: true }, null), one({ s: '0' }, '0')), ['cut-short']);
  assert.deepEqual(changesOf(one({ nil: true }, null), one({ s: '' }, null)), ['cut-short']);
  assert.deepEqual(changesOf(one({ nil: true }, null), one({ o: 'Object', e: [] }, null)), ['cut-short']);
  assert.deepEqual(changesOf(one({ nil: true }, null), one({ s: '5' }, '5')), ['unexplained'], 'a number from nothing');
  assert.deepEqual(changesOf(one({ nil: true }, null), one({ s: '0' }, null)), ['unexplained'], 'a cut-short 0 is read as 0');
  // No value where 0.4.0 had text: only with no address read.
  assert.deepEqual(changesOf(one({ s: 'unsupported type 5' }, null), one({ nil: true }, null)), ['unsupported-type']);
  assert.deepEqual(changesOf(one({ s: 'unsupported type 5' }, null), one({ nil: true }, null, v.keys[0]!.address)), ['unexplained'], 'an address');
  // A value more, or fewer readings than values.
  assert.deepEqual(changesOf(one({ s: 'x' }, null), { out: [{ s: 'x' }, { s: 'y' }], int: [null, null], address: ['', ''] }), ['unexplained'], 'a value more');
  assert.deepEqual(changesOf(one({ s: 'x' }, null), { out: [{ s: 'x' }], int: [], address: [''] }), ['unexplained'], 'no number read');
  assert.deepEqual(changesOf(one({ s: 'x' }, null), one({ s: 'x' }, null)), [], 'no change');
});

test('sdk vectors: the file holds no WIF-shaped string and no key field (the site\'s pack refuses both)', () => {
  const text = readFileSync(VECTORS_FILE, 'utf8');
  assert.doesNotMatch(text, /(?<![1-9A-HJ-NP-Za-km-z])(?:5[1-9A-HJ-NP-Za-km-z]{50}|[KL][1-9A-HJ-NP-Za-km-z]{51})(?![1-9A-HJ-NP-Za-km-z])/);
  assert.doesNotMatch(text, /\b(?:wif|private[_-]?key)\b/i);
});
