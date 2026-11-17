//! Reading Phantasma against the kit's own known answers
//! (`test/fixtures/sdk-vectors.json`): the 164 decoded node answers, and
//! the kit's 18 escrow reads over the devnet node's recorded answers.
//!
//! The rule for decoding: every well-formed answer (`kit`, `live`) reads
//! exactly as the kit reads it. A `corpus` or `malformed` answer reads
//! exactly as the kit reads it, or gives no value where the kit's SDK reads
//! a cut-short or malformed answer leniently. The port may refuse more, and
//! must never read a different value.

use p2pbot_core::phantasma::reader::{admin, hash_secrets, read_lock, read_open_cap, read_params};
use p2pbot_core::phantasma::vm::{decode_views, view_address, view_int};
use p2pbot_core::phantasma::{PhaNode, ScriptAnswer, VmValue};
use p2pbot_core::pins::{config, Network};
use p2pbot_core::{Error, Result};
use serde_json::{json, Value};

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../test/fixtures/sdk-vectors.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("test/fixtures/sdk-vectors.json")).unwrap()
}

/// The kit's `canon` form of a decoded value (`test/fixtures/sdk-vectors.ts`).
fn canon(v: Option<&VmValue>) -> Value {
    match v {
        None => json!({ "nil": true }),
        Some(VmValue::Str(s) | VmValue::Num(s) | VmValue::Obj(s)) => json!({ "s": s }),
        Some(VmValue::Bool(b)) => json!({ "b": b }),
        Some(VmValue::Enum(n)) => json!({ "num": n.to_string() }),
        Some(VmValue::Struct(fields)) => json!({ "o": "Object", "e": fields.iter().map(|(k, v)| json!([k, canon(Some(v))])).collect::<Vec<_>>() }),
    }
}

/// The values the kit read from one answer: `value` = one call answered by
/// `results: [hex]`; `stream` = 8 calls answered by one hex `result`.
fn port_reads(mode: &str, hex: &str) -> Vec<Option<VmValue>> {
    match mode {
        "value" => decode_views(Some(&[Some(hex.to_string())]), None, 1),
        "stream" => decode_views(None, Some(hex), 8),
        m => panic!("unknown mode {m}"),
    }
}

#[test]
fn decoded_answers_match_the_kit() {
    let v = vectors();
    let decode = v["decode"].as_array().unwrap();
    assert_eq!(decode.len(), 164);
    let (mut exact, mut refused) = (0, 0);
    for (i, x) in decode.iter().enumerate() {
        let from = x["from"].as_str().unwrap();
        // The kit's own SDK's reading: `pinned` where it differs from 0.4.0's.
        let kit = if x.get("pinned").is_some() { &x["pinned"] } else { x };
        let values = port_reads(x["mode"].as_str().unwrap(), x["hex"].as_str().unwrap());
        let (outs, ints, addrs) = (kit["out"].as_array().unwrap(), kit["int"].as_array().unwrap(), kit["address"].as_array().unwrap());
        assert_eq!(values.len(), outs.len(), "vector {i}: number of values");
        for (j, value) in values.iter().enumerate() {
            let got = (canon(value.as_ref()), view_int(value.as_ref()).map_or(Value::Null, Value::from), Value::from(view_address(value.as_ref())));
            let want = (outs[j].clone(), ints[j].clone(), addrs[j].clone());
            if got == want {
                exact += 1;
                continue;
            }
            // Not the kit's reading: allowed only as "no value", and only where the answer is not well formed.
            let well_formed = from == "kit" || from == "live";
            assert!(value.is_none() && !well_formed, "vector {i} ({from}) value {j}: the port read {got:?}, the kit {want:?}",);
            assert_eq!((got.1.clone(), got.2.clone()), (Value::Null, Value::from("")));
            refused += 1;
        }
    }
    // Every well-formed answer read exactly; the rest is the port refusing lenient readings.
    println!("decoded: {exact} values as the kit reads them, {refused} refused where the kit's SDK reads a malformed answer leniently");
    assert!(exact > 200, "too few exact readings: {exact}");
}

/// A node that answers only the scripts recorded from the devnet node, so a
/// script built differently from the kit's fails the read instead of being answered.
struct Replay {
    node: Vec<Value>,
}

impl PhaNode for Replay {
    fn invoke_raw_script(&mut self, chain: &str, script: &str) -> Result<ScriptAnswer> {
        assert_eq!(chain, "main");
        let hit =
            self.node.iter().find(|x| x["script"].as_str() == Some(script)).ok_or_else(|| Error::new("PHA_READ", "no recorded answer for this request"))?;
        Ok(ScriptAnswer {
            results: hit["results"].as_array().map(|a| a.iter().map(|r| r.as_str().map(str::to_string)).collect()),
            result: hit["result"].as_str().map(str::to_string),
        })
    }
}

#[test]
fn escrow_reads_match_the_kit_over_recorded_devnet_answers() {
    let v = vectors();
    let cfg = config(Network::Devnet);
    assert_eq!(v["escrowConfigs"][0]["network"], "devnet");
    let mut node = Replay { node: v["node"].as_array().unwrap().clone() };
    let reads = v["reads"].as_array().unwrap();
    assert_eq!(reads.len(), 18);
    for (i, r) in reads.iter().enumerate() {
        let args: Vec<&str> = r["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect();
        let want = &r["result"];
        assert!(want.get("error").is_none(), "read {i}: the recorded read failed in the kit");
        let got: Value = match r["read"].as_str().unwrap() {
            "readLock" => {
                let l = read_lock(&mut node, cfg, args[0]).unwrap();
                json!({ "h": l.h, "state": l.state, "sender": l.sender, "recipient": l.recipient, "symbol": l.symbol,
                        "amount": l.amount.to_string(), "deadline": l.deadline, "created": l.created, "secret": l.secret })
            }
            "readParams" => {
                let p = read_params(&mut node, cfg, args[0]).unwrap();
                json!({ "paused": p.paused, "minLock": p.min_lock, "maxLock": p.max_lock, "minAmount": p.min_amount.to_string(), "maxAmount": p.max_amount.to_string() })
            }
            "readOpenCap" => {
                let c = read_open_cap(&mut node, cfg, args[0]).unwrap();
                json!({ "openAmount": c.open_amount.to_string(), "maxOpen": c.max_open.to_string() })
            }
            "admin" => json!(admin(&mut node, cfg).unwrap()),
            "hashSecrets" => json!(hash_secrets(&mut node, cfg, &args).unwrap()),
            other => panic!("unknown read {other}"),
        };
        assert_eq!(&got, want, "read {i}: {}", r["read"]);
    }
}

#[test]
fn a_gap_is_never_a_reading() {
    // A node that answers nothing usable: every read is an error, never a default.
    struct Empty;
    impl PhaNode for Empty {
        fn invoke_raw_script(&mut self, _: &str, _: &str) -> Result<ScriptAnswer> {
            Ok(ScriptAnswer::default())
        }
    }
    let cfg = config(Network::Devnet);
    let h = format!("0x{}", "ab".repeat(32));
    assert!(read_lock(&mut Empty, cfg, &h).is_err());
    assert!(read_params(&mut Empty, cfg, "TAZ").is_err());
    assert!(read_open_cap(&mut Empty, cfg, "TAZ").is_err());
    assert!(admin(&mut Empty, cfg).is_err());
    assert_eq!(read_params(&mut Empty, cfg, "taz").unwrap_err().code, "TOKEN_NOT_TRADED");
}
