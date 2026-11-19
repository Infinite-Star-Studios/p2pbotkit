/**
 * npm run deploy: check bots.json, then deploy the Worker with it as its
 * BOTS_CONFIG secret, in one version (wrangler deploy --secrets-file). The
 * secrets file is written to a private temporary folder and removed as soon
 * as wrangler is done. Other secrets (keys, tokens) are kept as they are.
 * Arguments after `npm run deploy --` go to wrangler deploy.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBotsFile } from './config.js';

const dir = fileURLToPath(new URL('..', import.meta.url));
const r = readBotsFile(join(dir, 'bots.json'));
for (const line of r.lines) console.log(line);
if (!r.ok || r.minified === null) {
  console.log('Not deployed: put bots.json right first (above).');
  process.exit(1);
}
const tmp = mkdtempSync(join(tmpdir(), 'p2p-bots-'));
let code = 1;
try {
  const secrets = join(tmp, 'secrets.json');
  writeFileSync(secrets, JSON.stringify({ BOTS_CONFIG: r.minified }), { mode: 0o600 });
  const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  code = spawnSync(process.execPath, [wrangler, 'deploy', '--secrets-file', secrets, ...process.argv.slice(2)], { cwd: dir, stdio: 'inherit' }).status ?? 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(code);
