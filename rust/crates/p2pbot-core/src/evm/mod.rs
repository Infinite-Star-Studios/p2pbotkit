//! Base (EVM): keys and addresses, the escrow and USDC calls, the USDC
//! permit (EIP-712) and EIP-1559 transactions, encoded and signed exactly as
//! the kit does with viem (checked against `rust/fixtures/kit-vectors.json`).

pub mod abi;
pub mod calls;
pub mod keys;
pub mod permit;
pub mod tx;

pub use calls::BaseCall;
pub use keys::{checksum_address, evm_lower, keccak256, parse_address, EvmKey, RecoverableSignature};
pub use permit::{domain_separator, permit_digest, sign_permit, PermitSignature};
pub use tx::Eip1559;
