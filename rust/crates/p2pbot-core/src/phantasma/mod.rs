//! Phantasma: keys and addresses, VM scripts, transactions, the three
//! escrow transactions, and reading a node's answers, encoded and read
//! exactly as `phantasma-sdk-ts` does for the kit (checked against
//! `test/fixtures/sdk-vectors.json`).

pub mod escrow;
pub mod keys;
pub mod reader;
pub mod script;
pub mod tx;
pub mod vm;

pub use escrow::{claim_call, escrow_transaction, lock_call, refund_call, PhaCall};
pub use keys::{address_of_public_key, is_user_address_text, wif_of, wif_ok, PhaKeys};
pub use reader::{PhaLockRead, PhaNode, PhaOpenCap, PhaParams, ScriptAnswer};
pub use script::{view_scripts, Arg, ScriptBuilder};
pub use tx::Transaction;
pub use vm::VmValue;
