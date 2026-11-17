//! The Phantasma side against the kit's own known answers,
//! `test/fixtures/sdk-vectors.json` (what phantasma-sdk-ts gives for the
//! kit's keys, escrow transactions and view scripts), byte for byte.

use p2pbot_core::codec::sha256;
use p2pbot_core::phantasma::{self, claim_call, escrow_transaction, lock_call, refund_call, view_scripts, wif_of, wif_ok, PhaCall, PhaKeys};
use p2pbot_core::pins::{config, Network};
use serde_json::Value;

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../test/fixtures/sdk-vectors.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("test/fixtures/sdk-vectors.json")).unwrap()
}

/// The key of a vector label: its private key is the SHA-256 of the label.
fn keys_of(label: &str) -> PhaKeys {
    PhaKeys::from_private_key(&sha256(label.as_bytes()))
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap()
}

#[test]
fn keys_and_addresses() {
    let v = vectors();
    let keys = v["keys"].as_array().unwrap();
    assert_eq!(keys.len(), 8);
    for k in keys {
        let pair = keys_of(s(&k["label"]));
        assert_eq!(pair.address(), s(&k["address"]), "address of {}", s(&k["label"]));
        assert_eq!(hex::encode(pair.public_key()), s(&k["publicKey"]));
        assert!(phantasma::is_user_address_text(pair.address()));
        // Through the WIF, as a key file is read.
        let wif = wif_of(&sha256(s(&k["label"]).as_bytes()));
        assert!(wif_ok(&wif));
        assert_eq!(PhaKeys::from_wif(&wif).unwrap().address(), s(&k["address"]));
    }
}

#[test]
fn a_wif_with_a_wrong_checksum_is_refused() {
    let wif = wif_of(&sha256(b"some label"));
    let last = wif.chars().last().unwrap();
    let swapped = if last == '1' { '2' } else { '1' };
    let bad = format!("{}{}", &wif[..wif.len() - 1], swapped);
    assert!(!wif_ok(&bad));
    assert!(PhaKeys::from_wif(&bad).is_err());
}

#[test]
fn escrow_transactions_byte_for_byte() {
    let v = vectors();
    let keys = v["keys"].as_array().unwrap();
    let configs = v["escrowConfigs"].as_array().unwrap();
    let escrow = v["escrow"].as_array().unwrap();
    assert_eq!(escrow.len(), 24);
    for (i, e) in escrow.iter().enumerate() {
        let c = &configs[e["config"].as_u64().unwrap() as usize];
        let net = Network::parse(s(&c["network"])).unwrap();
        let cfg = config(net);
        // The vectors' escrow, nexus and chain are the kit's pins.
        assert_eq!(cfg.pha_contract, s(&c["phaContract"]));
        assert_eq!(cfg.pha.nexus, s(&c["nexus"]));
        assert_eq!(cfg.pha.chain, s(&c["chain"]));
        let signer = keys_of(s(&keys[e["key"].as_u64().unwrap() as usize]["label"]));
        let from = signer.address().to_string();
        let call: PhaCall = match s(&e["method"]) {
            "lock" => {
                let recipient = keys_of(s(&keys[e["recipient"].as_u64().unwrap() as usize]["label"]));
                let amount: u128 = s(&e["amount"]).parse().unwrap();
                lock_call(cfg, &from, s(&e["h"]), s(&e["symbol"]), amount, recipient.address(), e["deadline"].as_u64().unwrap()).unwrap()
            }
            "claim" => claim_call(cfg, s(&e["secret"])).unwrap(),
            "refund" => refund_call(cfg, s(&e["h"])).unwrap(),
            m => panic!("unexpected method {m}"),
        };
        let mut tx = escrow_transaction(cfg, &from, &call, e["expiresAtMs"].as_u64().unwrap()).unwrap();
        assert_eq!(hex::encode(tx.to_bytes(false).unwrap()), s(&e["unsigned"]), "unsigned escrow vector {i} ({})", s(&e["method"]));
        tx.sign(&signer).unwrap();
        assert_eq!(tx.signed_hex().unwrap(), s(&e["signed"]), "signed escrow vector {i} ({})", s(&e["method"]));
    }
}

#[test]
fn view_scripts_byte_for_byte() {
    let v = vectors();
    let views = v["views"].as_array().unwrap();
    assert_eq!(views.len(), 60);
    for (i, view) in views.iter().enumerate() {
        let calls: Vec<PhaCall> = view["calls"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| PhaCall {
                contract: s(&c["contract"]).to_string(),
                method: s(&c["method"]).to_string(),
                args: c["args"].as_array().unwrap().iter().map(|a| s(a).to_string()).collect(),
            })
            .collect();
        let want: Vec<String> = view["scripts"].as_array().expect("every vector has scripts").iter().map(|x| s(x).to_string()).collect();
        assert_eq!(view_scripts(&calls).unwrap(), want, "view vector {i} ({})", s(&view["from"]));
    }
}

#[test]
fn escrow_inputs_are_checked_like_the_kit() {
    let cfg = config(Network::Devnet);
    let pair = keys_of("check");
    let h = format!("0x{}", "ab".repeat(32));
    assert_eq!(lock_call(cfg, pair.address(), &h, "soul", 1, pair.address(), 1).unwrap_err().code, "TOKEN_NOT_TRADED");
    assert!(lock_call(cfg, pair.address(), &h, "SOUL", 0, pair.address(), 1).is_err());
    assert!(lock_call(cfg, pair.address(), &h, "SOUL", 1, pair.address(), 0).is_err());
    assert!(lock_call(cfg, pair.address(), &h, "SOUL", 1, pair.address(), 1 << 53).is_err());
    assert!(lock_call(cfg, pair.address(), "0x1234", "SOUL", 1, pair.address(), 1).is_err());
    let other = PhaCall { contract: "notescrow".into(), method: "lock".into(), args: vec![] };
    assert!(escrow_transaction(cfg, pair.address(), &other, 1_795_000_000_000).is_err());
    let not_escrow_method = PhaCall { contract: "saturnescrow".into(), method: "drain".into(), args: vec![] };
    assert!(escrow_transaction(cfg, pair.address(), &not_escrow_method, 1_795_000_000_000).is_err());
}
