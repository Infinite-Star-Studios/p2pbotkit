/**
 * The example bots and scripts (build spec sections 6.5, 6.7, 8.1 "Examples"
 * and 10.3 B10), against fake chains and a fake board:
 *
 *   - the example configs parse into KitOptions and a Policy; the seller's
 *     take key calls sellDownTo, the buyer's buyUpTo; the example prices keep
 *     TAZ = RA / 1.8554, devnet's ratio;
 *   - mainnet is refused without --mainnet, KIT_ALLOW_MAINNET=1 and pins;
 *   - the runner (on a fake kit): the offers first, then run(); the first
 *     Ctrl-C stops posting and taking, cancels the offers and finishes the
 *     running trades; the second exits at once;
 *   - new-keys.ts writes 0600 files and prints addresses only; faucet.ts;
 *     prune.ts removes only secrets of finished trades whose locks are final,
 *     7 days on;
 *   - docs/CHECKS.md lists every check with its code; the word scan;
 *   - --dry-run reads and sends nothing;
 *   - the quick start of examples/README.md, command by command, end to end:
 *     new keys, the faucet, then the seller and the buyer bots trading with
 *     each other both ways until a Ctrl-C stops both;
 *   - the README's loop of one's own: resume() first and about once a
 *     minute, then step();
 *   - offers sized from the balances (sizeFromBalances): the config's keys,
 *     the rule (planSizes) and the runner's sync, across sessions.
 *
 * The fakes (a Phantasma node that serves the real devnet escrow bytecode and
 * applies the escrow transactions the kit signs, a Base node with SaturnSwap
 * and USDC, and the board, all on virtual time) are copied from
 * test/flows.test.ts, which cannot be imported without registering its tests
 * again; the board here also serves the devnet faucet and the reference
 * price. Keys are made on the spot into 0600 files in temporary folders and
 * never printed. No transaction leaves this process.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile, readFile, readdir, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { PhantasmaKeys, Transaction } from 'phantasma-sdk-ts';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { decodeFunctionData, keccak256, parseTransaction, recoverTransactionAddress, type AbiEvent } from 'viem';
import {
  createKit, resolvePolicy, tokenToRaw, usdcToRaw, CHECK_CODES, FLOW_CODES, SIGNER_CODES, SAFETY, SafetyError, BoardError, CreateError,
  type Kit, type KitOptions, type KitInternals, type LocalOffer, type LocalTrade, type OfferInput, type Policy, type Reference
} from '../src/index.js';
import { hexToDecimal, decimalToHex, sha256Hex, hashOfSecret, makeSecretRecord } from '../src/codec.js';
import { P2P_CONFIG, P2P_TOKENS, BOARD, phaPinned, baseDeployed } from '../src/pins.js';
import { SATURN_SWAP_ABI, USDC_ABI, pinnedDomainSeparator, type BaseClient, type BaseBlock, type BaseLog, type BaseReceipt, type ReadCall, type TxCall, type Hex } from '../src/base.js';
import type { PhaRpc, PhaCall, PhaBalance, PhaTxState, PhaBalances } from '../src/pha.js';
import { loadKeys } from '../src/keys.js';
import { openStore } from '../src/store.js';
import type { Offer, Trade } from '../src/types.js';
import { runBot, parseBotConfig, parseHostedConfig, trade, SESSION_PAUSED, kitOptions, botPolicy, networkGate, readOnlyTransports, defaultConfigPath, referenceLines, sameOffer, describeOffer, guardProcess, MARKET_CONFIG, planSizes, sizedOffer, sizedSame, plainAmount, dryRunRest, SIZE_EVERY_S, type BotKit, type Role, type SizedListing, type HostedBotConfig } from '../examples/seller-bot.js';
import { main as newKeysMain, makeKeyPairs } from '../examples/new-keys.js';
import { main as faucetMain } from '../examples/faucet.js';
import { main as pruneMain, pruneSecrets, KEEP_DAYS, type PruneChains } from '../examples/prune.js';


// ── The devnet escrow as the node serves it (public bytecode) ────────────────

/** The devnet saturnescrow script (getContract('main', 'saturnescrow').script), deflated and base64: public bytecode. */
const ESCROW_SCRIPT_DEFLATED = [
  'eNrtXH2MG8d1352Z/d5Zfi/JJXVkzQvuVNhypH7YUZI2shQrjq1YsmUrlhxdGR0lnX26O/HuZKmBG9WOiqJNkMQBWqeui8SW4dYpChepEbQu5MgtpNRNW+QP',
  'F2maJi7gBjEKtHXdD6Qpkr43O8td3pE8WroDBLASlruz8+Y3b968N/vmSfMUrrDUXctzSzMnWlvubbUXZ+bnDIUpXKWqGiiqYiuHFaDZtnO53W7NLdXnWqeX',
  'F+sL7fml+SPzs/VTYZP64vH55dnp+kdb9a31+Xb9xHy75SrY0Jg6MTO348QSxYK1p7mwZedsq9k2ZF3zdJ86d2p2/siDren980vN2V4EfOrIbBO47k+hTc1M',
  '33m0d8fHm4vHd/RharE1N91q96qzp9qtIzMLMyCIPk3PnPjo/GzvuuaJ+eXe7ayp6VZzenZmrtWr1pw60m41l1rTvSr1qcUlqOs3EGi51LvZseVme7p3d/ML',
  'rX4zZuKM3Qn1qyqZSU18tWN6ut1aXJzcjK+IaRFL5RZVFWIReafyzuRdgztJe8TS4YEqTxNiGdymTHnlt95NbW4zun/HQfHQ0SWbW8zAzu9uLRkWEOvK+34x',
  '/dbBVeSheq0iN5Szl87/0qdoN308uO4GCjeZuau51MQiVYX4mtPAClUMkxIh6oXm8iLOELyg8IJMnRTPTBAfCSceyppQy3khQCjqoUhn5u4AXRdvjEjI0RsH',
  'TJFlF5tLy+251uKR9vxDN2zd8s4t76Sq+RJVRG3I2+7WEifMTVJyhapUzJTghxJDZZTACOBSGyphRBQBymYxEA4yHoM6bBedYQ7o5mSPbmLxDN1VJMGePa3u',
  'oSPwq+xgfJgOmOqpKuUUoShnTD0GSsA6BofPXZ3CGxrqGnBkUOyNELhUVqZMK2iapX1FAxJ777bt7RYsPO0zLlWgWkCtQqex3grtAL5hFDBSoMRbRElgEB1K',
  'VUG+hWZ32a+Kw1CAGU8lJEOI6iFnBAZmvltXkmMlHBhX1OuBZaIBIeMatNzENB2eCdECphm+boSaAKybH+tuj53wGtV+DH8UvomqdT5GNQX+AFOUvKZsVhVr',
  'whqzsPRVLNkT9piNpS9gyZlwxhwsncWSO+GOuTibvwAFPsHHOBbeBwVvwhvzsFCHQmoiNZaaUMfSPCP6OqvwLLDCc/iTx58C/vj4U8SfEo4Rvozs2PesB0C0',
  '2rk/OPaiAvyz9ltz7wERaNv/885nFBg7+/hd3j6uU+2Tx7UnFA7z+qW/e7TGYUEo/9Vrhya1TeViWSsjI/rmshLggwMPlVJQEYVyVCjpRsXXKpWSUak0oNwI',
  'TCRgj9/4a7c0AgXKVjCpIpwq4Ag2xAcOD9VSpSoKflQoqqTq02rVVwk0qVYb8K7BAuazGgN40zdr5iRDODYUd5pe8Rlwp0fcGYK7z+666WTInR1MmghnDsWd',
  'qVZ9AtyZaswdDahPaxTgDd+oGZMU4ehQ3DGt4lPgTou405FA+5sffvUFJWTPCSYNxDOGYs8wQXDAnmHG7JGA+KRGAF/39Zo+SRCODMUeZRWfAHssYk8T7D3z',
  '9y+8Idlzg0kd8fSh2NMNkBywpxsxe2qg+mpNBXzN12paUlXWYo/Qiq8CezRij4m5PfTyve8KueNBUpHX4k7TQXDAnabH3JmB0DiAFxqYVJW1uFNJxTeBOxJx',
  'RwV3b2bevC/kzguSirwWd0wDuQF3TIu5MwKhcQAvNDCpKWtxZ6oVHyy2pEbcETG15x/5+cfk1KaCpCavxR5lIDhgD9aPDnt6IDQO8IUGJjVlLfYMs+KDyZbM',
  'iD1VsPfq4eqXJHvpIKnJa7FHKEgO2CM0Zk8LhMYBvtDAq1/ztMefM74p2ctcg4ueeujRbMhd9tpb9NiFc1vHQ+5y196ax/7sYfeekLv8NbjkLX3kQjvkrnDt',
  'LXnaj/7wO2elWfjX4Jr3rP7tJyR7xWtwzVt684mLkr3Suq95NsLZAs6I2Msm2aOb7bAwWUTSoiDNYB/4kBOk1Yoo2JuLYaFhBVbDqsKVtXyrZq3Dynpx5onX',
  'lY1yJx2EcwYKwZFCKCFpaaAQSlIIdmA37CpcOdu3a/bVr9/ar+y+8K/KRnmtLsK5A4XgSiFYSGoNFIIlheAETsOpwpV3fKfmrMNn4tKTF1Mb5RpzhOMDZcCl',
  'DBKG008GtpSBG7gNtwpXwfXdmrsOH6Ovf9Ed3yj/20M4b6AMPCmDhN30k4EjZcAD3uBVuHz4W+Pr8Mmbv/6NGzbKy08hXGqgDFJSBgmz6ScDV8rAC7yGV4Wr',
  '6PlezVuHvcRzn1j64EbtJdIIlx4og7SUQcJs+smASxmkglQjVYWrlPJTtdTVf73Zt3/v+fs3asOSQbjMQBlkpAwSZtNPBp6UQTpIN9JVuKy0n66lr95FYN/6',
  '1R+c2qhdURbhsgNlkJUySJhNPxmkpAwyQaaRqcJlZ/xMLbMOHsJd+37u8Q3be+UQLjdQCDkphITd9BNCWgohG2Qb2SpcTtbP1rLr4CGcuLT1d5WN2uLlES4/',
  'UAh5KYSE4fQTQkYKIRfkGrkqXG7Oz9Vy6xA9+9oEfV7ZqJ1kAeEKA4VQkEJIWE4/IWSlEPJBvpGvwsXzfr6WX4cY3eWP3/eSslEbVh/h/IFC8KUQEpbTTwg5',
  'KYRCUGgUqnB5Bb9QK1y9j6C95bx2SdmofXFiP9RPCEUphITl9BNCXgrBD/yGX4Ur5ft+zV+H3ffuzz776obtvhP7oX5CKEkhJCynnxAKUgjFoNgoVuFKF/1i',
  'rbgOXsK+I6/oG7XFT2yH+snAkjJIGE4/GfhSBqWg1ChV4cqU/FKttA5ewrHNm/MjHkdg5+yvTIx4GIHd/BOVLaMeRfjfE9fvGfUoQo7ffPeoRxH2L9qtUY8i',
  'vGg/cGrEowjalr94+ZeVEQ8jaOeubz+mjHoc4Yvff+mpkY8j3H40+P84wsKv3/7yyMcRnt43e3nk4wjl7z/2jZGPI4zrn//bUY8jaOd+xvsPZdQDCQtfeCA9',
  '6oEE/+L58qgHEszZm8ZGPZBwx0MfmBj1QMILf/r8T496IOHLbvVdox5I+OBz3/zQqP93hDtf+e1Do/7fEd6a33J8xMMI7F8e+fTSiEcR2PyRZ06PehAhf/pr',
  'nxj5IIJJLn9y5IMI//PjC58Z+SDCP8/uPT/yQYT/fvoHF0Y9iKD9++mTlzbqWIP43w7fsx5oqEpUDk/CNogipIQEeCK2QRWhOkggTsY2mCIMCgnwhGxDUwQy',
  'EoiTsg1dEfJGAjwx2zAUoYRYxpOzDVMRlklU6x3WmNWwiLxTeWfyrsm7Lu+GvGNCAhIeYf7RLZ0jyAQPa+v19+oMat+xk1Nm7d22PUyfIE5bi+qHoZoS82d3',
  'KiuOeUensWXCiWHPeHNGVaVCmWZpn4/6nJvHtBfYp+DxqZ1DHPE35fl7mZMgPLQuDqZ3neamPY94ExV6YmWCXIztAngTuBBILpHHzAnLRBlCbls8MLMEXS8a',
  'BEW1bxcMFU+mPxS+dZnS7yg5Hv32hBgvikPibKtGiMF1Rh9snbnR0HRCsaSdas4ut0SZYVk9ic9UI6pGNa4xY++2vc1284QopCO2PjS/NHP0zL3bDG3ojAhx',
  'yoZQXnFNIiGDqGJdVVFmBlGl9RkqnpNnOjM8A2a7V2IMZnmWBXpjc4dcR5TFy/9YCG798z1v/NN/fevs+0/91F/ue9jMfO5wc8fjxcxff+6HU9RZieCUbcct',
  'uK7lvvp+bnfNgQ3T5lJXr1s6c4hjE9vhLlXVsuNyi7NbudNF7oTk8LbHLDvMsZybbuVuVxNXIVRgKiHmAcRE7Q1FCpBYSalLdE4553EmDix0mwYH7I5puMwl',
  'LvDsco6m4XLP8r6MvaNSLs0/2JqDvrEOtJvoHvW4FycFwUI3toddR9gcFJm7xPCIm9rkpdL45KSqXirjpzMe8aAWertuN0+JoYTZWtyUwlPYXYroaZrm6UR6',
  'FCx195eGtp3+UixFUoALHWUa6UyWZFM8g1AZomdplmcT+Uaw1A2V5ZkYKsMyJJMmqQxJZ6uZbM7KXd6N9cDm0eXZWTcDqwVAigUsY2Ve3w1wWIlJbtysyGpA',
  'aZaQHM3xXLRK4WN3nzlsFvWZZcAxdJsV6RDK2Vzeyr/3AxJYzHJWISbUkuuUNf8A9Ar9zSFiIQ+gv4mgrshuIVPrhMhEjWle7EODvQ9hPQN6L9zWEzlP88J+',
  'ciQHYshhNgi1DE2swq23ody6GuQUnmduZDz74cfIszzJ54hVIDl/vOAXSRHKPmHFTX6xhE9aseqDd1Aq+8QvkIJv+b9zGy8yB4CjXEBuUSG5Ii3q9X2aXh9n',
  'DFCAukRLhMAPL0UzWYKGnVweRVEpyICik+hoBY3aRSMTHq2gMRM0ycRHK8j0bqgwAdIKGqOLRiZCWkFjJWgSCZFWUOUSVHFipG4iXoLZismiFEndRHr90wwJ',
  'KRDq6CCWV6ScEm+67KOM3Ef2UWIlUoIZKRMjaJTBR670gynFvZZICmgiwngpWUFkxERD6Xd5pX5je7UsYP2OXrabc4tHW+39uIwuGiXxIQansLS1TPwKDxiZ',
  'mb6xUg4IwYJ6XDwb+KyHEyZeWPjCjGZHvNIFTTjx4kVJAJzE54iPMq7gdwixiNLqL3dZr39XSzhk4HjodWWn9JXg46/Xb97J0IvA1DIUPAKqUx08hGh68bl7',
  'vnT0F6L50oTTAW4O19GWNd2wDG8PUOCnRSC4moIQXXYM8ETXuIE9GoTip9xMaicWuzs1uRF3Co/E0IlmEN0MDNOyrEf3QD1+S1unF2basIoaCtEAFo2cm+Ce',
  'UzPqJhpYBxGVwyDg7nVIOim+umn0+r8xBBOU4Bpzq8uAsdzNtIVYEdNmn1ReBubrYtQi1JbptaSxY6Ebr5M/C/HAJyeWyW2UoQ2OA7gOTrwKYKG7sYPYUWNw',
  'bYhtcQcbO8RER8VdmfoNX3VDoDfTgXCkF+QSizfApaBeXxwnFqITuTBm6MLExjqkD8OJ5Y1zLwWuQw8IN+4J+QJ3BonAIUbKoYyer5wiLmD72bsr7B1doK2c',
  '0BT4SmjvcCcWFiIbxxcuvgD7hVuHJfSJdobCEsXVBsxXGHBiR7W8F/c/kUMis1cJe0brxm0QpUwYOdhjpPb43C1mDTYbHTEzJpNJ4XKglpmmW/p39gJFbM9M',
  'QYguew5XAVwCgDvYf8Cew0jaMxa7O8VNSKfTcDkgDE16kw4Gbe7bB/XYZavZnj3j6gpsW6ghrFkuGrKTaFgdPJx6XViqgZYKhLFNi8/x2muLyBbXpQO43KDl',
  'M7B8Elp+x0zXNntp4xRsnEQ2Ls30bdm4Edp4rO9DGTmx0MDHwflHrVsNYcdys4kJ9YKI6ILyCndRArafydjCZHDx2OoQgsaFJsMdXBOgEJkMvrDxBZgMPHdY',
  'wmX+rtbRZZjMaVFebTNOL5uBjx6GGZ68W7ny1HugUf8wfPtV6e6geXV/HOXAN/AVFhntaOxTYqF7VoE0nlUihjHdF0d6r0OhPLd/dbo4uWzIwIBEezurhlKB',
  'VcPWb7kngqJvfwUisPXCfHa337PSd4lWN4rWTQUVto6se+0gUY8IDqXmHw3ZUfKDf6V91e8d0BfrGlS4xAzTkXlqECpNosq1ZyjUrw+Jmljsh8IdPzAcbrwZ',
  'GQr2YweGFYL08IZC/caBdQwXhuvA+IevOKQWArSGB1gZeZMIz74thK4AnUR448NC2qsWMhk5GmoJuuG+PhhhZGsojJM9Mbo3jEMB/UlPoBX+7FBI7KBIE7rC',
  'T4I6TPcptBOpfvLgFWvBgBCpWLv1+vmd4PuhT6Zsgm2ZfFarmm76hil3bZb2xwdxswee1pHmAvpZBGpg6HITKPvUiQov9Pr+XauztCaS9KprBKkZ8xjoTogF',
  '7EEf4KSp6PLBM8iwCttH37RCb9BAj0spG/hvC/DGsI1HDoncxuhHRU6YVJOOy4VujGl+9xBu/yzzN6BBZ3CWInZtibahmna3JcxaEx+8UdwDomcp9o1CMFds',
  'jf3NjA2Kg2ueBhOlCrcYp1qI6z2bUFzEgNFXDdP2LVvslHFX/tT9uPmVsoAhaNiAnt1uVcUO+uL96E3Latg9A4ZBcYttsI4LHTEej1psskWVZDwhkFWakkzJ',
  'rIoczsmUzOoG/4sMmuXKlyRpKsIN6RGsh2mw2OsfAa8lGazX0EORYRMldJVCtjSJ2UsCcYJrtcc6E3vlQy0xxw4rPUGi6PdQIL9/eK1/WYpFROP0w5b+5mFM',
  'kCz1hSnCyYv2mjEPHc8O7YahkHCI22F9aeCaBLqF4SbY+SWXmH5Zk4muKhaZm5Jpm5cXjrWb0y3Y+K7R4skpuU9+cGZ2VpD/H0zK8Ps='
].join('');
const ESCROW_SCRIPT = inflateSync(Buffer.from(ESCROW_SCRIPT_DEFLATED, 'base64')).toString('hex');
const ESCROW_METHODS = ['Initialize', 'getContractVersion', 'lock', 'claim', 'refund', 'hashSecret', 'getLockCount', 'getOpen', 'getHashAt', 'getId', 'getState',
  'getSender', 'getRecipient', 'getSymbol', 'getAmount', 'getDeadline', 'getCreated', 'getSecret', 'getAdmin', 'getPaused', 'getMinLock', 'getMaxLock',
  'getMinAmount', 'getMaxAmount', 'getLockedTotal', 'getClaimedTotal', 'getNow', 'setPaused', 'setToken', 'setLockBounds', 'setAdmin', 'getOpenAmount',
  'getMaxOpen', 'setOpenCap', 'onUpgrade', 'onKill'];
const CFG = P2P_CONFIG.devnet;
const T0 = 1_790_000_000;
const SWAP = CFG.base.swap.toLowerCase();
const USDC = CFG.base.usdc.toLowerCase();
const ZERO = '0x' + '0'.repeat(40);
const KEEPER_BASE = '0x6ec2a535685d5ce5f143b8c0d9bf5f612295b703';
const sha = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest();
const nowSecOf = (ms: number) => Math.floor(ms / 1000);

// ── Virtual time ─────────────────────────────────────────────────────────────

/** Real wait for the kit's own I/O (the store fsyncs) to settle between virtual ticks. */
const settle = (ms = 8) => new Promise<void>((r) => setTimeout(r, ms));

class VTime {
  ms = T0 * 1000;
  #timers: Array<{ at: number; done: () => void }> = [];
  now = (): number => this.ms;
  /** A wait that moves the clock at once (step-driven tests). */
  jump = async (ms: number, _signal?: AbortSignal): Promise<void> => {
    if (ms > 0) this.ms += ms;
  };
  /** A wait that lasts until advance() reaches it, or its signal aborts (run() tests). */
  sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise<void>((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    if (!(ms > 0)) { setImmediate(resolve); return; }
    const t = {
      at: this.ms + ms,
      done: () => {
        signal?.removeEventListener('abort', t.done);
        this.#timers = this.#timers.filter((x) => x !== t);
        resolve();
      }
    };
    this.#timers.push(t);
    signal?.addEventListener('abort', t.done, { once: true });
  });

  async advance(ms: number): Promise<void> {
    const end = this.ms + ms;
    for (let guard = 0; guard < 10_000; guard++) {
      const due = this.#timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.ms = Math.max(this.ms, due.at);
      due.done();
      await settle(2);
    }
    this.ms = end;
    await settle();
  }
}

// ── A fake Phantasma node that applies the escrow's transactions ─────────────

interface FakeLock { state: number; sender: string; recipient: string; symbol: string; amount: bigint; deadline: number; created: number; secret?: string }
type SendMode = 'normal' | 'lose' | 'drop' | 'mempool';

/** The escrow call inside a signed Phantasma transaction, read back from its script. */
function decodeEscrowCall(hex: string): { method: string; args: string[] } | null {
  const tx = Transaction.FromBytes(hex);
  const script = Buffer.from(tx.script, 'hex');
  const regs: unknown[] = [];
  const stack: unknown[] = [];
  const argc: Record<string, number> = { AllowGas: 4, SpendGas: 1, lock: 6, claim: 1, refund: 1 };
  let found: { method: string; args: string[] } | null = null;
  let i = 0;
  const varint = () => {
    const b = script[i++]!;
    if (b < 0xfd) return b;
    const v = script[i]! | (script[i + 1]! << 8);
    i += 2;
    return v;
  };
  while (i < script.length) {
    const op = script[i++]!;
    if (op === 13) {
      const reg = script[i++]!;
      const type = script[i++]!;
      const len = varint();
      const bytes = script.subarray(i, i + len);
      i += len;
      regs[reg] = type === 4 ? bytes.toString('utf8') : '0x' + bytes.toString('hex');
    } else if (op === 3) {
      stack.push(regs[script[i++]!]);
    } else if (op === 4) {
      regs[script[i++]!] = stack.pop();
    } else if (op === 45) {
      const src = script[i++]!;
      const dst = script[i++]!;
      regs[dst] = regs[src];
    } else if (op === 46) {
      const ctx = String(regs[script[i++]!]);
      const method = String(stack.pop());
      const args: string[] = [];
      for (let k = 0; k < (argc[method] ?? 0); k++) args.push(String(stack.pop()));
      if (ctx === 'saturnescrow') found = { method, args };
    } else if (op === 7) {
      i++;
    } else if (op === 11) {
      break;
    } else {
      throw new Error(`fake node: opcode ${op}`);
    }
  }
  return found;
}

class FakePha implements PhaRpc {
  name = 'saturnescrow';
  script = ESCROW_SCRIPT;
  methods = [...ESCROW_METHODS];
  admin: string = CFG.phaAdmin;
  locks = new Map<string, FakeLock>();
  bounds: Record<string, { min: bigint; max: bigint }> = Object.fromEntries(P2P_TOKENS.map((t) => [t.symbol, { min: t.min, max: t.max }]));
  bals = new Map<string, PhaBalance[]>();
  sent: string[] = [];
  states = new Map<string, PhaTxState>();
  mempool = new Map<string, { method: string; args: string[] }>();
  /** How the next sends go (one entry each; default normal). */
  modes: SendMode[] = [];
  /** Sends by escrow method. */
  byMethod: Record<string, number> = {};

  constructor(readonly clock: () => number) {}

  async views(calls: readonly PhaCall[]): Promise<unknown[]> {
    return calls.map((c) => this.#view(c));
  }

  #view(c: PhaCall): unknown {
    if (c.contract !== this.name) return null;
    const lock = () => this.locks.get(decimalToHex(c.args[0])!);
    switch (c.method) {
      case 'getState': return String(lock()?.state ?? 0);
      case 'getSender': return lock()?.sender ?? null;
      case 'getRecipient': return lock()?.recipient ?? null;
      case 'getSymbol': return lock()?.symbol ?? null;
      case 'getAmount': return lock() ? String(lock()!.amount) : null;
      case 'getDeadline': return lock() ? String(lock()!.deadline) : null;
      case 'getCreated': return lock() ? String(lock()!.created) : null;
      case 'getSecret': { const s = lock()?.secret; return s ? hexToDecimal(s) : null; }
      case 'getAdmin': return this.admin;
      case 'getPaused': return '0';
      case 'getMinLock': return '600';
      case 'getMaxLock': return '7200';
      case 'getMinAmount': return String(this.bounds[c.args[0]!]?.min ?? 0n);
      case 'getMaxAmount': return String(this.bounds[c.args[0]!]?.max ?? 0n);
      case 'getOpenAmount': return '0';
      case 'getMaxOpen': return String(10n ** 20n);
      case 'hashSecret': {
        const bytes = Buffer.from(BigInt(c.args[0]!).toString(16).padStart(64, '0'), 'hex');
        return BigInt('0x' + sha(bytes).toString('hex')).toString();
      }
      default: return null;
    }
  }

  async contract(): Promise<{ name: string; script: string; methods: string[] }> {
    return { name: this.name, script: this.script, methods: this.methods };
  }

  async balances(address: string): Promise<PhaBalance[]> {
    return this.bals.get(address) ?? [];
  }

  /** Apply one escrow call as the escrow would, answering the transaction's state. */
  apply(call: { method: string; args: string[] } | null): PhaTxState {
    const now = nowSecOf(this.clock());
    if (!call) return { state: 'Fault', reason: 'not an escrow call' };
    this.byMethod[call.method] = (this.byMethod[call.method] ?? 0) + 1;
    if (call.method === 'lock') {
      const [from, hDec, symbol, amount, recipient, deadline] = call.args as [string, string, string, string, string, string];
      const h = decimalToHex(hDec)!;
      if (this.locks.has(h)) return { state: 'Fault', reason: 'P2:used' };
      this.locks.set(h, { state: 1, sender: from, recipient, symbol, amount: BigInt(amount), deadline: Number(deadline), created: now });
      return { state: 'Halt', reason: '' };
    }
    if (call.method === 'claim') {
      const secret = decimalToHex(call.args[0])!;
      const l = this.locks.get(hashOfSecret(secret));
      if (!l || l.state !== 1) return { state: 'Fault', reason: 'P2:state' };
      if (now >= l.deadline) return { state: 'Fault', reason: 'P2:expired' };
      l.state = 2;
      l.secret = secret;
      return { state: 'Halt', reason: '' };
    }
    if (call.method === 'refund') {
      const l = this.locks.get(decimalToHex(call.args[0])!);
      if (!l || l.state !== 1) return { state: 'Fault', reason: 'P2:state' };
      if (now < l.deadline) return { state: 'Fault', reason: 'P2:early' };
      l.state = 3;
      return { state: 'Halt', reason: '' };
    }
    return { state: 'Fault', reason: 'unknown method' };
  }

  async sendRaw(hex: string): Promise<string> {
    this.sent.push(hex);
    const hash = sha(Buffer.from(hex, 'hex')).toString('hex').toUpperCase();
    const mode = this.modes.shift() ?? 'normal';
    if (mode === 'lose') throw new Error('fetch failed');
    const call = decodeEscrowCall(hex);
    if (mode === 'mempool') {
      if (call) this.mempool.set(hash, call);
      return hash;
    }
    this.states.set(hash, this.apply(call));
    if (mode === 'drop') throw new Error('fetch failed');
    return hash;
  }

  /** Run every transaction waiting in the mempool. */
  flush(): void {
    for (const [hash, call] of this.mempool) this.states.set(hash, this.apply(call));
    this.mempool.clear();
  }

  async transaction(hash: string): Promise<PhaTxState | null> {
    return this.states.get(hash) ?? (this.mempool.has(hash) ? { state: 'Pending', reason: '' } : null);
  }

  /** Sends of one escrow method so far (lost ones included). */
  count(method: string): number {
    return this.sent.filter((hex) => decodeEscrowCall(hex)?.method === method).length;
  }
}

// ── A fake Base node with SaturnSwap and USDC that applies transactions ──────

interface FakeSwap { token: string; deadline: number; feeBps: number; sender: string; claimer: string; amount: bigint; block: bigint; claimedBlock?: bigint; refundedBlock?: bigint }

const BASE0 = 10_000n;

class FakeBase implements BaseClient {
  baseFee = 10_000_000n;
  tip = 1_000_000n;
  feeBps = 50;
  chain = 84532;
  usdc = new Map<string, bigint>();
  allowances = new Map<string, bigint>();
  nonces = new Map<string, number>();
  swaps = new Map<string, FakeSwap>();
  preimages = new Map<string, { value: string; block: bigint }>();
  owed = new Map<string, bigint>();
  events: BaseLog[] = [];
  receipts = new Map<string, BaseReceipt>();
  mempool = new Map<string, Hex>();
  sent: Hex[] = [];
  modes: SendMode[] = [];
  reads = 0;

  constructor(readonly clock: () => number) {}

  get head(): bigint {
    return BASE0 + BigInt(Math.max(0, Math.floor((this.clock() / 1000 - T0) / 2)));
  }

  blockTime(n: bigint): number {
    return T0 + Number(n - BASE0) * 2;
  }

  async chainId(): Promise<number> { return this.chain; }

  async block(at: { tag?: 'latest' | 'safe'; number?: bigint } = {}): Promise<BaseBlock> {
    const n = at.number != null ? at.number : at.tag === 'safe' ? this.head - 10n : this.head;
    return { number: n, timestamp: BigInt(this.blockTime(n)), baseFeePerGas: this.baseFee };
  }

  /** getSwap at block `bn`: as it stood then. */
  swapAt(h: string, sender: string, bn: bigint = this.head) {
    const s = this.swaps.get(`${h.toLowerCase()}|${sender.toLowerCase()}`);
    if (!s || s.block > bn) return { token: ZERO, deadline: 0n, feeBps: 0, state: 0, sender: ZERO, claimer: ZERO, amount: 0n };
    const state = s.claimedBlock != null && s.claimedBlock <= bn ? 2 : s.refundedBlock != null && s.refundedBlock <= bn ? 3 : 1;
    return { token: s.token, deadline: BigInt(s.deadline), feeBps: s.feeBps, state, sender: s.sender, claimer: s.claimer, amount: s.amount };
  }

  async read(c: ReadCall): Promise<unknown> {
    this.reads++;
    const a = (c.args ?? []) as string[];
    const to = c.address.toLowerCase();
    if (to === SWAP) {
      switch (c.functionName) {
        case 'getSwap': return this.swapAt(a[0]!, a[1]!, c.blockNumber ?? this.head);
        case 'feeBps': return this.feeBps;
        case 'paused': return false;
        case 'minLock': return 60n;
        case 'maxLock': return 172_800n;
        case 'tokenCfg': return [true, 1_000_000n, 100_000_000_000n];
        case 'getPreimage': {
          const p = this.preimages.get(`${a[0]!.toLowerCase()}|${a[1]!.toLowerCase()}`);
          if (!p || p.block > (c.blockNumber ?? this.head)) throw new Error('NotClaimed');
          return p.value;
        }
        case 'owed': return this.owed.get(a[1]!.toLowerCase()) ?? 0n;
      }
    }
    if (to === USDC) {
      switch (c.functionName) {
        case 'balanceOf': return this.usdc.get(a[0]!.toLowerCase()) ?? 0n;
        case 'allowance': return this.allowances.get(a[0]!.toLowerCase()) ?? 0n;
        case 'nonces': return 0n;
        case 'DOMAIN_SEPARATOR': return pinnedDomainSeparator(CFG);
        case 'isBlacklisted': return false;
        case 'paused': return false;
      }
    }
    throw new Error(`fake base: no ${c.functionName} at ${to}`);
  }

  async logs(q: { address: Hex; event: AbiEvent; args: Record<string, unknown>; fromBlock: bigint; toBlock: bigint }): Promise<BaseLog[]> {
    return this.events.filter((l) => l.eventName === q.event.name && l.blockNumber != null && l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock
      && Object.entries(q.args).every(([k, v]) => String(l.args[k]).toLowerCase() === String(v).toLowerCase()));
  }

  async receipt(hash: Hex): Promise<BaseReceipt | null> { return this.receipts.get(hash.toLowerCase()) ?? null; }
  async seen(hash: Hex): Promise<boolean> { return this.receipts.has(hash.toLowerCase()) || this.mempool.has(hash.toLowerCase()); }
  async code(): Promise<Hex> { return '0x'; }
  async balance(): Promise<bigint> { return 10n ** 18n; }

  async nonce(address: Hex, tag: 'latest' | 'pending'): Promise<number> {
    const a = address.toLowerCase();
    const mined = this.nonces.get(a) ?? 0;
    if (tag === 'latest') return mined;
    let n = mined;
    for (const raw of this.mempool.values()) if ((await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase() === a) n++;
    return n;
  }

  async priorityFee(): Promise<bigint> { return this.tip; }
  async estimateGas(): Promise<bigint> { return 100_000n; }

  /** One call's effect (dry: only whether it would revert). Throws the revert's name. */
  apply(from: string, to: string, data: Hex, dry: boolean, logs: BaseLog[] = []): void {
    const now = nowSecOf(this.clock());
    const block = this.head;
    if (to.toLowerCase() === USDC) {
      const d = decodeFunctionData({ abi: USDC_ABI, data });
      if (d.functionName === 'approve' && !dry) this.allowances.set(from, (d.args as readonly unknown[])[1] as bigint);
      return;
    }
    if (to.toLowerCase() !== SWAP) throw new Error('fake base: unknown contract');
    const d = decodeFunctionData({ abi: SATURN_SWAP_ABI, data });
    const a = d.args as readonly unknown[];
    switch (d.functionName) {
      case 'lock':
      case 'lockWithPermit': {
        const [h, token, amount, claimer, deadline, maxFeeBps] = a as [string, string, bigint, string, bigint, number];
        const key = `${h.toLowerCase()}|${from}`;
        if (this.swaps.has(key)) throw new Error('SwapExists');
        if (this.feeBps > Number(maxFeeBps)) throw new Error('FeeTooHigh');
        if ((this.usdc.get(from) ?? 0n) < amount) throw new Error('ERC20InsufficientBalance');
        if (d.functionName === 'lock' && (this.allowances.get(from) ?? 0n) < amount) throw new Error('ERC20InsufficientAllowance');
        if (dry) return;
        if (d.functionName === 'lock') this.allowances.set(from, (this.allowances.get(from) ?? 0n) - amount);
        this.usdc.set(from, (this.usdc.get(from) ?? 0n) - amount);
        this.swaps.set(key, { token: String(token).toLowerCase(), deadline: Number(deadline), feeBps: this.feeBps, sender: from, claimer: String(claimer).toLowerCase(), amount, block });
        const ev: BaseLog = { address: SWAP, blockNumber: block, eventName: 'Locked', args: { h: h.toLowerCase(), sender: from, claimer: String(claimer).toLowerCase(), token, amount, deadline, feeBps: this.feeBps } };
        this.events.push(ev);
        logs.push(ev);
        return;
      }
      case 'claim': {
        const [preimage, sender] = a as [string, string];
        const h = '0x' + sha(Buffer.from(preimage.slice(2), 'hex')).toString('hex');
        this.#claim(h, String(sender).toLowerCase(), preimage.toLowerCase(), dry, logs);
        return;
      }
      case 'refund': {
        const [h, sender] = a as [string, string];
        const s = this.swaps.get(`${h.toLowerCase()}|${String(sender).toLowerCase()}`);
        if (!s || this.swapAt(h, String(sender)).state !== 1) throw new Error('NotLocked');
        if (now < s.deadline) throw new Error('SwapNotExpired');
        if (dry) return;
        s.refundedBlock = block;
        this.usdc.set(s.sender, (this.usdc.get(s.sender) ?? 0n) + s.amount);
        return;
      }
      case 'withdrawOwed': {
        const claimer = String(a[1]).toLowerCase();
        const owed = this.owed.get(claimer) ?? 0n;
        if (owed === 0n) throw new Error('NothingOwed');
        if (dry) return;
        this.owed.set(claimer, 0n);
        this.usdc.set(claimer, (this.usdc.get(claimer) ?? 0n) + owed);
        return;
      }
    }
    throw new Error(`fake base: ${d.functionName} is not served`);
  }

  #claim(h: string, sender: string, preimage: string, dry: boolean, logs: BaseLog[]): void {
    const s = this.swaps.get(`${h}|${sender}`);
    if (!s || this.swapAt(h, sender).state !== 1) throw new Error('NotLocked');
    if (nowSecOf(this.clock()) >= s.deadline) throw new Error('SwapExpired');
    if (dry) return;
    const block = this.head;
    s.claimedBlock = block;
    this.preimages.set(`${h}|${sender}`, { value: preimage, block });
    const fee = (s.amount * BigInt(s.feeBps)) / 10_000n;
    this.usdc.set(s.claimer, (this.usdc.get(s.claimer) ?? 0n) + s.amount - fee);
    const ev: BaseLog = { address: SWAP, blockNumber: block, eventName: 'Claimed', args: { h, sender, preimage, claimer: s.claimer, net: s.amount - fee, fee } };
    this.events.push(ev);
    logs.push(ev);
  }

  /** The keeper (or anyone) claims a swap with its preimage, directly on chain. */
  claimDirect(h: string, sender: string, preimage: string): void {
    this.#claim(h.toLowerCase(), sender.toLowerCase(), preimage.toLowerCase(), false, []);
  }

  async call(c: TxCall): Promise<Hex> {
    this.apply(c.from.toLowerCase(), c.to, c.data, true);
    return '0x';
  }

  async #mine(raw: Hex, hash: string): Promise<void> {
    const t = parseTransaction(raw);
    const from = (await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase();
    this.nonces.set(from, (t.nonce ?? 0) + 1);
    const logs: BaseLog[] = [];
    let status: 'success' | 'reverted' = 'success';
    try {
      this.apply(from, t.to!, t.data!, false, logs);
    } catch {
      status = 'reverted';
    }
    this.receipts.set(hash, { status, blockNumber: this.head, transactionHash: hash, logs });
  }

  async sendRaw(raw: Hex): Promise<Hex> {
    this.sent.push(raw);
    const hash = keccak256(raw).toLowerCase() as Hex;
    const mode = this.modes.shift() ?? 'normal';
    if (mode === 'lose') throw new Error('fetch failed');
    if (mode === 'mempool') {
      this.mempool.set(hash, raw);
      return hash;
    }
    await this.#mine(raw, hash);
    if (mode === 'drop') throw new Error('fetch failed');
    return hash;
  }

  /** Mine every transaction waiting in the mempool. */
  async mineAll(): Promise<void> {
    for (const [hash, raw] of [...this.mempool]) {
      this.mempool.delete(hash);
      await this.#mine(raw, hash);
    }
  }

  /** Sends by function name so far. */
  count(fn: string): number {
    return this.sent.filter((raw) => {
      const t = parseTransaction(raw);
      try {
        return decodeFunctionData({ abi: t.to?.toLowerCase() === USDC ? USDC_ABI : SATURN_SWAP_ABI, data: t.data! }).functionName === fn;
      } catch { return false; }
    }).length;
  }
}

// ── A fake board over the kit's own fetch ────────────────────────────────────

interface BOffer { o: Offer; tokenHash: string; body: Record<string, unknown> }
interface BTrade { t: Trade; takerHash: string; takeBody: Record<string, unknown> }
type Script = (method: string, path: string, body: any) => 'lose' | 'drop' | { status: number; json: unknown } | undefined;

class FakeBoard {
  offers = new Map<number, BOffer>();
  trades = new Map<number, BTrade>();
  hashes = new Map<string, { kind: 'offer' | 'take'; id: number }>();
  calls: Array<{ method: string; path: string; body: any; wait: number }> = [];
  reveals: Array<{ id: number; secret: string }> = [];
  nextOffer = 1;
  nextTrade = 1;
  feeBps = 50;
  /** The board's /config keeper addresses. */
  keeper: { phaAddress: string | null; baseAddress: string | null; claimAddress: string | null } = { phaAddress: null, baseAddress: null, claimAddress: null };
  /** Answer a create with another price than posted (check 9). */
  echoPrice: string | null = null;
  /** Record a take at another price than the offer's (a board that lies). */
  takePrice: string | null = null;
  script: Script | null = null;
  held = 0;
  maxHeld = 0;
  maxTradeHeld = 0;
  tradeHeld = 0;
  #version = 0;
  #waiters: Array<() => void> = [];

  constructor(readonly vt: VTime, readonly pha: FakePha, readonly base: FakeBase) {}

  // ── Added for the examples: the devnet faucet and the reference price ──

  /** Addresses the fake faucet served (one claim per address). */
  faucetServed = new Set<string>();
  /** GET /v1/prices/reference (display only): RA near 2.00, TAZ = RA / 1.8554 (devnet's pool #223). */
  reference: unknown = {
    network: 'devnet', asOf: T0, stale: false,
    anchor: { state: 'via_soul', since: T0, passing: false, reasons: ['depth'], rule: {}, depth: {}, link: {} },
    twap: { poolId: 223, pool: 'v4:223', tazPerRa: 1.8554, spot: 1.8554, windowS: 86_400, source: 'sampler', status: 'ok', since: T0 },
    tokens: {
      RA: { line: 2, basis: 'via_soul', viaSoul: 2 },
      TAZ: { line: 1.0779, basis: 'via_soul', viaSoul: 1.0779 }
    }
  };

  /** What one faucet claim sends (the backend's defaults): 20 TAZ, 2 RA, 3 SOUL, 30 KCAL; 500 mUSDC (ETH is plenty on the fake). */
  credit(pha?: string | null, base?: string | null): void {
    if (pha) {
      const add: Record<string, bigint> = { TAZ: 20n * 10n ** 9n, RA: 2n * 10n ** 9n, SOUL: 3n * 10n ** 8n, KCAL: 30n * 10n ** 10n };
      const have = this.pha.bals.get(pha) ?? [];
      for (const [symbol, amount] of Object.entries(add)) {
        const row = have.find((b) => b.symbol === symbol);
        if (row) row.amount = (BigInt(row.amount) + amount).toString();
        else have.push({ symbol, amount: amount.toString(), decimals: P2P_TOKENS.find((t) => t.symbol === symbol)!.decimals });
      }
      this.pha.bals.set(pha, have);
    }
    if (base) this.base.usdc.set(base.toLowerCase(), (this.base.usdc.get(base.toLowerCase()) ?? 0n) + 500_000_000n);
  }

  #mutate(): void {
    this.#version++;
    const w = this.#waiters;
    this.#waiters = [];
    for (const f of w) f();
  }

  get nowS(): number { return nowSecOf(this.vt.ms); }

  /** The board's view of a trade, moved on from the chains as the real board's keeper does. */
  sync(b: BTrade): void {
    const t = b.t;
    const now = this.nowS;
    const before = t.status;
    if (t.status === 'requested' && t.acceptBy != null && now > t.acceptBy) {
      t.status = 'cancelled';
      this.#giveBack(t);
    }
    if (t.status === 'accepted' && t.lockBy != null && now > t.lockBy) t.status = 'expired';
    if (t.h) {
      const swap = this.base.swapAt(t.h, t.buyer.base);
      const lock = this.pha.locks.get(t.h);
      if (swap.state === 2 && ['pha_locked', 'base_locked', 'revealed'].includes(t.status)) t.status = 'base_claimed';
      if (t.status === 'base_claimed' && lock?.state === 2) t.status = 'done';
      if (lock?.state === 3 && swap.state !== 1 && !['done', 'refunded'].includes(t.status)) t.status = 'refunded';
    }
    if (t.status !== before) {
      t.updatedAt = now;
      if (['done', 'refunded', 'cancelled', 'expired'].includes(t.status)) t.endedAt = now;
      this.#mutate();
    }
  }

  #giveBack(t: Trade): void {
    const o = this.offers.get(t.offerId);
    if (o) o.o.remaining = (BigInt(o.o.remaining) + BigInt(t.taz)).toString();
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = new Headers(init?.headers);
    const auth = headers.get('authorization')?.replace(/^Bearer /, '') ?? null;
    const wait = Number(url.searchParams.get('wait') ?? body?.wait ?? 0);
    this.calls.push({ method, path: url.pathname, body, wait });
    const s = this.script?.(method, url.pathname, body);
    if (s === 'lose') throw new TypeError('fetch failed');
    if (s && typeof s === 'object') return this.#json(s.status, s.json);
    const res = await this.#route(method, url.pathname, url.searchParams, body, auth, wait, init?.signal ?? undefined);
    if (s === 'drop') throw new TypeError('fetch failed');
    return res;
  };

  #json(status: number, json: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json', ...headers } });
  }

  #ok(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return this.#json(status, { data }, headers);
  }

  #err(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
    return this.#json(status, { error: { code, message, retryable: false, ...extra } });
  }

  /** Hold a long-poll until something changes or the wait passes (virtual time). */
  async #hold(wait: number, signal: AbortSignal | undefined, trade: boolean): Promise<boolean> {
    if (!(wait > 0)) return false;
    const v = this.#version;
    this.held++;
    this.maxHeld = Math.max(this.maxHeld, this.held);
    if (trade) {
      this.tradeHeld++;
      this.maxTradeHeld = Math.max(this.maxTradeHeld, this.tradeHeld);
    }
    try {
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        this.#waiters.push(done);
        void this.vt.sleep(wait * 1000, signal).then(done);
      });
    } finally {
      this.held--;
      if (trade) this.tradeHeld--;
    }
    return this.#version !== v;
  }

  #tokenOk(token: string | null, hash: string): boolean {
    return !!token && sha256Hex(token) === hash;
  }

  async #route(method: string, path: string, q: URLSearchParams, body: any, auth: string | null, wait: number, signal?: AbortSignal): Promise<Response> {
    const now = this.nowS;
    let m: RegExpExecArray | null;
    if (method === 'GET' && path === '/v1/p2p/config') {
      return this.#ok({ network: 'devnet', enabled: true, displayOnly: true, note: '', keeper: this.keeper, tokens: [], timing: {}, limits: {} });
    }
    if (method === 'GET' && path === '/v1/p2p/recent') return this.#ok({ trades: [], next: null });
    if (method === 'GET' && path === '/v1/p2p/offers') {
      const sym = q.get('symbol') ?? 'all';
      const side = q.get('side');
      return this.#ok([...this.offers.values()].map((x) => x.o).filter((o) => o.status === 'open' && (sym === 'all' || o.symbol === sym) && (!side || o.side === side)));
    }
    if (method === 'GET' && (m = /^\/v1\/p2p\/trades\/(\d+)$/.exec(path))) {
      const b = this.trades.get(Number(m[1]));
      if (!b) return this.#err(404, 'NOT_FOUND', 'No such trade');
      this.sync(b);
      const waited = await this.#hold(wait, signal, true);
      if (waited) this.sync(b);
      return this.#ok(b.t, 200, { 'X-Server-Time': String(this.nowS), 'X-Waited': waited ? '1' : '0' });
    }
    if (method === 'POST' && path === '/v1/p2p/offers') {
      const hash = String(body.makerTokenHash);
      const had = this.hashes.get(hash);
      if (had) return this.#ok({ offer: this.offers.get(had.id)!.o, replayed: true });
      if (body.replayOnly) return this.#err(404, 'NOT_FOUND', 'No offer was made with this makerTokenHash', { reason: 'no_such_request' });
      const id = this.nextOffer++;
      const o: Offer = {
        id, network: 'devnet', side: body.side, makerPha: body.makerPha, makerBase: body.makerBase, symbol: body.symbol,
        tazTotal: body.tazTotal, tazMin: body.tazMin, tazMax: body.tazMax, price: this.echoPrice ?? body.price ?? body.follow?.limitPrice,
        remaining: body.tazTotal, status: 'open', online: true, createdAt: now, heartbeatAt: now, closedAt: null,
        follow: body.follow ? { offsetBps: body.follow.offsetBps, limitPrice: body.follow.limitPrice, dailyMax: body.follow.dailyMax, state: 'live', filled24h: '0' } : null
      };
      this.offers.set(id, { o, tokenHash: hash, body });
      this.hashes.set(hash, { kind: 'offer', id });
      this.#mutate();
      return this.#ok({ offer: o, replayed: false }, 201);
    }
    if (method === 'POST' && (m = /^\/v1\/p2p\/offers\/(\d+)\/take$/.exec(path))) {
      const off = this.offers.get(Number(m[1]));
      if (!off) return this.#err(404, 'NOT_FOUND', 'No such offer');
      const hash = String(body.takerTokenHash);
      const had = this.hashes.get(hash);
      if (had) {
        const b = this.trades.get(had.id)!;
        this.sync(b);
        return this.#ok({ trade: b.t, replayed: true });
      }
      if (body.replayOnly) return this.#err(404, 'NOT_FOUND', 'No take was made with this takerTokenHash', { reason: 'no_such_request' });
      const o = off.o;
      if (o.status !== 'open') return this.#err(409, 'CLOSED', 'This offer is closed');
      if (body.symbol !== o.symbol) return this.#err(409, 'TOKEN', 'Another token');
      if (body.price !== o.price) return this.#err(409, 'PRICE_CHANGED', 'The price changed');
      const taz = BigInt(body.taz);
      if (taz < BigInt(o.tazMin) || taz > BigInt(o.tazMax) || taz > BigInt(o.remaining)) return this.#err(409, 'AMOUNT', 'Amount');
      const price = this.takePrice ?? o.price;
      const unit = 10n ** BigInt(P2P_TOKENS.find((t) => t.symbol === o.symbol)!.decimals);
      const maker = { pha: o.makerPha, base: o.makerBase };
      const taker = { pha: body.takerPha, base: body.takerBase };
      const id = this.nextTrade++;
      const t: Trade = {
        id, network: 'devnet', offerId: o.id, side: o.side, symbol: o.symbol, taz: body.taz, usdc: ((taz * BigInt(price)) / unit).toString(), price,
        seller: o.side === 'sell' ? maker : taker, buyer: o.side === 'sell' ? taker : maker,
        h: null, phaContract: null, phaLockTx: null, baseLockTx: null, baseClaimTx: null, phaClaimTx: null, baseRefundTx: null, phaRefundTx: null,
        phaDeadline: null, baseDeadline: null, feeBps: null, payoutDeferred: false, status: 'requested',
        acceptBy: now + BOARD.acceptTimeout, lockBy: null, createdAt: now, acceptedAt: null, updatedAt: now, endedAt: null, lastError: null
      };
      o.remaining = (BigInt(o.remaining) - taz).toString();
      this.trades.set(id, { t, takerHash: hash, takeBody: body });
      this.hashes.set(hash, { kind: 'take', id });
      this.#mutate();
      return this.#ok({ trade: t, replayed: false }, 201);
    }
    if (method === 'POST' && (m = /^\/v1\/p2p\/offers\/(\d+)\/(heartbeat|cancel|reprice)$/.exec(path))) {
      const off = this.offers.get(Number(m[1]));
      if (!off) return this.#err(404, 'NOT_FOUND', 'No such offer');
      if (!this.#tokenOk(auth, off.tokenHash)) return this.#err(401, 'UNAUTHORIZED', 'Wrong token');
      if (m[2] === 'cancel') {
        if (off.o.status !== 'open') return this.#err(409, 'CLOSED', 'Closed');
        off.o.status = 'closed';
        off.o.closedAt = now;
        this.#mutate();
        return this.#ok({ ok: true });
      }
      if (m[2] === 'reprice') {
        off.o.price = body.price ?? off.o.price;
        this.#mutate();
        return this.#ok({ offer: off.o });
      }
      if (off.o.status !== 'open') return this.#err(409, 'CLOSED', 'Closed');
      off.o.heartbeatAt = now;
      const waited = await this.#hold(wait, signal, false);
      return this.#ok({ offer: off.o, trades: this.#running(off.o.id), serverTime: this.nowS, waited });
    }
    if (method === 'POST' && path === '/v1/p2p/heartbeats') {
      const items = body.offers as Array<{ id: number; token: string }>;
      const waited = await this.#hold(Number(body.wait ?? 0), signal, false);
      const results = items.map((it) => {
        const off = this.offers.get(it.id);
        if (!off || !this.#tokenOk(it.token, off.tokenHash)) return { id: it.id, ok: false, error: { code: 'UNAUTHORIZED', message: 'Wrong token', retryable: false } };
        if (off.o.status !== 'open') return { id: it.id, ok: false, error: { code: 'CLOSED', message: 'Closed', retryable: false } };
        off.o.heartbeatAt = this.nowS;
        return { id: it.id, ok: true, offer: off.o, trades: this.#running(off.o.id) };
      });
      return this.#ok({ results, serverTime: this.nowS, waited });
    }
    if (method === 'POST' && (m = /^\/v1\/p2p\/trades\/(\d+)\/(accept|decline|pha-locked|base-locked|reveal)$/.exec(path))) {
      const b = this.trades.get(Number(m[1]));
      if (!b) return this.#err(404, 'NOT_FOUND', 'No such trade');
      this.sync(b);
      const t = b.t;
      const off = this.offers.get(t.offerId)!;
      const makerOk = this.#tokenOk(auth, off.tokenHash);
      const takerOk = this.#tokenOk(auth, b.takerHash);
      const sOk = off.o.side === 'sell' ? makerOk : takerOk;
      const bOk = off.o.side === 'sell' ? takerOk : makerOk;
      switch (m[2]) {
        case 'accept':
          if (!makerOk) return this.#err(401, 'UNAUTHORIZED', 'Wrong token');
          if (t.status === 'accepted') return this.#ok(t);
          if (t.status !== 'requested') return this.#err(409, 'STATE', 'Not requested');
          Object.assign(t, { status: 'accepted', feeBps: this.feeBps, acceptedAt: now, updatedAt: now, lockBy: now + BOARD.lockWait });
          this.#mutate();
          return this.#ok(t);
        case 'decline':
          if (!makerOk) return this.#err(401, 'UNAUTHORIZED', 'Wrong token');
          if (t.status !== 'requested') return this.#err(409, 'STATE', 'Not requested');
          Object.assign(t, { status: 'cancelled', updatedAt: now, endedAt: now });
          this.#giveBack(t);
          this.#mutate();
          return this.#ok(t);
        case 'pha-locked': {
          if (!sOk) return this.#err(401, 'UNAUTHORIZED', 'Wrong token');
          if (t.status !== 'accepted') return this.#err(409, 'STATE', 'Not accepted');
          const l = this.pha.locks.get(String(body.h).toLowerCase());
          if (!l || l.state !== 1 || l.sender !== t.seller.pha || l.recipient !== t.buyer.pha || l.symbol !== t.symbol || l.amount !== BigInt(t.taz)) {
            return this.#err(422, 'NO_LOCK', 'No such lock', { retryable: true, retryAfter: 5 });
          }
          Object.assign(t, { status: 'pha_locked', h: String(body.h).toLowerCase(), phaContract: 'saturnescrow', phaLockTx: body.txHash ?? null, phaDeadline: l.deadline, updatedAt: now });
          this.#mutate();
          return this.#ok(t);
        }
        case 'base-locked': {
          if (!bOk) return this.#err(401, 'UNAUTHORIZED', 'Wrong token');
          if (t.status !== 'pha_locked' || !t.h) return this.#err(409, 'STATE', 'Not pha_locked');
          const s = this.base.swapAt(t.h, t.buyer.base);
          if (s.state !== 1) return this.#err(409, 'NOT_CONFIRMED', 'Not on Base yet', { retryable: true, retryAfter: 5 });
          Object.assign(t, { status: 'base_locked', baseLockTx: body.txHash, baseDeadline: Number(s.deadline), updatedAt: now });
          this.#mutate();
          return this.#ok(t);
        }
        case 'reveal': {
          if (!t.h || hashOfSecret(String(body.secret)) !== t.h) return this.#err(403, 'WRONG_SECRET', 'Wrong secret');
          this.reveals.push({ id: t.id, secret: String(body.secret) });
          if (t.status === 'base_locked') Object.assign(t, { status: 'revealed', updatedAt: now });
          this.#mutate();
          return this.#json(200, { ok: true });
        }
      }
    }
    if (method === 'GET' && path === '/v1/p2p/faucet') {
      return this.#ok({ enabled: true, amounts: { TAZ: '20', RA: '2', SOUL: '3', KCAL: '30', mUSDC: '500', ETH: '0.0005' }, perAddressHours: 24, leftToday: 190, low: false, parts: { pha: true, base: true } });
    }
    if (method === 'POST' && path === '/v1/p2p/faucet') {
      const who = [body?.pha, typeof body?.base === 'string' ? body.base.toLowerCase() : undefined].filter((x): x is string => typeof x === 'string' && !!x);
      if (who.some((a) => this.faucetServed.has(a))) return this.#err(429, 'FAUCET_LIMIT', 'This address was served in the last 24 hours', { reason: 'address', retryAfter: 86_000 });
      for (const a of who) this.faucetServed.add(a);
      this.credit(body?.pha, body?.base);
      return this.#ok({
        pha: body?.pha ? { txHash: 'AB'.repeat(32), amounts: { TAZ: '20', RA: '2', SOUL: '3', KCAL: '30' }, state: 'confirmed', error: null, note: null } : null,
        base: body?.base ? { usdcTx: '0x' + 'cd'.repeat(32), ethTx: '0x' + 'ef'.repeat(32), amounts: { mUSDC: '500', ETH: '0.0005' }, state: 'confirmed', error: null, note: null } : null
      }, 202);
    }
    if (method === 'GET' && path === '/v1/prices/reference') return this.#ok(this.reference);
    return this.#err(404, 'NOT_FOUND', `No route ${method} ${path}`);
  }

  #running(offerId: number): Trade[] {
    return [...this.trades.values()].filter((b) => b.t.offerId === offerId).map((b) => { this.sync(b); return b.t; })
      .filter((t) => !['done', 'refunded', 'cancelled', 'expired'].includes(t.status));
  }

  /** The keeper claims the seller's USDC with the revealed secret. */
  keeperClaimUsdc(id: number): void {
    const b = this.trades.get(id)!;
    const r = this.reveals.find((x) => x.id === id);
    assert.ok(r, 'the keeper holds the secret only after /reveal');
    this.base.claimDirect(b.t.h!, b.t.buyer.base, r.secret);
  }

  /** The keeper claims the buyer's tokens with the secret public on Base. */
  keeperClaimToken(id: number): void {
    const b = this.trades.get(id)!;
    const l = this.pha.locks.get(b.t.h!)!;
    const pre = this.base.preimages.get(`${b.t.h}|${b.t.buyer.base.toLowerCase()}`);
    assert.ok(pre && l.state === 1);
    l.state = 2;
    l.secret = pre.value;
  }

  /** The keeper refunds the seller's tokens after T1. */
  keeperRefundToken(id: number): void {
    const l = this.pha.locks.get(this.trades.get(id)!.t.h!)!;
    assert.ok(l.state === 1 && this.nowS >= l.deadline);
    l.state = 3;
  }

  /** Board calls of one kind so far. */
  count(method: string, re: RegExp): number {
    return this.calls.filter((c) => c.method === method && re.test(c.path)).length;
  }
}

// ── Worlds, helpers and a fake kit ───────────────────────────────────────────

const KIT_ROOT = new URL('../', import.meta.url);
const readKitFile = (rel: string) => readFile(new URL(rel, KIT_ROOT), 'utf8');
const DAY = 86_400_000;

const dirs: string[] = [];
const openKits: Kit[] = [];
after(async () => {
  for (const k of openKits) await k.close().catch(() => {});
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'kit-examples-'));
  dirs.push(d);
  return d;
}

interface World { vt: VTime; pha: FakePha; base: FakeBase; board: FakeBoard }

function world(): World {
  const vt = new VTime();
  const pha = new FakePha(vt.now);
  const base = new FakeBase(vt.now);
  const board = new FakeBoard(vt, pha, base);
  return { vt, pha, base, board };
}

/** What puts a kit on the fakes: the fake board and chains, virtual time, quick signer waits. */
function internalsOf(w: World): KitInternals {
  return {
    fetch: w.board.fetch as typeof fetch, pha: w.pha, base: w.base, now: w.vt.now, sleep: w.vt.sleep,
    signerSleep: async () => {}, signerWait: { phaTries: 1, phaIntervalMs: 0, baseTimeoutMs: 1, basePollMs: 1, allowanceTries: 2, allowancePollMs: 0 },
    argv: ['node', 'bot.ts'], storeKeyFile: null, pollWaitS: 5
  };
}

function sink(): { lines: string[]; out: (l: string) => void } {
  const lines: string[] = [];
  return { lines, out: (l: string) => { lines.push(l); } };
}

/** Move virtual time until `cond`, at most `max` steps. */
async function until(vt: VTime, cond: () => boolean | Promise<boolean>, what: string, o: { stepMs?: number; max?: number } = {}): Promise<void> {
  for (let i = 0; i < (o.max ?? 1_000); i++) {
    if (await cond()) return;
    await vt.advance(o.stepMs ?? 2_000);
  }
  assert.fail(`${what} did not happen`);
}

/** Await `p` while virtual time moves on. */
async function drive<T>(vt: VTime, p: Promise<T>, o: { stepMs?: number; max?: number } = {}): Promise<T> {
  let done = false;
  const q = p.finally(() => { done = true; });
  for (let i = 0; i < (o.max ?? 2_000) && !done; i++) await vt.advance(o.stepMs ?? 1_000);
  assert.ok(done, 'it did not finish');
  return q;
}

/** The values a set of key files holds (lower case, without 0x): what no output line may carry. */
async function keyMaterial(files: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) for (const v of Object.values(JSON.parse(await readFile(f, 'utf8')) as Record<string, string>)) out.push(v.toLowerCase().replace(/^0x/, ''));
  return out;
}

function assertNoSecrets(lines: readonly string[], material: readonly string[]): void {
  assert.ok(material.length > 0);
  for (const line of lines) {
    const l = line.toLowerCase();
    for (const m of material) assert.ok(!l.includes(m), 'an output line carries a key');
    assert.ok(!/[0-9a-f]{64}/.test(l), `an output line carries 64 hex digits: ${line.slice(0, 100)}`);
  }
}

const newPha = () => PhantasmaKeys.generate().Address.Text;
const newBase = () => privateKeyToAccount(generatePrivateKey()).address;

/** The part of a Kit the runner uses, recording every call; run() lasts until its signal aborts. */
class FakeKit {
  readonly network = 'devnet' as const;
  readonly address = { pha: newPha(), base: newBase() };
  offers: LocalOffer[] = [];
  trades: LocalTrade[] = [];
  calls: Array<{ fn: string; arg?: unknown; at: number }> = [];
  running = false;
  policy: Policy | undefined;
  /** Raw units of every token on Phantasma, and raw USDC on Base. */
  tokens = 10n ** 13n;
  usdc = 10n ** 10n;
  /** Raw units of one token, where it holds another amount than `tokens`. */
  held = new Map<string, bigint>();
  /** What the board says is left of an offer (raw units; its total when not set), the trades it shows on it, and the offers it has paused. */
  left = new Map<number, bigint>();
  takes = new Map<number, Array<{ id: number; status: string }>>();
  paused = new Set<number>();
  /** The board's public list (board.offers). */
  book: Offer[] = [];
  /** The calls that fail while named here: 'balances', 'readFunds', 'heartbeat', 'cancelOffer', 'postOffer'. */
  failing = new Set<string>();
  /** How often the balances and the board's word on an offer were read. */
  reads = { balances: 0, readFunds: 0, heartbeat: 0 };
  #next = 1;

  constructor(readonly clock: () => number) {}

  #call(fn: string, arg?: unknown): void {
    this.calls.push({ fn, arg, at: this.clock() });
  }

  count(fn: string): number {
    return this.calls.filter((c) => c.fn === fn).length;
  }

  readonly board = {
    offers: async (): Promise<Offer[]> => this.book,
    recent: async () => ({ trades: [], next: null }),
    reference: async () => { throw new Error('no reference on the fake kit'); },
    heartbeat: async (id: number, _token: string) => {
      this.reads.heartbeat++;
      if (this.failing.has('heartbeat')) throw new Error('the fake board is away');
      const o = this.offers.find((x) => x.id === id);
      if (!o || o.closedAt != null) throw new BoardError('CLOSED', 409, false);
      const offer = {
        id, status: 'open', remaining: (this.left.get(id) ?? BigInt(o.tazTotal)).toString(),
        follow: o.follow ? { ...o.follow, state: this.paused.has(id) ? 'paused' : 'live', filled24h: '0' } : null
      } as unknown as Offer;
      return { offer, trades: (this.takes.get(id) ?? []) as unknown as Trade[], waited: false };
    }
  };

  readonly store = {
    listOffers: async () => this.offers.map((o) => ({ ...o })),
    listTrades: async () => this.trades.map((t) => ({ ...t }))
  };

  readonly pha = {
    balances: async () => {
      this.reads.balances++;
      if (this.failing.has('balances')) throw new Error('the fake node is away');
      return new Map(P2P_TOKENS.map((t) => [t.symbol, { raw: this.held.get(t.symbol) ?? this.tokens, decimals: t.decimals }]));
    }
  };

  readonly base = {
    readFunds: async () => {
      this.reads.readFunds++;
      if (this.failing.has('readFunds')) throw new Error('the fake node is away');
      return { usdc: this.usdc, allowance: 0n, eth: 10n ** 18n };
    }
  };

  /** The preflight's items; the report is ok when every item is. */
  preflightItems: Array<{ name: string; ok: boolean; text: string; code?: string }> = [{ name: 'pins', ok: true, text: 'pinned' }];

  async preflight() {
    return { network: this.network, ok: this.preflightItems.every((i) => i.ok), address: this.address, items: this.preflightItems, balances: { pha: null, base: null }, clockSkewS: 0 };
  }

  async postOffer(o: OfferInput): Promise<LocalOffer> {
    this.#call('postOffer', o);
    if (this.failing.has('postOffer')) throw new Error('the fake board refused the offer');
    const raw = (v: string) => tokenToRaw(o.symbol, v).toString();
    const rec: LocalOffer = {
      id: this.#next++, network: 'devnet', side: o.side, symbol: o.symbol, makerPha: this.address.pha, makerBase: this.address.base.toLowerCase(),
      tazTotal: raw(o.total), tazMin: raw(o.min), tazMax: raw(o.max), price: usdcToRaw(o.price ?? o.follow!.limitPrice).toString(),
      makerToken: 'ab'.repeat(32), tokenSource: 'client', priceHistory: [],
      follow: o.follow ? { offsetBps: o.follow.offsetBps, limitPrice: usdcToRaw(o.follow.limitPrice).toString(), dailyMax: raw(o.follow.dailyMax ?? o.total) } : null,
      acceptOnTheirOwn: o.acceptOnTheirOwn !== false, mode: o.mode ?? 'standard', createdAt: this.clock(), closedAt: null
    };
    this.offers.push(rec);
    return rec;
  }

  async cancelOffer(id: number): Promise<void> {
    this.#call('cancelOffer', id);
    if (this.failing.has('cancelOffer')) throw new Error('the fake board refused the cancel');
    const o = this.offers.find((x) => x.id === id);
    assert.ok(o, `cancel of an offer the kit does not keep (#${id})`);
    o.closedAt = this.clock();
  }

  async buyUpTo(o: unknown): Promise<LocalTrade[]> {
    this.#call('buyUpTo', o);
    return [];
  }

  async sellDownTo(o: unknown): Promise<LocalTrade[]> {
    this.#call('sellDownTo', o);
    return [];
  }

  async run(policy?: Policy, signal?: AbortSignal): Promise<void> {
    this.#call('run');
    this.policy = policy;
    this.running = true;
    await new Promise<void>((r) => {
      if (!signal || signal.aborted) r();
      else signal.addEventListener('abort', () => r(), { once: true });
    });
    this.running = false;
  }

  async close(): Promise<void> {
    this.#call('close');
    assert.equal(this.running, false, 'close() only once run() has ended');
  }
}

/** A trade record that is still running, as far as the runner looks (it reads only id, status and endedAt). */
const runningTrade = (id: number) => ({ id, status: 'pha_locked' }) as unknown as LocalTrade;

/** The runner on a fake kit, with a fake process for its signals. */
async function onFakeKit(role: Role, kit: FakeKit, vt: VTime, argv: string[] = []) {
  const out = sink();
  const signals = new EventEmitter();
  const cwd = await tempDir();
  let code: number | null = null;
  let opts: KitOptions | null = null;
  const p = runBot({
    role, argv, cwd, env: {}, out: out.out, signals, now: vt.now, sleep: vt.sleep,
    makeKit: async (o) => { opts = o; return kit as unknown as BotKit; }
  }).then((c) => { code = c; return c; });
  return { p, out, signals, cwd, code: () => code, opts: () => opts };
}

// ── 1. The example configs ──────────────────────────────────────────────────

describe('the example configs', () => {
  test('both parse into KitOptions and a Policy: the seller\'s offers and take key, the buyer\'s bids and take key', async () => {
    const seller = parseBotConfig(JSON.parse(await readFile(defaultConfigPath('seller'), 'utf8')));
    assert.equal(seller.network, 'devnet');
    assert.deepEqual(seller.offers, [
      { side: 'sell', symbol: 'TAZ', total: '30', min: '1', max: '5', price: '1.08' },
      { side: 'sell', symbol: 'RA', total: '6', min: '1', max: '2', follow: { offsetBps: 200, limitPrice: '1.90' } }
    ]);
    assert.deepEqual(seller.take, [{ side: 'sell', symbol: 'TAZ', amount: '2', limit: '1.05', everyS: 120 }]);
    assert.equal(seller.acceptOnTheirOwn, true);
    assert.equal(seller.claimMode, 'self');
    const ko = kitOptions(seller, { cwd: '/srv/kit' });
    assert.equal(ko.network, 'devnet');
    assert.equal(ko.api, 'https://apiops.saturnx.cc');
    assert.equal(ko.phaKeyFile, '/srv/kit/keys/seller-pha.json');
    assert.equal(ko.baseKeyFile, '/srv/kit/keys/seller-base.json');
    assert.equal(ko.dataDir, '/srv/kit/data/seller');
    assert.equal(ko.claimMode, 'self');
    assert.equal(ko.usePermit, true);
    assert.equal(ko.apiKeyFile, undefined);
    assert.equal(ko.allowMainnet, undefined);
    const sp = resolvePolicy(botPolicy(seller), 'devnet');
    assert.equal(sp.acceptAfterS, 0);
    assert.equal(sp.claimWatchS, P2P_CONFIG.devnet.timing.claimWatch);

    const buyer = parseBotConfig(JSON.parse(await readFile(defaultConfigPath('buyer'), 'utf8')));
    assert.deepEqual(buyer.offers, [
      { side: 'buy', symbol: 'TAZ', total: '20', min: '1', max: '5', price: '1.06' },
      { side: 'buy', symbol: 'RA', total: '4', min: '1', max: '2', price: '1.89' }
    ]);
    assert.deepEqual(buyer.take, [{ side: 'buy', symbol: 'TAZ', amount: '2', limit: '1.10', everyS: 120 }]);
    assert.equal(buyer.claimWatchS, null, 'the buyer waits the network\'s claim watch for the keeper');
    const bp = resolvePolicy(botPolicy(buyer), 'devnet');
    assert.equal(bp.acceptAfterS, 0);
    assert.equal(bp.claimWatchS, 60);
    assert.equal(kitOptions(buyer, { cwd: '/srv/kit' }).dataDir, '/srv/kit/data/buyer');

    // The policy's accept is the kit's own rule (accept when the checks pass), and says no while the bot stops.
    let stopping = false;
    const policy = botPolicy(seller, () => stopping);
    const ctx = (ok: boolean) => ({ offer: {} as LocalOffer, checks: ok ? { ok: true as const } : { ok: false as const, problem: { check: 17, code: 'ACCEPT_REFUSED', text: 'no', retry: true } } });
    assert.equal(await policy.accept!({} as Trade, ctx(true)), true);
    assert.equal(await policy.accept!({} as Trade, ctx(false)), false);
    stopping = true;
    assert.equal(await policy.accept!({} as Trade, ctx(true)), false);
  });

  test('a config is checked strictly before anything is read or sent', () => {
    const base = { network: 'devnet', keys: { pha: 'a.json', base: 'b.json' }, dataDir: 'd' };
    const bad = (extra: Record<string, unknown>, re: RegExp) => assert.throws(() => parseBotConfig({ ...base, ...extra }), (e: Error & { code?: string }) => e.code === 'BAD_CONFIG' && re.test(e.message), JSON.stringify(extra));
    bad({ acceptAfterSecs: 0 }, /unknown key "acceptAfterSecs"/);
    bad({ network: 'testnet' }, /network is "devnet" or "mainnet"/);
    bad({ offers: [{ symbol: 'TAZ', total: 30, min: '1', max: '5', price: '1.08' }] }, /offers\[0\]\.total is required, as text/);
    bad({ offers: [{ symbol: 'taz', total: '30', min: '1', max: '5', price: '1.08' }] }, /offers\[0\]\.symbol is C, RA, TAZ, SOUL or KCAL/);
    bad({ offers: [{ symbol: 'TAZ', total: '30', min: '1', max: '5', price: '1.08', follow: { offsetBps: 200, limitPrice: '1' } }] }, /exactly one/);
    bad({ offers: [{ symbol: 'TAZ', total: '30', min: '1', max: '5', price: '1.0800001' }] }, /more than 6 decimal places/);
    bad({ bids: [{ symbol: 'TAZ', total: '3', min: '5', max: '6', price: '1.06' }] }, /bids\[0\]:/);
    bad({ offers: [{ symbol: 'RA', total: '6', min: '1', max: '2', follow: { offsetBps: 2500, limitPrice: '1.90' } }] }, /offsetBps/);
    bad({ take: { symbol: 'TAZ', amount: '2', minPrice: '1', maxPrice: '2', everyS: 60 } }, /exactly one/);
    bad({ take: { symbol: 'TAZ', amount: '2', minPrice: '1', everyS: 5 } }, /everyS is a whole number of seconds from 10/);
    bad({ acceptAfterS: -1 }, /acceptAfterS is a number of seconds/);
    bad({ claimMode: 'reveal' }, /claimMode/);
    assert.throws(() => parseBotConfig([]), /a JSON object/);
    // A list of orders is accepted as well as one.
    const two = parseBotConfig({ ...base, take: [{ symbol: 'TAZ', amount: '2', minPrice: '1.05', everyS: 60 }, { symbol: 'RA', amount: '1', maxPrice: '2.10', everyS: 60, maxLegs: 2 }] });
    assert.deepEqual(two.take.map((t) => [t.side, t.symbol, t.maxLegs]), [['sell', 'TAZ', undefined], ['buy', 'RA', 2]]);
  });

  test('an instant offer (C6 hand-off 1): a sell offer of a config with an API key, on devnet; kept instant offers match only instant entries', () => {
    const base = { network: 'devnet', keys: { pha: 'a.json', base: 'b.json' }, dataDir: 'd' };
    const ask = { symbol: 'TAZ', total: '30', min: '1', max: '5', price: '1.08' };
    const cfg = parseBotConfig({ ...base, apiKeyFile: 'keys/api-key.json', offers: [{ ...ask, mode: 'instant' }, { ...ask, price: '1.09', mode: 'standard' }, { ...ask, price: '1.10' }] });
    assert.deepEqual(cfg.offers, [
      { side: 'sell', ...ask, mode: 'instant' },
      { side: 'sell', ...ask, price: '1.09' },
      { side: 'sell', ...ask, price: '1.10' }
    ], '"standard" and no mode are the same standard offer');
    assert.equal(kitOptions(cfg, { cwd: '/srv/kit' }).apiKeyFile, '/srv/kit/keys/api-key.json');
    // A following offer can be instant too.
    const follow = parseBotConfig({ ...base, apiKeyFile: 'k', offers: [{ symbol: 'RA', total: '6', min: '1', max: '2', follow: { offsetBps: 200, limitPrice: '1.90' }, mode: 'instant' }] });
    assert.equal(follow.offers[0]!.mode, 'instant');
    const bad = (extra: Record<string, unknown>, re: RegExp) => assert.throws(() => parseBotConfig({ ...base, ...extra }), (e: Error & { code?: string }) => e.code === 'BAD_CONFIG' && re.test(e.message), JSON.stringify(extra));
    bad({ apiKeyFile: 'k', bids: [{ ...ask, price: '1.06', mode: 'instant' }] }, /bids\[0\]\.mode "instant" is for offers to sell only/);
    bad({ offers: [{ ...ask, mode: 'instant' }] }, /offers\[0\]\.mode "instant" needs an API key the owner flagged for instant offers/);
    bad({ apiKeyFile: null, offers: [ask, { ...ask, mode: 'instant' }] }, /offers\[1\]\.mode "instant" needs an API key/);
    bad({ apiKeyFile: 'k', offers: [{ ...ask, mode: 'fast' }] }, /offers\[0\]\.mode is "standard" or "instant"/);
    bad({ apiKeyFile: 'k', offers: [{ ...ask, mode: 'Instant' }] }, /mode is "standard" or "instant"/);
    // Never on mainnet in this release (the kit's INSTANT_NETWORKS), whatever else the config says.
    bad({ network: 'mainnet', apiKeyFile: 'k', offers: [{ ...ask, mode: 'instant' }] }, /offers\[0\]\.mode "instant": this kit release offers instant trades on devnet only, not on mainnet/);

    // sameOffer: a kept instant offer is its instant entry and nothing else; a kept standard offer is never an instant entry.
    const kept = (mode: 'standard' | 'instant'): LocalOffer => ({
      id: 7, network: 'devnet', side: 'sell', symbol: 'TAZ', makerPha: newPha(), makerBase: newBase().toLowerCase(),
      tazTotal: tokenToRaw('TAZ', '30').toString(), tazMin: tokenToRaw('TAZ', '1').toString(), tazMax: tokenToRaw('TAZ', '5').toString(),
      price: usdcToRaw('1.08').toString(), makerToken: 'ab'.repeat(32), tokenSource: 'client', priceHistory: [], follow: null,
      acceptOnTheirOwn: true, mode, createdAt: 0, closedAt: null
    });
    const instantEntry = cfg.offers[0]!;
    const { mode: _mode, ...standardEntry } = instantEntry;
    assert.equal(sameOffer(kept('instant'), instantEntry, true), true);
    assert.equal(sameOffer(kept('instant'), standardEntry, true), false);
    assert.equal(sameOffer(kept('standard'), instantEntry, true), false);
    assert.equal(sameOffer(kept('standard'), standardEntry, true), true);
    assert.equal(sameOffer(kept('instant'), instantEntry, false), false, 'the accept setting still counts');
    // describeOffer says who locks first.
    assert.equal(describeOffer(instantEntry, 'mUSDC'), 'sell 30 TAZ (1 to 5 per trade) at 1.08 mUSDC (instant: the buyer locks first)');
    assert.equal(describeOffer(standardEntry, 'mUSDC'), 'sell 30 TAZ (1 to 5 per trade) at 1.08 mUSDC');
    assert.match(describeOffer(follow.offers[0]!), /following the reference price \+2%, never below 1\.90 USDC \(instant: the buyer locks first\)$/);
  });

  test('the example prices keep devnet\'s ratio TAZ = RA / 1.8554, and each bot\'s order reaches the other bot\'s offer', async () => {
    const R = 1.8554; // devnet's reference pool #223: 408.90 TAZ for 220.38 RA
    assert.ok(Math.abs(408.9 / 220.38 - R) < 0.0001);
    const RA_MID = 2.0;
    const TAZ_MID = RA_MID / R;
    const seller = parseBotConfig(JSON.parse(await readFile(defaultConfigPath('seller'), 'utf8')));
    const buyer = parseBotConfig(JSON.parse(await readFile(defaultConfigPath('buyer'), 'utf8')));
    const prices = (sym: string) => [
      ...[...seller.offers, ...buyer.offers].filter((o) => o.symbol === sym && o.price).map((o) => Number(o.price)),
      ...[...seller.take, ...buyer.take].filter((t) => t.symbol === sym).map((t) => Number(t.limit))
    ];
    assert.ok(prices('TAZ').length >= 4);
    for (const p of prices('TAZ')) assert.ok(Math.abs(p / TAZ_MID - 1) <= 0.03, `TAZ at ${p} is within 3% of RA ${RA_MID} / ${R} = ${TAZ_MID.toFixed(4)}`);
    for (const p of prices('RA')) assert.ok(Math.abs(p / RA_MID - 1) <= 0.06, `RA at ${p} is within 6% of ${RA_MID}`);
    // The buyer's two bids keep the ratio between themselves, well inside the reference's 15% TAZ cross-check.
    const bid = (sym: string) => Number(buyer.offers.find((o) => o.symbol === sym)!.price);
    assert.ok(Math.abs(bid('RA') / bid('TAZ') / R - 1) <= 0.05, 'the buyer\'s RA bid over its TAZ bid is within 5% of 1.8554');
    // The seller's following RA offer: never below a limit under the RA level.
    const follow = seller.offers.find((o) => o.symbol === 'RA')!.follow!;
    assert.ok(follow.offsetBps > 0 && Number(follow.limitPrice) < RA_MID && Number(follow.limitPrice) >= RA_MID * 0.9);
    // The two books never cross, whatever the reference price does: every bid sits under the lowest price an ask
    // of its token can reach (a fixed price, or a following offer's limit, where it rests while the reference is
    // low, as on devnet today with RA via SOUL at about $0.0136).
    for (const sym of ['TAZ', 'RA']) {
      const asks = [...seller.offers, ...buyer.offers].filter((o) => o.side === 'sell' && o.symbol === sym).map((o) => Number(o.price ?? o.follow!.limitPrice));
      const bids = [...seller.offers, ...buyer.offers].filter((o) => o.side === 'buy' && o.symbol === sym).map((o) => Number(o.price ?? o.follow!.limitPrice));
      assert.ok(asks.length > 0 && bids.length > 0, sym);
      assert.ok(Math.max(...bids) < Math.min(...asks), `the ${sym} bids (${bids.join(', ')}) stay under the lowest ${sym} ask (${Math.min(...asks)})`);
    }
    // Each recurring order reaches the other bot's TAZ offer.
    const ask = Number(seller.offers.find((o) => o.symbol === 'TAZ')!.price);
    assert.ok(Number(buyer.take[0]!.limit) >= ask, 'the buyer buys from the seller\'s ask');
    assert.ok(Number(seller.take[0]!.limit) <= bid('TAZ'), 'the seller sells into the buyer\'s bid');
  });
});

// ── 2. Mainnet ──────────────────────────────────────────────────────────────

describe('mainnet is refused', () => {
  test('without --mainnet, without KIT_ALLOW_MAINNET=1, and with both while the release has no mainnet pins; the kit is never built', async () => {
    const d = await tempDir();
    const cfgFile = join(d, 'mainnet.json');
    await writeFile(cfgFile, JSON.stringify({ network: 'mainnet', keys: { pha: './k/p.json', base: './k/b.json' }, dataDir: './data' }));
    const pinned = phaPinned(P2P_CONFIG.mainnet) && baseDeployed(P2P_CONFIG.mainnet);
    const cases: Array<{ argv: string[]; env: Record<string, string>; re: RegExp }> = [
      { argv: [], env: { KIT_ALLOW_MAINNET: '1' }, re: /only with --mainnet and KIT_ALLOW_MAINNET=1/ },
      { argv: ['--mainnet'], env: {}, re: /--mainnet also needs KIT_ALLOW_MAINNET=1/ },
      // This release has no mainnet pins: refused even with both. A release with them passes this gate (below).
      ...(pinned ? [] : [{ argv: ['--mainnet'], env: { KIT_ALLOW_MAINNET: '1' }, re: /no escrow pins for mainnet/ }])
    ];
    for (const c of cases) {
      const out = sink();
      let built = 0;
      const code = await runBot({ role: 'seller', argv: ['--config', cfgFile, ...c.argv], cwd: d, env: c.env, out: out.out, signals: new EventEmitter(), makeKit: async () => { built++; throw new Error('never'); } });
      assert.equal(code, 1, out.lines.join('\n'));
      assert.equal(built, 0, 'the kit is never built');
      assert.match(out.lines.join('\n'), c.re);
    }
    if (pinned) assert.equal(networkGate({ network: 'mainnet' }, { mainnet: true, env: { KIT_ALLOW_MAINNET: '1' } }), null, 'mainnet pins and both gates: the kit may be built');
    // --mainnet with a devnet config is refused too.
    assert.match(networkGate({ network: 'devnet' }, { mainnet: true, env: { KIT_ALLOW_MAINNET: '1' } }) ?? '', /this config is for devnet/);
    assert.equal(networkGate({ network: 'devnet' }, { mainnet: false, env: {} }), null);
  });

  test('the faucet refuses any network but devnet before it sends anything', async () => {
    const w = world();
    const out = sink();
    assert.equal(await faucetMain({ argv: ['--network', 'mainnet', '--pha', newPha()], fetch: w.board.fetch as typeof fetch, out: out.out }), 2);
    assert.match(out.lines.join('\n'), /devnet only/);
    assert.equal(w.board.calls.length, 0);
  });
});

describe('the market bot (market-bot.ts): your own config, ./market.mainnet.json unless --config names another', () => {
  const never = () => async (): Promise<BotKit> => { throw new Error('never'); };

  test('its template, which sh start.sh mainnet copies, is for mainnet and lists nothing: no offer, bid or order until you add yours', async () => {
    const cfg = parseBotConfig(JSON.parse(await readKitFile('examples/market.mainnet.example.json')));
    assert.equal(cfg.network, 'mainnet');
    assert.deepEqual(cfg.offers, [], 'no offer or bid: the bot lists nothing at the start');
    assert.deepEqual(cfg.take, [], 'no recurring order: the bot takes nothing at the start');
    assert.equal(cfg.dataDir, './data/market');
    assert.equal(cfg.acceptOnTheirOwn, true);
    assert.equal(cfg.acceptAfterS, null, 'the kit\'s accept delay (15 s), so a take can still be declined');
    assert.equal(cfg.claimWatchS, null, 'the network\'s claim watch');
    assert.equal(cfg.claimMode, 'self');
    // Its key files are the pair new-keys.ts makes with --dir keys/mainnet --name market (start.sh's command).
    assert.deepEqual(cfg.keys, { pha: './keys/mainnet/market-pha.json', base: './keys/mainnet/market-base.json' });
    const d = await tempDir();
    const [pair] = await makeKeyPairs(join(d, 'keys', 'mainnet'), ['market']);
    assert.equal(pair!.phaFile, join(d, cfg.keys.pha));
    assert.equal(pair!.baseFile, join(d, cfg.keys.base));
  });

  test('without --config it reads market.mainnet.json in its folder; a missing one says how to make it, and the kit is never built', async () => {
    const d = await tempDir();
    const out = sink();
    const code = await runBot({ role: 'market', argv: ['--mainnet'], cwd: d, env: { KIT_ALLOW_MAINNET: '1' }, out: out.out, signals: new EventEmitter(), makeKit: never() });
    assert.equal(code, 1);
    const text = out.lines.join('\n');
    assert.ok(text.includes(`The config ${join(d, MARKET_CONFIG)} cannot be used`), text);
    assert.match(text, /\[market\] The config/, 'its lines say [market]');
    assert.match(text, /Make it with: sh start\.sh mainnet setup \(or copy examples\/market\.mainnet\.example\.json to market\.mainnet\.json\)/);
  });

  test('its mainnet config needs --mainnet and KIT_ALLOW_MAINNET=1 like any other; with both, the kit is built with the config\'s paths from its folder', async () => {
    const d = await tempDir();
    await writeFile(join(d, MARKET_CONFIG), await readKitFile('examples/market.mainnet.example.json'));
    for (const c of [
      { argv: [], env: { KIT_ALLOW_MAINNET: '1' }, re: /only with --mainnet and KIT_ALLOW_MAINNET=1/ },
      { argv: ['--mainnet'], env: {}, re: /--mainnet also needs KIT_ALLOW_MAINNET=1/ }
    ]) {
      const out = sink();
      let built = 0;
      const code = await runBot({ role: 'market', argv: c.argv, cwd: d, env: c.env, out: out.out, signals: new EventEmitter(), makeKit: async () => { built++; throw new Error('never'); } });
      assert.equal(code, 1, out.lines.join('\n'));
      assert.equal(built, 0, 'refused before the kit is built');
      assert.match(out.lines.join('\n'), c.re);
    }
    const out = sink();
    const built: KitOptions[] = [];
    const code = await runBot({
      role: 'market', argv: ['--mainnet'], cwd: d, env: { KIT_ALLOW_MAINNET: '1' }, out: out.out, signals: new EventEmitter(),
      makeKit: async (o) => { built.push(o); throw new SafetyError(SAFETY.KEY_FILE, `The key file ${o.phaKeyFile} cannot be opened (ENOENT).`); }
    });
    assert.equal(code, 1);
    assert.equal(built.length, 1, 'both switches: the kit is built');
    assert.equal(built[0]!.network, 'mainnet');
    assert.equal(built[0]!.allowMainnet, true);
    assert.equal(built[0]!.phaKeyFile, join(d, 'keys/mainnet/market-pha.json'));
    assert.equal(built[0]!.baseKeyFile, join(d, 'keys/mainnet/market-base.json'));
    assert.equal(built[0]!.dataDir, join(d, 'data/market'));
    const text = out.lines.join('\n');
    assert.match(text, /\[market\] Starting on mainnet with /);
    // Missing key files: the command that makes the pair its template names.
    assert.match(text, /Make the key files with: npx tsx examples\/new-keys\.ts --dir keys\/mainnet --name market/);
  });

  test('its help names its own config and the command that makes its keys; the example bots keep theirs', async () => {
    const help = async (role: Role) => {
      const out = sink();
      assert.equal(await runBot({ role, argv: ['--help'], cwd: await tempDir(), env: {}, out: out.out, signals: new EventEmitter(), makeKit: never() }), 0);
      return out.lines.join('\n');
    };
    const market = await help('market');
    assert.match(market, /^Usage: npm run market /);
    assert.match(market, /default \.\/market\.mainnet\.json/);
    assert.match(market, /new-keys\.ts --dir keys\/mainnet --name market/);
    const seller = await help('seller');
    assert.match(seller, /default examples\/seller\.devnet\.example\.json/);
    assert.doesNotMatch(seller, /market/);
  });
});

// ── 3. The runner, on a fake kit ─────────────────────────────────────────────

describe('the runner (seller-bot.ts) on a fake kit', () => {
  test('the seller lists its offers first, then run(); its take key calls sellDownTo every everyS; the buyer\'s calls buyUpTo', async () => {
    const vt = new VTime();
    const kit = new FakeKit(vt.now);
    const r = await onFakeKit('seller', kit, vt);
    await until(vt, () => kit.count('sellDownTo') >= 1, 'the first order', { stepMs: 1_000 });
    assert.deepEqual(kit.calls.slice(0, 4).map((c) => c.fn), ['postOffer', 'postOffer', 'run', 'sellDownTo']);
    assert.deepEqual(kit.calls.filter((c) => c.fn === 'postOffer').map((c) => c.arg), [
      { side: 'sell', symbol: 'TAZ', total: '30', min: '1', max: '5', price: '1.08', acceptOnTheirOwn: true },
      { side: 'sell', symbol: 'RA', total: '6', min: '1', max: '2', follow: { offsetBps: 200, limitPrice: '1.90' }, acceptOnTheirOwn: true }
    ]);
    assert.deepEqual(kit.calls.find((c) => c.fn === 'sellDownTo')!.arg, { symbol: 'TAZ', amount: '2', minPrice: '1.05' });
    assert.equal(kit.count('buyUpTo'), 0);
    const first = kit.calls.find((c) => c.fn === 'sellDownTo')!.at;
    await until(vt, () => kit.count('sellDownTo') >= 3, 'two more orders', { stepMs: 5_000 });
    const ats = kit.calls.filter((c) => c.fn === 'sellDownTo').map((c) => c.at - first);
    assert.ok(ats[1]! >= 120_000 && ats[1]! < 126_000 && ats[2]! >= 240_000, `every 120 s (${ats.join(', ')})`);
    assert.equal(resolvePolicy(kit.policy, 'devnet').acceptAfterS, 0);
    const o = r.opts()!;
    assert.equal(o.phaKeyFile, join(r.cwd, 'keys', 'seller-pha.json'));
    assert.equal(o.dataDir, join(r.cwd, 'data', 'seller'));
    // No running trade: one Ctrl-C cancels the offers and exits.
    r.signals.emit('SIGINT');
    assert.equal(await drive(vt, r.p), 0);
    assert.equal(kit.count('cancelOffer'), 2);
    assert.ok(kit.offers.every((x) => x.closedAt != null));
    assert.equal(kit.calls.at(-1)!.fn, 'close');

    const kit2 = new FakeKit(vt.now);
    const b = await onFakeKit('buyer', kit2, vt);
    await until(vt, () => kit2.count('buyUpTo') >= 1, 'the buyer\'s first order', { stepMs: 1_000 });
    assert.deepEqual(kit2.calls.filter((c) => c.fn === 'postOffer').map((c) => (c.arg as OfferInput).side), ['buy', 'buy']);
    assert.deepEqual(kit2.calls.find((c) => c.fn === 'buyUpTo')!.arg, { symbol: 'TAZ', amount: '2', maxPrice: '1.10' });
    assert.equal(kit2.count('sellDownTo'), 0);
    assert.equal(resolvePolicy(kit2.policy, 'devnet').claimWatchS, 60);
    b.signals.emit('SIGINT');
    assert.equal(await drive(vt, b.p), 0);
  });

  test('a token the escrow does not take on this network (TOKEN_OFF) stops the start only when the config trades it', async () => {
    const off = (sym: string) => ({ name: `escrow ${sym}`, ok: true, code: 'TOKEN_OFF', text: `The escrow takes no locks of ${sym} on this network, so the kit cannot trade it here. Other tokens are not affected.` });
    const vt = new VTime();
    // The seller's config trades TAZ and RA, not C: an off C is printed and the bot starts.
    const kit = new FakeKit(vt.now);
    kit.preflightItems = [{ name: 'pins', ok: true, text: 'pinned' }, off('C')];
    const r = await onFakeKit('seller', kit, vt);
    await until(vt, () => kit.count('run') >= 1, 'the start');
    assert.ok(r.out.lines.some((l) => l.includes('] preflight off escrow C: The escrow takes no locks of C')), r.out.lines.join('\n'));
    r.signals.emit('SIGINT');
    assert.equal(await drive(vt, r.p), 0);
    // An off TAZ, which the config trades, stops the start before anything is posted.
    const kit2 = new FakeKit(vt.now);
    kit2.preflightItems = [{ name: 'pins', ok: true, text: 'pinned' }, off('TAZ')];
    const r2 = await onFakeKit('seller', kit2, vt);
    assert.equal(await drive(vt, r2.p), 1);
    assert.ok(r2.out.lines.some((l) => l.includes('] preflight off escrow TAZ:')), r2.out.lines.join('\n'));
    assert.ok(r2.out.lines.some((l) => /\] Not starting: escrow TAZ \(above\)/.test(l)), r2.out.lines.join('\n'));
    assert.deepEqual(kit2.calls.map((c) => c.fn), ['close'], 'nothing posted, taken or run');
    // A failed escrow item of a token the config trades stops it too, as before; one it does not trade does not.
    const kit3 = new FakeKit(vt.now);
    kit3.preflightItems = [{ name: 'escrow RA', ok: false, text: 'New locks are paused.' }];
    assert.equal(await drive(vt, (await onFakeKit('seller', kit3, vt)).p), 1);
    assert.deepEqual(kit3.calls.map((c) => c.fn), ['close']);
  });

  test('the first Ctrl-C stops posting and taking, cancels the offers, leaves new takes unaccepted, and finishes the running trades before it exits', async () => {
    const vt = new VTime();
    const kit = new FakeKit(vt.now);
    kit.trades = [runningTrade(7)];
    const r = await onFakeKit('seller', kit, vt);
    await until(vt, () => kit.count('sellDownTo') >= 1, 'the first order', { stepMs: 1_000 });
    const ok = { offer: {} as LocalOffer, checks: { ok: true as const } };
    assert.equal(await kit.policy!.accept!({} as Trade, ok), true, 'takes are accepted while the bot runs');
    r.signals.emit('SIGINT');
    await until(vt, () => kit.count('cancelOffer') === 2, 'the offers cancelled', { stepMs: 1_000 });
    const posts = kit.count('postOffer'), orders = kit.count('sellDownTo');
    assert.equal(await kit.policy!.accept!({} as Trade, ok), false, 'a take that comes now is not accepted');
    for (let i = 0; i < 60; i++) await vt.advance(5_000); // 5 minutes: 2 orders and 5 offer checks would have come
    assert.equal(kit.count('postOffer'), posts, 'no new offers');
    assert.equal(kit.count('sellDownTo'), orders, 'no new takes');
    assert.equal(r.code(), null, 'still finishing its running trade');
    assert.equal(kit.running, true, 'run() still carries the trade');
    assert.match(r.out.lines.join('\n'), /Waiting for 1 running trade\(s\) to finish: #7 \(pha_locked\)/);
    kit.trades = [{ ...runningTrade(7), endedAt: vt.now() } as LocalTrade];
    assert.equal(await drive(vt, r.p), 0);
    assert.equal(kit.running, false);
    assert.equal(kit.calls.at(-1)!.fn, 'close');
    assert.match(r.out.lines.join('\n'), /Every trade of this bot is finished, and its offers are cancelled\. Stopped\./);
  });

  test('the second Ctrl-C exits at once (130) with a trade still running; one Ctrl-C delivered twice counts once', async () => {
    const vt = new VTime();
    const kit = new FakeKit(vt.now);
    kit.trades = [runningTrade(3)];
    const r = await onFakeKit('buyer', kit, vt);
    await until(vt, () => kit.count('buyUpTo') >= 1, 'the first order', { stepMs: 1_000 });
    r.signals.emit('SIGINT');
    r.signals.emit('SIGINT'); // the same press, delivered twice by a wrapper
    await vt.advance(100);
    assert.equal(r.code(), null);
    assert.equal(kit.running, true);
    await vt.advance(2_000);
    r.signals.emit('SIGINT');
    assert.equal(await drive(vt, r.p), 130);
    assert.equal(kit.running, false);
    assert.equal(kit.calls.at(-1)!.fn, 'close');
    assert.ok(kit.trades[0] && !kit.trades[0].endedAt, 'the trade is left for the next start to resume');
  });

  test('a restart keeps an open offer that matches the config, cancels one the config no longer lists, and lists nothing the bot cannot fill', async () => {
    const vt = new VTime();
    const kit = new FakeKit(vt.now);
    const kept = await kit.postOffer({ side: 'sell', symbol: 'TAZ', total: '30', min: '1', max: '5', price: '1.08', acceptOnTheirOwn: true });
    const stale = await kit.postOffer({ side: 'sell', symbol: 'TAZ', total: '30', min: '1', max: '5', price: '2.50', acceptOnTheirOwn: true });
    kit.calls = [];
    const r = await onFakeKit('seller', kit, vt);
    await until(vt, () => kit.count('sellDownTo') >= 1, 'the first order', { stepMs: 1_000 });
    assert.deepEqual(kit.calls.filter((c) => c.fn === 'postOffer').map((c) => (c.arg as OfferInput).symbol), ['RA'], 'only the missing offer is listed');
    assert.deepEqual(kit.calls.filter((c) => c.fn === 'cancelOffer').map((c) => c.arg), [stale.id]);
    assert.equal(kit.offers.find((o) => o.id === kept.id)!.closedAt, null);
    r.signals.emit('SIGINT');
    assert.equal(await drive(vt, r.p), 0);

    // A buyer without USDC lists no bid, and lists both once it has the USDC.
    const poor = new FakeKit(vt.now);
    poor.usdc = 0n;
    const b = await onFakeKit('buyer', poor, vt);
    await until(vt, () => poor.count('buyUpTo') >= 1, 'the buyer\'s first order', { stepMs: 1_000 });
    assert.equal(poor.count('postOffer'), 0);
    assert.match(b.out.lines.join('\n'), /Not listing buy 20 TAZ \(1 to 5 per trade\) at 1\.06 mUSDC now: this bot's Base address holds 0 mUSDC/);
    poor.usdc = 10n ** 9n;
    await until(vt, () => poor.count('postOffer') === 2, 'the bids listed', { stepMs: 5_000 });
    b.signals.emit('SIGINT');
    assert.equal(await drive(vt, b.p), 0);
  });

  test('an instant offer in the config is posted with mode "instant", and after a restart its kept offer is kept, never listed twice', async () => {
    const vt = new VTime();
    const dir = await tempDir();
    const config = join(dir, 'instant-seller.json');
    const ask = { symbol: 'TAZ', total: '30', min: '1', max: '5', price: '1.08' };
    await writeFile(config, JSON.stringify({
      network: 'devnet', apiKeyFile: './keys/api-key.json', keys: { pha: './keys/s-pha.json', base: './keys/s-base.json' }, dataDir: './data/s',
      offers: [{ ...ask, mode: 'instant' }], acceptAfterS: 0
    }));
    // A fresh start lists it as instant, with the API key handed to the kit.
    const kit = new FakeKit(vt.now);
    const r = await onFakeKit('seller', kit, vt, ['--config', config]);
    await until(vt, () => kit.count('run') >= 1, 'run()', { stepMs: 1_000 });
    assert.deepEqual(kit.calls.filter((c) => c.fn === 'postOffer').map((c) => c.arg), [{ side: 'sell', ...ask, mode: 'instant', acceptOnTheirOwn: true }]);
    assert.equal(r.opts()!.apiKeyFile, join(r.cwd, 'keys', 'api-key.json'));
    assert.match(r.out.lines.join('\n'), /Listed offer #1: sell 30 TAZ \(1 to 5 per trade\) at 1\.08 mUSDC \(instant: the buyer locks first\)\./);
    r.signals.emit('SIGINT');
    assert.equal(await drive(vt, r.p), 0);

    // A restart: the kept instant offer is the config's entry; a standard offer on the same terms is not, and is cancelled.
    const again = new FakeKit(vt.now);
    const keptInstant = await again.postOffer({ side: 'sell', ...ask, mode: 'instant', acceptOnTheirOwn: true });
    const keptStandard = await again.postOffer({ side: 'sell', ...ask, acceptOnTheirOwn: true });
    again.calls = [];
    const r2 = await onFakeKit('seller', again, vt, ['--config', config]);
    await until(vt, () => again.count('run') >= 1 && again.count('cancelOffer') >= 1, 'the sync', { stepMs: 1_000 });
    assert.equal(again.count('postOffer'), 0, 'no second offer beside the kept instant one');
    assert.deepEqual(again.calls.filter((c) => c.fn === 'cancelOffer').map((c) => c.arg), [keptStandard.id]);
    assert.equal(again.offers.find((o) => o.id === keptInstant.id)!.closedAt, null);
    r2.signals.emit('SIGINT');
    assert.equal(await drive(vt, r2.p), 0);
  });

  test('a failure of the loop (the store lost its lock) stops the bot with exit 1, after run() has ended', async () => {
    const vt = new VTime();
    const kit = new FakeKit(vt.now);
    let reads = 0;
    const list = kit.store.listOffers;
    (kit.store as { listOffers: () => Promise<LocalOffer[]> }).listOffers = async () => {
      if (++reads > 1) throw new SafetyError('STORE_LOCK_LOST', 'This process no longer holds the data directory.');
      return list();
    };
    const r = await onFakeKit('seller', kit, vt);
    assert.equal(await drive(vt, r.p, { stepMs: 5_000 }), 1);
    assert.match(r.out.lines.join('\n'), /The bot stopped: STORE_LOCK_LOST: This process no longer holds the data directory\./);
    assert.equal(kit.running, false);
    assert.equal(kit.calls.at(-1)!.fn, 'close', 'closed only after run() ended');
  });

  test('a key-shaped argument, an unknown flag and a bad config are refused before the kit is built', async () => {
    const vt = new VTime();
    const kit = new FakeKit(vt.now);
    const wif = PhantasmaKeys.generate().toWIF();
    const r1 = await onFakeKit('seller', kit, vt, ['--config', wif]);
    assert.equal(await r1.p, 2);
    assert.ok(!r1.out.lines.join('\n').includes(wif), 'the refusal does not repeat the key');
    const r2 = await onFakeKit('seller', kit, vt, ['--fast']);
    assert.equal(await r2.p, 2);
    const d = await tempDir();
    await writeFile(join(d, 'bad.json'), JSON.stringify({ network: 'devnet', keys: { pha: 'a', base: 'b' }, dataDir: 'd', offers: [{ symbol: 'TAZ', total: '30', min: '1', max: '5' }] }));
    const r3 = await onFakeKit('seller', kit, vt, ['--config', join(d, 'bad.json')]);
    assert.equal(await r3.p, 1);
    assert.match(r3.out.lines.join('\n'), /has a "price" or a "follow", exactly one/);
    assert.equal(kit.calls.length, 0, 'the kit was never used');
    assert.equal(r1.opts(), null);
  });
});

// ── 4. new-keys.ts ──────────────────────────────────────────────────────────

/** A process for guardProcess: its signals, and the kills it asks for. */
function fakeProcess(isTTY?: boolean) {
  const kills: Array<[number, string]> = [];
  const signals = new EventEmitter();
  const p = {
    pid: 4242,
    stdin: isTTY === undefined ? {} : { isTTY },
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    on(event: 'SIGHUP', fn: () => void) { signals.on(event, fn); return p; },
    kill(pid: number, signal: 'SIGTERM') { kills.push([pid, signal]); return true; }
  };
  return { p, kills, hangUp: () => signals.emit('SIGHUP') };
}

describe('the runner in sessions (a host such as a Cloudflare Durable Object: cloudflare/)', () => {
  /** The seller's example config without the three things a host keeps itself. */
  async function hostedSeller(): Promise<Record<string, unknown>> {
    const { keys: _k, dataDir: _d, ...rest } = JSON.parse(await readFile(defaultConfigPath('seller'), 'utf8')) as Record<string, unknown>;
    return rest;
  }

  test('parseHostedConfig: the same checks as a config of files, without "keys", "dataDir" and "apiKeyFile"; instant offers need the host\'s API key', async () => {
    const raw = await hostedSeller();
    const { keys: _k, dataDir: _d, apiKeyFile: _a, ...trading } = parseBotConfig(JSON.parse(await readFile(defaultConfigPath('seller'), 'utf8')));
    assert.deepEqual(parseHostedConfig(raw, { apiKey: false }), trading, 'the same config, without the files');
    for (const k of ['keys', 'dataDir', 'apiKeyFile']) {
      assert.throws(() => parseHostedConfig({ ...raw, [k]: 'x' }, { apiKey: false }), (e: Error & { code?: string }) => e.code === 'BAD_CONFIG' && e.message.includes(`"${k}", which names a file on a machine`));
    }
    assert.throws(() => parseHostedConfig({ ...raw, extra: 1 }, { apiKey: false }), (e: Error) => /unknown key "extra"/.test(e.message) && !/dataDir|keys|apiKeyFile/.test(e.message));
    assert.throws(() => parseHostedConfig({ ...raw, offers: [{ symbol: 'TAZ', total: '30', min: '1', max: '5' }] }, { apiKey: false }), /has a "price" or a "follow", exactly one/);
    assert.throws(() => parseHostedConfig([], { apiKey: false }), /a JSON object/);
    const instant = { network: 'devnet', offers: [{ symbol: 'TAZ', total: '5', min: '1', max: '5', price: '1.08', mode: 'instant' }] };
    assert.throws(() => parseHostedConfig(instant, { apiKey: false, apiKeyName: 'the secret SELLER_API_KEY' }), /offers\[0\]\.mode "instant" needs an API key the owner flagged for instant offers: set the secret SELLER_API_KEY/);
    assert.equal(parseHostedConfig(instant, { apiKey: true }).offers[0]!.mode, 'instant');
  });

  test('a session ends at `until` as a pause: nothing cancelled, SESSION_PAUSED; the next session posts nothing twice and takes no order early', async () => {
    const vt = new VTime();
    const kit = new FakeKit(vt.now);
    const cfg = parseHostedConfig(await hostedSeller(), { apiKey: false });
    const out = sink();
    const saved: number[][] = [];
    const takesAtSave: number[] = [];
    const takeDue = { load: () => saved.at(-1) ?? [], save: (d: readonly number[]) => { saved.push([...d]); takesAtSave.push(kit.count('sellDownTo')); } };
    const end = new AbortController();
    const p = trade(kit as unknown as BotKit, cfg, { say: out.out, usdc: 'mUSDC', now: vt.now, sleep: vt.sleep, signals: new EventEmitter(), session: { until: end.signal, takeDue } });
    await until(vt, () => kit.count('sellDownTo') >= 1, 'the first order', { stepMs: 1_000 });
    assert.equal(kit.count('postOffer'), 2);
    assert.deepEqual(takesAtSave, [0, 1], 'the order\'s next time is kept before the order goes out (a cut never sends it twice), and again after it');
    assert.ok(saved[0]![0]! >= vt.now() + 110_000, 'the next order is due everyS (120 s) later');
    end.abort();
    assert.equal(await drive(vt, p), SESSION_PAUSED);
    assert.equal(kit.count('cancelOffer'), 0, 'a pause cancels nothing');
    assert.equal(kit.running, false, 'run() ended with the session');
    assert.ok(!out.lines.some((l) => /Stopping|Stopped|Exiting/.test(l)), out.lines.join('\n'));
    // The next session, 10 s later: its offers are still the kit's, and the order is not due yet.
    await vt.advance(10_000);
    const end2 = new AbortController();
    const p2 = trade(kit as unknown as BotKit, cfg, { say: out.out, usdc: 'mUSDC', now: vt.now, sleep: vt.sleep, signals: new EventEmitter(), session: { until: end2.signal, takeDue } });
    await until(vt, () => kit.count('run') >= 2, 'run() again', { stepMs: 1_000 });
    assert.equal(kit.count('postOffer'), 2, 'nothing posted twice');
    assert.equal(kit.count('sellDownTo'), 1, 'no early order at the start of a session');
    await until(vt, () => kit.count('sellDownTo') >= 2, 'the second order, on time', { stepMs: 1_000 });
    assert.ok(kit.calls.filter((c) => c.fn === 'sellDownTo')[1]!.at >= saved[0]![0]!, 'when it was due');
    end2.abort();
    assert.equal(await drive(vt, p2), SESSION_PAUSED);
    // An `until` that has already ended: the session pauses at once.
    const done = new AbortController();
    done.abort();
    assert.equal(await drive(vt, trade(kit as unknown as BotKit, cfg, { say: out.out, usdc: 'mUSDC', now: vt.now, sleep: vt.sleep, signals: new EventEmitter(), session: { until: done.signal, takeDue } })), SESSION_PAUSED);
  });

  test('a stop asked before the session (stopping): no offer or order, the offers cancelled, the trades finished, then 0; a stop signal in a session does the same', async () => {
    const vt = new VTime();
    const kit = new FakeKit(vt.now);
    const cfg = parseHostedConfig(await hostedSeller(), { apiKey: false });
    await kit.postOffer({ side: 'sell', symbol: 'TAZ', total: '30', min: '1', max: '5', price: '1.08' });
    kit.trades = [runningTrade(7)];
    const out = sink();
    const end = new AbortController();
    const p = trade(kit as unknown as BotKit, cfg, { say: out.out, usdc: 'mUSDC', now: vt.now, sleep: vt.sleep, signals: new EventEmitter(), session: { until: end.signal, stopping: true } });
    await until(vt, () => kit.count('cancelOffer') === 1, 'the offer cancelled', { stepMs: 1_000 });
    const ok = { offer: {} as LocalOffer, checks: { ok: true as const } };
    assert.equal(await kit.policy!.accept!({} as Trade, ok), false, 'no take is accepted while stopping');
    for (let i = 0; i < 30; i++) await vt.advance(5_000);
    assert.equal(kit.count('postOffer'), 1, 'no new offers');
    assert.equal(kit.count('sellDownTo'), 0, 'no orders');
    kit.trades = [{ ...runningTrade(7), endedAt: vt.now() } as LocalTrade];
    assert.equal(await drive(vt, p), 0, 'stopped: every trade finished');
    // In a session that is running: a SIGTERM from the host stops it the same way.
    const kit2 = new FakeKit(vt.now);
    const signals = new EventEmitter();
    const out2 = sink();
    const p2 = trade(kit2 as unknown as BotKit, cfg, { say: out2.out, usdc: 'mUSDC', now: vt.now, sleep: vt.sleep, signals, session: { until: new AbortController().signal } });
    await until(vt, () => kit2.count('run') >= 1, 'the start', { stepMs: 1_000 });
    signals.emit('SIGTERM');
    assert.equal(await drive(vt, p2), 0);
    assert.equal(kit2.count('cancelOffer'), 2);
    assert.ok(out2.lines.some((l) => l.includes('then stops (its state is kept)')) && !out2.lines.some((l) => /Ctrl-C/.test(l)), out2.lines.join('\n'));
  });
});

describe('offers sized from the balances (sizeFromBalances)', () => {
  const hosted = (o: Record<string, unknown>): HostedBotConfig => parseHostedConfig({ network: 'devnet', ...o }, { apiKey: false });
  const ADDR = { pha: newPha(), base: newBase() };
  /** Phantasma balances in whole tokens (decimal text); plenty of SOUL and of KCAL unless given. */
  const bal = (o: Record<string, string>): PhaBalances => new Map(P2P_TOKENS.map((t) => [t.symbol, {
    raw: o[t.symbol] !== undefined ? (o[t.symbol] === '0' ? 0n : tokenToRaw(t.symbol, o[t.symbol]!)) : t.symbol === 'SOUL' || t.symbol === 'KCAL' ? 10n ** 12n : 0n, decimals: t.decimals
  }]));
  const tok = (symbol: string, v: string) => tokenToRaw(symbol, v);
  const listing = (id: number, symbol: string, total: string, left: string | null = total, hold: SizedListing['hold'] = null): SizedListing => ({ id, total: tok(symbol, total), left: left === null ? null : tok(symbol, left), hold });
  /** A plan for a config: every listing looked at unless `look` says otherwise; `usdc` null is a Base read that failed. */
  const plan = (cfg: HostedBotConfig, o: { listed?: Array<SizedListing | null>; pha?: PhaBalances | null; usdc?: string | null; eth?: bigint; trades?: LocalTrade[]; kept?: LocalOffer[]; look?: boolean } = {}) => planSizes({
    network: 'devnet', offers: cfg.offers, take: cfg.take, listed: o.listed ?? cfg.offers.map(() => null), look: cfg.offers.map(() => o.look ?? true), pha: o.pha === undefined ? bal({}) : o.pha,
    base: o.usdc === null ? null : { usdc: o.usdc === undefined || o.usdc === '0' ? 0n : usdcToRaw(o.usdc), eth: o.eth ?? 10n ** 18n },
    trades: o.trades ?? [], kept: o.kept ?? [], address: ADDR, holdBack: cfg.holdBack, usdcSymbol: 'mUSDC'
  });
  const totals = (p: { steps: Array<{ do: string }> }) => p.steps.map((x) => { const s = x as { do: string; offer?: OfferInput }; return s.offer ? s.offer.total : s.do; });
  const whyOf = (p: { steps: Array<{ do: string }> }, i = 0): string => (p.steps[i] as { why?: string }).why ?? '';
  /** One of the bot's own trades, as far as the sizing reads it. */
  const tradeOf = (o: Partial<LocalTrade>): LocalTrade => ({ id: 1, offerId: 1, role: 'S', maker: true, symbol: 'TAZ', taz: '0', usdc: '0', myPha: ADDR.pha, myBase: ADDR.base.toLowerCase(), txs: {}, ...o }) as LocalTrade;
  const SELL_C = { symbol: 'C', total: '9000', min: '5', max: '9000', price: '1.03' };
  const BUY_C = { symbol: 'C', total: '10000', min: '2.05', max: '10000', price: '0.98' };
  const SELL_TAZ = { symbol: 'TAZ', total: '30', min: '1', max: '5', price: '1.08' };

  test('the config: off unless turned on; sizeEveryS from 300 to 86400 (null: an hour); holdBack by token or "USDC", as text; a KCAL or SOUL sale names what it holds back', () => {
    const off = hosted({ offers: [SELL_C] });
    assert.equal(off.sizeFromBalances, false);
    assert.equal(off.sizeEveryS, null);
    assert.deepEqual(off.holdBack, {});
    assert.equal(SIZE_EVERY_S, 3600);
    const on = hosted({ offers: [SELL_C], sizeFromBalances: true, sizeEveryS: 600, holdBack: { KCAL: '100', USDC: '20.5', C: '0' } });
    assert.equal(on.sizeFromBalances, true);
    assert.equal(on.sizeEveryS, 600);
    assert.deepEqual(on.holdBack, { KCAL: '100', USDC: '20.5', C: '0' }, '"0" holds nothing back');
    assert.equal(hosted({ sizeFromBalances: null, sizeEveryS: null, holdBack: null }).sizeFromBalances, false, 'null is the default, as for every key');
    const bad = (o: Record<string, unknown>, re: RegExp) => assert.throws(() => hosted(o), (e: Error & { code?: string }) => e.code === 'BAD_CONFIG' && re.test(e.message), JSON.stringify(o));
    bad({ sizeFromBalances: 'yes' }, /sizeFromBalances is true or false/);
    for (const v of [299, 86_401, 600.5, '600', 0]) bad({ sizeEveryS: v }, /sizeEveryS is a whole number of seconds from 300 to 86400, or null for 3600 \(an hour\)/);
    bad({ holdBack: ['KCAL'] }, /holdBack is an object such as \{"KCAL": "100", "USDC": "20"\}/);
    bad({ holdBack: { DOGE: '1' } }, /holdBack has an unknown key "DOGE" \(allowed: C, RA, TAZ, SOUL, KCAL, USDC\)/);
    bad({ holdBack: { KCAL: 100 } }, /holdBack\.KCAL is an amount, as text/);
    bad({ holdBack: { USDC: '-1' } }, /holdBack\.USDC: .*a decimal number written as text/);
    bad({ holdBack: { C: '1.0000001' } }, /holdBack\.C: .*more than 6 decimal places/);
    bad({ keep: { USDC: '1' } }, /unknown key "keep"/);
    // Sized from the balance, a KCAL or SOUL sale would go down to what one lock needs: the config says what is held back.
    const kcal = { symbol: 'KCAL', total: '100', min: '1', max: '100', price: '1.50' };
    const soul = { symbol: 'SOUL', total: '100', min: '1', max: '100', price: '2.00' };
    bad({ offers: [SELL_C, kcal], sizeFromBalances: true }, /offers\[1\] sells KCAL with sizeFromBalances on: say in holdBack\.KCAL how much KCAL the bot holds back \(it pays the gas of every Phantasma transaction in KCAL\)/);
    bad({ offers: [soul], sizeFromBalances: true, holdBack: { KCAL: '5' } }, /offers\[0\] sells SOUL with sizeFromBalances on: say in holdBack\.SOUL/);
    assert.equal(hosted({ offers: [kcal, soul], sizeFromBalances: true, holdBack: { KCAL: '5', SOUL: '0' } }).offers.length, 2);
    assert.equal(hosted({ offers: [kcal, soul] }).offers.length, 2, 'without the option nothing changes');
    assert.equal(hosted({ bids: [kcal], sizeFromBalances: true }).offers.length, 1, 'a buy offer of KCAL spends USDC');
    // A config of files takes the same keys.
    assert.equal(parseBotConfig({ network: 'devnet', keys: { pha: 'a', base: 'b' }, dataDir: 'd', sizeFromBalances: true }).sizeFromBalances, true);
  });

  test('plainAmount, sizedOffer and sizedSame: an amount the kit takes back; the largest trade and the amount per day follow the total down; a sized listing is still its entry', () => {
    assert.equal(plainAmount(1_234_500_000n, 6), '1234.5');
    assert.equal(plainAmount(163_280_000n, 6), '163.28');
    assert.equal(plainAmount(5_000_000_000n, 9), '5');
    assert.equal(tokenToRaw('C', plainAmount(123_456_789_012n, 6)), 123_456_789_012n, 'no separator: the kit reads it back');
    const w: OfferInput = { side: 'buy', ...BUY_C };
    assert.equal(sizedOffer(w, tok('C', '10000')), w, 'at its own total: the entry itself');
    assert.deepEqual(sizedOffer(w, tok('C', '163.28')), { side: 'buy', symbol: 'C', total: '163.28', min: '2.05', max: '163.28', price: '0.98' });
    assert.deepEqual(sizedOffer({ side: 'sell', ...SELL_TAZ }, tok('TAZ', '12.34')), { side: 'sell', symbol: 'TAZ', total: '12.34', min: '1', max: '5', price: '1.08' }, 'a largest trade under the total stays');
    const f: OfferInput = { side: 'sell', symbol: 'RA', total: '6', min: '1', max: '2', follow: { offsetBps: 200, limitPrice: '1.90', dailyMax: '4' } };
    assert.deepEqual(sizedOffer(f, tok('RA', '3')).follow, { offsetBps: 200, limitPrice: '1.90', dailyMax: '3' });
    assert.deepEqual(sizedOffer(f, tok('RA', '5')).follow, f.follow, 'an amount per day under the total stays');
    // A kept offer listed at 163.28 is still this entry; one above the entry's total, at another price or with another accept setting is not.
    const kept = (o: OfferInput, id = 1): LocalOffer => ({
      id, network: 'devnet', side: o.side, symbol: o.symbol, makerPha: ADDR.pha, makerBase: ADDR.base.toLowerCase(), tazTotal: tok(o.symbol, o.total).toString(), tazMin: tok(o.symbol, o.min).toString(),
      tazMax: tok(o.symbol, o.max).toString(), price: usdcToRaw(o.price ?? o.follow!.limitPrice).toString(), makerToken: 'ab'.repeat(32), tokenSource: 'client', priceHistory: [],
      follow: o.follow ? { offsetBps: o.follow.offsetBps, limitPrice: usdcToRaw(o.follow.limitPrice).toString(), dailyMax: tok(o.symbol, o.follow.dailyMax ?? o.total).toString() } : null,
      acceptOnTheirOwn: true, mode: 'standard', createdAt: 0, closedAt: null
    });
    const at = kept(sizedOffer(w, tok('C', '163.28')));
    assert.equal(sameOffer(at, w, true), false, 'not the entry at the config\'s total');
    assert.equal(sizedSame(at, w, true), true);
    assert.equal(sizedSame(kept(w), w, true), true, 'one listed at the config\'s total, before the option was on, is the entry too');
    assert.equal(sizedSame(at, { ...w, total: '100', max: '100' }, true), false, 'more than the entry lists now');
    const five = kept({ ...w, total: '163.28', max: '5' });
    assert.equal(sizedSame(five, { ...w, total: '200', max: '5' }, true), true);
    assert.equal(sizedSame(five, { ...w, total: '163.28', max: '5' }, true), true, 'exactly the entry\'s total');
    assert.equal(sizedSame(five, { ...w, total: '100', max: '5' }, true), false, 'above the entry\'s total, whatever its largest trade: a total that was lowered is taken up at once');
    assert.equal(sizedSame(at, { ...w, price: '0.97' }, true), false);
    assert.equal(sizedSame(at, w, false), false);
    assert.equal(sizedSame(at, { ...w, side: 'sell' }, true), false);
    assert.equal(sizedSame(kept({ ...w, total: '163.28', max: '100' }), w, true), false, 'another largest trade than the bot would list');
    assert.equal(sizedSame(kept(sizedOffer(f, tok('RA', '3'))), f, true), true, 'a following offer with its amount per day lowered');
    const noDay: OfferInput = { side: 'sell', symbol: 'RA', total: '6', min: '1', max: '2', follow: { offsetBps: 200, limitPrice: '1.90' } };
    assert.equal(sizedSame(kept(sizedOffer(noDay, tok('RA', '3'))), noDay, true), true, 'one without an amount per day: the kit set it to the listed total');
  });

  test('planSizes: a buy offer grows to what the USDC covers; a sale changes nothing; more than the total is never listed', () => {
    // 160.016447 USDC at 0.98: 163.28 C, rounded down, and the largest trade with it.
    const bid = hosted({ bids: [BUY_C] });
    assert.deepEqual(plan(bid, { listed: [listing(208, 'C', '37.36')], usdc: '160.016447' }), {
      steps: [{ do: 'relist', id: 208, left: tok('C', '37.36'), offer: { side: 'buy', symbol: 'C', total: '163.28', min: '2.05', max: '163.28', price: '0.98' } }], complete: true
    });
    assert.deepEqual(plan(bid, { usdc: '160.016447' }).steps, [{ do: 'list', offer: { side: 'buy', symbol: 'C', total: '163.28', min: '2.05', max: '163.28', price: '0.98' } }]);
    // A sale took 123.85 C from the offer and from the balance alike: nothing to do.
    const ask = hosted({ offers: [SELL_C] });
    assert.deepEqual(plan(ask, { listed: [listing(206, 'C', '9000', '8876.15')], pha: bal({ C: '8876.15' }) }).steps, [{ do: 'keep' }]);
    // It holds more than the total: the listing is filled up to the total again, never past it.
    const up = plan(ask, { listed: [listing(206, 'C', '9000', '8876.15')], pha: bal({ C: '9852.5' }) }).steps[0]!;
    assert.equal(up.do, 'relist');
    assert.equal(up.do === 'relist' && up.offer, ask.offers[0], 'at the config\'s own total');
    // It promises 3.15 C more than the bot holds, less than a smallest trade: listed again all the same.
    assert.deepEqual(plan(ask, { listed: [listing(206, 'C', '9000', '8876.15')], pha: bal({ C: '8873' }) }).steps, [
      { do: 'relist', id: 206, left: tok('C', '8876.15'), offer: { side: 'sell', symbol: 'C', total: '8873', min: '5', max: '8873', price: '1.03' } }
    ]);
    // A difference under one smallest trade, with the bot able to fill it: left alone.
    assert.deepEqual(plan(ask, { listed: [listing(206, 'C', '8870')], pha: bal({ C: '8873' }) }).steps, [{ do: 'keep' }]);
    // The edges: a difference of exactly one smallest trade lists it again, a hair less does not; an offer with exactly its
    // smallest trade left can still be taken and is not used up, a hair less is.
    const edge = hosted({ offers: [{ symbol: 'TAZ', total: '100', min: '5', max: '50', price: '1.08' }] });
    assert.deepEqual(totals(plan(edge, { listed: [listing(1, 'TAZ', '30')], pha: bal({ TAZ: '35' }) })), ['35']);
    assert.deepEqual(totals(plan(edge, { listed: [listing(1, 'TAZ', '30')], pha: bal({ TAZ: '34.99' }) })), ['keep']);
    assert.deepEqual(totals(plan(edge, { listed: [listing(1, 'TAZ', '30')], pha: bal({ TAZ: '25' }) })), ['25'], 'downwards too');
    assert.deepEqual(totals(plan(edge, { listed: [listing(1, 'TAZ', '30', '5')], pha: bal({ TAZ: '5' }) })), ['keep'], 'its smallest trade can still be taken');
    assert.deepEqual(totals(plan(edge, { listed: [listing(1, 'TAZ', '30', '4.99')], pha: bal({ TAZ: '9' }) })), ['9']);
    // Less than its smallest trade left (the board no longer lists it): listed again, or cancelled when the bot has no more.
    assert.deepEqual(totals(plan(ask, { listed: [listing(206, 'C', '9000', '3')], pha: bal({ C: '7' }) })), ['7']);
    const gone = plan(ask, { listed: [listing(206, 'C', '9000', '3')], pha: bal({ C: '3' }) });
    assert.equal(gone.steps[0]!.do, 'unlist');
    assert.equal(whyOf(gone), 'this bot\'s Phantasma address holds 3 C, less than the smallest trade (5 C)');
    // Not listed and too little: nothing, with the reason; rounded down to hundredths, never up.
    const none = plan(ask, { pha: bal({ C: '4.999999' }) });
    assert.equal(none.steps[0]!.do, 'none');
    assert.match(whyOf(none), /holds 4\.999999 C, less than the smallest trade \(5 C\)/);
    assert.deepEqual(totals(plan(ask, { pha: bal({ C: '12.349999' }) })), ['12.34']);
    assert.deepEqual(plan(hosted({ bids: [{ symbol: 'C', total: '10000', min: '2', max: '10000', price: '0.98' }] }), { usdc: '2' }).steps[0], { do: 'list', offer: { side: 'buy', symbol: 'C', total: '2.04', min: '2', max: '2.04', price: '0.98' } }, '2 USDC buys 2.04 C at 0.98, not 2.05');
    const dry = plan(bid, { usdc: '1.99' });
    assert.equal(dry.steps[0]!.do, 'none');
    assert.equal(whyOf(dry), 'this bot\'s Base address holds 1.99 mUSDC, less than the smallest trade needs (2.009 mUSDC)');
    // The entry's own total is the limit, and the bot could list at least one smallest trade more: the plan says how much (for the bot's sentence).
    const small = hosted({ bids: [{ ...BUY_C, total: '37.36', max: '37.36' }] });
    assert.deepEqual(plan(small, { listed: [listing(208, 'C', '37.36')], usdc: '160.016447' }), { steps: [{ do: 'keep', more: tok('C', '163.28') }], complete: true });
    assert.deepEqual(plan(small, { listed: [listing(208, 'C', '37.36')], usdc: '38' }), { steps: [{ do: 'keep' }], complete: true }, 'under one smallest trade more: nothing to say');
    assert.deepEqual(plan(small, { usdc: '160.016447' }).steps, [{ do: 'list', offer: small.offers[0], more: tok('C', '163.28') }]);
    // A smallest trade written with more decimals than the rounding keeps: the smallest trade itself, when the bot holds it.
    assert.deepEqual(totals(plan(hosted({ offers: [{ symbol: 'C', total: '100', min: '1.005', max: '100', price: '1.03' }] }), { pha: bal({ C: '1.0099' }) })), ['1.005']);
  });

  test('planSizes: a take waiting, a paused offer, an amount per day and an unread balance leave a listing as it is; so does a size the kit would refuse', () => {
    const bid = hosted({ bids: [BUY_C] });
    assert.deepEqual(plan(bid, { listed: [listing(208, 'C', '37.36', '37.36', 'take')], usdc: '160' }), { steps: [{ do: 'wait', id: 208 }], complete: true });
    assert.deepEqual(plan(bid, { listed: [listing(208, 'C', '37.36', '37.36', 'take')], usdc: '37' }), { steps: [{ do: 'keep' }], complete: true }, 'a take waits, but nothing would change anyway');
    assert.deepEqual(plan(bid, { listed: [listing(208, 'C', '37.36', '37.36', 'paused')], usdc: '160' }), { steps: [{ do: 'keep' }], complete: true });
    assert.deepEqual(plan(bid, { listed: [listing(208, 'C', '37.36', null)], usdc: '160' }), { steps: [{ do: 'keep' }], complete: false }, 'the board did not say what is left');
    assert.deepEqual(plan(bid, { listed: [listing(208, 'C', '37.36')], usdc: null }), { steps: [{ do: 'keep' }], complete: false });
    const unread = plan(bid, { usdc: null });
    assert.equal(unread.complete, false);
    assert.match(whyOf(unread), /its mUSDC balance could not be read/);
    assert.match(whyOf(plan(bid, { usdc: '160', pha: null })), /its Phantasma balances could not be read/, 'a buyer\'s KCAL is read on Phantasma');
    assert.match(whyOf(plan(hosted({ offers: [SELL_C] }), { pha: null })), /its Phantasma balances could not be read/);
    // Not looked at (outside the timed look): a listing is left alone, and an unread balance does not make the look unfinished for it.
    assert.deepEqual(plan(bid, { listed: [listing(208, 'C', '37.36')], usdc: '160', look: false }), { steps: [{ do: 'keep' }], complete: true });
    assert.deepEqual(plan(bid, { listed: [listing(208, 'C', '37.36')], usdc: null, look: false }), { steps: [{ do: 'keep' }], complete: true });
    // A following offer with an amount per day: a new listing would start its 24 hours again.
    const daily = hosted({ offers: [{ symbol: 'RA', total: '6', min: '1', max: '2', follow: { offsetBps: 200, limitPrice: '1.90', dailyMax: '3' } }] });
    const day = plan(daily, { listed: [listing(1, 'RA', '6')], pha: bal({ RA: '2' }) });
    assert.equal(day.steps[0]!.do, 'keep');
    assert.match(whyOf(day), /it has an amount per day \(dailyMax\), and a new listing would start its 24 hours again; to list it again, change its entry in the config/);
    assert.deepEqual(plan(daily, { listed: [listing(1, 'RA', '6')], pha: bal({ RA: '6' }) }), { steps: [{ do: 'keep' }], complete: true }, 'nothing to say while nothing would change');
    assert.deepEqual(plan(daily, { pha: bal({ RA: '2' }) }).steps, [{ do: 'list', offer: { side: 'sell', symbol: 'RA', total: '2', min: '1', max: '2', follow: { offsetBps: 200, limitPrice: '1.90', dailyMax: '2' } } }], 'listed at what it holds when it is listed');
    // What is missing is listed from what the others leave: their own remaining when the board said it, else their total.
    const two = hosted({ offers: [SELL_TAZ, { ...SELL_TAZ, price: '1.20' }] });
    assert.deepEqual(totals(plan(two, { listed: [listing(1, 'TAZ', '30', null), null], pha: bal({ TAZ: '50' }), look: false })), ['keep', '20']);
    assert.deepEqual(totals(plan(two, { listed: [listing(1, 'TAZ', '30', '12'), null], pha: bal({ TAZ: '32' }), look: false })), ['keep', '20']);
    // ... wherever the missing entry stands in the config: a listing that is not looked at now is set aside first.
    assert.deepEqual(totals(plan(two, { listed: [null, listing(2, 'TAZ', '30', null)], pha: bal({ TAZ: '40' }), look: false })), ['10', 'keep']);
    assert.deepEqual(totals(plan(two, { listed: [null, listing(2, 'TAZ', '30', null)], pha: bal({ TAZ: '30.5' }), look: false })), ['none', 'keep']);
    // A following offer's largest trade may cost 10,000 USDC at its limit on devnet: fine while the bot holds little, refused once it holds more. Nothing is cancelled for a listing the kit would refuse.
    const big = hosted({ offers: [{ symbol: 'RA', total: '9000', min: '5', max: '4000', follow: { offsetBps: 0, limitPrice: '3.00' } }] });
    assert.deepEqual(totals(plan(big, { pha: bal({ RA: '3000' }) })), ['3000']);
    const stays = plan(big, { listed: [listing(1, 'RA', '3000')], pha: bal({ RA: '5000' }) });
    assert.equal(stays.steps[0]!.do, 'keep');
    assert.match(whyOf(stays), /listed again at 5000 RA the kit would refuse it \(At your limit price the largest trade costs over 10,000 USDC/);
    const never = plan(big, { pha: bal({ RA: '5000' }) });
    assert.equal(never.steps[0]!.do, 'none');
    assert.match(whyOf(never), /the kit would refuse it at 5000 RA/);
  });

  test('planSizes: offers on one balance share it in the config\'s order; gas, the SOUL a seller keeps, `holdBack`, recurring orders and the bot\'s own trades are held back', () => {
    const two = hosted({ offers: [SELL_TAZ, { ...SELL_TAZ, price: '1.20' }] });
    assert.deepEqual(totals(plan(two, { pha: bal({ TAZ: '40' }) })), ['30', '10']);
    // The first entry comes first: when the balance falls, the second gives way.
    assert.deepEqual(totals(plan(two, { listed: [listing(1, 'TAZ', '30'), listing(2, 'TAZ', '10')], pha: bal({ TAZ: '30.5' }) })), ['keep', 'unlist']);
    // Every buy offer draws on the one USDC balance, each at its own price.
    const bids = hosted({ bids: [{ symbol: 'C', total: '100', min: '2', max: '100', price: '0.98' }, { symbol: 'RA', total: '10', min: '1', max: '10', price: '2.00' }] });
    assert.deepEqual(totals(plan(bids, { usdc: '110' })), ['100', '6'], '98 USDC for the C, and 12 left buy 6 RA');
    // Sell offers and buy offers draw on different balances.
    const both = hosted({ offers: [{ symbol: 'C', total: '50', min: '5', max: '50', price: '1.03' }], bids: [{ symbol: 'C', total: '100', min: '2', max: '100', price: '0.98' }] });
    assert.deepEqual(totals(plan(both, { pha: bal({ C: '20' }), usdc: '49' })), ['20', '50']);
    // A KCAL lock needs 6 KCAL on top, a SOUL lock 1.1 SOUL.
    const gas = hosted({ offers: [{ symbol: 'KCAL', total: '100', min: '1', max: '100', price: '1.50' }, { symbol: 'SOUL', total: '100', min: '1', max: '100', price: '2.00' }] });
    assert.deepEqual(totals(plan(gas, { pha: bal({ KCAL: '50', SOUL: '10' }) })), ['44', '8.9']);
    // No seller locks anything with less than 1.1 SOUL free, or with less KCAL than a lock's gas may take; a buyer keeps 3 KCAL for its claim and needs ETH for its lock.
    const lone = hosted({ offers: [SELL_TAZ], bids: [BUY_C] });
    const low = plan(lone, { pha: bal({ TAZ: '30', SOUL: '0.5' }), usdc: '100' });
    assert.deepEqual(totals(low), ['none', '102.04']);
    assert.match(whyOf(low), /keeps 0\.5 SOUL free, less than the 1\.1 SOUL every seller needs/);
    const dry = plan(lone, { pha: bal({ TAZ: '30', KCAL: '2.5' }), usdc: '100' });
    assert.deepEqual(totals(dry), ['none', 'none']);
    assert.match(whyOf(dry, 0), /holds 2\.5 KCAL, less than the 3 KCAL a lock's gas may take/);
    assert.match(whyOf(dry, 1), /holds 2\.5 KCAL, less than the 3 KCAL a buyer keeps to claim its tokens/);
    const noGas = plan(lone, { pha: bal({ TAZ: '30' }), usdc: '100', eth: 0n });
    assert.deepEqual(totals(noGas), ['30', 'none']);
    assert.match(whyOf(noGas, 1), /holds no ETH for the gas of its USDC lock/);
    assert.deepEqual(totals(plan(lone, { listed: [listing(1, 'TAZ', '30'), listing(2, 'C', '102.04')], pha: bal({ TAZ: '30', KCAL: '2.5' }), usdc: '100' })), ['unlist', 'unlist'], 'listed offers it could not lock for are taken down');
    // holdBack: held back from the offers. A listing inside what the bot could fill, and under one smallest trade away, is left alone.
    const kept = hosted({ offers: [{ symbol: 'TAZ', total: '100', min: '10', max: '50', price: '1.08' }], bids: [{ symbol: 'C', total: '1000', min: '2', max: '1000', price: '0.98' }], holdBack: { TAZ: '10', USDC: '20', C: '0' } });
    assert.deepEqual(totals(plan(kept, { pha: bal({ TAZ: '40' }), usdc: '118' })), ['30', '100']);
    assert.deepEqual(plan(kept, { listed: [listing(1, 'TAZ', '35'), null], pha: bal({ TAZ: '40' }), usdc: '0' }).steps[0], { do: 'keep' });
    assert.equal(plan(kept, { listed: [listing(1, 'TAZ', '45'), null], pha: bal({ TAZ: '40' }), usdc: '0' }).steps[0]!.do, 'relist', 'more than the bot could fill at all');
    // One order of each recurring order is held back from the balance it spends: 2 TAZ of the sell order, 5 x 2.10 USDC of the buy order.
    const orders = hosted({ offers: [SELL_TAZ], bids: [{ symbol: 'C', total: '1000', min: '2', max: '1000', price: '0.98' }], take: [{ symbol: 'TAZ', minPrice: '1.05', amount: '2', everyS: 120 }, { symbol: 'RA', maxPrice: '2.10', amount: '5', everyS: 600 }] });
    assert.deepEqual(totals(plan(orders, { pha: bal({ TAZ: '20' }), usdc: '108.5' })), ['18', '100']);
    // What the bot's own trades still need: tokens of a sale accepted or waiting for its answer (not one already locked), USDC of a buy until its lock is reported.
    const one = hosted({ offers: [{ symbol: 'TAZ', total: '100', min: '1', max: '50', price: '1.08' }], bids: [{ symbol: 'C', total: '1000', min: '2', max: '1000', price: '0.98' }] });
    const trades = [
      tradeOf({ id: 1, status: 'accepted', taz: tok('TAZ', '5').toString() }),
      tradeOf({ id: 2, status: 'requested', taz: tok('TAZ', '2').toString() }),
      tradeOf({ id: 3, status: 'pha_locked', h: `0x${'11'.repeat(32)}`, taz: tok('TAZ', '9').toString() }),
      tradeOf({ id: 4, status: 'accepted', taz: tok('TAZ', '7').toString(), endedAt: 1 }),
      tradeOf({ id: 5, status: 'accepted', symbol: 'RA', taz: tok('RA', '3').toString() }),
      tradeOf({ id: 6, role: 'B', symbol: 'C', status: 'pha_locked', usdc: usdcToRaw('9.8').toString() }),
      tradeOf({ id: 7, role: 'B', symbol: 'C', status: 'base_locked', usdc: usdcToRaw('50').toString(), txs: { baseLock: `0x${'22'.repeat(32)}` } }),
      tradeOf({ id: 8, role: 'B', symbol: 'C', status: 'pha_locked', usdc: usdcToRaw('4.9').toString(), txs: { baseLock: `0x${'44'.repeat(32)}` } })
    ];
    assert.deepEqual(totals(plan(one, { pha: bal({ TAZ: '40' }), usdc: '112.7', trades })), ['33', '100'], 'the lock of trade 8 was sent but not reported: its USDC still counts');
    // An instant offer's trade counts until its lock reads as the bot's own (t1), though its h is kept before.
    const instantOffer = { id: 9, mode: 'instant' } as LocalOffer;
    const waiting = tradeOf({ id: 8, offerId: 9, status: 'base_locked', h: `0x${'33'.repeat(32)}`, taz: tok('TAZ', '4').toString() });
    assert.deepEqual(totals(plan(one, { pha: bal({ TAZ: '40' }), trades: [waiting], kept: [instantOffer] })), ['36', 'none']);
    assert.deepEqual(totals(plan(one, { pha: bal({ TAZ: '40' }), trades: [{ ...waiting, t1: 5 }], kept: [instantOffer] })), ['40', 'none']);
  });

  const SIZED = { offers: [SELL_TAZ], bids: [{ symbol: 'C', total: '1000', min: '2', max: '1000', price: '0.98' }], sizeFromBalances: true, sizeEveryS: 600 };
  const BID = { side: 'buy' as const, symbol: 'C', total: '37.75', min: '2', max: '37.75', price: '0.98' };
  /** A session of the runner on a fake kit, with the host's kept sizing time. */
  function session(kit: FakeKit, vt: VTime, cfg: HostedBotConfig, saved: number[], said: string[] = []) {
    const out = sink();
    const end = new AbortController();
    const sized = { load: () => saved.at(-1) ?? null, save: (at: number, line?: string) => { saved.push(at); said.push(line ?? ''); } };
    const p = trade(kit as unknown as BotKit, cfg, { say: out.out, usdc: 'mUSDC', now: vt.now, sleep: vt.sleep, signals: new EventEmitter(), session: { until: end.signal, sized } });
    return { out, end, p };
  }
  /** Until the session's first sync has ended (it comes once run() has started): its look is kept, or `cond` holds. */
  const started = (vt: VTime, saved: number[], cond: () => boolean = () => saved.length > 0) => until(vt, cond, 'the first sync', { stepMs: 1_000 });
  /** When run() was called for the `n`th time: that session's first sync follows at once (within the step the test's clock moves by). */
  const ranAt = (kit: FakeKit, n = 1) => kit.calls.filter((c) => c.fn === 'run')[n - 1]!.at;
  const about = (actual: number | undefined, expected: number, what: string) => assert.ok(actual !== undefined && actual >= expected && actual <= expected + 1_000, `${what}: ${actual} is not within a second after ${expected}`);
  const posts = (kit: FakeKit) => kit.calls.filter((c) => c.fn === 'postOffer').map((c) => c.arg);
  const open = (kit: FakeKit) => kit.offers.filter((o) => o.closedAt == null);

  test('the runner: lists at what the bot holds; the next session lists nothing again and reads nothing; at sizeEveryS the buy offer grows with the USDC that came in', async () => {
    const vt = new VTime();
    const kit = new FakeKit(vt.now);
    kit.held.set('TAZ', tok('TAZ', '12.3456789'));
    kit.usdc = usdcToRaw('37');
    const cfg = hosted(SIZED);
    const saved: number[] = [];
    const said: string[] = [];
    const s1 = session(kit, vt, cfg, saved, said);
    await started(vt, saved);
    assert.deepEqual(posts(kit), [
      { side: 'sell', symbol: 'TAZ', total: '12.34', min: '1', max: '5', price: '1.08', acceptOnTheirOwn: true },
      { side: 'buy', symbol: 'C', total: '37.75', min: '2', max: '37.75', price: '0.98', acceptOnTheirOwn: true }
    ]);
    assert.ok(s1.out.lines.includes('Listed offer #1: sell 12.34 TAZ (1 to 5 per trade) at 1.08 mUSDC (what the bot holds; the config allows up to 30 TAZ).'), s1.out.lines.join('\n'));
    assert.ok(s1.out.lines.includes('Sized the offers from the balances: 2 listed. The next look is in 600 s.'), s1.out.lines.join('\n'));
    assert.equal(saved.length, 1);
    about(saved[0], ranAt(kit), 'the look is kept for the host once it is done, right after run() started');
    assert.deepEqual(said, ['Sized the offers from the balances: 2 listed. The next look is in 600 s.'], 'with its sentence, for the host\'s status');
    assert.ok(!s1.out.lines.some((l) => l.startsWith('Sizes its offers')), 'a host says the option in its status, not at each session');
    assert.deepEqual(kit.reads, { balances: 1, readFunds: 1, heartbeat: 0 });
    // Between two looks nothing is read: 5 syncs later the counts are the same.
    for (let i = 0; i < 5; i++) await vt.advance(60_000);
    assert.deepEqual(kit.reads, { balances: 1, readFunds: 1, heartbeat: 0 });
    s1.end.abort();
    assert.equal(await drive(vt, s1.p), SESSION_PAUSED);
    // The next session: both sized offers are still its entries, and the look is not due.
    await vt.advance(10_000);
    const s2 = session(kit, vt, cfg, saved);
    await until(vt, () => kit.count('run') >= 2, 'run() again', { stepMs: 1_000 });
    await vt.advance(5_000);
    assert.equal(kit.count('postOffer'), 2, 'nothing listed twice');
    assert.equal(kit.count('cancelOffer'), 0);
    assert.deepEqual(kit.reads, { balances: 1, readFunds: 1, heartbeat: 0 }, 'a session\'s start reads no balance while the look is not due');
    // A sale took 2 TAZ (from the offer and the balance alike), and 123 USDC came in.
    kit.left.set(1, tok('TAZ', '10.34'));
    kit.held.set('TAZ', tok('TAZ', '10.3456789'));
    kit.usdc = usdcToRaw('160.016447');
    await until(vt, () => kit.count('postOffer') >= 3, 'the buy offer sized again', { stepMs: 5_000, max: 200 });
    assert.ok(kit.calls.find((c) => c.fn === 'cancelOffer')!.at >= saved[0]! + 600_000, 'not before sizeEveryS');
    assert.deepEqual(kit.calls.filter((c) => c.fn === 'cancelOffer').map((c) => c.arg), [2], 'the sell offer, which a sale lowered with the balance, is left alone');
    assert.deepEqual(posts(kit)[2], { side: 'buy', symbol: 'C', total: '163.28', min: '2', max: '163.28', price: '0.98', acceptOnTheirOwn: true });
    assert.ok(s2.out.lines.includes('Offer #2 cancelled to list it again at what its mUSDC covers (it had 37.75 C left).'), s2.out.lines.join('\n'));
    assert.ok(s2.out.lines.includes('Listed offer #3: buy 163.28 C (2 to 163.28 per trade) at 0.98 mUSDC (what its mUSDC covers; the config allows up to 1000 C).'), s2.out.lines.join('\n'));
    assert.ok(s2.out.lines.includes('Sized the offers from the balances: 1 listed again, 1 left as listed. The next look is in 600 s.'), s2.out.lines.join('\n'));
    assert.equal(saved.length, 2);
    assert.deepEqual(kit.reads, { balances: 2, readFunds: 2, heartbeat: 3 }, 'one look: each balance once, each listing once, and the one it cancels once more right before');
    s2.end.abort();
    assert.equal(await drive(vt, s2.p), SESSION_PAUSED);
    // Turned off again: the config's totals are what is listed, as before the option.
    const s3 = session(kit, vt, hosted({ ...SIZED, sizeFromBalances: false }), saved);
    await until(vt, () => kit.count('run') >= 3, 'the third session', { stepMs: 1_000 });
    assert.equal(saved.length, 2, 'with the option off nothing is kept for the host');
    assert.deepEqual(posts(kit).slice(3), [
      { side: 'sell', symbol: 'TAZ', total: '30', min: '1', max: '5', price: '1.08', acceptOnTheirOwn: true },
      { side: 'buy', symbol: 'C', total: '1000', min: '2', max: '1000', price: '0.98', acceptOnTheirOwn: true }
    ]);
    assert.deepEqual(open(kit).map((o) => o.id), [4, 5]);
    s3.end.abort();
    assert.equal(await drive(vt, s3.p), SESSION_PAUSED);
  });

  test('the runner: offers listed before the option was on are kept and sized at the first look; an offer the config no longer lists is cancelled', async () => {
    const vt = new VTime();
    const kit = new FakeKit(vt.now);
    await kit.postOffer({ side: 'sell', ...SELL_TAZ });
    await kit.postOffer({ side: 'buy', symbol: 'C', total: '1000', min: '2', max: '1000', price: '0.98' });
    await kit.postOffer({ side: 'sell', symbol: 'RA', total: '6', min: '1', max: '2', price: '2.05' });
    kit.calls.length = 0;
    kit.held.set('TAZ', tok('TAZ', '30'));
    kit.usdc = usdcToRaw('50');
    const saved: number[] = [];
    const s = session(kit, vt, hosted(SIZED), saved);
    await started(vt, saved);
    assert.deepEqual(kit.calls.filter((c) => c.fn === 'cancelOffer').map((c) => c.arg), [3, 2], 'the RA offer first (the config no longer lists it), then the buy offer to size it');
    assert.deepEqual(posts(kit), [{ side: 'buy', symbol: 'C', total: '51.02', min: '2', max: '51.02', price: '0.98', acceptOnTheirOwn: true }]);
    assert.ok(s.out.lines.includes('Offer #3 cancelled: the config no longer lists it.'));
    assert.ok(s.out.lines.includes('Sized the offers from the balances: 1 listed again, 1 left as listed. The next look is in 600 s.'), s.out.lines.join('\n'));
    s.end.abort();
    assert.equal(await drive(vt, s.p), SESSION_PAUSED);
  });

  test('the runner: an offer a take waits on is looked at again at each sync, the others not; a look left unfinished comes again after 5 minutes', async () => {
    const vt = new VTime();
    const kit = new FakeKit(vt.now);
    await kit.postOffer({ side: 'sell', ...SELL_TAZ });
    await kit.postOffer(BID);
    kit.calls.length = 0;
    kit.held.set('TAZ', tok('TAZ', '30'));
    kit.usdc = usdcToRaw('160.016447');
    const saved: number[] = [];
    // A take on the buy offer waits for its answer: a cancel would cancel it.
    kit.takes.set(2, [{ id: 77, status: 'requested' }]);
    const s = session(kit, vt, hosted(SIZED), saved);
    await started(vt, saved);
    const t0 = ranAt(kit);
    assert.equal(kit.count('cancelOffer'), 0);
    assert.equal(saved.length, 1);
    about(saved[0], t0 - 600_000 + 300_000, 'kept so that the next look of every offer comes after 5 minutes, not after sizeEveryS');
    assert.ok(s.out.lines.some((l) => l.startsWith('Offer #2 is not sized now: a take on it waits for its answer')), s.out.lines.join('\n'));
    assert.ok(s.out.lines.includes('Sized the offers from the balances: 1 left as listed, 1 waiting for a take\'s answer. The next look is in 300 s (not every offer could be decided now).'), s.out.lines.join('\n'));
    assert.deepEqual(kit.reads, { balances: 1, readFunds: 1, heartbeat: 2 });
    // The take was accepted, and the bot keeps its record: the board's trade is one it knows. But the balance cannot be
    // read, then the board does not answer, then the cancel is refused: each time the listing stays, and only it is looked at.
    kit.takes.set(2, [{ id: 77, status: 'accepted' }]);
    kit.trades = [{ id: 77, offerId: 2, role: 'B', maker: true, symbol: 'C', taz: tok('C', '10').toString(), usdc: usdcToRaw('9.8').toString(), myPha: kit.address.pha, myBase: kit.address.base.toLowerCase(), txs: {}, status: 'accepted' } as unknown as LocalTrade];
    kit.left.set(2, tok('C', '27.75'));
    for (const what of ['readFunds', 'heartbeat', 'cancelOffer']) {
      kit.failing = new Set([what]);
      await vt.advance(60_000);
      assert.equal(kit.offers[1]!.closedAt, null, what);
      assert.equal(saved.length, 1, what);
    }
    assert.ok(s.out.lines.some((l) => /^The bot's mUSDC balance could not be read \(.*\): its buy offers stay as they are/.test(l)), s.out.lines.join('\n'));
    assert.ok(s.out.lines.some((l) => /^The board did not say what is left of offer #2/.test(l)), s.out.lines.join('\n'));
    assert.ok(s.out.lines.some((l) => /^Offer #2 could not be cancelled yet to size it/.test(l)), s.out.lines.join('\n'));
    kit.failing = new Set();
    await vt.advance(60_000);
    // 160.016447 USDC less the 9.8 its accepted trade still needs: 153.28 C at 0.98.
    assert.deepEqual(posts(kit), [{ side: 'buy', symbol: 'C', total: '153.28', min: '2', max: '153.28', price: '0.98', acceptOnTheirOwn: true }]);
    assert.deepEqual(saved, [saved[0], saved[0]! + 300_000], 'every offer decided: the next look is a whole sizeEveryS after the last one');
    assert.ok(s.out.lines.some((l) => /^Every offer is sized now\. The next look is in 3\d\d s\.$/.test(l)), s.out.lines.join('\n'));
    assert.equal(kit.offers[0]!.closedAt, null, 'the sell offer was never touched');
    s.end.abort();
    assert.equal(await drive(vt, s.p), SESSION_PAUSED);
    // A look that could not read a balance: nothing changes, and it comes again after 5 minutes (not at every sync).
    const vt2 = new VTime();
    const kit2 = new FakeKit(vt2.now);
    await kit2.postOffer(BID);
    kit2.usdc = usdcToRaw('160.016447');
    kit2.failing = new Set(['readFunds']);
    const saved2: number[] = [];
    const s2 = session(kit2, vt2, hosted({ bids: SIZED.bids, sizeFromBalances: true, sizeEveryS: 3600 }), saved2);
    await started(vt2, saved2);
    assert.equal(saved2.length, 1);
    about(saved2[0], ranAt(kit2) - 3_600_000 + 300_000, 'the next look comes after 5 minutes');
    for (let i = 0; i < 4; i++) await vt2.advance(60_000);
    assert.equal(kit2.reads.readFunds, 1, 'not read again at every sync');
    kit2.failing = new Set();
    await until(vt2, () => kit2.count('postOffer') >= 2, 'the look, made again', { stepMs: 5_000, max: 30 });
    assert.equal(kit2.reads.readFunds, 2);
    assert.equal(saved2.length, 2);
    assert.ok(saved2[1]! >= saved2[0]! + 3_600_000, 'made when it was due again');
    s2.end.abort();
    assert.equal(await drive(vt2, s2.p), SESSION_PAUSED);
  });

  test('the runner: right before a cancel the board is asked once more, and a take that came in since is not cancelled; after a refusal nothing more is cancelled in that look', async () => {
    const vt = new VTime();
    const kit = new FakeKit(vt.now);
    await kit.postOffer(BID);
    kit.calls.length = 0;
    kit.usdc = usdcToRaw('160.016447');
    const saved: number[] = [];
    // The take arrives between the look's first answer from the board and the cancel.
    const heartbeat = kit.board.heartbeat;
    let asked = 0;
    kit.board.heartbeat = async (id: number, token: string) => {
      if (++asked === 2) kit.takes.set(1, [{ id: 78, status: 'requested' }]);
      return heartbeat(id, token);
    };
    const s = session(kit, vt, hosted({ bids: SIZED.bids, sizeFromBalances: true, sizeEveryS: 600 }), saved);
    await started(vt, saved);
    assert.equal(asked, 2);
    assert.equal(kit.count('cancelOffer'), 0, 'the take is not cancelled with the offer');
    assert.ok(s.out.lines.some((l) => l.includes('1 waiting for a take\'s answer')), s.out.lines.join('\n'));
    // What is left changed since the plan was made (the take was accepted meanwhile): decided afresh at the next sync.
    kit.takes.set(1, []);
    kit.left.set(1, tok('C', '30'));
    await vt.advance(60_000);
    assert.equal(kit.count('cancelOffer'), 1);
    assert.equal((posts(kit)[0] as OfferInput).total, '163.28');
    s.end.abort();
    assert.equal(await drive(vt, s.p), SESSION_PAUSED);
    // Two offers to list again, and the board refuses the first new listing: the second is not cancelled in that look.
    const vt2 = new VTime();
    const kit2 = new FakeKit(vt2.now);
    await kit2.postOffer({ side: 'sell', ...SELL_TAZ, total: '10', max: '5' });
    await kit2.postOffer(BID);
    kit2.calls.length = 0;
    kit2.held.set('TAZ', tok('TAZ', '30'));
    kit2.usdc = usdcToRaw('160.016447');
    kit2.failing = new Set(['postOffer']);
    const saved2: number[] = [];
    const s2 = session(kit2, vt2, hosted(SIZED), saved2);
    await started(vt2, saved2);
    assert.deepEqual(kit2.calls.filter((c) => c.fn === 'cancelOffer').map((c) => c.arg), [1], 'the buy offer stays listed');
    assert.deepEqual(open(kit2).map((o) => o.id), [2]);
    assert.equal(saved2.length, 1);
    about(saved2[0], ranAt(kit2) - 600_000 + 300_000, 'the look is not done: it comes again after 5 minutes');
    assert.ok(s2.out.lines.some((l) => l.startsWith('Could not list sell 30 TAZ')), s2.out.lines.join('\n'));
    // The sell offer is listed at the next sync, like any entry without a listing; the buy offer at the look after.
    kit2.failing = new Set();
    await vt2.advance(60_000);
    assert.deepEqual(open(kit2).map((o) => o.tazTotal), [tok('C', '37.75').toString(), tok('TAZ', '30').toString()]);
    await until(vt2, () => kit2.count('postOffer') >= 3, 'the buy offer, at the next look', { stepMs: 5_000, max: 80 });
    assert.equal((posts(kit2)[2] as OfferInput).total, '163.28');
    s2.end.abort();
    assert.equal(await drive(vt2, s2.p), SESSION_PAUSED);
  });

  test('the runner: what is left changed between the plan and the cancel, or the board shows a trade the bot has not kept yet: nothing is cancelled, and the next sync decides afresh', async () => {
    // Between the look's first answer and the cancel a take came in and was accepted at once: no take waits, but less is left.
    const vt = new VTime();
    const kit = new FakeKit(vt.now);
    await kit.postOffer(BID);
    kit.calls.length = 0;
    kit.usdc = usdcToRaw('160.016447');
    const heartbeat = kit.board.heartbeat;
    let asked = 0;
    kit.board.heartbeat = async (id: number, token: string) => {
      if (++asked === 2) kit.left.set(1, tok('C', '30'));
      return heartbeat(id, token);
    };
    const cfg = hosted({ bids: SIZED.bids, sizeFromBalances: true, sizeEveryS: 600 });
    const saved: number[] = [];
    const s = session(kit, vt, cfg, saved);
    await started(vt, saved);
    assert.equal(asked, 2);
    assert.equal(kit.count('cancelOffer'), 0, 'the plan was made for 37.75 C left: not carried out on 30');
    await vt.advance(60_000);
    assert.equal(kit.count('cancelOffer'), 1);
    assert.ok(s.out.lines.includes('Offer #1 cancelled to list it again at what its mUSDC covers (it had 30 C left).'), s.out.lines.join('\n'));
    s.end.abort();
    assert.equal(await drive(vt, s.p), SESSION_PAUSED);
    // The board shows an accepted trade on the offer that the bot's own records do not hold yet: what it still needs is
    // not known, so the offer waits until the record is there.
    const vt2 = new VTime();
    const kit2 = new FakeKit(vt2.now);
    await kit2.postOffer(BID);
    kit2.calls.length = 0;
    kit2.usdc = usdcToRaw('160.016447');
    kit2.left.set(1, tok('C', '27.75'));
    kit2.takes.set(1, [{ id: 99, status: 'accepted' }]);
    const saved2: number[] = [];
    const s2 = session(kit2, vt2, cfg, saved2);
    await started(vt2, saved2);
    assert.equal(kit2.count('cancelOffer'), 0);
    assert.ok(s2.out.lines.some((l) => l.includes('1 waiting for a take\'s answer')), s2.out.lines.join('\n'));
    kit2.trades = [{ id: 99, offerId: 1, role: 'B', maker: true, symbol: 'C', taz: tok('C', '10').toString(), usdc: usdcToRaw('9.8').toString(), myPha: kit2.address.pha, myBase: kit2.address.base.toLowerCase(), txs: {}, status: 'accepted' } as unknown as LocalTrade];
    await vt2.advance(60_000);
    assert.deepEqual(posts(kit2), [{ side: 'buy', symbol: 'C', total: '153.28', min: '2', max: '153.28', price: '0.98', acceptOnTheirOwn: true }], 'sized without the 9.8 USDC that trade still needs');
    s2.end.abort();
    assert.equal(await drive(vt2, s2.p), SESSION_PAUSED);
  });

  test('the runner: a listing that fails after its cancel is listed at the next sync (two minutes later when its answer was lost); an offer the bot holds too little for is not read again at every sync', async () => {
    const vt = new VTime();
    const kit = new FakeKit(vt.now);
    await kit.postOffer(BID);
    kit.calls.length = 0;
    kit.usdc = usdcToRaw('100');
    const cfg = hosted({ bids: SIZED.bids, sizeFromBalances: true, sizeEveryS: 3600 });
    const saved: number[] = [];
    kit.failing = new Set(['postOffer']);
    const s = session(kit, vt, cfg, saved);
    await started(vt, saved);
    assert.equal(kit.count('cancelOffer'), 1);
    assert.equal(open(kit).length, 0, 'cancelled, and not listed yet');
    assert.equal(saved.length, 1);
    about(saved[0], ranAt(kit), 'the look itself is done: the entry is listed like any entry without a listing');
    assert.ok(s.out.lines.some((l) => l.startsWith('Could not list buy 102.04 C')), s.out.lines.join('\n'));
    kit.failing = new Set();
    await vt.advance(60_000);
    assert.deepEqual(open(kit).map((o) => o.tazTotal), [tok('C', '102.04').toString()]);
    s.end.abort();
    assert.equal(await drive(vt, s.p), SESSION_PAUSED);
    // The board's answer to the listing was lost: the offer may exist, so it is not sent again until the kit has settled that.
    const vt3 = new VTime();
    const kit3 = new FakeKit(vt3.now);
    kit3.usdc = usdcToRaw('100');
    const post = kit3.postOffer.bind(kit3);
    let lost = true;
    kit3.postOffer = async (o: OfferInput) => {
      if (!lost) return post(o);
      lost = false;
      kit3.calls.push({ fn: 'postOffer', arg: o, at: vt3.now() });
      throw new CreateError(new BoardError('NETWORK', 0, true), { kind: 'offer', tokenHash: 'cd'.repeat(32), mayExist: true });
    };
    const saved3: number[] = [];
    const s3 = session(kit3, vt3, cfg, saved3);
    await started(vt3, saved3);
    assert.equal(kit3.count('postOffer'), 1);
    await vt3.advance(60_000);
    assert.equal(kit3.count('postOffer'), 1, 'one sync later: not sent again yet');
    await vt3.advance(120_000);
    assert.equal(kit3.count('postOffer'), 2, 'after two minutes it is');
    assert.equal(open(kit3).length, 1);
    s3.end.abort();
    assert.equal(await drive(vt3, s3.p), SESSION_PAUSED);
    // ... also when another entry is listed meanwhile: the look that lists the buy offer a minute later leaves the sell offer alone.
    const vt4 = new VTime();
    const kit4 = new FakeKit(vt4.now);
    kit4.held.set('TAZ', tok('TAZ', '30'));
    kit4.usdc = usdcToRaw('100');
    const post4 = kit4.postOffer.bind(kit4);
    let lost4 = true;
    kit4.postOffer = async (o: OfferInput) => {
      if (!lost4) return post4(o);
      lost4 = false;
      kit4.calls.push({ fn: 'postOffer', arg: o, at: vt4.now() });
      throw new CreateError(new BoardError('NETWORK', 0, true), { kind: 'offer', tokenHash: 'cd'.repeat(32), mayExist: true });
    };
    const saved4: number[] = [];
    const s4 = session(kit4, vt4, hosted({ ...SIZED, sizeEveryS: 3600 }), saved4);
    await started(vt4, saved4);
    assert.deepEqual(posts(kit4).map((o) => (o as OfferInput).symbol), ['TAZ'], 'after the lost answer nothing more is listed in that look');
    await vt4.advance(60_000);
    assert.deepEqual(posts(kit4).map((o) => (o as OfferInput).symbol), ['TAZ', 'C'], 'the buy offer is listed at the next sync; the sell offer is not sent again yet');
    await vt4.advance(120_000);
    assert.deepEqual(posts(kit4).map((o) => (o as OfferInput).symbol), ['TAZ', 'C', 'TAZ']);
    assert.equal(open(kit4).length, 2);
    s4.end.abort();
    assert.equal(await drive(vt4, s4.p), SESSION_PAUSED);
    // Too little for the smallest trade: said once, and read again only every 5 minutes.
    const vt2 = new VTime();
    const kit2 = new FakeKit(vt2.now);
    kit2.usdc = usdcToRaw('1.5');
    const saved2: number[] = [];
    const s2 = session(kit2, vt2, cfg, saved2);
    await started(vt2, saved2);
    assert.equal(kit2.reads.readFunds, 1);
    assert.ok(s2.out.lines.includes('Not listing buy 1000 C (2 to 1000 per trade) at 0.98 mUSDC now: this bot\'s Base address holds 1.5 mUSDC, less than the smallest trade needs (1.96 mUSDC).'), s2.out.lines.join('\n'));
    for (let i = 0; i < 4; i++) await vt2.advance(60_000);
    assert.equal(kit2.reads.readFunds, 1, 'four syncs later: not read again');
    await vt2.advance(120_000);
    assert.equal(kit2.reads.readFunds, 2, 'after five minutes it looks again');
    assert.equal(s2.out.lines.filter((l) => l.startsWith('Not listing buy 1000 C')).length, 1, s2.out.lines.join('\n'));
    // The USDC arrives: listed at the next look at that entry, without waiting for the timed one.
    kit2.usdc = usdcToRaw('20');
    await until(vt2, () => kit2.count('postOffer') >= 1, 'the offer listed', { stepMs: 5_000, max: 80 });
    assert.equal((posts(kit2)[0] as OfferInput).total, '20.4');
    s2.end.abort();
    assert.equal(await drive(vt2, s2.p), SESSION_PAUSED);
  });

  test('the runner: an offer its own trades have used up is looked at without waiting for the timed look, once', async () => {
    const vt = new VTime();
    const kit = new FakeKit(vt.now);
    kit.usdc = usdcToRaw('37');
    const cfg = hosted({ bids: SIZED.bids, sizeFromBalances: true, sizeEveryS: 3600 });
    const saved: number[] = [];
    const s = session(kit, vt, cfg, saved);
    await started(vt, saved);
    assert.deepEqual(posts(kit), [{ ...BID, acceptOnTheirOwn: true }]);
    const mineOf = (o: Partial<LocalTrade>) => ({ offerId: 1, role: 'B', maker: true, symbol: 'C', myPha: kit.address.pha, myBase: kit.address.base.toLowerCase(), txs: {}, ...o }) as unknown as LocalTrade;
    // A take that was never accepted is given back: the offer is not used up, and nothing is read for it.
    kit.trades = [mineOf({ id: 5, taz: tok('C', '37').toString(), usdc: usdcToRaw('36.26').toString(), status: 'cancelled', endedAt: vt.now() })];
    for (let i = 0; i < 3; i++) await vt.advance(60_000);
    assert.deepEqual(kit.reads, { balances: 1, readFunds: 1, heartbeat: 0 });
    // A seller took 36.5 C and the trade is done: 1.25 C left, under the smallest trade. The USDC is spent, so the offer is taken down ...
    kit.trades = [mineOf({ id: 6, taz: tok('C', '36.5').toString(), usdc: usdcToRaw('35.77').toString(), status: 'done', endedAt: vt.now() })];
    kit.left.set(1, tok('C', '1.25'));
    kit.usdc = usdcToRaw('1.23');
    await vt.advance(60_000);
    assert.deepEqual(kit.calls.filter((c) => c.fn === 'cancelOffer').map((c) => c.arg), [1]);
    assert.ok(s.out.lines.includes('Offer #1 cancelled: this bot\'s Base address holds 1.23 mUSDC, less than the smallest trade needs (1.96 mUSDC).'), s.out.lines.join('\n'));
    assert.equal(saved.length, 1, 'the timed look is not moved');
    // ... and listed again once the bot's own sale has brought USDC, well before the timed look.
    kit.usdc = usdcToRaw('122.77');
    await until(vt, () => kit.count('postOffer') >= 2, 'the offer listed again', { stepMs: 5_000, max: 80 });
    assert.equal((posts(kit)[1] as OfferInput).total, '125.27');
    assert.ok(vt.now() < saved[0]! + 3_600_000 - 2_000_000, 'long before the timed look');
    // Used up by the bot's records, but the board says otherwise and nothing is to change: looked at once, not at every sync.
    kit.trades = [mineOf({ id: 7, offerId: 2, taz: tok('C', '125').toString(), usdc: usdcToRaw('122.5').toString(), status: 'expired', endedAt: vt.now() })];
    const before = kit.reads.heartbeat;
    for (let i = 0; i < 4; i++) await vt.advance(60_000);
    assert.equal(kit.reads.heartbeat, before + 1);
    assert.deepEqual(open(kit).map((o) => o.id), [2]);
    s.end.abort();
    assert.equal(await drive(vt, s.p), SESSION_PAUSED);
  });

  test('the runner: a take holds an offer\'s sizing back for three looks at most; an offer the board has closed is listed afresh; a total that is the limit is said', async () => {
    // A take that is never answered (the bot cannot fund it): after three looks the offer is cancelled all the same.
    const vt = new VTime();
    const kit = new FakeKit(vt.now);
    await kit.postOffer(BID);
    kit.calls.length = 0;
    kit.usdc = usdcToRaw('160.016447');
    kit.takes.set(1, [{ id: 77, status: 'requested' }]);
    const saved: number[] = [];
    const s = session(kit, vt, hosted({ bids: SIZED.bids, sizeFromBalances: true, sizeEveryS: 600 }), saved);
    await started(vt, saved);
    for (let i = 0; i < 2; i++) await vt.advance(60_000);
    assert.equal(kit.count('cancelOffer'), 0, 'three looks: it waits');
    await vt.advance(60_000);
    assert.equal(kit.count('cancelOffer'), 1, 'the fourth: cancelled, and the take with it');
    assert.equal((posts(kit)[0] as OfferInput).total, '163.28');
    s.end.abort();
    assert.equal(await drive(vt, s.p), SESSION_PAUSED);
    // The board has closed the offer (it was filled while no session ran) and the bot's record does not know yet.
    const vt2 = new VTime();
    const kit2 = new FakeKit(vt2.now);
    await kit2.postOffer(BID);
    kit2.calls.length = 0;
    kit2.usdc = usdcToRaw('50');
    const heartbeat = kit2.board.heartbeat;
    kit2.board.heartbeat = async (id: number, token: string) => {
      if (id === 1) throw new BoardError('CLOSED', 409, false);
      return heartbeat(id, token);
    };
    const saved2: number[] = [];
    const s2 = session(kit2, vt2, hosted({ bids: SIZED.bids, sizeFromBalances: true }), saved2);
    await started(vt2, saved2);
    assert.ok(s2.out.lines.includes('Offer #1 is closed on the board: the bot lists its entry afresh.'), s2.out.lines.join('\n'));
    assert.deepEqual(open(kit2).map((o) => o.tazTotal), [tok('C', '51.02').toString()]);
    assert.ok(s2.out.lines.includes('Sized the offers from the balances: 1 listed. The next look is in 3600 s.'), s2.out.lines.join('\n'));
    s2.end.abort();
    assert.equal(await drive(vt2, s2.p), SESSION_PAUSED);
    // The entry's total was written for an earlier balance: the offer cannot grow, and the look says so.
    const vt3 = new VTime();
    const kit3 = new FakeKit(vt3.now);
    await kit3.postOffer(BID);
    kit3.calls.length = 0;
    kit3.usdc = usdcToRaw('160.016447');
    const saved3: number[] = [];
    const said3: string[] = [];
    const s3 = session(kit3, vt3, hosted({ bids: [{ symbol: 'C', total: '37.75', min: '2', max: '37.75', price: '0.98' }], sizeFromBalances: true }), saved3, said3);
    await started(vt3, saved3);
    assert.equal(kit3.count('cancelOffer') + kit3.count('postOffer'), 0);
    assert.deepEqual(said3, ['Sized the offers from the balances: 1 left as listed. The config\'s total is the limit for: buy C (its total is 37.75 C; its mUSDC covers 163.28 C). Raise total and max there to list more. The next look is in 3600 s.']);
    s3.end.abort();
    assert.equal(await drive(vt3, s3.p), SESSION_PAUSED);
  });

  test('the runner: a stop during a look lists nothing after the cancel; without the option on, no balance of a listed offer is ever read', async () => {
    const vt = new VTime();
    const kit = new FakeKit(vt.now);
    await kit.postOffer(BID);
    kit.calls.length = 0;
    kit.usdc = usdcToRaw('100');
    const signals = new EventEmitter();
    const out = sink();
    // The stop arrives while the cancel is on its way.
    const cancel = kit.cancelOffer.bind(kit);
    kit.cancelOffer = async (id: number) => { signals.emit('SIGTERM'); await cancel(id); };
    const p = trade(kit as unknown as BotKit, hosted({ bids: SIZED.bids, sizeFromBalances: true, holdBack: { USDC: '5' } }), { say: out.out, usdc: 'mUSDC', now: vt.now, sleep: vt.sleep, signals });
    assert.equal(await drive(vt, p), 0);
    assert.equal(out.lines[0], 'Sizes its offers from the balances, looking every 3600 s: each offer lists what the bot holds (a buy offer: what its mUSDC covers), at most its total; it holds back 5 mUSDC.', 'a run on a machine says so once, at its start');
    assert.equal(kit.count('postOffer'), 0, out.lines.join('\n'));
    assert.equal(open(kit).length, 0);
    // Off: the offer stays at the config's total whatever the balance, and nothing reads a balance for it.
    const kit2 = new FakeKit(vt.now);
    kit2.usdc = usdcToRaw('100');
    const end = new AbortController();
    const p2 = trade(kit2 as unknown as BotKit, hosted({ bids: SIZED.bids }), { say: sink().out, usdc: 'mUSDC', now: vt.now, sleep: vt.sleep, signals: new EventEmitter(), session: { until: end.signal } });
    await until(vt, () => kit2.count('run') >= 1, 'the start', { stepMs: 1_000 });
    for (let i = 0; i < 70; i++) await vt.advance(60_000);
    assert.deepEqual(posts(kit2), [{ side: 'buy', symbol: 'C', total: '1000', min: '2', max: '1000', price: '0.98', acceptOnTheirOwn: true }]);
    assert.deepEqual(kit2.reads, { balances: 0, readFunds: 1, heartbeat: 0 }, 'one read, before it was listed, as before');
    end.abort();
    assert.equal(await drive(vt, p2), SESSION_PAUSED);
  });

  test('--dry-run with the option: what a look would do now, from the balances and the board\'s public list', async () => {
    const vt = new VTime();
    const kit = new FakeKit(vt.now);
    await kit.postOffer({ side: 'sell', ...SELL_TAZ });
    await kit.postOffer(BID);
    await kit.postOffer({ side: 'sell', symbol: 'RA', total: '6', min: '1', max: '2', price: '2.05' });
    kit.calls.length = 0;
    kit.held.set('TAZ', tok('TAZ', '30'));
    kit.held.set('KCAL', tok('KCAL', '5'));
    kit.usdc = usdcToRaw('160.016447');
    kit.book = [{ id: 1, symbol: 'TAZ', side: 'sell', price: '1080000', remaining: tok('TAZ', '30').toString() }, { id: 2, symbol: 'C', side: 'buy', price: '980000', remaining: tok('C', '37.75').toString() }] as unknown as Offer[];
    const cfg = hosted({ ...SIZED, offers: [...SIZED.offers, { symbol: 'KCAL', total: '100', min: '1', max: '100', price: '1.50' }], holdBack: { USDC: '10', KCAL: '1', C: '0' } });
    const out = sink();
    assert.equal(await dryRunRest(kit as unknown as BotKit, cfg, { say: out.out, usdc: 'mUSDC', blocking: [], refused: () => ({ boardWrites: 0, chainSends: 0 }) }), 0);
    const lines = out.lines.join('\n');
    assert.ok(out.lines.includes('Sizes its offers from the balances, looking every 600 s: each offer lists what the bot holds (a buy offer: what its mUSDC covers), at most its total; it holds back 10 mUSDC, 1 KCAL.'), lines);
    assert.ok(out.lines.includes('Would cancel offer #3: the config no longer lists it.'), lines);
    assert.ok(out.lines.includes('Would keep offer #1 listed: sell 30 TAZ (1 to 5 per trade) at 1.08 mUSDC.'), lines);
    assert.ok(out.lines.includes('Would not list sell 100 KCAL (1 to 100 per trade) at 1.50 mUSDC yet: this bot\'s Phantasma address holds 5 KCAL, of which 0 KCAL are free for this offer, less than the smallest trade (1 KCAL).'), lines);
    assert.ok(out.lines.includes('Would cancel offer #2, which has 37.75 C left, and list it again at what its mUSDC covers: buy 153.07 C (2 to 153.07 per trade) at 0.98 mUSDC (what its mUSDC covers; the config allows up to 1000 C).'), lines);
    assert.equal(kit.count('postOffer') + kit.count('cancelOffer') + kit.reads.heartbeat, 0, 'a dry run sends nothing, not even a heartbeat');
  });
});

describe('guardProcess (mainOf): a lost output or a hangup never cuts a clean stop short', () => {
  test('EPIPE (a log pipe that closed) and EIO (a terminal that is gone) on stdout or stderr are swallowed; any other error still throws', () => {
    const { p } = fakeProcess(true);
    guardProcess(p);
    const err = (code: string) => Object.assign(new Error(code), { code });
    for (const s of [p.stdout, p.stderr]) {
      assert.doesNotThrow(() => s.emit('error', err('EPIPE')));
      assert.doesNotThrow(() => s.emit('error', err('EIO')));
      assert.throws(() => s.emit('error', err('ENOSPC')), /ENOSPC/);
    }
  });

  test('a hangup with a terminal on the input becomes SIGTERM, the runner\'s clean stop; with none (a service, </dev/null) it is ignored', () => {
    const attended = fakeProcess(true);
    guardProcess(attended.p);
    attended.hangUp();
    attended.hangUp(); // the kernel's and the shell's: still one stop, never a second press that exits at once
    assert.deepEqual(attended.kills, [[4242, 'SIGTERM']]);
    for (const isTTY of [false, undefined]) {
      const unattended = fakeProcess(isTTY);
      guardProcess(unattended.p);
      unattended.hangUp();
      assert.deepEqual(unattended.kills, []);
    }
  });
});

describe('new-keys.ts', () => {
  test('writes 0600 key files in a 0700 folder, prints only the addresses and the faucet commands, and never replaces a file', async () => {
    const d = await tempDir();
    const out = sink();
    assert.equal(await newKeysMain({ argv: [], cwd: d, out: out.out }), 0);
    const dir = join(d, 'keys');
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    const files = ['seller-pha.json', 'seller-base.json', 'buyer-pha.json', 'buyer-base.json'].map((f) => join(dir, f));
    assert.deepEqual((await readdir(dir)).sort(), ['buyer-base.json', 'buyer-pha.json', 'seller-base.json', 'seller-pha.json']);
    for (const f of files) assert.equal((await stat(f)).mode & 0o777, 0o600, f);
    const material = await keyMaterial(files);
    assertNoSecrets(out.lines, material);
    for (const name of ['seller', 'buyer']) {
      const k = await loadKeys({ network: 'devnet', phaKeyFile: join(dir, `${name}-pha.json`), baseKeyFile: join(dir, `${name}-base.json`), argv: [] });
      assert.ok(out.lines.includes(`  Fund it on devnet: npm run faucet -- --pha ${k.address.pha} --base ${k.address.base}`), name);
    }
    assert.ok(out.lines.some((l) => /data folder when you upgrade the kit/.test(l) && /Upgrading the kit/.test(l)), 'it says to keep the keys and the data across an upgrade');
    const before = await Promise.all(files.map((f) => readFile(f, 'utf8')));
    const again = sink();
    assert.equal(await newKeysMain({ argv: [], cwd: d, out: again.out }), 0);
    assert.deepEqual(await Promise.all(files.map((f) => readFile(f, 'utf8'))), before, 'nothing was replaced');
    assert.ok(again.lines.includes('seller: already there; left as it is'));
    assertNoSecrets(again.lines, material);
  });

  test('refuses a key-shaped argument, and leaves half a pair alone', async () => {
    const d = await tempDir();
    const out = sink();
    assert.equal(await newKeysMain({ argv: ['--name', '0x' + 'ab'.repeat(32)], cwd: d, out: out.out }), 2);
    assert.match(out.lines.join('\n'), /looks like a key/);
    const dir = join(d, 'keys');
    const made = await makeKeyPairs(dir, ['solo']);
    assert.equal(made[0]!.created, true);
    await rm(join(dir, 'solo-base.json'));
    const half = sink();
    assert.equal(await newKeysMain({ argv: ['--name', 'solo'], cwd: d, out: half.out }), 1);
    assert.match(half.lines.join('\n'), /only .*solo-pha\.json is there; nothing was written/);
    await assert.rejects(stat(join(dir, 'solo-base.json')));
    assert.equal(await newKeysMain({ argv: ['--name', '../x'], cwd: d, out: sink().out }), 1);
  });
});

// ── 5. faucet.ts ────────────────────────────────────────────────────────────

describe('faucet.ts', () => {
  test('funds both addresses of a bot; a second claim is the faucet\'s limit; --info; a key-shaped argument is refused', async () => {
    const w = world();
    const pha = newPha(), base = newBase();
    const f = w.board.fetch as typeof fetch;
    const out = sink();
    assert.equal(await faucetMain({ argv: ['--pha', pha, '--base', base, '--api', 'http://127.0.0.1:9'], fetch: f, out: out.out }), 0, out.lines.join('\n'));
    const text = out.lines.join('\n');
    assert.match(text, /Phantasma: 20 TAZ, 2 RA, 3 SOUL, 30 KCAL \(confirmed\)/);
    assert.match(text, /Base Sepolia: 500 mUSDC, 0\.0005 ETH \(confirmed\)/);
    assert.ok(!/[0-9a-f]{64}/i.test(text), 'transaction hashes are shortened');
    assert.equal(w.base.usdc.get(base.toLowerCase()), 500_000_000n);
    const again = sink();
    assert.equal(await faucetMain({ argv: ['--pha', pha, '--base', base, '--api', 'http://127.0.0.1:9'], fetch: f, out: again.out }), 1);
    assert.match(again.lines.join('\n'), /already served this address in the last 24 hours\. Try again in about 24 hours\./);
    const info = sink();
    assert.equal(await faucetMain({ argv: ['--info', '--api', 'http://127.0.0.1:9'], fetch: f, out: info.out }), 0);
    assert.match(info.lines.join('\n'), /One claim sends: 20 TAZ, 2 RA, 3 SOUL, 30 KCAL, 500 mUSDC, 0\.0005 ETH\./);
    const calls = w.board.calls.length;
    const wif = PhantasmaKeys.generate().toWIF();
    const refused = sink();
    assert.equal(await faucetMain({ argv: ['--pha', wif], fetch: f, out: refused.out }), 2);
    assert.ok(!refused.lines.join('\n').includes(wif));
    assert.equal(await faucetMain({ argv: [], fetch: f, out: sink().out }), 2, 'no address');
    assert.equal(w.board.calls.length, calls, 'refused before any request');
  });
});

// ── 6. prune.ts ─────────────────────────────────────────────────────────────

/** A store with trades and secrets in every state prune.ts tells apart. */
async function pruneFixture() {
  const d = await tempDir();
  const dataDir = join(d, 'data');
  const store = await openStore({ dataDir, network: 'devnet', keyFile: null, env: {} });
  const now = (T0 + 30 * 86_400) * 1000;
  const sPha = newPha(), bPha = newPha(), sBase = newBase().toLowerCase(), bBase = newBase().toLowerCase();
  const add = async (id: number, o: { endedDaysAgo?: number; openIntent?: boolean } = {}) => {
    const rec: LocalTrade = {
      id, network: 'devnet', offerId: id, role: 'S', maker: true, symbol: 'TAZ', taz: '2000000000', usdc: '2160000', price: '1080000',
      myPha: sPha, myBase: sBase, counterPha: bPha, counterBase: bBase, txs: {}, createdAt: now - 40 * DAY, updatedAt: now - 40 * DAY
    };
    await store.addTrade(rec);
    const sec = makeSecretRecord({ tradeId: id, network: 'devnet', symbol: 'TAZ', taz: rec.taz, sPha, bPha, role: 'S' }, now - 40 * DAY);
    await store.putSecret(sec);
    await store.patchTrade(id, { h: sec.h, phaContract: P2P_CONFIG.devnet.phaContract, ...(o.endedDaysAgo !== undefined ? { endedAt: now - o.endedDaysAgo * DAY, status: 'done' as const } : { status: 'base_locked' as const }) });
    if (o.openIntent) await store.addIntent(id, { kind: 'claimBase', h: sec.h });
    return sec.h;
  };
  const h = {
    final: await add(1, { endedDaysAgo: 8 }),
    young: await add(2, { endedDaysAgo: 6 }),
    running: await add(3),
    usdcOpen: await add(4, { endedDaysAgo: 8 }),
    intentOpen: await add(5, { endedDaysAgo: 8, openIntent: true }),
    phaOpen: await add(6, { endedDaysAgo: 8 }),
    neverLocked: await add(8, { endedDaysAgo: 9 })
  };
  const orphan = makeSecretRecord({ tradeId: 99, network: 'devnet', symbol: 'TAZ', taz: '1000000000', sPha, bPha, role: 'S' }, now - 40 * DAY);
  await store.putSecret(orphan);
  // The chains: claimed, refunded or never made is final; 1 is open.
  const pha = new Map<string, number>([[h.final, 2], [h.young, 2], [h.running, 1], [h.usdcOpen, 2], [h.intentOpen, 2], [h.phaOpen, 1], [h.neverLocked, 0]]);
  const usdc = new Map<string, number>([[h.final, 2], [h.young, 2], [h.running, 1], [h.usdcOpen, 1], [h.intentOpen, 2], [h.phaOpen, 0], [h.neverLocked, 0]]);
  const chains = {
    pha: { readLock: async (_c: unknown, x: string) => ({ state: pha.get(x) ?? 0 }) },
    base: {
      readSwap: async (x: string, sender: string) => {
        assert.equal(sender, bBase, 'the USDC lock is read under the buyer\'s address');
        return { swap: { state: usdc.get(x) ?? 0 }, blockTime: 0 };
      }
    }
  } as unknown as PruneChains;
  return { d, dataDir, store, now, h, orphan: orphan.h, chains, pha, usdc, sPha, bPha, bBase };
}

describe('prune.ts', () => {
  test('removes only secrets of finished trades whose locks are final, 7 days on; everything else is kept with its reason', async () => {
    const f = await pruneFixture();
    const all = (await f.store.listSecrets()).length;
    const dry = await pruneSecrets({ store: f.store, chains: f.chains, network: 'devnet', now: f.now, dryRun: true });
    assert.equal((await f.store.listSecrets()).length, all, 'a dry run removes nothing');
    const why = new Map(dry.map((r) => [r.h, r]));
    assert.deepEqual(dry.filter((r) => r.removed).map((r) => r.h).sort(), [f.h.final, f.h.neverLocked].sort());
    assert.match(why.get(f.h.young)!.why, /finished 6\.0 days ago; secrets are kept 7 days after/);
    assert.match(why.get(f.h.running)!.why, /is not finished for the kit/);
    assert.match(why.get(f.h.usdcOpen)!.why, /USDC lock under this hash is still open/);
    assert.match(why.get(f.h.intentOpen)!.why, /send whose outcome is still open \(claimBase\)/);
    assert.match(why.get(f.h.phaOpen)!.why, /Phantasma lock under this hash is still open/);
    assert.match(why.get(f.orphan)!.why, /keeps no record of trade #99/);
    // --days can only raise the wait.
    const later = await pruneSecrets({ store: f.store, chains: f.chains, network: 'devnet', now: f.now, days: 30, dryRun: true });
    assert.equal(later.filter((r) => r.removed).length, 0);
    const lower = await pruneSecrets({ store: f.store, chains: f.chains, network: 'devnet', now: f.now, days: 1, dryRun: true });
    assert.equal(lower.filter((r) => r.removed).length, 2, 'never fewer than 7 days');
    assert.equal(KEEP_DAYS, 7);
    // A read that fails keeps the secret.
    const broken = { pha: { readLock: async () => { throw new Error('node down'); } }, base: f.chains.base } as unknown as PruneChains;
    assert.equal((await pruneSecrets({ store: f.store, chains: broken, network: 'devnet', now: f.now })).filter((r) => r.removed).length, 0);
    const done = await pruneSecrets({ store: f.store, chains: f.chains, network: 'devnet', now: f.now });
    assert.equal(done.filter((r) => r.removed).length, 2);
    const left = (await f.store.listSecrets()).map((s) => s.h);
    assert.equal(left.length, all - 2);
    assert.ok(!left.includes(f.h.final) && !left.includes(f.h.neverLocked));
    await f.store.close();
  });

  test('the script refuses while the bot holds the data folder, reads the chains through their transports, and prints no secret', async () => {
    const f = await pruneFixture();
    const w = world();
    // The same chain states, on the fake nodes.
    const lockOf = (state: number) => ({ state, sender: f.sPha, recipient: f.bPha, symbol: 'TAZ', amount: 2_000_000_000n, deadline: T0, created: T0 - 2400, ...(state === 2 ? { secret: '0x' + '11'.repeat(32) } : {}) });
    for (const [h, s] of f.pha) if (s) w.pha.locks.set(h, lockOf(s));
    for (const [h, s] of f.usdc) {
      if (s) w.base.swaps.set(`${h}|${f.bBase}`, { token: CFG.base.usdc.toLowerCase(), deadline: T0, feeBps: 50, sender: f.bBase, claimer: f.bBase, amount: 2_160_000n, block: 0n, ...(s === 2 ? { claimedBlock: 0n } : {}) });
    }
    const secrets = (await f.store.listSecrets()).map((s) => s.secret.toLowerCase().replace(/^0x/, ''));
    const busy = sink();
    assert.equal(await pruneMain({ argv: ['--data-dir', f.dataDir], cwd: f.d, env: {}, out: busy.out, now: () => f.now, transports: { pha: w.pha, base: w.base } }), 1);
    assert.match(busy.lines.join('\n'), /running on this data folder; stop it first/);
    await f.store.close();
    const dry = sink();
    assert.equal(await pruneMain({ argv: ['--data-dir', f.dataDir, '--dry-run'], cwd: f.d, env: {}, out: dry.out, now: () => f.now, transports: { pha: w.pha, base: w.base } }), 0, dry.lines.join('\n'));
    assert.match(dry.lines.join('\n'), /Dry run: would remove 2 of 8 secret\(s\)/);
    const real = sink();
    assert.equal(await pruneMain({ argv: ['--data-dir', f.dataDir], cwd: f.d, env: {}, out: real.out, now: () => f.now, transports: { pha: w.pha, base: w.base } }), 0, real.lines.join('\n'));
    assert.match(real.lines.join('\n'), /Removed 2 of 8 secret\(s\)/);
    assertNoSecrets([...busy.lines, ...dry.lines, ...real.lines], secrets);
    assert.equal(w.pha.sent.length + w.base.sent.length, 0);
    assert.equal(await pruneMain({ argv: ['--data-dir', f.dataDir, '--days', '3'], cwd: f.d, env: {}, out: sink().out, transports: { pha: w.pha, base: w.base } }), 2);
    assert.equal(await pruneMain({ argv: [], cwd: f.d, env: {}, out: sink().out }), 2, 'the bot must be named');
    // A key on the command line is refused before anything is opened, and never repeated.
    const wif = PhantasmaKeys.generate().toWIF();
    const hex = '0x' + 'cd'.repeat(32);
    for (const argv of [['--config', wif], ['--data-dir', join(f.d, hex)]]) {
      const refused = sink();
      assert.equal(await pruneMain({ argv, cwd: f.d, env: {}, out: refused.out, transports: { pha: w.pha, base: w.base } }), 2, argv.join(' '));
      assert.match(refused.lines.join('\n'), /looks like a key or a secret/);
      assertNoSecrets(refused.lines, [wif.toLowerCase(), hex.slice(2)]);
    }
  });
});

// ── 7. The documents ────────────────────────────────────────────────────────

describe('the documents', () => {
  test('the READMEs say what a bot of one\'s own and an operator need: its key files, restarts, errors, the store key, upgrades, the network menu, the proxy switch, what npm installs', async () => {
    const kit = await readKitFile('README.md');
    const ex = await readKitFile('examples/README.md');
    // The own-bot sample reads the key files `new-keys.ts --name mybot` writes.
    const sample = /## Write your own bot([\s\S]*?)```ts\n([\s\S]*?)```/.exec(kit);
    assert.ok(sample, 'the README has its sample');
    assert.match(sample[1]!, /npx tsx examples\/new-keys\.ts --name mybot/);
    const d = await tempDir();
    const [pair] = await makeKeyPairs(join(d, 'keys'), ['mybot']);
    for (const f of [pair!.phaFile, pair!.baseFile]) assert.ok(sample[2]!.includes(`'./keys/${f.slice(f.lastIndexOf('/') + 1)}'`), f);
    // Restarts and stops.
    assert.match(kit, /post an offer once, not at\s+every start/);
    assert.match(kit, /Aborting `run\(\)` cancels no offer/);
    assert.match(sample[2]!, /process\.exit\(1\)/, 'a failed preflight stops the sample');
    // Errors: every class, the kit's own retries, and a create that may exist.
    for (const w of ['SafetyError', 'BoardError', 'CreateError', 'mayExist', 'retryAfter', 'PRICE_CHANGED', 'IDEMPOTENCY_MISMATCH', 'listPending()', 'do not wrap']) assert.ok(kit.includes(w), w);
    for (const code of ['KEY_FILE', 'KEY_FILE_MODE', 'STORE_LOCKED', 'STORE_KEY']) {
      assert.equal((SAFETY as Record<string, string>)[code], code);
      assert.ok(kit.includes(`\`${code}\``), code);
    }
    // The store key: how to make it, when to set it, what losing it means.
    assert.match(kit, /exactly 32 raw bytes or 64 hex digits/);
    assert.match(kit, /openssl rand -hex 32/);
    assert.match(kit, /Back it up with the key files/);
    assert.match(kit, /stay unencrypted until\s+`examples\/prune\.ts` removes them/);
    assert.match(ex, /KIT_STORE_KEY_FILE/);
    // Upgrades keep keys/ and data/.
    assert.match(ex, /## Upgrading the kit[\s\S]*Back up `keys\/` and `data\/`[\s\S]*--config seller\.json/);
    assert.match(kit, /"Upgrading the kit"/);
    // Stops can take until a time limit; SIGTERM is a Ctrl-C.
    assert.match(ex, /SIGTERM, which the bot handles the same way/);
    assert.match(ex, /about 41 minutes after the lock on devnet/);
    // The site's page picks the network in its menu, not from the address.
    for (const t of [kit, ex]) {
      assert.doesNotMatch(t, /\?network=/);
      assert.match(t, /devnet picked in the Network menu/);
    }
    // The proxy switch is named in both.
    for (const t of [kit, ex]) assert.match(t, /NODE_USE_ENV_PROXY=1/);
    // What npm installs: exactly the lockfile's versions, with no install script run, and why, in both READMEs.
    for (const t of [kit, ex]) {
      assert.match(t, /npm ci --ignore-scripts/);
      assert.doesNotMatch(t, /\bnpm install\b/, 'no plain npm install: it may move packages off the lockfile');
      assert.match(t, /`npm ci(?: --ignore-scripts)?` installs exactly the versions pinned in the\s+kit's `package-lock\.json`/);
      assert.match(t, /install script,\s+which matters on a machine that holds your\s+keys/);
    }
    assert.match(kit, /`viem` 2\.57\.4 and\s+`phantasma-sdk-ts` 0\.20\.0/);
    assert.match(kit, /`npm ci` refuses to install when the lockfile and\s+`package\.json` disagree/);
    // Upgrading: download, check the .sha256, npm ci --ignore-scripts, and keys/ and data/ kept outside or copied across.
    const kitUp = /To upgrade,([\s\S]*?)"Upgrading the kit"/.exec(kit)?.[1] ?? '';
    for (const w of [/download the new version and its `\.sha256`/, /sha256sum -c/, /npm ci --ignore-scripts/, /keep them outside the\s+unpacked folder/, /copy them across/]) assert.match(kitUp, w);
    const exUp = /## Upgrading the kit([\s\S]*?)\n## /.exec(ex)?.[1] ?? '';
    for (const w of [/Download the new version and its `\.sha256`/, /sha256sum -c saturn-p2p-bot-kit\.tgz\.sha256/, /Do not go on if the\s+check fails/,
      /cp -a saturn-p2p-bot-kit-old\/keys saturn-p2p-bot-kit-old\/data saturn-p2p-bot-kit\//, /outside the kit folder/, /run `npm ci --ignore-scripts`/, /new-keys\.ts --dir/]) assert.match(exUp, w);
    assert.ok(exUp.indexOf('sha256sum -c') < exUp.indexOf('tar xzf') && exUp.indexOf('tar xzf') < exUp.indexOf('cp -a saturn-p2p-bot-kit-old') && exUp.indexOf('cp -a saturn-p2p-bot-kit-old') < exUp.indexOf('npm ci --ignore-scripts'),
      'check, unpack, bring keys and data across, then install');
    const pkg = JSON.parse(await readKitFile('package.json')) as { dependencies: Record<string, string> };
    assert.deepEqual(pkg.dependencies, { 'phantasma-sdk-ts': '0.20.0', viem: '2.57.4' });
    // The quick start says the bots keep running, each in its own terminal, and to fund both.
    assert.match(ex, /each in its own terminal/);
    assert.match(kit, /Fund both bots/);
  });

  test('self-takes (backend honor.ts selfTake): left out of the accept rate, yet a trade between two bots of one machine still proves pairs and eligibility, and still counts toward the pause', async () => {
    const flat = (t: string) => t.replace(/\s+/g, ' ');
    const kit = flat(await readKitFile('README.md'));
    const ex = flat(await readKitFile('examples/README.md'));
    assert.match(kit, /never raise an accept rate, whatever keys they use/);
    assert.match(kit, /it proves the address pair of the offer it filled, so that pair's offers can count, and makes the maker's Base address eligible for a share of maker rewards/);
    assert.match(kit, /a lock not sent in time still counts toward the no-show pause below/);
    assert.match(ex, /they never raise a maker's accept rate: started on one machine/);
    assert.match(ex, /does prove the address pair of the offer it filled and makes the maker's Base address eligible for maker rewards/);
    // eligibleBases, provenPairs and makerPairProven have no self-take filter, so a self-trade can lift a reward from 0.
    for (const t of [kit, ex]) assert.doesNotMatch(t, /never raise (?:a maker's )?(?:an )?accept rate,? or (?:a )?reward/);
  });

  test('docs/CHECKS.md lists every check 1 to 68 and 59a, with what, why, the site source, the kit function and the code; every refusal code is in its check\'s row', async () => {
    const md = await readKitFile('docs/CHECKS.md');
    const rows = new Map<string, string[]>();
    for (const line of md.split('\n')) {
      const m = /^\| (\d+a?)(?: R)? \|/.exec(line);
      if (!m) continue;
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      assert.equal(cells.length, 6, `check ${m[1]} has six columns`);
      for (const c of cells) assert.ok(c.length > 0, `check ${m[1]} has an empty column`);
      assert.ok(!rows.has(m[1]!), `check ${m[1]} is listed once`);
      rows.set(m[1]!, cells);
    }
    const want = [...Array.from({ length: 68 }, (_, i) => String(i + 1)), '59a'].sort();
    assert.deepEqual([...rows.keys()].sort(), want);
    const inRow = (id: string | number, code: string) => (rows.get(String(id)) ?? []).slice(4).join(' ').includes(`\`${code}\``);
    for (const [code, id] of Object.entries(CHECK_CODES)) assert.ok(inRow(id, code), `${code} is in check ${id}'s row`);
    for (const [code, id] of Object.entries(FLOW_CODES)) if (id !== null) assert.ok(inRow(id, code), `${code} is in check ${id}'s row`);
    for (const code of Object.values(SIGNER_CODES)) assert.ok(md.includes(`\`${code}\``), `${code} is listed`);
    for (const [id, cells] of rows) if (id !== '26' && id !== '67' && id !== '68') assert.match(cells[3]!, /\.(js|md):\d|SPEC/, `check ${id} names its site source`);
  });

  test('the word scan: no peg, floor, backed or issuance policy, and no "the line", in the kit README, the examples, CHECKS.md and the sources', async () => {
    const FORBIDDEN = /\b(peg|pegs|pegged|floor|floors|backed|issuance policy)\b/i;
    const THE_LINE = /\bthe line\b/i;
    for (const s of ['a price floor', 'backed by', 'the PEG', 'an issuance policy', 'pegged to']) assert.match(s, FORBIDDEN);
    assert.match('above the line', THE_LINE);
    assert.doesNotMatch('the deadline and the lines of a table', THE_LINE);
    const files = ['README.md', 'examples/README.md', 'docs/CHECKS.md', 'package.json', ...(await readdir(new URL('examples/', KIT_ROOT))).filter((f) => /\.(ts|json)$/.test(f)).map((f) => `examples/${f}`),
      ...(await readdir(new URL('src/', KIT_ROOT), { recursive: true })).filter((f) => f.endsWith('.ts')).map((f) => `src/${f}`)];
    assert.ok(files.length >= 25 && files.includes('src/base.ts') && files.includes('src/flows/maker.ts'), files.join(', '));
    for (const f of files) {
      // Identifiers too: "acceptOnTheirOwn" is read as "accept On Their Own". JavaScript's Math.floor is the one exception.
      const text = (await readKitFile(f)).replace(/Math\.floor/g, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
      assert.doesNotMatch(text, FORBIDDEN, f);
      assert.doesNotMatch(text, THE_LINE, f);
    }
  });
});

// ── 8. --dry-run ────────────────────────────────────────────────────────────

describe('--dry-run', () => {
  test('starts, runs the preflight, reads the board and the reference price, prints the plan and the calibration, and sends nothing', async () => {
    const w = world();
    const cwd = await tempDir();
    const [k] = await makeKeyPairs(join(cwd, 'keys'), ['seller']);
    w.board.credit(k!.pha, k!.base);
    const out = sink();
    const code = await drive(w.vt, runBot({ role: 'seller', argv: ['--dry-run'], cwd, env: {}, out: out.out, internals: internalsOf(w), signals: new EventEmitter() }));
    const text = out.lines.join('\n');
    assert.equal(code, 0, text);
    assert.deepEqual([...new Set(w.board.calls.map((c) => c.method))], ['GET'], 'board calls are GETs only');
    assert.ok(w.board.calls.some((c) => c.path === '/v1/p2p/offers') && w.board.calls.some((c) => c.path === '/v1/p2p/recent') && w.board.calls.some((c) => c.path === '/v1/prices/reference'));
    assert.equal(w.pha.sent.length + w.base.sent.length, 0, 'no chain send');
    assert.equal(w.board.offers.size, 0);
    assert.match(text, /preflight ok code pin:/);
    assert.match(text, /Would list: sell 30 TAZ \(1 to 5 per trade\) at 1\.08 mUSDC\./);
    assert.match(text, /Would list: sell 6 RA \(1 to 2 per trade\) following the reference price \+2%, never below 1\.90 mUSDC\./);
    assert.match(text, /Would sell up to 2 TAZ every 120 s, at least 1\.05 mUSDC per TAZ\./);
    assert.match(text, /Reference pool #223: 1\.8554 TAZ per RA \(ok\)\./);
    assert.match(text, /Calibration: in RA terms \(TAZ times 1\.8554\), the config's prices sit at 1\.948 to 2\.004 mUSDC per RA, around 2\.004\./);
    assert.match(text, /Calibration: that level is 100\.2% of the reference price of RA \(\$2\.0000, via_soul\)\./);
    assert.match(text, /Dry run done: nothing was sent \(board writes refused: 0, chain sends refused: 0\)\./);
    assertNoSecrets(out.lines, await keyMaterial([k!.phaFile, k!.baseFile]));
  });

  test('the calibration compares the two tokens in RA terms; a level far from a via-SOUL reference is information, far from a P2P one it asks to recalibrate', async () => {
    const buyer = parseBotConfig(JSON.parse(await readFile(defaultConfigPath('buyer'), 'utf8')));
    const ref = (raLine: number, basis: string, r: number | null) => ({
      network: 'devnet', asOf: T0, stale: false, anchor: { state: basis, since: T0, passing: false, reasons: [], rule: {}, depth: {}, link: {} },
      twap: { poolId: 223, pool: 'v4:223', tazPerRa: r, spot: r, windowS: 86_400, source: 'sampler', status: r ? 'ok' : 'warming', since: null },
      tokens: { RA: { line: raLine, basis, viaSoul: raLine }, TAZ: { line: raLine / 1.8554, basis, viaSoul: raLine / 1.8554 } }
    }) as unknown as Reference;
    // Devnet today: the reference price is via SOUL, about $0.0136 for RA.
    const devnet = referenceLines(ref(0.0136, 'via_soul', 1.8554), buyer, 'mUSDC').join('\n');
    assert.match(devnet, /its RA and TAZ prices are 5\.7% apart in RA terms \(the P2P reference allows 15%\)\./);
    assert.match(devnet, /offers this far from it trade with each other, but do not count as depth near the reference price/);
    assert.doesNotMatch(devnet, /recalibrate/);
    assert.match(referenceLines(ref(1.5, 'p2p', 1.8554), buyer).join('\n'), /far from the P2P reference price; recalibrate the config/);
    assert.doesNotMatch(referenceLines(ref(1.99, 'p2p', 1.8554), buyer).join('\n'), /recalibrate/);
    const skewed = parseBotConfig({ network: 'devnet', keys: { pha: 'a', base: 'b' }, dataDir: 'd', bids: [{ symbol: 'TAZ', total: '5', min: '1', max: '5', price: '1.06' }, { symbol: 'RA', total: '4', min: '1', max: '2', price: '2.60' }] });
    assert.match(referenceLines(ref(2, 'via_soul', 1.8554), skewed).join('\n'), /recalibrate the config, or trades at these prices fail the reference's TAZ cross-check/);
    assert.match(referenceLines(ref(2, 'via_soul', null), buyer).join('\n'), /Calibration: not possible now/);
  });

  test('its transports refuse every board write and every chain send, and count them', async () => {
    const w = world();
    const ro = readOnlyTransports('devnet', internalsOf(w));
    await assert.rejects(ro.internals.fetch!('http://127.0.0.1:9/v1/p2p/offers', { method: 'POST', body: '{}' }), /dry run/);
    const res = await ro.internals.fetch!('http://127.0.0.1:9/v1/p2p/config?network=devnet');
    assert.equal(res.status, 200);
    await assert.rejects(ro.internals.pha!.sendRaw('00'), /dry run/);
    await assert.rejects(ro.internals.base!.sendRaw('0x00'), /dry run/);
    assert.deepEqual(ro.refused(), { boardWrites: 1, chainSends: 2 });
    assert.equal(w.pha.sent.length + w.base.sent.length, 0);
    assert.equal(w.board.calls.filter((c) => c.method !== 'GET').length, 0);
  });
});

// ── 9. The quick start, end to end ──────────────────────────────────────────

describe('the quick start of examples/README.md, end to end on the fakes', () => {
  test('new keys, the faucet, then the seller and the buyer bots trade with each other both ways, until Ctrl-C stops both', { timeout: 300_000 }, async () => {
    const readme = await readKitFile('examples/README.md');
    const block = /## Quick start on devnet[\s\S]*?```sh\n([\s\S]*?)```/.exec(readme);
    assert.ok(block, 'the README has its quick start');
    const commands = block[1]!.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    // Getting the kit (download, check, unpack, install) is the frontend pack test's (B9); every command after it runs here.
    const getKit = [
      'curl -fsSLO https://ops.saturnx.cc/downloads/saturn-p2p-bot-kit.tgz',
      'curl -fsSLO https://ops.saturnx.cc/downloads/saturn-p2p-bot-kit.tgz.sha256',
      'sha256sum -c saturn-p2p-bot-kit.tgz.sha256',
      'tar xzf saturn-p2p-bot-kit.tgz',
      'cd saturn-p2p-bot-kit',
      'npm ci --ignore-scripts'
    ];
    assert.deepEqual(commands.slice(0, getKit.length), getKit);
    const pkg = JSON.parse(await readKitFile('package.json')) as { scripts: Record<string, string> };
    assert.equal(pkg.scripts.seller, 'tsx examples/seller-bot.ts');
    assert.equal(pkg.scripts.buyer, 'tsx examples/buyer-bot.ts');
    assert.equal(pkg.scripts.faucet, 'tsx examples/faucet.ts');

    const w = world();
    const cwd = await tempDir();
    const fund = new Map<string, string>(); // the faucet command new-keys printed, by bot
    const bots: Array<{ role: Role; signals: EventEmitter; out: ReturnType<typeof sink>; code: number | null; p: Promise<number> }> = [];
    const outputs: string[] = [];
    for (const cmd of commands.slice(getKit.length)) {
      if (cmd === 'npx tsx examples/new-keys.ts') {
        const out = sink();
        assert.equal(await newKeysMain({ argv: [], cwd, out: out.out }), 0, out.lines.join('\n'));
        outputs.push(...out.lines);
        let bot = '';
        for (const l of out.lines) {
          const m = /^(\w+): wrote /.exec(l);
          if (m) bot = m[1]!;
          const f = /^ {2}Fund it on devnet: (npm run faucet -- .*)$/.exec(l);
          if (f) fund.set(bot, f[1]!);
        }
        continue;
      }
      const f = /^npm run faucet -- --pha <(seller|buyer) P2K address> --base <\1 0x address>$/.exec(cmd);
      if (f) {
        // The README's line is the one new-keys printed, with that bot's addresses filled in.
        const printed = fund.get(f[1]!);
        assert.ok(printed, `new-keys printed the ${f[1]} faucet command`);
        const m = /^npm run faucet -- --pha (P2K\S+) --base (0x[0-9a-fA-F]{40})$/.exec(printed);
        assert.ok(m, printed);
        assert.equal(cmd.replace(`<${f[1]} P2K address>`, m[1]!).replace(`<${f[1]} 0x address>`, m[2]!), printed);
        const out = sink();
        assert.equal(await faucetMain({ argv: ['--pha', m[1]!, '--base', m[2]!], fetch: w.board.fetch as typeof fetch, out: out.out }), 0, out.lines.join('\n'));
        outputs.push(...out.lines);
        continue;
      }
      const r = /^npm run (seller|buyer)$/.exec(cmd);
      if (r) {
        const role = r[1] as Role;
        const out = sink();
        const signals = new EventEmitter();
        const bot = { role, signals, out, code: null as number | null, p: Promise.resolve(0) };
        bot.p = runBot({ role, argv: [], cwd, env: {}, out: out.out, signals, internals: internalsOf(w) }).then((c) => { bot.code = c; return c; });
        bots.push(bot);
        continue;
      }
      assert.fail(`a quick-start command this test does not run: ${cmd}`);
    }
    assert.deepEqual(bots.map((b) => b.role), ['seller', 'buyer']);
    assert.deepEqual([...fund.keys()].sort(), ['buyer', 'seller']);

    const addr = async (name: string) => (await loadKeys({ network: 'devnet', phaKeyFile: join(cwd, 'keys', `${name}-pha.json`), baseKeyFile: join(cwd, 'keys', `${name}-base.json`), argv: [] })).address;
    const s = await addr('seller'), b = await addr('buyer');
    const between = () => [...w.board.trades.values()].map((x) => x.t).filter((t) => t.seller.pha === s.pha && t.buyer.pha === b.pha);
    // The buyer bot buys from the seller bot's TAZ ask (buyUpTo); the seller bot sells into the buyer bot's TAZ bid (sellDownTo).
    await until(w.vt, () => {
      const ts = between();
      return ts.some((t) => t.status === 'done' && t.side === 'sell') && ts.some((t) => t.status === 'done' && t.side === 'buy');
    }, 'a done trade each way between the two bots', { stepMs: 2_000, max: 900 });
    for (const bot of bots) assert.equal(bot.code, null, `${bot.role} is still running`);

    for (const bot of bots) bot.signals.emit('SIGINT');
    await until(w.vt, () => bots.every((x) => x.code !== null), 'both bots stopping', { stepMs: 2_000, max: 900 });
    assert.deepEqual(bots.map((x) => x.code), [0, 0]);

    const offers = [...w.board.offers.values()].map((x) => x.o);
    assert.equal(offers.length, 4, 'two offers each');
    for (const o of offers) assert.equal(o.status, 'closed', `offer #${o.id} cancelled at the stop`);
    for (const t of [...w.board.trades.values()].map((x) => x.t)) assert.ok(['done', 'refunded', 'cancelled', 'expired'].includes(t.status), `trade #${t.id} ended (${t.status})`);
    assert.equal(w.board.reveals.length, 0, 'claimMode "self": no secret went to the board');
    const done = between().filter((t) => t.status === 'done');
    assert.ok(done.length >= 2);
    assert.ok(w.pha.count('lock') >= done.length && w.base.count('claim') >= done.length && w.pha.count('claim') >= done.length);
    const sellerText = bots[0]!.out.lines.join('\n'), buyerText = bots[1]!.out.lines.join('\n');
    assert.match(sellerText, /Listed offer #\d+: sell 30 TAZ/);
    assert.match(sellerText, /Sold 2 TAZ in 1 trade\(s\)/);
    assert.match(buyerText, /Bought 2 TAZ in 1 trade\(s\)/);
    for (const text of [sellerText, buyerText]) assert.match(text, /Every trade of this bot is finished, and its offers are cancelled\. Stopped\./);
    const keyFiles = ['seller', 'buyer'].flatMap((n) => [join(cwd, 'keys', `${n}-pha.json`), join(cwd, 'keys', `${n}-base.json`)]);
    assertNoSecrets([...outputs, ...bots.flatMap((x) => x.out.lines)], await keyMaterial(keyFiles));
    for (const n of ['seller', 'buyer']) {
      const secretsDir = join(cwd, 'data', n, 'devnet', 'secrets');
      for (const f of await readdir(secretsDir)) assert.equal((await stat(join(secretsDir, f))).mode & 0o777, 0o600, f);
    }
  });
});

// ── 10. A loop of one's own ─────────────────────────────────────────────────

describe('a loop of its own (examples/README.md)', () => {
  test('resume() first and about once a minute, then step() each running trade (never beside run()): the trade completes', { timeout: 120_000 }, async () => {
    const w = world();
    const cwd = await tempDir();
    const pairs = await makeKeyPairs(join(cwd, 'keys'), ['maker', 'taker']);
    for (const p of pairs) w.board.credit(p.pha, p.base);
    const kitOf = async (name: string) => {
      const k = await createKit({
        network: 'devnet', phaKeyFile: join(cwd, 'keys', `${name}-pha.json`), baseKeyFile: join(cwd, 'keys', `${name}-base.json`),
        dataDir: join(cwd, 'data', name), env: {}, internals: internalsOf(w)
      });
      openKits.push(k);
      return k;
    };
    const maker = await kitOf('maker');
    const kit = await kitOf('taker');
    const offer = await maker.postOffer({ side: 'sell', symbol: 'TAZ', total: '10', min: '1', max: '5', price: '1.08' });
    const makerStop = new AbortController();
    const makerRun = maker.run({ acceptAfterS: 0 }, makerStop.signal);
    const taken = await kit.take(offer.id, '2');

    // The README's loop, on the test's clock.
    const stop = new AbortController();
    const policy = { claimWatchS: 60 };
    let resumes = 0;
    const loop = (async () => {
      await kit.resume();
      resumes++;
      let resumedAt = w.vt.now();
      while (!stop.signal.aborted) {
        if (w.vt.now() - resumedAt >= 60_000) {
          await kit.resume();
          resumes++;
          resumedAt = w.vt.now();
        }
        for (const t of await kit.store.listTrades()) {
          if (!t.endedAt) await kit.step(t.id, policy);
        }
        await w.vt.sleep(5_000, stop.signal);
      }
    })();
    await until(w.vt, async () => !!(await kit.store.getTrade(taken.id))?.endedAt, 'the taker\'s trade finishing', { stepMs: 2_000, max: 600 });
    stop.abort();
    makerStop.abort();
    await drive(w.vt, Promise.all([loop, makerRun]));
    assert.equal(w.board.trades.get(taken.id)!.t.status, 'done');
    assert.ok(resumes >= 2, `resume() ran first and again a minute on (${resumes})`);
    for (const k of [kit, maker]) {
      await k.close();
      openKits.splice(openKits.indexOf(k), 1);
    }
  });
});
