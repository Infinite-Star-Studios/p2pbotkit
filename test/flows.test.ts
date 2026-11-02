/**
 * The kit's flows end to end (build spec sections 6.3, 6.4 checks 9, 16, 35
 * and 67, 6.5 resume, 6.6 and 6.8 flows.test.ts), against fake chains and a
 * fake board:
 *
 *   - a fake Phantasma node that serves the real devnet escrow script (public
 *     bytecode; the code pin runs against the kit's real pins) and APPLIES the
 *     escrow transactions the kit signs (lock, claim, refund), decoded from
 *     the signed script;
 *   - a fake Base node with SaturnSwap and USDC that applies lockWithPermit,
 *     lock, approve, claim, refund and withdrawOwed, with blocks every 2 s,
 *     confirmations, logs, a mempool, and answers that can be lost;
 *   - a fake board, through the kit's own fetch: offers, takes with client
 *     token hashes and replayOnly, the price check, heartbeats with the
 *     long-poll, accept, decline, the lock reports and /reveal, and a fake
 *     keeper the tests drive to win races;
 *   - virtual time: the kit's clock and waits are the test's, so time limits
 *     (acceptAfterS, CLAIM_WATCH, T1, T2) pass in milliseconds.
 *
 * Keys are generated on the spot into 0600 files, never funded on any chain
 * and never printed. No transaction leaves this process: every send is
 * counted by the fakes.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { PhantasmaKeys, Transaction } from 'phantasma-sdk-ts';
import { generatePrivateKey } from 'viem/accounts';
import { decodeFunctionData, keccak256, parseTransaction, recoverTransactionAddress, type AbiEvent } from 'viem';
import { createKit, FLOW_CODES, SafetyError, type Kit, type KitOptions, type StepResult, type Policy } from '../src/index.js';
import { BoardError } from '../src/errors.js';
import { hexToDecimal, decimalToHex, sha256Hex, hashOfSecret } from '../src/codec.js';
import { P2P_CONFIG, P2P_TOKENS, BOARD, phaPinned, baseDeployed } from '../src/pins.js';
import { SATURN_SWAP_ABI, USDC_ABI, pinnedDomainSeparator, type BaseClient, type BaseBlock, type BaseLog, type BaseReceipt, type ReadCall, type TxCall, type Hex } from '../src/base.js';
import type { PhaRpc, PhaCall, PhaBalance, PhaTxState } from '../src/pha.js';
import * as checks from '../src/checks.js';
import { planFill } from '../src/flows/taker.js';
import { toRaw, echoProblem, resolvePolicy } from '../src/flows/maker.js';
import type { Offer, Trade, NewOffer } from '../src/types.js';

// ── The devnet escrow as the node serves it (public bytecode) ────────────────

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
const T0 = 1_790_000_000;
const SWAP = CFG.base.swap.toLowerCase();
const USDC = CFG.base.usdc.toLowerCase();
const ZERO = '0x' + '0'.repeat(40);
const KEEPER_BASE = '0x6ec2a535685d5ce5f143b8c0d9bf5f612295b703';
const sha = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest();
const nowSecOf = (ms: number) => Math.floor(ms / 1000);

// ── Virtual time ─────────────────────────────────────────────────────────────

/** Real wait for the kit's own I/O (the store fsyncs) to settle between virtual ticks. */
const settle = (ms = 8) => new Promise<void>((r) => setTimeout(r, ms));

class VTime {
  ms = T0 * 1000;
  #timers: Array<{ at: number; done: () => void }> = [];
  now = (): number => this.ms;
  /** A wait that moves the clock at once (step-driven tests). */
  jump = async (ms: number, _signal?: AbortSignal): Promise<void> => {
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

  async advance(ms: number): Promise<void> {
    const end = this.ms + ms;
    for (let guard = 0; guard < 10_000; guard++) {
      const due = this.#timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.ms = Math.max(this.ms, due.at);
      due.done();
      await settle(2);
    }
    this.ms = end;
    await settle();
  }
}

// ── A fake Phantasma node that applies the escrow's transactions ─────────────

interface FakeLock { state: number; sender: string; recipient: string; symbol: string; amount: bigint; deadline: number; created: number; secret?: string }
type SendMode = 'normal' | 'lose' | 'drop' | 'mempool';

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
  bals = new Map<string, PhaBalance[]>();
  sent: string[] = [];
  states = new Map<string, PhaTxState>();
  mempool = new Map<string, { method: string; args: string[] }>();
  /** How the next sends go (one entry each; default normal). */
  modes: SendMode[] = [];
  /** Sends by escrow method. */
  byMethod: Record<string, number> = {};

  constructor(readonly clock: () => number) {}

  async views(calls: readonly PhaCall[]): Promise<unknown[]> {
    return calls.map((c) => this.#view(c));
  }

  #view(c: PhaCall): unknown {
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
      case 'getPaused': return '0';
      case 'getMinLock': return '600';
      case 'getMaxLock': return '7200';
      case 'getMinAmount': return String(this.bounds[c.args[0]!]?.min ?? 0n);
      case 'getMaxAmount': return String(this.bounds[c.args[0]!]?.max ?? 0n);
      case 'getOpenAmount': return '0';
      case 'getMaxOpen': return String(10n ** 20n);
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
    this.byMethod[call.method] = (this.byMethod[call.method] ?? 0) + 1;
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
    if (mode === 'mempool') {
      if (call) this.mempool.set(hash, call);
      return hash;
    }
    this.states.set(hash, this.apply(call));
    if (mode === 'drop') throw new Error('fetch failed');
    return hash;
  }

  /** Run every transaction waiting in the mempool. */
  flush(): void {
    for (const [hash, call] of this.mempool) this.states.set(hash, this.apply(call));
    this.mempool.clear();
  }

  async transaction(hash: string): Promise<PhaTxState | null> {
    return this.states.get(hash) ?? (this.mempool.has(hash) ? { state: 'Pending', reason: '' } : null);
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
  chain = 84532;
  usdc = new Map<string, bigint>();
  allowances = new Map<string, bigint>();
  nonces = new Map<string, number>();
  swaps = new Map<string, FakeSwap>();
  preimages = new Map<string, { value: string; block: bigint }>();
  owed = new Map<string, bigint>();
  events: BaseLog[] = [];
  receipts = new Map<string, BaseReceipt>();
  mempool = new Map<string, Hex>();
  sent: Hex[] = [];
  modes: SendMode[] = [];
  reads = 0;

  constructor(readonly clock: () => number) {}

  get head(): bigint {
    return BASE0 + BigInt(Math.max(0, Math.floor((this.clock() / 1000 - T0) / 2)));
  }

  blockTime(n: bigint): number {
    return T0 + Number(n - BASE0) * 2;
  }

  async chainId(): Promise<number> { return this.chain; }

  async block(at: { tag?: 'latest' | 'safe'; number?: bigint } = {}): Promise<BaseBlock> {
    const n = at.number != null ? at.number : at.tag === 'safe' ? this.head - 10n : this.head;
    return { number: n, timestamp: BigInt(this.blockTime(n)), baseFeePerGas: this.baseFee };
  }

  /** getSwap at block `bn`: as it stood then. */
  swapAt(h: string, sender: string, bn: bigint = this.head) {
    const s = this.swaps.get(`${h.toLowerCase()}|${sender.toLowerCase()}`);
    if (!s || s.block > bn) return { token: ZERO, deadline: 0n, feeBps: 0, state: 0, sender: ZERO, claimer: ZERO, amount: 0n };
    const state = s.claimedBlock != null && s.claimedBlock <= bn ? 2 : s.refundedBlock != null && s.refundedBlock <= bn ? 3 : 1;
    return { token: s.token, deadline: BigInt(s.deadline), feeBps: s.feeBps, state, sender: s.sender, claimer: s.claimer, amount: s.amount };
  }

  async read(c: ReadCall): Promise<unknown> {
    this.reads++;
    const a = (c.args ?? []) as string[];
    const to = c.address.toLowerCase();
    if (to === SWAP) {
      switch (c.functionName) {
        case 'getSwap': return this.swapAt(a[0]!, a[1]!, c.blockNumber ?? this.head);
        case 'feeBps': return this.feeBps;
        case 'paused': return false;
        case 'minLock': return 60n;
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
  async seen(hash: Hex): Promise<boolean> { return this.receipts.has(hash.toLowerCase()) || this.mempool.has(hash.toLowerCase()); }
  async code(): Promise<Hex> { return '0x'; }
  async balance(): Promise<bigint> { return 10n ** 18n; }

  /** A transaction's sender, nonce and fees. */
  async info(raw: Hex): Promise<{ from: string; nonce: number; to: string; data: string; maxFee: bigint; tip: bigint }> {
    const t = parseTransaction(raw);
    const from = (await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase();
    return { from, nonce: t.nonce ?? 0, to: String(t.to ?? '').toLowerCase(), data: t.data ?? '0x', maxFee: t.maxFeePerGas ?? 0n, tip: t.maxPriorityFeePerGas ?? 0n };
  }

  /** The newest block's count, or with 'pending' also the waiting transactions that follow it without a gap (as a node counts them). */
  async nonce(address: Hex, tag: 'latest' | 'pending'): Promise<number> {
    const a = address.toLowerCase();
    const mined = this.nonces.get(a) ?? 0;
    if (tag === 'latest') return mined;
    const waiting = new Set<number>();
    for (const raw of this.mempool.values()) {
      const t = await this.info(raw);
      if (t.from === a) waiting.add(t.nonce);
    }
    let n = mined;
    while (waiting.has(n)) n++;
    return n;
  }

  async priorityFee(): Promise<bigint> { return this.tip; }
  async estimateGas(): Promise<bigint> { return 100_000n; }

  /** One call's effect (dry: only whether it would revert). Throws the revert's name. */
  apply(from: string, to: string, data: Hex, dry: boolean, logs: BaseLog[] = []): void {
    const now = nowSecOf(this.clock());
    const block = this.head;
    // A plain transfer to the sender itself (the kit's cancel): it only uses the nonce.
    if (to.toLowerCase() === from && (!data || data === '0x')) return;
    if (to.toLowerCase() === USDC) {
      const d = decodeFunctionData({ abi: USDC_ABI, data });
      if (d.functionName === 'approve' && !dry) this.allowances.set(from, (d.args as readonly unknown[])[1] as bigint);
      return;
    }
    if (to.toLowerCase() !== SWAP) throw new Error('fake base: unknown contract');
    const d = decodeFunctionData({ abi: SATURN_SWAP_ABI, data });
    const a = d.args as readonly unknown[];
    switch (d.functionName) {
      case 'lock':
      case 'lockWithPermit': {
        const [h, token, amount, claimer, deadline, maxFeeBps] = a as [string, string, bigint, string, bigint, number];
        const key = `${h.toLowerCase()}|${from}`;
        if (this.swaps.has(key)) throw new Error('SwapExists');
        if (this.feeBps > Number(maxFeeBps)) throw new Error('FeeTooHigh');
        if ((this.usdc.get(from) ?? 0n) < amount) throw new Error('ERC20InsufficientBalance');
        if (d.functionName === 'lock' && (this.allowances.get(from) ?? 0n) < amount) throw new Error('ERC20InsufficientAllowance');
        if (dry) return;
        if (d.functionName === 'lock') this.allowances.set(from, (this.allowances.get(from) ?? 0n) - amount);
        this.usdc.set(from, (this.usdc.get(from) ?? 0n) - amount);
        this.swaps.set(key, { token: String(token).toLowerCase(), deadline: Number(deadline), feeBps: this.feeBps, sender: from, claimer: String(claimer).toLowerCase(), amount, block });
        const ev: BaseLog = { address: SWAP, blockNumber: block, eventName: 'Locked', args: { h: h.toLowerCase(), sender: from, claimer: String(claimer).toLowerCase(), token, amount, deadline, feeBps: this.feeBps } };
        this.events.push(ev);
        logs.push(ev);
        return;
      }
      case 'claim': {
        const [preimage, sender] = a as [string, string];
        const h = '0x' + sha(Buffer.from(preimage.slice(2), 'hex')).toString('hex');
        this.#claim(h, String(sender).toLowerCase(), preimage.toLowerCase(), dry, logs);
        return;
      }
      case 'refund': {
        const [h, sender] = a as [string, string];
        const s = this.swaps.get(`${h.toLowerCase()}|${String(sender).toLowerCase()}`);
        if (!s || this.swapAt(h, String(sender)).state !== 1) throw new Error('NotLocked');
        if (now < s.deadline) throw new Error('SwapNotExpired');
        if (dry) return;
        s.refundedBlock = block;
        this.usdc.set(s.sender, (this.usdc.get(s.sender) ?? 0n) + s.amount);
        return;
      }
      case 'withdrawOwed': {
        const claimer = String(a[1]).toLowerCase();
        const owed = this.owed.get(claimer) ?? 0n;
        if (owed === 0n) throw new Error('NothingOwed');
        if (dry) return;
        this.owed.set(claimer, 0n);
        this.usdc.set(claimer, (this.usdc.get(claimer) ?? 0n) + owed);
        return;
      }
    }
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

  /** The keeper (or anyone) claims a swap with its preimage, directly on chain. */
  claimDirect(h: string, sender: string, preimage: string): void {
    this.#claim(h.toLowerCase(), sender.toLowerCase(), preimage.toLowerCase(), false, []);
  }

  async call(c: TxCall): Promise<Hex> {
    this.apply(c.from.toLowerCase(), c.to, c.data, true);
    return '0x';
  }

  async #mine(raw: Hex, hash: string): Promise<void> {
    const t = parseTransaction(raw);
    const from = (await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase();
    this.nonces.set(from, (t.nonce ?? 0) + 1);
    // Whatever else waited at this nonce can never be mined now.
    for (const [h, other] of [...this.mempool]) {
      const o = await this.info(other);
      if (o.from === from && o.nonce <= (t.nonce ?? 0)) this.mempool.delete(h);
    }
    const logs: BaseLog[] = [];
    let status: 'success' | 'reverted' = 'success';
    try {
      this.apply(from, t.to!, t.data!, false, logs);
    } catch {
      status = 'reverted';
    }
    this.receipts.set(hash, { status, blockNumber: this.head, transactionHash: hash, logs });
  }

  /** Hashes a node dropped because a transaction at the same nonce paid more. */
  replaced: string[] = [];

  async sendRaw(raw: Hex): Promise<Hex> {
    this.sent.push(raw);
    const hash = keccak256(raw).toLowerCase() as Hex;
    const mode = this.modes.shift() ?? 'normal';
    if (mode === 'lose') throw new Error('fetch failed');
    const t = await this.info(raw);
    if (t.nonce < (this.nonces.get(t.from) ?? 0)) throw rpcRefusal('nonce too low');
    // One waiting transaction per sender and nonce, as a node keeps them: another one replaces it only when it pays
    // at least 10% more, for the tip and for the max fee.
    for (const [h, other] of [...this.mempool]) {
      if (h === hash) continue;
      const o = await this.info(other);
      if (o.from !== t.from || o.nonce !== t.nonce) continue;
      if (t.maxFee * 10n < o.maxFee * 11n || t.tip * 10n < o.tip * 11n) throw rpcRefusal('replacement transaction underpriced');
      this.mempool.delete(h);
      this.replaced.push(h);
    }
    // Held by the test, or waiting behind an earlier nonce that is not mined.
    if (mode === 'mempool' || t.nonce > (this.nonces.get(t.from) ?? 0)) {
      this.mempool.set(hash, raw);
      return hash;
    }
    await this.#mine(raw, hash);
    if (mode === 'drop') throw new Error('fetch failed');
    return hash;
  }

  /** Mine every transaction waiting in the mempool, each sender's in nonce order. */
  async mineAll(): Promise<void> {
    for (let moved = true; moved && this.mempool.size;) {
      moved = false;
      for (const [hash, raw] of [...this.mempool]) {
        const t = await this.info(raw);
        if (t.nonce !== (this.nonces.get(t.from) ?? 0)) continue;
        this.mempool.delete(hash);
        await this.#mine(raw, hash);
        moved = true;
      }
    }
  }

  /** The 0-value transfers to their own sender (the kit's cancels) sent so far. */
  async cancels(): Promise<Array<{ nonce: number; maxFee: bigint; tip: bigint }>> {
    const out = [];
    for (const raw of this.sent) {
      const t = await this.info(raw);
      if (t.to === t.from && t.data === '0x') out.push({ nonce: t.nonce, maxFee: t.maxFee, tip: t.tip });
    }
    return out;
  }

  /** The sent transactions of one function, with their nonce and fees. */
  sentOf(fn: string): Array<{ hash: string; nonce: number; maxFee: bigint; tip: bigint }> {
    return this.sent.filter((raw) => {
      const t = parseTransaction(raw);
      try {
        return decodeFunctionData({ abi: t.to?.toLowerCase() === USDC ? USDC_ABI : SATURN_SWAP_ABI, data: t.data! }).functionName === fn;
      } catch { return false; }
    }).map((raw) => {
      const t = parseTransaction(raw);
      return { hash: keccak256(raw).toLowerCase(), nonce: t.nonce ?? 0, maxFee: t.maxFeePerGas ?? 0n, tip: t.maxPriorityFeePerGas ?? 0n };
    });
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

/** A JSON-RPC error answer, as viem shapes it: the node refused the transaction, so it surely did not go out. */
function rpcRefusal(details: string): Error {
  return Object.assign(new Error(details), { name: 'RpcRequestError', code: -32000, details });
}

// ── A fake board over the kit's own fetch ────────────────────────────────────

interface BOffer { o: Offer; tokenHash: string; body: Record<string, unknown> }
interface BTrade { t: Trade; takerHash: string; takeBody: Record<string, unknown> }
type Script = (method: string, path: string, body: any) => 'lose' | 'drop' | { status: number; json: unknown } | undefined;

class FakeBoard {
  offers = new Map<number, BOffer>();
  trades = new Map<number, BTrade>();
  hashes = new Map<string, { kind: 'offer' | 'take'; id: number }>();
  calls: Array<{ method: string; path: string; body: any; wait: number }> = [];
  reveals: Array<{ id: number; secret: string }> = [];
  nextOffer = 1;
  nextTrade = 1;
  feeBps = 50;
  /** The board's /config keeper addresses. */
  keeper: { phaAddress: string | null; baseAddress: string | null; claimAddress: string | null } = { phaAddress: null, baseAddress: null, claimAddress: null };
  /** Answer a create with another price than posted (check 9). */
  echoPrice: string | null = null;
  /** Record a take at another price than the offer's (a board that lies). */
  takePrice: string | null = null;
  script: Script | null = null;
  held = 0;
  maxHeld = 0;
  maxTradeHeld = 0;
  tradeHeld = 0;
  #version = 0;
  #waiters: Array<() => void> = [];

  constructor(readonly vt: VTime, readonly pha: FakePha, readonly base: FakeBase) {}

  #mutate(): void {
    this.#version++;
    const w = this.#waiters;
    this.#waiters = [];
    for (const f of w) f();
  }

  get nowS(): number { return nowSecOf(this.vt.ms); }

  /** The board's view of a trade, moved on from the chains as the real board's keeper does. */
  sync(b: BTrade): void {
    const t = b.t;
    const now = this.nowS;
    const before = t.status;
    if (t.status === 'requested' && t.acceptBy != null && now > t.acceptBy) {
      t.status = 'cancelled';
      this.#giveBack(t);
    }
    if (t.status === 'accepted' && t.lockBy != null && now > t.lockBy) t.status = 'expired';
    if (t.h) {
      const swap = this.base.swapAt(t.h, t.buyer.base);
      const lock = this.pha.locks.get(t.h);
      if (swap.state === 2 && ['pha_locked', 'base_locked', 'revealed'].includes(t.status)) t.status = 'base_claimed';
      if (t.status === 'base_claimed' && lock?.state === 2) t.status = 'done';
      if (lock?.state === 3 && swap.state !== 1 && !['done', 'refunded'].includes(t.status)) t.status = 'refunded';
    }
    if (t.status !== before) {
      t.updatedAt = now;
      if (['done', 'refunded', 'cancelled', 'expired'].includes(t.status)) t.endedAt = now;
      this.#mutate();
    }
  }

  #giveBack(t: Trade): void {
    const o = this.offers.get(t.offerId);
    if (o) o.o.remaining = (BigInt(o.o.remaining) + BigInt(t.taz)).toString();
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = new Headers(init?.headers);
    const auth = headers.get('authorization')?.replace(/^Bearer /, '') ?? null;
    const wait = Number(url.searchParams.get('wait') ?? body?.wait ?? 0);
    this.calls.push({ method, path: url.pathname, body, wait });
    const s = this.script?.(method, url.pathname, body);
    if (s === 'lose') throw new TypeError('fetch failed');
    if (s && typeof s === 'object') return this.#json(s.status, s.json);
    const res = await this.#route(method, url.pathname, url.searchParams, body, auth, wait, init?.signal ?? undefined);
    if (s === 'drop') throw new TypeError('fetch failed');
    return res;
  };

  #json(status: number, json: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json', ...headers } });
  }

  #ok(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return this.#json(status, { data }, headers);
  }

  #err(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
    return this.#json(status, { error: { code, message, retryable: false, ...extra } });
  }

  /** Hold a long-poll until something changes or the wait passes (virtual time). */
  async #hold(wait: number, signal: AbortSignal | undefined, trade: boolean): Promise<boolean> {
    if (!(wait > 0)) return false;
    const v = this.#version;
    this.held++;
    this.maxHeld = Math.max(this.maxHeld, this.held);
    if (trade) {
      this.tradeHeld++;
      this.maxTradeHeld = Math.max(this.maxTradeHeld, this.tradeHeld);
    }
    try {
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        this.#waiters.push(done);
        void this.vt.sleep(wait * 1000, signal).then(done);
      });
    } finally {
      this.held--;
      if (trade) this.tradeHeld--;
    }
    return this.#version !== v;
  }

  #tokenOk(token: string | null, hash: string): boolean {
    return !!token && sha256Hex(token) === hash;
  }

  async #route(method: string, path: string, q: URLSearchParams, body: any, auth: string | null, wait: number, signal?: AbortSignal): Promise<Response> {
    const now = this.nowS;
    let m: RegExpExecArray | null;
    if (method === 'GET' && path === '/v1/p2p/config') {
      return this.#ok({ network: 'devnet', enabled: true, displayOnly: true, note: '', keeper: this.keeper, tokens: [], timing: {}, limits: {} });
    }
    if (method === 'GET' && path === '/v1/p2p/recent') return this.#ok({ trades: [], next: null });
    if (method === 'GET' && path === '/v1/p2p/offers') {
      const sym = q.get('symbol') ?? 'all';
      const side = q.get('side');
      return this.#ok([...this.offers.values()].map((x) => x.o).filter((o) => o.status === 'open' && (sym === 'all' || o.symbol === sym) && (!side || o.side === side)));
    }
    if (method === 'GET' && (m = /^\/v1\/p2p\/trades\/(\d+)$/.exec(path))) {
      const b = this.trades.get(Number(m[1]));
      if (!b) return this.#err(404, 'NOT_FOUND', 'No such trade');
      this.sync(b);
      const waited = await this.#hold(wait, signal, true);
      if (waited) this.sync(b);
      return this.#ok(b.t, 200, { 'X-Server-Time': String(this.nowS), 'X-Waited': waited ? '1' : '0' });
    }
    if (method === 'POST' && path === '/v1/p2p/offers') {
      const hash = String(body.makerTokenHash);
      const had = this.hashes.get(hash);
      if (had) return this.#ok({ offer: this.offers.get(had.id)!.o, replayed: true });
      if (body.replayOnly) return this.#err(404, 'NOT_FOUND', 'No offer was made with this makerTokenHash', { reason: 'no_such_request' });
      const id = this.nextOffer++;
      const o: Offer = {
        id, network: 'devnet', side: body.side, makerPha: body.makerPha, makerBase: body.makerBase, symbol: body.symbol,
        tazTotal: body.tazTotal, tazMin: body.tazMin, tazMax: body.tazMax, price: this.echoPrice ?? body.price ?? body.follow?.limitPrice,
        remaining: body.tazTotal, status: 'open', online: true, createdAt: now, heartbeatAt: now, closedAt: null,
        follow: body.follow ? { offsetBps: body.follow.offsetBps, limitPrice: body.follow.limitPrice, dailyMax: body.follow.dailyMax, state: 'live', filled24h: '0' } : null
      };
      this.offers.set(id, { o, tokenHash: hash, body });
      this.hashes.set(hash, { kind: 'offer', id });
      this.#mutate();
      return this.#ok({ offer: o, replayed: false }, 201);
    }
    if (method === 'POST' && (m = /^\/v1\/p2p\/offers\/(\d+)\/take$/.exec(path))) {
      const off = this.offers.get(Number(m[1]));
      if (!off) return this.#err(404, 'NOT_FOUND', 'No such offer');
      const hash = String(body.takerTokenHash);
      const had = this.hashes.get(hash);
      if (had) {
        const b = this.trades.get(had.id)!;
        this.sync(b);
        return this.#ok({ trade: b.t, replayed: true });
      }
      if (body.replayOnly) return this.#err(404, 'NOT_FOUND', 'No take was made with this takerTokenHash', { reason: 'no_such_request' });
      const o = off.o;
      if (o.status !== 'open') return this.#err(409, 'CLOSED', 'This offer is closed');
      if (body.symbol !== o.symbol) return this.#err(409, 'TOKEN', 'Another token');
      if (body.price !== o.price) return this.#err(409, 'PRICE_CHANGED', 'The price changed');
      const taz = BigInt(body.taz);
      if (taz < BigInt(o.tazMin) || taz > BigInt(o.tazMax) || taz > BigInt(o.remaining)) return this.#err(409, 'AMOUNT', 'Amount');
      const price = this.takePrice ?? o.price;
      const unit = 10n ** BigInt(P2P_TOKENS.find((t) => t.symbol === o.symbol)!.decimals);
      const maker = { pha: o.makerPha, base: o.makerBase };
      const taker = { pha: body.takerPha, base: body.takerBase };
      const id = this.nextTrade++;
      const t: Trade = {
        id, network: 'devnet', offerId: o.id, side: o.side, symbol: o.symbol, taz: body.taz, usdc: ((taz * BigInt(price)) / unit).toString(), price,
        seller: o.side === 'sell' ? maker : taker, buyer: o.side === 'sell' ? taker : maker,
        h: null, phaContract: null, phaLockTx: null, baseLockTx: null, baseClaimTx: null, phaClaimTx: null, baseRefundTx: null, phaRefundTx: null,
        phaDeadline: null, baseDeadline: null, feeBps: null, payoutDeferred: false, status: 'requested',
        acceptBy: now + BOARD.acceptTimeout, lockBy: null, createdAt: now, acceptedAt: null, updatedAt: now, endedAt: null, lastError: null
      };
      o.remaining = (BigInt(o.remaining) - taz).toString();
      this.trades.set(id, { t, takerHash: hash, takeBody: body });
      this.hashes.set(hash, { kind: 'take', id });
      this.#mutate();
      return this.#ok({ trade: t, replayed: false }, 201);
    }
    if (method === 'POST' && (m = /^\/v1\/p2p\/offers\/(\d+)\/(heartbeat|cancel|reprice)$/.exec(path))) {
      const off = this.offers.get(Number(m[1]));
      if (!off) return this.#err(404, 'NOT_FOUND', 'No such offer');
      if (!this.#tokenOk(auth, off.tokenHash)) return this.#err(401, 'UNAUTHORIZED', 'Wrong token');
      if (m[2] === 'cancel') {
        if (off.o.status !== 'open') return this.#err(409, 'CLOSED', 'Closed');
        off.o.status = 'closed';
        off.o.closedAt = now;
        this.#mutate();
        return this.#ok({ ok: true });
      }
      if (m[2] === 'reprice') {
        off.o.price = body.price ?? off.o.price;
        this.#mutate();
        return this.#ok({ offer: off.o });
      }
      if (off.o.status !== 'open') return this.#err(409, 'CLOSED', 'Closed');
      off.o.heartbeatAt = now;
      const waited = await this.#hold(wait, signal, false);
      return this.#ok({ offer: off.o, trades: this.#running(off.o.id), serverTime: this.nowS, waited });
    }
    if (method === 'POST' && path === '/v1/p2p/heartbeats') {
      const items = body.offers as Array<{ id: number; token: string }>;
      const waited = await this.#hold(Number(body.wait ?? 0), signal, false);
      const results = items.map((it) => {
        const off = this.offers.get(it.id);
        if (!off || !this.#tokenOk(it.token, off.tokenHash)) return { id: it.id, ok: false, error: { code: 'UNAUTHORIZED', message: 'Wrong token', retryable: false } };
        if (off.o.status !== 'open') return { id: it.id, ok: false, error: { code: 'CLOSED', message: 'Closed', retryable: false } };
        off.o.heartbeatAt = this.nowS;
        return { id: it.id, ok: true, offer: off.o, trades: this.#running(off.o.id) };
      });
      return this.#ok({ results, serverTime: this.nowS, waited });
    }
    if (method === 'POST' && (m = /^\/v1\/p2p\/trades\/(\d+)\/(accept|decline|pha-locked|base-locked|reveal)$/.exec(path))) {
      const b = this.trades.get(Number(m[1]));
      if (!b) return this.#err(404, 'NOT_FOUND', 'No such trade');
      this.sync(b);
      const t = b.t;
      const off = this.offers.get(t.offerId)!;
      const makerOk = this.#tokenOk(auth, off.tokenHash);
      const takerOk = this.#tokenOk(auth, b.takerHash);
      const sOk = off.o.side === 'sell' ? makerOk : takerOk;
      const bOk = off.o.side === 'sell' ? takerOk : makerOk;
      switch (m[2]) {
        case 'accept':
          if (!makerOk) return this.#err(401, 'UNAUTHORIZED', 'Wrong token');
          if (t.status === 'accepted') return this.#ok(t);
          if (t.status !== 'requested') return this.#err(409, 'STATE', 'Not requested');
          Object.assign(t, { status: 'accepted', feeBps: this.feeBps, acceptedAt: now, updatedAt: now, lockBy: now + BOARD.lockWait });
          this.#mutate();
          return this.#ok(t);
        case 'decline':
          if (!makerOk) return this.#err(401, 'UNAUTHORIZED', 'Wrong token');
          if (t.status !== 'requested') return this.#err(409, 'STATE', 'Not requested');
          Object.assign(t, { status: 'cancelled', updatedAt: now, endedAt: now });
          this.#giveBack(t);
          this.#mutate();
          return this.#ok(t);
        case 'pha-locked': {
          if (!sOk) return this.#err(401, 'UNAUTHORIZED', 'Wrong token');
          if (t.status !== 'accepted') return this.#err(409, 'STATE', 'Not accepted');
          const l = this.pha.locks.get(String(body.h).toLowerCase());
          if (!l || l.state !== 1 || l.sender !== t.seller.pha || l.recipient !== t.buyer.pha || l.symbol !== t.symbol || l.amount !== BigInt(t.taz)) {
            return this.#err(422, 'NO_LOCK', 'No such lock', { retryable: true, retryAfter: 5 });
          }
          Object.assign(t, { status: 'pha_locked', h: String(body.h).toLowerCase(), phaContract: 'saturnescrow', phaLockTx: body.txHash ?? null, phaDeadline: l.deadline, updatedAt: now });
          this.#mutate();
          return this.#ok(t);
        }
        case 'base-locked': {
          if (!bOk) return this.#err(401, 'UNAUTHORIZED', 'Wrong token');
          if (t.status !== 'pha_locked' || !t.h) return this.#err(409, 'STATE', 'Not pha_locked');
          const s = this.base.swapAt(t.h, t.buyer.base);
          if (s.state !== 1) return this.#err(409, 'NOT_CONFIRMED', 'Not on Base yet', { retryable: true, retryAfter: 5 });
          Object.assign(t, { status: 'base_locked', baseLockTx: body.txHash, baseDeadline: Number(s.deadline), updatedAt: now });
          this.#mutate();
          return this.#ok(t);
        }
        case 'reveal': {
          if (!t.h || hashOfSecret(String(body.secret)) !== t.h) return this.#err(403, 'WRONG_SECRET', 'Wrong secret');
          this.reveals.push({ id: t.id, secret: String(body.secret) });
          if (t.status === 'base_locked') Object.assign(t, { status: 'revealed', updatedAt: now });
          this.#mutate();
          return this.#json(200, { ok: true });
        }
      }
    }
    return this.#err(404, 'NOT_FOUND', `No route ${method} ${path}`);
  }

  #running(offerId: number): Trade[] {
    return [...this.trades.values()].filter((b) => b.t.offerId === offerId).map((b) => { this.sync(b); return b.t; })
      .filter((t) => !['done', 'refunded', 'cancelled', 'expired'].includes(t.status));
  }

  /** The keeper claims the seller's USDC with the revealed secret. */
  keeperClaimUsdc(id: number): void {
    const b = this.trades.get(id)!;
    const r = this.reveals.find((x) => x.id === id);
    assert.ok(r, 'the keeper holds the secret only after /reveal');
    this.base.claimDirect(b.t.h!, b.t.buyer.base, r.secret);
  }

  /** The keeper claims the buyer's tokens with the secret public on Base. */
  keeperClaimToken(id: number): void {
    const b = this.trades.get(id)!;
    const l = this.pha.locks.get(b.t.h!)!;
    const pre = this.base.preimages.get(`${b.t.h}|${b.t.buyer.base.toLowerCase()}`);
    assert.ok(pre && l.state === 1);
    l.state = 2;
    l.secret = pre.value;
  }

  /** The keeper refunds the seller's tokens after T1. */
  keeperRefundToken(id: number): void {
    const l = this.pha.locks.get(this.trades.get(id)!.t.h!)!;
    assert.ok(l.state === 1 && this.nowS >= l.deadline);
    l.state = 3;
  }

  /** Board calls of one kind so far. */
  count(method: string, re: RegExp): number {
    return this.calls.filter((c) => c.method === method && re.test(c.path)).length;
  }
}

// ── Worlds and bots ──────────────────────────────────────────────────────────

const dirs: string[] = [];
const kits: Kit[] = [];
after(async () => {
  for (const k of kits) await k.close().catch(() => {});
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'kit-flows-'));
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

/** A bot's key files (0600), made on the spot and never printed. */
interface Bot { phaKeyFile: string; baseKeyFile: string; dataDir: string; pha: string; base: string; secrets: string[] }

async function newBot(w: World): Promise<Bot> {
  const d = await tempDir();
  const phaKeyFile = join(d, 'pha.json'), baseKeyFile = join(d, 'base.json');
  const pk = PhantasmaKeys.generate();
  const bk = generatePrivateKey();
  await writeFile(phaKeyFile, JSON.stringify({ wif: pk.toWIF() }), { mode: 0o600 });
  await writeFile(baseKeyFile, JSON.stringify({ privateKey: bk }), { mode: 0o600 });
  await chmod(phaKeyFile, 0o600);
  await chmod(baseKeyFile, 0o600);
  const { privateKeyToAccount } = await import('viem/accounts');
  const base = privateKeyToAccount(bk).address.toLowerCase();
  const pha = pk.Address.Text;
  w.pha.bals.set(pha, [
    { symbol: 'TAZ', amount: (100n * 10n ** 9n).toString(), decimals: 9 },
    { symbol: 'SOUL', amount: (5n * 10n ** 8n).toString(), decimals: 8 },
    { symbol: 'KCAL', amount: (10n * 10n ** 10n).toString(), decimals: 10 },
    { symbol: 'RA', amount: (100n * 10n ** 9n).toString(), decimals: 9 }
  ]);
  w.base.usdc.set(base, 1_000_000_000n);
  return { phaKeyFile, baseKeyFile, dataDir: join(d, 'data'), pha, base, secrets: [pk.toWIF(), bk] };
}

interface KitHandle { kit: Kit; logs: string[]; bot: Bot }

/** A kit on the fakes. `virtual`: waits last until the test advances time (run() tests); otherwise each wait moves the clock at once. */
async function kitFor(w: World, bot: Bot, o: Partial<KitOptions> & { virtual?: boolean } = {}): Promise<KitHandle> {
  const logs: string[] = [];
  const { virtual, ...opts } = o;
  const kit = await createKit({
    network: 'devnet', api: 'http://127.0.0.1:9', phaKeyFile: bot.phaKeyFile, baseKeyFile: bot.baseKeyFile, dataDir: bot.dataDir,
    log: (l) => logs.push(l), env: {},
    ...opts,
    internals: {
      fetch: w.board.fetch as typeof fetch, pha: w.pha, base: w.base, now: w.vt.now, sleep: virtual ? w.vt.sleep : w.vt.jump,
      signerSleep: async () => {}, signerWait: { phaTries: 1, phaIntervalMs: 0, baseTimeoutMs: 1, basePollMs: 1, allowanceTries: 2, allowancePollMs: 0 },
      argv: ['node', 'bot.ts'], storeKeyFile: null, pollWaitS: 5,
      ...(opts.internals ?? {})
    }
  });
  kits.push(kit);
  return { kit, logs, bot };
}

/** Close a kit as a crash would leave it (its store released; nothing else). */
async function crash(h: KitHandle): Promise<void> {
  await h.kit.close();
  kits.splice(kits.indexOf(h.kit), 1);
}

const SELL = { side: 'sell' as const, symbol: 'TAZ', total: '30', min: '1', max: '5', price: '1.08' };
const BUY = { side: 'buy' as const, symbol: 'TAZ', total: '30', min: '1', max: '5', price: '1.08' };
const TAZ2 = 2_000_000_000n;
const PRICE = 1_080_000n;

/** Step `kit` on trade `id` until `done(result)` or `max` steps, moving virtual time by `everyMs` between steps. */
async function stepUntil(w: World, h: KitHandle, id: number, done: (r: StepResult) => boolean, o: { max?: number; everyMs?: number; policy?: Policy } = {}): Promise<StepResult> {
  let r: StepResult | null = null;
  for (let i = 0; i < (o.max ?? 40); i++) {
    r = await h.kit.step(id, o.policy);
    if (done(r)) return r;
    w.vt.ms += o.everyMs ?? 2_000;
  }
  assert.fail(`trade #${id} did not get there: last step ${JSON.stringify(r)}`);
}

/** A seller bot with a listed sell offer, and a buyer bot that took 2 TAZ of it (step-driven). */
async function sellOfferTaken(w: World, o: { sellerOpts?: Partial<KitOptions>; buyerOpts?: Partial<KitOptions> } = {}) {
  const s = await kitFor(w, await newBot(w), o.sellerOpts);
  const b = await kitFor(w, await newBot(w), o.buyerOpts);
  const offer = await s.kit.postOffer(SELL);
  const taken = await b.kit.take(offer.id, '2');
  return { s, b, offer, id: taken.id, taken };
}

/** Both sides of one trade stepped in turn until `done`. */
async function stepBoth(w: World, s: KitHandle, b: KitHandle, id: number, done: () => boolean | Promise<boolean>, policy: Policy = { acceptAfterS: 0, claimWatchS: 0 }, max = 60): Promise<void> {
  for (let i = 0; i < max; i++) {
    await s.kit.step(id, policy);
    await b.kit.step(id, policy);
    if (await done()) return;
    w.vt.ms += 2_000;
  }
  assert.fail(`trade #${id} did not finish: board ${w.board.trades.get(id)?.t.status}`);
}

/** No key, token or secret in any log line. */
function assertClean(h: KitHandle, extra: string[] = []): void {
  const secrets = [...h.bot.secrets, ...extra].map((s) => s.toLowerCase().replace(/^0x/, ''));
  for (const line of h.logs) {
    const l = line.toLowerCase();
    for (const s of secrets) assert.ok(!l.includes(s), 'a log line carries a key, a token or a secret');
    assert.ok(!/[0-9a-f]{64}/.test(l), `a log line carries 64 hex digits: ${line.slice(0, 80)}`);
  }
}

// ── 1. createKit: check 67, mainnet, keys ────────────────────────────────────

describe('createKit refuses before it reads, with its own codes', () => {
  test('mainnet is refused (NETWORK_OFF) before any read: without both allowMainnet and KIT_ALLOW_MAINNET=1, and with both while its pins are empty (this release)', async () => {
    const w = world();
    const bot = await newBot(w);
    const off = (e: unknown) => e instanceof SafetyError && e.code === 'NETWORK_OFF';
    await assert.rejects(kitFor(w, bot, { network: 'mainnet' }), off);
    await assert.rejects(kitFor(w, bot, { network: 'mainnet', allowMainnet: true }), off);
    await assert.rejects(kitFor(w, bot, { network: 'mainnet', env: { KIT_ALLOW_MAINNET: '1' } }), off);
    if (!(phaPinned(P2P_CONFIG.mainnet) && baseDeployed(P2P_CONFIG.mainnet))) {
      await assert.rejects(kitFor(w, bot, { network: 'mainnet', allowMainnet: true, env: { KIT_ALLOW_MAINNET: '1' } }),
        (e: unknown) => off(e) && /no (escrow pins|SaturnSwap pin) for mainnet/.test((e as SafetyError).detail));
    }
    assert.equal(w.board.calls.length, 0, 'no board read');
    assert.equal(w.base.reads, 0, 'no Base read');
  });

  test('67: a Phantasma RPC off the allowlist, a Base RPC over plain http, or a Base RPC of another chain refuses to start', async () => {
    const w = world();
    const bot = await newBot(w);
    for (const phaRpc of ['https://evil.example/rpc', 'http://devnet.phantasma.info/rpc', 'https://devnet.phantasma.info:8443/rpc', 'https://user:pw@devnet.phantasma.info/rpc', 'https://pharpc1.phantasma.info/rpc']) {
      await assert.rejects(kitFor(w, bot, { phaRpc }), (e: unknown) => e instanceof SafetyError && e.code === 'RPC_NOT_ALLOWED', phaRpc);
    }
    await assert.rejects(kitFor(w, bot, { baseRpc: 'http://sepolia.base.org' }), (e: unknown) => e instanceof SafetyError && e.code === 'RPC_NOT_ALLOWED');
    assert.equal(w.board.calls.length, 0, 'refused before any read');
    w.base.chain = 1;
    await assert.rejects(kitFor(w, bot), (e: unknown) => e instanceof SafetyError && e.code === 'RPC_NOT_ALLOWED' && /chain 1/.test(e.detail));
    assert.equal(FLOW_CODES.RPC_NOT_ALLOWED, 67);
    w.base.chain = 84532;
    const ok = await kitFor(w, bot);
    assert.equal(ok.kit.network, 'devnet');
    await crash(ok);
  });

  test('68: a key whose address the board\'s /config names as the keeper refuses to start (display data only adds a refusal)', async () => {
    const w = world();
    const bot = await newBot(w);
    w.board.keeper = { phaAddress: bot.pha, baseAddress: null, claimAddress: null };
    await assert.rejects(kitFor(w, bot), (e: unknown) => e instanceof SafetyError && e.code === 'KEY_ROLE');
    w.board.keeper = { phaAddress: null, baseAddress: null, claimAddress: bot.base };
    await assert.rejects(kitFor(w, bot), (e: unknown) => e instanceof SafetyError && e.code === 'KEY_ROLE');
    w.board.keeper = { phaAddress: null, baseAddress: null, claimAddress: null };
    const h = await kitFor(w, bot);
    // The board names it later: run() re-reads /config before anything else and stops.
    w.board.keeper = { phaAddress: bot.pha, baseAddress: null, claimAddress: null };
    await assert.rejects(h.kit.run({}, AbortSignal.timeout(5_000)), (e: unknown) => e instanceof SafetyError && e.code === 'KEY_ROLE');
    await crash(h);
  });

  test('a policy out of range is refused (BAD_POLICY); the defaults are 15 s and CLAIM_WATCH', () => {
    assert.throws(() => resolvePolicy({ acceptAfterS: -1 }, 'devnet'), (e: unknown) => e instanceof SafetyError && e.code === 'BAD_POLICY');
    assert.throws(() => resolvePolicy({ claimWatchS: Number.NaN }, 'devnet'), (e: unknown) => e instanceof SafetyError && e.code === 'BAD_POLICY');
    assert.throws(() => resolvePolicy({ maxOpenTrades: 0 }, 'devnet'), (e: unknown) => e instanceof SafetyError && e.code === 'BAD_POLICY');
    const d = resolvePolicy(undefined, 'devnet');
    assert.equal(d.acceptAfterS, BOARD.acceptDelay);
    assert.equal(d.claimWatchS, CFG.timing.claimWatch);
    assert.equal(resolvePolicy({ acceptAfterS: 0, claimWatchS: 0 }, 'devnet').acceptAfterS, 0);
  });

  test('amounts are decimal text in whole units, never rounded', () => {
    assert.equal(toRaw('2.5', 9, 'x'), 2_500_000_000n);
    assert.equal(toRaw('1.08', 6, 'x'), 1_080_000n);
    for (const bad of ['', '1e3', '-1', ' 1', '1.0000000001', '0', '0.0', '1,5', '0x10']) assert.throws(() => toRaw(bad, 9, 'x'), (e: unknown) => e instanceof SafetyError && e.code === 'BAD_AMOUNT', bad);
    assert.throws(() => toRaw(5 as unknown as string, 9, 'x'), (e: unknown) => e instanceof SafetyError && e.code === 'BAD_AMOUNT');
  });
});

// ── 2. Offers: checks 7 and 9 ────────────────────────────────────────────────

describe('posting an offer', () => {
  test('9: the board listed it at another price: cancelled at once with its token (OFFER_ECHO), never heartbeated', async () => {
    const w = world();
    const s = await kitFor(w, await newBot(w));
    w.board.echoPrice = '1090000';
    await assert.rejects(s.kit.postOffer(SELL), (e: unknown) => e instanceof SafetyError && e.code === 'OFFER_ECHO');
    assert.equal(FLOW_CODES.OFFER_ECHO, 9);
    const listed = w.board.offers.get(1)!;
    assert.equal(listed.o.status, 'closed', 'the board\'s copy was cancelled');
    assert.ok((await s.kit.store.getOffer(1))?.closedAt, 'kept closed: no heartbeat keeps it listed');
    assert.equal(w.board.count('POST', /\/cancel$/), 1);
    // The pure rule: token, side, amounts, maker, price, follow settings.
    const body: NewOffer = { side: 'sell', symbol: 'TAZ', makerPha: 'P2K' + 'S'.repeat(44), makerBase: '0x' + '5a'.repeat(20), tazTotal: '30000000000', tazMin: '1000000000', tazMax: '5000000000', price: '1080000' };
    const echo = { ...listed.o, ...body, makerBase: '0x' + '5A'.repeat(20), remaining: body.tazTotal, follow: null } as Offer;
    assert.equal(echoProblem(echo, body), null, 'the same offer (checksum case aside) passes');
    assert.equal(echoProblem({ ...echo, tazMax: '6000000000' }, body), 'amounts');
    assert.equal(echoProblem({ ...echo, symbol: 'RA' }, body), 'token');
    assert.equal(echoProblem({ ...echo, makerPha: 'P2K' + 'X'.repeat(44) }, body), 'maker addresses');
    const fol: NewOffer = { ...body, price: undefined, follow: { offsetBps: 200, limitPrice: '1050000', dailyMax: body.tazTotal } };
    const folEcho = { ...echo, price: '1100000', follow: { offsetBps: 200, limitPrice: '1050000', dailyMax: body.tazTotal, state: 'live', filled24h: '0' } } as Offer;
    assert.equal(echoProblem(folEcho, fol), null);
    assert.equal(echoProblem({ ...folEcho, price: '1000000' }, fol), 'price past the limit');
    assert.equal(echoProblem({ ...folEcho, follow: { ...folEcho.follow!, offsetBps: 100 } }, fol), 'follow settings');
    assertClean(s);
  });

  test('7: an offer outside the token table is refused before anything is sent', async () => {
    const w = world();
    const s = await kitFor(w, await newBot(w));
    await assert.rejects(s.kit.postOffer({ ...SELL, min: '0.5' }), (e: unknown) => e instanceof SafetyError && e.code === 'OFFER_INVALID');
    await assert.rejects(s.kit.postOffer({ ...SELL, symbol: 'taz' }), (e: unknown) => e instanceof SafetyError && e.code === 'TOKEN_NOT_TRADED');
    await assert.rejects(s.kit.postOffer({ ...SELL, mode: 'instant' }), (e: unknown) => e instanceof SafetyError && e.code === 'MODE_NOT_SUPPORTED');
    assert.equal(w.board.count('POST', /\/offers$/), 0);
  });
});

// ── 3. Accepting: check 16 ───────────────────────────────────────────────────

describe('16: a take is accepted only once seen for acceptAfterS, and a decline wins', () => {
  test('the default 15 s refuses with ACCEPT_TOO_SOON until then; acceptAfterS 0 accepts at once', async () => {
    const w = world();
    const { s, id } = await sellOfferTaken(w);
    const r1 = await s.kit.step(id);
    assert.equal(r1.code, 'ACCEPT_TOO_SOON');
    assert.equal(r1.check, 16);
    assert.equal(r1.outcome, 'refused');
    assert.equal(r1.nextAt, w.vt.ms + 15_000, 'due when 15 s have passed since it was first seen');
    w.vt.ms += 14_000;
    assert.equal((await s.kit.step(id)).code, 'ACCEPT_TOO_SOON');
    w.vt.ms += 1_000;
    const r2 = await s.kit.step(id);
    assert.equal(r2.action, 'accept');
    assert.equal(r2.outcome, 'done');
    assert.equal(w.board.trades.get(id)!.t.status, 'accepted');

    const w2 = world();
    const t2 = await sellOfferTaken(w2);
    const r3 = await t2.s.kit.step(t2.id, { acceptAfterS: 0 });
    assert.equal(r3.action, 'accept');
    assert.equal(r3.outcome, 'done', 'acceptAfterS 0: accepted at the first step');
    assert.equal(w2.board.trades.get(t2.id)!.t.status, 'accepted');
  });

  test('a decline during the wait wins (TAKE_DECLINED), and the board shows the take cancelled', async () => {
    const w = world();
    const { s, id } = await sellOfferTaken(w);
    assert.equal((await s.kit.step(id)).code, 'ACCEPT_TOO_SOON');
    await s.kit.declineTake(id);
    w.vt.ms += 20_000;
    const r = await s.kit.step(id);
    assert.ok(r.outcome === 'refused' || r.outcome === 'finished', JSON.stringify(r));
    assert.equal(w.board.trades.get(id)!.t.status, 'cancelled');
    assert.equal(w.board.count('POST', /\/accept$/), 0, 'never accepted');
    // The rule itself, with the board still at requested (a decline the board has not answered yet).
    const w2 = world();
    const t2 = await sellOfferTaken(w2);
    await t2.s.kit.step(t2.id);
    w2.board.script = (m, p) => (m === 'POST' && /\/decline$/.test(p) ? { status: 503, json: { error: { code: 'UNAVAILABLE', message: 'down', retryable: false } } } : undefined);
    await assert.rejects(t2.s.kit.declineTake(t2.id));
    w2.board.script = null;
    w2.vt.ms += 20_000;
    const r2 = await t2.s.kit.step(t2.id);
    assert.equal(r2.code, 'TAKE_DECLINED');
    assert.equal(r2.check, 16);
    assert.equal(w2.board.count('POST', /\/accept$/), 0);
  });

  test('an offer posted with acceptOnTheirOwn false waits for acceptTake', async () => {
    const w = world();
    const s = await kitFor(w, await newBot(w));
    const b = await kitFor(w, await newBot(w));
    const offer = await s.kit.postOffer({ ...SELL, acceptOnTheirOwn: false });
    const t = await b.kit.take(offer.id, '2');
    const r = await s.kit.step(t.id, { acceptAfterS: 0 });
    assert.equal(r.code, 'ACCEPT_HELD');
    assert.equal(w.board.trades.get(t.id)!.t.status, 'requested');
    await s.kit.acceptTake(t.id);
    assert.equal(w.board.trades.get(t.id)!.t.status, 'accepted');
  });
});

// ── 4. The seller and the buyer end to end (step-driven) ─────────────────────

describe('a sell offer from start to finish, both sides stepped', () => {
  test('the seller locks, reports, claims its USDC itself (never POSTs /reveal); the buyer locks USDC with a permit and claims at once (claimWatchS 0)', async () => {
    const w = world();
    const { s, b, id, taken } = await sellOfferTaken(w);
    assert.equal(taken.price, PRICE.toString(), 'LocalTrade.price is the price the kit sent');
    assert.equal(w.board.trades.get(id)!.takeBody.price, PRICE.toString(), 'the take sent the price it read');
    await stepBoth(w, s, b, id, async () => !!(await s.kit.store.getTrade(id))?.endedAt && !!(await b.kit.store.getTrade(id))?.endedAt);
    const t = w.board.trades.get(id)!.t;
    assert.equal(t.status, 'done');
    assert.equal(w.board.reveals.length, 0, 'claimMode self: the secret never went to the board');
    assert.equal(w.board.count('POST', /\/reveal$/), 0);
    assert.equal(w.pha.count('lock'), 1, 'one Phantasma lock');
    assert.equal(w.base.count('lockWithPermit'), 1, 'one USDC lock, in one transaction');
    assert.equal(w.base.count('approve'), 0);
    assert.equal(w.base.count('claim'), 1, 'the seller claimed its USDC itself');
    assert.equal(w.pha.count('claim'), 1, 'the buyer claimed its TAZ itself');
    const lock = w.pha.locks.get(t.h!)!;
    assert.equal(lock.state, 2);
    assert.equal(lock.recipient, b.bot.pha);
    assert.equal(lock.amount, TAZ2);
    // Check 35's records: h, the escrow and T1 kept by the seller before the report.
    const sr = (await s.kit.store.getTrade(id))!;
    assert.equal(sr.h, t.h);
    assert.equal(sr.phaContract, 'saturnescrow');
    assert.equal(sr.t1, lock.deadline);
    assert.equal(sr.feeShown, 50, 'the fee shown, stored before the lock was signed');
    const secret = (await s.kit.store.secretsOfTrade(id))[0]!.secret;
    assertClean(s, [secret]);
    assertClean(b);
  });

  test('approve exactly, then lock, without a permit (usePermit false)', async () => {
    const w = world();
    const { s, b, id } = await sellOfferTaken(w, { buyerOpts: { usePermit: false } });
    await stepBoth(w, s, b, id, async () => !!(await b.kit.store.getTrade(id))?.endedAt);
    assert.equal(w.base.count('approve'), 1);
    assert.equal(w.base.count('lock'), 1);
    assert.equal(w.base.count('lockWithPermit'), 0);
  });

  test('a buy offer: the buyer bot is the maker, a seller bot takes it with sellDownTo', async () => {
    const w = world();
    const buyer = await kitFor(w, await newBot(w));
    const seller = await kitFor(w, await newBot(w));
    const offer = await buyer.kit.postOffer(BUY);
    const trades = await seller.kit.sellDownTo({ symbol: 'TAZ', amount: '2', minPrice: '1.05' });
    assert.equal(trades.length, 1);
    assert.equal(trades[0]!.offerId, offer.id);
    assert.equal(trades[0]!.price, PRICE.toString());
    const id = trades[0]!.id;
    await stepBoth(w, seller, buyer, id, async () => !!(await seller.kit.store.getTrade(id))?.endedAt && !!(await buyer.kit.store.getTrade(id))?.endedAt);
    assert.equal(w.board.trades.get(id)!.t.status, 'done');
    assert.equal(w.board.reveals.length, 0);
  });
});

// ── 5. Check 35 ──────────────────────────────────────────────────────────────

describe('35: the seller reports only its own lock', () => {
  test('a lock under h that pays someone else is not reported (LOCK_NOT_OURS), and nothing is recorded', async () => {
    const w = world();
    const { s, id } = await sellOfferTaken(w);
    await s.kit.step(id, { acceptAfterS: 0 });
    // The node shows the lock under the kit's h paying another address (a forked or lying node).
    const realApply = w.pha.apply.bind(w.pha);
    w.pha.apply = (call) => {
      const st = realApply(call);
      if (call?.method === 'lock') w.pha.locks.get(decimalToHex(call.args[1])!)!.recipient = 'P2K' + 'X'.repeat(44);
      return st;
    };
    const r = await s.kit.step(id);
    assert.equal(r.code, 'LOCK_NOT_OURS');
    assert.equal(r.check, 35);
    assert.equal(FLOW_CODES.LOCK_NOT_OURS, 35);
    assert.equal(w.board.count('POST', /\/pha-locked$/), 0, 'not reported');
    assert.equal((await s.kit.store.getTrade(id))?.h, undefined, 'h is not recorded for a lock that is not ours');
    assert.equal(w.board.trades.get(id)!.t.status, 'accepted');
  });
});

// ── 6. Resume after a crash at every durable step (section 6.5) ──────────────

describe('resume after a crash at each durable step', () => {
  test('1: the take\'s token kept before the POST: a take that reached the board is recorded on restart (replayOnly); one that never arrived makes nothing', async () => {
    const w = world();
    const s = await kitFor(w, await newBot(w));
    const botB = await newBot(w);
    let b = await kitFor(w, botB);
    const offer = await s.kit.postOffer(SELL);
    // Every answer to the take is lost, though the board made the trade: the kit keeps its token and gives up.
    w.board.script = (m, p) => (m === 'POST' && /\/take$/.test(p) ? 'drop' : undefined);
    await assert.rejects(b.kit.take(offer.id, '2'));
    assert.equal(w.board.trades.size, 1, 'the board made it once (each resend was a replay)');
    assert.equal((await b.kit.store.listPending()).length, 1, 'durable write 1: the token is kept');
    await crash(b);
    w.board.script = null;
    w.vt.ms += 61_000;
    b = await kitFor(w, botB, { virtual: true });
    const ctl = new AbortController();
    const run = b.kit.run({ acceptAfterS: 0 }, ctl.signal);
    for (let i = 0; i < 50 && !(await b.kit.store.getTrade(1)); i++) await w.vt.advance(1_000);
    ctl.abort();
    await run;
    assert.ok(await b.kit.store.getTrade(1), 'recorded from the replayOnly answer');
    assert.equal((await b.kit.store.listPending()).length, 0);
    assert.equal(w.board.trades.size, 1, 'no second trade');
    assert.ok(w.board.calls.some((c) => c.path === '/v1/p2p/recent'), 'the board was probed for client hashes (GET /recent) before replayOnly');
    assert.ok(w.board.calls.some((c) => /\/take$/.test(c.path) && c.body?.replayOnly === true), 'asked with replayOnly');

    // A take that never reached the board: the restart's replayOnly finds nothing and makes nothing.
    const w2 = world();
    const s2 = await kitFor(w2, await newBot(w2));
    const bot2 = await newBot(w2);
    let b2 = await kitFor(w2, bot2);
    const offer2 = await s2.kit.postOffer(SELL);
    w2.board.script = (m, p) => (m === 'POST' && /\/take$/.test(p) ? 'lose' : undefined);
    await assert.rejects(b2.kit.take(offer2.id, '2'));
    await crash(b2);
    w2.board.script = null;
    w2.vt.ms += 61_000;
    b2 = await kitFor(w2, bot2, { virtual: true });
    const ctl2 = new AbortController();
    const run2 = b2.kit.run({}, ctl2.signal);
    for (let i = 0; i < 50 && (await b2.kit.store.listPending()).length; i++) await w2.vt.advance(1_000);
    ctl2.abort();
    await run2;
    assert.equal((await b2.kit.store.listPending()).length, 0, 'cleared');
    assert.equal(w2.board.trades.size, 0, 'no trade was made late');
  });

  test('2: the secret kept before the lock: after a crash before signing, the restart locks under the same h, once', async () => {
    const w = world();
    const { s, id } = await sellOfferTaken(w);
    await s.kit.step(id, { acceptAfterS: 0 });
    const board = w.board.trades.get(id)!.t;
    const deps: checks.CheckDeps = { network: 'devnet', pha: s.kit.pha, base: s.kit.base, store: s.kit.store, board: s.kit.board, address: s.kit.address, now: w.vt.now };
    const r = await checks.sellerLock(deps, structuredClone(board), (await s.kit.store.getTrade(id))!);
    assert.equal(r.ok, true, r.ok ? '' : r.problem.text);
    const kept = await s.kit.store.secretsOfTrade(id);
    assert.equal(kept.length, 1, 'durable write 2: the secret is kept before any lock is signed');
    await crash(s);
    const s2 = await kitFor(w, s.bot);
    const out = await stepUntil(w, s2, id, (x) => x.action === 'reportPhaLock' && x.outcome === 'done');
    assert.equal(w.pha.count('lock'), 1, 'one lock');
    assert.equal(w.board.trades.get(id)!.t.h, kept[0]!.h, 'under the kept secret\'s h');
    assert.equal(out.outcome, 'done');
  });

  test('3: the journal intent before the send: a send that never arrived is not sent again for 5 minutes, then once more under the same h', async () => {
    const w = world();
    const { s, id } = await sellOfferTaken(w);
    await s.kit.step(id, { acceptAfterS: 0 });
    w.pha.modes = ['lose'];
    const r1 = await s.kit.step(id);
    assert.equal(r1.action, 'lockPha');
    assert.equal(r1.outcome, 'pending');
    const open = await s.kit.store.openIntents();
    assert.equal(open.length, 1, 'durable write 3: the intent was kept before the send');
    await crash(s);
    let s2 = await kitFor(w, s.bot);
    w.vt.ms += 60_000;
    const r2 = await s2.kit.step(id);
    assert.equal(r2.outcome, 'pending', 'no blind resend');
    assert.equal(w.pha.sent.length, 1);
    await crash(s2);
    w.vt.ms += 5 * 60_000;
    s2 = await kitFor(w, s.bot);
    await stepUntil(w, s2, id, (x) => x.action === 'reportPhaLock' && x.outcome === 'done');
    assert.equal(w.pha.sent.length, 2, 'sent once more, after the first was resolved as not sent');
    const j = await s2.kit.store.getJournal(id);
    assert.deepEqual(j.intents.map((i) => i.outcome), ['not_sent', 'confirmed']);
    assert.equal(new Set(j.intents.map((i) => i.h)).size, 1, 'the same h both times');
    assert.equal(w.board.trades.get(id)!.t.status, 'pha_locked');
  });

  test('3b: a lock that landed but whose answer was lost is resolved from the chain and reported, never sent again', async () => {
    const w = world();
    const { s, id } = await sellOfferTaken(w);
    await s.kit.step(id, { acceptAfterS: 0 });
    w.pha.modes = ['drop'];
    assert.equal((await s.kit.step(id)).outcome, 'pending');
    await crash(s);
    const s2 = await kitFor(w, s.bot);
    await stepUntil(w, s2, id, (x) => x.action === 'reportPhaLock' && x.outcome === 'done');
    assert.equal(w.pha.sent.length, 1);
    assert.deepEqual((await s2.kit.store.getJournal(id)).intents.map((i) => i.outcome), ['confirmed']);
  });

  test('4: the tx hash kept as the send returns: a USDC lock still in the mempool at the crash is resolved and reported after the restart', async () => {
    const w = world();
    const { s, b, id } = await sellOfferTaken(w);
    await s.kit.step(id, { acceptAfterS: 0 });
    await stepUntil(w, s, id, (x) => x.action === 'reportPhaLock' && x.outcome === 'done');
    w.base.modes = ['mempool'];
    const r = await b.kit.step(id);
    assert.equal(r.action, 'lockBase');
    assert.equal(r.outcome, 'pending');
    const open = await b.kit.store.openIntents();
    assert.equal(open.length, 1);
    assert.ok(open[0]!.intent.txHash, 'durable write 4: the hash is kept');
    await crash(b);
    await w.base.mineAll();
    const b2 = await kitFor(w, b.bot);
    await stepUntil(w, b2, id, (x) => x.action === 'reportBaseLock' && x.outcome === 'done');
    assert.equal(w.base.count('lockWithPermit'), 1, 'never sent again');
    assert.equal(w.board.trades.get(id)!.t.status, 'base_locked');
  });

  test('4b: the seller\'s USDC claim lost in flight is resolved on restart; the trade finishes with one claim', async () => {
    const w = world();
    const { s, b, id } = await sellOfferTaken(w);
    await stepBoth(w, s, b, id, () => w.board.trades.get(id)!.t.status === 'base_locked');
    w.base.modes = ['mempool'];
    await stepUntil(w, s, id, (x) => x.action === 'claimBase' && x.outcome === 'pending');
    await crash(s);
    await w.base.mineAll();
    const s2 = await kitFor(w, s.bot);
    await stepUntil(w, s2, id, (x) => x.outcome === 'finished');
    assert.equal(w.base.count('claim'), 1);
  });
});

describe('a lock that already exists is reported, never sent again', () => {
  test('LOCKED_ALREADY from the signer\'s re-check (the seller\'s own lock landed after its checks): reported under that h, 0 sends', async () => {
    const w = world();
    const { s, b, id } = await sellOfferTaken(w);
    await s.kit.step(id, { acceptAfterS: 0 });
    // The second read of the new h (the signer's re-check) finds this trade's own lock already there.
    const reads = new Map<string, number>();
    const realViews = w.pha.views.bind(w.pha);
    w.pha.views = async (calls) => {
      for (const c of calls) {
        if (c.method !== 'getState') continue;
        const h = decimalToHex(c.args[0])!;
        const n = (reads.get(h) ?? 0) + 1;
        reads.set(h, n);
        if (n === 2 && !w.pha.locks.has(h)) {
          w.pha.locks.set(h, { state: 1, sender: s.bot.pha, recipient: b.bot.pha, symbol: 'TAZ', amount: TAZ2, deadline: w.board.nowS + CFG.timing.phaLock, created: w.board.nowS });
        }
      }
      return realViews(calls);
    };
    const r = await s.kit.step(id);
    assert.equal(r.action, 'reportPhaLock');
    assert.equal(r.outcome, 'done');
    assert.equal(w.pha.sent.length, 0, 'never locked again');
    const t = w.board.trades.get(id)!.t;
    assert.equal(t.status, 'pha_locked');
    assert.equal(t.h, (await s.kit.store.getTrade(id))!.h);
  });

  test('USDC_LOCKED_ALREADY from the buyer\'s checks (its own USDC lock is on chain, the board never heard): reported with that transaction, 0 sends', async () => {
    const w = world();
    const { s, b, id } = await sellOfferTaken(w);
    await stepBoth(w, s, b, id, () => w.board.trades.get(id)!.t.status === 'base_locked', { acceptAfterS: 0 });
    const sentBefore = w.base.sent.length;
    // The board lost the report (it shows pha_locked again), and the engine's first read of the swap comes from a node behind.
    Object.assign(w.board.trades.get(id)!.t, { status: 'pha_locked', baseLockTx: null });
    let first = true;
    const realRead = w.base.read.bind(w.base);
    w.base.read = async (c) => {
      if (c.functionName === 'getSwap' && first) {
        first = false;
        return { token: ZERO, deadline: 0n, feeBps: 0, state: 0, sender: ZERO, claimer: ZERO, amount: 0n };
      }
      return realRead(c);
    };
    const r = await b.kit.step(id);
    assert.equal(r.action, 'reportBaseLock');
    assert.equal(r.outcome, 'done');
    assert.equal(w.base.sent.length, sentBefore, 'never locked again');
    assert.equal(w.board.trades.get(id)!.t.status, 'base_locked');
    assert.equal(w.board.trades.get(id)!.t.baseLockTx, (await b.kit.store.getTrade(id))!.txs.baseLock);
  });
});

// ── 7. Refunds and races with the keeper (section 6.6) ───────────────────────

describe('refunds, and losing a race to the keeper counts as success', () => {
  test('the seller refunds its tokens after T1 + 60 s when the buyer never locks', async () => {
    const w = world();
    const { s, id } = await sellOfferTaken(w);
    await s.kit.step(id, { acceptAfterS: 0 });
    await stepUntil(w, s, id, (x) => x.action === 'reportPhaLock');
    const t1 = (await s.kit.store.getTrade(id))!.t1!;
    w.vt.ms = (t1 + 30) * 1000;
    const early = await s.kit.step(id);
    assert.notEqual(early.action, 'refundPha', 'not before T1 + 60');
    w.vt.ms = (t1 + 61) * 1000;
    await stepUntil(w, s, id, (x) => x.action === 'refundPha' && x.outcome === 'done');
    assert.equal(w.pha.locks.get((await s.kit.store.getTrade(id))!.h!)!.state, 3);
    await stepUntil(w, s, id, (x) => x.outcome === 'finished');
  });

  test('past T1 + 60 s the seller refunds its tokens even while a USDC lock it may not claim is still in place', async () => {
    const w = world();
    const { s, b, id } = await sellOfferTaken(w);
    await stepBoth(w, s, b, id, () => w.board.trades.get(id)!.t.status === 'base_locked', { acceptAfterS: 0 });
    // The buyer's lock reads a fee above the one the seller was shown: the seller never claims it (check 55).
    const h = (await s.kit.store.getTrade(id))!.h!;
    w.base.swaps.get(`${h}|${b.bot.base}`)!.feeBps = 150;
    w.vt.ms += 10_000;
    const r = await s.kit.step(id);
    assert.equal(r.action, 'claimBase');
    assert.equal(r.outcome, 'refused');
    // The buyer never refunds its USDC (its bot is down): past T1 the seller's tokens come back all the same.
    const t1 = (await s.kit.store.getTrade(id))!.t1!;
    w.vt.ms = (t1 + 61) * 1000;
    await stepUntil(w, s, id, (x) => x.action === 'refundPha' && x.outcome === 'done');
    assert.equal(w.pha.locks.get(h)!.state, 3);
    assert.equal(w.base.count('claim'), 0);
  });

  test('the buyer refunds its USDC after T2 + 30 s when the seller never claims', async () => {
    const w = world();
    const { s, b, id } = await sellOfferTaken(w);
    await stepBoth(w, s, b, id, () => w.board.trades.get(id)!.t.status === 'base_locked', { acceptAfterS: 0 });
    const t2 = (await b.kit.store.getTrade(id))!.t2!;
    w.vt.ms = (t2 + 31) * 1000;
    await stepUntil(w, b, id, (x) => x.action === 'refundBase' && x.outcome === 'done');
    await stepUntil(w, b, id, (x) => x.outcome === 'finished');
    assert.equal(w.base.count('refund'), 1);
  });

  test('the keeper refunded the seller\'s tokens first: done elsewhere, no refund sent', async () => {
    const w = world();
    const { s, id } = await sellOfferTaken(w);
    await s.kit.step(id, { acceptAfterS: 0 });
    await stepUntil(w, s, id, (x) => x.action === 'reportPhaLock');
    const t1 = (await s.kit.store.getTrade(id))!.t1!;
    w.vt.ms = (t1 + 61) * 1000;
    w.board.keeperRefundToken(id);
    const r = await stepUntil(w, s, id, (x) => x.outcome === 'finished' || x.outcome === 'done');
    assert.ok(r.outcome === 'finished' || r.doneElsewhere, JSON.stringify(r));
    assert.equal(w.pha.count('refund'), 0);
  });

  test('the keeper claimed the buyer\'s tokens within claimWatchS (the default CLAIM_WATCH): the buyer finishes without a claim of its own', async () => {
    const w = world();
    const { s, b, id } = await sellOfferTaken(w);
    await stepBoth(w, s, b, id, () => w.base.count('claim') === 1, { acceptAfterS: 0 });
    // The buyer sees its USDC claimed and waits CLAIM_WATCH for the keeper.
    const r = await stepUntil(w, b, id, (x) => x.action === 'claimPha' && x.outcome === 'waiting', { everyMs: 1_000 });
    assert.equal(r.waitingFor, 'time');
    w.vt.ms += 10_000;
    w.board.keeperClaimToken(id);
    await stepUntil(w, b, id, (x) => x.outcome === 'finished');
    assert.equal(w.pha.count('claim'), 0, 'the keeper won; nothing was sent');
  });

  test('claimMode reveal-then-self: the secret is posted once, the keeper claims the USDC first, and the seller finishes with no claim of its own', async () => {
    const w = world();
    const { s, b, id } = await sellOfferTaken(w, { sellerOpts: { claimMode: 'reveal-then-self' } });
    await stepBoth(w, s, b, id, () => w.board.reveals.length === 1, { acceptAfterS: 0 });
    w.board.keeperClaimUsdc(id);
    await stepUntil(w, s, id, (x) => x.outcome === 'finished');
    assert.equal(w.base.count('claim'), 0, 'the seller sent no claim');
    assert.equal(w.board.count('POST', /\/reveal$/), 1);
  });

  test('claimMode reveal-then-self without a keeper: after CLAIM_WATCH the seller claims itself', async () => {
    const w = world();
    const { s, b, id } = await sellOfferTaken(w, { sellerOpts: { claimMode: 'reveal-then-self' } });
    await stepBoth(w, s, b, id, () => w.board.reveals.length === 1, { acceptAfterS: 0 });
    const r = await s.kit.step(id);
    assert.equal(r.outcome, 'waiting', 'within CLAIM_WATCH the keeper is left to claim');
    w.vt.ms += CFG.timing.claimWatch * 1000;
    await stepUntil(w, s, id, (x) => x.action === 'claimBase' && x.outcome === 'done');
    assert.equal(w.base.count('claim'), 1);
  });
});

// ── 8. The taker: limits and the price sent ──────────────────────────────────

describe('take, buyUpTo and sellDownTo', () => {
  test('buyUpTo takes the cheapest offers at or under maxPrice; each trade keeps the price it sent', async () => {
    const w = world();
    const s1 = await kitFor(w, await newBot(w));
    const s2 = await kitFor(w, await newBot(w));
    const s3 = await kitFor(w, await newBot(w));
    const b = await kitFor(w, await newBot(w));
    await s1.kit.postOffer({ ...SELL, price: '1.08' });
    await s2.kit.postOffer({ ...SELL, price: '1.05' });
    await s3.kit.postOffer({ ...SELL, price: '1.20' });
    const trades = await b.kit.buyUpTo({ symbol: 'TAZ', amount: '7', maxPrice: '1.10' });
    assert.deepEqual(trades.map((t) => [t.offerId, t.taz, t.price]), [[2, '5000000000', '1050000'], [1, '2000000000', '1080000']]);
    for (const t of trades) assert.equal(w.board.trades.get(t.id)!.takeBody.price, t.price, 'LocalTrade.price is the price sent');
    assert.ok(![...w.board.trades.values()].some((x) => x.t.offerId === 3), 'never above maxPrice');
  });

  test('buyUpTo refuses to lock a trade the board priced above maxPrice: PRICE_LIMIT, 0 sends', async () => {
    const w = world();
    const s = await kitFor(w, await newBot(w));
    const b = await kitFor(w, await newBot(w));
    await s.kit.postOffer(SELL);
    w.board.takePrice = '1200000';
    await assert.rejects(b.kit.buyUpTo({ symbol: 'TAZ', amount: '2', maxPrice: '1.10' }), (e: unknown) => e instanceof SafetyError && e.code === 'PRICE_LIMIT');
    w.board.takePrice = null;
    const id = 1;
    const rec = (await b.kit.store.getTrade(id))!;
    assert.equal(rec.price, PRICE.toString(), 'the record keeps the price the kit sent');
    // The seller accepts and locks (at the board's price): the buyer still never locks.
    const sr = await s.kit.step(id, { acceptAfterS: 0 });
    assert.notEqual(sr.outcome, 'failed');
    await stepUntil(w, s, id, (x) => x.action === 'reportPhaLock' || x.outcome === 'refused');
    const lockedOnBoard = w.board.trades.get(id)!.t;
    if (lockedOnBoard.status !== 'pha_locked') {
      // The seller refused too (the board's USDC does not match its price): put a lock on chain and the board at pha_locked by hand.
      const h = '0x' + '77'.repeat(32);
      w.pha.locks.set(h, { state: 1, sender: lockedOnBoard.seller.pha, recipient: lockedOnBoard.buyer.pha, symbol: 'TAZ', amount: TAZ2, deadline: w.board.nowS + CFG.timing.phaLock, created: w.board.nowS });
      Object.assign(lockedOnBoard, { status: 'pha_locked', h, phaContract: 'saturnescrow', feeBps: 50 });
    }
    const before = w.base.sent.length;
    const r = await b.kit.step(id);
    assert.equal(r.outcome, 'refused');
    assert.equal(r.code, 'PRICE_LIMIT');
    assert.equal(r.check, 14);
    assert.equal(w.base.sent.length, before, '0 sends');
  });

  test('sellDownTo refuses to lock a trade the board priced below minPrice: PRICE_LIMIT, 0 sends', async () => {
    const w = world();
    const buyer = await kitFor(w, await newBot(w));
    const seller = await kitFor(w, await newBot(w));
    await buyer.kit.postOffer(BUY);
    w.board.takePrice = '1000000';
    await assert.rejects(seller.kit.sellDownTo({ symbol: 'TAZ', amount: '2', minPrice: '1.05' }), (e: unknown) => e instanceof SafetyError && e.code === 'PRICE_LIMIT');
    w.board.takePrice = null;
    await buyer.kit.step(1, { acceptAfterS: 0 });
    // The buyer bot refuses the trade (it does not fit its offer), so the board is put at accepted by hand.
    Object.assign(w.board.trades.get(1)!.t, { status: 'accepted', feeBps: 50, lockBy: w.board.nowS + 600 });
    const before = w.pha.sent.length;
    const r = await seller.kit.step(1);
    assert.equal(r.code, 'PRICE_LIMIT');
    assert.equal(r.outcome, 'refused');
    assert.equal(w.pha.sent.length, before, '0 sends');
  });

  test('take: PRICE_CHANGED is not sent again; the offer is read again and the refusal returned', async () => {
    const w = world();
    const s = await kitFor(w, await newBot(w));
    const b = await kitFor(w, await newBot(w));
    const offer = await s.kit.postOffer(SELL);
    w.board.script = (m, p) => {
      if (m === 'POST' && /\/take$/.test(p)) w.board.offers.get(offer.id)!.o.price = '1100000';
      return undefined;
    };
    await assert.rejects(b.kit.take(offer.id, '2'), (e: unknown) => e instanceof BoardError && e.code === 'PRICE_CHANGED');
    assert.equal(w.board.count('POST', /\/take$/), 1, 'sent once');
    assert.equal(w.board.trades.size, 0);
    assert.ok(b.logs.some((l) => /changed its price/.test(l)));
  });

  test('take refuses the bot\'s own offer, an amount outside the offer, and a buyer without the USDC', async () => {
    const w = world();
    const s = await kitFor(w, await newBot(w));
    const b = await kitFor(w, await newBot(w));
    const offer = await s.kit.postOffer(SELL);
    await assert.rejects(s.kit.take(offer.id, '2'), (e: unknown) => e instanceof SafetyError && e.code === 'OWN_OFFER');
    await assert.rejects(b.kit.take(offer.id, '6'), (e: unknown) => e instanceof SafetyError && e.code === 'TAKE_INVALID');
    w.base.usdc.set(b.bot.base, 1_000_000n);
    await assert.rejects(b.kit.take(offer.id, '2'), (e: unknown) => e instanceof SafetyError && e.code === 'BUYER_NOT_READY');
    assert.equal(w.board.count('POST', /\/take$/), 0);
  });

  test('planFill: buy cheapest first, older first at one price; own and offline offers left out; legs inside the bounds', () => {
    const o = (id: number, price: string, x: Partial<Offer> = {}): Offer => ({
      id, network: 'devnet', side: 'sell', makerPha: 'P2K' + 'M'.repeat(44), makerBase: '0x' + 'c3'.repeat(20), symbol: 'TAZ',
      tazTotal: '10000000000', tazMin: '1000000000', tazMax: '5000000000', price, remaining: '10000000000', status: 'open', online: true,
      createdAt: 0, heartbeatAt: 0, closedAt: null, ...x
    });
    const me = { pha: 'P2K' + 'B'.repeat(44), base: '0x' + 'b7'.repeat(20) };
    const bounds = { usdcMin: 1_000_000n, usdcMax: 100_000_000_000n };
    const offers = [o(5, '1080000'), o(4, '1050000'), o(3, '1050000'), o(6, '1000000', { online: false }), o(7, '1000000', { makerPha: me.pha }), o(8, '1200000')];
    const p = planFill({ side: 'buy', symbol: 'TAZ', amount: 12_000_000_000n, limit: 1_100_000n, me, bounds, offers });
    assert.deepEqual(p.legs.map((l) => [l.offerId, l.taz]), [[3, 5_000_000_000n], [4, 5_000_000_000n], [5, 2_000_000_000n]]);
    assert.equal(p.left, 0n);
    // More than the offers at or under the limit hold: the rest stays unfilled, never bought above the limit.
    const more = planFill({ side: 'buy', symbol: 'TAZ', amount: 20_000_000_000n, limit: 1_100_000n, me, bounds, offers });
    assert.deepEqual(more.legs.map((l) => l.offerId), [3, 4, 5]);
    assert.equal(more.left, 5_000_000_000n);
    const sell = planFill({ side: 'sell', symbol: 'TAZ', amount: 2_000_000_000n, limit: 1_050_000n, me, bounds, offers: [o(1, '1100000', { side: 'buy' }), o(2, '1000000', { side: 'buy' })] });
    assert.deepEqual(sell.legs.map((l) => l.offerId), [1], 'a sell never goes under its minimum price');
  });

  test('planFill leaves out offers that follow the reference price while the board lists them as paused (build spec section 11.y)', () => {
    const o = (id: number, price: string, x: Partial<Offer> = {}): Offer => ({
      id, network: 'devnet', side: 'sell', makerPha: 'P2K' + 'M'.repeat(44), makerBase: '0x' + 'c3'.repeat(20), symbol: 'TAZ',
      tazTotal: '10000000000', tazMin: '1000000000', tazMax: '5000000000', price, remaining: '10000000000', status: 'open', online: true,
      createdAt: 0, heartbeatAt: 0, closedAt: null, ...x
    });
    const follow = (state: 'live' | 'paused') => ({ offsetBps: 200, limitPrice: '900000', dailyMax: '10000000000', state, filled24h: '0' });
    const me = { pha: 'P2K' + 'B'.repeat(44), base: '0x' + 'b7'.repeat(20) };
    const bounds = { usdcMin: 1_000_000n, usdcMax: 100_000_000_000n };
    // The cheapest ask and the best bid are paused: a take of either gets 409 FOLLOW_PAUSED, so neither is planned.
    const offers = [
      o(1, '1000000', { follow: follow('paused') }), o(2, '1020000', { follow: follow('live') }), o(3, '1040000', { follow: null }), o(4, '1060000'),
      o(5, '1100000', { side: 'buy', follow: follow('paused') }), o(6, '1050000', { side: 'buy', follow: follow('live') })
    ];
    const buy = planFill({ side: 'buy', symbol: 'TAZ', amount: 12_000_000_000n, limit: 1_100_000n, me, bounds, offers });
    assert.deepEqual(buy.legs.map((l) => [l.offerId, l.taz]), [[2, 5_000_000_000n], [3, 5_000_000_000n], [4, 2_000_000_000n]]);
    assert.equal(buy.usdcTotal, 5_100_000n + 5_200_000n + 2_120_000n, 'the paused offer\'s USDC is not counted toward the order');
    assert.deepEqual(planFill({ side: 'buy', symbol: 'TAZ', amount: 2_000_000_000n, limit: 1_000_000n, me, bounds, offers }).legs, [], 'only a paused offer at the limit: nothing planned');
    assert.deepEqual(planFill({ side: 'sell', symbol: 'TAZ', amount: 2_000_000_000n, limit: 1_000_000n, me, bounds, offers }).legs.map((l) => l.offerId), [6], 'selling skips the paused bid');
  });
});

// ── 9. run(): both bots together, bounded long-polls ─────────────────────────

describe('run(): two bots trading with each other', () => {
  test('a seller bot and a buyer bot complete a trade on their own; the take is accepted at once (acceptAfterS 0), nothing is revealed, long-polls stay bounded', async () => {
    const w = world();
    const s = await kitFor(w, await newBot(w), { virtual: true });
    const b = await kitFor(w, await newBot(w), { virtual: true });
    const ctl = new AbortController();
    const policy = { acceptAfterS: 0, claimWatchS: 0 };
    const offer = await s.kit.postOffer(SELL);
    const runs = [s.kit.run(policy, ctl.signal), b.kit.run(policy, ctl.signal)];
    await w.vt.advance(1_000);
    const [taken] = await b.kit.buyUpTo({ symbol: 'TAZ', amount: '2', maxPrice: '1.08' });
    assert.ok(taken);
    const id = taken.id;
    let acceptedAt: number | null = null;
    const takenAt = w.vt.ms;
    for (let i = 0; i < 400; i++) {
      if (acceptedAt == null && w.board.trades.get(id)!.t.status !== 'requested') acceptedAt = w.vt.ms;
      const sd = (await s.kit.store.getTrade(id))?.endedAt, bd = (await b.kit.store.getTrade(id))?.endedAt;
      if (sd && bd) break;
      await w.vt.advance(1_000);
    }
    ctl.abort();
    await Promise.all(runs);
    assert.ok((await s.kit.store.getTrade(id))?.endedAt, 'the seller finished');
    assert.ok((await b.kit.store.getTrade(id))?.endedAt, 'the buyer finished');
    assert.equal(w.board.trades.get(id)!.t.status, 'done');
    assert.equal(w.board.reveals.length, 0);
    assert.ok(acceptedAt != null && acceptedAt - takenAt <= 6_000, `accepted within one heartbeat round (${acceptedAt! - takenAt} ms)`);
    assert.equal(w.pha.count('lock'), 1);
    assert.equal(w.base.count('lockWithPermit'), 1);
    assert.equal(w.base.count('claim'), 1);
    assert.equal(w.pha.count('claim'), 1);
    assert.ok(w.board.maxHeld <= 5, `held long-polls at most 1 heartbeat + 4 trades (${w.board.maxHeld})`);
    assert.ok(offer.id > 0);
  });

  test('trade long-polls are bounded to 4 without an API key, whatever the number of waiting trades', async () => {
    const w = world();
    const sellers = [];
    for (let i = 0; i < 3; i++) sellers.push(await kitFor(w, await newBot(w)));
    for (const s of sellers) await s.kit.postOffer({ ...SELL, total: '30', max: '5' });
    const b = await kitFor(w, await newBot(w), { virtual: true });
    const trades = await b.kit.buyUpTo({ symbol: 'TAZ', amount: '15', maxPrice: '1.08', maxLegs: 3 });
    for (const sl of sellers.slice(0, 2)) await sl.kit.postOffer({ ...SELL, total: '30', max: '5' });
    trades.push(...await b.kit.buyUpTo({ symbol: 'TAZ', amount: '10', maxPrice: '1.08', maxLegs: 3 }));
    assert.ok(trades.length >= 5, `${trades.length} trades waiting for the makers`);
    const ctl = new AbortController();
    const run = b.kit.run({}, ctl.signal);
    for (let i = 0; i < 30; i++) await w.vt.advance(1_000);
    ctl.abort();
    await run;
    assert.ok(w.board.maxTradeHeld > 0, 'trade long-polls were used');
    assert.ok(w.board.maxTradeHeld <= 4, `at most 4 trade long-polls at once (${w.board.maxTradeHeld})`);
  });
});

// ── 10. preflight and the kit object ─────────────────────────────────────────

describe('preflight and the kit object', () => {
  test('preflight reads the pins, the vectors, SaturnSwap, the escrow per token, the balances and the clock, and sends nothing', async () => {
    const w = world();
    const h = await kitFor(w, await newBot(w));
    const rep = await h.kit.preflight();
    assert.equal(rep.ok, true, JSON.stringify(rep.items.filter((i) => !i.ok)));
    for (const name of ['pins', 'code pin', 'hash vectors', 'base chain', 'saturnswap', 'escrow TAZ', 'escrow RA', 'phantasma balance', 'base balance', 'clock', 'board']) {
      assert.ok(rep.items.some((i) => i.name === name && i.ok), name);
    }
    assert.equal(rep.balances.pha?.TAZ, (100n * 10n ** 9n).toString());
    assert.equal(rep.balances.base?.usdc, '1000000000');
    assert.equal(rep.clockSkewS !== null && Math.abs(rep.clockSkewS) <= 2, true);
    assert.equal(w.pha.sent.length + w.base.sent.length, 0, 'reads only');
    assert.equal(w.board.calls.filter((c) => c.method === 'POST').length, 0, 'no board write');
    w.pha.admin = 'P2K' + 'X'.repeat(44);
    const bad = await h.kit.preflight();
    assert.equal(bad.ok, false);
    assert.equal(bad.items.find((i) => i.name === 'code pin')?.code, 'CODE_PIN');
    w.pha.admin = CFG.phaAdmin;
    w.vt.ms += 10 * 60_000;
    w.base.chain = 84532;
    const skew = await createKit({ network: 'devnet', api: 'http://127.0.0.1:9', phaKeyFile: h.bot.phaKeyFile, baseKeyFile: h.bot.baseKeyFile, dataDir: join(await tempDir(), 'd'), env: {},
      internals: { fetch: w.board.fetch as typeof fetch, pha: w.pha, base: w.base, now: () => w.vt.ms + 10 * 60_000, sleep: w.vt.jump, argv: ['node'], storeKeyFile: null } });
    kits.push(skew);
    const r2 = await skew.preflight();
    assert.equal(r2.items.find((i) => i.name === 'clock')?.code, 'CLOCK_SKEW', 'a clock 10 minutes off is reported');
  });

  test('run() twice at once, and close() while running, are refused; close() after run() ends releases the data directory', async () => {
    const w = world();
    const bot = await newBot(w);
    const h = await kitFor(w, bot, { virtual: true });
    const ctl = new AbortController();
    const run = h.kit.run({}, ctl.signal);
    await w.vt.advance(100);
    await assert.rejects(h.kit.run({}, ctl.signal), (e: unknown) => e instanceof SafetyError && e.code === 'ALREADY_RUNNING');
    await assert.rejects(h.kit.close(), (e: unknown) => e instanceof SafetyError && e.code === 'ALREADY_RUNNING');
    ctl.abort();
    await run;
    // A second kit on the same data directory is refused while the first holds it.
    await assert.rejects(kitFor(w, bot), (e: unknown) => e instanceof SafetyError && e.code === 'STORE_LOCKED');
    await crash(h);
    const again = await kitFor(w, bot);
    assert.equal(again.kit.network, 'devnet');
  });

  test('step() on a take no heartbeat brought yet adopts it (checks 15 and 13), and refuses a trade the kit does not know', async () => {
    const w = world();
    const { s, id } = await sellOfferTaken(w);
    assert.equal(await s.kit.store.getTrade(id), null);
    await s.kit.step(id, { acceptAfterS: 0 });
    const rec = await s.kit.store.getTrade(id);
    assert.equal(rec?.maker, true);
    assert.equal(rec?.role, 'S');
    assert.equal(rec?.price, PRICE.toString());
    const r = await s.kit.step(999);
    assert.equal(r.code, 'NOT_KEPT');
  });
});

// ── 11. Independent audit ────────────────────────────────────────────────────

describe('audit: time limits, check 14 before a report, the manual accept, and the README example', () => {
  test('a long claimWatchS never waits past the lock\'s time limit: without a keeper the buyer claims its tokens itself while T1 - now >= CLAIM_MARGIN', async () => {
    const w = world();
    const { s, b, id } = await sellOfferTaken(w);
    await stepBoth(w, s, b, id, () => w.base.count('claim') === 1, { acceptAfterS: 0 });
    const policy: Policy = { claimWatchS: 86_400 };
    const r = await stepUntil(w, b, id, (x) => x.action === 'claimPha' && x.outcome === 'waiting', { everyMs: 1_000, policy });
    assert.equal(r.waitingFor, 'time');
    const t1 = (await b.kit.store.getTrade(id))!.t1!;
    // The keeper never claims: the buyer claims its TAZ itself, in time.
    const done = await stepUntil(w, b, id, (x) => x.action === 'claimPha' && x.outcome === 'done', { everyMs: 30_000, max: 200 });
    assert.equal(done.doneElsewhere, undefined);
    assert.equal(w.pha.count('claim'), 1);
    assert.ok(w.board.nowS >= t1 - CFG.timing.claimMargin, 'the keeper was waited for until CLAIM_MARGIN before T1');
    assert.ok(w.board.nowS <= t1 - CFG.timing.claimMargin + 30, 'and no longer: the claim went out CLAIM_MARGIN before T1');
    assert.equal(w.pha.locks.get((await b.kit.store.getTrade(id))!.h!)!.state, 2);
  });

  test('14 before a report: a lock found after a crash is recorded but not reported while the board\'s trade does not match; reported once it does', async () => {
    const w = world();
    const { s, id } = await sellOfferTaken(w);
    await s.kit.step(id, { acceptAfterS: 0 });
    w.pha.modes = ['drop'];
    assert.equal((await s.kit.step(id)).outcome, 'pending');
    await crash(s);
    // The board now shows another price for the trade (a board that lies).
    const bt = w.board.trades.get(id)!.t;
    const realPrice = bt.price;
    bt.price = (BigInt(realPrice) + 1n).toString();
    const s2 = await kitFor(w, s.bot);
    for (let i = 0; i < 4; i++) {
      await s2.kit.step(id);
      w.vt.ms += 2_000;
    }
    assert.equal(w.board.count('POST', /\/pha-locked$/), 0, 'nothing is reported for a trade that does not match');
    assert.ok((await s2.kit.store.getTrade(id))!.h, 'the lock is recorded all the same (claims and refunds never need the board)');
    assert.equal(w.pha.sent.length, 1, 'never locked again');
    bt.price = realPrice;
    await stepUntil(w, s2, id, (x) => x.action === 'reportPhaLock' && x.outcome === 'done');
    assert.equal(w.board.trades.get(id)!.t.status, 'pha_locked');
  });

  test('acceptTake: a seller without the tokens its lock needs is refused before the accept goes out', async () => {
    const w = world();
    const s = await kitFor(w, await newBot(w));
    const b = await kitFor(w, await newBot(w));
    const offer = await s.kit.postOffer({ ...SELL, acceptOnTheirOwn: false });
    const taken = await b.kit.take(offer.id, '2');
    await s.kit.step(taken.id, { acceptAfterS: 0 });
    w.pha.bals.set(s.bot.pha, [{ symbol: 'TAZ', amount: '1', decimals: 9 }, { symbol: 'SOUL', amount: (5n * 10n ** 8n).toString(), decimals: 8 }]);
    await assert.rejects(s.kit.acceptTake(taken.id), (e: unknown) => e instanceof SafetyError && e.code === 'SELLER_FUNDS');
    assert.equal(w.board.count('POST', /\/accept$/), 0, 'no accept went out');
    assert.equal(w.board.trades.get(taken.id)!.t.status, 'requested');
  });

  test('buyUpTo: a take whose answer was lost counts against the buyer\'s USDC when the order plans again, so the order never commits more than the bot holds', async () => {
    const w = world();
    const sellers = [];
    for (let i = 0; i < 4; i++) sellers.push(await kitFor(w, await newBot(w)));
    const offers = [];
    for (const s of sellers) offers.push(await s.kit.postOffer({ ...SELL, total: '10', max: '2' }));
    const [a, bb, c, d] = offers;
    // Two offers are online when the order plans first; two more come online while it runs.
    w.board.offers.get(c!.id)!.o.online = false;
    w.board.offers.get(d!.id)!.o.online = false;
    const b = await kitFor(w, await newBot(w));
    // 5 USDC: two legs of 2 TAZ at 1.08 (4.32 USDC) fit, three (6.48) do not.
    w.base.usdc.set(b.bot.base, 5_000_000n);
    w.board.script = (method, path) => {
      if (method !== 'POST') return undefined;
      if (path === `/v1/p2p/offers/${a!.id}/take`) return 'drop';
      if (path === `/v1/p2p/offers/${bb!.id}/take`) {
        w.board.offers.get(c!.id)!.o.online = true;
        w.board.offers.get(d!.id)!.o.online = true;
        return { status: 409, json: { error: { code: 'PRICE_CHANGED', message: 'The price changed', retryable: false } } };
      }
      return undefined;
    };
    const out = await b.kit.buyUpTo({ symbol: 'TAZ', amount: '6', maxPrice: '1.08' }).catch((e: unknown) => e);
    w.board.script = null;
    const made = [...w.board.trades.values()].filter((x) => x.t.buyer.base.toLowerCase() === b.bot.base);
    assert.ok(made.some((x) => x.t.offerId === a!.id), 'the take whose answer was lost exists on the board');
    const committed = made.reduce((sum, x) => sum + BigInt(x.t.usdc), 0n);
    assert.ok(committed <= 5_000_000n, `the board holds takes of ${committed} raw USDC for a bot holding 5000000 (${Array.isArray(out) ? out.length + ' trades' : String(out)})`);
  });

  test('a loop of its own: kit.resume() finds a take whose answer was lost (replayOnly after the GET /recent probe), and step() carries it on', async () => {
    const w = world();
    const s = await kitFor(w, await newBot(w));
    const b = await kitFor(w, await newBot(w));
    const offer = await s.kit.postOffer(SELL);
    w.board.script = (m, p) => (m === 'POST' && /\/take$/.test(p) ? 'drop' : undefined);
    await assert.rejects(b.kit.take(offer.id, '2'));
    w.board.script = null;
    const id = [...w.board.trades.keys()][0]!;
    assert.equal(await b.kit.store.getTrade(id), null, 'the trade is on the board, not in the store');
    w.vt.ms += 61_000;
    const rep = await b.kit.resume();
    assert.equal(rep.recorded, 1);
    assert.ok(w.board.calls.some((c) => c.path === '/v1/p2p/recent'), 'the board was probed for client hashes first');
    const rec = await b.kit.store.getTrade(id);
    assert.equal(rec?.price, PRICE.toString(), 'recorded with the price the kit sent');
    await stepBoth(w, s, b, id, () => w.board.trades.get(id)!.t.status === 'base_locked');
    assert.equal(w.board.trades.size, 1, 'no second trade');
  });

  test('a seller accepts only takes its balance covers together: tokens promised to its accepted trades not locked yet count as spent', async () => {
    const w = world();
    const s = await kitFor(w, await newBot(w));
    const b1 = await kitFor(w, await newBot(w));
    const b2 = await kitFor(w, await newBot(w));
    // 6 TAZ: one take of 5 can be locked, two cannot.
    w.pha.bals.set(s.bot.pha, [{ symbol: 'TAZ', amount: (6n * 10n ** 9n).toString(), decimals: 9 }, { symbol: 'SOUL', amount: (5n * 10n ** 8n).toString(), decimals: 8 }, { symbol: 'KCAL', amount: (10n * 10n ** 10n).toString(), decimals: 10 }]);
    const offer = await s.kit.postOffer(SELL);
    const t1 = await b1.kit.take(offer.id, '5');
    const t2 = await b2.kit.take(offer.id, '5');
    const r1 = await s.kit.step(t1.id, { acceptAfterS: 0 });
    assert.equal(r1.action, 'accept');
    assert.equal(r1.outcome, 'done');
    const r2 = await s.kit.step(t2.id, { acceptAfterS: 0 });
    assert.equal(r2.action, 'accept');
    assert.equal(r2.outcome, 'waiting', 'not accepted: its tokens are promised to the first trade');
    assert.equal(r2.code, 'ACCEPT_HELD');
    assert.equal(w.board.trades.get(t2.id)!.t.status, 'requested');
    // The same sum holds when the bot sells into a bid itself: 5 promised + 2 more is over its 6.
    const bidder = await kitFor(w, await newBot(w));
    await bidder.kit.postOffer(BUY);
    await assert.rejects(s.kit.sellDownTo({ symbol: 'TAZ', amount: '2', minPrice: '1.05' }), (e: unknown) => e instanceof SafetyError && e.code === 'SELLER_FUNDS');
    assert.equal(w.board.count('POST', /\/take$/), 2, 'no take of the bid was sent');
    // Once the first trade's tokens are locked they have left the balance, and the rule still holds.
    await stepUntil(w, s, t1.id, (x) => x.action === 'reportPhaLock' && x.outcome === 'done');
    w.pha.bals.set(s.bot.pha, [{ symbol: 'TAZ', amount: (1n * 10n ** 9n).toString(), decimals: 9 }, { symbol: 'SOUL', amount: (5n * 10n ** 8n).toString(), decimals: 8 }, { symbol: 'KCAL', amount: (10n * 10n ** 10n).toString(), decimals: 10 }]);
    assert.equal((await s.kit.step(t2.id)).code, 'ACCEPT_HELD');
  });

  test('run() stops as soon as it is aborted, also when the abort lands while its trade loop reads the store before it idles', async () => {
    const w = world();
    const h = await kitFor(w, await newBot(w), { virtual: true });
    const ctl = new AbortController();
    const store = h.kit.store as unknown as { listTrades: () => Promise<unknown[]> };
    const real = store.listTrades.bind(store);
    let inLoop = 0;
    store.listTrades = async () => {
      // The trade loop reads the store twice a round: for the due trades, then for its idle time. Abort during the second.
      const fromLoop = /tradeLoop/.test(new Error().stack ?? '');
      const r = await real();
      if (fromLoop && ++inLoop === 2) ctl.abort();
      return r;
    };
    const run = h.kit.run({}, ctl.signal);
    for (let i = 0; i < 50 && inLoop < 2; i++) await settle(5);
    assert.equal(inLoop >= 2, true, 'the trade loop ran');
    // Nothing moves the virtual clock from here: a stop that waits for its idle timer never comes.
    const how = await Promise.race([run.then(() => 'stopped'), settle(500).then(() => 'still running')]);
    assert.equal(how, 'stopped');
  });

  test('the README\'s "Write your own bot" example runs as written against the fakes: a restart posts nothing twice, and Ctrl-C cancels the offer and lets the trade finish', async () => {
    const readme = await (await import('node:fs/promises')).readFile(new URL('../README.md', import.meta.url), 'utf8');
    const sample = /## Write your own bot[\s\S]*?```ts\n([\s\S]*?)```/.exec(readme)?.[1] ?? '';
    // The sample this test follows, line by line.
    for (const line of [
      "phaKeyFile: './keys/mybot-pha.json',", "baseKeyFile: './keys/mybot-base.json',", "dataDir: './data/mybot',",
      'if (!report.ok) {', 'process.exit(1);',
      'const open = (await kit.store.listOffers()).filter((o) => o.closedAt == null);',
      "if (!open.some((o) => o.side === 'sell' && o.symbol === 'TAZ')) {",
      "await kit.postOffer({ side: 'sell', symbol: 'TAZ', total: '30', min: '1', max: '5', price: '1.08' });",
      "for (const o of (await kit.store.listOffers()).filter((x) => x.closedAt == null)) await kit.cancelOffer(o.id).catch(() => {});",
      'while (!stop.signal.aborted && (await kit.store.listTrades()).some((t) => !t.endedAt)) await new Promise((r) => setTimeout(r, 5_000));',
      'await kit.run({ acceptAfterS: 15 }, stop.signal);'
    ]) assert.ok(sample.includes(line), `the README sample has: ${line}`);
    assert.doesNotMatch(sample, /^await kit\.buyUpTo/m, 'no one-off order at every start');

    const w = world();
    const me = await newBot(w);
    const lines: string[] = [];
    const start = async () => {
      const kit = await createKit({
        network: 'devnet', phaKeyFile: me.phaKeyFile, baseKeyFile: me.baseKeyFile, dataDir: me.dataDir, log: (line) => lines.push(line), env: {},
        internals: { fetch: w.board.fetch as typeof fetch, pha: w.pha, base: w.base, now: w.vt.now, sleep: w.vt.sleep, argv: ['node', 'bot.ts'], storeKeyFile: null, pollWaitS: 5,
          signerSleep: async () => {}, signerWait: { phaTries: 1, phaIntervalMs: 0, baseTimeoutMs: 1, basePollMs: 1, allowanceTries: 2, allowancePollMs: 0 } }
      });
      kits.push(kit);
      const report = await kit.preflight();
      assert.equal(report.ok, true, JSON.stringify(report.items.filter((i) => !i.ok)));
      const open = (await kit.store.listOffers()).filter((o) => o.closedAt == null);
      if (!open.some((o) => o.side === 'sell' && o.symbol === 'TAZ')) {
        await kit.postOffer({ side: 'sell', symbol: 'TAZ', total: '30', min: '1', max: '5', price: '1.08' });
      }
      return kit;
    };
    // First start, then a crash and a second start: the offer kept in the store is the one run() lists; none is added.
    const first = await start();
    await first.close();
    kits.splice(kits.indexOf(first), 1);
    const kit = await start();
    assert.equal(w.board.offers.size, 1, 'one offer, however often the bot starts');
    const offerId = [...w.board.offers.keys()][0]!;
    // Another bot takes 2 TAZ of it while it runs.
    const buyer = await kitFor(w, await newBot(w), { virtual: true });
    const taken = await buyer.kit.take(offerId, '2');
    const stop = new AbortController();
    const other = new AbortController();
    const runs = [kit.run({ acceptAfterS: 15 }, stop.signal), buyer.kit.run({ acceptAfterS: 0, claimWatchS: 0 }, other.signal)];
    for (let i = 0; i < 100 && (await kit.store.getTrade(taken.id))?.status !== 'pha_locked'; i++) await w.vt.advance(1_000);
    // Ctrl-C, as the sample handles it: the offer is cancelled, the running trade is finished, then run() stops.
    const stopping = (async () => {
      for (const o of (await kit.store.listOffers()).filter((x) => x.closedAt == null)) await kit.cancelOffer(o.id).catch(() => {});
      while (!stop.signal.aborted && (await kit.store.listTrades()).some((t) => !t.endedAt)) await w.vt.sleep(5_000);
      stop.abort();
    })();
    for (let i = 0; i < 600 && !stop.signal.aborted; i++) await w.vt.advance(1_000);
    await stopping;
    assert.ok((await kit.store.getTrade(taken.id))?.endedAt, 'the running trade was finished for the bot before it stopped');
    assert.equal(w.base.count('claim'), 1, 'its USDC was claimed');
    for (let i = 0; i < 200 && w.board.trades.get(taken.id)!.t.status !== 'done'; i++) await w.vt.advance(1_000);
    other.abort();
    await Promise.all(runs);
    await kit.close();
    kits.splice(kits.indexOf(kit), 1);
    assert.equal(w.board.offers.get(offerId)!.o.status, 'closed', 'the offer was cancelled at the stop');
    assert.equal(w.board.trades.get(taken.id)!.t.status, 'done');
    assert.ok(lines.length > 0 && lines.every((l) => !me.secrets.some((k) => l.includes(k))), 'log lines carry no key');
  });
});

// ── 13. Wave B review: sends not mined, the secret's first way out, the board down, reorgs ──

describe('wave B review: a Base send not mined is followed at its own nonce', () => {
  /** A seller and a buyer at base_locked (both locks confirmed), the seller not claimed yet. */
  async function atBaseLocked(w: World, sellerOpts: Partial<KitOptions> = {}) {
    const t = await sellOfferTaken(w, { sellerOpts });
    await stepBoth(w, t.s, t.b, t.id, () => w.board.trades.get(t.id)!.t.status === 'base_locked', { acceptAfterS: 0 });
    const h = (await t.s.kit.store.getTrade(t.id))!.h!;
    const t2 = Number(w.base.swapAt(h, t.b.bot.base).deadline);
    return { ...t, h, t2 };
  }

  test('61: a claim not mined is replaced at its own nonce with fees at least 25% higher, never followed by a claim behind it; exactly one is mined', async () => {
    const w = world();
    const { s, id, h } = await atBaseLocked(w);
    w.base.modes = ['mempool', 'mempool', 'mempool'];
    await stepUntil(w, s, id, (x) => x.action === 'claimBase' && x.outcome === 'pending');
    assert.equal(w.base.sentOf('claim').length, 1);
    // Within REPLACE_AFTER the claim is left alone: no second send at all.
    w.vt.ms += 20_000;
    const wait = await s.kit.step(id);
    assert.equal(wait.action, 'claimBase');
    assert.equal(wait.outcome, 'pending');
    assert.equal(w.base.sentOf('claim').length, 1);
    // Base's fee rises; each step past REPLACE_AFTER replaces the claim at nonce 0.
    for (let i = 0; i < 2; i++) {
      w.base.baseFee *= 3n;
      w.vt.ms += 61_000;
      const r = await s.kit.step(id);
      assert.equal(r.action, 'claimBase', JSON.stringify(r));
      assert.equal(r.outcome, 'pending', JSON.stringify(r));
    }
    const claims = w.base.sentOf('claim');
    assert.equal(claims.length, 3);
    assert.deepEqual(claims.map((c) => c.nonce), [0, 0, 0], 'every claim at the first one\'s nonce');
    for (let i = 1; i < claims.length; i++) {
      assert.ok(claims[i]!.maxFee * 100n >= claims[i - 1]!.maxFee * 125n, `max fee ${i}: ${claims[i]!.maxFee} after ${claims[i - 1]!.maxFee}`);
      assert.ok(claims[i]!.tip * 100n >= claims[i - 1]!.tip * 125n, `tip ${i}: ${claims[i]!.tip} after ${claims[i - 1]!.tip}`);
    }
    const open = await s.kit.store.openIntents();
    assert.deepEqual(open.map((o) => o.intent.kind), ['claimBase'], 'one claim in the journal, still open');
    assert.deepEqual(open[0]!.intent.hashes, claims.map((c) => c.hash), 'every hash at the nonce is kept');
    assert.equal(w.base.mempool.size, 1, 'the node keeps only the newest claim at nonce 0');
    await w.base.mineAll();
    await stepUntil(w, s, id, (x) => x.outcome === 'finished');
    assert.deepEqual(claims.map((c) => w.base.receipts.get(c.hash)?.status ?? null), [null, null, 'success'], 'only the last replacement was mined');
    assert.equal(w.base.swapAt(h, w.board.trades.get(id)!.t.buyer.base).state, 2);
    assert.deepEqual((await s.kit.store.getJournal(id)).intents.filter((i) => i.kind === 'claimBase').map((i) => i.outcome), ['confirmed']);
    assertClean(s, [(await s.kit.store.secretsOfTrade(id))[0]!.secret]);
  });

  test('61: a claim still not mined when less than CLAIM_MARGIN is left is taken back at its nonce by a 0-value transfer, so it is never mined late', async () => {
    const w = world();
    const { s, id, h, t2 } = await atBaseLocked(w);
    w.base.modes = ['mempool'];
    await stepUntil(w, s, id, (x) => x.action === 'claimBase' && x.outcome === 'pending');
    const [claim] = w.base.sentOf('claim');
    w.vt.ms = (t2 - CFG.timing.claimMargin + 10) * 1000;
    const r = await s.kit.step(id);
    assert.equal(r.action, 'cancelBase', JSON.stringify(r));
    assert.equal(r.outcome, 'done');
    const cancels = await w.base.cancels();
    assert.equal(cancels.length, 1);
    assert.equal(cancels[0]!.nonce, 0, 'at the claim\'s own nonce');
    assert.ok(cancels[0]!.maxFee * 100n >= claim!.maxFee * 125n && cancels[0]!.tip * 100n >= claim!.tip * 125n, 'outbidding the claim');
    assert.equal(w.base.receipts.get(claim!.hash), undefined, 'the claim was never mined');
    assert.equal(w.base.mempool.size, 0);
    assert.equal(w.base.preimages.size, 0, 'the secret never reached the chain');
    assert.equal(w.base.swapAt(h, w.board.trades.get(id)!.t.buyer.base).state, 1);
    const j = (await s.kit.store.getJournal(id)).intents.filter((i) => i.kind === 'claimBase');
    assert.equal(j.length, 1);
    assert.equal(j[0]!.outcome, 'not_sent');
    assert.equal(j[0]!.cancelHashes?.length, 1);
    // Too late to claim again: refused, nothing sent.
    const again = await s.kit.step(id);
    assert.equal(again.outcome, 'refused');
    assert.equal(w.base.sentOf('claim').length, 1);
  });

  test('61: a claim waiting behind another trade\'s claim not mined is still taken back at its own nonce near its margin; neither claim is ever mined late', async () => {
    const w = world();
    const s = await kitFor(w, await newBot(w));
    const b1 = await kitFor(w, await newBot(w));
    const b2 = await kitFor(w, await newBot(w));
    const offer = await s.kit.postOffer(SELL);
    const t1 = (await b1.kit.take(offer.id, '2')).id;
    const t2 = (await b2.kit.take(offer.id, '2')).id;
    await stepBoth(w, s, b1, t1, () => w.board.trades.get(t1)!.t.status === 'base_locked');
    await stepBoth(w, s, b2, t2, () => w.board.trades.get(t2)!.t.status === 'base_locked');
    // Trade 1's claim is held at nonce 0; trade 2's goes out at nonce 1 and waits behind it.
    w.base.modes = ['mempool'];
    await stepUntil(w, s, t1, (x) => x.action === 'claimBase' && x.outcome === 'pending');
    await stepUntil(w, s, t2, (x) => x.action === 'claimBase' && x.outcome === 'pending');
    assert.deepEqual(w.base.sentOf('claim').map((c) => c.nonce), [0, 1]);
    const h2 = (await s.kit.store.getTrade(t2))!.h!;
    const t2End = Number(w.base.swapAt(h2, b2.bot.base).deadline);
    w.vt.ms = (t2End - CFG.timing.claimMargin + 10) * 1000;
    // Trade 2 first: its cancel takes the place of its claim at nonce 1, behind nonce 0.
    const r2 = await s.kit.step(t2);
    assert.equal(r2.action, 'cancelBase', JSON.stringify(r2));
    assert.equal(r2.outcome, 'pending', 'it waits behind nonce 0, as the claim did');
    // Trade 1 is past its margin too: its cancel at nonce 0 is mined at once.
    const r1 = await s.kit.step(t1);
    assert.equal(r1.action, 'cancelBase', JSON.stringify(r1));
    assert.equal(r1.outcome, 'done');
    await w.base.mineAll();
    assert.deepEqual(w.base.sentOf('claim').map((c) => w.base.receipts.get(c.hash)?.status ?? null), [null, null], 'neither claim was ever mined');
    assert.equal(w.base.preimages.size, 0, 'no secret reached the chain');
    assert.deepEqual((await w.base.cancels()).map((c) => c.nonce).sort(), [0, 1]);
    await s.kit.step(t2);
    for (const id of [t1, t2]) assert.deepEqual((await s.kit.store.getJournal(id)).intents.filter((i) => i.kind === 'claimBase').map((i) => i.outcome), ['not_sent'], `trade #${id}`);
  });

  test('the checks refuse a second claim while one is open (CLAIM_IN_FLIGHT), and the signer refuses one that is not its replacement', async () => {
    const w = world();
    const { s, b, id } = await atBaseLocked(w);
    w.base.modes = ['mempool'];
    await stepUntil(w, s, id, (x) => x.action === 'claimBase' && x.outcome === 'pending');
    const deps: checks.CheckDeps = { network: 'devnet', pha: s.kit.pha, base: s.kit.base, store: s.kit.store, board: s.kit.board, address: s.kit.address, now: w.vt.now };
    const rec = (await s.kit.store.getTrade(id))!;
    const fresh = await checks.selfClaim(deps, rec);
    assert.equal(fresh.ok, false);
    if (!fresh.ok) {
      assert.equal(fresh.problem.code, 'CLAIM_IN_FLIGHT');
      assert.equal(fresh.problem.check, 61);
      assert.equal(fresh.problem.retry, true);
    }
    const open = (await s.kit.store.openIntents())[0]!.intent;
    const follow = await checks.selfClaim(deps, rec, { follow: open });
    assert.equal(follow.ok, true);
    if (follow.ok) assert.deepEqual(follow.intent.facts.follow, { journalId: open.id, nonce: 0 });
    // The buyer's refund: SEND_IN_FLIGHT while one is open, the same way.
    const bt = (await b.kit.store.getTrade(id))!;
    assert.equal(checks.CHECK_CODES.SEND_IN_FLIGHT, 51);
    w.vt.ms = (bt.t2! + 31) * 1000;
    const bdeps: checks.CheckDeps = { ...deps, store: b.kit.store, address: b.kit.address };
    assert.equal((await checks.refundBase(bdeps, bt)).ok, true);
  });

  test('63: a refund not mined is replaced at its own nonce, never sent again behind it', async () => {
    const w = world();
    const { b, id } = await atBaseLocked(w);
    const t2 = (await b.kit.store.getTrade(id))!.t2!;
    w.vt.ms = (t2 + 31) * 1000;
    w.base.modes = ['mempool', 'mempool'];
    await stepUntil(w, b, id, (x) => x.action === 'refundBase' && x.outcome === 'pending');
    w.base.baseFee *= 2n;
    w.vt.ms += 61_000;
    const r = await b.kit.step(id);
    assert.equal(r.action, 'refundBase', JSON.stringify(r));
    assert.equal(r.outcome, 'pending');
    const refunds = w.base.sentOf('refund');
    assert.equal(refunds.length, 2);
    assert.equal(new Set(refunds.map((x) => x.nonce)).size, 1, 'one nonce');
    assert.ok(refunds[1]!.maxFee * 100n >= refunds[0]!.maxFee * 125n && refunds[1]!.tip * 100n >= refunds[0]!.tip * 125n);
    await w.base.mineAll();
    await stepUntil(w, b, id, (x) => x.outcome === 'finished');
    assert.deepEqual(refunds.map((x) => w.base.receipts.get(x.hash)?.status ?? null), [null, 'success']);
    assert.deepEqual((await b.kit.store.getJournal(id)).intents.filter((i) => i.kind === 'refundBase').map((i) => i.outcome), ['confirmed']);
  });

  test('62: a Phantasma claim that went out and is not settled is never sent a second time', async () => {
    const w = world();
    const { s, b, id } = await atBaseLocked(w);
    await stepUntil(w, s, id, (x) => x.action === 'claimBase' && x.outcome === 'done');
    w.vt.ms += 10_000;
    w.pha.modes = ['mempool'];
    const policy = { claimWatchS: 0 };
    await stepUntil(w, b, id, (x) => x.action === 'claimPha' && x.outcome === 'pending', { policy });
    for (let i = 0; i < 3; i++) {
      w.vt.ms += 20_000;
      const r = await b.kit.step(id, policy);
      assert.equal(r.action, 'claimPha');
      assert.equal(r.outcome, 'pending');
    }
    assert.equal(w.pha.count('claim'), 1, 'one claim on Phantasma');
    w.pha.flush();
    await stepUntil(w, b, id, (x) => x.outcome === 'finished', { policy });
    assert.equal(w.pha.count('claim'), 1);
  });
});

describe('wave B review: the secret\'s first way out is the kit\'s own claim too (checks 58 and 60)', () => {
  async function atBaseLocked(w: World) {
    const t = await sellOfferTaken(w);
    await stepBoth(w, t.s, t.b, t.id, () => w.board.trades.get(t.id)!.t.status === 'base_locked', { acceptAfterS: 0 });
    const h = (await t.s.kit.store.getTrade(t.id))!.h!;
    return { ...t, h, t2: Number(w.base.swapAt(h, t.b.bot.base).deadline) };
  }

  test('a first claim at T2 - (REVEAL_MIN + 10 s) that is dropped is claimed again at T2 - 240 s, at its nonce: secretSentAt is kept before the first one', async () => {
    const w = world();
    const { s, b, id, h, t2 } = await atBaseLocked(w);
    w.vt.ms = (t2 - CFG.timing.revealMin - 10) * 1000;
    w.base.modes = ['mempool'];
    const r1 = await s.kit.step(id);
    assert.equal(r1.action, 'claimBase', JSON.stringify(r1));
    assert.equal(r1.outcome, 'pending');
    assert.ok((await s.kit.store.getTrade(id))!.secretSentAt, 'secretSentAt is kept before the claim\'s simulation');
    w.base.mempool.clear(); // the node dropped it
    w.vt.ms = (t2 - 240) * 1000;
    const r2 = await s.kit.step(id);
    assert.equal(r2.action, 'claimBase', JSON.stringify(r2));
    assert.equal(r2.outcome, 'done', 'checks 55-57 do not run again: 240 s is more than CLAIM_MARGIN');
    assert.deepEqual(w.base.sentOf('claim').map((c) => c.nonce), [0, 0]);
    assert.equal(w.base.swapAt(h, b.bot.base).state, 2);
    await stepUntil(w, s, id, (x) => x.outcome === 'finished');
  });

  test('a first claim that reverts on chain: the next claim at T2 - 240 s goes out (no FIRST_CLAIM); with nothing ever sent it is still refused', async () => {
    const w = world();
    const { s, b, id, h, t2 } = await atBaseLocked(w);
    w.vt.ms = (t2 - CFG.timing.revealMin - 10) * 1000;
    const apply = w.base.apply.bind(w.base);
    let reverts = 1;
    w.base.apply = (from, to, data, dry, logs) => {
      if (!dry && reverts > 0 && to.toLowerCase() === SWAP && decodeFunctionData({ abi: SATURN_SWAP_ABI, data }).functionName === 'claim') {
        reverts--;
        throw new Error('SwapExpired');
      }
      return apply(from, to, data, dry, logs);
    };
    const r1 = await s.kit.step(id);
    assert.equal(r1.action, 'claimBase');
    assert.equal(r1.outcome, 'failed', JSON.stringify(r1));
    w.vt.ms = (t2 - 240) * 1000;
    const r2 = await s.kit.step(id);
    assert.equal(r2.action, 'claimBase', JSON.stringify(r2));
    assert.equal(r2.outcome, 'done');
    assert.equal(w.base.swapAt(h, b.bot.base).state, 2);

    // Nothing ever sent: at T2 - 240 s the first claim still runs 55-57, which need REVEAL_MIN left.
    const w2 = world();
    const two = await atBaseLocked(w2);
    w2.vt.ms = (two.t2 - 240) * 1000;
    const r3 = await two.s.kit.step(two.id);
    assert.equal(r3.code, 'FIRST_CLAIM', JSON.stringify(r3));
    assert.equal(w2.base.sentOf('claim').length, 0);
  });
});

describe('wave B review: the board never decides whether the seller is paid', () => {
  test('reveal-then-self with the board down after the buyer\'s lock: the kit claims itself before T2 - REVEAL_MIN, and nothing is revealed', async () => {
    const w = world();
    const { s, b, id } = await sellOfferTaken(w, { sellerOpts: { claimMode: 'reveal-then-self' } });
    await stepBoth(w, s, b, id, () => w.board.trades.get(id)!.t.status === 'base_locked', { acceptAfterS: 0 });
    const h = (await s.kit.store.getTrade(id))!.h!;
    const t2 = Number(w.base.swapAt(h, b.bot.base).deadline);
    w.board.script = (_m, p) => (p.startsWith('/v1/p2p/trades/') ? { status: 503, json: { error: { code: 'UNAVAILABLE', message: 'down', retryable: false } } } : undefined);
    const r = await stepUntil(w, s, id, (x) => x.action === 'claimBase' && x.outcome === 'done', { max: 200, everyMs: 15_000 });
    assert.ok(r.outcome === 'done');
    assert.ok(w.vt.ms <= (t2 - CFG.timing.revealMin) * 1000, 'claimed while check 55 still allows it');
    assert.equal(w.board.reveals.length, 0);
    assert.equal(w.board.count('POST', /\/reveal$/), 0, 'no reveal was ever posted');
    assert.equal(w.base.swapAt(h, b.bot.base).state, 2);
  });

  test('the seller finishes only on a claim seen at the confirmed block; a claim a reorg drops is claimed again', async () => {
    const w = world();
    const { s, b, id } = await sellOfferTaken(w);
    await stepBoth(w, s, b, id, () => w.board.trades.get(id)!.t.status === 'base_locked', { acceptAfterS: 0 });
    await stepUntil(w, s, id, (x) => x.action === 'claimBase' && x.outcome === 'done');
    const r = await s.kit.step(id);
    assert.equal(r.outcome, 'waiting', JSON.stringify(r));
    assert.equal(r.waitingFor, 'chain');
    assert.equal((await s.kit.store.getTrade(id))!.endedAt, undefined, 'not finished on the newest block alone');
    // A reorg drops the claim's block: the swap reads locked again.
    const h = (await s.kit.store.getTrade(id))!.h!;
    const sw = w.base.swaps.get(`${h}|${b.bot.base}`)!;
    delete sw.claimedBlock;
    w.base.preimages.clear();
    await stepUntil(w, s, id, (x) => x.action === 'claimBase' && x.outcome === 'done');
    assert.equal(w.base.count('claim'), 2, 'claimed again');
    await stepUntil(w, s, id, (x) => x.outcome === 'finished');
    assert.equal(w.base.swapAt(h, b.bot.base, w.base.head - 3n).state, 2);
  });
});

describe('wave B review: a following offer is checked as the site checks it before it is posted', () => {
  test('its largest trade at the limit price over FOLLOW_TAKE_USD_MAX, or a daily amount under the smallest trade: OFFER_INVALID, nothing posted', async () => {
    const w = world();
    const s = await kitFor(w, await newBot(w));
    const big = { side: 'sell' as const, symbol: 'TAZ', total: '1000', min: '1', max: '200', follow: { offsetBps: 200, limitPrice: '60' } };
    await assert.rejects(s.kit.postOffer(big), (e: unknown) => e instanceof SafetyError && e.code === 'OFFER_INVALID' && /largest trade costs over 10,000 USDC/.test(e.detail));
    await assert.rejects(s.kit.postOffer({ ...big, max: '5', follow: { offsetBps: 200, limitPrice: '1.05', dailyMax: '0.5' } }), (e: unknown) => e instanceof SafetyError && e.code === 'OFFER_INVALID' && /at least the smallest trade/.test(e.detail));
    assert.equal(w.board.count('POST', /\/offers$/), 0, 'nothing was posted');
    const ok = await s.kit.postOffer({ ...big, max: '5', follow: { offsetBps: 200, limitPrice: '1.05' } });
    assert.ok(ok.follow);
    await assert.rejects(s.kit.repriceOffer(ok.id, { follow: { offsetBps: 200, limitPrice: '1.05', dailyMax: '2000' } }), (e: unknown) => e instanceof SafetyError && e.code === 'OFFER_INVALID');
    assert.equal(w.board.count('POST', /\/reprice$/), 0);
  });
});
