# What the kit checks before it signs

The kit refuses to sign when any one of these checks fails. They are the
checks the Saturn site runs before a person's wallet signs a P2P step, ported
one by one; the kit adds the few of its own that a program needs (an RPC
allowlist, a refusal of known admin keys). A refusal carries a stable code
and a plain sentence, and means **nothing was sent**.

How the parts fit:

- **`checks.ts`** runs the checks of a step. When every one passes it issues
  an *intent*: what may be signed, fixed by the checks (the amount, the lock
  hash, the addresses, the deadline).
- **`signer.ts`** is the only module that signs. It refuses an intent the
  checks did not issue, one older than 60 seconds, and one already used, and
  right before it signs it runs the step's re-checks again (the checks marked
  **R** below), so time that passed since the checks cannot slip a stale fact
  into a signature.
- **`flows/maker.ts`** decides which step is due and holds checks 9, 16 and
  35; **`flows/instant.ts`** does the same for the bot's instant offers
  (section J); **`createKit`** (`index.ts`) holds check 67 and **`keys.ts`**
  check 68.
- The kit trusts only what is compiled into it (`pins.ts`: contracts, the
  escrow's code hash and admin, the token table, the timing, the fee caps),
  the chains read fresh, and its own records. The board's `/config`, its
  reference price and every feed are display data: they never feed a
  signature. The board's trade is only compared with the kit's own record.

Columns: **What** the kit checks; **Why** it matters; the **Site source** it
was ported from (`frontend/src/lib/p2p/…` at commit `e8f123f`, the tree the
kit was ported from; `SPEC` is `DexV4/P2P/SPEC.md`); the **Kit function** that
runs it; the **Code** it refuses with (`CHECK_CODES`, `FLOW_CODES` and
`SIGNER_CODES`, all exported from `src/index.ts`).

## A. Configuration and pins

| # | What | Why | Site source | Kit function | Code |
|---|---|---|---|---|---|
| 1 | A token's decimals and per-lock bounds come only from the kit's own token table, and the symbol must match it exactly. | A board, an offer or a feed that rescaled a token could make the bot sign ten times the amount its operator set. | `constants.js:58-63`, `tokenOf` 77-80 | `pins.tokenOf`, `checks.checkToken` | `TOKEN_NOT_TRADED` |
| 2 | The network has both escrow pins: the escrow's code SHA-256 and its admin. | Without pins there is nothing to check the contract against, so the kit does not trade there (mainnet in this release). | `constants.js:362-365` `phaPinned` | `checks.pinned` (`createKit` refuses first: `NETWORK_OFF`) | `NOT_PINNED` |
| 3 | Read fresh before every lock, reveal, claim and refund: the SHA-256 of the escrow's script equals the pin, and `getAdmin()` equals the pinned admin. | A replaced or upgraded contract, or a new admin, could change the rules after a trade started. | `pha.js:71-104` `codePinProblem` | `checks.codePin` | `CODE_PIN` |
| 4 | `hashSecret` on the live Phantasma node returns exactly the pinned SHA-256 vectors. Before a USDC lock, a reveal and a first self-claim. | Both chains must hash the secret the same way, or a secret that opens one lock would not open the other. | `pha.js:114-136` `hashVectorProblem`, `constants.js:337-342` | `checks.hashVectors` | `HASH_VECTORS` |
| 5 | A lock is always read under the escrow name stored in the trade's record; a contract this release does not serve is refused. | Locks made before an escrow upgrade stay on the old contract; reading another one would misjudge them. | `constants.js:380-384`, `actions.js:181, 189-191` `tradeEscrow` | `checks.escrowFor` | `ESCROW_NOT_SERVED` |
| 6 | SaturnSwap and USDC are pinned for the network. | USDC is locked only in the known contract, in the known token. | `constants.js:390-392` `baseDeployed` | `checks.baseDeployedProblem` | `BASE_NOT_DEPLOYED` |

## B. Offers and takes

| # | What | Why | Site source | Kit function | Code |
|---|---|---|---|---|---|
| 7 | `offerProblem`: the token is enabled; amounts present; the price at most the token's price maximum; the per-lock minimum and maximum; the total at most the offer maximum; min ≤ max ≤ total; the USDC of the smallest and the largest trade within the network's USDC bounds. A following offer is checked at its limit price, and as the site's form checks it (`followOfferProblem`): the offset within ±20%, the amount per day from the smallest trade to the total, and its largest trade at the limit price no more than one take of such an offer may cost (`FOLLOW_TAKE_USD_MAX`: 1,000 USDC on mainnet, 10,000 on devnet). | An offer the escrow or SaturnSwap would refuse only ends in failed trades, and a typo in a config is caught before anything is listed. | `rules.js:635-649` `offerProblem`, `followOfferProblem` | `checks.offerCheck` (`rules.offerProblem`); `Engine.postOffer` and `repriceOffer` (`rules.followOfferProblem`) | `OFFER_INVALID` |
| 8 | The bot's Base address is valid and is neither the swap contract nor the USDC token. | USDC paid to a contract address is lost. | `actions.js:210-212, 269-271` | `checks.baseAddressOk` | `BASE_ADDRESS` |
| 9 | The board's answer to a posted offer lists exactly what was posted (token, side, amounts, maker addresses, price or follow settings); otherwise the offer is cancelled at once. An answer the kit cannot read is cancelled with its control token. | A board that listed other terms would have the bot trade terms it never agreed to. | `actions.js:222-233, 240-246` `postOffer` | `flows/maker.ts` `Engine.postOffer` (`echoProblem`), `BoardSession.postOffer` | `OFFER_ECHO` |
| 10 | `takeProblem`: the amount within the offer's minimum, maximum and remaining amount, the table's per-lock bounds, and the USDC bounds. | A take the chains would refuse ends as a no-show. | `rules.js:660-673` `takeProblem` | `checks.takeCheck` | `TAKE_INVALID` |
| 11 | Room under the escrow's open-lock cap before a take or an accept (a read that fails does not block here; check 21 does). | The escrow refuses a lock past its cap, and a trade that cannot be locked counts against someone. | `rules.js:336-340` `openCapProblem` | `checks.openCapRoom`, `checks.openCapCheck` | `OPEN_CAP` |
| 12 | `buyerReadyProblem`: the USDC bounds; SaturnSwap's reads (not paused, USDC allowed, the amount within its bounds, its lock lengths fit the timing); **the USDC covers this trade plus every open trade of the kit still waiting for its USDC lock**; ETH for the lock's fee. | A buyer that takes more than it can lock does not lock in time: a no-show, and three of them pause the bot. | `actions.js:361-381` `buyerReadyProblem`, `rules.js:408-414` `swapReadsProblem` (the sum is the kit's, build spec 2.3.5) | `checks.buyerReady` | `BUYER_NOT_READY` |
| 13 | A trade id the store already keeps for another trade is refused; a new record is saved and read back. | A reset or lying board that reuses an id must never merge two trades' records. | `actions.js:293, 299-302` | `checks.keepTrade` (`store.addTrade`) | `TRADE_ID_REUSED` |
| 14 | `tradeMismatch`, before every action: the token first, then the amounts; `usdcFor(amount, price) == usdc` with the price the kit **saw and sent** at the take (kept in its record), never the board's; its own addresses; the counterparty's addresses unchanged once known; the side; h and the escrow once recorded; a following offer's price within its limit; the trade's mode (standard, or instant on the bot's instant offers) is the one the kit agreed to. `buyUpTo` and `sellDownTo` also never lock a trade priced past `maxPrice` or `minPrice`. | The board relays messages; its word never decides a token, an amount, a price, an address or who locks first. | `rules.js:559-579` `tradeMismatch` | `checks.tradeMismatch` (`rules.tradeMismatch`), `checks.modeMismatch`; the order limit in `flows/maker.ts` and `flows/taker.ts` | `TRADE_MISMATCH`, `PRICE_LIMIT` |
| 15 | A take on one of the bot's offers fits that offer exactly: its offer and side, the offer's token, an amount within the offer's per-trade bounds, a price the offer allows, a USDC amount that matches that price, the maker's own addresses, and valid taker addresses. | The bot adopts only takes of terms it listed; one that does not fit is declined. | `actions.js:326-347` `adoptMakerTrade` | `checks.adoptTake` | `TAKE_NOT_FIT` |

## C. Accepting a take (signs nothing)

| # | What | Why | Site source | Kit function | Code |
|---|---|---|---|---|---|
| 16 | A take is accepted only once it was seen for `Policy.acceptAfterS` seconds (default 15, minimum 0), and a decline wins over an accept. | It leaves a window to decline (by the operator or `Policy.accept`), and an accept already under way never overtakes a decline. | `actions.js:1789-1795` `acceptDue`, 1989 | `flows/maker.ts` (the engine's accept step, `acceptTake`, `declineTake`) | `ACCEPT_TOO_SOON`, `TAKE_DECLINED` |
| 17 | On a sell offer, `sellTakeProblem`: SaturnSwap's reads and the buyer's USDC and ETH. On a buy offer, `buyTakeProblem`: the seller's liquid balance plus its reserves. The bot's own side is checked too (its USDC as a buyer; its tokens and reserves as a seller, counting what its other trades still need). On an instant offer the take must be an instant trade, and SaturnSwap's lock bounds must take the buyer's instant lock (`instantSwapReadsProblem`). | Accepting a take the other side cannot fund only ties up the offer; accepting one the bot cannot fund makes the bot the no-show. | `actions.js:1841-1857` `sellTakeProblem`, 1868-1872 `buyTakeProblem`, 146-156 | `checks.acceptChecks` | `ACCEPT_REFUSED` (`SELLER_FUNDS`, `BUYER_NOT_READY` for the bot's own side) |

## D. The seller's Phantasma lock

| # | What | Why | Site source | Kit function | Code |
|---|---|---|---|---|---|
| 18 | The kit is the seller; `tradeMismatch`; `lockStartProblem`: no h yet, the trade accepted, at least 90 s left before its lock deadline. On an instant offer: the kit is its maker, on a network this release runs instant trades on, and the board's trade is an instant trade at `base_locked` with the buyer's h (the buyer locks first). | A lock sent too late lands after the board expired the trade. | `actions.js:662-708` `sellerLockChecks`, `rules.js:610-617` `lockStartProblem`; instant: build spec 3.10.3 step 2, `SPEC` amendment 8 | `checks.sellerLock`; `checks.instantSellerLock` | `LOCK_START`, `INSTANT_START` |
| 19 | Base is pinned, and the escrow recorded for the trade is the network's current one. | A new lock goes only to the current escrow. | `actions.js:662-708` | `checks.sellerLock`, `signer.lockPha` | `ESCROW_CHANGED` |
| 20 | The code pin, read fresh; the escrow deployed. | As check 3, at the moment of the lock. | `actions.js:662-708` | `checks.sellerLock` | `CODE_PIN`, `ESCROW_NOT_DEPLOYED` |
| 21 | Room under the open-lock cap, read fresh; **a read that fails refuses**. | A lock past the cap is refused on chain after its fee is spent. | `actions.js:595-599` `sellerCapProblem` | `checks.sellerLock` | `OPEN_CAP_UNREAD`, `OPEN_CAP` |
| 22 | The trade's fee is set and at most 200 bps. | It is the most the seller agrees to pay; SaturnSwap can never charge more than 2%. | `rules.js:422-425` `tradeFee` | `checks.sellerLock` | `FEE_UNSET` |
| 23 | The escrow's settings: not paused; the token enabled; **its minimum and maximum equal the kit's table**; the amount within them; the lock length within the escrow's bounds. | Bounds that differ from the kit's table mean the kit's view of the token is out of date: it stops. | `actions.js:691-701` | `checks.sellerLock` | `ESCROW_PARAMS` |
| 24 | `sellerBaseProblem`: SaturnSwap's reads; the Base fee at most the trade's fee; the buyer's USDC at least the amount. In an instant trade the buyer's USDC is already locked: the swap (h, the buyer's address) at the newest **and** the confirmed block reads locked, in the pinned USDC, for the trade's amount, paying the kit's Base address, made by the buyer, the two reads alike, its fee at most the trade's; its `Locked` event is found and confirmed, and its block time is t_B. | Locking tokens for a buyer who cannot lock the USDC (or did not) only ties them up until the refund. | `actions.js:573-585` `sellerBaseProblem`; instant: build spec 3.10.3 step 2 | `checks.sellerLock`; `checks.instantSellerLock` (`instantBuyerLockProblem`) | `SELLER_BASE`, `INSTANT_BUYER_LOCK` |
| 25 | `chainClock`: this machine's clock within 300 s of Base's newest block; T1 = max(local time, Base head) + the lock length. In an instant trade, with that "now": now − t_B ≤ I_WIN − I_WIN_LEAD (devnet: 180 s; a lock read 60 s after t_B goes ahead, one read at 200 s is refused), and T_B − now ≥ I_PHA + I_SAFETY; the lock ends at T_P = now + I_PHA. | A wrong clock makes every deadline wrong; an instant lock that lands after I_WIN is the maker's no-show, and one that ends too close to T_B leaves no time to claim the USDC. | `actions.js:431-439` `chainClock`; instant: build spec 3.10.2 | `checks.chainClock`; `checks.instantWindowProblem` | `CLOCK_SKEW`, `INSTANT_LATE`, `INSTANT_SHORT` |
| 26 | The terms dialog. | UI only: the site asks the person to confirm the terms. The kit's equivalent is its config, which the operator writes before the bot runs. | `actions.js:83-99` `confirmTerms` | (none: the operator's config) | (none) |
| 27 | One lock flow per trade: an in-process lock per trade, no second lock while an earlier send's outcome is unknown (the journal), and the store's single-instance lock asserted before every signature. | Two flows of one trade could lock twice; two processes on one data folder could double every step. | `actions.js:487-512` `withTradeLock` | `signer.ts` (its per-trade lock), `checks.ts` (the journal), `store.assertLock` | `LOCK_BUSY` (`STORE_LOCK_LOST` when the store's lock was lost) |
| 28 | The signing key's address is the seller in this trade; at least 1.1 SOUL free. | The kit signs only for its own address in the trade; SOUL pays Phantasma's fees (the lock now, a refund later). | `actions.js:167-178` `phaSigner` | `checks.sellerLock`, `signer.ts` | `PHA_KEY`, `SOUL_LOW` |
| 29 | `sellerFundsProblem`: the liquid balance covers the amount plus the KCAL reserve (the lock's gas and a claim) or the SOUL reserve; the balance's decimals equal the table's. | A lock without its gas fails after the trade was accepted. | `actions.js:146-156` `sellerFundsProblem`, 113-121 `balanceOf` | `checks.sellerLock` | `SELLER_FUNDS` |
| 30 | The secret is reused or made, then **saved, fsynced and read back** before anything is signed. The lock under its hash must be empty: the kit's own lock there is only reported, someone else's makes a new secret (the old one is kept). In an instant trade the hash is the buyer's: Phantasma must read nothing under it (`getState(h) == 0`); the kit's own lock there is only reported, anyone else's is a hash squat and the kit never locks behind it. | A lock whose secret is not on disk could never be claimed after a crash; a hash someone else used belongs to their lock (Phantasma takes each hash once). | `actions.js:754-766`; instant: build spec 3.10.3 step 2, 3.10.6 | `store.putSecret`, `checks.sellerLock`; `checks.instantSellerLock` | `SECRET_UNUSABLE`, `LOCKED_ALREADY`, `HASH_TAKEN` |
| 31 R | Right before signing: the trade read fresh, the code pin, the open cap, the Base side. | Time passes between the checks and the signature. | `actions.js:773-786` | the `sellerLock` re-check, run by `signer.lockPha` | `TRADE_CHANGED` (or the code of the check that failed again) |
| 32 | The fee shown and the escrow's name are stored with the trade before signing, and read back. | The reveal and the claim later compare with the fee the seller saw, never a fresh one. | `actions.js:787-790` | `checks.sellerLock` (`store.patchTrade`) | `FEE_SHOWN` |
| 33 R | The clock is read again for the lock's deadline. | The deadline is set from a fresh reading. | `actions.js:798-801` | the `sellerLock` re-check, run by `signer.lockPha` | `CLOCK_RECHECK` |
| 34 | A fixed gas allowance (price 100,000 × limit 300,000), never sized to the balance; the lock's transaction hash stored. On `P2:used` the secret is replaced only when the lock under its hash is someone else's. | A fee sized to the balance could spend all of it; `P2:used` means someone else took that hash first. | `actions.js:830-845` | `signer.lockPha` | the send ends `failed` (with `secretReplaced` when a new secret was kept); `HASH_USED` is reserved for it |
| 35 | The lock is reported to the board only once it reads on chain as this trade's own lock (`isOurLock`), and h, the escrow and T1 are recorded first. | Reporting a lock that is not this trade's would mislead the buyer into locking USDC. | `actions.js:539-563` `reportPhaLock`, 101-103 `isOurLock` | `flows/maker.ts` (the report step) | `LOCK_NOT_OURS` |

## E. The buyer's USDC lock on Base

| # | What | Why | Site source | Kit function | Code |
|---|---|---|---|---|---|
| 36 | The kit is the buyer; `tradeMismatch`; Base pinned; the trade at `pha_locked` with a lock hash. | USDC is locked only after the seller's lock is reported. | `actions.js:1008-1095` `buyerLockChecks` | `checks.buyerLock` | `BUYER_LOCK_START` |
| 37 | The record's and the board's escrow both equal the current escrow, and the record's h equals the trade's. | The kit locks against the lock it checked, on the contract it checked. | `actions.js:1008-1095` | `checks.buyerLock` | `ESCROW_MISMATCH` |
| 38 | No other trade of the kit uses this lock hash. | Two trades on one hash would let one claim reveal the secret of the other. | `actions.js:1252-1256` `hashUsedElsewhere` | `store.hashUsedElsewhere` (in `checks.buyerLock`) | `HASH_REUSED` |
| 39 | The trade's fee is set. | The lock carries the trade's fee as its maximum. | `actions.js:1008-1095` | `checks.buyerLock` | `FEE_NOT_FIXED` |
| 40 | `checkSellerLock`: the code pin; the seller's lock read from the chain; "now" never before Base's newest block; `phaLockProblem` (locked; **exactly the trade's token**, amount, recipient and sender; a valid deadline and start; the signing window still open; enough time left for the reveal and the USDC lock; not longer than the site's locks); then the SHA-256 vectors; then T2 = min(T1 − the safety margin, now + the reveal and lock allowances). | USDC is locked only behind a seller lock on chain that pays the bot exactly what it bought, with time for both claims. | `verify.js:81-109` `checkSellerLock`, `rules.js:210-247` `phaLockProblem`, `buyerT2` | `checks.sellerLockOnChain` | `SELLER_LOCK` |
| 41 | The signing key's address is the buyer in this trade. | The kit signs only for its own address. | `actions.js:1008-1095` | `checks.buyerLock`, `signer.ts` | `BASE_KEY` |
| 42 | A USDC lock for (h, the kit's address) that already exists is reported when it is this trade's, refused otherwise; never locked again. | Never lock twice. | `actions.js:1008-1095` | `checks.buyerLock` | `USDC_LOCKED_ALREADY`, `USDC_LOCK_EXISTS` |
| 43 | SaturnSwap is not paused, takes USDC and this amount, and **its fee is at most the trade's fee**. | A fee above the trade's makes the lock fail on chain. | `actions.js:1008-1095` | `checks.buyerLock` | `SWAP_REFUSES` |
| 44 | The USDC lock's length (T2 − now) is within SaturnSwap's minimum and maximum. | SaturnSwap refuses any other length. | `actions.js:1008-1095` | `checks.buyerLock` | `LOCK_LENGTH` |
| 45 | Enough USDC and enough ETH for the fee. | A lock that cannot be paid for fails after the seller locked. | `actions.js:1008-1095` | `checks.buyerLock` | `BUYER_FUNDS` |
| 46 | The permit path: USDC's `DOMAIN_SEPARATOR` equals the pinned permit domain; the nonce; the fee caps; ETH; the permit lasts 30 minutes, under the 2-hour maximum. | A permit for another domain could be used elsewhere; a short permit limits what it allows. | `base.js:1491-1518` `preparePermitLock`, 1426-1441 `lockUsdcPasskey` | `checks.permitProblem`, `signer.lockBase` | `PERMIT` |
| 47 | Refused while the bot's Phantasma address holds less KCAL than one claim needs, unless `Policy.lockWithLowKcal`. | Without KCAL the bot depends on the keeper to claim the tokens it paid for. | `actions.js:886-892` `kcalOf` | `checks.buyerLock` | `KCAL_LOW` |
| 48 | h, the escrow, T1 and T2 are stored with the trade before signing, and read back. | The claim and the refund must never need the board. | `actions.js:1173-1175` | `checks.buyerLock` (`store.patchTrade`) | `LOCK_DETAILS` |
| 49 | Without a permit: approve **exactly** the amount, never more; re-check; then lock with the trade's fee as the maximum fee. | An unlimited approval would let the contract take more later. | `base.js:1365-1378` `approveExact`, `actions.js:1217-1225` | `signer.lockBase` | `APPROVE` |
| 50 R | `usdcRecheck`: `checkSellerLock` again; T1 unchanged; the stored T2 still valid (never a new one); the trade read fresh (mismatch, status, h, fee); SaturnSwap's fee; the signing window and T2 against Base's newest block. | Time passes between the checks and the signature. | `actions.js:1108-1138` `usdcRecheck`, `rules.js:257-262` `storedT2Problem` | the `buyerLock` re-check, run by `signer.lockBase` | `USDC_RECHECK` |
| 51 R | The exact call is simulated (`eth_call`) before it is broadcast; the signed transaction equals the prepared one; it is still sendable (its nonce exactly the next one, the fee still enough). A refund or withdrawal of a trade that is not mined yet is never followed by another one at the next nonce: it is replaced at its own nonce with fees 25% higher after 60 s, or, once it may no longer go through, its nonce is taken back by a 0-value transfer to the kit's own address (a replacement or a cancel is sendable only while that nonce is not used). | What is broadcast is exactly what was checked, and nothing waits behind a transaction that is not mined. | `base.js:1539-1575` `signPreparedLock`, 674-697 `send` | `signer.ts`, `checks.cancelBase` | `NOT_SENDABLE`, `SEND_IN_FLIGHT` |

## F. The reveal (only with `claimMode: 'reveal-then-self'`)

| # | What | Why | Site source | Kit function | Code |
|---|---|---|---|---|---|
| 52 | The kit is the seller; `tradeMismatch`; the trade at `pha_locked` or `base_locked`; the record's h equals the trade's. | The secret is shared only at that step of this trade. | `actions.js:1373-1425` `revealOnce` | `checks.reveal` | `REVEAL_START` |
| 53 | The secret opens h and is bound to this trade (its id, network, token, amount and both addresses). | A secret kept for another trade is never shared for this one. | `actions.js:1289-1294` `sellerSecret` | `checks.reveal` | `SECRET_BINDING` |
| 54 | The fee shown before the lock is already stored; it is never read fresh here. | The buyer's lock is checked against the fee the seller agreed to. | `actions.js:1303-1309` `maxFee` | `checks.reveal` | `FEE_SHOWN_MISSING` |
| 55 | `checkBuyerLock`: the kit's own Phantasma lock still locked; the USDC lock on Base at the newest **and** at the confirmed block (state, token, amount, claimer, sender; the two reads agree; its deadline at most T1 − the safety margin and at least the reveal time left; **its fee at most the fee shown**); `buyerLockTimeProblem`: the `Locked` event mined within the lock window after the Phantasma lock, and confirmed. | Once the secret is out, the buyer can claim the tokens: the USDC must already be locked, final, and paying the seller. | `verify.js:151-188` `checkBuyerLock`, 122-133 `buyerLockTimeProblem`, `rules.js:454-472` `baseLockProblem` | `checks.buyerLockOnChain` | `BUYER_LOCK` |
| 56 | USDC has not blacklisted the seller's Base address or the swap contract; a USDC pause refuses (a bot never "asks"). Read where the token has these switches (devnet's MockUSDC has none); in an instant trade, before the kit locks its tokens. | A claim to a blacklisted address leaves the USDC frozen while the buyer takes the tokens. | `actions.js:1333-1339, 1390-1405` | `checks.usdcGuardProblem`; `checks.instantGuardProblem` | `USDC_GUARD` |
| 57 | The buyer's claim readiness, fresh: the code pin and the SHA-256 vectors. | The buyer must be able to claim with the secret once it is out. | `actions.js:1408` | `checks.reveal` | `CLAIM_READINESS` |
| 58 | The time the secret is shared is stored before the request goes out: before the POST to `/reveal`, and before the kit's own claim is simulated (the simulation already carries the secret to the Base node). | After a crash the kit knows the secret may be public. | `actions.js:1412` | `signer.reveal`, `signer.claimBase` | `SECRET_SENT` |

## G. The kit's own USDC claim (default `claimMode: 'self'`)

| # | What | Why | Site source | Kit function | Code |
|---|---|---|---|---|---|
| 59 | `selfClaimProblem` passes, with at least the claim margin left before the USDC lock ends. In an instant trade (`instantClaim`): only once the kit's Phantasma lock reads claimed, so the buyer's code is public there (Phantasma first, always); the code opens h and is kept with the trade before anything is simulated; the buyer's USDC lock still locked and paying the kit at the newest and the confirmed block, its fee at most the fee shown; at least 60 s left on it (the claim margin does not apply to a code that is already public). | A claim mined after the deadline fails but still makes the secret public; in an instant trade a USDC claim before the Phantasma claim would publish the buyer's code while its tokens are still locked. | `rules.js:497-523` `selfClaimProblem`; instant: build spec 3.10.3 step 4, 3.10.4 | `checks.selfClaim`; `checks.instantClaim` | `SELF_CLAIM`, `INSTANT_CLAIM`, `PHA_NOT_CLAIMED` |
| 59a | The kept secret opens h, and its trade id, seller address, amount and token equal the trade's record; refused before anything is read or simulated. | A claim publishes its secret: a secret kept for another trade must never be published by this one. | `verify.js:210-213` `checkSelfClaim` | `checks.selfClaim` | `SECRET_NOT_THIS_TRADE` |
| 60 | The first claim, while the secret has never left this machine (no reveal, and no claim of the kit's own sent or simulated yet) and the Phantasma lock is still locked, also runs checks 55 to 57. Once the kit's own claim or reveal first sent it, a later claim runs only checks 59 and 61, down to the claim margin. | The claim is the secret's first way out, so it gets the reveal's checks. | `actions.js:1467-1477` `claimUsdcSelf` | `checks.selfClaim` | `FIRST_CLAIM` |
| 61 R | A smart-contract account is refused; the lock's state, deadline and time left are checked again before the simulation and before signing; gas is twice the estimate, at least 150,000; **the `eth_call` simulation must pass** (a reverted claim still publishes the secret, `SPEC:1314-1319`); one claim per hash in flight: while the kit's claim is not mined, no new claim is sent at the next nonce; after 60 s it is replaced at its own nonce with fees 25% higher (under the fee caps), and when less than the claim margin is left its nonce is taken back by a 0-value transfer, so it is never mined after the deadline. | The claim must land, or the secret is out for nothing. | `base.js:1699-1709` `claimUsdc`, 653-656 `claimGasLimit` | `signer.claimBase` (the `selfClaim` re-check; an instant claim's re-check, from `instantClaim`, also reads the Phantasma lock still claimed and keeps 60 s) | `CLAIM_RECHECK`, `CONTRACT_ACCOUNT`, `CLAIM_IN_FLIGHT` |

## H. The other side's claim, refunds, withdrawals

| # | What | Why | Site source | Kit function | Code |
|---|---|---|---|---|---|
| 62 | The buyer's own claim of its tokens on Phantasma: the secret is public on Base (`getPreimage(h, the buyer's address)` at the confirmed block) and opens h; the code pin fresh; the lock still locked, paying the kit's address, exactly the token and the amount; at least 60 s before T1; at least 3 KCAL held for the claim's gas. A claim that went out and is not settled is never sent a second time. | The tokens are claimed only with the public secret, in time, by the kit for itself. | `actions.js:1544-1578` `claimTazFor`, `SPEC:1362-1375` | `checks.claimPhaFor` | `CLAIM_PHA` |
| 63 | The buyer's refund on Base: its USDC lock's deadline passed (plus 30 s) and the lock still reads locked. A refund not mined is followed at its own nonce (check 51). | A refund before the deadline fails; one already claimed or refunded is done. | `actions.js:1586-1608` `refundUsdcFor` | `checks.refundBase` | `REFUND_BASE` |
| 64 | The seller's refund on Phantasma: **never once the buyer's USDC lock reads claimed** (with no buyer address on record, Base is searched for a claim with this hash); the code pin fresh; at least T1 + 60 s (in an instant trade, T_P + 60 s). | Once the USDC was claimed, the tokens belong to the buyer. | `actions.js:1633-1675` `refundTazFor` | `checks.refundPha` | `REFUND_PHA` |
| 65 | `withdrawOwed` only for a payout SaturnSwap deferred to the kit's own address as the seller. | It withdraws only what is owed to the bot. | `actions.js:1685-1706` `withdrawOwedFor` | `checks.withdrawOwed` | `NOTHING_OWED` |

When Saturn's keeper does a claim or a refund first, the kit counts it as
done (`DONE_ELSEWHERE`): the payee has it.

## I. Every Base write and every Phantasma send

| # | What | Why | Site source | Kit function | Code |
|---|---|---|---|---|---|
| 66 | Every Base write is simulated first; the re-check runs twice; gas is the estimate plus 30% (twice the estimate for the escrow calls); the network fee stays under the pinned caps; ETH covers it; nonces come from a local counter, re-synced from the node after an error. Every Phantasma send carries the fixed gas allowance (check 34). | A write that would revert, or that costs more than one step may, is never sent. | `base.js:674-697` `send` | `signer.ts` (`base.ts` `prepareTx`) | `SIMULATION`, `FEE_CAPS`, `NO_ETH` |
| 67 | The RPC allowlist: the Phantasma node is the network's own (`devnet.phantasma.info` on devnet, `pharpc1.phantasma.info` on mainnet), over https on the default port, with no user name or password in the URL; the Base RPC uses https (or http to a node on this machine's loopback address), carries no user name or password, and its chain id equals the pin (84532 on devnet). Anything else stops the kit before it reads. Both clients refuse a redirect instead of following it, so no request leaves the checked host. | A node that lies could show locks that do not exist. | a kit rule (build spec 6.4) | `createKit` (`pins.phaRpcProblem`, `pins.baseRpcProblem`, `BaseReader.chainIdProblem`) | `RPC_NOT_ALLOWED` |
| 68 | The kit refuses to start with a key that holds a role a bot must never have: Saturn's admin key (P2KBPHBKq1…), an escrow admin, a keeper key (also the keeper addresses the board's `/config` shows: display data may only add a refusal), or the SaturnSwap owner. | A bot is a user's own; it never holds an admin, owner or keeper key. | a kit rule (build spec 6.4) | `keys.loadKeys` (`keys.knownRoleProblem`) | `KEY_ROLE` |

## J. Instant offers: the seller locks after the buyer (build spec section 3.10)

On an instant sell offer the buyer makes the secret and locks the USDC
first; the bot locks its tokens behind the buyer's hash only after checking
that lock, and claims the USDC only once the buyer's claim on Phantasma has
made its code public. These are the checks of that flow, in the order the
kit runs them; each one also extends the numbered check named in its row
(its code is listed there too). They come from the build spec, not from the
site: the site runs the buyer's side of an instant trade, the kit the
seller's. Time values are devnet's (`pins.ts` `INSTANT`: I_WIN 300 s,
I_WIN_LEAD 120 s, I_PHA 900 s, I_CLAIM 300 s, I_SAFETY 600 s, I_SLACK 120 s;
the same as the backend's `INSTANT_TIMING`).

| Step | What | Why | Source | Kit function | Code |
|---|---|---|---|---|---|
| I1 | Posting: a sell offer, on a network this release runs instant trades on (devnet), where the board's `/config` says instant trades are on (display only: it can add this refusal, never turn them on), with an API key, whose `/me` shows the instant flag the owner grants. Refused before anything is posted. | Only makers the owner trusts with instant offers post them, and a buyer who locks first must find a seller bot behind them. | build spec 3.10.5 | `Engine.postOffer` | `MODE_NOT_SUPPORTED` (`FLOW_CODES`, no numbered check) |
| I2 | Check 9 for the mode: an instant offer must be listed as instant. | A board that drops the mode would list a standard offer, whose buyer waits for the bot to lock first. | build spec 3.10.5, check 9 | `echoProblem` | `OFFER_ECHO` |
| I3 | Accepting (signs nothing): the take is an instant trade, SaturnSwap's lock bounds take the buyer's instant lock (T_B − now = 1,920 s), the buyer holds the USDC and ETH, the bot holds its tokens and reserves (counting what its other trades still need, an instant trade's until its lock is sent). | Accepting a take nobody can carry out only ends in a no-show. | build spec 3.10.3 step 0, checks 14 and 17 | `checks.acceptChecks` | `TRADE_MISMATCH`, `ACCEPT_REFUSED` |
| I4 | The start: the bot's own instant offer, the trade at `base_locked` with the buyer's h (`accepted`: wait, the buyer locks first). | The bot locks only behind a buyer lock the board has seen. | build spec 3.10.3 step 2, check 18 | `checks.instantSellerLock` | `INSTANT_START` |
| I5 | The buyer's lock at the confirmed tag: swap (h, the buyer's address) locked, the pinned USDC, the trade's amount, paying the bot, its fee at most the trade's; its `Locked` event confirmed, giving t_B. | The bot's tokens go only behind USDC that is locked, final and pays the bot. | build spec 3.10.3 step 2, check 24 | `checks.instantSellerLock` | `INSTANT_BUYER_LOCK` |
| I6 | The time rules: now − t_B ≤ I_WIN − I_WIN_LEAD (180 s) and T_B − now ≥ I_PHA + I_SAFETY (1,500 s). | The lock must land inside I_WIN, and the bot needs its own lock's length plus I_SAFETY to claim the USDC. | build spec 3.10.2, check 25 | `checks.instantWindowProblem` | `INSTANT_LATE`, `INSTANT_SHORT` |
| I7 | Phantasma under the buyer's h reads nothing; the bot's own lock there is only reported; anyone else's (a hash squat) is never locked behind. | Phantasma takes each hash once; a squatted hash can never carry the bot's lock. | build spec 3.10.3 step 2, 3.10.6 risk 1, check 30 | `checks.instantSellerLock` | `HASH_TAKEN`, `LOCKED_ALREADY` |
| I8 | Then the standard seller checks: the code pin, the open cap read fresh, the trade's fee, the escrow's settings with the instant lock length inside its bounds, USDC's blacklist and pause where the token has them, the signing key and its SOUL, the tokens with their reserves, no lock of the trade in flight; the buyer's h, the escrow, the fee shown and T_B stored with the trade and read back before signing. Right before signing the trade, Phantasma under h, the buyer's lock and the clock are read again, and the lock ends at T_P = now + I_PHA (900 s). | As for every seller lock: what is signed is what was checked, a moment before. | checks 19 to 34 | `checks.instantSellerLock`, `signer.lockPha` | `CODE_PIN`, `OPEN_CAP_UNREAD`, `OPEN_CAP`, `FEE_UNSET`, `ESCROW_PARAMS`, `USDC_GUARD`, `PHA_KEY`, `SOUL_LOW`, `SELLER_FUNDS`, `LOCK_BUSY`, `FEE_SHOWN`, `TRADE_CHANGED`, `CLOCK_RECHECK` |
| I9 | The report: the lock is reported (`/pha-locked`) only once it reads on chain as this trade's own, and T_P is recorded first. A report the board does not take is sent again at the board's retry time (at most once a minute when it is refused for good); the watch, the claim and the refund never wait for it. | The buyer reveals its code only against the bot's real lock. | check 35 | `flows/instant.ts` | `LOCK_NOT_OURS` |
| I10 | From the lock on, `getState(h)` is read at least every 10 s (the spec's bound is 15 s) until the bot has claimed or T_P has passed, per trade: `run()` steps each instant trade on its own, apart from the bot's other trades, and a step of the watch waits at most 3 s for the board's trade and 5 s for the lock report. | A claim on Phantasma at T_P − 1 s must still lead to the bot's USDC claim, also when Saturn's keeper does not claim it. | build spec 3.10.3 step 4 | `flows/instant.ts`, `Engine.#laneLoop` | (a schedule, not a refusal) |
| I11 | The USDC claim: only once the Phantasma lock reads claimed; the code kept with the trade; the buyer's lock still locked, at least 60 s left; simulated before it is sent. Never while the Phantasma lock reads locked. A claim sent and not mined yet is left in flight until T_B, even with under 60 s left (its code is public, so mined late it only reverts); only then is its nonce taken back. | Phantasma first, always: the buyer's code goes public on Phantasma before any USDC claim, and I_SAFETY is the bot's window. | build spec 3.10.3 step 4, 3.10.4, checks 59, 59a and 61 | `checks.instantClaim`, `signer.claimBase` | `PHA_NOT_CLAIMED`, `INSTANT_CLAIM`, `SECRET_NOT_THIS_TRADE`, `CLAIM_RECHECK` |
| I12 | The refund: a lock still unclaimed at T_P + 60 s comes back to the bot; never once the buyer's USDC lock reads claimed. | A buyer that never reveals holds the tokens for I_PHA at most. | build spec 3.10.3 step 5, check 64 | `checks.refundPha` | `REFUND_PHA` |

## The signer's own gate

Every signature needs an intent the checks issued:

| Code | Meaning |
|---|---|
| `INTENT_FOREIGN` | Not an intent the kit's checks issued (a look-alike object): nothing is signed for it. |
| `INTENT_OLD` | The checks ran more than 60 seconds ago: run them again. |
| `INTENT_USED` | The intent was already used once: an intent is never signed twice. |
| `INTENT_KIND` | The intent is for another step or network than the one being signed. |

## Before the kit starts

These refuse at `createKit`, before any lock, balance or trade is read and
before anything is sent (the one chain read before them is the Base RPC's
chain id, which is check 67 itself):

| Code | Meaning |
|---|---|
| `NETWORK_OFF` | The network has no pins in this release (mainnet), or mainnet was not explicitly allowed (`allowMainnet` and `KIT_ALLOW_MAINNET=1`). |
| `KEY_FILE` | A key file is missing, not a regular file, too large, or not the expected JSON (`{"wif": ...}`, `{"privateKey": ...}`). |
| `KEY_FILE_MODE` | Other users can read or change a key file: `chmod 600` it. |
| `KEY_ARGV` | A key appears on the command line: keys are read only from their files. |
| `RPC_NOT_ALLOWED` | Check 67. |
| `KEY_ROLE` | Check 68. |
| `STORE_LOCKED` | Another running process holds the data folder. |

## Where these come from

- The checks and their order: build spec section 6.4.
- The site's code: `frontend/src/lib/p2p/{actions,rules,verify,pha,base,constants}.js`
  at `e8f123f`; line numbers there may move in later commits, the function
  names stay.
- The kit's code: `src/checks.ts`, `src/signer.ts`, `src/flows/maker.ts`,
  `src/flows/taker.ts`, `src/flows/instant.ts`, `src/index.ts`, `src/keys.ts`,
  `src/store.ts`, `src/pins.ts`. `test/checks.test.ts` and `test/flows.test.ts`
  refuse each check once with its code; `test/signer-refusal.test.ts` shows
  that a failed check means zero sends; `test/instant.test.ts` refuses each
  instant check with zero sends and runs the instant seller flow end to end
  on fake chains.
- Instant mode: build spec sections 3.10.2 to 3.10.6 (`DexV4/P2P/SPEC.md`
  amendment 8).
