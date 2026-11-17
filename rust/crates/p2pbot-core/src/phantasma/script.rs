//! Phantasma VM scripts: the part of `phantasma-sdk-ts`'s `ScriptBuilder`
//! that the kit uses (contract calls, `AllowGas`, `SpendGas`), byte for byte.
//!
//! A contract call loads each argument into register 0 and pushes it, last
//! argument first; then the method name; then loads the contract name and
//! switches into it (`CTX 0 1`, `SWITCH 1`). A script ends with `RET`.

use alloc::string::{String, ToString};
use alloc::vec::Vec;

use crate::error::{Error, Result};
use crate::phantasma::escrow::PhaCall;
use crate::phantasma::keys::ADDRESS_LEN;

/// VM opcodes the kit's scripts use.
pub mod opcode {
    /// Push a register on the stack.
    pub const PUSH: u8 = 3;
    /// Return.
    pub const RET: u8 = 11;
    /// Load a value into a register.
    pub const LOAD: u8 = 13;
    /// Load a contract's context.
    pub const CTX: u8 = 45;
    /// Switch into a context.
    pub const SWITCH: u8 = 46;
}

/// VM value types the kit's scripts load.
pub mod vm_type {
    /// Raw bytes.
    pub const BYTES: u8 = 2;
    /// A string.
    pub const STRING: u8 = 4;
}

/// The name of the gas contract.
pub const GAS_CONTRACT: &str = "gas";

/// The calls one view script carries; the node refuses a script that is too long.
pub const VIEW_CHUNK: usize = 16;

/// Append a variable-length integer: one byte below `0xFD`, else a marker
/// byte and 2, 4 or 8 little-endian bytes.
pub fn write_var_int(out: &mut Vec<u8>, v: u64) {
    if v < 0xfd {
        out.push(v as u8);
    } else if v <= 0xffff {
        out.push(0xfd);
        out.extend_from_slice(&(v as u16).to_le_bytes());
    } else if v <= 0xffff_ffff {
        out.push(0xfe);
        out.extend_from_slice(&(v as u32).to_le_bytes());
    } else {
        out.push(0xff);
        out.extend_from_slice(&v.to_le_bytes());
    }
}

/// A string as the SDK writes it: one byte per character, so every
/// character must be at most U+00FF (the SDK refuses any other).
pub fn latin1(s: &str) -> Result<Vec<u8>> {
    s.chars().map(|c| u8::try_from(u32::from(c)).map_err(|_| Error::bad_input("A script string holds a character above U+00FF"))).collect()
}

/// One argument of a call.
#[derive(Debug, Clone, Copy)]
pub enum Arg<'a> {
    /// A string (decimal numbers, symbols and address texts are strings).
    Str(&'a str),
    /// An address object (`Address.Null` in `AllowGas`): its serialized bytes.
    Address(&'a [u8; ADDRESS_LEN]),
    /// A number, which the SDK loads as its decimal text.
    Number(u64),
}

/// Builds one script.
#[derive(Debug, Default, Clone)]
pub struct ScriptBuilder {
    buf: Vec<u8>,
}

impl ScriptBuilder {
    /// An empty script.
    pub fn new() -> Self {
        Self::default()
    }

    /// `LOAD reg type len bytes`.
    pub fn load_bytes(&mut self, reg: u8, bytes: &[u8], vm_type: u8) -> Result<&mut Self> {
        if bytes.len() > 0xffff {
            return Err(Error::bad_input("tried to load too much data"));
        }
        self.buf.extend_from_slice(&[opcode::LOAD, reg, vm_type]);
        write_var_int(&mut self.buf, bytes.len() as u64);
        self.buf.extend_from_slice(bytes);
        Ok(self)
    }

    /// Load one argument into `reg`.
    pub fn load(&mut self, reg: u8, arg: &Arg<'_>) -> Result<&mut Self> {
        match arg {
            Arg::Str(s) => {
                let b = latin1(s)?;
                self.load_bytes(reg, &b, vm_type::STRING)
            }
            Arg::Number(n) => {
                let s: String = n.to_string();
                self.load_bytes(reg, s.as_bytes(), vm_type::STRING)
            }
            Arg::Address(a) => {
                let mut b = Vec::with_capacity(ADDRESS_LEN + 1);
                write_var_int(&mut b, ADDRESS_LEN as u64);
                b.extend_from_slice(&a[..]);
                self.load_bytes(reg, &b, vm_type::BYTES)
            }
        }
    }

    /// `PUSH reg`.
    pub fn push(&mut self, reg: u8) -> &mut Self {
        self.buf.extend_from_slice(&[opcode::PUSH, reg]);
        self
    }

    /// Call `method` of `contract` with `args`.
    pub fn call_contract(&mut self, contract: &str, method: &str, args: &[Arg<'_>]) -> Result<&mut Self> {
        for a in args.iter().rev() {
            self.load(0, a)?;
            self.push(0);
        }
        self.load(0, &Arg::Str(method))?;
        self.push(0);
        self.load(0, &Arg::Str(contract))?;
        self.buf.extend_from_slice(&[opcode::CTX, 0, 1, opcode::SWITCH, 1]);
        Ok(self)
    }

    /// `gas.AllowGas(from, to, price, limit)`.
    pub fn allow_gas(&mut self, from: &str, to: &[u8; ADDRESS_LEN], price: u64, limit: u64) -> Result<&mut Self> {
        self.call_contract(GAS_CONTRACT, "AllowGas", &[Arg::Str(from), Arg::Address(to), Arg::Number(price), Arg::Number(limit)])
    }

    /// `gas.SpendGas(from)`.
    pub fn spend_gas(&mut self, from: &str) -> Result<&mut Self> {
        self.call_contract(GAS_CONTRACT, "SpendGas", &[Arg::Str(from)])
    }

    /// The finished script (`RET` appended).
    pub fn end_script(mut self) -> Vec<u8> {
        self.buf.push(opcode::RET);
        self.buf
    }
}

/// The view scripts for a list of read calls, `VIEW_CHUNK` calls per script,
/// as uppercase hex (what the kit sends to `invokeRawScript`).
pub fn view_scripts(calls: &[PhaCall]) -> Result<Vec<String>> {
    calls
        .chunks(VIEW_CHUNK)
        .map(|chunk| {
            let mut sb = ScriptBuilder::new();
            for c in chunk {
                let args: Vec<Arg<'_>> = c.args.iter().map(|a| Arg::Str(a)).collect();
                sb.call_contract(&c.contract, &c.method, &args)?;
            }
            Ok(hex::encode_upper(sb.end_script()))
        })
        .collect()
}
