//! The three escrow transactions (lock, claim, refund), ported from the
//! kit's `src/pha.ts`, with the same input checks.
//!
//! `h` and the secret go to the contract as **decimal** strings (the VM
//! reverses hex strings); the symbol is the token of the kit's own record,
//! never the board's; every transaction carries the fixed gas allowance
//! (never one fitted to the balance) and its method's payload label.

use alloc::string::{String, ToString};
use alloc::vec;
use alloc::vec::Vec;

use crate::codec::{hex_to_decimal, is_hex32};
use crate::error::{Error, Result};
use crate::phantasma::keys::NULL_ADDRESS;
use crate::phantasma::script::{Arg, ScriptBuilder};
use crate::phantasma::tx::Transaction;
use crate::pins::{is_contract_name, pha_tx_label, token_of, NetConfig, PHA_LOCK_GAS};

/// JavaScript's `Number.MAX_SAFE_INTEGER`: the kit refuses larger deadlines.
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// One contract call; every argument is a string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhaCall {
    /// Contract name.
    pub contract: String,
    /// Method.
    pub method: String,
    /// Arguments (decimal numbers, symbols, addresses).
    pub args: Vec<String>,
}

fn traded_symbol(symbol: &str) -> Result<&'static str> {
    token_of(symbol).map(|t| t.symbol).ok_or_else(|| Error::new("TOKEN_NOT_TRADED", "Not a token this kit trades."))
}

/// `lock(from, h, symbol, amount, recipient, deadline)`.
pub fn lock_call(cfg: &NetConfig, from: &str, h: &str, symbol: &str, amount: u128, recipient: &str, deadline: u64) -> Result<PhaCall> {
    let sym = traded_symbol(symbol)?;
    if !is_hex32(h) {
        return Err(Error::bad_input("Not a valid lock hash"));
    }
    if amount == 0 {
        return Err(Error::bad_input("Not a valid amount"));
    }
    if deadline == 0 || deadline > MAX_SAFE_INTEGER {
        return Err(Error::bad_input("Not a valid deadline"));
    }
    Ok(PhaCall {
        contract: cfg.pha_contract.to_string(),
        method: "lock".to_string(),
        args: vec![from.to_string(), hex_to_decimal(h)?, sym.to_string(), amount.to_string(), recipient.to_string(), deadline.to_string()],
    })
}

/// `claim(secret)`: pays the recipient fixed in the lock. Anyone may send it.
pub fn claim_call(cfg: &NetConfig, secret: &str) -> Result<PhaCall> {
    if !is_hex32(secret) {
        return Err(Error::bad_input("Not a valid secret"));
    }
    Ok(PhaCall { contract: cfg.pha_contract.to_string(), method: "claim".to_string(), args: vec![hex_to_decimal(secret)?] })
}

/// `refund(h)`: pays the sender back after the deadline. Anyone may send it.
pub fn refund_call(cfg: &NetConfig, h: &str) -> Result<PhaCall> {
    if !is_hex32(h) {
        return Err(Error::bad_input("Not a valid lock hash"));
    }
    Ok(PhaCall { contract: cfg.pha_contract.to_string(), method: "refund".to_string(), args: vec![hex_to_decimal(h)?] })
}

/// An unsigned transaction that calls one escrow method from `from`, with
/// the fixed gas allowance and the method's label. Only escrow calls are
/// built: the contract must be this network's escrow (or one still
/// draining) and the method lock, claim or refund.
pub fn escrow_transaction(cfg: &NetConfig, from: &str, call: &PhaCall, expires_at_ms: u64) -> Result<Transaction> {
    let served = call.contract == cfg.pha_contract || cfg.pha_draining.iter().any(|d| d.name == call.contract);
    if !is_contract_name(&call.contract) || !served {
        return Err(Error::bad_input("Not an escrow this kit serves"));
    }
    let label = pha_tx_label(&call.method).ok_or_else(|| Error::bad_input("Not an escrow transaction"))?;
    let mut sb = ScriptBuilder::new();
    sb.allow_gas(from, &NULL_ADDRESS, PHA_LOCK_GAS.price, PHA_LOCK_GAS.limit)?;
    let args: Vec<Arg<'_>> = call.args.iter().map(|a| Arg::Str(a)).collect();
    sb.call_contract(&call.contract, &call.method, &args)?;
    sb.spend_gas(from)?;
    Transaction::new(cfg.pha.nexus, cfg.pha.chain, sb.end_script(), expires_at_ms, label.as_bytes().to_vec())
}
