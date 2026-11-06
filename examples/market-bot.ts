/**
 * The market bot: your own bot, on the same runner as the example bots
 * (seller-bot.ts, where the whole behaviour is described). Its lines say
 * [market], and its config is your own, ./market.mainnet.json unless
 * --config names another:
 *
 *   KIT_ALLOW_MAINNET=1 npm run market -- --mainnet --dry-run   # reads only; sends nothing
 *   KIT_ALLOW_MAINNET=1 npm run market -- --mainnet             # trades, with real funds
 *   npm run market -- --config ./other.json                     # another config of your own
 *
 * sh start.sh mainnet does it for you: it makes market.mainnet.json from
 * examples/market.mainnet.example.json and the bot's own key pair in
 * keys/mainnet/, shows a dry run, and starts the bot once you type yes. The
 * template lists no offer, bid or order, so the bot lists and takes nothing
 * until you add yours, at your own prices: "offers" sell, "bids" buy, and one
 * config may hold both, which keeps both sides of a token listed. A config
 * for mainnet runs only with --mainnet and KIT_ALLOW_MAINNET=1.
 *
 * Ctrl-C once stops new offers and takes, cancels its offers and finishes its
 * running trades (on mainnet that can take up to about 12 hours, when the
 * other side never locks); Ctrl-C again exits at once. A restart resumes
 * every trade.
 */
import { isMain, mainOf } from './seller-bot.js';

if (isMain(import.meta.url)) await mainOf('market');
