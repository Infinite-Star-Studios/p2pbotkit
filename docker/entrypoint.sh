#!/bin/sh
# Saturn P2P bot kit in a container (Railway, or any Docker host): put the keys and the bots' state
# on a volume, then run start.sh. docs/RAILWAY.md says how to set it up.
#
# A container is replaced at every deploy, and only its volume stays. So this script:
#   1. refuses to start when its state folder is not a volume (a key made there would be lost);
#   2. links the kit's ./keys, ./data and ./market.mainnet.json to the volume;
#   3. removes the lock files that a bot in an earlier container left on the volume, which the kit
#      would otherwise take for a bot on another machine and refuse to start;
#   4. runs "sh start.sh <network> ..." with no terminal on its input.
#
# From the environment:
#   KIT_NETWORK          devnet (the default) or mainnet
#   KIT_START_ARGS       what follows the network on start.sh's command line, when the container's own
#                        command gives nothing: dry-run, setup, seller, buyer, faucet, ...
#   KIT_MARKET_CONFIG    mainnet: the market bot's config, as JSON text. Written to market.mainnet.json on
#                        the volume at each start. Without it, the file on the volume is used as it is
#   KIT_ALLOW_MAINNET    1: start.sh's own switch for a mainnet start that nobody can answer yes to
#   KIT_HOLD             1: start no bot; keep the container running, to open a shell in it
#   KIT_STATE_DIR        the volume's folder (default: RAILWAY_VOLUME_MOUNT_PATH on Railway, else /data)
#   KIT_ALLOW_NO_VOLUME  1: run although the state folder is not a volume (for a dry run only)
#   KIT_KEEP_LOCKS       1: leave every lock file as it is
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

# The device a path is on (GNU and BusyBox stat, then BSD's).
dev_of() { stat -c %d "$1" 2>/dev/null || stat -f %d "$1" 2>/dev/null || :; }

# True when the state folder is a mount of its own, on another device than the container's own
# disk: that disk ends with the container. The folder is looked at, not what the platform says
# about it, so a volume that is attached but not mounted here is not taken for one.
on_volume() {
  [ -d "$STATE" ] || return 1
  here=$(dev_of "$STATE")
  root=$(dev_of /)
  [ -n "$here" ] && [ -n "$root" ] && [ "$here" != "$root" ]
}

if ! on_volume; then
  if [ "${KIT_ALLOW_NO_VOLUME:-}" = 1 ]; then
    say "KIT_ALLOW_NO_VOLUME=1: $STATE is not a volume. The keys and the bots' state end with this container: for a dry run only, never with funds."
  else
    die "$STATE is not a volume: it is on the container's own disk, which ends with the container. The keys made here and the state of every running trade would be lost when the container is replaced (on Railway: at the next deploy), and with the keys whatever their addresses hold. Attach a volume with the mount path $STATE (on Railway: right-click the service, Attach Volume), then start again. For a dry run without one, set KIT_ALLOW_NO_VOLUME=1"
  fi
fi

mkdir -p "$STATE/keys" "$STATE/data" || die "cannot make folders in $STATE"
# Files copied onto the volume from outside (a restored key pair, an API key) often arrive readable
# by everyone, and the kit refuses such a key file. Nobody else uses this container: make them private.
chmod -R go-rwx "$STATE/keys" || die "cannot make $STATE/keys private"
chmod go-rwx "$STATE/data" || die "cannot make $STATE/data private"

# The kit's ./<name> is the volume's <name>: start.sh and the example configs use those paths.
link_state() { # <name>
  if [ -L "$KIT_DIR/$1" ]; then
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
# the file is deleted. A volume is mounted in one container at a time, so while no Node process
# runs in this one, no bot holds a lock on it, and every lock file there is a leftover.
# KIT_PROC_DIR is for the tests: a folder to read in place of /proc.
PROC=${KIT_PROC_DIR:-/proc}

node_runs() {
  for p in "$PROC"/[0-9]*; do
    case "$(readlink "$p/exe" 2>/dev/null || :)" in
      */node | */node\ *) return 0 ;;
    esac
  done
  return 1
}

clear_old_locks() {
  if [ "${KIT_KEEP_LOCKS:-}" = 1 ]; then
    return 0
  fi
  if node_runs; then
    say "A Node process runs in this container already, so the lock files on $STATE are left as they are."
    return 0
  fi
  find "$STATE" -type f -name .lock 2>/dev/null | while IFS= read -r lock; do
    # Only the kit's own lock files: one line of JSON with a pid, a host and a nonce.
    grep -q '"nonce"' "$lock" 2>/dev/null || continue
    grep -q '"host"' "$lock" 2>/dev/null || continue
    if rm -f "$lock"; then
      say "Removed $lock, the lock of a bot that ran in an earlier container. The bot resumes from its saved state."
    fi
  done
}
clear_old_locks

# ── Hold: no bot, for a shell ────────────────────────────────────────────────

if [ "${KIT_HOLD:-}" = 1 ]; then
  # The market bot's config, when the volume has one: for a dry run or prune.ts typed in that shell.
  if [ -f "$STATE/market.mainnet.json" ] && { [ -L "$KIT_DIR/market.mainnet.json" ] || [ ! -e "$KIT_DIR/market.mainnet.json" ]; }; then
    ln -sf "$STATE/market.mainnet.json" "$KIT_DIR/market.mainnet.json"
  fi
  say "KIT_HOLD=1: no bot is started. The container keeps running, so that you can open a shell in it (on Railway: railway ssh)."
  say "The kit is in $KIT_DIR, its keys in $STATE/keys and the bots' state in $STATE/data. Remove KIT_HOLD and deploy again to start the bots."
  # A sleep in the background, so that a SIGTERM ends the wait at once: it takes the sleep with it.
  nap=''
  trap 'kill "$nap" 2>/dev/null || :; exit 0' TERM INT
  while :; do
    sleep 3600 &
    nap=$!
    wait "$nap" || :
  done
fi

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
if [ -z "$NET" ]; then
  # As start.sh has it: the market bot is mainnet's, and without a terminal everything else is devnet's.
  case "${1:-}" in
    market) NET=mainnet ;;
    *) NET=devnet ;;
  esac
fi

say "Saturn P2P bot kit in a container: $NET, with its keys and state on the volume at $STATE."

# ── Mainnet: the market bot's config, on the volume ──────────────────────────

CONFIG=$STATE/market.mainnet.json

mainnet_config() {
  if [ -L "$KIT_DIR/market.mainnet.json" ]; then
    rm -f "$KIT_DIR/market.mainnet.json"
  elif [ -e "$KIT_DIR/market.mainnet.json" ]; then
    die "$KIT_DIR/market.mainnet.json is in the image. The market bot's config lives on the volume ($CONFIG) or in KIT_MARKET_CONFIG: take it out of the image"
  fi
  if [ ! -e "$CONFIG" ] && [ ! -L "$CONFIG" ]; then
    # The first start on this volume: start.sh's own setup makes the market bot's key pair
    # (in ./keys/mainnet, on the volume) and its config, which lists nothing.
    sh "$KIT_DIR/start.sh" mainnet setup </dev/null
    [ -f "$KIT_DIR/market.mainnet.json" ] || die "start.sh mainnet setup made no market.mainnet.json"
    mv "$KIT_DIR/market.mainnet.json" "$CONFIG"
    say ""
    say "In this container the market bot's config is $CONFIG, on the volume. Set it with the KIT_MARKET_CONFIG variable, or put your own file there (docs/RAILWAY.md)."
  fi
  [ -f "$CONFIG" ] || die "$CONFIG is there but is not a file: move it away, then start again"
  if [ -n "${KIT_MARKET_CONFIG:-}" ]; then
    new="$CONFIG.new.$$"
    printf '%s\n' "$KIT_MARKET_CONFIG" >"$new"
    if ! node -e 'const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (!c || typeof c !== "object" || Array.isArray(c)) process.exit(1);' "$new" 2>/dev/null; then
      rm -f "$new"
      die "KIT_MARKET_CONFIG is not a JSON object, so the market bot's config was left as it was. Paste the whole config, from its first { to its last } (examples/market.mainnet.example.json is the template)"
    fi
    mv -f "$new" "$CONFIG"
    say "Wrote the market bot's config, $CONFIG, from KIT_MARKET_CONFIG."
  fi
  ln -s "$CONFIG" "$KIT_DIR/market.mainnet.json"
}

if [ "$NET" = mainnet ]; then
  case "${1:-}" in
    help | -h | --help) ;;
    *) mainnet_config ;;
  esac
fi

# ── start.sh ─────────────────────────────────────────────────────────────────

# No terminal on its input: start.sh then asks nothing, and on mainnet it starts the market bot
# only with KIT_ALLOW_MAINNET=1. exec: a SIGTERM to this process reaches start.sh and the bots.
exec sh "$KIT_DIR/start.sh" "$NET" ${1+"$@"} </dev/null
