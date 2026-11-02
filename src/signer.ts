/**
 * The only module that signs (build spec section 6.4). It accepts nothing
 * but a Checked intent that checks.ts issued through it: an intent it did not
 * issue (a look-alike object), one older than 60 s, or one already used is
 * refused before anything else happens, and so is an intent for another key,
 * network or step. Right before it signs, it runs the intent's re-checks
 * (the items marked R in section 6.4), so time that passed since the checks
 * cannot slip a stale fact into a signature. A refusal throws SignRefusal;
 * nothing has been signed or sent then.
 *
 * What it adds to the checks:
 *   27  one signing flow per trade at a time (an in-process mutex), and the
 *       store's single-instance lock is asserted before every signature;
 *   34  every Phantasma send carries the fixed gas allowance; on P2:used the
 *       secret is replaced only when the lock under it is someone else's;
 *   49  without a permit, USDC is approved for exactly the amount, never
 *       more, then the re-check runs again before the lock;
 *   51  the signed Base transaction is exactly the one prepared, still
 *       sendable (its nonce exactly the next one Base expects, never one
 *       already taken nor one behind a gap; the fee still enough), and its
 *       exact call is simulated once more before it is broadcast;
 *   58  the reveal records secretSentAt before the secret is posted, and the
 *       kit's own claim before its simulation (which already carries it);
 *   61  the USDC claim refuses a smart-contract account, re-checks before the
 *       simulation and before signing, and only one claim per h is in flight:
 *       while one is not mined, a later claim goes only at its nonce, as its
 *       replacement with higher fees, never at the next nonce behind it;
 *   66  every Base write is simulated first, the re-check runs twice, gas is
 *       the estimate plus 30% (twice it for escrow calls), fees stay under the
 *       pinned caps, and nonces come from a local counter re-synced on error.
 *
 * Durable writes (section 6.5): the journal intent before any send, the
 * transaction hash as soon as the send returns, the outcome when it is known
 * (an outcome that is not known stays open for run() to resolve from the chain).
 * Only a send the node refused is recorded as not sent; a send whose answer
 * was lost may still land, so it stays open. The lock re-checks also read the
 * chain and the journal again, so a second intent of one trade never sends a
 * second lock under the same h.
 */
import { parseSignature } from 'viem';
import { P2P_CONFIG, phaPinned, baseDeployed, escrowCfg, type P2PNetConfig } from './pins.js';
import { SafetyError, SAFETY } from './errors.js';
import { secretOpens, makeSecretRecord } from './codec.js';
import { redactedLog, errorText, shortHex, type LogFn } from './redact.js';
import {
  PhaReader, PhaRpcError, lockCall, claimCall, refundCall, escrowTransaction, txHex, waitPhaTx, phaTxHalted, phaRefusalText, PHA_TX_TTL_MS,
  type PhaRpc, type PhaCall
} from './pha.js';
import {
  BaseReader, NonceManager, prepareTx, serializable, signedMatches, notSendable, broadcast, waitMined, baseErrorText, permitTypedData,
  approveCall, lockCallBase, lockWithPermitCall, claimCallBase, refundCallBase, withdrawOwedCall, cancelCall, CANCEL_GAS, PERMIT_SECONDS, PERMIT_MAX_SECONDS,
  type BaseClient, type BaseCall, type PreparedTx, type ReplaceAt, type Hex
} from './base.js';
import type { LoadedKeys } from './keys.js';
import type { KitStore } from './store.js';
import type { Network, IntentKind, TradeTxs } from './types.js';
import type { Problem, CheckId } from './checks.js';

// ── Intents ─────────────────────────────────────────────────────────────────

/**
 * The steps the signer performs. Every one but 'reveal' is a signature;
 * 'reveal' shares the secret. 'cancelBase' takes back the nonce of one of the
 * kit's own Base sends that is not mined (a 0-value transfer to itself).
 */
export type SignKind = 'phaLock' | 'baseLock' | 'claimBase' | 'claimPha' | 'refundPha' | 'refundBase' | 'withdrawOwed' | 'cancelBase' | 'reveal';

/** The Base steps whose unmined send is followed at its own nonce (replaced or taken back), never sent again behind it. */
export type FollowedKind = 'claimBase' | 'refundBase' | 'withdrawOwed';
export const FOLLOWED_KINDS: readonly FollowedKind[] = Object.freeze(['claimBase', 'refundBase', 'withdrawOwed']);

/** The journal intent of an unmined send a step replaces at its nonce. */
export interface FollowFacts { journalId: string; nonce: number }

/** What each step signs, fixed when the checks pass (frozen). */
export interface FactsMap {
  phaLock: { tradeId: number; escrow: string; h: string; symbol: string; amount: bigint; sender: string; recipient: string; fee: number; usdc: bigint; bBase: string };
  baseLock: { tradeId: number; escrow: string; h: string; amount: bigint; claimer: string; owner: string; t1: number; t2: number; fee: number; usePermit: boolean; created: number; sPha: string };
  claimBase: { tradeId: number; escrow: string; h: string; sender: string; deadline: number; minLeft: number; follow?: FollowFacts };
  claimPha: { tradeId: number; escrow: string; h: string; secret: string; deadline: number };
  refundPha: { tradeId: number; escrow: string; h: string; deadline: number };
  refundBase: { tradeId: number; h: string; sender: string; deadline: number; follow?: FollowFacts };
  withdrawOwed: { tradeId: number; claimer: string; follow?: FollowFacts };
  cancelBase: { tradeId: number; journalId: string; nonce: number; of: FollowedKind };
  reveal: { tradeId: number; h: string; escrow: string };
}

/** A re-check's answer: still fine (with the lock's deadline, read again, for a Phantasma lock), or why not. */
export type RecheckResult = { ok: true; deadline?: number } | { ok: false; problem: Problem };
export type Recheck = () => Promise<RecheckResult>;

/**
 * A step whose checks passed. Only checks.ts makes them (through the issuer
 * this module hands it once), and the signer takes each one once, within
 * 60 s of its issue.
 */
export interface Checked<K extends SignKind> {
  readonly kind: K;
  readonly network: Network;
  readonly tradeId: number;
  /** The address that must sign: the kit's Phantasma or Base address ('' for a reveal, which signs nothing). */
  readonly signer: string;
  /** ms, when the checks passed. */
  readonly issuedAt: number;
  readonly facts: Readonly<FactsMap[K]>;
  /** The R re-checks, run right before signing. */
  readonly recheck: Recheck;
}

/** How old an intent may be when the signer takes it. */
export const INTENT_MAX_AGE_MS = 60_000;

/** Intents issued and not yet taken. Module-private: nothing else can add to it. */
const ISSUED = new WeakSet<object>();
/** Intents already taken (refused again with INTENT_USED). */
const USED = new WeakSet<object>();
let issuerTaken = false;

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

export type Issuer = <K extends SignKind>(i: Checked<K>) => Checked<K>;

function issue<K extends SignKind>(i: Checked<K>): Checked<K> {
  const out = Object.freeze({
    kind: i.kind, network: i.network, tradeId: i.tradeId, signer: i.signer, issuedAt: i.issuedAt,
    facts: deepFreeze({ ...i.facts }), recheck: i.recheck
  }) as Checked<K>;
  ISSUED.add(out);
  return out;
}

/**
 * @internal checks.ts takes the issuer once, when it loads; any later call
 * throws, so no other module can make an intent the signer accepts.
 */
export function takeIssuer(): Issuer {
  if (issuerTaken) throw new SafetyError('ISSUER_TAKEN', 'The intent issuer belongs to checks.ts.');
  issuerTaken = true;
  return issue;
}

// ── Refusals and results ────────────────────────────────────────────────────

/** The signer refused: nothing was signed or sent. `check` is the section 6.4 check behind it. */
export class SignRefusal extends SafetyError {
  readonly check: CheckId | null;
  readonly retry: boolean;
  /** LOCKED_ALREADY / USDC_LOCKED_ALREADY from a re-check: the lock that already exists (report it, never lock again). */
  readonly h?: string;
  readonly txHash?: string;
  constructor(code: string, detail: string, o: { check?: CheckId | null; retry?: boolean; h?: string; txHash?: string } = {}) {
    super(code, detail);
    this.name = 'SignRefusal';
    this.check = o.check ?? null;
    this.retry = o.retry === true;
    if (o.h) this.h = o.h;
    if (o.txHash) this.txHash = o.txHash;
  }

  static of(p: Problem): SignRefusal {
    return new SignRefusal(p.code, p.text, { check: p.check, retry: p.retry, h: p.h, txHash: p.txHash });
  }
}

/** The refusal codes of the signer's own gate (not a check of section 6.4). */
export const SIGNER_CODES = Object.freeze({
  /** Not an intent this signer issued (a look-alike object, or none). */
  INTENT_FOREIGN: 'INTENT_FOREIGN',
  /** Issued more than 60 s ago (or in the future). */
  INTENT_OLD: 'INTENT_OLD',
  /** Already taken once. */
  INTENT_USED: 'INTENT_USED',
  /** An intent of another step or network than this call signs. */
  INTENT_KIND: 'INTENT_KIND'
});

/**
 * What a step did:
 *   confirmed       the transaction ran (or the reveal was taken);
 *   failed          it was refused or reverted on chain: what it was for did not happen;
 *   pending         sent, outcome not known yet (the journal keeps it open for run() to resolve);
 *   done_elsewhere  the chain shows it done by someone else (the keeper won the race): nothing was sent.
 */
export interface SendResult {
  readonly kind: SignKind;
  readonly tradeId: number;
  readonly outcome: 'confirmed' | 'failed' | 'pending' | 'done_elsewhere';
  readonly txHash: string | null;
  /** Why it failed, or the note of done_elsewhere (redacted). */
  readonly reason?: string;
  /** baseLock without a permit: the approval sent first, if one was needed. */
  readonly approveTx?: string;
  /** phaLock refused with P2:used under someone else's lock: a new secret was made for the next try. */
  readonly secretReplaced?: boolean;
}

// ── The signer ──────────────────────────────────────────────────────────────

export interface SignerDeps {
  readonly keys: LoadedKeys;
  /** The Phantasma node (sends and transaction states). */
  readonly pha: PhaRpc;
  /** The Base node. */
  readonly base: BaseClient;
  readonly store: KitStore;
  /** Local clock, ms (default Date.now). The same clock the checks use. */
  readonly now?: () => number;
  /** Receives redacted lines only. */
  readonly log?: LogFn;
  /** For tests: how waits happen (default setTimeout). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** For tests: how long and how often outcomes are read. */
  readonly wait?: { phaTries?: number; phaIntervalMs?: number; baseTimeoutMs?: number; basePollMs?: number; allowanceTries?: number; allowancePollMs?: number };
}

/** One signing flow per trade in this process (check 27), across every signer. */
const BUSY = new Set<string>();
/** One USDC claim per h in flight (check 61). */
const CLAIMING = new Set<string>();

/** Signs for one network with one bot's keys. Use createSigner(). */
export class Signer {
  readonly network: Network;
  readonly address: Readonly<{ pha: string; base: Hex }>;
  readonly #keys: LoadedKeys;
  readonly #pha: PhaRpc;
  readonly #phaReader: PhaReader;
  readonly #base: BaseClient;
  readonly #baseReader: BaseReader;
  readonly #store: KitStore;
  readonly #now: () => number;
  readonly #log: LogFn;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #wait: NonNullable<SignerDeps['wait']>;
  readonly #nonces: NonceManager;
  readonly #cfg: P2PNetConfig;

  constructor(d: SignerDeps) {
    const network = d.keys?.network;
    const cfg = network === 'devnet' || network === 'mainnet' ? P2P_CONFIG[network] : null;
    if (!cfg) throw new SafetyError(SAFETY.NETWORK_OFF, 'The keys are for no network this kit knows.');
    // Mainnet's pins are empty in this release: nothing is ever signed there (section 7, invariant 12).
    if (!phaPinned(cfg) || !baseDeployed(cfg)) throw new SafetyError(SAFETY.NETWORK_OFF, `This kit release has no pins for ${network}, so it signs nothing there.`);
    this.network = network;
    this.#cfg = cfg;
    this.address = Object.freeze({ pha: d.keys.address.pha, base: d.keys.address.base.toLowerCase() as Hex });
    this.#keys = d.keys;
    this.#pha = d.pha;
    this.#phaReader = new PhaReader(d.pha, network);
    this.#base = d.base;
    this.#baseReader = new BaseReader(d.base, network);
    this.#store = d.store;
    this.#now = d.now ?? Date.now;
    this.#log = redactedLog(d.log);
    this.#sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    this.#wait = d.wait ?? {};
    this.#nonces = new NonceManager(d.base);
    if (d.store.network !== network) throw new SafetyError(SAFETY.NETWORK_OFF, 'The store is for another network than the keys.');
  }

  // ── The gate ──────────────────────────────────────────────────────────────

  /** Take an intent once: issued here, of this step and network, at most 60 s old, for this signer's key. */
  #take<K extends SignKind>(intent: Checked<K>, kind: K): void {
    const o = intent as unknown as object;
    if (!o || typeof o !== 'object' || !ISSUED.has(o)) {
      if (o && typeof o === 'object' && USED.has(o)) throw new SignRefusal(SIGNER_CODES.INTENT_USED, 'This intent was already used once. Run the checks again.');
      throw new SignRefusal(SIGNER_CODES.INTENT_FOREIGN, 'This is not an intent the kit\'s checks issued, so nothing is signed for it.');
    }
    if (intent.kind !== kind || intent.network !== this.network) throw new SignRefusal(SIGNER_CODES.INTENT_KIND, `This intent is for ${intent.kind} on ${intent.network}, not ${kind} on ${this.network}.`);
    // Taken now, whatever follows: an intent is never signed twice.
    ISSUED.delete(o);
    USED.add(o);
    const age = this.#now() - intent.issuedAt;
    if (!(age <= INTENT_MAX_AGE_MS && age >= -5_000)) throw new SignRefusal(SIGNER_CODES.INTENT_OLD, `This intent's checks ran ${Math.round(age / 1000)} s ago, more than ${INTENT_MAX_AGE_MS / 1000} s. Run the checks again.`);
    const want = kind === 'reveal' ? '' : ['phaLock', 'claimPha', 'refundPha'].includes(kind) ? this.address.pha : this.address.base;
    const got = kind === 'reveal' || ['phaLock', 'claimPha', 'refundPha'].includes(kind) ? intent.signer : intent.signer.toLowerCase();
    if (got !== want) {
      const code = ['phaLock', 'claimPha', 'refundPha'].includes(kind) ? 'PHA_KEY' : 'BASE_KEY';
      throw new SignRefusal(code, `This step must be signed by ${intent.signer || 'no key'}, and this signer holds ${want || 'no key'}.`, { check: code === 'PHA_KEY' ? 28 : 41 });
    }
  }

  /** Run `fn` while no other signing flow of this trade runs (check 27), with the store's lock asserted first. */
  async #exclusive<T>(network: Network, tradeId: number, fn: () => Promise<T>): Promise<T> {
    const key = `${network}:${tradeId}`;
    if (BUSY.has(key)) throw new SignRefusal('LOCK_BUSY', `A signing flow of trade #${tradeId} is already running. Nothing else was signed.`, { check: 27, retry: true });
    BUSY.add(key);
    try {
      await this.#store.assertLock();
      return await fn();
    } finally {
      BUSY.delete(key);
    }
  }

  /** The intent's re-checks: fine, or DONE_ELSEWHERE (a result), or a refusal. */
  async #recheck(intent: Checked<SignKind>): Promise<{ ok: true; deadline?: number } | { done: SendResult }> {
    let r: RecheckResult;
    try {
      r = await intent.recheck();
    } catch (e) {
      throw new SignRefusal('RECHECK', `The re-check before signing could not run (${errorText(e)}). Nothing was signed.`, { retry: true });
    }
    if (r.ok) return r;
    if (r.problem.code === 'DONE_ELSEWHERE') return { done: this.#result(intent, 'done_elsewhere', null, { reason: r.problem.text }) };
    throw SignRefusal.of(r.problem);
  }

  /**
   * The re-check right before signing a Base transaction whose nonce is
   * already taken: when it refuses (or the step is done elsewhere), the nonce
   * is given back, so the next send does not leave a gap.
   */
  async #recheckPrepared(intent: Checked<SignKind>, p: PreparedTx, replacing = false): Promise<{ ok: true; deadline?: number } | { done: SendResult }> {
    // A replacement's nonce was never taken from the counter: it belongs to the transaction still waiting there.
    const release = () => { if (!replacing) this.#nonces.release(p.from, p.nonce); };
    let r: { ok: true; deadline?: number } | { done: SendResult };
    try {
      r = await this.#recheck(intent);
    } catch (e) {
      release();
      throw e;
    }
    if ('done' in r) release();
    return r;
  }

  #result(intent: Checked<SignKind>, outcome: SendResult['outcome'], txHash: string | null, extra: Partial<SendResult> = {}): SendResult {
    return Object.freeze({ kind: intent.kind, tradeId: intent.tradeId, outcome, txHash, ...extra });
  }

  // ── Phantasma ─────────────────────────────────────────────────────────────

  /**
   * Sign and send one escrow call on Phantasma: the journal intent first,
   * the fixed gas allowance, the hash recorded as soon as the node answers,
   * then the outcome. A node that answered an error means nothing was sent;
   * no answer at all leaves the intent open (it may still land).
   */
  async #sendPha(intent: Checked<SignKind>, journalKind: IntentKind, cfg: P2PNetConfig, call: PhaCall, h: string): Promise<{ hash: string | null; state: string; reason: string }> {
    const tradeId = intent.tradeId;
    const tx = escrowTransaction(cfg, this.address.pha, call, this.#now() + PHA_TX_TTL_MS);
    const j = await this.#store.addIntent(tradeId, { kind: journalKind, h });
    tx.signWithKeys(this.#keys.pha);
    let hash: string;
    try {
      hash = await this.#pha.sendRaw(txHex(tx));
    } catch (e) {
      if (e instanceof PhaRpcError || /refused the transaction/.test(String((e as Error)?.message))) {
        await this.#store.resolveIntent(tradeId, j.id, 'not_sent', errorText(e));
        return { hash: null, state: 'Rejected', reason: errorText(e) };
      }
      this.#log(`[signer] ${this.network} #${tradeId}: the ${journalKind} send got no answer; it may still land (journal ${j.id} stays open)`);
      return { hash: null, state: 'Unknown', reason: errorText(e) };
    }
    await this.#store.recordSent(tradeId, j.id, { txHash: hash });
    await this.#store.patchTrade(tradeId, { txs: { [txKey(journalKind)]: hash } as Partial<TradeTxs> });
    this.#log(`[signer] ${this.network} #${tradeId}: ${journalKind} sent (${shortHex(hash)})`);
    const st = await waitPhaTx(this.#pha, hash, { tries: this.#wait.phaTries, intervalMs: this.#wait.phaIntervalMs, sleep: this.#sleep });
    if (phaTxHalted(st)) await this.#store.resolveIntent(tradeId, j.id, 'confirmed');
    else if (st.state !== 'Pending') await this.#store.resolveIntent(tradeId, j.id, 'failed', st.reason);
    return { hash, state: st.state, reason: st.reason };
  }

  /**
   * The seller's Phantasma lock (checks 31, 33, 34): the re-check (a fresh
   * trade read, the code pin, the cap, the Base side, then the clock read
   * again for T1), then lock(S_p, h, symbol, amount, B_p, T1) on the current
   * escrow with the fixed gas allowance. On P2:used a new secret is made only
   * when the lock under h is someone else's.
   */
  async lockPha(intent: Checked<'phaLock'>): Promise<SendResult> {
    this.#take(intent, 'phaLock');
    const f = intent.facts;
    return this.#exclusive(intent.network, f.tradeId, async () => {
      const r = await this.#recheck(intent);
      if ('done' in r) return r.done;
      if (!Number.isSafeInteger(r.deadline)) throw new SignRefusal('CLOCK_RECHECK', 'The lock\'s end time was not read again. Nothing was locked.', { check: 33, retry: true });
      const cfg = this.#cfg;
      if (f.escrow !== cfg.phaContract) throw new SignRefusal('ESCROW_CHANGED', 'A new lock goes only to the network\'s current escrow. Nothing was locked.', { check: 19 });
      const call = lockCall(cfg, f.sender, f.h, f.symbol, f.amount, f.recipient, r.deadline as number);
      const sent = await this.#sendPha(intent, 'phaLock', cfg, call, f.h);
      if (!sent.hash) return this.#result(intent, sent.state === 'Unknown' ? 'pending' : 'failed', null, { reason: sent.reason });
      if (sent.state === 'Halt') return this.#result(intent, 'confirmed', sent.hash);
      if (sent.state === 'Pending') return this.#result(intent, 'pending', sent.hash);
      let secretReplaced = false;
      if (sent.reason.includes('P2:used')) secretReplaced = await this.#replaceUsedSecret(f);
      return this.#result(intent, 'failed', sent.hash, { reason: phaRefusalText(sent.reason, f.symbol) || sent.reason, ...(secretReplaced ? { secretReplaced } : {}) });
    });
  }

  /**
   * P2:used (check 34): a new secret only when the lock under h reads as someone else's (a lagging read that shows
   * none changes nothing), and only for a lock under a secret this kit made for the trade (role S, a standard
   * lock). An instant lock runs under the buyer's h: a new secret of the kit's own would never be used, so none
   * is made; the next step refuses HASH_TAKEN and sends nothing more.
   */
  async #replaceUsedSecret(f: FactsMap['phaLock']): Promise<boolean> {
    let own;
    try {
      own = await this.#store.getSecret(f.h);
    } catch (e) {
      // The next sellerLock sees the same foreign lock and makes the secret itself.
      this.#log(`[signer] ${this.network} #${f.tradeId}: the lock hash was used by someone else's lock, and this kit's secret for it could not be read yet (${errorText(e)})`);
      return false;
    }
    if (!own || own.role !== 'S' || own.tradeId !== f.tradeId) {
      this.#log(`[signer] ${this.network} #${f.tradeId}: the lock hash was used by someone else's lock; the hash is the buyer's (an instant trade), so no new secret is made`);
      return false;
    }
    const l = await this.#phaReader.readLock(this.#cfg, f.h).catch(() => null);
    const ours = !!l && l.state >= 1 && l.sender === f.sender && l.recipient === f.recipient && l.symbol === f.symbol && l.amount === f.amount;
    if (!l || l.state === 0 || ours) return false;
    try {
      await this.#store.putSecret(makeSecretRecord({ tradeId: f.tradeId, network: this.network, symbol: f.symbol, taz: f.amount.toString(), sPha: f.sender, bPha: f.recipient, role: 'S' }, this.#now()));
    } catch (e) {
      // The send's outcome still stands; the next sellerLock sees the same foreign lock and makes the secret itself.
      this.#log(`[signer] ${this.network} #${f.tradeId}: the lock hash was used by someone else's lock, and a new secret could not be kept yet (${errorText(e)})`);
      return false;
    }
    this.#log(`[signer] ${this.network} #${f.tradeId}: the lock hash was used by someone else's lock; a new secret is kept for the next try`);
    return true;
  }

  /** The buyer's own claim of the tokens on Phantasma (check 62), with the public secret. */
  async claimPha(intent: Checked<'claimPha'>): Promise<SendResult> {
    this.#take(intent, 'claimPha');
    const f = intent.facts;
    return this.#exclusive(intent.network, f.tradeId, async () => {
      const r = await this.#recheck(intent);
      if ('done' in r) return r.done;
      if (!secretOpens(f.secret, f.h)) throw new SignRefusal('CLAIM_PHA', 'The secret does not open this lock. Nothing was sent.', { check: 62 });
      const cfg = this.#escrow(f.escrow);
      const sent = await this.#sendPha(intent, 'claimPha', cfg, claimCall(cfg, f.secret), f.h);
      return this.#phaOutcome(intent, sent);
    });
  }

  /** The seller's refund of its own tokens on Phantasma (check 64). */
  async refundPha(intent: Checked<'refundPha'>): Promise<SendResult> {
    this.#take(intent, 'refundPha');
    const f = intent.facts;
    return this.#exclusive(intent.network, f.tradeId, async () => {
      const r = await this.#recheck(intent);
      if ('done' in r) return r.done;
      const cfg = this.#escrow(f.escrow);
      const sent = await this.#sendPha(intent, 'refundPha', cfg, refundCall(cfg, f.h), f.h);
      return this.#phaOutcome(intent, sent);
    });
  }

  #escrow(name: string): P2PNetConfig {
    const c = escrowCfg(this.#cfg, name);
    if (!c) throw new SignRefusal('ESCROW_NOT_SERVED', `The Phantasma contract ${name} is not one this kit release serves. Nothing was sent.`, { check: 5 });
    return c;
  }

  async #phaOutcome(intent: Checked<SignKind>, sent: { hash: string | null; state: string; reason: string }): Promise<SendResult> {
    if (!sent.hash) return this.#result(intent, sent.state === 'Unknown' ? 'pending' : 'failed', null, { reason: sent.reason });
    if (sent.state === 'Halt') return this.#result(intent, 'confirmed', sent.hash);
    if (sent.state === 'Pending') return this.#result(intent, 'pending', sent.hash);
    // Racing the keeper is expected: claimed or refunded by someone else, and the payee has it, counts as done.
    if (await this.#doneByOthers(intent)) return this.#result(intent, 'done_elsewhere', sent.hash, { reason: phaRefusalText(sent.reason) || sent.reason });
    return this.#result(intent, 'failed', sent.hash, { reason: phaRefusalText(sent.reason) || sent.reason });
  }

  /**
   * After a claim or refund that did not go through: whether the chain shows
   * the very step done by someone else (section 6.6: the payee has it). Read
   * from the chain, never from the error text; a failed read is "no".
   */
  async #doneByOthers(intent: Checked<SignKind>): Promise<boolean> {
    try {
      if (intent.kind === 'claimPha' || intent.kind === 'refundPha') {
        const f = intent.facts as FactsMap['claimPha'] | FactsMap['refundPha'];
        const l = await this.#phaReader.readLock(this.#escrow(f.escrow), f.h);
        return l.state === (intent.kind === 'claimPha' ? 2 : 3);
      }
      if (intent.kind === 'claimBase' || intent.kind === 'refundBase') {
        const f = intent.facts as FactsMap['claimBase'] | FactsMap['refundBase'];
        const s = await this.#baseReader.readSwap(f.h, f.sender);
        return s.swap.state === (intent.kind === 'claimBase' ? 2 : 3);
      }
    } catch { /* not known: not done */ }
    return false;
  }

  // ── Base ──────────────────────────────────────────────────────────────────

  /**
   * Sign and send one prepared Base transaction (checks 51 and 66): the
   * journal intent first; the signed transaction must be exactly the one
   * prepared and still sendable, and its exact call is simulated once more;
   * then the broadcast, the hash recorded, and the receipt.
   *
   * With `resend`, the transaction goes at the nonce of an open journal
   * intent whose own transaction is not mined: a replacement of its step
   * with higher fees, or a cancel (a 0-value transfer that takes the nonce
   * back). No new intent is made; the hash joins the intent's, and a resend
   * that does not go out leaves the intent open (its first transaction still
   * waits).
   */
  async #sendBase(intent: Checked<SignKind>, journalKind: IntentKind, p: PreparedTx, h?: string, resend?: { journalId: string; cancel?: boolean }): Promise<{ hash: string; status: 'success' | 'reverted' | 'timeout' }> {
    const tradeId = intent.tradeId;
    const j = resend ? { id: resend.journalId } : await this.#store.addIntent(tradeId, { kind: journalKind, nonce: p.nonce, ...(h ? { h } : {}) });
    const what = resend?.cancel ? `cancel of the ${journalKind}` : resend ? `replacement of the ${journalKind}` : journalKind;
    const notSent = async (code: string, text: string, retry: boolean): Promise<never> => {
      if (!resend) {
        this.#nonces.release(p.from, p.nonce);
        await this.#store.resolveIntent(tradeId, j.id, 'not_sent', text);
      }
      throw new SignRefusal(code, text, { check: code === 'NOT_SENDABLE' ? 51 : 66, retry });
    };
    const raw = await this.#keys.base.signTransaction(serializable(p));
    const hash = await signedMatches(raw, p);
    if (!hash) return notSent('NOT_SENDABLE', 'The signed transaction is not the one prepared, so nothing was sent.', false);
    const why = await notSendable(this.#base, p, { replacing: !!resend });
    if (why) {
      // The node's count and this process's disagree: the next send reads the node's count again.
      if (!resend) this.#nonces.resync(p.from);
      return notSent('NOT_SENDABLE', why, true);
    }
    try {
      await this.#base.call({ from: p.from, to: p.to, data: p.data, gas: p.gas });
    } catch (e) {
      return notSent('NOT_SENDABLE', `Base would refuse the signed ${what} now (${baseErrorText(e)}), so nothing was sent.`, true);
    }
    // The hash is known before the broadcast: the trade keeps it first, so a send whose answer is lost but that
    // lands later is still recognised as this kit's own (check 42 then reports it instead of refusing it).
    if (!resend?.cancel) await this.#store.patchTrade(tradeId, { txs: { [txKey(journalKind)]: hash } as Partial<TradeTxs> });
    let delivery: 'sent' | 'unknown';
    try {
      delivery = await broadcast(this.#base, raw as Hex, hash);
    } catch (e) {
      // The node refused it: surely not sent.
      if (!resend) this.#nonces.resync(p.from);
      return notSent('NOT_SENDABLE', `Base did not take the ${what} (${baseErrorText(e)}). Nothing was sent.`, true);
    }
    // An answer that was lost is not "not sent" (section 6.5, never a blind resend): the hash and the nonce are
    // kept, the receipt is awaited, and an outcome still unknown leaves the intent open for run() to resolve.
    const fees = { maxFee: p.maxFeePerGas, maxPrio: p.maxPriorityFeePerGas };
    if (resend) await this.#store.recordResend(tradeId, j.id, { txHash: hash, nonce: p.nonce, ...fees, ...(resend.cancel ? { cancel: true } : {}) });
    else await this.#store.recordSent(tradeId, j.id, { txHash: hash, nonce: p.nonce, ...fees });
    this.#log(delivery === 'sent'
      ? `[signer] ${this.network} #${tradeId}: ${what} sent at nonce ${p.nonce} (${shortHex(hash)})`
      : `[signer] ${this.network} #${tradeId}: the ${what} send (${shortHex(hash)}) got no answer; it may still land (journal ${j.id} stays open until it is seen)`);
    const mined = await waitMined(this.#base, hash, { timeoutMs: this.#wait.baseTimeoutMs, pollMs: this.#wait.basePollMs, sleep: this.#sleep });
    if (resend?.cancel) {
      // The nonce is used by the 0-value transfer: the step's own transaction can no longer be mined.
      if (mined.status !== 'timeout') await this.#store.resolveIntent(tradeId, j.id, 'not_sent', `its nonce was taken back by a 0-value transfer (${shortHex(hash)}); the ${journalKind} was not mined`);
    } else if (mined.status === 'success') await this.#store.resolveIntent(tradeId, j.id, 'confirmed');
    else if (mined.status === 'reverted') await this.#store.resolveIntent(tradeId, j.id, 'failed', 'reverted on Base');
    return { hash, status: mined.status };
  }

  /** Prepare a Base call from this signer's address (check 66), refusing in the kit's words; with `replace`, at that nonce. */
  async #prepare(call: BaseCall, gas: 'escrow' | 'plain' | bigint, replace?: ReplaceAt): Promise<PreparedTx> {
    try {
      return await prepareTx(this.#base, this.#cfg, this.address.base, call, { gas, nonces: this.#nonces, ...(replace ? { replace } : {}) });
    } catch (e) {
      if (e instanceof SafetyError) throw new SignRefusal(e.code, e.detail, { check: 66, retry: e.code !== 'SIMULATION' });
      throw new SignRefusal('SIMULATION', `Base could not be read to prepare this ${call.fn} (${baseErrorText(e)}). Nothing was sent.`, { check: 66, retry: true });
    }
  }

  /**
   * One send per step in flight (checks 51 and 61): while the journal holds
   * an open send of `kind` for this trade, a fresh one is refused (it would
   * wait behind that one's nonce); a step that follows it goes at that very
   * nonce, with fees that outbid the newest transaction there. Answers where
   * to send: nowhere special (a fresh send), or the open intent's nonce.
   */
  async #sendsAt(tradeId: number, kind: FollowedKind, follow: FollowFacts | undefined): Promise<{ journalId: string; replace: ReplaceAt } | null> {
    const open = (await this.#store.getJournal(tradeId)).intents.filter((i) => i.kind === kind && i.outcome === undefined);
    const what = kind === 'claimBase' ? 'USDC claim' : kind === 'refundBase' ? 'USDC refund' : 'payout withdrawal';
    if (!follow) {
      const o = open[0];
      if (!o) return null;
      throw new SignRefusal(kind === 'claimBase' ? 'CLAIM_IN_FLIGHT' : 'SEND_IN_FLIGHT',
        `A ${what} of this trade went out${o.nonce !== undefined ? ` at nonce ${o.nonce}` : ''} and is not settled yet; a new one is never sent behind it. Nothing else was sent.`,
        { check: kind === 'claimBase' ? 61 : 51, retry: true, ...(o.txHash ? { txHash: o.txHash } : {}) });
    }
    const i = open.find((x) => x.id === follow.journalId);
    if (!i || i.nonce === undefined || i.nonce !== follow.nonce || !(i.hashes?.length || i.txHash)) {
      throw new SignRefusal('NOT_SENDABLE', `The ${what} this would replace is no longer open in the journal. Nothing was sent.`, { check: 51, retry: true });
    }
    const fee = (v: string | undefined) => (v !== undefined && /^\d{1,40}$/.test(v) ? BigInt(v) : 0n);
    return { journalId: i.id, replace: { nonce: i.nonce, outbid: { maxFeePerGas: fee(i.maxFee), maxPriorityFeePerGas: fee(i.maxPrio) } } };
  }

  async #baseOutcome(intent: Checked<SignKind>, s: { hash: string; status: 'success' | 'reverted' | 'timeout' }, extra: Partial<SendResult> = {}): Promise<SendResult> {
    if (s.status === 'success') return this.#result(intent, 'confirmed', s.hash, extra);
    if (s.status === 'reverted' && await this.#doneByOthers(intent)) return this.#result(intent, 'done_elsewhere', s.hash, { reason: 'Someone else sent this step first; the payee has it.', ...extra });
    if (s.status === 'reverted') return this.#result(intent, 'failed', s.hash, { reason: 'The transaction reverted on Base.', ...extra });
    return this.#result(intent, 'pending', s.hash, { reason: 'Base has not shown it mined yet; it may still go through.', ...extra });
  }

  /**
   * The buyer's USDC lock (checks 46, 49, 50, 51, 66): the re-check first;
   * with a permit, the EIP-2612 permit for exactly the amount (30 minutes,
   * the pinned domain) and lockWithPermit with the pinned gas; without one,
   * an approval of exactly the amount when the allowance is short, mined and
   * visible, then the re-check again; the lock with maxFeeBps = the trade's
   * fee and exactly the stored T2. The re-check runs once more right before
   * the lock is signed.
   */
  async lockBase(intent: Checked<'baseLock'>): Promise<SendResult> {
    this.#take(intent, 'baseLock');
    const f = intent.facts;
    return this.#exclusive(intent.network, f.tradeId, async () => {
      const cfg = this.#cfg;
      if (f.owner !== this.address.base) throw new SignRefusal('BASE_KEY', `This lock must be signed by ${f.owner}.`, { check: 41 });
      if (f.escrow !== cfg.phaContract) throw new SignRefusal('ESCROW_MISMATCH', 'The USDC is locked only behind a lock on the network\'s current escrow. Nothing was locked.', { check: 37 });
      const r1 = await this.#recheck(intent);
      if ('done' in r1) return r1.done;
      let approveTx: string | undefined;
      let call: BaseCall;
      let gas: 'plain' | bigint;
      if (f.usePermit) {
        // Check 46: the pinned domain (read again), the permit nonce, 30 minutes from the later of this clock and Base's newest block.
        let domainOk: boolean, nonce: bigint, head: { time: number };
        try {
          [domainOk, nonce, head] = await Promise.all([this.#baseReader.permitDomainOk(), this.#baseReader.permitNonce(f.owner), this.#baseReader.head()]);
        } catch (e) {
          throw new SignRefusal('PERMIT', `Could not read the USDC permit details on Base (${baseErrorText(e)}). Nothing was locked.`, { check: 46, retry: true });
        }
        if (!domainOk) throw new SignRefusal('PERMIT', 'The USDC token on Base does not match the permit details pinned in this kit. Nothing was signed.', { check: 46 });
        const local = Math.floor(this.#now() / 1000);
        const permitDeadline = Math.max(local, head.time) + PERMIT_SECONDS;
        if (permitDeadline > local + PERMIT_MAX_SECONDS - 60) throw new SignRefusal('PERMIT', 'This machine\'s clock is far behind Base\'s newest block. Fix the clock. Nothing was signed.', { check: 46 });
        const sig = await this.#keys.base.signTypedData(permitTypedData(cfg, f.owner, f.amount, nonce, permitDeadline));
        const { r, s, v, yParity } = parseSignature(sig);
        const vNum = v != null ? Number(v) : 27 + (yParity ?? 0);
        call = lockWithPermitCall(cfg, { h: f.h, amount: f.amount, claimer: f.claimer, deadline: f.t2, maxFeeBps: f.fee, permitDeadline, v: vNum, r, s });
        gas = cfg.base.lockWithPermitGas;
      } else {
        // Check 49: approve exactly the amount, never more, and only when the allowance is short.
        let allowance: bigint;
        try { allowance = (await this.#baseReader.readFunds(f.owner)).allowance; } catch (e) {
          throw new SignRefusal('APPROVE', `Could not read the USDC allowance on Base (${baseErrorText(e)}). Nothing was locked.`, { check: 49, retry: true });
        }
        if (allowance < f.amount) {
          const pa = await this.#prepare(approveCall(cfg, f.amount), 'plain');
          const sent = await this.#sendBase(intent, 'approve', pa);
          if (sent.status !== 'success') {
            throw new SignRefusal('APPROVE', sent.status === 'reverted' ? 'The USDC approval reverted on Base. Nothing was locked.' : 'Base has not shown the USDC approval mined yet. Nothing was locked; try again shortly.', { check: 49, retry: true });
          }
          approveTx = sent.hash;
          let seen = false;
          for (let i = 0; i < (this.#wait.allowanceTries ?? 20) && !seen; i++) {
            try { seen = (await this.#baseReader.readFunds(f.owner)).allowance >= f.amount; } catch { /* read again */ }
            if (!seen) await this.#sleep(this.#wait.allowancePollMs ?? 1_500);
          }
          if (!seen) throw new SignRefusal('APPROVE', 'Base has not shown the USDC approval yet. Nothing was locked; the next try does not approve again.', { check: 49, retry: true });
          // Time passed while the approval was mined: the re-check again before the lock.
          const r2 = await this.#recheck(intent);
          if ('done' in r2) return r2.done;
        }
        call = lockCallBase(cfg, { h: f.h, amount: f.amount, claimer: f.claimer, deadline: f.t2, maxFeeBps: f.fee });
        gas = 'plain';
      }
      const p = await this.#prepare(call, gas);
      // Check 66: the guard runs a second time, right before the lock is signed.
      const r3 = await this.#recheckPrepared(intent, p);
      if ('done' in r3) return r3.done;
      const sent = await this.#sendBase(intent, 'baseLock', p, f.h);
      return this.#baseOutcome(intent, sent, approveTx ? { approveTx } : {});
    });
  }

  /**
   * The seller's own USDC claim (check 61): never from a smart-contract
   * account; the re-check (state, the same deadline, CLAIM_MARGIN left)
   * before the simulation, which carries the secret, and again before
   * signing; gas twice the estimate and at least 150,000; one claim per h in
   * flight. The secret is read from the store and must still open h, and
   * secretSentAt is stored before the simulation sends it out (check 58).
   * While a claim of this trade is not mined, a claim goes only as its
   * replacement (`facts.follow`): at its nonce, with fees 25% higher.
   */
  async claimBase(intent: Checked<'claimBase'>): Promise<SendResult> {
    this.#take(intent, 'claimBase');
    const f = intent.facts;
    if (CLAIMING.has(f.h)) throw new SignRefusal('CLAIM_IN_FLIGHT', 'A claim with this secret is already in flight. Nothing else was sent.', { check: 61, retry: true });
    CLAIMING.add(f.h);
    try {
      return await this.#exclusive(intent.network, f.tradeId, async () => {
        const at = await this.#sendsAt(f.tradeId, 'claimBase', f.follow);
        let contract: boolean;
        try { contract = await this.#baseReader.isContractAccount(this.address.base); } catch {
          throw new SignRefusal('CLAIM_RECHECK', 'Could not read this kit\'s Base account. Nothing was sent.', { check: 61, retry: true });
        }
        if (contract) throw new SignRefusal('CONTRACT_ACCOUNT', 'This kit\'s Base address is a smart-contract account, which may publish the secret without sending the claim. Nothing was sent.', { check: 61 });
        const r1 = await this.#recheck(intent);
        if ('done' in r1) return r1.done;
        const sec = await this.#store.getSecret(f.h).catch(() => null);
        if (!sec || !secretOpens(sec.secret, f.h) || sec.tradeId !== f.tradeId) throw new SignRefusal('SECRET_NOT_THIS_TRADE', 'The secret for this claim is not kept for this trade. Nothing was sent.', { check: '59a' });
        // Check 58 for the kit's own claim: from the simulation on, the secret is out of this machine. Every later
        // claim runs only the claim's own checks (59, 61), which allow it down to CLAIM_MARGIN before the deadline.
        try {
          const back = await this.#store.patchTrade(f.tradeId, { secretSentAt: this.#now() });
          if (back.secretSentAt == null) throw new Error('not kept');
        } catch (e) {
          throw new SignRefusal('SECRET_SENT', `The kit could not store that the secret is being sent (${errorText(e)}), so it was not sent.`, { check: 58 });
        }
        const p = await this.#prepare(claimCallBase(this.#cfg, sec.secret, f.sender), 'escrow', at?.replace);
        const r2 = await this.#recheckPrepared(intent, p, !!at);
        if ('done' in r2) return r2.done;
        const sent = await this.#sendBase(intent, 'claimBase', p, f.h, at ? { journalId: at.journalId } : undefined);
        return this.#baseOutcome(intent, sent);
      });
    } finally {
      CLAIMING.delete(f.h);
    }
  }

  /** The buyer's Base refund (check 63): refund(h, B_b), escrow gas; a refund not mined is followed at its nonce, like a claim. */
  async refundBase(intent: Checked<'refundBase'>): Promise<SendResult> {
    this.#take(intent, 'refundBase');
    const f = intent.facts;
    return this.#exclusive(intent.network, f.tradeId, async () => {
      const at = await this.#sendsAt(f.tradeId, 'refundBase', f.follow);
      const r1 = await this.#recheck(intent);
      if ('done' in r1) return r1.done;
      const p = await this.#prepare(refundCallBase(this.#cfg, f.h, f.sender), 'escrow', at?.replace);
      const r2 = await this.#recheckPrepared(intent, p, !!at);
      if ('done' in r2) return r2.done;
      return this.#baseOutcome(intent, await this.#sendBase(intent, 'refundBase', p, f.h, at ? { journalId: at.journalId } : undefined));
    });
  }

  /** withdrawOwed(USDC, S_b) for a deferred payout (check 65), escrow gas; one not mined is followed at its nonce. */
  async withdrawOwed(intent: Checked<'withdrawOwed'>): Promise<SendResult> {
    this.#take(intent, 'withdrawOwed');
    const f = intent.facts;
    return this.#exclusive(intent.network, f.tradeId, async () => {
      const at = await this.#sendsAt(f.tradeId, 'withdrawOwed', f.follow);
      const r1 = await this.#recheck(intent);
      if ('done' in r1) return r1.done;
      const p = await this.#prepare(withdrawOwedCall(this.#cfg, f.claimer), 'escrow', at?.replace);
      const r2 = await this.#recheckPrepared(intent, p, !!at);
      if ('done' in r2) return r2.done;
      return this.#baseOutcome(intent, await this.#sendBase(intent, 'withdrawOwed', p, undefined, at ? { journalId: at.journalId } : undefined));
    });
  }

  /**
   * Take back the nonce of one of this trade's Base sends that is not mined
   * and may no longer go through (a claim too close to its deadline, which
   * mined late would publish the secret in a failed transaction, or a step
   * the chain shows done or no longer due): a 0-value transfer to the kit's
   * own address at that nonce, with fees 25% above the newest transaction
   * there, so only one of them is ever mined. Sent again, higher, while none
   * is mined. Recorded on the same journal intent.
   */
  async cancelBase(intent: Checked<'cancelBase'>): Promise<SendResult> {
    this.#take(intent, 'cancelBase');
    const f = intent.facts;
    return this.#exclusive(intent.network, f.tradeId, async () => {
      const at = await this.#sendsAt(f.tradeId, f.of, { journalId: f.journalId, nonce: f.nonce });
      const r1 = await this.#recheck(intent);
      if ('done' in r1) return r1.done;
      const p = await this.#prepare(cancelCall(this.address.base), CANCEL_GAS, at!.replace);
      const r2 = await this.#recheckPrepared(intent, p, true);
      if ('done' in r2) return r2.done;
      const sent = await this.#sendBase(intent, f.of, p, undefined, { journalId: at!.journalId, cancel: true });
      if (sent.status === 'timeout') return this.#result(intent, 'pending', sent.hash, { reason: 'Base has not shown the cancel mined yet; whichever of the transactions at this nonce is mined settles it.' });
      return this.#result(intent, 'confirmed', sent.hash, { reason: `The ${f.of} was taken back at its nonce.` });
    });
  }

  // ── The reveal ────────────────────────────────────────────────────────────

  /**
   * Share the secret with the board's keeper (claimMode 'reveal-then-self'):
   * secretSentAt is stored, fsynced and read back before the POST (check 58),
   * because from the moment the POST leaves the keeper may hold the secret
   * whatever it answers. `post` is the board call (BoardClient.reveal). A
   * board error is thrown after secretSentAt is kept; revealedAt is stored
   * once the board took it.
   */
  async reveal(intent: Checked<'reveal'>, post: (tradeId: number, secret: string) => Promise<void>): Promise<SendResult> {
    this.#take(intent, 'reveal');
    const f = intent.facts;
    return this.#exclusive(intent.network, f.tradeId, async () => {
      const r = await this.#recheck(intent);
      if ('done' in r) return r.done;
      const sec = await this.#store.getSecret(f.h).catch(() => null);
      if (!sec || !secretOpens(sec.secret, f.h) || sec.tradeId !== f.tradeId) throw new SignRefusal('SECRET_BINDING', 'The secret for this trade is not kept. Nothing was shared.', { check: 53 });
      const at = this.#now();
      try {
        const back = await this.#store.patchTrade(f.tradeId, { secretSentAt: at });
        if (back.secretSentAt == null) throw new Error('not kept');
      } catch (e) {
        throw new SignRefusal('SECRET_SENT', `The kit could not store that the secret is being shared (${errorText(e)}), so it was not sent.`, { check: 58 });
      }
      await post(f.tradeId, sec.secret);
      await this.#store.patchTrade(f.tradeId, { revealedAt: this.#now() });
      this.#log(`[signer] ${this.network} #${f.tradeId}: the secret was shared with the board's keeper`);
      return this.#result(intent, 'confirmed', null);
    });
  }
}

/** The TradeTxs key a journal kind records its transaction under. */
function txKey(kind: IntentKind): keyof TradeTxs {
  return kind as keyof TradeTxs;
}

/**
 * The signer for one bot's keys. Refuses (NETWORK_OFF) a network this kit
 * release has no pins for, so nothing is ever signed on mainnet today.
 */
export function createSigner(d: SignerDeps): Signer {
  return new Signer(d);
}
