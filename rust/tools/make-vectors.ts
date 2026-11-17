/**
 * Known answers from the TypeScript kit for its Rust port (rust/), made by the
 * kit's own code. From the kit's folder, after `npm ci --ignore-scripts`:
 *
 *   npx tsx rust/tools/make-vectors.ts
 *
 * It writes rust/fixtures/kit-vectors.json:
 *   - pins: the kit's compiled-in trust (tokens, both networks' configs, gas,
 *     labels, timing, role addresses), for the Rust pins' parity test;
 *   - evm: the Base address of each test key (viem), every escrow and USDC
 *     call the kit sends (src/base.ts), EIP-712 permits signed with viem, and
 *     EIP-1559 transactions as src/signer.ts signs them (serializable + viem);
 *   - codec: control-token hashes, secret hashes and number conversions;
 *   - seals: files that the kit's own store (src/store.ts) wrote with a store
 *     key, and the records it read back from them.
 *
 * The test keys are the ones of test/fixtures/sdk-vectors.json: each private
 * key is the SHA-256 of its label, so the file holds no key. The Phantasma
 * side (keys, escrow transactions, view scripts) is checked against
 * test/fixtures/sdk-vectors.json itself.
 *
 * Remake this file whenever the kit changes its pins, its calls or its store
 * format: a Rust test that then fails names what the port must follow.
 */
import { createHash, createDecipheriv } from 'node:crypto';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { hashTypedData, keccak256, parseSignature, serializeTransaction, type Hex } from 'viem';
import {
  P2P_CONFIG, P2P_TOKENS, PHA_LOCK_GAS, PHA_HASH_VECTORS, CLOCK_SKEW_MAX, MAX_FEE_BPS, MIN_TRADE_USDC, USDC_DECIMALS,
  SOUL_RESERVE, PHA_CONTRACT, DEFAULT_API, knownRoleAddresses
} from '../../src/pins.js';
import { PHA_TX_LABELS, PHA_TX_TTL_MS } from '../../src/pha.js';
import {
  approveCall, lockCallBase, lockWithPermitCall, claimCallBase, refundCallBase, withdrawOwedCall, cancelCall,
  permitTypedData, serializable, pinnedDomainSeparator, CANCEL_GAS, PERMIT_SECONDS, PERMIT_MAX_SECONDS, type BaseCall
} from '../../src/base.js';
import { hashOfSecret, tokenHashOf, hexToDecimal, decimalToHex } from '../../src/codec.js';
import { openStore } from '../../src/store.js';
import type { Network, SecretRecord } from '../../src/types.js';

const OUT = fileURLToPath(new URL('../fixtures/kit-vectors.json', import.meta.url));
const SDK_VECTORS = fileURLToPath(new URL('../../test/fixtures/sdk-vectors.json', import.meta.url));

const sha256 = (b: string | Uint8Array): Buffer => createHash('sha256').update(b).digest();
const hex0x = (b: Uint8Array): Hex => `0x${Buffer.from(b).toString('hex')}`;
const NETWORKS: Network[] = ['devnet', 'mainnet'];

/** JSON with bigints as decimal strings. */
const json = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 1) + '\n';

/** A call, or the kit's refusal of it. */
function attempt<T>(f: () => T): T | { error: string } {
  try {
    return f();
  } catch (e) {
    return { error: (e as Error).message };
  }
}

const sdk = JSON.parse(readFileSync(SDK_VECTORS, 'utf8')) as { keys: { label: string; address: string }[]; escrow: { h: string; secret: string }[] };
const labels = sdk.keys.map((k) => k.label);
const accountOf = (label: string) => privateKeyToAccount(hex0x(sha256(label)));

// ── Pins ────────────────────────────────────────────────────────────────────

const roles = knownRoleAddresses();
const pins = {
  phaContract: PHA_CONTRACT,
  defaultApi: DEFAULT_API,
  usdcDecimals: USDC_DECIMALS,
  maxFeeBps: MAX_FEE_BPS,
  minTradeUsdc: MIN_TRADE_USDC,
  soulReserve: SOUL_RESERVE,
  clockSkewMax: CLOCK_SKEW_MAX,
  phaLockGas: PHA_LOCK_GAS,
  phaTxLabels: PHA_TX_LABELS,
  phaTxTtlMs: PHA_TX_TTL_MS,
  phaHashVectors: PHA_HASH_VECTORS,
  cancelGas: CANCEL_GAS,
  permitSeconds: PERMIT_SECONDS,
  permitMaxSeconds: PERMIT_MAX_SECONDS,
  tokens: P2P_TOKENS,
  config: P2P_CONFIG,
  roles: { pha: [...roles.pha.entries()].sort(), base: [...roles.base.entries()].sort() }
};

// ── Base: addresses, calls, permits, transactions ───────────────────────────

const keys = labels.map((label) => ({ label, base: accountOf(label).address }));

const h = sdk.escrow[0]!.h;
const secret = sdk.escrow[0]!.secret;
const owner = accountOf(labels[0]!);
const claimer = accountOf(labels[1]!).address;

const evm = await Promise.all(NETWORKS.map(async (network) => {
  const cfg = P2P_CONFIG[network];
  const permits = [];
  for (const [amount, nonce, deadline] of [[1_000_000n, 0n, 1_795_000_000], [123_456_789n, 7n, 1_795_001_800]] as const) {
    const input = { owner: owner.address, amount, nonce, deadline };
    const td = attempt(() => permitTypedData(cfg, owner.address, amount, nonce, deadline));
    if ('error' in td) { permits.push({ input, error: td.error }); continue; }
    const signature = await owner.signTypedData(td);
    const p = parseSignature(signature);
    permits.push({ input, key: 0, digest: hashTypedData(td), signature, v: Number(p.v), yParity: p.yParity, r: p.r, s: p.s });
  }
  const sig = permits.find((p) => 'signature' in p) as { v: number; r: Hex; s: Hex } | undefined;
  const lock = { h, amount: 1_000_000n, claimer, deadline: 1_795_003_600, maxFeeBps: 50 };
  const calls: Record<string, { input: unknown; out: BaseCall | { error: string } }> = {
    approve: { input: { amount: 1_000_000n }, out: attempt(() => approveCall(cfg, 1_000_000n)) },
    lock: { input: lock, out: attempt(() => lockCallBase(cfg, lock)) },
    lockWithPermit: {
      input: { ...lock, permitDeadline: 1_795_001_800, v: sig?.v ?? 27, r: sig?.r ?? `0x${'11'.repeat(32)}`, s: sig?.s ?? `0x${'22'.repeat(32)}` },
      out: attempt(() => lockWithPermitCall(cfg, { ...lock, permitDeadline: 1_795_001_800, v: sig?.v ?? 27, r: sig?.r ?? `0x${'11'.repeat(32)}`, s: sig?.s ?? `0x${'22'.repeat(32)}` }))
    },
    claim: { input: { secret, sender: owner.address }, out: attempt(() => claimCallBase(cfg, secret, owner.address)) },
    refund: { input: { h, sender: owner.address }, out: attempt(() => refundCallBase(cfg, h, owner.address)) },
    withdrawOwed: { input: { claimer }, out: attempt(() => withdrawOwedCall(cfg, claimer)) },
    cancel: { input: { from: owner.address }, out: attempt(() => cancelCall(owner.address)) }
  };
  // EIP-1559 transactions exactly as src/signer.ts signs them: serializable(prepared), then the account signs.
  const txs = [];
  let nonce = 3;
  for (const fn of ['approve', 'lock', 'claim', 'refund', 'cancel'] as const) {
    const call = calls[fn]!.out;
    if ('error' in call) continue;
    const prepared = {
      chainId: cfg.base.chainId, from: owner.address.toLowerCase() as Hex, nonce: nonce++, gas: fn === 'cancel' ? CANCEL_GAS : 250_000n,
      maxFeePerGas: 1_500_000_000n + BigInt(nonce), maxPriorityFeePerGas: 1_000_000n, to: call.to, data: call.data, need: 0n
    };
    const ser = serializable(prepared);
    const signed = await owner.signTransaction(ser);
    txs.push({ fn, key: 0, prepared, unsigned: serializeTransaction(ser), signed, hash: keccak256(signed) });
  }
  return { network, chainId: cfg.base.chainId, domainSeparator: attempt(() => pinnedDomainSeparator(cfg)), calls, permits, txs };
}));

// ── Codec ───────────────────────────────────────────────────────────────────

const codec = {
  tokenHashes: ['0'.repeat(64), 'f'.repeat(64), sha256('token').toString('hex')].map((token) => ({ token, hash: tokenHashOf(token) })),
  secretHashes: [...PHA_HASH_VECTORS.map((v) => v.secret), ...sdk.escrow.slice(0, 4).map((e) => e.secret)].map((s) => ({ secret: s, h: hashOfSecret(s) })),
  decimals: [h, secret, `0x${'0'.repeat(64)}`, `0x${'f'.repeat(64)}`, `0x${'0'.repeat(63)}1`].map((x) => ({ hex: x.toLowerCase(), decimal: hexToDecimal(x) })),
  notDecimal: ['', '-1', '1.5', 'abc', ' 12 ', '115792089237316195423570985008687907853269984665640564039457584007913129639936'].map((d) => ({ input: d, hex: decimalToHex(d) }))
};

// ── Store seals: what the kit's own store wrote ─────────────────────────────

const SEAL_KEY = sha256('saturn-p2p-bot-kit rust port: store seal test key');
async function seals() {
  const dir = await mkdtemp(join(tmpdir(), 'kit-seal-'));
  try {
    const keyFile = join(dir, 'store.key');
    await writeFile(keyFile, SEAL_KEY.toString('hex') + '\n', { mode: 0o600 });
    const out = [];
    for (const network of NETWORKS) {
      const store = await openStore({ network, dataDir: join(dir, 'data'), keyFile, now: () => 1_795_000_000_000 });
      try {
        const s = sdk.escrow[1]!.secret;
        const rec: SecretRecord = {
          v: 1, secret: s, h: hashOfSecret(s), tradeId: 42, network, symbol: 'TAZ', taz: '200000000',
          sPha: sdk.keys[0]!.address, bPha: sdk.keys[1]!.address, role: 'S', createdAt: 1_795_000_000_000
        };
        await store.putSecret(rec);
        const record = await store.getSecret(rec.h);
        for (const name of await readdir(join(store.dir, 'secrets'))) {
          const rel = `secrets/${name}`;
          const text = await readFile(join(store.dir, rel), 'utf8');
          const sealed = JSON.parse(text) as { iv: string; tag: string; data: string };
          const d = createDecipheriv('aes-256-gcm', SEAL_KEY, Buffer.from(sealed.iv, 'base64'), { authTagLength: 16 });
          d.setAAD(Buffer.from(`saturn-p2p-bot-kit|v1|${network}|${rel}`, 'utf8'));
          d.setAuthTag(Buffer.from(sealed.tag, 'base64'));
          const plain = Buffer.concat([d.update(Buffer.from(sealed.data, 'base64')), d.final()]).toString('utf8');
          out.push({ network, rel, file: text, plain, record });
        }
      } finally {
        await store.close();
      }
    }
    return { key: SEAL_KEY.toString('hex'), files: out };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const vectors = {
  about: 'Made by rust/tools/make-vectors.ts from the TypeScript kit; see that file.',
  kit: (JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { version: string }).version,
  pins,
  keys,
  evm,
  codec,
  seals: await seals()
};
writeFileSync(OUT, json(vectors));
console.log(`wrote ${OUT}`);
