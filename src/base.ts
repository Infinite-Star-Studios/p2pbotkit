/**
 * Base for the kit (build spec sections 6.2 and 6.4): SaturnSwap and USDC
 * reads at the newest block and at the confirmed point (head - 3 on Base
 * Sepolia, the 'safe' head on Base), when a buyer's Locked event was mined,
 * the public secret of a claimed swap, and the pieces signer.ts uses to send
 * (simulation, gas, fees under the pinned caps, nonces, broadcast). Nothing
 * here holds a key: signer.ts is the only module that signs.
 *
 * A port of the site's src/lib/p2p/base.js reads and send rules:
 *   - every write is simulated first and sent only when the simulation
 *     passes (a reverted claim still publishes the secret);
 *   - an escrow call (claim, refund, withdrawOwed) goes with twice its gas
 *     estimate, at least 150,000; an approval or a lock with the estimate
 *     plus 30%; lockWithPermit with the pinned gas limit;
 *   - fees stay under the pinned caps (pins.ts feeCaps), whatever the RPC asks;
 *   - a log search goes back in requests of 5,000 blocks, stepped down a
 *     ladder of round sizes inside that search when a request fails (every
 *     search starts at 5,000 again; a rate limit by its code is thrown at
 *     once), and
 *     reaches back to a block whose timestamp is at or before the time it
 *     must cover.
 *
 * Reads go only to the configured Base RPC (its chain id must equal the pin,
 * check 67), never to the board. The transport (BaseClient) is an interface:
 * baseClient() wraps viem; tests pass a fake that counts every send.
 */
import {
  createPublicClient, http, parseAbi, parseEventLogs, encodeFunctionData, decodeErrorResult, domainSeparator,
  parseTransaction, recoverTransactionAddress, keccak256, isAddress,
  type Abi, type AbiEvent
} from 'viem';
import { base as viemBase, baseSepolia } from 'viem/chains';
import { SafetyError, SAFETY } from './errors.js';
import { isHex32, secretOpens } from './codec.js';
import { p2pConfig, baseRpcProblem, BASE_BLOCK_SECONDS, MAX_FEE_BPS, type P2PNetConfig } from './pins.js';
import { evmLower, type BaseSwap } from './rules.js';
import { redact } from './redact.js';
import type { Network } from './types.js';

export type Hex = `0x${string}`;

// ── Interfaces of the contracts (SPEC section 5; the site's abi.js) ─────────

const SWAP_ITEMS = [
  'function lock(bytes32 h, address token, uint256 amount, address claimer, uint64 deadline, uint16 maxFeeBps)',
  'function lockWithPermit(bytes32 h, address token, uint256 amount, address claimer, uint64 deadline, uint16 maxFeeBps, uint256 permitDeadline, uint8 v, bytes32 r, bytes32 s)',
  'function claim(bytes32 preimage, address sender)',
  'function refund(bytes32 h, address sender)',
  'function swapId(bytes32 h, address sender) pure returns (bytes32)',
  'function getSwap(bytes32 h, address sender) view returns ((address token, uint64 deadline, uint16 feeBps, uint8 state, address sender, address claimer, uint256 amount))',
  'function getPreimage(bytes32 h, address sender) view returns (bytes32)',
  'function owed(address token, address claimer) view returns (uint256)',
  'function withdrawOwed(address token, address claimer)',
  'function hashOf(bytes32 preimage) pure returns (bytes32)',
  'function feeBps() view returns (uint16)',
  'function feesAccrued(address token) view returns (uint256)',
  'function paused() view returns (bool)',
  'function minLock() view returns (uint64)',
  'function maxLock() view returns (uint64)',
  'function tokenCfg(address token) view returns (bool allowed, uint128 minAmount, uint128 maxAmount)',
  'event Locked(bytes32 indexed h, address indexed sender, address indexed claimer, address token, uint256 amount, uint64 deadline, uint16 feeBps)',
  'event Claimed(bytes32 indexed h, address indexed sender, bytes32 preimage, address claimer, uint256 net, uint256 fee)',
  'event Refunded(bytes32 indexed h, address indexed sender, uint256 amount)',
  'event PayoutDeferred(bytes32 indexed h, address indexed sender, address indexed claimer, address token, uint256 amount)',
  'event OwedPaid(address indexed token, address indexed claimer, uint256 amount)'
] as const;
const SWAP_ERRORS = [
  'error LockPaused()', 'error TokenNotAllowed()', 'error AmountOutOfRange()', 'error BadClaimer()', 'error SwapExists()',
  'error BadDeadline()', 'error FeeTooHigh()', 'error TransferMismatch()', 'error NotLocked()', 'error SwapExpired()', 'error SwapNotExpired()',
  'error NothingOwed()', 'error NotClaimed()', 'error SafeERC20FailedOperation(address token)'
] as const;

/** SaturnSwap's ABI (DexV4 P2P/evm/abi/SaturnSwap.json, as the site's abi.js lists it). */
export const SATURN_SWAP_ABI: Abi = parseAbi([...SWAP_ITEMS, ...SWAP_ERRORS]);

/** The USDC token's calls the kit makes, the EIP-2612 reads, and the errors a lock can bubble up. */
export const USDC_ABI: Abi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function nonces(address owner) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)'
]);

/** FiatToken's switches (USDC on Base): read only where pins.ts says the token has them. */
export const FIAT_ABI: Abi = parseAbi([
  'function isBlacklisted(address account) view returns (bool)',
  'function paused() view returns (bool)'
]);

/** Every error a send may revert with, so it reads as words. */
const ERRORS_ABI: Abi = [...SATURN_SWAP_ABI, ...USDC_ABI].filter((x) => x.type === 'error');

const eventOf = (name: string) => SATURN_SWAP_ABI.find((x) => x.type === 'event' && x.name === name) as AbiEvent;
const LOCKED_EVENT = eventOf('Locked');
const CLAIMED_EVENT = eventOf('Claimed');

/** A lock-time search starts this long before the Phantasma lock's getCreated (clock skew between the chains, and margin). */
export const LOCK_SCAN_MARGIN = 900;
/**
 * The sizes a log request may ask for, largest first. Every search starts at
 * the first and steps down to the next inside itself when a request fails
 * (see #scanBack for which failures): providers' limits are round numbers
 * (10,000, 2,000, 500, 200 ...), which halving would miss (5,000 halved
 * lands on 156 where 200 is allowed). The results are filtered by contract
 * and topics, so a wide range costs nothing but the node's work. No size is
 * kept between searches: a kept size that never went back up let one
 * misread error slow a reader for the life of the process, and keeping saves
 * at most 4 refused requests a search.
 */
export const LOG_STEPS: readonly bigint[] = Object.freeze([5_000n, 2_000n, 1_000n, 500n, 200n, 100n, 50n, 20n, 10n, 5n, 2n, 1n]);
/** The first request's size of every search (SPEC section 6). */
export const LOG_CHUNK = LOG_STEPS[0]!;
/**
 * The largest size releases before 0.3.0 ever asked for. A provider's refusal
 * of a larger request may be worded in a way nobody has seen yet, so above
 * this size any failure but a rate limit told by its code steps down (the
 * words of a rate limit may belong to such a refusal); at or below it only
 * a recognised range refusal does, and a rate limit by code or by words is
 * thrown, as before.
 */
export const LOG_STEP_PROVEN = 500n;
/**
 * How many times a search may widen its first guess of where to start (each
 * time twice as far back) before it gives up and the check that needs it
 * refuses: a node whose timestamps never reach back far enough cannot keep a
 * search going.
 */
export const SEARCH_WIDEN_MAX = 6;
/** An escrow call's gas limit is twice the estimate, never below this (SPEC sections 6 and 8). */
export const MIN_CLAIM_GAS = 150_000n;
/** The EIP-2612 permit of a one-step lock lasts this long (check 46), under the 2 h the site's wallet allows. */
export const PERMIT_SECONDS = 30 * 60;
export const PERMIT_MAX_SECONDS = 2 * 3_600;

// ── The transport ───────────────────────────────────────────────────────────

export interface BaseBlock {
  number: bigint;
  timestamp: bigint;
  baseFeePerGas: bigint | null;
}

/** A decoded SaturnSwap log. */
export interface BaseLog {
  address: string;
  blockNumber: bigint | null;
  removed?: boolean;
  eventName?: string;
  args: Record<string, unknown>;
}

export interface BaseReceipt {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  transactionHash: string;
  /** SaturnSwap's logs in it, decoded. */
  logs: BaseLog[];
}

export interface ReadCall {
  address: Hex;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  /** Default: the newest block. */
  blockNumber?: bigint;
}

/** A call as it would be sent: `from` signs it. */
export interface TxCall {
  from: Hex;
  to: Hex;
  data: Hex;
  gas?: bigint;
}

/**
 * What the kit asks a Base node. baseClient() is the real one (viem over
 * https); tests pass a fake that counts every sendRaw.
 */
export interface BaseClient {
  chainId(): Promise<number>;
  /** The newest block, the 'safe' head, or a block by number. */
  block(at?: { tag?: 'latest' | 'safe'; number?: bigint }): Promise<BaseBlock>;
  read(c: ReadCall): Promise<unknown>;
  /** SaturnSwap logs of one event filtered on its indexed args, decoded. */
  logs(q: { address: Hex; event: AbiEvent; args: Record<string, unknown>; fromBlock: bigint; toBlock: bigint }): Promise<BaseLog[]>;
  /** A mined transaction's receipt, or null while it is not mined. */
  receipt(hash: Hex): Promise<BaseReceipt | null>;
  /** Whether the node knows the transaction (mined or waiting). */
  seen(hash: Hex): Promise<boolean>;
  code(address: Hex): Promise<Hex>;
  balance(address: Hex): Promise<bigint>;
  nonce(address: Hex, tag: 'latest' | 'pending'): Promise<number>;
  priorityFee(): Promise<bigint>;
  /** eth_call at the newest block; throws with the revert when it would fail. */
  call(c: TxCall): Promise<Hex>;
  estimateGas(c: TxCall): Promise<bigint>;
  /** eth_sendRawTransaction. */
  sendRaw(raw: Hex): Promise<Hex>;
}

/** The fetch options of the Base RPC transport: a redirect is an error, so no request leaves the checked host (check 67). */
export const BASE_FETCH_OPTIONS: Readonly<RequestInit> = Object.freeze({ redirect: 'error' as const });

export interface BaseClientOptions {
  /** Default: the network's pinned public RPC. https (or http on this machine's loopback). */
  url?: string;
  /** Per request, ms (default 15 s). */
  timeoutMs?: number;
}

/**
 * The network's Base RPC through viem. Refuses (RPC_NOT_ALLOWED) a URL that
 * is not https or carries credentials; the caller checks once that its chain
 * id equals the pin (BaseReader.chainIdProblem, check 67) before any other read.
 */
export function baseClient(network: Network, o: BaseClientOptions = {}): BaseClient {
  const cfg = p2pConfig(network);
  if (!cfg) throw new SafetyError(SAFETY.NETWORK_OFF, 'The network is devnet or mainnet.');
  const url = o.url ?? cfg.base.rpcUrl;
  const bad = baseRpcProblem(url);
  if (bad) throw new SafetyError(SAFETY.RPC_NOT_ALLOWED, bad);
  const known = cfg.base.chainId === viemBase.id ? viemBase : cfg.base.chainId === baseSepolia.id ? baseSepolia : null;
  if (!known) throw new SafetyError(SAFETY.NETWORK_OFF, 'Unknown Base chain.');
  const chain = { ...known, rpcUrls: { default: { http: [url] } } };
  // A redirect is refused, never followed (check 67): the request, and a signed transaction in it, goes only to the host checked here.
  const c = createPublicClient({ chain, transport: http(url, { timeout: o.timeoutMs ?? 15_000, retryCount: 1, fetchOptions: BASE_FETCH_OPTIONS }) });
  const blockOf = (b: { number: bigint | null; timestamp: bigint; baseFeePerGas?: bigint | null }): BaseBlock => {
    if (b.number == null) throw new Error('Base answered a block without a number');
    return { number: b.number, timestamp: b.timestamp, baseFeePerGas: typeof b.baseFeePerGas === 'bigint' ? b.baseFeePerGas : null };
  };
  const decoded = (logs: readonly unknown[]): BaseLog[] =>
    (parseEventLogs({ abi: SATURN_SWAP_ABI, logs: logs as never }) as unknown as Array<{ address: string; blockNumber: bigint | null; removed?: boolean; eventName?: string; args?: Record<string, unknown> }>)
      .map((l) => ({ address: l.address, blockNumber: l.blockNumber, removed: l.removed, eventName: l.eventName, args: l.args ?? {} }));
  return {
    chainId: () => c.getChainId(),
    async block(at = {}) {
      return blockOf(at.number != null ? await c.getBlock({ blockNumber: at.number }) : await c.getBlock({ blockTag: at.tag ?? 'latest' }));
    },
    read: (r) => c.readContract({ address: r.address, abi: r.abi, functionName: r.functionName, args: r.args as unknown[], ...(r.blockNumber != null ? { blockNumber: r.blockNumber } : {}) } as never),
    async logs(q) {
      const logs = await c.getLogs({ address: q.address, event: q.event, args: q.args as never, fromBlock: q.fromBlock, toBlock: q.toBlock } as never);
      return (logs as unknown as Array<{ address: string; blockNumber: bigint | null; removed?: boolean; eventName?: string; args?: Record<string, unknown> }>)
        .map((l) => ({ address: l.address, blockNumber: l.blockNumber, removed: l.removed, eventName: l.eventName, args: l.args ?? {} }));
    },
    async receipt(hash) {
      let r;
      try {
        r = await c.getTransactionReceipt({ hash });
      } catch (e) {
        if ((e as Error)?.name === 'TransactionReceiptNotFoundError') return null;
        throw e;
      }
      return { status: r.status, blockNumber: r.blockNumber, transactionHash: r.transactionHash, logs: decoded(r.logs) };
    },
    seen: (hash) => c.getTransaction({ hash }).then(() => true, () => false),
    async code(address) {
      return ((await c.getCode({ address })) ?? '0x') as Hex;
    },
    balance: (address) => c.getBalance({ address }),
    nonce: (address, tag) => c.getTransactionCount({ address, blockTag: tag }),
    priorityFee: () => c.estimateMaxPriorityFeePerGas(),
    async call(t) {
      const r = await c.call({ account: t.from, to: t.to, data: t.data, ...(t.gas != null ? { gas: t.gas } : {}) });
      return (r.data ?? '0x') as Hex;
    },
    estimateGas: (t) => c.estimateGas({ account: t.from, to: t.to, data: t.data }),
    sendRaw: (raw) => c.sendRawTransaction({ serializedTransaction: raw })
  };
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** SaturnSwap's settings and the USDC token's limits in it (checks 12, 17, 24, 43). */
export interface SwapParams {
  feeBps: number;
  paused: boolean;
  minLock: number;
  maxLock: number;
  allowed: boolean;
  minAmount: bigint;
  maxAmount: bigint;
  /** The newest block's time. */
  blockTime: number;
}

/** USDC balance, USDC allowance to SaturnSwap, and ETH balance of an address. */
export interface BaseFunds {
  usdc: bigint;
  allowance: bigint;
  eth: bigint;
}

/** getSwap's tuple -> BaseSwap (addresses lowercase). */
function toSwap(s: unknown): BaseSwap {
  const x = s as Record<string, unknown>;
  if (!x || typeof x !== 'object') throw new Error('Base answered an unreadable swap');
  const out = {
    state: Number(x.state),
    token: String(x.token ?? '').toLowerCase(),
    sender: String(x.sender ?? '').toLowerCase(),
    claimer: String(x.claimer ?? '').toLowerCase(),
    amount: BigInt(x.amount as bigint),
    deadline: Number(x.deadline),
    feeBps: Number(x.feeBps)
  };
  if (!Number.isInteger(out.state) || !Number.isSafeInteger(out.deadline) || !Number.isInteger(out.feeBps)) throw new Error('Base answered an unreadable swap');
  return out;
}

/**
 * A provider's rate limit or quota (HTTP 429, QuickNode -32007, -32029, and
 * the words providers use for it). No bare "limit reached": "block range
 * limit reached" is a range refusal.
 */
const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([429, -32007, -32029]);
const RATE_LIMIT_TEXT = /rate.?limit|too many requests|request rate|rate exceeded|request limit|requests? per (second|minute|day)|per second|throughput|capacity|credits|compute units|daily (request|limit)|monthly (request|limit)|quota/i;
/**
 * A refusal of the block range or of the result size. The bare words are
 * safe because a rate limit is looked for first and nothing is kept between
 * searches: a misread costs at most the rungs below 500 in one search.
 */
const RANGE_CODES: ReadonlySet<number> = new Set([-32614, -32005]);
const RANGE_TEXT = /range|limit|exceed|too large|too many|more than \d/i;

type RpcErrorLike = { status?: number; code?: number; shortMessage?: string; details?: string; message?: string; cause?: unknown } | null;

/** An error and its causes (viem wraps the node's answer), at most 8 deep. */
function errorChain(err: unknown): NonNullable<RpcErrorLike>[] {
  const out: NonNullable<RpcErrorLike>[] = [];
  let x = err as RpcErrorLike;
  for (let i = 0; x && typeof x === 'object' && i < 8; i++, x = x.cause as RpcErrorLike) out.push(x);
  return out;
}

/** The words of one error: viem's summary and the node's own text when it has them (its full message also holds the request). */
function errorWords(x: NonNullable<RpcErrorLike>): string {
  const short = `${x.shortMessage ?? ''} ${x.details ?? ''}`.trim();
  return short || String(x.message ?? '');
}

/**
 * Whether an RPC error carries a provider's rate limit CODE anywhere in its
 * cause chain: HTTP status or code 429, code -32007 or -32029. A log search
 * throws it at once at any size: a smaller request against a provider that
 * throttles the kit is only more requests.
 */
export function isRateLimitCode(err: unknown): boolean {
  for (const x of errorChain(err)) {
    if (RATE_LIMIT_CODES.has(Number(x.status)) || RATE_LIMIT_CODES.has(Number(x.code))) return true;
  }
  return false;
}

/**
 * Whether an RPC error is a provider's rate limit or quota, anywhere in its
 * cause chain: one of the codes of isRateLimitCode, or words such as "rate
 * limit", "too many requests", "compute units", "quota". Words alone decide
 * only for a request of LOG_STEP_PROVEN blocks or fewer (#scanBack): above
 * that they may belong to a range refusal nobody has seen.
 */
export function isRateLimit(err: unknown): boolean {
  if (isRateLimitCode(err)) return true;
  for (const x of errorChain(err)) {
    if (RATE_LIMIT_TEXT.test(errorWords(x))) return true;
  }
  return false;
}

/**
 * Whether an RPC error means "ask for fewer blocks": not a rate limit, and
 * anywhere in the cause chain HTTP 413, code -32614 or -32005, or words
 * about a range, a limit, a size or a count. A timeout or a failed fetch is
 * not one.
 */
export function isRangeError(err: unknown): boolean {
  if (isRateLimit(err)) return false;
  for (const x of errorChain(err)) {
    if (Number(x.status) === 413) return true;
    if (RANGE_CODES.has(Number(x.code))) return true;
    if (RANGE_TEXT.test(errorWords(x))) return true;
  }
  return false;
}

/**
 * The Base reads the kit's checks run, on one network's pinned SaturnSwap
 * and USDC. Every function throws when a read fails: a check that needs it
 * refuses (fail closed), never reads a gap as "none".
 */
export class BaseReader {
  readonly cfg: P2PNetConfig;
  readonly swap: Hex;
  readonly usdc: Hex;
  constructor(readonly client: BaseClient, readonly network: Network) {
    const cfg = p2pConfig(network);
    if (!cfg) throw new SafetyError(SAFETY.NETWORK_OFF, 'The network is devnet or mainnet.');
    this.cfg = cfg;
    this.swap = cfg.base.swap.toLowerCase() as Hex;
    this.usdc = cfg.base.usdc.toLowerCase() as Hex;
  }

  /** Why this RPC must not be used (its chain id is not the pin, check 67), or null. */
  async chainIdProblem(): Promise<string | null> {
    let id: number;
    try { id = await this.client.chainId(); } catch { return 'Could not read the Base RPC\'s chain id.'; }
    return id === this.cfg.base.chainId ? null : `The Base RPC serves chain ${id}, not ${this.cfg.base.name} (${this.cfg.base.chainId}).`;
  }

  /** The newest block's number and time. */
  async head(): Promise<{ number: bigint; time: number }> {
    const b = await this.client.block({ tag: 'latest' });
    return { number: b.number, time: Number(b.timestamp) };
  }

  /** The confirmed point (SPEC BASE_CONFIRM): head - 3 on Base Sepolia, the safe head on Base; never above `head`. */
  async confirmedBlock(head: bigint): Promise<bigint> {
    const n = this.cfg.base.confirmSafe ? (await this.client.block({ tag: 'safe' })).number : head - BigInt(this.cfg.base.confirmBlocks);
    return n > head ? head : n < 0n ? 0n : n;
  }

  #swapAt(h: string, sender: string, blockNumber: bigint): Promise<BaseSwap> {
    return this.client.read({ address: this.swap, abi: SATURN_SWAP_ABI, functionName: 'getSwap', args: [h, sender], blockNumber }).then(toSwap);
  }

  /** getSwap(h, sender) at the newest block, and that block's time. */
  async readSwap(h: string, sender: string): Promise<{ swap: BaseSwap; blockTime: number }> {
    const s = evmLower(sender);
    if (!isHex32(h) || !s) throw new Error('Not a valid lock');
    const head = await this.client.block({ tag: 'latest' });
    return { swap: await this.#swapAt(h.toLowerCase(), s, head.number), blockTime: Number(head.timestamp) };
  }

  /** getSwap at the newest block and at the confirmed point, from one client, plus the newest block's time. */
  async readSwapConfirmed(h: string, sender: string): Promise<{ latest: BaseSwap; confirmed: BaseSwap; blockTime: number; blockNumber: bigint }> {
    const s = evmLower(sender);
    if (!isHex32(h) || !s) throw new Error('Not a valid lock');
    const head = await this.client.block({ tag: 'latest' });
    const at = await this.confirmedBlock(head.number);
    const [latest, confirmed] = await Promise.all([this.#swapAt(h.toLowerCase(), s, head.number), this.#swapAt(h.toLowerCase(), s, at)]);
    return { latest, confirmed, blockTime: Number(head.timestamp), blockNumber: head.number };
  }

  /** SaturnSwap's fee, switches and lock bounds, and the USDC token's limits in it. */
  async readSwapParams(): Promise<SwapParams> {
    const at = { address: this.swap, abi: SATURN_SWAP_ABI };
    const [fee, paused, minLock, maxLock, tc, head] = await Promise.all([
      this.client.read({ ...at, functionName: 'feeBps' }),
      this.client.read({ ...at, functionName: 'paused' }),
      this.client.read({ ...at, functionName: 'minLock' }),
      this.client.read({ ...at, functionName: 'maxLock' }),
      this.client.read({ ...at, functionName: 'tokenCfg', args: [this.usdc] }),
      this.client.block({ tag: 'latest' })
    ]);
    const t = tc as readonly unknown[];
    return {
      feeBps: Number(fee), paused: Boolean(paused), minLock: Number(minLock), maxLock: Number(maxLock),
      allowed: Boolean(t[0]), minAmount: BigInt(t[1] as bigint), maxAmount: BigInt(t[2] as bigint), blockTime: Number(head.timestamp)
    };
  }

  /** USDC balance, USDC allowance to SaturnSwap and ETH balance of an address. */
  async readFunds(owner: string): Promise<BaseFunds> {
    const o = evmLower(owner) as Hex | null;
    if (!o) throw new Error('Not a valid address');
    const [usdc, allowance, eth] = await Promise.all([
      this.client.read({ address: this.usdc, abi: USDC_ABI, functionName: 'balanceOf', args: [o] }),
      this.client.read({ address: this.usdc, abi: USDC_ABI, functionName: 'allowance', args: [o, this.swap] }),
      this.client.balance(o)
    ]);
    return { usdc: BigInt(usdc as bigint), allowance: BigInt(allowance as bigint), eth: BigInt(eth) };
  }

  /**
   * About what `gas` costs at today's fees, for the ETH checks made before a
   * lock (checks 12, 17, 45): twice gas x (1.2 x the base fee + the tip),
   * which leaves room for Base's L1 data fee and a fee rise.
   */
  async gasCostEstimate(gas: bigint): Promise<bigint> {
    const [b, tip] = await Promise.all([this.client.block({ tag: 'latest' }), this.client.priorityFee()]);
    if (b.baseFeePerGas == null) throw new Error('Base answered no base fee');
    return gas * ((b.baseFeePerGas * 12n) / 10n + tip) * 2n;
  }

  /**
   * SaturnSwap logs of one event, filtered on its indexed `args`, from block
   * `top` back to `bottom`, in requests of LOG_CHUNK blocks at first. When a
   * request fails, in this order: a rate limit told by its code is thrown at
   * once; above LOG_STEP_PROVEN blocks any other failure steps down one rung
   * of LOG_STEPS (an error that reads like a rate limit only by its words
   * too: up there the words may belong to a range refusal, and stepping down
   * costs at most 3 requests); at LOG_STEP_PROVEN or fewer a rate limit by
   * code or by words is thrown, only a range refusal steps down, and
   * anything else is thrown; a failure at 1 block is thrown. The size lives
   * in this search only: the next search starts at LOG_CHUNK again. The
   * next range moves only after a served request, so no block is skipped or
   * asked twice. `pick` answers a value to stop with, or undefined to go on;
   * null when nothing was picked.
   */
  async #scanBack<T>(event: AbiEvent, args: Record<string, unknown>, top: bigint, bottom: bigint, pick: (l: BaseLog) => T | undefined): Promise<T | null> {
    let step = LOG_CHUNK;
    let to = top;
    while (to >= bottom) {
      const from = to - step + 1n > bottom ? to - step + 1n : bottom;
      let logs: BaseLog[];
      try {
        logs = await this.client.logs({ address: this.swap, event, args, fromBlock: from, toBlock: to });
      } catch (err) {
        // The rules count the blocks this request really asked for: the last
        // request of a search is cut at its bottom, and stepping from the
        // search's size could ask the very same range again.
        const asked = to - from + 1n;
        if (isRateLimitCode(err) || (asked <= LOG_STEP_PROVEN && isRateLimit(err))) throw err;
        const next = LOG_STEPS.find((n) => n < asked);
        if (next !== undefined && (asked > LOG_STEP_PROVEN || isRangeError(err))) {
          step = next;
          continue;
        }
        throw err;
      }
      for (const l of logs) {
        const v = pick(l);
        if (v !== undefined) return v;
      }
      if (from === 0n) break;
      to = from - 1n;
    }
    return null;
  }

  /**
   * The first block of a search that must reach back to unix time `notBefore`
   * less `margin` (from the head's time when `notBefore` is after it). The
   * block time only guesses it: the guessed block is read, and while its
   * timestamp is after that time the span is doubled, at most
   * SEARCH_WIDEN_MAX times. Throws (the check refuses and tries again later)
   * when the block cannot be read or the widening runs out, never answers a
   * bottom that falls short.
   */
  async #bottomFor(head: { number: bigint; time: number }, notBefore: number, margin: number): Promise<bigint> {
    const reach = Math.min(notBefore, head.time) - margin;
    let span = BigInt(Math.ceil((head.time - reach) / BASE_BLOCK_SECONDS));
    for (let i = 0; ; i++) {
      const bottom = head.number > span ? head.number - span : 0n;
      if (bottom === 0n) return 0n;
      const b = await this.client.block({ number: bottom });
      const t = Number(b.timestamp);
      if (b.number !== bottom || !Number.isSafeInteger(t)) throw new Error(`Base answered another block for ${bottom}`);
      if (t <= reach) return bottom;
      if (i >= SEARCH_WIDEN_MAX) throw new Error(`Base block ${bottom} is still after the time a log search must reach; not searching a shorter span`);
      span *= 2n;
    }
  }

  /**
   * When the buyer's USDC lock was mined (SPEC section 6, "The Base lock
   * window", check 55): the block holding SaturnSwap's Locked event for (h,
   * sender), and its time. From the receipt of `txHash` when it succeeded and
   * holds that very event; otherwise a chunked log search back from the
   * confirmed block to about `fromTime` (getCreated) minus LOCK_SCAN_MARGIN.
   * `confirmedBlock` is the BASE_CONFIRM block: a caller counts the lock only
   * when blockNumber is at or below it. Null when no such event was found.
   */
  async readLockedAt(h: string, sender: string, o: { txHash?: string | null; fromTime: number }): Promise<{ blockNumber: bigint; time: number; confirmedBlock: bigint } | null> {
    const s = evmLower(sender);
    if (!isHex32(h) || !s || !Number.isSafeInteger(o.fromTime)) throw new Error('Not a valid lock');
    const hl = h.toLowerCase();
    const isOurs = (l: BaseLog) => !!l && l.removed !== true && evmLower(l.address) === this.swap && (l.eventName == null || l.eventName === 'Locked')
      && String(l.args?.h ?? '').toLowerCase() === hl && evmLower(l.args?.sender) === s;
    const headB = await this.client.block({ tag: 'latest' });
    const head = { number: headB.number, time: Number(headB.timestamp) };
    const confirmedBlock = await this.confirmedBlock(head.number);
    let at: bigint | null = null;
    if (typeof o.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(o.txHash)) {
      let r: BaseReceipt | null = null;
      try { r = await this.client.receipt(o.txHash as Hex); } catch { r = null; }   // unknown or pruned: search the logs
      if (r && r.status === 'success') {
        const l = r.logs.find((x) => x.eventName === 'Locked' && isOurs(x));
        if (l) at = l.blockNumber ?? r.blockNumber;
      }
    }
    if (at == null) {
      at = await this.#scanBack(LOCKED_EVENT, { h: hl, sender: s }, confirmedBlock, await this.#bottomFor(head, o.fromTime, LOCK_SCAN_MARGIN),
        (l) => (isOurs(l) && l.blockNumber != null ? l.blockNumber : undefined));
    }
    if (at == null) return null;
    const b = await this.client.block({ number: at });
    return { blockNumber: at, time: Number(b.timestamp), confirmedBlock };
  }

  /**
   * USDC's own switches (check 56), at the newest block: isBlacklisted(account),
   * isBlacklisted(SaturnSwap) and paused(). Only for a token pins.ts marks as
   * having them; throws when a read fails.
   */
  async readUsdcGuard(account: string): Promise<{ blacklisted: boolean; swapBlacklisted: boolean; paused: boolean }> {
    const a = evmLower(account);
    if (!a) throw new Error('Not a valid address');
    const at = { address: this.usdc, abi: FIAT_ABI };
    const [bl, swBl, paused] = await Promise.all([
      this.client.read({ ...at, functionName: 'isBlacklisted', args: [a] }),
      this.client.read({ ...at, functionName: 'isBlacklisted', args: [this.swap] }),
      this.client.read({ ...at, functionName: 'paused' })
    ]);
    if (typeof bl !== 'boolean' || typeof swBl !== 'boolean' || typeof paused !== 'boolean') throw new Error('USDC answered something unreadable');
    return { blacklisted: bl, swapBlacklisted: swBl, paused };
  }

  /**
   * Whether any SaturnSwap Claimed event with this h (any sender) exists,
   * searched back from the newest block to `notBefore` (check 64: a
   * Phantasma lock whose h has a Base claim is never refunded).
   */
  async anyClaimedForH(h: string, notBefore: number): Promise<boolean> {
    if (!isHex32(h) || !Number.isSafeInteger(notBefore)) throw new Error('Not a valid lock');
    const hl = h.toLowerCase();
    const headB = await this.client.block({ tag: 'latest' });
    const head = { number: headB.number, time: Number(headB.timestamp) };
    const hit = await this.#scanBack(CLAIMED_EVENT, { h: hl }, head.number, await this.#bottomFor(head, notBefore, 600),
      (l) => (l.removed !== true && evmLower(l.address) === this.swap && String(l.args?.h ?? '').toLowerCase() === hl ? true : undefined));
    return hit === true;
  }

  /**
   * The public secret of a claimed swap (h, sender) at the confirmed block
   * (check 62): getPreimage there, else the Claimed event at or below it.
   * Checked against h either way; null when it is not public (or not
   * confirmed) yet.
   */
  async claimedSecret(h: string, sender: string, notBefore: number): Promise<string | null> {
    const s = evmLower(sender);
    if (!isHex32(h) || !s || !Number.isSafeInteger(notBefore)) throw new Error('Not a valid lock');
    const hl = h.toLowerCase();
    const headB = await this.client.block({ tag: 'latest' });
    const head = { number: headB.number, time: Number(headB.timestamp) };
    const at = await this.confirmedBlock(head.number);
    try {
      const pre = await this.client.read({ address: this.swap, abi: SATURN_SWAP_ABI, functionName: 'getPreimage', args: [hl, s], blockNumber: at });
      if (secretOpens(pre, hl)) return String(pre).toLowerCase();
    } catch { /* not claimed there, or a contract without getPreimage: search the logs */ }
    return this.#scanBack(CLAIMED_EVENT, { h: hl, sender: s }, at, await this.#bottomFor(head, notBefore, 600),
      (l) => (l.removed !== true && evmLower(l.address) === this.swap && secretOpens(l.args?.preimage, hl) ? String(l.args.preimage).toLowerCase() : undefined));
  }

  /** owed(USDC, claimer): a claim's payout the token deferred (check 65). */
  async readOwed(claimer: string): Promise<bigint> {
    const c = evmLower(claimer);
    if (!c) throw new Error('Not a valid address');
    return BigInt(await this.client.read({ address: this.swap, abi: SATURN_SWAP_ABI, functionName: 'owed', args: [this.usdc, c] }) as bigint);
  }

  /** Whether the USDC token's DOMAIN_SEPARATOR() is the permit domain pinned for this network (check 46). */
  async permitDomainOk(): Promise<boolean> {
    const sep = await this.client.read({ address: this.usdc, abi: USDC_ABI, functionName: 'DOMAIN_SEPARATOR' });
    return String(sep).toLowerCase() === pinnedDomainSeparator(this.cfg).toLowerCase();
  }

  /** The USDC permit nonce of `owner`. */
  async permitNonce(owner: string): Promise<bigint> {
    const o = evmLower(owner);
    if (!o) throw new Error('Not a valid address');
    return BigInt(await this.client.read({ address: this.usdc, abi: USDC_ABI, functionName: 'nonces', args: [o] }) as bigint);
  }

  /**
   * Whether `account` holds contract code (a Safe or another smart-contract
   * account, which may publish a claim's calldata without sending it, check
   * 61). An EIP-7702 delegation (0xef0100 + address) is still an account
   * whose own key signs, so it is not one. Throws when the read fails.
   */
  async isContractAccount(account: string): Promise<boolean> {
    const a = evmLower(account);
    if (!a) throw new Error('Not a valid address');
    const code = String((await this.client.code(a as Hex)) ?? '0x').toLowerCase();
    return code !== '0x' && code !== '' && !code.startsWith('0xef0100');
  }
}

/** The EIP-712 domain separator of the pinned USDC permit domain. */
export function pinnedDomainSeparator(cfg: P2PNetConfig): Hex {
  return domainSeparator({ domain: { name: cfg.base.permit.name, version: cfg.base.permit.version, chainId: cfg.base.chainId, verifyingContract: cfg.base.usdc as Hex } });
}

// ── Calls ────────────────────────────────────────────────────────────────────

/**
 * A call the signer may send: to SaturnSwap or USDC only, with its data; or
 * a cancel, a 0-value transfer to the sender itself that takes back a nonce
 * held by one of its own transactions not mined yet.
 */
export interface BaseCall {
  readonly to: Hex;
  readonly data: Hex;
  /** The function, for journals and messages. */
  readonly fn: 'approve' | 'lock' | 'lockWithPermit' | 'claim' | 'refund' | 'withdrawOwed' | 'cancel';
}

const swapOf = (cfg: P2PNetConfig) => cfg.base.swap.toLowerCase() as Hex;
const usdcOf = (cfg: P2PNetConfig) => cfg.base.usdc.toLowerCase() as Hex;

function feeArg(fee: number): number {
  if (!Number.isInteger(fee) || fee < 0 || fee > MAX_FEE_BPS) throw new Error('This trade has no valid fee, so nothing was locked.');
  return fee;
}

function lockFields(p: { h: string; amount: bigint; claimer: string; deadline: number }): { h: Hex; claimer: Hex } {
  const claimer = evmLower(p.claimer);
  if (!isHex32(p.h) || !claimer || !Number.isSafeInteger(p.deadline) || p.deadline <= 0 || typeof p.amount !== 'bigint' || p.amount <= 0n) throw new Error('This lock is not valid, so nothing was locked.');
  return { h: p.h.toLowerCase() as Hex, claimer: claimer as Hex };
}

/** approve(SaturnSwap, amount) on USDC: exactly the amount, never unlimited (check 49). */
export function approveCall(cfg: P2PNetConfig, amount: bigint): BaseCall {
  if (typeof amount !== 'bigint' || amount <= 0n || amount > cfg.base.usdcMax) throw new Error('Not an amount one lock may approve');
  return Object.freeze({ to: usdcOf(cfg), fn: 'approve' as const, data: encodeFunctionData({ abi: USDC_ABI, functionName: 'approve', args: [swapOf(cfg), amount] }) });
}

/** lock(h, USDC, amount, claimer, deadline, maxFeeBps = the trade's fee). */
export function lockCallBase(cfg: P2PNetConfig, p: { h: string; amount: bigint; claimer: string; deadline: number; maxFeeBps: number }): BaseCall {
  const f = lockFields(p);
  return Object.freeze({
    to: swapOf(cfg), fn: 'lock' as const,
    data: encodeFunctionData({ abi: SATURN_SWAP_ABI, functionName: 'lock', args: [f.h, usdcOf(cfg), p.amount, f.claimer, BigInt(p.deadline), feeArg(p.maxFeeBps)] })
  });
}

/** lockWithPermit(…, permitDeadline, v, r, s): the one-step lock. */
export function lockWithPermitCall(cfg: P2PNetConfig, p: { h: string; amount: bigint; claimer: string; deadline: number; maxFeeBps: number; permitDeadline: number; v: number; r: Hex; s: Hex }): BaseCall {
  const f = lockFields(p);
  return Object.freeze({
    to: swapOf(cfg), fn: 'lockWithPermit' as const,
    data: encodeFunctionData({ abi: SATURN_SWAP_ABI, functionName: 'lockWithPermit', args: [f.h, usdcOf(cfg), p.amount, f.claimer, BigInt(p.deadline), feeArg(p.maxFeeBps), BigInt(p.permitDeadline), p.v, p.r, p.s] })
  });
}

/** claim(secret, sender): pays the claimer fixed in the lock. */
export function claimCallBase(cfg: P2PNetConfig, secret: string, sender: string): BaseCall {
  const s = evmLower(sender);
  if (!isHex32(secret) || !s) throw new Error('Not a valid claim');
  return Object.freeze({ to: swapOf(cfg), fn: 'claim' as const, data: encodeFunctionData({ abi: SATURN_SWAP_ABI, functionName: 'claim', args: [secret.toLowerCase() as Hex, s as Hex] }) });
}

/** refund(h, sender): pays the buyer back after the deadline. */
export function refundCallBase(cfg: P2PNetConfig, h: string, sender: string): BaseCall {
  const s = evmLower(sender);
  if (!isHex32(h) || !s) throw new Error('Not a valid refund');
  return Object.freeze({ to: swapOf(cfg), fn: 'refund' as const, data: encodeFunctionData({ abi: SATURN_SWAP_ABI, functionName: 'refund', args: [h.toLowerCase() as Hex, s as Hex] }) });
}

/** withdrawOwed(USDC, claimer): pays a deferred payout to the claimer fixed in the contract. */
export function withdrawOwedCall(cfg: P2PNetConfig, claimer: string): BaseCall {
  const c = evmLower(claimer);
  if (!c) throw new Error('Not a valid address');
  return Object.freeze({ to: swapOf(cfg), fn: 'withdrawOwed' as const, data: encodeFunctionData({ abi: SATURN_SWAP_ABI, functionName: 'withdrawOwed', args: [usdcOf(cfg), c as Hex] }) });
}

/** A cancel: 0 ETH from `from` to itself, no data. Sent only at a nonce one of its own unmined transactions holds. */
export function cancelCall(from: string): BaseCall {
  const f = evmLower(from);
  if (!f) throw new Error('Not a valid address');
  return Object.freeze({ to: f as Hex, fn: 'cancel' as const, data: '0x' as Hex });
}

/** A cancel's gas: a plain transfer. */
export const CANCEL_GAS = 21_000n;

/** EIP-2612's Permit type, fixed: the caller never chooses the types or the domain that get signed. */
export const PERMIT_TYPES = Object.freeze({
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }
  ]
} as const);

/** The permit a one-step lock signs: the pinned USDC domain, spender SaturnSwap, value exactly the lock's amount. */
export function permitTypedData(cfg: P2PNetConfig, owner: string, amount: bigint, nonce: bigint, deadline: number) {
  const o = evmLower(owner);
  if (!o || typeof amount !== 'bigint' || amount <= 0n || typeof nonce !== 'bigint' || nonce < 0n || !Number.isSafeInteger(deadline)) throw new Error('Not a valid permit');
  return {
    domain: { name: cfg.base.permit.name, version: cfg.base.permit.version, chainId: cfg.base.chainId, verifyingContract: usdcOf(cfg) },
    types: PERMIT_TYPES,
    primaryType: 'Permit' as const,
    message: { owner: o as Hex, spender: swapOf(cfg), value: amount, nonce, deadline: BigInt(deadline) }
  };
}

// ── Sending (used by signer.ts only) ────────────────────────────────────────

/** An EIP-1559 transaction built for one call, before it is signed. */
export interface PreparedTx {
  readonly chainId: number;
  readonly from: Hex;
  readonly nonce: number;
  readonly gas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly to: Hex;
  readonly data: Hex;
  /** The most it can cost (wei), with room for Base's L1 data fee. */
  readonly need: bigint;
}

/** An escrow call's gas limit: twice the estimate, at least 150,000 (a claim that runs out of gas still publishes the secret). */
export function claimGasLimit(estimate: bigint): bigint {
  const twice = estimate * 2n;
  return twice > MIN_CLAIM_GAS ? twice : MIN_CLAIM_GAS;
}

/**
 * The account's nonces, counted here and re-synced from the node: the next
 * nonce is the larger of the node's pending count and the one after this
 * process's last send, so two sends never share one. A send that did not go
 * out gives its nonce back; an error drops the local count (resync).
 */
export class NonceManager {
  readonly #next = new Map<string, number>();
  constructor(readonly client: BaseClient) {}

  async take(address: string): Promise<number> {
    const a = String(address).toLowerCase();
    const node = await this.client.nonce(a as Hex, 'pending');
    const local = this.#next.get(a) ?? 0;
    const n = Math.max(Number(node), local);
    this.#next.set(a, n + 1);
    return n;
  }

  /** A nonce taken for a transaction that was not sent. */
  release(address: string, nonce: number): void {
    const a = String(address).toLowerCase();
    if (this.#next.get(a) === nonce + 1) this.#next.set(a, nonce);
  }

  /** Forget the local count: the next take reads the node only. */
  resync(address: string): void {
    this.#next.delete(String(address).toLowerCase());
  }
}

/** A refusal of the Base send rules (check 66), before anything is signed. */
const sendRefusal = (code: string, text: string) => new SafetyError(code, text);

/**
 * A transaction of the kit's that is not mined this long after it was sent is
 * replaced at its own nonce (never followed by a second one at the next
 * nonce, which could not be mined before it).
 */
export const REPLACE_AFTER_MS = 60_000;

/** A replacement pays 25% more than the transaction it replaces, per gas, for the tip and the max fee (nodes ask for at least 10%). */
export function bumpFee(x: bigint): bigint {
  return (x * 125n + 99n) / 100n;
}

/** What a replacement at a nonce must outbid: the fees of the newest transaction the kit sent there. */
export interface ReplaceAt {
  nonce: number;
  outbid: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
}

/**
 * Fees for a replacement of `gas` at a nonce: today's fees (feesFor), and at
 * least 25% more than the transaction it replaces, both for the tip and the
 * max fee; refused (FEE_CAPS) when that is above the pinned caps.
 */
export async function replacementFees(client: BaseClient, cfg: P2PNetConfig, gas: bigint, outbid: ReplaceAt['outbid']): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const caps = cfg.base.feeCaps;
  const fresh = await feesFor(client, cfg, gas);
  const maxPriorityFeePerGas = maxBig(fresh.maxPriorityFeePerGas, bumpFee(outbid.maxPriorityFeePerGas));
  let maxFeePerGas = maxBig(fresh.maxFeePerGas, bumpFee(outbid.maxFeePerGas));
  if (maxFeePerGas < maxPriorityFeePerGas) maxFeePerGas = maxPriorityFeePerGas;
  const perGasCap = gas > 0n && caps.maxFeeWei / gas < caps.maxFeePerGas ? caps.maxFeeWei / gas : caps.maxFeePerGas;
  if (maxPriorityFeePerGas > caps.maxPriorityFeePerGas || maxFeePerGas > perGasCap) {
    throw sendRefusal('FEE_CAPS', `Replacing the transaction not mined yet needs fees above what the kit pays for one step (${maxFeePerGas} wei per gas). Nothing was sent; it is tried again.`);
  }
  return { maxFeePerGas, maxPriorityFeePerGas };
}

const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);

/**
 * Fees for a transaction of `gas`: the RPC's tip, and a max fee of twice the
 * newest block's base fee plus that tip, lowered to the pinned caps (per gas,
 * and gas x max fee). Refused (FEE_CAPS) when the tip is above its cap or the
 * capped max fee no longer covers 1.25 x the base fee plus the tip.
 */
export async function feesFor(client: BaseClient, cfg: P2PNetConfig, gas: bigint): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const caps = cfg.base.feeCaps;
  const [block, tipRaw] = await Promise.all([client.block({ tag: 'latest' }), client.priorityFee()]);
  if (block.baseFeePerGas == null) throw sendRefusal('FEE_CAPS', 'Could not read Base\'s network fee, so nothing was sent.');
  const base = block.baseFeePerGas;
  const tip = BigInt(tipRaw);
  const perGasCap = gas > 0n && caps.maxFeeWei / gas < caps.maxFeePerGas ? caps.maxFeeWei / gas : caps.maxFeePerGas;
  const wanted = 2n * base + tip;
  const maxFeePerGas = wanted > perGasCap ? perGasCap : wanted;
  if (tip > caps.maxPriorityFeePerGas || maxFeePerGas < (base * 5n) / 4n + tip) {
    throw sendRefusal('FEE_CAPS', `Base's network fee is unusually high right now (${base + tip} wei per gas), above what the kit pays for one step. Nothing was sent.`);
  }
  return { maxFeePerGas, maxPriorityFeePerGas: tip };
}

/**
 * Build one transaction from `from` (check 66): simulate the call first
 * (SIMULATION when it would revert: nothing is signed), size its gas (an
 * escrow call twice the estimate and at least 150,000, any other call the
 * estimate plus 30%, or a fixed limit), fees under the pinned caps, the ETH
 * it can cost, and the next nonce. With `replace`, it is built at that nonce
 * instead, with fees that outbid the transaction waiting there.
 */
export async function prepareTx(client: BaseClient, cfg: P2PNetConfig, from: string, call: BaseCall, o: { gas: 'escrow' | 'plain' | bigint; nonces: NonceManager; replace?: ReplaceAt }): Promise<PreparedTx> {
  const f = evmLower(from) as Hex | null;
  if (!f) throw new Error('Not a valid sender');
  const tx: TxCall = { from: f, to: call.to, data: call.data };
  try {
    await client.call(typeof o.gas === 'bigint' ? { ...tx, gas: o.gas } : tx);
  } catch (e) {
    throw sendRefusal('SIMULATION', `Base would refuse this ${call.fn} (${baseErrorText(e)}). Nothing was sent.`);
  }
  let gas: bigint;
  const cap = cfg.base.feeCaps.maxGas;
  if (typeof o.gas === 'bigint') {
    gas = o.gas;
  } else {
    let est: bigint;
    try { est = BigInt(await client.estimateGas(tx)); } catch (e) { throw sendRefusal('SIMULATION', `Base could not estimate this ${call.fn} (${baseErrorText(e)}). Nothing was sent.`); }
    gas = o.gas === 'escrow' ? claimGasLimit(est) : (est * 13n) / 10n;
    if (gas < 21_000n) gas = 21_000n;
    if (gas > cap) {
      if ((est * 6n) / 5n > cap) throw sendRefusal('FEE_CAPS', 'This step needs more gas than the kit signs for one step. Nothing was sent.');
      gas = cap;
    }
  }
  if (gas > cap) throw sendRefusal('FEE_CAPS', 'This step needs more gas than the kit signs for one step. Nothing was sent.');
  const fees = o.replace ? await replacementFees(client, cfg, gas, o.replace.outbid) : await feesFor(client, cfg, gas);
  const l2 = gas * fees.maxFeePerGas;
  const need = l2 + l2 / 5n;
  const have = BigInt(await client.balance(f));
  if (have < need) throw sendRefusal('NO_ETH', `The Base address ${f} holds too little ETH for this step's network fee (it needs up to ${need} wei). Nothing was sent.`);
  // A replacement goes at the nonce its unmined transaction holds; the local counter is left as it is.
  const nonce = o.replace ? o.replace.nonce : await o.nonces.take(f);
  return Object.freeze({ chainId: cfg.base.chainId, from: f, nonce, gas, ...fees, to: call.to, data: call.data, need });
}

/** The prepared transaction as viem signs it (no value, no access list). */
export function serializable(p: PreparedTx) {
  return {
    type: 'eip1559' as const, chainId: p.chainId, nonce: p.nonce, gas: p.gas,
    maxFeePerGas: p.maxFeePerGas, maxPriorityFeePerGas: p.maxPriorityFeePerGas,
    to: p.to, data: p.data, value: 0n, accessList: [] as const
  };
}

/**
 * Whether a signed transaction is exactly the one prepared (check 51):
 * EIP-1559 on this chain, the same nonce, gas, fees, recipient and data, no
 * value, no access list, signed by `from`. Answers its hash, or null.
 */
export async function signedMatches(raw: string, p: PreparedTx): Promise<Hex | null> {
  try {
    const t = parseTransaction(raw as Hex) as { type?: string; chainId?: number; nonce?: number; gas?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; to?: string | null; data?: string; value?: bigint; accessList?: readonly unknown[] };
    const ok = t.type === 'eip1559' && t.chainId === p.chainId && t.nonce === p.nonce && t.gas === p.gas
      && t.maxFeePerGas === p.maxFeePerGas && t.maxPriorityFeePerGas === p.maxPriorityFeePerGas
      && evmLower(t.to) === evmLower(p.to) && String(t.data ?? '0x').toLowerCase() === p.data.toLowerCase()
      && (t.value ?? 0n) === 0n && !(t.accessList?.length);
    if (!ok) return null;
    const signer = await recoverTransactionAddress({ serializedTransaction: raw as never });
    return evmLower(signer) === evmLower(p.from) ? keccak256(raw as Hex) : null;
  } catch {
    return null;
  }
}

/**
 * Why a signed transaction must not be broadcast now (check 51), or null:
 * another transaction already took its nonce; its nonce is above the next one
 * Base expects (an earlier nonce of this address was never sent, so this one
 * would wait behind the gap and could be mined long after its checks, a
 * claim even after its deadline); or the base fee rose above what it pays.
 *
 * A replacement (`replacing`) goes where one of the kit's own transactions
 * waits, so the node's pending count is past its nonce by design: it is
 * sendable while the newest block's count has not passed that nonce (the
 * transaction it replaces is not mined). When an earlier transaction still
 * waits, the replacement waits behind it exactly as the one it replaces
 * does: nothing new is queued, and a cancel there still takes the place of
 * the step's transaction.
 */
export async function notSendable(client: BaseClient, p: PreparedTx, o: { replacing?: boolean } = {}): Promise<string | null> {
  let block: BaseBlock, count: number;
  try {
    [block, count] = await Promise.all([client.block({ tag: 'latest' }), client.nonce(p.from, o.replacing ? 'latest' : 'pending')]);
  } catch {
    return 'Could not read Base right before sending, so nothing was sent.';
  }
  if (block.baseFeePerGas == null) return 'Could not read Base\'s network fee, so nothing was sent.';
  if (o.replacing) {
    if (Number(count) > p.nonce) return 'The transaction this one would replace is no longer waiting: its nonce was used. Nothing was sent.';
  } else {
    if (Number(count) > p.nonce) return 'Another transaction from this address took its nonce, so nothing was sent.';
    if (Number(count) < p.nonce) return 'An earlier transaction from this address has not reached Base, so this one would wait behind it. Nothing was sent.';
  }
  if (p.maxFeePerGas * 10n < block.baseFeePerGas * 11n) return 'Base fees rose above what this transaction pays, so nothing was sent.';
  return null;
}

/**
 * Whether a failed broadcast was refused by the node itself, so the
 * transaction surely did not go out: a JSON-RPC error answer (nonce too low,
 * not enough funds, underpriced, …) or an HTTP 4xx before it was read. A
 * timeout, a lost connection, a 5xx or an internal error (-32603) is not
 * sure: the transaction may have arrived.
 */
export function sendRefused(err: unknown): boolean {
  let x = err as { name?: unknown; code?: unknown; status?: unknown; cause?: unknown; details?: unknown; message?: unknown } | null;
  for (let i = 0; x && typeof x === 'object' && i < 8; i++, x = x.cause as typeof x) {
    if (x.name === 'TimeoutError' || x.name === 'AbortError') return false;
    // The node already holds this very transaction: it went out.
    if (/already known|known transaction|already imported/i.test(`${String(x.details ?? '')} ${String(x.message ?? '')}`)) return false;
    if (x.name === 'HttpRequestError') {
      const s = Number(x.status);
      return s >= 400 && s < 500 && s !== 408;
    }
    if (x.name === 'RpcRequestError') return Number(x.code) !== -32603;
  }
  return false;
}

/**
 * Broadcast a signed transaction: 'sent' when the node took it (or knows it
 * by hash after an error), 'unknown' when no answer says either way (it may
 * still be mined: never treat it as not sent). Throws only when the node
 * refused it (sendRefused).
 */
export async function broadcast(client: BaseClient, raw: Hex, hash: Hex): Promise<'sent' | 'unknown'> {
  try {
    await client.sendRaw(raw);
    return 'sent';
  } catch (e) {
    if (await client.seen(hash).catch(() => false)) return 'sent';
    if (sendRefused(e)) throw e;
    return 'unknown';
  }
}

/** How a sent transaction ended: mined and ran, mined and reverted, or not seen in time (it may still be mined). */
export interface MinedOutcome {
  status: 'success' | 'reverted' | 'timeout';
  blockNumber: bigint | null;
}

/** Wait for a transaction's receipt, at most `timeoutMs` (default 3 min). */
export async function waitMined(client: BaseClient, hash: Hex, o: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<MinedOutcome> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = o.pollMs ?? 2_000;
  const tries = Math.max(1, Math.ceil((o.timeoutMs ?? 180_000) / pollMs));
  for (let i = 0; i < tries; i++) {
    try {
      const r = await client.receipt(hash);
      if (r) return { status: r.status, blockNumber: r.blockNumber };
    } catch { /* read again */ }
    await sleep(pollMs);
  }
  return { status: 'timeout', blockNumber: null };
}

const REVERTS: Readonly<Record<string, string>> = Object.freeze({
  LockPaused: 'new USDC locks are paused on Base',
  TokenNotAllowed: 'this token is not allowed in P2P swaps',
  AmountOutOfRange: 'this USDC amount is outside what one lock accepts',
  BadClaimer: 'the seller\'s Base address cannot receive this lock',
  SwapExists: 'a USDC lock for this trade already exists',
  BadDeadline: 'the lock\'s end time was refused',
  FeeTooHigh: 'the fee on Base is higher than this trade\'s fee',
  TransferMismatch: 'the token did not move the exact amount',
  NotLocked: 'this USDC lock was already claimed or refunded',
  SwapExpired: 'the USDC lock has ended',
  SwapNotExpired: 'the USDC lock has not ended yet',
  NothingOwed: 'nothing is owed to this address',
  NotClaimed: 'this USDC lock is not claimed yet',
  ERC20InsufficientBalance: 'not enough USDC',
  ERC20InsufficientAllowance: 'the USDC approval is not visible yet'
});

/** The revert's error name (decoded with SaturnSwap's and USDC's errors), or null. */
export function revertName(err: unknown): string | null {
  let x = err as { data?: unknown; cause?: unknown; name?: string } | null;
  for (let i = 0; x && i < 10; i++, x = x.cause as typeof x) {
    const d = typeof x.data === 'string' ? x.data : typeof (x.data as { data?: unknown })?.data === 'string' ? (x.data as { data: string }).data : null;
    if (d && /^0x[0-9a-fA-F]{8,}$/.test(d)) {
      try { return decodeErrorResult({ abi: ERRORS_ABI, data: d as Hex }).errorName; } catch { /* not one of ours */ }
    }
    const named = (x as { errorName?: unknown }).errorName ?? (x as { data?: { errorName?: unknown } }).data?.errorName;
    if (typeof named === 'string' && named) return named;
  }
  return null;
}

/** Short, redacted words for a Base error (never the request, which may carry a secret). */
export function baseErrorText(err: unknown): string {
  const name = revertName(err);
  if (name) return REVERTS[name] ?? name;
  const e = err as { shortMessage?: unknown; message?: unknown } | null;
  const m = typeof e?.shortMessage === 'string' && e.shortMessage ? e.shortMessage : typeof e?.message === 'string' ? e.message : String(err ?? 'error');
  return redact(m.split('\n')[0] ?? m, 200);
}

/** A typed Base address, lowercase, or null: 0x + 40 hex with a valid checksum when mixed case, never the zero address. */
export function typedBaseAddress(a: unknown): string | null {
  const s = typeof a === 'string' ? a.trim() : '';
  return isAddress(s, { strict: true }) ? evmLower(s) : null;
}
