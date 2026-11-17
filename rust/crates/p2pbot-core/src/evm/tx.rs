//! EIP-1559 transactions as the kit sends them (`src/base.ts` `serializable`
//! and viem): value 0, an empty access list, `0x02 || rlp([...])`.

use alloc::vec::Vec;

use crate::error::Result;
use crate::evm::keys::{keccak256, EvmKey, RecoverableSignature};

/// An EIP-1559 transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Eip1559 {
    /// EIP-155 chain id.
    pub chain_id: u64,
    /// Sender's nonce.
    pub nonce: u64,
    /// Priority fee per gas, wei.
    pub max_priority_fee_per_gas: u128,
    /// Max fee per gas, wei.
    pub max_fee_per_gas: u128,
    /// Gas limit.
    pub gas: u64,
    /// Recipient.
    pub to: [u8; 20],
    /// Value, wei (the kit always sends 0).
    pub value: u128,
    /// Call data.
    pub data: Vec<u8>,
}

/// RLP of a byte string.
fn rlp_bytes(out: &mut Vec<u8>, b: &[u8]) {
    if b.len() == 1 && b[0] < 0x80 {
        out.push(b[0]);
    } else {
        rlp_len(out, b.len(), 0x80);
        out.extend_from_slice(b);
    }
}

fn rlp_len(out: &mut Vec<u8>, len: usize, base: u8) {
    if len <= 55 {
        out.push(base + len as u8);
    } else {
        let be = (len as u64).to_be_bytes();
        let skip = be.iter().take_while(|&&x| x == 0).count();
        out.push(base + 55 + (8 - skip) as u8);
        out.extend_from_slice(&be[skip..]);
    }
}

/// RLP of an unsigned integer: minimal big-endian bytes (0 is the empty string).
fn rlp_uint(out: &mut Vec<u8>, v: u128) {
    let be = v.to_be_bytes();
    let skip = be.iter().take_while(|&&x| x == 0).count();
    rlp_bytes(out, &be[skip..]);
}

/// RLP of a 32-byte big-endian integer, leading zeros dropped.
fn rlp_word(out: &mut Vec<u8>, w: &[u8; 32]) {
    let skip = w.iter().take_while(|&&x| x == 0).count();
    rlp_bytes(out, &w[skip..]);
}

impl Eip1559 {
    fn fields(&self) -> Vec<u8> {
        let mut f = Vec::with_capacity(self.data.len() + 96);
        rlp_uint(&mut f, u128::from(self.chain_id));
        rlp_uint(&mut f, u128::from(self.nonce));
        rlp_uint(&mut f, self.max_priority_fee_per_gas);
        rlp_uint(&mut f, self.max_fee_per_gas);
        rlp_uint(&mut f, u128::from(self.gas));
        rlp_bytes(&mut f, &self.to);
        rlp_uint(&mut f, self.value);
        rlp_bytes(&mut f, &self.data);
        f.push(0xc0); // empty access list
        f
    }

    fn envelope(payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(payload.len() + 10);
        out.push(0x02);
        rlp_len(&mut out, payload.len(), 0xc0);
        out.extend_from_slice(payload);
        out
    }

    /// The unsigned transaction (what is hashed for signing).
    pub fn unsigned_bytes(&self) -> Vec<u8> {
        Self::envelope(&self.fields())
    }

    /// The transaction with a signature, as it is broadcast.
    pub fn with_signature(&self, sig: &RecoverableSignature) -> Vec<u8> {
        let mut f = self.fields();
        rlp_uint(&mut f, u128::from(sig.y_parity));
        rlp_word(&mut f, &sig.r);
        rlp_word(&mut f, &sig.s);
        Self::envelope(&f)
    }

    /// Sign with `key`: the broadcast bytes.
    pub fn sign(&self, key: &EvmKey) -> Result<Vec<u8>> {
        let sig = key.sign_hash(&keccak256(&self.unsigned_bytes()))?;
        Ok(self.with_signature(&sig))
    }
}

/// The hash of a signed transaction (its id on Base).
pub fn tx_hash(signed: &[u8]) -> [u8; 32] {
    keccak256(signed)
}
