/**
 * The taker side of the kit (build spec sections 4.6.1, 6.3 and 6.4): take
 * one offer, or fill an order across the best offers with buyUpTo and
 * sellDownTo, by the planner rules of the site's fill.js.
 *
 *   - Before any take: check 1 (the token of the kit's own table), 2 and 6
 *     (pinned), 10 (the take fits the offer and the bounds), 11 (open-cap
 *     room; a failed read does not block here) and 12 (the buyer's USDC
 *     covers this order plus every open trade still waiting for its USDC
 *     lock, and ETH for each lock), or for a seller its tokens with the KCAL
 *     or SOUL reserve.
 *   - Every take sends the offer's price as the kit read it (section 2.3.3),
 *     and the trade record keeps that price: LocalTrade.price is the price
 *     sent. PRICE_CHANGED is never sent again: take() re-reads the offer and
 *     returns the refusal; buyUpTo/sellDownTo plan again without that offer.
 *   - The control token is kept before the POST (BoardSession); a take whose
 *     answer was lost is counted as possibly made until the board is asked
 *     about it, so a later leg never overspends.
 *   - buyUpTo never takes an offer above `maxPrice`, sellDownTo never one
 *     below `minPrice`; a trade the board answers past the limit is blocked
 *     in the engine and never locked (SafetyError / StepResult PRICE_LIMIT,
 *     check 14), as is any trade whose board price is not the price sent.
 *
 * Taking signs nothing. The locks come later, from run() or step(), each
 * after its own checks.
 */
import { P2P_CONFIG, USDC_DECIMALS, SOUL_RESERVE, tokenOf, type P2PToken } from '../pins.js';
import { SafetyError, BoardError } from '../errors.js';
import { redactedLog, errorText, type LogFn } from '../redact.js';
import { amountText, evmLower, feeOf, posInt, usdcFor, type UsdcBounds } from '../rules.js';
import * as checks from '../checks.js';
import { CreateError, type BoardSession } from '../board.js';
import { balanceOf } from '../pha.js';
import { Engine, flowError, problemError, toRaw, usdcToRaw } from './maker.js';
import type { Network, Offer, Side, LocalTrade } from '../types.js';

/** Legs one pass of an order takes at most (the site's MAX_LEGS). */
export const MAX_LEGS = 5;
/** Takes one order tries at most, re-plans included (the site's MAX_TAKES). */
export const MAX_TAKES = 8;

/** One leg of a plan: raw units. */
export interface FillLeg {
  offerId: number;
  makerPha: string;
  makerBase: string;
  /** Raw USDC per whole token. */
  price: bigint;
  /** Raw units of the token. */
  taz: bigint;
  /** Raw USDC, rounded down. */
  usdc: bigint;
}

export interface FillPlan {
  legs: FillLeg[];
  /** Raw token the legs take. */
  filled: bigint;
  /** Raw token that cannot fill at this limit. */
  left: bigint;
  /** Σ usdc of the legs. */
  usdcTotal: bigint;
  /** Σ of each leg's usdc × feeBps / 10^4, each rounded down. */
  feeUsdc: bigint;
}

const rawOf = (v: unknown): bigint | null => posInt(v);

/**
 * Split an order across the best live offers (build spec section 4.6.1, the
 * site's fill.js planFill in 'amount' mode). Buying takes sell offers at or
 * under `limit`, cheapest first; selling takes buy offers at or over it,
 * best paid first; the older offer (lower id) first at one price. Left out:
 * another token, offline or closed offers, offers that follow the reference
 * price while the board lists them as paused (`follow.state` 'paused': a take
 * gets 409 FOLLOW_PAUSED; build spec section 11.y), the bot's own (by
 * address, or an id in `own`), ids in `exclude`, and offers priced above the
 * token's table.
 * Per offer: avail = min(tazMax, remaining), skipped under tazMin; take =
 * min(avail, left, token.max), skipped under max(tazMin, token.min); its USDC
 * skipped under bounds.usdcMin; over bounds.usdcMax the take shrinks to what
 * usdcMax buys there and is checked against the minimums again. Stops when
 * nothing is left or at `maxLegs` legs.
 */
export function planFill(p: {
  side: 'buy' | 'sell'; symbol: string; amount: bigint; limit: bigint; offers: readonly Offer[];
  me: { pha: string; base: string }; bounds: UsdcBounds; feeBps?: number; exclude?: ReadonlySet<number>; own?: ReadonlySet<number>; maxLegs?: number;
}): FillPlan {
  const out: FillPlan = { legs: [], filled: 0n, left: p.amount > 0n ? p.amount : 0n, usdcTotal: 0n, feeUsdc: 0n };
  const tok = tokenOf(p.symbol);
  if (!tok || !tok.enabled || p.amount <= 0n || p.limit <= 0n) return out;
  const unit = 10n ** BigInt(tok.decimals);
  const maxLegs = typeof p.maxLegs === 'number' && Number.isSafeInteger(p.maxLegs) && p.maxLegs >= 0 ? p.maxLegs : MAX_LEGS;
  const want: Side = p.side === 'buy' ? 'sell' : 'buy';
  const fee = typeof p.feeBps === 'number' && Number.isInteger(p.feeBps) && p.feeBps >= 0 ? p.feeBps : 0;
  const mine = (o: Offer) => o.makerPha === p.me.pha || evmLower(o.makerBase) === evmLower(p.me.base) || !!p.own?.has(o.id);
  const list = p.offers
    .map((o) => ({ o, price: rawOf(o.price), min: rawOf(o.tazMin), max: rawOf(o.tazMax), rem: rawOf(o.remaining) }))
    .filter((x): x is { o: Offer; price: bigint; min: bigint; max: bigint; rem: bigint } =>
      x.price != null && x.min != null && x.max != null && x.rem != null && x.o.symbol === tok.symbol && x.o.side === want
      && x.o.online === true && x.o.status === 'open' && x.o.follow?.state !== 'paused' && x.price <= tok.priceMax && (x.o.mode ?? 'standard') === 'standard')
    .filter((x) => (p.side === 'buy' ? x.price <= p.limit : x.price >= p.limit))
    .filter((x) => !mine(x.o) && !p.exclude?.has(x.o.id))
    .sort((a, b) => (p.side === 'buy' ? cmp(a.price, b.price) : cmp(b.price, a.price)) || a.o.id - b.o.id);
  let left = out.left;
  for (const x of list) {
    if (left <= 0n || out.legs.length >= maxLegs) break;
    const avail = x.max < x.rem ? x.max : x.rem;
    if (avail < x.min) continue;
    let take = minB(minB(avail, left), tok.max);
    const least = x.min > tok.min ? x.min : tok.min;
    if (take < least) continue;
    let usdc = (take * x.price) / unit;
    if (usdc < p.bounds.usdcMin) continue;
    if (p.bounds.usdcMax > 0n && usdc > p.bounds.usdcMax) {
      take = (p.bounds.usdcMax * unit) / x.price;
      usdc = (take * x.price) / unit;
      if (take < least || usdc < p.bounds.usdcMin) continue;
    }
    out.legs.push({ offerId: x.o.id, makerPha: x.o.makerPha, makerBase: x.o.makerBase, price: x.price, taz: take, usdc });
    out.filled += take;
    out.usdcTotal += usdc;
    out.feeUsdc += feeOf(usdc, fee);
    left -= take;
  }
  out.left = left > 0n ? left : 0n;
  return out;
}

const cmp = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
const minB = (a: bigint, b: bigint) => (a < b ? a : b);

/** Board codes after which an order skips that offer and plans again (the site's fill runner, section 4.6.3). */
const SKIP_CODES: ReadonlySet<string> = new Set(['OFFLINE', 'AMOUNT', 'BUSY', 'CLOSED', 'NOT_FOUND', 'PRICE_CHANGED', 'FOLLOW_PAUSED', 'TOKEN', 'STATE']);

export interface TakerOptions {
  network: Network;
  address: Readonly<{ pha: string; base: string }>;
  session: BoardSession;
  engine: Engine;
  deps: checks.CheckDeps;
  log?: LogFn;
}

/** take, buyUpTo and sellDownTo for one kit. createKit builds it. */
export class Taker {
  readonly network: Network;
  readonly #address: Readonly<{ pha: string; base: string }>;
  readonly #session: BoardSession;
  readonly #engine: Engine;
  readonly #deps: checks.CheckDeps;
  readonly #log: LogFn;

  constructor(o: TakerOptions) {
    this.network = o.network;
    this.#address = Object.freeze({ pha: o.address.pha, base: o.address.base.toLowerCase() });
    this.#session = o.session;
    this.#engine = o.engine;
    this.#deps = o.deps;
    this.#log = redactedLog(o.log);
  }

  /** The pins, the token (check 1) and Base deployed (checks 2, 6) before anything is read or sent. */
  #ready(symbol: unknown): Readonly<P2PToken> {
    const p1 = checks.checkToken(symbol);
    if (p1) throw problemError(p1);
    const p2 = checks.pinned(this.network) ?? checks.baseDeployedProblem(this.network);
    if (p2) throw problemError(p2);
    const p8 = checks.baseAddressOk(this.network, this.#address.base);
    if (p8) throw problemError(p8);
    return tokenOf(symbol)!;
  }

  /** Whether the bot made this offer (its record, or its own addresses). */
  async #own(o: Offer): Promise<boolean> {
    return o.makerPha === this.#address.pha || evmLower(o.makerBase) === this.#address.base || !!(await this.#session.store.getOffer(o.id));
  }

  /**
   * The seller's own funds for `amount` of `symbol` with the KCAL or SOUL
   * reserve (check 29's rule, before a take of a buy offer), on top of what
   * the kit's other trades as the seller still need (Engine.sellerCommitted).
   */
  async #sellerFunds(symbol: string, amount: bigint): Promise<SafetyError | null> {
    // On top of what the kit's other trades as the seller still need (accepted, or taken and waiting, and not locked
    // yet), read before the balance: a lock that lands in between is counted twice, never not at all.
    const committed = await this.#engine.sellerCommitted(symbol);
    let bal;
    try {
      bal = await this.#deps.pha.balances(this.#address.pha);
    } catch {
      return problemError(checks.problem('SELLER_FUNDS', 'Could not read this kit\'s Phantasma balances, so nothing was taken.', { retry: true }));
    }
    const soul = balanceOf(bal, 'SOUL');
    if (soul == null || soul < SOUL_RESERVE) return problemError(checks.problem('SOUL_LOW', `This kit's Phantasma address keeps less than ${amountText(SOUL_RESERVE, 8)} SOUL free for Phantasma's fees, so it could not lock what it sells. Nothing was taken.`));
    const why = checks.sellerFundsProblem(P2P_CONFIG[this.network], bal, symbol, amount + committed, 'This kit\'s Phantasma address');
    if (!why) return null;
    const t = tokenOf(symbol)!;
    const also = committed > 0n ? ` (${amountText(committed, t.decimals)} ${t.symbol} of it is for this kit's other trades that are not locked yet.)` : '';
    return problemError(checks.problem('SELLER_FUNDS', `${why}${also} Nothing was taken.`, { retry: true }));
  }

  /**
   * The bot's readiness for a take of `legs` (raw USDC each) or of `taz` raw
   * tokens as a seller; null when ready. `maybe` is what earlier takes of the
   * same order may have committed although their answer was lost (they are
   * not in the store until reconcilePending settles them): it counts as spent.
   */
  async #readiness(side: Side, symbol: string, taz: bigint, legs: readonly bigint[], maybe: { usdc: bigint; taz: bigint } = { usdc: 0n, taz: 0n }): Promise<SafetyError | null> {
    const cap = await checks.openCapRoom(this.#deps, symbol, taz);
    if (cap) return problemError(cap);
    if (side === 'sell') {
      // Taking a sell offer: the bot is the buyer (check 12, with the sum of its open trades).
      const ready = await checks.buyerReady(this.#deps, { bBase: this.#address.base, usdc: legs.reduce((a, b) => a + b, 0n), legs, extraUsdc: maybe.usdc });
      return ready ? problemError(ready) : null;
    }
    // Taking a buy offer: the bot is the seller.
    return this.#sellerFunds(symbol, taz + maybe.taz);
  }

  /**
   * Take one listed offer for `amount` whole tokens (decimal text). Checks 1,
   * 2, 6, 8, 10, 11 and 12 (or the seller's funds) run first; the take sends
   * the price the kit read, and the trade record keeps it (LocalTrade.price).
   * PRICE_CHANGED is not sent again: the offer is read again and the refusal
   * returned. A trade the board records differently from the take (check 14)
   * is kept but never signed for, and refused here (TRADE_MISMATCH).
   */
  async take(offerId: number, amount: string): Promise<LocalTrade> {
    if (typeof offerId !== 'number' || !Number.isSafeInteger(offerId) || offerId <= 0) throw flowError('BAD_INPUT', 'An offer id is a positive whole number.');
    const offers = await this.#session.board.offers({}, { maxRetryAfter: 10 });
    const offer = offers.find((o) => o.id === offerId);
    if (!offer) throw flowError('OFFER_NOT_LISTED', `Offer #${offerId} is not listed on the board now.`);
    const tok = this.#ready(offer.symbol);
    if (await this.#own(offer)) throw flowError('OWN_OFFER', `Offer #${offerId} is this kit's own.`);
    if ((offer.mode ?? 'standard') !== 'standard') {
      throw flowError('MODE_NOT_SUPPORTED', `Offer #${offerId} is an instant offer. This kit takes standard offers only: an instant offer's buyer locks first, which the site's P2P page does. The kit runs instant offers only as their seller. Nothing was sent.`);
    }
    const taz = toRaw(amount, tok.decimals, 'amount');
    const p10 = checks.takeCheck(this.network, taz, offer);
    if (p10) throw problemError(p10);
    const price = BigInt(offer.price);
    const ready = await this.#readiness(offer.side, tok.symbol, taz, [usdcFor(taz, price, tok.symbol)]);
    if (ready) throw ready;
    let t;
    try {
      t = await this.#session.take(offer, { taz: taz.toString(), takerPha: this.#address.pha, takerBase: this.#address.base, maxRetryAfter: 10 });
    } catch (e) {
      if (e instanceof CreateError && e.code === 'PRICE_CHANGED') {
        const now = (await this.#session.board.offers({ symbol: offer.symbol }, { maxRetryAfter: 10 }).catch(() => [] as Offer[])).find((o) => o.id === offerId);
        this.#log(`[kit] ${this.network}: offer #${offerId} changed its price from ${amountText(price, USDC_DECIMALS)}${now ? ` to ${amountText(BigInt(now.price), USDC_DECIMALS)}` : ''} USDC; nothing was taken`);
      }
      throw e;
    }
    this.#engine.wakeTrade(t.record.id);
    if (t.mismatch) {
      this.#engine.block(t.record.id, t.mismatch);
      throw problemError(checks.problem('TRADE_MISMATCH', `The board recorded trade #${t.record.id} differently from the take (${t.mismatch}). It is kept, but the kit never signs for it.`));
    }
    this.#log(`[kit] ${this.network}: took offer #${offerId}: trade #${t.record.id}, ${amountText(taz, tok.decimals)} ${tok.symbol} at ${amountText(price, USDC_DECIMALS)} USDC`);
    return t.record;
  }

  /** Buy up to `amount` whole tokens at `maxPrice` USDC per token or less (decimal text), across the best sell offers. */
  async buyUpTo(o: { symbol: string; amount: string; maxPrice: string; maxLegs?: number }): Promise<LocalTrade[]> {
    return this.#fill('buy', o.symbol, o.amount, o.maxPrice, o.maxLegs);
  }

  /** Sell up to `amount` whole tokens at `minPrice` USDC per token or more (decimal text), across the best buy offers. */
  async sellDownTo(o: { symbol: string; amount: string; minPrice: string; maxLegs?: number }): Promise<LocalTrade[]> {
    return this.#fill('sell', o.symbol, o.amount, o.minPrice, o.maxLegs);
  }

  /**
   * The order runner (section 4.6.3, for a bot): plan, check readiness for
   * the whole plan, take each leg (the price read, the token kept first),
   * skip an offer that refuses for its own reason and plan again without it,
   * stop on a refusal about the bot itself. At most MAX_TAKES takes, and
   * `maxLegs` (default 5) trades in all. Returns the trades within the limit;
   * throws when the very first step refuses (nothing taken).
   */
  async #fill(side: 'buy' | 'sell', symbol: string, amountIn: string, limitText: string, maxLegsIn?: number): Promise<LocalTrade[]> {
    const tok = this.#ready(symbol);
    const amount = toRaw(amountIn, tok.decimals, 'amount');
    const limit = usdcToRaw(limitText, side === 'buy' ? 'maxPrice' : 'minPrice');
    const maxLegs = maxLegsIn === undefined ? MAX_LEGS : maxLegsIn;
    if (typeof maxLegs !== 'number' || !Number.isSafeInteger(maxLegs) || maxLegs < 1 || maxLegs > MAX_TAKES) throw flowError('BAD_INPUT', `maxLegs is a whole number from 1 to ${MAX_TAKES}.`);
    const cfg = P2P_CONFIG[this.network];
    const bounds: UsdcBounds = { usdcMin: cfg.base.usdcMin, usdcMax: cfg.base.usdcMax };
    const taken: LocalTrade[] = [];
    const tried = new Set<number>();
    const own = new Set((await this.#session.store.listOffers()).map((x) => x.id));
    const priceText = (p: bigint) => `${amountText(p, USDC_DECIMALS)} USDC`;
    let left = amount;
    let tries = 0;
    let firstRefusal: Error | null = null;
    let pastLimit = 0;
    // Takes whose answer was lost: they may exist, so their USDC (or tokens) count as spent when the order plans again.
    const maybe = { usdc: 0n, taz: 0n };
    order: while (left > 0n && tries < MAX_TAKES && taken.length < maxLegs) {
      const offers = await this.#session.board.offers({ side: side === 'buy' ? 'sell' : 'buy', symbol: tok.symbol }, { maxRetryAfter: 10 });
      const plan = planFill({
        side, symbol: tok.symbol, amount: left, limit, offers, me: this.#address, bounds, exclude: tried, own,
        maxLegs: Math.min(maxLegs - taken.length, MAX_TAKES - tries)
      });
      if (plan.legs.length === 0) break;
      const ready = await this.#readiness(side === 'buy' ? 'sell' : 'buy', tok.symbol, plan.filled, plan.legs.map((l) => l.usdc), maybe);
      if (ready) {
        if (taken.length === 0 && pastLimit === 0) throw ready;
        this.#log(`[kit] ${this.network}: the order stops: ${ready.detail}`);
        break;
      }
      for (const leg of plan.legs) {
        const offer = offers.find((x) => x.id === leg.offerId)!;
        tried.add(leg.offerId);
        tries++;
        // The planner never picks a price past the limit; this guards the leg itself before anything is sent.
        if (side === 'buy' ? leg.price > limit : leg.price < limit) continue;
        const p10 = checks.takeCheck(this.network, leg.taz, offer);
        if (p10) continue;
        let t;
        try {
          t = await this.#session.take(offer, { taz: leg.taz.toString(), takerPha: this.#address.pha, takerBase: this.#address.base, maxRetryAfter: 10 });
        } catch (e) {
          if (e instanceof CreateError && e.mayExist) {
            // The take may exist: counted as made until the board is asked about it, so a later leg never overspends
            // (neither the order's amount nor, when the order plans again, the bot's USDC or tokens).
            left -= leg.taz;
            maybe.usdc += leg.usdc;
            maybe.taz += leg.taz;
            this.#log(`[kit] ${this.network}: the take of offer #${leg.offerId} got no clear answer (${e.code}); it counts as made until the board is asked again`);
            continue;
          }
          if (e instanceof BoardError && SKIP_CODES.has(e.code)) {
            this.#log(`[kit] ${this.network}: offer #${leg.offerId} skipped (${e.code})`);
            continue;
          }
          // About the bot itself (FUNDS, NO_SHOW_LIMIT, CAP_SHARE, the board off, a mismatch of tokens): the order stops.
          if (taken.length === 0 && pastLimit === 0) throw e;
          firstRefusal ??= e as Error;
          this.#log(`[kit] ${this.network}: the order stops (${errorText(e)})`);
          break order;
        }
        this.#engine.wakeTrade(t.record.id);
        const sent = BigInt(t.record.price), board = BigInt(t.trade.price);
        const past = side === 'buy' ? sent > limit || board > limit : sent < limit || board < limit;
        if (past || t.mismatch) {
          // Check 14: a trade past the order's limit, or not the price sent, is never locked.
          const why = past
            ? `The board answered trade #${t.record.id} at ${priceText(board)}, ${side === 'buy' ? 'above the order\'s maximum' : 'below the order\'s minimum'} of ${priceText(limit)}; the kit never locks it.`
            : `The board recorded trade #${t.record.id} differently from the take (${t.mismatch}); the kit never locks it.`;
          this.#engine.block(t.record.id, why);
          this.#log(`[kit] ${this.network}: ${why}`);
          pastLimit++;
          continue;
        }
        this.#engine.setPriceLimit(t.record.id, { side, price: limit });
        taken.push(t.record);
        left -= leg.taz;
        this.#log(`[kit] ${this.network}: ${side === 'buy' ? 'bought' : 'sold'} into offer #${leg.offerId}: trade #${t.record.id}, ${amountText(leg.taz, tok.decimals)} ${tok.symbol} at ${priceText(leg.price)}`);
        if (taken.length >= maxLegs) break order;
      }
    }
    if (taken.length === 0 && pastLimit > 0) {
      throw flowError('PRICE_LIMIT', `Every trade the board answered was past the order's ${side === 'buy' ? 'maximum' : 'minimum'} price of ${priceText(limit)}; the kit never locks them.`);
    }
    if (firstRefusal && taken.length === 0) throw firstRefusal;
    return taken;
  }
}
