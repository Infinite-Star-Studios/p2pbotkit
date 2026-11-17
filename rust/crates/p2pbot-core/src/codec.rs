//! The swap secret, its hash, control tokens and the number forms of the
//! chains: a port of the kit's `src/codec.ts`.
//!
//! - A secret is exactly 32 random bytes; `h` is their SHA-256.
//! - Base takes both as `bytes32`; Phantasma takes the same 32 bytes read as
//!   an unsigned big-endian integer, as a **decimal** string (its VM reverses
//!   hex strings).
//! - A control token is 32 random bytes as 64 lowercase hex. The board keeps
//!   the SHA-256 of that 64-character *string*, never of the raw bytes.
//!
//! Inside the kit, secrets and hashes are `0x` + 64 lowercase hex.

use alloc::string::String;
use alloc::vec::Vec;
use core::fmt::Write;

use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use crate::error::{Error, Result};

/// SHA-256 of `data`.
pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

/// Whether `s` is `0x` followed by exactly 64 hex characters (any case).
pub fn is_hex32(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 66 && b[0] == b'0' && b[1] == b'x' && b[2..].iter().all(u8::is_ascii_hexdigit)
}

/// `0x` + 64 hex (any case) to 32 bytes.
pub fn hex32_to_bytes(s: &str) -> Result<[u8; 32]> {
    if !is_hex32(s) {
        return Err(Error::bad_input("Expected 0x and 64 hex characters"));
    }
    let mut out = [0u8; 32];
    hex::decode_to_slice(&s[2..], &mut out).map_err(|_| Error::bad_input("Expected 0x and 64 hex characters"))?;
    Ok(out)
}

/// 32 bytes to `0x` + 64 lowercase hex.
pub fn bytes_to_hex32(b: &[u8; 32]) -> String {
    let mut s = String::with_capacity(66);
    s.push_str("0x");
    s.push_str(&hex::encode(b));
    s
}

/// `0x` + 64 hex to the decimal string a Phantasma `number` argument takes.
pub fn hex_to_decimal(s: &str) -> Result<String> {
    let mut bytes = hex32_to_bytes(s)?;
    let out = be_to_decimal(&bytes);
    bytes.zeroize();
    Ok(out)
}

/// A big-endian unsigned integer (a multiple of 4 bytes long) as decimal text.
fn be_to_decimal(bytes: &[u8; 32]) -> String {
    let mut limbs = [0u32; 8];
    for (i, c) in bytes.chunks_exact(4).enumerate() {
        limbs[i] = u32::from_be_bytes([c[0], c[1], c[2], c[3]]);
    }
    // Divide by 10^9 until nothing is left; each remainder is 9 digits.
    let mut parts: Vec<u32> = Vec::new();
    while limbs.iter().any(|&l| l != 0) {
        let mut rem: u64 = 0;
        for l in limbs.iter_mut() {
            let cur = (rem << 32) | u64::from(*l);
            *l = (cur / 1_000_000_000) as u32;
            rem = cur % 1_000_000_000;
        }
        parts.push(rem as u32);
    }
    let mut s = String::new();
    match parts.split_last() {
        None => s.push('0'),
        Some((top, rest)) => {
            let _ = write!(s, "{top}");
            for p in rest.iter().rev() {
                let _ = write!(s, "{p:09}");
            }
        }
    }
    s
}

/// JavaScript's `String.prototype.trim` (which the kit uses): it removes a
/// different set of characters than Rust's `str::trim` (not U+0085, for one).
pub fn js_trim(s: &str) -> &str {
    fn ws(c: char) -> bool {
        matches!(
            c,
            '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
                ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
        )
    }
    s.trim_matches(ws)
}

/// A decimal string from a Phantasma read to `0x` + 64 lowercase hex, or
/// `None` when it is not an unsigned 256-bit integer. White space around it
/// is allowed, as in the kit.
pub fn decimal_to_hex(dec: &str) -> Option<String> {
    let s = js_trim(dec);
    if s.is_empty() || s.len() > 78 || !s.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let mut n = [0u8; 32];
    for c in s.bytes() {
        let mut carry = u32::from(c - b'0');
        for byte in n.iter_mut().rev() {
            let v = u32::from(*byte) * 10 + carry;
            *byte = (v & 0xff) as u8;
            carry = v >> 8;
        }
        if carry != 0 {
            return None;
        }
    }
    Some(bytes_to_hex32(&n))
}

/// `h`: the SHA-256 of the 32 secret bytes, as `0x` + 64 lowercase hex.
pub fn hash_of_secret(secret: &str) -> Result<String> {
    let mut b = hex32_to_bytes(secret)?;
    let h = sha256(&b);
    b.zeroize();
    Ok(bytes_to_hex32(&h))
}

/// Whether `secret` opens `h` (both `0x` + 64 hex, any case). Never fails.
pub fn secret_opens(secret: &str, h: &str) -> bool {
    if !is_hex32(secret) || !is_hex32(h) {
        return false;
    }
    match hash_of_secret(secret) {
        Ok(x) => x.eq_ignore_ascii_case(h),
        Err(_) => false,
    }
}

/// A secret from 32 bytes of the caller's CSPRNG, as `0x` + 64 lowercase hex.
pub fn secret_from_random(mut random: [u8; 32]) -> String {
    let s = bytes_to_hex32(&random);
    random.zeroize();
    s
}

/// Whether `s` is a control token: exactly 64 lowercase hex characters.
pub fn is_control_token(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// A control token from 32 bytes of the caller's CSPRNG (64 lowercase hex).
pub fn control_token_from_random(mut random: [u8; 32]) -> String {
    let s = hex::encode(random);
    random.zeroize();
    s
}

/// What the board keeps for a control token: the lowercase hex SHA-256 of
/// the token's 64 characters. Refuses anything that is not a control token,
/// so a malformed one is never sent.
pub fn token_hash_of(token: &str) -> Result<String> {
    if !is_control_token(token) {
        return Err(Error::bad_input("A control token is 64 lowercase hex characters"));
    }
    Ok(hex::encode(sha256(token.as_bytes())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::string::ToString;

    #[test]
    fn shared_token_vector() {
        // src/codec.ts: 64 x '0' -> 60e05bd1...
        let t = "0".repeat(64);
        assert_eq!(token_hash_of(&t).unwrap(), "60e05bd1b195af2f94112fa7197a5c88289058840ce7c6df9693756bc6250f55");
    }

    #[test]
    fn decimal_round_trip() {
        let max = "0x".to_string() + &"f".repeat(64);
        let d = hex_to_decimal(&max).unwrap();
        assert_eq!(d, "115792089237316195423570985008687907853269984665640564039457584007913129639935");
        assert_eq!(decimal_to_hex(&d).unwrap(), max);
        assert_eq!(decimal_to_hex("115792089237316195423570985008687907853269984665640564039457584007913129639936"), None);
        assert_eq!(hex_to_decimal(&("0x".to_string() + &"0".repeat(64))).unwrap(), "0");
    }
}
