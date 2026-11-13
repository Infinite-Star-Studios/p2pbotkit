/**
 * The kit in a container (Dockerfile, docker/entrypoint.sh, docs/RAILWAY.md).
 *
 * The entrypoint runs here as it runs in a container, with `sh`, in a
 * folder of its own that stands for the image's /app: a start.sh that only
 * records how it was called, a folder that stands for the volume, a folder
 * that stands for /proc (KIT_PROC_DIR), a `stat` that says which device a
 * folder is on, so a test decides whether the volume is one, and a `sleep`
 * that only notes how long it was asked to wait. Nothing here needs Docker,
 * a network, or the kit's own packages.
 *
 *   - the volume: no start, no key and no state without one;
 *   - the links: ./keys, ./data and ./market.mainnet.json are the volume's;
 *   - the network and start.sh's command line, with no terminal on its
 *     input; a network that nobody named on a mainnet bot's volume;
 *   - the locks a killed bot leaves, which a new container's host name
 *     would turn into STORE_LOCKED: removed only where a volume is mounted
 *     in one container at a time, and only while no Node process runs;
 *   - mainnet: start.sh's own setup first, the config on the volume,
 *     KIT_MARKET_CONFIG, and a config whose paths are not the volume's;
 *   - KIT_HOLD;
 *   - the wait before a start that follows the last one at once;
 *   - the Dockerfile, the ignore files and the guide agree with the scripts.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  stdinIsTTY: process.stdin.isTTY === true,
  stdinIsDevNull: devNull,
  allowMainnet: process.env.KIT_ALLOW_MAINNET ?? null,
  links: { keys: link('keys'), data: link('data'), config: link('market.mainnet.json') }
};
fs.appendFileSync(process.env.FAKE_RECORD, JSON.stringify(rec) + '\\n');
if (rec.args[0] === 'mainnet' && rec.args[1] === 'setup') {
  // What "sh start.sh mainnet setup" makes: the market bot's key pair and its config (the template), in the kit's folder.
  fs.mkdirSync('keys/mainnet', { recursive: true });
  fs.writeFileSync('keys/mainnet/market-pha.json', '{"wif":"made by setup"}\\n', { mode: 0o600 });
  fs.writeFileSync('keys/mainnet/market-base.json', '{"privateKey":"made by setup"}\\n', { mode: 0o600 });
  fs.copyFileSync('examples/market.mainnet.example.json', 'market.mainnet.json');
}
process.exit(Number(process.env.FAKE_EXIT ?? 0));
`;

/**
 * stat's stand-in, first on the PATH: "stat -L -c %d <path>" answers the device a test gives that path. The folder
 * FAKE_VOLUME names, and what is in it, is on a device of its own; everything else is on the device of /.
 */
const FAKE_STAT = `#!/bin/sh
[ "$1" = -L ] && [ "$2" = -c ] && [ "$3" = %d ] && [ "$#" = 4 ] || exit 1
case "$4/" in
  "$FAKE_VOLUME"/*) echo 2049 ;;
  *) echo 64 ;;
esac
`;

/**
 * sleep's stand-in, first on the PATH: it notes the time it was asked to wait in FAKE_SLEEPS and returns at once,
 * so a test of the wait between starts takes no time. With FAKE_SLEEP_REAL=1 it is the real sleep (KIT_HOLD's).
 */
const FAKE_SLEEP = `#!/bin/sh
if [ "\${FAKE_SLEEP_REAL:-}" = 1 ]; then exec /bin/sleep "$@"; fi
printf '%s\\n' "$1" >>"$FAKE_SLEEPS"
`;

interface Call {
  args: string[];
  cwd: string;
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
  entrypoint: string;
}

const made: string[] = [];
process.on('exit', () => {
  for (const d of made) spawnSync('rm', ['-rf', d]);
});

async function box(): Promise<Box> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kit-docker-')));
  made.push(root);
  const kit = join(root, 'app');
  const b: Box = { kit, state: join(root, 'volume'), proc: join(root, 'proc'), record: join(root, 'calls.jsonl'), sleeps: join(root, 'sleeps'), entrypoint: join(kit, 'docker', 'entrypoint.sh') };
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
  return b;
}

/** Where no volume is mounted: a test that sets FAKE_VOLUME to it leaves the state folder on the device of /. */
const NOWHERE = '/nowhere';

/**
 * The environment of a container: nothing of the developer's own KIT_ or RAILWAY_ variables, and the state folder
 * on a device of its own (a volume) unless a test says otherwise. A value of '' takes a variable away.
 */
function envOf(b: Box, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { PATH: `${join(b.kit, '..', 'bin')}:${process.env.PATH ?? ''}`, FAKE_RECORD: b.record, FAKE_VOLUME: b.state, FAKE_SLEEPS: b.sleeps, KIT_STATE_DIR: b.state, KIT_PROC_DIR: b.proc };
  for (const [k, v] of Object.entries(extra)) {
    if (v === '') delete env[k];
    else env[k] = v;
  }
  return env;
}

function run(b: Box, args: string[] = [], extra: Record<string, string> = {}): { code: number | null; out: string; err: string } {
  const r = spawnSync('sh', [b.entrypoint, ...args], { env: envOf(b, extra), encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
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
const LOCK = '{"pid":7,"host":"an-earlier-container","startedAt":1794574606411,"nonce":"87a54ffe65f0995e98e1d5628e16ada2"}\n';

async function lockIn(dir: string, text = LOCK): Promise<string> {
  await mkdir(dir, { recursive: true });
  const f = join(dir, '.lock');
  await writeFile(f, text);
  return f;
}

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
    // On a volume the switch changes nothing and says nothing.
    assert.doesNotMatch(run(b, [], { KIT_ALLOW_NO_VOLUME: '1' }).out, /KIT_ALLOW_NO_VOLUME/);
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
    assert.deepEqual((await calls(b)).map((c) => c.args), [['devnet', 'help'], ['devnet', '-h'], ['devnet', '--help'], ['mainnet', 'help']]);
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
    assert.equal(run(b, [], { KIT_NETWORK: 'devnet' }).code, 0);
    for (const f of files) assert.equal(await modeOf(f), '600', f);
    assert.equal(await modeOf(join(b.state, 'keys')), '700');
    assert.equal(await modeOf(join(b.state, 'keys', 'mainnet')), '700');
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
      const locks = [await lockIn(join(b.state, 'data', 'seller', 'devnet')), await lockIn(join(b.state, 'data', 'buyer', 'devnet')), await lockIn(join(b.state, 'my-bot', 'devnet'))];
      await processOf(b, 1, '/usr/bin/tini');
      await processOf(b, 7, '/usr/bin/dash');
      const r = run(b, [], how);
      assert.equal(r.code, 0, r.err);
      for (const f of locks) {
        assert.ok(!existsSync(f), f);
        assert.ok(r.out.includes(`Removed ${f}, the lock of a bot that ran in an earlier container.`), f);
      }
    }
  });

  test('elsewhere nothing says that no other container holds the volume: the locks are left, named, and KIT_CLEAR_LOCKS=1 is how to say it', async () => {
    const b = await box();
    const f = await lockIn(join(b.state, 'data', 'seller', 'devnet'));
    const r = run(b);
    assert.equal(r.code, 0, r.err);
    assert.ok(existsSync(f), 'a lock that may be a live bot\'s in another container is never removed unasked');
    assert.ok(r.out.includes(`A bot's lock file is on ${b.state}:\n  ${f}\n`));
    assert.match(r.out, /If a bot runs on this volume in another container, leave it\. .* start with KIT_CLEAR_LOCKS=1 where this volume is mounted in one container at a time\./);
    // KIT_CLEAR_LOCKS=0 leaves them on Railway too; any other value is refused.
    assert.equal(run(b, [], { KIT_CLEAR_LOCKS: '0', RAILWAY_VOLUME_MOUNT_PATH: b.state }).code, 0);
    assert.ok(existsSync(f));
    const bad = run(b, [], { KIT_CLEAR_LOCKS: 'yes' });
    assert.equal(bad.code, 1);
    assert.match(bad.err, /KIT_CLEAR_LOCKS is 1 or 0, not "yes"/);
    // With no lock on the volume there is nothing to say.
    await rm(f);
    assert.doesNotMatch(run(b).out, /lock/);
  });

  test('while a Node process runs in the container (a bot, a dry run, prune.ts), every lock is left: one of them may be its own', async () => {
    for (const exe of ['/usr/local/bin/node', '/app/.node/bin/node', '/usr/local/bin/node (deleted)']) {
      const b = await box();
      const f = await lockIn(join(b.state, 'data', 'seller', 'devnet'));
      await processOf(b, 1, '/usr/bin/tini');
      await processOf(b, 88, exe);
      const r = run(b, [], { KIT_CLEAR_LOCKS: '1' });
      assert.equal(r.code, 0, r.err);
      assert.ok(existsSync(f), exe);
      assert.match(r.out, /A Node process runs in this container already, so the lock files on .* are left as they are\./);
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
    assert.equal(run(b, [], { KIT_CLEAR_LOCKS: '1' }).code, 0);
    assert.ok(!existsSync(f), 'the kit\'s lock is removed');
    assert.ok(existsSync(other) && existsSync(half), 'the others are kept');
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

  test('KIT_MARKET_CONFIG is written to the volume at each start, whole or not at all', async () => {
    const b = await box();
    const good = await marketConfig();
    const config = join(b.state, 'market.mainnet.json');
    const r = run(b, [], { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: good });
    assert.equal(r.code, 0, r.err);
    assert.equal(await readFile(config, 'utf8'), `${good}\n`);
    assert.ok(r.out.includes(`Wrote the market bot's config, ${config}, from KIT_MARKET_CONFIG.`));
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

  test('only a command that runs the market bot on market.mainnet.json makes the key pair and the config: not its help, not a config of its own, not a command start.sh refuses', async () => {
    const b = await box();
    const own = join(b.state, 'other.json');
    await writeFile(own, await marketConfig((c) => { c.dataDir = './data/other'; }));
    const r = run(b, ['market', '--config', own, '--dry-run'], { KIT_MARKET_CONFIG: await marketConfig() });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /KIT_MARKET_CONFIG is not used: this command does not run the market bot on market\.mainnet\.json\./);
    assert.equal(run(b, ['market', '--help']).code, 0);
    assert.equal(run(b, ['market', '--dry-run', '-h']).code, 0);
    assert.equal(run(b, ['mainnet', 'seller']).code, 0);
    assert.equal(run(b, ['mainnet', 'faucet']).code, 0);
    assert.deepEqual((await calls(b)).map((x) => x.args), [['mainnet', 'market', '--config', own, '--dry-run'], ['mainnet', 'market', '--help'], ['mainnet', 'market', '--dry-run', '-h'], ['mainnet', 'seller'], ['mainnet', 'faucet']]);
    assert.ok(!existsSync(join(b.state, 'market.mainnet.json')) && !existsSync(join(b.state, 'keys', 'mainnet')), 'nothing was made');
    // The commands that do: none at all, dry-run, setup, and the market bot by name.
    for (const args of [[], ['dry-run'], ['setup'], ['market'], ['market', '--dry-run']]) {
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
  /** The entrypoint on hold: resolves with what it printed once it waits, and a way to end it. */
  async function hold(b: Box, extra: Record<string, string> = {}) {
    const child = spawn('sh', [b.entrypoint], { env: envOf(b, { KIT_HOLD: '1', FAKE_SLEEP_REAL: '1', ...extra }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    const ended = new Promise<number | null>((res) => child.on('exit', (code) => res(code)));
    const deadline = Date.now() + 15_000;
    // The last thing it does before it waits is start its sleep.
    const sleeping = () => spawnSync('pgrep', ['-P', String(child.pid), '-x', 'sleep']).status === 0;
    while (child.exitCode === null && !(/Remove KIT_HOLD and deploy again/.test(out) && sleeping()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 50));
    return { child, text: () => out, end: async () => { child.kill('SIGTERM'); return ended; } };
  }

  test('starts no bot, keeps running for a shell, and ends at once on SIGTERM with exit 0', async () => {
    const b = await box();
    const f = await lockIn(join(b.state, 'data', 'seller', 'devnet'));
    const h = await hold(b, { KIT_CLEAR_LOCKS: '1' });
    assert.match(h.text(), /KIT_HOLD=1: no bot is started, and none sends a lock, a claim or a refund while it is set\. The container keeps running/);
    assert.equal(h.child.exitCode, null, 'it keeps running');
    assert.deepEqual(await calls(b), [], 'start.sh was not run');
    assert.equal(await readlink(join(b.kit, 'keys')), join(b.state, 'keys'), 'the links are there for the shell');
    assert.ok(!existsSync(join(b.kit, 'market.mainnet.json')) && !existsSync(join(b.state, 'market.mainnet.json')), 'no setup: no key and no config are made on hold');
    assert.ok(!existsSync(f), 'leftover locks are removed all the same');
    assert.ok(!existsSync(join(b.state, '.last-start')), 'a hold is not a start');
    const at = Date.now();
    assert.equal(await h.end(), 0);
    assert.ok(Date.now() - at < 5_000);
  });

  test('on mainnet the shell\'s dry run reads the config the next start will run: KIT_MARKET_CONFIG is written on hold too, a bad one only named; a volume with no config yet says so', async () => {
    const b = await box();
    const fresh = await hold(b, { KIT_NETWORK: 'mainnet' });
    assert.match(fresh.text(), /There is no market\.mainnet\.json on the volume yet\. One made in this shell .* stays in this container/);
    assert.equal(await fresh.end(), 0);
    assert.ok(!existsSync(join(b.state, 'keys', 'mainnet')), 'a hold makes no key: a key pair can be put there first');

    const config = join(b.state, 'market.mainnet.json');
    const old = await marketConfig();
    await writeFile(config, `${old}\n`);
    const next = await marketConfig((c) => { c.offers = []; });
    const h = await hold(b, { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: next });
    assert.ok(h.text().includes(`Wrote the market bot's config, ${config}, from KIT_MARKET_CONFIG.`));
    assert.equal(await readFile(config, 'utf8'), `${next}\n`);
    assert.equal(await readlink(join(b.kit, 'market.mainnet.json')), config);
    assert.equal(await h.end(), 0);

    const bad = await hold(b, { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: '{"offers": []}' });
    assert.match(bad.text(), /KIT_MARKET_CONFIG cannot be the market bot's config: its "network" is not "mainnet"\. The config on the volume was left as it was\./);
    assert.equal(bad.child.exitCode, null, 'the shell is still to be had');
    assert.equal(await readFile(config, 'utf8'), `${next}\n`);
    assert.equal(await bad.end(), 0);

    // With the network not named, a hold on a mainnet bot's volume is not refused: it starts no bot.
    const unnamed = await hold(b);
    assert.equal(unnamed.child.exitCode, null);
    assert.equal(await readlink(join(b.kit, 'market.mainnet.json')), config, 'the config is linked for the shell');
    assert.equal(await unnamed.end(), 0);
    assert.deepEqual(await calls(b), []);
  });
});

describe('docker/entrypoint.sh: a start right after the last one', { skip }, () => {
  const nowS = () => Math.floor(Date.now() / 1000);
  const markOf = async (b: Box) => (await readFile(join(b.state, '.last-start'), 'utf8')).trim().split(' ');

  test('a first start, and a start after a run of half a minute or more, wait for nothing and leave their mark on the volume', async () => {
    const b = await box();
    const before = nowS();
    const r = run(b);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(await sleepsOf(b), []);
    const [at, row] = await markOf(b);
    assert.ok(Number(at) >= before && Number(at) <= nowS() + 1, `the mark is the time of the start (${at})`);
    assert.equal(row, '0');
    // The last start was long ago, whatever came before it: the row starts again.
    await writeFile(join(b.state, '.last-start'), `${nowS() - 31} 7\n`);
    assert.equal(run(b).code, 0);
    assert.deepEqual(await sleepsOf(b), []);
    assert.equal((await markOf(b))[1], '0');
    assert.equal((await calls(b)).length, 2);
  });

  test('starts that follow each other within half a minute wait 5, 10, 20, 40, 80, 160 and then 300 seconds, and say so', async () => {
    const b = await box();
    const pauses = ['5', '10', '20', '40', '80', '160', '300', '300'];
    for (const [row, pause] of [...pauses.entries(), [41, '300'] as const]) {
      await rm(b.sleeps, { force: true });
      await writeFile(join(b.state, '.last-start'), `${nowS() - 3} ${row}\n`);
      const r = run(b, [], { FAKE_EXIT: '1' });
      assert.equal(r.code, 1);
      assert.deepEqual(await sleepsOf(b), [pause], `after ${row + 1} start(s) in a row`);
      assert.match(r.out, new RegExp(`The last start was [0-9]+ s ago \\(start ${row + 2} in a row\\): waiting ${pause} s before this one\\.`));
      assert.equal((await markOf(b))[1], String(row + 1));
    }
    // Railway's ten restarts of a start that fails at once: about 25 minutes of waits in all.
    assert.equal(pauses.concat(['300', '300']).reduce((a, s) => a + Number(s), 0), 1515);
    // The real thing, with no mark written by hand: a bot that fails at once, started three times.
    const c = await box();
    for (let i = 0; i < 3; i++) assert.equal(run(c, [], { FAKE_EXIT: '1' }).code, 1);
    assert.deepEqual(await sleepsOf(c), ['5', '10']);
    assert.equal((await calls(c)).length, 3, 'every start still runs start.sh');
  });

  test('a mark that cannot be read, or from a clock that has since been set back, makes no start wait or fail, and is written anew', async () => {
    const b = await box();
    const t = nowS() - 3;
    for (const mark of ['', 'not a time\n', '-5 2\n', `${t}x 1\n`, `${nowS() + 600} 3\n`, `0${t} 1\n`, '09 08\n', `${t}0000000000000 1\n`, `${t} many\n`, `${t} 08\n`, `${t} 99999999999999999999\n`]) {
      await rm(b.sleeps, { force: true });
      await writeFile(join(b.state, '.last-start'), mark);
      const r = run(b);
      assert.equal(r.code, 0, `${JSON.stringify(mark)}: ${r.err}`);
      // A time that reads, with a count that does not, still counts as a start a moment ago: the first wait.
      const first = mark.startsWith(`${t} `);
      assert.deepEqual(await sleepsOf(b), first ? ['5'] : [], JSON.stringify(mark));
      assert.match((await readFile(join(b.state, '.last-start'), 'utf8')), /^[1-9][0-9]* (0|[1-9][0-9]*)\n$/);
    }
  });

  test('help waits for nothing and leaves no mark', async () => {
    const b = await box();
    assert.equal(run(b, ['help']).code, 0);
    assert.ok(!existsSync(join(b.state, '.last-start')), 'no mark');
    const mark = `${nowS() - 3} 2\n`;
    await writeFile(join(b.state, '.last-start'), mark);
    assert.equal(run(b, ['help']).code, 0);
    assert.deepEqual(await sleepsOf(b), []);
    assert.equal(await readFile(join(b.state, '.last-start'), 'utf8'), mark, 'the mark is as it was');
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
    const read = [...new Set([...script.matchAll(/\$\{(KIT_[A-Z_]+)[:}]/g)].map((m) => m[1]!))].filter((v) => v !== 'KIT_PROC_DIR').sort();
    assert.deepEqual(read, ['KIT_ALLOW_NO_VOLUME', 'KIT_CLEAR_LOCKS', 'KIT_HOLD', 'KIT_MARKET_CONFIG', 'KIT_NETWORK', 'KIT_START_ARGS', 'KIT_STATE_DIR']);
    for (const v of [...read, 'KIT_ALLOW_MAINNET', 'KIT_SKIP_FAUCET', 'RAILWAY_DEPLOYMENT_DRAINING_SECONDS']) {
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
    for (const quoted of ['is not a volume', 'in a row): waiting', 'KIT_MARKET_CONFIG cannot be the market bot\'s config', 'the network is not named']) assert.ok(guide.includes(quoted), quoted);
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
