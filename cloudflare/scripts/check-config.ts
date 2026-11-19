/**
 * npm run check-config: check bots.json (scripts/config.ts) as the Worker will
 * check it, and say what each bot lists and takes and which secrets it needs.
 * Exits 1 when it cannot be used. Reads no secret: npx wrangler secret list
 * shows which are set.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBotsFile } from './config.js';

const file = process.argv[2] ?? join(fileURLToPath(new URL('..', import.meta.url)), 'bots.json');
const r = readBotsFile(file);
for (const line of r.lines) console.log(line);
process.exit(r.ok ? 0 : 1);
