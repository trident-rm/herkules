//! Whether a key's owner is still an active Herkules member.
//!
//! The auth service's private `POST /auth/internal/ai-membership` answers for up to 100
//! users with a dedicated secret. Answers are cached for [`TTL`], so disabling or removing a
//! user stops their keys within that time. When the auth service cannot answer, requests
//! fail closed.

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::Deserialize;
use serde_json::json;

pub const TTL: Duration = Duration::from_secs(20);

pub struct Membership {
    http: reqwest::Client,
    url: String,
    secret: String,
    cache: Mutex<HashMap<String, (bool, Instant)>>,
}

#[derive(Deserialize)]
struct Answer {
    users: Vec<Status>,
}

#[derive(Deserialize)]
struct Status {
    id: String,
    enabled: bool,
}

impl Membership {
    pub fn new(http: reqwest::Client, url: String, secret: String) -> Self {
        Self {
            http,
            url,
            secret,
            cache: Mutex::default(),
        }
    }

    /// `Ok(enabled)`, or `Err` when the auth service did not answer.
    pub async fn enabled(&self, sub: &str) -> Result<bool, String> {
        if let Some((enabled, at)) = self.cache.lock().unwrap().get(sub)
            && at.elapsed() < TTL
        {
            return Ok(*enabled);
        }
        let response = self
            .http
            .post(&self.url)
            .bearer_auth(&self.secret)
            .json(&json!({"ids": [sub]}))
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .map_err(|e| format!("membership check failed: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("membership check answered {}", response.status()));
        }
        let answer: Answer = response
            .json()
            .await
            .map_err(|e| format!("membership answer unreadable: {e}"))?;
        let enabled = answer.users.iter().any(|u| u.id == sub && u.enabled);
        let mut cache = self.cache.lock().unwrap();
        cache.retain(|_, (_, at)| at.elapsed() < TTL);
        cache.insert(sub.to_owned(), (enabled, Instant::now()));
        Ok(enabled)
    }
}
