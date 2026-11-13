#!/bin/sh
# Saturn P2P bot kit in a container (Railway, or any Docker host): put the keys and the bots' state
# on a volume, then run start.sh. docs/RAILWAY.md says how to set it up.
#
# A container is replaced at every deploy, and only its volume stays. So this script:
#   1. refuses to start when its state folder is not a volume (a key made there would be lost);
#   2. links the kit's ./keys, ./data and ./market.mainnet.json to the volume, and refuses a
#      config whose own paths are not on it;
#   3. removes the lock files that a bot in an earlier container left on the volume, which the kit
#      would otherwise take for a bot on another machine and refuse to start;
#   4. waits before a start that follows the last one at once (a bot that keeps failing);
#   5. runs "sh start.sh <network> ..." with no terminal on its input.
#
# From the environment:
#   KIT_NETWORK          devnet or mainnet. Not named at all: devnet, unless the volume holds a
#                        mainnet bot's keys or state, which stops the start
#   KIT_START_ARGS       what follows the network on start.sh's command line, when the container's own
#                        command gives nothing: dry-run, setup, seller, buyer, ...
#   KIT_MARKET_CONFIG    mainnet: the market bot's whole config, as JSON text. Written to
#                        market.mainnet.json on the volume at each start. Without it, the file on the
#                        volume is used as it is
#   KIT_ALLOW_MAINNET    1: start.sh's own switch for a mainnet start that nobody can answer yes to
#   KIT_HOLD             1: start no bot; keep the container running, to open a shell in it
#   KIT_STATE_DIR        the volume's folder (default: RAILWAY_VOLUME_MOUNT_PATH on Railway, else /data)
#   KIT_CLEAR_LOCKS      1: remove the lock files an earlier container left; 0: leave them. Not set:
#                        remove them on Railway only, which mounts a volume in one container at a time
#   KIT_ALLOW_NO_VOLUME  1: run devnet's example bots although the state folder is not a volume
# start.sh and the bots read their own (KIT_SKIP_FAUCET, KIT_STORE_KEY_FILE, ...).
#
# MIT License (LICENSE): the kit comes as is, without warranty of any kind, and you use it at your
# own risk.

set -eu
umask 077

say() { printf '%s\n' "$*"; }
die() {
  printf 'entrypoint.sh: %s\n' "$*" >&2
  exit 1
}

KIT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd) || die "cannot find the kit's folder"
[ -f "$KIT_DIR/start.sh" ] || die "there is no start.sh in $KIT_DIR"
cd "$KIT_DIR"

# ── The network and start.sh's command ───────────────────────────────────────

if [ "$#" = 0 ] && [ -n "${KIT_START_ARGS:-}" ]; then
  # Split at blanks only: no file name patterns, and nothing is run.
  set -f
  # shellcheck disable=SC2086 # the splitting is wanted
  set -- $KIT_START_ARGS
  set +f
fi

NET=''
name_network() { # <devnet|mainnet> <where it was named>
  case "$1" in
    devnet | mainnet) ;;
    *) die "$2 is devnet or mainnet, not \"$1\"" ;;
  esac
  if [ -n "$NET" ] && [ "$NET" != "$1" ]; then
    die "two networks were named ($NET and $1): name one"
  fi
  NET=$1
}
[ -z "${KIT_NETWORK:-}" ] || name_network "$KIT_NETWORK" KIT_NETWORK
while [ "$#" -gt 0 ]; do
  case "$1" in
    devnet | mainnet)
      name_network "$1" 'The network'
      shift
      ;;
    --network)
      [ "$#" -ge 2 ] || die "--network is devnet or mainnet"
      name_network "$2" --network
      shift 2
      ;;
    --network=*)
      name_network "${1#--network=}" --network
      shift
      ;;
    *) break ;;
  esac
done
# NAMED: whether a variable, the command line or the command itself chose the network.
NAMED=1
if [ -z "$NET" ]; then
  # As start.sh has it: the market bot is mainnet's, the example bots and the faucet are devnet's,
  # and without a terminal everything else is devnet's too.
  case "${1:-}" in
    market) NET=mainnet ;;
    seller | buyer | faucet) NET=devnet ;;
    *)
      NET=devnet
      NAMED=0
      ;;
  esac
fi

# start.sh's own help makes nothing and needs nothing.
case "${1:-}" in
  help | -h | --help) exec sh "$KIT_DIR/start.sh" "$NET" "$@" </dev/null ;;
esac

# ── The volume ───────────────────────────────────────────────────────────────

STATE=${KIT_STATE_DIR:-${RAILWAY_VOLUME_MOUNT_PATH:-/data}}
case "$STATE" in
  /*) ;;
  *) die "the state folder is an absolute path (got \"$STATE\")" ;;
esac
while [ "$STATE" != / ] && [ "${STATE%/}" != "$STATE" ]; do STATE=${STATE%/}; done
[ "$STATE" != / ] || die "the state folder cannot be /"
case "$STATE/" in
  "$KIT_DIR"/*) die "the state folder cannot be inside the kit's own folder ($KIT_DIR), which every new image replaces" ;;
esac

# The device a path is on, a link followed (GNU and BusyBox stat, then BSD's).
dev_of() { stat -L -c %d "$1" 2>/dev/null || stat -L -f %d "$1" 2>/dev/null || :; }

# True when the state folder (or, while it is not made yet, the folder it will be made in) is on
# another device than the container's own disk, which ends with the container. The folder is
# looked at, not what the platform says about it, so a volume that is attached but not mounted
# here is not taken for one.
on_volume() {
  at=$STATE
  while [ ! -e "$at" ] && [ "$at" != / ]; do at=$(dirname -- "$at"); done
  [ -d "$at" ] || return 1
  here=$(dev_of "$at")
  root=$(dev_of /)
  [ -n "$here" ] && [ -n "$root" ] && [ "$here" != "$root" ]
}

VOLUME=1
if ! on_volume; then
  VOLUME=0
  if [ "${KIT_ALLOW_NO_VOLUME:-}" != 1 ]; then
    die "$STATE is not a volume: it is on the container's own disk, which ends with the container. The keys made here and the state of every running trade would be lost when the container is replaced (on Railway: at the next deploy), and with the keys whatever their addresses hold. Attach a volume with the mount path $STATE, then start again. Only to try devnet's example bots without one: KIT_ALLOW_NO_VOLUME=1"
  fi
  if [ "$NET" != devnet ]; then
    die "KIT_ALLOW_NO_VOLUME=1 is for devnet's test tokens. On mainnet a key made without a volume is lost when the container is replaced, with whatever was sent to its address: attach a volume with the mount path $STATE"
  fi
  say "KIT_ALLOW_NO_VOLUME=1: $STATE is not a volume. The keys and the bots' state end with this container."
fi

mkdir -p "$STATE/keys" "$STATE/data" || die "cannot make folders in $STATE"
# Files copied onto the volume from outside (a restored key pair, an API key) often arrive readable
# by everyone, and the kit refuses such a key file. Nobody else uses this container: make them private.
chmod -R go-rwx "$STATE/keys" || die "cannot make $STATE/keys private"
chmod go-rwx "$STATE/data" || die "cannot make $STATE/data private"

# The network was not named, and this volume holds a mainnet bot's keys or state: a variable that
# was lost must not turn a mainnet bot into devnet's examples while its trades wait.
if [ "$NAMED" = 0 ] && [ "${KIT_HOLD:-}" != 1 ]; then
  for sign in "$STATE/market.mainnet.json" "$STATE/keys/mainnet" "$STATE"/data/*/mainnet; do
    if [ -e "$sign" ]; then
      die "the network is not named, and this volume holds a mainnet bot's keys or state ($sign). Set KIT_NETWORK=mainnet to run that bot, or KIT_NETWORK=devnet to run devnet's example bots beside it"
    fi
  done
fi

# The kit's ./<name> is the volume's <name>: start.sh and the example configs use those paths.
link_state() { # <name>
  if [ -L "$KIT_DIR/$1" ]; then
    if [ "$(readlink "$KIT_DIR/$1")" = "$STATE/$1" ]; then
      return 0
    fi
    rm -f "$KIT_DIR/$1"
  elif [ -e "$KIT_DIR/$1" ]; then
    die "$KIT_DIR/$1 is there and is not the volume's. An image holds no keys and no state: take it out of the image (.dockerignore keeps it out of a build), and move what it holds to $STATE/$1"
  fi
  ln -s "$STATE/$1" "$KIT_DIR/$1"
}
link_state keys
link_state data

# ── Locks left by an earlier container ───────────────────────────────────────

# A bot's data folder holds a lock file, {pid, host, ...}, which a bot that is killed leaves behind.
# The kit takes over the lock of a dead process on its own machine, but a new container has a new
# host name: there the kit sees a bot on another machine and refuses to start (STORE_LOCKED) until
# the file is deleted. Where a volume is mounted in one container at a time, and while no Node
# process runs in this one, no bot holds a lock on it, and every lock file there is a leftover.
# Railway mounts a volume that way; elsewhere only who runs the containers knows (KIT_CLEAR_LOCKS).
# KIT_PROC_DIR is for the tests: a folder to read in place of /proc.
PROC=${KIT_PROC_DIR:-/proc}

node_runs() {
  for p in "$PROC"/[0-9]*; do
    exe=$(readlink "$p/exe" 2>/dev/null || :)
    if [ -z "$exe" ] && [ -r "$p/cmdline" ]; then
      # A process whose program cannot be read here (another user's): the name it was started under.
      exe=$(tr '\0' '\n' <"$p/cmdline" 2>/dev/null | head -n 1 || :)
    fi
    case "$exe" in
      node | */node | */node\ *) return 0 ;;
    esac
  done
  return 1
}

# The kit's own lock files on the volume, one to a row: a row of JSON with a host and a nonce.
kit_locks() {
  find "$STATE" -type f -name .lock 2>/dev/null | while IFS= read -r lock; do
    grep -q '"nonce"' "$lock" 2>/dev/null || continue
    grep -q '"host"' "$lock" 2>/dev/null || continue
    printf '%s\n' "$lock"
  done
}

clear_old_locks() {
  clear=${KIT_CLEAR_LOCKS:-}
  if [ -z "$clear" ]; then
    if [ -n "${RAILWAY_VOLUME_MOUNT_PATH:-}" ]; then clear=1; else clear=0; fi
  fi
  case "$clear" in
    0 | 1) ;;
    *) die "KIT_CLEAR_LOCKS is 1 or 0, not \"$clear\"" ;;
  esac
  locks=$(kit_locks)
  [ -n "$locks" ] || return 0
  if [ "$clear" = 0 ]; then
    say "A bot's lock file is on $STATE:"
    printf '%s\n' "$locks" | sed 's/^/  /'
    say "If a bot runs on this volume in another container, leave it. If it is the leftover of a container that is gone, the kit refuses it here all the same (STORE_LOCKED, a bot on another machine): delete it, or start with KIT_CLEAR_LOCKS=1 where this volume is mounted in one container at a time."
    return 0
  fi
  if node_runs; then
    say "A Node process runs in this container already, so the lock files on $STATE are left as they are."
    return 0
  fi
  printf '%s\n' "$locks" | while IFS= read -r lock; do
    if rm -f "$lock"; then
      say "Removed $lock, the lock of a bot that ran in an earlier container. The bot resumes from its saved state."
    fi
  done
}
clear_old_locks

# ── A config's own paths ─────────────────────────────────────────────────────

# A bot's config names its key files and its data folder. They must be the volume's: ./keys/...
# and ./data/... (through the links above) or a path under the volume. A data folder anywhere
# else is on the container's own disk: the bot's offers, trades and swap secrets would end with
# the container, and a start on the empty folder would know nothing of them. Prints why not.
check_config() { # <file> [the network it must be for]
  node -e '
    const fs = require("fs"), path = require("path");
    const [file, kit, state, net] = process.argv.slice(1);
    const no = (why) => { process.stdout.write(why + "\n"); process.exit(1); };
    let c;
    try { c = JSON.parse(fs.readFileSync(file, "utf8")); } catch { no("it is not JSON"); }
    if (!c || typeof c !== "object" || Array.isArray(c)) no("it is not a JSON object");
    if (net && c.network !== net) no("its \"network\" is not \"" + net + "\"");
    const roots = [path.join(kit, "keys"), path.join(kit, "data"), state];
    const kept = (p) => { const r = path.resolve(kit, p); return roots.some((d) => r === d || r.startsWith(d + path.sep)); };
    const named = { "keys.pha": c.keys && c.keys.pha, "keys.base": c.keys && c.keys.base, "dataDir": c.dataDir };
    for (const [key, value] of Object.entries(named)) {
      if (typeof value !== "string" || !value) no("it has no \"" + key + "\"");
      if (!kept(value)) no("its \"" + key + "\" (" + value + ") is not on the volume: use a path under ./keys or ./data, or under " + state);
    }
    if (typeof c.apiKeyFile === "string" && c.apiKeyFile && !kept(c.apiKeyFile)) no("its \"apiKeyFile\" (" + c.apiKeyFile + ") is not on the volume: use a path under ./keys, or under " + state);
  ' "$1" "$KIT_DIR" "$STATE" "${2:-}"
}

# ── Mainnet: the market bot's config, on the volume ──────────────────────────

CONFIG=$STATE/market.mainnet.json

link_config() {
  if [ -L "$KIT_DIR/market.mainnet.json" ] && [ "$(readlink "$KIT_DIR/market.mainnet.json")" = "$CONFIG" ]; then
    return 0
  fi
  ln -sf "$CONFIG" "$KIT_DIR/market.mainnet.json"
}

# KIT_MARKET_CONFIG onto the volume, whole or not at all. Prints why not.
write_market_config() {
  new="$CONFIG.new.$$"
  printf '%s\n' "$KIT_MARKET_CONFIG" >"$new"
  if why=$(check_config "$new" mainnet); then
    mv -f "$new" "$CONFIG"
    return 0
  fi
  rm -f "$new"
  printf '%s\n' "$why"
  return 1
}

# Whether start.sh's command runs the market bot on its default config, market.mainnet.json.
uses_market_config() { # start.sh's words after the network
  case "${1:-demo}" in
    demo | start | run | setup | dry-run | dryrun) return 0 ;;
    market)
      shift
      for a in ${1+"$@"}; do
        case "$a" in
          --help | -h | --config | --config=*) return 1 ;;
        esac
      done
      return 0
      ;;
  esac
  return 1
}

mainnet_config() {
  if [ -L "$KIT_DIR/market.mainnet.json" ]; then
    :
  elif [ -f "$KIT_DIR/market.mainnet.json" ] && cmp -s "$KIT_DIR/market.mainnet.json" "$KIT_DIR/examples/market.mainnet.example.json" 2>/dev/null; then
    # What a first start that was cut short left in this container: the template, which lists nothing.
    rm -f "$KIT_DIR/market.mainnet.json"
  elif [ -e "$KIT_DIR/market.mainnet.json" ]; then
    die "$KIT_DIR/market.mainnet.json is in the image. The market bot's config lives on the volume ($CONFIG) or in KIT_MARKET_CONFIG: take it out of the image"
  fi
  # A config half written by a start that was cut short.
  rm -f "$CONFIG".new.[0-9]*
  if [ ! -e "$CONFIG" ] && [ ! -L "$CONFIG" ]; then
    # The first start on this volume: start.sh's own setup makes the market bot's key pair
    # (in ./keys/mainnet, on the volume) and its config, which lists nothing.
    rm -f "$KIT_DIR/market.mainnet.json"
    sh "$KIT_DIR/start.sh" mainnet setup </dev/null
    [ -f "$KIT_DIR/market.mainnet.json" ] || die "start.sh mainnet setup made no market.mainnet.json"
    # Onto the volume whole or not at all: a copy beside it, then a rename.
    cp "$KIT_DIR/market.mainnet.json" "$CONFIG.new.$$"
    mv -f "$CONFIG.new.$$" "$CONFIG"
    rm -f "$KIT_DIR/market.mainnet.json"
    say ""
    say "In this container the market bot's config is $CONFIG, on the volume. Set it with the KIT_MARKET_CONFIG variable, or put your own file there (docs/RAILWAY.md)."
  fi
  [ -f "$CONFIG" ] || die "$CONFIG is there but is not a file: move it away, then start again"
  if [ -n "${KIT_MARKET_CONFIG:-}" ]; then
    if ! why=$(write_market_config); then
      die "KIT_MARKET_CONFIG cannot be the market bot's config: $why. The config on the volume was left as it was, and no bot was started. Paste the whole config, from its first { to its last }: examples/market.mainnet.example.json is the template, with its keys and dataDir as they are"
    fi
    say "Wrote the market bot's config, $CONFIG, from KIT_MARKET_CONFIG."
  fi
  if ! why=$(check_config "$CONFIG" mainnet); then
    die "the market bot's config, $CONFIG, cannot be used here: $why. No bot was started"
  fi
  link_config
}

# ── Hold: no bot, for a shell ────────────────────────────────────────────────

if [ "${KIT_HOLD:-}" = 1 ]; then
  say "KIT_HOLD=1: no bot is started, and none sends a lock, a claim or a refund while it is set. The container keeps running, so that you can open a shell in it (on Railway: railway ssh)."
  say "The kit is in $KIT_DIR, its keys in $STATE/keys and the bots' state in $STATE/data. Remove KIT_HOLD and deploy again to start the bots."
  # The config a dry run typed in that shell reads is the one the next start will run.
  if [ "$NET" = mainnet ] && [ -n "${KIT_MARKET_CONFIG:-}" ]; then
    if why=$(write_market_config); then
      say "Wrote the market bot's config, $CONFIG, from KIT_MARKET_CONFIG."
    else
      say "KIT_MARKET_CONFIG cannot be the market bot's config: $why. The config on the volume was left as it was."
    fi
  fi
  if [ -f "$CONFIG" ]; then
    if [ -L "$KIT_DIR/market.mainnet.json" ] || [ ! -e "$KIT_DIR/market.mainnet.json" ]; then
      link_config
    fi
  elif [ "$NET" = mainnet ]; then
    say "There is no market.mainnet.json on the volume yet. One made in this shell (sh start.sh mainnet setup) stays in this container: a start without KIT_HOLD makes it on the volume."
  fi
  # A sleep in the background, so that a SIGTERM ends the wait at once: it takes the sleep with it.
  nap=''
  trap 'kill "$nap" 2>/dev/null || :; exit 0' TERM INT
  while :; do
    sleep 3600 &
    nap=$!
    wait "$nap" || :
  done
fi

if [ "$VOLUME" = 1 ]; then
  say "Saturn P2P bot kit in a container: $NET, with its keys and state on the volume at $STATE."
else
  say "Saturn P2P bot kit in a container: $NET, with its keys and state in this container only ($STATE)."
fi

if [ "$NET" = mainnet ]; then
  if uses_market_config ${1+"$@"}; then
    mainnet_config
  elif [ -n "${KIT_MARKET_CONFIG:-}" ]; then
    say "KIT_MARKET_CONFIG is not used: this command does not run the market bot on market.mainnet.json."
  fi
fi

# A config the command itself names (seller --config <file>, market --config <file>): its paths too.
named_config=''
next=''
for a in ${1+"$@"}; do
  if [ "$next" = config ]; then
    named_config=$a
    next=''
    continue
  fi
  case "$a" in
    --config) next=config ;;
    --config=*) named_config=${a#--config=} ;;
  esac
done
if [ -n "$named_config" ] && [ -f "$named_config" ]; then
  if ! why=$(check_config "$named_config"); then
    die "the config $named_config cannot be used here: $why. No bot was started"
  fi
fi

# ── A start right after the last one ─────────────────────────────────────────

# A start fails where a running bot would have carried on: the preflight needs the board and both
# chains to answer. The platform starts a container that stopped on an error again, ten times on
# Railway, and then no more. So a start that comes within half a minute of the last one waits
# first, longer each time (5 s, then 10, 20, 40, 80, 160, and 300 from then on): those ten starts
# then last about 25 minutes and not seconds, and an outage that long passes. A start after a run
# of half a minute or more waits for nothing. (A recurring order of the config is still sent at
# every one of those starts.)
STAMP=$STATE/.last-start

# A count this shell can reckon with: digits, no leading zero, not too long.
is_count() {
  case "$1" in
    '' | *[!0-9]* | 0?* | ?????????????*) return 1 ;;
  esac
  return 0
}

wait_if_restarting() {
  now=$(date +%s 2>/dev/null || :)
  is_count "$now" || return 0
  last=''
  row=''
  if [ -f "$STAMP" ]; then
    read -r last row <"$STAMP" 2>/dev/null || :
  fi
  is_count "$last" || last=0
  is_count "$row" || row=0
  if [ "$last" -gt 0 ] && [ "$now" -ge "$last" ] && [ $((now - last)) -lt 30 ]; then
    row=$((row + 1))
    case "$row" in
      1) pause=5 ;;
      2) pause=10 ;;
      3) pause=20 ;;
      4) pause=40 ;;
      5) pause=80 ;;
      6) pause=160 ;;
      *) pause=300 ;;
    esac
    say "The last start was $((now - last)) s ago (start $((row + 1)) in a row): waiting $pause s before this one."
    sleep "$pause"
    now=$(date +%s 2>/dev/null || :)
    is_count "$now" || return 0
  else
    row=0
  fi
  # Best effort: a start never fails for this mark.
  if printf '%s %s\n' "$now" "$row" >"$STAMP.new.$$" 2>/dev/null; then
    mv -f "$STAMP.new.$$" "$STAMP" 2>/dev/null || rm -f "$STAMP.new.$$"
  fi
}
wait_if_restarting

# ── start.sh ─────────────────────────────────────────────────────────────────

# No terminal on its input: start.sh then asks nothing, and on mainnet it starts the market bot
# only with KIT_ALLOW_MAINNET=1. exec: a SIGTERM to this process reaches start.sh and the bots.
exec sh "$KIT_DIR/start.sh" "$NET" ${1+"$@"} </dev/null
