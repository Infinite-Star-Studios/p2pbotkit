//! Phantasma: keys and addresses, VM scripts, transactions and the three
//! escrow transactions, encoded exactly as `phantasma-sdk-ts` encodes them
//! for the kit (checked against `test/fixtures/sdk-vectors.json`).

pub mod escrow;
pub mod keys;
pub mod script;
pub mod tx;

pub use escrow::{claim_call, escrow_transaction, lock_call, refund_call, PhaCall};
pub use keys::{address_of_public_key, is_user_address_text, wif_of, wif_ok, PhaKeys};
pub use script::{view_scripts, Arg, ScriptBuilder};
pub use tx::Transaction;
