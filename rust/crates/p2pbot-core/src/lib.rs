//! The core of the Saturn P2P bot kit, in Rust.
//!
//! This crate holds what the TypeScript kit (`../../src`) compiles in and
//! signs, ported byte for byte and tested against the kit's own answers:
//!
//! - [`pins`]: the compiled-in trust (tokens, both networks, gas, timing, the
//!   addresses a bot must never hold), from `src/pins.ts`;
//! - [`codec`]: swap secrets, their hash and control tokens, from `src/codec.ts`;
//! - [`phantasma`]: Phantasma keys and addresses, the VM scripts and the three
//!   escrow transactions (lock, claim, refund), from `src/pha.ts` and
//!   `phantasma-sdk-ts`;
//! - [`evm`]: Base keys and addresses, the escrow and USDC calls, the USDC
//!   permit (EIP-712) and EIP-1559 transactions, from `src/base.ts` and viem;
//! - [`seal`]: the store's AES-256-GCM sealing, from `src/store.ts`.
//!
//! It is `no_std` (with `alloc`) and has no clock, no network and no random
//! source of its own: the caller passes the time and the random bytes, so the
//! same code runs on Linux and on a microcontroller. Nothing in this crate
//! sends anything; it only builds and signs what it is given, after the same
//! input checks as the kit. The checks that decide *whether* to sign (the
//! kit's `src/checks.ts`) are not ported yet: see `rust/README.md`.
#![no_std]
#![forbid(unsafe_code)]
#![warn(missing_docs)]

extern crate alloc;

pub mod codec;
pub mod error;
pub mod evm;
pub mod phantasma;
pub mod pins;
pub mod seal;

pub use error::{Error, Result};
