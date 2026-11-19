/**
 * bots.json, as npm run check-config and npm run deploy read it: your bots
 * and their configs, a file on your machine only (cloudflare/.gitignore),
 * which npm run deploy uploads as the Worker's BOTS_CONFIG secret. It holds
 * your prices, your limits and, with a Base RPC of your own, that RPC's key:
 * never commit it. bots.example.json is the template.
 */
import { existsSync, readFileSync } from 'node:fs';
import { loadBots } from '../src/fleet.js';
import { describeOffer } from '../../examples/seller-bot.js';
import { P2P_CONFIG } from '../../src/index.js';

/** The largest value a Worker secret holds (5 KB). */
export const SECRET_MAX_BYTES = 5_000;

export interface BotsFile {
  ok: boolean;
  /** What to tell the person, line by line. */
  lines: string[];
  /** The config as the secret's value (minified), when it can be used. */
  minified: string | null;
}

/** Read and check bots.json: each bot's config as the Worker checks it, its offers in words, and the secrets it needs. */
export function readBotsFile(file: string): BotsFile {
  if (!existsSync(file)) {
    return { ok: false, minified: null, lines: [`${file} is missing. Make it from the template, then add your bots' offers: cp bots.example.json bots.json`] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { ok: false, minified: null, lines: [`bots.json is not JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const bots = loadBots(raw);
  if (bots.error) return { ok: false, minified: null, lines: [bots.error] };
  const lines: string[] = [];
  let ok = true;
  for (const b of bots.list) {
    if (!b.cfg) {
      ok = false;
      lines.push(`${b.name}: cannot be used: ${b.error}`);
      continue;
    }
    const usdc = P2P_CONFIG[b.cfg.network].base.usdcSymbol;
    lines.push(`${b.name} (${b.cfg.network}):`);
    if (b.cfg.offers.length === 0 && b.cfg.take.length === 0) lines.push('  lists and takes nothing: add its offers, bids or orders');
    for (const w of b.cfg.offers) lines.push(`  keeps listed: ${describeOffer(w, usdc)}`);
    for (const t of b.cfg.take) lines.push(`  every ${t.everyS} s: ${t.side} up to ${t.amount} ${t.symbol} at ${t.side === 'buy' ? 'most' : 'least'} ${t.limit} ${usdc}`);
    if (b.cfg.network === 'mainnet' && !b.cfg.baseRpc) lines.push('  baseRpc: none; on mainnet give it a Base RPC of your own (Cloudflare\'s addresses are shared, and the public RPC limits each address)');
    const apiKey = b.cfg.offers.some((w) => w.mode === 'instant') ? `${b.prefix}_API_KEY (needed: it lists an instant offer)` : `${b.prefix}_API_KEY (recommended)`;
    lines.push(`  secrets: ${b.prefix}_PHA_KEY, ${b.prefix}_BASE_KEY; ${apiKey}; ${b.prefix}_STORE_KEY (optional)`);
  }
  const minified = JSON.stringify(raw);
  const size = Buffer.byteLength(minified, 'utf8');
  if (size > SECRET_MAX_BYTES) {
    ok = false;
    lines.push(`bots.json is ${size} bytes once minified; a Worker secret holds at most ${SECRET_MAX_BYTES}.`);
  }
  return { ok, lines, minified: ok ? minified : null };
}
