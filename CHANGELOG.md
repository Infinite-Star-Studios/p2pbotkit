# Changelog

The kit's releases, newest first. Each release sets `version` in
`package.json` and in `package-lock.json` (the two must agree, or `npm ci`
refuses). While the kit is 0.x, a release that changes only its pins (the
addresses it refuses, the contracts it checks against) is a patch release;
one that changes what the kit does, its checks or its configuration is a
minor release. To upgrade, follow `examples/README.md`, "Upgrading the kit".

## 0.2.2 (11 November 2026)

`start.sh` and the READMEs only. No trade, check, pin or setting of the kit
changes.

- In a terminal, a mainnet start always shows the dry run and asks you to
  type yes, even with `KIT_ALLOW_MAINNET=1` set, as the README says. That
  variable stands in for the yes only without a terminal (a service). 0.2.0
  and 0.2.1 also took it in a terminal, and then started the bot at once.
- When `market.mainnet.json` lists nothing but the market bot's saved state
  still holds open offers or unfinished trades, a mainnet start no longer
  stops after the dry run. It goes on (the dry run, then your yes; or
  `KIT_ALLOW_MAINNET=1` without a terminal), and the bot cancels those offers
  and finishes those trades. `sh start.sh mainnet dry-run` names them, or
  says why the saved state could not be read (sealed, or in use by a running
  bot).
- `dry-run`, `setup` and `faucet` refuse anything after them instead of
  ignoring it: the network goes first (`sh start.sh mainnet dry-run`), and
  the market bot's options after `market`
  (`sh start.sh market --config <file> --dry-run`).
- On mainnet the faucet's refusal, and `sh start.sh mainnet setup` once the
  config is there, point to the market bot's addresses on the `Addresses`
  line of `sh start.sh mainnet dry-run`. Setup showed them only the first
  time.
- `start.sh` makes `market.mainnet.json` only where nothing is there yet. A
  folder at that name, or a link to a folder or to nothing, is refused;
  0.2.0 copied the example config into that folder, or through the link.
- README: the Saturn site's file is still version 0.1.4, without `start.sh`
  or the market bot; a start in a terminal waits at the network question,
  so a script or a terminal nobody answers names the network
  (`sh start.sh devnet`); and the tests skipped outside Saturn's source tree
  are 16, plus one that only a release without mainnet's pins runs.

## 0.2.1 (11 November 2026)

`start.sh` only: the Node it downloads is now 22.23.5, the November 2026
Node.js security release (nodejs.org/en/blog/vulnerability/november-2026-security-releases).
No trade, check, pin or setting of the kit changes.

- A `./.node` from an earlier start (22.23.4) is replaced by 22.23.5 on the
  next start, checked against nodejs.org's SHA-256 list like a first
  download; if the download fails, the old one stays in use.
- With your own Node 22 older than 22.23.5, `start.sh` says that 22.23.5 has
  security fixes for it; it still runs.

## 0.2.0 (6 November 2026)

`start.sh` runs on mainnet too, with a market bot of your own. No trade,
check, pin or setting of the kit changes.

- `sh start.sh` asks where to run: devnet (the two example bots, test
  tokens; Enter alone picks it) or mainnet (your own market bot, real
  funds). `sh start.sh devnet` and `sh start.sh mainnet`, `--network`, or
  `KIT_NETWORK` choose without the question. Without a terminal and without
  any of them it stays on devnet, as before.
- On mainnet `start.sh` makes the market bot's own key pair in
  `keys/mainnet/` and its config `market.mainnet.json` from
  `examples/market.mainnet.example.json`, which lists no offers, bids or
  orders: the bot lists and takes nothing until you add yours. It never asks
  a faucet, shows a dry run first, and starts the bot only once you type yes,
  or with `KIT_ALLOW_MAINNET=1` already set for a start without a terminal;
  then it gives `--mainnet` and `KIT_ALLOW_MAINNET=1` to that bot alone.
- `examples/market-bot.ts` (`npm run market`): the example bots' runner with
  your own config, `market.mainnet.json` in the kit's folder unless
  `--config` names another; its lines say `[market]`.
- The example seller and buyer and the faucet stay devnet's: `start.sh`
  refuses them on mainnet, where the examples' devnet prices would trade for
  real.

## 0.1.4 (6 November 2026)

Pins only: mainnet's escrow and SaturnSwap (P2P/LAUNCH.md step 9). No
trade, check or setting changes.

- Mainnet's escrow, `saturnescrow`:
  - code SHA-256 `ca1521581d1632dac9c0579817044e76253977f685c95240343ce76358e4fd99`
    (the tested build, the same as devnet's);
  - admin `P2KBH6mEVXiXgaGqUjafg49oviuXvpTLhskWprpzq1BkYph`, the operating admin after
    the launch hand-off.
- SaturnSwap on Base: `0x32A77cfC4B3c1F99378Bf5CCcca1531D3A1392A7`, deployed at block
  53707008.
- The kit no longer refuses mainnet for want of pins. It still runs there
  only with `allowMainnet: true` and `KIT_ALLOW_MAINNET=1`, and posts no
  instant offer there (`INSTANT_NETWORKS` is devnet only).

## 0.1.3 (3 November 2026)

Dependencies only: no trade, check or setting changes.

- `viem` 2.57.2 to 2.57.4, the version Saturn's backend and P2P service
  already run, and the site from this release on, so every part of Saturn
  builds its Base transactions with the same library. Its `ox` moves from
  0.14.45 to 0.14.54 with it; no other package changes. Both are the very
  packages the backend and the P2P service install (the same integrity
  hashes), and neither has a known advisory.

## 0.1.2 (3 November 2026)

Dependencies only: no trade, check or setting changes.

- `phantasma-sdk-ts` 0.4.0 to 0.20.0, its current release. It signs with
  `tweetnacl` instead of `elliptic`, for which `npm audit` reported a
  low-severity advisory (GHSA-848j-6mx2-7j84, a flaw in `elliptic`'s ECDSA
  signing; the kit's Ed25519 signatures were never affected), and it no
  longer brings the Ledger hardware-wallet modules the kit never used. The
  lockfile falls from 165 packages to 65, none of them with a known
  advisory; only `tsx`'s `esbuild` and `fsevents` keep install scripts,
  which `npm ci --ignore-scripts` skips.
- The kit signs exactly what it signed before: `test/sdk-vectors.test.ts`
  holds the new SDK to 0.4.0's keys, escrow transactions and view scripts,
  byte for byte (`test/fixtures/sdk-vectors.json`), and checks each
  signature with Node's own Ed25519.
- Answers from a Phantasma node read exactly as before: the same test
  replays the devnet node's answers to the kit's reads, recorded with
  0.4.0, and gets 0.4.0's results. Only answers the escrow never gives the
  kit (malformed ones, or values of another type) read differently, and the
  vectors file records each one:
  - a value of a type the SDK does not decode (a timestamp, bytes), a
    struct that does not decode, or a read past the end of the answer reads
    as no answer, where 0.4.0 read the text "unsupported type N" or part of
    the struct;
  - a number whose last byte has its top bit set reads as negative, which
    the kit refuses (a node never sends one for a value of 0 or more: it
    adds a 00 sign byte, so secrets and hashes of 2^255 or more read as
    before);
  - a value whose length or data is missing entirely reads as 0 or empty,
    where 0.4.0 refused it, exactly as a well-formed 0 or empty value
    reads, so a node could send the same reading anyway.
- Saturn's repository now runs the kit's type check and tests on every
  change to the kit (`.github/workflows/kit.yml` there).

## 0.1.1 (26 October 2026)

Pins only: no trade, check or setting changes.

- Check 68 (a bot's key never holds an admin, owner or keeper role) refuses
  the devnet keeper's new keys, K1, which the board runs on since
  26 October 2026, at the addresses its `/v1/p2p/config?network=devnet`
  shows under `keeper`:
  - `P2KKFuFZNpiFdtgWQ68DHuTtwqnjBMgTv2hArZrmQYmf4gx`, the devnet keeper
    (Phantasma claims and refunds), `phaAddress`;
  - `0xa93Bc149Ff1DE9f20Fa1198e2edB4FFb69ECE58A`, the devnet keeper (refunds
    and withdrawOwed), `baseAddress`;
  - `0x8701a821221266800a6dF354701E79Fdb5Ab80A6`, the devnet keeper (claims),
    `claimAddress`.

  The kit already refused the keeper addresses the board's `/config` shows
  when it starts; now they are pinned, so a board that shows none, or other
  ones, cannot let them through.
- The previous devnet keeper's keys, K0 (`P2KJBzzwGWLkDz5HUtuHQ7ydUWmbyAtFukwytu8qFtbRkuX`,
  `0xe16fE62e009961682F3a7F42642F36F5E46962F8` and
  `0x6EC2A535685D5cE5f143B8C0d9bF5F612295b703`), stay refused, now named
  "the retired devnet keeper": they leaked and were retired.
- A bot whose key is one of these addresses stops at start with `KEY_ROLE`;
  give it a key of its own (`npx tsx examples/new-keys.ts`).
- Still to come: SaturnSwap's new `gasKeeper`, the owner's cold address, is
  added to the same list in the release after it is set.

## 0.1.0

The first release: maker and taker bots for the devnet P2P board, with
their own keys on their own machine (`README.md`).
