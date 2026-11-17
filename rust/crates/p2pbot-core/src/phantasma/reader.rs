//! The escrow reads the kit's checks run on Phantasma (`PhaReader` in
//! `src/pha.ts`): a lock, the escrow's settings for a token, its open cap,
//! its admin, and its hash of a secret.
//!
//! The transport is the [`PhaNode`] trait, so the same reads run over HTTPS
//! on Linux, over the ESP32's network stack, or over recorded answers in the
//! tests. A read that is missing or does not decode is an error, never a
//! default: a gap never reads as "no lock".

use alloc::string::{String, ToString};
use alloc::vec::Vec;

use crate::codec::{decimal_to_hex, hex_to_decimal, is_hex32};
use crate::error::{Error, Result};
use crate::phantasma::escrow::PhaCall;
use crate::phantasma::script::{view_scripts, VIEW_CHUNK};
use crate::phantasma::vm::{decode_views, view_address, view_small_int, view_text, view_u128, VmValue};
use crate::pins::{token_of, NetConfig};

/// A node's answer to one `invokeRawScript`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScriptAnswer {
    /// One hex value per call, when the node sends them apart.
    pub results: Option<Vec<Option<String>>>,
    /// All values in one hex stream.
    pub result: Option<String>,
}

/// A Phantasma node: what the reads need from it.
pub trait PhaNode {
    /// `invokeRawScript(chain, script)`, with the script as uppercase hex.
    /// An error when the node refuses or does not answer.
    fn invoke_raw_script(&mut self, chain: &str, script: &str) -> Result<ScriptAnswer>;
}

/// Run read calls, `VIEW_CHUNK` per script: one value per call (`None` when
/// it did not decode).
pub fn views<N: PhaNode + ?Sized>(node: &mut N, cfg: &NetConfig, calls: &[PhaCall]) -> Result<Vec<Option<VmValue>>> {
    let scripts = view_scripts(calls)?;
    let mut out = Vec::with_capacity(calls.len());
    for (script, chunk) in scripts.iter().zip(calls.chunks(VIEW_CHUNK)) {
        let a = node.invoke_raw_script(cfg.pha.chain, script)?;
        out.extend(decode_views(a.results.as_deref(), a.result.as_deref(), chunk.len()));
    }
    Ok(out)
}

fn call(cfg: &NetConfig, method: &str, args: &[&str]) -> PhaCall {
    PhaCall { contract: cfg.pha_contract.to_string(), method: method.to_string(), args: args.iter().map(|a| a.to_string()).collect() }
}

fn unreadable(what: &str) -> Error {
    Error::new("PHA_READ", what)
}

fn traded_symbol(symbol: &str) -> Result<&'static str> {
    token_of(symbol).map(|t| t.symbol).ok_or_else(|| Error::new("TOKEN_NOT_TRADED", "Not a token this kit trades."))
}

/// One escrow lock as the chain holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhaLockRead {
    /// The lock hash, lowercase.
    pub h: String,
    /// 0: none; 1: locked; 2: claimed; 3: refunded.
    pub state: u64,
    /// Who locked.
    pub sender: String,
    /// Who may claim.
    pub recipient: String,
    /// The symbol exactly as the chain wrote it (never upper-cased).
    pub symbol: String,
    /// Raw amount.
    pub amount: u128,
    /// Unix seconds.
    pub deadline: u64,
    /// `getCreated`: the start of the buyer's Base lock window.
    pub created: u64,
    /// The secret, only when the lock reads claimed.
    pub secret: Option<String>,
}

/// The escrow's switches and its bounds for one token (check 23).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PhaParams {
    /// Whether new locks are paused.
    pub paused: bool,
    /// Shortest lock, seconds.
    pub min_lock: u64,
    /// Longest lock, seconds.
    pub max_lock: u64,
    /// Smallest lock, raw.
    pub min_amount: u128,
    /// Largest lock, raw (0: the escrow does not take this token).
    pub max_amount: u128,
}

/// The escrow's open cap for one token (checks 11 and 21).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PhaOpenCap {
    /// Raw amount locked and open now.
    pub open_amount: u128,
    /// The cap.
    pub max_open: u128,
}

/// One lock: `getState` first (the other getters refuse an `h` never
/// locked), then the getters, and `getSecret` when it reads claimed.
pub fn read_lock<N: PhaNode + ?Sized>(node: &mut N, cfg: &NetConfig, h: &str) -> Result<PhaLockRead> {
    if !is_hex32(h) {
        return Err(Error::bad_input("Not a valid lock hash"));
    }
    let arg = hex_to_decimal(h)?;
    let st = views(node, cfg, &[call(cfg, "getState", &[&arg])])?;
    let state = view_small_int(st.first().and_then(Option::as_ref)).ok_or_else(|| unreadable("Phantasma returned an unreadable number"))?;
    let hl = h.to_ascii_lowercase();
    if state == 0 {
        return Ok(PhaLockRead {
            h: hl,
            state: 0,
            sender: String::new(),
            recipient: String::new(),
            symbol: String::new(),
            amount: 0,
            deadline: 0,
            created: 0,
            secret: None,
        });
    }
    let mut methods = alloc::vec!["getSender", "getRecipient", "getSymbol", "getAmount", "getDeadline", "getCreated"];
    if state == 2 {
        methods.push("getSecret");
    }
    let calls: Vec<PhaCall> = methods.iter().map(|m| call(cfg, m, &[&arg])).collect();
    let r = views(node, cfg, &calls)?;
    if r.len() < methods.len() || r.iter().any(Option::is_none) {
        return Err(unreadable("Phantasma did not answer every read of this lock"));
    }
    // By name, so adding a getter never shifts another one's answer.
    let by = |name: &str| r[methods.iter().position(|m| *m == name).unwrap_or(usize::MAX)].as_ref();
    let secret =
        if state == 2 { Some(decimal_to_hex(&view_text(by("getSecret"))).ok_or_else(|| unreadable("Phantasma returned an unreadable secret"))?) } else { None };
    let symbol = view_text(by("getSymbol"));
    if symbol.is_empty() {
        return Err(unreadable("Phantasma returned no symbol for this lock"));
    }
    let num = |name: &str| view_small_int(by(name)).ok_or_else(|| unreadable("Phantasma returned an unreadable number"));
    Ok(PhaLockRead {
        h: hl,
        state,
        sender: view_address(by("getSender")),
        recipient: view_address(by("getRecipient")),
        symbol,
        amount: view_u128(by("getAmount")).ok_or_else(|| unreadable("Phantasma returned an unreadable number"))?,
        deadline: num("getDeadline")?,
        created: num("getCreated")?,
        secret,
    })
}

/// The escrow's switches and its per-lock bounds for `symbol` (a token the
/// escrow never enabled reads `max_amount` 0).
pub fn read_params<N: PhaNode + ?Sized>(node: &mut N, cfg: &NetConfig, symbol: &str) -> Result<PhaParams> {
    let sym = traded_symbol(symbol)?;
    let r = views(
        node,
        cfg,
        &[
            call(cfg, "getPaused", &[]),
            call(cfg, "getMinLock", &[]),
            call(cfg, "getMaxLock", &[]),
            call(cfg, "getMinAmount", &[sym]),
            call(cfg, "getMaxAmount", &[sym]),
        ],
    )?;
    if r.len() < 5 || r.iter().any(Option::is_none) {
        return Err(unreadable("Phantasma did not answer every read of the P2P settings"));
    }
    let bad = || unreadable("Phantasma returned an unreadable number");
    let paused = match &r[0] {
        Some(VmValue::Bool(b)) => *b,
        v => view_small_int(v.as_ref()).ok_or_else(bad)? != 0,
    };
    Ok(PhaParams {
        paused,
        min_lock: view_small_int(r[1].as_ref()).ok_or_else(bad)?,
        max_lock: view_small_int(r[2].as_ref()).ok_or_else(bad)?,
        min_amount: view_u128(r[3].as_ref()).ok_or_else(bad)?,
        max_amount: view_u128(r[4].as_ref()).ok_or_else(bad)?,
    })
}

/// `getOpenAmount(symbol)` and `getMaxOpen(symbol)`.
pub fn read_open_cap<N: PhaNode + ?Sized>(node: &mut N, cfg: &NetConfig, symbol: &str) -> Result<PhaOpenCap> {
    let sym = traded_symbol(symbol)?;
    let r = views(node, cfg, &[call(cfg, "getOpenAmount", &[sym]), call(cfg, "getMaxOpen", &[sym])])?;
    if r.len() < 2 || r.iter().any(Option::is_none) {
        return Err(unreadable("Phantasma did not answer every read of the open cap"));
    }
    let bad = || unreadable("Phantasma returned an unreadable number");
    Ok(PhaOpenCap { open_amount: view_u128(r[0].as_ref()).ok_or_else(bad)?, max_open: view_u128(r[1].as_ref()).ok_or_else(bad)? })
}

/// `getAdmin()` of the escrow, as an address (`""` when it does not decode).
pub fn admin<N: PhaNode + ?Sized>(node: &mut N, cfg: &NetConfig) -> Result<String> {
    let r = views(node, cfg, &[call(cfg, "getAdmin", &[])])?;
    match r.first() {
        Some(Some(v)) => Ok(view_address(Some(v))),
        _ => Err(unreadable("Phantasma did not answer getAdmin")),
    }
}

/// The live escrow's `hashSecret(x)` of each secret (`0x` + 64 hex), as
/// `0x` + 64 hex digests (`None` when one does not decode). One read per secret.
pub fn hash_secrets<N: PhaNode + ?Sized>(node: &mut N, cfg: &NetConfig, secrets: &[&str]) -> Result<Vec<Option<String>>> {
    let mut out = Vec::with_capacity(secrets.len());
    for s in secrets {
        let r = views(node, cfg, &[call(cfg, "hashSecret", &[&hex_to_decimal(s)?])])?;
        out.push(r.into_iter().next().flatten().and_then(|v| decimal_to_hex(&view_text(Some(&v)))));
    }
    Ok(out)
}
