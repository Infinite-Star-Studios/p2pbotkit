//! The port against the TypeScript kit's own answers,
//! `rust/fixtures/kit-vectors.json` (made by `rust/tools/make-vectors.ts`
//! from the kit's code): the pins, Base addresses, calls, permits and
//! EIP-1559 transactions, the codec, and files sealed by the kit's store.

use p2pbot_core::codec::{decimal_to_hex, hash_of_secret, hex_to_decimal, sha256, token_hash_of};
use p2pbot_core::evm::calls::{
    approve_call, cancel_call, claim_call_base, lock_call_base, lock_with_permit_call, refund_call_base, withdraw_owed_call, LockParams, PermitParams,
};
use p2pbot_core::evm::tx::tx_hash;
use p2pbot_core::evm::{domain_separator, keccak256, parse_address, permit_digest, sign_permit, BaseCall, Eip1559, EvmKey};
use p2pbot_core::pins::{self, config, known_role_addresses, NetConfig, Network};
use p2pbot_core::seal::{seal, store_key_from_file, unseal, Sealed, IV_BYTES};
use serde_json::Value;

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/kit-vectors.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("rust/fixtures/kit-vectors.json")).unwrap()
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("not a string: {v}"))
}

/// A number the kit wrote as a JSON number or (bigint) a decimal string.
fn n(v: &Value) -> u128 {
    match v {
        Value::Number(x) => x.as_u64().unwrap() as u128,
        Value::String(x) => x.parse().unwrap(),
        _ => panic!("not a number: {v}"),
    }
}

fn hex0x(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}

fn key_of(label: &str) -> EvmKey {
    EvmKey::from_private_key(&sha256(label.as_bytes())).unwrap()
}

// ── Pins ────────────────────────────────────────────────────────────────────

#[test]
fn pins_match_the_kit() {
    let v = vectors();
    let p = &v["pins"];
    assert_eq!(pins::PHA_CONTRACT, s(&p["phaContract"]));
    assert_eq!(pins::DEFAULT_API, s(&p["defaultApi"]));
    assert_eq!(u128::from(pins::USDC_DECIMALS), n(&p["usdcDecimals"]));
    assert_eq!(u128::from(pins::MAX_FEE_BPS), n(&p["maxFeeBps"]));
    assert_eq!(pins::MIN_TRADE_USDC, n(&p["minTradeUsdc"]));
    assert_eq!(pins::SOUL_RESERVE, n(&p["soulReserve"]));
    assert_eq!(u128::from(pins::CLOCK_SKEW_MAX), n(&p["clockSkewMax"]));
    assert_eq!(u128::from(pins::PHA_LOCK_GAS.price), n(&p["phaLockGas"]["price"]));
    assert_eq!(u128::from(pins::PHA_LOCK_GAS.limit), n(&p["phaLockGas"]["limit"]));
    assert_eq!(u128::from(pins::PHA_TX_TTL_MS), n(&p["phaTxTtlMs"]));
    assert_eq!(u128::from(pins::CANCEL_GAS), n(&p["cancelGas"]));
    assert_eq!(u128::from(pins::PERMIT_SECONDS), n(&p["permitSeconds"]));
    assert_eq!(u128::from(pins::PERMIT_MAX_SECONDS), n(&p["permitMaxSeconds"]));
    let labels = p["phaTxLabels"].as_object().unwrap();
    assert_eq!(labels.len(), pins::PHA_TX_LABELS.len());
    for (method, label) in labels {
        assert_eq!(pins::pha_tx_label(method), Some(s(label)));
    }
    let hv = p["phaHashVectors"].as_array().unwrap();
    assert_eq!(hv.len(), pins::PHA_HASH_VECTORS.len());
    for (i, x) in hv.iter().enumerate() {
        assert_eq!(pins::PHA_HASH_VECTORS[i], (s(&x["secret"]), s(&x["digest"])));
    }

    let tokens = p["tokens"].as_array().unwrap();
    assert_eq!(tokens.len(), pins::TOKENS.len());
    for (t, want) in pins::TOKENS.iter().zip(tokens) {
        assert_eq!(t.symbol, s(&want["symbol"]));
        assert_eq!(u128::from(t.decimals), n(&want["decimals"]));
        assert_eq!((t.min, t.max, t.offer_max, t.price_max), (n(&want["min"]), n(&want["max"]), n(&want["offerMax"]), n(&want["priceMax"])));
        assert_eq!((t.gas, t.stake, t.enabled), (want["gas"].as_bool().unwrap(), want["stake"].as_bool().unwrap(), want["enabled"].as_bool().unwrap()));
    }

    for net in Network::ALL {
        let c = config(net);
        let w = &p["config"][net.name()];
        check_config(c, w);
    }

    let (pha, base) = known_role_addresses();
    let mut pha_sorted = pha.clone();
    pha_sorted.sort();
    let mut base_sorted = base.clone();
    base_sorted.sort();
    let want =
        |side: &str| -> Vec<(String, String)> { p["roles"][side].as_array().unwrap().iter().map(|e| (s(&e[0]).to_string(), s(&e[1]).to_string())).collect() };
    assert_eq!(pha_sorted, want("pha"));
    assert_eq!(base_sorted, want("base"));
}

fn check_config(c: &NetConfig, w: &Value) {
    assert_eq!(c.network.name(), s(&w["network"]));
    assert_eq!(c.pha_contract, s(&w["phaContract"]));
    assert_eq!(c.pha_code_sha256, s(&w["phaCodeSha256"]));
    assert_eq!(c.pha_admin, s(&w["phaAdmin"]));
    assert_eq!(c.pha_claim_kcal, n(&w["phaClaimKcal"]));
    let draining = w["phaDraining"].as_array().unwrap();
    assert_eq!(c.pha_draining.len(), draining.len());
    for (d, want) in c.pha_draining.iter().zip(draining) {
        assert_eq!((d.name, d.code_sha256, d.admin), (s(&want["name"]), s(&want["codeSha256"]), s(&want["admin"])));
    }
    let pha = &w["pha"];
    assert_eq!(c.pha.rpc_url, s(&pha["rpcUrl"]));
    let hosts: Vec<&str> = pha["rpcHosts"].as_array().unwrap().iter().map(s).collect();
    assert_eq!(c.pha.rpc_hosts, hosts.as_slice());
    assert_eq!((c.pha.nexus, c.pha.chain, c.pha.explorer_url), (s(&pha["nexus"]), s(&pha["chain"]), s(&pha["explorerUrl"])));
    let b = &w["base"];
    assert_eq!(c.base.name, s(&b["name"]));
    assert_eq!(u128::from(c.base.chain_id), n(&b["chainId"]));
    assert_eq!((c.base.rpc_url, c.base.explorer_url), (s(&b["rpcUrl"]), s(&b["explorerUrl"])));
    assert_eq!((c.base.swap, c.base.usdc, c.base.usdc_symbol), (s(&b["swap"]), s(&b["usdc"]), s(&b["usdcSymbol"])));
    let nc = &b["nativeCurrency"];
    assert_eq!((c.base.native_currency.name, c.base.native_currency.symbol), (s(&nc["name"]), s(&nc["symbol"])));
    assert_eq!(u128::from(c.base.native_currency.decimals), n(&nc["decimals"]));
    assert_eq!(u128::from(c.base.confirm_blocks), n(&b["confirmBlocks"]));
    assert_eq!(c.base.confirm_safe, b["confirmSafe"].as_bool().unwrap());
    assert_eq!(c.base.usdc_has_blacklist, b["usdcHasBlacklist"].as_bool().unwrap());
    assert_eq!((c.base.usdc_min, c.base.usdc_max), (n(&b["usdcMin"]), n(&b["usdcMax"])));
    assert_eq!((c.base.permit.name, c.base.permit.version), (s(&b["permit"]["name"]), s(&b["permit"]["version"])));
    let fc = &b["feeCaps"];
    assert_eq!(u128::from(c.base.fee_caps.max_gas), n(&fc["maxGas"]));
    assert_eq!(c.base.fee_caps.max_fee_per_gas, n(&fc["maxFeePerGas"]));
    assert_eq!(c.base.fee_caps.max_priority_fee_per_gas, n(&fc["maxPriorityFeePerGas"]));
    assert_eq!(c.base.fee_caps.max_fee_wei, n(&fc["maxFeeWei"]));
    assert_eq!(c.base.faucet_max, n(&b["faucetMax"]));
    assert_eq!(u128::from(c.base.lock_with_permit_gas), n(&b["lockWithPermitGas"]));
    let t = &w["timing"];
    let want = [
        "phaLock",
        "safety",
        "revealMin",
        "baseLockLead",
        "revealAllowance",
        "claimMargin",
        "claimWatch",
        "refundGrace",
        "lockSlack",
        "baseLockWindow",
        "baseLockSignLead",
        "phaRefundGrace",
        "baseRefundGrace",
    ];
    let have = [
        c.timing.pha_lock,
        c.timing.safety,
        c.timing.reveal_min,
        c.timing.base_lock_lead,
        c.timing.reveal_allowance,
        c.timing.claim_margin,
        c.timing.claim_watch,
        c.timing.refund_grace,
        c.timing.lock_slack,
        c.timing.base_lock_window,
        c.timing.base_lock_sign_lead,
        c.timing.pha_refund_grace,
        c.timing.base_refund_grace,
    ];
    assert_eq!(t.as_object().unwrap().len(), want.len(), "the kit's timing has fields the port lacks");
    for (k, h) in want.iter().zip(have) {
        assert_eq!(u128::from(h), n(&t[*k]), "timing {k}");
    }
    // Every top-level field of the kit's config is covered above.
    assert_eq!(w.as_object().unwrap().len(), 9);
    assert_eq!(b.as_object().unwrap().len(), 17);
    assert_eq!(pha.as_object().unwrap().len(), 5);
}

// ── Base ────────────────────────────────────────────────────────────────────

#[test]
fn base_addresses_match_viem() {
    let v = vectors();
    for k in v["keys"].as_array().unwrap() {
        assert_eq!(key_of(s(&k["label"])).address_checksummed(), s(&k["base"]));
    }
}

fn check_call(got: BaseCall, want: &Value, what: &str) {
    assert_eq!(got.to, s(&want["to"]), "{what}: to");
    assert_eq!(hex0x(&got.data), s(&want["data"]), "{what}: data");
    assert_eq!(got.func, s(&want["fn"]), "{what}: fn");
}

#[test]
fn calls_permits_and_transactions_match_the_kit() {
    let v = vectors();
    let labels: Vec<&str> = v["keys"].as_array().unwrap().iter().map(|k| s(&k["label"])).collect();
    let nets = v["evm"].as_array().unwrap();
    assert_eq!(nets.len(), 2, "one entry per network");
    for net_v in nets {
        // A fixture made while the kit refused something would test nothing: refuse it here.
        assert!(!net_v.to_string().contains("\"error\""), "the fixture holds a refusal: remake it");
        assert_eq!(net_v["calls"].as_object().unwrap().len(), 7);
        assert_eq!(net_v["permits"].as_array().unwrap().len(), 2);
        assert_eq!(net_v["txs"].as_array().unwrap().len(), 5);
    }
    for net_v in nets {
        let net = Network::parse(s(&net_v["network"])).unwrap();
        let cfg = config(net);
        assert_eq!(u128::from(cfg.base.chain_id), n(&net_v["chainId"]));
        assert_eq!(hex0x(&domain_separator(cfg).unwrap()), s(&net_v["domainSeparator"]), "{}: domain separator", net.name());

        let calls = &net_v["calls"];
        let lock = &calls["lock"]["input"];
        let lp = LockParams {
            h: s(&lock["h"]),
            amount: n(&lock["amount"]),
            claimer: s(&lock["claimer"]),
            deadline: n(&lock["deadline"]) as u64,
            max_fee_bps: n(&lock["maxFeeBps"]) as u32,
        };
        check_call(approve_call(cfg, n(&calls["approve"]["input"]["amount"])).unwrap(), &calls["approve"]["out"], "approve");
        check_call(lock_call_base(cfg, &lp).unwrap(), &calls["lock"]["out"], "lock");
        let pi = &calls["lockWithPermit"]["input"];
        let pp = PermitParams { permit_deadline: n(&pi["permitDeadline"]) as u64, v: n(&pi["v"]) as u8, r: s(&pi["r"]), s: s(&pi["s"]) };
        check_call(lock_with_permit_call(cfg, &lp, &pp).unwrap(), &calls["lockWithPermit"]["out"], "lockWithPermit");
        let ci = &calls["claim"]["input"];
        check_call(claim_call_base(cfg, s(&ci["secret"]), s(&ci["sender"])).unwrap(), &calls["claim"]["out"], "claim");
        let ri = &calls["refund"]["input"];
        check_call(refund_call_base(cfg, s(&ri["h"]), s(&ri["sender"])).unwrap(), &calls["refund"]["out"], "refund");
        check_call(withdraw_owed_call(cfg, s(&calls["withdrawOwed"]["input"]["claimer"])).unwrap(), &calls["withdrawOwed"]["out"], "withdrawOwed");
        check_call(cancel_call(s(&calls["cancel"]["input"]["from"])).unwrap(), &calls["cancel"]["out"], "cancel");

        for p in net_v["permits"].as_array().unwrap() {
            let key = key_of(labels[n(&p["key"]) as usize]);
            let input = &p["input"];
            assert_eq!(key.address_checksummed(), s(&input["owner"]));
            let (amount, nonce, deadline) = (n(&input["amount"]), n(&input["nonce"]), n(&input["deadline"]) as u64);
            assert_eq!(hex0x(&permit_digest(cfg, s(&input["owner"]), amount, nonce, deadline).unwrap()), s(&p["digest"]));
            let signed = sign_permit(&key, cfg, amount, nonce, deadline).unwrap();
            assert_eq!(hex0x(&signed.signature.to_rsv()), s(&p["signature"]), "{}: permit signature", net.name());
            assert_eq!(hex0x(&signed.signature.r), s(&p["r"]));
            assert_eq!(hex0x(&signed.signature.s), s(&p["s"]));
            assert_eq!(u128::from(signed.signature.v()), n(&p["v"]));
            assert_eq!(u128::from(signed.signature.y_parity), n(&p["yParity"]));
        }

        for t in net_v["txs"].as_array().unwrap() {
            let key = key_of(labels[n(&t["key"]) as usize]);
            let p = &t["prepared"];
            assert_eq!(key.address_lower(), s(&p["from"]));
            let data = s(&p["data"]);
            let tx = Eip1559 {
                chain_id: n(&p["chainId"]) as u64,
                nonce: n(&p["nonce"]) as u64,
                max_priority_fee_per_gas: n(&p["maxPriorityFeePerGas"]),
                max_fee_per_gas: n(&p["maxFeePerGas"]),
                gas: n(&p["gas"]) as u64,
                to: parse_address(s(&p["to"])).unwrap(),
                value: 0,
                data: hex::decode(&data[2..]).unwrap(),
            };
            let what = format!("{}: {} transaction", net.name(), s(&t["fn"]));
            assert_eq!(hex0x(&tx.unsigned_bytes()), s(&t["unsigned"]), "{what} (unsigned)");
            let signed = tx.sign(&key).unwrap();
            assert_eq!(hex0x(&signed), s(&t["signed"]), "{what} (signed)");
            assert_eq!(hex0x(&tx_hash(&signed)), s(&t["hash"]), "{what} (hash)");
        }
    }
}

#[test]
fn base_inputs_are_checked_like_the_kit() {
    let cfg = config(Network::Mainnet);
    let h = format!("0x{}", "ab".repeat(32));
    let claimer = "0x00000000000000000000000000000000000000aa";
    let ok = LockParams { h: &h, amount: 1, claimer, deadline: 1, max_fee_bps: 200 };
    assert!(lock_call_base(cfg, &ok).is_ok());
    assert!(lock_call_base(cfg, &LockParams { max_fee_bps: 201, ..ok }).is_err());
    assert!(lock_call_base(cfg, &LockParams { amount: 0, ..ok }).is_err());
    assert!(lock_call_base(cfg, &LockParams { claimer: "0x0000000000000000000000000000000000000000", ..ok }).is_err());
    assert!(lock_call_base(cfg, &LockParams { deadline: 0, ..ok }).is_err());
    assert!(approve_call(cfg, cfg.base.usdc_max + 1).is_err());
    assert!(approve_call(cfg, 0).is_err());
    assert!(claim_call_base(cfg, "0x12", claimer).is_err());
    assert!(cancel_call("not an address").is_err());
    assert_eq!(keccak256(b""), hex_literal("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"));
}

fn hex_literal(h: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    hex::decode_to_slice(h, &mut out).unwrap();
    out
}

// ── Codec ───────────────────────────────────────────────────────────────────

#[test]
fn codec_matches_the_kit() {
    let v = vectors();
    let c = &v["codec"];
    for t in c["tokenHashes"].as_array().unwrap() {
        assert_eq!(token_hash_of(s(&t["token"])).unwrap(), s(&t["hash"]));
    }
    for x in c["secretHashes"].as_array().unwrap() {
        assert_eq!(hash_of_secret(s(&x["secret"])).unwrap(), s(&x["h"]));
    }
    for (secret, digest) in pins::PHA_HASH_VECTORS {
        assert_eq!(hash_of_secret(secret).unwrap(), digest);
    }
    for d in c["decimals"].as_array().unwrap() {
        assert_eq!(hex_to_decimal(s(&d["hex"])).unwrap(), s(&d["decimal"]));
        assert_eq!(decimal_to_hex(s(&d["decimal"])).unwrap(), s(&d["hex"]));
    }
    for d in c["notDecimal"].as_array().unwrap() {
        assert_eq!(decimal_to_hex(s(&d["input"])).as_deref(), d["hex"].as_str(), "decimal_to_hex({:?})", s(&d["input"]));
    }
}

// ── Store seals ─────────────────────────────────────────────────────────────

#[test]
fn files_sealed_by_the_kit_open_and_reseal_identically() {
    let v = vectors();
    let seals = &v["seals"];
    let key = store_key_from_file(format!("{}\n", s(&seals["key"])).as_bytes()).unwrap();
    let files = seals["files"].as_array().unwrap();
    assert_eq!(files.len(), 2);
    for f in files {
        let net = Network::parse(s(&f["network"])).unwrap();
        let rel = s(&f["rel"]);
        let file: Value = serde_json::from_str(s(&f["file"])).unwrap();
        assert_eq!(s(&file["sealed"]), "aes-256-gcm");
        assert_eq!(file["v"].as_u64(), Some(1));
        let sealed = Sealed { iv: s(&file["iv"]).to_string(), tag: s(&file["tag"]).to_string(), data: s(&file["data"]).to_string() };
        let plain = unseal(&key, net, rel, &sealed).unwrap();
        assert_eq!(std::str::from_utf8(&plain).unwrap(), s(&f["plain"]));
        // What the kit read back from the file is the same record.
        let record: Value = serde_json::from_slice(&plain).unwrap();
        assert_eq!(record, f["record"]);
        // Sealing the same bytes with the same IV gives the kit's file, byte for byte.
        let mut iv = [0u8; IV_BYTES];
        iv.copy_from_slice(&base64_decode(&sealed.iv));
        let again = seal(&key, net, rel, &plain, iv).unwrap();
        assert_eq!(again.to_file_text(), s(&f["file"]));
        // Another place, network or key does not open it.
        assert!(unseal(&key, net, "secrets/elsewhere.json", &sealed).is_err());
        let other_net = if net == Network::Devnet { Network::Mainnet } else { Network::Devnet };
        assert!(unseal(&key, other_net, rel, &sealed).is_err());
        let mut wrong = *key;
        wrong[0] ^= 1;
        assert!(unseal(&wrong, net, rel, &sealed).is_err());
    }
}

fn base64_decode(s: &str) -> Vec<u8> {
    // Small decoder for the test (the crate's own decoder is what is tested above).
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let mut buf = 0u32;
    let mut bits = 0;
    for c in s.bytes().filter(|&c| c != b'=') {
        buf = (buf << 6) | ALPHABET.iter().position(|&a| a == c).unwrap() as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    out
}

#[test]
fn store_key_files_are_read_like_the_kit() {
    assert!(store_key_from_file(&[7u8; 32]).is_ok());
    assert!(store_key_from_file(format!("  {}  \n", "ab".repeat(32)).as_bytes()).is_ok());
    assert!(store_key_from_file(b"too short").is_err());
    assert!(store_key_from_file(format!("{}\n", "zz".repeat(32)).as_bytes()).is_err());
}
