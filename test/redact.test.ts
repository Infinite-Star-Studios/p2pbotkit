/**
 * Redaction (build spec sections 6.5 and 6.8, safety invariants 6 and 8):
 * keys, control tokens, API keys, bearer values and swap secrets never appear
 * in a log line or an error message, while addresses, amounts and words stay
 * readable. Keys here are generated on the spot, never funded, never printed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PhantasmaKeys } from 'phantasma-sdk-ts';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BaseError } from 'viem';
import { redact, errorText, shortHex, redactedLog, REDACT_MAX } from '../src/redact.js';
import { SafetyError, BoardError } from '../src/errors.js';
import { loadKeys } from '../src/keys.js';
import { openStore } from '../src/store.js';
import { makeSecretRecord, newControlToken, tokenHashOf, hexToDecimal } from '../src/codec.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const randB58 = (n: number) => Array.from(randomBytes(n), (b) => B58[b % 58]).join('');
const PHA_ADDR = 'P2KAwvD3zJX92qex3zF4RjtkxZyp4QihwLTqBRqUVE1hMRH';
const BASE_ADDR = '0x952Cd62D3575Fd1B434faAE1B48FBDD0eD0a891d';

/** Fresh secrets of every kind the kit handles. */
function secrets() {
  const wif = PhantasmaKeys.generate().toWIF();
  const pk = generatePrivateKey();
  const token = newControlToken();
  const swapSecret = '0x' + randomBytes(32).toString('hex');
  const apiKey = 'sat_' + randomBytes(32).toString('base64url');
  return { wif, uncompressedWif: '5' + randB58(50), pk, token, swapSecret, swapSecretDecimal: hexToDecimal(swapSecret), apiKey, admin: randomBytes(24).toString('base64url') };
}

/** None of the secret values appear in `s` (checked case-insensitively for hex). Fixed messages: a failure never prints a secret. */
function clean(s: string, x: ReturnType<typeof secrets>, what: string) {
  const low = s.toLowerCase();
  assert.ok(!s.includes(x.wif), `${what}: WIF`);
  assert.ok(!s.includes(x.uncompressedWif), `${what}: uncompressed WIF`);
  assert.ok(!low.includes(x.pk.slice(2).toLowerCase()), `${what}: Base key`);
  assert.ok(!low.includes(x.token), `${what}: control token`);
  assert.ok(!low.includes(x.swapSecret.slice(2)), `${what}: swap secret`);
  assert.ok(!s.includes(x.swapSecretDecimal), `${what}: swap secret as decimal`);
  assert.ok(!s.includes(x.apiKey.slice(4)), `${what}: API key`);
  assert.ok(!s.includes(x.admin), `${what}: admin secret`);
}

test('redact() scrubs WIF-shaped base58, 0x + 64 hex, bare 64 hex, long decimals, sat_ keys and bearer tokens', () => {
  const x = secrets();
  const lines = [
    `phantasma wif ${x.wif} loaded`,
    `old style ${x.uncompressedWif}.`,
    `base key ${x.pk}`,
    `BASE KEY ${x.pk.toUpperCase().replace('0X', '0x')}`,
    `heartbeat with token ${x.token}`,
    `claim(${x.swapSecret}, ${BASE_ADDR})`,
    `phantasma claim args ["${x.swapSecretDecimal}"]`,
    `X-API-Key: ${x.apiKey}`,
    `headers {"x-api-key":"${x.apiKey}"}`,
    `key ${x.apiKey} was rejected`,
    `Authorization: Bearer ${x.token}`,
    `authorization: bearer ${x.admin}`,
    `body {"wif":"${x.wif}","privateKey":"${x.pk}","secret":"${x.swapSecret}","makerToken":"${x.token}","apiKey":"${x.apiKey}"}`,
    `config wif=${x.wif} privateKey=${x.pk}`,
    `signed 0x02f8${randomBytes(120).toString('hex')}${x.pk.slice(2)}`
  ];
  for (const l of lines) clean(redact(l), x, l.slice(0, 24));
  assert.match(redact(`wif ${x.wif}`), /<wif>/);
  assert.match(redact(`key ${x.pk}`), /<hex>/);
  // A 77-digit decimal is also 64+ hex digits: the hex rule runs first (so a hex key is never cut into
  // pieces the decimal rule would leave behind), and either placeholder hides it.
  assert.match(redact(`n ${x.swapSecretDecimal}`), /^n <(hex|number)>$/);
  assert.equal(redact(`n ${'7'.repeat(40)}`), 'n <number>');
  assert.equal(redact(`n ${'7'.repeat(29)}`), `n ${'7'.repeat(29)}`);
  assert.match(redact(`k ${x.apiKey}`), /sat_<redacted>/);
  assert.match(redact(`Authorization: Bearer ${x.token}`), /Bearer <redacted>/);
  assert.match(redact(`{"token":"${x.token}"}`), /"token":"<redacted>"/);
  // An Authorization header of any scheme: the scheme stays, the credential goes; a bare credential goes too.
  const basic = Buffer.from(`bot:${x.admin}`).toString('base64');
  assert.equal(redact(`Authorization: Basic ${basic}`), 'Authorization: Basic <redacted>');
  assert.equal(redact(`{"Proxy-Authorization":"Basic ${basic}"}`), '{"Proxy-Authorization":"Basic <redacted>"}');
  assert.equal(redact(`authorization: ${x.admin} was refused`), 'authorization: <redacted> was refused');
  assert.equal(redact(`Authorization: Bearer ${x.token}`), 'Authorization: Bearer <redacted>');
});

test('redact() keeps what a log line needs: addresses, amounts, ids, codes, words', () => {
  const line = `trade #42 TAZ 5000000000 raw at 1640000 for 8200000 USDC; seller ${PHA_ADDR} base ${BASE_ADDR}; code PRICE_CHANGED (409)`;
  assert.equal(redact(line), line);
  assert.equal(redact('KCAL offerMax 3000000000000000000 (19 digits) stays'), 'KCAL offerMax 3000000000000000000 (19 digits) stays');
  assert.equal(redact('tokenHash and secretSentAt are field names, not values'), 'tokenHash and secretSentAt are field names, not values');
  assert.equal(redact('  two\n lines\t here  '), 'two lines here', 'one line');
});

test('redact() keeps a URL\'s scheme, host and short path segments, and hides key-like segments, the query and the user part', () => {
  const key = randomBytes(16).toString('hex');
  const qk = randomBytes(12).toString('base64url');
  const out = redact(`POST https://base-sepolia.g.alchemy.com/v2/${key}?x=1 failed; https://user:pw@rpc.example.org/a?apikey=${qk}#frag; see https://apiops.saturnx.cc`);
  assert.ok(!out.includes(key), 'the key in the path');
  assert.ok(!out.includes(qk), 'the key in the query');
  assert.ok(!out.includes('pw@') && !out.includes('user:'), 'the user part');
  assert.match(out, /https:\/\/base-sepolia\.g\.alchemy\.com\/v2\/…\?… failed/);
  assert.match(out, /https:\/\/rpc\.example\.org\/a\?… see/);
  assert.match(out, /https:\/\/apiops\.saturnx\.cc$/);
  assert.equal(redact('POST https://apiops.saturnx.cc/v1/p2p/offers/42/take answered 409'), 'POST https://apiops.saturnx.cc/v1/p2p/offers/42/take answered 409');
  assert.equal(redact('GET https://apiops.saturnx.cc/v1/p2p/trades/42?network=devnet&symbol=all'), 'GET https://apiops.saturnx.cc/v1/p2p/trades/42?…');
});

test('redact() caps the length; shortHex shortens public hashes so a line can still name them', () => {
  const long = 'word '.repeat(1000);
  assert.ok(redact(long).length <= REDACT_MAX);
  assert.equal(redact('abcdef', 4), 'abc…');
  const tx = '0x' + 'ab'.repeat(32);
  assert.equal(shortHex(tx), '0xababab…abab');
  assert.equal(redact(`sent ${shortHex(tx)}`), 'sent 0xababab…abab', 'a shortened hash survives redact()');
  assert.equal(shortHex('ABCDEF'), 'ABCDEF');
  assert.equal(shortHex('not hex'), '—');
  assert.equal(shortHex(null), '—');
});

test('errors carry no secret: SafetyError, BoardError and errorText() of a viem error', () => {
  const x = secrets();
  const s = new SafetyError('SOME_CODE', `while checking ${x.wif} and ${x.pk} for ${x.token}`);
  clean(s.message, x, 'SafetyError.message');
  clean(s.detail, x, 'SafetyError.detail');
  clean(String(s.stack), x, 'SafetyError.stack');
  const b = new BoardError('UNAUTHORIZED', 401, false, null, null, `Authorization: Bearer ${x.token} with ${x.apiKey}`);
  clean(b.message, x, 'BoardError.message');
  assert.equal(b.code, 'UNAUTHORIZED');
  assert.equal(b.retryable, false);
  const r = new BoardError('BUSY', 409, true, 60.7, 'waiting_per_offer');
  assert.equal(r.retryAfter, 60);
  assert.equal(r.reason, 'waiting_per_offer');
  assert.equal(new BoardError('X', 0, true, -5).retryAfter, null);
  // viem's long message carries the request (a claim's request carries the secret); errorText takes its short message.
  const v = new BaseError('Execution reverted', { details: `eth_call {"data":"0xabcdef01${x.swapSecret.slice(2)}"} key ${x.pk}` });
  assert.ok(v.message.includes(x.swapSecret.slice(2)), 'the fixture really holds the secret');
  assert.equal(errorText(v), 'Execution reverted');
  clean(redact(v), x, 'redact(viem error)');
  clean(errorText(new Error(`node said ${x.wif}`)), x, 'errorText(Error)');
  clean(errorText(`a string ${x.token}`), x, 'errorText(string)');
});

test('redactedLog() hands a logger only redacted lines, and a throwing logger never stops the kit', () => {
  const x = secrets();
  const got: string[] = [];
  const log = redactedLog((l) => got.push(l));
  log(`token ${x.token} and key ${x.pk}`);
  assert.equal(got.length, 1);
  clean(got[0]!, x, 'redactedLog');
  assert.doesNotThrow(() => redactedLog(() => { throw new Error('logger down'); })('line'));
  assert.doesNotThrow(() => redactedLog(undefined)('line'));
});

test('a whole session (keys, store, secrets, tokens, errors) logs no key, token or secret', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kit-redact-'));
  try {
    const x = secrets();
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);
    const phaFile = join(dir, 'pha.json');
    const baseFile = join(dir, 'base.json');
    await writeFile(phaFile, JSON.stringify({ wif: x.wif }), { mode: 0o600 });
    await writeFile(baseFile, JSON.stringify({ privateKey: x.pk }), { mode: 0o600 });
    const keys = await loadKeys({ network: 'devnet', phaKeyFile: phaFile, baseKeyFile: baseFile, argv: [], log });
    assert.equal(keys.address.base, privateKeyToAccount(x.pk).address);
    const errors: string[] = [];
    // A key on the command line and a key file readable by others are refused with messages that quote neither.
    await loadKeys({ network: 'devnet', phaKeyFile: phaFile, baseKeyFile: baseFile, argv: ['node', 'bot.ts', x.wif], log }).catch((e) => errors.push(String(e.message)));
    await writeFile(join(dir, 'open.json'), JSON.stringify({ wif: x.wif }), { mode: 0o644 });
    await loadKeys({ network: 'devnet', phaKeyFile: join(dir, 'open.json'), baseKeyFile: baseFile, argv: [], log }).catch((e) => errors.push(String(e.message)));
    const keyFile = join(dir, 'store.key');
    await writeFile(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
    const store = await openStore({ dataDir: join(dir, 'data'), network: 'devnet', keyFile, log });
    const rec = makeSecretRecord({ tradeId: 9, network: 'devnet', symbol: 'TAZ', taz: '1000000000', sPha: keys.address.pha, bPha: PHA_ADDR, role: 'S' });
    await store.putSecret(rec);
    await store.putSecret({ ...rec, tradeId: 10 }).catch((e) => errors.push(String(e.message)));
    await store.putPending({
      kind: 'offer', network: 'devnet', token: x.token, tokenHash: tokenHashOf(x.token),
      body: { side: 'sell', symbol: 'TAZ', makerPha: keys.address.pha, makerBase: keys.address.base.toLowerCase(), tazTotal: '3000000000', tazMin: '1000000000', tazMax: '2000000000', price: '1080000' },
      createdAt: Date.now(), sentAt: null
    });
    await store.putPending({ kind: 'offer', network: 'devnet', token: x.token, tokenHash: 'f'.repeat(64), body: { symbol: 'TAZ' } as never, createdAt: Date.now(), sentAt: null }).catch((e) => errors.push(String(e.message)));
    await store.close();
    await openStore({ dataDir: join(dir, 'data'), network: 'devnet', keyFile: null, log }).catch((e) => errors.push(String(e.message)));
    assert.ok(lines.length >= 1 && errors.length === 5, `${lines.length} log lines, ${errors.length} refusals`);
    const withRec = { ...x, swapSecret: rec.secret, swapSecretDecimal: hexToDecimal(rec.secret) };
    for (const l of lines) clean(l, withRec, 'log line');
    for (const m of errors) clean(m, withRec, 'error message');
    clean(JSON.stringify(keys), withRec, 'keys as JSON');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
