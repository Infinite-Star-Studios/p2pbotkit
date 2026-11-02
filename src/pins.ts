/**
 * The kit's trust constants, hardcoded per network (P2P/SPEC.md sections 1,
 * 4-7 and "Tokens"; build spec sections 0.4 and 6.2). Ported value for value
 * from the site's src/lib/p2p/constants.js; test/pins-parity.test.ts checks
 * them against that file and the backend's src/p2p/config.ts.
 *
 * Nothing here is ever read from the board. Its /config, /reference and every
 * feed are display only: a board that lied about a contract, the USDC token,
 * a chain id, a time limit or a token's decimals could otherwise steer a bot
 * into locking funds where it cannot get them back, or at a scale its
 * operator never chose. Changing a value here is a kit release, reviewed like
 * a contract change.
 *
 * Mainnet's escrow and SaturnSwap pins are empty in this release, so the kit
 * refuses mainnet (networkProblem); they are filled only after the owner's
 * launch steps. Instant offers (INSTANT, build spec section 3.10) are
 * devnet only in this release (INSTANT_NETWORKS).
 */
import type { Network } from './types.js';

/** The Phantasma escrow (SPEC sections 1 and 4): one contract per network, the same build under the same name. */
export const PHA_CONTRACT = 'saturnescrow';
export const USDC_DECIMALS = 6;
/** SaturnSwap.MAX_FEE_BPS: the owner can never set a fee above 2%. */
export const MAX_FEE_BPS = 200;
/** Smallest trade: 1 USDC (SPEC sections 5 and 7). */
export const MIN_TRADE_USDC = 1_000_000n;

/**
 * A token the board trades (SPEC "Tokens"). Amounts are raw units: `min` and
 * `max` bound one lock and equal the escrow's getMinAmount/getMaxAmount for
 * the symbol, `offerMax` bounds one offer's total, `priceMax` is the highest
 * price in raw USDC per whole token. `gas`: the token also pays Phantasma's
 * gas (KCAL). `stake`: only the liquid balance can be locked (SOUL).
 */
export interface P2PToken {
  readonly symbol: string;
  readonly decimals: number;
  readonly min: bigint;
  readonly max: bigint;
  readonly offerMax: bigint;
  readonly priceMax: bigint;
  readonly gas: boolean;
  readonly stake: boolean;
  /** false: no new offer or take; trades already running go on. */
  readonly enabled: boolean;
}

/**
 * The tokens, in the site's order. Decimals and limits come only from here,
 * never from the board, an offer, a trade or /config: a source that could
 * rescale them could make a bot sign 10x the amount its operator set. Look a
 * symbol up only through tokenOf.
 */
export const P2P_TOKENS: readonly Readonly<P2PToken>[] = Object.freeze([
  Object.freeze({ symbol: 'TAZ', decimals: 9, min: 1_000_000_000n, max: 100_000_000_000_000n, offerMax: 10_000_000_000_000_000n, priceMax: 1_000_000_000_000n, gas: false, stake: false, enabled: true }),
  Object.freeze({ symbol: 'SOUL', decimals: 8, min: 100_000_000n, max: 100_000_000_000_000n, offerMax: 10_000_000_000_000_000n, priceMax: 1_000_000_000_000n, gas: false, stake: true, enabled: true }),
  Object.freeze({ symbol: 'KCAL', decimals: 10, min: 10_000_000_000n, max: 300_000_000_000_000_000n, offerMax: 3_000_000_000_000_000_000n, priceMax: 1_000_000_000_000n, gas: true, stake: false, enabled: true }),
  Object.freeze({ symbol: 'RA', decimals: 9, min: 1_000_000_000n, max: 5_000_000_000_000n, offerMax: 10_000_000_000_000n, priceMax: 1_000_000_000_000n, gas: false, stake: false, enabled: true })
]);

/** A symbol as the chain and the table write it: upper case, no spaces, at most 10 characters. */
const SYMBOL = /^[A-Z][A-Z0-9]{0,9}$/;
/** By symbol, in a Map: a plain object would answer '__proto__' or 'constructor'. */
const TOKEN_BY_SYMBOL = new Map(P2P_TOKENS.map((t) => [t.symbol, t]));

/**
 * The table's row for a symbol, or null for anything else (another case,
 * spaces, a symbol the kit does not trade, not a string). Exact: never
 * upper-cased or trimmed.
 */
export function tokenOf(symbol: unknown): Readonly<P2PToken> | null {
  return typeof symbol === 'string' && SYMBOL.test(symbol) ? TOKEN_BY_SYMBOL.get(symbol) ?? null : null;
}

/** Raw units in one whole token, 10^decimals. Throws for a symbol the kit does not trade. */
export function unitOf(symbol: unknown): bigint {
  const t = tokenOf(symbol);
  if (!t) throw new Error('Not a token this kit trades');
  return 10n ** BigInt(t.decimals);
}

/** The symbols, in the table's order. */
export const P2P_SYMBOLS: readonly string[] = Object.freeze(P2P_TOKENS.map((t) => t.symbol));

/** KCAL's decimals (from the table). */
export const KCAL_DECIMALS = tokenOf('KCAL')!.decimals;

/**
 * The seller's Phantasma lock (and every other Phantasma send of the kit) is
 * signed with this fixed gas allowance, never one fitted to the balance:
 * price 100,000 x limit 300,000 = 3 KCAL.
 */
export const PHA_LOCK_GAS = Object.freeze({ price: 100_000, limit: 300_000 });
/** That allowance in raw KCAL. */
export const PHA_LOCK_KCAL = BigInt(PHA_LOCK_GAS.price) * BigInt(PHA_LOCK_GAS.limit);
/** Liquid SOUL a seller keeps free through its lock (1.1 SOUL): 1 SOUL for later signatures plus the lock's data fee. */
export const SOUL_RESERVE = 110_000_000n;

/** Base block time on both chains, used only to narrow log searches. */
export const BASE_BLOCK_SECONDS = 2;
/** The largest difference between this machine's clock and the newest Base block a lock accepts (seconds). */
export const CLOCK_SKEW_MAX = 5 * 60;

const MIN = 60;
const HOUR = 3_600;

/** Seconds (SPEC section 6). The first eleven fields are the site's P2PTiming, field for field. */
export interface P2PTiming {
  /** S's Phantasma lock length: T1 = lock time + phaLock. */
  readonly phaLock: number;
  /** T1 - T2 at least. */
  readonly safety: number;
  /** S reveals only while T2 - now >= revealMin. */
  readonly revealMin: number;
  /** B locks only while T2 - now >= revealMin + baseLockLead. */
  readonly baseLockLead: number;
  /** REVEAL_ALLOWANCE: B's T2 is at most now + revealMin + baseLockLead + this. */
  readonly revealAllowance: number;
  /** CLAIM_MARGIN: a Base claim is sent only while its deadline is this far away. */
  readonly claimMargin: number;
  /** CLAIM_WATCH: how long a claim by the keeper is waited for before claiming oneself. */
  readonly claimWatch: number;
  /** Refunds are shown this long after a deadline (the site's rule; block time trails the clock). */
  readonly refundGrace: number;
  /** B refuses a Phantasma lock running longer than phaLock + this. */
  readonly lockSlack: number;
  /** BASE_LOCK_WINDOW: B's USDC lock counts only when mined at most this long after the Phantasma lock's getCreated. */
  readonly baseLockWindow: number;
  /** B signs only while now - created <= baseLockWindow - this. */
  readonly baseLockSignLead: number;
  /** A Phantasma refund is sent at T1 + this or later (the keeper's grace, section 6.6). */
  readonly phaRefundGrace: number;
  /** A Base refund is sent at T2 + this or later (the keeper's grace, section 6.6). */
  readonly baseRefundGrace: number;
}

/** An older escrow a release still serves for claims and refunds while its locks drain. New locks never go to it. */
export interface DrainingEscrow {
  readonly name: string;
  readonly codeSha256: string;
  readonly admin: string;
}

/** The most the kit signs for one Base transaction's fees (raw wei), whatever an RPC asks for. */
export interface FeeCaps {
  readonly maxGas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly maxFeeWei: bigint;
}

export interface PhaNet {
  /** The default RPC endpoint. */
  readonly rpcUrl: string;
  /** RPC_ALLOWLIST (check 67): the only hosts the kit talks to for this network (redirects elsewhere are refused, never followed). */
  readonly rpcHosts: readonly string[];
  readonly nexus: string;
  readonly chain: string;
  readonly explorerUrl: string;
}

export interface BaseNet {
  readonly name: string;
  readonly chainId: number;
  /** The default public RPC (any other RPC must answer this chain id, check 67). */
  readonly rpcUrl: string;
  readonly explorerUrl: string;
  /** SaturnSwap, '' while not deployed. */
  readonly swap: string;
  /** The one USDC token trades use, '' while not set. */
  readonly usdc: string;
  readonly usdcSymbol: string;
  readonly nativeCurrency: Readonly<{ name: string; symbol: string; decimals: number }>;
  /** Blocks after the lock's block (0 = use the safe head). */
  readonly confirmBlocks: number;
  /** The lock's block must be at or below the `safe` head. */
  readonly confirmSafe: boolean;
  /** The token has paused() and isBlacklisted() (FiatToken). */
  readonly usdcHasBlacklist: boolean;
  /** USDC_MIN / USDC_MAX: per trade, raw. */
  readonly usdcMin: bigint;
  readonly usdcMax: bigint;
  /** The USDC token's EIP-712 domain name and version (EIP-2612 permit, check 46). */
  readonly permit: Readonly<{ name: string; version: string }>;
  readonly feeCaps: Readonly<FeeCaps>;
  /** MockUSDC's FAUCET_MAX; 0 where the token has no faucet. */
  readonly faucetMax: bigint;
  /** Gas limit of the one-step USDC lock (lockWithPermit). */
  readonly lockWithPermitGas: bigint;
}

export interface P2PNetConfig {
  readonly network: Network;
  /** The current escrow: every new Phantasma lock. */
  readonly phaContract: string;
  /** PHA_CODE_SHA256: SHA-256 of the escrow's deployed script bytes (64 lowercase hex). '' = not pinned: no trading. */
  readonly phaCodeSha256: string;
  /** PHA_ADMIN: getAdmin() of the escrow. '' = not pinned: no trading. */
  readonly phaAdmin: string;
  readonly phaDraining: readonly DrainingEscrow[];
  /** PHA_CLAIM_KCAL, raw KCAL: what one Phantasma claim needs (the buyer is warned below it, check 47). */
  readonly phaClaimKcal: bigint;
  readonly pha: Readonly<PhaNet>;
  readonly base: Readonly<BaseNet>;
  readonly timing: Readonly<P2PTiming>;
}

/** The site's passkey-wallet fee ceilings, which the kit signs under too: gas 600,000; 5 gwei; 2 gwei tip; 0.002 ETH per transaction. */
const FEE_CAPS: Readonly<FeeCaps> = Object.freeze({
  maxGas: 600_000n,
  maxFeePerGas: 5_000_000_000n,
  maxPriorityFeePerGas: 2_000_000_000n,
  maxFeeWei: 2_000_000_000_000_000n
});
/** lockWithPermit measured 181,589 gas with MockUSDC; Circle's permit costs more. */
const LOCK_WITH_PERMIT_GAS = 350_000n;

export const P2P_CONFIG: Readonly<Record<Network, Readonly<P2PNetConfig>>> = Object.freeze({
  devnet: Object.freeze({
    network: 'devnet' as const,
    phaContract: PHA_CONTRACT,
    phaCodeSha256: 'ca1521581d1632dac9c0579817044e76253977f685c95240343ce76358e4fd99',
    phaAdmin: 'P2KBNc6TpAqLi5LEBHgX62BA3uqa6d87NefwRmJ825fbJ8D',
    phaDraining: Object.freeze([]),
    phaClaimKcal: 30_000_000_000n,
    pha: Object.freeze({
      rpcUrl: 'https://devnet.phantasma.info/rpc',
      rpcHosts: Object.freeze(['devnet.phantasma.info']),
      nexus: 'testnet',
      chain: 'main',
      explorerUrl: 'https://devnet-explorer.phantasma.info'
    }),
    base: Object.freeze({
      name: 'Base Sepolia',
      chainId: 84532,
      rpcUrl: 'https://sepolia.base.org',
      explorerUrl: 'https://sepolia.basescan.org',
      swap: '0x952Cd62D3575Fd1B434faAE1B48FBDD0eD0a891d',
      usdc: '0x1eCcc4Ff269087d80cEcE6EE46f658C496E9A358',
      usdcSymbol: 'mUSDC',
      nativeCurrency: Object.freeze({ name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 }),
      confirmBlocks: 3,
      confirmSafe: false,
      usdcHasBlacklist: false,
      usdcMin: 1_000_000n,
      usdcMax: 100_000_000_000n,
      permit: Object.freeze({ name: 'Mock USD Coin', version: '1' }),
      feeCaps: FEE_CAPS,
      faucetMax: 10_000_000_000n,
      lockWithPermitGas: LOCK_WITH_PERMIT_GAS
    }),
    timing: Object.freeze({
      phaLock: 40 * MIN, safety: 15 * MIN, revealMin: 5 * MIN, baseLockLead: 10 * MIN, revealAllowance: 5 * MIN, claimMargin: 3 * MIN,
      claimWatch: 1 * MIN, refundGrace: 30, lockSlack: 15 * MIN, baseLockWindow: 15 * MIN, baseLockSignLead: 5 * MIN,
      phaRefundGrace: 60, baseRefundGrace: 30
    })
  }),
  mainnet: Object.freeze({
    network: 'mainnet' as const,
    phaContract: PHA_CONTRACT,
    // Filled at launch, after the owner's launch steps (P2P/LAUNCH.md step 9). Empty: the kit refuses mainnet.
    phaCodeSha256: '',
    phaAdmin: '',
    phaDraining: Object.freeze([]),
    phaClaimKcal: 30_000_000_000n,
    pha: Object.freeze({
      rpcUrl: 'https://pharpc1.phantasma.info/rpc',
      rpcHosts: Object.freeze(['pharpc1.phantasma.info']),
      nexus: 'mainnet',
      chain: 'main',
      explorerUrl: 'https://explorer.phantasma.info'
    }),
    base: Object.freeze({
      name: 'Base',
      chainId: 8453,
      rpcUrl: 'https://mainnet.base.org',
      explorerUrl: 'https://basescan.org',
      swap: '',
      usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      usdcSymbol: 'USDC',
      nativeCurrency: Object.freeze({ name: 'Ether', symbol: 'ETH', decimals: 18 }),
      confirmBlocks: 0,
      confirmSafe: true,
      usdcHasBlacklist: true,
      usdcMin: 1_000_000n,
      usdcMax: 10_000_000_000n,
      permit: Object.freeze({ name: 'USD Coin', version: '2' }),
      feeCaps: FEE_CAPS,
      faucetMax: 0n,
      lockWithPermitGas: LOCK_WITH_PERMIT_GAS
    }),
    timing: Object.freeze({
      phaLock: 12 * HOUR, safety: 6 * HOUR, revealMin: 1 * HOUR, baseLockLead: 10 * MIN, revealAllowance: 30 * MIN, claimMargin: 30 * MIN,
      claimWatch: 5 * MIN, refundGrace: 30, lockSlack: 15 * MIN, baseLockWindow: 30 * MIN, baseLockSignLead: 5 * MIN,
      phaRefundGrace: 60, baseRefundGrace: 30
    })
  })
});

/** Offer board timings (SPEC section 7), seconds, the same on both networks. */
export const BOARD = Object.freeze({
  /** A maker sends a heartbeat this often while its offers are open. */
  heartbeat: 20,
  /** An offer is hidden after this long without a heartbeat. */
  heartbeatTtl: 90,
  /** A take not accepted within this is cancelled by the board. */
  acceptTimeout: 2 * MIN,
  /** An accepted trade whose tokens are not locked on Phantasma within this expires. */
  lockWait: 10 * MIN,
  /** The seller does not start a lock with less than this left before the trade expires. */
  lockStartMargin: 90,
  /** A take is accepted on its own only once it has been seen this long (Policy.acceptAfterS defaults to it). */
  acceptDelay: 15,
  /** The site reads /config again this often. */
  configRecheck: 60
});

// ── Instant mode (build spec section 3.10) ──────────────────────────────────

/**
 * Instant mode's time rules, seconds (build spec section 3.10.2). In an
 * instant trade the buyer B makes the secret and locks the USDC first, with
 * the later deadline T_B; the seller S (the bot) locks its tokens after
 * checking B's lock, with T_P <= T_B - I_SAFETY. The names are the spec's,
 * field for field the backend's src/p2p/config.ts INSTANT_TIMING and the
 * site's constants.js INSTANT (test/pins-parity.test.ts imports the
 * backend's under tsx and compares them).
 */
export interface InstantTiming {
  /** S must have locked within this of t_B (the block time of B's Locked event). */
  readonly I_WIN: number;
  /** S starts its lock only while now - t_B <= I_WIN - I_WIN_LEAD, so the lock is mined inside I_WIN. */
  readonly I_WIN_LEAD: number;
  /** T_P - S's lock time: the length of S's Phantasma lock. */
  readonly I_PHA: number;
  /** B reveals or claims only while T_P - now >= this. */
  readonly I_CLAIM: number;
  /** T_B - T_P at least: S's worst-case window to claim the USDC once the secret is public on Phantasma. */
  readonly I_SAFETY: number;
  /** From B signing its lock to its mining. */
  readonly I_SLACK: number;
}

/**
 * INSTANT: the instant time rules per network. Devnet: S starts its lock at
 * most 180 s (I_WIN - I_WIN_LEAD) after B's lock was mined, locks for 15
 * minutes, and has at least 10 minutes to claim the USDC after the secret is
 * public; B's USDC is held at most 32 minutes. Mainnet's values are the
 * spec's, but this release posts no instant offer there (INSTANT_NETWORKS).
 */
export const INSTANT: Readonly<Record<Network, Readonly<InstantTiming>>> = Object.freeze({
  devnet: Object.freeze({ I_WIN: 300, I_WIN_LEAD: 120, I_PHA: 900, I_CLAIM: 300, I_SAFETY: 600, I_SLACK: 120 }),
  mainnet: Object.freeze({ I_WIN: 600, I_WIN_LEAD: 300, I_PHA: 3900, I_CLAIM: 900, I_SAFETY: 3600, I_SLACK: 300 })
});

/**
 * The networks where this kit release posts instant offers and locks for
 * them: devnet only. Instant trades on mainnet are the owner's decision after
 * SPEC amendment 8 (a hash squat costs the buyer time; a failed Phantasma
 * claim can cost the buyer the USDC), and need a kit release that lists it.
 */
export const INSTANT_NETWORKS: readonly Network[] = Object.freeze(['devnet'] as Network[]);

/**
 * The kit's fixed margins of instant trades, seconds:
 *   claimMin     the USDC claim goes out only while T_B - now >= this. The
 *                secret is already public on Phantasma then, so CLAIM_MARGIN
 *                (which keeps a private secret from leaking in a failed
 *                claim) does not apply (build spec section 3.10.3 step 4);
 *   watchEvery   from its lock on, the kit reads getState(h) at least this
 *                often until it has claimed or T_P has passed, so a claim on
 *                Phantasma at T_P - 1 s still leads to its USDC claim (the
 *                spec's bound is 15 s);
 *   phaLockSlack the board accepts S's lock up to this much shorter than
 *                I_PHA (its start and end come from two clocks);
 *   baseSpanSlack the board accepts a T_B up to this much later than
 *                t_B + I_SLACK + I_WIN + I_PHA + I_SAFETY.
 * The backend's src/p2p/logic.ts INSTANT holds the same figures
 * (baseClaimMinS, phaLockSlackS, baseSpanSlackS).
 */
export const INSTANT_RULES = Object.freeze({ claimMin: 60, watchEvery: 10, phaLockSlack: 120, baseSpanSlack: 300 });

/** T_B - now when B locks: I_SLACK + I_WIN + I_PHA + I_SAFETY (1,920 s on devnet, 8,400 s on mainnet). */
export function instantBaseSpan(t: InstantTiming): number {
  return t.I_SLACK + t.I_WIN + t.I_PHA + t.I_SAFETY;
}

/** The instant time rules of a network where this kit release posts instant offers, or null (mainnet, or anything else). */
export function instantTiming(network: unknown): Readonly<InstantTiming> | null {
  return (network === 'devnet' || network === 'mainnet') && INSTANT_NETWORKS.includes(network) ? INSTANT[network] : null;
}

/** PHA_HASH_VECTORS (SPEC section 4): the escrow's hashSecret must return exactly these digests on the live node (check 4). */
export const PHA_HASH_VECTORS: readonly Readonly<{ secret: string; digest: string }>[] = Object.freeze([
  Object.freeze({ secret: '0x' + '00'.repeat(32), digest: '0x66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925' }),
  Object.freeze({ secret: '0x' + 'ff'.repeat(32), digest: '0xaf9613760f72635fbdb44a5a0a63c39f12af30f950a6ee5c971be188e89c4051' }),
  Object.freeze({ secret: '0x80' + '00'.repeat(31), digest: '0x84b3f13b0a4fbcce4c3f811e0313e00dcbd27431c229eff576598be8d1afb848' }),
  Object.freeze({ secret: '0x' + 'ab'.repeat(32), digest: '0x9a2db2e23f1504cd056606553ac049c5e718e8f9ce9233876df1a7a1821af885' })
]);

/** The board the kit talks to unless told otherwise. */
export const DEFAULT_API = 'https://apiops.saturnx.cc';

/**
 * Addresses whose keys a bot must never hold (check 68): Saturn's admin key,
 * the escrow admins, the devnet test wallet, the keeper's Phantasma key and
 * its Base keys, and the SaturnSwap owner. A bot is the user's own; a key
 * that also holds an admin or keeper role must not be put on a bot's machine.
 * Refused on every network. The pinned escrow admins (P2P_CONFIG) are added
 * by knownRoleAddresses().
 *
 * The keeper's keys come in sets: K0, the devnet keeper's keys until October
 * 2026, retired (they leaked) and still refused; K1, the devnet keeper's keys
 * since 26 October 2026, at the addresses the board's /config shows. The
 * owner's cold gasKeeper address for SaturnSwap is added when it is set.
 */
export const KNOWN_ROLE_ADDRESSES: Readonly<{ pha: readonly Readonly<{ address: string; role: string }>[]; base: readonly Readonly<{ address: string; role: string }>[] }> = Object.freeze({
  pha: Object.freeze([
    Object.freeze({ address: 'P2KBPHBKq1xuoSajuKxQCd7RfCfGFyoczoHQdVxacEUc9As', role: 'Saturn\'s admin key' }),
    Object.freeze({ address: 'P2KBNc6TpAqLi5LEBHgX62BA3uqa6d87NefwRmJ825fbJ8D', role: 'the devnet escrow admin and test deploy wallet' }),
    // K0, retired.
    Object.freeze({ address: 'P2KJBzzwGWLkDz5HUtuHQ7ydUWmbyAtFukwytu8qFtbRkuX', role: 'the retired devnet keeper' }),
    // K1.
    Object.freeze({ address: 'P2KKFuFZNpiFdtgWQ68DHuTtwqnjBMgTv2hArZrmQYmf4gx', role: 'the devnet keeper (Phantasma claims and refunds)' })
  ]),
  base: Object.freeze([
    Object.freeze({ address: '0x941536821262b424997Cb212bDDFc97CAD7fD6f6', role: 'the SaturnSwap owner' }),
    // K0, retired.
    Object.freeze({ address: '0xe16fE62e009961682F3a7F42642F36F5E46962F8', role: 'the retired devnet keeper (refunds)' }),
    Object.freeze({ address: '0x6EC2A535685D5cE5f143B8C0d9bF5F612295b703', role: 'the retired devnet keeper (claims)' }),
    // K1.
    Object.freeze({ address: '0xa93Bc149Ff1DE9f20Fa1198e2edB4FFb69ECE58A', role: 'the devnet keeper (refunds and withdrawOwed)' }),
    Object.freeze({ address: '0x8701a821221266800a6dF354701E79Fdb5Ab80A6', role: 'the devnet keeper (claims)' })
  ])
});

/** Every address of KNOWN_ROLE_ADDRESSES plus every pinned escrow admin, current and draining, of both networks. */
export function knownRoleAddresses(): { pha: Map<string, string>; base: Map<string, string> } {
  const pha = new Map<string, string>();
  const base = new Map<string, string>();
  for (const a of KNOWN_ROLE_ADDRESSES.pha) pha.set(a.address, a.role);
  for (const a of KNOWN_ROLE_ADDRESSES.base) base.set(a.address.toLowerCase(), a.role);
  for (const cfg of Object.values(P2P_CONFIG)) {
    if (cfg.phaAdmin) pha.set(cfg.phaAdmin, `the ${cfg.network} escrow admin (PHA_ADMIN)`);
    for (const d of cfg.phaDraining) if (d.admin) pha.set(d.admin, `the ${cfg.network} admin of ${d.name}`);
  }
  return { pha, base };
}

/** The hardcoded settings of a network, or null for anything else. */
export function p2pConfig(network: unknown): Readonly<P2PNetConfig> | null {
  return network === 'devnet' || network === 'mainnet' ? P2P_CONFIG[network] : null;
}

/** A Phantasma user address (shape only). */
const PHA_ADDRESS = /^P2K[1-9A-HJ-NP-Za-km-z]{40,50}$/;

/** Whether the network's current escrow is pinned: a code hash (64 lowercase hex) and an admin (check 2). */
export function phaPinned(cfg: Pick<P2PNetConfig, 'phaCodeSha256' | 'phaAdmin'> | null): boolean {
  return !!cfg && /^[0-9a-f]{64}$/.test(cfg.phaCodeSha256) && PHA_ADDRESS.test(cfg.phaAdmin);
}

/** A contract name as TOMB writes it. */
export function isContractName(name: unknown): name is string {
  return typeof name === 'string' && /^[a-z][a-z0-9]{2,31}$/.test(name);
}

/**
 * The network's config for the escrow named `name` (check 5): the current one
 * (no name, or its name) or a draining one this release lists, with that
 * contract's pins. Null for a contract this release does not serve.
 */
export function escrowCfg(cfg: Readonly<P2PNetConfig>, name?: string | null): Readonly<P2PNetConfig> | null {
  if (!name || name === cfg.phaContract) return cfg;
  const d = cfg.phaDraining.find((x) => x.name === name);
  return d ? Object.freeze({ ...cfg, phaContract: d.name, phaCodeSha256: d.codeSha256, phaAdmin: d.admin }) : null;
}

/** Whether trading can run on this network's Base side: SaturnSwap and USDC are both pinned (check 6). */
export function baseDeployed(cfg: Pick<P2PNetConfig, 'base'> | null): boolean {
  return !!cfg && /^0x[0-9a-fA-F]{40}$/.test(cfg.base.swap) && /^0x[0-9a-fA-F]{40}$/.test(cfg.base.usdc);
}

/**
 * Why the kit must not run on `network`, or null:
 *   - a network this release does not know;
 *   - the escrow or SaturnSwap pins are empty (mainnet today);
 *   - mainnet without both `allowMainnet: true` and env KIT_ALLOW_MAINNET=1.
 */
export function networkProblem(network: unknown, o: { allowMainnet?: boolean; env?: Record<string, string | undefined> } = {}): string | null {
  const cfg = p2pConfig(network);
  if (!cfg) return 'The network is devnet or mainnet.';
  if (cfg.network === 'mainnet') {
    const env = o.env ?? process.env;
    if (o.allowMainnet !== true || env.KIT_ALLOW_MAINNET !== '1') return 'Mainnet needs allowMainnet: true and KIT_ALLOW_MAINNET=1 in the environment.';
  }
  if (!phaPinned(cfg)) return `This kit release has no escrow pins for ${cfg.network}, so it does not trade there.`;
  if (!baseDeployed(cfg)) return `This kit release has no SaturnSwap pin for ${cfg.network}, so it does not trade there.`;
  return null;
}

/**
 * Why a Phantasma RPC URL is not allowed for `network` (check 67), or null:
 * https only, no user part, no port, and a host on the network's allowlist.
 */
export function phaRpcProblem(network: Network, url: unknown): string | null {
  const cfg = p2pConfig(network);
  if (!cfg) return 'The network is devnet or mainnet.';
  let u: URL;
  try { u = new URL(String(url)); } catch { return 'The Phantasma RPC is not a URL.'; }
  if (u.protocol !== 'https:') return 'The Phantasma RPC must use https.';
  if (u.username || u.password) return 'The Phantasma RPC URL must not carry a user name or password.';
  if (u.port) return 'The Phantasma RPC URL must use the default https port.';
  if (!cfg.pha.rpcHosts.includes(u.hostname.toLowerCase())) return `The Phantasma RPC host must be ${cfg.pha.rpcHosts.join(' or ')} on ${network}.`;
  return null;
}

/**
 * Why a Base RPC URL cannot be used, or null: https (or http on this machine's
 * loopback, for a local node) and no user part. The RPC's chain id must also
 * equal the pin; that is read when the kit starts (check 67). The transport
 * refuses redirects (base.ts BASE_FETCH_OPTIONS), so the checked URL is the
 * only one ever asked.
 */
export function baseRpcProblem(url: unknown): string | null {
  let u: URL;
  try { u = new URL(String(url)); } catch { return 'The Base RPC is not a URL.'; }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return 'The Base RPC must use https (or http on 127.0.0.1).';
  if (u.username || u.password) return 'The Base RPC URL must not carry a user name or password.';
  return null;
}
