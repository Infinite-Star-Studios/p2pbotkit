/**
 * The kit in a container (Dockerfile, docker/entrypoint.sh, docs/RAILWAY.md).
 *
 * The entrypoint runs here as it runs in a container, with `sh`, in a
 * folder of its own that stands for the image's /app: a start.sh that only
 * records how it was called, a folder that stands for the volume, a folder
 * that stands for /proc (KIT_PROC_DIR), a `stat` that says which device a
 * folder is on, so a test decides whether the volume is one, a `sleep`
 * that only notes how long it was asked to wait, and a `date` that reads a
 * clock a test can set. Nothing here needs Docker, a network, or the kit's
 * own packages.
 *
 *   - the volume: no start, no key and no state without one;
 *   - the links: ./keys, ./data and ./market.mainnet.json are the volume's;
 *   - the network and start.sh's command line, with no terminal on its
 *     input; a network that nobody named on a mainnet bot's volume;
 *   - the locks a killed bot leaves, which a new container's host name
 *     would turn into STORE_LOCKED: removed only where a volume is mounted
 *     in one container at a time, or when they are this container's own,
 *     and only while no Node process runs;
 *   - mainnet: start.sh's own setup first (never while the yes is given
 *     already), the config on the volume, KIT_MARKET_CONFIG, and a config
 *     whose paths are not the volume's or whose data folder is another;
 *   - KIT_HOLD;
 *   - KIT_PROBE: whether two containers have the volume at a time;
 *   - the wait before a start that follows the last one at once;
 *   - the Dockerfile, the ignore files and the guide agree with the scripts.
 */
import { describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT_ROOT = new URL('../', import.meta.url);
const kitFile = (rel: string) => fileURLToPath(new URL(rel, KIT_ROOT));
const readKitFile = (rel: string) => readFile(kitFile(rel), 'utf8');

const skip = process.platform === 'win32' ? 'the kit does not run on Windows itself' : false;

/** start.sh's stand-in: records its command line, its folder, its input and its links, then exits as FAKE_EXIT says. */
const FAKE_START_SH = '#!/bin/sh\nexec node "$(dirname "$0")/fake-start.cjs" "$@"\n';
const FAKE_START_CJS = `
const fs = require('fs');
const link = (n) => { try { return fs.readlinkSync(n); } catch { return null; } };
let devNull = false;
try { devNull = fs.fstatSync(0).rdev === fs.statSync('/dev/null').rdev && fs.fstatSync(0).isCharacterDevice(); } catch {}
const rec = {
  args: process.argv.slice(2),
  cwd: process.cwd(),
  pid: process.pid,
  stdinIsTTY: process.stdin.isTTY === true,
  stdinIsDevNull: devNull,
  allowMainnet: process.env.KIT_ALLOW_MAINNET ?? null,
  links: { keys: link('keys'), data: link('data'), config: link('market.mainnet.json') }
};
fs.appendFileSync(process.env.FAKE_RECORD, JSON.stringify(rec) + '\\n');
if (rec.args[0] === 'mainnet' && rec.args[1] === 'setup') {
  // What "sh start.sh mainnet setup" makes: the market bot's key pair and its config (the template), in the
  // kit's folder. As examples/new-keys.ts: a pair that is there is left as it is, and with one of its two files
  // there nothing is written and the setup ends with an error.
  fs.mkdirSync('keys/mainnet', { recursive: true });
  const pair = [['keys/mainnet/market-pha.json', '{"wif":"made by setup"}\\n'], ['keys/mainnet/market-base.json', '{"privateKey":"made by setup"}\\n']];
  const there = pair.filter(([f]) => fs.existsSync(f)).length;
  if (there === 1) process.exit(1);
  if (there === 0) for (const [f, text] of pair) fs.writeFileSync(f, text, { mode: 0o600 });
  fs.copyFileSync('examples/market.mainnet.example.json', 'market.mainnet.json');
  // A setup that ends with an error although it has written its config.
  if (process.env.FAKE_SETUP_EXIT) process.exit(Number(process.env.FAKE_SETUP_EXIT));
}
process.exit(Number(process.env.FAKE_EXIT ?? 0));
`;

/**
 * stat's stand-in, first on the PATH: "stat -L -c %d <path>" answers the device a test gives that path. The folder
 * FAKE_VOLUME names, and what is in it, is on a device of its own; everything else is on the device of /. For the
 * path FAKE_STAT_BLIND names it has no answer.
 */
const FAKE_STAT = `#!/bin/sh
# With FAKE_STAT_BSD=1 it is BSD's stat, which has no -c: "stat -L -f %d <path>".
form=-c
[ "\${FAKE_STAT_BSD:-}" != 1 ] || form=-f
[ "$1" = -L ] && [ "$2" = "$form" ] && [ "$3" = %d ] && [ "$#" = 4 ] || exit 1
[ "$4" != "\${FAKE_STAT_BLIND:-}" ] || exit 1
case "$4/" in
  "$FAKE_VOLUME"/*) echo 2049 ;;
  *) echo 64 ;;
esac
`;

/** Where the real program is, for a stand-in that hands over to it (found before the stand-ins are on the PATH). */
const realPath = (name: string) => {
  const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
  return found.startsWith('/') ? found : `/bin/${name}`;
};
const REAL_SLEEP = realPath('sleep');
const REAL_DATE = realPath('date');

/**
 * sleep's stand-in, first on the PATH: it notes the time it was asked to wait in FAKE_SLEEPS, moves the test's
 * clock on by it (FAKE_CLOCK) and returns at once, so a test of the wait between starts takes no time. With
 * FAKE_SLEEP_REAL=1 it then is the real sleep (KIT_HOLD's).
 */
const FAKE_SLEEP = `#!/bin/sh
printf '%s\\n' "$1" >>"$FAKE_SLEEPS"
# Another container that writes its mark while this one sleeps (KIT_PROBE): a new mark at every sleep.
if [ -n "\${FAKE_OTHER_PROBE:-}" ]; then printf 'the-other 1800000000 %s 00000000\\n' "$(wc -l <"$FAKE_SLEEPS" | tr -d ' ')" >"$FAKE_OTHER_PROBE"; fi
if [ -n "\${FAKE_CLOCK:-}" ]; then echo $(( $(cat "$FAKE_CLOCK") + $1 )) >"$FAKE_CLOCK"; fi
if [ "\${FAKE_SLEEP_REAL:-}" = 1 ]; then exec ${REAL_SLEEP} "$@"; fi
`;

/** date's stand-in, first on the PATH: "date +%s" reads the clock a test set (the file FAKE_CLOCK names). */
const FAKE_DATE = `#!/bin/sh
if [ -n "\${FAKE_CLOCK:-}" ] && [ "$#" = 1 ] && [ "$1" = +%s ]; then cat "$FAKE_CLOCK"; exit 0; fi
exec ${REAL_DATE} "$@"
`;

interface Call {
  args: string[];
  cwd: string;
  pid: number;
  stdinIsTTY: boolean;
  stdinIsDevNull: boolean;
  allowMainnet: string | null;
  links: { keys: string | null; data: string | null; config: string | null };
}

interface Box {
  /** Stands for the image's /app. */
  kit: string;
  /** Stands for the volume. */
  state: string;
  /** Stands for /proc. */
  proc: string;
  record: string;
  /** The waits the entrypoint asked for, one per row. */
  sleeps: string;
  /** A clock a test can set: the time in seconds, read by `date +%s` when FAKE_CLOCK names this file. */
  clock: string;
  entrypoint: string;
}

const made: string[] = [];
/** The process groups of the entrypoints that are still held or probing (KIT_HOLD, KIT_PROBE). */
const groups = new Set<number>();
process.on('exit', () => {
  for (const d of made) spawnSync('rm', ['-rf', d]);
});
// A run that is interrupted (Ctrl-C, a cancelled job) ends those entrypoints too, which are in process groups of
// their own and would outlive it, and removes its folders: the 'exit' handler above does not run for a signal.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    for (const pid of groups) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch { /* ended already */ }
    }
    process.exit(130);
  });
}

async function box(): Promise<Box> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kit-docker-')));
  made.push(root);
  const kit = join(root, 'app');
  const b: Box = { kit, state: join(root, 'volume'), proc: join(root, 'proc'), record: join(root, 'calls.jsonl'), sleeps: join(root, 'sleeps'), clock: join(root, 'clock'), entrypoint: join(kit, 'docker', 'entrypoint.sh') };
  await mkdir(join(kit, 'docker'), { recursive: true });
  await mkdir(join(kit, 'examples'));
  await mkdir(b.state);
  await mkdir(b.proc);
  await copyFile(kitFile('docker/entrypoint.sh'), b.entrypoint);
  await copyFile(kitFile('examples/market.mainnet.example.json'), join(kit, 'examples', 'market.mainnet.example.json'));
  await writeFile(join(kit, 'start.sh'), FAKE_START_SH);
  await writeFile(join(kit, 'fake-start.cjs'), FAKE_START_CJS);
  await mkdir(join(root, 'bin'));
  await writeFile(join(root, 'bin', 'stat'), FAKE_STAT, { mode: 0o755 });
  await writeFile(join(root, 'bin', 'sleep'), FAKE_SLEEP, { mode: 0o755 });
  await writeFile(join(root, 'bin', 'date'), FAKE_DATE, { mode: 0o755 });
  return b;
}

/** Where no volume is mounted: a test that sets FAKE_VOLUME to it leaves the state folder on the device of /. */
const NOWHERE = '/nowhere';

/**
 * The environment of a container: nothing of the developer's own KIT_ or RAILWAY_ variables, and the state folder
 * on a device of its own (a volume) unless a test says otherwise. A value of '' takes a variable away. The Node
 * that runs the tests is on the PATH, for start.sh's stand-in and the entrypoint's own checks.
 */
function envOf(b: Box, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { PATH: `${join(b.kit, '..', 'bin')}:${dirname(process.execPath)}:${process.env.PATH ?? ''}`, FAKE_RECORD: b.record, FAKE_VOLUME: b.state, FAKE_SLEEPS: b.sleeps, KIT_STATE_DIR: b.state, KIT_PROC_DIR: b.proc };
  for (const [k, v] of Object.entries(extra)) {
    if (v === '') delete env[k];
    else env[k] = v;
  }
  return env;
}

/** One run of the entrypoint to its end. A run that does not end (a hold nobody asked for) is killed: code null. */
function run(b: Box, args: string[] = [], extra: Record<string, string> = {}): { code: number | null; out: string; err: string; pid: number } {
  const r = spawnSync('sh', [b.entrypoint, ...args], { env: envOf(b, extra), encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' });
  return { code: r.status, out: r.stdout, err: r.stderr, pid: r.pid };
}

async function calls(b: Box): Promise<Call[]> {
  if (!existsSync(b.record)) return [];
  return (await readFile(b.record, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Call);
}

/** The waits asked for so far, in seconds. */
async function sleepsOf(b: Box): Promise<string[]> {
  return existsSync(b.sleeps) ? (await readFile(b.sleeps, 'utf8')).split('\n').filter(Boolean) : [];
}

const modeOf = async (f: string) => ((await stat(f)).mode & 0o777).toString(8);
/** The lock of a bot that ran in an earlier container: another host name, as the kit writes it (src/store.ts). */
const LOCK = '{"pid":7,"host":"an-earlier-container","startedAt":1794574606411,"nonce":"87a54ffe65f0995e98e1d5628e16ada2"}\n';
/** The lock of a bot that ran in this same container before (this machine's own host name). */
const OWN_LOCK = `${JSON.stringify({ pid: 88, host: hostname(), startedAt: 1794574606411, nonce: '0f5c7a54ffe65f0995e98e1d5628e16a' })}\n`;

async function lockIn(dir: string, text = LOCK): Promise<string> {
  await mkdir(dir, { recursive: true });
  const f = join(dir, '.lock');
  await writeFile(f, text);
  return f;
}

/** A bot's saved state for a network in a data folder: <folder>/<network> with the kit's own file in it. */
async function storeIn(dataDir: string, network = 'mainnet'): Promise<void> {
  await mkdir(join(dataDir, network), { recursive: true });
  await writeFile(join(dataDir, network, 'meta.json'), '{"version":1}\n');
}

/** A key pair as examples/new-keys.ts names it: <dir>/<name>-pha.json and <dir>/<name>-base.json. */
async function keyPair(dir: string, name: string, mark = 'put here by hand'): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}-pha.json`), `{"wif":"${mark}"}\n`, { mode: 0o600 });
  await writeFile(join(dir, `${name}-base.json`), `{"privateKey":"${mark}"}\n`, { mode: 0o600 });
}

/** A new container on the same volume, as at every deploy: the kit's folder has none of its links yet. */
async function newContainer(b: Box): Promise<void> {
  for (const name of ['keys', 'data', 'market.mainnet.json']) await rm(join(b.kit, name), { force: true });
}

/** What a start that was refused may not leave on the volume: the text of a KIT_MARKET_CONFIG, half written. */
const halfWritten = async (b: Box) => (await readdir(b.state)).filter((n) => n.includes('.new.'));

/** A process in the stand-in /proc whose program is `exe`. */
async function processOf(b: Box, pid: number, exe: string): Promise<void> {
  await mkdir(join(b.proc, String(pid)));
  await symlink(exe, join(b.proc, String(pid), 'exe'));
}

/** The market bot's template with one offer: a whole config, its keys and its data folder as the kit ships them. */
async function marketConfig(change: (c: Record<string, unknown>) => void = () => {}): Promise<string> {
  const c = JSON.parse(await readKitFile('examples/market.mainnet.example.json')) as Record<string, unknown>;
  c.offers = [{ symbol: 'TAZ', total: '500', min: '20', max: '100', price: '9.99' }];
  change(c);
  return JSON.stringify(c);
}

describe('docker/entrypoint.sh: the volume', { skip }, () => {
  test('a state folder on the container\'s own disk is refused before anything is made: no key and no state without a volume', async () => {
    const b = await box();
    const r = run(b, [], { FAKE_VOLUME: NOWHERE });
    assert.equal(r.code, 1);
    assert.match(r.err, /is not a volume: it is on the container's own disk/);
    assert.ok(r.err.includes(`Attach a volume with the mount path ${b.state}, then start again.`));
    assert.deepEqual(await calls(b), [], 'start.sh was not run');
    assert.ok(!existsSync(join(b.state, 'keys')) && !existsSync(join(b.kit, 'keys')), 'nothing was made');
  });

  test('what the platform says is not enough: with RAILWAY_VOLUME_MOUNT_PATH set and nothing mounted there, it is refused all the same', async () => {
    const b = await box();
    const r = run(b, [], { FAKE_VOLUME: NOWHERE, KIT_STATE_DIR: '', RAILWAY_VOLUME_MOUNT_PATH: b.state });
    assert.equal(r.code, 1);
    assert.match(r.err, /is not a volume/);
    assert.deepEqual(await calls(b), []);
    assert.ok(!existsSync(join(b.state, 'keys')));
  });

  test('a folder on another device than / is a volume: it starts, in that folder or one inside it, made or still to make; RAILWAY_VOLUME_MOUNT_PATH names it when KIT_STATE_DIR does not', async () => {
    const b = await box();
    const r = run(b, [], { KIT_STATE_DIR: '', RAILWAY_VOLUME_MOUNT_PATH: `${b.state}/` });
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out + r.err, /is not a volume/);
    assert.ok(r.out.includes(`with its keys and state on the volume at ${b.state}.`));
    assert.equal((await calls(b)).at(-1)?.links.keys, join(b.state, 'keys'));
    // KIT_STATE_DIR wins, and a folder inside the volume is on the volume too, also one that is not made yet.
    for (const inside of [join(b.state, 'kit'), join(b.state, 'not', 'made', 'yet')]) {
      if (inside.endsWith('kit')) await mkdir(inside);
      const r2 = run(b, [], { KIT_STATE_DIR: inside, RAILWAY_VOLUME_MOUNT_PATH: '/somewhere/else' });
      assert.equal(r2.code, 0, r2.err);
      assert.equal((await calls(b)).at(-1)?.links.keys, join(inside, 'keys'));
      assert.ok(existsSync(join(inside, 'keys')));
    }
    // A folder that is not made yet, with nothing mounted above it, is no volume.
    const r3 = run(b, [], { FAKE_VOLUME: NOWHERE, KIT_STATE_DIR: join(b.state, 'nor', 'here') });
    assert.equal(r3.code, 1);
    assert.match(r3.err, /is not a volume/);
    assert.ok(!existsSync(join(b.state, 'nor')));
  });

  test('KIT_ALLOW_NO_VOLUME=1 runs devnet\'s examples without one and says where the keys are; on mainnet it is refused, whatever the command', async () => {
    const b = await box();
    const r = run(b, [], { FAKE_VOLUME: NOWHERE, KIT_ALLOW_NO_VOLUME: '1' });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /KIT_ALLOW_NO_VOLUME=1: .* is not a volume\. The keys and the bots' state end with this container\./);
    assert.match(r.out, /with its keys and state in this container only/);
    assert.doesNotMatch(r.out, /on the volume/);
    assert.equal((await calls(b)).length, 1);
    for (const args of [[], ['dry-run'], ['setup'], ['market', '--dry-run']]) {
      const m = run(b, args, { FAKE_VOLUME: NOWHERE, KIT_ALLOW_NO_VOLUME: '1', KIT_NETWORK: 'mainnet' });
      assert.equal(m.code, 1, args.join(' '));
      assert.match(m.err, /KIT_ALLOW_NO_VOLUME=1 is for devnet's test tokens\. On mainnet a key made without a volume is lost/);
    }
    assert.equal((await calls(b)).length, 1, 'no mainnet key is ever made without a volume');
    assert.ok(!existsSync(join(b.state, 'keys', 'mainnet')) && !existsSync(join(b.state, 'market.mainnet.json')));
    // Only 1 says it: whoever sets 0 or false to say no gets no bot whose keys end with the container.
    for (const value of ['0', 'false', 'true', 'yes', ' 1']) {
      const no = run(b, [], { FAKE_VOLUME: NOWHERE, KIT_ALLOW_NO_VOLUME: value });
      assert.equal(no.code, 1, value);
      assert.match(no.err, /is not a volume/, value);
    }
    assert.equal((await calls(b)).length, 1);
    // On a volume the switch changes nothing and says nothing.
    assert.doesNotMatch(run(b, [], { KIT_ALLOW_NO_VOLUME: '1' }).out, /KIT_ALLOW_NO_VOLUME/);
  });

  test('where stat is BSD\'s (no -c), the volume is told from the container\'s disk all the same', async () => {
    const b = await box();
    assert.equal(run(b, [], { FAKE_STAT_BSD: '1' }).code, 0);
    assert.equal((await calls(b)).length, 1);
    const none = run(b, [], { FAKE_STAT_BSD: '1', FAKE_VOLUME: NOWHERE });
    assert.equal(none.code, 1);
    assert.match(none.err, /is not a volume/);
  });

  test('a folder whose device cannot be read is not taken for a volume, and neither is any folder when the device of / cannot be read', async () => {
    const b = await box();
    for (const blind of [b.state, '/']) {
      const r = run(b, [], { FAKE_STAT_BLIND: blind });
      assert.equal(r.code, 1, blind);
      assert.match(r.err, /is not a volume/, blind);
    }
    assert.deepEqual(await calls(b), []);
    assert.ok(!existsSync(join(b.state, 'keys')));
  });

  test('the state folder is an absolute path, not / and not inside the kit\'s folder', async () => {
    const b = await box();
    for (const [dir, why] of [['data', /absolute path/], ['/', /cannot be \//], ['///', /cannot be \//], [join(b.kit, 'state'), /inside the kit's own folder/]] as const) {
      const r = run(b, [], { KIT_STATE_DIR: dir });
      assert.equal(r.code, 1, dir);
      assert.match(r.err, why, dir);
    }
    assert.deepEqual(await calls(b), []);
  });

  test('start.sh\'s own help needs no volume and makes nothing', async () => {
    const b = await box();
    for (const args of [['help'], ['-h'], ['--help'], ['mainnet', 'help']]) {
      const r = run(b, args, { FAKE_VOLUME: NOWHERE });
      assert.equal(r.code, 0, r.err);
      assert.equal(r.out + r.err, '', 'only start.sh speaks');
    }
    const helps = await calls(b);
    assert.deepEqual(helps.map((c) => c.args), [['devnet', 'help'], ['devnet', '-h'], ['devnet', '--help'], ['mainnet', 'help']]);
    assert.ok(helps.every((c) => c.stdinIsDevNull), 'no terminal on its input here either');
    assert.deepEqual(await readdir(b.state), []);
    assert.ok(!existsSync(join(b.kit, 'keys')));
  });
});

describe('docker/entrypoint.sh: the links and start.sh', { skip }, () => {
  test('./keys and ./data are the volume\'s, private; start.sh runs in the kit\'s folder, the network first, with /dev/null on its input', async () => {
    const b = await box();
    const r = run(b);
    assert.equal(r.code, 0, r.err);
    const [c, ...more] = await calls(b);
    assert.ok(c && more.length === 0, 'start.sh ran once');
    assert.deepEqual(c.args, ['devnet']);
    assert.equal(c.cwd, b.kit);
    assert.deepEqual(c.links, { keys: join(b.state, 'keys'), data: join(b.state, 'data'), config: null });
    assert.equal(c.stdinIsTTY, false);
    assert.equal(c.stdinIsDevNull, true, 'no terminal on its input: start.sh asks nothing');
    assert.equal(await modeOf(join(b.state, 'keys')), '700');
    assert.equal(await modeOf(join(b.state, 'data')), '700');
    assert.match(r.out, /Saturn P2P bot kit in a container: devnet, with its keys and state on the volume at /);
    // exec: start.sh takes the entrypoint's place. A shell left between the container's first process and the bots
    // would die on SIGTERM without passing it on, and the bots would be killed in the middle of their trades.
    assert.equal(c.pid, r.pid, 'start.sh runs as the process the entrypoint was');
    // What the entrypoint and start.sh make is for nobody else (umask 077).
    assert.equal(await modeOf(b.record), '600', 'a file start.sh makes');
    assert.equal(await modeOf(join(b.state, '.last-start')), '600');
  });

  test('start.sh\'s exit status is the container\'s (a restart policy acts on it)', async () => {
    const b = await box();
    assert.equal(run(b, [], { FAKE_EXIT: '1' }).code, 1);
    assert.equal(run(b, [], { FAKE_EXIT: '0' }).code, 0);
    assert.equal(run(b, ['dry-run'], { FAKE_EXIT: '1' }).code, 1, 'a dry run that found something to put right ends with an error too');
  });

  test('a second start in the same container finds its own links and leaves them as they are; a link to another place is put right', async () => {
    const b = await box();
    assert.equal(run(b).code, 0);
    const before = (await lstat(join(b.kit, 'keys'))).ino;
    const r = run(b);
    assert.equal(r.code, 0, r.err);
    assert.equal(await readlink(join(b.kit, 'keys')), join(b.state, 'keys'));
    assert.equal((await lstat(join(b.kit, 'keys'))).ino, before, 'the link a running bot reads through is never taken away');
    await rm(join(b.kit, 'data'));
    await symlink('/somewhere/else', join(b.kit, 'data'));
    assert.equal(run(b).code, 0);
    assert.equal(await readlink(join(b.kit, 'data')), join(b.state, 'data'));
    assert.equal((await calls(b)).length, 3);
  });

  test('a keys or data folder inside the image is refused: an image holds no keys and no state', async () => {
    for (const name of ['keys', 'data']) {
      const b = await box();
      await mkdir(join(b.kit, name));
      const r = run(b);
      assert.equal(r.code, 1, name);
      assert.match(r.err, new RegExp(`/${name} is there and is not the volume's`));
      assert.deepEqual(await calls(b), []);
    }
  });

  test('key files copied onto the volume readable by everyone are made private before the kit reads them', async () => {
    const b = await box();
    await mkdir(join(b.state, 'keys', 'mainnet'), { recursive: true });
    const files = [join(b.state, 'keys', 'api-key'), join(b.state, 'keys', 'mainnet', 'market-pha.json')];
    for (const f of files) {
      await writeFile(f, 'x\n');
      await chmod(f, 0o644);
    }
    await chmod(join(b.state, 'keys'), 0o755);
    await chmod(join(b.state, 'keys', 'mainnet'), 0o755);
    // A data folder that came onto the volume open to everyone (a restored copy): the swap secrets are in it.
    await mkdir(join(b.state, 'data'));
    await chmod(join(b.state, 'data'), 0o755);
    assert.equal(run(b, [], { KIT_NETWORK: 'devnet' }).code, 0);
    for (const f of files) assert.equal(await modeOf(f), '600', f);
    assert.equal(await modeOf(join(b.state, 'keys')), '700');
    assert.equal(await modeOf(join(b.state, 'keys', 'mainnet')), '700');
    assert.equal(await modeOf(join(b.state, 'data')), '700');
  });
});

describe('docker/entrypoint.sh: the network and the command', { skip }, () => {
  const argsOf = async (args: string[], extra: Record<string, string> = {}) => {
    const b = await box();
    const r = run(b, args, extra);
    const c = await calls(b);
    return { code: r.code, err: r.err, args: c.at(-1)?.args ?? null };
  };

  test('devnet unless KIT_NETWORK, the first word, --network or the market bot says mainnet; the network always goes first', async () => {
    assert.deepEqual((await argsOf([])).args, ['devnet']);
    assert.deepEqual((await argsOf(['seller', '--dry-run'])).args, ['devnet', 'seller', '--dry-run']);
    assert.deepEqual((await argsOf(['help'], { KIT_NETWORK: 'mainnet' })).args, ['mainnet', 'help']);
    assert.deepEqual((await argsOf(['mainnet', 'help'])).args, ['mainnet', 'help']);
    assert.deepEqual((await argsOf(['--network', 'mainnet', 'help'])).args, ['mainnet', 'help']);
    assert.deepEqual((await argsOf(['--network=devnet', 'dry-run'])).args, ['devnet', 'dry-run']);
    assert.deepEqual((await argsOf(['mainnet', 'help'], { KIT_NETWORK: 'mainnet' })).args, ['mainnet', 'help']);
    assert.deepEqual((await argsOf(['market', '--help'])).args, ['mainnet', 'market', '--help']);
    // With KIT_NETWORK=devnet the market bot stays start.sh's to refuse.
    assert.deepEqual((await argsOf(['market', '--help'], { KIT_NETWORK: 'devnet' })).args, ['devnet', 'market', '--help']);
  });

  test('two networks, or a network that is neither, stop it before start.sh runs', async () => {
    for (const [args, extra, why] of [
      [['devnet'], { KIT_NETWORK: 'mainnet' }, /two networks were named \(mainnet and devnet\)/],
      [['mainnet', 'devnet'], {}, /two networks were named/],
      [[], { KIT_NETWORK: 'testnet' }, /KIT_NETWORK is devnet or mainnet, not "testnet"/],
      [['--network', 'main'], {}, /--network is devnet or mainnet, not "main"/],
      [['--network'], {}, /--network is devnet or mainnet/]
    ] as const) {
      const r = await argsOf([...args], extra);
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.err, why);
      assert.equal(r.args, null, 'start.sh was not run');
    }
  });

  test('KIT_START_ARGS stands for the command when the container gives none: split at blanks, no file name patterns, nothing run', async () => {
    assert.deepEqual((await argsOf([], { KIT_START_ARGS: 'dry-run' })).args, ['devnet', 'dry-run']);
    assert.deepEqual((await argsOf([], { KIT_START_ARGS: '  seller   --dry-run  ' })).args, ['devnet', 'seller', '--dry-run']);
    assert.deepEqual((await argsOf([], { KIT_START_ARGS: 'mainnet help' })).args, ['mainnet', 'help']);
    assert.deepEqual((await argsOf([], { KIT_START_ARGS: 'seller * $(id) `id`' })).args, ['devnet', 'seller', '*', '$(id)', '`id`']);
    // The container's own command wins.
    assert.deepEqual((await argsOf(['buyer'], { KIT_START_ARGS: 'seller' })).args, ['devnet', 'buyer']);
  });

  test('KIT_ALLOW_MAINNET is start.sh\'s own switch: passed on as it is, never set here', async () => {
    const b = await box();
    run(b, ['help']);
    run(b, ['help'], { KIT_ALLOW_MAINNET: '1' });
    assert.deepEqual((await calls(b)).map((c) => c.allowMainnet), [null, '1']);
  });

  test('a network nobody named, on a volume that holds a mainnet bot\'s keys or state, stops the start: a lost variable does not turn the bot into devnet\'s examples', async () => {
    for (const sign of ['market.mainnet.json', 'keys/mainnet', 'data/market/mainnet', 'data/my-bot/mainnet']) {
      const b = await box();
      if (sign.endsWith('.json')) await writeFile(join(b.state, sign), await marketConfig());
      else await mkdir(join(b.state, sign), { recursive: true });
      for (const args of [[], ['dry-run'], ['setup']]) {
        const r = run(b, args);
        assert.equal(r.code, 1, `${sign}: ${args.join(' ')}`);
        assert.match(r.err, /the network is not named, and this volume holds a mainnet bot's keys or state/);
        assert.match(r.err, /Set KIT_NETWORK=mainnet to run that bot, or KIT_NETWORK=devnet/);
      }
      assert.deepEqual(await calls(b), [], sign);
      assert.ok(!existsSync(join(b.state, 'keys', 'seller-pha.json')));
      // Named, either way and by any means, it starts.
      assert.equal(run(b, [], { KIT_NETWORK: 'devnet' }).code, 0);
      assert.equal(run(b, ['devnet']).code, 0);
      assert.equal(run(b, ['seller']).code, 0, 'the seller bot is devnet\'s by its own name');
      assert.deepEqual((await calls(b)).map((c) => c.args), [['devnet'], ['devnet'], ['devnet', 'seller']]);
    }
    // A volume with devnet's bots only is devnet's, named or not.
    const d = await box();
    await mkdir(join(d.state, 'data', 'seller', 'devnet'), { recursive: true });
    assert.equal(run(d).code, 0);
  });

  test('the command line it builds is one the real start.sh takes', async () => {
    const b = await box();
    await copyFile(kitFile('start.sh'), join(b.kit, 'start.sh'));
    // What start.sh looks for before it takes its folder for the kit's.
    await writeFile(join(b.kit, 'package.json'), '{}\n');
    await writeFile(join(b.kit, 'examples', 'seller-bot.ts'), '');
    for (const extra of [{}, { KIT_NETWORK: 'mainnet' }] as Record<string, string>[]) {
      const r = run(b, ['help'], extra);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /sh start\.sh devnet {5}set up, then run the example seller and buyer bots together/);
    }
    assert.deepEqual(await readdir(b.state), [], 'help makes nothing, on mainnet either');
  });
});

describe('docker/entrypoint.sh: locks left by an earlier container', { skip }, () => {
  test('on Railway, which mounts a volume in one container at a time, every lock file of the kit on the volume is a leftover while no Node process runs: removed, wherever the data folder is', async () => {
    for (const how of [{ KIT_STATE_DIR: '', RAILWAY_VOLUME_MOUNT_PATH: '' }, { KIT_CLEAR_LOCKS: '1' }] as Record<string, string>[]) {
      const b = await box();
      if ('RAILWAY_VOLUME_MOUNT_PATH' in how) how.RAILWAY_VOLUME_MOUNT_PATH = b.state;
      const locks = [await lockIn(join(b.state, 'data', 'seller', 'devnet')), await lockIn(join(b.state, 'data', 'buyer', 'devnet'), OWN_LOCK), await lockIn(join(b.state, 'my bot', 'devnet'))];
      await processOf(b, 1, '/usr/bin/tini');
      await processOf(b, 7, '/usr/bin/dash');
      const r = run(b, [], how);
      assert.equal(r.code, 0, r.err);
      for (const f of locks) {
        assert.ok(!existsSync(f), f);
        assert.ok(r.out.includes(`Removed ${f}, the leftover lock of a bot that is gone.`), f);
      }
      assert.doesNotMatch(r.out, /A bot's lock file is on/);
    }
  });

  test('elsewhere nothing says that no other container holds the volume: a lock that names another host is left and named, and KIT_CLEAR_LOCKS=1 is how to say it; this container\'s own leftover is removed all the same', async () => {
    const b = await box();
    const theirs = await lockIn(join(b.state, 'data', 'seller', 'devnet'));
    const mine = await lockIn(join(b.state, 'data', 'buyer', 'devnet'), OWN_LOCK);
    const r = run(b);
    assert.equal(r.code, 0, r.err);
    assert.ok(existsSync(theirs), 'a lock that may be a live bot\'s in another container is never removed unasked');
    assert.ok(r.out.includes(`A bot's lock file is on ${b.state}:\n  ${theirs}\n`));
    assert.match(r.out, /If a bot runs on this volume in another container, leave it\. .* start with KIT_CLEAR_LOCKS=1 where this volume is mounted in one container at a time\./);
    // The same container, started again after a kill: its own lock is a leftover (the kit would take it over itself,
    // but not when another process now has the old bot's id, as happens among a container's few ids).
    assert.ok(!existsSync(mine), 'this container\'s own leftover');
    assert.ok(r.out.includes(`Removed ${mine}, the leftover lock of a bot that is gone.`));
    assert.ok(!r.out.includes(`  ${mine}\n`), 'and it is not named among those left');
    // KIT_CLEAR_LOCKS=0 leaves them all, on Railway too; any other value is refused.
    const again = await lockIn(join(b.state, 'data', 'buyer', 'devnet'), OWN_LOCK);
    assert.equal(run(b, [], { KIT_CLEAR_LOCKS: '0', RAILWAY_VOLUME_MOUNT_PATH: b.state }).code, 0);
    assert.ok(existsSync(theirs) && existsSync(again));
    for (const value of ['yes', ' 1', 'true']) {
      const bad = run(b, [], { KIT_CLEAR_LOCKS: value });
      assert.equal(bad.code, 1);
      assert.ok(bad.err.includes(`KIT_CLEAR_LOCKS is 1 or 0, not "${value}"`));
    }
    // With no lock on the volume there is nothing to say.
    await rm(theirs);
    await rm(again);
    assert.doesNotMatch(run(b).out, /lock/);
  });

  test('while a Node process runs in the container (a bot, a dry run, prune.ts), every lock is left: one of them may be its own', async () => {
    for (const exe of ['/usr/local/bin/node', '/app/.node/bin/node', '/usr/local/bin/node (deleted)']) {
      for (const how of [{ KIT_CLEAR_LOCKS: '1' }, {}] as Record<string, string>[]) {
        const b = await box();
        const f = await lockIn(join(b.state, 'data', 'seller', 'devnet'), OWN_LOCK);
        await processOf(b, 1, '/usr/bin/tini');
        await processOf(b, 88, exe);
        const r = run(b, [], how);
        assert.equal(r.code, 0, r.err);
        assert.ok(existsSync(f), exe);
        assert.match(r.out, /A Node process runs in this container already, so the lock files on .* are left as they are\./);
      }
    }
    // A process whose program cannot be read (another user's) is known by the name it was started under.
    const other = await box();
    const kept = await lockIn(join(other.state, 'data', 'seller', 'devnet'));
    await mkdir(join(other.proc, '41'));
    await writeFile(join(other.proc, '41', 'cmdline'), '/usr/local/bin/node\0--import\0tsx\0examples/seller-bot.ts\0');
    await mkdir(join(other.proc, '2'));
    await writeFile(join(other.proc, '2', 'cmdline'), '');
    assert.equal(run(other, [], { KIT_CLEAR_LOCKS: '1' }).code, 0);
    assert.ok(existsSync(kept), 'a Node known by its command line');
    // Started as plain "node", found on the PATH.
    const bare = await box();
    const keptToo = await lockIn(join(bare.state, 'data', 'seller', 'devnet'));
    await mkdir(join(bare.proc, '41'));
    await writeFile(join(bare.proc, '41', 'cmdline'), 'node\0--import\0tsx\0examples/seller-bot.ts\0');
    assert.equal(run(bare, [], { KIT_CLEAR_LOCKS: '1' }).code, 0);
    assert.ok(existsSync(keptToo), 'a Node started by its bare name');
    // Where there is a /proc (Linux), the real one shows this test's own Node process.
    if (existsSync('/proc/self/exe')) {
      const b = await box();
      const f = await lockIn(join(b.state, 'data', 'seller', 'devnet'));
      const r = run(b, [], { KIT_PROC_DIR: '', KIT_CLEAR_LOCKS: '1' });
      assert.equal(r.code, 0, r.err);
      assert.ok(existsSync(f), 'the real /proc');
      assert.match(r.out, /A Node process runs in this container already/);
    }
  });

  test('a .lock that is not the kit\'s is never touched, and start.sh\'s own help touches none', async () => {
    const b = await box();
    const f = await lockIn(join(b.state, 'data', 'seller', 'devnet'));
    const other = await lockIn(join(b.state, 'data', 'other'), 'held by something else\n');
    const half = await lockIn(join(b.state, 'data', 'half'), '{"nonce":"x"}\n');
    assert.equal(run(b, ['help'], { KIT_CLEAR_LOCKS: '1' }).code, 0);
    assert.ok(existsSync(f), 'help opens no store');
    const r = run(b, [], { KIT_CLEAR_LOCKS: '1' });
    assert.equal(r.code, 0);
    assert.ok(!existsSync(f), 'the kit\'s lock is removed');
    assert.ok(existsSync(other) && existsSync(half), 'the others are kept');
    assert.ok(!r.out.includes(other) && !r.out.includes(half), 'and not spoken of');
  });
});

describe('docker/entrypoint.sh: mainnet, the market bot\'s config on the volume', { skip }, () => {
  test('the first start on a volume runs start.sh\'s own setup, then keeps the keys and the config it made on the volume; later starts make nothing', async () => {
    const b = await box();
    const r = run(b, [], { KIT_NETWORK: 'mainnet' });
    assert.equal(r.code, 0, r.err);
    let c = await calls(b);
    assert.deepEqual(c.map((x) => x.args), [['mainnet', 'setup'], ['mainnet']]);
    assert.equal(c[0]!.stdinIsDevNull, true);
    const config = join(b.state, 'market.mainnet.json');
    assert.deepEqual(c[1]!.links, { keys: join(b.state, 'keys'), data: join(b.state, 'data'), config });
    assert.ok((await lstat(join(b.kit, 'market.mainnet.json'))).isSymbolicLink());
    assert.equal(await readFile(config, 'utf8'), await readKitFile('examples/market.mainnet.example.json'));
    assert.match(await readFile(join(b.state, 'keys', 'mainnet', 'market-pha.json'), 'utf8'), /made by setup/);
    assert.ok(r.out.includes(`In this container the market bot's config is ${config}, on the volume.`));
    assert.equal(await modeOf(config), '600');

    // A new container on the same volume: the kit's folder is new, the volume is not.
    await rm(join(b.kit, 'market.mainnet.json'));
    await rm(join(b.kit, 'keys'));
    await rm(join(b.kit, 'data'));
    await rm(b.record);
    assert.equal(run(b, [], { KIT_NETWORK: 'mainnet' }).code, 0);
    c = await calls(b);
    assert.deepEqual(c.map((x) => x.args), [['mainnet']], 'no setup again');
    assert.equal(c[0]!.links.config, config);
  });

  test('no key pair is made while the yes is given: with KIT_ALLOW_MAINNET=1, a start that would have to make one is refused, whatever the command (a replaced volume, or a copy of the service)', async () => {
    const b = await box();
    const good = await marketConfig();
    for (const args of [[], ['dry-run'], ['setup'], ['market'], ['market', '--dry-run']]) {
      const r = run(b, args, { KIT_NETWORK: 'mainnet', KIT_ALLOW_MAINNET: '1', KIT_MARKET_CONFIG: good });
      assert.equal(r.code, 1, args.join(' '));
      assert.ok(r.err.includes(`this volume has no market.mainnet.json and no market bot's key pair (${join(b.state, 'keys', 'mainnet', 'market-pha.json')} and market-base.json), and KIT_ALLOW_MAINNET=1 is set already: this start would make a new key pair, and none is made while the yes is given.`), r.err);
      assert.match(r.err, /If this bot has run before, its keys are not here: attach the volume that holds them, or put its key files here/);
      assert.match(r.err, /No key was made$/m);
    }
    assert.deepEqual(await calls(b), [], 'start.sh was not run, not for its setup either');
    assert.ok(!existsSync(join(b.state, 'market.mainnet.json')) && !existsSync(join(b.state, 'keys', 'mainnet')), 'the volume is as it was');
    // What matters is whether start.sh's setup would make the pair, and it would for anything but the pair itself.
    const notThePair: [string, (v: Box) => Promise<void>][] = [
      ['an empty keys/mainnet', async (v) => { await mkdir(join(v.state, 'keys', 'mainnet'), { recursive: true }); }],
      ['devnet\'s keys and state', async (v) => { await keyPair(join(v.state, 'keys'), 'seller'); await keyPair(join(v.state, 'keys'), 'buyer'); await storeIn(join(v.state, 'data', 'seller'), 'devnet'); }],
      ['another file in keys/mainnet', async (v) => { await mkdir(join(v.state, 'keys', 'mainnet'), { recursive: true }); await writeFile(join(v.state, 'keys', 'mainnet', 'api-key'), 'x\n'); }],
      ['the pair one folder too deep', async (v) => { await keyPair(join(v.state, 'keys', 'mainnet', 'kit-keys'), 'market'); }],
      ['the pair under other names', async (v) => { await keyPair(join(v.state, 'keys', 'mainnet'), 'bot'); }],
      ['half the pair', async (v) => { await mkdir(join(v.state, 'keys', 'mainnet'), { recursive: true }); await writeFile(join(v.state, 'keys', 'mainnet', 'market-pha.json'), '{"wif":"half"}\n'); }],
      ['keys/mainnet as a link to an empty folder', async (v) => { await mkdir(join(v.state, 'keys')); await mkdir(join(v.state, 'elsewhere')); await symlink(join(v.state, 'elsewhere'), join(v.state, 'keys', 'mainnet')); }],
      ['key files that are links to nothing', async (v) => { await mkdir(join(v.state, 'keys', 'mainnet'), { recursive: true }); for (const f of ['market-pha.json', 'market-base.json']) await symlink(join(v.state, 'gone', f), join(v.state, 'keys', 'mainnet', f)); }]
    ];
    for (const [what, put] of notThePair) {
      const v = await box();
      await put(v);
      const r = run(v, [], { KIT_NETWORK: 'mainnet', KIT_ALLOW_MAINNET: '1' });
      assert.equal(r.code, 1, what);
      assert.match(r.err, /no market bot's key pair/, what);
      assert.deepEqual(await calls(v), [], what);
      assert.ok(!existsSync(join(v.state, 'market.mainnet.json')) && !existsSync(join(v.state, 'elsewhere', 'market-pha.json')), what);
    }
    // Any other value is not the yes (start.sh takes only 1), and without it the first start is the usual one.
    const c = await box();
    assert.equal(run(c, [], { KIT_NETWORK: 'mainnet', KIT_ALLOW_MAINNET: '0' }).code, 0);
    assert.deepEqual((await calls(c)).map((x) => x.args), [['mainnet', 'setup'], ['mainnet']]);
    // Once the volume has its key pair and its config, the yes starts the bot.
    assert.equal(run(c, [], { KIT_NETWORK: 'mainnet', KIT_ALLOW_MAINNET: '1' }).code, 0);
    assert.deepEqual((await calls(c)).at(-1)?.args, ['mainnet']);
    // Both key files on a new volume (a bot that moves here): the setup has nothing to make, so the yes is no
    // obstacle. It writes the config and leaves the keys as they are.
    const d = await box();
    await keyPair(join(d.state, 'keys', 'mainnet'), 'market');
    assert.equal(run(d, [], { KIT_NETWORK: 'mainnet', KIT_ALLOW_MAINNET: '1' }).code, 0);
    assert.deepEqual((await calls(d)).map((x) => x.args), [['mainnet', 'setup'], ['mainnet']]);
    assert.match(await readFile(join(d.state, 'keys', 'mainnet', 'market-pha.json'), 'utf8'), /put here by hand/);
    assert.match(await readFile(join(d.state, 'keys', 'mainnet', 'market-base.json'), 'utf8'), /put here by hand/);
    // So are key files that are links to files kept elsewhere on the volume.
    const l = await box();
    await keyPair(join(l.state, 'kept'), 'market', 'kept elsewhere');
    await mkdir(join(l.state, 'keys', 'mainnet'), { recursive: true });
    for (const f of ['market-pha.json', 'market-base.json']) await symlink(join(l.state, 'kept', f), join(l.state, 'keys', 'mainnet', f));
    assert.equal(run(l, [], { KIT_NETWORK: 'mainnet', KIT_ALLOW_MAINNET: '1' }).code, 0);
    assert.match(await readFile(join(l.state, 'kept', 'market-pha.json'), 'utf8'), /kept elsewhere/);
    // On devnet the switch plays no part.
    const e = await box();
    assert.equal(run(e, [], { KIT_ALLOW_MAINNET: '1' }).code, 0);
    assert.deepEqual((await calls(e)).map((x) => x.args), [['devnet']]);
  });

  test('a bot that comes to a volume with its keys and its state needs nothing made: when both key files that KIT_MARKET_CONFIG names are there, the variable becomes the volume\'s config with no setup, the yes given or not', async () => {
    // Under the names the kit gives them.
    const b = await box();
    const config = join(b.state, 'market.mainnet.json');
    await keyPair(join(b.state, 'keys', 'mainnet'), 'market');
    await storeIn(join(b.state, 'data', 'market'));
    const good = await marketConfig();
    const r = run(b, [], { KIT_NETWORK: 'mainnet', KIT_ALLOW_MAINNET: '1', KIT_MARKET_CONFIG: good });
    assert.equal(r.code, 0, r.err);
    const c = await calls(b);
    assert.deepEqual(c.map((x) => x.args), [['mainnet']], 'no setup: nothing had to be made');
    assert.equal(c[0]!.links.config, config);
    assert.equal(await readFile(config, 'utf8'), `${good}\n`);
    assert.ok(r.out.includes(`Wrote the market bot's config, ${config}, from KIT_MARKET_CONFIG.`));
    assert.match(await readFile(join(b.state, 'keys', 'mainnet', 'market-pha.json'), 'utf8'), /put here by hand/);
    // Under names and in folders of the bot's own, where the kit's setup would never look.
    const own = await marketConfig((x) => { x.keys = { pha: './keys/prod/bot-pha.json', base: './keys/prod/bot-base.json' }; x.dataDir = './data/prod'; });
    for (const yes of ['1', '']) {
      const p = await box();
      await keyPair(join(p.state, 'keys', 'prod'), 'bot');
      await storeIn(join(p.state, 'data', 'prod'));
      const x = run(p, [], { KIT_NETWORK: 'mainnet', KIT_ALLOW_MAINNET: yes, KIT_MARKET_CONFIG: own });
      assert.equal(x.code, 0, x.err);
      assert.deepEqual((await calls(p)).map((y) => y.args), [['mainnet']], 'no setup, so no spare key pair');
      assert.ok(!existsSync(join(p.state, 'keys', 'mainnet')), 'nothing was made');
      assert.equal(await readFile(join(p.state, 'market.mainnet.json'), 'utf8'), `${own}\n`);
    }
    // A variable that names key files of its own which are not there is no such bot, and no new bot either: the
    // setup would make the kit's pair and ask for funds at its addresses, and that config would never use it.
    // Refused before anything is made, the yes given or not.
    const q = await box();
    for (const yes of ['1', '']) {
      const x = run(q, [], { KIT_NETWORK: 'mainnet', KIT_ALLOW_MAINNET: yes, KIT_MARKET_CONFIG: own });
      assert.equal(x.code, 1);
      assert.match(x.err, /the key files that KIT_MARKET_CONFIG names are not on the volume, and they are not the pair a first start makes \(.*\/keys\/mainnet\/market-pha\.json and market-base\.json\)/);
      assert.match(x.err, /No key was made, and no bot was started$/m);
    }
    // One of the kit's two names beside one of the bot's own is not the kit's pair either.
    const mixed = await marketConfig((x) => { x.keys = { pha: './keys/mainnet/market-pha.json', base: './keys/prod/bot-base.json' }; });
    assert.equal(run(q, [], { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: mixed }).code, 1);
    assert.deepEqual(await calls(q), []);
    assert.deepEqual(await halfWritten(q), []);
    assert.ok(!existsSync(join(q.state, 'keys', 'mainnet')) && !existsSync(join(q.state, 'market.mainnet.json')));
    // The pair a first start makes, by another spelling of its place, is that pair.
    const spelled = await marketConfig((x) => { x.keys = { pha: join(q.state, 'keys', 'mainnet', 'market-pha.json'), base: './keys/../keys/mainnet/market-base.json' }; });
    assert.equal(run(q, [], { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: spelled }).code, 0);
    assert.deepEqual((await calls(q)).map((x) => x.args), [['mainnet', 'setup'], ['mainnet']]);
    // One of the two key files is not enough either.
    const h = await box();
    await mkdir(join(h.state, 'keys', 'prod'), { recursive: true });
    await writeFile(join(h.state, 'keys', 'prod', 'bot-pha.json'), '{"wif":"half"}\n');
    assert.equal(run(h, [], { KIT_NETWORK: 'mainnet', KIT_ALLOW_MAINNET: '1', KIT_MARKET_CONFIG: own }).code, 1);
    assert.deepEqual(await calls(h), []);
  });

  test('a setup that ends with an error stops the start, also when it left a config behind: no bot runs after it, and no config reaches the volume', async () => {
    const b = await box();
    const r = run(b, [], { KIT_NETWORK: 'mainnet', FAKE_SETUP_EXIT: '1' });
    assert.equal(r.code, 1);
    assert.deepEqual((await calls(b)).map((x) => x.args), [['mainnet', 'setup']], 'nothing after the setup');
    assert.ok(!existsSync(join(b.state, 'market.mainnet.json')));
    // The next start is a first start again.
    assert.equal(run(b, [], { KIT_NETWORK: 'mainnet' }).code, 0);
    assert.deepEqual((await calls(b)).map((x) => x.args), [['mainnet', 'setup'], ['mainnet', 'setup'], ['mainnet']]);
  });

  test('a variable that cannot be the config stops a first start before anything is made: no key pair, no config, and the same answer at the next start', async () => {
    for (const value of ['{"network": "mainnet", oops', await marketConfig((c) => { c.dataDir = './market-data'; })]) {
      const b = await box();
      for (let i = 0; i < 2; i++) {
        const r = run(b, [], { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: value });
        assert.equal(r.code, 1, value);
        assert.match(r.err, /KIT_MARKET_CONFIG cannot be the market bot's config: /);
      }
      assert.deepEqual(await calls(b), [], 'not even start.sh\'s setup was run');
      assert.ok(!existsSync(join(b.state, 'keys', 'mainnet')) && !existsSync(join(b.state, 'market.mainnet.json')), value);
      assert.deepEqual(await halfWritten(b), []);
    }
    // The same when the saved states decide: one on the volume, in a folder the variable does not name.
    const s = await box();
    await storeIn(join(s.state, 'data', 'prod'));
    const template = await marketConfig();
    for (let i = 0; i < 2; i++) {
      const r = run(s, [], { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: template });
      assert.equal(r.code, 1);
      assert.ok(r.err.includes(`which holds no saved state, while ${join(s.state, 'data', 'prod')} on this volume holds a mainnet bot's`), r.err);
    }
    assert.deepEqual(await calls(s), []);
    assert.ok(!existsSync(join(s.state, 'keys', 'mainnet')) && !existsSync(join(s.state, 'market.mainnet.json')));
  });

  test('something in the config\'s place that is not a file is refused', async () => {
    const b = await box();
    await mkdir(join(b.state, 'market.mainnet.json'));
    const r = run(b, [], { KIT_NETWORK: 'mainnet' });
    assert.equal(r.code, 1);
    assert.match(r.err, /market\.mainnet\.json is there but is not a file: move it away, then start again/);
    assert.deepEqual(await calls(b), []);
  });

  test('KIT_MARKET_CONFIG is written to the volume at each start, whole or not at all', async () => {
    const b = await box();
    const good = await marketConfig();
    const config = join(b.state, 'market.mainnet.json');
    const r = run(b, [], { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: good });
    assert.equal(r.code, 0, r.err);
    assert.equal(await readFile(config, 'utf8'), `${good}\n`);
    assert.ok(r.out.includes(`Wrote the market bot's config, ${config}, from KIT_MARKET_CONFIG.`));
    assert.equal(await modeOf(config), '600');
    assert.deepEqual((await calls(b)).map((x) => x.args), [['mainnet', 'setup'], ['mainnet']], 'the key pair is made first all the same');
    assert.equal(run(b, [], { KIT_NETWORK: 'mainnet' }).code, 0);
    assert.equal(await readFile(config, 'utf8'), `${good}\n`, 'without the variable, the file on the volume is used as it is');
    const onVolume = async () => (await readdir(b.state)).filter((n) => n !== '.last-start').sort();
    assert.deepEqual(await onVolume(), ['data', 'keys', 'market.mainnet.json'], 'no temporary file is left');
    // A config half written by a start that was cut short is cleared away, never used.
    await writeFile(`${config}.new.4242`, '{"network": "mainn');
    assert.equal(run(b, [], { KIT_NETWORK: 'mainnet' }).code, 0);
    assert.deepEqual(await onVolume(), ['data', 'keys', 'market.mainnet.json']);
    assert.equal(await readFile(config, 'utf8'), `${good}\n`);
  });

  test('a KIT_MARKET_CONFIG that is not the whole config, or whose keys or data folder are not the volume\'s, starts no bot and leaves the config on the volume as it was', async () => {
    const b = await box();
    const good = await marketConfig();
    const config = join(b.state, 'market.mainnet.json');
    assert.equal(run(b, [], { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: good }).code, 0);
    const bad: [string, RegExp][] = [
      ['{"network": "mainnet", oops', /it is not JSON/],
      ['[]', /it is not a JSON object/],
      ['"text"', /it is not a JSON object/],
      ['null', /it is not a JSON object/],
      // Only the three lists, as one might paste to "list nothing": no bot could run it, and start.sh would call the volume empty.
      ['{"offers": [], "bids": [], "take": []}', /its "network" is not "mainnet"/],
      [await marketConfig((c) => { c.network = 'devnet'; }), /its "network" is not "mainnet"/],
      [await marketConfig((c) => { delete c.dataDir; }), /it has no "dataDir"/],
      [await marketConfig((c) => { delete c.keys; }), /it has no "keys\.pha"/],
      // A data folder on the container's own disk would end with the container, the swap secrets of running trades with it.
      [await marketConfig((c) => { c.dataDir = './market-data'; }), /its "dataDir" \(\.\/market-data\) is not on the volume/],
      [await marketConfig((c) => { c.dataDir = '/home/me/kit/data/market'; }), /its "dataDir" \(\/home\/me\/kit\/data\/market\) is not on the volume/],
      [await marketConfig((c) => { c.dataDir = './data/../state'; }), /its "dataDir" .* is not on the volume/],
      [await marketConfig((c) => { c.keys = { pha: './market-pha.json', base: './keys/mainnet/market-base.json' }; }), /its "keys\.pha" \(\.\/market-pha\.json\) is not on the volume/],
      // Each of the two key files: a Base key made on the container's disk is lost with whatever was sent to it.
      [await marketConfig((c) => { c.keys = { pha: './keys/mainnet/market-pha.json', base: '/tmp/market-base.json' }; }), /its "keys\.base" \(\/tmp\/market-base\.json\) is not on the volume/],
      [await marketConfig((c) => { c.keys = { pha: './keys/mainnet/market-pha.json' }; }), /it has no "keys\.base"/],
      // A folder beside the volume whose name only begins like the volume's.
      [await marketConfig((c) => { c.dataDir = `${b.state}-old/market`; }), /its "dataDir" \(.*-old\/market\) is not on the volume/],
      [await marketConfig((c) => { c.apiKeyFile = '/root/api-key'; }), /its "apiKeyFile" \(\/root\/api-key\) is not on the volume/]
    ];
    for (const [value, why] of bad) {
      await rm(b.record, { force: true });
      const x = run(b, [], { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: value, KIT_ALLOW_MAINNET: '1' });
      assert.equal(x.code, 1, value);
      assert.match(x.err, /KIT_MARKET_CONFIG cannot be the market bot's config: /);
      assert.match(x.err, why, value);
      assert.match(x.err, /The config on the volume was left as it was, and no bot was started\./);
      assert.equal(await readFile(config, 'utf8'), `${good}\n`, 'left as it was');
      assert.deepEqual(await calls(b), [], 'the bot is not started on a config that was not meant');
      // The refused text may hold an RPC address with a provider's key: it does not stay on the volume.
      assert.deepEqual(await halfWritten(b), [], value);
    }
    // Paths on the volume by another name are the volume's too.
    for (const fine of [await marketConfig((c) => { c.dataDir = join(b.state, 'data', 'market'); c.apiKeyFile = './keys/api-key'; }), await marketConfig((c) => { c.dataDir = './data/other'; c.apiKeyFile = null; })]) {
      assert.equal(run(b, [], { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: fine }).code, 0, fine);
      assert.equal(await readFile(config, 'utf8'), `${fine}\n`);
    }
  });

  test('a config put on the volume by hand is held to the same: a data folder that is not the volume\'s starts no bot', async () => {
    const b = await box();
    await mkdir(join(b.state, 'keys', 'mainnet'), { recursive: true });
    const config = join(b.state, 'market.mainnet.json');
    await writeFile(config, await marketConfig((c) => { c.dataDir = './state'; }));
    const r = run(b, [], { KIT_NETWORK: 'mainnet' });
    assert.equal(r.code, 1);
    assert.ok(r.err.includes(`the market bot's config, ${config}, cannot be used here: its "dataDir" (./state) is not on the volume`));
    assert.deepEqual(await calls(b), []);
  });

  test('the default config by any of its names is the default config, as start.sh reads the options: an empty --config, the file\'s own name, its place on the volume', async () => {
    const forms = (b: Box) => [['market', '--config='], ['market', '--config', ''], ['market', '--config', 'market.mainnet.json'], ['market', '--config=./market.mainnet.json', '--dry-run'], ['market', '--config', join(b.kit, 'market.mainnet.json')], ['market', '--config', join(b.state, 'market.mainnet.json')]];
    for (let i = 0; i < 6; i++) {
      const b = await box();
      const args = forms(b)[i]!;
      const good = await marketConfig();
      const r = run(b, args, { KIT_MARKET_CONFIG: good });
      assert.equal(r.code, 0, `${args.join(' ')}: ${r.err}`);
      const c = await calls(b);
      assert.deepEqual(c.map((x) => x.args), [['mainnet', 'setup'], ['mainnet', ...args]], args.join(' '));
      assert.equal(c[1]!.links.config, join(b.state, 'market.mainnet.json'), 'the kit\'s folder has the volume\'s config');
      assert.equal(await readFile(join(b.state, 'market.mainnet.json'), 'utf8'), `${good}\n`);
      assert.doesNotMatch(r.out, /KIT_MARKET_CONFIG is not used/);
    }
  });

  test('a command with a config of its own still finds the volume\'s market.mainnet.json where the kit\'s folder has it', async () => {
    const b = await box();
    assert.equal(run(b, [], { KIT_NETWORK: 'mainnet' }).code, 0);
    await rm(join(b.kit, 'market.mainnet.json'));
    const own = join(b.state, 'other.json');
    await writeFile(own, await marketConfig((c) => { c.dataDir = './data/other'; }));
    assert.equal(run(b, ['market', '--config', own]).code, 0);
    assert.equal(run(b, ['mainnet', 'seller']).code, 0);
    const c = await calls(b);
    assert.deepEqual(c.slice(-2).map((x) => x.links.config), [join(b.state, 'market.mainnet.json'), join(b.state, 'market.mainnet.json')]);
  });

  test('KIT_MARKET_CONFIG cannot move the bot away from its saved state: start.sh looks for open offers and trades only where the config says, so another dataDir is refused while the old folder holds a mainnet bot\'s state', async () => {
    const b = await box();
    const config = join(b.state, 'market.mainnet.json');
    const here = join(b.state, 'data', 'market');
    const there = join(b.state, 'data', 'market2');
    const moved = await marketConfig((c) => { c.dataDir = './data/market2'; c.offers = []; });
    // Before the bot has saved anything, the data folder is still free to choose, and to choose again. A store's
    // folder with nothing in it holds nothing.
    assert.equal(run(b, [], { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: moved }).code, 0);
    const first = await marketConfig();
    assert.equal(run(b, [], { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: first }).code, 0);
    await mkdir(join(here, 'mainnet'), { recursive: true });
    assert.equal(run(b, [], { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: moved }).code, 0, 'an empty folder is no saved state');
    assert.equal(run(b, [], { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: first }).code, 0);
    // The bot has run with ./data/market. A config that lists nothing and names another folder (pasted to stop the
    // bot for good) would have start.sh call the bot idle while its trades wait in the old one. In a new
    // container, as at every deploy.
    await storeIn(here);
    await newContainer(b);
    await rm(b.record);
    const r = run(b, [], { KIT_NETWORK: 'mainnet', KIT_ALLOW_MAINNET: '1', KIT_MARKET_CONFIG: moved });
    assert.equal(r.code, 1);
    assert.ok(r.err.includes(`KIT_MARKET_CONFIG cannot be the market bot's config: its "dataDir" is ${there}, and the config it replaces has ${here}, which holds a market bot's saved state: offers and trades that are still open there would not be looked at`), r.err);
    assert.match(r.err, /The config on the volume was left as it was, and no bot was started\./);
    assert.equal(await readFile(config, 'utf8'), `${first}\n`);
    assert.deepEqual(await calls(b), []);
    assert.deepEqual(await halfWritten(b), [], 'the refused text is not left on the volume');
    // Also when the other folder holds a state of its own: the config on the volume says which one the bot uses.
    await storeIn(there);
    assert.equal(run(b, [], { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: moved }).code, 1);
    await rm(there, { recursive: true });
    // The same folder by another name is the same folder.
    const sameByName = await marketConfig((c) => { c.dataDir = here; });
    assert.equal(run(b, [], { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: sameByName }).code, 0);
    assert.doesNotMatch(run(b, [], { KIT_NETWORK: 'mainnet' }).out, /Note: /, 'the config\'s own data folder');
    // On purpose it can be done: the config put on the volume as a file. The start then says what it leaves behind.
    await writeFile(config, moved);
    const byHand = run(b, [], { KIT_NETWORK: 'mainnet' });
    assert.equal(byHand.code, 0, byHand.err);
    assert.ok(byHand.out.includes(`Note: ${here} holds a mainnet bot's state, and this config's dataDir is another folder.`));
    assert.match(byHand.out, /Offers and trades still open there are not looked at, and not finished, by this start\./);
  });

  test('the same for a data folder with a name of its own, wherever on the volume it is; and with no config to compare with, the saved states on the volume decide', async () => {
    // A data folder of the bot's own, not under ./data.
    const b = await box();
    const config = join(b.state, 'market.mainnet.json');
    const mine = join(b.state, 'bot1');
    const first = await marketConfig((c) => { c.dataDir = mine; });
    assert.equal(run(b, [], { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: first }).code, 0);
    await storeIn(mine);
    await newContainer(b);
    await rm(b.record);
    const template = await marketConfig((c) => { c.offers = []; });
    const r = run(b, [], { KIT_NETWORK: 'mainnet', KIT_ALLOW_MAINNET: '1', KIT_MARKET_CONFIG: template });
    assert.equal(r.code, 1);
    assert.ok(r.err.includes(`its "dataDir" is ${join(b.state, 'data', 'market')}, and the config it replaces has ${mine}, which holds a market bot's saved state`), r.err);
    assert.deepEqual(await calls(b), []);
    // Put there by hand, the start names the state it leaves behind, wherever on the volume that is.
    await writeFile(config, template);
    const byHand = run(b, [], { KIT_NETWORK: 'mainnet' });
    assert.equal(byHand.code, 0, byHand.err);
    assert.ok(byHand.out.includes(`Note: ${mine} holds a mainnet bot's state, and this config's dataDir is another folder.`), byHand.out);
    // The keys' folder is never taken for a bot's state, and devnet's states are not mainnet's.
    await storeIn(join(b.state, 'data', 'seller'), 'devnet');
    const quiet = run(b, [], { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: first });
    assert.equal(quiet.code, 0, quiet.err);
    assert.doesNotMatch(quiet.out, /Note: /);

    // The config on the volume cannot be read (an edit that went wrong): nothing to compare with, so the saved
    // states decide. One in a folder the new config does not name, while its own folder holds none, stops it.
    const u = await box();
    assert.equal(run(u, [], { KIT_NETWORK: 'mainnet' }).code, 0);
    await storeIn(join(u.state, 'data', 'market'));
    await writeFile(join(u.state, 'market.mainnet.json'), '{"network": "mainnet", "offers": [,]}');
    await newContainer(u);
    await rm(u.record);
    const other = await marketConfig((c) => { c.dataDir = './data/other'; c.offers = []; });
    const x = run(u, [], { KIT_NETWORK: 'mainnet', KIT_ALLOW_MAINNET: '1', KIT_MARKET_CONFIG: other });
    assert.equal(x.code, 1);
    assert.ok(x.err.includes(`KIT_MARKET_CONFIG cannot be the market bot's config: its "dataDir" is ${join(u.state, 'data', 'other')}, which holds no saved state, while ${join(u.state, 'data', 'market')} on this volume holds a mainnet bot's: offers and trades that are still open there would not be looked at`), x.err);
    assert.deepEqual(await calls(u), []);
    assert.deepEqual(await halfWritten(u), []);
    // The variable that names the folder with the state puts the config right.
    const good = await marketConfig();
    assert.equal(run(u, [], { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: good }).code, 0);
    assert.equal(await readFile(join(u.state, 'market.mainnet.json'), 'utf8'), `${good}\n`);

    // No config on the volume at all (a bot that moved here with its keys), its state in ./data/prod, and a
    // pasted template, which names ./data/market: the same.
    const m = await box();
    await keyPair(join(m.state, 'keys', 'mainnet'), 'market');
    await storeIn(join(m.state, 'data', 'prod'));
    const y = run(m, [], { KIT_NETWORK: 'mainnet', KIT_ALLOW_MAINNET: '1', KIT_MARKET_CONFIG: template });
    assert.equal(y.code, 1);
    assert.ok(y.err.includes(`which holds no saved state, while ${join(m.state, 'data', 'prod')} on this volume holds a mainnet bot's`), y.err);
    assert.deepEqual(await calls(m), []);
    assert.ok(!existsSync(join(m.state, 'market.mainnet.json')), 'no config was put on the volume');
    assert.deepEqual(await halfWritten(m), []);
    // Named, it starts, also beside a state that a first dry run left in ./data/market.
    await storeIn(join(m.state, 'data', 'market'));
    const prod = await marketConfig((c) => { c.dataDir = './data/prod'; });
    const z = run(m, [], { KIT_NETWORK: 'mainnet', KIT_ALLOW_MAINNET: '1', KIT_MARKET_CONFIG: prod });
    assert.equal(z.code, 0, z.err);
    assert.deepEqual((await calls(m)).map((c) => c.args), [['mainnet']]);
    assert.ok(z.out.includes(`Note: ${join(m.state, 'data', 'market')} holds a mainnet bot's state`), 'and says what it does not look at');

    // The config that this very start's setup made is not "the config it replaces": a first start with the
    // variable, on a volume where the template's ./data/market holds a state and the variable names the bot's own.
    const n = await box();
    await storeIn(join(n.state, 'data', 'market'));
    await storeIn(join(n.state, 'data', 'prod'));
    const w = run(n, [], { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: prod });
    assert.equal(w.code, 0, w.err);
    assert.deepEqual((await calls(n)).map((c) => c.args), [['mainnet', 'setup'], ['mainnet']]);
    assert.equal(await readFile(join(n.state, 'market.mainnet.json'), 'utf8'), `${prod}\n`);
  });

  test('a first start writes no config beside a saved state that config would not look at: a bot that came to the volume without its config is refused until it has one', async () => {
    const b = await box();
    await keyPair(join(b.state, 'keys', 'mainnet'), 'market');
    await storeIn(join(b.state, 'data', 'old'));
    // No variable, as in the guide's first step, the yes given or not: the template would name ./data/market.
    for (const yes of ['', '1']) {
      const r = run(b, [], { KIT_NETWORK: 'mainnet', KIT_ALLOW_MAINNET: yes });
      assert.equal(r.code, 1);
      assert.ok(r.err.includes(`this volume has no market.mainnet.json, and ${join(b.state, 'data', 'old')} on it holds a mainnet bot's saved state: the config a first start writes names another data folder (${join(b.state, 'data', 'market')})`), r.err);
      assert.match(r.err, /Give the bot its config: KIT_MARKET_CONFIG with that folder as its "dataDir", or its market\.mainnet\.json on the volume\. No key was made, and no bot was started$/m);
    }
    assert.deepEqual(await calls(b), []);
    assert.ok(!existsSync(join(b.state, 'market.mainnet.json')), 'no template was put on the volume');
    // The variable that names the bot's folder is its config.
    const named = await marketConfig((c) => { c.dataDir = './data/old'; });
    assert.equal(run(b, [], { KIT_NETWORK: 'mainnet', KIT_ALLOW_MAINNET: '1', KIT_MARKET_CONFIG: named }).code, 0);
    assert.deepEqual((await calls(b)).map((x) => x.args), [['mainnet']]);
    // And from then on the variable cannot take the bot elsewhere, in one start or in several.
    for (const dir of ['./data/market', './data/third', './data/market']) {
      const x = run(b, [], { KIT_NETWORK: 'mainnet', KIT_ALLOW_MAINNET: '1', KIT_MARKET_CONFIG: await marketConfig((c) => { c.dataDir = dir; }) });
      assert.equal(x.code, 1, dir);
    }
    assert.equal((await calls(b)).length, 1);
    assert.equal(await readFile(join(b.state, 'market.mainnet.json'), 'utf8'), `${named}\n`);
    // With the state in the template's own folder a first start is the usual one: the setup makes nothing new.
    const t = await box();
    await keyPair(join(t.state, 'keys', 'mainnet'), 'market');
    await storeIn(join(t.state, 'data', 'market'));
    assert.equal(run(t, [], { KIT_NETWORK: 'mainnet', KIT_ALLOW_MAINNET: '1' }).code, 0);
    assert.deepEqual((await calls(t)).map((x) => x.args), [['mainnet', 'setup'], ['mainnet']]);
    // And so is a new bot's, on a volume that holds no state at all.
    const n = await box();
    assert.equal(run(n, [], { KIT_NETWORK: 'mainnet' }).code, 0);
    assert.deepEqual((await calls(n)).map((x) => x.args), [['mainnet', 'setup'], ['mainnet']]);
  });

  test('with a config on the volume whose data folder holds no state: the variable may name that same folder (the choice was made with the file, and the start says what it leaves behind), but no third one while another folder holds a state', async () => {
    const b = await box();
    const config = join(b.state, 'market.mainnet.json');
    assert.equal(run(b, [], { KIT_NETWORK: 'mainnet' }).code, 0);
    await storeIn(join(b.state, 'data', 'market'));
    // The way to move on purpose: the config as a file, naming a new folder. The variable may then say the same.
    const fresh = await marketConfig((c) => { c.dataDir = './data/new'; });
    await writeFile(config, fresh);
    const same = run(b, [], { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: fresh });
    assert.equal(same.code, 0, same.err);
    assert.ok(same.out.includes(`Wrote the market bot's config, ${config}, from KIT_MARKET_CONFIG.`));
    assert.ok(same.out.includes(`Note: ${join(b.state, 'data', 'market')} holds a mainnet bot's state, and this config's dataDir is another folder.`));
    // A third folder, also without a state: the variable is not the way to it.
    await rm(b.record);
    const third = run(b, [], { KIT_NETWORK: 'mainnet', KIT_ALLOW_MAINNET: '1', KIT_MARKET_CONFIG: await marketConfig((c) => { c.dataDir = './data/third'; }) });
    assert.equal(third.code, 1);
    assert.ok(third.err.includes(`its "dataDir" is ${join(b.state, 'data', 'third')}, which holds no saved state, while ${join(b.state, 'data', 'market')} on this volume holds a mainnet bot's`), third.err);
    assert.match(third.err, /remove KIT_MARKET_CONFIG\. The config on the volume was left as it was, and no bot was started\.$/m);
    assert.doesNotMatch(third.err, /Paste the whole config/, 'the template\'s dataDir is not the advice here');
    assert.deepEqual(await calls(b), []);
    assert.equal(await readFile(config, 'utf8'), `${fresh}\n`);
    // Back to the folder that holds the state: always.
    assert.equal(run(b, [], { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: await marketConfig() }).code, 0);
  });

  test('a saved state is the kit\'s own: a folder that is only named mainnet is none (a copy of the keys, for one), a state behind a link is one, and the volume may itself be reached through a link', async () => {
    const b = await box();
    assert.equal(run(b, [], { KIT_NETWORK: 'mainnet' }).code, 0);
    await keyPair(join(b.state, 'kit-keys', 'mainnet'), 'market', 'a copy of the keys');
    await mkdir(join(b.state, 'notes', 'mainnet'), { recursive: true });
    await writeFile(join(b.state, 'notes', 'mainnet', 'readme.txt'), 'x\n');
    await mkdir(join(b.state, 'data', 'market', 'mainnet'), { recursive: true });
    await writeFile(join(b.state, 'data', 'market', 'mainnet', '.lock'), LOCK);
    const other = await marketConfig((c) => { c.dataDir = './data/other'; });
    const r = run(b, [], { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: other, KIT_CLEAR_LOCKS: '0' });
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out, /Note: /, 'none of them is a bot\'s saved state');
    // A state whose mainnet folder is a link to where it is kept.
    await storeIn(join(b.state, 'kept'));
    await mkdir(join(b.state, 'data', 'other'), { recursive: true });
    await symlink(join(b.state, 'kept', 'mainnet'), join(b.state, 'data', 'other', 'mainnet'));
    await rm(b.record);
    const x = run(b, [], { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: await marketConfig((c) => { c.dataDir = './data/third'; }) });
    assert.equal(x.code, 1);
    assert.ok(x.err.includes(`and the config it replaces has ${join(b.state, 'data', 'other')}, which holds a market bot's saved state`), x.err);
    assert.deepEqual(await calls(b), []);
    // The volume's folder given as a link to it: the states on it are found all the same.
    const v = await box();
    const link = join(v.kit, '..', 'the-volume');
    await symlink(v.state, link);
    await keyPair(join(v.state, 'keys', 'mainnet'), 'market');
    await storeIn(join(v.state, 'data', 'old'));
    const y = run(v, [], { KIT_NETWORK: 'mainnet', KIT_STATE_DIR: link, FAKE_VOLUME: link, KIT_MARKET_CONFIG: await marketConfig() });
    assert.equal(y.code, 1);
    assert.ok(y.err.includes(`which holds no saved state, while ${join(v.state, 'data', 'old')} on this volume holds a mainnet bot's`), y.err);
    const z = run(v, [], { KIT_NETWORK: 'mainnet', KIT_STATE_DIR: link, FAKE_VOLUME: link, KIT_MARKET_CONFIG: await marketConfig((c) => { c.dataDir = './data/old'; }) });
    assert.equal(z.code, 0, z.err);
    assert.equal((await calls(v)).at(-1)?.links.keys, join(v.state, 'keys'), 'the kit\'s links lead to the volume itself');
  });

  test('a path that leaves the volume through a link on it is not the volume\'s; KIT_STORE_KEY_FILE must be the volume\'s too', async () => {
    const b = await box();
    assert.equal(run(b, [], { KIT_NETWORK: 'mainnet' }).code, 0);
    const outside = join(b.kit, '..', 'outside');
    await mkdir(outside);
    await symlink(outside, join(b.state, 'data', 'off'));
    await rm(b.record);
    const r = run(b, [], { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: await marketConfig((c) => { c.dataDir = './data/off/market'; }) });
    assert.equal(r.code, 1);
    assert.match(r.err, /its "dataDir" \(\.\/data\/off\/market\) is not on the volume/);
    assert.deepEqual(await calls(b), []);
    // The key that seals a bot's state: lost with the container, the state could not be read again.
    for (const key of ['/root/store.key', './store.key', join(b.kit, 'store.key'), './data/off/store.key']) {
      const x = run(b, [], { KIT_NETWORK: 'devnet', KIT_STORE_KEY_FILE: key });
      assert.equal(x.code, 1, key);
      assert.ok(x.err.includes(`KIT_STORE_KEY_FILE (${key}) is not on the volume`), key);
    }
    assert.deepEqual(await calls(b), []);
    for (const key of ['./keys/store.key', join(b.state, 'keys', 'store.key'), join(b.state, 'store.key')]) assert.equal(run(b, [], { KIT_NETWORK: 'devnet', KIT_STORE_KEY_FILE: key }).code, 0, key);
  });

  test('only a command that runs the market bot on market.mainnet.json makes the key pair and the config: not its help, not a config of its own, not a command start.sh refuses', async () => {
    const b = await box();
    const own = join(b.state, 'other.json');
    await writeFile(own, await marketConfig((c) => { c.dataDir = './data/other'; }));
    const r = run(b, ['market', '--config', own, '--dry-run'], { KIT_MARKET_CONFIG: await marketConfig() });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /KIT_MARKET_CONFIG is not used: this command does not run the market bot on market\.mainnet\.json\./);
    assert.equal(run(b, ['market', `--config=${own}`]).code, 0);
    assert.equal(run(b, ['market', '--help']).code, 0);
    assert.equal(run(b, ['market', '--dry-run', '-h']).code, 0);
    assert.equal(run(b, ['mainnet', 'seller']).code, 0);
    assert.equal(run(b, ['mainnet', 'faucet']).code, 0);
    assert.deepEqual((await calls(b)).map((x) => x.args), [['mainnet', 'market', '--config', own, '--dry-run'], ['mainnet', 'market', `--config=${own}`], ['mainnet', 'market', '--help'], ['mainnet', 'market', '--dry-run', '-h'], ['mainnet', 'seller'], ['mainnet', 'faucet']]);
    assert.ok(!existsSync(join(b.state, 'market.mainnet.json')) && !existsSync(join(b.state, 'keys', 'mainnet')), 'nothing was made');
    // The commands that do: none at all, start.sh's words for a start, dry-run, setup, and the market bot by name.
    for (const args of [[], ['demo'], ['start'], ['run'], ['dry-run'], ['dryrun'], ['setup'], ['market'], ['market', '--dry-run']]) {
      const c = await box();
      assert.equal(run(c, args, { KIT_NETWORK: 'mainnet' }).code, 0, args.join(' '));
      assert.deepEqual((await calls(c)).map((x) => x.args), [['mainnet', 'setup'], ['mainnet', ...args]]);
    }
  });

  test('a config the command names is held to the volume too, for any bot: its data folder on the container\'s own disk starts no bot', async () => {
    const b = await box();
    const seller = join(b.state, 'my-seller.json');
    await writeFile(seller, JSON.stringify({ network: 'devnet', keys: { pha: './keys/seller-pha.json', base: './keys/seller-base.json' }, dataDir: './state' }));
    for (const args of [['seller', '--config', seller], ['seller', `--config=${seller}`, '--dry-run'], ['market', '--config', seller]]) {
      const r = run(b, args);
      assert.equal(r.code, 1, args.join(' '));
      assert.ok(r.err.includes(`the config ${seller} cannot be used here: its "dataDir" (./state) is not on the volume`));
    }
    assert.deepEqual(await calls(b), []);
    await writeFile(seller, JSON.stringify({ network: 'devnet', keys: { pha: './keys/seller-pha.json', base: './keys/seller-base.json' }, dataDir: './data/seller' }));
    assert.equal(run(b, ['seller', '--config', seller]).code, 0);
    // A config that is not there is start.sh's to refuse, in its own words.
    assert.equal(run(b, ['seller', '--config', join(b.state, 'none.json')]).code, 0);
    assert.equal((await calls(b)).length, 2);
  });

  test('a config in the image is refused; the template a first start left in the container when it was cut short is not taken for one', async () => {
    const b = await box();
    await writeFile(join(b.kit, 'market.mainnet.json'), await marketConfig());
    const r = run(b, [], { KIT_NETWORK: 'mainnet' });
    assert.equal(r.code, 1);
    assert.match(r.err, /market\.mainnet\.json is in the image/);
    assert.deepEqual(await calls(b), []);
    // start.sh's setup wrote the template into the container, and the container was stopped before it reached the volume.
    await copyFile(kitFile('examples/market.mainnet.example.json'), join(b.kit, 'market.mainnet.json'));
    assert.equal(run(b, [], { KIT_NETWORK: 'mainnet' }).code, 0);
    assert.deepEqual((await calls(b)).map((x) => x.args), [['mainnet', 'setup'], ['mainnet']]);
    assert.ok((await lstat(join(b.kit, 'market.mainnet.json'))).isSymbolicLink());
    assert.ok(existsSync(join(b.state, 'market.mainnet.json')));
  });

  test('on devnet none of this happens', async () => {
    const b = await box();
    assert.equal(run(b, [], { KIT_MARKET_CONFIG: await marketConfig() }).code, 0);
    assert.deepEqual((await calls(b)).map((x) => x.args), [['devnet']]);
    assert.ok(!existsSync(join(b.state, 'market.mainnet.json')) && !existsSync(join(b.kit, 'market.mainnet.json')));
  });
});

describe('docker/entrypoint.sh: KIT_HOLD=1', { skip }, () => {
  /**
   * The entrypoint on hold, in a process group of its own: resolves with what it printed once it waits, and a way
   * to end it. When the test ends, however it ends, the whole group is killed: a failed assertion leaves no shell
   * and no sleep behind that would keep the test run from ending.
   */
  async function hold(t: TestContext, b: Box, extra: Record<string, string> = {}) {
    await rm(b.sleeps, { force: true });
    const child = spawn('sh', [b.entrypoint], { env: envOf(b, { KIT_HOLD: '1', FAKE_SLEEP_REAL: '1', ...extra }), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    const ended = new Promise<number | null>((res) => child.on('exit', (code) => res(code)));
    const group = child.pid;
    if (group !== undefined) groups.add(group);
    t.after(() => {
      try {
        if (group !== undefined) process.kill(-group, 'SIGKILL');
      } catch { /* the group has ended already */ }
      if (group !== undefined) groups.delete(group);
      child.stdout.destroy();
      child.stderr.destroy();
    });
    // The last thing it does before it waits is start its sleep, which the stand-in notes.
    const deadline = Date.now() + 15_000;
    while (child.exitCode === null && !(/Remove KIT_HOLD and deploy again/.test(out) && (await sleepsOf(b)).length > 0) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 50));
    return { child, text: () => out, end: async () => { child.kill('SIGTERM'); return ended; } };
  }

  test('starts no bot, keeps running for a shell, and ends at once on SIGTERM with exit 0', { timeout: 30_000 }, async (t) => {
    const b = await box();
    const f = await lockIn(join(b.state, 'data', 'seller', 'devnet'));
    const h = await hold(t, b, { KIT_CLEAR_LOCKS: '1' });
    assert.match(h.text(), /KIT_HOLD=1: no bot is started, and none sends a lock, a claim or a refund while it is set\. The container keeps running/);
    assert.equal(h.child.exitCode, null, 'it keeps running');
    assert.deepEqual(await calls(b), [], 'start.sh was not run');
    assert.equal(await readlink(join(b.kit, 'keys')), join(b.state, 'keys'), 'the links are there for the shell');
    assert.ok(!existsSync(join(b.kit, 'market.mainnet.json')) && !existsSync(join(b.state, 'market.mainnet.json')), 'no setup: no key and no config are made on hold');
    assert.ok(!existsSync(f), 'leftover locks are removed all the same');
    assert.ok(!existsSync(join(b.state, '.last-start')), 'a hold is not a start');
    assert.equal((await sleepsOf(b))[0], '15', 'short naps: a sleep the signal missed ends by itself soon');
    const at = Date.now();
    assert.equal(await h.end(), 0);
    assert.ok(Date.now() - at < 5_000);
  });

  test('the hold outlasts its naps: it ends only when it is told to', { timeout: 30_000 }, async (t) => {
    const b = await box();
    // A sleep that returns at once: nap after nap.
    const h = await hold(t, b, { FAKE_SLEEP_REAL: '' });
    const deadline = Date.now() + 10_000;
    while ((await sleepsOf(b)).length < 5 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok((await sleepsOf(b)).length >= 5, 'it napped again and again');
    assert.equal(h.child.exitCode, null, 'and still holds');
    assert.deepEqual(await calls(b), []);
    assert.equal(await h.end(), 0);
  });

  test('on mainnet the shell\'s dry run reads the config the next start will run: KIT_MARKET_CONFIG is written on hold too, a bad one only named; never onto a volume that has had no first start, which would leave the bot without its key pair', { timeout: 60_000 }, async (t) => {
    const b = await box();
    const config = join(b.state, 'market.mainnet.json');
    // With the yes set as well: a hold makes nothing and refuses nothing.
    const fresh = await hold(t, b, { KIT_NETWORK: 'mainnet', KIT_ALLOW_MAINNET: '1', KIT_MARKET_CONFIG: await marketConfig() });
    assert.match(fresh.text(), /KIT_MARKET_CONFIG is not written yet: this volume has no market\.mainnet\.json of a first start\./);
    assert.match(fresh.text(), /There is no market\.mainnet\.json on the volume yet\. A start without KIT_HOLD makes it, and the market bot's key pair with it, though not while KIT_ALLOW_MAINNET=1 is set: no key pair is made under a yes\./);
    assert.match(fresh.text(), /A key pair made in this shell \(sh start\.sh mainnet setup\) is on the volume, and the config that command writes stays in this container\./);
    assert.equal(fresh.child.exitCode, null);
    assert.equal(await fresh.end(), 0);
    assert.ok(!existsSync(config), 'the first start still finds no config, and so makes the key pair');
    assert.ok(!existsSync(join(b.state, 'keys', 'mainnet')), 'a hold makes no key: a key pair can be put there first');
    // The first start, then a hold with a changed config.
    assert.equal(run(b, [], { KIT_NETWORK: 'mainnet' }).code, 0);
    assert.ok(existsSync(join(b.state, 'keys', 'mainnet', 'market-pha.json')));
    const next = await marketConfig();
    const h = await hold(t, b, { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: next });
    assert.ok(h.text().includes(`Wrote the market bot's config, ${config}, from KIT_MARKET_CONFIG.`));
    assert.equal(await readFile(config, 'utf8'), `${next}\n`);
    assert.equal(await readlink(join(b.kit, 'market.mainnet.json')), config);
    assert.equal(await h.end(), 0);

    const bad = await hold(t, b, { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: '{"offers": []}' });
    assert.match(bad.text(), /KIT_MARKET_CONFIG cannot be the market bot's config: its "network" is not "mainnet"\. Paste the whole config, .* The config on the volume was left as it was\./);
    assert.equal(bad.child.exitCode, null, 'the shell is still to be had');
    assert.equal(await readFile(config, 'utf8'), `${next}\n`);
    assert.equal(await bad.end(), 0);

    // A config that would move the bot away from its saved state is only named as well.
    await storeIn(join(b.state, 'data', 'market'));
    const away = await hold(t, b, { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: await marketConfig((c) => { c.dataDir = './data/market2'; }) });
    assert.match(away.text(), /KIT_MARKET_CONFIG cannot be the market bot's config: its "dataDir" is .*\/data\/market2, and the config it replaces has .*\/data\/market, which holds a market bot's saved state/);
    assert.deepEqual(await halfWritten(b), []);
    assert.equal(await readFile(config, 'utf8'), `${next}\n`);
    assert.equal(await away.end(), 0);

    // With the network not named, a hold on a mainnet bot's volume is not refused: it starts no bot. The variable is
    // then not written, and that is said.
    const unnamed = await hold(t, b, { KIT_MARKET_CONFIG: await marketConfig((c) => { c.offers = []; }) });
    assert.equal(unnamed.child.exitCode, null);
    assert.match(unnamed.text(), /KIT_MARKET_CONFIG is not written: the network is not mainnet \(KIT_NETWORK\)\./);
    assert.equal(await readFile(config, 'utf8'), `${next}\n`);
    assert.equal(await readlink(join(b.kit, 'market.mainnet.json')), config, 'the config is linked for the shell');
    assert.equal(await unnamed.end(), 0);
    assert.deepEqual((await calls(b)).map((x) => x.args), [['mainnet', 'setup'], ['mainnet']], 'no hold ran start.sh');
  });

  test('only KIT_HOLD=1 holds: with any other value the bots start as usual', async () => {
    for (const value of ['0', 'false', 'true', 'yes']) {
      const b = await box();
      const r = run(b, [], { KIT_HOLD: value });
      assert.equal(r.code, 0, value);
      assert.equal((await calls(b)).length, 1, value);
      assert.doesNotMatch(r.out, /no bot is started/, value);
    }
  });
});

describe('docker/entrypoint.sh: KIT_PROBE=1', { skip }, () => {
  /**
   * The entrypoint as a probe, in a process group of its own and with the real sleep: what it has printed, a wait
   * for a row, and its end. Killed with its group when the test ends, as the holds are.
   */
  function probe(t: TestContext, b: Box, extra: Record<string, string> = {}) {
    const child = spawn('sh', [b.entrypoint], { env: envOf(b, { KIT_PROBE: '1', FAKE_SLEEP_REAL: '1', ...extra }), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    const ended = new Promise<void>((res) => child.on('exit', () => res()));
    const group = child.pid;
    if (group !== undefined) groups.add(group);
    const kill = async () => {
      try {
        if (group !== undefined) process.kill(-group, 'SIGKILL');
      } catch { /* ended already */ }
      if (group !== undefined) groups.delete(group);
      await ended;
    };
    t.after(async () => {
      await kill();
      child.stdout.destroy();
      child.stderr.destroy();
    });
    const until = async (row: RegExp, ms = 20_000) => {
      const deadline = Date.now() + ms;
      while (!row.test(out) && child.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      assert.match(out, row);
    };
    return { child, text: () => out, until, kill };
  }
  const markOf = (b: Box) => readFile(join(b.state, '.probe'), 'utf8');
  /** Waits until the mark on the volume is another one than `was`. */
  const moves = async (b: Box, was: string, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if ((await markOf(b).catch(() => was)) !== was) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };

  test('starts no bot and writes its mark to the volume once a second, also after a SIGTERM, as a bot that finishes a trade goes on: only a kill ends it', { timeout: 60_000 }, async (t) => {
    const b = await box();
    const p = probe(t, b);
    await p.until(/Writing to .*\/\.probe once a second now\./);
    assert.match(p.text(), /KIT_PROBE=1: no bot is started\./);
    assert.match(p.text(), /No probe has written to this volume before, so there is nothing to compare with yet\./);
    const first = await markOf(b);
    assert.match(first, /^\S+ [1-9][0-9]* [1-9][0-9]* [0-9a-f]+\n$/, 'a host, a time, a count and an id of its own');
    assert.match(p.text(), /A probe sees only another probe, never a bot\./);
    assert.ok(await moves(b, first), 'the mark moves');
    p.child.kill('SIGTERM');
    await p.until(/SIGTERM: this container goes on writing/);
    const after = await markOf(b);
    assert.ok(await moves(b, after), 'and goes on moving after the SIGTERM');
    assert.equal(p.child.exitCode, null, 'it still runs');
    assert.deepEqual(await calls(b), [], 'start.sh was not run');
    assert.ok(!existsSync(join(b.kit, 'keys')) && !existsSync(join(b.state, 'market.mainnet.json')) && !existsSync(join(b.state, '.last-start')), 'no link, no config, no mark of a start');
    await p.kill();
  });

  test('the container after it says what it saw: ONE CONTAINER AT A TIME when the probe before it was gone, TWO CONTAINERS AT ONCE, and for how long, when it still wrote', { timeout: 120_000 }, async (t) => {
    const b = await box();
    const old = probe(t, b);
    await old.until(/Writing to .*\/\.probe once a second now\./);
    // A second container on the volume while the first still runs (a platform that starts the new one first).
    const beside = probe(t, b);
    await beside.until(/Another container \(\S+\) is writing to this volume now: looking until it stops\./);
    await old.kill();
    await beside.until(/TWO CONTAINERS AT ONCE: another container \(\S+\) went on writing to this volume for [1-9][0-9]* s after this one had started\. .* set KIT_CLEAR_LOCKS=0/);
    assert.doesNotMatch(beside.text(), /ONE CONTAINER AT A TIME|Nothing was compared/);
    await beside.until(/Writing to .*\/\.probe once a second now\./);
    await beside.kill();
    // A third one after both are gone (a platform that stops the old one first).
    const next = probe(t, b);
    await next.until(/ONE CONTAINER AT A TIME: the probe before this one \(\S+\) wrote its last mark [0-9]+ s before this container started, and none since\./);
    assert.doesNotMatch(next.text(), /TWO CONTAINERS/);
    await next.until(/Writing to .*\/\.probe once a second now\./);
    await next.kill();
    assert.deepEqual(await calls(b), []);
  });

  test('a mark from an earlier check is not the container this one replaced: nothing was compared, and no verdict is given', { timeout: 60_000 }, async (t) => {
    const now = Math.floor(Date.now() / 1000);
    for (const mark of [`an-old-probe ${now - 4000} 7 0a1b2c3d\n`, 'an-old-probe when 7 0a1b2c3d\n', `an-old-probe ${now + 4000} 7 0a1b2c3d\n`]) {
      const b = await box();
      await writeFile(join(b.state, '.probe'), mark);
      // (A sleep that returns at once: the five quiet looks take no time.)
      const p = probe(t, b, { FAKE_SLEEP_REAL: '' });
      await p.until(/Writing to .*\/\.probe once a second now\./);
      assert.match(p.text(), /Nothing was compared: the last probe on this volume \(an-old-probe\) stopped writing long before this container started, or at a time that cannot be read, so it is not the container this one replaced\. Deploy once more while this one writes\./, mark);
      assert.doesNotMatch(p.text(), /ONE CONTAINER AT A TIME|TWO CONTAINERS/, mark);
      await p.kill();
    }
    // A mark of the last minutes is.
    const f = await box();
    await writeFile(join(f.state, '.probe'), `the-one-before ${now - 200} 7 0a1b2c3d\n`);
    const q = probe(t, f, { FAKE_SLEEP_REAL: '' });
    await q.until(/ONE CONTAINER AT A TIME: the probe before this one \(the-one-before\) wrote its last mark 2[0-9][0-9] s before this container started, and none since\./);
    await q.kill();
  });

  test('a probe that finds another one writing beside it after its verdict says so (two that started together, or one that had stalled)', { timeout: 60_000 }, async (t) => {
    const b = await box();
    const p = probe(t, b);
    await p.until(/Writing to .*\/\.probe once a second now\./);
    assert.doesNotMatch(p.text(), /TWO CONTAINERS/);
    // Another container's mark appears in the place of this probe's own.
    await writeFile(join(b.state, '.probe'), 'another-container 1800000000 3 ffffffff\n');
    await p.until(/TWO CONTAINERS AT ONCE: another container \(another-container\) is writing to this volume beside this one\. .* set KIT_CLEAR_LOCKS=0/);
    await p.kill();
  });

  test('while the other container goes on writing, the probe goes on looking, a quarter of an hour at most, and then says that it still is', { timeout: 120_000 }, async (t) => {
    const b = await box();
    const mark = join(b.state, '.probe');
    await writeFile(mark, 'the-other 1800000000 0 00000000\n');
    // A sleep that returns at once, and during each one the other container writes a new mark: the probe's 900
    // looks take seconds, and each of them sees a change.
    const p = probe(t, b, { FAKE_SLEEP_REAL: '', FAKE_OTHER_PROBE: mark });
    await p.until(/TWO CONTAINERS AT ONCE: another container \(the-other\) is still writing to this volume, 900 s after this one started\. .* set KIT_CLEAR_LOCKS=0/, 90_000);
    assert.match(p.text(), /Another container \(the-other\) is writing to this volume now: looking until it stops\./);
    assert.doesNotMatch(p.text(), /ONE CONTAINER AT A TIME|Nothing was compared|went on writing/);
    await p.kill();
    assert.ok((await sleepsOf(b)).slice(0, 900).every((row) => row === '1'), 'it looked once a second');
  });

  test('it looks at a volume, so it needs one; and only KIT_PROBE=1 is a probe', async () => {
    const b = await box();
    const none = run(b, [], { KIT_PROBE: '1', FAKE_VOLUME: NOWHERE });
    assert.equal(none.code, 1);
    assert.match(none.err, /is not a volume/);
    const allowed = run(b, [], { KIT_PROBE: '1', FAKE_VOLUME: NOWHERE, KIT_ALLOW_NO_VOLUME: '1' });
    assert.equal(allowed.code, 1);
    assert.match(allowed.err, /KIT_PROBE=1 looks at a volume, and .* is not one/);
    assert.ok(!existsSync(join(b.state, '.probe')));
    // Any start that is not a probe ends a check: it takes the mark away, so that the probe of a later check
    // compares itself with a probe or with nothing, never with a mark from before a bot ran here.
    await writeFile(join(b.state, '.probe'), 'an-earlier-probe 1800000000 9 0a1b2c3d\n');
    for (const value of ['0', 'true', 'yes']) {
      const r = run(b, [], { KIT_PROBE: value });
      assert.equal(r.code, 0, value);
      assert.doesNotMatch(r.out, /KIT_PROBE=1/);
    }
    assert.equal((await calls(b)).length, 3);
    assert.ok(!existsSync(join(b.state, '.probe')), 'the mark of an earlier check is gone');
  });
});

describe('docker/entrypoint.sh: a start right after the last one', { skip }, () => {
  /** The time on a box's own clock when a test begins, in seconds. */
  const T0 = 1_800_000_000;
  /** A box whose clock a test sets: `date +%s` reads it, and a wait moves it on by its length. */
  const clocked = async () => {
    const b = await box();
    await writeFile(b.clock, `${T0}\n`);
    return b;
  };
  const timeOf = async (b: Box) => Number((await readFile(b.clock, 'utf8')).trim());
  /** Time passes: a bot runs, or fails, for this long. */
  const pass = async (b: Box, seconds: number) => writeFile(b.clock, `${(await timeOf(b)) + seconds}\n`);
  const start = (b: Box, extra: Record<string, string> = {}) => run(b, [], { FAKE_CLOCK: b.clock, ...extra });
  const markOf = async (b: Box) => (await readFile(join(b.state, '.last-start'), 'utf8')).trim().split(' ');
  const mark = (b: Box, text: string) => writeFile(join(b.state, '.last-start'), text);

  test('a first start, and a start five minutes or more after the last one, wait for nothing and leave their mark on the volume', async () => {
    const b = await clocked();
    const r = start(b);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(await sleepsOf(b), []);
    assert.deepEqual(await markOf(b), [String(T0), '0'], 'the mark is the time of the start');
    // Five minutes to the second, whatever came before: the row starts again.
    await pass(b, 300);
    assert.equal(start(b).code, 0);
    await mark(b, `${(await timeOf(b)) - 300} 7\n`);
    assert.equal(start(b).code, 0);
    assert.deepEqual(await sleepsOf(b), []);
    assert.deepEqual(await markOf(b), [String(T0 + 300), '0']);
    assert.equal((await calls(b)).length, 3);
    // With the machine's own clock, the mark is its time.
    const real = await box();
    const before = Math.floor(Date.now() / 1000);
    assert.equal(run(real).code, 0);
    const at = Number((await markOf(real))[0]);
    assert.ok(at >= before && at <= Math.floor(Date.now() / 1000) + 1, `the time of the start (${at})`);
  });

  test('starts that follow each other within five minutes wait 5, 10, 20, 40, 80, 160 and then 300 seconds, and say so', async () => {
    const b = await clocked();
    const pauses = ['5', '10', '20', '40', '80', '160', '300', '300'];
    for (const [row, pause] of [...pauses.entries(), [41, '300'] as const]) {
      await rm(b.sleeps, { force: true });
      const now = await timeOf(b);
      await mark(b, `${now - 3} ${row}\n`);
      const r = start(b, { FAKE_EXIT: '1' });
      assert.equal(r.code, 1);
      assert.deepEqual(await sleepsOf(b), [pause], `after ${row + 1} start(s) in a row`);
      assert.ok(r.out.includes(`The last start was 3 s ago (start ${row + 2} in a row): waiting ${pause} s before this one.`), r.out);
      // The mark is the time the wait ended, not the time it began: the next start counts from there.
      assert.deepEqual(await markOf(b), [String(now + Number(pause)), String(row + 1)]);
    }
    // A start that took long to fail (an RPC that accepts and does not answer: half a minute and more) counts too,
    // up to five minutes less a second.
    for (const [ago, waits] of [[33, ['20']], [120, ['20']], [299, ['20']], [300, []]] as const) {
      await rm(b.sleeps, { force: true });
      await mark(b, `${(await timeOf(b)) - ago} 2\n`);
      assert.equal(start(b, { FAKE_EXIT: '1' }).code, 1);
      assert.deepEqual(await sleepsOf(b), [...waits], `${ago} s after the last start`);
    }
  });

  test('Railway\'s ten restarts of a bot that fails at every start take 25 minutes of waits, not seconds: each wait counts from the end of the one before', async () => {
    const b = await clocked();
    // The first start of a deploy and the ten restarts after it; each takes 14 s to fail.
    for (let i = 0; i < 11; i++) {
      assert.equal(start(b, { FAKE_EXIT: '1' }).code, 1);
      await pass(b, 14);
    }
    assert.deepEqual(await sleepsOf(b), ['5', '10', '20', '40', '80', '160', '300', '300', '300', '300']);
    assert.equal((await timeOf(b)) - T0, 11 * 14 + 1515, '25 minutes and 15 seconds of waits');
    assert.equal((await calls(b)).length, 11, 'every start still runs start.sh');
    // A bot that then runs for five minutes starts the row again at its next start.
    await pass(b, 300 - 14);
    await rm(b.sleeps, { force: true });
    assert.equal(start(b).code, 0);
    assert.deepEqual(await sleepsOf(b), []);
    assert.equal((await markOf(b))[1], '0');
  });

  test('a mark that cannot be read, or from a clock that has since been set back, makes no start wait or fail, and is written anew', async () => {
    const b = await clocked();
    const t = T0 - 3;
    for (const text of ['', 'not a time\n', '-5 2\n', `${t}x 1\n`, `${T0 + 600} 3\n`, `0${t} 1\n`, '09 08\n', `${t}0000000000000 1\n`, `${t} many\n`, `${t} 08\n`, `${t} 99999999999999999999\n`]) {
      await rm(b.sleeps, { force: true });
      await writeFile(b.clock, `${T0}\n`);
      await mark(b, text);
      const r = start(b);
      assert.equal(r.code, 0, `${JSON.stringify(text)}: ${r.err}`);
      // A time that reads, with a count that does not, still counts as a start a moment ago: the first wait.
      const first = text.startsWith(`${t} `);
      assert.deepEqual(await sleepsOf(b), first ? ['5'] : [], JSON.stringify(text));
      assert.match((await readFile(join(b.state, '.last-start'), 'utf8')), /^[1-9][0-9]* (0|[1-9][0-9]*)\n$/);
    }
    // A clock that says nothing: no wait, and the start goes on.
    await writeFile(b.clock, '\n');
    await mark(b, `${t} 2\n`);
    await rm(b.sleeps, { force: true });
    assert.equal(start(b).code, 0);
    assert.deepEqual(await sleepsOf(b), []);
  });

  test('help waits for nothing and leaves no mark', async () => {
    const b = await clocked();
    assert.equal(run(b, ['help'], { FAKE_CLOCK: b.clock }).code, 0);
    assert.ok(!existsSync(join(b.state, '.last-start')), 'no mark');
    const text = `${T0 - 3} 2\n`;
    await mark(b, text);
    assert.equal(run(b, ['help'], { FAKE_CLOCK: b.clock }).code, 0);
    assert.deepEqual(await sleepsOf(b), []);
    assert.equal(await readFile(join(b.state, '.last-start'), 'utf8'), text, 'the mark is as it was');
  });
});

describe('the image and its guide', { skip }, () => {
  test('the Dockerfile uses the Node that start.sh names, installs through start.sh, declares no volume and starts through tini and the entrypoint', async () => {
    const dockerfile = await readKitFile('Dockerfile');
    const lines = dockerfile.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
    const kitNode = /^KIT_NODE_VERSION=(\d+\.\d+\.\d+)$/m.exec(await readKitFile('start.sh'))?.[1];
    assert.ok(kitNode, 'start.sh names its Node');
    assert.ok(lines.includes(`ARG NODE_IMAGE=node:${kitNode}-bookworm-slim\nFROM \${NODE_IMAGE}`), `the image's Node is ${kitNode}, on Debian (glibc)`);
    // The packages come from start.sh's own install (npm ci --ignore-scripts, the lockfile's versions), never from another one.
    assert.match(lines, /sh start\.sh market --help/);
    assert.doesNotMatch(lines, /npm (install|i|ci|update)\b/);
    assert.match(await readKitFile('start.sh'), /"\$NPM" ci --ignore-scripts --include=dev/);
    // The build stops if that step ever made a key or state.
    for (const name of ['keys', 'data', 'market.mainnet.json']) assert.ok(lines.includes(`test ! -e ${name}`), name);
    // Railway takes no VOLUME instruction, and an unnamed volume would hide a missing one from the entrypoint.
    assert.doesNotMatch(lines, /^\s*VOLUME\b/m);
    assert.doesNotMatch(lines, /^\s*(USER|CMD)\b/m);
    // The image sets one variable, start.sh's own "do not download a Node". None of the switches the guide has the
    // user set (KIT_ALLOW_MAINNET above all) comes with the image.
    assert.deepEqual(lines.split('\n').filter((l) => /^\s*ENV\b/.test(l)), ['ENV KIT_NO_NODE_DOWNLOAD=1']);
    // Through sh, as start.sh is run: the entrypoint does not depend on the mode a checkout gave its file.
    // -s: tini reaps and passes signals on also where the platform runs an init of its own before it.
    assert.match(lines, /^ENTRYPOINT \["\/usr\/bin\/tini", "-s", "--", "sh", "\/app\/docker\/entrypoint\.sh"\]$/m);
    assert.match(lines, /apt-get install -y --no-install-recommends procps tini/);
    assert.match(lines, /^WORKDIR \/app$/m);
    assert.ok(((await stat(kitFile('docker/entrypoint.sh'))).mode & 0o111) !== 0, 'the entrypoint can be executed');
  });

  test('the ignore files keep a working folder\'s keys, state and secrets out of every commit and every build, also a copy of a key file kept beside the kit', async () => {
    const rows = (text: string) => text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    const ignored = rows(await readKitFile('.dockerignore'));
    // At any depth, as .gitignore's own patterns work: a .dockerignore pattern without **/ is for the top folder only.
    for (const name of ['keys', 'data', 'store.key', '*.key', 'api-key*', '*-pha.json', '*-base.json', 'market.mainnet.json', 'node_modules']) assert.ok(ignored.includes(`**/${name}`), name);
    assert.ok(!ignored.some((l) => l.startsWith('!')), 'nothing is let back in');
    // What .gitignore keeps out of a commit, .dockerignore keeps out of an image.
    const git = rows(await readKitFile('.gitignore')).filter((l) => !l.startsWith('!'));
    for (const name of ['*-pha.json', '*-base.json', 'keys/', 'data/']) assert.ok(git.includes(name), `${name} in .gitignore`);
    for (const name of git.map((g) => g.replace(/\/$/, ''))) assert.ok(ignored.includes(name) || ignored.includes(`**/${name}`), `${name} of .gitignore`);
    // No file of the kit is named like a key file: the patterns hide nothing the kit needs.
    for (const dir of ['examples', 'src', 'docs', 'docker']) {
      for (const f of await readdir(kitFile(dir), { recursive: true })) assert.doesNotMatch(f, /(-pha|-base)\.json$|\.key$|(^|\/)api-key|(^|\/)(keys|data)(\/|$)/, `${dir}/${f}`);
    }
  });

  test('docs/RAILWAY.md names every variable the entrypoint reads, the settings a bot needs there, and what to keep a copy of', async () => {
    const guide = await readKitFile('docs/RAILWAY.md');
    const script = await readKitFile('docker/entrypoint.sh');
    // Every KIT_ name outside the script's comments, however it is read. KIT_DIR is the script's own, and
    // KIT_PROC_DIR is for these tests.
    const code = script.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
    const read = [...new Set([...code.matchAll(/\bKIT_[A-Z_]+/g)].map((m) => m[0]))].filter((v) => v !== 'KIT_DIR' && v !== 'KIT_PROC_DIR').sort();
    assert.deepEqual(read, ['KIT_ALLOW_MAINNET', 'KIT_ALLOW_NO_VOLUME', 'KIT_CLEAR_LOCKS', 'KIT_HOLD', 'KIT_MARKET_CONFIG', 'KIT_NETWORK', 'KIT_PROBE', 'KIT_START_ARGS', 'KIT_STATE_DIR', 'KIT_STORE_KEY_FILE']);
    for (const v of [...read, 'KIT_SKIP_FAUCET', 'RAILWAY_DEPLOYMENT_DRAINING_SECONDS', 'RAILWAY_VOLUME_MOUNT_PATH']) {
      assert.ok(guide.includes(`\`${v}`), `the guide names ${v}`);
      if (v.startsWith('KIT_') && v !== 'KIT_SKIP_FAUCET') assert.ok(script.includes(`#   ${v} `), `the entrypoint's own list names ${v}`);
    }
    for (const w of ['/data', 'STORE_LOCKED', 'railway ssh', 'market.mainnet.json', 'keys/mainnet/market-pha.json', 'keys/mainnet/market-base.json', 'Custom Start Command', 'Pre-Deploy Command', 'apiKeyFile', 'docker run']) assert.ok(guide.includes(w), w);
    // The entrypoint's waits, as the guide gives them.
    assert.match(guide, /5\s+seconds,\s+then\s+10,\s+20,\s+40,\s+80,\s+160,\s+and\s+300\s+from\s+then\s+on/);
    assert.match(script, /1\) pause=5 ;;\s+2\) pause=10 ;;\s+3\) pause=20 ;;\s+4\) pause=40 ;;\s+5\) pause=80 ;;\s+6\) pause=160 ;;\s+\*\) pause=300 ;;/);
    // The lines the guide's table quotes are the entrypoint's own.
    assert.ok(script.includes('is not a volume: it is on the container\'s own disk'));
    assert.ok(script.includes('(start $((row + 1)) in a row): waiting $pause s before this one.'));
    assert.ok(script.includes('KIT_MARKET_CONFIG cannot be the market bot\'s config: '));
    assert.ok(script.includes('the network is not named, and this volume holds a mainnet bot\'s keys or state'));
    assert.ok(script.includes('KIT_STORE_KEY_FILE ($KIT_STORE_KEY_FILE) is not on the volume'));
    assert.ok(script.includes('this volume has no market.mainnet.json and no market bot\'s key pair ('));
    assert.ok(script.includes('which holds a market bot\'s saved state'));
    // What the entrypoint takes for a bot's saved state is the file the kit's store keeps in it.
    assert.match(await readKitFile('src/store.ts'), /const META_FILE = 'meta\.json';/);
    assert.ok(script.includes('has_store() { [ -f "$1/mainnet/meta.json" ]; }'));
    // The data folder a first start's config names is the template's.
    assert.match(await readKitFile('start.sh'), /cp examples\/market\.mainnet\.example\.json "\$MARKET_CONFIG"/);
    assert.ok(script.includes('on_volume_check data-dir "$KIT_DIR/examples/market.mainnet.example.json"'));
    // The two files the refusal looks for are the ones start.sh's setup makes (examples/new-keys.ts names them).
    assert.match(await readKitFile('start.sh'), /run_tsx examples\/new-keys\.ts --dir keys\/mainnet --name market\)/);
    assert.match(await readKitFile('examples/new-keys.ts'), /join\(dir, `\$\{name\}-pha\.json`\)/);
    assert.match(await readKitFile('examples/new-keys.ts'), /join\(dir, `\$\{name\}-base\.json`\)/);
    assert.ok(script.includes('"$STATE/keys/mainnet/market-pha.json"') && script.includes('"$STATE/keys/mainnet/market-base.json"'));
    // The entrypoint takes the yes as start.sh does: only 1.
    assert.match(script, /\[ "\$\{KIT_ALLOW_MAINNET:-\}" = 1 \]/);
    assert.match(await readKitFile('start.sh'), /elif \[ "\$\{KIT_ALLOW_MAINNET:-\}" = 1 \]; then/);
    assert.match(script, /\[ \$\(\(now - last\)\) -lt 300 \]/);
    assert.match(guide, /within five\s+minutes of the last one/);
    // (The guide wraps its rows: it is compared with its blanks and row ends made one blank.)
    const flat = guide.replace(/\s+/g, ' ');
    for (const quoted of ['is not a volume', 'in a row): waiting', 'KIT_MARKET_CONFIG cannot be the market bot\'s config', 'the network is not named', 'is not on the volume', 'Stopping: no new offers or takes', 'this volume has no market.mainnet.json and no market bot\'s key pair', '/data/.last-start', 'the leftover lock of a bot that is gone']) assert.ok(flat.includes(quoted), quoted);
    // The rows the guide tells its reader to wait for, each in the guide and in the file that prints it. When one
    // of them is reworded, the guide must not go on naming a row that no longer comes.
    for (const [row, file] of [
      ['ONE CONTAINER AT A TIME', 'docker/entrypoint.sh'],
      ['TWO CONTAINERS AT ONCE', 'docker/entrypoint.sh'],
      ['holds a mainnet bot\'s state', 'docker/entrypoint.sh'],
      ['Stopping: the bots cancel their offers and finish their running trades, then exit.', 'start.sh'],
      ['Both bots stopped', 'start.sh'],
      ['lists no offers, bids or orders yet, so the market bot has nothing to do', 'start.sh'],
      ['unfinished trade(s)', 'start.sh'],
      ['Dry run done', 'examples/seller-bot.ts'],
      ['STORE_LOCK_LOST', 'src/errors.ts']
    ] as const) {
      assert.ok(flat.includes(row), `the guide: ${row}`);
      assert.ok((await readKitFile(file)).includes(row), `${file}: ${row}`);
    }
    assert.ok(script.includes('the leftover lock of a bot that is gone'));
    assert.ok(script.includes('STAMP=$STATE/.last-start'));
    // The stop instructions name lines the real bot prints.
    assert.match(await readKitFile('src/flows/maker.ts'), /\[kit\] \$\{this\.network\}: running \(/);
    assert.match(await readKitFile('examples/seller-bot.ts'), /Stopping: no new offers or takes\./);
    assert.match(await readKitFile('examples/seller-bot.ts'), /Every trade of this bot is finished, and its offers are cancelled\. Stopped\./);
    // (The guide wraps its rows: compare it with its blanks and row ends made one blank.)
    assert.ok(guide.replace(/\s+/g, ' ').includes('Every trade of this bot is finished, and its offers are cancelled. Stopped.'));
    assert.match(await readKitFile('README.md'), /docs\/RAILWAY\.md/);
    // The kit's word scan (test/examples.test.ts), for the guide and the scripts too.
    const FORBIDDEN = /\b(peg|pegs|pegged|floor|floors|backed|issuance policy)\b/i;
    const THE_LINE = /\bthe line\b/i;
    for (const [name, text] of [['docs/RAILWAY.md', guide], ['docker/entrypoint.sh', script], ['Dockerfile', await readKitFile('Dockerfile')]] as const) {
      assert.doesNotMatch(text, FORBIDDEN, name);
      assert.doesNotMatch(text, THE_LINE, name);
    }
  });
});
