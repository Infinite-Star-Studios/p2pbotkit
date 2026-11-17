//! Key files, compatible with the TypeScript kit's (`src/keys.ts`,
//! `examples/new-keys.ts`):
//!
//! - `<name>-pha.json`: `{"wif":"…"}`; `<name>-base.json`: `{"privateKey":"0x…"}`;
//! - a key file must be a regular file of at most 4 KB that neither group
//!   nor others can read or write (`chmod 600`), checked on the opened file;
//! - a WIF's checksum is checked before it is read;
//! - a key that appears on the command line, or whose address is an admin,
//!   owner or keeper address (check 68), is refused;
//! - new key files are created 0600 in a 0700 folder, never over an existing
//!   file, fsynced, then read back through the same loader.

use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use p2pbot_core::evm::EvmKey;
use p2pbot_core::phantasma::{is_user_address_text, wif_ok, PhaKeys};
use p2pbot_core::pins::{known_role_problem, Network};
use p2pbot_core::{Error, Result};
use serde_json::Value;
use zeroize::Zeroizing;

/// The largest secret file the kit reads (a key file is well under 200 bytes).
pub const SECRET_FILE_MAX: u64 = 4096;

/// The names made when none is given: the two example bots.
pub const DEFAULT_NAMES: [&str; 2] = ["seller", "buyer"];

/// Read a file that holds a secret: a regular file of this size or less that
/// neither group nor others can read, write or execute (mode & 0o077 == 0).
pub fn read_secret_file(path: &Path, what: &str) -> Result<Zeroizing<Vec<u8>>> {
    let p = path.display();
    let f = File::open(path).map_err(|e| Error::new("KEY_FILE", format!("The {what} file {p} cannot be opened ({}).", e.kind())))?;
    let meta = f.metadata().map_err(|e| Error::new("KEY_FILE", format!("The {what} file {p} cannot be read ({}).", e.kind())))?;
    if !meta.is_file() {
        return Err(Error::new("KEY_FILE", format!("The {what} file {p} is not a regular file.")));
    }
    let mode = meta.permissions().mode();
    if mode & 0o077 != 0 {
        return Err(Error::new(
            "KEY_FILE_MODE",
            format!("The {what} file {p} can be read or changed by other users (mode {:o}). Run: chmod 600 {p}", mode & 0o777),
        ));
    }
    if meta.len() > SECRET_FILE_MAX {
        return Err(Error::new("KEY_FILE", format!("The {what} file {p} is larger than a key file can be.")));
    }
    let mut buf = Zeroizing::new(Vec::new());
    f.take(SECRET_FILE_MAX + 1).read_to_end(&mut buf).map_err(|e| Error::new("KEY_FILE", format!("The {what} file {p} cannot be read ({}).", e.kind())))?;
    Ok(buf)
}

/// One string field of a key file's JSON object, trimmed (the error never quotes the content).
fn key_field(buf: &[u8], path: &Path, what: &str, field: &str) -> Result<Zeroizing<String>> {
    let p = path.display();
    let v: Value = serde_json::from_slice(buf).map_err(|_| Error::new("KEY_FILE", format!("The {what} file {p} is not JSON.")))?;
    let obj = v.as_object().ok_or_else(|| Error::new("KEY_FILE", format!("The {what} file {p} is not a JSON object.")))?;
    Ok(Zeroizing::new(obj.get(field).and_then(Value::as_str).map(str::trim).unwrap_or_default().to_string()))
}

/// The Phantasma key from its file, with the text it was read from.
pub fn load_pha_key(path: &Path) -> Result<(PhaKeys, Zeroizing<String>)> {
    let buf = read_secret_file(path, "Phantasma key")?;
    let wif = key_field(&buf, path, "Phantasma key", "wif")?;
    let p = path.display();
    if wif.is_empty() {
        return Err(Error::new("KEY_FILE", format!("The Phantasma key file {p} has no \"wif\" field.")));
    }
    if !wif_ok(&wif) {
        return Err(Error::new("KEY_FILE", format!("The \"wif\" in {p} is not a valid Phantasma WIF (its checksum or shape is wrong).")));
    }
    let keys = PhaKeys::from_wif(&wif)?;
    if !is_user_address_text(keys.address()) {
        return Err(Error::new("KEY_FILE", format!("The key in {p} does not give a Phantasma user address.")));
    }
    Ok((keys, wif))
}

/// The Base key from its file, with the text it was read from.
pub fn load_base_key(path: &Path) -> Result<(EvmKey, Zeroizing<String>)> {
    let buf = read_secret_file(path, "Base key")?;
    let pk = key_field(&buf, path, "Base key", "privateKey")?;
    let p = path.display();
    let b = pk.as_bytes();
    if b.len() != 66 || !pk.starts_with("0x") || !b[2..].iter().all(u8::is_ascii_hexdigit) {
        return Err(Error::new("KEY_FILE", format!("The Base key file {p} needs \"privateKey\": \"0x\" followed by 64 hex digits.")));
    }
    let mut raw = Zeroizing::new([0u8; 32]);
    hex::decode_to_slice(&pk[2..], &mut raw[..]).map_err(|_| Error::new("KEY_FILE", format!("The \"privateKey\" in {p} is not hex.")))?;
    let key = EvmKey::from_private_key(&raw).map_err(|_| Error::new("KEY_FILE", format!("The \"privateKey\" in {p} is not a valid secp256k1 key.")))?;
    Ok((key, pk))
}

/// Why a command line carries a loaded key, or `None`.
pub fn argv_key_problem(argv: &[String], material: &[&str]) -> Option<&'static str> {
    let needles: Vec<String> = material.iter().filter(|m| m.len() >= 32).map(|m| m.to_ascii_lowercase().trim_start_matches("0x").to_string()).collect();
    let found = argv.iter().any(|a| {
        let s = a.to_ascii_lowercase();
        needles.iter().any(|n| s.contains(n.as_str()))
    });
    found.then_some("A key appears on the command line. Keys are read only from their key files; remove it from the command (and from your shell history).")
}

fn is_b58(c: char) -> bool {
    c.is_ascii_alphanumeric() && !matches!(c, '0' | 'O' | 'I' | 'l')
}

/// Whether any argument looks like a key or a secret: a WIF, 64 hex digits,
/// or a `sat_` API key. Commands that never take one refuse such an argument.
pub fn secret_shaped_arg(argv: &[String]) -> bool {
    argv.iter().any(|a| {
        // A WIF: a whole run of base58 of 51 characters from '5', or 52 from 'K' or 'L'.
        let wif = a
            .split(|c: char| !is_b58(c))
            .any(|run| (run.len() == 51 && run.starts_with('5')) || (run.len() == 52 && (run.starts_with('K') || run.starts_with('L'))));
        // 64 hex digits in a row.
        let hex64 = a.split(|c: char| !c.is_ascii_hexdigit()).any(|run| run.len() >= 64);
        // An API key: sat_ at a word start and 8 or more key characters.
        let api = a.match_indices("sat_").any(|(i, _)| {
            let start_ok = a[..i].chars().last().is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'));
            let tail = a[i + 4..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').count();
            start_ok && tail >= 8
        });
        wif || hex64 || api
    })
}

/// A bot's two keys. Printing it shows the addresses only.
#[derive(Debug)]
pub struct LoadedKeys {
    /// The network they were checked for.
    pub network: Network,
    /// The Phantasma key.
    pub pha: PhaKeys,
    /// The Base key.
    pub base: EvmKey,
}

/// Load both keys (mode 0600), check that neither is on the command line and
/// that neither holds a forbidden role (check 68).
pub fn load_keys(network: Network, pha_file: &Path, base_file: &Path, argv: &[String]) -> Result<LoadedKeys> {
    let (pha, wif) = load_pha_key(pha_file)?;
    let (base, pk) = load_base_key(base_file)?;
    if let Some(why) = argv_key_problem(argv, &[wif.as_str(), pk.as_str()]) {
        return Err(Error::new("KEY_ARGV", why));
    }
    if let Some(why) = known_role_problem(Some(pha.address()), Some(&base.address_checksummed()), &[], &[]) {
        return Err(Error::new("KEY_ROLE", why));
    }
    Ok(LoadedKeys { network, pha, base })
}

/// What [`make_key_pairs`] did for one name.
#[derive(Debug)]
pub struct KeyPairResult {
    /// The pair's name.
    pub name: String,
    /// `<dir>/<name>-pha.json`.
    pub pha_file: PathBuf,
    /// `<dir>/<name>-base.json`.
    pub base_file: PathBuf,
    /// False when the files were already there (left as they are).
    pub created: bool,
    /// The addresses, when the pair could be read.
    pub addresses: Option<(String, String)>,
    /// Why an existing pair was left alone.
    pub note: Option<String>,
}

fn name_ok(n: &str) -> bool {
    let b = n.as_bytes();
    !b.is_empty() && b.len() <= 32 && b[0].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'-')
}

/// Create `path` with `content`, mode 0600, never over an existing file; fsynced.
fn write_new(path: &Path, content: &[u8]) -> std::io::Result<()> {
    let mut f = OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)?;
    f.write_all(content)?;
    f.set_permissions(fs::Permissions::from_mode(0o600))?;
    f.sync_all()
}

fn random32() -> Result<Zeroizing<[u8; 32]>> {
    let mut b = Zeroizing::new([0u8; 32]);
    getrandom::getrandom(&mut b[..]).map_err(|_| Error::new("RANDOM", "the operating system gave no random bytes"))?;
    Ok(b)
}

/// Make (or report) the key pairs of `names` in `dir`. Existing files are
/// never replaced: a pair already there is read back for its addresses, and
/// half a pair is reported for the operator to sort out.
pub fn make_key_pairs(dir: &Path, names: &[String]) -> Result<Vec<KeyPairResult>> {
    for n in names {
        if !name_ok(n) {
            return Err(Error::bad_input(format!(
                "A key pair's name is 1 to 32 letters, digits, \"-\" or \"_\" (got \"{}\").",
                n.chars().take(40).collect::<String>()
            )));
        }
    }
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|e| Error::new("KEY_FILE", format!("{} cannot be made ({}).", dir.display(), e.kind())))?;
    let mut out = Vec::new();
    for name in names {
        let pha_file = dir.join(format!("{name}-pha.json"));
        let base_file = dir.join(format!("{name}-base.json"));
        let (has_pha, has_base) = (pha_file.exists(), base_file.exists());
        if has_pha || has_base {
            let (addresses, note) = if has_pha && has_base {
                match load_keys(Network::Devnet, &pha_file, &base_file, &[]) {
                    Ok(k) => (Some((k.pha.address().to_string(), k.base.address_checksummed())), "already there; left as it is".to_string()),
                    Err(e) => (None, format!("already there, but not usable: {}", e.detail)),
                }
            } else {
                let there = if has_pha { &pha_file } else { &base_file };
                (None, format!("only {} is there; nothing was written. Move it away (it may hold funds) or add the other file", there.display()))
            };
            out.push(KeyPairResult { name: name.clone(), pha_file, base_file, created: false, addresses, note: Some(note) });
            continue;
        }
        // A fresh Phantasma key, checked and round-tripped through its WIF before it is written.
        let pha = PhaKeys::from_private_key(&*random32()?);
        let wif = pha.to_wif();
        if !wif_ok(&wif) || PhaKeys::from_wif(&wif)?.address() != pha.address() {
            return Err(Error::new("KEY_FILE", "a fresh Phantasma key did not read back to the same address"));
        }
        // A fresh Base key (a random scalar; out-of-range draws are drawn again).
        let (base, pk) = loop {
            let raw = random32()?;
            if let Ok(k) = EvmKey::from_private_key(&raw) {
                break (k, Zeroizing::new(format!("0x{}", hex::encode(&raw[..]))));
            }
        };
        let pha_json = Zeroizing::new(format!("{}\n", serde_json::json!({ "wif": wif.as_str() })));
        let base_json = Zeroizing::new(format!("{}\n", serde_json::json!({ "privateKey": pk.as_str() })));
        write_new(&pha_file, pha_json.as_bytes()).map_err(|e| Error::new("KEY_FILE", format!("{} cannot be written ({}).", pha_file.display(), e.kind())))?;
        if let Err(e) = write_new(&base_file, base_json.as_bytes()) {
            // Never leave half a pair that was just made: nothing was funded yet.
            let _ = fs::remove_file(&pha_file);
            return Err(Error::new("KEY_FILE", format!("{} cannot be written ({}).", base_file.display(), e.kind())));
        }
        File::open(dir).and_then(|d| d.sync_all()).map_err(|e| Error::new("KEY_FILE", format!("{} cannot be synced ({}).", dir.display(), e.kind())))?;
        // Read back through the loader: the modes, the WIF checksum, the addresses.
        let k = load_keys(Network::Devnet, &pha_file, &base_file, &[])?;
        if k.pha.address() != pha.address() || k.base.address() != base.address() {
            return Err(Error::new("KEY_FILE", format!("the key files of {name} did not read back to the addresses just made")));
        }
        out.push(KeyPairResult {
            name: name.clone(),
            pha_file,
            base_file,
            created: true,
            addresses: Some((k.pha.address().to_string(), k.base.address_checksummed())),
            note: None,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use p2pbot_core::codec::sha256;
    use p2pbot_core::phantasma::wif_of;

    fn temp_dir(tag: &str) -> PathBuf {
        let mut r = [0u8; 8];
        getrandom::getrandom(&mut r).unwrap();
        let d = std::env::temp_dir().join(format!("p2pbot-{tag}-{}", hex::encode(r)));
        DirBuilder::new().recursive(true).mode(0o700).create(&d).unwrap();
        d
    }

    #[test]
    fn new_keys_are_private_and_read_back() {
        let dir = temp_dir("new");
        let keys = dir.join("keys");
        let made = make_key_pairs(&keys, &["market".to_string()]).unwrap();
        assert!(made[0].created);
        for f in [&made[0].pha_file, &made[0].base_file] {
            assert_eq!(fs::metadata(f).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert_eq!(fs::metadata(&keys).unwrap().permissions().mode() & 0o777, 0o700);
        let text = fs::read_to_string(&made[0].pha_file).unwrap();
        assert!(text.starts_with("{\"wif\":\"") && text.ends_with("\"}\n"));
        // A second run leaves them as they are.
        let again = make_key_pairs(&keys, &["market".to_string()]).unwrap();
        assert!(!again[0].created);
        assert_eq!(again[0].addresses, made[0].addresses);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn readable_key_files_are_refused() {
        let dir = temp_dir("mode");
        let f = dir.join("k-pha.json");
        fs::write(&f, format!("{{\"wif\":\"{}\"}}\n", wif_of(&sha256(b"mode test")))).unwrap();
        fs::set_permissions(&f, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(load_pha_key(&f).unwrap_err().code, "KEY_FILE_MODE");
        fs::set_permissions(&f, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(load_pha_key(&f).is_ok());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn typescript_key_files_load_to_the_same_addresses() {
        // A key file as the TypeScript kit writes it, for the first key of test/fixtures/sdk-vectors.json.
        let dir = temp_dir("ts");
        let label = "saturn-p2p-bot-kit sdk vector key 0";
        let pha = dir.join("v-pha.json");
        let base = dir.join("v-base.json");
        write_new(&pha, format!("{{\"wif\":\"{}\"}}\n", wif_of(&sha256(label.as_bytes()))).as_bytes()).unwrap();
        write_new(&base, format!("{{\"privateKey\":\"0x{}\"}}\n", hex::encode(sha256(label.as_bytes()))).as_bytes()).unwrap();
        let k = load_keys(Network::Mainnet, &pha, &base, &[]).unwrap();
        assert_eq!(k.pha.address(), "P2KJECxUM4DUw6VU8ihTKAXxXB1iAAA62Kv1QzjLWPKpgaL");
        assert_eq!(k.base.address_checksummed(), "0x46cCFDDf40A1b04980e6cd05153b67a786258f78");
        // The key on the command line is refused.
        let argv = vec![format!("--x={}", hex::encode(sha256(label.as_bytes())))];
        assert_eq!(load_keys(Network::Mainnet, &pha, &base, &argv).unwrap_err().code, "KEY_ARGV");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn secret_shaped_args_are_spotted() {
        let wif = wif_of(&sha256(b"x"));
        assert!(secret_shaped_arg(std::slice::from_ref(&wif)));
        assert!(secret_shaped_arg(&[format!("--key={wif}")]));
        assert!(secret_shaped_arg(&["ab".repeat(32)]));
        assert!(secret_shaped_arg(&["sat_abcdefgh".to_string()]));
        assert!(!secret_shaped_arg(&["--dir".to_string(), "keys/mainnet".to_string(), "--name".to_string(), "market".to_string()]));
        assert!(!secret_shaped_arg(&["xsat_abcdefgh".to_string()]));
    }
}
