/**
 * The Worker's control API (worker.ts), in front of the fleet (fleet.ts):
 *
 *   GET  /status                   every bot: its state, offers, trades and latest lines
 *   GET  /bots/<name>/logs?n=200   a bot's latest lines
 *   POST /bots/<name>/dry-run      what it would list and take; sends nothing (a stopped bot)
 *   POST /bots/<name>/start        the preflight, then it runs (mainnet: the body {"mainnet": true})
 *   POST /bots/<name>/stop         its offers cancelled, its trades finished, then it stops
 *   POST /bots/<name>/halt         it stops at once; its trades wait for the next start
 *
 * Every call needs `Authorization: Bearer <CONTROL_TOKEN>`, a Worker secret of
 * 32 or more characters; while CONTROL_TOKEN is not set, every call is
 * refused (503). `?text` answers in plain lines rather than JSON. No call can
 * change what a bot trades: that is bots.json, deployed with the Worker.
 */
import type { Reply } from './fleet.js';

/** The fleet's control calls, as the Durable Object's stub serves them. */
export interface FleetApi {
  status(): Reply | Promise<Reply>;
  logs(name: string, n?: number): Reply | Promise<Reply>;
  dryRun(name: string): Promise<Reply>;
  start(name: string, mainnet: boolean): Promise<Reply>;
  stop(name: string): Promise<Reply>;
  halt(name: string): Promise<Reply>;
}

/** The shortest control token accepted. */
export const TOKEN_MIN = 32;

const plain = (status: number, text: string, headers: Record<string, string> = {}) =>
  new Response(text.endsWith('\n') ? text : `${text}\n`, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers } });

/** Whether two secrets are equal, compared in constant time (their SHA-256 digests, byte for byte). */
export async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < u.length; i++) d |= u[i]! ^ v[i]!;
  return d === 0;
}

/** The refusal of a call without the control token, or null when it carries it. */
export async function refusal(request: Request, token: unknown): Promise<Response | null> {
  const want = typeof token === 'string' ? token.trim() : '';
  if (want.length < TOKEN_MIN) {
    return plain(503, `The control API is off until the CONTROL_TOKEN secret is set, ${TOKEN_MIN} or more random characters: openssl rand -hex 32 | npx wrangler secret put CONTROL_TOKEN`);
  }
  const got = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
  if (!got || !(await sameSecret(got, want))) return plain(401, 'Unauthorized.', { 'www-authenticate': 'Bearer' });
  return null;
}

/** The body of a start: {"mainnet": true} is the yes a mainnet bot needs; anything else is no. */
async function mainnetYes(request: Request): Promise<boolean> {
  try {
    const b = (await request.json()) as unknown;
    return !!b && typeof b === 'object' && (b as { mainnet?: unknown }).mainnet === true;
  } catch {
    return false;
  }
}

/** A reply as plain lines: its lines, then its note and error; for status, each bot in a few lines. */
function asText(r: Reply): string {
  const b = r.body as Record<string, unknown>;
  const out: string[] = [];
  if (Array.isArray(b.bots)) {
    for (const x of b.bots as Array<Record<string, unknown>>) {
      out.push(`${x.name} (${x.network ?? 'no config'}): ${x.mode}${x.since ? ` since ${x.since}` : ''}${x.sessionRunning ? '; a session runs it now' : ''}`);
      if (x.configError) out.push(`  config: ${x.configError}`);
      if (x.secrets !== 'set') out.push(`  secrets: ${x.secrets}`);
      if (x.note) out.push(`  ${x.note}`);
      if (x.lastError) out.push(`  last failure: ${x.lastError} (tries again at ${x.retryAt})`);
      const a = x.address as { pha?: string; base?: string } | undefined;
      if (a) out.push(`  addresses: ${a.pha}, ${a.base}`);
      // Each open offer with the amount it was listed at, where the fleet gives it; else its number alone.
      const listed = Array.isArray(x.listedOffers) ? (x.listedOffers as string[]) : Array.isArray(x.openOffers) ? (x.openOffers as number[]).map((id) => `#${id}`) : null;
      if (listed) out.push(`  open offers: ${listed.join(', ') || 'none'}`);
      const z = x.sizing as { everyS?: number; lastLookAt?: string | null; nextLookAt?: string | null; lastLook?: string | null } | undefined;
      if (z) {
        const next = z.nextLookAt ? `next ${z.nextLookAt}` : 'the next when it runs again (a start looks at once)';
        out.push(`  offers sized from the balances every ${z.everyS} s: ${z.lastLookAt ? `last look ${z.lastLookAt}, ${next}` : 'no look kept: its next session looks'}`);
        if (z.lastLook) out.push(`  last look: ${z.lastLook}`);
      }
      if (Array.isArray(x.runningTrades)) out.push(`  running trades: ${(x.runningTrades as Array<{ id: number; status: string }>).map((t) => `#${t.id} (${t.status})`).join(', ') || 'none'}`);
      for (const l of (x.lastLines as string[] | undefined) ?? []) out.push(`  ${l}`);
    }
  }
  if (Array.isArray(b.lines)) out.push(...(b.lines as string[]));
  if (typeof b.note === 'string') out.push(b.note);
  if (Array.isArray(b.runningTrades)) out.push(`Running trades: ${(b.runningTrades as Array<{ id: number; status: string }>).map((t) => `#${t.id} (${t.status})`).join(', ')}`);
  if (typeof b.error === 'string') out.push(`Error: ${b.error}`);
  return out.join('\n');
}

const respond = (r: Reply, text: boolean): Response => text
  ? plain(r.status, asText(r))
  : new Response(`${JSON.stringify(r.body, null, 2)}\n`, { status: r.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

const ROUTE = /^\/bots\/([a-z][a-z0-9-]{0,30})\/(logs|dry-run|start|stop|halt)\/?$/;

/** Serve one control call. */
export async function handle(request: Request, token: unknown, fleet: FleetApi): Promise<Response> {
  const denied = await refusal(request, token);
  if (denied) return denied;
  const url = new URL(request.url);
  const text = url.searchParams.has('text');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/status' || path === '/') {
    if (request.method !== 'GET') return plain(405, 'GET /status.', { allow: 'GET' });
    return respond(await fleet.status(), text);
  }
  const m = ROUTE.exec(url.pathname);
  if (!m) return plain(404, 'Not found. The calls: GET /status, GET /bots/<name>/logs, POST /bots/<name>/dry-run, /start, /stop, /halt.');
  const [, name, action] = m as unknown as [string, string, string];
  if (action === 'logs') {
    if (request.method !== 'GET') return plain(405, `GET /bots/${name}/logs.`, { allow: 'GET' });
    return respond(await fleet.logs(name, Number(url.searchParams.get('n') ?? 200)), text);
  }
  if (request.method !== 'POST') return plain(405, `POST /bots/${name}/${action}.`, { allow: 'POST' });
  switch (action) {
    case 'dry-run': return respond(await fleet.dryRun(name), text);
    case 'start': return respond(await fleet.start(name, await mainnetYes(request)), text);
    case 'stop': return respond(await fleet.stop(name), text);
    default: return respond(await fleet.halt(name), text);
  }
}
