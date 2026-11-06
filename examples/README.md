# The example bots

Two small bots that trade with each other on devnet, built on the kit
(`../README.md`): a **seller** that keeps sell offers listed and sells into
bids, and a **buyer** that keeps buy offers listed and buys from asks. Start
both and they trade in both directions, through the public P2P board, with
locks and claims on Phantasma devnet and Base Sepolia.

Their trades with each other are real trades, but they never raise a maker's
accept rate: started on one machine, one network address, each take counts
as the maker's own, whatever API keys the two bots use. Like any completed
trade, a trade between them does prove the address pair of the offer it
filled and makes the maker's Base address eligible for maker rewards (see
"API keys and limits" in `../README.md`).

They are examples to read, copy and change. They run on your machine with
keys made on your machine; Saturn never holds a key, never trades for you and
runs no bot of its own. Your keys, your risk: start on devnet, keep small
balances on a bot's addresses, and watch it before you trust it.

## Quick start on devnet

You need Node 22 or later. Run these one at a time, in order. For the two
faucet lines, copy the commands `new-keys.ts` prints: it fills in each bot's
addresses. The last two lines keep running until Ctrl-C, so start
`npm run seller` and `npm run buyer` each in its own terminal, in the kit's
folder:

```sh
curl -fsSLO https://ops.saturnx.cc/downloads/saturn-p2p-bot-kit.tgz
curl -fsSLO https://ops.saturnx.cc/downloads/saturn-p2p-bot-kit.tgz.sha256
sha256sum -c saturn-p2p-bot-kit.tgz.sha256
tar xzf saturn-p2p-bot-kit.tgz
cd saturn-p2p-bot-kit
npm ci --ignore-scripts
npx tsx examples/new-keys.ts
npm run faucet -- --pha <seller P2K address> --base <seller 0x address>
npm run faucet -- --pha <buyer P2K address> --base <buyer 0x address>
npm run seller
npm run buyer
```

1. **Get the kit.** Download it and its SHA-256 from the Saturn site, check
   it (on macOS: `shasum -a 256 -c saturn-p2p-bot-kit.tgz.sha256`), unpack
   it and install its dependencies. Do not run it if the check fails.
   `npm ci --ignore-scripts` installs exactly the versions pinned in the
   kit's `package-lock.json` and lets no package run its own install script,
   which matters on a machine that holds your keys; `../README.md` ("Get the
   kit") says what gets installed.
2. **Make keys.** `new-keys.ts` writes a key pair for each bot into `keys/`
   (`seller-pha.json`, `seller-base.json`, `buyer-pha.json`,
   `buyer-base.json`), each file mode 0600, and prints only the addresses. It
   never replaces a file that is already there. `--name mybot` makes a pair
   for a bot of your own (`keys/mybot-pha.json`, `keys/mybot-base.json`).
3. **Fund both bots.** `new-keys.ts` prints the two faucet commands with the
   addresses filled in. One claim sends test TAZ, RA, SOUL and KCAL on
   Phantasma devnet, and MockUSDC (mUSDC) and a little ETH on Base Sepolia.
4. **Run the bots**, each in its own terminal: `npm run seller` in one,
   `npm run buyer` in the other.
5. **Watch them trade** on the site's P2P page, https://ops.saturnx.cc/p2p,
   with devnet picked in the Network menu at the top of the page.

Before a real start, `npm run seller -- --dry-run` (or `buyer`) shows
everything the bot would do and sends nothing (see "Dry run" below).

## What the two bots do

Both run the same runner (`seller-bot.ts`; `buyer-bot.ts` starts it with the
buyer's config). On start a bot reads its config, runs the kit's preflight
(pins, the escrow's code, both chains, its balances, the clock), and stops if
a check that its trading needs fails. Then:

| | Seller (`seller.devnet.example.json`) | Buyer (`buyer.devnet.example.json`) |
|---|---|---|
| Keeps listed | sells 30 TAZ at 1.08 mUSDC (1 to 5 a trade); sells 6 RA following the reference price +2%, never below 1.90 | buys 20 TAZ at 1.06 (1 to 5 a trade); buys 4 RA at 1.89 (1 to 2 a trade) |
| Every 120 s | sells up to 2 TAZ into bids at 1.05 or more (`sellDownTo`): the buyer's TAZ bid | buys up to 2 TAZ from asks at 1.10 or less (`buyUpTo`): the seller's TAZ ask |
| Takes on its offers | accepted at once when their checks pass (`acceptAfterS: 0`) | the same |
| Its claim | claims its USDC itself; its secret never goes to the board (`claimMode: "self"`) | claims the tokens itself when Saturn's keeper has not within 60 s (`claimWatchS: null`, the devnet default) |

Everything else is the kit's `run()`: it keeps the offers listed with one
long-poll heartbeat, accepts takes, locks, claims, refunds after the time
limits, and resumes every trade after a crash or a restart. Each lock, claim
and refund runs every check of `../docs/CHECKS.md` first and signs only when
all of them pass.

A bot lists an offer only while it holds what that offer's smallest trade
needs (the token for a sell, USDC for a buy), and lists it again when the
board closes or fills it. Accepting checks its funds again, take by take: a
bot never accepts a take its balance cannot cover. One faucet claim covers
a few example trades; the totals in the example offers are larger than that.

## The config

A bot reads one JSON file (`--config <file>`; the default is its example).
Relative paths in it resolve against the folder you run the command in (the
kit's folder under `npm run`). An unknown key, an amount written as a number
instead of text, or an offer outside the kit's token table stops the bot
before anything is read or sent.

| Key | Default | Meaning |
|---|---|---|
| `network` | (required) | `"devnet"` or `"mainnet"` (mainnet also needs `--mainnet` and `KIT_ALLOW_MAINNET=1`, see "Mainnet"). |
| `api` | `https://apiops.saturnx.cc` | The board. |
| `apiKeyFile` | `null` | A file holding an API key (mode 0600). Optional on devnet. |
| `keys` | (required) | `{"pha": "<file>", "base": "<file>"}`: the two key files, mode 0600. |
| `dataDir` | (required) | The bot's crash-safe state. One running bot per folder. To encrypt it on disk, see `KIT_STORE_KEY_FILE` in `../README.md` ("Encrypting the store"), and back that key up with `keys/`. |
| `phaRpc`, `baseRpc` | the kit's pinned RPCs | Your own RPCs; the Phantasma host must be the network's own, and the Base RPC must serve the pinned chain. |
| `offers` | `[]` | Sell offers to keep listed. |
| `bids` | `[]` | Buy offers to keep listed. |
| `take` | none | One recurring order, or a list of them. |
| `acceptOnTheirOwn` | `true` | Accept takes once their checks pass (accepting signs nothing). With `false` the bot never accepts; use the kit directly to answer takes yourself. |
| `acceptAfterS` | `null` (15 s) | How long a take is seen before it is accepted. |
| `claimWatchS` | `null` (60 s on devnet) | How long a buyer waits for the keeper to claim its tokens before it claims them itself. |
| `claimMode` | `"self"` | `"self"`: the seller claims its USDC itself and never sends its secret to the board. `"reveal-then-self"`: it gives the secret to Saturn's keeper, and claims itself if the keeper has not. |
| `usePermit` | `true` | Lock USDC with a permit in one transaction; `false` approves exactly the amount, then locks. |

An offer (in `offers` or `bids`):
`{"symbol": "TAZ", "total": "30", "min": "1", "max": "5", "price": "1.08"}`,
or, to follow the reference price,
`{"symbol": "RA", "total": "6", "min": "1", "max": "2", "follow": {"offsetBps": 200, "limitPrice": "1.90"}}`.
Amounts are whole tokens and prices are USDC per whole token, both written
as text. `offsetBps` is the offset from the reference price in basis points
(200 is +2%); `limitPrice` is the lowest price of a sell and the highest of
a buy; an optional `dailyMax` caps what the offer fills in 24 hours.
An offer in `offers` may add `"mode": "instant"`: its buyer locks the USDC
first, then the bot locks its tokens. It needs `apiKeyFile` to name a key
the owner flagged for instant offers, and runs on devnet only in this
release (see "Instant offers" in `../README.md`). A bid cannot be instant.

A recurring order (`take`):
`{"symbol": "TAZ", "minPrice": "1.05", "amount": "2", "everyS": 120}` sells
up to 2 TAZ into bids at 1.05 or more every 120 seconds (`sellDownTo`);
`maxPrice` instead of `minPrice` buys from asks at that price or less
(`buyUpTo`). `everyS` is at least 10; `maxLegs` (1 to 8) caps the trades
of one order.

## Prices and the devnet ratio

The example prices keep devnet's own ratio between the two tokens, within a
few percent:
**TAZ = RA / 1.8554**, the TAZ per RA of devnet's reference pool #223
(220.38 RA against 408.90 TAZ). With RA near 2.00, TAZ sits near 1.08:

| | TAZ | RA | TAZ times 1.8554 |
|---|---|---|---|
| Seller's ask | 1.08 | reference +2% (never below 1.90) | 2.004 |
| Buyer's bid | 1.06 | 1.89 | 1.967 |
| Seller sells into bids at | 1.05 or more | | 1.948 |
| Buyer buys from asks at | 1.10 or less | | 2.041 |

Each token's asks sit above its bids, so the two bots' offers never cross,
and each bot's recurring order reaches the other's TAZ offer. The seller's RA
offer follows the reference price, so its price moves; it never goes below
1.90, and the buyer's RA bid stays under that (1.89). That matters on devnet
today: with the reference price of RA far under 2.00 (see below), the
seller's RA offer rests at its 1.90 minimum.

What matters is the ratio. The reference price built from P2P trades
compares RA trades with TAZ trades converted through the pool (they may be at
most 15% apart) and leaves out trades priced far from the others, so keep
both tokens on one ratio. The level of 2.00 is the example's own choice: on
devnet the reference price is still "via SOUL" (RA was about $0.0136 on
2026-10-14), and a level that low would put a one-token trade under the 1 USDC
minimum per trade. Offers far from a via-SOUL reference price trade with each
other, but do not count as depth near it. A dry run prints the reference
price, the pool's TAZ per RA, where your prices sit in RA terms, and how far
apart the two tokens' prices are.

## Dry run

```sh
npm run seller -- --dry-run
```

The bot makes its full start (the key files, the RPC allowlist, the pinned
chain, the preflight), then reads the board (its open offers, the feed of done
trades, the reference price) and prints what it would list and take. It sends
nothing: its board calls can only be GETs, its chain transports refuse every
send, and its closing lines count the writes and sends it refused (always 0)
and name any check a real start would stop on.

## Stopping, restarting

- **Ctrl-C once** (or SIGTERM, which the bot handles the same way): the bot
  stops listing and taking, cancels its offers, lets takes still waiting for
  an answer time out, and finishes every running trade (locks, claims,
  refunds); then it exits. Finishing can take until a trade's time limit
  runs out: if the other side never locks, the bot's own lock comes back only
  by a refund at its time limit, about 41 minutes after the lock on devnet
  (12 hours on mainnet). While it waits, it names the running trades once a
  minute. If you need it to stop sooner (a service manager with a short stop
  timeout, for one), use the second Ctrl-C: its state is kept and the next
  start resumes the trades, so start it again soon (a lock it owes and does
  not send in time counts as its no-show).
- **Ctrl-C again**: it exits at once.
- Its state is in `dataDir` either way. Start it again and it resumes every
  trade where it was, from the board and the chains; it never sends anything
  blindly twice.

## Upgrading the kit

Your keys (`keys/`) and each bot's state (its `dataDir`, `data/<bot>` in the
examples) are the only files that matter. `data/` holds the swap secrets and
control tokens of unfinished trades. The download never contains `keys/` or
`data/`, so the new version's folder starts without them: keep them outside
the kit folder, or copy them across.

1. Stop each bot with one Ctrl-C and wait until it exits, so it finishes its
   running trades.
2. Back up `keys/` and `data/` (`cp -a keys data ../bot-backup/`), with your
   own config files. Never delete them, not even when you remove an old kit
   folder: the keys may still hold funds.
3. Download the new version and its `.sha256` and check it as in the quick
   start (`sha256sum -c saturn-p2p-bot-kit.tgz.sha256`). Do not go on if the
   check fails.
4. Move the old kit folder aside
   (`mv saturn-p2p-bot-kit saturn-p2p-bot-kit-old`), then run
   `tar xzf saturn-p2p-bot-kit.tgz`: the new version unpacks into a fresh
   `saturn-p2p-bot-kit/` folder.
5. Bring your keys, state and config across. When your config names key
   files and a `dataDir` outside the kit folder (absolute paths, below),
   there is nothing to move. Otherwise copy them from the old folder with
   their modes:
   `cp -a saturn-p2p-bot-kit-old/keys saturn-p2p-bot-kit-old/data saturn-p2p-bot-kit/`,
   and the `KIT_STORE_KEY_FILE` file too if you keep it there. Keep your own
   config outside `examples/`, whose `*.example.json` files every version
   replaces: for example `cp examples/seller.devnet.example.json seller.json`,
   then `npm run seller -- --config seller.json`.
6. In the new folder, run `npm ci --ignore-scripts`, then `--dry-run`, then
   start the bot with the same config. It resumes from the same `dataDir`
   with the same keys.

To keep keys and state outside the kit folder from the start, put absolute
paths for `keys` and `dataDir` in your own config, and make the keys there
with `npx tsx examples/new-keys.ts --dir <folder>`. An upgrade then never
moves them.

## The faucet

```sh
npm run faucet -- --pha <P2K address> --base <0x address>
npm run faucet -- --info
```

`--info` shows what one claim sends and how many claims are left today. The
faucet serves each address once every 24 hours, at most 3 claims a day per
connection, with hourly and daily limits for everyone. If a claim's answer
was lost and the faucet then says it already served the address, the first
claim went out: check the balances (the bot's preflight shows them). Devnet
only: mainnet has no faucet.

## Old secrets

The kit keeps every swap secret until you remove it. Stop the bot, then:

```sh
npx tsx examples/prune.ts --config examples/seller.devnet.example.json --dry-run
npx tsx examples/prune.ts --config examples/seller.devnet.example.json
```

It removes a secret only when its trade is finished for the kit, finished at
least 7 days ago (`--days` raises that, never lowers it), has no send whose
outcome is still open, and both locks under the secret's hash read final on
the chains now (claimed, refunded, or never made). Everything else is kept,
with the reason.

## A loop of your own

The example bots drive their trades with `kit.run()` only. A bot that drives
its trades with `kit.step()` instead calls `kit.resume()` before its first
step and about once a minute, as `run()` does, so a take whose answer was
lost or a send whose outcome is open is settled from the board and the
chains. Never call `step(id, policy)` while `run()` runs: `step` with a
policy replaces the one `run()` was given. Such a loop does not send
heartbeats, so it suits a bot that only takes; keep `run()` for offers.

```ts
const policy = { claimWatchS: 60 };
await kit.resume();
let resumedAt = Date.now();
while (!stop.signal.aborted) {
  if (Date.now() - resumedAt >= 60_000) {
    await kit.resume();
    resumedAt = Date.now();
  }
  for (const t of await kit.store.listTrades()) {
    if (!t.endedAt) await kit.step(t.id, policy);
  }
  await new Promise((r) => setTimeout(r, 5_000));
}
```

## Mainnet

This release pins mainnet's escrow and SaturnSwap. A bot runs on mainnet only
with `"network": "mainnet"` in its config, `--mainnet` on its command line and
`KIT_ALLOW_MAINNET=1` in its environment; without any one of them it refuses
to start. It trades only while the board runs P2P on mainnet. Use keys made
for it and small balances first.

## Behind a proxy

Node's built-in `fetch`, which the kit uses for the board and both chains,
does not read `HTTPS_PROXY` by itself. On Node 22.21 or later, set
`NODE_USE_ENV_PROXY=1` as well when the machine reaches the internet only
through a proxy.

## Files

| File | What it is |
|---|---|
| `seller-bot.ts` | The seller bot, and the runner both bots use. |
| `buyer-bot.ts` | The buyer bot. |
| `seller.devnet.example.json`, `buyer.devnet.example.json` | Their configs. |
| `new-keys.ts` | Makes key pairs (0600 files) and prints their addresses. |
| `faucet.ts` | Asks the devnet faucet for test tokens. |
| `prune.ts` | Removes old swap secrets. |
