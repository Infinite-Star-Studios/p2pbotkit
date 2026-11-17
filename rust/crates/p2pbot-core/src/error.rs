//! Refusals. When a function returns an [`Error`], nothing was built or signed.

use alloc::string::String;
use core::fmt;

/// A refusal with a stable `code` (the kit's code where it has one) and a
/// human-readable `detail` that never quotes a key or a secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    /// Stable code, e.g. `KEY_FILE`, `TOKEN_NOT_TRADED`, `BAD_INPUT`.
    pub code: &'static str,
    /// What was wrong.
    pub detail: String,
}

impl Error {
    /// A refusal with this code and detail.
    pub fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self { code, detail: detail.into() }
    }

    /// A refusal of malformed input (`BAD_INPUT`).
    pub fn bad_input(detail: impl Into<String>) -> Self {
        Self::new("BAD_INPUT", detail)
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.detail)
    }
}

impl core::error::Error for Error {}

/// The result of a step that may refuse.
pub type Result<T> = core::result::Result<T, Error>;
