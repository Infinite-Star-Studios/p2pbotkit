/**
 * The repository's CI job for the kit (.github/workflows/kit.yml): it runs the
 * kit's type check and tests, test/sdk-vectors.test.ts among them, on every
 * change to the kit or to a file the kit's tests or the job read beside it,
 * from the lockfiles with install scripts off, with no secret, no credential
 * kept and nothing built or kept. Every line of kit.yml but its comments is
 * held here, so any change to the job (a step skipped or allowed to fail, a
 * filter, a trigger, a right, a shell, a command) fails this test until the
 * test changes with it. Skipped when the kit is not checked out in the Saturn
 * repository (a downloaded kit, or a copy of the kit alone); inside it, a
 * missing or renamed kit.yml fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const FILE = new URL('../../.github/workflows/kit.yml', import.meta.url);
const P2P_WORKFLOW = new URL('../../.github/workflows/p2p.yml', import.meta.url);
const BACKEND_PACKAGE = new URL('../../backend/package.json', import.meta.url);

/** The Saturn repository around the kit, told by its backend and its P2P workflow (not by kit.yml, which a rename would hide). */
const inSaturn = ((): boolean => {
  if (!existsSync(P2P_WORKFLOW) || !existsSync(BACKEND_PACKAGE)) return false;
  try { return JSON.parse(readFileSync(BACKEND_PACKAGE, 'utf8')).name === 'saturndata-backend'; } catch { return false; }
})();
const skip = inSaturn ? false : 'the kit is not checked out in the Saturn repository';

/**
 * kit.yml without its comments, line for line: read-only rights, no secret and
 * no expression, the two actions pinned to full commit SHAs (as p2p.yml pins
 * them), no credential kept, the Node.js version of backend/.node-version with
 * no dependency cache, both lockfiles installed with install scripts off, and
 * then the kit's type check and tests, with nothing skipped or allowed to fail.
 */
const JOB = [
  'name: P2P bot kit',
  'on:',
  '  push:',
  '    paths:',
  "      - 'p2p-bot-kit/**'",
  "      - '.github/workflows/kit.yml'",
  "      - '.github/workflows/p2p.yml'",
  "      - 'README.md'",
  "      - 'package.json'",
  "      - 'backend/**'",
  "      - 'frontend/package.json'",
  "      - 'frontend/src/lib/dex/network.js'",
  "      - 'frontend/src/lib/p2p/**'",
  "      - 'p2p/packages/signer-core/**'",
  '  pull_request:',
  '    paths:',
  "      - 'p2p-bot-kit/**'",
  "      - '.github/workflows/kit.yml'",
  "      - '.github/workflows/p2p.yml'",
  "      - 'README.md'",
  "      - 'package.json'",
  "      - 'backend/**'",
  "      - 'frontend/package.json'",
  "      - 'frontend/src/lib/dex/network.js'",
  "      - 'frontend/src/lib/p2p/**'",
  "      - 'p2p/packages/signer-core/**'",
  '  workflow_dispatch:',
  'permissions:',
  '  contents: read',
  'defaults:',
  '  run:',
  '    shell: bash',
  'jobs:',
  '  kit:',
  '    name: Kit',
  '    runs-on: ubuntu-24.04',
  '    timeout-minutes: 20',
  '    steps:',
  '      - name: Check out',
  '        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
  '        with:',
  '          persist-credentials: false',
  '      - name: Set up Node.js',
  '        uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0',
  '        with:',
  '          node-version-file: backend/.node-version',
  '          package-manager-cache: false',
  '      - name: Check the Node.js version',
  '        run: |',
  `          want="$(tr -d '[:space:]' < backend/.node-version)"`,
  '          echo "Node.js $(node --version), backend/.node-version $want"',
  '          test "$(node --version)" = "v$want"',
  "      - name: Install the backend's packages",
  '        working-directory: backend',
  '        run: npm ci --ignore-scripts --no-audit --no-fund',
  "      - name: Install the kit's packages",
  '        working-directory: p2p-bot-kit',
  '        run: npm ci --ignore-scripts --no-audit --no-fund',
  '      - name: Type-check the kit',
  '        working-directory: p2p-bot-kit',
  '        run: npm run check',
  "      - name: Run the kit's tests",
  '        working-directory: p2p-bot-kit',
  '        run: npm test'
];

/** A workflow's lines without blank lines, comment lines or trailing spaces. */
const linesOf = (y: string): string[] => y.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l !== '' && !l.trimStart().startsWith('#'));

test('CI: kit.yml is in the repository, under its name', { skip }, () => {
  assert.ok(existsSync(FILE), '.github/workflows/kit.yml runs the kit\'s tests in CI: it is missing or renamed');
});

test('CI: kit.yml is exactly the job that runs the kit\'s type check and tests, every line but its comments', { skip }, () => {
  const y = readFileSync(FILE, 'utf8');
  assert.deepEqual(linesOf(y), JOB, 'kit.yml changed: change JOB with it, keeping its rules');
  // The two actions are pinned to the commits p2p.yml uses, so a bump there fails here until kit.yml follows.
  const p2p = readFileSync(P2P_WORKFLOW, 'utf8');
  for (const m of y.matchAll(/uses: ([a-z0-9-]+\/[a-z0-9-]+@[0-9a-f]{40})/g)) assert.ok(p2p.includes(`uses: ${m[1]}`), `${m[1]} is the commit p2p.yml uses`);
});

test('CI: kit.yml runs on a change to the kit, to itself, and to every file the kit\'s tests read beside the kit', { skip }, () => {
  const y = readFileSync(FILE, 'utf8');
  const lists = [...y.matchAll(/^ {2}(push|pull_request):\n {4}paths:\n((?: {6}- '.+'\n)+)/gm)].map((m) => [m[1]!, [...m[2]!.matchAll(/'(.+)'/g)].map((x) => x[1]!)] as const);
  assert.deepEqual(lists.map(([on]) => on), ['push', 'pull_request']);
  assert.deepEqual(lists[0]![1], lists[1]![1], 'the same paths for a push and a pull request');
  const paths = lists[0]![1];
  // The kit and this job; p2p.yml, whose action pins the job matches; all of the backend: the parity tests import its
  // P2P code, which imports more of it, and the job installs its lockfile on its Node.js version; the P2P signer's pins.
  for (const p of ['p2p-bot-kit/**', '.github/workflows/kit.yml', '.github/workflows/p2p.yml', 'backend/**', 'frontend/src/lib/p2p/**', 'p2p/packages/signer-core/**']) {
    assert.ok(paths.includes(p), p);
  }
  const covered = (f: string) => paths.some((p) => (p.endsWith('/**') ? f.startsWith(p.slice(0, -2)) : f === p));
  // Every file outside the kit that a test reads: a URL made from '../../' and the file's path, relative to the test.
  const dir = new URL('./', import.meta.url);
  const read = new Set<string>();
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    for (const m of readFileSync(new URL(name, dir), 'utf8').matchAll(/new URL\('\.\.\/\.\.\/([^']+)'/g)) read.add(m[1]!);
  }
  assert.ok(read.size >= 10, 'the tests read files beside the kit');
  for (const f of read) assert.ok(covered(f), `kit.yml runs when ${f} changes`);
});
