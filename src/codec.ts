/**
 * The swap secret, its hash and the control tokens (P2P/SPEC.md section 3,
 * build spec sections 2.1.4 and 6.5): the same maths as the site's
 * src/lib/p2p/secret.js and api.js and the backend's src/p2p/codec.ts.
 * Breaking one of these rules lets one side take both assets, or locks a bot
 * out of its own offer.
 *
 *   - A secret is exactly 32 bytes from the operating system's CSPRNG.
 *   - h is the SHA-256 digest of those 32 bytes.
 *   - Base takes both as bytes32 ('0x' + 64 hex). Phantasma takes the same
 *     bytes read as an unsigned big-endian integer (0 <= n < 2^256, the top
 *     bit may be set), as a DECIMAL string: the VM reverses hex strings.
 *   - A control token is 32 random bytes written as 64 lowercase hex. The
 *     board stores and checks sha256Hex of that 64-character STRING (its
 *     UTF-8 bytes), never of the 32 raw bytes. Shared vector: 64 x '0' ->
 *     60e05bd1b195af2f94112fa7197a5c88289058840ce7c6df9693756bc6250f55.
 *
 * Inside the kit, secrets and hashes are carried as '0x' + 64 lowercase hex.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Network, SecretRecord } from './types.js';

/** '0x' + 64 lowercase hex: how the kit stores a secret or an h. */
export const HEX32 = /^0x[0-9a-f]{64}$/;
const HEX32_ANY_CASE = /^0x[0-9a-fA-F]{64}$/;
/** A control token: 64 lowercase hex, no 0x. */
export const TOKEN_RE = /^[0-9a-f]{64}$/;
export const UINT256_MAX = (1n << 256n) - 1n;

/** '0x' + exactly 64 hex characters (any case). */
export function isHex32(v: unknown): v is string {
  return typeof v === 'string' && HEX32_ANY_CASE.test(v);
}

/** '0x' + 64 hex (any case, surrounding spaces allowed) -> lowercase, or null for anything else. */
export function cleanHex32(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return HEX32_ANY_CASE.test(s) ? s.toLowerCase() : null;
}

/** 32 bytes -> '0x' + 64 lowercase hex. */
export function bytesToHex(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new Error('A secret or hash is exactly 32 bytes');
  return '0x' + Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');
}

/** '0x' + 64 hex -> 32 bytes. */
export function hexToBytes(hex: string): Uint8Array {
  if (!isHex32(hex)) throw new Error('Expected 0x and 64 hex characters');
  return new Uint8Array(Buffer.from(hex.slice(2), 'hex'));
}

/** The 32 bytes read as an unsigned big-endian integer. */
export function hexToBigInt(hex: string): bigint {
  if (!isHex32(hex)) throw new Error('Expected 0x and 64 hex characters');
  return BigInt(hex);
}

/** An integer 0 <= n < 2^256 -> '0x' + 64 lowercase hex. */
export function bigIntToHex(n: bigint): string {
  if (typeof n !== 'bigint' || n < 0n || n > UINT256_MAX) throw new Error('Outside 0 .. 2^256 - 1');
  return '0x' + n.toString(16).padStart(64, '0');
}

/** '0x' + 64 hex -> the decimal string a Phantasma `number` argument takes. */
export function hexToDecimal(hex: string): string {
  return hexToBigInt(hex).toString(10);
}

/** A decimal string from a Phantasma read -> '0x' + 64 lowercase hex, or null when it is not a 256-bit unsigned integer. */
export function decimalToHex(dec: unknown): string | null {
  const s = String(dec ?? '').trim();
  if (!/^\d{1,78}$/.test(s)) return null;
  const n = BigInt(s);
  return n <= UINT256_MAX ? bigIntToHex(n) : null;
}

/** SHA-256 of bytes. */
export function sha256Bytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(bytes).digest());
}

/** SHA-256 as 64 lowercase hex (no 0x). A string is hashed as its UTF-8 bytes. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).digest('hex');
}

/** h = SHA-256 of the 32 secret bytes, as '0x' + 64 lowercase hex. */
export function hashOfSecret(secretHex: string): string {
  return bytesToHex(sha256Bytes(hexToBytes(secretHex)));
}

/** Whether `secretHex` opens `hHex` (both '0x' + 64 hex, any case). Never throws. */
export function secretOpens(secretHex: unknown, hHex: unknown): boolean {
  if (!isHex32(secretHex) || !isHex32(hHex)) return false;
  return hashOfSecret(secretHex) === hHex.toLowerCase();
}

/** A fresh secret: 32 bytes from the CSPRNG as '0x' + 64 lowercase hex. */
export function newSecret(): string {
  const b = randomBytes(32);
  try {
    return '0x' + b.toString('hex');
  } finally {
    b.fill(0);
  }
}

/** A fresh control token: 32 bytes from the CSPRNG as 64 lowercase hex (build spec section 2.1.4). */
export function newControlToken(): string {
  const b = randomBytes(32);
  try {
    return b.toString('hex');
  } finally {
    b.fill(0);
  }
}

/**
 * What the board stores and checks for a control token: the lowercase hex
 * SHA-256 of the UTF-8 bytes of the 64-character token. Throws for anything
 * that is not 64 lowercase hex, so a malformed token is never sent.
 */
export function tokenHashOf(token: string): string {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new Error('A control token is 64 lowercase hex characters');
  return sha256Hex(token);
}

/** What a secret is bound to: one trade, its token, amount and parties (build spec section 6.5). */
export interface SecretBinding {
  tradeId: number;
  network: Network;
  symbol: string;
  /** Raw amount of `symbol`. */
  taz: string;
  sPha: string;
  bPha: string;
}

/**
 * A fresh secret for one trade, bound to it (not saved: KitStore.putSecret
 * saves it, fsyncs it and reads it back before anything is locked behind its h).
 */
export function makeSecretRecord(b: SecretBinding & { role: 'S' | 'B' }, now: number = Date.now()): SecretRecord {
  if (!Number.isSafeInteger(b.tradeId) || b.tradeId <= 0) throw new Error('A secret is made for one trade');
  if (typeof b.symbol !== 'string' || !/^[A-Z][A-Z0-9]{0,9}$/.test(b.symbol)) throw new Error('A secret is made for one trade\'s token');
  if (typeof b.taz !== 'string' || !/^[1-9]\d{0,39}$/.test(b.taz)) throw new Error('A secret is made for one trade\'s amount');
  const secret = newSecret();
  return {
    v: 1, secret, h: hashOfSecret(secret), tradeId: b.tradeId, network: b.network, symbol: b.symbol, taz: b.taz,
    sPha: b.sPha, bPha: b.bPha, role: b.role, createdAt: now
  };
}

/** Whether a secret record was made for exactly this trade, token, amount and parties. */
export function bindingMatches(rec: Pick<SecretRecord, 'tradeId' | 'network' | 'symbol' | 'taz' | 'sPha' | 'bPha'>, b: SecretBinding): boolean {
  return rec.tradeId === b.tradeId && rec.network === b.network && rec.symbol === b.symbol && rec.taz === b.taz
    && rec.sPha === b.sPha && rec.bPha === b.bPha;
}
