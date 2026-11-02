/**
 * The example buyer bot (build spec section 6.7). It runs the same runner as
 * the seller bot (seller-bot.ts, where the whole behaviour is described),
 * with examples/buyer.devnet.example.json:
 *
 *   npm run buyer                                  # the example config
 *   npm run buyer -- --config ./my-buyer.json      # a config of your own
 *   npm run buyer -- --dry-run                     # reads only; sends nothing
 *
 * The example keeps two buy offers listed (`bids`: TAZ at 1.06 and RA at
 * 1.89 USDC, near the devnet ratio of TAZ = RA / 1.8554; the RA bid stays
 * under 1.90, the lowest price the seller bot's following RA offer reaches,
 * so the two bots' books never cross), and every 120 s buys
 * up to 2 TAZ from asks at 1.10 USDC or less (`take.maxPrice`: buyUpTo), for
 * example from the seller bot's asks. It accepts takes on its bids at once
 * (`acceptAfterS: 0`), locks USDC with a permit in one transaction (or, with
 * `usePermit: false`, approves exactly the amount and then locks), and claims
 * the tokens it bought itself when Saturn's keeper has not within
 * `claimWatchS` (null: the network's claim watch, 60 s on devnet).
 *
 * Ctrl-C once stops new offers and takes, cancels its bids and finishes its
 * running trades; Ctrl-C again exits at once. A restart resumes every trade.
 */
import { isMain, mainOf } from './seller-bot.js';

if (isMain(import.meta.url)) await mainOf('buyer');
