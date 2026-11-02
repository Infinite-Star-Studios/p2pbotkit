/**
 * Make fresh key pairs for the example bots (build spec section 6.7, step 2
 * of the quick start):
 *
 *   npx tsx examples/new-keys.ts                       # keys/seller-*.json and keys/buyer-*.json
 *   npx tsx examples/new-keys.ts --name mybot          # keys/mybot-pha.json and keys/mybot-base.json
 *   npx tsx examples/new-keys.ts --dir ./other-keys    # another folder
 *
 * For each name it writes two files the kit reads:
 *   <dir>/<name>-pha.json   {"wif": ...}         the Phantasma key
 *   <dir>/<name>-base.json  {"privateKey": ...}  the Base key
 * each created new (never over an existing file: a key that may already hold
 * funds is never replaced) with mode 0600, fsynced, in a folder created 0700.
 * The pair is then read back through the kit's own key loader, which checks
 * the modes and derives the addresses.
 *
 * It prints only the two addresses of each pair and the faucet command that
 * funds them on devnet. It never prints a key, and it takes none on its
 * command line. Keep the files private: whoever can read them can spend what
 * the addresses hold. keys/ is in the kit's .gitignore.
 */
import { open, mkdir, stat, unlink, access } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PhantasmaKeys } from 'phantasma-sdk-ts';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { loadKeys, secretShapedArg, wifOk } from '../src/keys.js';
import { SafetyError } from '../src/errors.js';
import { errorText } from '../src/redact.js';

/** The names made when none is given: the two example bots. */
export const DEFAULT_NAMES: readonly string[] = Object.freeze(['seller', 'buyer']);
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

export interface KeyPairResult {
  name: string;
  phaFile: string;
  baseFile: string;
  /** False when the files were already there (they are left as they are). */
  created: boolean;
  /** The addresses (null when existing files could not be read as a pair). */
  pha: string | null;
  base: string | null;
  /** Why an existing pair was left alone. */
  note?: string;
}

const exists = (p: string) => access(p).then(() => true, () => false);

/** Create `path` with `content`, mode 0600, never over an existing file; fsynced. */
async function writeNew(path: string, content: string): Promise<void> {
  const fh = await open(path, 'wx', 0o600);
  try {
    await fh.writeFile(content, 'utf8');
    await fh.chmod(0o600);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function syncDir(dir: string): Promise<void> {
  const fh = await open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** A fresh Phantasma WIF, checked (its checksum and shape) and round-tripped before it is written. */
function newPhaKey(): { wif: string; address: string } {
  const seed = randomBytes(32);
  const keys = new PhantasmaKeys(seed);
  seed.fill(0);
  const wif = keys.toWIF();
  if (!wifOk(wif)) throw new Error('a fresh Phantasma key did not give a well formed WIF');
  const address = PhantasmaKeys.fromWIF(wif).Address.Text;
  if (address !== keys.Address.Text) throw new Error('a fresh Phantasma key did not read back to the same address');
  return { wif, address };
}

/**
 * Make (or report) the key pairs of `names` in `dir`. Existing files are
 * never replaced: a pair that is already there is read back for its
 * addresses, and a half pair is reported for the operator to sort out.
 */
export async function makeKeyPairs(dir: string, names: readonly string[] = DEFAULT_NAMES): Promise<KeyPairResult[]> {
  for (const n of names) if (!NAME_RE.test(n)) throw new SafetyError('BAD_INPUT', `A key pair's name is 1 to 32 letters, digits, "-" or "_" (got "${n.slice(0, 40)}").`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const out: KeyPairResult[] = [];
  for (const name of names) {
    const phaFile = join(dir, `${name}-pha.json`);
    const baseFile = join(dir, `${name}-base.json`);
    const [hasPha, hasBase] = await Promise.all([exists(phaFile), exists(baseFile)]);
    if (hasPha || hasBase) {
      if (hasPha && hasBase) {
        try {
          const k = await loadKeys({ network: 'devnet', phaKeyFile: phaFile, baseKeyFile: baseFile, argv: [] });
          out.push({ name, phaFile, baseFile, created: false, pha: k.address.pha, base: k.address.base, note: 'already there; left as it is' });
        } catch (e) {
          out.push({ name, phaFile, baseFile, created: false, pha: null, base: null, note: `already there, but not usable: ${e instanceof SafetyError ? e.detail : errorText(e)}` });
        }
      } else {
        out.push({ name, phaFile, baseFile, created: false, pha: null, base: null, note: `only ${hasPha ? phaFile : baseFile} is there; nothing was written. Move it away (it may hold funds) or add the other file` });
      }
      continue;
    }
    const pha = newPhaKey();
    const pk = generatePrivateKey();
    const base = privateKeyToAccount(pk).address;
    await writeNew(phaFile, `${JSON.stringify({ wif: pha.wif })}\n`);
    try {
      await writeNew(baseFile, `${JSON.stringify({ privateKey: pk })}\n`);
    } catch (e) {
      // Never leave half a pair that was just made: nothing was funded yet.
      await unlink(phaFile).catch(() => undefined);
      throw e;
    }
    await syncDir(dir);
    // Read back through the kit's own loader: the modes, the WIF checksum, the addresses.
    const k = await loadKeys({ network: 'devnet', phaKeyFile: phaFile, baseKeyFile: baseFile, argv: [] });
    if (k.address.pha !== pha.address || k.address.base.toLowerCase() !== base.toLowerCase()) throw new Error(`the key files of ${name} did not read back to the addresses just made`);
    out.push({ name, phaFile, baseFile, created: true, pha: k.address.pha, base: k.address.base });
  }
  return out;
}

const usage = [
  'Usage: npx tsx examples/new-keys.ts [--dir <folder>] [--name <name>]...',
  '  --dir <folder>  where the key files go (default ./keys)',
  '  --name <name>   a key pair to make; repeat for more (default: seller and buyer)',
  'It writes <name>-pha.json and <name>-base.json (mode 0600) and prints only the addresses.'
].join('\n');

/** The script: resolves with its exit code. */
export async function main(o: { argv?: readonly string[]; cwd?: string; out?: (line: string) => void } = {}): Promise<number> {
  const argv = [...(o.argv ?? process.argv.slice(2))];
  const out = o.out ?? ((l: string) => console.log(l));
  if (secretShapedArg(argv)) {
    out('Refused: an argument looks like a key or a secret. This script makes keys; it never takes one.');
    return 2;
  }
  let flags: { dir?: string; name?: string[]; help?: boolean };
  try {
    flags = parseArgs({ args: argv, strict: true, allowPositionals: false, options: { dir: { type: 'string' }, name: { type: 'string', multiple: true }, help: { type: 'boolean', short: 'h' } } }).values;
  } catch (e) {
    out(errorText(e));
    out(usage);
    return 2;
  }
  if (flags.help) {
    out(usage);
    return 0;
  }
  const dir = resolve(o.cwd ?? process.cwd(), flags.dir ?? 'keys');
  let made: KeyPairResult[];
  try {
    made = await makeKeyPairs(dir, flags.name?.length ? flags.name : DEFAULT_NAMES);
  } catch (e) {
    out(`No keys were made: ${e instanceof SafetyError ? e.detail : errorText(e)}`);
    return 1;
  }
  let bad = false;
  for (const r of made) {
    out(r.created ? `${r.name}: wrote ${r.phaFile} and ${r.baseFile} (mode 0600)` : `${r.name}: ${r.note}`);
    if (r.pha && r.base) {
      out(`  Phantasma ${r.pha}`);
      out(`  Base      ${r.base}`);
      out(`  Fund it on devnet: npm run faucet -- --pha ${r.pha} --base ${r.base}`);
    } else {
      bad = true;
    }
  }
  const st = await stat(dir).catch(() => null);
  if (st && (st.mode & 0o077) !== 0) out(`Note: other users can list the folder ${dir}; the key files themselves are 0600.`);
  out(`Keep the files in ${dir} private: whoever can read them can spend what the addresses hold. Back them up before you fund them with anything of value.`);
  out(`Keep ${dir} and each bot's data folder when you upgrade the kit: unpacking a new release over the old one leaves them as they are (examples/README.md, "Upgrading the kit").`);
  return bad ? 1 : 0;
}

/** Whether this file is the script node was started with. */
function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(resolve(entry));
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) process.exitCode = await main();
