/**
 * Every check of build spec section 6.4 that lives in checks.ts, signer.ts,
 * rules.ts, store.ts or keys.ts refuses with its own code: one failing case
 * each, over fake chains (section 6.8), plus the passing path of every step
 * so each failing case differs from a working one by exactly one fact.
 * Checks 9, 16, 35 and 67 are B6d's (flows, createKit); 26 is UI only.
 *
 * The fake Phantasma node serves the real devnet escrow script (public
 * on-chain bytecode, deflated below), so the code pin runs against the
 * kit's real pins: nothing in a test changes a pin.
 *
 * Keys are generated on the spot, never funded and never printed; no
 * transaction leaves this process (the fakes count every send).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { PhantasmaKeys, ScriptBuilder, Address } from 'phantasma-sdk-ts';
import { generatePrivateKey } from 'viem/accounts';
import { decodeFunctionData, keccak256, parseTransaction, recoverTransactionAddress, type AbiEvent } from 'viem';
import { openStore, type KitStore } from '../src/store.js';
import { loadKeys, knownRoleProblem, type LoadedKeys } from '../src/keys.js';
import { SafetyError } from '../src/errors.js';
import { makeSecretRecord, hexToDecimal, decimalToHex, hashOfSecret, newControlToken } from '../src/codec.js';
import { P2P_CONFIG, PHA_HASH_VECTORS, P2P_TOKENS, PHA_LOCK_GAS, phaPinned, baseDeployed } from '../src/pins.js';
import { PhaReader, type PhaRpc, type PhaCall, type PhaBalance, type PhaTxState } from '../src/pha.js';
import { BaseReader, SATURN_SWAP_ABI, USDC_ABI, pinnedDomainSeparator, sendRefused, notSendable, feesFor, replacementFees, bumpFee, type BaseClient, type BaseBlock, type BaseLog, type BaseReceipt, type ReadCall, type TxCall, type Hex } from '../src/base.js';
import * as checks from '../src/checks.js';
import { CHECK_CODES, type CheckDeps, type Problem, type TradeReader } from '../src/checks.js';
import { createSigner, SignRefusal, type Signer } from '../src/signer.js';
import type { Trade, LocalTrade, LocalOffer, SecretRecord } from '../src/types.js';

// ── The devnet escrow as the node serves it ────────────────────────────────

/** The devnet saturnescrow script (getContract('main', 'saturnescrow').script), deflated and base64: public bytecode. */
const ESCROW_SCRIPT_DEFLATED = [
  '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'
].join('');
const ESCROW_SCRIPT = inflateSync(Buffer.from(ESCROW_SCRIPT_DEFLATED, 'base64')).toString('hex');
const ESCROW_METHODS = ['Initialize', 'getContractVersion', 'lock', 'claim', 'refund', 'hashSecret', 'getLockCount', 'getOpen', 'getHashAt', 'getId', 'getState',
  'getSender', 'getRecipient', 'getSymbol', 'getAmount', 'getDeadline', 'getCreated', 'getSecret', 'getAdmin', 'getPaused', 'getMinLock', 'getMaxLock',
  'getMinAmount', 'getMaxAmount', 'getLockedTotal', 'getClaimedTotal', 'getNow', 'setPaused', 'setToken', 'setLockBounds', 'setAdmin', 'getOpenAmount',
  'getMaxOpen', 'setOpenCap', 'onUpgrade', 'onKill'];
const CFG = P2P_CONFIG.devnet;

// ── Fixed facts ─────────────────────────────────────────────────────────────

const T0 = 1_790_000_000;
const S_P = 'P2K' + 'S'.repeat(44);
const B_P = 'P2K' + 'B'.repeat(44);
const X_P = 'P2K' + 'X'.repeat(44);
const S_B = '0x' + '5a'.repeat(20);
const B_B = '0x' + 'b7'.repeat(20);
const X_B = '0x' + 'c3'.repeat(20);
const SWAP = CFG.base.swap.toLowerCase();
const USDC = CFG.base.usdc.toLowerCase();
const TAZ = 5_000_000_000n;          // 5 TAZ
const PRICE = 1_080_000n;            // 1.08 USDC per TAZ
const USDC_AMT = 5_400_000n;         // 5.4 USDC
const ZERO = '0x' + '0'.repeat(40);

const sha = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest();

// ── A fake Phantasma node with the escrow ───────────────────────────────────

interface FakeLock { state: number; sender: string; recipient: string; symbol: string; amount: bigint; deadline: number; created: number; secret?: string }

class FakePha implements PhaRpc {
  name = 'saturnescrow';
  script = ESCROW_SCRIPT;
  methods = [...ESCROW_METHODS];
  admin: string = CFG.phaAdmin;
  locks = new Map<string, FakeLock>();
  paused = false;
  minLock = 600;
  maxLock = 7_200;
  bounds: Record<string, { min: bigint; max: bigint }> = Object.fromEntries(P2P_TOKENS.map((t) => [t.symbol, { min: t.min, max: t.max }]));
  caps: Record<string, { open: bigint; max: bigint }> = Object.fromEntries(P2P_TOKENS.map((t) => [t.symbol, { open: 0n, max: 10n ** 20n }]));
  bals = new Map<string, PhaBalance[]>();
  vectorsWrong = false;
  fail = new Set<string>();
  sent: string[] = [];
  reads = 0;
  nextState: PhaTxState = { state: 'Halt', reason: '' };
  states = new Map<string, PhaTxState>();
  onSend?: (hex: string) => void;

  async views(calls: readonly PhaCall[]): Promise<unknown[]> {
    this.reads += calls.length;
    return calls.map((c) => this.#view(c));
  }

  #view(c: PhaCall): unknown {
    if (this.fail.has(c.method)) throw new Error(`fake node: ${c.method} fails`);
    if (c.contract !== this.name) return null;
    const lock = () => this.locks.get(decimalToHex(c.args[0])!);
    switch (c.method) {
      case 'getState': return String(lock()?.state ?? 0);
      case 'getSender': return lock()?.sender ?? null;
      case 'getRecipient': return lock()?.recipient ?? null;
      case 'getSymbol': return lock()?.symbol ?? null;
      case 'getAmount': return lock() ? String(lock()!.amount) : null;
      case 'getDeadline': return lock() ? String(lock()!.deadline) : null;
      case 'getCreated': return lock() ? String(lock()!.created) : null;
      case 'getSecret': { const s = lock()?.secret; return s ? hexToDecimal(s) : null; }
      case 'getAdmin': return this.admin;
      case 'getPaused': return this.paused ? '1' : '0';
      case 'getMinLock': return String(this.minLock);
      case 'getMaxLock': return String(this.maxLock);
      case 'getMinAmount': return String(this.bounds[c.args[0]!]?.min ?? 0n);
      case 'getMaxAmount': return String(this.bounds[c.args[0]!]?.max ?? 0n);
      case 'getOpenAmount': return String(this.caps[c.args[0]!]?.open ?? 0n);
      case 'getMaxOpen': return String(this.caps[c.args[0]!]?.max ?? 0n);
      case 'hashSecret': {
        const bytes = Buffer.from(BigInt(c.args[0]!).toString(16).padStart(64, '0'), 'hex');
        const d = BigInt('0x' + sha(bytes).toString('hex')) + (this.vectorsWrong ? 1n : 0n);
        return d.toString();
      }
      default: return null;
    }
  }

  async contract(): Promise<{ name: string; script: string; methods: string[] }> {
    if (this.fail.has('getContract')) throw new Error('fake node: getContract fails');
    return { name: this.name, script: this.script, methods: this.methods };
  }

  async balances(address: string): Promise<PhaBalance[]> {
    if (this.fail.has('getAccount')) throw new Error('fake node: getAccount fails');
    return this.bals.get(address) ?? [];
  }

  async sendRaw(hex: string): Promise<string> {
    this.sent.push(hex);
    const hash = sha(Buffer.from(hex, 'hex')).toString('hex').toUpperCase();
    this.states.set(hash, this.nextState);
    this.onSend?.(hex);
    return hash;
  }

  async transaction(hash: string): Promise<PhaTxState | null> {
    return this.states.get(hash) ?? null;
  }
}

// ── A fake Base node with SaturnSwap and USDC ──────────────────────────────

interface FakeSwap { token: string; deadline: number; feeBps: number; state: number; sender: string; claimer: string; amount: bigint; block: bigint }

class FakeBase implements BaseClient {
  head = 10_000n;
  skew = 0;
  baseFee = 10_000_000n;
  tip = 1_000_000n;
  feeBps = 50;
  paused = false;
  minLock = 60;
  maxLock = 172_800;
  allowed = true;
  minAmount = 1_000_000n;
  maxAmount = 100_000_000_000n;
  usdc = new Map<string, bigint>();
  allowances = new Map<string, bigint>();
  eth = new Map<string, bigint>();
  nonces = new Map<string, number>();
  pendingExtra = 0;
  swaps = new Map<string, FakeSwap>();
  preimages = new Map<string, string>();
  owed = new Map<string, bigint>();
  domain: string = pinnedDomainSeparator(CFG);
  permitNonces = new Map<string, bigint>();
  codes = new Map<string, Hex>();
  events: BaseLog[] = [];
  blockTimes = new Map<bigint, number>();
  receipts = new Map<string, BaseReceipt>();
  /** eth_call: an error for a call that must revert (n counts the calls). */
  failCall?: (c: TxCall, n: number) => Error | null;
  calls = 0;
  reads = 0;
  sent: Hex[] = [];
  applyApprove = true;
  nextStatus: 'success' | 'reverted' | null = 'success';
  failRead = new Set<string>();

  constructor(readonly clock: () => number) {}

  #time(): number { return Math.floor(this.clock() / 1000) + this.skew; }

  async chainId(): Promise<number> { return 84532; }

  async block(at: { tag?: 'latest' | 'safe'; number?: bigint } = {}): Promise<BaseBlock> {
    if (this.failRead.has('block')) throw new Error('fake base: block fails');
    if (at.number != null) {
      return { number: at.number, timestamp: BigInt(this.blockTimes.get(at.number) ?? this.#time() - Number(this.head - at.number) * 2), baseFeePerGas: this.baseFee };
    }
    const n = at.tag === 'safe' ? this.head - 10n : this.head;
    return { number: n, timestamp: BigInt(this.#time() - Number(this.head - n) * 2), baseFeePerGas: this.baseFee };
  }

  #swapAt(h: string, sender: string, blockNumber: bigint | undefined) {
    const s = this.swaps.get(`${h.toLowerCase()}|${sender.toLowerCase()}`);
    if (!s || (blockNumber != null && s.block > blockNumber)) return { token: ZERO, deadline: 0n, feeBps: 0, state: 0, sender: ZERO, claimer: ZERO, amount: 0n };
    return { token: s.token, deadline: BigInt(s.deadline), feeBps: s.feeBps, state: s.state, sender: s.sender, claimer: s.claimer, amount: s.amount };
  }

  async read(c: ReadCall): Promise<unknown> {
    this.reads++;
    if (this.failRead.has(c.functionName)) throw new Error(`fake base: ${c.functionName} fails`);
    const a = (c.args ?? []) as string[];
    const to = c.address.toLowerCase();
    if (to === SWAP) {
      switch (c.functionName) {
        case 'getSwap': return this.#swapAt(a[0]!, a[1]!, c.blockNumber);
        case 'feeBps': return this.feeBps;
        case 'paused': return this.paused;
        case 'minLock': return BigInt(this.minLock);
        case 'maxLock': return BigInt(this.maxLock);
        case 'tokenCfg': return [this.allowed, this.minAmount, this.maxAmount];
        case 'getPreimage': {
          const p = this.preimages.get(`${a[0]!.toLowerCase()}|${a[1]!.toLowerCase()}`);
          if (!p) throw new Error('NotClaimed');
          return p;
        }
        case 'owed': return this.owed.get(a[1]!.toLowerCase()) ?? 0n;
      }
    }
    if (to === USDC) {
      switch (c.functionName) {
        case 'balanceOf': return this.usdc.get(a[0]!.toLowerCase()) ?? 0n;
        case 'allowance': return this.allowances.get(a[0]!.toLowerCase()) ?? 0n;
        case 'nonces': return this.permitNonces.get(a[0]!.toLowerCase()) ?? 0n;
        case 'DOMAIN_SEPARATOR': return this.domain;
        case 'isBlacklisted': return false;
        case 'paused': return false;
      }
    }
    throw new Error(`fake base: no ${c.functionName} at ${to}`);
  }

  async logs(q: { address: Hex; event: AbiEvent; args: Record<string, unknown>; fromBlock: bigint; toBlock: bigint }): Promise<BaseLog[]> {
    return this.events.filter((l) => l.eventName === q.event.name && l.blockNumber != null && l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock
      && Object.entries(q.args).every(([k, v]) => String(l.args[k]).toLowerCase() === String(v).toLowerCase()));
  }

  async receipt(hash: Hex): Promise<BaseReceipt | null> { return this.receipts.get(hash.toLowerCase()) ?? null; }
  async seen(hash: Hex): Promise<boolean> { return this.receipts.has(hash.toLowerCase()); }
  async code(address: Hex): Promise<Hex> { return this.codes.get(address.toLowerCase()) ?? '0x'; }
  async balance(address: Hex): Promise<bigint> { return this.eth.get(address.toLowerCase()) ?? 10n ** 18n; }
  async nonce(address: Hex, tag: 'latest' | 'pending'): Promise<number> { return (this.nonces.get(address.toLowerCase()) ?? 0) + (tag === 'pending' ? this.pendingExtra : 0); }
  async priorityFee(): Promise<bigint> { return this.tip; }

  async call(c: TxCall): Promise<Hex> {
    const n = ++this.calls;
    const e = this.failCall?.(c, n);
    if (e) throw e;
    return '0x';
  }

  async estimateGas(): Promise<bigint> { return 100_000n; }

  async sendRaw(raw: Hex): Promise<Hex> {
    this.sent.push(raw);
    const hash = keccak256(raw);
    const t = parseTransaction(raw);
    const from = (await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase();
    this.nonces.set(from, (t.nonce ?? 0) + 1);
    if (this.applyApprove && t.data && t.to?.toLowerCase() === USDC) {
      const d = decodeFunctionData({ abi: USDC_ABI, data: t.data });
      if (d.functionName === 'approve') this.allowances.set(from, (d.args as readonly unknown[])[1] as bigint);
    }
    if (this.nextStatus) this.receipts.set(hash.toLowerCase(), { status: this.nextStatus, blockNumber: this.head + 1n, transactionHash: hash, logs: [] });
    return hash;
  }

  /** Put a buyer's USDC lock on chain at `block`, with its Locked event mined at unix time `minedAt`. */
  addSwap(h: string, s: Omit<FakeSwap, 'block'>, block: bigint, minedAt: number): void {
    this.swaps.set(`${h.toLowerCase()}|${s.sender.toLowerCase()}`, { ...s, block });
    this.blockTimes.set(block, minedAt);
    this.events.push({ address: SWAP, blockNumber: block, eventName: 'Locked', args: { h: h.toLowerCase(), sender: s.sender, claimer: s.claimer, token: s.token, amount: s.amount, deadline: BigInt(s.deadline), feeBps: s.feeBps } });
  }
}

class FakeBoard implements TradeReader {
  trades = new Map<number, Trade>();
  fail = false;
  gate: Promise<void> | null = null;
  async trade(id: number): Promise<Trade> {
    if (this.gate) await this.gate;
    if (this.fail) throw new Error('board down');
    const t = this.trades.get(id);
    if (!t) throw new Error('no such trade');
    return structuredClone(t);
  }
}

// ── Worlds ──────────────────────────────────────────────────────────────────

const dirs: string[] = [];
const stores: KitStore[] = [];
after(async () => {
  for (const s of stores) await s.close().catch(() => {});
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'kit-checks-'));
  dirs.push(d);
  return d;
}

let K: LoadedKeys;
let KB: string;  // the kit's Base address, lowercase
before(async () => {
  const d = await tempDir();
  const phaFile = join(d, 'pha.json'), baseFile = join(d, 'base.json');
  await writeFile(phaFile, JSON.stringify({ wif: PhantasmaKeys.generate().toWIF() }), { mode: 0o600 });
  await writeFile(baseFile, JSON.stringify({ privateKey: generatePrivateKey() }), { mode: 0o600 });
  await chmod(phaFile, 0o600);
  await chmod(baseFile, 0o600);
  K = await loadKeys({ network: 'devnet', phaKeyFile: phaFile, baseKeyFile: baseFile, argv: ['node', 'bot.ts'] });
  KB = K.address.base.toLowerCase();
});

interface World {
  clock: { ms: number };
  pha: FakePha;
  base: FakeBase;
  board: FakeBoard;
  store: KitStore;
  deps: CheckDeps;
  signer: Signer;
  trade: Trade;
  rec: LocalTrade;
  /** Sends so far on both chains. */
  sends(): number;
}

function tradeOf(o: Partial<Trade> = {}): Trade {
  return {
    id: 7, network: 'devnet', offerId: 3, side: 'sell', symbol: 'TAZ', taz: TAZ.toString(), usdc: USDC_AMT.toString(), price: PRICE.toString(),
    seller: { pha: S_P, base: S_B }, buyer: { pha: B_P, base: B_B }, h: null, phaContract: null,
    phaLockTx: null, baseLockTx: null, baseClaimTx: null, phaClaimTx: null, baseRefundTx: null, phaRefundTx: null,
    phaDeadline: null, baseDeadline: null, feeBps: 50, payoutDeferred: false, status: 'accepted',
    acceptBy: null, lockBy: T0 + 500, createdAt: T0 - 100, acceptedAt: T0 - 50, updatedAt: T0 - 50, endedAt: null, lastError: null, ...o
  };
}

const PHA_BALANCES = (): PhaBalance[] => [
  { symbol: 'TAZ', amount: (100n * 10n ** 9n).toString(), decimals: 9 },
  { symbol: 'SOUL', amount: (5n * 10n ** 8n).toString(), decimals: 8 },
  { symbol: 'KCAL', amount: (10n * 10n ** 10n).toString(), decimals: 10 }
];

/**
 * A world where every check of `role`'s next step passes:
 *   S: the kit sold on its own sell offer; the take is accepted (the seller's lock is next);
 *   B: the kit took a sell offer; the seller locked (the USDC lock is next).
 */
async function world(role: 'S' | 'B', o: { trade?: Partial<Trade>; rec?: Partial<LocalTrade>; address?: Partial<CheckDeps['address']> } = {}): Promise<World> {
  const clock = { ms: T0 * 1000 };
  const now = () => clock.ms;
  const pha = new FakePha();
  const base = new FakeBase(now);
  const board = new FakeBoard();
  const store = await openStore({ dataDir: await tempDir(), network: 'devnet', keyFile: null, now });
  stores.push(store);
  const me = { pha: K.address.pha, base: K.address.base };
  const trade = role === 'S'
    ? tradeOf({ seller: me, ...o.trade })
    : tradeOf({ buyer: me, status: 'pha_locked', ...o.trade });
  const rec: LocalTrade = role === 'S'
    ? { id: 7, network: 'devnet', offerId: 3, role: 'S', maker: true, symbol: 'TAZ', taz: TAZ.toString(), usdc: USDC_AMT.toString(), price: PRICE.toString(),
      myPha: K.address.pha, myBase: KB, counterPha: B_P, counterBase: B_B, txs: {}, status: 'accepted', createdAt: clock.ms - 100_000, updatedAt: clock.ms - 100_000, ...o.rec }
    : { id: 7, network: 'devnet', offerId: 3, role: 'B', maker: false, symbol: 'TAZ', taz: TAZ.toString(), usdc: USDC_AMT.toString(), price: PRICE.toString(),
      myPha: K.address.pha, myBase: KB, counterPha: S_P, counterBase: S_B, takerToken: newControlToken(), tokenSource: 'client', txs: {}, status: 'pha_locked',
      createdAt: clock.ms - 100_000, updatedAt: clock.ms - 100_000, ...o.rec };
  await store.addTrade(rec);
  board.trades.set(trade.id, trade);
  pha.bals.set(K.address.pha, PHA_BALANCES());
  base.usdc.set(B_B, 100_000_000n);
  base.usdc.set(KB, 100_000_000n);
  const deps: CheckDeps = {
    network: 'devnet', pha: new PhaReader(pha, 'devnet'), base: new BaseReader(base, 'devnet'), store, board,
    address: { pha: K.address.pha, base: K.address.base, ...o.address }, now
  };
  const signer = createSigner({ keys: K, pha, base, store, now, sleep: async () => {}, wait: { phaTries: 1, phaIntervalMs: 0, baseTimeoutMs: 1, basePollMs: 1, allowanceTries: 2, allowancePollMs: 0 } });
  return { clock, pha, base, board, store, deps, signer, trade, rec, sends: () => pha.sent.length + base.sent.length };
}

/** The seller's lock is on chain under h (made 60 s ago), as the buyer's world needs it. */
function sellerLocked(w: World, h: string, o: Partial<FakeLock> = {}): FakeLock {
  const l: FakeLock = { state: 1, sender: S_P, recipient: K.address.pha, symbol: 'TAZ', amount: TAZ, deadline: T0 - 60 + CFG.timing.phaLock, created: T0 - 60, ...o };
  w.pha.locks.set(h.toLowerCase(), l);
  return l;
}

const SECRET = '0x' + '42'.repeat(32);
const H = hashOfSecret(SECRET);

/** A buyer's world at the USDC lock: the board says pha_locked under H, the lock is on chain. */
async function buyerWorld(o: Parameters<typeof world>[1] = {}): Promise<World> {
  const w = await world('B', { ...o, trade: { h: H, phaContract: 'saturnescrow', ...o.trade } });
  sellerLocked(w, H);
  return w;
}

/**
 * A seller's world after both locks: the kit's secret for H is kept, its
 * Phantasma lock is on chain (made 300 s ago), the buyer's USDC lock is mined
 * 60 s after it and confirmed; feeShown 50 is stored.
 */
async function sellerAfterLocks(o: Parameters<typeof world>[1] & { swap?: Partial<Omit<FakeSwap, 'block'>>; minedAt?: number } = {}): Promise<World> {
  const w = await world('S', { ...o, trade: { h: H, phaContract: 'saturnescrow', status: 'base_locked', ...o.trade } });
  const sec: SecretRecord = { v: 1, secret: SECRET, h: H, tradeId: 7, network: 'devnet', symbol: 'TAZ', taz: TAZ.toString(), sPha: K.address.pha, bPha: B_P, role: 'S', createdAt: w.clock.ms - 400_000 };
  await w.store.putSecret(sec);
  await w.store.patchTrade(7, { feeShown: 50, phaContract: 'saturnescrow', h: H, t1: T0 - 300 + CFG.timing.phaLock });
  w.pha.locks.set(H, { state: 1, sender: K.address.pha, recipient: B_P, symbol: 'TAZ', amount: TAZ, deadline: T0 - 300 + CFG.timing.phaLock, created: T0 - 300 });
  w.base.addSwap(H, { token: USDC, deadline: T0 + 900, feeBps: 50, state: 1, sender: B_B, claimer: KB, amount: USDC_AMT, ...o.swap }, w.base.head - 20n, o.minedAt ?? T0 - 240);
  return w;
}

/** The problem of a refused result (fails the test when it passed). */
function refusedWith(r: { ok: boolean; problem?: Problem }, code: string, check?: checks.CheckId): Problem {
  assert.equal(r.ok, false, `expected a refusal ${code}`);
  const p = r.problem!;
  assert.equal(p.code, code, p.text);
  assert.equal(p.check, check ?? CHECK_CODES[code as checks.CheckCode]);
  assert.ok(p.text.length > 10, 'a sentence for the operator');
  return p;
}

function isProblem(p: Problem | null, code: string): Problem {
  assert.ok(p, `expected a refusal ${code}`);
  assert.equal(p.code, code, p.text);
  assert.equal(p.check, CHECK_CODES[code as checks.CheckCode]);
  return p;
}

async function signRefused(p: Promise<unknown>, code: string): Promise<SignRefusal | SafetyError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof SafetyError, `a SafetyError, got ${(e as Error)?.message}`);
    assert.equal(e.code, code, e.message);
    return e;
  }
  assert.fail(`expected the signer to refuse with ${code}`);
}

// ── The passing paths ───────────────────────────────────────────────────────

describe('every step passes in its clean world, and the signer sends exactly once', () => {
  test('the fixture is the devnet escrow the pins name', () => {
    assert.equal(createHash('sha256').update(Buffer.from(ESCROW_SCRIPT, 'hex')).digest('hex'), CFG.phaCodeSha256);
  });

  test('seller: sellerLock issues an intent; lockPha re-checks, signs once with the fixed gas allowance, and the lock lands', async () => {
    const w = await world('S');
    const r = await checks.sellerLock(w.deps, w.trade, w.rec);
    assert.equal(r.ok, true, r.ok ? '' : r.problem.text);
    if (!r.ok) return;
    const kept = await w.store.getTrade(7);
    assert.equal(kept?.feeShown, 50, 'check 32: feeShown stored before signing');
    assert.equal(kept?.phaContract, 'saturnescrow', 'check 32: the escrow name stored before signing');
    const secrets = await w.store.secretsOfTrade(7);
    assert.equal(secrets.length, 1, 'check 30: the secret is saved before signing');
    assert.equal(secrets[0]!.h, r.intent.facts.h);
    assert.equal(w.sends(), 0, 'the checks send nothing');
    const out = await w.signer.lockPha(r.intent);
    assert.equal(out.outcome, 'confirmed');
    assert.equal(w.pha.sent.length, 1);
    // Check 34: the fixed gas allowance (100,000 x 300,000), whatever the balance.
    const deadline = T0 + CFG.timing.phaLock;
    const sb = new ScriptBuilder();
    sb.AllowGas(K.address.pha, Address.Null, PHA_LOCK_GAS.price, PHA_LOCK_GAS.limit);
    sb.CallContract('saturnescrow', 'lock', [K.address.pha, hexToDecimal(r.intent.facts.h), 'TAZ', TAZ.toString(), B_P, String(deadline)]);
    sb.SpendGas(K.address.pha);
    assert.ok(w.pha.sent[0]!.toLowerCase().includes(sb.EndScript().toLowerCase()), 'the lock script, gas allowance included, is the one signed');
    const j = await w.store.getJournal(7);
    assert.deepEqual(j.intents.map((i) => [i.kind, i.outcome]), [['phaLock', 'confirmed']], 'journal: intent before the send, outcome after');
    assert.ok(j.intents[0]!.txHash);
  });

  test('buyer: buyerLock stores h, the escrow, T1 and T2 first; lockBase signs one lockWithPermit for exactly the amount', async () => {
    const w = await buyerWorld();
    const r = await checks.buyerLock(w.deps, w.trade, w.rec);
    assert.equal(r.ok, true, r.ok ? '' : r.problem.text);
    if (!r.ok) return;
    const kept = await w.store.getTrade(7);
    assert.equal(kept?.h, H, 'check 48');
    assert.equal(kept?.t1, T0 - 60 + CFG.timing.phaLock);
    assert.equal(kept?.t2, Math.min(kept!.t1! - CFG.timing.safety, T0 + CFG.timing.revealMin + CFG.timing.baseLockLead + CFG.timing.revealAllowance));
    const out = await w.signer.lockBase(r.intent);
    assert.equal(out.outcome, 'confirmed');
    assert.equal(w.base.sent.length, 1, 'one transaction: no separate approval');
    const t = parseTransaction(w.base.sent[0]!);
    assert.equal(t.to?.toLowerCase(), SWAP);
    assert.equal(t.gas, CFG.base.lockWithPermitGas, 'the pinned gas of the one-step lock');
    const d = decodeFunctionData({ abi: SATURN_SWAP_ABI, data: t.data! });
    assert.equal(d.functionName, 'lockWithPermit');
    const a = d.args as readonly unknown[];
    assert.equal(String(a[0]).toLowerCase(), H);
    assert.equal(a[2], USDC_AMT, 'exactly the trade\'s USDC');
    assert.equal(String(a[3]).toLowerCase(), S_B, 'the seller is paid');
    assert.equal(a[4], BigInt(kept!.t2!), 'exactly the stored T2');
    assert.equal(a[5], 50, 'maxFeeBps is the trade\'s fee');
    assert.ok(Number(a[6]) - T0 === 30 * 60, 'the permit lasts 30 minutes');
  });

  test('seller: reveal checks pass and the secret is posted only after secretSentAt is stored', async () => {
    const w = await sellerAfterLocks();
    const r = await checks.reveal(w.deps, w.trade, (await w.store.getTrade(7))!);
    assert.equal(r.ok, true, r.ok ? '' : r.problem.text);
    if (!r.ok) return;
    let posted = '';
    const out = await w.signer.reveal(r.intent, async (id, secret) => {
      assert.ok((await w.store.getTrade(id))?.secretSentAt, 'check 58: secretSentAt is stored before the POST');
      posted = secret;
    });
    assert.equal(out.outcome, 'confirmed');
    assert.equal(posted, SECRET);
    assert.ok((await w.store.getTrade(7))?.revealedAt);
    assert.equal(w.sends(), 0);
  });

  test('seller: selfClaim (a first claim runs the reveal\'s checks) and claimBase with twice the gas estimate', async () => {
    const w = await sellerAfterLocks();
    const r = await checks.selfClaim(w.deps, (await w.store.getTrade(7))!);
    assert.equal(r.ok, true, r.ok ? '' : r.problem.text);
    if (!r.ok) return;
    const out = await w.signer.claimBase(r.intent);
    assert.equal(out.outcome, 'confirmed');
    assert.equal(w.base.sent.length, 1);
    const t = parseTransaction(w.base.sent[0]!);
    assert.equal(t.gas, 200_000n, 'check 61: 2 x the 100,000 estimate (at least 150,000)');
    const d = decodeFunctionData({ abi: SATURN_SWAP_ABI, data: t.data! });
    assert.equal(d.functionName, 'claim');
    assert.equal(String((d.args as readonly unknown[])[1]).toLowerCase(), B_B);
  });

  test('buyer: claimPhaFor with the secret public at the confirmed block; refundBase after T2; seller: refundPha after T1; withdrawOwed', async () => {
    // The buyer claims its tokens itself.
    const b = await buyerWorld({ rec: { h: H, phaContract: 'saturnescrow' } });
    b.base.addSwap(H, { token: USDC, deadline: T0 + 900, feeBps: 50, state: 2, sender: KB, claimer: S_B, amount: USDC_AMT }, b.base.head - 20n, T0 - 30);
    b.base.preimages.set(`${H}|${KB}`, SECRET);
    const c = await checks.claimPhaFor(b.deps, (await b.store.getTrade(7))!);
    assert.equal(c.ok, true, c.ok ? '' : c.problem.text);
    if (c.ok) assert.equal((await b.signer.claimPha(c.intent)).outcome, 'confirmed');
    assert.equal(b.pha.sent.length, 1);

    // The buyer's refund on Base.
    const rb = await buyerWorld({ rec: { h: H, phaContract: 'saturnescrow' } });
    rb.base.addSwap(H, { token: USDC, deadline: T0 - 100, feeBps: 50, state: 1, sender: KB, claimer: S_B, amount: USDC_AMT }, rb.base.head - 200n, T0 - 1000);
    const r1 = await checks.refundBase(rb.deps, (await rb.store.getTrade(7))!);
    assert.equal(r1.ok, true, r1.ok ? '' : r1.problem.text);
    if (r1.ok) assert.equal((await rb.signer.refundBase(r1.intent)).outcome, 'confirmed');

    // The seller's refund on Phantasma.
    const s = await sellerAfterLocks();
    s.pha.locks.get(H)!.deadline = T0 - 61;
    s.base.swaps.get(`${H}|${B_B}`)!.state = 3;
    const r2 = await checks.refundPha(s.deps, (await s.store.getTrade(7))!);
    assert.equal(r2.ok, true, r2.ok ? '' : r2.problem.text);
    if (r2.ok) assert.equal((await s.signer.refundPha(r2.intent)).outcome, 'confirmed');

    // A deferred payout.
    const o = await sellerAfterLocks();
    o.base.owed.set(KB, USDC_AMT);
    const r3 = await checks.withdrawOwed(o.deps, (await o.store.getTrade(7))!);
    assert.equal(r3.ok, true, r3.ok ? '' : r3.problem.text);
    if (r3.ok) assert.equal((await o.signer.withdrawOwed(r3.intent)).outcome, 'confirmed');
  });
});

// ── A. Configuration and pins ───────────────────────────────────────────────

/** Whether this release pins mainnet (the owner fills the pins at launch); its refusals are checked on UNPINNED either way. */
const MAINNET_PINNED = phaPinned(P2P_CONFIG.mainnet) && baseDeployed(P2P_CONFIG.mainnet);
/** Mainnet's settings with the escrow and SaturnSwap pins emptied, as this release ships them. */
const UNPINNED = Object.freeze({ ...P2P_CONFIG.mainnet, phaCodeSha256: '', phaAdmin: '', base: Object.freeze({ ...P2P_CONFIG.mainnet.base, swap: '' }) });

describe('A. configuration and pins', () => {
  test('1: a symbol not exactly in the table', () => {
    isProblem(checks.checkToken('taz'), 'TOKEN_NOT_TRADED');
    isProblem(checks.checkToken('TAZ '), 'TOKEN_NOT_TRADED');
    assert.equal(checks.checkToken('TAZ'), null);
  });

  test('2: a network without both escrow pins (mainnet in this release)', async () => {
    if (MAINNET_PINNED) assert.equal(checks.pinned('mainnet'), null);
    else isProblem(checks.pinned('mainnet'), 'NOT_PINNED');
    assert.equal(checks.pinned('devnet'), null);
    const w = await world('S');
    isProblem(await checks.codePin(w.deps, UNPINNED), 'NOT_PINNED');
    isProblem(await checks.codePin(w.deps, { ...P2P_CONFIG.devnet, phaAdmin: '' }), 'NOT_PINNED');
    assert.equal(w.pha.reads, 0, 'an empty pin refuses without a read');
  });

  test('3: a script that is not the pinned one, or another admin', async () => {
    const w = await world('S');
    w.pha.script = ESCROW_SCRIPT.slice(0, -2) + (ESCROW_SCRIPT.endsWith('00') ? '01' : '00');
    refusedWith(await checks.sellerLock(w.deps, w.trade, w.rec), 'CODE_PIN');
    w.pha.script = ESCROW_SCRIPT;
    w.pha.admin = X_P;
    refusedWith(await checks.sellerLock(w.deps, w.trade, w.rec), 'CODE_PIN');
    w.pha.admin = CFG.phaAdmin;
    w.pha.fail.add('getContract');
    assert.equal(refusedWith(await checks.sellerLock(w.deps, w.trade, w.rec), 'CODE_PIN').retry, true, 'a failed read is retried later');
    assert.equal(w.sends(), 0);
  });

  test('4: hashSecret on the node disagrees with the vectors', async () => {
    const w = await buyerWorld();
    w.pha.vectorsWrong = true;
    refusedWith(await checks.buyerLock(w.deps, w.trade, w.rec), 'HASH_VECTORS');
    isProblem(await checks.hashVectors(w.deps), 'HASH_VECTORS');
    assert.equal(PHA_HASH_VECTORS.length, 4);
  });

  test('5: a lock under an escrow this release does not serve', async () => {
    const r = checks.escrowFor('devnet', 'saturnold');
    refusedWith(r, 'ESCROW_NOT_SERVED');
    assert.equal(checks.escrowFor('devnet', null).ok, true, 'a record without a name: the current escrow');
    // The record names another escrow: the claim never reads under the current one instead.
    const w = await world('S', { rec: { phaContract: 'saturnold', h: H } });
    await w.store.putSecret({ v: 1, secret: SECRET, h: H, tradeId: 7, network: 'devnet', symbol: 'TAZ', taz: TAZ.toString(), sPha: K.address.pha, bPha: B_P, role: 'S', createdAt: w.clock.ms });
    refusedWith(await checks.selfClaim(w.deps, w.rec), 'ESCROW_NOT_SERVED');
    assert.equal(w.pha.reads + w.base.reads, 0);
  });

  test('6: SaturnSwap or USDC not pinned for the network', () => {
    if (MAINNET_PINNED) assert.equal(checks.baseDeployedProblem('mainnet'), null);
    else isProblem(checks.baseDeployedProblem('mainnet'), 'BASE_NOT_DEPLOYED');
    assert.equal(checks.baseDeployedProblem('devnet'), null);
    assert.equal(baseDeployed(UNPINNED), false, 'an empty SaturnSwap pin is not deployed');
    assert.equal(baseDeployed({ base: { ...P2P_CONFIG.devnet.base, usdc: '' } }), false, 'nor an empty USDC pin');
  });
});

// ── B. Offers and takes ─────────────────────────────────────────────────────

describe('B. offers and takes', () => {
  test('7: an offer outside the table (smallest trade under the token\'s minimum)', () => {
    const ok = { symbol: 'TAZ', tazTotal: '30000000000', tazMin: '1000000000', tazMax: '5000000000', price: PRICE.toString() };
    assert.equal(checks.offerCheck('devnet', ok), null);
    isProblem(checks.offerCheck('devnet', { ...ok, tazMin: '500000000' }), 'OFFER_INVALID');
  });

  test('8: a Base address that is the swap contract, USDC, or not an address', () => {
    assert.equal(checks.baseAddressOk('devnet', B_B), null);
    isProblem(checks.baseAddressOk('devnet', CFG.base.swap), 'BASE_ADDRESS');
    isProblem(checks.baseAddressOk('devnet', CFG.base.usdc.toLowerCase()), 'BASE_ADDRESS');
    isProblem(checks.baseAddressOk('devnet', '0x' + 'g'.repeat(40)), 'BASE_ADDRESS');
  });

  test('10: a take below the offer\'s minimum', () => {
    const offer = { symbol: 'TAZ', tazMin: '2000000000', tazMax: '5000000000', remaining: '30000000000', price: PRICE.toString() };
    assert.equal(checks.takeCheck('devnet', '2000000000', offer), null);
    isProblem(checks.takeCheck('devnet', '1000000000', offer), 'TAKE_INVALID');
  });

  test('11: no open-cap room for the take (a failed read does not block)', async () => {
    isProblem(checks.openCapCheck({ openAmount: 10n ** 20n - TAZ + 1n, maxOpen: 10n ** 20n }, TAZ, 'TAZ'), 'OPEN_CAP');
    assert.equal(checks.openCapCheck(null, TAZ, 'TAZ'), null);
    const w = await world('S', { trade: { status: 'requested' }, rec: { status: 'requested' } });
    w.pha.caps.TAZ = { open: 10n ** 20n, max: 10n ** 20n };
    refusedWith(await checks.acceptChecks(w.deps, w.trade, w.rec), 'OPEN_CAP');
    w.pha.fail.add('getOpenAmount');
    assert.equal((await checks.acceptChecks(w.deps, w.trade, w.rec)).ok, true, 'an unread cap does not block an accept');
  });

  test('12: the buyer\'s USDC counts the kit\'s other trades still waiting for their USDC lock', async () => {
    const w = await buyerWorld();
    w.base.usdc.set(KB, 9_000_000n);
    assert.equal(await checks.buyerReady(w.deps, { bBase: KB, usdc: USDC_AMT, excludeTradeId: 7 }), null);
    // Another accepted take of this kit on the same Base address needs 5 USDC more.
    await w.store.addTrade({ ...w.rec, id: 8, usdc: '5000000', taz: '4629629629', status: 'accepted', takerToken: newControlToken(), counterPha: S_P });
    const p = isProblem(await checks.buyerReady(w.deps, { bBase: KB, usdc: USDC_AMT, excludeTradeId: 7 }), 'BUYER_NOT_READY');
    assert.match(p.text, /open trades need/);
    assert.equal(await checks.waitingUsdc(w.store, KB, 7, w.clock.ms), 5_000_000n);
  });

  test('13: a trade id the store keeps for another trade', async () => {
    const w = await world('S');
    refusedWith(await checks.keepTrade(w.store, { ...w.rec, taz: '6000000000', usdc: '6480000' }), 'TRADE_ID_REUSED');
    assert.equal((await checks.keepTrade(w.store, w.rec)).ok, true, 'the same trade again is the kept record');
  });

  test('14: the board\'s trade against the price the kit saw and sent (and a following offer\'s limit)', async () => {
    const w = await world('S');
    assert.equal(checks.tradeMismatch(w.trade, w.rec), null);
    // The board fixed the take at another price with matching USDC: not the price the kit agreed to.
    const repriced = { ...w.trade, price: '1100000', usdc: '5500000' };
    isProblem(checks.tradeMismatch(repriced, w.rec), 'TRADE_MISMATCH');
    // Only the price field differs: refused too.
    isProblem(checks.tradeMismatch({ ...w.trade, price: '1100000' }, w.rec), 'TRADE_MISMATCH');
    // A maker's record checked against its following offer: past the minimum price is refused.
    const offer: LocalOffer = {
      id: 3, network: 'devnet', side: 'sell', symbol: 'TAZ', makerPha: K.address.pha, makerBase: KB, tazTotal: '30000000000', tazMin: '1000000000', tazMax: '5000000000',
      price: '1000000', makerToken: newControlToken(), tokenSource: 'client', priceHistory: [], follow: { offsetBps: 200, limitPrice: '1100000', dailyMax: '30000000000' },
      acceptOnTheirOwn: true, mode: 'standard', createdAt: w.clock.ms, closedAt: null
    };
    const below = isProblem(checks.tradeMismatch(w.trade, w.rec, offer), 'TRADE_MISMATCH');
    // The site's own rule and words (rules.ts): the limit written as the site writes a price, "1.10 USDC".
    assert.match(below.text, /below your minimum price \(1\.10 USDC\)/);
    assert.equal(checks.tradeMismatch(w.trade, w.rec, { ...offer, follow: { offsetBps: 200, limitPrice: '1080000', dailyMax: '30000000000' } }), null);
    // Follow settings that do not read in full (no amount per day) count as a fixed offer, the stricter rule, as on the site.
    isProblem(checks.tradeMismatch(w.trade, w.rec, { ...offer, follow: { offsetBps: 200, limitPrice: '1080000' } }), 'TRADE_MISMATCH');
    assert.equal(checks.tradeMismatch(w.trade, w.rec, { ...offer, price: '1080000', follow: { offsetBps: 200, limitPrice: '1080000' } }), null);
  });

  test('15: a take that does not fit the offer exactly', async () => {
    const w = await world('S');
    const offer: LocalOffer = {
      id: 3, network: 'devnet', side: 'sell', symbol: 'TAZ', makerPha: K.address.pha, makerBase: KB, tazTotal: '30000000000', tazMin: '1000000000', tazMax: '4000000000',
      price: PRICE.toString(), makerToken: newControlToken(), tokenSource: 'client', priceHistory: [{ price: PRICE.toString(), at: 1 }], follow: null,
      acceptOnTheirOwn: true, mode: 'standard', createdAt: w.clock.ms, closedAt: null
    };
    refusedWith(checks.adoptTake(w.trade, offer), 'TAKE_NOT_FIT');
    const fits = checks.adoptTake(w.trade, { ...offer, tazMax: '5000000000' }, w.clock.ms);
    assert.equal(fits.ok, true);
    if (fits.ok) assert.deepEqual([fits.record.role, fits.record.maker, fits.record.counterBase, fits.record.price], ['S', true, B_B, PRICE.toString()]);
  });
});

// ── C. Accepting ─────────────────────────────────────────────────────────────

describe('C. accepting (signs nothing)', () => {
  test('17: a sell offer\'s buyer without the USDC; a buy offer\'s seller without the token', async () => {
    const w = await world('S', { trade: { status: 'requested' }, rec: { status: 'requested' } });
    assert.equal((await checks.acceptChecks(w.deps, w.trade, w.rec)).ok, true);
    w.base.usdc.set(B_B, USDC_AMT - 1n);
    refusedWith(await checks.acceptChecks(w.deps, w.trade, w.rec), 'ACCEPT_REFUSED');

    const b = await world('B', { trade: { side: 'buy', status: 'requested' }, rec: { maker: true, takerToken: undefined, status: 'requested' } });
    b.pha.bals.set(S_P, [{ symbol: 'TAZ', amount: (TAZ - 1n).toString(), decimals: 9 }]);
    refusedWith(await checks.acceptChecks(b.deps, b.trade, b.rec), 'ACCEPT_REFUSED');
    b.pha.bals.set(S_P, [{ symbol: 'TAZ', amount: TAZ.toString(), decimals: 9 }]);
    assert.equal((await checks.acceptChecks(b.deps, b.trade, b.rec)).ok, true);
  });
});

// ── D. The seller's Phantasma lock ──────────────────────────────────────────

describe('D. the seller\'s lock', () => {
  const one = async (mut: (w: World) => void | Promise<void>, code: string, o: Parameters<typeof world>[1] = {}) => {
    const w = await world('S', o);
    await mut(w);
    const p = refusedWith(await checks.sellerLock(w.deps, w.trade, w.rec), code);
    assert.equal(w.sends(), 0, `${code}: nothing sent`);
    return { w, p };
  };

  test('18: not accepted yet (or the kit is not the seller)', async () => {
    await one(() => {}, 'LOCK_START', { trade: { status: 'requested' } });
    const w = await buyerWorld();
    refusedWith(await checks.sellerLock(w.deps, w.trade, w.rec), 'LOCK_START');
  });

  test('19: the record names another escrow', async () => void await one(() => {}, 'ESCROW_CHANGED', { rec: { phaContract: 'saturnold' } }));
  test('20: the escrow is not deployed (no getState)', async () => void await one((w) => { w.pha.methods = w.pha.methods.filter((m) => m !== 'getState'); }, 'ESCROW_NOT_DEPLOYED'));
  test('21: the open cap cannot be read (a failed read refuses here)', async () => void await one((w) => { w.pha.fail.add('getOpenAmount'); }, 'OPEN_CAP_UNREAD'));
  test('22: the trade\'s fee is above 2%', async () => void await one(() => {}, 'FEE_UNSET', { trade: { feeBps: 250 } }));
  test('23: the escrow\'s bounds for the token are not the table\'s', async () => void await one((w) => { w.pha.bounds.TAZ = { min: 2_000_000_000n, max: w.pha.bounds.TAZ!.max }; }, 'ESCROW_PARAMS'));
  test('24: SaturnSwap\'s fee is above the trade\'s', async () => void await one((w) => { w.base.feeBps = 60; }, 'SELLER_BASE'));
  test('25: this clock is off from Base\'s newest block', async () => void await one((w) => { w.base.skew = 400; }, 'CLOCK_SKEW'));
  test('28: the signing key is not the seller\'s; less than 1.1 SOUL free', async () => {
    await one(() => {}, 'PHA_KEY', { address: { pha: X_P } });
    await one((w) => { w.pha.bals.set(K.address.pha, PHA_BALANCES().map((b) => (b.symbol === 'SOUL' ? { ...b, amount: '100000000' } : b))); }, 'SOUL_LOW');
  });
  test('29: the seller\'s liquid balance is short', async () => void await one((w) => { w.pha.bals.set(K.address.pha, PHA_BALANCES().map((b) => (b.symbol === 'TAZ' ? { ...b, amount: (TAZ - 1n).toString() } : b))); }, 'SELLER_FUNDS'));

  test('30: our own lock under the kept secret is only reported; someone else\'s gets a new secret', async () => {
    const w = await world('S');
    const sec = await w.store.putSecret(makeSecretRecord({ tradeId: 7, network: 'devnet', symbol: 'TAZ', taz: TAZ.toString(), sPha: K.address.pha, bPha: B_P, role: 'S' }, w.clock.ms));
    w.pha.locks.set(sec.h, { state: 1, sender: K.address.pha, recipient: B_P, symbol: 'TAZ', amount: TAZ, deadline: T0 + 2000, created: T0 - 400 });
    const p = refusedWith(await checks.sellerLock(w.deps, w.trade, w.rec), 'LOCKED_ALREADY');
    assert.equal(p.h, sec.h, 'the h to report');
    // Someone else's lock under that h: a new secret, kept beside the old one.
    w.pha.locks.set(sec.h, { state: 1, sender: X_P, recipient: X_P, symbol: 'TAZ', amount: 1n, deadline: T0 + 2000, created: T0 - 400 });
    const r = await checks.sellerLock(w.deps, w.trade, w.rec);
    assert.equal(r.ok, true, r.ok ? '' : r.problem.text);
    if (r.ok) assert.notEqual(r.intent.facts.h, sec.h);
    assert.equal((await w.store.secretsOfTrade(7)).length, 2, 'the old secret is kept');
    assert.equal(w.sends(), 0);
  });

  test('32: feeShown cannot be stored (the record fixed another one under its h)', async () => void await one(() => {}, 'FEE_SHOWN', { rec: { h: H, feeShown: 40 } }));

  test('31 R: the trade\'s fee changed between the checks and the signature: 0 sends', async () => {
    const w = await world('S');
    const r = await checks.sellerLock(w.deps, w.trade, w.rec);
    assert.ok(r.ok);
    if (!r.ok) return;
    w.board.trades.set(7, { ...w.trade, feeBps: 60 });
    await signRefused(w.signer.lockPha(r.intent), 'TRADE_CHANGED');
    assert.equal(w.sends(), 0);
  });

  test('33 R: the clock is read again for the deadline: 0 sends when it drifted', async () => {
    const w = await world('S');
    const r = await checks.sellerLock(w.deps, w.trade, w.rec);
    assert.ok(r.ok);
    if (!r.ok) return;
    w.base.skew = -400;
    await signRefused(w.signer.lockPha(r.intent), 'CLOCK_RECHECK');
    assert.equal(w.sends(), 0);
  });

  test('34: P2:used under someone else\'s lock makes a new secret; under ours it does not', async () => {
    const w = await world('S');
    const r = await checks.sellerLock(w.deps, w.trade, w.rec);
    assert.ok(r.ok);
    if (!r.ok) return;
    const h = r.intent.facts.h;
    w.pha.nextState = { state: 'Fault', reason: 'P2:used' };
    w.pha.onSend = () => { w.pha.locks.set(h, { state: 1, sender: X_P, recipient: X_P, symbol: 'TAZ', amount: 1n, deadline: T0 + 2000, created: T0 }); };
    const out = await w.signer.lockPha(r.intent);
    assert.equal(out.outcome, 'failed');
    assert.equal(out.secretReplaced, true);
    assert.equal((await w.store.secretsOfTrade(7)).length, 2);
    assert.equal((await w.store.getJournal(7)).intents[0]!.outcome, 'failed');

    const v = await world('S');
    const r2 = await checks.sellerLock(v.deps, v.trade, v.rec);
    assert.ok(r2.ok);
    if (!r2.ok) return;
    const h2 = r2.intent.facts.h;
    v.pha.nextState = { state: 'Fault', reason: 'P2:used' };
    v.pha.onSend = () => { v.pha.locks.set(h2, { state: 1, sender: K.address.pha, recipient: B_P, symbol: 'TAZ', amount: TAZ, deadline: T0 + 2400, created: T0 }); };
    const out2 = await v.signer.lockPha(r2.intent);
    assert.equal(out2.secretReplaced, undefined, 'our own lock: the secret stays');
    assert.equal((await v.store.secretsOfTrade(7)).length, 1);
  });

  test('27: a lock sent less than 5 minutes ago whose outcome is not known is never sent again blindly', async () => {
    const w = await world('S');
    await w.store.addIntent(7, { kind: 'phaLock' });
    w.clock.ms += 60_000;
    const p = refusedWith(await checks.sellerLock(w.deps, w.trade, w.rec), 'LOCK_BUSY');
    assert.equal(p.retry, true);
    w.clock.ms += checks.LOCK_RESEND_AFTER_MS;
    const r = await checks.sellerLock(w.deps, { ...w.trade, lockBy: T0 + 10_000 }, w.rec);
    assert.equal(r.ok, true, r.ok ? '' : r.problem.text);

    const b = await buyerWorld();
    await b.store.addIntent(7, { kind: 'baseLock', h: H, nonce: 0 });
    refusedWith(await checks.buyerLock(b.deps, b.trade, b.rec), 'LOCK_BUSY');
    assert.equal(w.sends() + b.sends(), 0);
  });

  test('30/27 R: a second intent of one trade never sends a second lock under its h (landed, or still in flight)', async () => {
    // The first lock landed: the second intent's re-check sees it under h and only reports it.
    const w = await world('S');
    const a = await checks.sellerLock(w.deps, w.trade, w.rec);
    const b = await checks.sellerLock(w.deps, w.trade, w.rec);
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;
    const h = a.intent.facts.h;
    assert.equal(b.intent.facts.h, h, 'both intents use the kept secret');
    w.pha.onSend = () => { w.pha.locks.set(h, { state: 1, sender: K.address.pha, recipient: B_P, symbol: 'TAZ', amount: TAZ, deadline: T0 + CFG.timing.phaLock, created: T0 }); };
    assert.equal((await w.signer.lockPha(a.intent)).outcome, 'confirmed');
    const e = await signRefused(w.signer.lockPha(b.intent), 'LOCKED_ALREADY');
    assert.equal((e as SignRefusal).h, h, 'the h to report');
    assert.equal(w.pha.sent.length, 1, 'one lock, not two');

    // The first lock is not seen in a block yet (its journal intent is open): the second intent waits for it.
    const v = await world('S');
    const c = await checks.sellerLock(v.deps, v.trade, v.rec);
    const d = await checks.sellerLock(v.deps, v.trade, v.rec);
    assert.ok(c.ok && d.ok);
    if (!c.ok || !d.ok) return;
    v.pha.transaction = async () => null;
    assert.equal((await v.signer.lockPha(c.intent)).outcome, 'pending');
    await signRefused(v.signer.lockPha(d.intent), 'LOCK_BUSY');
    assert.equal(v.pha.sent.length, 1);

    // Someone else's lock appeared under h after the checks: refused (retry: the next check makes a new secret), nothing sent.
    const u = await world('S');
    const f = await checks.sellerLock(u.deps, u.trade, u.rec);
    assert.ok(f.ok);
    if (!f.ok) return;
    u.pha.locks.set(f.intent.facts.h, { state: 1, sender: X_P, recipient: X_P, symbol: 'TAZ', amount: 1n, deadline: T0 + 2000, created: T0 });
    assert.equal((await signRefused(u.signer.lockPha(f.intent), 'SECRET_UNUSABLE') as SignRefusal).retry, true);
    assert.equal(u.sends(), 0);
  });

  test('27: one signing flow per trade, and none without the store\'s lock', async () => {
    const w = await world('S');
    const a = await checks.sellerLock(w.deps, w.trade, w.rec);
    const b = await checks.sellerLock(w.deps, w.trade, w.rec);
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;
    let release!: () => void;
    w.board.gate = new Promise<void>((r) => { release = r; });
    const first = w.signer.lockPha(a.intent);
    await new Promise((r) => setImmediate(r));
    await signRefused(w.signer.lockPha(b.intent), 'LOCK_BUSY');
    release();
    w.board.gate = null;
    assert.equal((await first).outcome, 'confirmed');
    assert.equal(w.pha.sent.length, 1, 'only the first flow sent');

    const v = await world('S');
    const c = await checks.sellerLock(v.deps, v.trade, v.rec);
    assert.ok(c.ok);
    if (!c.ok) return;
    await v.store.close();
    await signRefused(v.signer.lockPha(c.intent), 'STORE_CLOSED');
    assert.equal(v.sends(), 0);
  });
});

// ── E. The buyer's Base lock ────────────────────────────────────────────────

describe('E. the buyer\'s lock', () => {
  const one = async (mut: (w: World) => void | Promise<void>, code: string, o: Parameters<typeof world>[1] = {}, lockOpts: { usePermit?: boolean; lockWithLowKcal?: boolean } = {}) => {
    const w = await buyerWorld(o);
    await mut(w);
    const p = refusedWith(await checks.buyerLock(w.deps, w.trade, w.rec, lockOpts), code);
    assert.equal(w.sends(), 0, `${code}: nothing sent`);
    return { w, p };
  };

  test('36: the seller has not locked yet', async () => void await one(() => {}, 'BUYER_LOCK_START', { trade: { status: 'accepted', h: null } }));
  test('37: the board ties the trade to another escrow', async () => void await one(() => {}, 'ESCROW_MISMATCH', { trade: { phaContract: 'saturnold' } }));
  test('38: another local trade already uses this h', async () => void await one(async (w) => {
    await w.store.addTrade({ ...w.rec, id: 9, h: H, takerToken: newControlToken() });
  }, 'HASH_REUSED'));
  test('39: the trade\'s fee is not fixed', async () => void await one(() => {}, 'FEE_NOT_FIXED', { trade: { feeBps: null } }));
  test('40: the lock holds another token than the trade (exact symbol)', async () => void await one((w) => { w.pha.locks.get(H)!.symbol = 'RA'; }, 'SELLER_LOCK'));
  test('41: the signing key is not the buyer\'s', async () => void await one(() => {}, 'BASE_KEY', { address: { base: X_B } }));
  test('42: a USDC lock for (h, me) exists that the kit did not record', async () => void await one((w) => {
    w.base.addSwap(H, { token: USDC, deadline: T0 + 900, feeBps: 50, state: 1, sender: KB, claimer: S_B, amount: USDC_AMT }, w.base.head - 5n, T0 - 10);
  }, 'USDC_LOCK_EXISTS'));
  test('42: our own recorded lock is only reported', async () => {
    const { p } = await one((w) => {
      w.base.addSwap(H, { token: USDC, deadline: T0 + 900, feeBps: 50, state: 1, sender: KB, claimer: S_B, amount: USDC_AMT }, w.base.head - 5n, T0 - 10);
    }, 'USDC_LOCKED_ALREADY', { rec: { txs: { baseLock: '0x' + 'ab'.repeat(32) } } });
    assert.equal(p.txHash, '0x' + 'ab'.repeat(32));
  });
  test('43: SaturnSwap\'s fee is above the trade\'s', async () => void await one((w) => { w.base.feeBps = 60; }, 'SWAP_REFUSES'));
  test('44: T2 is outside the contract\'s lock bounds', async () => void await one((w) => { w.base.maxLock = 600; }, 'LOCK_LENGTH'));
  test('45: not enough USDC', async () => void await one((w) => { w.base.usdc.set(KB, USDC_AMT - 1n); }, 'BUYER_FUNDS'));
  test('46: the USDC permit domain is not the pinned one', async () => void await one((w) => { w.base.domain = '0x' + '11'.repeat(32); }, 'PERMIT'));
  test('47: less KCAL than one Phantasma claim, unless lockWithLowKcal', async () => {
    const { w } = await one((v) => { v.pha.bals.set(K.address.pha, PHA_BALANCES().filter((b) => b.symbol !== 'KCAL')); }, 'KCAL_LOW');
    assert.equal((await checks.buyerLock(w.deps, w.trade, w.rec, { lockWithLowKcal: true })).ok, true);
  });
  test('48: the lock details cannot be stored (the record fixed another T1)', async () => void await one(() => {}, 'LOCK_DETAILS', { rec: { t1: T0 + 1 } }));

  test('49: without a permit the approval is exactly the amount; an approval that never shows stops before the lock', async () => {
    const w = await buyerWorld();
    const r = await checks.buyerLock(w.deps, w.trade, w.rec, { usePermit: false });
    assert.ok(r.ok);
    if (!r.ok) return;
    w.base.applyApprove = false;
    await signRefused(w.signer.lockBase(r.intent), 'APPROVE');
    assert.equal(w.base.sent.length, 1, 'the approval only, no lock');
    const d = decodeFunctionData({ abi: USDC_ABI, data: parseTransaction(w.base.sent[0]!).data! });
    assert.equal(d.functionName, 'approve');
    assert.deepEqual([String((d.args as readonly unknown[])[0]).toLowerCase(), (d.args as readonly unknown[])[1]], [SWAP, USDC_AMT], 'exactly the amount, to SaturnSwap');

    const v = await buyerWorld();
    const r2 = await checks.buyerLock(v.deps, v.trade, v.rec, { usePermit: false });
    assert.ok(r2.ok);
    if (!r2.ok) return;
    const out = await v.signer.lockBase(r2.intent);
    assert.equal(out.outcome, 'confirmed');
    assert.ok(out.approveTx);
    assert.deepEqual(v.base.sent.map((x) => decodeFunctionData({ abi: [...USDC_ABI, ...SATURN_SWAP_ABI], data: parseTransaction(x).data! }).functionName), ['approve', 'lock']);
  });

  test('50 R: the trade ended between the checks and the signature: 0 sends', async () => {
    const w = await buyerWorld();
    const r = await checks.buyerLock(w.deps, w.trade, w.rec);
    assert.ok(r.ok);
    if (!r.ok) return;
    w.board.trades.set(7, { ...w.trade, status: 'expired' });
    await signRefused(w.signer.lockBase(r.intent), 'USDC_RECHECK');
    assert.equal(w.sends(), 0);
  });

  test('42/27 R: a second intent of one trade never sends a second USDC lock (landed, or still in flight)', async () => {
    // The first lock landed: the second intent's re-check sees the swap and only reports it.
    const w = await buyerWorld();
    const a = await checks.buyerLock(w.deps, w.trade, w.rec);
    const b = await checks.buyerLock(w.deps, w.trade, w.rec);
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;
    const send = w.base.sendRaw.bind(w.base);
    w.base.sendRaw = async (raw) => {
      const hash = await send(raw);
      w.base.addSwap(H, { token: USDC, deadline: a.intent.facts.t2, feeBps: 50, state: 1, sender: KB, claimer: S_B, amount: USDC_AMT }, w.base.head, T0);
      return hash;
    };
    const first = await w.signer.lockBase(a.intent);
    assert.equal(first.outcome, 'confirmed');
    const e = await signRefused(w.signer.lockBase(b.intent), 'USDC_LOCKED_ALREADY');
    assert.equal((e as SignRefusal).txHash, first.txHash, 'the lock to report');
    assert.equal(w.base.sent.length, 1, 'one USDC lock, not two');

    // The first lock is not mined yet (its journal intent is open): the second intent waits for it.
    const v = await buyerWorld();
    const c = await checks.buyerLock(v.deps, v.trade, v.rec);
    const d = await checks.buyerLock(v.deps, v.trade, v.rec);
    assert.ok(c.ok && d.ok);
    if (!c.ok || !d.ok) return;
    v.base.nextStatus = null;
    assert.equal((await v.signer.lockBase(c.intent)).outcome, 'pending');
    await signRefused(v.signer.lockBase(d.intent), 'LOCK_BUSY');
    assert.equal(v.base.sent.length, 1);
  });

  test('51 R: the exact signed call would revert, or its nonce was taken: 0 sends', async () => {
    const w = await buyerWorld();
    const r = await checks.buyerLock(w.deps, w.trade, w.rec);
    assert.ok(r.ok);
    if (!r.ok) return;
    w.base.failCall = (_c, n) => (n >= 2 ? new Error('execution reverted') : null);
    await signRefused(w.signer.lockBase(r.intent), 'NOT_SENDABLE');
    assert.equal(w.sends(), 0);
    assert.equal((await w.store.getJournal(7)).intents[0]!.outcome, 'not_sent');

    const v = await buyerWorld();
    const r2 = await checks.buyerLock(v.deps, v.trade, v.rec);
    assert.ok(r2.ok);
    if (!r2.ok) return;
    let reads = 0;
    const orig = v.base.nonce.bind(v.base);
    v.base.nonce = async (a, tag) => (tag === 'pending' && ++reads >= 2 ? (await orig(a, tag)) + 1 : orig(a, tag));
    await signRefused(v.signer.lockBase(r2.intent), 'NOT_SENDABLE');
    assert.equal(v.sends(), 0);
  });
});

// ── F. Reveal ───────────────────────────────────────────────────────────────

describe('F. reveal (claimMode reveal-then-self)', () => {
  const one = async (mut: (w: World) => void | Promise<void>, code: string, o: Parameters<typeof sellerAfterLocks>[0] = {}) => {
    const w = await sellerAfterLocks(o);
    await mut(w);
    const p = refusedWith(await checks.reveal(w.deps, w.trade, (await w.store.getTrade(7))!), code);
    assert.equal(w.sends(), 0);
    return p;
  };

  test('52: the trade is not at the reveal step', async () => void await one(() => {}, 'REVEAL_START', { trade: { status: 'accepted' } }));
  test('53: the kept secret was made for another buyer', async () => void await one(async (w) => {
    await w.store.pruneSecret(H);
    await w.store.putSecret({ v: 1, secret: SECRET, h: H, tradeId: 7, network: 'devnet', symbol: 'TAZ', taz: TAZ.toString(), sPha: K.address.pha, bPha: X_P, role: 'S', createdAt: w.clock.ms });
  }, 'SECRET_BINDING'));
  test('54: no feeShown stored', async () => {
    const w = await world('S', { trade: { h: H, phaContract: 'saturnescrow', status: 'base_locked' } });
    await w.store.putSecret({ v: 1, secret: SECRET, h: H, tradeId: 7, network: 'devnet', symbol: 'TAZ', taz: TAZ.toString(), sPha: K.address.pha, bPha: B_P, role: 'S', createdAt: w.clock.ms });
    refusedWith(await checks.reveal(w.deps, w.trade, w.rec), 'FEE_SHOWN_MISSING');
  });
  test('55: the buyer\'s lock charges more than feeShown', async () => void await one(() => {}, 'BUYER_LOCK', { swap: { feeBps: 60 } }));
  test('55: the buyer\'s lock was mined after the Base lock window', async () => void await one(() => {}, 'BUYER_LOCK', { minedAt: T0 - 300 + CFG.timing.baseLockWindow + 1 }));
  test('56: USDC blacklists the seller (read where the token has a blacklist)', async () => {
    const w = await sellerAfterLocks();
    w.base.read = async (c: ReadCall) => (c.functionName === 'isBlacklisted' ? true : FakeBase.prototype.read.call(w.base, c));
    isProblem(await checks.usdcGuardProblem(w.deps, KB), 'USDC_GUARD');
    // Devnet's MockUSDC has none, so its reveal never reads one.
    assert.equal(CFG.base.usdcHasBlacklist, false);
    assert.equal(P2P_CONFIG.mainnet.base.usdcHasBlacklist, true);
  });
  test('57: the claim readiness fails (SHA-256 vectors)', async () => void await one((w) => { w.pha.vectorsWrong = true; }, 'CLAIM_READINESS'));

  test('5: the reveal reads the lock under the record\'s escrow, never under a name the board gives', async () => {
    // A record without an escrow name (the board names one this release does not serve): the current escrow, where the kit's lock is.
    const w = await world('S', { trade: { h: H, phaContract: 'saturnold', status: 'base_locked' } });
    await w.store.putSecret({ v: 1, secret: SECRET, h: H, tradeId: 7, network: 'devnet', symbol: 'TAZ', taz: TAZ.toString(), sPha: K.address.pha, bPha: B_P, role: 'S', createdAt: w.clock.ms });
    await w.store.patchTrade(7, { feeShown: 50, h: H, t1: T0 - 300 + CFG.timing.phaLock });
    w.pha.locks.set(H, { state: 1, sender: K.address.pha, recipient: B_P, symbol: 'TAZ', amount: TAZ, deadline: T0 - 300 + CFG.timing.phaLock, created: T0 - 300 });
    w.base.addSwap(H, { token: USDC, deadline: T0 + 900, feeBps: 50, state: 1, sender: B_B, claimer: KB, amount: USDC_AMT }, w.base.head - 20n, T0 - 240);
    const r = await checks.reveal(w.deps, w.trade, (await w.store.getTrade(7))!);
    assert.equal(r.ok, true, r.ok ? '' : r.problem.text);
    if (r.ok) assert.equal(r.intent.facts.escrow, 'saturnescrow');
  });

  test('58: secretSentAt cannot be stored: nothing is posted', async () => {
    const w = await sellerAfterLocks();
    const r = await checks.reveal(w.deps, w.trade, (await w.store.getTrade(7))!);
    assert.ok(r.ok);
    if (!r.ok) return;
    const orig = w.store.patchTrade.bind(w.store);
    w.store.patchTrade = async (id, p) => { if (p.secretSentAt !== undefined) throw new Error('disk full'); return orig(id, p); };
    let posted = false;
    await signRefused(w.signer.reveal(r.intent, async () => { posted = true; }), 'SECRET_SENT');
    assert.equal(posted, false);
  });
});

// ── G. The kit's own USDC claim ─────────────────────────────────────────────

describe('G. the self-claim', () => {
  test('59: too close to T2 to claim safely', async () => {
    const w = await sellerAfterLocks({ swap: { deadline: T0 + 100 } });
    refusedWith(await checks.selfClaim(w.deps, (await w.store.getTrade(7))!), 'SELF_CLAIM');
  });

  test('59a: a secret file whose tradeId, sPha, taz or symbol differs is refused before any read or simulation', async () => {
    for (const bad of [{ tradeId: 8 }, { sPha: X_P }, { taz: '6000000000' }, { symbol: 'RA' }]) {
      const w = await sellerAfterLocks();
      await w.store.pruneSecret(H);
      await w.store.putSecret({ v: 1, secret: SECRET, h: H, tradeId: 7, network: 'devnet', symbol: 'TAZ', taz: TAZ.toString(), sPha: K.address.pha, bPha: B_P, role: 'S', createdAt: w.clock.ms, ...bad });
      const reads = [w.pha.reads, w.base.reads, w.base.calls];
      refusedWith(await checks.selfClaim(w.deps, (await w.store.getTrade(7))!), 'SECRET_NOT_THIS_TRADE', '59a');
      assert.deepEqual([w.pha.reads, w.base.reads, w.base.calls], reads, `${JSON.stringify(bad)}: no read, no simulation`);
    }
  });

  test('60: a first claim (the secret never left) runs the reveal\'s checks', async () => {
    const w = await sellerAfterLocks({ swap: { feeBps: 60 } });
    refusedWith(await checks.selfClaim(w.deps, (await w.store.getTrade(7))!), 'FIRST_CLAIM');
    // Once the secret was shared, the claim is the seller's protection: the same fee no longer stops it.
    await w.store.patchTrade(7, { secretSentAt: w.clock.ms });
    assert.equal((await checks.selfClaim(w.deps, (await w.store.getTrade(7))!)).ok, true);
    // A record kept before the kit stored secretSentAt for its own claims: a claim it sent counts as the secret out.
    const v = await sellerAfterLocks({ swap: { feeBps: 60 } });
    await v.store.patchTrade(7, { txs: { claimBase: '0x' + 'ab'.repeat(32) } });
    assert.equal((await checks.selfClaim(v.deps, (await v.store.getTrade(7))!)).ok, true);
  });

  test('58/61: the kit\'s own claim keeps secretSentAt before its simulation; while it is not settled a fresh claim is refused by the checks and by the signer (CLAIM_IN_FLIGHT)', async () => {
    const w = await sellerAfterLocks();
    const a = await checks.selfClaim(w.deps, (await w.store.getTrade(7))!);
    const b = await checks.selfClaim(w.deps, (await w.store.getTrade(7))!);
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;
    let sentAtSimulation: number | undefined;
    const call = w.base.call.bind(w.base);
    w.base.call = async (c) => { sentAtSimulation ??= (await w.store.getTrade(7))!.secretSentAt; return call(c); };
    w.base.nextStatus = null; // sent, not mined
    const out = await w.signer.claimBase(a.intent);
    assert.equal(out.outcome, 'pending');
    assert.ok(sentAtSimulation, 'secretSentAt was kept before the simulation carried the secret');
    const open = (await w.store.getJournal(7)).intents[0]!;
    assert.deepEqual(open.hashes, [out.txHash]);
    assert.ok(open.maxFee && open.maxPrio && open.lastSentAt, 'its fees are kept for a replacement to outbid');
    // An intent issued before the claim went out is refused by the signer itself: it would wait behind nonce 0.
    await signRefused(w.signer.claimBase(b.intent), 'CLAIM_IN_FLIGHT');
    refusedWith(await checks.selfClaim(w.deps, (await w.store.getTrade(7))!), 'CLAIM_IN_FLIGHT');
    assert.equal(w.base.sent.length, 1);
  });

  test('61 R: a smart-contract account, a changed deadline, a claim already in flight: 0 sends', async () => {
    const w = await sellerAfterLocks();
    const r = await checks.selfClaim(w.deps, (await w.store.getTrade(7))!);
    assert.ok(r.ok);
    if (!r.ok) return;
    w.base.codes.set(KB, '0x6080604052');
    await signRefused(w.signer.claimBase(r.intent), 'CONTRACT_ACCOUNT');
    assert.equal(w.sends(), 0);

    const v = await sellerAfterLocks();
    const r2 = await checks.selfClaim(v.deps, (await v.store.getTrade(7))!);
    assert.ok(r2.ok);
    if (!r2.ok) return;
    v.base.swaps.get(`${H}|${B_B}`)!.deadline = T0 + 120;
    await signRefused(v.signer.claimBase(r2.intent), 'CLAIM_RECHECK');
    assert.equal(v.sends(), 0);
    assert.equal(v.base.calls, 0, 'refused before the simulation (which carries the secret)');

    const u = await sellerAfterLocks();
    const a = await checks.selfClaim(u.deps, (await u.store.getTrade(7))!);
    const b = await checks.selfClaim(u.deps, (await u.store.getTrade(7))!);
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const code = u.base.code.bind(u.base);
    u.base.code = async (x) => { await gate; return code(x); };
    const first = u.signer.claimBase(a.intent);
    await signRefused(u.signer.claimBase(b.intent), 'CLAIM_IN_FLIGHT');
    release();
    assert.equal((await first).outcome, 'confirmed');
    assert.equal(u.base.sent.length, 1);
  });
});

// ── H. The other side's claim, refunds, withdraw ────────────────────────────

describe('H. claims for the buyer, refunds, withdraw', () => {
  test('62: the secret is not public on Base (at the confirmed block)', async () => {
    const w = await buyerWorld({ rec: { h: H, phaContract: 'saturnescrow' } });
    const p = refusedWith(await checks.claimPhaFor(w.deps, (await w.store.getTrade(7))!), 'CLAIM_PHA');
    assert.equal(p.retry, true);
  });

  test('63: the buyer\'s USDC lock has not ended', async () => {
    const w = await buyerWorld({ rec: { h: H, phaContract: 'saturnescrow' } });
    w.base.addSwap(H, { token: USDC, deadline: T0 + 10, feeBps: 50, state: 1, sender: KB, claimer: S_B, amount: USDC_AMT }, w.base.head - 200n, T0 - 1000);
    refusedWith(await checks.refundBase(w.deps, (await w.store.getTrade(7))!), 'REFUND_BASE');
  });

  test('64: never once the buyer\'s swap reads claimed', async () => {
    const w = await sellerAfterLocks();
    w.pha.locks.get(H)!.deadline = T0 - 61;
    w.base.swaps.get(`${H}|${B_B}`)!.state = 2;
    refusedWith(await checks.refundPha(w.deps, (await w.store.getTrade(7))!), 'REFUND_PHA');
    // An unknown buyer: any Claimed event with this h refuses.
    const v = await sellerAfterLocks({ rec: { counterBase: undefined } });
    v.pha.locks.get(H)!.deadline = T0 - 61;
    v.base.events.push({ address: SWAP, blockNumber: v.base.head - 2n, eventName: 'Claimed', args: { h: H, sender: X_B, preimage: SECRET } });
    refusedWith(await checks.refundPha(v.deps, (await v.store.getTrade(7))!), 'REFUND_PHA');
    v.base.events.pop();
    assert.equal((await checks.refundPha(v.deps, (await v.store.getTrade(7))!)).ok, true, 'no claim with this h: the refund may go');
  });

  test('65: nothing owed to this address', async () => {
    const w = await sellerAfterLocks();
    refusedWith(await checks.withdrawOwed(w.deps, (await w.store.getTrade(7))!), 'NOTHING_OWED');
  });

  test('losing the race to the keeper after the send counts as done (read from the chain, never from the error)', async () => {
    const w = await sellerAfterLocks();
    w.pha.locks.get(H)!.deadline = T0 - 61;
    const r = await checks.refundPha(w.deps, (await w.store.getTrade(7))!);
    assert.ok(r.ok);
    if (!r.ok) return;
    w.pha.nextState = { state: 'Fault', reason: 'P2:state' };
    w.pha.onSend = () => { w.pha.locks.get(H)!.state = 3; };
    assert.equal((await w.signer.refundPha(r.intent)).outcome, 'done_elsewhere');
    // The same error while the lock is still open is a failure.
    const v = await sellerAfterLocks();
    v.pha.locks.get(H)!.deadline = T0 - 61;
    const r2 = await checks.refundPha(v.deps, (await v.store.getTrade(7))!);
    assert.ok(r2.ok);
    if (!r2.ok) return;
    v.pha.nextState = { state: 'Fault', reason: 'P2:state' };
    assert.equal((await v.signer.refundPha(r2.intent)).outcome, 'failed');
  });

  test('a step the keeper already did is DONE_ELSEWHERE, never a send', async () => {
    const w = await sellerAfterLocks();
    w.pha.locks.get(H)!.deadline = T0 - 61;
    w.pha.locks.get(H)!.state = 3;
    const r = await checks.refundPha(w.deps, (await w.store.getTrade(7))!);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.problem.code, checks.DONE_ELSEWHERE);
    // Done between the checks and the signature: a result, not an error, and no send.
    const v = await sellerAfterLocks();
    v.pha.locks.get(H)!.deadline = T0 - 61;
    const r2 = await checks.refundPha(v.deps, (await v.store.getTrade(7))!);
    assert.ok(r2.ok);
    if (!r2.ok) return;
    v.pha.locks.get(H)!.state = 3;
    assert.equal((await v.signer.refundPha(r2.intent)).outcome, 'done_elsewhere');
    assert.equal(v.sends(), 0);
  });
});

// ── I. Every Base write and every Phantasma send ────────────────────────────

describe('I. every write', () => {
  test('66: a write whose simulation reverts, fees above the caps, or too little ETH: 0 sends', async () => {
    const mk = async () => {
      const w = await buyerWorld({ rec: { h: H, phaContract: 'saturnescrow' } });
      w.base.addSwap(H, { token: USDC, deadline: T0 - 100, feeBps: 50, state: 1, sender: KB, claimer: S_B, amount: USDC_AMT }, w.base.head - 200n, T0 - 1000);
      const r = await checks.refundBase(w.deps, (await w.store.getTrade(7))!);
      assert.ok(r.ok);
      return { w, intent: r.ok ? r.intent : null! };
    };
    const a = await mk();
    a.w.base.failCall = () => new Error('execution reverted');
    await signRefused(a.w.signer.refundBase(a.intent), 'SIMULATION');
    const b = await mk();
    b.w.base.tip = CFG.base.feeCaps.maxPriorityFeePerGas + 1n;
    await signRefused(b.w.signer.refundBase(b.intent), 'FEE_CAPS');
    const c = await mk();
    c.w.base.eth.set(KB, 1n);
    await signRefused(c.w.signer.refundBase(c.intent), 'NO_ETH');
    assert.equal(a.w.sends() + b.w.sends() + c.w.sends(), 0);
  });

  test('51/66: a broadcast whose answer is lost stays open (never "not sent"); one the node refused is not_sent', async () => {
    const mk = async () => {
      const w = await buyerWorld({ rec: { h: H, phaContract: 'saturnescrow' } });
      w.base.addSwap(H, { token: USDC, deadline: T0 - 100, feeBps: 50, state: 1, sender: KB, claimer: S_B, amount: USDC_AMT }, w.base.head - 200n, T0 - 1000);
      const r = await checks.refundBase(w.deps, (await w.store.getTrade(7))!);
      assert.ok(r.ok);
      return { w, intent: r.ok ? r.intent : null! };
    };
    // No answer, and the node does not know the hash yet: it may still be mined.
    const a = await mk();
    a.w.base.sendRaw = async (raw) => { a.w.base.sent.push(raw); throw Object.assign(new Error('The request took too long to respond.'), { name: 'TimeoutError' }); };
    const out = await a.w.signer.refundBase(a.intent);
    assert.equal(out.outcome, 'pending');
    const ja = (await a.w.store.getJournal(7)).intents[0]!;
    assert.equal(ja.outcome, undefined, 'left open for run() to resolve from the chain');
    assert.equal(ja.txHash, out.txHash, 'its hash is kept');
    // The node refused it (a JSON-RPC error answer): surely not sent.
    const b = await mk();
    const rpc = Object.assign(new Error('nonce too low'), { name: 'RpcRequestError', code: -32000 });
    b.w.base.sendRaw = async () => { throw Object.assign(new Error('Missing or invalid parameters.'), { name: 'InvalidInputRpcError', code: -32000, cause: rpc }); };
    await signRefused(b.w.signer.refundBase(b.intent), 'NOT_SENDABLE');
    assert.equal((await b.w.store.getJournal(7)).intents[0]!.outcome, 'not_sent');

    const err = (name: string, o: Record<string, unknown> = {}) => Object.assign(new Error(name), { name, ...o });
    assert.equal(sendRefused(err('TimeoutError')), false);
    assert.equal(sendRefused(err('HttpRequestError', { status: 502 })), false, 'a gateway error may have passed it on');
    assert.equal(sendRefused(err('HttpRequestError', { status: 429 })), true);
    assert.equal(sendRefused(err('InternalRpcError', { code: -32603, cause: err('RpcRequestError', { code: -32603 }) })), false);
    assert.equal(sendRefused(new Error('socket hang up')), false);
    // "already known": the node holds this very transaction, so it went out (the intent stays open).
    assert.equal(sendRefused(err('InvalidInputRpcError', { code: -32000, cause: err('RpcRequestError', { code: -32000, details: 'already known' }) })), false);
    const c = await mk();
    c.w.base.sendRaw = async (raw) => { c.w.base.sent.push(raw); throw err('InvalidInputRpcError', { code: -32000, cause: err('RpcRequestError', { code: -32000, details: 'already known' }) }); };
    assert.equal((await c.w.signer.refundBase(c.intent)).outcome, 'pending');
    assert.equal((await c.w.store.getJournal(7)).intents[0]!.outcome, undefined);
  });

  test('51: a nonce above the node\'s count is never broadcast (it would wait behind a gap)', async () => {
    const w = await buyerWorld();
    const p = { chainId: CFG.base.chainId, from: KB as Hex, nonce: 3, gas: 100_000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n, to: SWAP as Hex, data: '0x' as Hex, need: 0n };
    w.base.nonces.set(KB, 3);
    assert.equal(await notSendable(w.base, p), null);
    w.base.nonces.set(KB, 2);
    assert.match((await notSendable(w.base, p)) ?? '', /earlier transaction/);
    w.base.nonces.set(KB, 4);
    assert.match((await notSendable(w.base, p)) ?? '', /took its nonce/);
  });

  test('51/61: a replacement goes at the nonce its own transaction holds while that nonce is not used, and outbids it by 25% under the fee caps', async () => {
    const w = await buyerWorld();
    const p = { chainId: CFG.base.chainId, from: KB as Hex, nonce: 3, gas: 200_000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n, to: SWAP as Hex, data: '0x' as Hex, need: 0n };
    // The node counts the waiting transaction in its pending count: a fresh send there is refused, a replacement is not.
    w.base.nonces.set(KB, 3);
    w.base.pendingExtra = 1;
    assert.match((await notSendable(w.base, p)) ?? '', /took its nonce/);
    assert.equal(await notSendable(w.base, p, { replacing: true }), null);
    // Waiting behind an earlier transaction, as the one it replaces does: still sendable (a cancel there takes its place).
    w.base.nonces.set(KB, 2);
    assert.equal(await notSendable(w.base, p, { replacing: true }), null);
    // Its nonce was used: nothing to replace.
    w.base.nonces.set(KB, 4);
    assert.match((await notSendable(w.base, p, { replacing: true })) ?? '', /no longer waiting/);
    w.base.pendingExtra = 0;
    // Fees: today's, and at least 25% above the transaction replaced, for the tip and the max fee.
    const fresh = await feesFor(w.base, CFG, 200_000n);
    const up = await replacementFees(w.base, CFG, 200_000n, { maxFeePerGas: fresh.maxFeePerGas * 4n, maxPriorityFeePerGas: fresh.maxPriorityFeePerGas * 4n });
    assert.equal(up.maxFeePerGas, bumpFee(fresh.maxFeePerGas * 4n));
    assert.equal(up.maxPriorityFeePerGas, bumpFee(fresh.maxPriorityFeePerGas * 4n));
    assert.ok(up.maxFeePerGas * 100n >= fresh.maxFeePerGas * 4n * 125n);
    const low = await replacementFees(w.base, CFG, 200_000n, { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
    assert.deepEqual(low, fresh, 'today\'s fees when they are higher');
    // Above the pinned caps: refused, nothing signed.
    await assert.rejects(replacementFees(w.base, CFG, 200_000n, { maxFeePerGas: CFG.base.feeCaps.maxFeePerGas, maxPriorityFeePerGas: 1n }), (e: unknown) => e instanceof SafetyError && e.code === 'FEE_CAPS');
    await assert.rejects(replacementFees(w.base, CFG, 200_000n, { maxFeePerGas: 1n, maxPriorityFeePerGas: CFG.base.feeCaps.maxPriorityFeePerGas }), (e: unknown) => e instanceof SafetyError && e.code === 'FEE_CAPS');
  });

  test('68: a key that is a known admin, owner or keeper is never loaded', async () => {
    assert.match(knownRoleProblem({ pha: CFG.phaAdmin }) ?? '', /escrow admin/);
    const d = await tempDir();
    const phaFile = join(d, 'p.json'), baseFile = join(d, 'b.json');
    await writeFile(phaFile, JSON.stringify({ wif: PhantasmaKeys.generate().toWIF() }), { mode: 0o600 });
    await writeFile(baseFile, JSON.stringify({ privateKey: generatePrivateKey() }), { mode: 0o600 });
    const k = await loadKeys({ network: 'devnet', phaKeyFile: phaFile, baseKeyFile: baseFile, argv: [] });
    await signRefused(loadKeys({ network: 'devnet', phaKeyFile: phaFile, baseKeyFile: baseFile, argv: [], forbid: { base: [k.address.base] } }), 'KEY_ROLE');
  });

  test('every refusal code names its check, and codes are unique to their check', () => {
    const byCheck = new Map<string, Set<string>>();
    for (const [code, check] of Object.entries(CHECK_CODES)) {
      const k = String(check);
      if (!byCheck.has(k)) byCheck.set(k, new Set());
      byCheck.get(k)!.add(code);
    }
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24, 25, 27, 28, 29, 30, 31, 32, 33, 34, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, '59a', 60, 61, 62, 63, 64, 65, 66, 68]) {
      assert.ok(byCheck.get(String(n))?.size, `check ${n} has a code`);
    }
    for (const n of [9, 16, 26, 35, 67]) assert.equal(byCheck.has(String(n)), false, `check ${n} is not checks.ts's`);
  });
});

describe('mainnet while its pins are empty (this release)', () => {
  test('no signer on mainnet, and its checks refuse before any read', { skip: MAINNET_PINNED ? 'this release pins mainnet: an unpinned network\'s refusal is checked on UNPINNED in A.2 and A.6' : false }, async () => {
    const d = await tempDir();
    const phaFile = join(d, 'p.json'), baseFile = join(d, 'b.json');
    await writeFile(phaFile, JSON.stringify({ wif: PhantasmaKeys.generate().toWIF() }), { mode: 0o600 });
    await writeFile(baseFile, JSON.stringify({ privateKey: generatePrivateKey() }), { mode: 0o600 });
    const mk = await loadKeys({ network: 'mainnet', phaKeyFile: phaFile, baseKeyFile: baseFile, argv: [] });
    const store = await openStore({ dataDir: d, network: 'mainnet', keyFile: null });
    stores.push(store);
    const pha = new FakePha(), base = new FakeBase(Date.now);
    await signRefused(Promise.resolve().then(() => createSigner({ keys: mk, pha, base, store })), 'NETWORK_OFF');
    const deps: CheckDeps = { network: 'mainnet', pha: new PhaReader(pha, 'mainnet'), base: new BaseReader(base, 'mainnet'), store, board: new FakeBoard(), address: mk.address, now: () => T0 * 1000 };
    const rec: LocalTrade = { id: 1, network: 'mainnet', offerId: 1, role: 'S', maker: true, symbol: 'TAZ', taz: TAZ.toString(), usdc: USDC_AMT.toString(), price: PRICE.toString(), myPha: mk.address.pha, myBase: mk.address.base.toLowerCase(), counterPha: B_P, counterBase: B_B, txs: {}, createdAt: 1, updatedAt: 1 };
    await store.addTrade(rec);
    const t = { ...tradeOf({ seller: { pha: mk.address.pha, base: mk.address.base } }), id: 1, network: 'mainnet' as const, offerId: 1 };
    const r = await checks.sellerLock(deps, t, rec);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(['BASE_NOT_DEPLOYED', 'NOT_PINNED'].includes(r.problem.code), r.problem.code);
    assert.equal(pha.reads + base.reads + pha.sent.length + base.sent.length, 0);
  });
});
