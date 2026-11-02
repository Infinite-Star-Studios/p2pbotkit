/**
 * The instant seller flow (build spec sections 3.10.2, 3.10.3 and 3.10.5):
 * the kit's own instant sell offers, where the buyer locks the USDC first.
 *
 * Who may run it: the maker of a sell offer posted with `mode: 'instant'`,
 * with an API key the owner flagged instant (Engine.postOffer checks /me
 * before it posts), on a network this kit release lists in
 * INSTANT_NETWORKS (devnet only). A taker of this kit never takes an
 * instant offer.
 *
 * The steps, one per call of step(), each only when it is due:
 *   requested    accept the take once its checks pass (signs nothing; the
 *                engine's accept, with the instant swap reads of check 17);
 *   accepted     wait: the buyer makes the secret and locks its USDC first;
 *   base_locked  instantSellerLock (step 2: the buyer's lock at the
 *                confirmed tag, t_B, the time rules, getState(h) == 0, the
 *                code pin, the cap, the funds), then the signer locks the
 *                tokens behind the buyer's h with T_P = now + I_PHA, then
 *                the lock is reported (POST /pha-locked) once it reads on
 *                chain as this trade's own;
 *   from the lock on, getState(h) is read at least every
 *                INSTANT_RULES.watchEvery seconds (10 s, under the spec's
 *                15 s) until the kit has claimed or T_P has passed:
 *                  - claimed (2): the buyer's code is public on Phantasma;
 *                    instantClaim, then the signer simulates and sends the
 *                    USDC claim while T_B - now >= 60 s. A claim on
 *                    Phantasma at T_P - 1 s still leads to it: I_SAFETY is
 *                    left on the USDC lock;
 *                  - still locked at T_P + 60 s: the tokens are refunded
 *                    (check 64, which never refunds once the USDC was
 *                    claimed).
 *                That cadence holds per trade: run() steps every instant
 *                trade on its own lane (Engine.#laneLoop), apart from the
 *                bot's other trades, and a step of the watch waits at most
 *                3 s for the board's trade and 5 s for the lock report.
 * The USDC is never claimed while the Phantasma lock still reads locked:
 * Phantasma first, always (section 3.10.4).
 *
 * Nothing here signs: checks.ts issues the intents and signer.ts signs
 * them, as for every standard step. The board's word never decides a lock:
 * its trade only says which step is due and is compared with the kit's own
 * record (check 14 and the mode); the buyer's lock, its time and the
 * Phantasma side are read from the chains.
 */
import { INSTANT_RULES, P2P_CONFIG } from '../pins.js';
import { BoardError } from '../errors.js';
import { errorText, shortHex, type LogFn } from '../redact.js';
import { TERMINAL, type BaseSwap } from '../rules.js';
import * as checks from '../checks.js';
import { SignRefusal, type Signer, type SendResult, type FollowedKind } from '../signer.js';
import type { PhaLockRead } from '../pha.js';
import type { BoardSession, CallOptions } from '../board.js';
import type { KitStore } from '../store.js';
import type { CheckDeps, Problem } from '../checks.js';
import type { Network, Trade, LocalTrade, LocalOffer, TradeStatus, Intent, Journal } from '../types.js';
import type { StepResult, StepAction, StepOutcome } from './maker.js';

/**
 * The lock report (POST /pha-locked): sent once, waiting at most 5 s for the board. It runs inside the watch, which
 * reads getState(h) every INSTANT_RULES.watchEvery; a report the board did not take is sent again by a later step.
 */
const REPORT_CALL: CallOptions = Object.freeze({ retries: 0, timeoutMs: 5_000 });
/** A read that failed, or a report the board did not take yet, is tried again this soon. */
const RETRY_MS = 10_000;
/** A lock report the board refused for good (not retryable) is sent again at most this often while the lock runs. */
const REPORT_REFUSED_MS = 60_000;

/** What the engine lends the instant flow: its records, chains, signer and the shapes of its step results. */
export interface InstantHost {
  readonly network: Network;
  readonly deps: CheckDeps;
  readonly store: KitStore;
  readonly session: BoardSession;
  readonly signer: Signer;
  /** Receives redacted lines only. */
  readonly log: LogFn;
  /** ms. */
  now(): number;
  result(rec: Pick<LocalTrade, 'id'>, status: TradeStatus | null, action: StepAction, outcome: StepOutcome, extra?: Partial<Omit<StepResult, 'tradeId' | 'action' | 'outcome' | 'status'>>): StepResult;
  refused(rec: Pick<LocalTrade, 'id'>, status: TradeStatus | null, action: StepAction, p: Problem, nextAt?: number): StepResult;
  fromSign(rec: Pick<LocalTrade, 'id'>, status: TradeStatus | null, action: StepAction, e: SignRefusal): StepResult;
  fromSend(rec: Pick<LocalTrade, 'id'>, status: TradeStatus | null, action: StepAction, out: SendResult): StepResult;
  finish(rec: LocalTrade, status: TradeStatus | null, why: string): Promise<StepResult>;
  keepStatus(rec: LocalTrade, t: Trade | null): Promise<LocalTrade>;
  /** The engine's accept step (check 16, check 17 with the instant swap reads, the policy). */
  accept(rec: LocalTrade, trade: Trade): Promise<StepResult>;
  waitBoard(rec: LocalTrade, trade: Trade, text: string): StepResult;
  /** A claim or withdrawal not mined, followed at its own nonce (an instant claim is re-checked with instantClaim). */
  followSend(rec: LocalTrade, status: TradeStatus | null, kind: FollowedKind, open: Intent): Promise<StepResult>;
  refundPha(rec: LocalTrade, status: TradeStatus | null): Promise<StepResult>;
  /** The USDC is claimed: withdraw a deferred payout, else finish. */
  sellerPaid(rec: LocalTrade, trade: Trade | null, status: TradeStatus | null, why: string): Promise<StepResult>;
  /** A refusal of the flows with its check (LOCK_NOT_OURS is check 35). */
  flowProblem(code: 'LOCK_NOT_OURS', text: string, retry?: boolean): Problem;
}

/** The open Base send of `kind` in a trade's journal (recorded with its nonce, outcome not known yet), or null. */
function openBaseSend(j: Journal, kind: FollowedKind): Intent | null {
  return j.intents.find((i) => i.kind === kind && i.outcome === undefined && i.nonce !== undefined) ?? null;
}

/** The seller's side of the kit's instant trades. The engine makes one and dispatches every instant trade to step(). */
export class InstantSeller {
  readonly #h: InstantHost;
  /**
   * When a lock report the board did not take may be sent again, per trade
   * (ms): the watch reads Phantasma every few seconds, the report follows the
   * board's own retry time (at most once a minute for a refusal for good).
   */
  readonly #reportAt = new Map<number, number>();

  constructor(host: InstantHost) {
    this.#h = host;
  }

  /**
   * One step of an instant trade the kit sells on its own instant offer.
   * `trade` is the board's trade when it was read and matched the record
   * (check 14 and the mode), `raw` the board's answer as read, `mismatch`
   * why it did not match. Steps on the chains (the claim, the refund) run
   * without the board.
   */
  async step(rec: LocalTrade, trade: Trade | null, raw: Trade | null, status: TradeStatus | null, mismatch: Problem | null, offer: LocalOffer | null): Promise<StepResult> {
    const H = this.#h;
    const ec = checks.escrowFor(H.network, rec.phaContract ?? null);
    if (!ec.ok) return H.refused(rec, status, 'none', ec.problem);
    const bPha = rec.counterPha || trade?.buyer.pha || '';
    // The kit records the buyer's h before it signs its lock (instantSellerLock): any lock of its own is under rec.h.
    let lock: PhaLockRead | null = null;
    if (rec.h) {
      try {
        lock = await H.deps.pha.readLock(ec.cfg, rec.h);
      } catch {
        return H.result(rec, status, 'none', 'waiting', { waitingFor: 'chain', text: 'Could not read Phantasma.', retry: true, nextAt: H.now() + RETRY_MS });
      }
    }
    if (rec.h && lock && checks.isOurLock(lock, rec, bPha)) return this.#afterLock(rec, trade, status, rec.h, lock);
    return this.#beforeLock(rec, trade, raw, status, mismatch, offer);
  }

  /** Nothing of the kit's is locked under the buyer's h yet. */
  async #beforeLock(rec: LocalTrade, trade: Trade | null, raw: Trade | null, status: TradeStatus | null, mismatch: Problem | null, offer: LocalOffer | null): Promise<StepResult> {
    const H = this.#h;
    const openLock = (await H.store.getJournal(rec.id)).intents.some((i) => i.kind === 'phaLock' && i.outcome === undefined);
    if (openLock) return H.result(rec, status, 'lockPha', 'pending', { text: 'A Phantasma lock of this trade went out and its outcome is not known yet.' });
    if (!trade) {
      if (mismatch) return H.refused(rec, status, 'none', mismatch);
      return H.result(rec, status, 'none', 'waiting', { waitingFor: 'board', text: raw ? 'The board\'s trade could not be used.' : 'The board could not be read.', retry: true });
    }
    switch (trade.status) {
      case 'requested':
        return H.accept(rec, trade);
      case 'accepted':
        return H.waitBoard(rec, trade, 'Waiting for the buyer to lock the USDC: in an instant trade the buyer locks first.');
      case 'base_locked':
        return this.#lock(rec, trade, offer);
      default:
        break;
    }
    if (TERMINAL.includes(trade.status) || trade.status === 'refunding') {
      return H.finish(rec, trade.status, `the trade ended (${trade.status}) before this kit locked anything`);
    }
    // The board is past the lock while this kit's lock does not show on Phantasma (a node behind, or a board that is wrong).
    return H.result(rec, status, 'none', 'waiting', {
      waitingFor: 'chain', retry: true, nextAt: H.now() + RETRY_MS,
      text: `The board shows this trade at ${trade.status}, but no lock of this kit's shows on Phantasma under its hash.`
    });
  }

  /** Step 2 of section 3.10.3: instantSellerLock, then the signer; then the report (check 35). */
  async #lock(rec: LocalTrade, trade: Trade, offer: LocalOffer | null): Promise<StepResult> {
    const H = this.#h;
    const r = await checks.instantSellerLock(H.deps, trade, rec, offer);
    if (!r.ok) {
      // This kit's own lock already exists under the buyer's h: only reported, never locked again.
      if (r.problem.code === 'LOCKED_ALREADY' && r.problem.h) return this.#reported(rec, trade, r.problem.h, null);
      return H.refused(rec, trade.status, 'lockPha', r.problem);
    }
    let out: SendResult;
    try {
      out = await H.signer.lockPha(r.intent);
    } catch (e) {
      if (e instanceof SignRefusal) {
        if (e.code === 'LOCKED_ALREADY' && e.h) return this.#reported(rec, trade, e.h, null);
        return H.fromSign(rec, trade.status, 'lockPha', e);
      }
      throw e;
    }
    if (out.outcome === 'confirmed') {
      H.log(`[kit] ${H.network}: instant trade #${rec.id}: ${rec.symbol} locked on Phantasma behind the buyer's USDC (${shortHex(out.txHash)})`);
      return this.#reported((await H.store.getTrade(rec.id)) ?? rec, trade, r.intent.facts.h, out.txHash);
    }
    return H.fromSend(rec, trade.status, 'lockPha', out);
  }

  /**
   * The report right after the lock (#report, which reads the lock first):
   * the watch starts with that read, so the next step is due at most
   * INSTANT_RULES.watchEvery after it, however long the board took.
   */
  async #reported(rec: LocalTrade, trade: Trade, h: string, txHash: string | null): Promise<StepResult> {
    const since = this.#h.now();
    return this.#watched(await this.#report(rec, trade, h, txHash), since);
  }

  /** From the lock on, the next step (which reads getState(h)) is never further than INSTANT_RULES.watchEvery after `since`. */
  #watched(r: StepResult, since: number): StepResult {
    const watchAt = since + INSTANT_RULES.watchEvery * 1000;
    return r.nextAt > watchAt ? { ...r, nextAt: watchAt } : r;
  }

  /**
   * Check 35 for an instant trade: read the lock under h; only when it is
   * this trade's own lock are its end (T_P) recorded and the lock reported
   * (POST /pha-locked), while the board's trade was read, matched the record
   * and waits for it (base_locked).
   */
  async #report(rec: LocalTrade, trade: Trade | null, h: string, txHash: string | null): Promise<StepResult> {
    const H = this.#h;
    const status = trade?.status ?? rec.status ?? null;
    const ec = checks.escrowFor(H.network, rec.phaContract ?? null);
    if (!ec.ok) return H.refused(rec, status, 'reportPhaLock', ec.problem);
    const bPha = rec.counterPha || trade?.buyer.pha || '';
    let lock: PhaLockRead;
    try {
      lock = await H.deps.pha.readLock(ec.cfg, h);
    } catch {
      return H.result(rec, status, 'reportPhaLock', 'waiting', { waitingFor: 'chain', text: 'Could not read the lock on Phantasma.', retry: true, nextAt: H.now() + RETRY_MS });
    }
    if (!checks.isOurLock(lock, rec, bPha)) {
      return H.refused(rec, status, 'reportPhaLock', H.flowProblem('LOCK_NOT_OURS', lock.state === 0
        ? 'Phantasma does not show this trade\'s lock yet, so it is not reported.'
        : 'The lock under the buyer\'s hash is not this trade\'s own lock (sender, buyer, token or amount differ), so it is not reported.', lock.state === 0));
    }
    // Recorded before the report: the claim and the refund never need the board.
    rec = await H.store.patchTrade(rec.id, { h, phaContract: ec.cfg.phaContract, t1: lock.deadline });
    if (!trade) {
      return H.result(rec, status, 'reportPhaLock', 'waiting', {
        waitingFor: 'board', retry: true, nextAt: H.now() + RETRY_MS,
        text: 'The lock is recorded; it is reported once the board\'s trade can be read and matches what this kit agreed to.'
      });
    }
    if (trade.status !== 'base_locked') return H.result(rec, status, 'reportPhaLock', 'done', { text: 'The lock is recorded.' });
    const tx = txHash ?? rec.txs.phaLock ?? undefined;
    try {
      const t = await H.session.phaLocked(rec.id, { h, ...(tx ? { txHash: tx.replace(/^0x/i, '') } : {}) }, REPORT_CALL);
      this.#reportAt.delete(rec.id);
      await H.keepStatus(rec, t);
      H.log(`[kit] ${H.network}: instant trade #${rec.id}: the Phantasma lock ${shortHex(h)} was reported`);
      return H.result(rec, t.status, 'reportPhaLock', 'done', { txHash: tx ?? null });
    } catch (e) {
      // The lock stands whatever the board answers: the watch, the claim and the refund go on without it. A refusal
      // for good (the board found the lock out of the instant time rules, say) is not sent again every few seconds.
      const be = e instanceof BoardError ? e : null;
      const wait = be?.retryAfter ? Math.min(be.retryAfter, 60) * 1000 : be && !be.retryable ? REPORT_REFUSED_MS : RETRY_MS;
      const nextAt = H.now() + wait;
      this.#reportAt.set(rec.id, nextAt);
      H.log(`[kit] ${H.network}: instant trade #${rec.id}: the board did not take the lock report (${errorText(e)}); it is sent again in ${Math.round(wait / 1000)} s`);
      return H.result(rec, status, 'reportPhaLock', 'failed', { code: be?.code ?? 'BOARD', text: errorText(e), retry: true, nextAt });
    }
  }

  /**
   * The kit's lock is under h: report it while the board waits for it, then
   * watch getState(h) at least every INSTANT_RULES.watchEvery seconds until
   * the kit has claimed the USDC or T_P has passed.
   */
  async #afterLock(recIn: LocalTrade, trade: Trade | null, status: TradeStatus | null, h: string, lock: PhaLockRead): Promise<StepResult> {
    const H = this.#h;
    let rec = recIn;
    if (rec.t1 === undefined) rec = await H.store.patchTrade(rec.id, { t1: lock.deadline });
    const sym = rec.symbol;
    const now = H.now();
    const watchAt = now + INSTANT_RULES.watchEvery * 1000;
    // A report the board does not take yet never holds up a claim or a refund.
    let reported: StepResult | null = null;
    if (lock.state === 1 && trade && trade.status === 'base_locked') {
      const due = this.#reportAt.get(rec.id) ?? 0;
      if (now >= due) {
        const r = await this.#report(rec, trade, h, null);
        if (r.outcome === 'done') return { ...r, nextAt: Math.min(r.nextAt, watchAt) };
        reported = r;
        rec = (await H.store.getTrade(rec.id)) ?? rec;
      } else {
        reported = H.result(rec, status, 'reportPhaLock', 'waiting', {
          waitingFor: 'board', retry: true, nextAt: due,
          text: 'The board did not take the lock report yet; it is sent again shortly. The lock is watched on Phantasma meanwhile.'
        });
      }
    }
    const bBase = rec.counterBase || trade?.buyer.base.toLowerCase() || '';
    let swap: BaseSwap;
    let paidConfirmed = false;
    try {
      const r = await H.deps.base.readSwapConfirmed(h, bBase);
      swap = r.latest;
      paidConfirmed = r.confirmed.state === 2;
    } catch {
      return H.result(rec, status, 'none', 'waiting', { waitingFor: 'chain', text: 'Could not read Base.', retry: true, nextAt: Math.min(H.now() + RETRY_MS, watchAt) });
    }
    const claimSeen = (why: string): Promise<StepResult> => (paidConfirmed
      ? H.sellerPaid(rec, trade, status, why)
      : Promise.resolve(H.result(rec, status, 'none', 'waiting', {
          waitingFor: 'chain', retry: true, nextAt: Math.min(H.now() + RETRY_MS, watchAt),
          text: 'The USDC claim shows on Base but not at the confirmed block yet; the trade is finished once it is confirmed.'
        })));
    if (lock.state === 1) {
      if (swap.state === 2) return claimSeen('the USDC was claimed');
      // T_P has passed (plus the keeper's grace) with the lock unclaimed: the buyer can no longer claim; the tokens come back.
      const refundAt = (lock.deadline + P2P_CONFIG[H.network].timing.phaRefundGrace) * 1000;
      if (H.now() >= refundAt) return H.refundPha(rec, status);
      if (reported) return { ...reported, nextAt: Math.min(reported.nextAt, watchAt, refundAt) };
      return H.result(rec, status, 'none', 'waiting', {
        waitingFor: 'chain', nextAt: Math.min(refundAt, watchAt),
        text: `Waiting for the buyer's code to open the ${sym} lock on Phantasma (then this kit claims the USDC), or for the lock's time limit (then the ${sym} comes back).`
      });
    }
    if (lock.state === 2) {
      // The buyer claimed the tokens on Phantasma: its code is public there, and the USDC is the kit's to claim.
      if (swap.state === 1) return this.#claim(rec, status, watchAt);
      if (swap.state === 2) return claimSeen('both sides claimed');
      return H.finish(rec, status, `the ${sym} was claimed and the USDC lock reads ${swap.state === 3 ? 'refunded' : 'empty'}; check this trade by hand`);
    }
    if (lock.state === 3) return H.finish(rec, status, `the ${sym} was refunded to this kit`);
    return H.result(rec, status, 'none', 'waiting', { waitingFor: 'chain', text: 'Phantasma does not show the lock yet.', retry: true, nextAt: Math.min(H.now() + RETRY_MS, watchAt) });
  }

  /** The USDC claim (section 3.10.3 step 4): one not mined is followed at its nonce; else instantClaim, then the signer. */
  async #claim(rec: LocalTrade, status: TradeStatus | null, watchAt: number): Promise<StepResult> {
    const H = this.#h;
    const open = openBaseSend(await H.store.getJournal(rec.id), 'claimBase');
    if (open) return H.followSend(rec, status, 'claimBase', open);
    const r = await checks.instantClaim(H.deps, rec);
    if (!r.ok) {
      if (r.problem.code === checks.DONE_ELSEWHERE) return H.result(rec, status, 'claimBase', 'done', { doneElsewhere: true, text: r.problem.text });
      return H.refused(rec, status, 'claimBase', r.problem, r.problem.retry ? Math.min(H.now() + RETRY_MS, watchAt) : undefined);
    }
    try {
      return H.fromSend(rec, status, 'claimBase', await H.signer.claimBase(r.intent));
    } catch (e) {
      if (e instanceof SignRefusal) return H.fromSign(rec, status, 'claimBase', e);
      throw e;
    }
  }
}
