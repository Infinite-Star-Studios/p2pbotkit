/**
 * Known answers for the Phantasma SDK the kit runs (phantasma-sdk-ts), for
 * test/sdk-vectors.test.ts.
 *
 * The kit uses the SDK in four places, and the vectors run each one through
 * the kit's own code (the fifth item runs them together, as the kit reads):
 *   - its key: PhantasmaKeys.fromWIF and the key's address (src/keys.ts);
 *   - the three escrow transactions: escrowTransaction (ScriptBuilder and
 *     Transaction), signWithKeys and txHex, as src/signer.ts signs and sends
 *     them;
 *   - its view scripts: views() of phaRpc (ScriptBuilder), over a fake node;
 *   - the node's answers: views() again (Decoder), then viewInt and
 *     viewAddress (Address.FromBytes);
 *   - the escrow reads themselves (PhaReader: readLock, readParams,
 *     readOpenCap, admin, hashSecrets), over the devnet node's answers to
 *     them as recorded on 3 Nov 2026 (`node`), batches of up to 7 calls.
 * sdk-vectors.json holds the inputs and what phantasma-sdk-ts 0.4.0 gave for
 * each: the version the kit ran before 0.1.2, which the backend keeper still
 * runs. The test checks that the installed SDK gives the same bytes and
 * values, so a new SDK release cannot change what the kit signs or reads
 * without a test failing.
 *
 * The keys are made from fixed labels (each private key is the SHA-256 of its
 * label), so the file holds no key: only labels, addresses and public keys.
 * Each answer says where it comes from: the kit's own reads ('kit', built
 * well formed), the devnet node's real answers to them ('live', recorded on
 * 3 Nov 2026 through the kit's own reads), answers built to be cut short or
 * malformed ('malformed'), and the value and stream answers of the P2P
 * service's VM corpus in the Saturn repository ('corpus',
 * p2p/packages/chain/test/node/fixtures/vm-reference.jsonl, also made with
 * 0.4.0; its string-only view call lists are among the view inputs).
 *
 * The kit's own SDK (package.json; 0.20.0 from kit 0.1.2) gives the same
 * keys, transactions and scripts, byte for byte. It reads some malformed
 * answers, or values of another type, differently: where it does, the answer
 * also holds `pinned` (what the
 * kit's SDK reads) and `why` (the kinds of change, DECODE_CHANGES). No
 * well-formed answer ('kit' or 'live') reads differently.
 *
 * To remake the file from its inputs, in a copy of the kit:
 *   npm install --no-save --ignore-scripts phantasma-sdk-ts@0.4.0
 *   npx tsx test/fixtures/sdk-vectors.ts --write     (0.4.0's answers)
 *   npm ci --ignore-scripts
 *   npx tsx test/fixtures/sdk-vectors.ts --pinned    (the kit's SDK: pinned and why)
 * --pinned refuses to write when the kit's SDK changes a key, a transaction
 * or a script, or reads an answer differently in a way DECODE_CHANGES does
 * not name.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PhantasmaKeys } from 'phantasma-sdk-ts';
import { escrowTransaction, lockCall, claimCall, refundCall, txHex, viewAddress, viewInt, phaRpc, PhaReader, type PhaCall } from '../../src/pha.js';
import { escrowFor } from '../../src/checks.js';
import type { P2PNetConfig } from '../../src/pins.js';
import type { Network } from '../../src/types.js';

export const VECTORS_FILE = fileURLToPath(new URL('./sdk-vectors.json', import.meta.url));

/** The SDK whose answers the file holds. */
export const REFERENCE_SDK = 'phantasma-sdk-ts@0.4.0';

/** Values read from one stream answer (a node's single `result`), as views() reads that many calls. */
export const STREAM_READS = 8;

export interface EscrowConfig { network: Network; phaContract: string; nexus: string; chain: string }
export interface KeyVector { label: string; address: string; publicKey: string }
export interface EscrowVector {
  /** Inputs: the signing key and the config (indexes), the call's arguments and the expiry. */
  key: number;
  config: number;
  method: 'lock' | 'claim' | 'refund';
  h: string;
  secret: string;
  symbol: string;
  amount: string;
  recipient: number;
  deadline: number;
  expiresAtMs: number;
  /** Answers: the transaction without its signature (lowercase hex) and as the kit sends it (txHex). */
  unsigned: string;
  signed: string;
}
export interface ViewVector {
  /** 'kit': the kit's own reads; 'corpus': a case of the P2P service's VM corpus. */
  from: 'kit' | 'corpus';
  calls: PhaCall[];
  /** The scripts views() sent, one per chunk of 16 calls; null when the SDK refused to build them. */
  scripts: string[] | null;
}
export interface DecodeVector {
  /** 'kit': a well-formed answer of the kit's own reads; 'live': one the devnet node sent; 'malformed': built cut short or malformed; 'corpus': a case of the VM corpus. */
  from: 'kit' | 'live' | 'malformed' | 'corpus';
  /** 'value': the node answered `results: [hex]` for one call; 'stream': one `result` hex for STREAM_READS calls. */
  mode: 'value' | 'stream';
  hex: string;
  /** What views() answered, one per call (canon form; null where it did not decode). */
  out: unknown[];
  /** viewInt of each (null where it throws) and viewAddress of each. */
  int: (string | null)[];
  address: string[];
  /** Where the kit's SDK reads the answer differently from 0.4.0: what it reads, and the kinds of change. */
  pinned?: Answer;
  why?: DecodeChange[];
}
export type Answer = Pick<DecodeVector, 'out' | 'int' | 'address'>;
/** One view script the devnet node answered (invokeRawScript), as recorded through the kit's own reads on 3 Nov 2026. */
export interface NodeExchange { script: string; result: string; results: string[] }
/** One escrow read of the kit's (PhaReader on the devnet config) over the recorded answers, and what it read. */
export interface ReadVector {
  read: 'readLock' | 'readParams' | 'readOpenCap' | 'admin' | 'hashSecrets';
  args: string[];
  /** The kit's reading, bigints as decimal strings; { error } when it threw. */
  result: unknown;
}
export interface Vectors {
  sdk: string;
  escrowConfigs: EscrowConfig[];
  keys: KeyVector[];
  escrow: EscrowVector[];
  views: ViewVector[];
  decode: DecodeVector[];
  node: NodeExchange[];
  reads: ReadVector[];
}

const sha256 = (b: string | Uint8Array): Buffer => createHash('sha256').update(b).digest();
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/** The installed SDK, as "phantasma-sdk-ts@<version>". */
export function installedSdk(): string {
  const require = createRequire(import.meta.url);
  const pkg = require('phantasma-sdk-ts/package.json') as { version: string };
  return `phantasma-sdk-ts@${pkg.version}`;
}

// ── Keys ────────────────────────────────────────────────────────────────────

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(bytes: Uint8Array): string {
  let n = BigInt('0x' + (hex(bytes) || '0'));
  let out = '';
  while (n > 0n) { out = B58_ALPHABET[Number(n % 58n)]! + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
  return out;
}

/** The private key of a label: its SHA-256. */
export const privateKeyOf = (label: string): Uint8Array => Uint8Array.from(sha256(label));

/**
 * The WIF of a compressed key, made without the SDK: base58 of 0x80, the 32
 * key bytes, 0x01 and the first 4 bytes of the double SHA-256 of those 34
 * bytes (src/keys.ts wifOk).
 */
export function wifOf(privateKey: Uint8Array): string {
  const body = Buffer.concat([Buffer.from([0x80]), Buffer.from(privateKey), Buffer.from([0x01])]);
  return base58(Buffer.concat([body, sha256(sha256(body)).subarray(0, 4)]));
}

/** The key of a label, read the way src/keys.ts reads a key file: PhantasmaKeys.fromWIF. */
export const keysOf = (label: string): PhantasmaKeys => PhantasmaKeys.fromWIF(wifOf(privateKeyOf(label)));

function keyVectors(labels: readonly string[]): KeyVector[] {
  return labels.map((label) => {
    const k = keysOf(label);
    return { label, address: k.Address.Text, publicKey: hex(k.PublicKey) };
  });
}

// ── Escrow transactions ─────────────────────────────────────────────────────

/** A config with the contract, nexus and chain a vector names (the kit's pins may move on; the vectors stay). */
export function configOf(c: EscrowConfig): P2PNetConfig {
  const r = escrowFor(c.network);
  if (!r.ok) throw new Error(`the kit serves no ${c.network} escrow`);
  return { ...r.cfg, phaContract: c.phaContract, phaDraining: [], pha: { ...r.cfg.pha, nexus: c.nexus, chain: c.chain } };
}

/** One escrow transaction, built and signed as src/signer.ts does: the unsigned bytes and what is sent. */
export function escrowAnswer(v: Omit<EscrowVector, 'unsigned' | 'signed'>, configs: readonly EscrowConfig[], keys: readonly KeyVector[]): Pick<EscrowVector, 'unsigned' | 'signed'> {
  const cfg = configOf(configs[v.config]!);
  const k = keysOf(keys[v.key]!.label);
  const from = k.Address.Text;
  const call: PhaCall =
    v.method === 'lock' ? lockCall(cfg, from, v.h, v.symbol, BigInt(v.amount), keysOf(keys[v.recipient]!.label).Address.Text, v.deadline)
      : v.method === 'claim' ? claimCall(cfg, v.secret)
        : refundCall(cfg, v.h);
  const tx = escrowTransaction(cfg, from, call, v.expiresAtMs);
  const unsigned = hex(tx.ToByteAray(false));
  tx.signWithKeys(k);
  return { unsigned, signed: txHex(tx) };
}

// ── Views and answers, through phaRpc over a fake node ──────────────────────

/** A fake node: records each invokeRawScript script and answers with `answer`. */
function fakeNode(answer: (script: string) => unknown): { fetch: typeof fetch; scripts: string[] } {
  const scripts: string[] = [];
  const f = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[]; id: string };
    if (body.method !== 'invokeRawScript') throw new Error(`unexpected ${body.method}`);
    const script = String(body.params[1]);
    scripts.push(script);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: answer(script) }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: f, scripts };
}

/** The scripts views() sends for a list of calls (null when the SDK refuses to build one). */
export async function viewScripts(calls: readonly PhaCall[]): Promise<string[] | null> {
  const node = fakeNode(() => ({ error: '', results: calls.map(() => '030100') }));
  try {
    await phaRpc('devnet', { fetch: node.fetch }).views(calls);
  } catch (e) {
    if (node.scripts.length === 0) return null;
    throw e;
  }
  return node.scripts;
}

/** A decoded VM value in a form JSON keeps exactly (types included). */
export function canon(v: unknown): unknown {
  if (v === null) return { nil: true };
  if (v === undefined) return { undef: true };
  if (typeof v === 'bigint') return { n: v.toString() };
  if (typeof v === 'number') return { num: Object.is(v, -0) ? '-0' : String(v) };
  if (typeof v === 'string') return { s: v };
  if (typeof v === 'boolean') return { b: v };
  if (v instanceof Uint8Array) return { bytes: hex(v) };
  if (Array.isArray(v)) return { a: v.map(canon) };
  if (v instanceof Map) return { m: [...v.entries()].map(([k, x]) => [canon(k), canon(x)]) };
  if (typeof v === 'object') return { o: (v as object).constructor?.name ?? 'Object', e: Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, canon(x)]) };
  return { other: typeof v };
}

/** What views() answers when the node returns `hex`, and the kit's readings of each value. */
export async function decodeAnswer(mode: DecodeVector['mode'], h: string): Promise<Answer> {
  const n = mode === 'value' ? 1 : STREAM_READS;
  const calls: PhaCall[] = Array.from({ length: n }, () => ({ contract: 'saturnescrow', method: 'getState', args: [] }));
  const node = fakeNode(() => (mode === 'value' ? { error: '', results: [h] } : h));
  const values = await phaRpc('devnet', { fetch: node.fetch }).views(calls);
  return {
    out: values.map(canon),
    int: values.map((v) => { try { return viewInt(v).toString(); } catch { return null; } }),
    address: values.map((v) => viewAddress(v))
  };
}

/**
 * A node that answers each view script with its recorded answer, and refuses
 * one it has no answer for (so a script the SDK builds differently fails the
 * read instead of being answered).
 */
function replayNode(node: readonly NodeExchange[]): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[]; id: string };
    const hit = body.method === 'invokeRawScript' ? node.find((x) => x.script === String(body.params[1])) : undefined;
    const payload = hit
      ? { jsonrpc: '2.0', id: body.id, result: { events: [], result: hit.result, error: '', results: hit.results, oracles: [] } }
      : { jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'no recorded answer for this request' } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

/** What one of the kit's escrow reads gives over the recorded answers (bigints as decimal strings), or { error }. */
export async function readAnswer(r: Pick<ReadVector, 'read' | 'args'>, node: readonly NodeExchange[], config: EscrowConfig): Promise<unknown> {
  const cfg = configOf(config);
  const reader = new PhaReader(phaRpc(config.network, { fetch: replayNode(node) }), config.network);
  const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
  try {
    switch (r.read) {
      case 'readLock': return plain(await reader.readLock(cfg, r.args[0]!));
      case 'readParams': return plain(await reader.readParams(cfg, r.args[0]!));
      case 'readOpenCap': return plain(await reader.readOpenCap(cfg, r.args[0]!));
      case 'admin': return await reader.admin(cfg);
      case 'hashSecrets': return await reader.hashSecrets(cfg, r.args);
    }
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * The ways the kit's SDK (0.20.0) reads an answer differently from 0.4.0,
 * each read in the SDK's source (vm/decoder.js). The kit refuses a missing
 * value ("did not answer every read") and viewInt refuses a negative number,
 * so a change of the first four kinds fails closed.
 */
export const DECODE_CHANGES = Object.freeze({
  'unsupported-type': 'a VM type the SDK does not decode (a timestamp, bytes, an unknown type): 0.4.0 gave the text "unsupported type N" as the value, 0.20.0 gives no value',
  'past-end': 'a read past the end of the answer: 0.4.0 gave the text "unsupported type NaN" as the value, 0.20.0 gives no value',
  'malformed-struct': 'a struct that does not decode: 0.4.0 gave a partial object, 0.20.0 gives no value',
  'negative-number': "a number whose last byte has its top bit set (a node never sends one for a value of 0 or more: it adds a 00 sign byte), negative in the chain's two's complement: 0.4.0 read it as positive (its decoder had not implemented negative numbers), 0.20.0 reads it negative, which viewInt refuses",
  'cut-short': "a value whose length or data is missing entirely (as 03, 04fd or 01fd) or a number of zero bytes (0300): 0.4.0 gave no value (it threw), 0.20.0 reads 0, '' or an empty struct, exactly as it reads the well-formed 030100, 0400 and 0100, so a node could send the same reading anyway"
});
export type DecodeChange = keyof typeof DECODE_CHANGES;

/** The kinds of change between 0.4.0's reading of an answer and another; 'unexplained' for anything else. */
export function changesOf(was: Answer, now: Answer): (DecodeChange | 'unexplained')[] {
  const kinds = new Set<DecodeChange | 'unexplained'>();
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const kindOf = (a: any, b: any): DecodeChange | 'unexplained' | null => {
    if (same(a, b)) return null;
    if (b?.nil && typeof a?.s === 'string' && a.s === 'unsupported type NaN') return 'past-end';
    if (b?.nil && typeof a?.s === 'string' && /^unsupported type \d+$/.test(a.s)) return 'unsupported-type';
    if (b?.nil && a?.o) return 'malformed-struct';
    if (a?.nil && (b?.s === '0' || b?.s === '' || (b?.o && Array.isArray(b.e) && b.e.length === 0))) return 'cut-short';
    if (typeof a?.s === 'string' && typeof b?.s === 'string' && /^\d+$/.test(a.s) && /^-\d+$/.test(b.s)) {
      // The same bytes read in two's complement: now = was - 256^k, the top bit of was's last byte set.
      const was = BigInt(a.s), now = BigInt(b.s);
      const k = BigInt(Math.ceil(was.toString(16).length / 2));
      return was - now === 256n ** k && was >= 256n ** k / 2n ? 'negative-number' : 'unexplained';
    }
    if (a?.o && b?.o && a.e.length === b.e.length && a.e.every((x: any, i: number) => x[0] === b.e[i][0])) {
      // A struct whose fields changed: each must change by a named kind.
      const inner = a.e.map((x: any, i: number) => kindOf(x[1], b.e[i][1])).filter(Boolean);
      return inner.length && inner.every((k: string) => k !== 'unexplained') ? inner[0] : 'unexplained';
    }
    return 'unexplained';
  };
  if (was.out.length !== now.out.length || now.int.length !== now.out.length || now.address.length !== now.out.length) return ['unexplained'];
  was.out.forEach((a, j) => {
    const k = kindOf(a, now.out[j]);
    if (!k) {
      if (was.int[j] !== now.int[j] || was.address[j] !== now.address[j]) kinds.add('unexplained');
      return;
    }
    // What the kit reads from the new value must be what the kind implies: no address, and no number but a cut-short 0.
    const b = now.out[j] as { s?: unknown };
    const int = k === 'cut-short' && b?.s === '0' ? '0' : null;
    kinds.add(now.int[j] === int && now.address[j] === '' ? k : 'unexplained');
  });
  return [...kinds].sort();
}

// ── The file ────────────────────────────────────────────────────────────────

export type Inputs = Pick<Vectors, 'escrowConfigs' | 'keys' | 'node'> & {
  reads: Pick<ReadVector, 'read' | 'args'>[];
  escrow: Omit<EscrowVector, 'unsigned' | 'signed'>[];
  views: Pick<ViewVector, 'from' | 'calls'>[];
  decode: (Pick<DecodeVector, 'from' | 'mode' | 'hex'> & Partial<Pick<DecodeVector, 'pinned' | 'why'>>)[];
};

/** Every answer for the file's inputs, from the installed SDK. */
export async function compute(inputs: Inputs): Promise<Vectors> {
  const keys = keyVectors(inputs.keys.map((k) => k.label));
  const escrow = inputs.escrow.map((e) => {
    const { key, config, method, h, secret, symbol, amount, recipient, deadline, expiresAtMs } = e;
    const base = { key, config, method, h, secret, symbol, amount, recipient, deadline, expiresAtMs };
    return { ...base, ...escrowAnswer(base, inputs.escrowConfigs, keys) };
  });
  const views: ViewVector[] = [];
  for (const v of inputs.views) views.push({ from: v.from, calls: v.calls, scripts: await viewScripts(v.calls) });
  const decode: DecodeVector[] = [];
  for (const d of inputs.decode) {
    const kept = d.pinned && d.why ? { pinned: d.pinned, why: d.why } : {};
    decode.push({ from: d.from, mode: d.mode, hex: d.hex, ...(await decodeAnswer(d.mode, d.hex)), ...kept });
  }
  const reads: ReadVector[] = [];
  for (const r of inputs.reads) reads.push({ read: r.read, args: r.args, result: await readAnswer(r, inputs.node, inputs.escrowConfigs[0]!) });
  return { sdk: installedSdk(), escrowConfigs: inputs.escrowConfigs, keys, escrow, views, decode, node: inputs.node, reads };
}

export function readVectors(): Vectors {
  return JSON.parse(readFileSync(VECTORS_FILE, 'utf8')) as Vectors;
}

/** The file's text: one entry per line, so a diff shows which answer moved. */
export function vectorsText(v: Vectors): string {
  const list = (xs: readonly unknown[]) => (xs.length ? `[\n${xs.map((x) => '  ' + JSON.stringify(x)).join(',\n')}\n ]` : '[]');
  return `{\n "sdk": ${JSON.stringify(v.sdk)},\n "escrowConfigs": ${list(v.escrowConfigs)},\n "keys": ${list(v.keys)},\n "escrow": ${list(v.escrow)},\n "views": ${list(v.views)},\n "decode": ${list(v.decode)},\n "node": ${list(v.node)},\n "reads": ${list(v.reads)}\n}\n`;
}

/**
 * The SHA-256 of everything the file holds but `pinned` and `why`: its inputs
 * and 0.4.0's answers. The test holds it to SDK_VECTORS_SHA256, so dropping or
 * editing a vector shows in the test's diff, not only in this large file's.
 * --write and --pinned print it.
 */
export function referenceDigest(v: Vectors): string {
  const decode = v.decode.map(({ pinned: _p, why: _w, ...rest }) => rest);
  return sha256(JSON.stringify({ ...v, decode })).toString('hex');
}

/** The SDK the kit pins (its package.json), as "phantasma-sdk-ts@<version>". */
export function pinnedSdk(): string {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
  return `phantasma-sdk-ts@${pkg.dependencies['phantasma-sdk-ts']}`;
}

/**
 * The file with the kit's SDK's readings: `pinned` and `why` where it reads an
 * answer differently from 0.4.0. Throws when it changes a key, a transaction
 * or a script, or reads an answer differently in a way DECODE_CHANGES does not name.
 */
export async function withPinned(v: Vectors): Promise<Vectors> {
  const now = await compute(v);
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(now.keys, v.keys)) throw new Error(`${installedSdk()} derives other keys or addresses`);
  if (!same(now.escrow, v.escrow)) throw new Error(`${installedSdk()} builds or signs other escrow transactions`);
  if (!same(now.views, v.views)) throw new Error(`${installedSdk()} builds other view scripts`);
  if (!same(now.reads, v.reads)) throw new Error(`${installedSdk()} gives other escrow reads`);
  const decode = v.decode.map((d, i) => {
    const was: Answer = { out: d.out, int: d.int, address: d.address };
    const read = now.decode[i]!;
    const got: Answer = { out: read.out, int: read.int, address: read.address };
    const { pinned: _p, why: _w, ...rest } = d;
    if (same(got, was)) return rest;
    const why = changesOf(was, got);
    if (why.includes('unexplained') || !why.length) throw new Error(`${installedSdk()} reads answer ${i} (${d.hex.slice(0, 24)}) differently in an unnamed way`);
    return { ...rest, pinned: got, why: why as DecodeChange[] };
  });
  return { ...v, decode };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--write')) {
    if (installedSdk() !== REFERENCE_SDK) throw new Error(`the answers are ${REFERENCE_SDK}'s; ${installedSdk()} is installed`);
    const v = await compute(readVectors());
    writeFileSync(VECTORS_FILE, vectorsText(v));
    console.log(`wrote ${VECTORS_FILE}: ${v.keys.length} keys, ${v.escrow.length} escrow transactions, ${v.views.length} call lists, ${v.decode.length} answers, ${v.reads.length} reads over ${v.node.length} recorded node answers; reference digest ${referenceDigest(v)}`);
  } else if (process.argv.includes('--pinned')) {
    if (installedSdk() !== pinnedSdk()) throw new Error(`the kit pins ${pinnedSdk()}; ${installedSdk()} is installed (npm ci --ignore-scripts)`);
    const v = await withPinned(readVectors());
    writeFileSync(VECTORS_FILE, vectorsText(v));
    console.log(`wrote ${VECTORS_FILE}: ${v.decode.filter((d) => d.pinned).length} answers ${pinnedSdk()} reads differently; reference digest ${referenceDigest(v)}`);
  }
}
