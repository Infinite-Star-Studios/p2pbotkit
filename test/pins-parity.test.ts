/**
 * The kit's pins (src/pins.ts) and codec (src/codec.ts) against the site's
 * src/lib/p2p/constants.js and secret.js and the backend's src/p2p/config.ts
 * and codec.ts (build spec sections 6.1 and 6.8): every constant a signature
 * depends on is the same value in all three. The backend's .ts files are
 * imported under tsx; the site's network table (dex/network.js) imports
 * SvelteKit aliases, so it is read as text.
 *
 * Skipped only when the kit is not checked out beside the site and the
 * backend (a downloaded kit); inside the repository every case runs.
 *
 * Also here: the kit's own dependency pins (package.json) and the lockfile
 * the quick start's `npm ci --ignore-scripts` installs from (package-lock.json),
 * and instant mode's INSTANT against the backend's INSTANT_TIMING (build spec
 * section 3.10.2; the backend's config.ts and logic.ts imported under tsx);
 * and the role addresses a bot's key may not be (check 68): K1's keeper keys
 * and K0's retired ones (WP-00), the same addresses as the P2P signer's
 * ROLE_ADDRESSES (p2p/packages/signer-core/src/pins.ts, imported under tsx;
 * skipped when p2p/ is not checked out beside the kit).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { getAddress } from 'viem';
import * as pins from '../src/pins.js';
import * as codec from '../src/codec.js';

const SITE = new URL('../../frontend/src/lib/p2p/constants.js', import.meta.url);
const SITE_SECRET = new URL('../../frontend/src/lib/p2p/secret.js', import.meta.url);
const SITE_NETWORK = new URL('../../frontend/src/lib/dex/network.js', import.meta.url);
const BACKEND = new URL('../../backend/src/p2p/config.ts', import.meta.url);
const BACKEND_CODEC = new URL('../../backend/src/p2p/codec.ts', import.meta.url);
const BACKEND_ENV = new URL('../../backend/src/config.ts', import.meta.url);
const BACKEND_LOGIC = new URL('../../backend/src/p2p/logic.ts', import.meta.url);
/** The repository's own README (absent in a downloaded kit). */
const ROOT_README = new URL('../../README.md', import.meta.url);
/** The P2P service's signer pins (p2p/, absent in a downloaded kit): its ROLE_ADDRESSES. */
const SIGNER_PINS = new URL('../../p2p/packages/signer-core/src/pins.ts', import.meta.url);
const NETS = ['devnet', 'mainnet'] as const;

const siteHere = existsSync(SITE) && existsSync(SITE_SECRET) && existsSync(SITE_NETWORK);
const backendHere = existsSync(BACKEND) && existsSync(BACKEND_CODEC) && existsSync(BACKEND_ENV) && existsSync(BACKEND_LOGIC);
const signerHere = existsSync(SIGNER_PINS);
const NO_SITE = 'the site (frontend/) is not checked out beside the kit';
const NO_BACKEND = 'the backend (backend/) is not checked out beside the kit';
const NO_SIGNER = 'the P2P service (p2p/) is not checked out beside the kit';

/** A token row with every field as a comparable primitive. */
const tokenRow = (x: any) => ({
  symbol: String(x.symbol), decimals: Number(x.decimals), min: BigInt(String(x.min)), max: BigInt(String(x.max)),
  offerMax: BigInt(String(x.offerMax)), priceMax: BigInt(String(x.priceMax)), enabled: x.enabled !== false, gas: !!x.gas, stake: !!x.stake
});

/** The site's eleven P2PTiming fields. */
const SITE_TIMING_KEYS = ['phaLock', 'safety', 'revealMin', 'baseLockLead', 'revealAllowance', 'claimMargin', 'claimWatch', 'refundGrace', 'lockSlack', 'baseLockWindow', 'baseLockSignLead'];

test('package.json: exactly viem 2.57.4 and phantasma-sdk-ts 0.20.0; dev tsx ^4.19.2, typescript ^5.6.3, @types/node ^22; the gate scripts', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.name, 'saturn-p2p-bot-kit');
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines?.node, '>=22');
  assert.deepEqual(pkg.dependencies, { 'phantasma-sdk-ts': '0.20.0', viem: '2.57.4' }, 'no other runtime package; exact versions');
  assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ['@types/node', 'tsx', 'typescript']);
  assert.equal(pkg.devDependencies.tsx, '^4.19.2');
  assert.equal(pkg.devDependencies.typescript, '^5.6.3');
  assert.match(pkg.devDependencies['@types/node'], /^\^22(\.|$)/);
  assert.equal(pkg.scripts.test, 'node --import tsx --test test/*.test.ts');
  assert.equal(pkg.scripts.check, 'tsc --noEmit');
  for (const s of ['seller', 'buyer', 'faucet']) assert.match(pkg.scripts[s], /^tsx examples\/[a-z-]+\.ts$/, s);
  // viem is the site's pin. The backend keeper runs phantasma-sdk-ts 0.4.0, whose keys, escrow transactions and view
  // scripts test/sdk-vectors.test.ts holds the kit's 0.20.0 to, byte for byte; a keeper on any other version is not covered.
  const site = new URL('../../frontend/package.json', import.meta.url);
  const backend = new URL('../../backend/package.json', import.meta.url);
  // Only beside Saturn's own site and backend (siteHere, backendHere): a clone next to some other frontend/ or backend/ folder skips these.
  if (siteHere && existsSync(site)) assert.equal(JSON.parse(readFileSync(site, 'utf8')).dependencies.viem, '2.57.4', 'the site pins the same viem');
  if (backendHere && existsSync(backend)) {
    const keeper = String(JSON.parse(readFileSync(backend, 'utf8')).dependencies['phantasma-sdk-ts']).replace(/^\^/, '');
    assert.ok(['0.4.0', '0.20.0'].includes(keeper), `the backend keeper runs phantasma-sdk-ts 0.4.0 (the vectors' version) or the kit's 0.20.0, not ${keeper}`);
  }
});

test('.gitignore keeps data/, keys/ and node_modules/ out of the repository, and keeps package-lock.json in it', () => {
  const lines = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8').split('\n').map((l) => l.trim());
  for (const p of ['data/', 'keys/', 'node_modules/']) assert.ok(lines.includes(p), p);
  // The repository's own .gitignore leaves lockfiles out; the kit's lockfile is the one exception (build spec section 11.y).
  assert.ok(lines.includes('!package-lock.json'), 'the kit tracks its lockfile');
  assert.ok(!lines.some((l) => /^\/?package-lock\.json$/.test(l) || /^\*+\.json$/.test(l) || l === '*'), 'nothing ignores the lockfile');
});

test('the repository README names the kit\'s lockfile as tracked and shipped, unlike the site\'s untracked one', { skip: siteHere && existsSync(ROOT_README) ? false : NO_SITE }, () => {
  const t = readFileSync(ROOT_README, 'utf8').replace(/\s+/g, ' ');
  // The site's lockfile is not tracked; the backend's is, since its image build (b7cc4fe) installs with `npm ci`.
  assert.match(t, /The frontend's lockfile is not tracked/, 'the rule for frontend/');
  assert.match(t, /the kit tracks its `package-lock\.json`,? and ships it in the download/);
  assert.match(t, /installs exactly the locked packages with `npm ci --ignore-scripts`/);
});

test('package-lock.json ships with the kit: in step with package.json, viem 2.57.4 and phantasma-sdk-ts 0.20.0 exactly, no elliptic or Ledger modules, every package from the npm registry with its hash', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.ok(lock.lockfileVersion === 2 || lock.lockfileVersion === 3, `a lockfile npm 7 or later wrote (lockfileVersion ${lock.lockfileVersion})`);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  // `npm ci` refuses a lockfile whose root differs from package.json.
  const root = lock.packages?.[''];
  assert.ok(root, 'the lockfile has its root entry');
  assert.deepEqual(root.dependencies, pkg.dependencies, 'dependencies');
  assert.deepEqual(root.devDependencies, pkg.devDependencies, 'devDependencies');
  // The two direct dependencies resolve to their exact pins, once, from the npm registry.
  for (const [name, version] of [['viem', '2.57.4'], ['phantasma-sdk-ts', '0.20.0']] as const) {
    const entry = lock.packages[`node_modules/${name}`];
    assert.ok(entry, `${name} is locked`);
    assert.equal(entry.version, version, `${name} resolves to ${version}`);
    assert.equal(entry.resolved, `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`, `${name} comes from the npm registry`);
    assert.match(entry.integrity ?? '', /^sha512-[A-Za-z0-9+/]+={0,2}$/, `${name} has its sha512 hash`);
    assert.ok(!entry.dev && !entry.optional, `${name} is a runtime package`);
    const copies = Object.keys(lock.packages).filter((k) => k.endsWith(`node_modules/${name}`));
    assert.deepEqual(copies, [`node_modules/${name}`], `one copy of ${name}`);
  }
  // 0.20.0 signs with tweetnacl and has no Ledger support: no elliptic (GHSA-848j-6mx2-7j84) and none of the USB
  // modules 0.4.0 brought. Only tsx's esbuild and fsevents (tsx's macOS file watcher) have install scripts, which
  // `npm ci --ignore-scripts` skips; both are development packages.
  const names = Object.keys(lock.packages).filter(Boolean).map((p) => p.slice(p.lastIndexOf('node_modules/') + 'node_modules/'.length));
  assert.deepEqual(names.filter((n) => n === 'elliptic' || n.startsWith('@ledgerhq/') || n === 'node-hid' || n === 'usb'), [], 'no elliptic, no Ledger or USB module');
  const scripted = Object.entries<any>(lock.packages).filter(([, e]) => e.hasInstallScript);
  assert.deepEqual(scripted.map(([p]) => p).sort(), ['node_modules/esbuild', 'node_modules/fsevents'], 'the packages with an install script');
  for (const [p, e] of scripted) assert.equal(e.dev, true, `${p} is a development package`);
  // Every other locked package: fetched from the npm registry only, each with an integrity hash npm checks.
  const bad: string[] = [];
  for (const [path, entry] of Object.entries<any>(lock.packages)) {
    if (path === '' || entry.link) continue;
    if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith('https://registry.npmjs.org/')) bad.push(`${path}: resolved ${entry.resolved}`);
    if (typeof entry.integrity !== 'string' || !/^sha(512|384|256)-/.test(entry.integrity)) bad.push(`${path}: no integrity hash`);
  }
  assert.deepEqual(bad, []);
});

test('pins.ts equals the site\'s constants.js: tokens, escrow pins, Base pins, timing, BOARD, vectors, gas, fees', { skip: siteHere ? false : NO_SITE }, async () => {
  const site: any = await import(SITE.href);
  assert.deepEqual(pins.P2P_TOKENS.map(tokenRow), site.P2P_TOKENS.map(tokenRow), 'P2P_TOKENS, in the same order');
  assert.deepEqual([...pins.P2P_SYMBOLS], [...site.P2P_SYMBOLS]);
  assert.equal(pins.PHA_CONTRACT, site.PHA_CONTRACT);
  assert.equal(pins.USDC_DECIMALS, site.USDC_DECIMALS);
  assert.equal(pins.MAX_FEE_BPS, site.MAX_FEE_BPS);
  assert.equal(pins.MAX_FEE_BPS, 200);
  assert.equal(pins.MIN_TRADE_USDC, site.MIN_TRADE_USDC);
  assert.equal(pins.KCAL_DECIMALS, site.KCAL_DECIMALS);
  assert.deepEqual({ ...pins.PHA_LOCK_GAS }, { ...site.PHA_LOCK_GAS });
  assert.deepEqual({ ...pins.PHA_LOCK_GAS }, { price: 100_000, limit: 300_000 }, 'gas 100,000 x 300,000');
  assert.equal(pins.PHA_LOCK_KCAL, site.PHA_LOCK_KCAL);
  assert.equal(pins.SOUL_RESERVE, site.SOUL_RESERVE);
  assert.equal(pins.BASE_BLOCK_SECONDS, site.BASE_BLOCK_SECONDS);
  assert.equal(pins.CLOCK_SKEW_MAX, site.CLOCK_SKEW_MAX);
  assert.deepEqual({ ...pins.BOARD }, { ...site.BOARD }, 'BOARD');
  assert.deepEqual(pins.PHA_HASH_VECTORS.map((v) => ({ ...v })), site.PHA_HASH_VECTORS.map((v: any) => ({ ...v })), 'PHA_HASH_VECTORS');
  for (const n of NETS) {
    const k = pins.P2P_CONFIG[n], s = site.P2P_CONFIG[n];
    assert.equal(k.network, s.network, n);
    assert.equal(k.phaContract, s.phaContract, `${n} escrow name`);
    assert.equal(k.phaCodeSha256, s.phaCodeSha256, `${n} PHA_CODE_SHA256`);
    assert.equal(k.phaAdmin, s.phaAdmin, `${n} PHA_ADMIN`);
    assert.deepEqual(k.phaDraining.map((d) => ({ ...d })), s.phaDraining.map((d: any) => ({ ...d })), `${n} draining escrows`);
    assert.equal(k.phaClaimKcal, s.phaClaimKcal, `${n} PHA_CLAIM_KCAL`);
    const kb = k.base, sb = s.base;
    for (const f of ['name', 'chainId', 'rpcUrl', 'explorerUrl', 'swap', 'usdc', 'usdcSymbol', 'confirmBlocks', 'confirmSafe', 'usdcHasBlacklist', 'usdcMin', 'usdcMax', 'faucetMax', 'lockWithPermitGas'] as const) {
      assert.equal(kb[f], sb[f], `${n} base.${f}`);
    }
    assert.deepEqual({ ...kb.nativeCurrency }, { ...sb.nativeCurrency }, `${n} base.nativeCurrency`);
    assert.deepEqual({ ...kb.permit }, { ...sb.permit }, `${n} base.permit (the USDC permit domain, check 46)`);
    assert.deepEqual({ ...kb.feeCaps }, { ...sb.signerCaps }, `${n}: the kit signs Base fees under the site's caps`);
    assert.deepEqual(Object.keys(s.timing).sort(), [...SITE_TIMING_KEYS].sort(), `${n}: the site's timing fields`);
    for (const f of SITE_TIMING_KEYS) assert.equal((k.timing as any)[f], s.timing[f], `${n} timing.${f}`);
    // The helpers answer the same on the same inputs.
    assert.equal(pins.phaPinned(k), site.phaPinned(s), `${n} phaPinned`);
    assert.equal(pins.baseDeployed(k), site.baseDeployed(s), `${n} baseDeployed`);
    for (const name of [undefined, null, '', 'saturnescrow', 'saturnp2p', 'other']) {
      const a = pins.escrowCfg(k, name), b = site.escrowCfg(s, name);
      assert.equal(a === null, b === null, `${n} escrowCfg(${String(name)})`);
      if (a && b) assert.deepEqual([a.phaContract, a.phaCodeSha256, a.phaAdmin], [b.phaContract, b.phaCodeSha256, b.phaAdmin]);
    }
  }
  for (const sym of ['C', 'RA', 'TAZ', 'SOUL', 'KCAL', 'c', 'taz', ' TAZ', 'TAZ ', '__proto__', 'constructor', 'DOGE', '', null, undefined, 7, {}]) {
    const a = pins.tokenOf(sym), b = site.tokenOf(sym);
    assert.equal(a?.symbol ?? null, b?.symbol ?? null, `tokenOf(${String(sym)})`);
  }
  for (const name of ['saturnescrow', 'ab', 'abc', 'Saturn', 'a'.repeat(32), 'a'.repeat(33), '1abc', null, 3]) {
    assert.equal(pins.isContractName(name), site.isContractName(name), `isContractName(${String(name)})`);
  }
  for (const n of NETS) assert.equal(pins.p2pConfig(n)?.network, site.p2pConfig(n)?.network);
  assert.equal(pins.p2pConfig('testnet'), null);
  assert.equal(site.p2pConfig('testnet'), null);
});

test('the Phantasma RPC pins equal the site\'s network table (dex/network.js), and each default host is on its allowlist (check 67)', { skip: siteHere ? false : NO_SITE }, () => {
  const text = readFileSync(SITE_NETWORK, 'utf8');
  for (const n of NETS) {
    const block = new RegExp(`\\b${n}:\\s*\\{([^}]*)\\}`).exec(text)?.[1] ?? '';
    const field = (f: string) => new RegExp(`\\b${f}:\\s*'([^']*)'`).exec(block)?.[1];
    const k = pins.P2P_CONFIG[n].pha;
    assert.equal(k.rpcUrl, field('rpcUrl'), `${n} rpcUrl`);
    assert.equal(k.nexus, field('nexus'), `${n} nexus`);
    assert.equal(k.chain, field('chain'), `${n} chain`);
    assert.equal(k.explorerUrl, field('explorerUrl'), `${n} explorerUrl`);
    assert.ok(k.rpcHosts.includes(new URL(k.rpcUrl).hostname), `${n}: the default RPC host is allowed`);
    assert.equal(pins.phaRpcProblem(n, k.rpcUrl), null);
  }
  assert.deepEqual([...pins.P2P_CONFIG.devnet.pha.rpcHosts], ['devnet.phantasma.info']);
  assert.deepEqual([...pins.P2P_CONFIG.mainnet.pha.rpcHosts], ['pharpc1.phantasma.info']);
});

test('pins.ts equals the backend\'s p2p/config.ts (imported under tsx): tokens, timing, escrow pins, Base pins, vectors, fees, USDC bounds, KCAL claim', { skip: backendHere ? false : NO_BACKEND }, async () => {
  const be: any = await import(BACKEND.href);
  const env: any = await import(BACKEND_ENV.href);
  assert.deepEqual(pins.P2P_TOKENS.map(tokenRow), be.P2P_TOKENS.map(tokenRow), 'P2P_TOKENS, in the same order');
  assert.equal(pins.MAX_FEE_BPS, be.MAX_FEE_BPS);
  assert.equal(pins.USDC_DECIMALS, be.USDC_DECIMALS);
  assert.deepEqual(pins.PHA_HASH_VECTORS.map((v) => v.digest), be.PHA_HASH_VECTORS.map((v: any) => v.digest));
  assert.deepEqual(pins.PHA_HASH_VECTORS.map((v) => codec.hexToBigInt(v.secret)), be.PHA_HASH_VECTORS.map((v: any) => v.secret), 'the same secrets');
  for (const n of NETS) {
    const k = pins.P2P_CONFIG[n];
    const t = be.TIMING[n];
    // The backend's names for the same limits.
    const pairs: Array<[keyof pins.P2PTiming, string]> = [
      ['phaLock', 'phaLock'], ['safety', 'safety'], ['revealMin', 'revealMin'], ['baseLockLead', 'baseLockLead'], ['lockSlack', 'lockSlack'],
      ['baseLockWindow', 'baseLockWindow'], ['baseLockSignLead', 'baseWindowLead'], ['revealAllowance', 'revealAllowance'], ['claimMargin', 'baseClaimMargin'],
      ['claimWatch', 'claimWatch'], ['phaRefundGrace', 'phaRefundGrace'], ['baseRefundGrace', 'baseRefundGrace'], ['refundGrace', 'baseRefundGrace']
    ];
    for (const [kk, bk] of pairs) assert.equal(k.timing[kk], t[bk], `${n} timing.${kk} = backend ${bk}`);
    assert.equal(pins.BOARD.heartbeatTtl, t.heartbeatTtl, `${n} heartbeatTtl`);
    assert.equal(pins.BOARD.acceptTimeout, t.acceptTimeout, `${n} acceptTimeout`);
    assert.equal(pins.BOARD.lockWait, t.lockWait, `${n} lockWait`);
    const list = be.PHA_CONTRACTS[n];
    const cur = be.currentContract(list);
    assert.equal(k.phaContract, cur.name, `${n} current escrow`);
    assert.equal(k.phaCodeSha256, cur.codeSha256, `${n} PHA_CODE_SHA256`);
    assert.equal(k.phaAdmin, cur.admin, `${n} PHA_ADMIN`);
    assert.deepEqual(k.phaDraining.map((d) => d.name), list.filter((c: any) => !c.current).map((c: any) => c.name), `${n} draining escrows`);
    const pb = be.PINNED_BASE[n];
    assert.equal(k.base.swap.toLowerCase(), pb.contract.toLowerCase(), `${n} SaturnSwap`);
    assert.equal(k.base.usdc.toLowerCase(), pb.usdc.toLowerCase(), `${n} USDC`);
    assert.equal(k.base.usdcHasBlacklist, pb.usdcHasBlacklist, `${n} usdcHasBlacklist`);
    assert.equal(k.base.usdcMin, be.USDC_BOUNDS[n].min, `${n} USDC_MIN`);
    assert.equal(k.base.usdcMax, be.USDC_BOUNDS[n].max, `${n} USDC_MAX`);
    assert.equal(k.phaClaimKcal, be.kcalRules(pins.PHA_LOCK_GAS).claim, `${n} PHA_CLAIM_KCAL = the claim allowance at the kit's gas`);
    const cfg = be.p2pConfig(n);
    assert.equal(k.base.chainId, cfg.base.chainId, `${n} chain id`);
    assert.equal(k.base.name, cfg.base.name, `${n} Base name`);
    assert.equal(k.base.confirmSafe ? 'safe' : k.base.confirmBlocks, cfg.base.confirmations, `${n} the Base confirm rule`);
    assert.equal(k.pha.nexus, env.NETWORKS[n].nexus, `${n} nexus`);
    const envName = n === 'devnet' ? 'PHANTASMA_RPC_DEVNET' : 'PHANTASMA_RPC_MAINNET';
    if (!process.env[envName]) assert.equal(k.pha.rpcUrl, env.NETWORKS[n].rpcUrl, `${n} Phantasma RPC`);
  }
  // The backend never lets a test deploy's admin key keep mainnet; the kit refuses every one of them as a bot key.
  const known = pins.knownRoleAddresses();
  for (const a of be.TEST_ADMINS) assert.ok(known.pha.has(a), `${a} is refused as a bot key`);
});

test('INSTANT equals the backend\'s p2p/config.ts INSTANT_TIMING (imported under tsx), field by field on both networks; T_B - now; the margins of logic.ts INSTANT; devnet only', { skip: backendHere ? false : NO_BACKEND }, async () => {
  const be: any = await import(BACKEND.href);
  const logic: any = await import(BACKEND_LOGIC.href);
  const FIELDS = ['I_WIN', 'I_WIN_LEAD', 'I_PHA', 'I_CLAIM', 'I_SAFETY', 'I_SLACK'];
  for (const n of NETS) {
    const k = pins.INSTANT[n], b = be.INSTANT_TIMING[n];
    assert.deepEqual(Object.keys(k).sort(), [...FIELDS].sort(), `${n}: the kit's INSTANT fields`);
    assert.deepEqual(Object.keys(b).sort(), [...FIELDS].sort(), `${n}: the backend's INSTANT_TIMING fields`);
    for (const f of FIELDS) assert.equal((k as any)[f], b[f], `${n} INSTANT.${f} = backend INSTANT_TIMING.${f}`);
    assert.equal(pins.instantBaseSpan(k), be.instantBaseSpan(b), `${n}: T_B - now when the buyer locks`);
    assert.ok(Object.isFrozen(k), `${n}: INSTANT is frozen`);
    // What /config shows (display only) is the same table under the board's names.
    assert.deepEqual(be.instantTimingJson(b), { sellerWindow: k.I_WIN, sellerLead: k.I_WIN_LEAD, phaLock: k.I_PHA, claimMargin: k.I_CLAIM, safety: k.I_SAFETY, slack: k.I_SLACK });
  }
  // The spec's own figures (build spec section 3.10.2).
  assert.deepEqual({ ...pins.INSTANT.devnet }, { I_WIN: 300, I_WIN_LEAD: 120, I_PHA: 900, I_CLAIM: 300, I_SAFETY: 600, I_SLACK: 120 });
  assert.deepEqual({ ...pins.INSTANT.mainnet }, { I_WIN: 600, I_WIN_LEAD: 300, I_PHA: 3900, I_CLAIM: 900, I_SAFETY: 3600, I_SLACK: 300 });
  assert.equal(pins.instantBaseSpan(pins.INSTANT.devnet), 1920, 'devnet: 32 minutes');
  assert.equal(pins.instantBaseSpan(pins.INSTANT.mainnet), 8400, 'mainnet: 2 h 20 min');
  assert.equal(pins.INSTANT.devnet.I_WIN - pins.INSTANT.devnet.I_WIN_LEAD, 180, 'devnet: the seller starts its lock within 180 s of t_B');
  assert.equal(pins.INSTANT.mainnet.I_WIN - pins.INSTANT.mainnet.I_WIN_LEAD, 300);
  // The margins the board applies to the same trades.
  assert.equal(pins.INSTANT_RULES.claimMin, logic.INSTANT.baseClaimMinS, 'the USDC claim needs T_B - now >= 60 s, as the keeper\'s');
  assert.equal(pins.INSTANT_RULES.phaLockSlack, logic.INSTANT.phaLockSlackS);
  assert.equal(pins.INSTANT_RULES.baseSpanSlack, logic.INSTANT.baseSpanSlackS);
  assert.ok(pins.INSTANT_RULES.watchEvery > 0 && pins.INSTANT_RULES.watchEvery <= 15, 'getState(h) at least every 15 s');
  // The escrow's minimum lock (devnet 60 s, mainnet 3,600 s) is under I_PHA, with mainnet's 300 s margin.
  assert.ok(pins.INSTANT.mainnet.I_PHA - 3_600 >= 300);
  // Instant trades: devnet only. The backend's default lists no network, and the kit posts none on mainnet.
  assert.deepEqual([...be.parseInstantConfig({}).networks], []);
  assert.deepEqual([...pins.INSTANT_NETWORKS], ['devnet']);
  assert.equal(pins.instantTiming('mainnet'), null);
  assert.equal(pins.instantTiming('devnet'), pins.INSTANT.devnet);
  assert.equal(pins.instantTiming('testnet'), null);
  // The site's INSTANT (constants.js, build spec section 4.12) once it is beside the kit: the same table, three ways.
  if (siteHere) {
    const site: any = await import(SITE.href);
    if (site.INSTANT) for (const n of NETS) assert.deepEqual({ ...pins.INSTANT[n] }, { ...site.INSTANT[n] }, `${n}: the site's INSTANT`);
    if (site.INSTANT_NETWORKS) assert.deepEqual([...pins.INSTANT_NETWORKS], [...site.INSTANT_NETWORKS], 'the site\'s INSTANT_NETWORKS');
    if (site.INSTANT_RULES?.phaLockSlack !== undefined) assert.equal(pins.INSTANT_RULES.phaLockSlack, site.INSTANT_RULES.phaLockSlack, 'the site\'s INSTANT_RULES.phaLockSlack');
  }
});

test('INSTANT reads back from pins.ts as text with the regex the site uses for the backend\'s INSTANT_TIMING (the three-way check of build spec decision 16 parses the kit\'s file the same way)', () => {
  const block = (src: string, name: string) => src.match(new RegExp(`export const ${name}[^=]*=\\s*Object\\.freeze\\(\\{([\\s\\S]*?)\\}\\);`))?.[1];
  const table = (b: string) => Object.fromEntries(NETS.map((n) => {
    const row = b.match(new RegExp(`${n}:\\s*Object\\.freeze\\(\\{([^}]*)\\}\\)`))?.[1] ?? '';
    return [n, Object.fromEntries([...row.matchAll(/(I_[A-Z_]+):\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]))];
  }));
  const kit = block(readFileSync(new URL('../src/pins.ts', import.meta.url), 'utf8'), 'INSTANT:');
  assert.ok(kit, 'export const INSTANT: ... = Object.freeze({ ... }); in src/pins.ts');
  const parsed = table(kit!);
  for (const n of NETS) assert.deepEqual(parsed[n], { ...pins.INSTANT[n] }, `${n}: pins.ts as text`);
  if (backendHere) {
    const be = block(readFileSync(BACKEND, 'utf8'), 'INSTANT_TIMING');
    assert.ok(be, 'INSTANT_TIMING in backend/src/p2p/config.ts');
    assert.deepEqual(table(be!), parsed, 'the backend\'s INSTANT_TIMING, as text');
  }
});

test('codec.ts: the hash vectors, hex <-> decimal and the control-token hash agree with the site (secret.js) and the backend (codec.ts)', async (t) => {
  for (const v of pins.PHA_HASH_VECTORS) assert.equal(codec.hashOfSecret(v.secret), v.digest, `sha256(${v.secret.slice(0, 6)}…)`);
  // The shared vector of build spec section 2.1.4: sha256Hex of the 64-character string, never of the raw bytes.
  const zero = '0'.repeat(64);
  assert.equal(codec.tokenHashOf(zero), '60e05bd1b195af2f94112fa7197a5c88289058840ce7c6df9693756bc6250f55');
  assert.notEqual(codec.tokenHashOf(zero), '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925');
  assert.equal(codec.sha256Hex(new Uint8Array(32)), '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925', 'the raw-bytes hash is a different value');
  assert.throws(() => codec.tokenHashOf('A'.repeat(64)), /64 lowercase hex/);
  assert.throws(() => codec.tokenHashOf('0'.repeat(63)), /64 lowercase hex/);
  const tok = codec.newControlToken();
  assert.match(tok, /^[0-9a-f]{64}$/);
  assert.notEqual(codec.newControlToken(), tok);
  const sec = codec.newSecret();
  assert.match(sec, codec.HEX32);
  assert.ok(codec.secretOpens(sec, codec.hashOfSecret(sec)));
  assert.ok(codec.secretOpens(sec.toUpperCase().replace('0X', '0x'), codec.hashOfSecret(sec).toUpperCase().replace('0X', '0x')), 'any case');
  assert.equal(codec.secretOpens(sec, codec.hashOfSecret(codec.newSecret())), false);
  assert.equal(codec.secretOpens('0x12', codec.hashOfSecret(sec)), false);
  assert.equal(codec.secretOpens(null, undefined), false);
  const samples = ['0x' + '00'.repeat(32), '0x' + 'ff'.repeat(32), '0x80' + '00'.repeat(31), '0x' + '0'.repeat(63) + '1', sec];
  const decimals = ['0', '1', '115792089237316195423570985008687907853269984665640564039457584007913129639935', '115792089237316195423570985008687907853269984665640564039457584007913129639936', '-1', '1.5', '', 'abc', ' 42 ', '0x10'];
  for (const h of samples) assert.equal(codec.decimalToHex(codec.hexToDecimal(h)), h.toLowerCase(), 'round trip');
  await t.test('the site\'s secret.js', { skip: siteHere ? false : NO_SITE }, async () => {
    const s: any = await import(SITE_SECRET.href);
    for (const v of pins.PHA_HASH_VECTORS) assert.equal(await s.hashOfSecret(v.secret), codec.hashOfSecret(v.secret));
    for (const h of samples) {
      assert.equal(codec.hexToDecimal(h), s.hexToDecimal(h));
      assert.equal(await s.hashOfSecret(h), codec.hashOfSecret(h));
      assert.equal(await s.secretOpens(h, codec.hashOfSecret(h)), codec.secretOpens(h, codec.hashOfSecret(h)));
    }
    for (const d of decimals) assert.equal(codec.decimalToHex(d), s.decimalToHex(d), `decimalToHex(${JSON.stringify(d)})`);
    for (const v of ['0x' + 'a'.repeat(64), '0x' + 'A'.repeat(64), 'a'.repeat(64), '0x' + 'a'.repeat(63), '0x' + 'g'.repeat(64), null, 42]) {
      assert.equal(codec.isHex32(v), s.isHex32(v), `isHex32(${String(v)})`);
    }
    assert.equal(codec.UINT256_MAX, s.UINT256_MAX);
  });
  await t.test('the backend\'s codec.ts', { skip: backendHere ? false : NO_BACKEND }, async () => {
    const b: any = await import(BACKEND_CODEC.href);
    for (const h of samples) {
      assert.equal(codec.hexToDecimal(h), b.hexToDecimal(h));
      assert.equal(codec.hashOfSecret(h), b.hashOfSecret(h));
      assert.equal(codec.secretOpens(h, codec.hashOfSecret(h)), b.secretMatches(h, codec.hashOfSecret(h)));
      assert.equal(codec.cleanHex32(h.toUpperCase().replace('0X', '0x')), b.cleanHex32(h.toUpperCase().replace('0X', '0x')));
    }
    for (const d of decimals) assert.equal(codec.decimalToHex(d), b.decimalToHex(d), `decimalToHex(${JSON.stringify(d)})`);
  });
});

/** Whether this release pins mainnet's escrow and SaturnSwap (the owner fills them at launch, P2P/LAUNCH.md step 9). */
const MAINNET_PINNED = pins.phaPinned(pins.P2P_CONFIG.mainnet) && pins.baseDeployed(pins.P2P_CONFIG.mainnet);
/** Mainnet's settings with the escrow and SaturnSwap pins emptied: the refusal of an unpinned network, whatever this release pins. */
const UNPINNED = Object.freeze({ ...pins.P2P_CONFIG.mainnet, phaCodeSha256: '', phaAdmin: '', base: Object.freeze({ ...pins.P2P_CONFIG.mainnet.base, swap: '' }) });

test('mainnet: always behind allowMainnet and KIT_ALLOW_MAINNET=1; refused while a pin is empty (this release); pins once filled are well formed', () => {
  const m = pins.P2P_CONFIG.mainnet, d = pins.P2P_CONFIG.devnet;
  // The gate, whatever the pins.
  assert.match(pins.networkProblem('mainnet') ?? '', /allowMainnet/);
  assert.match(pins.networkProblem('mainnet', { allowMainnet: true, env: {} }) ?? '', /KIT_ALLOW_MAINNET/);
  assert.match(pins.networkProblem('mainnet', { allowMainnet: false, env: { KIT_ALLOW_MAINNET: '1' } }) ?? '', /allowMainnet/);
  assert.equal(pins.networkProblem('devnet', { env: {} }), null);
  assert.match(pins.networkProblem('testnet') ?? '', /devnet or mainnet/);
  assert.equal(pins.phaPinned(d), true);
  assert.equal(pins.baseDeployed(d), true);
  // An unpinned network refuses: empty escrow pins, an empty SaturnSwap pin, or a malformed one.
  assert.equal(pins.phaPinned(UNPINNED), false);
  assert.equal(pins.baseDeployed(UNPINNED), false);
  assert.equal(pins.phaPinned({ phaCodeSha256: 'ab'.repeat(32), phaAdmin: '' }), false);
  assert.equal(pins.phaPinned({ phaCodeSha256: 'AB'.repeat(32), phaAdmin: d.phaAdmin }), false, 'the code hash is lowercase hex');
  assert.equal(pins.phaPinned({ phaCodeSha256: 'ab'.repeat(32), phaAdmin: d.phaAdmin }), true);
  assert.equal(pins.baseDeployed({ base: { ...UNPINNED.base, swap: '0x1234' } }), false);
  const both = { allowMainnet: true, env: { KIT_ALLOW_MAINNET: '1' } };
  // Each filled pin is well formed (a release may fill them together only; until then mainnet refuses).
  if (m.phaCodeSha256) assert.match(m.phaCodeSha256, /^[0-9a-f]{64}$/, 'PHA_CODE_SHA256');
  if (m.phaAdmin) {
    assert.match(m.phaAdmin, /^P2K[1-9A-HJ-NP-Za-km-z]{40,50}$/, 'PHA_ADMIN');
    assert.notEqual(m.phaAdmin, d.phaAdmin, 'not the devnet admin');
  }
  if (m.base.swap) {
    assert.match(m.base.swap, /^0x[0-9a-fA-F]{40}$/, 'SaturnSwap');
    assert.notEqual(m.base.swap.toLowerCase(), d.base.swap.toLowerCase(), 'not the devnet SaturnSwap');
  }
  if (MAINNET_PINNED) {
    // Filled at launch: with both gates given, mainnet runs.
    assert.equal(pins.networkProblem('mainnet', both), null);
  } else {
    // This release: refused even with both gates given.
    assert.match(pins.networkProblem('mainnet', both) ?? '', /no (escrow pins|SaturnSwap pin) for mainnet/);
    if (!pins.phaPinned(m)) assert.match(pins.networkProblem('mainnet', both) ?? '', /no escrow pins for mainnet/);
  }
});

test('RPC allowlist helpers (check 67): Phantasma hosts per network only, https, no user part or port; Base https or loopback http', () => {
  assert.equal(pins.phaRpcProblem('devnet', 'https://devnet.phantasma.info/rpc'), null);
  assert.equal(pins.phaRpcProblem('devnet', 'https://DEVNET.phantasma.info/rpc'), null);
  assert.match(pins.phaRpcProblem('devnet', 'https://pharpc1.phantasma.info/rpc') ?? '', /devnet\.phantasma\.info/);
  assert.match(pins.phaRpcProblem('mainnet', 'https://devnet.phantasma.info/rpc') ?? '', /pharpc1/);
  assert.match(pins.phaRpcProblem('devnet', 'http://devnet.phantasma.info/rpc') ?? '', /https/);
  assert.match(pins.phaRpcProblem('devnet', 'https://user:pw@devnet.phantasma.info/rpc') ?? '', /user name/);
  assert.match(pins.phaRpcProblem('devnet', 'https://devnet.phantasma.info:8443/rpc') ?? '', /port/);
  assert.match(pins.phaRpcProblem('devnet', 'https://devnet.phantasma.info.evil.example/rpc') ?? '', /host/);
  assert.match(pins.phaRpcProblem('devnet', 'not a url') ?? '', /not a URL/);
  assert.equal(pins.baseRpcProblem('https://sepolia.base.org'), null);
  assert.equal(pins.baseRpcProblem('http://127.0.0.1:8545'), null);
  assert.match(pins.baseRpcProblem('http://sepolia.base.org') ?? '', /https/);
  assert.match(pins.baseRpcProblem('https://a:b@sepolia.base.org') ?? '', /user name/);
});

// WP-00 (docs/p2p-service/PLAN.md): the kit's role pins take K1, the devnet keeper's keys since 26 October 2026, at the
// addresses the board's /config keeper shows, and keep K0's, relabelled retired.
test('KNOWN_ROLE_ADDRESSES: K1\'s three keeper addresses are known roles, checksummed as /config shows them; K0\'s are kept, marked retired; no address twice', () => {
  const known = pins.knownRoleAddresses();
  const k1 = { pha: 'P2KKFuFZNpiFdtgWQ68DHuTtwqnjBMgTv2hArZrmQYmf4gx', base: '0xa93Bc149Ff1DE9f20Fa1198e2edB4FFb69ECE58A', claim: '0x8701a821221266800a6dF354701E79Fdb5Ab80A6' };
  assert.equal(known.pha.get(k1.pha), 'the devnet keeper (Phantasma claims and refunds)');
  assert.equal(known.base.get(k1.base.toLowerCase()), 'the devnet keeper (refunds and withdrawOwed)');
  assert.equal(known.base.get(k1.claim.toLowerCase()), 'the devnet keeper (claims)');
  const listed = (a: string) => [...pins.KNOWN_ROLE_ADDRESSES.pha, ...pins.KNOWN_ROLE_ADDRESSES.base].filter((r) => r.address === a);
  for (const a of [k1.pha, k1.base, k1.claim]) assert.equal(listed(a).length, 1, `${a} is listed once, as /config writes it`);
  assert.equal(known.pha.get('P2KJBzzwGWLkDz5HUtuHQ7ydUWmbyAtFukwytu8qFtbRkuX'), 'the retired devnet keeper');
  assert.equal(known.base.get('0xe16fe62e009961682f3a7f42642f36f5e46962f8'), 'the retired devnet keeper (refunds)');
  assert.equal(known.base.get('0x6ec2a535685d5ce5f143b8c0d9bf5f612295b703'), 'the retired devnet keeper (claims)');
  for (const list of [pins.KNOWN_ROLE_ADDRESSES.pha, pins.KNOWN_ROLE_ADDRESSES.base]) {
    assert.equal(new Set(list.map((r) => r.address.toLowerCase())).size, list.length, 'no address listed twice');
    assert.ok(Object.isFrozen(list) && list.every((r) => Object.isFrozen(r)), 'frozen');
  }
  // Every keeper role is the devnet keeper's (K1) or the retired one's (K0): nothing else names a keeper.
  const keepers = [...pins.KNOWN_ROLE_ADDRESSES.pha, ...pins.KNOWN_ROLE_ADDRESSES.base].filter((r) => /keeper/.test(r.role)).map((r) => r.address).sort();
  assert.deepEqual(keepers, [k1.pha, k1.base, k1.claim, 'P2KJBzzwGWLkDz5HUtuHQ7ydUWmbyAtFukwytu8qFtbRkuX', '0xe16fE62e009961682F3a7F42642F36F5E46962F8', '0x6EC2A535685D5cE5f143B8C0d9bF5F612295b703'].sort());
  // Base addresses as /config and the explorers write them: checksummed (EIP-55).
  for (const r of pins.KNOWN_ROLE_ADDRESSES.base) assert.equal(r.address, getAddress(r.address.toLowerCase()), r.address);
});

test('KNOWN_ROLE_ADDRESSES holds exactly the addresses of the P2P signer\'s ROLE_ADDRESSES (signer-core pins.ts, imported under tsx): the same release adds a key set to both', { skip: signerHere ? false : NO_SIGNER }, async () => {
  const sc: any = await import(SIGNER_PINS.href);
  const signer = { pha: sc.ROLE_ADDRESSES.pha.map((r: any) => r.address).sort(), base: sc.ROLE_ADDRESSES.base.map((r: any) => r.address.toLowerCase()).sort() };
  const kit = { pha: pins.KNOWN_ROLE_ADDRESSES.pha.map((r) => r.address).sort(), base: pins.KNOWN_ROLE_ADDRESSES.base.map((r) => r.address.toLowerCase()).sort() };
  assert.deepEqual(kit, signer);
  // The signer's K1 entries ("K1: ...") are exactly the kit's devnet keeper (not retired) ones.
  const k1Signer = [...sc.ROLE_ADDRESSES.pha, ...sc.ROLE_ADDRESSES.base].filter((r: any) => /^K1: /.test(r.role)).map((r: any) => r.address.toLowerCase()).sort();
  const k1Kit = [...pins.KNOWN_ROLE_ADDRESSES.pha, ...pins.KNOWN_ROLE_ADDRESSES.base].filter((r) => /^the devnet keeper/.test(r.role)).map((r) => r.address.toLowerCase()).sort();
  assert.deepEqual(k1Kit, k1Signer);
  assert.equal(k1Kit.length, 3);
});
