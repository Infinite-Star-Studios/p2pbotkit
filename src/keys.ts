/**
 * The bot's two keys (build spec sections 6.4 check 68 and 6.5): read from
 * two key files only, never from the command line, an environment variable
 * or a URL; addresses derived and logged, keys never logged.
 *
 *   - Phantasma: a JSON file {"wif": "<WIF>"}; the WIF's checksum is verified
 *     before use (a typo would otherwise make another, unfunded key).
 *   - Base: a JSON file {"privateKey": "0x<64 hex>"}.
 *
 * A key file must be a regular file of this user that nobody else can read
 * or write: mode & 0o077 must be 0 (chmod 600), or it is refused before a
 * byte of it is parsed. The same rule covers every other secret file the kit
 * reads (the store's KIT_STORE_KEY_FILE, an API key file), through
 * readSecretFile.
 *
 * A key whose address holds a role a bot must never have (Saturn's admin, an
 * escrow admin, a keeper, the SaturnSwap owner) is refused: check 68.
 *
 * The loaded keys are handed to the signer only. LoadedKeys hides them from
 * JSON.stringify, console.log and util.inspect, which show the addresses.
 */
import { open } from 'node:fs/promises';
import { inspect } from 'node:util';
import { createHash } from 'node:crypto';
import { PhantasmaKeys } from 'phantasma-sdk-ts';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { SafetyError, SAFETY } from './errors.js';
import { knownRoleAddresses } from './pins.js';
import { redactedLog, type LogFn } from './redact.js';
import type { Network } from './types.js';

/** The largest secret file the kit reads (a key file is well under 200 bytes). */
const SECRET_FILE_MAX = 4096;

/**
 * Read a file that holds a secret: refuse it unless it is a regular file
 * that neither group nor others can read, write or execute (mode & 0o077 is
 * 0), and at most 4 KB. The mode is read from the opened file itself, so the
 * file checked is the file read. `what` names it in errors (never its content).
 */
export async function readSecretFile(path: string, what: string): Promise<Buffer> {
  if (typeof path !== 'string' || !path) throw new SafetyError(SAFETY.KEY_FILE, `No ${what} file was given.`);
  let fh;
  try {
    fh = await open(path, 'r');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new SafetyError(SAFETY.KEY_FILE, `The ${what} file ${path} cannot be opened (${code ?? 'error'}).`);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new SafetyError(SAFETY.KEY_FILE, `The ${what} file ${path} is not a regular file.`);
    if ((st.mode & 0o077) !== 0) {
      throw new SafetyError(SAFETY.KEY_FILE_MODE, `The ${what} file ${path} can be read or changed by other users (mode ${(st.mode & 0o777).toString(8)}). Run: chmod 600 ${path}`);
    }
    if (st.size > SECRET_FILE_MAX) throw new SafetyError(SAFETY.KEY_FILE, `The ${what} file ${path} is larger than a key file can be.`);
    return await fh.readFile();
  } finally {
    await fh.close();
  }
}

/** Parse a key file's JSON; the error never quotes the content. */
function parseKeyJson(buf: Buffer, path: string, what: string): Record<string, unknown> {
  let o: unknown;
  try {
    o = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new SafetyError(SAFETY.KEY_FILE, `The ${what} file ${path} is not JSON.`);
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new SafetyError(SAFETY.KEY_FILE, `The ${what} file ${path} is not a JSON object.`);
  return o as Record<string, unknown>;
}

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 -> bytes, or null for a character outside the alphabet. */
function base58Decode(s: string): Uint8Array | null {
  let n = 0n;
  for (const ch of s) {
    const v = B58_ALPHABET.indexOf(ch);
    if (v < 0) return null;
    n = n * 58n + BigInt(v);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const body = n === 0n ? new Uint8Array(0) : Uint8Array.from(Buffer.from(hex, 'hex'));
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  const out = new Uint8Array(zeros + body.length);
  out.set(body, zeros);
  return out;
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest();

/**
 * Whether `wif` is a well formed WIF of a compressed key, checksum included:
 * base58 of 0x80, 32 key bytes, 0x01 and the first 4 bytes of the double
 * SHA-256 of those 34 bytes (what PhantasmaKeys.fromWIF reads, without the
 * checksum check it skips).
 */
export function wifOk(wif: unknown): boolean {
  if (typeof wif !== 'string' || !/^[KL][1-9A-HJ-NP-Za-km-z]{51}$/.test(wif)) return false;
  const raw = base58Decode(wif);
  if (!raw || raw.length !== 38 || raw[0] !== 0x80 || raw[33] !== 0x01) return false;
  const check = sha256(sha256(raw.subarray(0, 34)));
  const ok = check.subarray(0, 4).equals(Buffer.from(raw.subarray(34, 38)));
  raw.fill(0);
  return ok;
}

/** The bot's keys, for the signer only. Serialising or inspecting this object shows the addresses, never a key. */
export interface LoadedKeys {
  readonly network: Network;
  readonly address: Readonly<{ pha: string; base: `0x${string}` }>;
  /** The Phantasma key pair (signer.ts only). */
  readonly pha: PhantasmaKeys;
  /** The Base account (signer.ts only): it signs without exposing the private key. */
  readonly base: PrivateKeyAccount;
}

export interface LoadKeysOptions {
  network: Network;
  /** JSON {"wif": "..."}, mode 0600. */
  phaKeyFile: string;
  /** JSON {"privateKey": "0x..."}, mode 0600. */
  baseKeyFile: string;
  /** Checked for the loaded key material (default: process.argv and process.execArgv). */
  argv?: readonly string[];
  /**
   * More addresses to refuse, on top of the pinned ones (check 68): for
   * example the keeper addresses the board's /config shows. Display data may
   * only ever add a refusal here, never remove one.
   */
  forbid?: { pha?: readonly string[]; base?: readonly string[] };
  /** Receives the derived addresses (redacted lines only). */
  log?: LogFn;
}

/**
 * Why a command line carries the loaded key, or null: a key typed on the
 * command line is in the shell history and the process list, so the kit
 * refuses to run with it there even though it read the key from its file.
 */
export function argvKeyProblem(argv: readonly string[], material: readonly string[]): string | null {
  const needles = material.filter((m) => typeof m === 'string' && m.length >= 32).map((m) => m.toLowerCase().replace(/^0x/, ''));
  for (const a of argv) {
    const s = String(a).toLowerCase();
    if (needles.some((n) => s.includes(n))) return 'A key appears on the command line. Keys are read only from their key files; remove it from the command (and from your shell history).';
  }
  return null;
}

/**
 * Whether any command-line argument looks like a key or a secret (a WIF, 64
 * hex digits with or without 0x, a sat_ API key). For scripts that never take
 * one (examples/new-keys.ts, faucet.ts): they refuse such an argument.
 */
export function secretShapedArg(argv: readonly string[]): boolean {
  return argv.some((a) => /(?:^|[^1-9A-HJ-NP-Za-km-z])(?:5[1-9A-HJ-NP-Za-km-z]{50}|[KL][1-9A-HJ-NP-Za-km-z]{51})(?:$|[^1-9A-HJ-NP-Za-km-z])/.test(a)
    || /(?:0x)?[0-9a-fA-F]{64}/.test(a) || /\bsat_[A-Za-z0-9_-]{8,}/.test(a));
}

/**
 * Why these addresses must not be a bot's (check 68), or null: Saturn's admin
 * key, an escrow admin, the devnet test wallet, a keeper key, or the
 * SaturnSwap owner (pins.ts KNOWN_ROLE_ADDRESSES and every pinned escrow admin).
 */
export function knownRoleProblem(addr: { pha?: string; base?: string }, forbid: LoadKeysOptions['forbid'] = {}): string | null {
  const known = knownRoleAddresses();
  for (const a of forbid?.pha ?? []) if (typeof a === 'string' && a && !known.pha.has(a)) known.pha.set(a, 'an address this bot was told to refuse (a keeper or admin)');
  for (const a of forbid?.base ?? []) if (typeof a === 'string' && a && !known.base.has(a.toLowerCase())) known.base.set(a.toLowerCase(), 'an address this bot was told to refuse (a keeper or owner)');
  const pha = addr.pha ? known.pha.get(addr.pha) : undefined;
  if (pha) return `The Phantasma key is ${pha} (${addr.pha}). A bot must never hold an admin, owner or keeper key: use a key of its own.`;
  const base = addr.base ? known.base.get(addr.base.toLowerCase()) : undefined;
  if (base) return `The Base key is ${base} (${addr.base}). A bot must never hold an admin, owner or keeper key: use a key of its own.`;
  return null;
}

/** The Phantasma key from its file. */
async function loadPhaKey(path: string): Promise<{ keys: PhantasmaKeys; material: string }> {
  const buf = await readSecretFile(path, 'Phantasma key');
  try {
    const o = parseKeyJson(buf, path, 'Phantasma key');
    const wif = typeof o.wif === 'string' ? o.wif.trim() : '';
    if (!wif) throw new SafetyError(SAFETY.KEY_FILE, `The Phantasma key file ${path} has no "wif" field.`);
    if (!wifOk(wif)) throw new SafetyError(SAFETY.KEY_FILE, `The "wif" in ${path} is not a valid Phantasma WIF (its checksum or shape is wrong).`);
    let keys: PhantasmaKeys;
    try {
      keys = PhantasmaKeys.fromWIF(wif);
    } catch {
      throw new SafetyError(SAFETY.KEY_FILE, `The "wif" in ${path} could not be read as a Phantasma key.`);
    }
    if (!/^P2K[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(keys.Address.Text)) throw new SafetyError(SAFETY.KEY_FILE, `The key in ${path} does not give a Phantasma user address.`);
    return { keys, material: wif };
  } finally {
    buf.fill(0);
  }
}

/** The Base account from its file. */
async function loadBaseKey(path: string): Promise<{ account: PrivateKeyAccount; material: string }> {
  const buf = await readSecretFile(path, 'Base key');
  try {
    const o = parseKeyJson(buf, path, 'Base key');
    const pk = typeof o.privateKey === 'string' ? o.privateKey.trim() : '';
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new SafetyError(SAFETY.KEY_FILE, `The Base key file ${path} needs "privateKey": "0x" followed by 64 hex digits.`);
    let account: PrivateKeyAccount;
    try {
      account = privateKeyToAccount(pk.toLowerCase() as `0x${string}`);
    } catch {
      throw new SafetyError(SAFETY.KEY_FILE, `The "privateKey" in ${path} is not a valid secp256k1 key.`);
    }
    return { account, material: pk };
  } finally {
    buf.fill(0);
  }
}

/**
 * Load both keys from their files (mode 0600), check that neither is on the
 * command line and that neither holds a forbidden role (check 68), and log
 * the two addresses. Throws SafetyError (KEY_FILE, KEY_FILE_MODE, KEY_ARGV,
 * KEY_ROLE) without ever quoting a key.
 */
export async function loadKeys(o: LoadKeysOptions): Promise<LoadedKeys> {
  if (o.network !== 'devnet' && o.network !== 'mainnet') throw new SafetyError(SAFETY.NETWORK_OFF, 'The network is devnet or mainnet.');
  const log = redactedLog(o.log);
  const pha = await loadPhaKey(o.phaKeyFile);
  const base = await loadBaseKey(o.baseKeyFile);
  const argv = o.argv ?? [...process.argv, ...process.execArgv];
  const onArgv = argvKeyProblem(argv, [pha.material, base.material]);
  if (onArgv) throw new SafetyError(SAFETY.KEY_ARGV, onArgv);
  const address = Object.freeze({ pha: pha.keys.Address.Text, base: base.account.address });
  const role = knownRoleProblem(address, o.forbid);
  if (role) throw new SafetyError(SAFETY.KEY_ROLE, role);
  log(`[kit] ${o.network}: Phantasma address ${address.pha}, Base address ${address.base}`);
  return hideKeys({ network: o.network, address, pha: pha.keys, base: base.account });
}

/** The keys object with its key-holding fields non-enumerable and a printable form that shows the addresses only. */
function hideKeys(k: LoadedKeys): LoadedKeys {
  const out = {} as LoadedKeys;
  Object.defineProperties(out, {
    network: { value: k.network, enumerable: true },
    address: { value: k.address, enumerable: true },
    pha: { value: k.pha, enumerable: false },
    base: { value: k.base, enumerable: false },
    toJSON: { value: () => ({ network: k.network, address: k.address }), enumerable: false },
    toString: { value: () => `keys(${k.network}: ${k.address.pha}, ${k.address.base})`, enumerable: false },
    [inspect.custom]: { value: () => `LoadedKeys { network: '${k.network}', pha: '${k.address.pha}', base: '${k.address.base}' }`, enumerable: false }
  });
  return Object.freeze(out);
}
