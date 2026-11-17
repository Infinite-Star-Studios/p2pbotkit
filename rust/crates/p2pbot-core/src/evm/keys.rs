//! Base keys (secp256k1) and addresses.
//!
//! Signatures are deterministic (RFC 6979) and low-S, as viem's, so the same
//! key and hash give the same bytes in both kits.

use alloc::string::String;
use core::fmt;

use k256::ecdsa::SigningKey;
use sha3::{Digest, Keccak256};

use crate::error::{Error, Result};

/// Keccak-256 of `data`.
pub fn keccak256(data: &[u8]) -> [u8; 32] {
    Keccak256::digest(data).into()
}

/// `0x` + 40 hex (any case) to 20 bytes.
pub fn parse_address(a: &str) -> Result<[u8; 20]> {
    let b = a.as_bytes();
    if b.len() != 42 || b[0] != b'0' || b[1] != b'x' || !b[2..].iter().all(u8::is_ascii_hexdigit) {
        return Err(Error::bad_input("Not an EVM address"));
    }
    let mut out = [0u8; 20];
    hex::decode_to_slice(&a[2..], &mut out).map_err(|_| Error::bad_input("Not an EVM address"))?;
    Ok(out)
}

/// The kit's `evmLower`: a valid, non-zero address in lowercase, else `None`.
pub fn evm_lower(a: &str) -> Option<String> {
    let bytes = parse_address(a).ok()?;
    if bytes.iter().all(|&b| b == 0) {
        return None;
    }
    let mut s = String::from("0x");
    s.push_str(&hex::encode(bytes));
    Some(s)
}

/// The EIP-55 checksummed text of an address.
pub fn checksum_address(addr: &[u8; 20]) -> String {
    let lower = hex::encode(addr);
    let hash = keccak256(lower.as_bytes());
    let mut s = String::with_capacity(42);
    s.push_str("0x");
    for (i, c) in lower.chars().enumerate() {
        let nibble = (hash[i / 2] >> (if i % 2 == 0 { 4 } else { 0 })) & 0x0f;
        s.push(if c.is_ascii_alphabetic() && nibble >= 8 { c.to_ascii_uppercase() } else { c });
    }
    s
}

/// A signature with its recovery parity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecoverableSignature {
    /// r, 32 bytes big-endian.
    pub r: [u8; 32],
    /// s, 32 bytes big-endian (low-S).
    pub s: [u8; 32],
    /// 0 or 1.
    pub y_parity: u8,
}

impl RecoverableSignature {
    /// `v` as legacy signatures and permits carry it: 27 or 28.
    pub fn v(&self) -> u8 {
        27 + self.y_parity
    }

    /// The 65 bytes `r || s || v`, as viem's `signTypedData` returns them.
    pub fn to_rsv(&self) -> [u8; 65] {
        let mut out = [0u8; 65];
        out[..32].copy_from_slice(&self.r);
        out[32..64].copy_from_slice(&self.s);
        out[64] = self.v();
        out
    }
}

/// A Base key. Printing it (`{:?}`) shows the address only; the key is wiped
/// from memory when it is dropped.
pub struct EvmKey {
    signing: SigningKey,
    address: [u8; 20],
}

impl EvmKey {
    /// The key of 32 private-key bytes; refused (`KEY_FILE`) when they are
    /// not a valid secp256k1 key.
    pub fn from_private_key(private_key: &[u8; 32]) -> Result<Self> {
        let signing = SigningKey::from_slice(private_key).map_err(|_| Error::new("KEY_FILE", "not a valid secp256k1 key"))?;
        let point = signing.verifying_key().to_encoded_point(false);
        let hash = keccak256(&point.as_bytes()[1..]);
        let mut address = [0u8; 20];
        address.copy_from_slice(&hash[12..]);
        Ok(Self { signing, address })
    }

    /// The address bytes.
    pub fn address(&self) -> [u8; 20] {
        self.address
    }

    /// The EIP-55 checksummed address.
    pub fn address_checksummed(&self) -> String {
        checksum_address(&self.address)
    }

    /// The lowercase address.
    pub fn address_lower(&self) -> String {
        let mut s = String::from("0x");
        s.push_str(&hex::encode(self.address));
        s
    }

    /// Sign a 32-byte hash.
    pub fn sign_hash(&self, hash: &[u8; 32]) -> Result<RecoverableSignature> {
        let (sig, recid) = self.signing.sign_prehash_recoverable(hash).map_err(|_| Error::new("SIGN", "the hash could not be signed"))?;
        let bytes = sig.to_bytes();
        let mut r = [0u8; 32];
        let mut s = [0u8; 32];
        r.copy_from_slice(&bytes[..32]);
        s.copy_from_slice(&bytes[32..]);
        Ok(RecoverableSignature { r, s, y_parity: recid.to_byte() & 1 })
    }
}

impl fmt::Debug for EvmKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EvmKey").field("address", &self.address_checksummed()).finish_non_exhaustive()
    }
}
