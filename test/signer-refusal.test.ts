/**
 * The signer's gate (build spec sections 6.4 and 6.8, section 7 invariant 5):
 *   - it refuses an intent it did not issue (a look-alike object, a copy),
 *     one older than 60 s, one already used, one for another step, network
 *     or key;
 *   - a failed check means 0 sends, and so does a re-check that fails right
 *     before the signature; the fake transports count every send;
 *   - only checks.ts can make intents; mainnet has a signer only with its pins.
 *
 * The intents come from the Base-only steps (a refund, a deferred payout),
 * so no escrow bytecode is needed here; checks.test.ts covers every step
 * over the real devnet escrow script.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PhantasmaKeys } from 'phantasma-sdk-ts';
import { generatePrivateKey } from 'viem/accounts';
import { keccak256, parseTransaction, recoverTransactionAddress, type AbiEvent } from 'viem';
import { openStore, type KitStore } from '../src/store.js';
import { loadKeys, type LoadedKeys } from '../src/keys.js';
import { SafetyError } from '../src/errors.js';
import { hashOfSecret, newControlToken } from '../src/codec.js';
import { P2P_CONFIG, phaPinned, baseDeployed } from '../src/pins.js';
import { PhaReader, type PhaRpc, type PhaCall, type PhaBalance, type PhaTxState } from '../src/pha.js';
import { BaseReader, type BaseClient, type BaseBlock, type BaseLog, type BaseReceipt, type ReadCall, type TxCall, type Hex } from '../src/base.js';
import * as checks from '../src/checks.js';
import type { CheckDeps } from '../src/checks.js';
import { createSigner, takeIssuer, INTENT_MAX_AGE_MS, SIGNER_CODES, type Signer, type Checked } from '../src/signer.js';
import type { Trade, LocalTrade } from '../src/types.js';

const T0 = 1_790_000_000;
const CFG = P2P_CONFIG.devnet;
const SWAP = CFG.base.swap.toLowerCase();
const USDC = CFG.base.usdc.toLowerCase();
const S_P = 'P2K' + 'S'.repeat(44);
const S_B = '0x' + '5a'.repeat(20);
const X_B = '0x' + 'c3'.repeat(20);
const H = hashOfSecret('0x' + '42'.repeat(32));
const ZERO = '0x' + '0'.repeat(40);

/** A Phantasma node that counts reads and sends; its escrow script is not the pinned one. */
class CountingPha implements PhaRpc {
  reads = 0;
  sent: string[] = [];
  async views(calls: readonly PhaCall[]): Promise<unknown[]> { this.reads += calls.length; return calls.map(() => '0'); }
  async contract(): Promise<{ name: string; script: string; methods: string[] }> { this.reads++; return { name: 'saturnescrow', script: '00'.repeat(64), methods: ['getState'] }; }
  async balances(): Promise<PhaBalance[]> { this.reads++; return []; }
  async sendRaw(hex: string): Promise<string> { this.sent.push(hex); return createHash('sha256').update(hex).digest('hex').toUpperCase(); }
  async transaction(): Promise<PhaTxState | null> { return { state: 'Halt', reason: '' }; }
}

/** A Base node with one buyer's USDC lock and SaturnSwap's owed payouts; it counts calls and sends. */
class CountingBase implements BaseClient {
  head = 10_000n;
  swap = { token: USDC, deadline: BigInt(T0 - 100), feeBps: 50, state: 1, sender: '', claimer: S_B, amount: 5_400_000n };
  owed = new Map<string, bigint>();
  nonces = new Map<string, number>();
  calls = 0;
  sent: Hex[] = [];
  receipts = new Map<string, BaseReceipt>();
  constructor(readonly clock: () => number) {}
  async chainId(): Promise<number> { return CFG.base.chainId; }
  async block(at: { tag?: 'latest' | 'safe'; number?: bigint } = {}): Promise<BaseBlock> {
    return { number: at.number ?? this.head, timestamp: BigInt(Math.floor(this.clock() / 1000)), baseFeePerGas: 10_000_000n };
  }
  async read(c: ReadCall): Promise<unknown> {
    const a = (c.args ?? []) as string[];
    if (c.address.toLowerCase() === SWAP && c.functionName === 'getSwap') {
      return a[1]!.toLowerCase() === this.swap.sender ? this.swap : { token: ZERO, deadline: 0n, feeBps: 0, state: 0, sender: ZERO, claimer: ZERO, amount: 0n };
    }
    if (c.address.toLowerCase() === SWAP && c.functionName === 'owed') return this.owed.get(a[1]!.toLowerCase()) ?? 0n;
    throw new Error(`no ${c.functionName}`);
  }
  async logs(_q: { address: Hex; event: AbiEvent; args: Record<string, unknown>; fromBlock: bigint; toBlock: bigint }): Promise<BaseLog[]> { return []; }
  async receipt(hash: Hex): Promise<BaseReceipt | null> { return this.receipts.get(hash.toLowerCase()) ?? null; }
  async seen(hash: Hex): Promise<boolean> { return this.receipts.has(hash.toLowerCase()); }
  async code(): Promise<Hex> { return '0x'; }
  async balance(): Promise<bigint> { return 10n ** 18n; }
  async nonce(address: Hex): Promise<number> { return this.nonces.get(address.toLowerCase()) ?? 0; }
  async priorityFee(): Promise<bigint> { return 1_000_000n; }
  async call(_c: TxCall): Promise<Hex> { this.calls++; return '0x'; }
  async estimateGas(): Promise<bigint> { return 100_000n; }
  async sendRaw(raw: Hex): Promise<Hex> {
    this.sent.push(raw);
    const hash = keccak256(raw);
    const from = (await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase();
    this.nonces.set(from, (parseTransaction(raw).nonce ?? 0) + 1);
    this.receipts.set(hash.toLowerCase(), { status: 'success', blockNumber: this.head + 1n, transactionHash: hash, logs: [] });
    return hash;
  }
}

class Board { trades = new Map<number, Trade>(); async trade(id: number): Promise<Trade> { const t = this.trades.get(id); if (!t) throw new Error('none'); return t; } }

const dirs: string[] = [];
const stores: KitStore[] = [];
after(async () => {
  for (const s of stores) await s.close().catch(() => {});
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'kit-signer-'));
  dirs.push(d);
  return d;
}

async function makeKeys(network: 'devnet' | 'mainnet'): Promise<LoadedKeys> {
  const d = await tempDir();
  const phaFile = join(d, 'p.json'), baseFile = join(d, 'b.json');
  await writeFile(phaFile, JSON.stringify({ wif: PhantasmaKeys.generate().toWIF() }), { mode: 0o600 });
  await writeFile(baseFile, JSON.stringify({ privateKey: generatePrivateKey() }), { mode: 0o600 });
  return loadKeys({ network, phaKeyFile: phaFile, baseKeyFile: baseFile, argv: [] });
}

let K: LoadedKeys;
let KB: string;
before(async () => {
  K = await makeKeys('devnet');
  KB = K.address.base.toLowerCase();
});

interface Rig {
  clock: { ms: number };
  pha: CountingPha;
  base: CountingBase;
  store: KitStore;
  deps: CheckDeps;
  signer: Signer;
  buyer: LocalTrade;
  seller: LocalTrade;
  sends(): number;
}

/** Trade 7: the kit bought, its USDC lock ended (refundable). Trade 8: the kit sold, a payout is owed. */
async function rig(o: { address?: Partial<CheckDeps['address']> } = {}): Promise<Rig> {
  const clock = { ms: T0 * 1000 };
  const now = () => clock.ms;
  const pha = new CountingPha();
  const base = new CountingBase(now);
  base.swap.sender = KB;
  const store = await openStore({ dataDir: await tempDir(), network: 'devnet', keyFile: null, now });
  stores.push(store);
  const common = { network: 'devnet' as const, offerId: 3, symbol: 'TAZ', taz: '5000000000', usdc: '5400000', price: '1080000', myPha: K.address.pha, myBase: KB, txs: {}, createdAt: clock.ms, updatedAt: clock.ms };
  const buyer: LocalTrade = { ...common, id: 7, role: 'B', maker: false, counterPha: S_P, counterBase: S_B, takerToken: newControlToken(), h: H, phaContract: 'saturnescrow' };
  const seller: LocalTrade = { ...common, id: 8, role: 'S', maker: true, counterPha: S_P, counterBase: X_B, h: H, phaContract: 'saturnescrow', feeShown: 50 };
  await store.addTrade(buyer);
  await store.addTrade(seller);
  base.owed.set(KB, 5_373_000n);
  const deps: CheckDeps = {
    network: 'devnet', pha: new PhaReader(pha, 'devnet'), base: new BaseReader(base, 'devnet'), store, board: new Board(),
    address: { pha: K.address.pha, base: K.address.base, ...o.address }, now
  };
  const signer = createSigner({ keys: K, pha, base, store, now, sleep: async () => {}, wait: { phaTries: 1, phaIntervalMs: 0, baseTimeoutMs: 1, basePollMs: 1 } });
  return { clock, pha, base, store, deps, signer, buyer, seller, sends: () => pha.sent.length + base.sent.length };
}

async function refusal(p: Promise<unknown>, code: string): Promise<SafetyError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof SafetyError, `a SafetyError, got ${(e as Error)?.message}`);
    assert.equal(e.code, code, e.message);
    return e;
  }
  assert.fail(`expected a refusal ${code}`);
}

async function refundIntent(r: Rig): Promise<Checked<'refundBase'>> {
  const c = await checks.refundBase(r.deps, r.buyer);
  assert.equal(c.ok, true, c.ok ? '' : c.problem.text);
  if (!c.ok) throw new Error('unreachable');
  return c.intent;
}

describe('the signer refuses intents it must not sign', () => {
  test('one it did not issue: a look-alike object, a copy, or no intent at all, with 0 sends', async () => {
    const r = await rig();
    const real = await refundIntent(r);
    const lookAlike = { kind: 'refundBase', network: 'devnet', tradeId: 7, signer: KB, issuedAt: r.clock.ms, facts: { tradeId: 7, h: H, sender: KB, deadline: T0 - 100 }, recheck: async () => ({ ok: true }) };
    await refusal(r.signer.refundBase(lookAlike as unknown as Checked<'refundBase'>), SIGNER_CODES.INTENT_FOREIGN);
    await refusal(r.signer.refundBase({ ...real }), SIGNER_CODES.INTENT_FOREIGN);
    await refusal(r.signer.refundBase(Object.create(real) as Checked<'refundBase'>), SIGNER_CODES.INTENT_FOREIGN);
    await refusal(r.signer.refundBase(null as unknown as Checked<'refundBase'>), SIGNER_CODES.INTENT_FOREIGN);
    assert.equal(r.sends(), 0);
    assert.equal(r.base.calls, 0, 'not even a simulation');
    // The real one still signs.
    assert.equal((await r.signer.refundBase(real)).outcome, 'confirmed');
    assert.equal(r.base.sent.length, 1);
  });

  test('one older than 60 s, with 0 sends (60 s exactly is still fine)', async () => {
    const r = await rig();
    const old = await refundIntent(r);
    r.clock.ms += INTENT_MAX_AGE_MS + 1;
    await refusal(r.signer.refundBase(old), SIGNER_CODES.INTENT_OLD);
    assert.equal(r.sends(), 0);
    // A refused intent is spent: it cannot be tried again.
    await refusal(r.signer.refundBase(old), SIGNER_CODES.INTENT_USED);

    const v = await rig();
    const atLimit = await refundIntent(v);
    v.clock.ms += INTENT_MAX_AGE_MS;
    assert.equal((await v.signer.refundBase(atLimit)).outcome, 'confirmed');
  });

  test('one already used: the second use sends nothing', async () => {
    const r = await rig();
    const i = await refundIntent(r);
    assert.equal((await r.signer.refundBase(i)).outcome, 'confirmed');
    assert.equal(r.base.sent.length, 1);
    await refusal(r.signer.refundBase(i), SIGNER_CODES.INTENT_USED);
    assert.equal(r.base.sent.length, 1);
  });

  test('one for another step, or for another key', async () => {
    const r = await rig();
    const i = await refundIntent(r);
    await refusal(r.signer.withdrawOwed(i as unknown as Checked<'withdrawOwed'>), SIGNER_CODES.INTENT_KIND);
    // Checks run for another Base address than this signer's key: the signer refuses it.
    const v = await rig({ address: { base: X_B } });
    const other = await checks.withdrawOwed(v.deps, v.seller);
    assert.ok(other.ok);
    if (!other.ok) return;
    await refusal(v.signer.withdrawOwed(other.intent), 'BASE_KEY');
    assert.equal(r.sends() + v.sends(), 0);
  });

  test('intents are frozen: what was checked is what is signed', async () => {
    const r = await rig();
    const i = await refundIntent(r);
    assert.throws(() => { (i.facts as { sender: string }).sender = X_B; }, TypeError);
    assert.throws(() => { (i as { tradeId: number }).tradeId = 8; }, TypeError);
    assert.equal((await r.signer.refundBase(i)).outcome, 'confirmed');
  });
});

describe('a failed check means 0 sends', () => {
  test('checks that refuse issue no intent, read before nothing is sent, and the signer has nothing to sign', async () => {
    const r = await rig();
    // Too early for the refund.
    r.base.swap.deadline = BigInt(T0 + 600);
    const early = await checks.refundBase(r.deps, r.buyer);
    assert.equal(early.ok, false);
    if (!early.ok) assert.equal(early.problem.code, 'REFUND_BASE');
    // Nothing owed.
    r.base.owed.clear();
    const owed = await checks.withdrawOwed(r.deps, r.seller);
    assert.equal(owed.ok, false);
    if (!owed.ok) assert.equal(owed.problem.code, 'NOTHING_OWED');
    // A Phantasma escrow whose script is not the pinned one: the seller's claim refuses before any send.
    const claim = await checks.selfClaim(r.deps, r.seller);
    assert.equal(claim.ok, false, 'no secret kept: refused');
    const pin = await checks.codePin(r.deps);
    assert.equal(pin?.code, 'CODE_PIN');
    // A refused result is not an intent.
    await refusal(r.signer.refundBase((early as unknown) as Checked<'refundBase'>), SIGNER_CODES.INTENT_FOREIGN);
    assert.equal(r.sends(), 0, 'no transaction on either chain');
    assert.equal(r.base.calls, 0, 'no simulation either');
  });

  test('a re-check that fails right before the signature: 0 sends; a step the keeper already did: done_elsewhere, 0 sends', async () => {
    const r = await rig();
    const i = await refundIntent(r);
    r.base.swap.state = 2;   // the seller claimed it meanwhile
    const e = await refusal(r.signer.refundBase(i), 'REFUND_BASE');
    assert.equal((e as { check?: unknown }).check, 63);
    assert.equal(r.sends(), 0);

    const v = await rig();
    const j = await refundIntent(v);
    v.base.swap.state = 3;   // the keeper refunded it meanwhile
    const out = await v.signer.refundBase(j);
    assert.equal(out.outcome, 'done_elsewhere');
    assert.equal(v.sends(), 0);
  });

  test('the journal records the intent before the send and its outcome after it', async () => {
    const r = await rig();
    const i = await refundIntent(r);
    assert.equal((await r.store.getJournal(7)).intents.length, 0, 'checks write no intent');
    const out = await r.signer.refundBase(i);
    const j = await r.store.getJournal(7);
    assert.equal(j.intents.length, 1);
    assert.equal(j.intents[0]!.kind, 'refundBase');
    assert.equal(j.intents[0]!.txHash, out.txHash);
    assert.equal(j.intents[0]!.outcome, 'confirmed');
    assert.equal((await r.store.getTrade(7))?.txs.refundBase, out.txHash);
  });
});

describe('Base nonces never leave a gap (a later transaction would wait behind it, and a claim could land after its deadline)', () => {
  test('a re-check that refuses after the nonce was taken gives the nonce back: the next send uses it', async () => {
    const r = await rig();
    const i = await refundIntent(r);
    let swaps = 0;
    const read = r.base.read.bind(r.base);
    // The second getSwap read is the re-check right before signing, after prepare took nonce 0: the seller claimed meanwhile.
    r.base.read = async (c) => { if (c.functionName === 'getSwap' && ++swaps === 2) r.base.swap.state = 2; return read(c); };
    await refusal(r.signer.refundBase(i), 'REFUND_BASE');
    const o = await checks.withdrawOwed(r.deps, r.seller);
    assert.ok(o.ok);
    if (!o.ok) return;
    assert.equal((await r.signer.withdrawOwed(o.intent)).outcome, 'confirmed');
    assert.deepEqual(r.base.sent.map((x) => parseTransaction(x).nonce), [0], 'nonce 0, not 1');
  });

  test('two trades at once: a nonce above the node\'s count is refused, never broadcast; the next send reads the node again', async () => {
    const r = await rig();
    const i7 = await refundIntent(r);
    const o8 = await checks.withdrawOwed(r.deps, r.seller);
    assert.ok(o8.ok);
    if (!o8.ok) return;
    // Trade 7's refund takes nonce 0, then waits in its last re-check while trade 8's payout takes nonce 1.
    let swaps = 0;
    let reached!: () => void;
    let open!: () => void;
    const atGate = new Promise<void>((res) => { reached = res; });
    const gate = new Promise<void>((res) => { open = res; });
    const read = r.base.read.bind(r.base);
    r.base.read = async (c) => {
      if (c.functionName === 'getSwap' && ++swaps === 2) { reached(); await gate; r.base.swap.state = 2; }
      return read(c);
    };
    const p7 = r.signer.refundBase(i7);
    await atGate;
    await refusal(r.signer.withdrawOwed(o8.intent), 'NOT_SENDABLE');
    open();
    await refusal(p7, 'REFUND_BASE');
    assert.equal(r.sends(), 0, 'nothing was broadcast behind the unused nonce 0');
    const again = await checks.withdrawOwed(r.deps, r.seller);
    assert.ok(again.ok);
    if (!again.ok) return;
    assert.equal((await r.signer.withdrawOwed(again.intent)).outcome, 'confirmed');
    assert.deepEqual(r.base.sent.map((x) => parseTransaction(x).nonce), [0]);
  });
});

describe('who may make intents, and where', () => {
  test('only checks.ts holds the issuer', () => {
    assert.throws(() => takeIssuer(), (e: unknown) => e instanceof SafetyError && e.code === 'ISSUER_TAKEN');
  });

  test('mainnet has a signer only once its pins are filled (this release fills them); keys and store must be of one network', async () => {
    const mk = await makeKeys('mainnet');
    const d = await tempDir();
    const ms = await openStore({ dataDir: d, network: 'mainnet', keyFile: null });
    stores.push(ms);
    // The signer signs only where the escrow and SaturnSwap are pinned; running on mainnet also needs createKit's gates.
    if (phaPinned(P2P_CONFIG.mainnet) && baseDeployed(P2P_CONFIG.mainnet)) assert.ok(createSigner({ keys: mk, pha: new CountingPha(), base: new CountingBase(Date.now), store: ms }));
    else assert.throws(() => createSigner({ keys: mk, pha: new CountingPha(), base: new CountingBase(Date.now), store: ms }), (e: unknown) => e instanceof SafetyError && e.code === 'NETWORK_OFF' && /no pins for mainnet/.test(e.detail));
    const ds = await openStore({ dataDir: await tempDir(), network: 'devnet', keyFile: null });
    stores.push(ds);
    assert.throws(() => createSigner({ keys: K, pha: new CountingPha(), base: new CountingBase(Date.now), store: ms }), (e: unknown) => e instanceof SafetyError && e.code === 'NETWORK_OFF');
    assert.ok(createSigner({ keys: K, pha: new CountingPha(), base: new CountingBase(Date.now), store: ds }));
  });
});
