/**
 * The kit's two error classes (build spec section 6.2).
 *
 * SafetyError: the kit refused to act because a safety rule did not hold (a
 * check before a signature, a key file readable by others, a secret that
 * would be overwritten, a store that cannot be trusted). Nothing was sent.
 * `code` is stable and machine-readable; `detail` is a sentence for people.
 *
 * BoardError: the P2P board answered with an error body (build spec section
 * 2.1.2), or did not answer. `retryable` says whether the identical request
 * may succeed later; `retryAfter` is the wait in seconds when the board gave
 * one; `reason` separates the meanings of an overloaded code (section 2.6).
 *
 * Every message is redacted when the error is made, so neither class can
 * carry a key, a token or a secret into a log or a crash report.
 */
import { redact } from './redact.js';

/**
 * The SafetyError codes the kit's foundation uses (keys, store, pins). The
 * checks before each signature add their own codes (checks.ts, signer.ts);
 * `code` is a plain string so every module can name its own.
 */
export const SAFETY = Object.freeze({
  /** A key file is readable or writable by group or others (mode & 0o077). */
  KEY_FILE_MODE: 'KEY_FILE_MODE',
  /** A key file is missing, not a regular file, too large or not the expected JSON. */
  KEY_FILE: 'KEY_FILE',
  /** The loaded key also appears on the command line. */
  KEY_ARGV: 'KEY_ARGV',
  /** The key's address is a known admin, owner or keeper address (check 68). */
  KEY_ROLE: 'KEY_ROLE',
  /** Another live process holds this data directory. */
  STORE_LOCKED: 'STORE_LOCKED',
  /** This process no longer holds the data directory's lock. */
  STORE_LOCK_LOST: 'STORE_LOCK_LOST',
  /** The store was closed. */
  STORE_CLOSED: 'STORE_CLOSED',
  /** A file did not read back exactly as written. */
  STORE_READBACK: 'STORE_READBACK',
  /** A stored file cannot be read or does not have the shape it must have. */
  STORE_CORRUPT: 'STORE_CORRUPT',
  /** The encryption key is missing, malformed or not the one the store was sealed with. */
  STORE_KEY: 'STORE_KEY',
  /** A data directory or file has the wrong permissions and could not be fixed. */
  STORE_MODE: 'STORE_MODE',
  /** A record would be given a different value for a field that never changes. */
  RECORD_CONFLICT: 'RECORD_CONFLICT',
  /** A record (or a change to one) does not have the shape it must have; nothing was written. */
  RECORD_INVALID: 'RECORD_INVALID',
  /** A different secret is already stored under this h. */
  SECRET_CONFLICT: 'SECRET_CONFLICT',
  /** A secret that does not open its h, or a malformed secret record. */
  SECRET_INVALID: 'SECRET_INVALID',
  /** The network has no pins in this release, or mainnet was not explicitly allowed. */
  NETWORK_OFF: 'NETWORK_OFF',
  /** An RPC URL is not allowed for the network (check 67). */
  RPC_NOT_ALLOWED: 'RPC_NOT_ALLOWED'
} as const);

export type FoundationSafetyCode = (typeof SAFETY)[keyof typeof SAFETY];

/** The kit refused to act; nothing was sent. */
export class SafetyError extends Error {
  readonly code: string;
  readonly detail: string;

  constructor(code: string, detail: string) {
    const c = redact(code, 64);
    const d = redact(detail);
    super(`${c}: ${d}`);
    this.name = 'SafetyError';
    this.code = c;
    this.detail = d;
  }
}

/** The board answered with an error (or did not answer: code 'NETWORK', status 0). */
export class BoardError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfter: number | null;
  readonly reason: string | null;

  constructor(code: string, status: number, retryable: boolean, retryAfter: number | null = null, reason: string | null = null, message?: string) {
    const c = redact(code, 64);
    super(redact(message ? `${c}: ${message}` : c));
    this.name = 'BoardError';
    this.code = c;
    this.status = Number.isSafeInteger(status) ? status : 0;
    this.retryable = retryable === true;
    this.retryAfter = typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.floor(retryAfter) : null;
    this.reason = typeof reason === 'string' && reason ? redact(reason, 64) : null;
  }
}

/** Whether `e` is a SafetyError, optionally with one of `codes`. */
export function isSafetyError(e: unknown, ...codes: string[]): e is SafetyError {
  return e instanceof SafetyError && (codes.length === 0 || codes.includes(e.code));
}

/** Whether `e` is a BoardError, optionally with one of `codes`. */
export function isBoardError(e: unknown, ...codes: string[]): e is BoardError {
  return e instanceof BoardError && (codes.length === 0 || codes.includes(e.code));
}
