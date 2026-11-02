/**
 * Phantasma for the kit (build spec sections 6.2 and 6.4): the escrow's
 * reads, the account balances a seller check needs, and the three escrow
 * transactions (lock, claim, refund) built unsigned. Only signer.ts signs
 * them; nothing here holds a key.
 *
 * Every read goes to the network's own Phantasma RPC, on the allowlist of
 * pins.ts (check 67), never to the board. A port of the site's
 * src/lib/p2p/pha.js and the keeper's src/p2p/phaChain.ts:
 *
 *   - h and the secret are unsigned 256-bit numbers. They go to the contract
 *     as decimal strings, never hex: the VM reverses hex strings.
 *   - A lock is read with getState first: the other getters refuse an h
 *     that was never locked and would fail the whole batch. A missing or
 *     unreadable answer throws, so a gap never reads as "no lock".
 *   - The symbol of a lock is kept exactly as the chain wrote it (never
 *     upper-cased): a lock of 'soul' is not SOUL's, and the checks compare it
 *     exactly with the token of the kit's own record.
 *
 * The transport (PhaRpc) is an interface, so tests run the same code over a
 * fake chain and count every send.
 */
import { createHash } from 'node:crypto';
import { ScriptBuilder, Transaction, Address, Base16, Decoder } from 'phantasma-sdk-ts';
import { SafetyError, SAFETY } from './errors.js';
import { hexToDecimal, decimalToHex, isHex32 } from './codec.js';
import { tokenOf, isContractName, p2pConfig, phaRpcProblem, PHA_LOCK_GAS, type P2PNetConfig } from './pins.js';
import { openCapText, tokenOffText, symName, type PhaLock } from './rules.js';
import { redact } from './redact.js';
import type { Network } from './types.js';

// ── The transport ───────────────────────────────────────────────────────────

/** One contract call: arguments are already strings (decimal numbers, symbols, addresses). */
export interface PhaCall {
  readonly contract: string;
  readonly method: string;
  readonly args: readonly string[];
}

/** getContract(chain, name): the deployed script (hex) and the names of its methods. */
export interface PhaContractInfo {
  name: string;
  script: string;
  methods: string[];
}

/** One liquid balance of getAccount (staked SOUL is not in it). `amount` is raw. */
export interface PhaBalance {
  symbol: string;
  amount: string;
  decimals: number | null;
}

/** A transaction as the node reports it: 'Halt' when it ran, 'Fault' or 'Break' when it did not. */
export interface PhaTxState {
  state: string;
  /** The node's debug comment (an escrow refusal such as "P2:used"), redacted. */
  reason: string;
}

/**
 * What the kit asks a Phantasma node. phaRpc() is the real one (JSON-RPC
 * over https); tests pass a fake that counts every sendRaw.
 */
export interface PhaRpc {
  /** View calls, batched in one script; one decoded answer per call (null when it did not decode). Throws when the node refuses. */
  views(calls: readonly PhaCall[]): Promise<unknown[]>;
  /** The contract as the node serves it now (never cached). Throws when the node answers an error. */
  contract(name: string): Promise<PhaContractInfo>;
  /** The liquid balances of an address. Throws when they cannot be read. */
  balances(address: string): Promise<PhaBalance[]>;
  /** Broadcast a signed transaction (hex); answers its hash. Throws when the node refuses it. */
  sendRaw(signedTx: string): Promise<string>;
  /** A transaction's outcome, or null while the node does not know it. */
  transaction(hash: string): Promise<PhaTxState | null>;
}

/** Calls per script: the escrow reads are small, and a node refuses a script that is too long. */
const VIEW_CHUNK = 16;
const HASH_RE = /^[0-9a-fA-F]{64}$/;

export interface PhaRpcOptions {
  /** Default: the network's pinned RPC. Its host must be on the network's allowlist (check 67). */
  url?: string;
  /** Per request, ms (default 15 s). */
  timeoutMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
}

/**
 * The network's Phantasma node over JSON-RPC. Refuses (RPC_NOT_ALLOWED) an
 * RPC whose host is not on the network's allowlist, before any request, and
 * refuses every redirect (a request never leaves that host). Error messages
 * are redacted: a node may echo a script or a transaction.
 */
export function phaRpc(network: Network, o: PhaRpcOptions = {}): PhaRpc {
  const cfg = p2pConfig(network);
  if (!cfg) throw new SafetyError(SAFETY.NETWORK_OFF, 'The network is devnet or mainnet.');
  const url = o.url ?? cfg.pha.rpcUrl;
  const bad = phaRpcProblem(network, url);
  if (bad) throw new SafetyError(SAFETY.RPC_NOT_ALLOWED, bad);
  const timeoutMs = o.timeoutMs ?? 15_000;
  const doFetch = o.fetch ?? fetch;
  const chain = cfg.pha.chain;
  let id = 0;

  /** One JSON-RPC call: its `result`, or a throw with the node's (redacted) error. */
  async function call(method: string, params: unknown[]): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: String(++id) }),
        signal: AbortSignal.timeout(timeoutMs),
        // Check 67 holds for every request, not only the configured URL: a redirect to another host is refused,
        // never followed (a 307 or 308 would carry the body, a signed escrow transaction, along).
        redirect: 'error'
      });
    } catch (e) {
      throw new Error(`Phantasma ${method}: no answer (${redact((e as Error)?.name ?? 'error', 60)})`);
    }
    if (!res.ok) throw new Error(`Phantasma ${method}: HTTP ${res.status}`);
    let body: { result?: unknown; error?: unknown };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new Error(`Phantasma ${method}: the answer is not JSON`);
    }
    // A Phantasma node answers a good invokeRawScript with "error": "" beside
    // its results: only a non-empty error is a failure.
    const failed = (v: unknown) => v != null && v !== '';
    if (failed(body.error)) throw new PhaRpcError(method, body.error);
    const r = body.result as { error?: unknown } | undefined;
    if (r && typeof r === 'object' && failed(r.error)) throw new PhaRpcError(method, r.error);
    return body.result;
  }

  async function viewChunk(calls: readonly PhaCall[]): Promise<unknown[]> {
    const sb = new ScriptBuilder();
    sb.BeginScript();
    for (const c of calls) sb.CallContract(c.contract, c.method, [...c.args]);
    const result = (await call('invokeRawScript', [chain, sb.EndScript()])) as { results?: unknown; result?: unknown } | string | null;
    return decodeViews(result, calls.length);
  }

  return {
    async views(calls) {
      const out: unknown[] = [];
      for (let i = 0; i < calls.length; i += VIEW_CHUNK) out.push(...(await viewChunk(calls.slice(i, i + VIEW_CHUNK))));
      return out;
    },
    async contract(name) {
      const c = (await call('getContract', [chain, name])) as { name?: unknown; script?: unknown; methods?: unknown } | null;
      if (!c || typeof c !== 'object') throw new Error(`Phantasma getContract(${name}): no contract`);
      const methods = Array.isArray(c.methods) ? c.methods.map((m) => String((m as { name?: unknown })?.name ?? '')).filter(Boolean) : [];
      return { name: String(c.name ?? ''), script: typeof c.script === 'string' ? c.script : '', methods };
    },
    async balances(address) {
      const a = (await call('getAccount', [address])) as { balances?: unknown } | null;
      if (!a || typeof a !== 'object' || !Array.isArray(a.balances)) throw new Error('Phantasma getAccount: no balances');
      return a.balances.map((b) => {
        const x = b as { symbol?: unknown; amount?: unknown; decimals?: unknown };
        const d = Number(x.decimals);
        return { symbol: String(x.symbol ?? ''), amount: String(x.amount ?? ''), decimals: Number.isInteger(d) ? d : null };
      });
    },
    async sendRaw(signedTx) {
      const r = await call('sendRawTransaction', [signedTx]);
      if (typeof r !== 'string' || !HASH_RE.test(r)) throw new Error(`Phantasma refused the transaction: ${redact(typeof r === 'string' ? r : JSON.stringify(r), 200)}`);
      return r.toUpperCase();
    },
    async transaction(hash) {
      let r: unknown;
      try {
        r = await call('getTransaction', [hash]);
      } catch (e) {
        // "not found" while the transaction is not in a block yet.
        if (e instanceof PhaRpcError && /not found|unknown/i.test(e.message)) return null;
        throw e;
      }
      const t = r as { state?: unknown; debugComment?: unknown } | null;
      if (!t || typeof t !== 'object' || typeof t.state !== 'string' || !t.state) return null;
      return { state: t.state, reason: redact(String(t.debugComment ?? ''), 300) };
    }
  };
}

/** A JSON-RPC error answered by the node (its message redacted). */
export class PhaRpcError extends Error {
  constructor(method: string, err: unknown) {
    const text = typeof err === 'string' ? err : (err as { message?: unknown })?.message ?? JSON.stringify(err);
    super(`Phantasma ${method}: ${redact(String(text), 300)}`);
    this.name = 'PhaRpcError';
  }
}

/** invokeRawScript's answer -> one decoded VM object per call (null for an answer that does not decode). */
function decodeViews(result: unknown, n: number): unknown[] {
  const r = result as { results?: unknown; result?: unknown } | string | null;
  const one = (hex: unknown): unknown => {
    if (typeof hex !== 'string' || !hex) return null;
    try { return new Decoder(hex).readVmObject(); } catch { return null; }
  };
  if (r && typeof r === 'object' && Array.isArray(r.results) && r.results.length >= n) return r.results.slice(0, n).map(one);
  const hex = typeof r === 'string' ? r : r && typeof r === 'object' && typeof r.result === 'string' ? r.result : null;
  if (!hex) return new Array(n).fill(null);
  const d = new Decoder(hex);
  return Array.from({ length: n }, () => {
    try { return d.readVmObject(); } catch { return null; }
  });
}

// ── Decoding answers ────────────────────────────────────────────────────────

/** An unsigned integer answer (a decimal string, a bigint or a safe number); throws for anything else. */
export function viewInt(v: unknown): bigint {
  if (typeof v === 'bigint' && v >= 0n) return v;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  const s = typeof v === 'string' ? v.trim() : '';
  if (!/^\d{1,78}$/.test(s)) throw new Error('Phantasma returned an unreadable number');
  return BigInt(s);
}

/** The same, as a JS number (must be a safe integer). */
export function viewSmallInt(v: unknown): number {
  const n = viewInt(v);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Phantasma returned a number out of range');
  return Number(n);
}

/**
 * A Phantasma address from a view answer: the text form as it is, or the
 * 34 address bytes (hex, possibly with a length prefix, or a byte array).
 * '' when it is none of these.
 */
export function viewAddress(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Uint8Array || (Array.isArray(v) && v.every((b) => Number.isInteger(b)))) {
    try { return Address.FromBytes(Uint8Array.from(v as ArrayLike<number>)).Text; } catch { return ''; }
  }
  const s = String(v).trim();
  if (/^[PSX][1-9A-HJ-NP-Za-km-z]{20,60}$/.test(s)) return s;
  if (!/^[0-9a-fA-F]+$/.test(s)) return '';
  const tries: string[] = [];
  if (s.length === 68) tries.push(s);
  if (s.length >= 70) tries.push(s.slice(-68), s.slice(2));
  if (s.length === 66) tries.push('00' + s);
  for (const hex of tries) {
    try {
      const bytes = Uint8Array.from(Buffer.from(hex.slice(0, 68), 'hex'));
      if (bytes.length !== 34 || bytes.every((b) => b === 0)) continue;
      return Address.FromBytes(bytes).Text;
    } catch { /* try the next framing */ }
  }
  return '';
}

/** A string answer with NUL padding removed (never case-folded). */
function viewText(v: unknown): string {
  return v == null ? '' : String(v).replace(/\u0000/g, '');
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** One escrow lock as read from the chain, with its h; `secret` only when the lock reads claimed (2). */
export interface PhaLockRead extends PhaLock {
  h: string;
  secret: string | null;
}

/** The escrow's switches and its per-lock bounds for one token (check 23). */
export interface PhaParams {
  paused: boolean;
  minLock: number;
  maxLock: number;
  minAmount: bigint;
  maxAmount: bigint;
}

/** The escrow's open cap for one token (checks 11 and 21). */
export interface PhaOpenCap {
  openAmount: bigint;
  maxOpen: bigint;
}

/** A liquid balance by symbol, raw, with the decimals the node lists (null when it lists none). */
export type PhaBalances = Map<string, { raw: bigint; decimals: number | null }>;

/** The table's symbol, or a throw before anything is read or signed. */
function tradedSymbol(symbol: unknown): string {
  const t = tokenOf(symbol);
  if (!t) throw new SafetyError('TOKEN_NOT_TRADED', 'Not a token this kit trades.');
  return t.symbol;
}

/**
 * The escrow reads the kit's checks run, under the contract a config names
 * (the network's current escrow, or escrowCfg for the one a trade's record
 * names). Reads only: the transactions are built by escrowTransaction and
 * signed by signer.ts.
 */
export class PhaReader {
  constructor(readonly rpc: PhaRpc, readonly network: Network) {}

  /**
   * One lock, straight from the chain: getState first, then the getters
   * (getSecret too when it reads claimed). Throws when any read is missing.
   * `created` is getCreated(h): the start of the buyer's Base lock window.
   */
  async readLock(cfg: P2PNetConfig, h: string): Promise<PhaLockRead> {
    if (!isHex32(h)) throw new Error('Not a valid lock hash');
    const contract = cfg.phaContract;
    const arg = hexToDecimal(h);
    const [st] = await this.rpc.views([{ contract, method: 'getState', args: [arg] }]);
    const state = viewSmallInt(st);
    const hl = h.toLowerCase();
    if (state === 0) return { h: hl, state: 0, sender: '', recipient: '', symbol: '', amount: 0n, deadline: 0, created: 0, secret: null };
    const methods = ['getSender', 'getRecipient', 'getSymbol', 'getAmount', 'getDeadline', 'getCreated'];
    if (state === 2) methods.push('getSecret');
    const r = await this.rpc.views(methods.map((method) => ({ contract, method, args: [arg] })));
    if (r.length < methods.length || r.some((v) => v == null)) throw new Error('Phantasma did not answer every read of this lock');
    // By name, so adding a getter never shifts another one's answer.
    const by: Record<string, unknown> = {};
    methods.forEach((m, i) => { by[m] = r[i]; });
    let secret: string | null = null;
    if (state === 2) {
      secret = decimalToHex(viewText(by.getSecret));
      if (!secret) throw new Error('Phantasma returned an unreadable secret');
    }
    const symbol = viewText(by.getSymbol);
    if (!symbol) throw new Error('Phantasma returned no symbol for this lock');
    return {
      h: hl,
      state,
      sender: viewAddress(by.getSender),
      recipient: viewAddress(by.getRecipient),
      symbol,
      amount: viewInt(by.getAmount),
      deadline: viewSmallInt(by.getDeadline),
      created: viewSmallInt(by.getCreated),
      secret
    };
  }

  /** The escrow's switches and its per-lock bounds for `symbol` (a token the escrow never enabled reads maxAmount 0). */
  async readParams(cfg: P2PNetConfig, symbol: string): Promise<PhaParams> {
    const sym = tradedSymbol(symbol);
    const c = cfg.phaContract;
    const r = await this.rpc.views([
      { contract: c, method: 'getPaused', args: [] },
      { contract: c, method: 'getMinLock', args: [] },
      { contract: c, method: 'getMaxLock', args: [] },
      { contract: c, method: 'getMinAmount', args: [sym] },
      { contract: c, method: 'getMaxAmount', args: [sym] }
    ]);
    if (r.length < 5 || r.some((v) => v == null)) throw new Error('Phantasma did not answer every read of the P2P settings');
    const paused = typeof r[0] === 'boolean' ? r[0] : viewSmallInt(r[0]) !== 0;
    return { paused, minLock: viewSmallInt(r[1]), maxLock: viewSmallInt(r[2]), minAmount: viewInt(r[3]), maxAmount: viewInt(r[4]) };
  }

  /** getOpenAmount(symbol) and getMaxOpen(symbol). Throws when a read is missing. */
  async readOpenCap(cfg: P2PNetConfig, symbol: string): Promise<PhaOpenCap> {
    const sym = tradedSymbol(symbol);
    const c = cfg.phaContract;
    const r = await this.rpc.views([
      { contract: c, method: 'getOpenAmount', args: [sym] },
      { contract: c, method: 'getMaxOpen', args: [sym] }
    ]);
    if (r.length < 2 || r.some((v) => v == null)) throw new Error('Phantasma did not answer every read of the open cap');
    return { openAmount: viewInt(r[0]), maxOpen: viewInt(r[1]) };
  }

  /** The open cap, or null when it could not be read (a take or an accept never blocks on a failed read, check 11). */
  async readOpenCapOrNull(cfg: P2PNetConfig, symbol: string): Promise<PhaOpenCap | null> {
    try { return await this.readOpenCap(cfg, symbol); } catch { return null; }
  }

  /**
   * The escrow's deployed script as the node serves it now (never cached):
   * its name, the SHA-256 of its bytes (64 lowercase hex), or null when the
   * script is empty or not hex, and whether it has `getState`. Throws when
   * the node cannot be read.
   */
  async code(cfg: P2PNetConfig): Promise<{ name: string; sha256: string | null; methods: string[] }> {
    const c = await this.rpc.contract(cfg.phaContract);
    const script = c.script.trim();
    const ok = !!script && script.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(script);
    const sha256 = ok ? createHash('sha256').update(Buffer.from(script, 'hex')).digest('hex') : null;
    return { name: c.name, sha256, methods: c.methods };
  }

  /** getAdmin() of the escrow, as an address ('' when it does not decode). Throws when it cannot be read. */
  async admin(cfg: P2PNetConfig): Promise<string> {
    const [v] = await this.rpc.views([{ contract: cfg.phaContract, method: 'getAdmin', args: [] }]);
    if (v == null) throw new Error('Phantasma did not answer getAdmin');
    return viewAddress(v);
  }

  /** hashSecret(x) on the live node for each secret ('0x' + 64 hex), as '0x' + 64 hex digests (null when one does not decode). One read per secret. */
  async hashSecrets(cfg: P2PNetConfig, secrets: readonly string[]): Promise<Array<string | null>> {
    const out: Array<string | null> = [];
    for (const s of secrets) {
      const [v] = await this.rpc.views([{ contract: cfg.phaContract, method: 'hashSecret', args: [hexToDecimal(s)] }]);
      out.push(v == null ? null : decimalToHex(viewText(v)));
    }
    return out;
  }

  /** The liquid balances of an address, by symbol (staked SOUL is not in them). Throws when they cannot be read. */
  async balances(address: string): Promise<PhaBalances> {
    const out: PhaBalances = new Map();
    for (const b of await this.rpc.balances(address)) {
      if (!b.symbol || !/^\d{1,40}$/.test(b.amount)) continue;
      out.set(b.symbol, { raw: BigInt(b.amount), decimals: b.decimals });
    }
    return out;
  }

  /** A transaction's outcome, or null while the node does not know it. */
  async txState(hash: string): Promise<PhaTxState | null> {
    return this.rpc.transaction(hash);
  }
}

/**
 * A liquid balance of `symbol`, raw, or null when it is not listed or listed
 * with other decimals than the kit's table (a node or token that disagrees on
 * decimals is not trusted with an amount). A symbol the kit does not trade is null.
 */
export function balanceOf(bal: PhaBalances | null | undefined, symbol: string): bigint | null {
  const t = tokenOf(symbol);
  if (!t || !bal) return null;
  const b = bal.get(t.symbol);
  if (!b) return null;
  if (b.decimals != null && b.decimals !== t.decimals) return null;
  return b.raw;
}

// ── The three escrow transactions (built here, signed only by signer.ts) ───

/** The payload label of each escrow transaction (the site's and the keeper's). */
export const PHA_TX_LABELS = Object.freeze({ lock: 'SATURN_p2pLock', claim: 'SATURN_p2pClaim', refund: 'SATURN_p2pRefund' });

/** A signed transaction expires this long after it is built. */
export const PHA_TX_TTL_MS = 5 * 60_000;

/**
 * saturnescrow.lock(from, h, symbol, amount, recipient, deadline), exactly as
 * P2P/SPEC.md section 4 sends it: h as a decimal number, the table's symbol,
 * the amount and the deadline as decimal strings. `symbol` is the token of
 * the kit's own record, never the board's. Throws for a symbol the kit does
 * not trade, so nothing is signed for one.
 */
export function lockCall(cfg: P2PNetConfig, from: string, h: string, symbol: string, amount: bigint, recipient: string, deadline: number): PhaCall {
  const sym = tradedSymbol(symbol);
  if (!isHex32(h)) throw new Error('Not a valid lock hash');
  if (typeof amount !== 'bigint' || amount <= 0n) throw new Error('Not a valid amount');
  if (!Number.isSafeInteger(deadline) || deadline <= 0) throw new Error('Not a valid deadline');
  return Object.freeze({ contract: cfg.phaContract, method: 'lock', args: Object.freeze([from, hexToDecimal(h), sym, amount.toString(), recipient, String(deadline)]) });
}

/** claim(secret): pays the recipient fixed in the lock. Anyone may send it. */
export function claimCall(cfg: P2PNetConfig, secret: string): PhaCall {
  if (!isHex32(secret)) throw new Error('Not a valid secret');
  return Object.freeze({ contract: cfg.phaContract, method: 'claim', args: Object.freeze([hexToDecimal(secret)]) });
}

/** refund(h): pays the sender back after the deadline. Anyone may send it. */
export function refundCall(cfg: P2PNetConfig, h: string): PhaCall {
  if (!isHex32(h)) throw new Error('Not a valid lock hash');
  return Object.freeze({ contract: cfg.phaContract, method: 'refund', args: Object.freeze([hexToDecimal(h)]) });
}

/**
 * An unsigned transaction that calls one escrow method from `from`, with the
 * fixed gas allowance (PHA_LOCK_GAS: price 100,000 x limit 300,000, never one
 * fitted to the balance, check 34) and the method's payload label. Only
 * escrow calls are built: the contract must be a contract name and the method
 * lock, claim or refund.
 */
export function escrowTransaction(cfg: P2PNetConfig, from: string, call: PhaCall, expiresAtMs: number): Transaction {
  if (!isContractName(call.contract) || (call.contract !== cfg.phaContract && !cfg.phaDraining.some((d) => d.name === call.contract))) {
    throw new Error('Not an escrow this kit serves');
  }
  const label = (PHA_TX_LABELS as Record<string, string>)[call.method];
  if (!label) throw new Error('Not an escrow transaction');
  const sb = new ScriptBuilder();
  sb.AllowGas(from, Address.Null, PHA_LOCK_GAS.price, PHA_LOCK_GAS.limit);
  sb.CallContract(call.contract, call.method, [...call.args]);
  sb.SpendGas(from);
  return new Transaction(cfg.pha.nexus, cfg.pha.chain, sb.EndScript(), new Date(expiresAtMs), Base16.encode(label));
}

/** A signed transaction's bytes as the node takes them. */
export function txHex(tx: Transaction): string {
  return Base16.encodeUint8Array(tx.ToByteAray(true));
}

/**
 * Wait for a transaction's outcome: its state once the node knows it, else
 * 'Pending' after `tries` reads `intervalMs` apart.
 */
export async function waitPhaTx(rpc: PhaRpc, hash: string, o: { tries?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<PhaTxState> {
  const tries = o.tries ?? 16;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < tries; i++) {
    await sleep(o.intervalMs ?? 2_500);
    try {
      const r = await rpc.transaction(hash);
      if (r) return r;
    } catch { /* not readable yet: read again */ }
  }
  return { state: 'Pending', reason: `not confirmed after ${tries} reads` };
}

/** Whether a node state means the transaction ran. */
export const phaTxHalted = (s: PhaTxState | null | undefined): boolean => s?.state === 'Halt';

/**
 * Plain words for the escrow's refusals ('' to fall back to the node's own
 * reason). `symbol`: the token of the lock the call was about, when known.
 */
export function phaRefusalText(reason: string, symbol?: unknown): string {
  const r = String(reason || '');
  if (r.includes('P2:full')) return openCapText(symbol);
  if (r.includes('P2:paused')) return 'New P2P locks are paused on Phantasma right now. Nothing was locked.';
  if (r.includes('P2:token')) return tokenOffText(symbol);
  if (r.includes('P2:amount')) return 'This amount is outside what one P2P lock accepts. Nothing was locked.';
  if (r.includes('P2:used')) return 'This lock hash was already used. Nothing was locked.';
  if (r.includes('P2:recipient')) return 'The buyer\'s Phantasma address cannot receive this lock. Nothing was locked.';
  if (r.includes('P2:deadline')) return 'The lock\'s end time was refused. Check this machine\'s clock. Nothing was locked.';
  if (r.includes('P2:witness')) return 'The key that signed is not the seller\'s address. Nothing was locked.';
  if (r.includes('P2:secret')) return 'That secret is not 32 bytes. Nothing was claimed.';
  if (r.includes('P2:nolock')) return 'There is no lock with this hash on Phantasma. Nothing was changed.';
  if (r.includes('P2:state')) return `This ${symName(symbol)} lock was already claimed or refunded. Nothing was changed.`;
  if (r.includes('P2:expired')) return `The ${symName(symbol)} lock has ended, so it can no longer be claimed. It refunds to the seller.`;
  if (r.includes('P2:early')) return `The ${symName(symbol)} lock has not ended yet, so it cannot be refunded.`;
  return '';
}
