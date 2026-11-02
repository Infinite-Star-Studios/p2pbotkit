/**
 * Log redaction (build spec section 6.5): every line the kit logs, and every
 * error message it builds, goes through redact() first, so a key, a control
 * token, an API key or a swap secret never reaches a log, a terminal or an
 * error report.
 *
 * What is scrubbed:
 *   - WIF-shaped base58 (a Phantasma private key as `{"wif": ...}` holds it);
 *   - 64 or more hex digits in a row, with or without 0x: a Base private key,
 *     a swap secret, a control token (64 lowercase hex) or a Phantasma key in
 *     hex. Lock hashes and transaction hashes look the same and are scrubbed
 *     too; log them with shortHex() when a line needs one;
 *   - 30 or more decimal digits in a row: a secret or a hash as Phantasma
 *     takes it (a decimal number below 2^256). Raw token amounts stay
 *     readable: the largest the board takes has 19 digits;
 *   - `sat_…` API keys, `Bearer …` values, and the values of `X-API-Key:` and
 *     `Authorization:` headers whatever their scheme (Basic too);
 *   - the value of any field named like a secret (wif, privateKey, secret,
 *     token, makerToken, takerToken, apiKey, …) in JSON or `name=value` text;
 *   - in every URL, the user part, the query and every path segment longer
 *     than 15 characters (RPC providers put their API key there); the scheme,
 *     the host and short segments stay, so `/v1/p2p/offers/42/take` is still
 *     readable.
 *
 * Addresses (P2K…, 0x + 40 hex), amounts, ids, codes and words stay.
 * No imports: the error classes and every other module use this one.
 */

const B58 = '1-9A-HJ-NP-Za-km-z';

/** WIF: base58, 51 characters from '5' (uncompressed) or 52 from 'K'/'L' (compressed), alone. */
const WIF = new RegExp(`(?<![${B58}])(?:5[${B58}]{50}|[KL][${B58}]{51})(?![${B58}])`, 'g');
/** 64 or more hex digits, optionally after 0x: keys, secrets, control tokens (and public hashes, which look the same). */
const HEX64 = /(?:0x)?[0-9a-fA-F]{64,}/g;
/** A 256-bit number written in decimal (how Phantasma takes a secret or h). */
const LONG_DECIMAL = /\d{30,}/g;
/** An API key: sat_ + base64url. */
const SAT_KEY = /\bsat_[A-Za-z0-9_-]{4,}/g;
/** `Bearer <anything>` (control tokens, the admin secret). */
const BEARER = /\b(Bearer)\s+[^\s"',;)}\]]+/gi;
/** An X-API-Key header written out. */
const API_KEY_HEADER = /(x-api-key["']?\s*[:=]\s*["']?)[^\s"',;)}\]]+/gi;
/**
 * An (Proxy-)Authorization header written out, whatever its scheme: a known
 * scheme word stays, the credential after it goes; without a known scheme the
 * first token after the colon is the credential.
 */
const AUTH_HEADER = /(authorization["']?\s*[:=]\s*["']?)(?:(Bearer|Basic|Digest|Token|ApiKey|Negotiate|NTLM)\s+)?[^\s"',;)}\]]+/gi;
/** A field named like a secret, in JSON (`"wif": "…"`) or as `name=value`. */
const SECRET_FIELD = /(["']?)\b(wif|privateKey|private_key|secret|seed|mnemonic|password|passphrase|token|makerToken|takerToken|subToken|apiKey|api_key|storeKey)\b\1(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;)}\]]+)/gi;
/** A URL: scheme, optional user part, host, then path, query and fragment. */
const URL_RE = /\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/@"'`<>]*@)?([^\s/?#"'`<>]+)([^\s"'`<>)\]]*)/gi;

/** A URL's path with key-like segments (over 15 characters) blanked and its query hidden; no fragment. */
function urlRest(rest: string): string {
  const m = /^([^?#]*)(\?[^#]*)?/.exec(rest);
  const path = (m?.[1] ?? '').split('/').map((seg) => (seg.length > 15 ? '…' : seg)).join('/');
  return path + (m?.[2] ? '?…' : '');
}

/** The longest line redact() returns. */
export const REDACT_MAX = 1000;

/**
 * `text` with every secret-shaped part replaced and whitespace folded to one
 * line, at most `max` characters. Safe on anything: a non-string is turned
 * into text first.
 */
export function redact(text: unknown, max: number = REDACT_MAX): string {
  let s = typeof text === 'string' ? text : text instanceof Error ? text.message : String(text ?? '');
  s = s
    .replace(URL_RE, (_m, scheme: string, host: string, rest: string) => `${scheme}${host}${urlRest(rest)}`)
    .replace(BEARER, '$1 <redacted>')
    .replace(AUTH_HEADER, (_m, pre: string, scheme: string | undefined) => `${pre}${scheme ? `${scheme} ` : ''}<redacted>`)
    .replace(API_KEY_HEADER, '$1<redacted>')
    .replace(SECRET_FIELD, (_m, q: string, name: string, sep: string) => `${q}${name}${q}${sep}"<redacted>"`)
    .replace(SAT_KEY, 'sat_<redacted>')
    .replace(WIF, '<wif>')
    .replace(HEX64, '<hex>')
    .replace(LONG_DECIMAL, '<number>')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

/**
 * The safest short text of an error from viem, the Phantasma SDK, node or
 * anything else: viem's short message when there is one (its long message
 * carries the request, and a claim's request carries the secret), then
 * redact().
 */
export function errorText(e: unknown, max: number = 300): string {
  if (e && typeof e === 'object') {
    const o = e as { shortMessage?: unknown; message?: unknown; name?: unknown };
    if (typeof o.shortMessage === 'string' && o.shortMessage) return redact(o.shortMessage, max);
    if (typeof o.message === 'string' && o.message) return redact(o.message, max);
    if (typeof o.name === 'string') return redact(o.name, max);
  }
  return redact(e, max);
}

/**
 * A public hash for a log line, shortened so redact() leaves it alone:
 * "0x1a2b3c…7f8e" (or "1A2B3C…7F8E" without 0x). Only for values that are
 * public anyway (transaction hashes, lock hashes once on chain): never for a
 * key, a token or a secret that has not been published.
 */
export function shortHex(h: unknown): string {
  if (typeof h !== 'string') return '—';
  const m = /^(0x)?([0-9a-fA-F]+)$/.exec(h.trim());
  if (!m) return '—';
  const body = m[2]!;
  return body.length <= 10 ? `${m[1] ?? ''}${body}` : `${m[1] ?? ''}${body.slice(0, 6)}…${body.slice(-4)}`;
}

/** A log function that only ever receives redacted lines. */
export type LogFn = (line: string) => void;

/** Wrap a log function so every line it gets is redacted first; no function logs nothing. */
export function redactedLog(log: LogFn | undefined | null): LogFn {
  if (!log) return () => {};
  return (line: string) => {
    try { log(redact(line)); } catch { /* a failing logger never stops the kit */ }
  };
}
