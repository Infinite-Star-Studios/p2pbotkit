# P2P bot kit in Rust (work in progress)

A port of this kit to Rust, so the bot can run on hardware much cheaper than
a Raspberry Pi. The TypeScript kit needs Node.js and about 260 MB of RAM. A
Rust build needs a few MB, which fits a ~$20 ESP32-S3 board with Ethernet
and Wi-Fi, or a 256 MB Linux board. The hardware side is in the
[`p2pbotkithardware`](https://github.com/Infinite-Star-Studios/p2pbotkithardware)
repository, branch `RustCustomHardware`.

**Status: stage 1 of the port, the foundation. It cannot trade yet.**

What stage 1 does:

- **It reproduces every byte the kit signs.** That covers both Phantasma and
  Base, and each piece is tested against the TypeScript kit's own answers.
- **It sends nothing and has no network code.** It does not decide whether a
  trade should be signed: the kit's safety checks
  ([`docs/CHECKS.md`](../docs/CHECKS.md)) are not ported yet.
- **Do not use it with funds.** Use the TypeScript kit (`sh start.sh`) to
  trade.

## What is ported, and how it is checked

| Part | Ported from | Checked against |
|---|---|---|
| Phantasma keys, WIF (checksum checked), addresses | `src/keys.ts`, phantasma-sdk-ts | the 8 keys of `test/fixtures/sdk-vectors.json` |
| Escrow transactions: lock, claim, refund (script, gas, label, expiry, Ed25519 signature) | `src/pha.ts`, phantasma-sdk-ts | all 24 escrow vectors, unsigned and signed, byte for byte |
| View scripts (16 calls per script) | `src/pha.ts`, phantasma-sdk-ts | all 60 view vectors, byte for byte |
| Base keys and EIP-55 addresses | viem | the 8 keys, as viem derives them |
| Base calls: USDC `approve`; SaturnSwap `lock`, `lockWithPermit`, `claim`, `refund`, `withdrawOwed`; `cancel` | `src/base.ts` | every call on both networks, as the kit builds it |
| USDC permit (EIP-712): domain separator, digest, signature | `src/base.ts`, viem | both networks, signed with viem |
| EIP-1559 transactions as `src/signer.ts` signs them | `src/base.ts`, viem | 5 transactions per network: unsigned bytes, signed bytes and hash |
| Pins: tokens, both networks (escrow, chains, fee caps, timing), gas, labels, addresses a bot must never hold | `src/pins.ts` | every value the kit compiles in |
| Swap secrets, `h`, control tokens, decimal and hex forms | `src/codec.ts` | the kit's outputs, including its shared vector |
| Store sealing (AES-256-GCM, place-bound) | `src/store.ts` | files the kit's own store wrote: they open, and re-seal to the same bytes |
| Key files (0600, never overwritten, fsynced, read back) | `src/keys.ts`, `examples/new-keys.ts` | key files in the TypeScript format load here, and the kit's `loadKeys` reads key files made here |

The input checks go with them: an unknown or lowercase token symbol, a bad
hash, a zero amount, a fee above 200 bps, a deadline out of range, another
contract or method, and a key that appears on the command line are all
refused. So is an admin, owner or keeper key (check 68).

`p2pbot-core` builds without the standard library. It compiles for
`riscv32imac-unknown-none-elf`, a bare-metal microcontroller target, so the
same code can run on Linux and on an ESP32.

## Layout

```
rust/
  crates/p2pbot-core/   no_std library: pins, codec, phantasma, evm, seal
    tests/              the checks against the kit's answers
  crates/p2pbot-cli/    `p2pbot`: key files (Linux or macOS)
  fixtures/kit-vectors.json   the kit's answers (made by tools/make-vectors.ts)
  tools/make-vectors.ts       makes that file from the TypeScript kit
```

The core has no clock, no network and no random source of its own. The
caller passes in the time and random bytes, which is what lets one codebase
serve both a Linux board and a microcontroller.

## Use it

Install Rust from https://rustup.rs, then run these from `rust/`:

```sh
cargo test --workspace          # every check against the kit's answers
cargo build --release           # target/release/p2pbot (about 0.6 MB)
```

To check that the core builds for a microcontroller:

```sh
rustup target add riscv32imac-unknown-none-elf
cargo build -p p2pbot-core --release --target riscv32imac-unknown-none-elf
```

The CLI makes key files that the TypeScript kit reads too. It prints only
the addresses:

```sh
target/release/p2pbot new-keys --dir keys/mainnet --name market
target/release/p2pbot addresses --network mainnet --pha keys/mainnet/market-pha.json --base keys/mainnet/market-base.json
```

## Keeping it in step with the TypeScript kit

When the kit changes its pins, its calls or its store format, remake the
answers from the kit's folder, then run the tests:

```sh
npm ci --ignore-scripts
npx tsx rust/tools/make-vectors.ts
cd rust && cargo test --workspace
```

A failing test names the value or the bytes the port must follow. The store
seals get a new random IV on every run, so that part of the file always
changes, and the tests accept any IV.

## Road to a working bot

Each stage keeps the rule of stage 1: it is checked against the TypeScript
kit before the next one starts.

1. **Chain readers.** These are the Phantasma JSON-RPC and the decoding of
   VM answers, and the Base JSON-RPC (calls, logs, nonces, fees). The kit
   already has 164 decode answers and 18 escrow reads in
   `test/fixtures/sdk-vectors.json`, including recorded answers from devnet.
2. **The board client.** This is `src/board.ts`: the offers, takes,
   heartbeats, long-polls, and the retry and refusal rules.
3. **The crash-safe store.** This is `src/store.ts`: the journal of sends,
   fsync and read-back before each step, and one running bot per folder.
4. **The checks and the signer.** These are `src/checks.ts` and
   `src/signer.ts`. Every numbered check in `docs/CHECKS.md` runs before a
   signature, and the signer only signs intents the checks issued. It
   re-checks time-sensitive facts right before signing.
5. **The flows.** These are the maker, taker and instant flows
   (`src/flows/`) and the market bot (`examples/market-bot.ts`).
6. **The kit's tests.** The behavior its 393 tests pin down, against fake
   chains and a fake board.
7. **Targets.** Linux first (std), then ESP32-S3 firmware
   (`esp-idf-svc`):
   - Wi-Fi and W5500 Ethernet;
   - HTTPS through ESP-IDF's TLS;
   - LittleFS on flash for the store;
   - SNTP for the 300-second clock rule;
   - flash encryption and secure boot to protect the keys.
8. **An independent security review** before it touches mainnet funds.
