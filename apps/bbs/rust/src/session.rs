//! BBS profile presentation over the shared Rust OAuth client.
use herkules_auth::Principal;
pub use herkules_auth::session::*;
use serde_json::{Value, json};

pub async fn viewer(auth: &Auth, p: &Principal) -> Value {
    let profile = auth.user_profile(p).await;
    json!({"id":p.subject,"role":p.role,"displayName":profile.as_ref().map(|v|&v["displayName"]).unwrap_or(&json!(p.subject)),"avatarUrl":profile.as_ref().map(|v|&v["avatarUrl"]).unwrap_or(&Value::Null)})
}
