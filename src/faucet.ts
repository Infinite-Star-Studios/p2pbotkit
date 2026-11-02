/**
 * The devnet faucet client (build spec sections 2.4.10 and 6.7): test tokens
 * for a bot's own devnet addresses, sent by the board's faucet. Devnet only,
 * checked here before anything is sent; the board checks it three more ways.
 *
 *   GET  /v1/p2p/faucet?network=devnet  {enabled, amounts, perAddressHours, leftToday, low, parts}
 *   POST /v1/p2p/faucet?network=devnet  {pha?, base?} -> 202 {pha, base}
 *
 * POST is not idempotent, but the faucet serves one claim per address per
 * 24 h. So a send whose answer was lost (no answer, or a server error) is
 * sent again, and a FAUCET_LIMIT `address` answer to that second send means
 * the first one most likely went out: devnetFaucet reports it as
 * `alreadyServed` (check the balances), not as an error. A part that is off
 * on the server is null in the answer.
 *
 * The board's own words in an answer (`error`, `note`) are display data,
 * shortened; they reach a log only through redact().
 */
import { BoardError, SafetyError, SAFETY } from './errors.js';
import { redact, redactedLog, shortHex, type LogFn } from './redact.js';
import { evmLower, isPhaAddress } from './rules.js';
import type { BoardClient, SleepFn } from './board.js';
import type { FaucetInfo } from './types.js';

/** How one part of a claim ended: every transaction confirmed, some still pending, some failed, or all failed. */
export type FaucetPartState = 'confirmed' | 'pending' | 'partial' | 'failed';

/** POST /faucet's answer (202): per part, the transactions, what was sent and how it ended. A part that is off, or was not asked for, is null. */
export interface FaucetClaim {
  pha: {
    txHash: string | null;
    /** Whole tokens by symbol (TAZ, RA, SOUL, KCAL). */
    amounts: Record<string, string>;
    state: FaucetPartState | null;
    /** The board's note on a transaction that failed (it sent nothing). */
    error: string | null;
    /** The board's note on a transaction whose outcome is still open. */
    note: string | null;
  } | null;
  base: {
    usdcTx: string | null;
    ethTx: string | null;
    /** Whole units by symbol (mUSDC, ETH). */
    amounts: Record<string, string>;
    state: FaucetPartState | null;
    error: string | null;
    note: string | null;
  } | null;
}

/** GET /faucet's answer: types.ts FaucetInfo plus which parts are on (null from a faucet that does not say). */
export interface FaucetInfoAnswer extends FaucetInfo {
  parts: { pha: boolean; base: boolean } | null;
}

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const PHA_TX = /^[0-9a-fA-F]{64}$/;
const BASE_TX = /^0x[0-9a-fA-F]{64}$/;
const STATES: ReadonlySet<string> = new Set(['confirmed', 'pending', 'partial', 'failed']);
const note = (v: unknown): string | null => (typeof v === 'string' && v ? v.slice(0, 300) : null);
const txOf = (v: unknown, re: RegExp): string | null => (typeof v === 'string' && re.test(v) ? v : null);
const stateOf = (v: unknown): FaucetPartState | null => (typeof v === 'string' && STATES.has(v) ? (v as FaucetPartState) : null);

/** Amounts by symbol, keeping only well-formed rows: a symbol of 2-10 letters and a decimal number. */
function amountsOf(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRec(v)) return out;
  for (const [k, x] of Object.entries(v)) if (/^[A-Za-z]{2,10}$/.test(k) && typeof x === 'string' && /^\d{1,30}(\.\d{1,30})?$/.test(x)) out[k] = x;
  return out;
}

/** GET /faucet's data, or null when it is not the faucet's shape. */
export function parseFaucetInfo(v: unknown): FaucetInfoAnswer | null {
  if (!isRec(v) || typeof v.enabled !== 'boolean') return null;
  const int = (x: unknown) => (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : 0);
  const parts = isRec(v.parts) && typeof v.parts.pha === 'boolean' && typeof v.parts.base === 'boolean' ? { pha: v.parts.pha, base: v.parts.base } : null;
  return { enabled: v.enabled, amounts: amountsOf(v.amounts), perAddressHours: int(v.perAddressHours), leftToday: int(v.leftToday), low: v.low === true, parts };
}

/** POST /faucet's data, or null when it is not the faucet's shape (at least one part is answered). */
export function parseFaucetClaim(v: unknown): FaucetClaim | null {
  if (!isRec(v) || !('pha' in v) || !('base' in v)) return null;
  const pha = isRec(v.pha)
    ? { txHash: txOf(v.pha.txHash, PHA_TX), amounts: amountsOf(v.pha.amounts), state: stateOf(v.pha.state), error: note(v.pha.error), note: note(v.pha.note) }
    : null;
  const base = isRec(v.base)
    ? { usdcTx: txOf(v.base.usdcTx, BASE_TX), ethTx: txOf(v.base.ethTx, BASE_TX), amounts: amountsOf(v.base.amounts), state: stateOf(v.base.state), error: note(v.base.error), note: note(v.base.note) }
    : null;
  if (!pha && !base) return null;
  return { pha, base };
}

/** The faucet's outcome for one request. */
export interface FaucetOutcome {
  /** The faucet's answer, or null when `alreadyServed`. */
  claim: FaucetClaim | null;
  /**
   * An earlier send's answer was lost, and the faucet now says it already
   * served this address in the last 24 h: the earlier send most likely went
   * out. Check the balances; this is not an error.
   */
  alreadyServed: boolean;
  /** When the faucet serves this address again (seconds from now), when it said. */
  retryAfter: number | null;
}

export interface DevnetFaucetOptions {
  signal?: AbortSignal;
  /** Sends of the same request after a lost answer, at most (default 2). */
  resends?: number;
  /** The wait before such a send, ms (default 5 s). */
  resendAfterMs?: number;
  log?: LogFn;
  /** For tests. */
  sleep?: SleepFn;
}

/**
 * A send whose outcome is unknown: no answer, or a server error. FAUCET_EMPTY
 * (503) is not one: the faucet refused before sending anything, and it asks
 * for an hour's wait, so asking again in seconds only spends the per-IP limit.
 */
const unknownOutcome = (e: BoardError) => e.code === 'NETWORK' || (e.status >= 500 && e.code !== 'FAUCET_EMPTY');

const realSleep: SleepFn = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted || !(ms > 0)) { resolve(); return; }
  const done = () => { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); };
  const t = setTimeout(done, ms);
  signal?.addEventListener('abort', done, { once: true });
});

/**
 * Ask the devnet faucet for test tokens for `to` (a Phantasma address, a
 * Base address or both). Refuses any network but devnet before sending.
 * Throws BoardError for a refusal: FAUCET_OFF (off on this server),
 * FAUCET_LIMIT (an address, IP, hourly or daily cap; `retryAfter` says when),
 * FAUCET_EMPTY (the faucet is low), P2P_OFF.
 */
export async function devnetFaucet(board: BoardClient, to: { pha?: string; base?: string }, o: DevnetFaucetOptions = {}): Promise<FaucetOutcome> {
  if (board.network !== 'devnet') throw new SafetyError(SAFETY.NETWORK_OFF, 'The faucet runs on devnet only; mainnet has none.');
  const body: { pha?: string; base?: string } = {};
  if (to?.pha !== undefined && to.pha !== '') {
    if (!isPhaAddress(to.pha)) throw new SafetyError('BAD_INPUT', 'pha is a Phantasma address (P2K…).');
    body.pha = to.pha;
  }
  if (to?.base !== undefined && to.base !== '') {
    if (!evmLower(to.base)) throw new SafetyError('BAD_INPUT', 'base is a Base address (0x + 40 hex).');
    body.base = to.base;
  }
  if (!body.pha && !body.base) throw new SafetyError('BAD_INPUT', 'Name a Phantasma address, a Base address or both.');
  const log = redactedLog(o.log);
  const wait = o.sleep ?? realSleep;
  const resends = typeof o.resends === 'number' && Number.isSafeInteger(o.resends) ? Math.max(0, Math.min(o.resends, 5)) : 2;
  const after = typeof o.resendAfterMs === 'number' && Number.isSafeInteger(o.resendAfterMs) && o.resendAfterMs >= 0 ? o.resendAfterMs : 5_000;
  let lost = false;
  for (let i = 0; ; i++) {
    try {
      const claim = await board.faucet(body, { signal: o.signal });
      return { claim, alreadyServed: false, retryAfter: null };
    } catch (e) {
      if (!(e instanceof BoardError)) throw e;
      // The answer to an earlier send was lost; the faucet now says it served this address: that send went out.
      if (lost && e.code === 'FAUCET_LIMIT' && e.reason === 'address') {
        log('faucet: an earlier request\'s answer was lost, and the faucet now says it already served this address: check the balances');
        return { claim: null, alreadyServed: true, retryAfter: e.retryAfter };
      }
      if (!unknownOutcome(e) || i >= resends || o.signal?.aborted) throw e;
      lost = true;
      log(`faucet: no clear answer (${e.code}); asking again in ${Math.round(after / 1000)} s (the faucet serves an address once a day, so nothing is sent twice)`);
      await wait(after, o.signal);
      if (o.signal?.aborted) throw e;
    }
  }
}

/** Lines that say what a claim sent, for a script's output: amounts and short transaction hashes (all public); the board's notes redacted. */
export function faucetClaimLines(c: FaucetClaim): string[] {
  const out: string[] = [];
  const amounts = (a: Record<string, string>) => Object.entries(a).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing';
  if (c.pha) {
    out.push(`Phantasma: ${amounts(c.pha.amounts)}${c.pha.state ? ` (${c.pha.state})` : ''}${c.pha.txHash ? `, tx ${shortHex(c.pha.txHash)}` : ''}`);
    if (c.pha.error) out.push(`  ${redact(c.pha.error, 300)}`);
    if (c.pha.note) out.push(`  ${redact(c.pha.note, 300)}`);
  }
  if (c.base) {
    const txs = [c.base.usdcTx && `mUSDC tx ${shortHex(c.base.usdcTx)}`, c.base.ethTx && `ETH tx ${shortHex(c.base.ethTx)}`].filter(Boolean).join(', ');
    out.push(`Base Sepolia: ${amounts(c.base.amounts)}${c.base.state ? ` (${c.base.state})` : ''}${txs ? `, ${txs}` : ''}`);
    if (c.base.error) out.push(`  ${redact(c.base.error, 300)}`);
    if (c.base.note) out.push(`  ${redact(c.base.note, 300)}`);
  }
  return out;
}
