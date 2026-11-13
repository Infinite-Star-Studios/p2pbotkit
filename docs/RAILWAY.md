# The kit on Railway

Railway (https://railway.com) runs a container for you around the clock.
This guide puts a bot of the kit in one: the image of `Dockerfile`, started
by `docker/entrypoint.sh`, with the bot's keys and state on a Railway volume.
The same image runs on any Docker host ("On any Docker host" below).

> **Your keys are then on Railway's disks.** The kit's README says the bot
> runs on your machine, with your keys. On Railway that machine is a
> container and its volume, at Railway. Whoever can change the service or
> open a shell in it can read the key files and spend what their addresses
> hold:
>
> - the members of your Railway workspace and project who may deploy or
>   change settings: through the dashboard's Console, `railway ssh`, the
>   volume's files, or a start command of their own;
> - whoever holds an SSH key or an API token of one of them, or a workspace
>   SSH key;
> - whoever can push to the repository the service deploys from: their code
>   then runs beside the keys;
> - Railway itself, and whoever breaks into Railway. In October 2026 Railway
>   disclosed a break-in in which some customers' environment variables may
>   have been read.
>
> The kit never takes a key from a variable: never put one there. Use keys
> made for this bot alone, keep small balances on them, keep a copy of the
> keys ("Keep a copy of the keys" below), and keep the people on that list
> few. You use the kit at your own risk (`LICENSE`).

What Railway does is Railway's to change. The settings and commands below
are as its documentation had them in November 2026, and its pages are linked
where a step depends on them. Nothing here was run on Railway itself: the
image and its entrypoint were run in containers on a Docker host.

## What the image does

`Dockerfile` builds on the Node that `start.sh` names (22.23.5, on Debian),
adds `procps` and `tini`, copies the kit to `/app`, and lets `start.sh`
install the packages its own way (`npm ci --ignore-scripts`, exactly the
versions in `package-lock.json`). The image holds no key and no state.

A container is replaced at every deploy, and only its volume stays. So
`docker/entrypoint.sh`, the container's command, does five things:

1. **No volume, no start.** It refuses to start when its state folder
   (`/data`) is on the container's own disk: a key made there would be lost
   at the next deploy, with whatever its address holds.
2. **The kit's folders are the volume's.** It links `/app/keys` to
   `/data/keys`, `/app/data` to `/data/data` and, on mainnet,
   `/app/market.mainnet.json` to `/data/market.mainnet.json`. `start.sh`
   and the example configs then work unchanged: where a bot's lines say
   `/app/keys/...`, the file is on the volume. A config whose own key files
   or data folder are anywhere else is refused: a bot's state on the
   container's disk would end with the container.
3. **Locks of an earlier container.** A bot that is killed leaves its lock
   file in its data folder. The kit takes over the lock of a dead process on
   its own machine, but a new container has a new host name, and there the
   kit sees a bot on another machine and refuses to start (`STORE_LOCKED:
   ... is in use by process 7 on 260b0665c620 ... if that process is gone,
   delete .../.lock`). Railway mounts a volume in one container at a time,
   so while no Node process runs in the new container, every lock file on
   its volume is a leftover: on Railway the entrypoint removes them and
   says so.
4. **A start right after the last one waits.** A start can fail where a
   running bot would have carried on, and Railway starts a container that
   stopped on an error again only 10 times. A start that comes within half
   a minute of the last one therefore waits first: 5 seconds, then 10, 20,
   40, 80, 160, and 300 from then on. Ten such starts then last about 25
   minutes, so an outage of the board or an RPC that long passes.
5. **`start.sh`, with no terminal.** It runs `sh start.sh <network> ...`
   with nothing on its input. `start.sh` then asks no question: on devnet it
   runs the two example bots, and on mainnet it starts the market bot only
   with `KIT_ALLOW_MAINNET=1` (README, "On mainnet").

## Set it up

1. **A repository of your own.** Fork this repository on GitHub, or push
   the kit to a repository of yours: you choose when a new version of the
   kit reaches your bot. In Railway, make a new project, pick "GitHub Repo"
   and choose it. Railway finds `Dockerfile` at the root and builds it; the
   build log says "Using detected Dockerfile!"
   (https://docs.railway.com/builds/dockerfiles). Railway deploys again at
   each push to the branch it follows, and a deploy restarts the bot. To
   choose the moment yourself, disable automatic deploys in the service's
   settings and deploy the latest commit by hand
   (https://docs.railway.com/deployments/github-autodeploys).
2. **A volume.** Make a volume (the Command Palette, or a right-click on
   the project canvas), connect it to the service and give it the mount
   path `/data`; the service's Settings have it too
   (https://docs.railway.com/volumes). A first deploy without it harms
   nothing: the entrypoint stops with "is not a volume" and makes no key.
   The plan sets the volume's size, and the smallest is far more than the
   kit needs.
3. **The variables**, in the service's Variables tab ("The variables"
   below). A change there is staged: it reaches the bot when you press
   Deploy, which starts a new container. From the CLI, `railway variable
   set` deploys at once.
4. **The settings to leave alone**, in the service's Settings:
   - **Custom Start Command: leave it empty.** A start command set there
     replaces the image's own, and with it the entrypoint and everything
     above (https://docs.railway.com/deployments/start-command). Give
     `start.sh` its command with `KIT_START_ARGS` instead.
   - **Pre-Deploy Command: leave it empty.** It runs in a container of its
     own, without the volume.
   - **Restart Policy: "On Failure"**, Railway's default, with its 10
     restarts ("What a deploy does to a running bot" below). Never
     "Always": a setup or a dry run ends on purpose, and would be started
     again without end.
   - **Serverless: off**, as it is by default. A bot that is put to sleep
     sends no lock and no claim.
   - **Replicas: one.** Railway allows no replicas on a service with a
     volume, and the kit allows one bot per data folder.
   - No public domain, no port and no health check: the bot only calls out.
5. **Deploy, and read the logs** (the service's Deployments tab, or
   `railway logs`).

### The variables

| Variable | Value | Meaning |
|---|---|---|
| `KIT_NETWORK` | `devnet` or `mainnet` | Where the bots run. Not set: devnet, unless the volume holds a mainnet bot's keys or state. Then the start is refused: a variable that was lost does not turn a mainnet bot into devnet's examples. |
| `KIT_ALLOW_MAINNET` | `1` | Mainnet only: your yes. With it, every start, deploy and restart starts the market bot with real funds, without a dry run and without a question (README, "On mainnet"). Set it last. Without it no bot starts at all, also not to finish open trades. |
| `KIT_MARKET_CONFIG` | the market bot's whole config, as JSON | Mainnet only. Written to `/data/market.mainnet.json` at each start, also under `KIT_HOLD=1`. Without it, the file on the volume is used as it is. |
| `KIT_START_ARGS` | for example `dry-run` | What follows the network on `start.sh`'s command line: `dry-run`, `setup`, `seller`, `buyer`, `market --config /data/other.json`. Split at blanks. Empty: both example bots on devnet, the market bot on mainnet. |
| `KIT_HOLD` | `1` | Start no bot and keep the container running, to open a shell in it ("A shell, and the files on the volume" below). |
| `KIT_SKIP_FAUCET` | `1` | Devnet: never ask the faucet on a start (`start.sh` reads it). |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `30` | Railway's own: how long a container has between SIGTERM and SIGKILL. Railway's default is 0 ("What a deploy does to a running bot" below). |
| `KIT_STATE_DIR` | a path | The volume's folder, if it is not `/data`. On Railway the entrypoint takes the volume's mount path from `RAILWAY_VOLUME_MOUNT_PATH`, which Railway sets. |
| `KIT_CLEAR_LOCKS` | `1` or `0` | Remove, or leave, the lock files an earlier container left (step 3 of "What the image does"). Not set: remove them on Railway, leave them anywhere else ("On any Docker host" below). |
| `KIT_ALLOW_NO_VOLUME` | `1` | Devnet only: run the example bots without a volume. Their keys and state end with the container. |

The kit never takes a key from a variable. `KIT_STORE_KEY_FILE` (README,
"Encrypting the store") still names a file: keep that file on the volume,
for example `/data/keys/store.key`, and copy it with the keys.

### On devnet

With `KIT_NETWORK=devnet`, or no variable at all on a new volume, the first
start makes a key pair for each example bot in `/data/keys`, asks the devnet
faucet for test tokens, and runs the seller and the buyer together, as `sh
start.sh devnet` does on your own machine (README, "What `sh start.sh` does
on devnet"). Three things differ on Railway:

- **The faucet counts connections.** It serves each connection at most 3
  times a day, and Railway's outbound addresses are shared between its
  customers, so it may refuse a bot it has never seen. The bots start all
  the same and wait for tokens. Ask from your own machine instead, in a
  copy of the kit there, with the two addresses each bot printed:
  `npm run faucet -- --pha <P2K address> --base <0x address>`. Then set
  `KIT_SKIP_FAUCET=1` on the service.
- **One container, two bots.** When one of the two stops on an error, the
  other keeps running, the container with it, and nothing restarts the one
  that stopped: Railway sees a running container. The pair is a
  demonstration. A bot that must stay up runs alone in its service
  (`KIT_START_ARGS=seller`, or the market bot on mainnet), each service
  with a volume of its own.
- **The board decides.** When the preflight fails (`preflight FAIL board:
  P2P is off on devnet at this board`, an RPC that does not answer), the
  bots stop with an error, Railway starts the container again up to 10
  times, and then marks the deployment Crashed and tells the project's
  members. Nothing was sent. Deploy again once the cause is gone.

### On mainnet

Mainnet is real funds: nobody can undo a trade for you, so start small, and
take the steps in this order.

1. **Keys.** Set `KIT_NETWORK=mainnet` and deploy. The first start on the
   volume runs `sh start.sh mainnet setup`: it makes the market bot's own
   key pair, `/data/keys/mainnet/market-pha.json` and
   `/data/keys/mainnet/market-base.json` (mode 0600), prints its two
   addresses, and writes `/data/market.mainnet.json`, which lists nothing.
   A dry run follows, and the container exits: with nothing listed the bot
   has nothing to do. Railway does not restart a container that exits
   without an error. (When that dry run cannot read the board or a chain it
   ends with an error, and Railway repeats it: the keys are made once all
   the same.)
2. **Keep a copy of the keys** ("Keep a copy of the keys" below), before
   anything of value reaches their addresses. The copy may need a running
   container: set `KIT_HOLD=1` and deploy for it, then remove `KIT_HOLD`.
3. **Funds.** Send the two addresses only what the bot should trade
   (README, "On mainnet", step 4). This step needs no deploy.
4. **Your config, and a dry run of it.** Put the whole config in
   `KIT_MARKET_CONFIG`: the text of `examples/market.mainnet.example.json`
   with your own `offers`, `bids` or `take` (`examples/README.md`, "The
   config"). Keep its `network`, `keys` and `dataDir` as they are:
   `./keys/mainnet/...` and `./data/market` are on the volume, and the
   entrypoint refuses a config without them. Do not copy the devnet
   examples' prices: on mainnet a price is a real trade at that price. Set
   `KIT_START_ARGS=dry-run` with it, then deploy. The logs show the
   balances, the open offers, the reference price, and what the bot would
   list and take; nothing is sent. A dry run that ends with "Dry run done"
   and no more exits without an error. One that ends with "A real start
   would stop here", or that could not read the board or a chain, exits
   with an error: Railway then repeats it, up to 10 times, and marks the
   deployment Crashed. Read the first run, put right what it names, and
   deploy again.
5. **Your yes.** Remove `KIT_START_ARGS`, set `KIT_ALLOW_MAINNET=1` and
   deploy. The bot now trades, and every later deploy or restart starts it
   again without asking.

**To change your offers**, set the new `KIT_MARKET_CONFIG` together with
`KIT_START_ARGS=dry-run` and deploy: the bot is away while you read that
dry run. Then remove `KIT_START_ARGS` and deploy. At its start the bot
keeps the open offers that still match the config, cancels those the config
no longer lists, and lists the new ones. With `KIT_ALLOW_MAINNET=1` in
place, a deploy without the dry run trades at once at the prices it finds,
a typing error included.

**To take your yes back**, stop the bot first ("To stop a bot for good"
below). Removing `KIT_ALLOW_MAINNET` alone only makes the next start refuse
to run: no bot starts, also not the one that would cancel the offers and
finish the open trades.

## What a deploy does to a running bot

A new deploy (a push to your repository, a changed variable, "Redeploy")
replaces the container. "Restart" (the dashboard's, or `railway restart`)
starts the bot again in the same deployment, from the same image and the
same variables, without a build: a changed variable needs a deploy.

- **Railway stops the old container before it starts the new one**, as for
  every service with a volume, so the bot is away for a short time at each
  deploy (https://docs.railway.com/volumes/reference).
- **The stop is SIGTERM, then SIGKILL** after
  `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`, which is 0 unless you set it
  (https://docs.railway.com/deployments/deployment-teardown). `tini`, the
  image's first process, passes the SIGTERM on to `start.sh` and the bots.
  - With **0**, the bot is killed at once, as by a power cut. Its state is
    made for that (README, "Crash-safe state"): the next start resumes
    every trade from the board and the chains. Its offers stay listed until
    their heartbeats lapse (90 seconds) or the new container takes them up
    again.
  - With **30**, a bot with no running trade stops as on Ctrl-C: it cancels
    its offers and exits, and the new container lists them again. A bot
    with a running trade is still finishing it when the 30 seconds end, and
    is killed then; the next start resumes the trade. A longer time only
    makes each deploy longer: a trade can take hours to end.
- **The new container resumes.** Every trade goes on where it was, and
  nothing is sent blindly twice. A recurring `take` order sends its first
  order at each start, not `everyS` seconds after the last one: a
  deployment that fails 10 times after that first order sends it 11 times.
  Keep its amount small, or leave `take` out of a mainnet config.
- **A stopped bot sends no lock, no claim and no refund.** A lock it owes
  and does not send in time is its no-show, and a bot that is the buyer
  must claim its tokens before the seller's lock ends, or count on Saturn's
  keeper to do it. So do not deploy while the bot has trades open if you
  can wait, do not leave it stopped, and look at the logs after each
  deploy.

**A start can fail where a running bot would have carried on.** A running
bot carries on through an outage of the board or an RPC; a start needs both,
and stops with an error when the preflight fails. Railway's restart policy
then starts the container again, 10 times by default, and after that marks
the deployment Crashed and tells the project's members
(https://docs.railway.com/deployments/restart-policy). The entrypoint's
waits (step 4 of "What the image does") stretch those 10 starts over about
25 minutes. After that the bot stays stopped until you deploy again: let
Railway's notice reach someone who acts on it. On a paid plan the number of
restarts can be raised in the service's settings.

**A quiet log is not a sign of health.** A bot with nothing to do prints
nothing, and so does one that cannot read a chain. Watch from outside too:
the bot's offers on https://ops.saturnx.cc/p2p and its two addresses on the
chains' explorers.

**To stop a bot now, without a deploy:** `railway ssh -- pkill -TERM node`
is one Ctrl-C. Within seconds the bot cancels its offers and takes nothing
new; it then finishes its running trades ("Waiting for 1 running trade(s)
to finish", which can last hours) and exits by itself, and Railway does not
start a container again that exits without an error. **Send it once.** A
second one is the second Ctrl-C: the bot exits at once with an error, and
Railway starts it again, trading. So does one sent in the bot's first
seconds, before it has printed "running". And a deploy, a restart or a
crash before it has exited starts the bot as usual, with its offers.

**To stop a bot for good**, do not remove its deployment while trades are
open. Either way below, keep `KIT_ALLOW_MAINNET=1` until nothing is left
open: the start that finishes the trades needs it.

- Ask it to stop, once, as above, and wait for its sentence "Every trade of
  this bot is finished, and its offers are cancelled. Stopped." The
  container then exits without an error.
- Or, to have it list nothing across restarts as well: in
  `KIT_MARKET_CONFIG`, empty only the three lists (`"offers": [], "bids":
  [], "take": []`) and keep every other key as it is, then deploy. The
  start says what the bot's saved state still holds ("the market bot still
  has 2 unfinished trade(s) ..."), and the bot cancels its offers and
  finishes those trades. Restart it later (`railway restart`): nothing is
  left open once a start ends with "Dry run done" and then "lists no
  offers, bids or orders yet, so the market bot has nothing to do", and the
  container exits without an error. A start that ends with an error, or a
  deployment that is Crashed, shows nothing of the kind.

Remove the deployment then (its menu, or `railway down`), and move the
funds off the bot's addresses only after that.

## A shell, and the files on the volume

Railway's CLI (https://docs.railway.com/cli) reaches both. Update it, log
in (`railway login`) and link a folder to the project (`railway link`). Run
`railway ssh` once by itself first: it registers an SSH key for your
account.

- **A shell in the running container:** `railway ssh`, or one command with
  `railway ssh -- <command>` (https://docs.railway.com/cli/ssh). The
  dashboard's Console tab is the same shell in the browser. The kit is in
  `/app`. `sh start.sh mainnet setup` there shows the market bot's
  addresses again, also while the bot runs.
- **A shell with no bot running:** set `KIT_HOLD=1` and deploy. The
  container then starts no bot and waits, with the links of "What the image
  does" in place and `KIT_MARKET_CONFIG`, if it is set, written to the
  volume. Use it for what needs the bot stopped: a dry run by hand (`sh
  start.sh mainnet dry-run`), putting a key pair on a new volume before a
  first start, or `examples/prune.ts` (`node --import tsx
  examples/prune.ts --config market.mainnet.json --dry-run`). Remove
  `KIT_HOLD` and deploy to start the bot again: while it is set, no lock,
  claim or refund is sent. A shell needs a running container: there is none
  after a container has exited.
- **The files on the volume:** `railway volume files list /`,
  `railway volume files download <on the volume> <here>` and
  `railway volume files upload <here> <on the volume>`
  (https://docs.railway.com/cli/volume; `railway volume --help` shows the
  form your CLI version takes). With more than one volume in the project,
  name it: `railway volume files --volume <name> list /`. The volume's `/`
  is the container's `/data`: `list /` shows `keys` and `data`. Railway
  says these commands need no running container, but people have met a
  timeout ("Failed to initialize SFTP session") when the service was
  stopped: if you do, set `KIT_HOLD=1`, deploy, and copy the files while
  that container runs.

A file you upload into `keys` may arrive readable by everyone, which the
kit refuses (`KEY_FILE_MODE`): the entrypoint makes every file under
`/data/keys` private again at each start. Never change, add or copy a file
among a bot's records (`offers`, `trades` and the other folders of
`/data/data/<bot>/<network>`): the kit takes a file it does not know there
for a damaged store and stops (`STORE_CORRUPT`), and a lock file deleted
under a running bot stops it at its next write.

### Keep a copy of the keys

The volume is the only place the keys are. Without a copy, a deleted volume
or project is the end of what their addresses hold. Make the copy in a
folder of its own, outside the kit's folder and every repository, private
from the start:

```sh
mkdir -m 700 ~/kit-keys
railway volume files download /keys ~/kit-keys
```

Or, while a container runs, one file at a time:

```sh
(umask 077; railway ssh -- cat /data/keys/mainnet/market-pha.json > ~/kit-keys/market-pha.json)
(umask 077; railway ssh -- cat /data/keys/mainnet/market-base.json > ~/kit-keys/market-base.json)
```

Make the files private (`chmod 600`), then look at what arrived: each is one
short row of JSON (`{"wif": ...}` and `{"privateKey": ...}`), and `sh
start.sh mainnet setup` in a copy of the kit on your own machine, with the
two files in its `keys/mainnet/`, prints the same two addresses as the
bot's log. Copy `/data/keys/store.key` too if you set `KIT_STORE_KEY_FILE`.

Each bot's state (`/data/data`) holds the swap secrets of its unfinished
trades: copy it, with the bot stopped, if you move the bot elsewhere. An
old copy of it is not a way back: a bot started on yesterday's state no
longer knows today's offers and trades, and sends no claim and no refund
for them. Railway's own volume backups
(https://docs.railway.com/volumes/backups) are a copy of the keys, inside
Railway, and can only be put back into the same project. Do not put one
back over a bot that has traded since: it brings yesterday's state back,
and yesterday's `market.mainnet.json`.

To move a key pair onto a new volume, upload the two files to
`/keys/mainnet/` (or `/keys/` for the devnet bots) before the first start
with `KIT_NETWORK` set, or under `KIT_HOLD=1`: `start.sh` never replaces a
key file that is there.

## Know before you rely on it

- **A paid plan.** On Railway's trial and Free plan a service is stopped
  when its credit is used up, and the volume is deleted 30 days later: that
  volume holds the keys (https://docs.railway.com/pricing/free-trial). A
  paid plan that is cancelled loses its volumes some weeks later as well.
  On any plan, a usage limit you set or an unpaid invoice stops every
  service, and a stopped bot sends no lock, no claim and no refund.
- **An API key, since the address is shared.** Without an API key the board
  knows a bot by its IP address, and Railway's outbound addresses are
  shared between its customers, also the static ones of its Pro plan. A
  stranger's bot behind the same address then shares your bot's limits and
  its no-show count (README, "API keys and limits"). Ask for a key in the
  Saturn Telegram channel (https://t.me/stellargateio), upload it as
  `/keys/api-key`, and name it in your config: `"apiKeyFile":
  "./keys/api-key"`. One rule a key does not change: a take that comes from
  the same address as the offer counts as the maker's own, whoever sent it,
  so a take by another bot at Railway, behind your bot's address, does not
  count toward your accept rate.
- **Your own Base RPC.** The kit's pinned Base RPCs are public ones, which
  limit each address, and yours is shared here: a limited RPC fails a start
  and slows every step of a trade. A `baseRpc` of your own in the config
  (https, serving the pinned chain) takes the bot off that limit. Choose a
  provider you would trust with the bot's balance: the kit believes what
  its RPC says about the chain.
- **Railway can be away.** A deploy, a restart, a move to another of
  Railway's machines or trouble at Railway takes the bot away for a while,
  and while Railway pauses deploys you cannot change the bot's config this
  way: the running bot goes on at its old prices ("To stop a bot now" above
  needs no deploy). Start small.
- **Railway's rules.** Its Acceptable Use Policy
  (https://railway.com/legal/acceptable-use) forbids cryptocurrency mining,
  and bots that break the terms of the service they use. A bot on the
  Saturn board is what the board is for; ask Railway if you are unsure
  about yours.
- **What it costs.** One bot used between 115 and 160 MiB of memory at its
  start when this guide was written, and little processor time after it.
  Railway meters what a service uses by the minute, and a plan's monthly
  fee already pays for that much usage (https://railway.com/pricing): work
  it out from its current prices.
- **No `railway.json`.** Railway's Config as Code is deprecated, and
  Railway stops reading those files on 1 December 2026
  (https://docs.railway.com/config-as-code). Nothing here needs one:
  Railway finds the `Dockerfile`, and the rest is the volume and the
  variables above. Railway's Infrastructure as Code
  (https://docs.railway.com/infrastructure-as-code) can hold a service, its
  volume and its variables in a file; it needs Railway's own package beside
  the kit's, so the kit ships none.

## If something goes wrong

| The logs say | What it means, and what to do |
|---|---|
| `entrypoint.sh: /data is not a volume` | No volume is mounted at `/data`. Attach one with that mount path, then deploy. No key was made. |
| `KIT_ALLOW_NO_VOLUME=1 is for devnet's test tokens` | Mainnet does not start without a volume, whatever is set: a key made there would be lost with what was sent to it. |
| `the network is not named, and this volume holds a mainnet bot's keys or state` | `KIT_NETWORK` is not set on a volume that a mainnet bot has used. Set `KIT_NETWORK=mainnet` to run that bot. |
| `The last start was 4 s ago (start 2 in a row): waiting 5 s before this one.` | The container was started again within half a minute of its last start. Mostly the bot stopped on an error, whose reason is in the lines before; a restart by hand does the same. The wait is step 4 of "What the image does". |
| `STORE_LOCKED: ... on <another host>` | A lock file of an earlier container was left in place: `KIT_CLEAR_LOCKS=0` is set, or a Node process ran in the container when the entrypoint looked. With no bot running, delete the `.lock` file the message names. |
| `STORE_LOCKED: ... is in use by process ...` with no host | Another copy of that bot runs in the same container: a dry run typed in a shell while the bot runs, for one. Stop it first. |
| `start.sh: on mainnet the market bot starts only once you type yes` | `KIT_ALLOW_MAINNET=1` is not set, and the config lists offers, or lists nothing while the bot's saved state still holds offers or trades. Look at a dry run (`KIT_START_ARGS=dry-run`), then set it. |
| `KIT_MARKET_CONFIG cannot be the market bot's config: ...` | The variable does not hold the whole config, or names key files or a data folder that are not the volume's. The words after the colon say which. The config on the volume was left as it was, and no bot was started. |
| `the market bot's config, /data/market.mainnet.json, cannot be used here: ...` | The same, for the file on the volume. |
| `preflight FAIL board: P2P is off on ...` | The board does not run P2P on that network now. Nothing to change on Railway: deploy again once it does. |
| `RPC_NOT_ALLOWED`, or a preflight item that fails on an RPC | A chain's RPC did not answer, or it is not the network's own. Railway starts the container again; set your own `baseRpc` if it lasts. |
| `KEY_FILE ... cannot be opened (ENOENT)` | The config names key files that are not on the volume. The market bot's are `./keys/mainnet/market-pha.json` and `./keys/mainnet/market-base.json`. |
| The deployment is Crashed | The container stopped with an error, was started again 10 times and stopped each time. Its last lines say why; put that right, then deploy again. |
| The container has exited and nothing restarts it | It exited without an error: a setup, a dry run that found nothing to put right, a mainnet config that lists nothing, or a stop you asked for. That is how those end. |
| `Failed to initialize SFTP session: Timeout` from `railway volume files` | No container of the service runs. Set `KIT_HOLD=1`, deploy, and copy the files then. |

`README.md`, "If something goes wrong", has the kit's own messages.

## On any Docker host

The image needs nothing of Railway's: a volume at `/data`, and the same
variables.

```sh
docker build -t p2pbotkit .
docker volume create p2pbotkit-data
docker run -d --name p2pbotkit --restart on-failure:10 --stop-timeout 30 \
  -e KIT_CLEAR_LOCKS=1 -v p2pbotkit-data:/data p2pbotkit
docker logs -f p2pbotkit
```

Use a named volume or a folder of the host (`-v /srv/p2pbotkit:/data`), not
a `tmpfs` and not an unnamed volume: those end with the container, and the
entrypoint cannot tell them from a volume that stays.

`docker stop p2pbotkit` is one Ctrl-C: the bots stop cleanly, or are killed
when the stop timeout ends, and the next start resumes their trades.

`KIT_CLEAR_LOCKS=1` says that this volume is mounted in one container at a
time: the entrypoint then removes the lock file a killed bot left, which
the kit would refuse in a new container (step 3 of "What the image does").
Give it only to the bot's own container, and start no second container on
the volume while that one runs, not for a dry run either: it would take the
running bot's lock away, and the bot stops at its next write. Without the
variable the entrypoint names the lock files it finds and leaves them: a
new container after a kill then stops on `STORE_LOCKED` until you delete
the file that message names.

`docker run --rm -e KIT_ALLOW_NO_VOLUME=1 p2pbotkit dry-run` shows what the
example bots would do, with keys that end with the container.
