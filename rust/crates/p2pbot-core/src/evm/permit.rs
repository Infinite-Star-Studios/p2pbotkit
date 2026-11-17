//! The USDC permit (EIP-2612, signed as EIP-712 typed data), ported from
//! `src/base.ts` `permitTypedData`: domain = USDC's pinned name and version,
//! Base's chain id and the USDC contract; spender = SaturnSwap.

use crate::error::{Error, Result};
use crate::evm::abi::{address, uint};
use crate::evm::keys::{evm_lower, keccak256, parse_address, EvmKey, RecoverableSignature};
use crate::phantasma::escrow::MAX_SAFE_INTEGER;
use crate::pins::NetConfig;

const DOMAIN_TYPE: &str = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
const PERMIT_TYPE: &str = "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)";

/// USDC's EIP-712 domain separator on this network (the kit compares it with
/// USDC's own `DOMAIN_SEPARATOR()` before it signs a permit).
pub fn domain_separator(cfg: &NetConfig) -> Result<[u8; 32]> {
    let mut buf = [0u8; 32 * 5];
    buf[..32].copy_from_slice(&keccak256(DOMAIN_TYPE.as_bytes()));
    buf[32..64].copy_from_slice(&keccak256(cfg.base.permit.name.as_bytes()));
    buf[64..96].copy_from_slice(&keccak256(cfg.base.permit.version.as_bytes()));
    buf[96..128].copy_from_slice(&uint(u128::from(cfg.base.chain_id)));
    buf[128..].copy_from_slice(&address(&parse_address(cfg.base.usdc)?));
    Ok(keccak256(&buf))
}

/// The EIP-712 digest of a permit for `amount` raw USDC from `owner` to SaturnSwap.
pub fn permit_digest(cfg: &NetConfig, owner: &str, amount: u128, nonce: u128, deadline: u64) -> Result<[u8; 32]> {
    let owner = evm_lower(owner).ok_or_else(|| Error::bad_input("Not a valid permit"))?;
    if amount == 0 || deadline > MAX_SAFE_INTEGER {
        return Err(Error::bad_input("Not a valid permit"));
    }
    let mut s = [0u8; 32 * 6];
    s[..32].copy_from_slice(&keccak256(PERMIT_TYPE.as_bytes()));
    s[32..64].copy_from_slice(&address(&parse_address(&owner)?));
    s[64..96].copy_from_slice(&address(&parse_address(cfg.base.swap)?));
    s[96..128].copy_from_slice(&uint(amount));
    s[128..160].copy_from_slice(&uint(nonce));
    s[160..].copy_from_slice(&uint(u128::from(deadline)));
    let struct_hash = keccak256(&s);
    let mut m = [0u8; 2 + 64];
    m[0] = 0x19;
    m[1] = 0x01;
    m[2..34].copy_from_slice(&domain_separator(cfg)?);
    m[34..].copy_from_slice(&struct_hash);
    Ok(keccak256(&m))
}

/// A signed permit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PermitSignature {
    /// What was signed.
    pub digest: [u8; 32],
    /// The signature.
    pub signature: RecoverableSignature,
}

/// Sign a permit from `key`'s own address (the owner is always the signer).
pub fn sign_permit(key: &EvmKey, cfg: &NetConfig, amount: u128, nonce: u128, deadline: u64) -> Result<PermitSignature> {
    let digest = permit_digest(cfg, &key.address_lower(), amount, nonce, deadline)?;
    Ok(PermitSignature { digest, signature: key.sign_hash(&digest)? })
}
