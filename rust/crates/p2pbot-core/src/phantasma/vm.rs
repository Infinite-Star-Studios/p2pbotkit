//! Reading a Phantasma node's answers: VM values, and the kit's readings of
//! them (`viewInt`, `viewSmallInt`, `viewAddress`, `viewText` in `src/pha.ts`).
//!
//! The decoder is **strict**. Every well-formed answer reads exactly as the
//! kit reads it (checked against the 164 decode answers of
//! `test/fixtures/sdk-vectors.json`, recorded devnet answers included). An
//! answer that is cut short, has bytes left over, nests too deep or has a
//! type the kit does not read gives **no value**. The kit's SDK pads a
//! cut-short string with NUL characters, reads a bool with no byte as true
//! and a number of no bytes as 0; here they are refused, so a gap can only
//! ever stop a step (the kit's readers refuse a missing value), never pass
//! as a reading.

use alloc::string::{String, ToString};
use alloc::vec::Vec;

use crate::codec::js_trim;
use crate::phantasma::keys::{address_text, ADDRESS_LEN};

/// VM types.
pub mod vm_type {
    /// A struct of key/value pairs.
    pub const STRUCT: u8 = 1;
    /// A number (two's complement, little-endian).
    pub const NUMBER: u8 = 3;
    /// A string (one byte per character).
    pub const STRING: u8 = 4;
    /// A bool.
    pub const BOOL: u8 = 6;
    /// An enum.
    pub const ENUM: u8 = 7;
    /// An object: raw bytes (an address, a hash).
    pub const OBJECT: u8 = 8;
}

/// How deep structs may nest before an answer is refused.
pub const MAX_DEPTH: usize = 16;

/// JavaScript's `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE: u64 = (1 << 53) - 1;

/// One decoded VM value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VmValue {
    /// A string; each byte is one character (U+0000 to U+00FF).
    Str(String),
    /// A number, as decimal text (negative when its two's complement says so).
    Num(String),
    /// A bool.
    Bool(bool),
    /// An enum.
    Enum(u64),
    /// An object's bytes, as the hex text the node sent (its case kept).
    Obj(String),
    /// A struct's fields, in JavaScript's order for an object's keys:
    /// integer keys first, ascending, then the others as they came.
    Struct(Vec<(String, VmValue)>),
}

impl VmValue {
    /// The value as JavaScript's `String(v)` gives it (the text the kit's readers start from).
    pub fn js_string(&self) -> String {
        match self {
            VmValue::Str(s) | VmValue::Num(s) | VmValue::Obj(s) => s.clone(),
            VmValue::Bool(b) => (if *b { "true" } else { "false" }).to_string(),
            VmValue::Enum(n) => n.to_string(),
            VmValue::Struct(_) => "[object Object]".to_string(),
        }
    }
}

struct Reader<'a> {
    hex: &'a str,
    bytes: Vec<u8>,
    pos: usize,
    /// An enum was read: anything after it in this answer is refused (see `ENUM`).
    after_enum: bool,
}

fn decode_hex(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) || !hex.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    hex::decode(hex).ok()
}

/// Whether `k` is an array index as JavaScript orders object keys: the
/// canonical decimal text of an integer from 0 to 2^32 - 2.
fn array_index(k: &str) -> Option<u32> {
    let b = k.as_bytes();
    if b.is_empty() || b.len() > 10 || !b.iter().all(u8::is_ascii_digit) || (b.len() > 1 && b[0] == b'0') {
        return None;
    }
    let n: u64 = k.parse().ok()?;
    (n < u64::from(u32::MAX)).then_some(n as u32)
}

impl<'a> Reader<'a> {
    fn new(hex: &'a str) -> Option<Self> {
        Some(Self { hex, bytes: decode_hex(hex)?, pos: 0, after_enum: false })
    }

    fn done(&self) -> bool {
        self.pos == self.bytes.len()
    }

    fn u8(&mut self) -> Option<u8> {
        let b = *self.bytes.get(self.pos)?;
        self.pos += 1;
        Some(b)
    }

    fn take(&mut self, n: u64) -> Option<(usize, usize)> {
        let n = usize::try_from(n).ok()?;
        let end = self.pos.checked_add(n)?;
        if end > self.bytes.len() {
            return None;
        }
        let start = self.pos;
        self.pos = end;
        Some((start, end))
    }

    fn var_int(&mut self) -> Option<u64> {
        let first = self.u8()?;
        let width = match first {
            0xfd => 2,
            0xfe => 4,
            0xff => 8,
            n => return Some(u64::from(n)),
        };
        let (s, e) = self.take(width)?;
        Some(self.bytes[s..e].iter().rev().fold(0u64, |acc, &b| (acc << 8) | u64::from(b)))
    }

    fn value(&mut self, depth: usize) -> Option<VmValue> {
        if self.after_enum {
            return None;
        }
        match self.u8()? {
            vm_type::STRING => {
                let n = self.var_int()?;
                let (s, e) = self.take(n)?;
                Some(VmValue::Str(self.bytes[s..e].iter().map(|&c| char::from(c)).collect()))
            }
            vm_type::NUMBER => {
                let n = self.var_int()?;
                if n == 0 {
                    return None;
                }
                let (s, e) = self.take(n)?;
                Some(VmValue::Num(twos_complement_le_to_decimal(&self.bytes[s..e])))
            }
            vm_type::BOOL => Some(VmValue::Bool(self.u8()? != 0)),
            vm_type::ENUM => {
                // The VM writes an enum as 4 little-endian bytes (the SDK's
                // emitLoadEnum too), but the kit's SDK reads it as a variable
                // integer: its first byte, leaving 3 bytes that it then reads
                // as whatever follows. Accept only the enums both read alike
                // (below 0xFD), and nothing after one in the same answer.
                let (s, e) = self.take(4)?;
                let b = &self.bytes[s..e];
                self.after_enum = true;
                (b[0] < 0xfd && b[1..].iter().all(|&x| x == 0)).then_some(VmValue::Enum(u64::from(b[0])))
            }
            vm_type::OBJECT => {
                let n = self.var_int()?;
                let (s, e) = self.take(n)?;
                Some(VmValue::Obj(self.hex[s * 2..e * 2].to_string()))
            }
            vm_type::STRUCT => {
                if depth >= MAX_DEPTH {
                    return None;
                }
                let n = self.var_int()?;
                let mut fields: Vec<(String, VmValue)> = Vec::new();
                for _ in 0..n {
                    let key = self.value(depth + 1)?.js_string();
                    let value = self.value(depth + 1)?;
                    // `res[key] = value` on a plain object: `__proto__` sets no own
                    // key; a repeated key keeps its place and takes the new value.
                    if key == "__proto__" {
                        continue;
                    }
                    match fields.iter_mut().find(|(k, _)| *k == key) {
                        Some(f) => f.1 = value,
                        None => fields.push((key, value)),
                    }
                }
                let (mut idx, rest): (Vec<_>, Vec<_>) = fields.into_iter().partition(|(k, _)| array_index(k).is_some());
                idx.sort_by_key(|(k, _)| array_index(k));
                idx.extend(rest);
                Some(VmValue::Struct(idx))
            }
            _ => None,
        }
    }
}

/// Little-endian two's complement to decimal text.
fn twos_complement_le_to_decimal(le: &[u8]) -> String {
    let negative = le.last().is_some_and(|b| b & 0x80 != 0);
    // Magnitude, big-endian: the bytes as they are, or their two's complement when negative.
    let mut be: Vec<u8> = le.iter().rev().copied().collect();
    if negative {
        let mut carry = true;
        for b in be.iter_mut().rev() {
            let (v, c) = (!*b).overflowing_add(u8::from(carry));
            *b = v;
            carry = c;
        }
    }
    let digits = be_to_decimal(&be);
    if negative && digits != "0" {
        let mut s = String::from("-");
        s.push_str(&digits);
        s
    } else {
        digits
    }
}

/// A big-endian unsigned integer of any length as decimal text.
fn be_to_decimal(be: &[u8]) -> String {
    let mut n: Vec<u8> = be.iter().copied().skip_while(|&b| b == 0).collect();
    if n.is_empty() {
        return String::from("0");
    }
    let mut digits = Vec::new();
    while !n.is_empty() {
        let mut rem = 0u32;
        for b in n.iter_mut() {
            let cur = (rem << 8) | u32::from(*b);
            *b = (cur / 10) as u8;
            rem = cur % 10;
        }
        digits.push(b'0' + rem as u8);
        let lead = n.iter().take_while(|&&b| b == 0).count();
        n.drain(..lead);
    }
    digits.iter().rev().map(|&d| char::from(d)).collect()
}

/// One answer value (`invokeRawScript`'s `results[i]`), or `None` when it does not decode.
pub fn decode_value(hex: &str) -> Option<VmValue> {
    let mut r = Reader::new(hex)?;
    let v = r.value(0)?;
    r.done().then_some(v)
}

/// `n` values read one after another from one answer (`result`). After a
/// value that does not decode, the rest give no value either.
pub fn decode_stream(hex: &str, n: usize) -> Vec<Option<VmValue>> {
    let mut out = Vec::with_capacity(n);
    let mut reader = Reader::new(hex);
    for _ in 0..n {
        let v = reader.as_mut().and_then(|r| r.value(0));
        if v.is_none() {
            reader = None;
        }
        out.push(v);
    }
    out
}

/// The kit's `decodeViews`: one value per call from a node's answer to a
/// script of `n` calls. `results` (one hex per call) is used when it holds
/// at least `n` entries; else `result` is read as one stream of `n` values.
pub fn decode_views(results: Option<&[Option<String>]>, result: Option<&str>, n: usize) -> Vec<Option<VmValue>> {
    if let Some(rs) = results {
        if rs.len() >= n {
            return rs[..n].iter().map(|h| h.as_deref().filter(|h| !h.is_empty()).and_then(decode_value)).collect();
        }
    }
    match result.filter(|h| !h.is_empty()) {
        Some(h) => decode_stream(h, n),
        None => alloc::vec![None; n],
    }
}

/// The kit's `viewInt`: an unsigned integer answer, as decimal text without
/// leading zeros (up to 78 digits), or `None` (the kit throws).
pub fn view_int(v: Option<&VmValue>) -> Option<String> {
    let s = match v? {
        VmValue::Enum(n) => return Some(n.to_string()),
        VmValue::Str(s) | VmValue::Num(s) | VmValue::Obj(s) => js_trim(s),
        VmValue::Bool(_) | VmValue::Struct(_) => return None,
    };
    if s.is_empty() || s.len() > 78 || !s.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let t = s.trim_start_matches('0');
    Some(if t.is_empty() { "0".to_string() } else { t.to_string() })
}

/// The kit's `viewSmallInt`: `view_int` within JavaScript's safe integers.
pub fn view_small_int(v: Option<&VmValue>) -> Option<u64> {
    view_int(v)?.parse::<u64>().ok().filter(|&n| n <= MAX_SAFE)
}

/// `view_int` as a `u128` (refused when larger).
pub fn view_u128(v: Option<&VmValue>) -> Option<u128> {
    view_int(v)?.parse::<u128>().ok()
}

fn is_b58(c: u8) -> bool {
    c.is_ascii_alphanumeric() && !matches!(c, b'0' | b'O' | b'I' | b'l')
}

/// The kit's `viewAddress`: an address text as it is, or the 34 address
/// bytes as hex (68 digits, with a 2-digit length prefix, or 66 digits that
/// lost a leading 00); `""` for anything else.
pub fn view_address(v: Option<&VmValue>) -> String {
    let Some(v) = v else { return String::new() };
    let text = v.js_string();
    let s = js_trim(&text);
    let b = s.as_bytes();
    if (21..=61).contains(&b.len()) && matches!(b[0], b'P' | b'S' | b'X') && b[1..].iter().all(|&c| is_b58(c)) {
        return s.to_string();
    }
    if b.is_empty() || !b.iter().all(u8::is_ascii_hexdigit) {
        return String::new();
    }
    let mut tries: Vec<String> = Vec::new();
    if b.len() == 68 {
        tries.push(s.to_string());
    }
    if b.len() >= 70 {
        tries.push(s[s.len() - 68..].to_string());
        tries.push(s[2..].to_string());
    }
    if b.len() == 66 {
        let mut t = String::from("00");
        t.push_str(s);
        tries.push(t);
    }
    for t in tries {
        let mut bytes = [0u8; ADDRESS_LEN];
        if hex::decode_to_slice(&t[..68], &mut bytes).is_err() || bytes.iter().all(|&x| x == 0) {
            continue;
        }
        return address_text(&bytes);
    }
    String::new()
}

/// The kit's `viewText`: a string answer with NUL characters removed (never case-folded).
pub fn view_text(v: Option<&VmValue>) -> String {
    v.map(|v| v.js_string().replace('\0', "")).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers() {
        assert_eq!(decode_value("030100"), Some(VmValue::Num("0".into())));
        assert_eq!(decode_value("0302ff00"), Some(VmValue::Num("255".into())));
        assert_eq!(decode_value("0301ff"), Some(VmValue::Num("-1".into())));
        assert_eq!(decode_value("030180"), Some(VmValue::Num("-128".into())));
        // Cut short, empty or with bytes left over: no value.
        assert_eq!(decode_value("03"), None);
        assert_eq!(decode_value("0300"), None);
        assert_eq!(decode_value("030100ff"), None);
    }

    #[test]
    fn strings_and_bools() {
        assert_eq!(decode_value("0403534f55"), Some(VmValue::Str("SOU".into())));
        assert_eq!(decode_value("0405aa"), None);
        assert_eq!(decode_value("0601"), Some(VmValue::Bool(true)));
        assert_eq!(decode_value("06"), None);
    }

    #[test]
    fn view_int_rules() {
        assert_eq!(view_int(Some(&VmValue::Num(" 007 ".into()))), Some("7".into()));
        assert_eq!(view_int(Some(&VmValue::Num("-1".into()))), None);
        assert_eq!(view_int(Some(&VmValue::Bool(true))), None);
        assert_eq!(view_int(None), None);
        assert_eq!(view_small_int(Some(&VmValue::Num("9007199254740992".into()))), None);
    }
}
