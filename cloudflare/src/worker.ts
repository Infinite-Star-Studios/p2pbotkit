/**
 * The Cloudflare Worker that runs the kit's bots (README.md here):
 *
 *   - BotFleet, its one Durable Object, runs every bot of bots.json in
 *     sessions driven by its alarm (fleet.ts), with each bot's records in the
 *     object's SQLite (SqlBackend) and its keys from the Worker's secrets;
 *   - fetch serves the control API behind CONTROL_TOKEN (http.ts);
 *   - scheduled, every 10 minutes (wrangler.jsonc), re-arms the alarm should
 *     it ever be lost while a bot runs; the alarm itself runs the bots.
 */
import { DurableObject } from 'cloudflare:workers';
import { createHostedKit } from '../../src/index.js';
import { sleep } from '../../src/board.js';
import { Fleet, loadBots, type Reply } from './fleet.js';
import { handle } from './http.js';
import { noRedirectFetch } from './fetch.js';
import BOTS from '../bots.json';

export interface Env {
  FLEET: DurableObjectNamespace<BotFleet>;
  /** The control API's bearer token (a secret, 32 or more characters). */
  CONTROL_TOKEN?: string;
  /** "1": mainnet bots may start (with their start's own yes as well). A var of wrangler.jsonc. */
  KIT_ALLOW_MAINNET?: string;
}

/** The one object that runs every bot: the name every call and the cron use. */
const FLEET_NAME = 'fleet';

export class BotFleet extends DurableObject<Env> {
  readonly #fleet: Fleet;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const storage = ctx.storage;
    const vars = env as unknown as Record<string, unknown>;
    this.#fleet = new Fleet({
      sql: storage.sql,
      kv: storage.kv,
      setAlarm: (at) => storage.setAlarm(at),
      getAlarm: () => storage.getAlarm(),
      deleteAlarm: () => storage.deleteAlarm(),
      env: vars,
      makeKit: (o) => createHostedKit(o),
      now: () => Date.now(),
      sleep,
      print: (line) => console.log(line),
      // Every request of the kits: never follows a redirect (the runtime has no redirect "error"; fetch.ts).
      fetch: noRedirectFetch(globalThis.fetch.bind(globalThis))
    }, loadBots(BOTS, vars));
  }

  status(): Reply { return this.#fleet.status(); }
  logs(name: string, n?: number): Reply { return this.#fleet.logs(name, n); }
  dryRun(name: string): Promise<Reply> { return this.#fleet.dryRun(name); }
  start(name: string, mainnet: boolean): Promise<Reply> { return this.#fleet.start(name, { mainnet }); }
  stop(name: string): Promise<Reply> { return this.#fleet.stop(name); }
  halt(name: string): Promise<Reply> { return this.#fleet.halt(name); }
  wake(): Promise<void> { return this.#fleet.wake(); }

  override async alarm(): Promise<void> {
    await this.#fleet.alarm();
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    return handle(request, env.CONTROL_TOKEN, env.FLEET.getByName(FLEET_NAME) as never);
  },
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(env.FLEET.getByName(FLEET_NAME).wake());
  }
} satisfies ExportedHandler<Env>;
