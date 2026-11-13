/**
 * Instant mode, the seller's side (build spec sections 3.10.2 to 3.10.5,
 * 6.8 `instant.test.ts` and 8.1 "Instant kit"; C6): on the bot's own
 * instant sell offer the buyer locks the USDC first, the bot locks its
 * tokens only after checking that lock, and claims the USDC only once the
 * buyer's claim on Phantasma has made its code public.
 *
 *   - every check of step 2 refuses with zero sends: the swap (h, B_b)
 *     (state, token, amount, claimer, fee), now - t_B <= I_WIN - I_WIN_LEAD
 *     (a devnet lock read 60 s after t_B goes ahead, one read at 200 s is
 *     refused), T_B - now >= I_PHA + I_SAFETY, getState(h) == 0, S_b not
 *     blacklisted, the code pin, the cap, the balance and its reserves;
 *   - the lock ends at T_P = now + I_PHA and is then reported (/pha-locked);
 *     from there getState(h) is read at least every 15 s until the bot has
 *     claimed or T_P has passed; the USDC claim goes out once Phantasma reads
 *     claimed (2), simulated first, while T_B - now >= 60 s, and a claim on
 *     Phantasma at T_P - 1 s still leads to it; a refund after T_P;
 *   - an instant postOffer without an API key (or with a key the owner did
 *     not flag) is refused before anything is sent;
 *   - run() steps instant trades apart from the bot's other trades: while
 *     those hold the trade loop 180 s per step, the instant lock still starts
 *     within seconds of t_B and getState(h) is still read every <= 15 s; a
 *     board that does not answer holds a watch step at most 3 s (5 s for
 *     the lock report); two takes counted at once never share the tokens;
 *   - take() refuses an instant offer: the kit takes standard offers only.
 *
 * The fakes: a Phantasma node that serves the real devnet escrow script
 * (public bytecode) and applies the escrow calls the kit signs; a Base node
 * with SaturnSwap and USDC that applies the kit's transactions, with blocks
 * every 2 s and confirmations; a board that follows the instant routes of
 * build spec section 2.5.1. The test drives the buyer and the keeper.
 * Time is virtual. Keys are made on the spot, never funded and never
 * printed; no transaction leaves this process: every send is counted.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { PhantasmaKeys, Transaction } from 'phantasma-sdk-ts';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { decodeFunctionData, keccak256, parseTransaction, recoverTransactionAddress, type AbiEvent } from 'viem';
import { createKit, SafetyError, type Kit, type KitOptions, type StepResult, type Policy } from '../src/index.js';
import { hexToDecimal, decimalToHex, sha256Hex, hashOfSecret, newSecret } from '../src/codec.js';
import { P2P_CONFIG, P2P_TOKENS, BOARD, INSTANT, INSTANT_RULES, instantBaseSpan } from '../src/pins.js';
import { SATURN_SWAP_ABI, USDC_ABI, pinnedDomainSeparator, BaseReader, type BaseClient, type BaseBlock, type BaseLog, type BaseReceipt, type ReadCall, type TxCall, type Hex } from '../src/base.js';
import { PhaReader, type PhaRpc, type PhaCall, type PhaBalance, type PhaTxState } from '../src/pha.js';
import * as checks from '../src/checks.js';
import { CHECK_CODES, type CheckDeps, type Problem } from '../src/checks.js';
import { createSigner, SignRefusal, type Signer } from '../src/signer.js';
import { loadKeys } from '../src/keys.js';
import { echoProblem } from '../src/flows/maker.js';
import type { Offer, Trade, LocalOffer, NewOffer } from '../src/types.js';

// ── The devnet escrow as the node serves it (public bytecode) ────────────────

const ESCROW_SCRIPT_DEFLATED = [
  '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'
].join('');
const ESCROW_SCRIPT = inflateSync(Buffer.from(ESCROW_SCRIPT_DEFLATED, 'base64')).toString('hex');
const ESCROW_METHODS = ['Initialize', 'getContractVersion', 'lock', 'claim', 'refund', 'hashSecret', 'getLockCount', 'getOpen', 'getHashAt', 'getId', 'getState',
  'getSender', 'getRecipient', 'getSymbol', 'getAmount', 'getDeadline', 'getCreated', 'getSecret', 'getAdmin', 'getPaused', 'getMinLock', 'getMaxLock',
  'getMinAmount', 'getMaxAmount', 'getLockedTotal', 'getClaimedTotal', 'getNow', 'setPaused', 'setToken', 'setLockBounds', 'setAdmin', 'getOpenAmount',
  'getMaxOpen', 'setOpenCap', 'onUpgrade', 'onKill'];
const CFG = P2P_CONFIG.devnet;
const ITM = INSTANT.devnet;
const T0 = 1_790_000_000;
const SWAP = CFG.base.swap.toLowerCase();
const USDC = CFG.base.usdc.toLowerCase();
const ZERO = '0x' + '0'.repeat(40);
/** The buyer, which the test drives (it is not a kit). */
const B_P = 'P2K' + 'B'.repeat(44);
const B_B = '0x' + 'b7'.repeat(20);
/** Someone else on Phantasma (a hash squatter). */
const X_P = 'P2K' + 'X'.repeat(44);
const API_KEY = 'sat_instant_test_key_000001';
const TAZ2 = 2_000_000_000n;          // 2 TAZ
const PRICE = 1_080_000n;             // 1.08 USDC per TAZ
const USDC2 = 2_160_000n;             // 2.16 USDC
const SELL = { side: 'sell' as const, symbol: 'TAZ', total: '30', min: '1', max: '5', price: '1.08' };
const POLICY: Policy = { acceptAfterS: 0 };
const sha = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest();
const nowSecOf = (ms: number) => Math.floor(ms / 1000);
/** Real wait for the kit's own I/O (the store fsyncs) to settle. */
const settle = (ms = 8) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Count the store's calls in flight and return a wait for none (run() tests): every step of the kit's reads and
 * writes its store between two of its waits, and the fakes answer at once, so a store with nothing in flight across
 * two turns of the event loop means every loop of the kit waits on the virtual clock. The clock then moves.
 */
function settledWith(store: object): () => Promise<void> {
  let inFlight = 0;
  const target = store as Record<string, unknown>;
  for (const k of Object.getOwnPropertyNames(Object.getPrototypeOf(store))) {
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(store), k);
    if (k === 'constructor' || typeof desc?.value !== 'function') continue;
    const f = desc.value as (...a: unknown[]) => unknown;
    target[k] = (...a: unknown[]) => {
      inFlight++;
      let out: unknown;
      try { out = f.apply(store, a); } catch (e) { inFlight--; throw e; }
      if (out instanceof Promise) return out.finally(() => { inFlight--; });
      inFlight--;
      return out;
    };
  }
  return async () => {
    for (let quiet = 0, i = 0; quiet < 2 && i < 2_000; i++) {
      await settle(1);
      quiet = inFlight === 0 ? quiet + 1 : 0;
    }
  };
}

// ── Virtual time ─────────────────────────────────────────────────────────────

class VTime {
  ms = T0 * 1000;
  #timers: Array<{ at: number; done: () => void }> = [];
  /** Resolves once the kit has settled (run() tests: its store has nothing in flight); the clock moves only then. */
  idle: (() => Promise<void>) | null = null;
  now = (): number => this.ms;
  /** A wait that moves the clock at once (step-driven tests). */
  jump = async (ms: number): Promise<void> => {
    if (ms > 0) this.ms += ms;
  };
  /** A wait that lasts until advance() reaches it, or its signal aborts (run() tests). */
  sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise<void>((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    if (!(ms > 0)) { setImmediate(resolve); return; }
    const t = {
      at: this.ms + ms,
      done: () => {
        signal?.removeEventListener('abort', t.done);
        this.#timers = this.#timers.filter((x) => x !== t);
        resolve();
      }
    };
    this.#timers.push(t);
    signal?.addEventListener('abort', t.done, { once: true });
  });
  /** Move the clock `ms` ahead, ending each wait in turn and letting the kit's own I/O settle after each. */
  async advance(ms: number): Promise<void> {
    const end = this.ms + ms;
    for (let guard = 0; guard < 10_000; guard++) {
      const due = this.#timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.ms = Math.max(this.ms, due.at);
      due.done();
      await (this.idle ? this.idle() : settle(3));
    }
    this.ms = end;
    await (this.idle ? this.idle() : settle());
  }
  get s(): number { return nowSecOf(this.ms); }
  /** Set the clock to unix second `s`. */
  at(s: number): void { this.ms = s * 1000; }
}

// ── A fake Phantasma node that applies the escrow's transactions ─────────────

interface FakeLock { state: number; sender: string; recipient: string; symbol: string; amount: bigint; deadline: number; created: number; secret?: string }
type SendMode = 'normal' | 'lose' | 'drop';

/** The escrow call inside a signed Phantasma transaction, read back from its script. */
function decodeEscrowCall(hex: string): { method: string; args: string[] } | null {
  const tx = Transaction.FromBytes(hex);
  const script = Buffer.from(tx.script, 'hex');
  const regs: unknown[] = [];
  const stack: unknown[] = [];
  const argc: Record<string, number> = { AllowGas: 4, SpendGas: 1, lock: 6, claim: 1, refund: 1 };
  let found: { method: string; args: string[] } | null = null;
  let i = 0;
  const varint = () => {
    const b = script[i++]!;
    if (b < 0xfd) return b;
    const v = script[i]! | (script[i + 1]! << 8);
    i += 2;
    return v;
  };
  while (i < script.length) {
    const op = script[i++]!;
    if (op === 13) {
      const reg = script[i++]!;
      const type = script[i++]!;
      const len = varint();
      const bytes = script.subarray(i, i + len);
      i += len;
      regs[reg] = type === 4 ? bytes.toString('utf8') : '0x' + bytes.toString('hex');
    } else if (op === 3) {
      stack.push(regs[script[i++]!]);
    } else if (op === 4) {
      regs[script[i++]!] = stack.pop();
    } else if (op === 45) {
      const src = script[i++]!;
      const dst = script[i++]!;
      regs[dst] = regs[src];
    } else if (op === 46) {
      const ctx = String(regs[script[i++]!]);
      const method = String(stack.pop());
      const args: string[] = [];
      for (let k = 0; k < (argc[method] ?? 0); k++) args.push(String(stack.pop()));
      if (ctx === 'saturnescrow') found = { method, args };
    } else if (op === 7) {
      i++;
    } else if (op === 11) {
      break;
    } else {
      throw new Error(`fake node: opcode ${op}`);
    }
  }
  return found;
}

class FakePha implements PhaRpc {
  name = 'saturnescrow';
  script = ESCROW_SCRIPT;
  methods = [...ESCROW_METHODS];
  admin: string = CFG.phaAdmin;
  locks = new Map<string, FakeLock>();
  bounds: Record<string, { min: bigint; max: bigint }> = Object.fromEntries(P2P_TOKENS.map((t) => [t.symbol, { min: t.min, max: t.max }]));
  caps: Record<string, { open: bigint; max: bigint }> = Object.fromEntries(P2P_TOKENS.map((t) => [t.symbol, { open: 0n, max: 10n ** 20n }]));
  bals = new Map<string, PhaBalance[]>();
  /** Views that fail (by method). */
  failViews = new Set<string>();
  sent: string[] = [];
  states = new Map<string, PhaTxState>();
  modes: SendMode[] = [];
  /** The escrow calls applied, decoded from the signed scripts. */
  applied: Array<{ method: string; args: string[]; at: number }> = [];
  /** When getState was read (unix s), for the watch cadence. */
  stateReads: number[] = [];
  /** The same, per lock hash (0x-hex). */
  stateReadsOf = new Map<string, number[]>();
  /** How long a send takes to be confirmed, ms (0: at once); a lock waiting on it is not on chain before then. */
  slowFor: ((call: { method: string; args: string[] } | null) => number) | null = null;
  /** Sends waiting to be confirmed (slowFor), by hash. */
  slow = new Map<string, { call: { method: string; args: string[] } | null; at: number }>();
  /** Every slow send: when it went out and when it could be confirmed (ms). */
  slowLog: Array<{ sent: number; at: number }> = [];

  constructor(readonly clock: () => number) {}

  async views(calls: readonly PhaCall[]): Promise<unknown[]> {
    return calls.map((c) => this.#view(c));
  }

  #view(c: PhaCall): unknown {
    if (this.failViews.has(c.method)) throw new Error(`fake node: ${c.method} fails`);
    if (c.contract !== this.name) return null;
    const lock = () => this.locks.get(decimalToHex(c.args[0])!);
    switch (c.method) {
      case 'getState': {
        const at = nowSecOf(this.clock());
        this.stateReads.push(at);
        const h = decimalToHex(c.args[0])!;
        this.stateReadsOf.set(h, [...(this.stateReadsOf.get(h) ?? []), at]);
        return String(lock()?.state ?? 0);
      }
      case 'getSender': return lock()?.sender ?? null;
      case 'getRecipient': return lock()?.recipient ?? null;
      case 'getSymbol': return lock()?.symbol ?? null;
      case 'getAmount': return lock() ? String(lock()!.amount) : null;
      case 'getDeadline': return lock() ? String(lock()!.deadline) : null;
      case 'getCreated': return lock() ? String(lock()!.created) : null;
      case 'getSecret': { const s = lock()?.secret; return s ? hexToDecimal(s) : null; }
      case 'getAdmin': return this.admin;
      case 'getPaused': return '0';
      case 'getMinLock': return '60';
      case 'getMaxLock': return '7200';
      case 'getMinAmount': return String(this.bounds[c.args[0]!]?.min ?? 0n);
      case 'getMaxAmount': return String(this.bounds[c.args[0]!]?.max ?? 0n);
      case 'getOpenAmount': return String(this.caps[c.args[0]!]?.open ?? 0n);
      case 'getMaxOpen': return String(this.caps[c.args[0]!]?.max ?? 0n);
      case 'hashSecret': {
        const bytes = Buffer.from(BigInt(c.args[0]!).toString(16).padStart(64, '0'), 'hex');
        return BigInt('0x' + sha(bytes).toString('hex')).toString();
      }
      default: return null;
    }
  }

  async contract(): Promise<{ name: string; script: string; methods: string[] }> {
    return { name: this.name, script: this.script, methods: this.methods };
  }

  async balances(address: string): Promise<PhaBalance[]> {
    return this.bals.get(address) ?? [];
  }

  /** Apply one escrow call as the escrow would, answering the transaction's state. */
  apply(call: { method: string; args: string[] } | null): PhaTxState {
    const now = nowSecOf(this.clock());
    if (!call) return { state: 'Fault', reason: 'not an escrow call' };
    this.applied.push({ ...call, at: now });
    if (call.method === 'lock') {
      const [from, hDec, symbol, amount, recipient, deadline] = call.args as [string, string, string, string, string, string];
      const h = decimalToHex(hDec)!;
      if (this.locks.has(h)) return { state: 'Fault', reason: 'P2:used' };
      this.locks.set(h, { state: 1, sender: from, recipient, symbol, amount: BigInt(amount), deadline: Number(deadline), created: now });
      return { state: 'Halt', reason: '' };
    }
    if (call.method === 'claim') {
      const secret = decimalToHex(call.args[0])!;
      const l = this.locks.get(hashOfSecret(secret));
      if (!l || l.state !== 1) return { state: 'Fault', reason: 'P2:state' };
      if (now >= l.deadline) return { state: 'Fault', reason: 'P2:expired' };
      l.state = 2;
      l.secret = secret;
      return { state: 'Halt', reason: '' };
    }
    if (call.method === 'refund') {
      const l = this.locks.get(decimalToHex(call.args[0])!);
      if (!l || l.state !== 1) return { state: 'Fault', reason: 'P2:state' };
      if (now < l.deadline) return { state: 'Fault', reason: 'P2:early' };
      l.state = 3;
      return { state: 'Halt', reason: '' };
    }
    return { state: 'Fault', reason: 'unknown method' };
  }

  async sendRaw(hex: string): Promise<string> {
    this.sent.push(hex);
    const hash = sha(Buffer.from(hex, 'hex')).toString('hex').toUpperCase();
    const mode = this.modes.shift() ?? 'normal';
    if (mode === 'lose') throw new Error('fetch failed');
    const call = decodeEscrowCall(hex);
    const delay = this.slowFor?.(call) ?? 0;
    if (delay > 0) {
      this.slow.set(hash, { call, at: this.clock() + delay });
      this.slowLog.push({ sent: this.clock(), at: this.clock() + delay });
      return hash;
    }
    this.states.set(hash, this.apply(call));
    if (mode === 'drop') throw new Error('fetch failed');
    return hash;
  }

  async transaction(hash: string): Promise<PhaTxState | null> {
    const w = this.slow.get(hash);
    if (w && this.clock() >= w.at) {
      this.slow.delete(hash);
      this.states.set(hash, this.apply(w.call));
    }
    return this.states.get(hash) ?? null;
  }

  /** Sends of one escrow method so far (lost ones included). */
  count(method: string): number {
    return this.sent.filter((hex) => decodeEscrowCall(hex)?.method === method).length;
  }
}

// ── A fake Base node with SaturnSwap and USDC that applies transactions ──────

interface FakeSwap { token: string; deadline: number; feeBps: number; sender: string; claimer: string; amount: bigint; block: bigint; claimedBlock?: bigint; refundedBlock?: bigint }

const BASE0 = 10_000n;

class FakeBase implements BaseClient {
  baseFee = 10_000_000n;
  tip = 1_000_000n;
  feeBps = 50;
  usdc = new Map<string, bigint>();
  allowances = new Map<string, bigint>();
  nonces = new Map<string, number>();
  swaps = new Map<string, FakeSwap>();
  preimages = new Map<string, { value: string; block: bigint }>();
  owed = new Map<string, bigint>();
  events: BaseLog[] = [];
  receipts = new Map<string, BaseReceipt>();
  sent: Hex[] = [];
  /** Every eth_call simulation, by function, in order (the sends follow in `sent`). */
  simulated: string[] = [];
  /** Function names in the order calls and sends happened ('call:x' or 'send:x'). */
  order: string[] = [];
  /** While true, a send is taken into the mempool and never mined (no receipt, its nonce not used). */
  stuck = false;
  /** Transactions the node knows but has not mined. */
  pending = new Set<string>();

  constructor(readonly clock: () => number) {}

  get head(): bigint {
    return BASE0 + BigInt(Math.max(0, Math.floor((this.clock() / 1000 - T0) / 2)));
  }

  blockTime(n: bigint): number {
    return T0 + Number(n - BASE0) * 2;
  }

  async chainId(): Promise<number> { return 84532; }

  async block(at: { tag?: 'latest' | 'safe'; number?: bigint } = {}): Promise<BaseBlock> {
    const n = at.number != null ? at.number : at.tag === 'safe' ? this.head - 10n : this.head;
    return { number: n, timestamp: BigInt(this.blockTime(n)), baseFeePerGas: this.baseFee };
  }

  swapAt(h: string, sender: string, bn: bigint = this.head) {
    const s = this.swaps.get(`${h.toLowerCase()}|${sender.toLowerCase()}`);
    if (!s || s.block > bn) return { token: ZERO, deadline: 0n, feeBps: 0, state: 0, sender: ZERO, claimer: ZERO, amount: 0n };
    const state = s.claimedBlock != null && s.claimedBlock <= bn ? 2 : s.refundedBlock != null && s.refundedBlock <= bn ? 3 : 1;
    return { token: s.token, deadline: BigInt(s.deadline), feeBps: s.feeBps, state, sender: s.sender, claimer: s.claimer, amount: s.amount };
  }

  async read(c: ReadCall): Promise<unknown> {
    const a = (c.args ?? []) as string[];
    const to = c.address.toLowerCase();
    if (to === SWAP) {
      switch (c.functionName) {
        case 'getSwap': return this.swapAt(a[0]!, a[1]!, c.blockNumber ?? this.head);
        case 'feeBps': return this.feeBps;
        case 'paused': return false;
        case 'minLock': return 300n;
        case 'maxLock': return 172_800n;
        case 'tokenCfg': return [true, 1_000_000n, 100_000_000_000n];
        case 'getPreimage': {
          const p = this.preimages.get(`${a[0]!.toLowerCase()}|${a[1]!.toLowerCase()}`);
          if (!p || p.block > (c.blockNumber ?? this.head)) throw new Error('NotClaimed');
          return p.value;
        }
        case 'owed': return this.owed.get(a[1]!.toLowerCase()) ?? 0n;
      }
    }
    if (to === USDC) {
      switch (c.functionName) {
        case 'balanceOf': return this.usdc.get(a[0]!.toLowerCase()) ?? 0n;
        case 'allowance': return this.allowances.get(a[0]!.toLowerCase()) ?? 0n;
        case 'nonces': return 0n;
        case 'DOMAIN_SEPARATOR': return pinnedDomainSeparator(CFG);
      }
    }
    throw new Error(`fake base: no ${c.functionName} at ${to}`);
  }

  async logs(q: { address: Hex; event: AbiEvent; args: Record<string, unknown>; fromBlock: bigint; toBlock: bigint }): Promise<BaseLog[]> {
    return this.events.filter((l) => l.eventName === q.event.name && l.blockNumber != null && l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock
      && Object.entries(q.args).every(([k, v]) => String(l.args[k]).toLowerCase() === String(v).toLowerCase()));
  }

  async receipt(hash: Hex): Promise<BaseReceipt | null> { return this.receipts.get(hash.toLowerCase()) ?? null; }
  async seen(hash: Hex): Promise<boolean> { return this.receipts.has(hash.toLowerCase()) || this.pending.has(hash.toLowerCase()); }
  async code(): Promise<Hex> { return '0x'; }
  async balance(): Promise<bigint> { return 10n ** 18n; }
  async nonce(address: Hex): Promise<number> { return this.nonces.get(address.toLowerCase()) ?? 0; }
  async priorityFee(): Promise<bigint> { return this.tip; }
  async estimateGas(): Promise<bigint> { return 100_000n; }

  /** One call's effect (dry: only whether it would revert). Throws the revert's name. */
  apply(from: string, to: string, data: Hex, dry: boolean, logs: BaseLog[] = []): void {
    if (to.toLowerCase() === from && (!data || data === '0x')) return;
    if (to.toLowerCase() !== SWAP) throw new Error('fake base: the kit only calls SaturnSwap in these tests');
    const d = decodeFunctionData({ abi: SATURN_SWAP_ABI, data });
    const a = d.args as readonly unknown[];
    if (d.functionName === 'claim') {
      const [preimage, sender] = a as [string, string];
      const h = '0x' + sha(Buffer.from(preimage.slice(2), 'hex')).toString('hex');
      this.#claim(h, String(sender).toLowerCase(), preimage.toLowerCase(), dry, logs);
      return;
    }
    if (d.functionName === 'withdrawOwed') throw new Error('NothingOwed');
    throw new Error(`fake base: ${d.functionName} is not served`);
  }

  #claim(h: string, sender: string, preimage: string, dry: boolean, logs: BaseLog[]): void {
    const s = this.swaps.get(`${h}|${sender}`);
    if (!s || this.swapAt(h, sender).state !== 1) throw new Error('NotLocked');
    if (nowSecOf(this.clock()) >= s.deadline) throw new Error('SwapExpired');
    if (dry) return;
    const block = this.head;
    s.claimedBlock = block;
    this.preimages.set(`${h}|${sender}`, { value: preimage, block });
    const fee = (s.amount * BigInt(s.feeBps)) / 10_000n;
    this.usdc.set(s.claimer, (this.usdc.get(s.claimer) ?? 0n) + s.amount - fee);
    const ev: BaseLog = { address: SWAP, blockNumber: block, eventName: 'Claimed', args: { h, sender, preimage, claimer: s.claimer, net: s.amount - fee, fee } };
    this.events.push(ev);
    logs.push(ev);
  }

  /** The buyer's USDC lock, mined in the newest block, with its Locked event and receipt. Returns the lock's transaction hash. */
  lockAs(from: string, h: string, o: { amount: bigint; claimer: string; deadline: number; token?: string; feeBps?: number }): Hex {
    const block = this.head;
    const sender = from.toLowerCase();
    const s: FakeSwap = { token: (o.token ?? USDC).toLowerCase(), deadline: o.deadline, feeBps: o.feeBps ?? this.feeBps, sender, claimer: o.claimer.toLowerCase(), amount: o.amount, block };
    this.swaps.set(`${h.toLowerCase()}|${sender}`, s);
    const ev: BaseLog = { address: SWAP, blockNumber: block, eventName: 'Locked', args: { h: h.toLowerCase(), sender, claimer: s.claimer, token: s.token, amount: s.amount, deadline: BigInt(s.deadline), feeBps: s.feeBps } };
    this.events.push(ev);
    const hash = keccak256(Buffer.from(`lock ${h} ${sender} ${block}`)).toLowerCase() as Hex;
    this.receipts.set(hash, { status: 'success', blockNumber: block, transactionHash: hash, logs: [ev] });
    return hash;
  }

  /** The keeper (or anyone) claims a swap with its preimage, directly on chain. */
  claimDirect(h: string, sender: string, preimage: string): void {
    this.#claim(h.toLowerCase(), sender.toLowerCase(), preimage.toLowerCase(), false, []);
  }

  async call(c: TxCall): Promise<Hex> {
    const fn = (() => { try { return decodeFunctionData({ abi: SATURN_SWAP_ABI, data: c.data }).functionName; } catch { return 'unknown'; } })();
    this.simulated.push(fn);
    this.order.push(`call:${fn}`);
    this.apply(c.from.toLowerCase(), c.to, c.data, true);
    return '0x';
  }

  async sendRaw(raw: Hex): Promise<Hex> {
    this.sent.push(raw);
    const hash = keccak256(raw).toLowerCase() as Hex;
    const t = parseTransaction(raw);
    const from = (await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase();
    const fn = (() => { try { return decodeFunctionData({ abi: SATURN_SWAP_ABI, data: t.data! }).functionName; } catch { return 'unknown'; } })();
    this.order.push(`send:${fn}`);
    if ((t.nonce ?? 0) < (this.nonces.get(from) ?? 0)) throw Object.assign(new Error('nonce too low'), { name: 'RpcRequestError', code: -32000, details: 'nonce too low' });
    if (this.stuck) {
      this.pending.add(hash);
      return hash;
    }
    this.nonces.set(from, (t.nonce ?? 0) + 1);
    const logs: BaseLog[] = [];
    let status: 'success' | 'reverted' = 'success';
    try {
      this.apply(from, t.to!, t.data!, false, logs);
    } catch {
      status = 'reverted';
    }
    this.receipts.set(hash, { status, blockNumber: this.head, transactionHash: hash, logs });
    return hash;
  }

  /** Sends by function name so far. */
  count(fn: string): number {
    return this.sent.filter((raw) => {
      const t = parseTransaction(raw);
      try {
        return decodeFunctionData({ abi: t.to?.toLowerCase() === USDC ? USDC_ABI : SATURN_SWAP_ABI, data: t.data! }).functionName === fn;
      } catch { return false; }
    }).length;
  }
}

// ── A fake board with the instant routes (build spec section 2.5.1) ──────────

interface BOffer { o: Offer; tokenHash: string; body: NewOffer & Record<string, unknown> }
/** The board's own fields beside tradeJson (never sent: tradeJson gains only `mode`). */
interface BTrade { t: Trade; baseLockedAt: number | null; secret: string | null }

class FakeBoard {
  offers = new Map<number, BOffer>();
  trades = new Map<number, BTrade>();
  calls: Array<{ method: string; path: string; body: any; key: string | null }> = [];
  nextOffer = 1;
  nextTrade = 1;
  feeBps = 50;
  /** /me's instant flag for the API key. */
  keyInstant = true;
  /** An older board that drops `mode` from its offers. */
  dropMode = false;
  /** A board that refuses every lock report for good (422 MISMATCH, not retryable). */
  refuseReport = false;
  /** What /config says about instant trades: on, off, or nothing at all (a board from before wave C). */
  instantOn: boolean | null = true;
  /** A board that takes requests and never answers: every one ('all'), or its POSTs only ('post'); each ends only when the kit gives up on it. */
  hang: 'all' | 'post' | null = null;

  constructor(readonly vt: VTime, readonly pha: FakePha, readonly base: FakeBase) {}

  get nowS(): number { return nowSecOf(this.vt.ms); }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = new Headers(init?.headers);
    const auth = headers.get('authorization')?.replace(/^Bearer /, '') ?? null;
    const key = headers.get('x-api-key');
    this.calls.push({ method, path: url.pathname, body, key });
    if (this.hang === 'all' || (this.hang === 'post' && method === 'POST')) {
      return new Promise<Response>((_, reject) => {
        const stop = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        if (init?.signal?.aborted) stop();
        else init?.signal?.addEventListener('abort', stop, { once: true });
      });
    }
    return this.#route(method, url.pathname, body, auth, key);
  };

  #json(status: number, json: unknown): Response {
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json', 'X-Server-Time': String(this.nowS) } });
  }
  #ok(data: unknown, status = 200): Response { return this.#json(status, { data }); }
  #err(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
    return this.#json(status, { error: { code, message, retryable: false, ...extra } });
  }
  #tokenOk(token: string | null, hash: string): boolean { return !!token && sha256Hex(token) === hash; }

  async #route(method: string, path: string, body: any, auth: string | null, key: string | null): Promise<Response> {
    const now = this.nowS;
    let m: RegExpExecArray | null;
    if (method === 'GET' && path === '/v1/p2p/config') {
      return this.#ok({
        network: 'devnet', enabled: true, displayOnly: true, note: '', keeper: {}, tokens: [], timing: {}, limits: {},
        ...(this.instantOn === null ? {} : { instant: { enabled: this.instantOn, timing: {} } })
      });
    }
    if (method === 'GET' && path === '/v1/p2p/recent') return this.#ok({ trades: [], next: null });
    if (method === 'GET' && path === '/v1/p2p/offers') return this.#ok([...this.offers.values()].map((x) => x.o).filter((o) => o.status === 'open'));
    if (method === 'GET' && path === '/v1/p2p/me') {
      if (!key) return this.#err(401, 'BAD_API_KEY', 'An API key is needed');
      return this.#ok({
        key: { id: 'k1', label: 'instant bot', rpm: 600, p2pCreateRpm: 60, p2pWriteRpm: 600, capShareBps: null, instant: this.keyInstant },
        noShows: { taker: { count24h: 0, pausedUntil: null }, maker: { count24h: 0, pausedUntil: null } }, capShare: {}
      });
    }
    if (method === 'POST' && path === '/v1/p2p/offers') {
      if (body.mode === 'instant') {
        if (body.side !== 'sell') return this.#err(400, 'BAD_REQUEST', 'An instant offer is a sell offer');
        if (!key || !this.keyInstant) return this.#err(403, 'NOT_ELIGIBLE', 'Instant offers need an API key flagged instant', { reason: 'instant_key' });
      }
      const id = this.nextOffer++;
      const o: Offer = {
        id, network: 'devnet', side: body.side, makerPha: body.makerPha, makerBase: body.makerBase, symbol: body.symbol,
        tazTotal: body.tazTotal, tazMin: body.tazMin, tazMax: body.tazMax, price: body.price, remaining: body.tazTotal,
        status: 'open', online: true, createdAt: now, heartbeatAt: now, closedAt: null, follow: null,
        ...(this.dropMode ? {} : { mode: body.mode === 'instant' ? 'instant' : 'standard' })
      };
      this.offers.set(id, { o, tokenHash: String(body.makerTokenHash), body });
      return this.#ok({ offer: o, replayed: false }, 201);
    }
    if (method === 'POST' && (m = /^\/v1\/p2p\/offers\/(\d+)\/(heartbeat|cancel)$/.exec(path))) {
      const off = this.offers.get(Number(m[1]));
      if (!off) return this.#err(404, 'NOT_FOUND', 'No such offer');
      if (!this.#tokenOk(auth, off.tokenHash)) return this.#err(401, 'UNAUTHORIZED', 'Wrong token');
      if (m[2] === 'cancel') {
        off.o.status = 'closed';
        off.o.closedAt = now;
        return this.#ok({ ok: true });
      }
      const trades = [...this.trades.values()].map((x) => x.t).filter((t) => t.offerId === off.o.id && t.endedAt === null);
      return this.#ok({ offer: off.o, trades, serverTime: now, waited: false });
    }
    if (method === 'GET' && (m = /^\/v1\/p2p\/trades\/(\d+)$/.exec(path))) {
      const b = this.trades.get(Number(m[1]));
      if (!b) return this.#err(404, 'NOT_FOUND', 'No such trade');
      return this.#ok(b.t);
    }
    if (method === 'POST' && (m = /^\/v1\/p2p\/trades\/(\d+)\/(accept|decline|pha-locked|base-locked|reveal)$/.exec(path))) {
      const b = this.trades.get(Number(m[1]));
      if (!b) return this.#err(404, 'NOT_FOUND', 'No such trade');
      const t = b.t;
      const off = this.offers.get(t.offerId)!;
      const makerOk = this.#tokenOk(auth, off.tokenHash);
      switch (m[2]) {
        case 'accept':
          if (!makerOk) return this.#err(401, 'UNAUTHORIZED', 'Wrong token');
          if (t.status !== 'requested') return this.#err(409, 'STATE', 'Not requested');
          Object.assign(t, { status: 'accepted', feeBps: this.feeBps, acceptedAt: now, updatedAt: now, lockBy: now + BOARD.lockWait });
          return this.#ok(t);
        case 'decline':
          if (!makerOk) return this.#err(401, 'UNAUTHORIZED', 'Wrong token');
          Object.assign(t, { status: 'cancelled', updatedAt: now, endedAt: now });
          return this.#ok(t);
        case 'pha-locked': {
          // Build spec section 2.5.1: allowed in base_locked; the lock fits and keeps the instant time rules.
          if (!makerOk) return this.#err(401, 'UNAUTHORIZED', 'Wrong token');
          if (this.refuseReport) return this.#err(422, 'MISMATCH', 'The Phantasma lock does not fit this instant trade');
          if (t.mode !== 'instant') return this.#err(409, 'STATE', 'This board serves only instant trades in these tests');
          if (t.status !== 'base_locked' || !t.h) return this.#err(409, 'STATE', 'The buyer has not locked the USDC yet');
          if (String(body.h).toLowerCase() !== t.h) return this.#err(422, 'MISMATCH', 'This is not the h of the buyer\'s USDC lock');
          const l = this.pha.locks.get(t.h);
          if (!l || l.state !== 1 || l.sender !== t.seller.pha || l.recipient !== t.buyer.pha || l.symbol !== t.symbol || l.amount !== BigInt(t.taz)) {
            return this.#err(409, 'NOT_YET', 'The Phantasma lock is not visible yet', { retryable: true, retryAfter: 5 });
          }
          if (l.created > b.baseLockedAt! + ITM.I_WIN) return this.#err(422, 'MISMATCH', 'The tokens were locked too late');
          if (l.deadline > t.baseDeadline! - ITM.I_SAFETY) return this.#err(422, 'MISMATCH', 'The tokens lock ends too close to the USDC lock');
          if (l.deadline - l.created < ITM.I_PHA - INSTANT_RULES.phaLockSlack) return this.#err(422, 'MISMATCH', 'The tokens lock is too short');
          Object.assign(t, { status: 'pha_locked', phaDeadline: l.deadline, phaLockTx: body.txHash ?? null, updatedAt: now });
          return this.#ok(t);
        }
        case 'reveal':
          return this.#err(409, 'STATE', 'A seller never reveals in an instant trade');
        default:
          return this.#err(409, 'STATE', 'The buyer reports its own lock in these tests');
      }
    }
    return this.#err(404, 'NOT_FOUND', `No route ${method} ${path}`);
  }

  /** The buyer B takes `taz` of offer `offerId` (the board's row, as a take makes it). `mode`: what the board says (default: the offer's). */
  take(offerId: number, taz: bigint = TAZ2, o: { mode?: 'standard' | 'instant' } = {}): Trade {
    const off = this.offers.get(offerId)!.o;
    const now = this.nowS;
    const t: Trade = {
      id: this.nextTrade++, network: 'devnet', offerId, side: off.side, symbol: off.symbol, taz: taz.toString(),
      usdc: ((taz * BigInt(off.price)) / 10n ** 9n).toString(), price: off.price,
      seller: { pha: off.makerPha, base: off.makerBase }, buyer: { pha: B_P, base: B_B },
      h: null, phaContract: null, phaLockTx: null, baseLockTx: null, baseClaimTx: null, phaClaimTx: null, baseRefundTx: null, phaRefundTx: null,
      phaDeadline: null, baseDeadline: null, feeBps: null, payoutDeferred: false, status: 'requested',
      acceptBy: now + BOARD.acceptTimeout, lockBy: null, createdAt: now, acceptedAt: null, updatedAt: now, endedAt: null, lastError: null,
      mode: o.mode ?? off.mode ?? 'standard'
    };
    off.remaining = (BigInt(off.remaining) - taz).toString();
    this.trades.set(t.id, { t, baseLockedAt: null, secret: null });
    return t;
  }

  /**
   * The buyer makes its secret, locks the USDC on Base (in the newest
   * block, t_B its time), and reports it: the trade is base_locked with h,
   * T_B and t_B. `onChain: false` reports a lock that is not on Base.
   */
  buyerLocks(id: number, o: { deadline?: number; amount?: bigint; claimer?: string; token?: string; feeBps?: number; onChain?: boolean } = {}): { x: string; h: string; tB: number; TB: number } {
    const b = this.trades.get(id)!;
    const t = b.t;
    const x = newSecret();
    const h = hashOfSecret(x);
    const tB = this.base.blockTime(this.base.head);
    const TB = o.deadline ?? tB + instantBaseSpan(ITM);
    let tx: Hex = ('0x' + '11'.repeat(32)) as Hex;
    if (o.onChain !== false) {
      tx = this.base.lockAs(B_B, h, { amount: o.amount ?? BigInt(t.usdc), claimer: o.claimer ?? t.seller.base, deadline: TB, token: o.token, feeBps: o.feeBps });
    }
    Object.assign(t, { status: 'base_locked', h, phaContract: 'saturnescrow', baseLockTx: tx, baseDeadline: TB, updatedAt: this.nowS });
    b.baseLockedAt = tB;
    b.secret = x;
    return { x, h, tB, TB };
  }

  /** The buyer reveals and the keeper claims the buyer's tokens on Phantasma with that code (section 3.10.4: Phantasma first). */
  keeperClaimsPha(id: number): void {
    const b = this.trades.get(id)!;
    const st = this.pha.apply({ method: 'claim', args: [hexToDecimal(b.secret!)] });
    assert.equal(st.state, 'Halt', `the keeper's Phantasma claim: ${st.reason}`);
    Object.assign(b.t, { status: 'revealed', updatedAt: this.nowS });
  }

  /** Board calls of one kind so far. */
  count(method: string, re: RegExp): number {
    return this.calls.filter((c) => c.method === method && re.test(c.path)).length;
  }
}

// ── Worlds and the seller bot ────────────────────────────────────────────────

const dirs: string[] = [];
const kits: Kit[] = [];
after(async () => {
  for (const k of kits) await k.close().catch(() => {});
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'kit-instant-'));
  dirs.push(d);
  return d;
}

interface World { vt: VTime; pha: FakePha; base: FakeBase; board: FakeBoard }

function world(): World {
  const vt = new VTime();
  const pha = new FakePha(vt.now);
  const base = new FakeBase(vt.now);
  const board = new FakeBoard(vt, pha, base);
  return { vt, pha, base, board };
}

interface Bot { phaKeyFile: string; baseKeyFile: string; dataDir: string; pha: string; base: string; secrets: string[] }

/** The seller bot's key files (0600), made on the spot and never printed, and its balances on the fakes. */
async function newBot(w: World): Promise<Bot> {
  const d = await tempDir();
  const phaKeyFile = join(d, 'pha.json'), baseKeyFile = join(d, 'base.json');
  const pk = PhantasmaKeys.generate();
  const bk = generatePrivateKey();
  await writeFile(phaKeyFile, JSON.stringify({ wif: pk.toWIF() }), { mode: 0o600 });
  await writeFile(baseKeyFile, JSON.stringify({ privateKey: bk }), { mode: 0o600 });
  await chmod(phaKeyFile, 0o600);
  await chmod(baseKeyFile, 0o600);
  const base = privateKeyToAccount(bk).address.toLowerCase();
  const pha = pk.Address.Text;
  w.pha.bals.set(pha, [
    { symbol: 'TAZ', amount: (100n * 10n ** 9n).toString(), decimals: 9 },
    { symbol: 'SOUL', amount: (5n * 10n ** 8n).toString(), decimals: 8 },
    { symbol: 'KCAL', amount: (10n * 10n ** 10n).toString(), decimals: 10 }
  ]);
  w.base.usdc.set(B_B, 1_000_000_000n);
  return { phaKeyFile, baseKeyFile, dataDir: join(d, 'data'), pha, base, secrets: [pk.toWIF(), bk] };
}

interface Seller { w: World; kit: Kit; logs: string[]; bot: Bot }

/**
 * The seller bot on the fakes, with an API key unless `apiKey: null`. Each wait moves the virtual clock at once; with
 * `virtual`, waits last until the test advances the clock (run() tests), and the signer waits as long as a real one
 * would: a Phantasma send up to 200 s, a Base send up to 180 s.
 */
async function seller(o: { apiKey?: string | null; w?: World; virtual?: boolean } = {}): Promise<Seller> {
  const w = o.w ?? world();
  const bot = await newBot(w);
  const logs: string[] = [];
  const opts: KitOptions = {
    network: 'devnet', api: 'http://127.0.0.1:9', phaKeyFile: bot.phaKeyFile, baseKeyFile: bot.baseKeyFile, dataDir: bot.dataDir,
    log: (l) => logs.push(l), env: {},
    ...(o.apiKey === null ? {} : { apiKey: o.apiKey ?? API_KEY }),
    internals: {
      fetch: w.board.fetch as typeof fetch, pha: w.pha, base: w.base, now: w.vt.now, sleep: o.virtual ? w.vt.sleep : w.vt.jump,
      ...(o.virtual
        ? { signerSleep: (ms: number) => w.vt.sleep(ms), signerWait: { phaTries: 80, phaIntervalMs: 2_500, baseTimeoutMs: 180_000, basePollMs: 2_000, allowanceTries: 2, allowancePollMs: 0 } }
        : { signerSleep: async () => {}, signerWait: { phaTries: 1, phaIntervalMs: 0, baseTimeoutMs: 1, basePollMs: 1, allowanceTries: 2, allowancePollMs: 0 } }),
      argv: ['node', 'bot.ts'], storeKeyFile: null, pollWaitS: 0
    }
  };
  const kit = await createKit(opts);
  kits.push(kit);
  return { w, kit, logs, bot };
}

/** No key, token or secret in any log line, and no 64-hex value at all. */
function assertClean(s: Seller, extra: string[] = []): void {
  const secrets = [...s.bot.secrets, API_KEY, ...extra].map((x) => x.toLowerCase().replace(/^0x/, ''));
  for (const line of s.logs) {
    const l = line.toLowerCase();
    for (const x of secrets) assert.ok(!l.includes(x), 'a log line carries a key, a token or a secret');
    assert.ok(!/[0-9a-f]{64}/.test(l), `a log line carries 64 hex digits: ${line.slice(0, 80)}`);
  }
}

/** Sends on both chains so far. */
const sends = (w: World) => w.pha.sent.length + w.base.sent.length;

/** The seller posts an instant offer, the buyer takes 2 TAZ of it, and the bot accepts the take (acceptAfterS 0). */
async function acceptedInstant(o: { apiKey?: string | null } = {}): Promise<Seller & { offer: LocalOffer; id: number }> {
  const s = await seller(o);
  const offer = await s.kit.postOffer({ ...SELL, mode: 'instant' });
  const t = s.w.board.take(offer.id);
  const r = await s.kit.step(t.id, POLICY);
  assert.equal(r.action, 'accept', JSON.stringify(r));
  assert.equal(r.outcome, 'done', JSON.stringify(r));
  assert.equal(s.w.board.trades.get(t.id)!.t.status, 'accepted');
  return { ...s, offer, id: t.id };
}

/** As acceptedInstant, then the buyer locks its USDC first (options as FakeBoard.buyerLocks); the clock then stands at t_B + `after` s. */
async function buyerLocked(after: number, o: Parameters<FakeBoard['buyerLocks']>[1] = {}) {
  const s = await acceptedInstant();
  s.w.vt.ms += 4_000;
  const lock = s.w.board.buyerLocks(s.id, o);
  s.w.vt.at(lock.tB + after);
  return { ...s, ...lock };
}

/** The refusal of a step (fails the test when it did something else). */
function refusedWith(r: StepResult, code: string): StepResult {
  assert.equal(r.outcome, 'refused', JSON.stringify(r));
  assert.equal(r.code, code, r.text);
  assert.equal(r.check, CHECK_CODES[code as checks.CheckCode] ?? r.check);
  return r;
}

/** The deadline argument of the n-th escrow lock the kit signed. */
function lockDeadline(w: World, n = 0): number {
  const locks = w.pha.applied.filter((a) => a.method === 'lock');
  return Number(locks[n]!.args[5]);
}

// ── 1. The constants ─────────────────────────────────────────────────────────

describe('INSTANT: the time rules the kit locks and claims by', () => {
  test('devnet: the seller starts its lock within 180 s of t_B, locks for 900 s, and claims while 60 s are left; T_B - now = 1,920 s when the buyer locks', () => {
    assert.equal(ITM.I_WIN - ITM.I_WIN_LEAD, 180);
    assert.equal(ITM.I_PHA, 900);
    assert.equal(instantBaseSpan(ITM), 1920);
    assert.equal(INSTANT_RULES.claimMin, 60);
    assert.ok(INSTANT_RULES.watchEvery <= 15);
  });

  test('instantWindowProblem: 60 s after t_B goes ahead, 180 s still does, 181 s and 200 s are late; T_B - now under I_PHA + I_SAFETY is too short', () => {
    const tB = T0, TB = T0 + 1920;
    assert.equal(checks.instantWindowProblem(tB, TB, tB + 60, ITM), null);
    assert.equal(checks.instantWindowProblem(tB, TB, tB + 180, ITM), null);
    assert.equal(checks.instantWindowProblem(tB, TB, tB + 181, ITM)?.code, 'INSTANT_LATE');
    assert.equal(checks.instantWindowProblem(tB, TB, tB + 200, ITM)?.code, 'INSTANT_LATE');
    assert.match(checks.instantWindowProblem(tB, TB, tB + 200, ITM)!.text, /mined 200 s ago; this kit starts its lock only within 180 s/);
    assert.equal(checks.instantWindowProblem(tB, tB + 60 + 1500, tB + 60, ITM), null, 'exactly I_PHA + I_SAFETY left');
    assert.equal(checks.instantWindowProblem(tB, tB + 60 + 1499, tB + 60, ITM)?.code, 'INSTANT_SHORT');
    assert.equal(checks.instantWindowProblem(0, TB, tB, ITM)?.code, 'INSTANT_LATE', 'an unknown t_B never passes');
  });

  test('instantBuyerLockProblem: state, token, amount, claimer, sender, the confirmed read and the fee', () => {
    const want = { usdcToken: USDC, usdc: USDC2, sBase: '0x' + '5a'.repeat(20), bBase: B_B, maxFeeBps: 50 };
    const swap = { state: 1, token: USDC, sender: B_B, claimer: want.sBase, amount: USDC2, deadline: T0 + 1920, feeBps: 50 };
    assert.equal(checks.instantBuyerLockProblem(swap, swap, want), null);
    assert.match(checks.instantBuyerLockProblem({ ...swap, state: 0 }, null, want)!, /not locked the USDC on Base yet/);
    assert.match(checks.instantBuyerLockProblem({ ...swap, state: 2 }, swap, want)!, /already claimed/);
    assert.match(checks.instantBuyerLockProblem({ ...swap, state: 3 }, swap, want)!, /already refunded/);
    assert.match(checks.instantBuyerLockProblem({ ...swap, token: '0x' + 'ee'.repeat(20) }, swap, want)!, /another token/);
    assert.match(checks.instantBuyerLockProblem({ ...swap, amount: USDC2 - 1n }, swap, want)!, /different amount/);
    assert.match(checks.instantBuyerLockProblem({ ...swap, claimer: B_B }, swap, want)!, /pays another address/);
    assert.match(checks.instantBuyerLockProblem({ ...swap, sender: '0x' + 'c3'.repeat(20) }, swap, want)!, /another address than the buyer/);
    assert.match(checks.instantBuyerLockProblem(swap, { ...swap, state: 0 }, want)!, /waiting for confirmations/);
    assert.match(checks.instantBuyerLockProblem(swap, { ...swap, deadline: swap.deadline + 1 }, want)!, /changed while it was being checked/);
    assert.match(checks.instantBuyerLockProblem({ ...swap, feeBps: 51 }, { ...swap, feeBps: 51 }, want)!, /higher fee/);
  });

  test('instantSwapReadsProblem: the accept needs SaturnSwap\'s lock bounds to take the buyer\'s 1,920 s lock', () => {
    const bp = { paused: false, allowed: true, minAmount: 1_000_000n, maxAmount: 100_000_000_000n, minLock: 300, maxLock: 172_800 };
    assert.equal(checks.instantSwapReadsProblem(bp, USDC2, ITM), null);
    assert.match(checks.instantSwapReadsProblem({ ...bp, paused: true }, USDC2, ITM)!, /paused/);
    assert.match(checks.instantSwapReadsProblem({ ...bp, minLock: 1921 }, USDC2, ITM)!, /shortest lock/);
    assert.match(checks.instantSwapReadsProblem({ ...bp, maxLock: 1920 }, USDC2, ITM)!, /longest lock/);
    assert.match(checks.instantSwapReadsProblem(bp, 999_999n, ITM)!, /would not accept/);
  });
});

// ── 2. Posting an instant offer ──────────────────────────────────────────────

describe('posting an instant offer (build spec section 3.10.5)', () => {
  test('without an API key the kit refuses before anything is sent (MODE_NOT_SUPPORTED: no /me, no POST)', async () => {
    const s = await seller({ apiKey: null });
    await assert.rejects(s.kit.postOffer({ ...SELL, mode: 'instant' }), (e: unknown) => e instanceof SafetyError && e.code === 'MODE_NOT_SUPPORTED' && /API key/.test(e.detail));
    assert.equal(s.w.board.count('POST', /\/offers$/), 0);
    assert.equal(s.w.board.count('GET', /\/me$/), 0);
    assert.equal(s.w.board.offers.size, 0);
    assert.equal((await s.kit.store.listOffers()).length, 0);
  });

  test('a key the owner did not flag instant is refused after /me, before the POST; a buy offer and an unknown mode are refused too', async () => {
    const s = await seller();
    s.w.board.keyInstant = false;
    await assert.rejects(s.kit.postOffer({ ...SELL, mode: 'instant' }), (e: unknown) => e instanceof SafetyError && e.code === 'MODE_NOT_SUPPORTED' && /not flagged for instant offers/.test(e.detail));
    assert.equal(s.w.board.count('GET', /\/me$/), 1);
    assert.equal(s.w.board.count('POST', /\/offers$/), 0);
    s.w.board.keyInstant = true;
    await assert.rejects(s.kit.postOffer({ ...SELL, side: 'buy', mode: 'instant' }), (e: unknown) => e instanceof SafetyError && e.code === 'MODE_NOT_SUPPORTED' && /sell offer/.test(e.detail));
    await assert.rejects(s.kit.postOffer({ ...SELL, mode: 'fast' as never }), (e: unknown) => e instanceof SafetyError && e.code === 'BAD_INPUT');
    assert.equal(s.w.board.count('POST', /\/offers$/), 0);
  });

  test('off unless the board\'s /config says instant trades are on: a board with them off, or one from before wave C, gets no /me and no POST', async () => {
    for (const on of [false, null] as const) {
      const s = await seller();
      s.w.board.instantOn = on;
      await assert.rejects(s.kit.postOffer({ ...SELL, mode: 'instant' }), (e: unknown) => e instanceof SafetyError && e.code === 'MODE_NOT_SUPPORTED' && /instant trades.*off/.test(e.detail), String(on));
      assert.equal(s.w.board.count('GET', /\/me$/), 0, String(on));
      assert.equal(s.w.board.count('POST', /\/offers$/), 0, String(on));
      assert.equal((await s.kit.store.listOffers()).length, 0, String(on));
      // A standard offer is not held back by it.
      const std = await s.kit.postOffer(SELL);
      assert.equal(std.mode, 'standard');
    }
  });

  test('with a flagged key the offer is posted as instant, kept as instant, and listed as instant', async () => {
    const s = await seller();
    const offer = await s.kit.postOffer({ ...SELL, mode: 'instant' });
    assert.equal(offer.mode, 'instant');
    assert.equal((await s.kit.store.getOffer(offer.id))?.mode, 'instant');
    const posted = s.w.board.calls.find((c) => c.method === 'POST' && c.path === '/v1/p2p/offers')!;
    assert.equal(posted.body.mode, 'instant');
    assert.equal(posted.key, API_KEY, 'the API key goes with the create');
    assert.equal(s.w.board.offers.get(offer.id)!.o.mode, 'instant');
    assertClean(s);
  });

  test('check 9: a board that lists the instant offer without its mode gets it cancelled at once (OFFER_ECHO)', async () => {
    const s = await seller();
    s.w.board.dropMode = true;
    await assert.rejects(s.kit.postOffer({ ...SELL, mode: 'instant' }), (e: unknown) => e instanceof SafetyError && e.code === 'OFFER_ECHO');
    assert.equal(s.w.board.count('POST', /\/offers\/\d+\/cancel$/), 1);
    const posted: NewOffer = { side: 'sell', symbol: 'TAZ', makerPha: X_P, makerBase: B_B, tazTotal: '1', tazMin: '1', tazMax: '1', price: '1', mode: 'instant' };
    const listed = { id: 1, network: 'devnet', side: 'sell', makerPha: X_P, makerBase: B_B, symbol: 'TAZ', tazTotal: '1', tazMin: '1', tazMax: '1', price: '1', remaining: '1', status: 'open', online: true, createdAt: T0, heartbeatAt: T0, closedAt: null } as Offer;
    assert.equal(echoProblem(listed, posted), 'mode', 'no mode listed');
    assert.equal(echoProblem({ ...listed, mode: 'standard' }, posted), 'mode');
    assert.equal(echoProblem({ ...listed, mode: 'instant' }, posted), null);
    assert.equal(echoProblem({ ...listed, mode: 'instant' }, { ...posted, mode: undefined }), 'mode', 'a standard offer listed as instant');
  });
});

// ── 3. Accepting, and the trade's mode ───────────────────────────────────────

describe('accepting an instant take (signs nothing) and the mode check (check 14)', () => {
  test('the take is accepted; then the bot waits for the buyer to lock first, sending nothing', async () => {
    const s = await acceptedInstant();
    const r = await s.kit.step(s.id, POLICY);
    assert.equal(r.outcome, 'waiting');
    assert.match(r.text ?? '', /buyer locks first/);
    assert.equal(sends(s.w), 0);
    assert.equal(s.w.base.sent.length, 0);
  });

  test('a take the board calls standard on an instant offer, or instant on a standard one, is never accepted (TRADE_MISMATCH)', async () => {
    const s = await seller();
    const inst = await s.kit.postOffer({ ...SELL, mode: 'instant' });
    const std = await s.kit.postOffer(SELL);
    const t1 = s.w.board.take(inst.id, TAZ2, { mode: 'standard' });
    const t2 = s.w.board.take(std.id, TAZ2, { mode: 'instant' });
    refusedWith(await s.kit.step(t1.id, POLICY), 'TRADE_MISMATCH');
    refusedWith(await s.kit.step(t2.id, POLICY), 'TRADE_MISMATCH');
    assert.equal(s.w.board.count('POST', /\/accept$/), 0);
    assert.equal(sends(s.w), 0);
  });

  test('a board that calls an accepted trade by another mode afterwards gets nothing locked or reported (TRADE_MISMATCH at every step)', async () => {
    const s = await seller();
    const std = await s.kit.postOffer(SELL);
    const t = s.w.board.take(std.id);
    const a = await s.kit.step(t.id, POLICY);
    assert.equal(a.outcome, 'done', JSON.stringify(a));
    assert.equal(s.w.board.trades.get(t.id)!.t.status, 'accepted');
    // The standard seller locks first; a board that now says "instant" (the buyer locks first) is not believed.
    s.w.board.trades.get(t.id)!.t.mode = 'instant';
    refusedWith(await s.kit.step(t.id, POLICY), 'TRADE_MISMATCH');
    assert.equal(sends(s.w), 0);
    assert.equal(s.w.board.count('POST', /\/pha-locked$/), 0);
    // And an instant trade the board calls standard once the buyer has locked is never locked behind.
    const i = await buyerLocked(60);
    i.w.board.trades.get(i.id)!.t.mode = 'standard';
    refusedWith(await i.kit.step(i.id, POLICY), 'TRADE_MISMATCH');
    assert.equal(sends(i.w), 0);
  });
});

// ── 4. Step 2: every check refuses with zero sends ───────────────────────────

describe('step 2 of section 3.10.3: the seller\'s checks before its lock, each refusing with zero sends', () => {
  test('a devnet lock read 60 s after t_B goes ahead: one lock, ending at T_P = now + I_PHA, then reported (/pha-locked)', async () => {
    const s = await buyerLocked(60);
    const now = s.w.vt.s;
    const r = await s.kit.step(s.id, POLICY);
    assert.equal(r.action, 'reportPhaLock', JSON.stringify(r));
    assert.equal(r.outcome, 'done');
    assert.equal(s.w.pha.count('lock'), 1);
    assert.equal(lockDeadline(s.w), now + ITM.I_PHA, 'T_P = now + I_PHA');
    const l = s.w.pha.locks.get(s.h)!;
    assert.deepEqual([l.state, l.sender, l.recipient, l.symbol, l.amount], [1, s.bot.pha, B_P, 'TAZ', TAZ2], 'locked behind the buyer\'s h, paying the buyer');
    assert.equal(s.w.board.trades.get(s.id)!.t.status, 'pha_locked', 'the board took the report: the lock keeps its time rules');
    const rec = (await s.kit.store.getTrade(s.id))!;
    assert.deepEqual([rec.h, rec.phaContract, rec.feeShown, rec.t1, rec.t2], [s.h, 'saturnescrow', 50, now + ITM.I_PHA, s.TB], 'h, the escrow, the fee shown, T_P and T_B recorded');
    assert.equal(s.w.base.sent.length, 0, 'nothing on Base');
    assertClean(s, [s.x]);
  });

  test('one read at 200 s after t_B is refused (INSTANT_LATE, the limit is 180 s): zero sends, and never later either', async () => {
    const s = await buyerLocked(200);
    const r = refusedWith(await s.kit.step(s.id, POLICY), 'INSTANT_LATE');
    assert.equal(r.retry, false);
    assert.match(r.text ?? '', /mined 200 s ago/);
    assert.equal(sends(s.w), 0);
    s.w.vt.ms += 30_000;
    refusedWith(await s.kit.step(s.id, POLICY), 'INSTANT_LATE');
    assert.equal(sends(s.w), 0);
    assert.equal(s.w.pha.locks.size, 0);
  });

  test('T_B - now under I_PHA + I_SAFETY (INSTANT_SHORT): zero sends', async () => {
    // A buyer lock that ends 1,530 s after t_B: read at t_B + 60 s, 1,470 s are left (1,500 needed).
    const s = await acceptedInstant();
    s.w.vt.ms += 4_000;
    const lock = s.w.board.buyerLocks(s.id, { deadline: s.w.base.blockTime(s.w.base.head) + 1530 });
    s.w.vt.at(lock.tB + 60);
    const r = refusedWith(await s.kit.step(s.id, POLICY), 'INSTANT_SHORT');
    assert.match(r.text ?? '', /ends in 1470 s/);
    assert.equal(sends(s.w), 0);
  });

  test('the swap (h, B_b): not on Base, another token, another amount, another claimer, a higher fee (INSTANT_BUYER_LOCK): zero sends each', async () => {
    const cases: Array<[string, Parameters<FakeBoard['buyerLocks']>[1], RegExp]> = [
      ['not on chain', { onChain: false }, /not locked the USDC on Base yet/],
      ['another token', { token: '0x' + 'ee'.repeat(20) }, /another token/],
      ['another amount', { amount: USDC2 - 1n }, /different amount/],
      ['another claimer', { claimer: '0x' + 'c3'.repeat(20) }, /pays another address/],
      ['a higher fee', { feeBps: 60 }, /higher fee/]
    ];
    for (const [what, o, re] of cases) {
      const s = await buyerLocked(60, o);
      const r = refusedWith(await s.kit.step(s.id, POLICY), 'INSTANT_BUYER_LOCK');
      assert.match(r.text ?? '', re, what);
      assert.equal(sends(s.w), 0, what);
    }
  });

  test('a buyer lock not confirmed yet waits (INSTANT_BUYER_LOCK, retry), then goes ahead once confirmed', async () => {
    const s = await acceptedInstant();
    s.w.vt.ms += 4_000;
    const lock = s.w.board.buyerLocks(s.id);
    s.w.vt.at(lock.tB + 2);
    const r = refusedWith(await s.kit.step(s.id, POLICY), 'INSTANT_BUYER_LOCK');
    assert.equal(r.retry, true);
    assert.match(r.text ?? '', /waiting for confirmations/);
    assert.equal(sends(s.w), 0);
    s.w.vt.at(lock.tB + 12);
    assert.equal((await s.kit.step(s.id, POLICY)).outcome, 'done');
    assert.equal(s.w.pha.count('lock'), 1);
  });

  test('getState(h) != 0: a lock of someone else under the buyer\'s h (a squat) is never locked behind (HASH_TAKEN): zero sends', async () => {
    const s = await buyerLocked(60);
    s.w.pha.locks.set(s.h, { state: 1, sender: X_P, recipient: X_P, symbol: 'KCAL', amount: 10n ** 10n, deadline: s.w.vt.s + 900, created: s.w.vt.s - 10 });
    const r = refusedWith(await s.kit.step(s.id, POLICY), 'HASH_TAKEN');
    assert.match(r.text ?? '', /hash squat/);
    assert.equal(sends(s.w), 0);
  });

  test('the code pin, the open cap (full, and unreadable), the balance and the SOUL reserve: each refuses with zero sends', async () => {
    const cases: Array<[string, (w: World, bot: Bot) => void, string]> = [
      ['another escrow script', (w) => { w.pha.script = w.pha.script.slice(0, -2) + '00'; }, 'CODE_PIN'],
      ['another escrow admin', (w) => { w.pha.admin = X_P; }, 'CODE_PIN'],
      ['the open cap full', (w) => { w.pha.caps.TAZ = { open: 10n ** 12n - TAZ2 + 1n, max: 10n ** 12n }; }, 'OPEN_CAP'],
      ['the open cap unreadable', (w) => { w.pha.failViews.add('getOpenAmount'); }, 'OPEN_CAP_UNREAD'],
      ['too few tokens', (w, bot) => { w.pha.bals.set(bot.pha, [{ symbol: 'TAZ', amount: '1000000000', decimals: 9 }, { symbol: 'SOUL', amount: '500000000', decimals: 8 }]); }, 'SELLER_FUNDS'],
      ['too little SOUL', (w, bot) => { w.pha.bals.set(bot.pha, [{ symbol: 'TAZ', amount: (100n * 10n ** 9n).toString(), decimals: 9 }, { symbol: 'SOUL', amount: '100000000', decimals: 8 }]); }, 'SOUL_LOW']
    ];
    for (const [what, spoil, code] of cases) {
      const s = await buyerLocked(60);
      spoil(s.w, s.bot);
      refusedWith(await s.kit.step(s.id, POLICY), code);
      assert.equal(sends(s.w), 0, what);
    }
  });

  test('S_b blacklisted (check 56, where the token has a blacklist): refused before the lock; devnet\'s MockUSDC has none, so nothing is read there', async () => {
    const reads: string[] = [];
    const guardOf = (g: { blacklisted: boolean; swapBlacklisted: boolean; paused: boolean } | 'fail') => ({
      network: 'devnet', base: { readUsdcGuard: async (a: string) => { reads.push(a); if (g === 'fail') throw new Error('rpc down'); return g; } }
    } as unknown as CheckDeps);
    const fiat = { base: { ...CFG.base, usdcHasBlacklist: true } };
    const sb = '0x' + '5a'.repeat(20);
    const clean = { blacklisted: false, swapBlacklisted: false, paused: false };
    assert.equal(await checks.instantGuardProblem(guardOf(clean), fiat, sb), null);
    const bl = await checks.instantGuardProblem(guardOf({ ...clean, blacklisted: true }), fiat, sb);
    assert.equal(bl?.code, 'USDC_GUARD');
    assert.equal(bl?.check, 56);
    assert.match(bl!.text, /blacklisted this kit's Base address/);
    assert.equal((await checks.instantGuardProblem(guardOf({ ...clean, swapBlacklisted: true }), fiat, sb))?.code, 'USDC_GUARD');
    assert.equal((await checks.instantGuardProblem(guardOf({ ...clean, paused: true }), fiat, sb))?.retry, true);
    assert.equal((await checks.instantGuardProblem(guardOf('fail'), fiat, sb))?.code, 'USDC_GUARD', 'a failed read refuses');
    assert.deepEqual(reads, [sb, sb, sb, sb, sb], 'S_b is the address read');
    reads.length = 0;
    assert.equal(await checks.instantGuardProblem(guardOf({ ...clean, blacklisted: true }), CFG, sb), null, 'devnet: MockUSDC has no blacklist');
    assert.deepEqual(reads, []);
  });

  test('the board not at base_locked yet (INSTANT_START, retry) and the kit\'s own lock already there (reported, never locked again)', async () => {
    const s = await acceptedInstant();
    const deps = depsOf(s);
    const trade = structuredClone(s.w.board.trades.get(s.id)!.t);
    const rec = (await s.kit.store.getTrade(s.id))!;
    const offer = (await s.kit.store.getOffer(s.offer.id))!;
    const r = await checks.instantSellerLock(deps, trade, rec, offer);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.problem.code, 'INSTANT_START');
      assert.equal(r.problem.retry, true);
    }
    const r2 = await checks.instantSellerLock(deps, trade, rec, { ...offer, mode: 'standard' });
    assert.equal(!r2.ok && r2.problem.code, 'INSTANT_START', 'only on the kit\'s own instant offer');
    assert.equal(sends(s.w), 0);
  });
});

/** Check deps over the seller's own store and the fakes (for calling the checks and the signer directly). */
function depsOf(s: Seller): CheckDeps {
  return {
    network: 'devnet', pha: new PhaReader(s.w.pha, 'devnet'), base: new BaseReader(s.w.base, 'devnet'), store: s.kit.store,
    board: { trade: (id: number) => s.kit.board.trade(id, { retries: 0 }) }, address: s.kit.address, now: s.w.vt.now
  };
}

async function signerOf(s: Seller): Promise<Signer> {
  const keys = await loadKeys({ network: 'devnet', phaKeyFile: s.bot.phaKeyFile, baseKeyFile: s.bot.baseKeyFile, argv: ['node', 'bot.ts'] });
  return createSigner({ keys, pha: s.w.pha, base: s.w.base, store: s.kit.store, now: s.w.vt.now, sleep: async () => {}, wait: { phaTries: 1, phaIntervalMs: 0, baseTimeoutMs: 1, basePollMs: 1 } });
}

// ── 5. The re-checks right before signing ────────────────────────────────────

describe('the re-checks right before the lock is signed (checks 31 and 33)', () => {
  test('checked at t_B + 170 s, signed at t_B + 181 s: the signer refuses (INSTANT_LATE), zero sends', async () => {
    const s = await buyerLocked(170);
    const deps = depsOf(s);
    const r = await checks.instantSellerLock(deps, structuredClone(s.w.board.trades.get(s.id)!.t), (await s.kit.store.getTrade(s.id))!, (await s.kit.store.getOffer(s.offer.id))!);
    assert.equal(r.ok, true, r.ok ? '' : r.problem.text);
    if (!r.ok) return;
    s.w.vt.ms += 11_000;
    const signer = await signerOf(s);
    await assert.rejects(signer.lockPha(r.intent), (e: unknown) => e instanceof SignRefusal && e.code === 'INSTANT_LATE');
    assert.equal(sends(s.w), 0);
  });

  test('a squat that lands between the checks and the signature: the signer refuses (HASH_TAKEN), zero sends', async () => {
    const s = await buyerLocked(60);
    const deps = depsOf(s);
    const r = await checks.instantSellerLock(deps, structuredClone(s.w.board.trades.get(s.id)!.t), (await s.kit.store.getTrade(s.id))!, (await s.kit.store.getOffer(s.offer.id))!);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    s.w.pha.locks.set(s.h, { state: 1, sender: X_P, recipient: X_P, symbol: 'KCAL', amount: 10n ** 10n, deadline: s.w.vt.s + 900, created: s.w.vt.s });
    await assert.rejects((await signerOf(s)).lockPha(r.intent), (e: unknown) => e instanceof SignRefusal && e.code === 'HASH_TAKEN');
    assert.equal(sends(s.w), 0);
  });

  test('a token the escrow takes no locks of (its largest lock reads 0): refused (ESCROW_PARAMS) before anything is signed, zero sends', async () => {
    const s = await buyerLocked(60);
    const sym = (await s.kit.store.getTrade(s.id))!.symbol;
    s.w.pha.bounds[sym] = { min: s.w.pha.bounds[sym]!.min, max: 0n };
    const r = await checks.instantSellerLock(depsOf(s), structuredClone(s.w.board.trades.get(s.id)!.t), (await s.kit.store.getTrade(s.id))!, (await s.kit.store.getOffer(s.offer.id))!);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.problem.code, 'ESCROW_PARAMS');
    assert.match(r.problem.text, /is not enabled in the P2P escrow on Phantasma right now/);
    assert.equal(sends(s.w), 0);
  });

  test('a squat mined between the signer\'s re-check and its lock (P2:used): no new secret is made for the buyer\'s hash, and the next step refuses', async () => {
    const s = await buyerLocked(60);
    const deps = depsOf(s);
    const r = await checks.instantSellerLock(deps, structuredClone(s.w.board.trades.get(s.id)!.t), (await s.kit.store.getTrade(s.id))!, (await s.kit.store.getOffer(s.offer.id))!);
    assert.equal(r.ok, true, r.ok ? '' : r.problem.text);
    if (!r.ok) return;
    const before = (await s.kit.store.secretsOfTrade(s.id)).length;
    // The squatter's lock lands just before the kit's: the escrow answers P2:used.
    const pha = s.w.pha;
    const send = pha.sendRaw.bind(pha);
    pha.sendRaw = async (hex: string) => {
      pha.locks.set(s.h, { state: 1, sender: X_P, recipient: X_P, symbol: 'KCAL', amount: 10n ** 10n, deadline: s.w.vt.s + 900, created: s.w.vt.s });
      return send(hex);
    };
    const keys = await loadKeys({ network: 'devnet', phaKeyFile: s.bot.phaKeyFile, baseKeyFile: s.bot.baseKeyFile, argv: ['node', 'bot.ts'] });
    const lines: string[] = [];
    const signer = createSigner({ keys, pha, base: s.w.base, store: s.kit.store, now: s.w.vt.now, sleep: async () => {}, log: (l: string) => { lines.push(l); }, wait: { phaTries: 1, phaIntervalMs: 0, baseTimeoutMs: 1, basePollMs: 1 } });
    const out = await signer.lockPha(r.intent);
    assert.equal(out.outcome, 'failed');
    assert.equal(out.secretReplaced, undefined, 'the buyer\'s hash: nothing of the kit\'s own to replace');
    assert.equal((await s.kit.store.secretsOfTrade(s.id)).length, before, 'no secret was made for the trade');
    assert.ok(lines.some((l) => /the hash is the buyer's \(an instant trade\), so no new secret is made/.test(l)), lines.join('\n'));
    assert.ok(!lines.some((l) => /a new secret is kept for the next try/.test(l)));
    // The next step sees the squat and refuses before any send.
    pha.sendRaw = send;
    const sentBefore = sends(s.w);
    const next = refusedWith(await s.kit.step(s.id, POLICY), 'HASH_TAKEN');
    assert.match(next.text ?? '', /hash squat/);
    assert.equal(sends(s.w), sentBefore);
  });

  test('the board moves the trade on (refunding) after the checks: the signer refuses (TRADE_CHANGED), zero sends', async () => {
    const s = await buyerLocked(60);
    const deps = depsOf(s);
    const r = await checks.instantSellerLock(deps, structuredClone(s.w.board.trades.get(s.id)!.t), (await s.kit.store.getTrade(s.id))!, (await s.kit.store.getOffer(s.offer.id))!);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    s.w.board.trades.get(s.id)!.t.status = 'refunding';
    await assert.rejects((await signerOf(s)).lockPha(r.intent), (e: unknown) => e instanceof SignRefusal && e.code === 'TRADE_CHANGED');
    assert.equal(sends(s.w), 0);
  });
});

// ── 6. After the lock: watch, claim, refund ──────────────────────────────────

/** Step the bot as run() would: each step at the time its result asks for. `inject` runs before a step when its time has come. */
async function stepLoop(s: Seller & { id: number }, until: (r: StepResult) => boolean, o: { max?: number; inject?: { at: number; run: () => void } } = {}): Promise<StepResult[]> {
  const out: StepResult[] = [];
  let injected = false;
  for (let i = 0; i < (o.max ?? 400); i++) {
    const r = await s.kit.step(s.id, POLICY);
    out.push(r);
    if (until(r)) return out;
    let next = Math.max(r.nextAt, s.w.vt.ms + 1);
    if (o.inject && !injected && next > o.inject.at * 1000) {
      s.w.vt.at(o.inject.at);
      o.inject.run();
      injected = true;
      next = Math.max(next, s.w.vt.ms);
    }
    s.w.vt.ms = next;
    await settle(1);
  }
  assert.fail(`trade #${s.id} did not get there: last step ${JSON.stringify(out.at(-1))}`);
}

describe('after the lock: getState(h) every <= 15 s, the USDC claim once Phantasma reads claimed, the refund after T_P', () => {
  test('end to end: lock, report, watch with zero USDC claims while Phantasma reads locked, the keeper claims on Phantasma, the bot claims the USDC once (simulated first), and finishes', async () => {
    const s = await buyerLocked(30);
    const lockAt = s.w.vt.s;
    assert.equal((await s.kit.step(s.id, POLICY)).action, 'reportPhaLock');
    const TP = lockAt + ITM.I_PHA;
    // Watch for 3 minutes: every step is a wait at most 15 s ahead, and nothing goes to Base.
    s.w.pha.stateReads.length = 0;
    const until = (lockAt + 180) * 1000;
    while (s.w.vt.ms < until) {
      const r = await s.kit.step(s.id, POLICY);
      assert.equal(r.outcome, 'waiting', JSON.stringify(r));
      assert.ok(r.nextAt - s.w.vt.ms <= 15_000 && r.nextAt > s.w.vt.ms, `the next read is ${r.nextAt - s.w.vt.ms} ms away`);
      assert.match(r.text ?? '', /buyer's code to open/);
      s.w.vt.ms = r.nextAt;
    }
    assert.equal(s.w.base.sent.length, 0, 'no USDC claim while the Phantasma lock reads locked');
    assert.ok(s.w.pha.stateReads.length >= 12);
    // The buyer reveals; the keeper claims the buyer's tokens on Phantasma (its code is now public there).
    s.w.board.keeperClaimsPha(s.id);
    const c = await s.kit.step(s.id, POLICY);
    assert.equal(c.action, 'claimBase', JSON.stringify(c));
    assert.equal(c.outcome, 'done');
    assert.equal(s.w.base.count('claim'), 1);
    const iSend = s.w.base.order.indexOf('send:claim');
    assert.ok(iSend > 0 && s.w.base.order.slice(0, iSend).includes('call:claim'), `simulated before it was sent: ${s.w.base.order.join(', ')}`);
    assert.equal(s.w.base.swapAt(s.h, B_B).state, 2);
    assert.ok(s.w.vt.s < TP, 'claimed while the Phantasma lock still ran');
    // The code it claimed with is the buyer's, kept with the trade (made by the buyer: role B).
    const sec = (await s.kit.store.getSecret(s.h))!;
    assert.deepEqual([sec.secret, sec.role, sec.tradeId, sec.bPha, sec.sPha], [s.x, 'B', s.id, B_P, s.bot.pha]);
    // Once the claim is confirmed, the bot is done.
    s.w.vt.ms += 10_000;
    const f = await s.kit.step(s.id, POLICY);
    assert.equal(f.outcome, 'finished', JSON.stringify(f));
    assert.equal(s.w.pha.count('lock'), 1);
    assert.equal(s.w.pha.count('claim') + s.w.pha.count('refund'), 0, 'the bot never claims or refunds on Phantasma in a finished trade');
    assert.equal(s.w.board.count('POST', /\/reveal$/), 0, 'a seller never reveals in an instant trade');
    assert.equal(s.w.base.usdc.get(s.bot.base), USDC2 - (USDC2 * 50n) / 10_000n, 'the seller is paid the USDC less the fee');
    assertClean(s, [s.x]);
  });

  test('getState(h) is read at least every 15 s from the lock until T_P has passed (no claim on Phantasma), then the tokens are refunded after T_P + 60 s', async () => {
    const s = await buyerLocked(30);
    const lockAt = s.w.vt.s;
    assert.equal((await s.kit.step(s.id, POLICY)).action, 'reportPhaLock');
    const TP = lockAt + ITM.I_PHA;
    s.w.pha.stateReads.length = 0;
    const steps = await stepLoop(s, (r) => r.action === 'refundPha');
    const reads = [lockAt, ...s.w.pha.stateReads.filter((t) => t <= TP + 60)];
    for (let i = 1; i < reads.length; i++) assert.ok(reads[i]! - reads[i - 1]! <= 15, `getState(h) read ${reads[i]! - reads[i - 1]!} s after the last read`);
    assert.ok(reads.at(-1)! >= TP, 'read up to T_P');
    const refund = steps.at(-1)!;
    assert.equal(refund.outcome, 'done', JSON.stringify(refund));
    assert.ok(s.w.vt.s >= TP + 60, 'the refund goes out at T_P + 60 s or later');
    assert.equal(s.w.pha.count('refund'), 1);
    assert.equal(s.w.base.sent.length, 0, 'never a USDC claim: the Phantasma lock never read claimed');
    assert.equal(s.w.pha.locks.get(s.h)!.state, 3);
    s.w.vt.ms += 2_000;
    assert.equal((await s.kit.step(s.id, POLICY)).outcome, 'finished');
  });

  test('a claim on Phantasma at T_P - 1 s still leads to the USDC claim, while T_B - now >= 60 s', async () => {
    const s = await buyerLocked(30);
    const lockAt = s.w.vt.s;
    await s.kit.step(s.id, POLICY);
    const TP = lockAt + ITM.I_PHA;
    const steps = await stepLoop(s, (r) => r.action === 'claimBase' && r.outcome === 'done', { inject: { at: TP - 1, run: () => s.w.board.keeperClaimsPha(s.id) } });
    const claimedAt = s.w.vt.s;
    assert.ok(claimedAt > TP - 1 && claimedAt <= TP - 1 + 15, `the USDC claim went out ${claimedAt - (TP - 1)} s after the Phantasma claim`);
    assert.ok(s.TB - claimedAt >= INSTANT_RULES.claimMin, 'with at least 60 s left on the USDC lock');
    assert.equal(s.w.base.count('claim'), 1);
    assert.equal(s.w.pha.count('refund'), 0, 'no refund: the lock was claimed');
    assert.ok(steps.every((r) => r.action !== 'refundPha'));
  });

  test('instantClaim: never while the Phantasma lock reads locked (PHA_NOT_CLAIMED); refused with less than 60 s left on the USDC lock, allowed at exactly 60 s', async () => {
    const s = await buyerLocked(30);
    await s.kit.step(s.id, POLICY);
    const deps = depsOf(s);
    const rec = async () => (await s.kit.store.getTrade(s.id))!;
    const r1 = await checks.instantClaim(deps, await rec());
    assert.equal(!r1.ok && r1.problem.code, 'PHA_NOT_CLAIMED');
    assert.equal(!r1.ok && r1.problem.check, 59);
    assert.equal(await s.kit.store.getSecret(s.h), null, 'nothing kept before the code is public');
    s.w.board.keeperClaimsPha(s.id);
    s.w.vt.at(s.TB - 59);
    const r2 = await checks.instantClaim(deps, await rec());
    assert.equal(!r2.ok && r2.problem.code, 'INSTANT_CLAIM');
    assert.match(!r2.ok ? r2.problem.text : '', /at least 60 s are left/);
    s.w.vt.at(s.TB - 60);
    const r3 = await checks.instantClaim(deps, await rec());
    assert.equal(r3.ok, true, r3.ok ? '' : r3.problem.text);
    if (r3.ok) assert.equal(r3.intent.facts.minLeft, 60);
    assert.equal(s.w.base.sent.length, 0, 'nothing was sent on Base');
    assert.equal(s.w.pha.sent.length, 1, 'only the lock was ever sent');
  });

  test('a USDC claim not mined yet is never taken back while the USDC lock runs (its secret is public: mined late it only reverts); after T_B its nonce is freed', async () => {
    const s = await buyerLocked(30);
    assert.equal((await s.kit.step(s.id, POLICY)).action, 'reportPhaLock');
    s.w.board.keeperClaimsPha(s.id);
    s.w.base.stuck = true;
    const c = await s.kit.step(s.id, POLICY);
    assert.equal(c.action, 'claimBase', JSON.stringify(c));
    assert.equal(c.outcome, 'pending', JSON.stringify(c));
    assert.equal(s.w.base.count('claim'), 1);
    const sent = s.w.base.sent.length;
    // 50 s before T_B no claim may go out any more (under 60 s left), but the one in flight is left to be mined.
    s.w.vt.at(s.TB - 50);
    const r = await s.kit.step(s.id, POLICY);
    assert.equal(r.action, 'claimBase', JSON.stringify(r));
    assert.equal(r.outcome, 'pending', JSON.stringify(r));
    assert.ok(r.nextAt <= s.TB * 1000 && r.nextAt > s.w.vt.ms, JSON.stringify(r));
    assert.equal(s.w.base.sent.length, sent, 'no 0-value transfer takes its nonce back, and no replacement goes out');
    // After T_B the claim can only revert: its nonce is taken back with a 0-value transfer to the bot itself.
    s.w.base.stuck = false;
    s.w.vt.at(s.TB + 1);
    const x = await s.kit.step(s.id, POLICY);
    assert.equal(x.action, 'cancelBase', JSON.stringify(x));
    assert.equal(s.w.base.sent.length, sent + 1);
    const t = parseTransaction(s.w.base.sent.at(-1)!);
    assert.equal(t.to?.toLowerCase(), s.bot.base);
    assert.equal(t.value ?? 0n, 0n);
    assert.equal(s.w.base.count('claim'), 1, 'one claim only');
    assertClean(s, [s.x]);
  });

  test('the keeper claims the USDC first (public-secret path): done elsewhere, no claim of the bot\'s own', async () => {
    const s = await buyerLocked(30);
    await s.kit.step(s.id, POLICY);
    s.w.board.keeperClaimsPha(s.id);
    s.w.base.claimDirect(s.h, B_B, s.x);
    s.w.vt.ms += 10_000;
    const r = await s.kit.step(s.id, POLICY);
    assert.equal(r.outcome, 'finished', JSON.stringify(r));
    assert.equal(s.w.base.sent.length, 0);
  });
});

// ── 7. Crash safety ──────────────────────────────────────────────────────────

describe('crash safety', () => {
  test('a lock whose answer was lost is resolved from the chain and reported, never sent again', async () => {
    const s = await buyerLocked(30);
    s.w.pha.modes.push('drop');
    const r1 = await s.kit.step(s.id, POLICY);
    assert.equal(r1.outcome, 'pending', JSON.stringify(r1));
    assert.equal(s.w.pha.count('lock'), 1);
    assert.equal(s.w.board.trades.get(s.id)!.t.status, 'base_locked');
    s.w.vt.ms += 5_000;
    const r2 = await s.kit.step(s.id, POLICY);
    assert.equal(r2.action, 'reportPhaLock', JSON.stringify(r2));
    assert.equal(r2.outcome, 'done');
    assert.equal(s.w.pha.count('lock'), 1, 'never sent again');
    assert.equal(s.w.board.trades.get(s.id)!.t.status, 'pha_locked');
  });
});

// ── 8. The bot's own bookkeeping ─────────────────────────────────────────────

describe('the bot\'s own bookkeeping around its instant locks', () => {
  test('the tokens of an instant trade that holds the buyer\'s h but sent no lock yet still count as committed: a second take is not accepted past the balance', async () => {
    const s = await buyerLocked(60);
    // 3 TAZ: enough for one 2 TAZ lock, not for two.
    s.w.pha.bals.set(s.bot.pha, [
      { symbol: 'TAZ', amount: (3n * 10n ** 9n).toString(), decimals: 9 },
      { symbol: 'SOUL', amount: (5n * 10n ** 8n).toString(), decimals: 8 },
      { symbol: 'KCAL', amount: (10n * 10n ** 10n).toString(), decimals: 10 }
    ]);
    // The checks pass and keep the buyer's h with the trade; nothing is signed (as when a re-check refuses before the send).
    const r = await checks.instantSellerLock(depsOf(s), structuredClone(s.w.board.trades.get(s.id)!.t), (await s.kit.store.getTrade(s.id))!, (await s.kit.store.getOffer(s.offer.id))!);
    assert.equal(r.ok, true, r.ok ? '' : r.problem.text);
    const kept = (await s.kit.store.getTrade(s.id))!;
    assert.equal(kept.h, s.h);
    assert.equal(kept.txs.phaLock, undefined);
    const t2 = s.w.board.take(s.offer.id);
    const a = await s.kit.step(t2.id, POLICY);
    assert.equal(a.action, 'accept', JSON.stringify(a));
    assert.equal(a.outcome, 'waiting', JSON.stringify(a));
    assert.match(a.text ?? '', /other trades that are not locked yet/);
    assert.equal(s.w.board.trades.get(t2.id)!.t.status, 'requested', 'not accepted');
    assert.equal(sends(s.w), 0);
    // Once the first lock is on chain, its tokens have left the balance: the second take is judged on what is left.
    assert.equal((await s.kit.step(s.id, POLICY)).action, 'reportPhaLock');
    s.w.pha.bals.set(s.bot.pha, [
      { symbol: 'TAZ', amount: (3n * 10n ** 9n).toString(), decimals: 9 },
      { symbol: 'SOUL', amount: (5n * 10n ** 8n).toString(), decimals: 8 },
      { symbol: 'KCAL', amount: (10n * 10n ** 10n).toString(), decimals: 10 }
    ]);
    const a2 = await s.kit.step(t2.id, POLICY);
    assert.equal(a2.outcome, 'done', JSON.stringify(a2));
    assert.equal(s.w.board.trades.get(t2.id)!.t.status, 'accepted');
  });

  test('a lock report the board refuses for good is sent again at most once a minute, while getState(h) is still read every <= 15 s and the USDC claim is not held up', async () => {
    const s = await buyerLocked(30);
    s.w.board.refuseReport = true;
    const r1 = await s.kit.step(s.id, POLICY);
    assert.equal(r1.action, 'reportPhaLock', JSON.stringify(r1));
    assert.equal(r1.outcome, 'failed');
    assert.equal(r1.code, 'MISMATCH');
    assert.ok(r1.nextAt - s.w.vt.ms <= 15_000, 'the watch starts with the lock, whatever the board answered');
    assert.equal(s.w.pha.count('lock'), 1);
    const lockAt = s.w.vt.s;
    s.w.vt.ms = r1.nextAt;
    s.w.pha.stateReads.length = 0;
    while (s.w.vt.ms < (lockAt + 150) * 1000) {
      const r = await s.kit.step(s.id, POLICY);
      assert.ok(r.nextAt - s.w.vt.ms <= 15_000 && r.nextAt > s.w.vt.ms, `the next read is ${r.nextAt - s.w.vt.ms} ms away: ${JSON.stringify(r)}`);
      s.w.vt.ms = r.nextAt;
    }
    const reads = [lockAt, ...s.w.pha.stateReads];
    for (let i = 1; i < reads.length; i++) assert.ok(reads[i]! - reads[i - 1]! <= 15, `getState(h) read ${reads[i]! - reads[i - 1]!} s after the last read`);
    assert.equal(s.w.board.count('POST', /\/pha-locked$/), 3, 'reported at the lock, then about once a minute (150 s)');
    assert.equal(s.w.base.sent.length, 0);
    s.w.board.keeperClaimsPha(s.id);
    const c = await s.kit.step(s.id, POLICY);
    assert.equal(c.action, 'claimBase', JSON.stringify(c));
    assert.equal(c.outcome, 'done');
    assert.equal(s.w.base.count('claim'), 1);
    assertClean(s, [s.x]);
  });
});

// ── 9. run(): the instant lane ───────────────────────────────────────────────

/** 3 TAZ with the SOUL and KCAL reserves: enough for one 2 TAZ lock, not for two. */
function threeTaz(w: World, pha: string, taz = 3n): void {
  w.pha.bals.set(pha, [
    { symbol: 'TAZ', amount: (taz * 10n ** 9n).toString(), decimals: 9 },
    { symbol: 'SOUL', amount: (5n * 10n ** 8n).toString(), decimals: 8 },
    { symbol: 'KCAL', amount: (10n * 10n ** 10n).toString(), decimals: 10 }
  ]);
}

describe('run(): instant trades are stepped apart from the bot\'s other trades (build spec section 3.10.3 step 4)', () => {
  test('standard trades hold the trade loop 180 s per step; the instant trade still locks within seconds of t_B, getState(h) is read every <= 15 s from the lock, and a claim on Phantasma at T_P - 1 s leads to exactly one USDC claim', async () => {
    const s = await seller({ virtual: true });
    const w = s.w;
    w.vt.idle = settledWith(s.kit.store);
    const policy: Policy = { acceptAfterS: 0, maxOpenTrades: 10 };
    const instOffer = await s.kit.postOffer({ ...SELL, mode: 'instant' });
    const stdOffer = await s.kit.postOffer(SELL);
    // Each standard lock takes 180 s to be confirmed on Phantasma, so each of their lock steps holds the trade loop for
    // 180 s, as a Base send waiting to be mined would. The instant lock (under the buyer's h) is confirmed at once.
    let instantH: string | null = null;
    w.pha.slowFor = (call) => (call?.method === 'lock' && decimalToHex(call.args[1]) !== instantH ? 180_000 : 0);
    for (let i = 0; i < 3; i++) {
      const t = w.board.take(stdOffer.id);
      const r = await s.kit.step(t.id, policy);
      assert.equal(r.action, 'accept', JSON.stringify(r));
      assert.equal(r.outcome, 'done', JSON.stringify(r));
    }
    const it = w.board.take(instOffer.id);
    assert.equal((await s.kit.step(it.id, policy)).outcome, 'done');
    const ctl = new AbortController();
    const run = s.kit.run(policy, ctl.signal);
    let ended = false;
    void run.then(() => { ended = true; }, () => { ended = true; });
    const tick = (n = 1) => w.vt.advance(n * 1000);
    await tick(20);
    assert.equal(w.pha.slow.size, 1, 'the trade loop waits on its first standard lock');
    // The buyer locks its USDC first; the bot's lock goes out within seconds, while the trade loop still waits.
    const b = w.board.buyerLocks(it.id);
    instantH = b.h;
    let lockedAt: number | null = null;
    for (let i = 0; i < 60 && lockedAt === null; i++) {
      await tick();
      if (w.pha.locks.has(b.h)) lockedAt = w.vt.s;
    }
    // Within seconds: the buyer's lock is read at the confirmed block first (3 blocks), and a check that waits for it is
    // tried again 10 s later. A serial trade loop would reach the trade only after the standard lock it waits on.
    assert.ok(lockedAt !== null && lockedAt - b.tB <= 30, `the instant lock went out ${lockedAt === null ? 'never' : `${lockedAt - b.tB} s after t_B`}`);
    assert.ok(w.pha.slowLog.some((x) => x.sent <= b.tB * 1000 && x.at >= lockedAt! * 1000), 'while the trade loop was inside a 180 s step');
    // Reported once the lock reads on chain as this trade's own (the signer reads its outcome 2.5 s after the send).
    await tick(5);
    assert.equal(w.board.trades.get(it.id)!.t.status, 'pha_locked', 'reported');
    const TP = w.pha.locks.get(b.h)!.deadline;
    // The watch runs to T_P - 1 s while the trade loop steps its standard trades 180 s at a time (three more takes come in
    // half way, adopted from the heartbeats); then the buyer claims.
    let more = false;
    while (w.vt.ms < (TP - 1) * 1000) {
      if (!more && w.vt.s >= b.tB + 450) {
        more = true;
        for (let i = 0; i < 3; i++) w.board.take(stdOffer.id);
      }
      await w.vt.advance(Math.min(1_000, (TP - 1) * 1000 - w.vt.ms));
    }
    assert.equal(w.base.sent.length, 0, 'no USDC claim while the Phantasma lock read locked');
    w.board.keeperClaimsPha(it.id);
    for (let i = 0; i < 30 && w.base.count('claim') === 0; i++) await tick();
    const claimedAt = w.vt.s;
    assert.equal(w.base.count('claim'), 1, 'the bot claimed the USDC itself (nobody else did)');
    assert.ok(claimedAt - (TP - 1) <= 15, `the USDC claim went out ${claimedAt - (TP - 1)} s after the claim on Phantasma`);
    assert.ok(b.TB - claimedAt >= INSTANT_RULES.claimMin, 'with at least 60 s left on the USDC lock');
    // All the while, the trade loop was inside its 180 s steps, but for its accepts and reports between two of them.
    const busy = w.pha.slowLog.reduce((sum, x) => sum + Math.max(0, Math.min(x.at, claimedAt * 1000) - Math.max(x.sent, lockedAt! * 1000)), 0) / 1000;
    assert.ok(busy >= 0.9 * (claimedAt - lockedAt!), `the trade loop was inside its 180 s steps for ${busy} of the ${claimedAt - lockedAt!} s from the lock to the USDC claim`);
    const reads = (w.pha.stateReadsOf.get(b.h) ?? []).filter((x) => x >= lockedAt! && x <= claimedAt);
    const gaps = reads.slice(1).map((x, i) => x - reads[i]!);
    assert.ok(reads.length >= 60, `getState(h) read ${reads.length} times`);
    assert.ok(Math.max(...gaps) <= 15, `getState(h) read up to ${Math.max(...gaps)} s after the last read`);
    // Once the claim is confirmed the trade is finished, with one claim.
    for (let i = 0; i < 60 && !(await s.kit.store.getTrade(it.id))?.endedAt; i++) await tick();
    assert.ok((await s.kit.store.getTrade(it.id))?.endedAt, 'the instant trade finished');
    assert.equal(w.base.count('claim'), 1, 'exactly one USDC claim');
    assert.equal(w.pha.count('claim') + w.pha.count('refund'), 0);
    // A stop returns once the trade loop's own step has ended (it waits on a standard lock).
    ctl.abort();
    for (let i = 0; i < 400 && !ended; i++) await tick();
    await run;
    assertClean(s, [b.x]);
  });

  test('two takes accepted at the same moment (the lane steps trades side by side) never count the same tokens: with enough for one lock, one is accepted and the other waits', async () => {
    const s = await seller();
    const offer = await s.kit.postOffer({ ...SELL, mode: 'instant' });
    threeTaz(s.w, s.bot.pha);
    const t1 = s.w.board.take(offer.id), t2 = s.w.board.take(offer.id);
    const rs = await Promise.all([s.kit.step(t1.id, POLICY), s.kit.step(t2.id, POLICY)]);
    assert.deepEqual(rs.map((r) => `${r.action}:${r.outcome}`).sort(), ['accept:done', 'accept:waiting'], JSON.stringify(rs));
    const held = rs.find((r) => r.outcome === 'waiting')!;
    assert.equal(held.code, 'ACCEPT_HELD');
    assert.match(held.text ?? '', /other trades that are not locked yet/);
    assert.equal([...s.w.board.trades.values()].filter((x) => x.t.status === 'accepted').length, 1);
    assert.equal(s.w.board.count('POST', /\/accept$/), 1, 'one accept sent');
    assert.equal(sends(s.w), 0);
  });

  test('a lock that lands while a take is counted is counted twice (in its trade\'s share and gone from the balance), never not at all', async () => {
    const s = await buyerLocked(60);
    threeTaz(s.w, s.bot.pha);
    // The checks keep the buyer's h with the trade and the lock goes out (its hash kept); it has not landed yet.
    const r = await checks.instantSellerLock(depsOf(s), structuredClone(s.w.board.trades.get(s.id)!.t), (await s.kit.store.getTrade(s.id))!, (await s.kit.store.getOffer(s.offer.id))!);
    assert.equal(r.ok, true, r.ok ? '' : r.problem.text);
    await s.kit.store.patchTrade(s.id, { txs: { phaLock: 'ab'.repeat(32) } });
    // A second take is counted; right after its balance read the first lock lands: the tokens leave and T_P is kept.
    const t2 = s.w.board.take(s.offer.id);
    const read = s.w.pha.balances.bind(s.w.pha);
    let landed = false;
    s.w.pha.balances = async (address: string) => {
      const out = await read(address);
      if (!landed && address === s.bot.pha) {
        landed = true;
        threeTaz(s.w, s.bot.pha, 1n);
        await s.kit.store.patchTrade(s.id, { t1: s.w.vt.s + ITM.I_PHA });
      }
      return out;
    };
    const a = await s.kit.step(t2.id, POLICY);
    assert.ok(landed, 'the lock landed during the count');
    assert.equal(a.action, 'accept', JSON.stringify(a));
    assert.equal(a.outcome, 'waiting', JSON.stringify(a));
    assert.match(a.text ?? '', /other trades that are not locked yet/);
    assert.equal(s.w.board.trades.get(t2.id)!.t.status, 'requested', 'not accepted: 1 TAZ is left for a 2 TAZ lock');
    // Counted again with the lock on chain: what is left (1 TAZ) is still too little.
    s.w.pha.balances = read;
    const a2 = await s.kit.step(t2.id, POLICY);
    assert.equal(a2.outcome, 'waiting', JSON.stringify(a2));
    assert.equal(s.w.board.count('POST', /\/accept$/), 1, 'only the first take was ever accepted');
  });
});

// ── 10. A board that does not answer ─────────────────────────────────────────

describe('a board that does not answer never holds up the watch (build spec section 3.10.3 step 4)', () => {
  test('after the lock, a watch step reads the board once and waits at most 3 s: the buyer\'s claim on Phantasma still leads to the USDC claim in under 10 s of real time', async () => {
    const s = await buyerLocked(30);
    assert.equal((await s.kit.step(s.id, POLICY)).action, 'reportPhaLock');
    s.w.vt.ms += 10_000;
    s.w.board.hang = 'all';
    s.w.board.keeperClaimsPha(s.id);
    const gets = s.w.board.count('GET', /^\/v1\/p2p\/trades\/\d+$/);
    const t0 = performance.now();
    const r = await s.kit.step(s.id, POLICY);
    const took = performance.now() - t0;
    assert.equal(r.action, 'claimBase', JSON.stringify(r));
    assert.equal(r.outcome, 'done', JSON.stringify(r));
    assert.ok(took < 10_000, `the step took ${Math.round(took)} ms`);
    assert.equal(s.w.board.count('GET', /^\/v1\/p2p\/trades\/\d+$/) - gets, 1, 'one read of the board, not sent again');
    assert.equal(s.w.base.count('claim'), 1);
    assert.ok(s.logs.some((l) => /the board could not be read/.test(l)));
    assertClean(s, [s.x]);
  });

  test('a lock report the board does not answer holds the step that locked at most 5 s; the next step is due watchEvery after the lock was read, and reports again', async () => {
    const s = await buyerLocked(30);
    s.w.board.hang = 'post';
    const at = s.w.vt.ms;
    const t0 = performance.now();
    const r = await s.kit.step(s.id, POLICY);
    const took = performance.now() - t0;
    assert.equal(r.action, 'reportPhaLock', JSON.stringify(r));
    assert.equal(r.outcome, 'failed', JSON.stringify(r));
    assert.ok(took < 8_000, `the step took ${Math.round(took)} ms`);
    assert.equal(s.w.pha.count('lock'), 1);
    assert.equal(s.w.board.count('POST', /\/pha-locked$/), 1, 'sent once, not again within the step');
    assert.ok(r.nextAt - at <= INSTANT_RULES.watchEvery * 1000, `the next step is ${r.nextAt - at} ms after the lock was read`);
    // The board answers again: the next step reports the lock.
    s.w.board.hang = null;
    s.w.vt.ms = r.nextAt;
    const r2 = await s.kit.step(s.id, POLICY);
    assert.equal(r2.action, 'reportPhaLock', JSON.stringify(r2));
    assert.equal(r2.outcome, 'done', JSON.stringify(r2));
    assert.equal(s.w.board.trades.get(s.id)!.t.status, 'pha_locked');
    assert.equal(s.w.pha.count('lock'), 1, 'never locked again');
  });
});

// ── 11. The kit takes standard offers only ──────────────────────────────────

describe('the kit is only ever the seller of an instant offer', () => {
  test('take() on an instant offer is refused before anything is sent (MODE_NOT_SUPPORTED): the site\'s P2P page takes it, and no later kit release is promised', async () => {
    const s = await seller();
    const offer = await s.kit.postOffer({ ...SELL, mode: 'instant' });
    const b = await seller({ w: s.w, apiKey: null });
    const posts = s.w.board.calls.filter((c) => c.method === 'POST').length;
    await assert.rejects(b.kit.take(offer.id, '2'), (e: unknown) => e instanceof SafetyError && e.code === 'MODE_NOT_SUPPORTED'
      && /standard offers only/.test(e.detail) && /site's P2P page/.test(e.detail) && /Nothing was sent/.test(e.detail) && !/later/.test(e.detail));
    assert.equal(s.w.board.calls.filter((c) => c.method === 'POST').length, posts, 'no take was sent');
    assert.equal(s.w.board.trades.size, 0);
    assert.equal(sends(s.w), 0);
  });
});
