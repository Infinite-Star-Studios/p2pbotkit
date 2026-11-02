# Changelog

The kit's releases, newest first. Each release sets `version` in
`package.json` and in `package-lock.json` (the two must agree, or `npm ci`
refuses). While the kit is 0.x, a release that changes only its pins (the
addresses it refuses, the contracts it checks against) is a patch release;
one that changes what the kit does, its checks or its configuration is a
minor release. To upgrade, follow `examples/README.md`, "Upgrading the kit".

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
