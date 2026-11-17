//! `p2pbot`: the command line of the Rust port. It makes and checks key
//! files that the TypeScript kit reads too, and reads the live escrow. It
//! signs and sends nothing: the trading bot itself is not ported yet
//! (`rust/README.md`).

#[cfg(not(unix))]
compile_error!("p2pbot runs on Linux or macOS, like the kit (key files must be mode 0600).");

mod keyfile;
mod net;

use std::path::PathBuf;
use std::process::ExitCode;

use p2pbot_core::phantasma::reader;
use p2pbot_core::pins::{self, Network};

const USAGE: &str = "\
p2pbot: the Rust port of the Saturn P2P bot kit (keys and reads for now; it signs and sends nothing).

Usage:
  p2pbot new-keys [--dir <folder>] [--name <name>]...
      Make key pairs: <folder>/<name>-pha.json and <name>-base.json (mode 0600),
      the same files the TypeScript kit makes and reads. Default folder ./keys,
      default names seller and buyer. Existing files are never replaced.
      The market bot's mainnet pair: p2pbot new-keys --dir keys/mainnet --name market
  p2pbot addresses --network <devnet|mainnet> --pha <file> --base <file>
      Check a key pair as the kit does (mode 0600, the WIF's checksum, no admin,
      owner or keeper key) and print its two addresses.
  p2pbot check-escrow --network <devnet|mainnet>
      Read the live Phantasma escrow through the network's pinned node (reads
      only) and check it against the kit's pins: its code, its admin, and each
      token's settings and open cap.
  p2pbot help";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if keyfile::secret_shaped_arg(&args) {
        println!("Refused: an argument looks like a key or a secret. p2pbot reads keys only from their key files.");
        return ExitCode::from(2);
    }
    match args.first().map(String::as_str) {
        Some("new-keys") => new_keys(&args[1..]),
        Some("addresses") => addresses(&args[1..]),
        Some("check-escrow") => check_escrow(&args[1..]),
        Some("help" | "--help" | "-h") | None => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        Some(other) => {
            println!("Unknown command: {other}\n\n{USAGE}");
            ExitCode::from(2)
        }
    }
}

/// `--flag value` pairs; `None` (after printing why) on anything else.
fn flags(args: &[String], allowed: &[&str]) -> Option<Vec<(String, String)>> {
    let mut out = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if !allowed.contains(&a.as_str()) {
            println!("Unknown option: {a}\n\n{USAGE}");
            return None;
        }
        match it.next() {
            Some(v) => out.push((a.clone(), v.clone())),
            None => {
                println!("{a} needs a value\n\n{USAGE}");
                return None;
            }
        }
    }
    Some(out)
}

fn new_keys(args: &[String]) -> ExitCode {
    let Some(f) = flags(args, &["--dir", "--name"]) else { return ExitCode::from(2) };
    let dir = PathBuf::from(f.iter().rev().find(|(k, _)| k == "--dir").map_or("keys", |(_, v)| v.as_str()));
    let mut names: Vec<String> = f.iter().filter(|(k, _)| k == "--name").map(|(_, v)| v.clone()).collect();
    if names.is_empty() {
        names = keyfile::DEFAULT_NAMES.iter().map(|s| s.to_string()).collect();
    }
    let made = match keyfile::make_key_pairs(&dir, &names) {
        Ok(m) => m,
        Err(e) => {
            println!("No keys were made: {}", e.detail);
            return ExitCode::FAILURE;
        }
    };
    let mut bad = false;
    for r in &made {
        if r.created {
            println!("{}: wrote {} and {} (mode 0600)", r.name, r.pha_file.display(), r.base_file.display());
        } else {
            println!("{}: {}", r.name, r.note.as_deref().unwrap_or(""));
        }
        match &r.addresses {
            Some((pha, base)) => {
                println!("  Phantasma {pha}");
                println!("  Base      {base}");
            }
            None => bad = true,
        }
    }
    println!(
        "Keep the files in {} private: whoever can read them can spend what the addresses hold. Back them up before you fund them with anything of value.",
        dir.display()
    );
    if bad {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

fn addresses(args: &[String]) -> ExitCode {
    let Some(f) = flags(args, &["--network", "--pha", "--base"]) else { return ExitCode::from(2) };
    let get = |k: &str| f.iter().rev().find(|(x, _)| x == k).map(|(_, v)| v.clone());
    let (Some(net), Some(pha), Some(base)) = (get("--network"), get("--pha"), get("--base")) else {
        println!("addresses needs --network, --pha and --base\n\n{USAGE}");
        return ExitCode::from(2);
    };
    let Some(network) = Network::parse(&net) else {
        println!("The network is devnet or mainnet.");
        return ExitCode::from(2);
    };
    let argv: Vec<String> = std::env::args().collect();
    match keyfile::load_keys(network, &PathBuf::from(pha), &PathBuf::from(base), &argv) {
        Ok(k) => {
            println!("{}:", k.network.name());
            println!("  Phantasma {}", k.pha.address());
            println!("  Base      {}", k.base.address_checksummed());
            ExitCode::SUCCESS
        }
        Err(e) => {
            println!("Refused ({}): {}", e.code, e.detail);
            ExitCode::FAILURE
        }
    }
}

fn check_escrow(args: &[String]) -> ExitCode {
    let Some(f) = flags(args, &["--network"]) else { return ExitCode::from(2) };
    let Some(network) = f.iter().rev().find(|(k, _)| k == "--network").and_then(|(_, v)| Network::parse(v)) else {
        println!("check-escrow needs --network devnet or --network mainnet\n\n{USAGE}");
        return ExitCode::from(2);
    };
    let cfg = pins::config(network);
    let mut node = net::HttpNode::pinned(cfg);
    println!("Phantasma {} escrow {}, through {} (reads only):", network.name(), cfg.pha_contract, node.url());
    let mut ok = true;
    match node.contract_code(cfg) {
        Ok((sha, methods)) => {
            let pinned = sha.as_deref() == Some(cfg.pha_code_sha256);
            let has_state = methods.iter().any(|m| m == "getState");
            ok &= pinned && has_state;
            println!("  code   {}  {}", sha.as_deref().unwrap_or("(none)"), if pinned { "= the pinned code" } else { "DIFFERS from the pinned code" });
            if !has_state {
                println!("  the escrow has no getState method");
            }
        }
        Err(e) => {
            ok = false;
            println!("  code   unreadable: {}", e.detail);
        }
    }
    match reader::admin(&mut node, cfg) {
        Ok(a) => {
            let pinned = a == cfg.pha_admin;
            ok &= pinned;
            println!("  admin  {a}  {}", if pinned { "= the pinned admin" } else { "DIFFERS from the pinned admin" });
        }
        Err(e) => {
            ok = false;
            println!("  admin  unreadable: {}", e.detail);
        }
    }
    for t in pins::TOKENS {
        match (reader::read_params(&mut node, cfg, t.symbol), reader::read_open_cap(&mut node, cfg, t.symbol)) {
            (Ok(p), Ok(c)) => {
                // Check 23: a token the escrow takes must have the kit's bounds; one it does not take (max 0) is off.
                let on = p.max_amount > 0;
                let bounds = !on || (p.min_amount == t.min && p.max_amount == t.max);
                ok &= bounds && !p.paused;
                let state = if p.paused {
                    "PAUSED"
                } else if on {
                    "on"
                } else {
                    "off"
                };
                println!(
                    "  {:<4}   {state:<6} lock {}-{} s, amount {}-{} raw, open {} of {}{}",
                    t.symbol,
                    p.min_lock,
                    p.max_lock,
                    p.min_amount,
                    p.max_amount,
                    c.open_amount,
                    c.max_open,
                    if bounds { "" } else { "  (bounds DIFFER from the kit's table)" }
                );
            }
            (Err(e), _) | (_, Err(e)) => {
                ok = false;
                println!("  {:<4}   unreadable: {}", t.symbol, e.detail);
            }
        }
    }
    if ok {
        println!("All reads match the kit's pins.");
        ExitCode::SUCCESS
    } else {
        println!("Something differs or could not be read (above): the kit would not trade on this.");
        ExitCode::FAILURE
    }
}
