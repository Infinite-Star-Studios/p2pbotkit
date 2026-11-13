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
#   4. waits before a start that follows the last one within minutes (a bot that keeps failing);
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
#   KIT_ALLOW_MAINNET    1: start.sh's own switch for a mainnet start that nobody can answer yes to.
#                        While it is set, this script makes no key pair: a start that would have to
#                        (no config on the volume, and not both of the market bot's key files) is
#                        refused
#   KIT_HOLD             1: start no bot; keep the container running, to open a shell in it
#   KIT_PROBE            1: start no bot; say whether another container writes to this volume while
#                        this one runs, then write there every second until the platform kills this
#                        one. Two deploys with it show whether the platform runs two containers on
#                        the volume at a time
#   KIT_STATE_DIR        the volume's folder (default: RAILWAY_VOLUME_MOUNT_PATH on Railway, else /data)
#   KIT_CLEAR_LOCKS      1: remove every lock file a bot that is gone left on the volume; 0: leave them
#                        all. Not set: all of them on Railway, which mounts a volume in one container at
#                        a time; elsewhere only those this same container left
#   KIT_ALLOW_NO_VOLUME  1: run devnet's example bots although the state folder is not a volume
#   KIT_STORE_KEY_FILE   the bots' own, the key that seals their state: refused when it is not on
#                        the volume
# start.sh and the bots read their own (KIT_SKIP_FAUCET, ...).
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

# A count this shell can reckon with: digits, no leading zero, not too long.
is_count() {
  case "$1" in
    '' | *[!0-9]* | 0?* | ?????????????*) return 1 ;;
  esac
  return 0
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

# The config the command's options name, as start.sh and the bots read them: the last --config,
# and '' when there is none or it is empty.
NAMED_CONFIG=''
next=''
for a in ${1+"$@"}; do
  if [ "$next" = config ]; then
    NAMED_CONFIG=$a
    next=''
    continue
  fi
  case "$a" in
    --config) next=config ;;
    --config=*) NAMED_CONFIG=${a#--config=} ;;
  esac
done

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

# ── Probe: two containers on this volume at a time? ──────────────────────────

# The lock handling below takes a lock file for a leftover because the platform mounts the volume
# in one container at a time. KIT_PROBE=1 lets its owner see that: this container first looks,
# second by second, whether the probe before it still writes its mark, and says so. Then it
# writes the mark itself, once a second, and goes on after a SIGTERM, as a bot that is finishing
# a trade does: only the platform's kill ends it. So the second of two deploys in a row says
# whether the first one's container was still there, for as long as the platform lets a
# container run after its SIGTERM.
if [ "${KIT_PROBE:-}" = 1 ]; then
  [ "$VOLUME" = 1 ] || die "KIT_PROBE=1 looks at a volume, and $STATE is not one"
  MARK=$STATE/.probe
  say "KIT_PROBE=1: no bot is started. This container looks whether another one writes to the volume at $STATE, then writes there once a second itself, also after a SIGTERM, until the platform ends it. Deploy once more while it runs: the first rows of that deploy say whether the two containers ran at once. Then remove KIT_PROBE."
  began=$(date +%s 2>/dev/null || :)
  seen=$(cat "$MARK" 2>/dev/null || :)
  if [ -z "$seen" ]; then
    say "No probe has written to this volume before, so there is nothing to compare with yet."
  else
    # A probe that runs writes every second. Three seconds without a new mark: it is gone.
    looks=0
    last=0
    quiet=0
    while [ "$quiet" -lt 3 ] && [ "$looks" -lt 900 ]; do
      sleep 1 || :
      looks=$((looks + 1))
      mark=$(cat "$MARK" 2>/dev/null || :)
      if [ "$mark" != "$seen" ]; then
        [ "$last" != 0 ] || say "Another container (${mark%% *}) is writing to this volume now: looking until it stops."
        seen=$mark
        last=$looks
        quiet=0
      else
        quiet=$((quiet + 1))
      fi
    done
    if [ "$last" = 0 ]; then
      # A mark is "<host> <time> <count>": how long the volume was without a container.
      wrote=${seen#* }
      wrote=${wrote%% *}
      if is_count "$began" && is_count "$wrote" && [ "$began" -ge "$wrote" ]; then
        say "ONE CONTAINER AT A TIME: the probe before this one (${seen%% *}) wrote its last mark $((began - wrote)) s before this container started, and none since."
      else
        say "ONE CONTAINER AT A TIME: the probe before this one (${seen%% *}) had stopped writing when this container started."
      fi
    elif [ "$quiet" -lt 3 ]; then
      say "TWO CONTAINERS AT ONCE: another container (${seen%% *}) is still writing to this volume, $looks s after this one started. On this platform a bot that is replaced can run beside its successor: set KIT_CLEAR_LOCKS=0 (docs/RAILWAY.md)."
    else
      say "TWO CONTAINERS AT ONCE: another container (${seen%% *}) went on writing to this volume for $last s after this one had started. On this platform a bot that is replaced can run beside its successor for that long: set KIT_CLEAR_LOCKS=0 (docs/RAILWAY.md)."
    fi
  fi
  here=$(uname -n 2>/dev/null || :)
  trap 'say "SIGTERM: this container goes on writing, as a bot that is finishing a trade would, until the platform ends it."' TERM
  trap 'exit 0' INT
  beat=0
  while :; do
    beat=$((beat + 1))
    if printf '%s %s %s\n' "${here:-this-container}" "$(date +%s 2>/dev/null || :)" "$beat" >"$MARK.new" 2>/dev/null; then
      mv -f "$MARK.new" "$MARK" 2>/dev/null || :
    fi
    [ "$beat" != 1 ] || say "Writing to $MARK once a second now."
    sleep 1 || :
  done
fi

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
# A lock that names this container's own host is a leftover anywhere while no Node process runs
# here: the kit would take it over itself, unless another process now has the old bot's id, which
# among a container's few process ids is common.
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

# The host a lock file names.
lock_host() { sed -n 's/.*"host":"\([^"]*\)".*/\1/p' "$1" 2>/dev/null | head -n 1; }

clear_old_locks() {
  case "${KIT_CLEAR_LOCKS:-}" in
    1) clear=all ;;
    0) clear=none ;;
    '') if [ -n "${RAILWAY_VOLUME_MOUNT_PATH:-}" ]; then clear=all; else clear=own; fi ;;
    *) die "KIT_CLEAR_LOCKS is 1 or 0, not \"$KIT_CLEAR_LOCKS\"" ;;
  esac
  locks=$(kit_locks)
  [ -n "$locks" ] || return 0
  if [ "$clear" != none ] && node_runs; then
    say "A Node process runs in this container already, so the lock files on $STATE are left as they are."
    return 0
  fi
  here=$(uname -n 2>/dev/null || :)
  left=''
  # No pipe into this loop: it fills $left for the rows after it.
  while IFS= read -r lock; do
    [ -n "$lock" ] || continue
    if [ "$clear" = all ] || { [ "$clear" = own ] && [ -n "$here" ] && [ "$(lock_host "$lock")" = "$here" ]; }; then
      if rm -f "$lock"; then
        say "Removed $lock, the leftover lock of a bot that is gone. The bot resumes from its saved state."
      fi
    else
      left="$left  $lock
"
    fi
  done <<LOCKS
$locks
LOCKS
  if [ -n "$left" ]; then
    say "A bot's lock file is on $STATE:"
    printf '%s' "$left"
    say "If a bot runs on this volume in another container, leave it. If it is the leftover of a container that is gone, the kit refuses it here all the same (STORE_LOCKED, a bot on another machine): delete it, or start with KIT_CLEAR_LOCKS=1 where this volume is mounted in one container at a time."
  fi
}
clear_old_locks

# ── A config's own paths ─────────────────────────────────────────────────────

# A bot's config names its key files and its data folder. They must be the volume's: ./keys/...
# and ./data/... (through the links above) or a path under the volume, wherever a link on the way
# leads. A data folder anywhere else is on the container's own disk: the bot's offers, trades and
# swap secrets would end with the container, and a start on the empty folder would know nothing
# of them. One helper, three questions:
#   on_volume_check config <file> [network]  the config's paths (and its network); prints why not
#   on_volume_check path <path>              one path
#   on_volume_check data-dir <file>          prints where the config's data folder really is
#   on_volume_check keys-there <file>        true when both key files the config names are there
on_volume_check() {
  node -e '
    const fs = require("fs"), path = require("path");
    const [ask, arg, kit, state, net] = process.argv.slice(1);
    const no = (why) => { process.stdout.write(why + "\n"); process.exit(1); };
    // Where a path really is: its nearest folder that exists, links followed, then the rest as written.
    const real = (p) => {
      let at = path.resolve(kit, p);
      const rest = [];
      for (;;) {
        try { return path.join(fs.realpathSync(at), ...rest); } catch { /* not there yet */ }
        const up = path.dirname(at);
        if (up === at) return path.join(at, ...rest);
        rest.unshift(path.basename(at));
        at = up;
      }
    };
    const volume = real(state);
    const kept = (p) => { const r = real(p); return r === volume || r.startsWith(volume + path.sep); };
    if (ask === "path") process.exit(kept(arg) ? 0 : 1);
    let c;
    try { c = JSON.parse(fs.readFileSync(arg, "utf8")); } catch { no("it is not JSON"); }
    if (!c || typeof c !== "object" || Array.isArray(c)) no("it is not a JSON object");
    if (ask === "data-dir") { if (typeof c.dataDir === "string" && c.dataDir) process.stdout.write(real(c.dataDir) + "\n"); process.exit(0); }
    if (ask === "keys-there") process.exit(["pha", "base"].every((k) => { try { return fs.statSync(path.resolve(kit, c.keys[k])).isFile(); } catch { return false; } }) ? 0 : 1);
    if (net && c.network !== net) no("its \"network\" is not \"" + net + "\"");
    const named = { "keys.pha": c.keys && c.keys.pha, "keys.base": c.keys && c.keys.base, "dataDir": c.dataDir };
    for (const [key, value] of Object.entries(named)) {
      if (typeof value !== "string" || !value) no("it has no \"" + key + "\"");
      if (!kept(value)) no("its \"" + key + "\" (" + value + ") is not on the volume: use a path under ./keys or ./data, or under " + state);
    }
    if (typeof c.apiKeyFile === "string" && c.apiKeyFile && !kept(c.apiKeyFile)) no("its \"apiKeyFile\" (" + c.apiKeyFile + ") is not on the volume: use a path under ./keys, or under " + state);
  ' "$1" "$2" "$KIT_DIR" "$STATE" "${3:-}"
}
check_config() { on_volume_check config "$1" "${2:-}"; }

# The key that seals a bot's state (README, "Encrypting the store") must outlive the container too:
# without it a sealed state cannot be read again.
if [ -n "${KIT_STORE_KEY_FILE:-}" ] && ! on_volume_check path "$KIT_STORE_KEY_FILE"; then
  die "KIT_STORE_KEY_FILE ($KIT_STORE_KEY_FILE) is not on the volume: the key that seals a bot's state would end with this container, and that state could not be read again. Keep it under $STATE, for example $STATE/keys/store.key"
fi

# ── Mainnet: the market bot's config, on the volume ──────────────────────────

CONFIG=$STATE/market.mainnet.json

link_config() {
  if [ -L "$KIT_DIR/market.mainnet.json" ] && [ "$(readlink "$KIT_DIR/market.mainnet.json")" = "$CONFIG" ]; then
    return 0
  fi
  ln -sf "$CONFIG" "$KIT_DIR/market.mainnet.json"
}

# A bot's saved state for mainnet is <data folder>/mainnet, with something in it.
has_store() { [ -d "$1/mainnet" ] && [ -n "$(find "$1/mainnet" -mindepth 1 -maxdepth 1 2>/dev/null | head -n 1)" ]; }

# The data folders on the volume that hold one, wherever they are (the keys' folder apart), one to
# a row, as they really are (links followed).
mainnet_stores() {
  find "$STATE" -type d -name mainnet 2>/dev/null | while IFS= read -r store; do
    case "$store" in
      "$STATE"/keys | "$STATE"/keys/*) continue ;;
    esac
    folder=$(CDPATH='' cd -- "$store/.." 2>/dev/null && pwd -P) || continue
    if has_store "$folder"; then
      printf '%s\n' "$folder"
    fi
  done
}

# KIT_MARKET_CONFIG onto the volume, whole or not at all. Prints why not.
#   write_market_config ''      over the config on the volume, whose data folder counts
#   write_market_config first   the volume had no config when this start began
# With a second word, check: only say whether it would be written.
write_market_config() {
  new="$CONFIG.new.$$"
  if ! printf '%s\n' "$KIT_MARKET_CONFIG" >"$new" 2>/dev/null; then
    rm -f "$new"
    printf 'it could not be written to %s (is the volume full?)\n' "$STATE"
    return 1
  fi
  if why=$(check_config "$new" mainnet); then
    # start.sh and the bot look for open offers and trades in the data folder their config names,
    # and nowhere else. A config that names another one leaves those of the old folder unseen and
    # unfinished, and start.sh would call the bot idle. Not through a variable, then.
    wants=$(on_volume_check data-dir "$new" 2>/dev/null) || wants=''
    was=''
    if [ "${1:-}" != first ]; then
      was=$(on_volume_check data-dir "$CONFIG" 2>/dev/null) || was=''
    fi
    other=''
    if [ -z "$was" ] && [ -n "$wants" ] && ! has_store "$wants"; then
      # No config to compare with (the volume had none, or it cannot be read): the saved states
      # themselves. One in a folder this config does not name is not looked at by this bot.
      other=$(mainnet_stores | head -n 1)
    fi
    if [ -n "$was" ] && [ "$was" != "$wants" ] && has_store "$was"; then
      why="its \"dataDir\" is $wants, and the config it replaces has $was, which holds a market bot's saved state: offers and trades that are still open there would not be looked at, and not finished. Keep the \"dataDir\" as it is. To move the bot to another data folder on purpose, put the config on the volume as a file and remove KIT_MARKET_CONFIG"
    elif [ -n "$other" ]; then
      why="its \"dataDir\" is $wants, which holds no saved state, while $other on this volume holds a mainnet bot's: offers and trades that are still open there would not be looked at, and not finished. Name that folder as the \"dataDir\". To start in a new data folder on purpose, put the config on the volume as a file and remove KIT_MARKET_CONFIG"
    elif [ "${2:-}" = check ]; then
      rm -f "$new"
      return 0
    elif mv -f "$new" "$CONFIG" 2>/dev/null; then
      return 0
    else
      why="it could not be put in the place of $CONFIG"
    fi
  fi
  rm -f "$new"
  printf '%s\n' "${why:-it could not be checked (is Node there?)}"
  return 1
}

# True when KIT_MARKET_CONFIG is a whole config and both key files it names are on the volume.
variable_has_its_keys() {
  asked="$CONFIG.new.$$"
  there=1
  if printf '%s\n' "$KIT_MARKET_CONFIG" >"$asked" 2>/dev/null; then
    if check_config "$asked" mainnet >/dev/null 2>&1 && on_volume_check keys-there "$asked" >/dev/null 2>&1; then
      there=0
    fi
  fi
  rm -f "$asked"
  return "$there"
}

# Whether start.sh's command runs the market bot on its default config, market.mainnet.json:
# the market bot with no --config (or an empty one, or that very file), and not its help.
uses_market_config() { # start.sh's words after the network
  case "${1:-demo}" in
    demo | start | run | setup | dry-run | dryrun) return 0 ;;
    market)
      for a in "$@"; do
        case "$a" in
          --help | -h) return 1 ;;
        esac
      done
      case "$NAMED_CONFIG" in
        '' | market.mainnet.json | ./market.mainnet.json | "$KIT_DIR/market.mainnet.json" | "$CONFIG") return 0 ;;
      esac
      return 1
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
  first=''
  if [ ! -e "$CONFIG" ] && [ ! -L "$CONFIG" ]; then
    first=first
  elif [ ! -f "$CONFIG" ]; then
    die "$CONFIG is there but is not a file: move it away, then start again"
  fi
  refused="The config on the volume was left as it was, and no bot was started. Paste the whole config, from its first { to its last }: examples/market.mainnet.example.json is the template, with its keys and dataDir as they are"
  if [ -n "${KIT_MARKET_CONFIG:-}" ]; then
    # Before anything is made: a variable that cannot be the config stops the start here, with
    # the volume as it was.
    if ! why=$(write_market_config "$first" check); then
      die "KIT_MARKET_CONFIG cannot be the market bot's config: $why. $refused"
    fi
  fi
  if [ -n "$first" ]; then
    # The volume has no config: a new bot's first start, or the start of a bot that came here
    # with its keys and its state.
    if [ -n "${KIT_MARKET_CONFIG:-}" ] && variable_has_its_keys; then
      # The variable is a whole config, and both key files it names are on the volume: nothing
      # has to be made, and it becomes the volume's config below.
      :
    else
      # start.sh's own setup makes the market bot's key pair, keys/mainnet/market-pha.json and
      # market-base.json on the volume, unless both are there, and its config, which lists
      # nothing. Never while the yes is given: a yes was not given to a key pair that did not
      # exist yet. The volume was replaced or wiped, or the service was copied, variables and
      # all; the bot's own keys, with their funds and its open trades, are not here.
      if [ "${KIT_ALLOW_MAINNET:-}" = 1 ] && { [ ! -f "$STATE/keys/mainnet/market-pha.json" ] || [ ! -f "$STATE/keys/mainnet/market-base.json" ]; }; then
        die "this volume has no market.mainnet.json and no market bot's key pair ($STATE/keys/mainnet/market-pha.json and market-base.json), and KIT_ALLOW_MAINNET=1 is set already: this start would make a new key pair, and none is made while the yes is given. If this bot has run before, its keys are not here: attach the volume that holds them, or put its key files here (docs/RAILWAY.md, \"One service, one volume, one bot\"). For a new bot, remove KIT_ALLOW_MAINNET until the first start has made the key pair and you have seen a dry run. No key was made"
      fi
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
  fi
  if [ -n "${KIT_MARKET_CONFIG:-}" ]; then
    if ! why=$(write_market_config "$first"); then
      die "KIT_MARKET_CONFIG cannot be the market bot's config: $why. $refused"
    fi
    say "Wrote the market bot's config, $CONFIG, from KIT_MARKET_CONFIG."
  fi
  [ -f "$CONFIG" ] || die "there is no $CONFIG to run the market bot on"
  if ! why=$(check_config "$CONFIG" mainnet); then
    die "the market bot's config, $CONFIG, cannot be used here: $why. No bot was started"
  fi
  link_config
  # start.sh looks for open offers and trades in the data folder this config names, and nowhere else.
  used=$(on_volume_check data-dir "$CONFIG" || :)
  mainnet_stores | while IFS= read -r folder; do
    if [ -n "$used" ] && [ "$folder" != "$used" ]; then
      say "Note: $folder holds a mainnet bot's state, and this config's dataDir is another folder. Offers and trades still open there are not looked at, and not finished, by this start."
    fi
  done
}

# ── Hold: no bot, for a shell ────────────────────────────────────────────────

if [ "${KIT_HOLD:-}" = 1 ]; then
  say "KIT_HOLD=1: no bot is started, and none sends a lock, a claim or a refund while it is set. The container keeps running, so that you can open a shell in it (on Railway: railway ssh)."
  say "The kit is in $KIT_DIR, its keys in $STATE/keys and the bots' state in $STATE/data. Remove KIT_HOLD and deploy again to start the bots."
  # The config a dry run typed in that shell reads is the one the next start will run. Only onto a
  # volume that has had its first start: that start makes the market bot's key pair, and only while
  # there is no config.
  if [ -n "${KIT_MARKET_CONFIG:-}" ]; then
    if [ "$NET" != mainnet ]; then
      say "KIT_MARKET_CONFIG is not written: the network is not mainnet (KIT_NETWORK)."
    elif [ ! -f "$CONFIG" ]; then
      say "KIT_MARKET_CONFIG is not written yet: this volume has no market.mainnet.json of a first start."
    elif why=$(write_market_config ''); then
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
    say "There is no market.mainnet.json on the volume yet. A start without KIT_HOLD makes it, and the market bot's key pair with it, though not while KIT_ALLOW_MAINNET=1 is set: no key pair is made under a yes. A key pair made in this shell (sh start.sh mainnet setup) is on the volume, and the config that command writes stays in this container."
  fi
  # A sleep in the background, so that a SIGTERM ends the wait at once and takes the sleep with
  # it. Short naps: a sleep that the signal missed (it came while the sleep was being started)
  # ends by itself soon after.
  nap=''
  trap 'kill "$nap" 2>/dev/null || :; exit 0' TERM INT
  while :; do
    sleep 15 &
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
  else
    if [ -n "${KIT_MARKET_CONFIG:-}" ]; then
      say "KIT_MARKET_CONFIG is not used: this command does not run the market bot on market.mainnet.json."
    fi
    # The volume's config is still where the kit's folder has it, for whatever names it.
    if [ -f "$CONFIG" ] && { [ -L "$KIT_DIR/market.mainnet.json" ] || [ ! -e "$KIT_DIR/market.mainnet.json" ]; }; then
      link_config
    fi
  fi
fi

# A config the command itself names (seller --config <file>, market --config <file>): its paths too.
if [ -n "$NAMED_CONFIG" ] && [ -f "$NAMED_CONFIG" ]; then
  if ! why=$(check_config "$NAMED_CONFIG"); then
    die "the config $NAMED_CONFIG cannot be used here: $why. No bot was started"
  fi
fi

# ── A start right after the last one ─────────────────────────────────────────

# A start fails where a running bot would have carried on: the preflight needs the board and both
# chains to answer. The platform starts a container that stopped on an error again, ten times on
# Railway, and then no more. So a start that comes within five minutes of the last one waits
# first, longer each time (5 s, then 10, 20, 40, 80, 160, and 300 from then on): those ten starts
# then last 25 minutes or more and not seconds, and an outage that long passes. Five minutes, so
# that a start which takes long to fail (an RPC that accepts and does not answer) counts as well.
# A start after a run of five minutes or more waits for nothing. (A recurring order of the config
# is still sent at every one of those starts.)
STAMP=$STATE/.last-start

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
  if [ "$last" -gt 0 ] && [ "$now" -ge "$last" ] && [ $((now - last)) -lt 300 ]; then
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
