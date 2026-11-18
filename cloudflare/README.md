# The bots on Cloudflare (Durable Objects)

This folder runs the kit's bots on Cloudflare instead of on a machine of
your own: a laptop, a VPS, or a container host such as Railway. One
Cloudflare Durable Object runs every bot listed in `bots.json`, with the
kit's own runner (the loop of `npm run market`), its config format and every
one of its checks. It needs no server of yours, and costs Cloudflare's
Workers Paid plan: $5 a month.

> **Use at your own risk**, as with the kit itself (`../LICENSE`, and
> "Your keys, your risk" in `../README.md`). Here the bot's keys are Worker
> secrets: Cloudflare runs the code and holds them, as any host you rent
> does. Start on devnet or with small balances, and watch it before you
> trust it.

## What changes on Cloudflare

| On a machine of your own | Here |
|---|---|
| A process that runs for days | Sessions of about 6 minutes, one after the other, each run by the object's alarm (an alarm may run for 15 minutes at most). The end of a session is a pause, not a stop: nothing is cancelled, and the next session resumes from the store a second later, as after any restart. |
| Keys in two 0600 files | The same two files' content in Worker secrets (`MARKET_PHA_KEY`, `MARKET_BASE_KEY`), checked exactly as the files are. |
| The store in `data/` | The same records, rules and checks in the object's own SQLite. A record is durable before anything the bot sends after it goes out (the object's output gate holds every request until its writes are stored). |
| A terminal: Ctrl-C, `--dry-run`, the mainnet "yes" | An HTTP control API behind a token: `dry-run`, `start` (on mainnet with `{"mainnet": true}`, your yes), `stop` (one Ctrl-C), `halt` (two). |
| `market.mainnet.json` | `bots.json`, deployed with the Worker: no call to the control API can change what a bot trades. |
| Long-polls for heartbeats and trades | Plain polls every 5 s. A Worker holds at most six requests waiting for their answers at once, and a held long-poll would make a chain read wait behind it. |
| Your own IP address | Cloudflare's addresses, shared with other customers: give each bot an API key, so the board counts its limits and its record by the key, not by an address it shares. |

## What it costs

- **The Workers Paid plan, $5 a month.** The Free plan does not work: it
  allows 10 ms of CPU per call, and a session checks and signs
  transactions for minutes at a time.
- **One object for every bot, always running:** 30 days of 128 MB is about
  332,000 GB-s, inside the 400,000 GB-s the plan includes. Its requests
  (an alarm per session, the 10-minute cron, your calls) are about 12,000
  a month, of the million included; its storage is a few megabytes.
- So the bots cost the plan's $5, as long as the account's other Durable
  Objects leave room in what the plan includes (past it, $12.50 per
  million GB-s, and $0.15 per million requests).

## Before you start

- Node 22 or later, and the kit's packages: `npm ci --ignore-scripts` in the
  kit's folder, then again in this folder. `npm ci` installs exactly the
  versions in each `package-lock.json`, and no package runs an install
  script.
- A Cloudflare account on Workers Paid, and `npx wrangler login` (run it in
  this folder).
- The bot's two key files, made as for any bot
  (`npx tsx examples/new-keys.ts --dir keys/mainnet --name market` in the
  kit's folder), or the ones it has.
- An API key for each bot (recommended; needed for instant offers): ask in
  the Saturn Telegram channel (https://t.me/stellargateio).

## Moving a bot here from another host

A bot's open trades live in its store, and its swap secrets are in that
store alone. So a bot moves only once it has nothing running:

1. **Stop it where it runs now**, cleanly: one Ctrl-C, or SIGTERM (what a
   service stop sends). It cancels its offers and finishes its trades; on
   mainnet that can take hours when the other side never locks. Wait for
   its line `Every trade of this bot is finished, and its offers are
   cancelled. Stopped.`
2. **Back up its `data/` folder and its key files**, and keep them.
3. **Never run the bot in both places at once.** Two bots with the same keys
   keep two stores that know nothing of each other, list the same offers
   twice, and send Base transactions that fight over the address's nonces.
4. Set it up here, below, with the same key files (or new ones, with the
   funds moved over). Its store here starts empty.

## Set it up

All commands run in this folder (`cloudflare/`).

1. **The config.** `bots.json` holds one entry per bot, named in lower case
   (`market`): the same config as `market.mainnet.json`, without `keys`,
   `dataDir` and `apiKeyFile`, which name files on a machine
   (`../examples/README.md`, "The config", explains every field). The file
   here lists the market bot on mainnet with no offers: add yours, at your
   own prices. Check it:

   ```sh
   npm run check-config
   ```

2. **Deploy**, which prints the Worker's address
   (`https://p2p-bots.<your subdomain>.workers.dev`). Until the secrets are
   set, no bot can start and every call is refused.

   ```sh
   npm run deploy
   ```

3. **The secrets.** Each bot's are named by its name in capitals
   (`market` gives `MARKET_...`). The key files go in as they are, so no key
   is ever typed or shown:

   ```sh
   npx wrangler secret put MARKET_PHA_KEY < ../keys/mainnet/market-pha.json
   ```

   ```sh
   npx wrangler secret put MARKET_BASE_KEY < ../keys/mainnet/market-base.json
   ```

   ```sh
   npx wrangler secret put MARKET_API_KEY
   ```

   The control token, kept in a 0600 file for your own calls:

   ```sh
   (umask 077; openssl rand -hex 32 > control-token) && npx wrangler secret put CONTROL_TOKEN < control-token
   ```

   Optionally, a store key that seals the bot's control tokens and swap
   secrets at rest (as `KIT_STORE_KEY_FILE` does on a machine). Back it up
   with the key files: a store sealed with it cannot be read without it.

   ```sh
   (umask 077; openssl rand -hex 32 > market-store.key) && npx wrangler secret put MARKET_STORE_KEY < market-store.key
   ```

4. **Mainnet's second switch.** A mainnet bot starts only with
   `"KIT_ALLOW_MAINNET": "1"` in the `vars` of `wrangler.jsonc`, deployed
   (`npm run deploy`), and with its start's own yes (step 6), as
   `npm run market` needs both `KIT_ALLOW_MAINNET=1` and `--mainnet`.

5. **A dry run.** It runs the preflight and reads the board, then shows what
   the bot would list and take. It sends nothing.

   ```sh
   curl -s -X POST -H "Authorization: Bearer $(cat control-token)" "https://p2p-bots.<your subdomain>.workers.dev/bots/market/dry-run?text"
   ```

6. **Start it.** The preflight runs again, and a failed item stops the
   start, as on a machine. On mainnet, the body `{"mainnet": true}` is your
   yes; a devnet bot needs no body.

   ```sh
   curl -s -X POST -H "Authorization: Bearer $(cat control-token)" -d '{"mainnet": true}' "https://p2p-bots.<your subdomain>.workers.dev/bots/market/start?text"
   ```

   Its first session starts within seconds. Watch it with `status` (below),
   in the Cloudflare dashboard (Workers, `p2p-bots`, Logs), with
   `npx wrangler tail`, and on the P2P page (https://ops.saturnx.cc/p2p) with
   mainnet picked in the Network menu at the top of the page.

## The control API

Every call needs `Authorization: Bearer <CONTROL_TOKEN>`; `?text` answers in
lines rather than JSON. Replace `<url>` with the Worker's address.

| Call | What it does |
|---|---|
| `GET <url>/status` | Every bot: stopped, running or stopping; its addresses, open offers, running trades, last failure and latest lines. |
| `GET <url>/bots/market/logs?n=200` | The bot's latest lines (the ones since the object last started; Cloudflare's logs keep them all). |
| `POST <url>/bots/market/dry-run` | What it would list and take now; sends nothing. A stopped bot only (it opens the bot's store). |
| `POST <url>/bots/market/start` | The preflight, then it runs. Mainnet: the body `{"mainnet": true}`. |
| `POST <url>/bots/market/stop` | One Ctrl-C: no new offers or takes; it cancels its offers, finishes its trades (on mainnet that can take hours), then stops. |
| `POST <url>/bots/market/halt` | Two Ctrl-C: it stops at once and cancels nothing. Its offers lapse within 90 s and its trades wait in its store: a stopped bot sends no lock, claim or refund, so a lock it owes and does not send in time is its no-show (3 in 24 hours pause it). Start it again soon. |

The token can start, stop and halt the bots and read their lines; it can
neither change what they trade nor read a key. If it leaks, put a new one
in place (`npx wrangler secret put CONTROL_TOKEN`, as in step 3). For a
second gate in front of the API, Cloudflare Access can protect the Worker's
address.

## Day to day

- **A new config:** edit `bots.json`, then `npm run deploy`. A deploy
  restarts the object; the running session is cut short, and the next one
  starts with the new config, which keeps listed what it lists and cancels
  what it no longer lists, as a restart does on a machine.
- **A new kit version:** `git pull` in the kit's folder, `npm ci
  --ignore-scripts` in both folders, then `npm run deploy` here.
- **A failed session** (an RPC that does not answer, a secret not set yet)
  is tried again after 1 minute, then after 2, 4 and 8, and every
  15 minutes after that, until one runs. `status` shows the failure. Fix
  the cause; nothing else needs doing.
- **More bots:** add their entries to `bots.json` and their secrets; they
  share the one object, and its cost.

## Good to know

- **A session's end** waits for the step the bot is in to finish: usually
  seconds, but a Base transaction can take up to 3 minutes to be mined, or
  twice that with `usePermit: false`. Meanwhile its offers get no heartbeat,
  and an offer whose heartbeats lapse (90 s) is listed again by the next
  session.
- **A cut session** (a deploy, a Cloudflare runtime update, an eviction) is
  a restart: the object's alarm runs the next session, which takes the
  store's lock over (its log says so), settles every open request and send
  from the board and the chains, and sends nothing blindly twice.
- **The lines** are redacted as on a machine: never a key, a control token
  or a swap secret. The Worker's logs (Workers Logs) keep them for a few
  days.
- **Prune** (`../examples/prune.ts`) works on a data folder on a machine,
  not on this store; the swap secrets here stay in the object's storage.

## Tests

```sh
npm run check
```

```sh
npm test
```

```sh
npm run test:workerd
```

`npm test` runs the fleet, the control API and the redirect rule on Node
with fakes. `npm run test:workerd` runs the fleet on a real Durable Object
in workerd (`wrangler dev`, local only, about a minute): a start, sessions
that follow one another, a reset in the middle of a session (the next
instance takes the store's lock over and lists nothing twice), a stop and a
halt. The kit's own tests (`npm test` in the kit's folder) cover the SQLite
store and `createHostedKit`, including a hosted bot that trades a whole
swap across a restart of its host.

## Files

| File | What it holds |
|---|---|
| `bots.json` | The bots and their configs; deployed with the Worker. |
| `wrangler.jsonc` | The Worker: its object, its cron, its CPU limit, `KIT_ALLOW_MAINNET`, and the secrets it reads. |
| `src/worker.ts` | The Worker and its Durable Object (`BotFleet`). |
| `src/fleet.ts` | The sessions, the bots' states, the control calls. |
| `src/http.ts` | The control API and its token. |
| `src/fetch.ts` | The fetch of every request: never follows a redirect (the runtime has no redirect "error"). |
| `scripts/check-config.ts` | `npm run check-config`. |
| `test/` | The tests above; `test/workerd/` is a test Worker, never deployed. |
