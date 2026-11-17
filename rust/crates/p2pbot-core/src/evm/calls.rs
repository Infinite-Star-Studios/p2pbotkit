//! The Base calls the kit sends, ported from `src/base.ts` with the same
//! checks: USDC `approve`, and SaturnSwap `lock`, `lockWithPermit`, `claim`,
//! `refund` and `withdrawOwed`, plus the 0-value `cancel` that takes back an
//! unmined nonce.

use alloc::string::String;
use alloc::vec::Vec;

use crate::codec::{hex32_to_bytes, is_hex32};
use crate::error::{Error, Result};
use crate::evm::abi::{address, encode_call, uint};
use crate::evm::keys::{evm_lower, parse_address};
use crate::phantasma::escrow::MAX_SAFE_INTEGER;
use crate::pins::{NetConfig, MAX_FEE_BPS};

/// One Base call: where it goes and its data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BaseCall {
    /// The contract (or, for `cancel`, the sender itself), lowercase.
    pub to: String,
    /// Call data.
    pub data: Vec<u8>,
    /// Which call: approve, lock, lockWithPermit, claim, refund, withdrawOwed, cancel.
    pub func: &'static str,
}

impl BaseCall {
    /// `to` as 20 bytes.
    pub fn to_bytes(&self) -> Result<[u8; 20]> {
        parse_address(&self.to)
    }
}

fn lower(a: &str) -> String {
    a.to_ascii_lowercase()
}

fn fee_arg(fee: u32) -> Result<u128> {
    if fee > u32::from(MAX_FEE_BPS) {
        return Err(Error::bad_input("This trade has no valid fee, so nothing was locked."));
    }
    Ok(u128::from(fee))
}

/// The fields of a lock.
#[derive(Debug, Clone, Copy)]
pub struct LockParams<'a> {
    /// The lock hash, `0x` + 64 hex.
    pub h: &'a str,
    /// Raw USDC.
    pub amount: u128,
    /// Who may claim it.
    pub claimer: &'a str,
    /// Unix seconds.
    pub deadline: u64,
    /// The highest fee the lock accepts, basis points.
    pub max_fee_bps: u32,
}

fn lock_words(cfg: &NetConfig, p: &LockParams<'_>) -> Result<Vec<[u8; 32]>> {
    let claimer = evm_lower(p.claimer);
    let ok = is_hex32(p.h) && claimer.is_some() && p.deadline > 0 && p.deadline <= MAX_SAFE_INTEGER && p.amount > 0;
    let claimer = match (ok, claimer) {
        (true, Some(c)) => parse_address(&c)?,
        _ => return Err(Error::bad_input("This lock is not valid, so nothing was locked.")),
    };
    Ok(alloc::vec![
        hex32_to_bytes(p.h)?,
        address(&parse_address(cfg.base.usdc)?),
        uint(p.amount),
        address(&claimer),
        uint(u128::from(p.deadline)),
        uint(fee_arg(p.max_fee_bps)?),
    ])
}

/// USDC `approve(swap, amount)`, for at most what one lock may take.
pub fn approve_call(cfg: &NetConfig, amount: u128) -> Result<BaseCall> {
    if amount == 0 || amount > cfg.base.usdc_max {
        return Err(Error::bad_input("Not an amount one lock may approve"));
    }
    let data = encode_call("approve(address,uint256)", &[address(&parse_address(cfg.base.swap)?), uint(amount)]);
    Ok(BaseCall { to: lower(cfg.base.usdc), data, func: "approve" })
}

/// SaturnSwap `lock(h, usdc, amount, claimer, deadline, maxFeeBps)`.
pub fn lock_call_base(cfg: &NetConfig, p: &LockParams<'_>) -> Result<BaseCall> {
    let words = lock_words(cfg, p)?;
    Ok(BaseCall { to: lower(cfg.base.swap), data: encode_call("lock(bytes32,address,uint256,address,uint64,uint16)", &words), func: "lock" })
}

/// The permit part of `lockWithPermit`.
#[derive(Debug, Clone, Copy)]
pub struct PermitParams<'a> {
    /// The permit's deadline, Unix seconds.
    pub permit_deadline: u64,
    /// 27 or 28.
    pub v: u8,
    /// `0x` + 64 hex.
    pub r: &'a str,
    /// `0x` + 64 hex.
    pub s: &'a str,
}

/// SaturnSwap `lockWithPermit(…, permitDeadline, v, r, s)`: the lock and the
/// USDC permit in one transaction.
pub fn lock_with_permit_call(cfg: &NetConfig, p: &LockParams<'_>, permit: &PermitParams<'_>) -> Result<BaseCall> {
    let mut words = lock_words(cfg, p)?;
    if !is_hex32(permit.r) || !is_hex32(permit.s) || !(permit.v == 27 || permit.v == 28) {
        return Err(Error::bad_input("Not a valid permit signature"));
    }
    words.push(uint(u128::from(permit.permit_deadline)));
    words.push(uint(u128::from(permit.v)));
    words.push(hex32_to_bytes(permit.r)?);
    words.push(hex32_to_bytes(permit.s)?);
    Ok(BaseCall {
        to: lower(cfg.base.swap),
        data: encode_call("lockWithPermit(bytes32,address,uint256,address,uint64,uint16,uint256,uint8,bytes32,bytes32)", &words),
        func: "lockWithPermit",
    })
}

/// SaturnSwap `claim(secret, sender)`.
pub fn claim_call_base(cfg: &NetConfig, secret: &str, sender: &str) -> Result<BaseCall> {
    let s = evm_lower(sender);
    match s {
        Some(s) if is_hex32(secret) => Ok(BaseCall {
            to: lower(cfg.base.swap),
            data: encode_call("claim(bytes32,address)", &[hex32_to_bytes(secret)?, address(&parse_address(&s)?)]),
            func: "claim",
        }),
        _ => Err(Error::bad_input("Not a valid claim")),
    }
}

/// SaturnSwap `refund(h, sender)`.
pub fn refund_call_base(cfg: &NetConfig, h: &str, sender: &str) -> Result<BaseCall> {
    let s = evm_lower(sender);
    match s {
        Some(s) if is_hex32(h) => Ok(BaseCall {
            to: lower(cfg.base.swap),
            data: encode_call("refund(bytes32,address)", &[hex32_to_bytes(h)?, address(&parse_address(&s)?)]),
            func: "refund",
        }),
        _ => Err(Error::bad_input("Not a valid refund")),
    }
}

/// SaturnSwap `withdrawOwed(usdc, claimer)`.
pub fn withdraw_owed_call(cfg: &NetConfig, claimer: &str) -> Result<BaseCall> {
    let c = evm_lower(claimer).ok_or_else(|| Error::bad_input("Not a valid address"))?;
    Ok(BaseCall {
        to: lower(cfg.base.swap),
        data: encode_call("withdrawOwed(address,address)", &[address(&parse_address(cfg.base.usdc)?), address(&parse_address(&c)?)]),
        func: "withdrawOwed",
    })
}

/// A 0-value transfer to the sender itself, which takes back its unmined nonce.
pub fn cancel_call(from: &str) -> Result<BaseCall> {
    let f = evm_lower(from).ok_or_else(|| Error::bad_input("Not a valid address"))?;
    Ok(BaseCall { to: f, data: Vec::new(), func: "cancel" })
}
