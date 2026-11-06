#!/bin/sh
# Saturn P2P bot kit: run it with one command, on devnet or on mainnet.
#
#   sh start.sh             ask where to run: devnet (test tokens) or mainnet (real funds)
#   sh start.sh devnet      set up, then run the example seller and buyer bots together
#   sh start.sh mainnet     set up your market bot, show a dry run, then start it once you type yes
#
# On devnet:
#   sh start.sh seller      set up, then run only the seller bot (more options go to the bot)
#   sh start.sh buyer       set up, then run only the buyer bot
#   sh start.sh faucet      ask the devnet faucet for test tokens for both bots again
# On mainnet:
#   sh start.sh market      the market bot (more options go to the bot)
# After the network's name, or alone (then it asks):
#   sh start.sh dry-run     set up, then show what the bots would do; sends nothing
#   sh start.sh setup       only set up: Node, the packages, the keys, and the first test
#                           tokens on devnet or the market bot's config on mainnet
#   sh start.sh help        this text
#
# Devnet is test tokens, no real money; mainnet is real funds, and a bot
# starts there only once you type yes (or with KIT_ALLOW_MAINNET=1 already
# set). The keys are made on this machine, stay in ./keys (mainnet's in
# ./keys/mainnet, mode 0600) and are never sent anywhere. README.md says what
# each step does.
#
# MIT License (LICENSE): the kit comes as is, without warranty of any kind,
# and you use it at your own risk.

set -eu
umask 077

# The Node this script downloads into ./.node when the machine has no Node 22 or later.
KIT_NODE_VERSION=22.23.4

say() { printf '%s\n' "$*"; }
die() {
  printf 'start.sh: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Saturn P2P bot kit, on devnet (test tokens) or mainnet (real funds).
Use at your own risk: the kit comes as is, without warranty of any kind
(MIT License, see LICENSE).

  sh start.sh            ask where to run: devnet or mainnet (Enter alone picks devnet)
  sh start.sh devnet     set up, then run the example seller and buyer bots together
  sh start.sh mainnet    set up your market bot, show a dry run, then start it once you type yes

On devnet:
  sh start.sh seller     set up, then run only the seller bot
  sh start.sh buyer      set up, then run only the buyer bot
  sh start.sh faucet     ask the devnet faucet for test tokens for both bots again
On mainnet:
  sh start.sh market     the market bot: a dry run first, then it starts once you type yes
After the network's name, or alone (then it asks):
  sh start.sh dry-run    set up, then show what the bots would do; sends nothing
  sh start.sh setup      only set up (Node, packages, keys; on devnet the first test
                         tokens, on mainnet the market bot's config market.mainnet.json)
  sh start.sh help       this text

The network's name goes first, for example: sh start.sh mainnet dry-run.
--network devnet or --network mainnet does the same, and so does KIT_NETWORK
in the environment. Without a terminal to ask in, and without any of them,
start.sh runs on devnet.

Options after "seller", "buyer" or "market" go to that bot (a relative path
in them is taken from the kit's folder), for example:
  sh start.sh seller --config seller.json
  sh start.sh buyer --dry-run
  sh start.sh market --config my-market.json

On mainnet a bot starts only once you type yes, or with KIT_ALLOW_MAINNET=1
already set (for a start without a terminal, such as a service).
Set KIT_SKIP_FAUCET=1 to never ask the faucet on a start, and
KIT_NO_NODE_DOWNLOAD=1 to never download Node into ./.node.
EOF
}

# Run from the kit's own folder, wherever this was started from.
KIT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd) || die "cannot find the kit's folder"
cd "$KIT_DIR"
if [ ! -f package.json ] || [ ! -f examples/seller-bot.ts ]; then
  die "run this from the kit's folder (no package.json or examples/ in $KIT_DIR)"
fi

# ── Node 22 or later ─────────────────────────────────────────────────────────

node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

fetch() { # <url> <file>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 2 -o "$2" "$1"
  else
    wget -nv -O "$2" "$1"
  fi
}

sha256_of() { # <file>
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

download_node() {
  if [ "${KIT_NO_NODE_DOWNLOAD:-}" = 1 ]; then
    die "Node 22 or later is needed: install it (https://nodejs.org), then run sh start.sh again"
  fi
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) die "no Node 22 or later was found, and this script downloads Node only on macOS and Linux (this is $os). On Windows, run the kit in WSL; elsewhere install Node 22 or later (https://nodejs.org), then run sh start.sh again" ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    armv7l) arch=armv7l ;;
    *) die "no Node 22 or later was found, and nodejs.org has no download for this processor ($arch) that this script knows. Install Node 22 or later yourself, then run sh start.sh again" ;;
  esac
  # A 64-bit ARM kernel can run a 32-bit system (Raspberry Pi OS 32-bit), which needs the armv7l Node.
  if [ "$os" = linux ] && [ "$arch" = arm64 ] && [ "$(getconf LONG_BIT 2>/dev/null || :)" = 32 ]; then
    arch=armv7l
  fi
  if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
    die "no Node 22 or later was found, and this script does not download Node for musl-based Linux such as Alpine. Install Node 22 or later with the system's packages (on Alpine: apk add nodejs npm, where that gives version 22 or later), then run sh start.sh again"
  fi
  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    die "no Node 22 or later was found, and neither curl nor wget is installed to download it: install one of them, or install Node 22 or later yourself (https://nodejs.org)"
  fi
  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    die "no Node 22 or later was found, and neither sha256sum nor shasum is installed to check a download: install Node 22 or later yourself (https://nodejs.org)"
  fi
  name="node-v$KIT_NODE_VERSION-$os-$arch"
  url="https://nodejs.org/dist/v$KIT_NODE_VERSION"
  work="$KIT_DIR/.node-download"
  rm -rf "$work"
  mkdir -p "$work"
  say "No Node 22 or later here: downloading Node $KIT_NODE_VERSION ($os-$arch) from nodejs.org into ./.node."
  say "It is used by this kit only; nothing is installed for the rest of the machine."
  if ! fetch "$url/$name.tar.gz" "$work/$name.tar.gz" || ! fetch "$url/SHASUMS256.txt" "$work/SHASUMS256.txt"; then
    rm -rf "$work"
    die "Node could not be downloaded from nodejs.org (check the network, or HTTPS_PROXY behind a proxy). Or install Node 22 or later yourself (https://nodejs.org), then run sh start.sh again"
  fi
  want=$(awk -v f="$name.tar.gz" '$2 == f { print $1 }' "$work/SHASUMS256.txt")
  if [ -z "$want" ] || [ "$(sha256_of "$work/$name.tar.gz")" != "$want" ]; then
    rm -rf "$work"
    die "the Node download does not match nodejs.org's list of SHA-256 sums; nothing was installed"
  fi
  say "SHA-256 checked against nodejs.org's list: OK."
  tar -xzf "$work/$name.tar.gz" -C "$work"
  rm -rf "$KIT_DIR/.node"
  mv "$work/$name" "$KIT_DIR/.node"
  rm -rf "$work"
}

use_local_node() {
  NODE="$KIT_DIR/.node/bin/node"
  NPM="$KIT_DIR/.node/bin/npm"
  PATH="$KIT_DIR/.node/bin:$PATH"
  export PATH
}

find_node() {
  if command -v node >/dev/null 2>&1 && [ "$(node_major node)" -ge 22 ] 2>/dev/null; then
    NODE=$(command -v node)
    NPM=$(command -v npm 2>/dev/null) || die "Node $(node --version) is installed but npm is not: install npm (it comes with Node from https://nodejs.org), then run sh start.sh again"
    return
  fi
  if [ -x "$KIT_DIR/.node/bin/node" ] && [ "$(node_major "$KIT_DIR/.node/bin/node")" -ge 22 ] 2>/dev/null; then
    use_local_node
    return
  fi
  if command -v node >/dev/null 2>&1; then
    say "This machine has Node $(node --version); the kit needs Node 22 or later."
  fi
  download_node
  use_local_node
  if ! "$NODE" --version >/dev/null; then
    rm -rf "$KIT_DIR/.node"
    die "the downloaded Node does not start on this machine (the error is above; nodejs.org's Linux builds need glibc 2.28 or later). Install Node 22 or later yourself, then run sh start.sh again"
  fi
}

# Node's own fetch reads HTTPS_PROXY only with NODE_USE_ENV_PROXY=1 (Node 22.21 or later).
proxy_setting() {
  if [ -n "${HTTPS_PROXY:-}${https_proxy:-}" ] && [ -z "${NODE_USE_ENV_PROXY:-}" ]; then
    NODE_USE_ENV_PROXY=1
    export NODE_USE_ENV_PROXY
    # Node 22 calls its proxy support experimental and says so on every start: keep that one notice quiet.
    NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--disable-warning=UNDICI-EHPA"
    export NODE_OPTIONS
    if ! "$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=21)?0:1)'; then
      say "Note: a proxy is set (HTTPS_PROXY), and Node $("$NODE" --version) cannot use it for the kit's requests: Node 22.21 or later can."
    fi
  fi
}

# ── The kit's packages ───────────────────────────────────────────────────────

install_packages() {
  stamp="node_modules/.kit-installed"
  want=$("$NODE" -e 'const c=require("crypto"),f=require("fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync("package-lock.json")).digest("hex")+" "+process.version)')
  if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$want" ] && [ -f node_modules/tsx/package.json ]; then
    return
  fi
  say "Installing the kit's packages with npm ci --ignore-scripts: exactly the versions in package-lock.json, and no package runs an install script."
  # --include=dev: the bots run their TypeScript through tsx, a dev dependency, even where NODE_ENV=production.
  "$NPM" ci --ignore-scripts --include=dev --no-audit --no-fund --no-update-notifier
  [ -f node_modules/tsx/package.json ] || die "npm ci did not install tsx, which the bots need (an npm setting that leaves dev dependencies out?)"
  printf '%s\n' "$want" >"$stamp"
}

run_tsx() { # <script> [args...]: one Node process, TypeScript through tsx
  script=$1
  shift
  "$NODE" --import tsx "$script" ${1+"$@"}
}

# ── Keys and test tokens ─────────────────────────────────────────────────────

NEW_KEYS=0
FUND_SELLER=''
FUND_BUYER=''

# The kit refuses key files that other users could read (mode 0600). Some drives cannot make a
# file private, such as Windows drives under WSL (/mnt/c): find that out before making keys.
check_private_files() {
  mkdir -p data
  probe="data/.mode-check.$$"
  printf '' >"$probe" || die "cannot write files in $KIT_DIR/data"
  chmod 600 "$probe" 2>/dev/null || :
  # shellcheck disable=SC2012 # the file and its name are ours; ls -l shows a mode the same way on macOS and Linux (stat does not)
  probe_mode=$(ls -l "$probe" | cut -c1-10)
  rm -f "$probe"
  # Like the kit itself, ask only that group and others get nothing (some drives show -rwx------).
  case "$probe_mode" in
    -???------) ;;
    *) die "files in $KIT_DIR cannot be made private (a test file there still shows $probe_mode after chmod 600), and the kit refuses key files that other users could read. On Windows (WSL), keep the kit in WSL's own files, not on a Windows drive under /mnt: run cd ~, then clone the kit again there and start it there. Elsewhere, move the kit to a folder on this machine's own disk" ;;
  esac
}

make_keys() {
  check_private_files
  for f in keys/seller-pha.json keys/seller-base.json keys/buyer-pha.json keys/buyer-base.json; do
    [ -f "$f" ] || NEW_KEYS=1
  done
  if [ "$NEW_KEYS" = 1 ]; then
    say ""
    say "Making a key pair for each bot (a Phantasma key and a Base key) in ./keys, mode 0600."
  fi
  if ! out=$(run_tsx examples/new-keys.ts); then
    printf '%s\n' "$out" | grep -v '^  Fund it on devnet: ' || :
    die "the key files could not all be made or read (above), so the bots were not started"
  fi
  if [ "$NEW_KEYS" = 1 ]; then
    # start.sh asks the faucet itself, so leave out new-keys' "npm run faucet" hints.
    printf '%s\n' "$out" | grep -v '^  Fund it on devnet: ' || :
  fi
  FUND_SELLER=$(printf '%s\n' "$out" | awk '/^seller: /{ b = "seller" } /^buyer: /{ b = "buyer" } b == "seller" && sub(/^  Fund it on devnet: npm run faucet -- /, "") { print; exit }')
  FUND_BUYER=$(printf '%s\n' "$out" | awk '/^seller: /{ b = "seller" } /^buyer: /{ b = "buyer" } b == "buyer" && sub(/^  Fund it on devnet: npm run faucet -- /, "") { print; exit }')
}

# data/.test-tokens-<Phantasma address> records that the faucet served that bot's addresses once.
SERVED=0
FAILED=0

faucet_for() { # <bot> <"--pha P2K… --base 0x…"> <always|first>
  case "$2" in
    "--pha P2K"*" --base 0x"*) ;;
    *)
      say "The $1 bot's addresses could not be read, so no test tokens were asked for it."
      FAILED=$((FAILED + 1))
      return 0
      ;;
  esac
  pha=$(printf '%s\n' "$2" | awk '{ print $2 }')
  base=$(printf '%s\n' "$2" | awk '{ print $4 }')
  mark="data/.test-tokens-$pha"
  if [ "$3" = first ] && [ -f "$mark" ]; then
    return 0
  fi
  say ""
  say "Asking the devnet faucet for test tokens for the $1 bot."
  mkdir -p data
  st="data/.faucet-status.$$"
  # The faucet script's own hint names npm, which a start.sh user may not have: leave that line out
  # (claim_test_tokens says what to run instead). Its other lines show as they come.
  { run_tsx examples/faucet.ts --pha "$pha" --base "$base" && echo 0 >"$st" || echo "$?" >"$st"; } |
    { grep -v -F 'npm run seller -- --dry-run' || :; }
  faucet_rc=$(cat "$st" 2>/dev/null || :)
  rm -f "$st"
  if [ "$faucet_rc" = 0 ]; then
    date -u '+%Y-%m-%dT%H:%M:%SZ' >"$mark"
    SERVED=$((SERVED + 1))
  else
    say "The faucet did not serve the $1 bot; the reason is just above."
    FAILED=$((FAILED + 1))
  fi
}

claim_test_tokens() { # <always|first>
  SERVED=0
  FAILED=0
  faucet_for seller "$FUND_SELLER" "$1"
  faucet_for buyer "$FUND_BUYER" "$1"
  if [ "$SERVED" -gt 0 ]; then
    say ""
    say "The test tokens arrive within a minute or two. Until then the bots wait, and they list their offers as soon as they hold them."
    if [ "$1" = always ]; then
      say "To see each bot's balances, run sh start.sh dry-run while the bots are stopped."
    fi
  fi
  if [ "$FAILED" -gt 0 ]; then
    say ""
    say "Without test tokens a bot starts but lists nothing and takes nothing. Ask again later with: sh start.sh faucet"
  fi
}

# Node and the packages, the same on both networks.
setup_node() {
  find_node
  proxy_setting
  say "Node $("$NODE" --version) at $NODE"
  install_packages
}

setup() { # [skip-faucet]: devnet's setup
  say "Saturn P2P bot kit, devnet: test tokens only, no real money. Your keys stay on this machine."
  say "You use it at your own risk: it comes as is, without warranty of any kind (MIT License, see LICENSE)."
  setup_node
  make_keys
  if [ "${1:-}" = skip-faucet ]; then
    return
  fi
  if [ "${KIT_SKIP_FAUCET:-}" = 1 ]; then
    say "KIT_SKIP_FAUCET=1: no test tokens asked for. Ask for them with: sh start.sh faucet"
    return
  fi
  claim_test_tokens first
}

# ── Running the bots ─────────────────────────────────────────────────────────

SELLER_PID=''
BUYER_PID=''
STOPS=0

on_stop() { # <INT|TERM>
  STOPS=$((STOPS + 1))
  # Ctrl-C in the terminal reaches the bots themselves; a TERM sent to this script is passed on.
  if [ "$1" = TERM ]; then
    kill -TERM "$SELLER_PID" "$BUYER_PID" 2>/dev/null || true
  fi
  say ""
  if [ "$STOPS" = 1 ]; then
    say "Stopping: the bots cancel their offers and finish their running trades, then exit."
    say "That can take a while when a trade is half way (on devnet up to about 41 minutes, when the other side never locks)."
    say "Press Ctrl-C again to stop them at once. The next start resumes every trade, so start them again soon: a lock a stopped bot owes and does not send in time counts as its no-show."
  else
    say "Ctrl-C again: the bots stop at once. (They take a second press within half a second of the first as the same press: if they keep finishing their trades, press Ctrl-C once more.)"
  fi
}

wait_bot() { # <pid>; sets BOT_RC to the bot's exit status (always returns 0, for set -e)
  BOT_RC=0
  while :; do
    if wait "$1"; then
      BOT_RC=0
    else
      BOT_RC=$?
    fi
    # Above 128, a signal may have ended the wait itself while the bot still runs (it is
    # finishing its trades) or has just ended: wait again, which then gives its own status.
    if [ "$BOT_RC" -gt 128 ] && kill -0 "$1" 2>/dev/null; then
      continue
    fi
    return 0
  done
}

bot_ended() { # <pid>: true once the bot has exited (gone, or exited and not yet waited for)
  kill -0 "$1" 2>/dev/null || return 0
  case $(ps -o stat= -p "$1" 2>/dev/null) in
    Z*) return 0 ;;
  esac
  return 1
}

run_both() {
  say ""
  say "Starting the seller and the buyer bots on devnet. Each line starts with the time (UTC); the bots' own lines then say [seller] or [buyer], and the kit's lines about offers, locks, claims and refunds say [kit] with the trade's number."
  say "They post offers and trade with each other through the public board. Watch them on https://ops.saturnx.cc/p2p, with devnet picked in the Network menu at the top of the page."
  say "Press Ctrl-C once to stop both cleanly."
  say ""
  trap 'on_stop INT' INT
  trap 'on_stop TERM' TERM
  # Each bot is a direct child of this script (no subshell between), so a TERM passed on reaches it.
  "$NODE" --import tsx examples/seller-bot.ts &
  SELLER_PID=$!
  "$NODE" --import tsx examples/buyer-bot.ts &
  BUYER_PID=$!
  seller_rc=''
  buyer_rc=''
  while [ -z "$seller_rc" ] || [ -z "$buyer_rc" ]; do
    if [ -z "$seller_rc" ] && bot_ended "$SELLER_PID"; then
      wait_bot "$SELLER_PID"
      seller_rc=$BOT_RC
      # Both bots often fail together (a second start in the same folder): wait a moment before saying the other one runs on.
      if [ -z "$buyer_rc" ] && [ "$STOPS" = 0 ] && { sleep 2 || :; } && [ "$STOPS" = 0 ] && ! bot_ended "$BUYER_PID"; then
        say "The seller bot stopped (exit status $seller_rc); its lines above say why. The buyer bot keeps running: press Ctrl-C to stop it."
      fi
    fi
    if [ -z "$buyer_rc" ] && bot_ended "$BUYER_PID"; then
      wait_bot "$BUYER_PID"
      buyer_rc=$BOT_RC
      if [ -z "$seller_rc" ] && [ "$STOPS" = 0 ] && { sleep 2 || :; } && [ "$STOPS" = 0 ] && ! bot_ended "$SELLER_PID"; then
        say "The buyer bot stopped (exit status $buyer_rc); its lines above say why. The seller bot keeps running: press Ctrl-C to stop it."
      fi
    fi
    if [ -z "$seller_rc" ] || [ -z "$buyer_rc" ]; then
      sleep 1 || :
    fi
  done
  trap - INT TERM
  # After a Ctrl-C or a TERM, a bot ended by the signal itself (130 or 143) has stopped as asked.
  if [ "$STOPS" -gt 0 ]; then
    case "$seller_rc" in 130 | 143) seller_rc=0 ;; esac
    case "$buyer_rc" in 130 | 143) buyer_rc=0 ;; esac
  fi
  if [ "$seller_rc" = 0 ] && [ "$buyer_rc" = 0 ]; then
    say "Both bots stopped. Run sh start.sh again to start them where they left off."
    return 0
  fi
  say "A bot stopped with an error (seller: $seller_rc, buyer: $buyer_rc); its lines above say why."
  return 1
}

dry_run_both() {
  rc=0
  for bot in seller buyer; do
    say ""
    say "Dry run of the $bot bot: it reads the board and both chains and sends nothing."
    run_tsx "examples/$bot-bot.ts" --dry-run || rc=1
  done
  return "$rc"
}

# ── The network: devnet or mainnet ───────────────────────────────────────────

NETWORK=''

set_network() { # <devnet|mainnet> <where it was named>
  case "$1" in
    devnet | mainnet) ;;
    *) die "$2 is devnet or mainnet, not \"$1\"" ;;
  esac
  if [ -n "$NETWORK" ] && [ "$NETWORK" != "$1" ]; then
    die "two networks were named ($NETWORK and $1): name one"
  fi
  NETWORK=$1
}

# A question needs someone to see it and answer it: a terminal on both ends.
is_interactive() { [ -t 0 ] && [ -t 1 ]; }

# The network, asked in a terminal when no name, --network, KIT_NETWORK or command chose it; devnet without a terminal.
choose_network() {
  if [ -n "$NETWORK" ]; then
    return 0
  fi
  if ! is_interactive; then
    NETWORK=devnet
    say "Network: devnet, the default without a terminal to ask in (sh start.sh mainnet runs on mainnet)."
    return 0
  fi
  say "Where do you want to run the bot?"
  say "  1) devnet   the test network: test tokens with no value; the two example bots trade with each other"
  say "  2) mainnet  real funds: your own market bot, trading at the prices you set"
  tries=0
  while :; do
    printf '%s' 'Type 1 or 2, then Enter (Enter alone picks devnet): '
    answer=''
    read -r answer || die "no answer came, so nothing was done"
    case "$answer" in
      '' | 1 | devnet | Devnet | DEVNET)
        NETWORK=devnet
        return 0
        ;;
      2 | mainnet | Mainnet | MAINNET)
        NETWORK=mainnet
        return 0
        ;;
    esac
    tries=$((tries + 1))
    [ "$tries" -lt 3 ] || die "no network was picked, so nothing was done"
    say "Type 1 for devnet or 2 for mainnet."
  done
}

# The example bots and the faucet are devnet's.
devnet_only() { # <command>
  if [ "$NETWORK" = mainnet ]; then
    case "$1" in
      faucet) die "the faucet serves devnet's test tokens only; mainnet has none. Send the market bot what it should trade (sh start.sh mainnet setup shows its addresses)" ;;
      *) die "the $1 bot is a devnet example: its config's prices are devnet's own, and on mainnet they would trade for real. On mainnet, run your own market bot: sh start.sh mainnet" ;;
    esac
  fi
  NETWORK=devnet
}

# ── Mainnet: your own market bot ─────────────────────────────────────────────

# The market bot's config when no --config is given: your own file, kept outside examples/ (each version replaces examples/).
MARKET_CONFIG=market.mainnet.json

intro_mainnet() {
  say "Saturn P2P bot kit, mainnet: real funds and real trades. Your keys stay on this machine."
  say "You use it at your own risk: it comes as is, without warranty of any kind (MIT License, see LICENSE). Nobody can undo a trade for you: start small."
}

# The market bot's own key pair and its config, made once (never over a file that is there).
market_setup() {
  if [ -f "$MARKET_CONFIG" ]; then
    return 0
  fi
  check_private_files
  say ""
  say "Making the market bot's own key pair for mainnet (a Phantasma key and a Base key) in ./keys/mainnet, mode 0600."
  if ! out=$(run_tsx examples/new-keys.ts --dir keys/mainnet --name market); then
    printf '%s\n' "$out" | grep -v '^  Fund it on devnet: ' || :
    die "the market bot's key files could not all be made or read (above), so its config was not made"
  fi
  # Mainnet has no faucet: leave out new-keys' devnet hint.
  printf '%s\n' "$out" | grep -v '^  Fund it on devnet: ' || :
  cp examples/market.mainnet.example.json "$MARKET_CONFIG"
  say ""
  say "Mainnet has no faucet: the bot trades only what you send to those two addresses. Send it what it should trade, and start small:"
  say "  Phantasma: the tokens it sells, at least 1.1 SOUL, and a few KCAL for its sends (each one can cost up to 3 KCAL)."
  say "  Base: the USDC it buys with, and a little ETH for gas (each transaction at most 0.002 ETH under the kit's fee caps)."
  say ""
  say "Wrote $MARKET_CONFIG, the market bot's config. It lists nothing yet, so the bot lists and takes nothing until you add your offers:"
  say '  "offers" are sell offers and "bids" buy offers: amounts in whole tokens and prices in USDC per whole token, as text, such as'
  say '  "offers": [{ "symbol": "TAZ", "total": "500", "min": "20", "max": "100", "price": "<your price>" }]'
  say "  Each trade is at least 1 USDC. examples/README.md (\"The config\") explains every key, and a dry run shows the open offers and the reference price."
  say "  Do not copy the prices of the devnet examples: they are devnet's own, and on mainnet a price is a real trade at that price."
}

# True when the config reads as a JSON object that lists no offer, bid or recurring order: the bot would have nothing to do.
config_lists_nothing() { # <file>
  "$NODE" -e '
    let c;
    try { c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch { process.exit(1); }
    if (!c || typeof c !== "object" || Array.isArray(c)) process.exit(1);
    const n = (v) => (Array.isArray(v) ? v.length : v == null ? 0 : 1);
    process.exit(n(c.offers) + n(c.bids) + n(c.take) === 0 ? 0 : 1);
  ' "$1"
}

nothing_listed_note() { # <config>
  if config_lists_nothing "$1"; then
    say ""
    say "$1 lists no offers, bids or orders yet, so the market bot has nothing to do. Add yours there (examples/README.md, \"The config\"), then start it again."
  fi
}

# What the market bot's options ask for: M_MODE start, dry-run or help; M_CONFIG the --config given ('' for none); M_MAINNET 1 when --mainnet is among them.
market_scan() {
  M_MODE=start
  M_CONFIG=''
  M_MAINNET=0
  next=''
  for a in ${1+"$@"}; do
    if [ "$next" = config ]; then
      M_CONFIG=$a
      next=''
      continue
    fi
    case "$a" in
      --help | -h) M_MODE=help ;;
      --dry-run) [ "$M_MODE" = help ] || M_MODE=dry-run ;;
      --mainnet) M_MAINNET=1 ;;
      --config) next=config ;;
      --config=*) M_CONFIG=${a#--config=} ;;
    esac
  done
}

market_main() { # [the market bot's options]
  market_scan ${1+"$@"}
  intro_mainnet
  setup_node
  if [ "$M_MODE" = help ]; then
    say ""
    say "The market bot's own help follows. Through this script, where it says npm run market -- <options>, type sh start.sh market <options>."
    exec "$NODE" --import tsx examples/market-bot.ts ${1+"$@"}
  fi
  cfg=$M_CONFIG
  if [ -z "$cfg" ]; then
    market_setup
    cfg=$MARKET_CONFIG
    set -- ${1+"$@"} --config "$cfg"
  fi
  [ -f "$cfg" ] || die "there is no config $cfg (sh start.sh mainnet setup makes $MARKET_CONFIG)"
  # The bot's own switch for a mainnet config; KIT_ALLOW_MAINNET=1, its other one, is given below run by run.
  [ "$M_MAINNET" = 1 ] || set -- "$@" --mainnet
  if [ "$M_MODE" = dry-run ] || config_lists_nothing "$cfg"; then
    say ""
    say "Dry run of the market bot on mainnet: it reads the board and both chains and sends nothing."
    [ "$M_MODE" = dry-run ] || set -- "$@" --dry-run
    # Reading mainnet needs both switches too; a dry run's transports refuse every send.
    rc=0
    KIT_ALLOW_MAINNET=1 "$NODE" --import tsx examples/market-bot.ts "$@" || rc=$?
    nothing_listed_note "$cfg"
    return "$rc"
  fi
  if [ "${KIT_ALLOW_MAINNET:-}" = 1 ]; then
    say ""
    say "KIT_ALLOW_MAINNET=1 is set, so the market bot starts without a question."
  elif is_interactive; then
    say ""
    say "First a dry run: it reads the board and both chains, shows what the bot would list and take, and sends nothing."
    if ! KIT_ALLOW_MAINNET=1 "$NODE" --import tsx examples/market-bot.ts "$@" --dry-run; then
      say ""
      say "The dry run stopped on a problem (above), so the market bot was not started. Nothing was sent."
      return 1
    fi
    say ""
    say "That is what the market bot lists and takes on mainnet, with real funds, at the prices in $cfg."
    printf '%s' 'Start it now? Type yes to start, anything else to stop here: '
    answer=''
    read -r answer || :
    case "$answer" in
      yes | Yes | YES) ;;
      *)
        say "Not started. Nothing was sent."
        return 0
        ;;
    esac
  else
    die "on mainnet the market bot starts only once you type yes in a terminal, or with KIT_ALLOW_MAINNET=1 already set (for a start without a terminal). sh start.sh mainnet dry-run shows what it would do"
  fi
  say ""
  say "Starting the market bot on mainnet with $cfg. Its own lines say [market], and the kit's lines about offers, locks, claims and refunds say [kit] with the trade's number."
  say "Watch it on https://ops.saturnx.cc/p2p, with mainnet picked in the Network menu at the top of the page."
  say "Press Ctrl-C once to stop it cleanly: it cancels its offers and finishes its running trades, which on mainnet can take up to about 12 hours when the other side never locks. Ctrl-C again stops it at once; the next start resumes every trade."
  KIT_ALLOW_MAINNET=1
  export KIT_ALLOW_MAINNET
  exec "$NODE" --import tsx examples/market-bot.ts "$@"
}

# ── Main ─────────────────────────────────────────────────────────────────────

# The network's name first, when given: sh start.sh mainnet ..., or sh start.sh --network mainnet ...
while [ "$#" -gt 0 ]; do
  case "$1" in
    devnet | mainnet)
      set_network "$1" 'The network'
      shift
      ;;
    --network)
      [ "$#" -ge 2 ] || die "--network is devnet or mainnet"
      set_network "$2" --network
      shift 2
      ;;
    --network=*)
      set_network "${1#--network=}" --network
      shift
      ;;
    *) break ;;
  esac
done
if [ -z "$NETWORK" ] && [ -n "${KIT_NETWORK:-}" ]; then
  set_network "$KIT_NETWORK" KIT_NETWORK
fi

cmd=${1:-demo}
if [ "$#" -gt 0 ]; then shift; fi

case "$cmd" in
  demo | start | run)
    [ "$#" = 0 ] || die "sh start.sh takes no options here; options go after seller, buyer or market (sh start.sh help)"
    choose_network
    if [ "$NETWORK" = mainnet ]; then
      market_main
    else
      setup
      run_both
    fi
    ;;
  seller | buyer)
    devnet_only "$cmd"
    # A dry run or the bot's help sends nothing, so they never ask the faucet either.
    bot_mode=start
    for a in ${1+"$@"}; do
      case "$a" in
        --help | -h) bot_mode=help ;;
        --dry-run) [ "$bot_mode" = help ] || bot_mode=dry-run ;;
      esac
    done
    if [ "$bot_mode" = start ]; then setup; else setup skip-faucet; fi
    say ""
    case "$bot_mode" in
      start) say "Starting the $cmd bot on devnet. Press Ctrl-C once to stop it cleanly." ;;
      dry-run) say "Dry run of the $cmd bot: it reads the board and both chains and sends nothing." ;;
      help) say "The $cmd bot's own help follows. Through this script, where it says npm run $cmd -- <options>, type sh start.sh $cmd <options>." ;;
    esac
    exec "$NODE" --import tsx "examples/$cmd-bot.ts" ${1+"$@"}
    ;;
  market)
    if [ "$NETWORK" = devnet ]; then
      die "the market bot is start.sh's mainnet bot. On devnet, run the example bots (sh start.sh devnet), or a config of your own with sh start.sh seller --config <file>"
    fi
    NETWORK=mainnet
    market_main ${1+"$@"}
    ;;
  dry-run | dryrun)
    choose_network
    if [ "$NETWORK" = mainnet ]; then
      market_main --dry-run
    else
      setup skip-faucet
      say "A dry run sends nothing, so no test tokens were asked for. A start without it asks for them, or run: sh start.sh faucet"
      dry_run_both
    fi
    ;;
  faucet)
    devnet_only faucet
    find_node
    proxy_setting
    install_packages
    make_keys
    claim_test_tokens always
    [ "$SERVED" -gt 0 ]
    ;;
  setup)
    choose_network
    if [ "$NETWORK" = mainnet ]; then
      intro_mainnet
      setup_node
      market_setup
      say ""
      if config_lists_nothing "$MARKET_CONFIG"; then
        say "Set up. Add your offers to $MARKET_CONFIG, then start the market bot with: sh start.sh mainnet"
      else
        say "Set up. Start the market bot with: sh start.sh mainnet"
      fi
    else
      setup
      say ""
      say "Set up. Start both bots with: sh start.sh devnet"
    fi
    ;;
  help | -h | --help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
