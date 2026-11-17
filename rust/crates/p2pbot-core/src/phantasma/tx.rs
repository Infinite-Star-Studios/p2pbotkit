//! Phantasma transactions, serialized as `phantasma-sdk-ts` does: nexus and
//! chain names, the script, the expiry (seconds, 4 bytes little-endian) and
//! the payload, each length-prefixed; a signed transaction adds the count of
//! its signatures and each one (kind 1, Ed25519, then its 64 bytes).

use alloc::string::String;
use alloc::vec::Vec;

use crate::error::{Error, Result};
use crate::phantasma::keys::PhaKeys;
use crate::phantasma::script::{latin1, write_var_int};

/// The signature kind of Ed25519.
pub const SIGNATURE_ED25519: u8 = 1;

/// A transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transaction {
    /// Nexus name (`mainnet`, `testnet`).
    pub nexus: String,
    /// Chain name (`main`).
    pub chain: String,
    /// The script.
    pub script: Vec<u8>,
    /// Expiry, Unix seconds.
    pub expiration: u32,
    /// Payload bytes (the escrow transactions carry their label).
    pub payload: Vec<u8>,
    /// Ed25519 signatures.
    pub signatures: Vec<[u8; 64]>,
}

impl Transaction {
    /// An unsigned transaction that expires at `expires_at_ms` (Unix ms,
    /// truncated to seconds). Refuses an expiry past 2038, which the SDK
    /// would write wrapped around.
    pub fn new(nexus: &str, chain: &str, script: Vec<u8>, expires_at_ms: u64, payload: Vec<u8>) -> Result<Self> {
        let secs = expires_at_ms / 1000;
        if secs > i32::MAX as u64 {
            return Err(Error::bad_input("The expiry is past what a transaction can carry"));
        }
        Ok(Self { nexus: String::from(nexus), chain: String::from(chain), script, expiration: secs as u32, payload, signatures: Vec::new() })
    }

    /// The bytes that are signed (`with_signatures == false`) or sent.
    pub fn to_bytes(&self, with_signatures: bool) -> Result<Vec<u8>> {
        let mut w = Vec::with_capacity(self.script.len() + 128);
        for name in [&self.nexus, &self.chain] {
            let b = latin1(name)?;
            write_var_int(&mut w, b.len() as u64);
            w.extend_from_slice(&b);
        }
        write_var_int(&mut w, self.script.len() as u64);
        w.extend_from_slice(&self.script);
        w.extend_from_slice(&self.expiration.to_le_bytes());
        write_var_int(&mut w, self.payload.len() as u64);
        w.extend_from_slice(&self.payload);
        if with_signatures {
            write_var_int(&mut w, self.signatures.len() as u64);
            for sig in &self.signatures {
                w.push(SIGNATURE_ED25519);
                write_var_int(&mut w, 64);
                w.extend_from_slice(sig);
            }
        }
        Ok(w)
    }

    /// Sign with `keys` (adds one signature over the unsigned bytes).
    pub fn sign(&mut self, keys: &PhaKeys) -> Result<()> {
        let msg = self.to_bytes(false)?;
        self.signatures.push(keys.sign(&msg));
        Ok(())
    }

    /// The signed transaction as the node takes it (`sendRawTransaction`): uppercase hex.
    pub fn signed_hex(&self) -> Result<String> {
        Ok(hex::encode_upper(self.to_bytes(true)?))
    }
}
