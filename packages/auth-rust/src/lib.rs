//! Shared Herkules token verification and first-party browser OAuth.
//! See the crate README and docs/tokens.md for the binding contracts.
pub mod auth;
pub mod session;
pub use auth::{Failure, Principal, Verifier};
pub use session::{Auth, AuthConfig, AuthError, Session, with_cookies};
