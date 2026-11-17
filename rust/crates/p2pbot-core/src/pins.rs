//! The kit's compiled-in trust, ported from `src/pins.ts`: the token table,
//! both networks (escrow, chains, fee caps, timing) and the addresses a bot
//! must never hold. The board's `/config` and every price feed are display
//! data; only these values feed a signature.
//!
//! `tests/kit_vectors.rs` checks every value here against what the
//! TypeScript kit compiles in (`rust/fixtures/kit-vectors.json`), so the two
//! cannot drift apart unseen.

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;

/// The escrow contract on Phantasma.
pub const PHA_CONTRACT: &str = "saturnescrow";
/// The P2P board.
pub const DEFAULT_API: &str = "https://apiops.saturnx.cc";
/// USDC's decimals.
pub const USDC_DECIMALS: u32 = 6;
/// The highest fee a trade may carry, in basis points.
pub const MAX_FEE_BPS: u16 = 200;
/// The smallest trade, raw USDC.
pub const MIN_TRADE_USDC: u128 = 1_000_000;
/// SOUL kept back on a seller's Phantasma address, raw.
pub const SOUL_RESERVE: u128 = 110_000_000;
/// The largest clock skew the kit accepts against Base's newest block, seconds.
pub const CLOCK_SKEW_MAX: u64 = 5 * 60;
/// How long a signed Phantasma transaction lives, ms.
pub const PHA_TX_TTL_MS: u64 = 5 * 60_000;
/// Gas of the 0-value transfer that takes back an unmined Base nonce.
pub const CANCEL_GAS: u64 = 21_000;
/// A USDC permit's life, seconds.
pub const PERMIT_SECONDS: u64 = 30 * 60;
/// The longest permit the kit signs, seconds.
pub const PERMIT_MAX_SECONDS: u64 = 2 * 3_600;

/// Phantasma gas of every escrow transaction: never fitted to the balance (check 34).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PhaGas {
    /// Gas price.
    pub price: u64,
    /// Gas limit.
    pub limit: u64,
}

/// The fixed gas allowance of the escrow transactions.
pub const PHA_LOCK_GAS: PhaGas = PhaGas { price: 100_000, limit: 300_000 };

/// The payload label of each escrow transaction (the site's and the keeper's).
pub const PHA_TX_LABELS: [(&str, &str); 3] = [("lock", "SATURN_p2pLock"), ("claim", "SATURN_p2pClaim"), ("refund", "SATURN_p2pRefund")];

/// The label of an escrow method, or `None` for any other method.
pub fn pha_tx_label(method: &str) -> Option<&'static str> {
    PHA_TX_LABELS.iter().find(|(m, _)| *m == method).map(|(_, l)| *l)
}

/// SHA-256 vectors that Phantasma's and Base's hashes must agree on.
pub const PHA_HASH_VECTORS: [(&str, &str); 4] = [
    ("0x0000000000000000000000000000000000000000000000000000000000000000", "0x66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925"),
    ("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", "0xaf9613760f72635fbdb44a5a0a63c39f12af30f950a6ee5c971be188e89c4051"),
    ("0x8000000000000000000000000000000000000000000000000000000000000000", "0x84b3f13b0a4fbcce4c3f811e0313e00dcbd27431c229eff576598be8d1afb848"),
    ("0xabababababababababababababababababababababababababababababababab", "0x9a2db2e23f1504cd056606553ac049c5e718e8f9ce9233876df1a7a1821af885"),
];

// ── Tokens ──────────────────────────────────────────────────────────────────

/// One Phantasma token the kit trades. Amounts are raw (smallest units).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Token {
    /// Symbol, exactly as the chain writes it.
    pub symbol: &'static str,
    /// Decimals.
    pub decimals: u32,
    /// Smallest lock.
    pub min: u128,
    /// Largest lock.
    pub max: u128,
    /// Largest offer.
    pub offer_max: u128,
    /// Highest price, raw USDC per whole token.
    pub price_max: u128,
    /// The chain's gas token.
    pub gas: bool,
    /// Can be staked.
    pub stake: bool,
    /// `false`: no new offer or take; trades already running go on.
    pub enabled: bool,
}

/// The token table.
pub const TOKENS: [Token; 5] = [
    Token {
        symbol: "C",
        decimals: 6,
        min: 1_000_000,
        max: 10_000_000_000,
        offer_max: 100_000_000_000,
        price_max: 1_000_000_000_000,
        gas: false,
        stake: false,
        enabled: true,
    },
    Token {
        symbol: "RA",
        decimals: 9,
        min: 1_000_000_000,
        max: 5_000_000_000_000,
        offer_max: 10_000_000_000_000,
        price_max: 1_000_000_000_000,
        gas: false,
        stake: false,
        enabled: true,
    },
    Token {
        symbol: "TAZ",
        decimals: 9,
        min: 1_000_000_000,
        max: 100_000_000_000_000,
        offer_max: 10_000_000_000_000_000,
        price_max: 1_000_000_000_000,
        gas: false,
        stake: false,
        enabled: true,
    },
    Token {
        symbol: "SOUL",
        decimals: 8,
        min: 100_000_000,
        max: 100_000_000_000_000,
        offer_max: 10_000_000_000_000_000,
        price_max: 1_000_000_000_000,
        gas: false,
        stake: true,
        enabled: true,
    },
    Token {
        symbol: "KCAL",
        decimals: 10,
        min: 10_000_000_000,
        max: 300_000_000_000_000_000,
        offer_max: 3_000_000_000_000_000_000,
        price_max: 1_000_000_000_000,
        gas: true,
        stake: false,
        enabled: true,
    },
];

/// Whether `s` has the shape of a symbol: `^[A-Z][A-Z0-9]{0,9}$`.
fn symbol_shaped(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b.len() <= 10 && b[0].is_ascii_uppercase() && b[1..].iter().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

/// The token of a symbol, or `None` for a symbol the kit does not trade.
/// Exact match: `soul` is not SOUL.
pub fn token_of(symbol: &str) -> Option<&'static Token> {
    if !symbol_shaped(symbol) {
        return None;
    }
    TOKENS.iter().find(|t| t.symbol == symbol)
}

/// Whether `name` is a Phantasma contract name: `^[a-z][a-z0-9]{2,31}$`.
pub fn is_contract_name(name: &str) -> bool {
    let b = name.as_bytes();
    (3..=32).contains(&b.len()) && b[0].is_ascii_lowercase() && b[1..].iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

// ── Networks ────────────────────────────────────────────────────────────────

/// The two networks the kit runs on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Network {
    /// Phantasma devnet and Base Sepolia: test tokens only.
    Devnet,
    /// Phantasma and Base mainnets: real funds.
    Mainnet,
}

impl Network {
    /// Both networks, in the kit's order.
    pub const ALL: [Network; 2] = [Network::Devnet, Network::Mainnet];

    /// `devnet` or `mainnet`.
    pub fn name(self) -> &'static str {
        match self {
            Network::Devnet => "devnet",
            Network::Mainnet => "mainnet",
        }
    }

    /// The network of a name, exactly `devnet` or `mainnet`.
    pub fn parse(s: &str) -> Option<Network> {
        match s {
            "devnet" => Some(Network::Devnet),
            "mainnet" => Some(Network::Mainnet),
            _ => None,
        }
    }
}

/// An escrow that takes no new locks but still has some to settle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DrainingEscrow {
    /// Contract name.
    pub name: &'static str,
    /// SHA-256 of its deployed script.
    pub code_sha256: &'static str,
    /// Its admin.
    pub admin: &'static str,
}

/// Phantasma on one network.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PhaNet {
    /// The pinned RPC.
    pub rpc_url: &'static str,
    /// The RPC hosts the kit may read from (check 67).
    pub rpc_hosts: &'static [&'static str],
    /// The nexus name signed into every transaction.
    pub nexus: &'static str,
    /// The chain name signed into every transaction.
    pub chain: &'static str,
    /// Explorer.
    pub explorer_url: &'static str,
}

/// The fee caps of one Base transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FeeCaps {
    /// Largest gas limit.
    pub max_gas: u64,
    /// Largest max fee per gas, wei.
    pub max_fee_per_gas: u128,
    /// Largest priority fee per gas, wei.
    pub max_priority_fee_per_gas: u128,
    /// Largest total fee, wei.
    pub max_fee_wei: u128,
}

/// USDC's EIP-712 domain name and version.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PermitDomain {
    /// Domain name.
    pub name: &'static str,
    /// Domain version.
    pub version: &'static str,
}

/// The chain's native currency.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeCurrency {
    /// Name.
    pub name: &'static str,
    /// Symbol.
    pub symbol: &'static str,
    /// Decimals.
    pub decimals: u32,
}

/// Base on one network.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BaseNet {
    /// Chain name.
    pub name: &'static str,
    /// EIP-155 chain id.
    pub chain_id: u64,
    /// The pinned public RPC.
    pub rpc_url: &'static str,
    /// Explorer.
    pub explorer_url: &'static str,
    /// The SaturnSwap escrow.
    pub swap: &'static str,
    /// USDC (MockUSDC on devnet).
    pub usdc: &'static str,
    /// USDC's symbol.
    pub usdc_symbol: &'static str,
    /// Native currency.
    pub native_currency: NativeCurrency,
    /// Confirmations a lock needs.
    pub confirm_blocks: u64,
    /// Whether the `safe` block confirms instead.
    pub confirm_safe: bool,
    /// Whether USDC has a blacklist to check.
    pub usdc_has_blacklist: bool,
    /// Smallest USDC lock, raw.
    pub usdc_min: u128,
    /// Largest USDC lock, raw.
    pub usdc_max: u128,
    /// USDC's permit domain.
    pub permit: PermitDomain,
    /// Fee caps.
    pub fee_caps: FeeCaps,
    /// Devnet faucet's largest grant, raw (0 on mainnet).
    pub faucet_max: u128,
    /// Gas limit of a lock with permit.
    pub lock_with_permit_gas: u64,
}

/// A network's timing rules, seconds.
#[allow(missing_docs)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timing {
    pub pha_lock: u64,
    pub safety: u64,
    pub reveal_min: u64,
    pub base_lock_lead: u64,
    pub reveal_allowance: u64,
    pub claim_margin: u64,
    pub claim_watch: u64,
    pub refund_grace: u64,
    pub lock_slack: u64,
    pub base_lock_window: u64,
    pub base_lock_sign_lead: u64,
    pub pha_refund_grace: u64,
    pub base_refund_grace: u64,
}

/// Everything the kit pins for one network.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NetConfig {
    /// The network.
    pub network: Network,
    /// The current escrow: every new Phantasma lock.
    pub pha_contract: &'static str,
    /// SHA-256 of the escrow's deployed script.
    pub pha_code_sha256: &'static str,
    /// The escrow's admin.
    pub pha_admin: &'static str,
    /// Escrows still settling old locks.
    pub pha_draining: &'static [DrainingEscrow],
    /// What one Phantasma claim needs, raw KCAL.
    pub pha_claim_kcal: u128,
    /// Phantasma.
    pub pha: PhaNet,
    /// Base.
    pub base: BaseNet,
    /// Timing.
    pub timing: Timing,
}

const FEE_CAPS: FeeCaps =
    FeeCaps { max_gas: 600_000, max_fee_per_gas: 5_000_000_000, max_priority_fee_per_gas: 2_000_000_000, max_fee_wei: 2_000_000_000_000_000 };
const ESCROW_CODE_SHA256: &str = "ca1521581d1632dac9c0579817044e76253977f685c95240343ce76358e4fd99";

/// Devnet: Phantasma devnet and Base Sepolia.
pub const DEVNET: NetConfig = NetConfig {
    network: Network::Devnet,
    pha_contract: PHA_CONTRACT,
    pha_code_sha256: ESCROW_CODE_SHA256,
    pha_admin: "P2KBNc6TpAqLi5LEBHgX62BA3uqa6d87NefwRmJ825fbJ8D",
    pha_draining: &[],
    pha_claim_kcal: 30_000_000_000,
    pha: PhaNet {
        rpc_url: "https://devnet.phantasma.info/rpc",
        rpc_hosts: &["devnet.phantasma.info"],
        nexus: "testnet",
        chain: "main",
        explorer_url: "https://devnet-explorer.phantasma.info",
    },
    base: BaseNet {
        name: "Base Sepolia",
        chain_id: 84_532,
        rpc_url: "https://sepolia.base.org",
        explorer_url: "https://sepolia.basescan.org",
        swap: "0x952Cd62D3575Fd1B434faAE1B48FBDD0eD0a891d",
        usdc: "0x1eCcc4Ff269087d80cEcE6EE46f658C496E9A358",
        usdc_symbol: "mUSDC",
        native_currency: NativeCurrency { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
        confirm_blocks: 3,
        confirm_safe: false,
        usdc_has_blacklist: false,
        usdc_min: 1_000_000,
        usdc_max: 100_000_000_000,
        permit: PermitDomain { name: "Mock USD Coin", version: "1" },
        fee_caps: FEE_CAPS,
        faucet_max: 10_000_000_000,
        lock_with_permit_gas: 350_000,
    },
    timing: Timing {
        pha_lock: 2_400,
        safety: 900,
        reveal_min: 300,
        base_lock_lead: 600,
        reveal_allowance: 300,
        claim_margin: 180,
        claim_watch: 60,
        refund_grace: 30,
        lock_slack: 900,
        base_lock_window: 900,
        base_lock_sign_lead: 300,
        pha_refund_grace: 60,
        base_refund_grace: 30,
    },
};

/// Mainnet: real funds.
pub const MAINNET: NetConfig = NetConfig {
    network: Network::Mainnet,
    pha_contract: PHA_CONTRACT,
    pha_code_sha256: ESCROW_CODE_SHA256,
    pha_admin: "P2KBH6mEVXiXgaGqUjafg49oviuXvpTLhskWprpzq1BkYph",
    pha_draining: &[],
    pha_claim_kcal: 30_000_000_000,
    pha: PhaNet {
        rpc_url: "https://pharpc1.phantasma.info/rpc",
        rpc_hosts: &["pharpc1.phantasma.info"],
        nexus: "mainnet",
        chain: "main",
        explorer_url: "https://explorer.phantasma.info",
    },
    base: BaseNet {
        name: "Base",
        chain_id: 8_453,
        rpc_url: "https://mainnet.base.org",
        explorer_url: "https://basescan.org",
        swap: "0x32A77cfC4B3c1F99378Bf5CCcca1531D3A1392A7",
        usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        usdc_symbol: "USDC",
        native_currency: NativeCurrency { name: "Ether", symbol: "ETH", decimals: 18 },
        confirm_blocks: 0,
        confirm_safe: true,
        usdc_has_blacklist: true,
        usdc_min: 1_000_000,
        usdc_max: 10_000_000_000,
        permit: PermitDomain { name: "USD Coin", version: "2" },
        fee_caps: FEE_CAPS,
        faucet_max: 0,
        lock_with_permit_gas: 350_000,
    },
    timing: Timing {
        pha_lock: 43_200,
        safety: 21_600,
        reveal_min: 3_600,
        base_lock_lead: 600,
        reveal_allowance: 1_800,
        claim_margin: 1_800,
        claim_watch: 300,
        refund_grace: 30,
        lock_slack: 900,
        base_lock_window: 1_800,
        base_lock_sign_lead: 300,
        pha_refund_grace: 60,
        base_refund_grace: 30,
    },
};

/// The pins of a network.
pub fn config(network: Network) -> &'static NetConfig {
    match network {
        Network::Devnet => &DEVNET,
        Network::Mainnet => &MAINNET,
    }
}

/// The config for escrow `name` on this network: the current one when `name`
/// is `None` or the current contract, a draining one's own pins, or `None`
/// for a contract the kit does not serve.
pub fn escrow_cfg(cfg: &NetConfig, name: Option<&str>) -> Option<NetConfig> {
    match name {
        None => Some(*cfg),
        Some(n) if n == cfg.pha_contract => Some(*cfg),
        Some(n) => cfg.pha_draining.iter().find(|d| d.name == n).map(|d| NetConfig {
            pha_contract: d.name,
            pha_code_sha256: d.code_sha256,
            pha_admin: d.admin,
            ..*cfg
        }),
    }
}

// ── Addresses a bot must never hold (check 68) ──────────────────────────────

/// An address and the role that makes it forbidden.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Role {
    /// The address as pinned.
    pub address: &'static str,
    /// Its role.
    pub role: &'static str,
}

/// Known Phantasma role addresses (before the escrow admins are added).
pub const KNOWN_ROLES_PHA: [Role; 4] = [
    Role { address: "P2KBPHBKq1xuoSajuKxQCd7RfCfGFyoczoHQdVxacEUc9As", role: "Saturn's admin key" },
    Role { address: "P2KBNc6TpAqLi5LEBHgX62BA3uqa6d87NefwRmJ825fbJ8D", role: "the devnet escrow admin and test deploy wallet" },
    Role { address: "P2KJBzzwGWLkDz5HUtuHQ7ydUWmbyAtFukwytu8qFtbRkuX", role: "the retired devnet keeper" },
    Role { address: "P2KKFuFZNpiFdtgWQ68DHuTtwqnjBMgTv2hArZrmQYmf4gx", role: "the devnet keeper (Phantasma claims and refunds)" },
];

/// Known Base role addresses.
pub const KNOWN_ROLES_BASE: [Role; 5] = [
    Role { address: "0x941536821262b424997Cb212bDDFc97CAD7fD6f6", role: "the SaturnSwap owner" },
    Role { address: "0xe16fE62e009961682F3a7F42642F36F5E46962F8", role: "the retired devnet keeper (refunds)" },
    Role { address: "0x6EC2A535685D5cE5f143B8C0d9bF5F612295b703", role: "the retired devnet keeper (claims)" },
    Role { address: "0xa93Bc149Ff1DE9f20Fa1198e2edB4FFb69ECE58A", role: "the devnet keeper (refunds and withdrawOwed)" },
    Role { address: "0x8701a821221266800a6dF354701E79Fdb5Ab80A6", role: "the devnet keeper (claims)" },
];

/// Forbidden addresses and their roles.
pub type RoleList = Vec<(String, String)>;

/// Every forbidden address with its role, as the kit's `knownRoleAddresses()`
/// builds them: the known roles, then each network's escrow admins (which
/// replace an earlier role for the same address). Base addresses are lowercase.
pub fn known_role_addresses() -> (RoleList, RoleList) {
    fn set(list: &mut Vec<(String, String)>, address: String, role: String) {
        match list.iter_mut().find(|(a, _)| *a == address) {
            Some(entry) => entry.1 = role,
            None => list.push((address, role)),
        }
    }
    let mut pha = Vec::new();
    let mut base = Vec::new();
    for r in KNOWN_ROLES_PHA {
        set(&mut pha, r.address.to_string(), r.role.to_string());
    }
    for r in KNOWN_ROLES_BASE {
        set(&mut base, r.address.to_ascii_lowercase(), r.role.to_string());
    }
    for n in Network::ALL {
        let cfg = config(n);
        if !cfg.pha_admin.is_empty() {
            set(&mut pha, cfg.pha_admin.to_string(), format!("the {} escrow admin (PHA_ADMIN)", n.name()));
        }
        for d in cfg.pha_draining {
            if !d.admin.is_empty() {
                set(&mut pha, d.admin.to_string(), format!("the {} admin of {}", n.name(), d.name));
            }
        }
    }
    (pha, base)
}

/// Why these addresses must not be a bot's (check 68), or `None`. `forbid_*`
/// adds addresses to refuse (for example the keepers the board's `/config`
/// shows); display data may only ever add a refusal.
pub fn known_role_problem(pha: Option<&str>, base: Option<&str>, forbid_pha: &[&str], forbid_base: &[&str]) -> Option<String> {
    let (known_pha, known_base) = known_role_addresses();
    let told = "an address this bot was told to refuse";
    if let Some(a) = pha {
        let role =
            known_pha.iter().find(|(k, _)| k == a).map(|(_, r)| r.clone()).or_else(|| forbid_pha.contains(&a).then(|| format!("{told} (a keeper or admin)")));
        if let Some(role) = role {
            return Some(format!("The Phantasma key is {role} ({a}). A bot must never hold an admin, owner or keeper key: use a key of its own."));
        }
    }
    if let Some(a) = base {
        let lower = a.to_ascii_lowercase();
        let role = known_base
            .iter()
            .find(|(k, _)| *k == lower)
            .map(|(_, r)| r.clone())
            .or_else(|| forbid_base.iter().any(|f| f.to_ascii_lowercase() == lower).then(|| format!("{told} (a keeper or owner)")));
        if let Some(role) = role {
            return Some(format!("The Base key is {role} ({a}). A bot must never hold an admin, owner or keeper key: use a key of its own."));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn symbols_are_exact() {
        assert!(token_of("SOUL").is_some());
        assert!(token_of("soul").is_none());
        assert!(token_of("SOUL ").is_none());
        assert!(token_of("XYZ").is_none());
    }

    #[test]
    fn contract_names() {
        assert!(is_contract_name("saturnescrow"));
        assert!(!is_contract_name("ab"));
        assert!(!is_contract_name("Saturnescrow"));
        assert!(!is_contract_name("saturn_escrow"));
    }

    #[test]
    fn roles_refuse_admins() {
        assert!(known_role_problem(Some(MAINNET.pha_admin), None, &[], &[]).is_some());
        assert!(known_role_problem(None, Some("0x941536821262B424997CB212BDDFC97CAD7FD6F6"), &[], &[]).is_some());
        assert!(known_role_problem(Some("P2Kfoo"), Some("0x0000000000000000000000000000000000000001"), &[], &[]).is_none());
        assert!(known_role_problem(Some("P2Kfoo"), None, &["P2Kfoo"], &[]).is_some());
    }
}
