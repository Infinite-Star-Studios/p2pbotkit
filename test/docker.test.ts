/**
 * The kit in a container (Dockerfile, docker/entrypoint.sh, docs/RAILWAY.md).
 *
 * The entrypoint runs here as it runs in a container, with `sh`, in a
 * folder of its own that stands for the image's /app: a start.sh that only
 * records how it was called, a folder that stands for the volume, a folder
 * that stands for /proc (KIT_PROC_DIR), and a `stat` that says which device
 * a folder is on, so a test decides whether the volume is one. Nothing here
 * needs Docker, a network, or the kit's own packages.
 *
 *   - the volume: no start, no key and no state without one;
 *   - the links: ./keys, ./data and ./market.mainnet.json are the volume's;
 *   - the locks a killed bot leaves, which a new container's host name
 *     would turn into STORE_LOCKED: removed only while no Node process runs;
 *   - the network and start.sh's command line, with no terminal on its input;
 *   - mainnet: start.sh's own setup first, the config on the volume,
 *     KIT_MARKET_CONFIG;
 *   - KIT_HOLD;
 *   - the Dockerfile, .dockerignore and the guide agree with the scripts.
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
  // What "sh start.sh mainnet setup" makes: the market bot's key pair and its config, in the kit's folder.
  fs.mkdirSync('keys/mainnet', { recursive: true });
  fs.writeFileSync('keys/mainnet/market-pha.json', '{"wif":"made by setup"}\\n', { mode: 0o600 });
  fs.writeFileSync('keys/mainnet/market-base.json', '{"privateKey":"made by setup"}\\n', { mode: 0o600 });
  fs.writeFileSync('market.mainnet.json', '{"network":"mainnet","offers":[],"bids":[],"take":[]}\\n');
}
process.exit(Number(process.env.FAKE_EXIT ?? 0));
`;

/**
 * stat's stand-in, first on the PATH: "stat -c %d <path>" answers the device a test gives that path. The folder
 * FAKE_VOLUME names, and what is in it, is on a device of its own; everything else is on the device of /.
 */
const FAKE_STAT = `#!/bin/sh
[ "$1" = -c ] && [ "$2" = %d ] && [ "$#" = 3 ] || exit 1
case "$3/" in
  "$FAKE_VOLUME"/*) echo 2049 ;;
  *) echo 64 ;;
esac
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
  const b: Box = { kit, state: join(root, 'volume'), proc: join(root, 'proc'), record: join(root, 'calls.jsonl'), entrypoint: join(kit, 'docker', 'entrypoint.sh') };
  await mkdir(join(kit, 'docker'), { recursive: true });
  await mkdir(b.state);
  await mkdir(b.proc);
  await copyFile(kitFile('docker/entrypoint.sh'), b.entrypoint);
  await writeFile(join(kit, 'start.sh'), FAKE_START_SH);
  await writeFile(join(kit, 'fake-start.cjs'), FAKE_START_CJS);
  await mkdir(join(root, 'bin'));
  await writeFile(join(root, 'bin', 'stat'), FAKE_STAT, { mode: 0o755 });
  return b;
}

/** Where no volume is mounted: a test that sets FAKE_VOLUME to it leaves the state folder on the device of /. */
const NOWHERE = '/nowhere';

/**
 * The environment of a container: nothing of the developer's own KIT_ or RAILWAY_ variables, and the state folder
 * on a device of its own (a volume) unless a test says otherwise.
 */
function envOf(b: Box, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { PATH: `${join(b.kit, '..', 'bin')}:${process.env.PATH ?? ''}`, FAKE_RECORD: b.record, FAKE_VOLUME: b.state, KIT_STATE_DIR: b.state, KIT_PROC_DIR: b.proc };
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

describe('docker/entrypoint.sh: the volume', { skip }, () => {
  test('a state folder on the container\'s own disk is refused before anything is made: no key and no state without a volume', async () => {
    const b = await box();
    const r = run(b, [], { FAKE_VOLUME: NOWHERE });
    assert.equal(r.code, 1);
    assert.match(r.err, /is not a volume: it is on the container's own disk/);
    assert.ok(r.err.includes(`Attach a volume with the mount path ${b.state} `));
    assert.match(r.err, /KIT_ALLOW_NO_VOLUME=1/);
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

  test('a folder on another device than / is a volume: it starts, in that folder or one inside it; RAILWAY_VOLUME_MOUNT_PATH names it when KIT_STATE_DIR does not', async () => {
    const b = await box();
    const r = run(b, [], { KIT_STATE_DIR: '', RAILWAY_VOLUME_MOUNT_PATH: `${b.state}/` });
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out + r.err, /is not a volume/);
    assert.ok(r.out.includes(`with its keys and state on the volume at ${b.state}.`));
    assert.equal((await calls(b)).at(-1)?.links.keys, join(b.state, 'keys'));
    // KIT_STATE_DIR wins, and a folder inside the volume is on the volume too.
    const inside = join(b.state, 'kit');
    await mkdir(inside);
    const r2 = run(b, [], { KIT_STATE_DIR: inside, RAILWAY_VOLUME_MOUNT_PATH: '/somewhere/else' });
    assert.equal(r2.code, 0, r2.err);
    assert.equal((await calls(b)).at(-1)?.links.keys, join(inside, 'keys'));
  });

  test('a state folder that is not there is no volume either', async () => {
    const b = await box();
    const r = run(b, [], { KIT_STATE_DIR: join(b.state, 'missing') });
    assert.equal(r.code, 1);
    assert.match(r.err, /is not a volume/);
  });

  test('KIT_ALLOW_NO_VOLUME=1 runs without one, and says that keys and state end with the container', async () => {
    const b = await box();
    const r = run(b, [], { FAKE_VOLUME: NOWHERE, KIT_ALLOW_NO_VOLUME: '1' });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /KIT_ALLOW_NO_VOLUME=1: .* is not a volume\. .* never with funds\./);
    assert.equal((await calls(b)).length, 1);
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
  });

  test('a second start in the same container finds its own links and goes on', async () => {
    const b = await box();
    assert.equal(run(b).code, 0);
    const r = run(b);
    assert.equal(r.code, 0, r.err);
    assert.equal(await readlink(join(b.kit, 'keys')), join(b.state, 'keys'));
    assert.equal((await calls(b)).length, 2);
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
    assert.equal(run(b).code, 0);
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
    assert.deepEqual((await argsOf([], { KIT_START_ARGS: '  seller   --config  /data/seller.json ' })).args, ['devnet', 'seller', '--config', '/data/seller.json']);
    assert.deepEqual((await argsOf([], { KIT_START_ARGS: 'mainnet dry-run' })).args, ['mainnet', 'dry-run']);
    assert.deepEqual((await argsOf([], { KIT_START_ARGS: 'seller --config * $(id) `id`' })).args, ['devnet', 'seller', '--config', '*', '$(id)', '`id`']);
    // The container's own command wins.
    assert.deepEqual((await argsOf(['buyer'], { KIT_START_ARGS: 'seller' })).args, ['devnet', 'buyer']);
  });

  test('KIT_ALLOW_MAINNET is start.sh\'s own switch: passed on as it is, never set here', async () => {
    const b = await box();
    run(b, ['help']);
    run(b, ['help'], { KIT_ALLOW_MAINNET: '1' });
    assert.deepEqual((await calls(b)).map((c) => c.allowMainnet), [null, '1']);
  });

  test('the command line it builds is one the real start.sh takes', async () => {
    const b = await box();
    await copyFile(kitFile('start.sh'), join(b.kit, 'start.sh'));
    // What start.sh looks for before it takes its folder for the kit's.
    await writeFile(join(b.kit, 'package.json'), '{}\n');
    await mkdir(join(b.kit, 'examples'));
    await writeFile(join(b.kit, 'examples', 'seller-bot.ts'), '');
    for (const extra of [{}, { KIT_NETWORK: 'mainnet' }] as Record<string, string>[]) {
      const r = run(b, ['help'], extra);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /sh start\.sh devnet {5}set up, then run the example seller and buyer bots together/);
    }
    assert.ok(!existsSync(join(b.state, 'market.mainnet.json')) && !existsSync(join(b.state, 'keys', 'mainnet')), 'help makes nothing, on mainnet either');
  });
});

describe('docker/entrypoint.sh: locks left by an earlier container', { skip }, () => {
  test('while no Node process runs, every lock file of the kit on the volume is a leftover and is removed, wherever the data folder is', async () => {
    const b = await box();
    const locks = [await lockIn(join(b.state, 'data', 'seller', 'devnet')), await lockIn(join(b.state, 'data', 'market', 'mainnet')), await lockIn(join(b.state, 'my-bot', 'devnet'))];
    await processOf(b, 1, '/usr/bin/tini');
    await processOf(b, 7, '/usr/bin/dash');
    const r = run(b);
    assert.equal(r.code, 0, r.err);
    for (const f of locks) {
      assert.ok(!existsSync(f), f);
      assert.ok(r.out.includes(`Removed ${f}, the lock of a bot that ran in an earlier container.`), f);
    }
  });

  test('while a Node process runs in the container (a bot, a dry run, prune.ts), every lock is left: one of them may be its own', async () => {
    for (const exe of ['/usr/local/bin/node', '/app/.node/bin/node', '/usr/local/bin/node (deleted)']) {
      const b = await box();
      const f = await lockIn(join(b.state, 'data', 'seller', 'devnet'));
      await processOf(b, 1, '/usr/bin/tini');
      await processOf(b, 88, exe);
      const r = run(b);
      assert.equal(r.code, 0, r.err);
      assert.ok(existsSync(f), exe);
      assert.match(r.out, /A Node process runs in this container already, so the lock files on .* are left as they are\./);
    }
    // Where there is a /proc (Linux), the real one shows this test's own Node process.
    if (existsSync('/proc/self/exe')) {
      const b = await box();
      const f = await lockIn(join(b.state, 'data', 'seller', 'devnet'));
      const r = run(b, [], { KIT_PROC_DIR: '' });
      assert.equal(r.code, 0, r.err);
      assert.ok(existsSync(f), 'the real /proc');
      assert.match(r.out, /A Node process runs in this container already/);
    }
  });

  test('KIT_KEEP_LOCKS=1 leaves them all; a .lock that is not the kit\'s is never touched', async () => {
    const b = await box();
    const f = await lockIn(join(b.state, 'data', 'seller', 'devnet'));
    assert.equal(run(b, [], { KIT_KEEP_LOCKS: '1' }).code, 0);
    assert.ok(existsSync(f));
    const other = await lockIn(join(b.state, 'data', 'other'), 'held by something else\n');
    const half = await lockIn(join(b.state, 'data', 'half'), '{"nonce":"x"}\n');
    assert.equal(run(b).code, 0);
    assert.ok(!existsSync(f), 'the kit\'s lock is removed');
    assert.ok(existsSync(other) && existsSync(half), 'the others are kept');
  });
});

describe('docker/entrypoint.sh: mainnet, the market bot\'s config on the volume', { skip }, () => {
  const CONFIG = '{ "network": "mainnet", "offers": [{ "symbol": "TAZ", "total": "500", "min": "20", "max": "100", "price": "9.99" }] }';

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
    assert.match(await readFile(config, 'utf8'), /"offers":\[\]/);
    assert.match(await readFile(join(b.state, 'keys', 'mainnet', 'market-pha.json'), 'utf8'), /made by setup/);
    assert.ok(r.out.includes(`In this container the market bot's config is ${config}, on the volume.`));

    // A new container on the same volume: the kit's folder is new, the volume is not.
    await rm(join(b.kit, 'market.mainnet.json'));
    await rm(join(b.kit, 'keys'));
    await rm(join(b.kit, 'data'));
    await rm(b.record, { force: true });
    assert.equal(run(b, [], { KIT_NETWORK: 'mainnet' }).code, 0);
    c = await calls(b);
    assert.deepEqual(c.map((x) => x.args), [['mainnet']], 'no setup again');
    assert.equal(c[0]!.links.config, config);
  });

  test('KIT_MARKET_CONFIG is written to the volume at each start, and only when it is a JSON object', async () => {
    const b = await box();
    const config = join(b.state, 'market.mainnet.json');
    const r = run(b, [], { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: CONFIG });
    assert.equal(r.code, 0, r.err);
    assert.equal(await readFile(config, 'utf8'), `${CONFIG}\n`);
    assert.ok(r.out.includes(`Wrote the market bot's config, ${config}, from KIT_MARKET_CONFIG.`));
    assert.deepEqual((await calls(b)).map((x) => x.args), [['mainnet', 'setup'], ['mainnet']], 'the key pair is made first all the same');
    for (const bad of ['{"network": "mainnet", oops', '[]', '"text"', 'null', '42']) {
      await rm(b.record, { force: true });
      const x = run(b, [], { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: bad });
      assert.equal(x.code, 1, bad);
      assert.match(x.err, /KIT_MARKET_CONFIG is not a JSON object, so the market bot's config was left as it was/);
      assert.equal(await readFile(config, 'utf8'), `${CONFIG}\n`, 'left as it was');
      assert.deepEqual(await calls(b), [], 'the bot is not started on a config that was not meant');
    }
    assert.equal(run(b, [], { KIT_NETWORK: 'mainnet' }).code, 0);
    assert.equal(await readFile(config, 'utf8'), `${CONFIG}\n`, 'without the variable, the file on the volume is used as it is');
    assert.deepEqual((await readdir(b.state)).sort(), ['data', 'keys', 'market.mainnet.json'], 'no temporary file is left');
  });

  test('on devnet none of this happens; help on mainnet makes nothing; a config inside the image is refused', async () => {
    const b = await box();
    assert.equal(run(b, [], { KIT_MARKET_CONFIG: CONFIG }).code, 0);
    assert.equal(run(b, ['help'], { KIT_NETWORK: 'mainnet', KIT_MARKET_CONFIG: CONFIG }).code, 0);
    assert.deepEqual((await calls(b)).map((x) => x.args), [['devnet'], ['mainnet', 'help']]);
    assert.ok(!existsSync(join(b.state, 'market.mainnet.json')) && !existsSync(join(b.kit, 'market.mainnet.json')));
    await writeFile(join(b.kit, 'market.mainnet.json'), CONFIG);
    const r = run(b, [], { KIT_NETWORK: 'mainnet' });
    assert.equal(r.code, 1);
    assert.match(r.err, /market\.mainnet\.json is in the image/);
  });
});

describe('docker/entrypoint.sh: KIT_HOLD=1', { skip }, () => {
  test('starts no bot, keeps running for a shell, and ends at once on SIGTERM with exit 0', async () => {
    const b = await box();
    const f = await lockIn(join(b.state, 'data', 'seller', 'devnet'));
    const child = spawn('sh', [b.entrypoint], { env: envOf(b, { KIT_HOLD: '1', KIT_NETWORK: 'mainnet' }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    const ended = new Promise<number | null>((res) => child.on('exit', (code) => res(code)));
    const deadline = Date.now() + 10_000;
    while (!/KIT_HOLD=1: no bot is started/.test(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.match(out, /KIT_HOLD=1: no bot is started\. The container keeps running/);
    assert.equal(child.exitCode, null, 'it keeps running');
    assert.deepEqual(await calls(b), [], 'start.sh was not run');
    assert.equal(await readlink(join(b.kit, 'keys')), join(b.state, 'keys'), 'the links are there for the shell');
    assert.ok(!existsSync(join(b.kit, 'market.mainnet.json')) && !existsSync(join(b.state, 'market.mainnet.json')), 'no setup: no key and no config are made on hold');
    assert.ok(!existsSync(f), 'leftover locks are removed all the same');
    const at = Date.now();
    child.kill('SIGTERM');
    assert.equal(await ended, 0);
    assert.ok(Date.now() - at < 5_000);
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
    assert.match(lines, /^ENTRYPOINT \["\/usr\/bin\/tini", "--", "\/app\/docker\/entrypoint\.sh"\]$/m);
    assert.match(lines, /apt-get install -y --no-install-recommends procps tini/);
    assert.match(lines, /^WORKDIR \/app$/m);
    assert.ok(((await stat(kitFile('docker/entrypoint.sh'))).mode & 0o111) !== 0, 'the entrypoint can be executed');
  });

  test('.dockerignore keeps a working folder\'s keys, state and secrets out of every build', async () => {
    const ignored = (await readKitFile('.dockerignore')).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    // At any depth, as .gitignore's own patterns work: a .dockerignore pattern without **/ is for the top folder only.
    for (const name of ['keys', 'data', 'store.key', '*.key', 'api-key*', 'market.mainnet.json', 'node_modules']) assert.ok(ignored.includes(`**/${name}`), name);
    assert.ok(!ignored.some((l) => l.startsWith('!')), 'nothing is let back in');
    // What .gitignore keeps out of a commit, .dockerignore keeps out of an image.
    const git = (await readKitFile('.gitignore')).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('!'));
    for (const name of git.map((g) => g.replace(/\/$/, ''))) assert.ok(ignored.includes(name) || ignored.includes(`**/${name}`), `${name} of .gitignore`);
  });

  test('docs/RAILWAY.md names every variable the entrypoint reads, the settings a bot needs there, and what to keep a copy of', async () => {
    const guide = await readKitFile('docs/RAILWAY.md');
    const script = await readKitFile('docker/entrypoint.sh');
    const read = [...new Set([...script.matchAll(/\$\{(KIT_[A-Z_]+)[:}]/g)].map((m) => m[1]!))].filter((v) => v !== 'KIT_PROC_DIR').sort();
    assert.deepEqual(read, ['KIT_ALLOW_NO_VOLUME', 'KIT_HOLD', 'KIT_KEEP_LOCKS', 'KIT_MARKET_CONFIG', 'KIT_NETWORK', 'KIT_START_ARGS', 'KIT_STATE_DIR']);
    for (const v of [...read, 'KIT_ALLOW_MAINNET', 'KIT_SKIP_FAUCET', 'RAILWAY_DEPLOYMENT_DRAINING_SECONDS']) {
      assert.ok(guide.includes(`\`${v}`), `the guide names ${v}`);
      if (v.startsWith('KIT_') && v !== 'KIT_SKIP_FAUCET') assert.ok(script.includes(`#   ${v} `), `the entrypoint's own list names ${v}`);
    }
    for (const w of ['/data', 'STORE_LOCKED', 'railway ssh', 'market.mainnet.json', 'keys/mainnet/market-pha.json', 'keys/mainnet/market-base.json', 'Custom Start Command', 'apiKeyFile', 'docker run']) assert.ok(guide.includes(w), w);
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
