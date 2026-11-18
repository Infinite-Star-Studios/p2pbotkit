/**
 * Check bots.json before a deploy (npm run check-config; npm run deploy runs
 * it first): each bot's config as the Worker will check it, its offers in
 * words, and the secrets it needs. Exits 1 when a config cannot be used.
 * Reads no secret: it cannot tell whether one is set (npx wrangler secret
 * list can), so it names them all.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadBots } from '../src/fleet.js';
import { describeOffer } from '../../examples/seller-bot.js';
import { P2P_CONFIG } from '../../src/index.js';

const file = fileURLToPath(new URL('../bots.json', import.meta.url));
let raw: unknown;
try {
  raw = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.log(`bots.json cannot be read: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
// The Worker checks bots.json the same way: a config's use never depends on the secrets (they are checked at a start).
const bots = loadBots(raw);
if (bots.error) {
  console.log(bots.error);
  process.exit(1);
}
let bad = 0;
for (const b of bots.list) {
  if (!b.cfg) {
    bad++;
    console.log(`${b.name}: cannot be used: ${b.error}`);
    continue;
  }
  const usdc = P2P_CONFIG[b.cfg.network].base.usdcSymbol;
  console.log(`${b.name} (${b.cfg.network}):`);
  if (b.cfg.offers.length === 0 && b.cfg.take.length === 0) console.log('  lists and takes nothing: add its offers, bids or orders');
  for (const w of b.cfg.offers) console.log(`  keeps listed: ${describeOffer(w, usdc)}`);
  for (const t of b.cfg.take) console.log(`  every ${t.everyS} s: ${t.side} up to ${t.amount} ${t.symbol} at ${t.side === 'buy' ? 'most' : 'least'} ${t.limit} ${usdc}`);
  const optional = b.cfg.offers.some((w) => w.mode === 'instant') ? `${b.prefix}_API_KEY (needed: it lists an instant offer)` : `${b.prefix}_API_KEY (recommended)`;
  console.log(`  secrets: ${b.prefix}_PHA_KEY, ${b.prefix}_BASE_KEY; ${optional}; ${b.prefix}_STORE_KEY (optional)`);
}
process.exit(bad ? 1 : 0);
