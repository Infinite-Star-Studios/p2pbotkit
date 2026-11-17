//! The store's encryption at rest (`KIT_STORE_KEY_FILE`), ported from
//! `src/store.ts`: AES-256-GCM with a 12-byte IV and a full 16-byte tag, and
//! the file's place bound in as associated data
//! (`saturn-p2p-bot-kit|v1|<network>|<kind>/<name>.json`), so a sealed file
//! cannot be moved to another record or network unnoticed. A sealed file is
//! `{"sealed":"aes-256-gcm","v":1,"iv":…,"tag":…,"data":…}` (base64 fields).
//!
//! Files sealed by the TypeScript kit open here and the other way round
//! (checked against files the kit's own store wrote).

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use zeroize::Zeroizing;

use crate::error::{Error, Result};
use crate::pins::Network;

/// IV bytes.
pub const IV_BYTES: usize = 12;
/// Tag bytes; a shorter tag is refused.
pub const TAG_BYTES: usize = 16;
/// The store kinds that are sealed when a key is set.
pub const SEALED_KINDS: [&str; 4] = ["pending", "offers", "trades", "secrets"];

/// The associated data of one file.
pub fn aad(network: Network, rel: &str) -> String {
    format!("saturn-p2p-bot-kit|v1|{}|{}", network.name(), rel)
}

/// A sealed value (the three base64 fields of a sealed file).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sealed {
    /// IV, base64.
    pub iv: String,
    /// Tag, base64.
    pub tag: String,
    /// Ciphertext, base64.
    pub data: String,
}

impl Sealed {
    /// The file text, as the kit writes it (one line of JSON and a newline).
    pub fn to_file_text(&self) -> String {
        format!("{{\"sealed\":\"aes-256-gcm\",\"v\":1,\"iv\":\"{}\",\"tag\":\"{}\",\"data\":\"{}\"}}\n", self.iv, self.tag, self.data)
    }
}

/// Seal `plain` for the file `rel` (`<kind>/<name>.json`) of `network`.
/// `iv` must be 12 fresh random bytes, never reused with the same key.
pub fn seal(key: &[u8; 32], network: Network, rel: &str, plain: &[u8], iv: [u8; IV_BYTES]) -> Result<Sealed> {
    let cipher = Aes256Gcm::new(key.into());
    let a = aad(network, rel);
    let mut out = cipher
        .encrypt(Nonce::from_slice(&iv), Payload { msg: plain, aad: a.as_bytes() })
        .map_err(|_| Error::new("STORE_KEY", "the record could not be sealed"))?;
    let tag = out.split_off(out.len() - TAG_BYTES);
    Ok(Sealed { iv: B64.encode(iv), tag: B64.encode(tag), data: B64.encode(&out) })
}

/// Open a sealed value of the file `rel`; refused unless the IV is exactly
/// 12 bytes, the tag a full 16 and both the key and the place are right.
pub fn unseal(key: &[u8; 32], network: Network, rel: &str, sealed: &Sealed) -> Result<Zeroizing<Vec<u8>>> {
    let malformed = || Error::new("STORE_CORRUPT", "malformed seal");
    let iv = B64.decode(&sealed.iv).map_err(|_| malformed())?;
    let tag = B64.decode(&sealed.tag).map_err(|_| malformed())?;
    let mut data = B64.decode(&sealed.data).map_err(|_| malformed())?;
    if iv.len() != IV_BYTES || tag.len() != TAG_BYTES {
        return Err(malformed());
    }
    data.extend_from_slice(&tag);
    let cipher = Aes256Gcm::new(key.into());
    let a = aad(network, rel);
    cipher
        .decrypt(Nonce::from_slice(&iv), Payload { msg: &data, aad: a.as_bytes() })
        .map(Zeroizing::new)
        .map_err(|_| Error::new("STORE_KEY", "the store key is not the key this file was sealed with, or the file was changed"))
}

/// The store key from its key file's bytes: exactly 32 raw bytes, or 64 hex
/// digits (white space around them allowed).
pub fn store_key_from_file(bytes: &[u8]) -> Result<Zeroizing<[u8; 32]>> {
    let mut key = Zeroizing::new([0u8; 32]);
    if bytes.len() == 32 {
        key.copy_from_slice(bytes);
        return Ok(key);
    }
    let bad = || Error::new("STORE_KEY", "The store key file must hold exactly 32 bytes (raw, or as 64 hex digits).");
    let text = core::str::from_utf8(bytes).map_err(|_| bad())?.trim();
    if text.len() != 64 || !text.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(bad());
    }
    hex::decode_to_slice(text, &mut key[..]).map_err(|_| bad())?;
    Ok(key)
}
