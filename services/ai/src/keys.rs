//! API keys: `sk-hk-` and 43 base64url characters from 32 random bytes.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::{TryRng as _, rngs::SysRng};
use sha2::{Digest, Sha256};

pub const PREFIX: &str = "sk-hk-";
/// Characters of a key shown in the portal after creation.
const SHOWN: usize = PREFIX.len() + 6;

/// A new key, its hash and the part shown later.
pub struct NewKey {
    pub secret: String,
    pub hash: String,
    pub prefix: String,
}

pub fn generate() -> NewKey {
    let mut bytes = [0; 32];
    SysRng
        .try_fill_bytes(&mut bytes)
        .expect("OS entropy unavailable");
    let secret = format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes));
    NewKey {
        hash: hash(&secret),
        prefix: secret[..SHOWN].to_owned(),
        secret,
    }
}

/// The stored form of a key: lowercase hex SHA-256.
pub fn hash(secret: &str) -> String {
    hex::encode(Sha256::digest(secret.as_bytes()))
}

/// Whether `raw` looks like a gateway key; anything else is refused before a lookup.
pub fn well_formed(raw: &str) -> bool {
    raw.strip_prefix(PREFIX).is_some_and(|rest| {
        rest.len() == 43
            && rest
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_distinct_and_well_formed() {
        let a = generate();
        let b = generate();
        assert_ne!(a.secret, b.secret);
        assert!(well_formed(&a.secret));
        assert_eq!(a.hash, hash(&a.secret));
        assert_eq!(a.hash.len(), 64);
        assert!(a.secret.starts_with(&a.prefix));
        assert!(!well_formed("sk-hk-short"));
        assert!(!well_formed(&a.secret.replace(PREFIX, "sk-xx-")));
    }
}
