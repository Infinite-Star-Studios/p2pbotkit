//! The little ABI encoding the kit's calls need: a 4-byte selector, then
//! static 32-byte words (no dynamic types appear in any call the kit sends).

use alloc::vec::Vec;

use crate::evm::keys::keccak256;

/// The selector of a canonical function signature, e.g. `claim(bytes32,address)`.
pub fn selector(signature: &str) -> [u8; 4] {
    let h = keccak256(signature.as_bytes());
    [h[0], h[1], h[2], h[3]]
}

/// An unsigned integer as one word.
pub fn uint(v: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&v.to_be_bytes());
    w
}

/// An address as one word.
pub fn address(a: &[u8; 20]) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a);
    w
}

/// Call data: selector, then the words.
pub fn encode_call(signature: &str, words: &[[u8; 32]]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + 32 * words.len());
    out.extend_from_slice(&selector(signature));
    for w in words {
        out.extend_from_slice(w);
    }
    out
}
