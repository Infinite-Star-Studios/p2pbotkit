/**
 * The store's records in a SQLite database: a StoreBackend (store.ts) for a
 * host with no file system of its own. A Cloudflare Durable Object is one:
 * cloudflare/ hands its ctx.storage.sql to this as it is.
 *
 *   const store = await openStore({ backend: new SqlBackend(ctx.storage.sql, { network, name: 'market' }), network, key });
 *
 * The records, their rules, their sealing and the read-back of every write
 * are KitStore's, the same as on files; this keeps each record's text as one
 * row of one table, and the single-writer lock as a row of its own:
 *
 *   kit_store (store, kind, name, text), primary key (store, kind, name)
 *     store  `<name>/<network>`: several stores share one database
 *     kind   pending | offers | trades | secrets | journal, or meta and lock
 *     name   the record's name, as on files (a token hash, an id, an h)
 *
 * Atomic and durable: every statement here is synchronous and runs whole.
 * In a Durable Object, the writes of one turn commit together, and every
 * outgoing message (a request to a node or to the board) waits behind the
 * object's output gate until they are durable; a write that fails discards
 * those messages and restarts the object. So a record written before a send
 * is durable before the send goes out, as fsync makes it on files.
 *
 * The lock: one open store per database and store name in this isolate (a
 * second open is STORE_LOCKED until the first one closes), and a lock row
 * that names this store's nonce, checked before every write
 * (STORE_LOCK_LOST once another store took it). A lock row this isolate does
 * not hold was left by an earlier instance of the host (a restart, a deploy,
 * an eviction mid-run) and is taken over, and logged. That is right only for
 * a database that one instance of the host uses at a time, as a Durable
 * Object's is; never share one database between processes through this.
 */
import { randomBytes } from 'node:crypto';
import { SafetyError, SAFETY } from './errors.js';
import { STORE_KINDS, type StoreBackend, type StoreKind } from './store.js';
import type { LogFn } from './redact.js';
import type { Network } from './types.js';

/** What SqlBackend needs of a database. A Durable Object's ctx.storage.sql (SqlStorage) has this shape: exec runs the statement at once. */
export interface SqlDatabase {
  exec(query: string, ...bindings: Array<string | number | null>): { toArray(): unknown[] };
}

export interface SqlBackendOptions {
  network: Network;
  /** Which store of the database: several bots may keep theirs in one. Letters, digits, '.', '_' and '-' (default "bot"). */
  name?: string;
  /** Where the store is, for messages (default `sqlite:<name>/<network>`). */
  where?: string;
}

const TABLE = 'kit_store';
/** The kinds of the two rows that are not records. */
const META = 'meta';
const LOCK = 'lock';
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const RECORD_KINDS: ReadonlySet<string> = new Set(STORE_KINDS);

/** The stores open in this isolate, per database object: a second open of one is refused while the first is open. */
const OPEN = new WeakMap<object, Set<string>>();

interface LockRow { nonce: string; startedAt: number }

export class SqlBackend implements StoreBackend {
  readonly where: string;
  readonly #db: SqlDatabase;
  readonly #store: string;
  readonly #network: Network;
  readonly #nonce = randomBytes(16).toString('hex');
  #held = false;

  constructor(db: SqlDatabase, o: SqlBackendOptions) {
    if (!db || typeof db.exec !== 'function') throw new SafetyError(SAFETY.STORE_CORRUPT, 'SqlBackend needs a SQLite database (exec).');
    if (o.network !== 'devnet' && o.network !== 'mainnet') throw new SafetyError(SAFETY.NETWORK_OFF, 'The network is devnet or mainnet.');
    const name = o.name ?? 'bot';
    if (!NAME_RE.test(name)) throw new SafetyError(SAFETY.STORE_CORRUPT, 'A store name is 1 to 64 letters, digits, ".", "_" or "-".');
    this.#db = db;
    this.#network = o.network;
    this.#store = `${name}/${o.network}`;
    this.where = o.where ?? `sqlite:${this.#store}`;
  }

  // ── Rows ───────────────────────────────────────────────────────────────────

  #get(kind: string, name: string): string | null {
    const row = this.#db.exec(`SELECT text FROM ${TABLE} WHERE store = ? AND kind = ? AND name = ?`, this.#store, kind, name).toArray()[0] as { text?: unknown } | undefined;
    if (row === undefined) return null;
    if (typeof row.text !== 'string') throw new Error(`the ${kind} row ${name} holds no text`);
    return row.text;
  }

  #put(kind: string, name: string, text: string): void {
    this.#db.exec(`INSERT INTO ${TABLE} (store, kind, name, text) VALUES (?, ?, ?, ?) ON CONFLICT (store, kind, name) DO UPDATE SET text = excluded.text`, this.#store, kind, name, text);
  }

  #has(kind: string, name: string): boolean {
    return this.#db.exec(`SELECT 1 AS one FROM ${TABLE} WHERE store = ? AND kind = ? AND name = ?`, this.#store, kind, name).toArray().length > 0;
  }

  #lock(): LockRow | null {
    const text = this.#get(LOCK, LOCK);
    if (text === null) return null;
    try {
      const o = JSON.parse(text) as LockRow;
      return typeof o?.nonce === 'string' ? o : { nonce: '', startedAt: 0 };
    } catch {
      return { nonce: '', startedAt: 0 };
    }
  }

  static #kind(kind: StoreKind): string {
    if (!RECORD_KINDS.has(kind)) throw new Error(`no record kind ${String(kind)}`);
    return kind;
  }

  // ── The lock ───────────────────────────────────────────────────────────────

  async open(o: { log: LogFn }): Promise<void> {
    const open = OPEN.get(this.#db) ?? new Set<string>();
    if (open.has(this.#store)) {
      throw new SafetyError(SAFETY.STORE_LOCKED, `${this.where} is already open here, in this instance. One store per database and name; close the other one first.`);
    }
    this.#db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (store TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY (store, kind, name)) WITHOUT ROWID`);
    const prev = this.#lock();
    if (prev) {
      const since = Number.isSafeInteger(prev.startedAt) && prev.startedAt > 0 ? ` (since ${new Date(prev.startedAt).toISOString()})` : '';
      o.log(`[store] ${this.#network}: an earlier instance held ${this.where}${since} and has ended; taking over its lock`);
    }
    this.#put(LOCK, LOCK, JSON.stringify({ nonce: this.#nonce, startedAt: Date.now() } satisfies LockRow));
    if (this.#lock()?.nonce !== this.#nonce) throw new SafetyError(SAFETY.STORE_LOCK_LOST, `The lock of ${this.where} changed while it was being taken.`);
    this.#held = true;
    open.add(this.#store);
    OPEN.set(this.#db, open);
  }

  async assertHeld(): Promise<void> {
    if (!this.#held || this.#lock()?.nonce !== this.#nonce) {
      if (this.#held) OPEN.get(this.#db)?.delete(this.#store);
      this.#held = false;
      throw new SafetyError(SAFETY.STORE_LOCK_LOST, `This instance no longer holds the lock of ${this.where}: another store may be using it. Nothing more is written.`);
    }
  }

  async close(): Promise<void> {
    if (!this.#held) return;
    this.#held = false;
    OPEN.get(this.#db)?.delete(this.#store);
    try {
      if (this.#lock()?.nonce === this.#nonce) this.#db.exec(`DELETE FROM ${TABLE} WHERE store = ? AND kind = ? AND name = ?`, this.#store, LOCK, LOCK);
    } catch { /* a lock row left behind is taken over at the next open */ }
  }

  // ── Records ────────────────────────────────────────────────────────────────

  async readMeta(): Promise<string | null> {
    return this.#get(META, META);
  }

  async writeMeta(text: string): Promise<void> {
    this.#put(META, META, text);
  }

  pathOf(kind: StoreKind, name: string): string {
    return `${this.where}/${kind}/${name}.json`;
  }

  async read(kind: StoreKind, name: string): Promise<string | null> {
    return this.#get(SqlBackend.#kind(kind), name);
  }

  async write(kind: StoreKind, name: string, text: string): Promise<void> {
    this.#put(SqlBackend.#kind(kind), name, text);
  }

  async writeNew(kind: StoreKind, name: string, text: string): Promise<boolean> {
    const k = SqlBackend.#kind(kind);
    // One synchronous turn: nothing else runs between the look and the insert (the primary key backs it up).
    if (this.#has(k, name)) return false;
    this.#db.exec(`INSERT INTO ${TABLE} (store, kind, name, text) VALUES (?, ?, ?, ?)`, this.#store, k, name, text);
    return true;
  }

  async remove(kind: StoreKind, name: string): Promise<boolean> {
    const k = SqlBackend.#kind(kind);
    if (!this.#has(k, name)) return false;
    this.#db.exec(`DELETE FROM ${TABLE} WHERE store = ? AND kind = ? AND name = ?`, this.#store, k, name);
    return true;
  }

  async names(kind: StoreKind): Promise<string[]> {
    const rows = this.#db.exec(`SELECT name FROM ${TABLE} WHERE store = ? AND kind = ? ORDER BY name`, this.#store, SqlBackend.#kind(kind)).toArray();
    return rows.map((r) => String((r as { name: unknown }).name));
  }
}
