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
where a step depends on them. The image and its entrypoint were tested in
containers on a Docker host. On Railway itself these have been seen, on one
project in November 2026: the image builds there, a Railway volume at
`/data` is taken for a volume, and a deploy stops the old container before
it starts the new one (check 3 below, without draining seconds: the two
were 2 seconds apart, each under a host name of its own). The first
mainnet start, a dry run and a market bot listing its offers ran there
too, with the config set through the Raw Editor's JSON tab, and the key
files were copied off the volume one at a time with `railway volume files
download` (CLI 5.74, once an SSH key was registered). The rest is from
Railway's pages. So make the checks on a project of your own before
funds depend on it ("Check it once on your own project" below).

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
   `/app/keys/...`, the file is on the volume. A config whose own key
   files, API key file or data folder are anywhere else is refused: a bot's
   state on the container's disk would end with the container.
3. **Locks of an earlier container.** A bot that is killed leaves its lock
   file in its data folder. The kit takes over the lock of a dead process on
   its own machine, but a new container has a new host name, and there the
   kit sees a bot on another machine and refuses to start (`STORE_LOCKED:
   ... is in use by process 7 on 260b0665c620 ... if that process is gone,
   delete .../.lock`). Railway mounts a volume in one container at a time,
   so while no Node process runs in the new container, every lock file on
   its volume is a leftover: on Railway the entrypoint removes them and
   says so. (Anywhere else it removes only the lock this same container
   left: "On any Docker host" below.)
4. **A start soon after the last one waits.** A start can fail where a
   running bot would have carried on, and Railway starts a container that
   stopped on an error again only 10 times. A start that comes within five
   minutes of the last one therefore waits first: 5 seconds, then 10, 20,
   40, 80, 160, and 300 from then on. Ten such starts then last 25 minutes
   or more, so an outage of the board or an RPC that long passes. The
   entrypoint cannot tell why a start follows the last one: a deploy or a
   restart by hand within those five minutes waits as well. The count is
   kept in `/data/.last-start`, and five minutes without a start set it
   back.
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
| `KIT_ALLOW_MAINNET` | `1` | Mainnet only: your yes. With it, every start, deploy and restart starts the market bot with real funds, without a dry run and without a question (README, "On mainnet"). Set it last. Without it no bot starts at all, also not to finish open trades. While it is set the entrypoint makes no key pair: a start that would have to make one (a volume with no `market.mainnet.json` and without both of the market bot's key files) is refused ("One service, one volume, one bot" below). |
| `KIT_MARKET_CONFIG` | the market bot's whole config, as JSON | Mainnet only. Written to `/data/market.mainnet.json` at each start (the log says "Wrote the market bot's config"), also under `KIT_HOLD=1` once the volume has had its first start. Without it, the file on the volume is used as it is. One that is not the whole config, that names key files or a data folder off the volume, or that would take the bot away from its saved state, is refused: the config on the volume stays as it was, and no bot starts. The variable may name the data folder the volume's config names already, a folder that holds a bot's state itself (unless the config it replaces names another that does), or any folder while the volume holds no state at all. |
| `KIT_START_ARGS` | for example `dry-run` | What follows the network on `start.sh`'s command line: `dry-run`, `setup`, `seller`, `buyer`. Split at blanks. Empty: both example bots on devnet, the market bot on mainnet. `market --config /data/other.json` runs a config you put on the volume yourself, with its own key files: `KIT_MARKET_CONFIG`, the first start's setup and the steps of "On mainnet" are for `market.mainnet.json` only. |
| `KIT_HOLD` | `1` | Start no bot and keep the container running, to open a shell in it ("A shell, and the files on the volume" below). |
| `KIT_PROBE` | `1` | Start no bot. The container says whether another one is writing to the volume, then writes there once a second itself until Railway ends it: two deploys with it show whether Railway runs two containers on the volume at a time ("Check it once on your own project" below). |
| `KIT_SKIP_FAUCET` | `1` | Devnet: never ask the faucet on a start (`start.sh` reads it). |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `30` | Railway's own: how long a container has between SIGTERM and SIGKILL. Railway's default is 0 ("What a deploy does to a running bot" below). |
| `KIT_STATE_DIR` | a path | The volume's folder, if it is not `/data`. On Railway the entrypoint takes the volume's mount path from `RAILWAY_VOLUME_MOUNT_PATH`, which Railway sets. |
| `KIT_CLEAR_LOCKS` | `1` or `0` | Remove, or leave, the lock files a bot that is gone left (step 3 of "What the image does"). Not set: all of them on Railway; anywhere else only the one this same container left ("On any Docker host" below). |
| `KIT_ALLOW_NO_VOLUME` | `1` | Devnet only: run the example bots without a volume. Their keys and state end with the container. |

The kit never takes a key from a variable. `KIT_STORE_KEY_FILE` (README,
"Encrypting the store") still names a file: keep that file on the volume,
for example `/data/keys/store.key`, and copy it with the keys. The
entrypoint refuses one that is anywhere else: without that key a sealed
state cannot be read again.

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
   examples' prices: on mainnet a price is a real trade at that price. In
   the service's Variables, the Raw Editor's JSON tab takes the whole set
   at once (`{"KIT_NETWORK": "mainnet", "KIT_MARKET_CONFIG": "{...}"}`,
   the config as one JSON string), which keeps its quotes intact. Set
   `KIT_START_ARGS=dry-run` with it, then deploy. The logs show the
   balances, the open offers, the reference price, and what the bot would
   list and take; nothing is sent. A dry run that ends with "Dry run done"
   and no more exits without an error. One that ends with "A real start
   would stop here", or that could not read the board or a chain, exits
   with an error: Railway then repeats it, up to 10 times, and marks the
   deployment Crashed. Read the first run, put right what it names, and
   deploy again. (A config that holds an RPC address with a provider's key
   in it does not belong in a variable: "Your own Base RPC" below.)
5. **Your yes.** Remove `KIT_START_ARGS`, set `KIT_ALLOW_MAINNET=1` and
   deploy. The bot now trades, and every later deploy or restart starts it
   again without asking.

**One service, one volume, one bot.** Do not let Railway copy this
service: keep PR environments off for its project, and do not duplicate
its environment (https://docs.railway.com/environments). A copy has the
same variables, `KIT_ALLOW_MAINNET=1` among them, and a volume of its own.
Railway's pages say a sealed variable is not copied
(https://docs.railway.com/variables): seal `KIT_ALLOW_MAINNET`, and a copy
has no yes. (A sealed value can be set anew, but not shown or unsealed.)

- On an empty volume the entrypoint refuses to start it: "this volume has
  no market.mainnet.json and no market bot's key pair ... and
  KIT_ALLOW_MAINNET=1 is set already". A bot's keys and the state of its
  open trades are on the volume it ran on, and its funds are at those
  keys' addresses: a new key pair is not that bot. You meet the same
  message after you replaced or wiped the bot's volume. Attach its own
  volume again. Or, under `KIT_HOLD=1`, put a copy of its two key files
  and of its data folder on the new one, where its config names them
  (`/keys/mainnet/market-pha.json`, `/keys/mainnet/market-base.json` and
  `/data/market` for the template's names): the next start then finds the
  key files that `KIT_MARKET_CONFIG` names, makes nothing, and writes the
  variable as the volume's config. If you keep the config as a file and
  not in `KIT_MARKET_CONFIG`, put a copy of its `market.mainnet.json`
  there too: without either, a start writes a config that lists nothing,
  and the bot cancels its offers and only finishes its trades. And a bot
  whose state is in a folder that no config on the volume names is
  refused until it has its config: "this volume has no
  market.mainnet.json, and ... holds a mainnet bot's saved state".
- With a copy of the volume's files (Railway's PR environments can be set
  to copy volume data) the copy is the same bot a second time, on the same
  keys and the same trades. Nothing in the kit can see that from inside
  one container. Remove such a copy before it starts.

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
waits (step 4 of "What the image does") stretch those 10 starts over 25
minutes or more; whatever Railway itself waits between two restarts, which
its pages do not say, comes on top. After that the bot stays stopped until
you deploy again: let
Railway's notice reach someone who acts on it. On a paid plan the number of
restarts can be raised in the service's settings.

**A quiet log is not a sign of health.** A bot with nothing to do prints
nothing, and so does one that cannot read a chain. Watch from outside too:
the bot's offers on https://ops.saturnx.cc/p2p and its two addresses on the
chains' explorers.

**To stop a bot now, without a deploy:** `railway ssh -- pkill -TERM node`
is one Ctrl-C. The bot answers "Stopping: no new offers or takes": within
seconds it cancels its offers, then it finishes its running trades
("Waiting for 1 running trade(s) to finish", which can last hours) and
exits by itself, and Railway does not start a container again that exits
without an error. **Send it once.** A second one is the second Ctrl-C: the
bot exits at once with an error, and Railway starts it again, trading. So
does one sent in the bot's first seconds, before its row `[kit] mainnet:
running (...)`. A deploy, a restart or a crash before it has exited starts
the bot as usual, with its offers. And while the log's last row is
"waiting N s before this one", no bot runs: the command stops nothing, and
the bot starts when the wait ends. To keep it from starting, set
`KIT_HOLD=1` and deploy.

**To stop a bot for good**, do not remove its deployment while trades are
open. Either way below, keep `KIT_ALLOW_MAINNET=1` until nothing is left
open: the start that finishes the trades needs it.

- Ask it to stop, once, as above, and wait for its sentence "Every trade of
  this bot is finished, and its offers are cancelled. Stopped." The
  container then exits without an error.
- Or, to have it list nothing across restarts as well: in
  `KIT_MARKET_CONFIG`, empty only the three lists (`"offers": [], "bids":
  [], "take": []`) and keep every other key as it is, above all `dataDir`:
  a start looks for open offers and trades only in the data folder its
  config names, and the entrypoint refuses a `KIT_MARKET_CONFIG` that
  names another one while the bot's state is in the old. Then deploy. The
  start says what the bot's saved state still holds ("the market bot still
  has 2 unfinished trade(s) ..."), and the bot cancels its offers and
  finishes those trades. Restart it later (`railway restart`): nothing is
  left open once a start ends with "Dry run done" and then "lists no
  offers, bids or orders yet, so the market bot has nothing to do", the
  container exits without an error, and no row of that start says "holds
  a mainnet bot's state": that is the entrypoint's note on a state in a
  folder the config does not name, wherever on the volume. A start that
  ends with an error, or a deployment that is Crashed, shows nothing of
  the kind.

Remove the deployment then (its menu, or `railway down`), and move the
funds off the bot's addresses only after that.

## A shell, and the files on the volume

Railway's CLI (https://docs.railway.com/cli) reaches both. Use a current
version: an older one (4.15, for one) has neither `railway volume files`
("unrecognized subcommand 'files'") nor `railway upgrade`, so update it
the way it was installed (`brew upgrade railway`, or `npm i -g
@railway/cli`; `which railway` tells which). Then log in (`railway login`) and link a
folder to the project (`railway link`).

Both reach the container over SSH, with a key registered with Railway.
Register yours once, and if it has a passphrase, hand it to the SSH agent
so the CLI can use it:

```sh
railway ssh keys add --key ~/.ssh/id_ed25519.pub
```

```sh
ssh-add ~/.ssh/id_ed25519
```

`railway ssh keys` lists the keys Railway knows.

- **A shell in the running container:** `railway ssh`, or one command with
  `railway ssh -- <command>` (https://docs.railway.com/cli/ssh). The
  dashboard's Console tab is the same shell in the browser. The kit is in
  `/app`. `sh start.sh mainnet setup` there shows the market bot's
  addresses again, also while the bot runs.
- **A shell with no bot running:** set `KIT_HOLD=1` and deploy. The
  container then starts no bot and waits, with the links of "What the image
  does" in place and, on mainnet, `KIT_MARKET_CONFIG` written to the volume
  if it is set (its log says "Wrote the market bot's config"; not on a
  volume that has had no first start yet, which still has to make the key
  pair). Use it for what needs the bot stopped: a dry run by hand (`sh
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
mkdir -p ~/kit-keys && chmod 700 ~/kit-keys
```

Then the two key files, one at a time (`railway volume files list
/keys/mainnet` shows them first; with more than one volume the CLI asks
which):

```sh
railway volume files download /keys/mainnet/market-pha.json ~/kit-keys/market-pha.json
```

```sh
railway volume files download /keys/mainnet/market-base.json ~/kit-keys/market-base.json
```

Or, while a container runs, through `railway ssh`:

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

To move a key pair onto a new volume, upload both of its files to
`/keys/mainnet/` (or `/keys/` for the devnet bots) before the first start
with `KIT_NETWORK` set, or under `KIT_HOLD=1`: `start.sh` never replaces a
key file that is there, and with only one of the two it stops and makes
none. A bot that has traded needs its data folder as well ("One service,
one volume, one bot" above).

## Check it once on your own project

Little of this guide was run on Railway itself (what was is said at its
top), and what Railway does can change. Five checks on devnet, with test
tokens, show whether your project does what the guide says. Make them
before the mainnet steps.

1. **The build and the volume.** The first deploy's log begins "Saturn P2P
   bot kit in a container: devnet, with its keys and state on the volume
   at /data." Then the image was built, the volume is mounted, and the
   entrypoint took it for one. "is not a volume" while a volume is
   attached at `/data` means the entrypoint cannot tell Railway's volume
   from the container's disk: stop there.
2. **A deploy over running bots.** While both bots run, and before you
   set the draining seconds of check 4, press Redeploy. The new
   deployment's log must say "Removed /data/data/seller/devnet/.lock, the
   leftover lock of a bot that is gone", and both bots must start. If it
   stops on `STORE_LOCKED` instead, set `KIT_CLEAR_LOCKS=1`.
3. **One container at a time.** The entrypoint removes those locks because
   Railway says it stops the old container before it starts the new one.
   See it, with the draining seconds you mean to use
   (`RAILWAY_DEPLOYMENT_DRAINING_SECONDS`, or none). Set `KIT_PROBE=1` and
   deploy: the container starts no bot and writes a mark to the volume
   once a second, also after Railway's SIGTERM, as a bot that is finishing
   a trade goes on. When its log says "Writing to /data/.probe once a
   second now", press Redeploy. Only that second deployment's log counts:
   a probe sees only another probe, never a bot, so the deploy that first
   set `KIT_PROBE` compares nothing and says so ("No probe's mark is on
   this volume"). The second one has one of two rows:
   - "ONE CONTAINER AT A TIME: the probe before this one ... wrote its
     last mark 9 s before this container started, and none since." The
     old container was gone first, and the number is how long the volume
     had none.
   - "TWO CONTAINERS AT ONCE: another container ... went on writing to
     this volume for 30 s after this one had started." A bot that is
     replaced would run beside its successor for that long, and the
     entrypoint would take its lock away. Set `KIT_CLEAR_LOCKS=0`: a
     start then names a leftover lock and the kit refuses it, until you
     delete the file by hand. Ask Railway, and try the check without
     draining seconds. Later, an old deployment whose log ends with
     `STORE_LOCK_LOST` is the same finding.

   After a change of the draining seconds, make the check anew: one
   deploy that brings the change, then a Redeploy over that probe. Remove
   `KIT_PROBE` afterwards. With draining seconds set, a deploy over the
   probe takes that long, as it does over a bot with a trade under way.
4. **A clean stop.** Set `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30`, deploy,
   and then redeploy over the running bots. The old deployment's log must
   show "Stopping: the bots cancel their offers and finish their running
   trades, then exit.", and each bot's "Stopping: no new offers or
   takes": then Railway's SIGTERM reaches the bots. "Both bots stopped"
   follows only when no trade outlasts the 30 seconds. (Checks 2 and 4
   need bots that run. While the board has P2P off on devnet, as on the
   day this guide was written, the bots stop at their preflight, and
   these two checks have to wait.)
5. **A start that fails.** A devnet start fails while the board has P2P
   off there, and so does any start with an RPC that does not answer. When
   you meet one, count the starts in the log, read their "waiting N s"
   rows, and see the deployment end as Crashed: that is how many restarts
   your service gets, and how long they last.

Copy the devnet keys once as well ("Keep a copy of the keys" above): the
commands are the ones you will need for the mainnet keys.

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
  its RPC says about the chain. Most providers put your key in the
  address. Keep such a config out of Railway's variables: leave
  `KIT_MARKET_CONFIG` unset and, once the first start has made the keys,
  put the config on the volume as a file, then restart the bot (`railway
  restart`):

  ```sh
  railway volume files upload market.mainnet.json /market.mainnet.json
  ```
- **The kit's own bots.** The image runs `start.sh`'s commands: the two
  example bots and the market bot. A bot script of your own is not for a
  Custom Start Command, which would run it without the volume test, the
  links and the lock handling above. Give it an entrypoint of its own that
  does what `docker/entrypoint.sh` does and then runs your script where
  this one runs `start.sh`.
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
| `The last start was 4 s ago (start 2 in a row): waiting 5 s before this one.` | The container was started again within five minutes of its last start. Mostly the bot stopped on an error, whose reason is in the lines before; a deploy or a restart by hand does the same. The wait is step 4 of "What the image does". Before a deploy you make on purpose soon after the last one, delete `/data/.last-start` while the bot runs (`railway ssh -- rm /data/.last-start`): the next start then waits for nothing. |
| `this volume has no market.mainnet.json and no market bot's key pair (...), and KIT_ALLOW_MAINNET=1 is set already` | The volume has no config and not both of the market bot's key files, and the yes is given: the entrypoint makes no key pair then. For a new bot, remove `KIT_ALLOW_MAINNET` and take the steps of "On mainnet" from the first. For a bot that has run before, its keys are not on this volume, or not where its config names them ("One service, one volume, one bot"). No key was made. |
| `this volume has no market.mainnet.json, and ... holds a mainnet bot's saved state` | A bot's state is on the volume, in a folder the template does not name, and no config says so: a first start would write a config that looks elsewhere. Give the bot its config: `KIT_MARKET_CONFIG` with that folder as its `dataDir`, or its `market.mainnet.json` on the volume. Nothing was made. |
| `only one of the market bot's two key files is on this volume` | A key pair is two files, `market-pha.json` and `market-base.json`, and `start.sh` makes neither beside one that is there. Add the other one, or move the one that is there away (it may hold funds). |
| `the key files that KIT_MARKET_CONFIG names are not on the volume, and they are not the pair a first start makes` | The config in the variable names key files of your own, and they are not there. Put them where the config names them; for a new bot, keep the template's `keys`, which the first start makes. No key was made. |
| `STORE_LOCKED: ... on <another host>` | A lock file of another container was left in place: off Railway `KIT_CLEAR_LOCKS=1` is not set, or it is `0`, or a Node process ran in the container when the entrypoint looked, or a bot does run on this volume in another container. With no bot running anywhere on the volume, delete the `.lock` file the message names (on the volume it is `data/<bot>/<network>/.lock`). On Railway the entrypoint removes such a file itself and says "Removed ..., the leftover lock of a bot that is gone"; it knows Railway by `RAILWAY_VOLUME_MOUNT_PATH`, so if a deploy's first rows do not say that, set `KIT_CLEAR_LOCKS=1`. |
| `STORE_LOCKED: ... is in use by process ...` with no host | Another copy of that bot runs in the same container: a dry run typed in a shell while the bot runs, for one. Stop it first. |
| `start.sh: on mainnet the market bot starts only once you type yes` | `KIT_ALLOW_MAINNET=1` is not set, and the config lists offers, or lists nothing while the bot's saved state still holds offers or trades. Look at a dry run (`KIT_START_ARGS=dry-run`), then set it. |
| `KIT_MARKET_CONFIG cannot be the market bot's config: ...` | The variable does not hold the whole config, or names key files or a data folder that are not the volume's, or names a data folder that would take the bot away from its saved state. The words after the colon say which, and name the folders. The config on the volume was left as it was, and no bot was started. |
| `the market bot's config, /data/market.mainnet.json, cannot be used here: ...` or `the config <file> cannot be used here: ...` | The same, for the file on the volume, or for a config the command names with `--config`. |
| `KIT_STORE_KEY_FILE (...) is not on the volume` | The key that seals the bots' state must be a file on the volume, for example `/data/keys/store.key`. |
| `preflight FAIL board: P2P is off on ...` | The board does not run P2P on that network now. Nothing to change on Railway: deploy again once it does. |
| `RPC_NOT_ALLOWED`, or a preflight item that fails on an RPC | A chain's RPC did not answer, or it is not the network's own. Railway starts the container again; set your own `baseRpc` if it lasts. |
| `KEY_FILE ... cannot be opened (ENOENT)` | The config names key files that are not on the volume. The market bot's are `./keys/mainnet/market-pha.json` and `./keys/mainnet/market-base.json`: the first start on a volume makes them, while the volume has no `market.mainnet.json` yet. On a volume that got its config another way, make them in a `KIT_HOLD=1` shell (`node --import tsx examples/new-keys.ts --dir keys/mainnet --name market`), or upload your own pair to `/keys/mainnet/`. |
| The deployment is Crashed | The container stopped with an error, was started again 10 times and stopped each time. Its last lines say why; put that right, then deploy again. |
| The container has exited and nothing restarts it | It exited without an error: a setup, a dry run that found nothing to put right, a mainnet config that lists nothing, or a stop you asked for. That is how those end. |
| `Failed to initialize SFTP session: Timeout` from `railway volume files` | No container of the service runs. Set `KIT_HOLD=1`, deploy, and copy the files then. |
| `error: unrecognized subcommand 'files'` from `railway volume files` | The CLI is older than the volume commands (4.15 was). Update it the way it was installed: `brew upgrade railway`, or `npm i -g @railway/cli` ("A shell, and the files on the volume"). |
| `SSH authentication failed. Ensure one of your keys is registered with Railway` | No SSH key of yours is registered: `railway ssh keys add --key ~/.ssh/id_ed25519.pub`. |
| `No loadable SSH keys found` | The CLI could not unlock your key: a mistyped passphrase, or no terminal to ask for it. Load the key into the agent with `ssh-add ~/.ssh/id_ed25519` and try again. |

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
variable the entrypoint removes only the lock this same container left (a
restart after a kill), and names and leaves a lock from another container:
a new container after a kill then stops on `STORE_LOCKED` until you delete
the file that message names.

`docker run --rm -e KIT_ALLOW_NO_VOLUME=1 p2pbotkit dry-run` shows what the
example bots would do, with keys that end with the container.
