/**
 * The kit's crash-safe store (build spec section 6.5): everything a bot must
 * still know after a crash, a kill or a power cut, so a restart resumes every
 * trade from the chains and never sends anything blindly.
 *
 * Layout: `dataDir/<network>/`, mode 0700, every file 0600.
 *
 *   .lock                    single-instance lock {pid, host, startedAt, nonce}: a live holder
 *                            refuses a second start; a dead one is taken over (and logged), and so
 *                            is one left by an earlier run under this process's own id (a
 *                            restarted container or service often reuses the pid)
 *   meta.json                {v, network, createdAt, sealCheck?}
 *   pending/<tokenHash>.json a control token made before its POST (offer or take); deleted once
 *                            the board's row is recorded
 *   offers/<offerId>.json    LocalOffer: the offer, its maker token, priceHistory, follow
 *   trades/<tradeId>.json    LocalTrade: figures, role, taker token, h, phaContract, t1, t2,
 *                            feeShown, txs, timestamps
 *   secrets/<h>.json         SecretRecord, never overwritten: a different secret under the same h
 *                            is SECRET_CONFLICT. Removed only by examples/prune.ts (pruneSecret)
 *   journal/<tradeId>.json   every send, recorded before it goes out: [{kind, at, nonce?, txHash?, outcome?}];
 *                            a Base send also keeps every hash sent at its nonce (replacements, cancels)
 *                            and the fees of the newest
 *
 * Every write is atomic and checked:
 *   1. write a temp file `<name>.tmp.<pid>.<random>` opened with 'wx' and 0o600;
 *   2. fsync and close it;
 *   3. rename it over the target (or, for a file that must never be
 *      overwritten, hard-link it to the target, which fails if the target
 *      exists: 'wx' semantics without a torn file);
 *   4. fsync the directory;
 *   5. read the file back and compare it byte for byte and value for value:
 *      a mismatch throws STORE_READBACK.
 * A crash at any point leaves the old file or the new one, never a torn one;
 * a temp file left behind is removed when the store next opens.
 *
 * Every write first checks that this store still holds the lock
 * (STORE_LOCK_LOST otherwise), so two processes can never both write.
 *
 * Optional encryption at rest: KIT_STORE_KEY_FILE names a 32-byte key file
 * (0600; 32 raw bytes or 64 hex digits). With it, the files that hold tokens
 * or secrets (pending, offers, trades, secrets) are sealed with AES-256-GCM,
 * a random 12-byte IV per file and the file's own path as associated data, so
 * a sealed file moved to another name does not open. meta.json keeps a sealed
 * check value, so a store sealed with one key refuses to open with another or
 * with none.
 *
 * Every record is validated before it is written and when it is read; a file
 * that does not parse or does not have its shape is STORE_CORRUPT, never
 * silently skipped.
 */
import { open, rename, link, unlink, readFile, readdir, mkdir, chmod, stat, rm, realpath } from 'node:fs/promises';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { hostname } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { SafetyError, SAFETY } from './errors.js';
import { readSecretFile } from './keys.js';
import { redactedLog, type LogFn } from './redact.js';
import { HEX32, TOKEN_RE, secretOpens, tokenHashOf } from './codec.js';
import { tokenOf, isContractName } from './pins.js';
import type {
  Network, PendingCreate, LocalOffer, LocalTrade, SecretRecord, Intent, IntentKind, IntentOutcome, Journal, TradeTxs, TradeStatus, FollowSettings
} from './types.js';

export const STORE_KINDS = ['pending', 'offers', 'trades', 'secrets', 'journal'] as const;
export type StoreKind = (typeof STORE_KINDS)[number];

/** The kinds whose files hold a token or a secret, sealed when a store key is set. */
const SEALED_KINDS: ReadonlySet<StoreKind> = new Set(['pending', 'offers', 'trades', 'secrets']);

const LOCK_FILE = '.lock';
const META_FILE = 'meta.json';
/** A lock file that cannot be read is taken over only once it is this old (ms): a process may be writing it. */
const LOCK_UNREADABLE_GRACE_MS = 10_000;
const SEAL_CHECK_TEXT = 'saturn-p2p-bot-kit store key check v1';
const TMP_RE = /\.tmp\.\d+\.[0-9a-f]{12}$/;
/** AES-256-GCM: a 12-byte IV and the full 16-byte tag, nothing shorter (Node otherwise accepts a 4-byte tag). */
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
/** A lock naming this process's id that is older than this process (less this slack, ms) was left by an earlier run. */
const PID_START_SLACK_MS = 1_000;

/**
 * The data directories this process holds the lock of, shared by every copy
 * of this module loaded in the process. A lock file that names this process's
 * own id is this process's only while its directory is in here (or it was
 * written after this process started); otherwise an earlier run had the same
 * id, as a container or service restart often gives (node as pid 1 again).
 */
const HELD_KEY = Symbol.for('saturn-p2p-bot-kit.store.held-locks');
const HELD_LOCKS: Set<string> = ((globalThis as unknown as Record<symbol, Set<string> | undefined>)[HELD_KEY] ??= new Set<string>());

/** When this process started (ms, wall clock). */
const processStartMs = () => Date.now() - process.uptime() * 1000;

/** Fault-injection points, for the crash tests only. */
export interface StoreHooks {
  /** Runs after the temp file is written, fsynced and closed, right before it is renamed (or linked) into place. */
  beforeRename?: (tmp: string, target: string) => void | Promise<void>;
  /** Runs right after the new file is in place and the directory fsynced, before the read-back. */
  afterPublish?: (target: string) => void | Promise<void>;
}

export interface OpenStoreOptions {
  /** The bot's data directory; created 0700 when missing. The store lives in `<dataDir>/<network>/`. */
  dataDir: string;
  network: Network;
  /** A 32-byte key file (0600) that seals tokens and secrets. Default: env KIT_STORE_KEY_FILE; null: no sealing. */
  keyFile?: string | null;
  env?: Record<string, string | undefined>;
  /** Receives redacted lines only. */
  log?: LogFn;
  /** ms clock, for tests. */
  now?: () => number;
  hooks?: StoreHooks;
}

/** What a trade record may gain after it is created (LocalTrade). */
export interface TradePatch {
  /** Written once: a different value later is RECORD_CONFLICT. */
  counterPha?: string;
  counterBase?: string;
  h?: string;
  phaContract?: string;
  t1?: number;
  /** Replaced by each call (the buyer replaces T2 only while no USDC lock exists: the caller's rule). */
  t2?: number;
  /** Replaced until h is recorded; then a different value is RECORD_CONFLICT. */
  feeShown?: number;
  /** Each given transaction replaces the one of its kind. */
  txs?: Partial<TradeTxs>;
  status?: TradeStatus;
  /** The first value is kept. */
  secretSentAt?: number;
  revealedAt?: number;
  endedAt?: number;
}

/** What an offer record may gain after it is created (LocalOffer). */
export interface OfferPatch {
  /** The current fixed price; also appended to priceHistory. */
  price?: string;
  follow?: FollowSettings | null;
  acceptOnTheirOwn?: boolean;
  /** The first value is kept. */
  closedAt?: number;
}

// ── Shapes ──────────────────────────────────────────────────────────────────

const RAW = /^[1-9]\d{0,39}$/;
const PHA = /^P2K[1-9A-HJ-NP-Za-km-z]{40,50}$/;
const EVM_LOWER = /^0x[0-9a-f]{40}$/;
const TX = /^(0x)?[0-9a-fA-F]{64}$/;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isNet = (v: unknown): v is Network => v === 'devnet' || v === 'mainnet';
const STATUSES = new Set(['requested', 'accepted', 'pha_locked', 'base_locked', 'revealed', 'base_claimed', 'payout_pending', 'done', 'refunding', 'refunded', 'cancelled', 'expired']);
const TX_KINDS = new Set(['phaLock', 'baseLock', 'approve', 'claimBase', 'claimPha', 'refundPha', 'refundBase', 'withdrawOwed']);
const OUTCOMES = new Set(['confirmed', 'failed', 'not_sent', 'done_elsewhere']);
/** A fee per gas in wei (decimal text). */
const FEE = /^(0|[1-9]\d{0,39})$/;
/** Transactions one intent may send at its nonce (the first, then replacements and cancels): far above what a lock's time allows. */
const MAX_RESENDS = 200;

function followOk(f: unknown): f is FollowSettings {
  if (!f || typeof f !== 'object') return false;
  const x = f as Record<string, unknown>;
  return Number.isInteger(x.offsetBps) && Math.abs(x.offsetBps as number) <= 2000 && typeof x.limitPrice === 'string' && RAW.test(x.limitPrice)
    && (x.dailyMax === undefined || (typeof x.dailyMax === 'string' && RAW.test(x.dailyMax)));
}

function txsOk(t: unknown): t is TradeTxs {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return false;
  return Object.entries(t).every(([k, v]) => TX_KINDS.has(k) && typeof v === 'string' && TX.test(v));
}

/** Why a trade record cannot be stored, or null. */
export function tradeShapeProblem(r: unknown, network: Network): string | null {
  if (!r || typeof r !== 'object') return 'not an object';
  const t = r as LocalTrade;
  if (!isId(t.id)) return 'id';
  if (t.network !== network) return 'network';
  if (!isId(t.offerId)) return 'offerId';
  if (t.role !== 'S' && t.role !== 'B') return 'role';
  if (typeof t.maker !== 'boolean') return 'maker';
  if (!tokenOf(t.symbol)) return 'symbol';
  if (!RAW.test(String(t.taz)) || !RAW.test(String(t.usdc)) || !RAW.test(String(t.price))) return 'amounts';
  if (typeof t.taz !== 'string' || typeof t.usdc !== 'string' || typeof t.price !== 'string') return 'amounts';
  if (!PHA.test(t.myPha) || !EVM_LOWER.test(t.myBase)) return 'own addresses';
  if (t.counterPha !== undefined && !PHA.test(t.counterPha)) return 'counterPha';
  if (t.counterBase !== undefined && !EVM_LOWER.test(t.counterBase)) return 'counterBase';
  if (t.h !== undefined && !HEX32.test(t.h)) return 'h';
  if (t.phaContract !== undefined && !isContractName(t.phaContract)) return 'phaContract';
  for (const k of ['t1', 't2', 'secretSentAt', 'revealedAt', 'endedAt'] as const) if (t[k] !== undefined && !isTime(t[k])) return k;
  if (t.feeShown !== undefined && !(Number.isInteger(t.feeShown) && t.feeShown >= 0 && t.feeShown <= 10_000)) return 'feeShown';
  if (t.takerToken !== undefined && !TOKEN_RE.test(t.takerToken)) return 'takerToken';
  if (t.tokenSource !== undefined && t.tokenSource !== 'client' && t.tokenSource !== 'server') return 'tokenSource';
  if (!t.maker && t.takerToken === undefined) return 'takerToken';
  if (!txsOk(t.txs)) return 'txs';
  if (t.status !== undefined && !STATUSES.has(t.status)) return 'status';
  if (!isTime(t.createdAt) || !isTime(t.updatedAt)) return 'times';
  return null;
}

/** Why an offer record cannot be stored, or null. */
export function offerShapeProblem(r: unknown, network: Network): string | null {
  if (!r || typeof r !== 'object') return 'not an object';
  const o = r as LocalOffer;
  if (!isId(o.id)) return 'id';
  if (o.network !== network) return 'network';
  if (o.side !== 'sell' && o.side !== 'buy') return 'side';
  if (!tokenOf(o.symbol)) return 'symbol';
  for (const k of ['tazTotal', 'tazMin', 'tazMax', 'price'] as const) if (typeof o[k] !== 'string' || !RAW.test(o[k])) return k;
  if (!PHA.test(o.makerPha) || !EVM_LOWER.test(o.makerBase)) return 'maker addresses';
  if (!TOKEN_RE.test(o.makerToken)) return 'makerToken';
  if (o.tokenSource !== 'client' && o.tokenSource !== 'server') return 'tokenSource';
  if (!Array.isArray(o.priceHistory) || !o.priceHistory.every((p) => p && typeof p.price === 'string' && RAW.test(p.price) && isTime(p.at))) return 'priceHistory';
  if (o.follow !== null && !followOk(o.follow)) return 'follow';
  if (typeof o.acceptOnTheirOwn !== 'boolean') return 'acceptOnTheirOwn';
  if (o.mode !== 'standard' && o.mode !== 'instant') return 'mode';
  if (!isTime(o.createdAt)) return 'createdAt';
  if (o.closedAt !== null && !isTime(o.closedAt)) return 'closedAt';
  return null;
}

/** Why a pending create cannot be stored, or null. */
export function pendingShapeProblem(r: unknown, network: Network): string | null {
  if (!r || typeof r !== 'object') return 'not an object';
  const p = r as PendingCreate;
  if (p.kind !== 'offer' && p.kind !== 'take') return 'kind';
  if (p.network !== network) return 'network';
  if (typeof p.token !== 'string' || !TOKEN_RE.test(p.token)) return 'token';
  if (p.tokenHash !== tokenHashOf(p.token)) return 'tokenHash';
  if (p.kind === 'take' && !isId(p.offerId)) return 'offerId';
  if (p.kind === 'offer' && p.offerId !== undefined) return 'offerId';
  if (!p.body || typeof p.body !== 'object' || Array.isArray(p.body)) return 'body';
  if (!tokenOf((p.body as { symbol?: unknown }).symbol)) return 'body.symbol';
  if (!isTime(p.createdAt)) return 'createdAt';
  if (p.sentAt !== null && !isTime(p.sentAt)) return 'sentAt';
  return null;
}

/** Why a secret record cannot be stored, or null (it must open its own h). */
export function secretShapeProblem(r: unknown, network: Network): string | null {
  if (!r || typeof r !== 'object') return 'not an object';
  const s = r as SecretRecord;
  if (s.v !== 1) return 'v';
  if (!HEX32.test(s.secret) || !HEX32.test(s.h)) return 'secret or h';
  if (!secretOpens(s.secret, s.h)) return 'the secret does not open h';
  if (!isId(s.tradeId)) return 'tradeId';
  if (s.network !== network) return 'network';
  if (!tokenOf(s.symbol)) return 'symbol';
  if (typeof s.taz !== 'string' || !RAW.test(s.taz)) return 'taz';
  if (!PHA.test(s.sPha) || !PHA.test(s.bPha)) return 'parties';
  if (s.role !== 'S' && s.role !== 'B') return 'role';
  if (!isTime(s.createdAt)) return 'createdAt';
  return null;
}

/** What makes two pending entries the same create: everything but when it was made and last sent. */
function pendingIdentity(p: PendingCreate): Record<string, unknown> {
  const { createdAt: _made, sentAt: _sent, ...rest } = JSON.parse(JSON.stringify(p)) as PendingCreate;
  return rest;
}

function journalShapeProblem(r: unknown, network: Network, tradeId: number): string | null {
  if (!r || typeof r !== 'object') return 'not an object';
  const j = r as Journal;
  if (j.tradeId !== tradeId || j.network !== network || !Array.isArray(j.intents)) return 'header';
  const ids = new Set<string>();
  for (const i of j.intents) {
    if (!i || typeof i.id !== 'string' || !/^[a-zA-Z]+-\d+$/.test(i.id) || ids.has(i.id)) return 'intent id';
    ids.add(i.id);
    if (!TX_KINDS.has(i.kind) || !isTime(i.at)) return 'intent';
    if (i.h !== undefined && !HEX32.test(i.h)) return 'intent h';
    if (i.nonce !== undefined && !(Number.isSafeInteger(i.nonce) && i.nonce >= 0)) return 'intent nonce';
    if (i.txHash !== undefined && !TX.test(i.txHash)) return 'intent txHash';
    if (i.outcome !== undefined && !OUTCOMES.has(i.outcome)) return 'intent outcome';
    for (const k of ['hashes', 'cancelHashes'] as const) {
      const v = i[k];
      if (v === undefined) continue;
      if (!Array.isArray(v) || v.length === 0 || v.length > MAX_RESENDS || !v.every((x) => typeof x === 'string' && TX.test(x))) return `intent ${k}`;
      if (i.nonce === undefined) return `intent ${k} without a nonce`;
    }
    for (const k of ['maxFee', 'maxPrio'] as const) if (i[k] !== undefined && !(typeof i[k] === 'string' && FEE.test(i[k]))) return `intent ${k}`;
    if (i.lastSentAt !== undefined && !isTime(i.lastSentAt)) return 'intent lastSentAt';
  }
  return null;
}

// ── Files ───────────────────────────────────────────────────────────────────

const errCode = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code;

/** fsync a directory, so a rename, link or unlink in it survives a power cut (ignored where the platform cannot). */
async function fsyncDir(dir: string): Promise<void> {
  let fh;
  try {
    fh = await open(dir, 'r');
    await fh.sync();
  } catch (e) {
    if (!['EISDIR', 'EINVAL', 'EPERM', 'EBADF', 'ENOTSUP'].includes(errCode(e) ?? '')) throw e;
  } finally {
    await fh?.close();
  }
}

/** Create `file` with 'wx' and 0o600, write `text`, fsync and close it. */
async function writeSynced(file: string, text: string): Promise<void> {
  const fh = await open(file, 'wx', 0o600);
  try {
    await fh.writeFile(text, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
}

const tmpName = (file: string) => `${file}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;

/** Whether a process with this id runs (EPERM: it runs under another user). */
function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errCode(e) === 'EPERM';
  }
}

interface LockInfo { pid: number; host: string; startedAt: number; nonce: string }

/** A 32-byte store key from a key file: 32 raw bytes, or 64 hex digits (spaces around allowed). */
async function loadStoreKey(file: string): Promise<Buffer> {
  const buf = await readSecretFile(file, 'store key (KIT_STORE_KEY_FILE)');
  try {
    if (buf.length === 32) return Buffer.from(buf);
    const text = buf.toString('utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex');
    throw new SafetyError(SAFETY.STORE_KEY, `The store key file ${file} must hold exactly 32 bytes (raw, or as 64 hex digits).`);
  } finally {
    buf.fill(0);
  }
}

interface Sealed { sealed: 'aes-256-gcm'; v: 1; iv: string; tag: string; data: string }

const isSealed = (o: unknown): o is Sealed => !!o && typeof o === 'object' && (o as Sealed).sealed === 'aes-256-gcm' && (o as Sealed).v === 1;

/** Opens a store; see the file comment. */
export async function openStore(o: OpenStoreOptions): Promise<KitStore> {
  if (!isNet(o.network)) throw new SafetyError(SAFETY.NETWORK_OFF, 'The network is devnet or mainnet.');
  if (typeof o.dataDir !== 'string' || !o.dataDir) throw new SafetyError(SAFETY.STORE_CORRUPT, 'No data directory was given.');
  const env = o.env ?? process.env;
  const keyFile = o.keyFile === undefined ? (env.KIT_STORE_KEY_FILE || null) : o.keyFile;
  const key = keyFile ? await loadStoreKey(keyFile) : null;
  const store = new KitStore(o, key);
  await store.init();
  return store;
}

export class KitStore {
  readonly network: Network;
  /** `<dataDir>/<network>`. */
  readonly dir: string;
  readonly sealed: boolean;
  readonly #dataDir: string;
  readonly #key: Buffer | null;
  readonly #log: LogFn;
  readonly #now: () => number;
  readonly #hooks: StoreHooks;
  readonly #nonce = randomBytes(16).toString('hex');
  #closed = false;
  #held = false;
  /** The store directory's real path: this process's key for its lock (HELD_LOCKS). */
  #lockKey: string;
  readonly #queues = new Map<string, Promise<unknown>>();

  /** Use openStore(). */
  constructor(o: OpenStoreOptions, key: Buffer | null) {
    this.network = o.network;
    this.#dataDir = o.dataDir;
    this.dir = join(o.dataDir, o.network);
    this.#lockKey = this.dir;
    this.#key = key;
    this.sealed = !!key;
    this.#log = redactedLog(o.log);
    this.#now = o.now ?? Date.now;
    this.#hooks = o.hooks ?? {};
  }

  // ── Opening, the lock, closing ──────────────────────────────────────────

  /** @internal Creates the directories, takes the lock, checks the key, cleans up after a crash. */
  async init(): Promise<void> {
    await this.#ensureDir(this.#dataDir, false);
    await this.#ensureDir(this.dir, true);
    this.#lockKey = await realpath(this.dir);
    await this.#acquireLock();
    try {
      for (const k of STORE_KINDS) await this.#ensureDir(join(this.dir, k), true);
      await this.#checkMeta();
      await this.#sweep();
    } catch (e) {
      await this.close();
      throw e;
    }
  }

  /**
   * Create a directory 0700 when missing (with any missing parents, also 0700,
   * for the data directory); `strict`: an existing one is set to 0700 too, and
   * must end up so.
   */
  async #ensureDir(dir: string, strict: boolean): Promise<void> {
    let made = false;
    try {
      if (strict) {
        await mkdir(dir, { mode: 0o700 });
        made = true;
      } else {
        made = (await mkdir(dir, { recursive: true, mode: 0o700 })) !== undefined;
      }
    } catch (e) {
      if (errCode(e) !== 'EEXIST') throw new SafetyError(SAFETY.STORE_MODE, `Cannot create ${dir} (${errCode(e) ?? 'error'}).`);
    }
    const st = await stat(dir);
    if (!st.isDirectory()) throw new SafetyError(SAFETY.STORE_MODE, `${dir} is not a directory.`);
    if ((made || strict) && (st.mode & 0o777) !== 0o700) {
      await chmod(dir, 0o700);
      if (((await stat(dir)).mode & 0o077) !== 0) throw new SafetyError(SAFETY.STORE_MODE, `${dir} could not be made private (chmod 700).`);
    }
  }

  async #readLock(): Promise<{ info: LockInfo | null; mtimeMs: number } | null> {
    const file = join(this.dir, LOCK_FILE);
    let text: string;
    let mtimeMs: number;
    try {
      [text, mtimeMs] = await Promise.all([readFile(file, 'utf8'), stat(file).then((s) => s.mtimeMs)]);
    } catch (e) {
      if (errCode(e) === 'ENOENT') return null;
      throw e;
    }
    try {
      const o = JSON.parse(text) as LockInfo;
      const ok = Number.isSafeInteger(o.pid) && typeof o.host === 'string' && isTime(o.startedAt) && typeof o.nonce === 'string';
      return { info: ok ? o : null, mtimeMs };
    } catch {
      return { info: null, mtimeMs };
    }
  }

  async #acquireLock(): Promise<void> {
    const file = join(this.dir, LOCK_FILE);
    // startedAt is wall-clock time (never the injected test clock): it is compared with this process's start.
    const mine: LockInfo = { pid: process.pid, host: hostname(), startedAt: Date.now(), nonce: this.#nonce };
    for (let attempt = 0; attempt < 5; attempt++) {
      if (await this.#publishNew(file, JSON.stringify(mine) + '\n', false)) {
        const back = await this.#readLock();
        if (back?.info?.nonce !== this.#nonce) throw new SafetyError(SAFETY.STORE_LOCK_LOST, `The lock of ${this.dir} changed while it was being taken.`);
        this.#held = true;
        HELD_LOCKS.add(this.#lockKey);
        return;
      }
      const held = await this.#readLock();
      if (!held) continue;
      let takeover: string;
      if (held.info) {
        const i = held.info;
        const since = new Date(i.startedAt).toISOString();
        if (i.host !== hostname()) {
          throw new SafetyError(SAFETY.STORE_LOCKED, `${this.dir} is in use by process ${i.pid} on ${i.host} (since ${since}). One bot per data directory; if that process is gone, delete ${file}.`);
        }
        if (i.pid === process.pid) {
          // This process's own id: a store this process still has open, or a lock left by an earlier run that
          // had the same id (a restarted container or service often runs the bot under the same pid again).
          if (HELD_LOCKS.has(this.#lockKey) || i.startedAt >= processStartMs() - PID_START_SLACK_MS) {
            throw new SafetyError(SAFETY.STORE_LOCKED, `${this.dir} is in use by process ${i.pid}, this one (since ${since}): it is already open here. One store per data directory; close the other one first.`);
          }
          takeover = `an earlier run with this same process id ${i.pid} (started ${since}) held ${this.dir} and has ended; taking over its lock`;
        } else if (pidAlive(i.pid)) {
          throw new SafetyError(SAFETY.STORE_LOCKED, `${this.dir} is in use by process ${i.pid} (since ${since}). One bot per data directory; if that process is not this kit, delete ${file}.`);
        } else {
          takeover = `process ${i.pid} (started ${since}) held ${this.dir} and is no longer running; taking over its lock`;
        }
      } else {
        if (Date.now() - held.mtimeMs < LOCK_UNREADABLE_GRACE_MS) {
          throw new SafetyError(SAFETY.STORE_LOCKED, `${this.dir} is being opened by another process right now; try again in a few seconds.`);
        }
        takeover = `the lock file of ${this.dir} cannot be read (a crash while it was written); taking it over`;
      }
      // Remove only the lock judged stale: when another process replaced it meanwhile, judge again.
      const again = await this.#readLock();
      if (!again) continue;
      const same = held.info ? again.info?.nonce === held.info.nonce : !again.info && again.mtimeMs === held.mtimeMs;
      if (!same) continue;
      this.#log(`[store] ${this.network}: ${takeover}`);
      try {
        await unlink(file);
        await fsyncDir(this.dir);
      } catch (e) {
        if (errCode(e) !== 'ENOENT') throw e;
      }
    }
    throw new SafetyError(SAFETY.STORE_LOCKED, `Could not take the lock of ${this.dir}.`);
  }

  /** Throws unless this store still holds its lock (checked before every write). */
  async assertLock(): Promise<void> {
    if (this.#closed) throw new SafetyError(SAFETY.STORE_CLOSED, `The store of ${this.dir} is closed.`);
    const held = await this.#readLock();
    if (!this.#held || held?.info?.nonce !== this.#nonce || held.info.pid !== process.pid) {
      if (this.#held) HELD_LOCKS.delete(this.#lockKey);
      this.#held = false;
      throw new SafetyError(SAFETY.STORE_LOCK_LOST, `This process no longer holds the lock of ${this.dir}: another process may be using it. Nothing more is written.`);
    }
  }

  /** Release the lock (only when it is still this store's). Later calls throw STORE_CLOSED. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#held) return;
    this.#held = false;
    HELD_LOCKS.delete(this.#lockKey);
    try {
      const held = await this.#readLock();
      if (held?.info?.nonce === this.#nonce) {
        await unlink(join(this.dir, LOCK_FILE));
        await fsyncDir(this.dir);
      }
    } catch { /* the lock of a dead process is taken over at the next start */ }
  }

  async #checkMeta(): Promise<void> {
    const file = join(this.dir, META_FILE);
    let meta: Record<string, unknown> | null = null;
    try {
      meta = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    } catch (e) {
      if (errCode(e) !== 'ENOENT') throw new SafetyError(SAFETY.STORE_CORRUPT, `${file} cannot be read.`);
    }
    if (meta && (meta.v !== 1 || meta.network !== this.network)) throw new SafetyError(SAFETY.STORE_CORRUPT, `${file} is not this store's (${this.network}).`);
    const check = meta?.sealCheck;
    if (check !== undefined) {
      if (!this.#key) throw new SafetyError(SAFETY.STORE_KEY, `${this.dir} is sealed: set KIT_STORE_KEY_FILE to the key it was sealed with.`);
      let ok = false;
      try { ok = isSealed(check) && this.#unseal(check, META_FILE).toString('utf8') === SEAL_CHECK_TEXT; } catch { ok = false; }
      if (!ok) throw new SafetyError(SAFETY.STORE_KEY, `KIT_STORE_KEY_FILE is not the key ${this.dir} was sealed with.`);
      return;
    }
    if (meta && !this.#key) return;
    const next: Record<string, unknown> = { v: 1, network: this.network, createdAt: (meta?.createdAt as number) ?? this.#now() };
    if (this.#key) {
      next.sealCheck = this.#seal(Buffer.from(SEAL_CHECK_TEXT, 'utf8'), META_FILE);
      if (meta) this.#log(`[store] ${this.network}: sealing tokens and secrets from now on (KIT_STORE_KEY_FILE); files written before stay readable: offers and trades are sealed when next written, while kept secrets and pending entries (never rewritten) stay unsealed until removed`);
    }
    const text = JSON.stringify(next, null, 2) + '\n';
    await this.assertLock();
    await this.#publishReplace(file, text, false);
    if ((await readFile(file, 'utf8')) !== text) throw new SafetyError(SAFETY.STORE_READBACK, `${file} did not read back as written.`);
  }

  /** Remove temp files a crash left behind and make every file private again. */
  async #sweep(): Promise<void> {
    for (const name of await readdir(this.dir)) {
      if (TMP_RE.test(name)) {
        // Another process that is opening this folder right now writes its own .lock temp file here: leave a live one's.
        const pid = Number(/\.tmp\.(\d+)\./.exec(name)?.[1]);
        if (pid !== process.pid && pidAlive(pid)) continue;
        await rm(join(this.dir, name), { force: true });
        this.#log(`[store] ${this.network}: removed ${name}, left by an interrupted write`);
      }
    }
    for (const k of STORE_KINDS) {
      const dir = join(this.dir, k);
      for (const name of await readdir(dir)) {
        const file = join(dir, name);
        if (TMP_RE.test(name)) {
          await rm(file, { force: true });
          this.#log(`[store] ${this.network}: removed ${k}/${name}, left by an interrupted write (the file it was for is unchanged)`);
          continue;
        }
        const st = await stat(file);
        if (st.isFile() && (st.mode & 0o077) !== 0) {
          await chmod(file, 0o600);
          this.#log(`[store] ${this.network}: ${k}/${name} was readable by others; set to 0600`);
        }
      }
    }
    await fsyncDir(this.dir);
  }

  // ── Low-level writes ───────────────────────────────────────────────────────

  /** Run `fn` after every earlier queued call for `key` (one writer per file inside this process). */
  #serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#queues.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.#queues.set(key, tail);
    void tail.then(() => { if (this.#queues.get(key) === tail) this.#queues.delete(key); });
    return run;
  }

  /** Steps 1-4 for a file that may be replaced. */
  async #publishReplace(file: string, text: string, hooks = true): Promise<void> {
    const tmp = tmpName(file);
    await writeSynced(tmp, text);
    try {
      if (hooks) await this.#hooks.beforeRename?.(tmp, file);
      await rename(tmp, file);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    await fsyncDir(dirname(file));
    if (hooks) await this.#hooks.afterPublish?.(file);
  }

  /** Steps 1-4 for a file that must never be overwritten. False when it already exists (nothing written). */
  async #publishNew(file: string, text: string, hooks = true): Promise<boolean> {
    const tmp = tmpName(file);
    await writeSynced(tmp, text);
    try {
      if (hooks) await this.#hooks.beforeRename?.(tmp, file);
      try {
        await link(tmp, file);
      } catch (e) {
        const c = errCode(e);
        if (c === 'EEXIST') return false;
        if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EMLINK'].includes(c ?? '')) throw e;
        // A file system without hard links: 'wx' straight on the target (not atomic, but never overwrites).
        try {
          await writeSynced(file, text);
        } catch (e2) {
          if (errCode(e2) === 'EEXIST') return false;
          throw e2;
        }
      }
    } finally {
      await rm(tmp, { force: true });
    }
    await fsyncDir(dirname(file));
    if (hooks) await this.#hooks.afterPublish?.(file);
    return true;
  }

  #aad(rel: string): Buffer {
    return Buffer.from(`saturn-p2p-bot-kit|v1|${this.network}|${rel}`, 'utf8');
  }

  #seal(plain: Buffer, rel: string): Sealed {
    const iv = randomBytes(GCM_IV_BYTES);
    const c = createCipheriv('aes-256-gcm', this.#key!, iv, { authTagLength: GCM_TAG_BYTES });
    c.setAAD(this.#aad(rel));
    const data = Buffer.concat([c.update(plain), c.final()]);
    return { sealed: 'aes-256-gcm', v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
  }

  /** Open a sealed value; throws (never returns unchecked bytes) unless it is exactly 12 IV bytes, a full 16-byte tag and the key's. */
  #unseal(s: Sealed, rel: string): Buffer {
    if (!this.#key) throw new SafetyError(SAFETY.STORE_KEY, `${rel} is sealed and no store key is set (KIT_STORE_KEY_FILE).`);
    if (typeof s.iv !== 'string' || typeof s.tag !== 'string' || typeof s.data !== 'string') throw new Error('malformed seal');
    const iv = Buffer.from(s.iv, 'base64');
    const tag = Buffer.from(s.tag, 'base64');
    // A shorter tag is easier to forge, and Node accepts one as short as 4 bytes unless told the length.
    if (iv.length !== GCM_IV_BYTES || tag.length !== GCM_TAG_BYTES) throw new Error('malformed seal');
    const d = createDecipheriv('aes-256-gcm', this.#key, iv, { authTagLength: GCM_TAG_BYTES });
    d.setAAD(this.#aad(rel));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(Buffer.from(s.data, 'base64')), d.final()]);
  }

  #path(kind: StoreKind, name: string): string {
    return join(this.dir, kind, `${name}.json`);
  }

  /** A record as file text (sealed for the token and secret kinds when a key is set). */
  #encode(kind: StoreKind, name: string, value: unknown): string {
    const plain = JSON.stringify(value, null, 2) + '\n';
    if (!this.#key || !SEALED_KINDS.has(kind)) return plain;
    return JSON.stringify(this.#seal(Buffer.from(plain, 'utf8'), `${kind}/${name}.json`)) + '\n';
  }

  /** File text -> the record's JSON value; STORE_CORRUPT (or STORE_KEY) when it cannot be read. */
  #decode(kind: StoreKind, name: string, text: string): unknown {
    const rel = `${kind}/${name}.json`;
    let o: unknown;
    try {
      o = JSON.parse(text);
    } catch {
      throw new SafetyError(SAFETY.STORE_CORRUPT, `${rel} in ${this.dir} is not JSON.`);
    }
    if (!isSealed(o)) return o;
    let plain: Buffer;
    try {
      plain = this.#unseal(o, rel);
    } catch (e) {
      if (e instanceof SafetyError) throw e;
      throw new SafetyError(SAFETY.STORE_CORRUPT, `${rel} in ${this.dir} does not open with the store key (changed, moved or damaged).`);
    }
    try {
      return JSON.parse(plain.toString('utf8'));
    } catch {
      throw new SafetyError(SAFETY.STORE_CORRUPT, `${rel} in ${this.dir} is not JSON inside its seal.`);
    }
  }

  async #read(kind: StoreKind, name: string): Promise<unknown | null> {
    let text: string;
    try {
      text = await readFile(this.#path(kind, name), 'utf8');
    } catch (e) {
      if (errCode(e) === 'ENOENT') return null;
      throw new SafetyError(SAFETY.STORE_CORRUPT, `${kind}/${name}.json in ${this.dir} cannot be read (${errCode(e) ?? 'error'}).`);
    }
    return this.#decode(kind, name, text);
  }

  /** Step 5: the file reads back exactly as written, and as the value meant. */
  async #verify(kind: StoreKind, name: string, text: string, value: unknown): Promise<void> {
    const file = this.#path(kind, name);
    let back: string;
    try {
      back = await readFile(file, 'utf8');
    } catch {
      throw new SafetyError(SAFETY.STORE_READBACK, `${kind}/${name}.json in ${this.dir} could not be read back after it was written.`);
    }
    if (back !== text) throw new SafetyError(SAFETY.STORE_READBACK, `${kind}/${name}.json in ${this.dir} did not read back as written.`);
    const decoded = this.#decode(kind, name, back);
    if (!isDeepStrictEqual(decoded, JSON.parse(JSON.stringify(value)))) throw new SafetyError(SAFETY.STORE_READBACK, `${kind}/${name}.json in ${this.dir} did not read back as the record written.`);
  }

  /** Write (replacing) and read back. */
  async #put(kind: StoreKind, name: string, value: unknown): Promise<void> {
    await this.assertLock();
    const text = this.#encode(kind, name, value);
    await this.#publishReplace(this.#path(kind, name), text);
    await this.#verify(kind, name, text, value);
  }

  /** Write only when absent and read back. False (nothing written) when the file exists. */
  async #putNew(kind: StoreKind, name: string, value: unknown): Promise<boolean> {
    await this.assertLock();
    const text = this.#encode(kind, name, value);
    if (!(await this.#publishNew(this.#path(kind, name), text))) return false;
    await this.#verify(kind, name, text, value);
    return true;
  }

  async #remove(kind: StoreKind, name: string): Promise<boolean> {
    await this.assertLock();
    try {
      await unlink(this.#path(kind, name));
    } catch (e) {
      if (errCode(e) === 'ENOENT') return false;
      throw e;
    }
    await fsyncDir(join(this.dir, kind));
    return true;
  }

  async #names(kind: StoreKind): Promise<string[]> {
    const out: string[] = [];
    for (const n of await readdir(join(this.dir, kind))) if (n.endsWith('.json') && !TMP_RE.test(n)) out.push(n.slice(0, -5));
    return out;
  }

  #corrupt(kind: StoreKind, name: string, why: string): SafetyError {
    return new SafetyError(SAFETY.STORE_CORRUPT, `${kind}/${name}.json in ${this.dir} is not a valid record (${why}).`);
  }

  // ── Pending creates (control tokens before their POST) ──────────────────

  /**
   * Durable write 1: keep a control token before its POST. Never replaces an
   * entry: the same create again (the same token, kind, offer, body and seen;
   * its createdAt and sentAt aside, so a retry after markPendingSent matches)
   * is a no-op that returns the kept entry; another create under the same
   * token hash is RECORD_CONFLICT. Returns the stored entry, read back.
   */
  putPending(p: PendingCreate): Promise<PendingCreate> {
    const why = pendingShapeProblem(p, this.network);
    if (why) return Promise.reject(new SafetyError(SAFETY.RECORD_INVALID, `A pending create is not well formed (${why}).`));
    return this.#serial(`pending/${p.tokenHash}`, async () => {
      if (await this.#putNew('pending', p.tokenHash, p)) return p;
      const have = await this.getPending(p.tokenHash);
      if (have && isDeepStrictEqual(pendingIdentity(have), pendingIdentity(p))) return have;
      throw new SafetyError(SAFETY.RECORD_CONFLICT, `A different pending create is already kept under token hash ${p.tokenHash.slice(0, 8)}….`);
    });
  }

  /** Record when a pending create was (re)sent; nothing else of it changes. */
  markPendingSent(tokenHash: string, at: number): Promise<PendingCreate> {
    return this.#serial(`pending/${tokenHash}`, async () => {
      const have = await this.getPending(tokenHash);
      if (!have) throw new SafetyError(SAFETY.RECORD_CONFLICT, 'No pending create is kept under this token hash.');
      if (!isTime(at)) throw new SafetyError(SAFETY.RECORD_INVALID, 'A send time is a positive integer of milliseconds.');
      const next = { ...have, sentAt: at };
      await this.#put('pending', tokenHash, next);
      return next;
    });
  }

  async getPending(tokenHash: string): Promise<PendingCreate | null> {
    if (typeof tokenHash !== 'string' || !TOKEN_RE.test(tokenHash)) return null;
    const v = await this.#read('pending', tokenHash);
    if (v == null) return null;
    const why = pendingShapeProblem(v, this.network);
    if (why || (v as PendingCreate).tokenHash !== tokenHash) throw this.#corrupt('pending', tokenHash, why ?? 'name');
    return v as PendingCreate;
  }

  async listPending(): Promise<PendingCreate[]> {
    const out: PendingCreate[] = [];
    for (const n of await this.#names('pending')) {
      if (!TOKEN_RE.test(n)) throw this.#corrupt('pending', n, 'name');
      const p = await this.getPending(n);
      if (p) out.push(p);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Drop a pending create once its row is recorded (or it was refused). True when it was there. */
  deletePending(tokenHash: string): Promise<boolean> {
    if (typeof tokenHash !== 'string' || !TOKEN_RE.test(tokenHash)) return Promise.resolve(false);
    return this.#serial(`pending/${tokenHash}`, () => this.#remove('pending', tokenHash));
  }

  // ── Offers ───────────────────────────────────────────────────────────────

  /**
   * Keep a new offer and read it back. The same offer again is a no-op;
   * another offer under the same id (other figures, maker or token) is
   * RECORD_CONFLICT.
   */
  addOffer(o: LocalOffer): Promise<LocalOffer> {
    const why = offerShapeProblem(o, this.network);
    if (why) return Promise.reject(new SafetyError(SAFETY.RECORD_INVALID, `An offer record is not well formed (${why}).`));
    return this.#serial(`offers/${o.id}`, async () => {
      if (await this.#putNew('offers', String(o.id), o)) return o;
      const have = (await this.getOffer(o.id))!;
      const fixed = ['id', 'network', 'side', 'symbol', 'makerPha', 'makerBase', 'tazTotal', 'tazMin', 'tazMax', 'makerToken', 'tokenSource', 'mode'] as const;
      if (fixed.every((k) => have[k] === o[k])) return have;
      throw new SafetyError(SAFETY.RECORD_CONFLICT, `Offer #${o.id} is already kept for another offer.`);
    });
  }

  /** Change what may change in an offer record (price, follow, accept setting, closedAt); returns it read back. */
  patchOffer(id: number, patch: OfferPatch): Promise<LocalOffer> {
    return this.#serial(`offers/${id}`, async () => {
      const have = await this.getOffer(id);
      if (!have) throw new SafetyError(SAFETY.RECORD_CONFLICT, `No offer #${id} is kept.`);
      const next: LocalOffer = { ...have, priceHistory: [...have.priceHistory] };
      if (patch.price !== undefined) {
        next.price = patch.price;
        next.priceHistory.push({ price: patch.price, at: this.#now() });
      }
      if (patch.follow !== undefined) next.follow = patch.follow;
      if (patch.acceptOnTheirOwn !== undefined) next.acceptOnTheirOwn = patch.acceptOnTheirOwn;
      if (patch.closedAt !== undefined && next.closedAt == null) next.closedAt = patch.closedAt;
      const why = offerShapeProblem(next, this.network);
      if (why) throw new SafetyError(SAFETY.RECORD_INVALID, `Offer #${id} would not be well formed (${why}).`);
      await this.#put('offers', String(id), next);
      return next;
    });
  }

  async getOffer(id: number): Promise<LocalOffer | null> {
    if (!isId(id)) return null;
    const v = await this.#read('offers', String(id));
    if (v == null) return null;
    const why = offerShapeProblem(v, this.network);
    if (why || (v as LocalOffer).id !== id) throw this.#corrupt('offers', String(id), why ?? 'id');
    return v as LocalOffer;
  }

  async listOffers(): Promise<LocalOffer[]> {
    const out: LocalOffer[] = [];
    for (const n of await this.#names('offers')) {
      if (!/^[1-9]\d{0,15}$/.test(n)) throw this.#corrupt('offers', n, 'name');
      const o = await this.getOffer(Number(n));
      if (o) out.push(o);
    }
    return out.sort((a, b) => a.id - b.id);
  }

  // ── Trades ───────────────────────────────────────────────────────────────

  /**
   * Keep a new trade and read it back (check 13). The same trade again is a
   * no-op that returns the kept record; a trade id the store already keeps for
   * another trade (other figures, side, addresses or token) is RECORD_CONFLICT.
   */
  addTrade(t: LocalTrade): Promise<LocalTrade> {
    const why = tradeShapeProblem(t, this.network);
    if (why) return Promise.reject(new SafetyError(SAFETY.RECORD_INVALID, `A trade record is not well formed (${why}).`));
    return this.#serial(`trades/${t.id}`, async () => {
      if (await this.#putNew('trades', String(t.id), t)) return t;
      const have = (await this.getTrade(t.id))!;
      if (TRADE_FIXED.every((k) => have[k] === t[k])) return have;
      throw new SafetyError(SAFETY.RECORD_CONFLICT, `Trade #${t.id} is already kept for another trade; refusing to replace it.`);
    });
  }

  /**
   * Record progress on a kept trade and read it back. Write-once fields
   * (counterPha, counterBase, h, phaContract, t1) never change: a different
   * value is RECORD_CONFLICT. secretSentAt, revealedAt and endedAt keep their
   * first value. t2, txs and status are replaced. feeShown is replaced only
   * until h is recorded: from then on the lock exists and the fee its seller
   * was shown is what the reveal and the claim check (checks 32 and 54), so a
   * different value is RECORD_CONFLICT.
   */
  patchTrade(id: number, patch: TradePatch): Promise<LocalTrade> {
    return this.#serial(`trades/${id}`, async () => {
      const have = await this.getTrade(id);
      if (!have) throw new SafetyError(SAFETY.RECORD_CONFLICT, `No trade #${id} is kept.`);
      const next: LocalTrade = { ...have, txs: { ...have.txs } };
      for (const k of ['counterPha', 'counterBase', 'h', 'phaContract', 't1'] as const) {
        const v = patch[k];
        if (v === undefined) continue;
        const norm = (k === 'counterBase' || k === 'h') && typeof v === 'string' ? v.toLowerCase() : v;
        if (have[k] !== undefined && have[k] !== norm) throw new SafetyError(SAFETY.RECORD_CONFLICT, `Trade #${id} already records another ${k}; it never changes.`);
        (next as unknown as Record<string, unknown>)[k] = norm;
      }
      for (const k of ['secretSentAt', 'revealedAt', 'endedAt'] as const) {
        if (patch[k] !== undefined && have[k] === undefined) next[k] = patch[k];
      }
      if (patch.t2 !== undefined) next.t2 = patch.t2;
      if (patch.feeShown !== undefined) {
        if (have.h !== undefined && have.feeShown !== undefined && have.feeShown !== patch.feeShown) {
          throw new SafetyError(SAFETY.RECORD_CONFLICT, `Trade #${id} is locked under its h with another fee shown; that fee never changes now.`);
        }
        next.feeShown = patch.feeShown;
      }
      if (patch.status !== undefined) next.status = patch.status;
      if (patch.txs) for (const [k, v] of Object.entries(patch.txs)) if (v !== undefined) (next.txs as Record<string, string>)[k] = v;
      next.updatedAt = Math.max(this.#now(), have.updatedAt);
      const why = tradeShapeProblem(next, this.network);
      if (why) throw new SafetyError(SAFETY.RECORD_INVALID, `Trade #${id} would not be well formed (${why}).`);
      await this.#put('trades', String(id), next);
      return next;
    });
  }

  async getTrade(id: number): Promise<LocalTrade | null> {
    if (!isId(id)) return null;
    const v = await this.#read('trades', String(id));
    if (v == null) return null;
    const why = tradeShapeProblem(v, this.network);
    if (why || (v as LocalTrade).id !== id) throw this.#corrupt('trades', String(id), why ?? 'id');
    return v as LocalTrade;
  }

  async listTrades(): Promise<LocalTrade[]> {
    const out: LocalTrade[] = [];
    for (const n of await this.#names('trades')) {
      if (!/^[1-9]\d{0,15}$/.test(n)) throw this.#corrupt('trades', n, 'name');
      const t = await this.getTrade(Number(n));
      if (t) out.push(t);
    }
    return out.sort((a, b) => a.id - b.id);
  }

  // ── Secrets ──────────────────────────────────────────────────────────────

  /**
   * Durable write 2: keep a secret before anything is locked behind its h,
   * fsynced and read back. Never overwritten: the same record again is a
   * no-op; a different record under the same h is SECRET_CONFLICT. A record
   * whose secret does not open its h is never written (SECRET_INVALID).
   */
  putSecret(s: SecretRecord): Promise<SecretRecord> {
    const why = secretShapeProblem(s, this.network);
    if (why) return Promise.reject(new SafetyError(SAFETY.SECRET_INVALID, `A secret record is not well formed (${why}).`));
    return this.#serial(`secrets/${s.h}`, async () => {
      if (await this.#putNew('secrets', s.h, s)) return s;
      const have = await this.getSecret(s.h);
      if (have && isDeepStrictEqual(have, JSON.parse(JSON.stringify(s)))) return have;
      throw new SafetyError(SAFETY.SECRET_CONFLICT, `A different secret is already kept for this h (trade #${have?.tradeId ?? '?'}); it is never overwritten.`);
    });
  }

  /** The secret kept for h, checked to open it; null when none is kept. */
  async getSecret(h: string): Promise<SecretRecord | null> {
    if (typeof h !== 'string' || !HEX32.test(h)) return null;
    const v = await this.#read('secrets', h);
    if (v == null) return null;
    const why = secretShapeProblem(v, this.network);
    if (why || (v as SecretRecord).h !== h) throw this.#corrupt('secrets', h, why ?? 'h');
    return v as SecretRecord;
  }

  async listSecrets(): Promise<SecretRecord[]> {
    const out: SecretRecord[] = [];
    for (const n of await this.#names('secrets')) {
      if (!HEX32.test(n)) throw this.#corrupt('secrets', n, 'name');
      const s = await this.getSecret(n);
      if (s) out.push(s);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Every secret made for one trade (an earlier one is kept when a lock is replaced), oldest first. */
  async secretsOfTrade(tradeId: number): Promise<SecretRecord[]> {
    return (await this.listSecrets()).filter((s) => s.tradeId === tradeId);
  }

  /**
   * Check 38: whether h is used by another local trade (its record's h, or a
   * secret kept for another trade).
   */
  async hashUsedElsewhere(h: string, tradeId: number): Promise<boolean> {
    const want = String(h).toLowerCase();
    if ((await this.listTrades()).some((t) => t.id !== tradeId && t.h === want)) return true;
    const s = await this.getSecret(want);
    return !!s && s.tradeId !== tradeId;
  }

  /**
   * Remove a kept secret. The kit never calls this itself: secrets are kept
   * until their trade is terminal and both locks are final, plus 7 days, and
   * only examples/prune.ts removes them, when its operator runs it.
   */
  pruneSecret(h: string): Promise<boolean> {
    if (typeof h !== 'string' || !HEX32.test(h)) return Promise.resolve(false);
    return this.#serial(`secrets/${h}`, () => this.#remove('secrets', h));
  }

  // ── The journal (every send, before it goes out) ────────────────────────

  async getJournal(tradeId: number): Promise<Journal> {
    if (!isId(tradeId)) throw new SafetyError(SAFETY.RECORD_INVALID, 'A trade id is a positive integer.');
    const v = await this.#read('journal', String(tradeId));
    if (v == null) return { tradeId, network: this.network, intents: [] };
    const why = journalShapeProblem(v, this.network, tradeId);
    if (why) throw this.#corrupt('journal', String(tradeId), why);
    return v as Journal;
  }

  /**
   * Durable write 3: record a send before it goes out, fsynced and read back.
   * Returns the intent (its id names it in recordSent and resolveIntent).
   */
  addIntent(tradeId: number, i: { kind: IntentKind; h?: string; nonce?: number }): Promise<Intent> {
    return this.#serial(`journal/${tradeId}`, async () => {
      const j = await this.getJournal(tradeId);
      // Unique within the journal: one more than every number already used (and than the count).
      const n = j.intents.reduce((m, x) => Math.max(m, Number(/-(\d+)$/.exec(x.id)?.[1] ?? 0)), j.intents.length) + 1;
      const intent: Intent = { id: `${i.kind}-${n}`, kind: i.kind, at: this.#now() };
      if (i.h !== undefined) intent.h = i.h.toLowerCase();
      if (i.nonce !== undefined) intent.nonce = i.nonce;
      const next: Journal = { ...j, intents: [...j.intents, intent] };
      const why = journalShapeProblem(next, this.network, tradeId);
      if (why) throw new SafetyError(SAFETY.RECORD_INVALID, `The intent is not well formed (${why}).`);
      await this.#put('journal', String(tradeId), next);
      return intent;
    });
  }

  /**
   * Durable write 4: the tx hash (and nonce), as soon as the send returns.
   * Written once per intent. A Base send also records its fees, so a
   * replacement at the same nonce knows what it must outbid.
   */
  recordSent(tradeId: number, intentId: string, sent: { txHash: string; nonce?: number; maxFee?: bigint; maxPrio?: bigint }): Promise<Intent> {
    return this.#updateIntent(tradeId, intentId, (i) => {
      if (i.txHash !== undefined && i.txHash !== sent.txHash) throw new SafetyError(SAFETY.RECORD_CONFLICT, `Intent ${intentId} already records another transaction.`);
      if (i.nonce !== undefined && sent.nonce !== undefined && i.nonce !== sent.nonce) throw new SafetyError(SAFETY.RECORD_CONFLICT, `Intent ${intentId} already records another nonce.`);
      const at = i.sentAt ?? this.#now();
      const nonce = sent.nonce ?? i.nonce;
      return {
        ...i, txHash: sent.txHash, ...(nonce !== undefined ? { nonce, hashes: i.hashes ?? [sent.txHash], lastSentAt: i.lastSentAt ?? at } : {}), sentAt: at,
        ...(sent.maxFee !== undefined ? { maxFee: sent.maxFee.toString() } : {}), ...(sent.maxPrio !== undefined ? { maxPrio: sent.maxPrio.toString() } : {})
      };
    });
  }

  /**
   * A Base intent's step sent again at its own nonce: a replacement of the
   * same step with higher fees (its hash becomes txHash), or a cancel, a
   * 0-value transfer that takes the nonce back (`cancel`). Only while the
   * intent is open, at the nonce it records; every hash is kept, and the fees
   * the next replacement must outbid are these.
   */
  recordResend(tradeId: number, intentId: string, sent: { txHash: string; nonce: number; maxFee: bigint; maxPrio: bigint; cancel?: boolean }): Promise<Intent> {
    return this.#updateIntent(tradeId, intentId, (i) => {
      if (i.outcome !== undefined) throw new SafetyError(SAFETY.RECORD_CONFLICT, `Intent ${intentId} already ended as ${i.outcome}.`);
      if (i.nonce === undefined || i.nonce !== sent.nonce) throw new SafetyError(SAFETY.RECORD_CONFLICT, `Intent ${intentId} records another nonce.`);
      const now = this.#now();
      const fees = { maxFee: sent.maxFee.toString(), maxPrio: sent.maxPrio.toString(), lastSentAt: now };
      if (sent.cancel) {
        if (i.cancelHashes?.includes(sent.txHash)) return i;
        return { ...i, cancelHashes: [...(i.cancelHashes ?? []), sent.txHash], ...fees };
      }
      const hashes = i.hashes ?? (i.txHash ? [i.txHash] : []);
      if (hashes.includes(sent.txHash)) return i;
      return { ...i, txHash: sent.txHash, hashes: [...hashes, sent.txHash], sentAt: i.sentAt ?? now, ...fees };
    });
  }

  /** Record how an intent ended (from its answer or the chain). Written once: another outcome later is RECORD_CONFLICT. */
  resolveIntent(tradeId: number, intentId: string, outcome: IntentOutcome, note?: string): Promise<Intent> {
    return this.#updateIntent(tradeId, intentId, (i) => {
      if (i.outcome !== undefined) {
        if (i.outcome !== outcome) throw new SafetyError(SAFETY.RECORD_CONFLICT, `Intent ${intentId} already ended as ${i.outcome}.`);
        return i;
      }
      return { ...i, outcome, resolvedAt: this.#now(), ...(note ? { note: note.slice(0, 200) } : {}) };
    });
  }

  #updateIntent(tradeId: number, intentId: string, change: (i: Intent) => Intent): Promise<Intent> {
    return this.#serial(`journal/${tradeId}`, async () => {
      const j = await this.getJournal(tradeId);
      const at = j.intents.findIndex((x) => x.id === intentId);
      if (at < 0) throw new SafetyError(SAFETY.RECORD_CONFLICT, `Trade #${tradeId} has no intent ${intentId}.`);
      const updated = change(j.intents[at]!);
      if (updated === j.intents[at]) return updated;
      const next: Journal = { ...j, intents: j.intents.map((x, k) => (k === at ? updated : x)) };
      const why = journalShapeProblem(next, this.network, tradeId);
      if (why) throw new SafetyError(SAFETY.RECORD_INVALID, `The intent would not be well formed (${why}).`);
      await this.#put('journal', String(tradeId), next);
      return updated;
    });
  }

  /** Every intent without an outcome, across all trades: what a restart resolves from the chain before any new send. */
  async openIntents(): Promise<Array<{ tradeId: number; intent: Intent }>> {
    const out: Array<{ tradeId: number; intent: Intent }> = [];
    for (const n of await this.#names('journal')) {
      if (!/^[1-9]\d{0,15}$/.test(n)) throw this.#corrupt('journal', n, 'name');
      const j = await this.getJournal(Number(n));
      for (const intent of j.intents) if (intent.outcome === undefined) out.push({ tradeId: j.tradeId, intent });
    }
    return out.sort((a, b) => a.intent.at - b.intent.at);
  }

  /** The path of a record's file, for messages and tests. */
  fileOf(kind: StoreKind, name: string | number): string {
    return this.#path(kind, basename(String(name)));
  }
}

/** The fields of a trade record that never change once it is created (check 13). */
const TRADE_FIXED = ['id', 'network', 'offerId', 'role', 'maker', 'symbol', 'taz', 'usdc', 'price', 'myPha', 'myBase', 'takerToken', 'tokenSource'] as const;
