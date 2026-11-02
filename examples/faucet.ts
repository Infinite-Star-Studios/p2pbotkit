/**
 * Ask the devnet faucet for test tokens (build spec sections 2.4.10 and 6.7):
 *
 *   npm run faucet -- --pha P2K… --base 0x…     # both addresses of one bot
 *   npm run faucet -- --info                    # what one claim sends, and the limits
 *
 * One claim sends test TAZ, RA, SOUL and KCAL to the Phantasma address and
 * MockUSDC and a little ETH to the Base address, on devnet only (mainnet has
 * no faucet: anything but devnet is refused before anything is sent). The
 * faucet serves each address once a day and has hourly and daily limits.
 *
 * Only public addresses go on the command line: a key-shaped argument is
 * refused. A request whose answer was lost is asked once more; when the
 * faucet then says it already served the address, the first request went
 * out, so the script says to check the balances (it is not an error).
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BoardClient } from '../src/board.js';
import { devnetFaucet, faucetClaimLines } from '../src/faucet.js';
import { BoardError, SafetyError } from '../src/errors.js';
import { DEFAULT_API } from '../src/pins.js';
import { secretShapedArg } from '../src/keys.js';
import { errorText, redact } from '../src/redact.js';

const usage = [
  'Usage: npm run faucet -- --pha <P2K address> --base <0x address> [--api <url>]',
  '       npm run faucet -- --info [--api <url>]',
  '  --pha <address>   the bot\'s Phantasma address (test TAZ, RA, SOUL and KCAL)',
  '  --base <address>  the bot\'s Base Sepolia address (MockUSDC and a little ETH)',
  '  --info            show what one claim sends and how many claims are left today',
  `  --api <url>       the board (default ${DEFAULT_API})`,
  '  --network devnet  the only network with a faucet (the default)',
  'npx tsx examples/new-keys.ts prints this command with a new bot\'s addresses filled in.'
].join('\n');

/** Seconds as hours or minutes, for a person. */
function waitText(s: number): string {
  if (s >= 5400) return `about ${Math.round(s / 3600)} hours`;
  if (s >= 90) return `about ${Math.round(s / 60)} minutes`;
  return `${s} seconds`;
}

/** A faucet refusal in plain words. */
export function faucetRefusalText(e: unknown): string {
  if (e instanceof BoardError) {
    const later = e.retryAfter != null ? ` Try again in ${waitText(e.retryAfter)}.` : '';
    switch (e.code) {
      case 'FAUCET_LIMIT':
        if (e.reason === 'address') return `The faucet already served this address in the last 24 hours.${later}`;
        if (e.reason === 'ip') return `The faucet already served this connection three times in the last 24 hours.${later}`;
        if (e.reason === 'hourly') return `The faucet's hourly limit is reached.${later}`;
        if (e.reason === 'daily') return `The faucet's daily limit is reached.${later}`;
        return `The faucet refused this claim for now.${later}`;
      case 'FAUCET_OFF':
      case 'P2P_OFF':
        return 'The faucet is off on this board (P2P or the faucet is not open on devnet there).';
      case 'FAUCET_EMPTY':
        return `The faucet is running low and sends nothing for now.${later || ' Try again in an hour.'}`;
      case 'RATE_LIMITED':
        return `The board asks this connection to slow down.${later}`;
      case 'NETWORK':
        return `The board could not be reached (${redact(e.message, 200)}).`;
      default:
        return `The board refused the claim: ${redact(e.message, 300)}`;
    }
  }
  if (e instanceof SafetyError) return e.detail;
  return errorText(e);
}

/** The script: resolves with its exit code. */
export async function main(o: { argv?: readonly string[]; out?: (line: string) => void; fetch?: typeof fetch } = {}): Promise<number> {
  const argv = [...(o.argv ?? process.argv.slice(2))];
  const out = o.out ?? ((l: string) => console.log(l));
  if (secretShapedArg(argv)) {
    out('Refused: an argument looks like a key or a secret. The faucet needs only the public addresses (P2K… and 0x…).');
    return 2;
  }
  let flags: { pha?: string; base?: string; api?: string; network?: string; info?: boolean; help?: boolean };
  try {
    flags = parseArgs({
      args: argv, strict: true, allowPositionals: false,
      options: { pha: { type: 'string' }, base: { type: 'string' }, api: { type: 'string' }, network: { type: 'string' }, info: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }
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
  if (flags.network !== undefined && flags.network !== 'devnet') {
    out(`Refused: the faucet runs on devnet only (got --network ${redact(flags.network, 40)}). Mainnet has no faucet.`);
    return 2;
  }
  if (!flags.info && !flags.pha && !flags.base) {
    out('Name the addresses to fund: --pha <P2K address>, --base <0x address>, or both.');
    out(usage);
    return 2;
  }
  let board: BoardClient;
  try {
    board = new BoardClient({ network: 'devnet', api: flags.api ?? DEFAULT_API, ...(o.fetch ? { fetch: o.fetch } : {}) });
  } catch (e) {
    out(`Refused: ${faucetRefusalText(e)}`);
    return 2;
  }
  if (flags.info) {
    try {
      const i = await board.faucetInfo({ retries: 2, maxRetryAfter: 10 });
      out(`The devnet faucet at ${board.api} is ${i.enabled ? 'on' : 'off'}${i.low ? ' (running low)' : ''}.`);
      out(`One claim sends: ${Object.entries(i.amounts).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing'}.`);
      if (i.parts) out(`Parts on: Phantasma ${i.parts.pha ? 'yes' : 'no'}, Base ${i.parts.base ? 'yes' : 'no'}.`);
      out(`Each address is served once every ${i.perAddressHours} hours; ${i.leftToday} claims are left today.`);
      return 0;
    } catch (e) {
      out(faucetRefusalText(e));
      return 1;
    }
  }
  try {
    const r = await devnetFaucet(board, { ...(flags.pha ? { pha: flags.pha } : {}), ...(flags.base ? { base: flags.base } : {}) }, { log: out });
    if (r.alreadyServed || !r.claim) {
      out('An earlier request\'s answer was lost, and the faucet now says it already served this address: that request went out. Check the balances (the bot\'s preflight shows them).');
      return 0;
    }
    for (const line of faucetClaimLines(r.claim)) out(line);
    out('The transactions confirm within a minute or two; the bot\'s preflight (npm run seller -- --dry-run) shows the balances.');
    return 0;
  } catch (e) {
    out(faucetRefusalText(e));
    return e instanceof SafetyError ? 2 : 1;
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
