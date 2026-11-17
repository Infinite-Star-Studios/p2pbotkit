//! The network, for the read-only commands: a Phantasma node over HTTPS
//! JSON-RPC, with the kit's rules (check 67): only the network's pinned
//! RPC, never a redirect, a timeout on every request, and a node's error
//! answer is an error, never a value.

use std::time::Duration;

use p2pbot_core::codec::sha256;
use p2pbot_core::phantasma::{PhaNode, ScriptAnswer};
use p2pbot_core::pins::NetConfig;
use p2pbot_core::{Error, Result};
use serde_json::{json, Value};

/// A Phantasma node: the network's pinned RPC only.
pub struct HttpNode {
    agent: ureq::Agent,
    url: &'static str,
    id: u64,
}

impl HttpNode {
    /// The pinned node of this network.
    pub fn pinned(cfg: &NetConfig) -> Self {
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(15)).redirects(0).try_proxy_from_env(true).build();
        Self { agent, url: cfg.pha.rpc_url, id: 0 }
    }

    /// The pinned RPC's URL.
    pub fn url(&self) -> &str {
        self.url
    }

    /// One JSON-RPC call: its `result`, or an error with the node's message (cut short).
    pub fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        self.id += 1;
        let body = json!({ "jsonrpc": "2.0", "method": method, "params": params, "id": self.id.to_string() }).to_string();
        let text = match self.agent.post(self.url).set("content-type", "application/json").send_string(&body) {
            Ok(r) => r.into_string().map_err(|e| Error::new("PHA_RPC", format!("Phantasma {method}: the answer could not be read ({e})")))?,
            Err(ureq::Error::Status(code, _)) => return Err(Error::new("PHA_RPC", format!("Phantasma {method}: HTTP {code}"))),
            Err(e) => return Err(Error::new("PHA_RPC", format!("Phantasma {method}: no answer ({})", e.kind()))),
        };
        let v: Value = serde_json::from_str(&text).map_err(|_| Error::new("PHA_RPC", format!("Phantasma {method}: the answer is not JSON")))?;
        // A node answers a good invokeRawScript with "error": "" beside its results: only a non-empty error fails.
        let failed = |e: &Value| !(e.is_null() || e.as_str() == Some(""));
        if failed(&v["error"]) || (v["result"].is_object() && failed(&v["result"]["error"])) {
            let msg = if failed(&v["error"]) { &v["error"] } else { &v["result"]["error"] };
            let text: String = msg.as_str().map(str::to_string).unwrap_or_else(|| msg.to_string()).chars().take(200).collect();
            return Err(Error::new("PHA_RPC", format!("Phantasma {method}: {text}")));
        }
        Ok(v["result"].clone())
    }

    /// The escrow's deployed script as the node serves it now: the SHA-256 of
    /// its bytes (`None` when it is empty or not hex) and its method names.
    pub fn contract_code(&mut self, cfg: &NetConfig) -> Result<(Option<String>, Vec<String>)> {
        let c = self.call("getContract", json!([cfg.pha.chain, cfg.pha_contract]))?;
        if !c.is_object() {
            return Err(Error::new("PHA_RPC", "Phantasma getContract: no contract"));
        }
        let script = c["script"].as_str().unwrap_or("").trim();
        let sha = (!script.is_empty() && script.len() % 2 == 0).then(|| hex::decode(script).ok()).flatten().map(|b| hex::encode(sha256(&b)));
        let methods = c["methods"].as_array().map(|a| a.iter().filter_map(|m| m["name"].as_str().map(str::to_string)).collect()).unwrap_or_default();
        Ok((sha, methods))
    }
}

impl PhaNode for HttpNode {
    fn invoke_raw_script(&mut self, chain: &str, script: &str) -> Result<ScriptAnswer> {
        let r = self.call("invokeRawScript", json!([chain, script]))?;
        Ok(match &r {
            Value::String(s) => ScriptAnswer { results: None, result: Some(s.clone()) },
            Value::Object(_) => ScriptAnswer {
                results: r["results"].as_array().map(|a| a.iter().map(|x| x.as_str().map(str::to_string)).collect()),
                result: r["result"].as_str().map(str::to_string),
            },
            _ => ScriptAnswer::default(),
        })
    }
}
