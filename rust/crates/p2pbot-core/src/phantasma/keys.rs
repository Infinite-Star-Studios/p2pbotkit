//! Phantasma keys (Ed25519), their WIF and their addresses.
//!
//! - A WIF is base58 of `0x80`, the 32 key bytes, `0x01` and the first 4
//!   bytes of the double SHA-256 of those 34 bytes. The kit checks the
//!   checksum before it reads a key (`src/keys.ts` `wifOk`), so a typo can
//!   never give another, unfunded key; [`PhaKeys::from_wif`] does the same.
//! - An address is 34 bytes: kind 1 (user), a 0 byte and the 32-byte public
//!   key; its text is `P` + base58 of those bytes.

use alloc::string::String;
use alloc::vec::Vec;
use core::fmt;

use ed25519_dalek::{Signer, SigningKey};
use zeroize::{Zeroize, Zeroizing};

use crate::codec::sha256;
use crate::error::{Error, Result};

/// Bytes in an address.
pub const ADDRESS_LEN: usize = 34;

/// The null address (`Address.Null`): 34 zero bytes.
pub const NULL_ADDRESS: [u8; ADDRESS_LEN] = [0u8; ADDRESS_LEN];

const B58: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

fn is_b58(c: u8) -> bool {
    B58.contains(&c)
}

/// The address bytes of a user's public key.
pub fn address_bytes_of_public_key(public_key: &[u8; 32]) -> [u8; ADDRESS_LEN] {
    let mut b = [0u8; ADDRESS_LEN];
    b[0] = 1;
    b[2..].copy_from_slice(public_key);
    b
}

/// The text of address bytes: `NULL`, or `P` (user), `X` (interop) or `S`
/// (system) followed by base58 of the 34 bytes.
pub fn address_text(bytes: &[u8; ADDRESS_LEN]) -> String {
    if bytes.iter().all(|&b| b == 0) {
        return String::from("NULL");
    }
    let prefix = match bytes[0] {
        1 => 'P',
        3 => 'X',
        _ => 'S',
    };
    let mut s = String::new();
    s.push(prefix);
    s.push_str(&bs58::encode(bytes).into_string());
    s
}

/// The address text of a user's public key.
pub fn address_of_public_key(public_key: &[u8; 32]) -> String {
    address_text(&address_bytes_of_public_key(public_key))
}

/// Whether `s` has the shape of a user address: `^P2K[base58]{40,50}$`.
pub fn is_user_address_text(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 43 && b.len() <= 53 && b.starts_with(b"P2K") && b[3..].iter().all(|&c| is_b58(c))
}

/// Whether `wif` is a well formed WIF of a compressed key, checksum included.
pub fn wif_ok(wif: &str) -> bool {
    let b = wif.as_bytes();
    if b.len() != 52 || !(b[0] == b'K' || b[0] == b'L') || !b.iter().all(|&c| is_b58(c)) {
        return false;
    }
    let raw = match bs58::decode(wif).into_vec() {
        Ok(v) => Zeroizing::new(v),
        Err(_) => return false,
    };
    if raw.len() != 38 || raw[0] != 0x80 || raw[33] != 0x01 {
        return false;
    }
    let check = sha256(&sha256(&raw[..34]));
    check[..4] == raw[34..38]
}

/// The WIF of a private key.
pub fn wif_of(private_key: &[u8; 32]) -> String {
    let mut body: Zeroizing<Vec<u8>> = Zeroizing::new(Vec::with_capacity(38));
    body.push(0x80);
    body.extend_from_slice(private_key);
    body.push(0x01);
    let check = sha256(&sha256(&body));
    body.extend_from_slice(&check[..4]);
    bs58::encode(body.as_slice()).into_string()
}

/// A Phantasma key pair. Printing it (`{:?}`) shows the address only; the
/// private key is wiped from memory when it is dropped.
pub struct PhaKeys {
    signing: SigningKey,
    public_key: [u8; 32],
    address: String,
}

impl PhaKeys {
    /// The key pair of a 32-byte private key.
    pub fn from_private_key(private_key: &[u8; 32]) -> Self {
        let signing = SigningKey::from_bytes(private_key);
        let public_key = signing.verifying_key().to_bytes();
        let address = address_of_public_key(&public_key);
        Self { signing, public_key, address }
    }

    /// The key pair of a WIF, refused (`KEY_FILE`) unless its shape and
    /// checksum are right.
    pub fn from_wif(wif: &str) -> Result<Self> {
        if !wif_ok(wif) {
            return Err(Error::new("KEY_FILE", "not a valid Phantasma WIF (its checksum or shape is wrong)"));
        }
        let raw = Zeroizing::new(bs58::decode(wif).into_vec().map_err(|_| Error::new("KEY_FILE", "not a valid Phantasma WIF"))?);
        let mut sk = [0u8; 32];
        sk.copy_from_slice(&raw[1..33]);
        let keys = Self::from_private_key(&sk);
        sk.zeroize();
        Ok(keys)
    }

    /// The 32-byte Ed25519 public key.
    pub fn public_key(&self) -> &[u8; 32] {
        &self.public_key
    }

    /// The address text (`P2K…`).
    pub fn address(&self) -> &str {
        &self.address
    }

    /// The address bytes.
    pub fn address_bytes(&self) -> [u8; ADDRESS_LEN] {
        address_bytes_of_public_key(&self.public_key)
    }

    /// The key as a WIF, for writing a key file.
    pub fn to_wif(&self) -> Zeroizing<String> {
        Zeroizing::new(wif_of(&self.signing.to_bytes()))
    }

    /// An Ed25519 signature of `message`.
    pub fn sign(&self, message: &[u8]) -> [u8; 64] {
        self.signing.sign(message).to_bytes()
    }
}

impl fmt::Debug for PhaKeys {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PhaKeys").field("address", &self.address).finish_non_exhaustive()
    }
}
