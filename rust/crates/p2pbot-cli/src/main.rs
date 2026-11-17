//! `p2pbot`: the command line of the Rust port. It makes and checks key
//! files that the TypeScript kit reads too. It sends nothing and signs
//! nothing: the trading bot itself is not ported yet (`rust/README.md`).

#[cfg(not(unix))]
compile_error!("p2pbot runs on Linux or macOS, like the kit (key files must be mode 0600).");

mod keyfile;

use std::path::PathBuf;
use std::process::ExitCode;

use p2pbot_core::pins::Network;

const USAGE: &str = "\
p2pbot: the Rust port of the Saturn P2P bot kit (keys only for now; it sends nothing).

Usage:
  p2pbot new-keys [--dir <folder>] [--name <name>]...
      Make key pairs: <folder>/<name>-pha.json and <name>-base.json (mode 0600),
      the same files the TypeScript kit makes and reads. Default folder ./keys,
      default names seller and buyer. Existing files are never replaced.
      The market bot's mainnet pair: p2pbot new-keys --dir keys/mainnet --name market
  p2pbot addresses --network <devnet|mainnet> --pha <file> --base <file>
      Check a key pair as the kit does (mode 0600, the WIF's checksum, no admin,
      owner or keeper key) and print its two addresses.
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
