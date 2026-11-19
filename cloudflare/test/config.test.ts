/**
 * scripts/config.ts: bots.json as npm run check-config and npm run deploy read
 * it. Missing or not JSON: refused, with what to do. Usable: each bot in
 * words, the secrets it needs, a warning for a mainnet bot on the public Base
 * RPC, and its minified text for the BOTS_CONFIG secret, within 5 KB.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBotsFile, SECRET_MAX_BYTES } from '../scripts/config.js';

test('bots.json: missing, not JSON, a bad config, too large for a secret, or usable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bots-json-'));
  try {
    const f = join(dir, 'bots.json');
    let r = readBotsFile(f);
    assert.equal(r.ok, false);
    assert.match(r.lines[0]!, /missing.*cp bots\.example\.json bots\.json/);
    writeFileSync(f, '{"market": ');
    r = readBotsFile(f);
    assert.equal(r.ok, false);
    assert.match(r.lines[0]!, /not JSON/);
    writeFileSync(f, JSON.stringify({ market: { network: 'mainnet', offers: [{ symbol: 'TAZ', total: '30', min: '1', max: '5' }] } }));
    r = readBotsFile(f);
    assert.equal(r.ok, false);
    assert.match(r.lines.join('\n'), /market: cannot be used: .*"price" or a "follow"/);
    const market = { network: 'mainnet', offers: [{ symbol: 'TAZ', total: '30', min: '1', max: '5', price: '1.08' }], take: { symbol: 'RA', amount: '1', maxPrice: '2.10', everyS: 600 } };
    writeFileSync(f, JSON.stringify({ market }, null, 2));
    r = readBotsFile(f);
    assert.equal(r.ok, true, r.lines.join('\n'));
    assert.match(r.lines.join('\n'), /keeps listed: sell 30 TAZ \(1 to 5 per trade\) at 1\.08 USDC/);
    assert.match(r.lines.join('\n'), /every 600 s: buy up to 1 RA at most 2\.10 USDC/);
    assert.match(r.lines.join('\n'), /baseRpc: none; on mainnet give it a Base RPC of your own/);
    assert.match(r.lines.join('\n'), /secrets: MARKET_PHA_KEY, MARKET_BASE_KEY; MARKET_API_KEY \(recommended\)/);
    assert.equal(r.minified, JSON.stringify({ market }), 'the secret\'s value: the same JSON, minified');
    writeFileSync(f, JSON.stringify({ market: { ...market, baseRpc: 'https://base-mainnet.example/v2/abc' } }));
    assert.doesNotMatch(readBotsFile(f).lines.join('\n'), /baseRpc: none/);
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`bot-${i}`, market]));
    writeFileSync(f, JSON.stringify(many));
    r = readBotsFile(f);
    assert.equal(r.ok, false);
    assert.equal(r.minified, null);
    assert.match(r.lines.at(-1)!, new RegExp(`a Worker secret holds at most ${SECRET_MAX_BYTES}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
