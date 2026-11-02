/**
 * Remove swap secrets the bot no longer needs (build spec section 6.5). The
 * kit never removes a secret by itself; this script is the only way, and only
 * when its operator runs it:
 *
 *   npx tsx examples/prune.ts --config examples/seller.devnet.example.json
 *   npx tsx examples/prune.ts --data-dir ./data/seller --dry-run
 *
 * A secret is removed only when all of these hold:
 *   - the kit keeps the record of its trade, and that trade is finished for
 *     the kit (it recorded the trade's end: the trade ended on the board, or
 *     both locks are final);
 *   - it finished at least 7 days ago (--days raises that, never lowers it);
 *   - the trade's journal has no send whose outcome is still open;
 *   - the chains, read now, show both locks under the secret's hash final:
 *     the Phantasma lock claimed, refunded or never made, and the USDC lock
 *     on Base claimed, refunded or never made.
 * Anything else is kept, with the reason. A read that fails keeps the secret.
 *
 * It opens the bot's data directory the way the bot does, so it refuses to
 * run while the bot runs (one process per data directory). With
 * KIT_STORE_KEY_FILE set, sealed secrets open the same way. It prints only
 * short lock hashes and trade ids, never a secret; it takes no key or secret
 * on its command line (a key-shaped argument is refused), and every line it
 * prints is redacted.
 */
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openStore, type KitStore } from '../src/store.js';
import { PhaReader, phaRpc, type PhaRpc } from '../src/pha.js';
import { BaseReader, baseClient, type BaseClient } from '../src/base.js';
import { escrowFor } from '../src/checks.js';
import { P2P_CONFIG, phaPinned, baseDeployed } from '../src/pins.js';
import { SafetyError } from '../src/errors.js';
import { secretShapedArg } from '../src/keys.js';
import { errorText, redact, shortHex } from '../src/redact.js';
import type { Network, SecretRecord } from '../src/types.js';

/** Secrets are kept at least this long after their trade finished. */
export const KEEP_DAYS = 7;
const DAY_MS = 86_400_000;

/** What prune reads on the chains. */
export interface PruneChains {
  pha: Pick<PhaReader, 'readLock'>;
  base: Pick<BaseReader, 'readSwap'>;
}

export interface PruneOutcome {
  h: string;
  tradeId: number;
  /** Removed (or, in a dry run, would be removed). */
  removed: boolean;
  /** Why it is kept, or what showed it may go. */
  why: string;
}

/**
 * Why the secret `s` must stay, or null when it may go (see the file
 * comment). Reads the store and the chains; never writes.
 */
export async function keepReason(store: KitStore, chains: PruneChains, network: Network, s: SecretRecord, nowMs: number, days: number): Promise<string | null> {
  const t = await store.getTrade(s.tradeId);
  if (!t) return `the kit keeps no record of trade #${s.tradeId}`;
  if (!t.endedAt) return `trade #${t.id} is not finished for the kit`;
  const age = nowMs - t.endedAt;
  if (age < days * DAY_MS) return `trade #${t.id} finished ${(age / DAY_MS).toFixed(1)} days ago; secrets are kept ${days} days after`;
  const open = (await store.getJournal(t.id)).intents.filter((i) => i.outcome === undefined);
  if (open.length) return `trade #${t.id} has a send whose outcome is still open (${open.map((i) => i.kind).join(', ')})`;
  const ec = escrowFor(network, t.phaContract ?? null);
  if (!ec.ok) return `trade #${t.id}'s lock is on a contract this kit release does not read`;
  let lockState: number;
  try {
    lockState = (await chains.pha.readLock(ec.cfg, s.h)).state;
  } catch (e) {
    return `Phantasma could not be read (${errorText(e, 120)})`;
  }
  if (lockState === 1) return 'the Phantasma lock under this hash is still open';
  if (lockState !== 0 && lockState !== 2 && lockState !== 3) return `the Phantasma lock under this hash reads a state this kit does not know (${lockState})`;
  // The USDC lock is keyed by the buyer's Base address: the counterparty's for a seller, the kit's own for a buyer.
  const buyerBase = t.role === 'S' ? t.counterBase : t.myBase;
  if (!buyerBase) {
    // In the standard flow the buyer locks USDC only behind a Phantasma lock; without one, nothing can be open on Base.
    return lockState === 0 ? null : `the buyer's Base address of trade #${t.id} is not known, so the USDC lock cannot be read`;
  }
  let swapState: number;
  try {
    swapState = (await chains.base.readSwap(s.h, buyerBase)).swap.state;
  } catch (e) {
    return `Base could not be read (${errorText(e, 120)})`;
  }
  if (swapState === 1) return 'the USDC lock under this hash is still open';
  if (swapState !== 0 && swapState !== 2 && swapState !== 3) return `the USDC lock under this hash reads a state this kit does not know (${swapState})`;
  return null;
}

/**
 * Go through every kept secret: remove the ones that may go (none in a dry
 * run) and report each one. `days` is at least KEEP_DAYS.
 */
export async function pruneSecrets(o: { store: KitStore; chains: PruneChains; network: Network; now: number; days?: number; dryRun?: boolean }): Promise<PruneOutcome[]> {
  const days = Math.max(KEEP_DAYS, o.days ?? KEEP_DAYS);
  const out: PruneOutcome[] = [];
  for (const s of await o.store.listSecrets()) {
    const why = await keepReason(o.store, o.chains, o.network, s, o.now, days);
    if (why) {
      out.push({ h: s.h, tradeId: s.tradeId, removed: false, why });
      continue;
    }
    if (!o.dryRun) await o.store.pruneSecret(s.h);
    out.push({ h: s.h, tradeId: s.tradeId, removed: true, why: `trade #${s.tradeId} finished over ${days} days ago and both locks are final` });
  }
  return out;
}

const usage = [
  'Usage: npx tsx examples/prune.ts (--config <bot config> | --data-dir <folder> [--network devnet]) [--days <n>] [--dry-run]',
  '  --config <file>    the bot\'s config: its dataDir, network and RPCs',
  '  --data-dir <dir>   the bot\'s data folder, when there is no config',
  `  --days <n>         keep secrets this many days after their trade finished (at least ${KEEP_DAYS}, the default)`,
  '  --dry-run          list what would be removed, and remove nothing',
  'Stop the bot first: its data folder is held by one process at a time.'
].join('\n');

/** The script: resolves with its exit code. Tests pass fake chain transports. */
export async function main(o: { argv?: readonly string[]; cwd?: string; out?: (line: string) => void; env?: Record<string, string | undefined>; now?: () => number; transports?: { pha?: PhaRpc; base?: BaseClient } } = {}): Promise<number> {
  const argv = [...(o.argv ?? process.argv.slice(2))];
  const write = o.out ?? ((l: string) => console.log(l));
  const out = (l: string) => write(redact(l, 2000));
  const cwd = o.cwd ?? process.cwd();
  if (secretShapedArg(argv)) {
    out('Refused: an argument looks like a key or a secret. This script needs only the bot\'s config or data folder; it never takes a key.');
    return 2;
  }
  let flags: { config?: string; 'data-dir'?: string; network?: string; days?: string; 'dry-run'?: boolean; help?: boolean };
  try {
    flags = parseArgs({
      args: argv, strict: true, allowPositionals: false,
      options: { config: { type: 'string' }, 'data-dir': { type: 'string' }, network: { type: 'string' }, days: { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }
    }).values;
  } catch (e) {
    out(errorText(e));
    out(usage);
    return 2;
  }
  if (flags.help) {
    out(usage);
    return 0;
  }
  if (!!flags.config === !!flags['data-dir']) {
    out('Name the bot: --config <its config> or --data-dir <its data folder>, one of them.');
    out(usage);
    return 2;
  }
  let network: unknown = flags.network ?? 'devnet';
  let dataDir: string;
  let rpc: { pha?: string; base?: string } = {};
  if (flags.config) {
    try {
      const c = JSON.parse(await readFile(resolve(cwd, flags.config), 'utf8')) as Record<string, unknown>;
      if (flags.network !== undefined && flags.network !== c.network) throw new Error(`the config is for ${String(c.network)}, not ${flags.network}`);
      if (typeof c.dataDir !== 'string' || !c.dataDir) throw new Error('it names no dataDir');
      network = c.network;
      dataDir = resolve(cwd, c.dataDir);
      rpc = { ...(typeof c.phaRpc === 'string' ? { pha: c.phaRpc } : {}), ...(typeof c.baseRpc === 'string' ? { base: c.baseRpc } : {}) };
    } catch (e) {
      out(`The config ${flags.config} cannot be used: ${errorText(e)}`);
      return 1;
    }
  } else {
    dataDir = resolve(cwd, flags['data-dir']!);
  }
  if (network !== 'devnet' && network !== 'mainnet') {
    out('The network is devnet or mainnet.');
    return 2;
  }
  const cfg = P2P_CONFIG[network];
  if (!phaPinned(cfg) || !baseDeployed(cfg)) {
    out(`This kit release does not trade on ${network}, so it keeps no ${network} secrets.`);
    return 1;
  }
  let days = KEEP_DAYS;
  if (flags.days !== undefined) {
    days = Number(flags.days);
    if (!Number.isInteger(days) || days < KEEP_DAYS || days > 3650) {
      out(`--days is a whole number from ${KEEP_DAYS} to 3650: secrets are kept at least ${KEEP_DAYS} days after their trade finished.`);
      return 2;
    }
  }
  let chains: PruneChains;
  try {
    const p = o.transports?.pha ?? phaRpc(network, rpc.pha ? { url: rpc.pha } : {});
    const b = new BaseReader(o.transports?.base ?? baseClient(network, rpc.base ? { url: rpc.base } : {}), network);
    // Check 67: the Base RPC serves the pinned chain before anything is read from it.
    const wrong = await b.chainIdProblem();
    if (wrong) throw new SafetyError('RPC_NOT_ALLOWED', wrong);
    chains = { pha: new PhaReader(p, network), base: b };
  } catch (e) {
    out(`The chains cannot be read: ${e instanceof SafetyError ? e.detail : errorText(e)}. Nothing was removed.`);
    return 1;
  }
  let store: KitStore;
  try {
    store = await openStore({ dataDir, network, env: o.env ?? process.env, log: out });
  } catch (e) {
    const busy = e instanceof SafetyError && e.code === 'STORE_LOCKED';
    out(`${busy ? 'The bot is running on this data folder; stop it first' : 'The data folder cannot be opened'}: ${e instanceof SafetyError ? e.detail : errorText(e)}. Nothing was removed.`);
    return 1;
  }
  try {
    const dryRun = flags['dry-run'] === true;
    const res = await pruneSecrets({ store, chains, network, now: (o.now ?? Date.now)(), days, dryRun });
    for (const r of res) out(`${r.removed ? (dryRun ? 'would remove' : 'removed') : 'kept'} ${shortHex(r.h)} (trade #${r.tradeId}): ${r.why}`);
    const n = res.filter((r) => r.removed).length;
    out(`${dryRun ? 'Dry run: would remove' : 'Removed'} ${n} of ${res.length} secret(s) in ${store.dir}.`);
    return 0;
  } catch (e) {
    out(`Stopped: ${e instanceof SafetyError ? `${e.code}: ${e.detail}` : errorText(e)}`);
    return 1;
  } finally {
    await store.close().catch(() => undefined);
  }
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
