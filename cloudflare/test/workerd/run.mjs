/**
 * npm run test:workerd: the fleet on a real Durable Object in workerd
 * (wrangler dev), with test/workerd/worker.ts (a fake kit on the real store,
 * sessions of 6 s). In order, through the control API:
 *   1. a start: the first session lists the bot's offer and runs it;
 *   2. the next session follows on its own (the alarm the first one set),
 *      and lists nothing twice;
 *   3. a reset of the object in the middle of a session (an eviction, a
 *      deploy): a new instance runs the next session, takes the store's lock
 *      over (and logs it), and lists nothing twice (the offer is in the store);
 *   4. a stop: the offer cancelled, the bot stopped, no session after it;
 *   5. a start, then a halt: stopped at once, its new offer left listed.
 * About a minute. Local only: it deploys nothing and reads no secret.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const dir = fileURLToPath(new URL('.', import.meta.url));
const wrangler = fileURLToPath(new URL('../../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const token = randomBytes(32).toString('hex');
const port = 8700 + Math.floor(Math.random() * 200);
const state = mkdtempSync(join(tmpdir(), 'p2p-bots-workerd-'));
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dev = spawn(process.execPath, [wrangler, 'dev', '-c', 'wrangler.jsonc', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', state, '--var', `CONTROL_TOKEN:${token}`], {
  cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }
});
let out = '';
dev.stdout.on('data', (d) => { out += d; });
dev.stderr.on('data', (d) => { out += d; });

const call = async (method, path) => {
  const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json() };
};
const bot = async () => (await call('GET', '/status')).body.bots[0];
const lines = async () => (await call('GET', '/bots/fake/logs?n=400')).body.lines ?? [];
const count = async (re) => (await lines()).filter((l) => re.test(l)).length;
async function until(what, cond, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await cond()) return; } catch { /* the object may be resetting */ }
    await sleep(300);
  }
  throw new Error(`${what} did not happen within ${ms / 1000} s.\nLast lines:\n${(await lines().catch(() => [])).slice(-15).join('\n')}`);
}
const step = (s) => console.log(`workerd: ${s}`);

try {
  for (let i = 0; i < 120 && !/Ready on/.test(out); i++) await sleep(500);
  assert.match(out, /Ready on/, `wrangler dev did not start:\n${out.slice(-2000)}`);

  // 1. A start, and the first session.
  const started = await call('POST', '/bots/fake/start');
  assert.equal(started.status, 200, JSON.stringify(started.body));
  await until('the first session', async () => (await count(/fake run #/)) >= 1);
  await until('the offer listed', async () => (await count(/Listed offer #1/)) === 1);
  assert.equal((await bot()).mode, 'running');
  step('1. started; the first session listed the offer and runs it');

  // 2. The next session, on its own.
  await until('the second session', async () => (await count(/fake run #/)) >= 2, 15_000);
  assert.equal(await count(/Listed offer/), 1, 'nothing listed twice');
  assert.deepEqual((await bot()).openOffers, [1]);
  step('2. the next session followed (its alarm set by the first); nothing listed twice');

  // 3. A reset in the middle of a session.
  await until('a session running', async () => (await bot()).sessionRunning === true);
  await sleep(1_000);
  await fetch(`${base}/crash`).catch(() => undefined);
  await until('the lock taken over by a new instance', async () => (await count(/an earlier instance held durable-object:fake\/devnet .*taking over its lock/)) === 1, 40_000);
  await until('a session of the new instance', async () => (await count(/fake run #/)) >= 1);
  assert.equal(await count(/Listed offer/), 0, 'the new instance lists nothing: the offer is still in the store');
  await until('its status', async () => JSON.stringify((await bot()).openOffers) === '[1]');
  step('3. after a reset mid-session, a new instance took the store\'s lock over and listed nothing twice');

  // 4. A stop.
  assert.equal((await call('POST', '/bots/fake/stop')).status, 200);
  await until('stopped', async () => (await bot()).mode === 'stopped', 15_000);
  const stopped = await bot();
  assert.match(stopped.note, /Stopped cleanly/);
  assert.deepEqual(stopped.openOffers, [], 'its offer cancelled');
  const runs = await count(/fake run #/);
  await sleep(3_000);
  assert.equal(await count(/fake run #/), runs, 'no session after the stop');
  assert.equal((await bot()).sessionRunning, false);
  step('4. stopped: its offer cancelled, no session after it');

  // 5. A start, then a halt.
  assert.equal((await call('POST', '/bots/fake/start')).status, 200);
  await until('the new offer', async () => (await count(/Listed offer #2/)) === 1);
  const halted = await call('POST', '/bots/fake/halt');
  assert.equal(halted.status, 200);
  await until('halted', async () => (await bot()).mode === 'stopped' && (await bot()).sessionRunning === false);
  const after = await bot();
  assert.match(after.note, /Halted/);
  assert.ok(after.openOffers.includes(2), 'a halt cancels nothing');
  step('5. a halt stopped it at once and cancelled nothing');
  console.log('workerd: all passed');
} catch (e) {
  console.error(`workerd: FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  dev.kill('SIGTERM');
  await sleep(500);
  rmSync(state, { recursive: true, force: true });
}
