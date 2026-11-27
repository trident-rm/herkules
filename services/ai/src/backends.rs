//! Backends: where each model is served, whether each server is up, and which one a request
//! goes to.
//!
//! Backends come from the server-owned `AI_BACKENDS_FILE` and from the `backends` table,
//! which holds the tunnel backends admins add in the portal. Their enabled, disabled or
//! draining state lives in `backend_state`. A poller reads each backend's `/health` and
//! `/metrics` every [`POLL`]; a request goes to an enabled, healthy backend for its model
//! with the lowest load.

use std::{
    collections::BTreeSet,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use chrono::{DateTime, Utc};
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
use serde::Serialize;
use serde_json::Value;

/// How often each backend is checked.
pub const POLL: Duration = Duration::from_secs(5);
const CHECK_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Clone)]
pub enum Credential {
    None,
    Bearer(String),
    /// A Cloudflare Access service token.
    Access {
        id: String,
        secret: String,
    },
}

impl Credential {
    pub fn apply(&self, headers: &mut HeaderMap) {
        match self {
            Self::None => {}
            Self::Bearer(token) => {
                if let Ok(value) = HeaderValue::from_str(&format!("Bearer {token}")) {
                    headers.insert(AUTHORIZATION, value);
                }
            }
            Self::Access { id, secret } => {
                if let (Ok(id), Ok(secret)) =
                    (HeaderValue::from_str(id), HeaderValue::from_str(secret))
                {
                    headers.insert("cf-access-client-id", id);
                    headers.insert("cf-access-client-secret", secret);
                }
            }
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Source {
    /// Listed in `AI_BACKENDS_FILE`.
    File,
    /// Added in the portal: a Cloudflare tunnel and its DNS record.
    Tunnel {
        tunnel_id: String,
        dns_record_id: String,
        hostname: String,
        port: i32,
    },
}

#[derive(Clone)]
pub struct Backend {
    pub name: String,
    /// Base URL without a trailing slash.
    pub url: String,
    pub models: Vec<String>,
    pub credential: Credential,
    pub source: Source,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Enabled,
    Disabled,
    Draining,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Enabled => "enabled",
            Self::Disabled => "disabled",
            Self::Draining => "draining",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "enabled" => Some(Self::Enabled),
            "disabled" => Some(Self::Disabled),
            "draining" => Some(Self::Draining),
            _ => None,
        }
    }
}

/// What the last check found.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Live {
    pub healthy: bool,
    pub running: f64,
    pub waiting: f64,
    pub checked_at: Option<DateTime<Utc>>,
    pub error: Option<String>,
    /// `/v1/models` entries, kept for the gateway's own model list.
    #[serde(skip)]
    pub cards: Vec<Value>,
    /// The tunnel's status from Cloudflare: `healthy`, `degraded`, `down` or `inactive`.
    pub tunnel: Option<String>,
}

pub struct Entry {
    pub backend: Backend,
    pub state: Mutex<State>,
    pub live: Mutex<Live>,
    /// Requests this gateway has open on the backend.
    pub inflight: AtomicUsize,
}

impl Entry {
    pub fn state(&self) -> State {
        *self.state.lock().unwrap()
    }

    pub fn live(&self) -> Live {
        self.live.lock().unwrap().clone()
    }

    /// The load a new request would join: what this gateway has open, or what the server
    /// reports running if that is more, plus the server's queue.
    pub fn load(&self) -> f64 {
        let live = self.live.lock().unwrap();
        (self.inflight.load(Ordering::Relaxed) as f64).max(live.running) + live.waiting
    }

    fn usable(&self, model: &str) -> bool {
        self.state() == State::Enabled
            && self.live.lock().unwrap().healthy
            && self.backend.models.iter().any(|m| m == model)
    }
}

/// Counts a request against a backend until dropped.
pub struct Inflight(Arc<Entry>);

impl Inflight {
    pub fn new(entry: Arc<Entry>) -> Self {
        entry.inflight.fetch_add(1, Ordering::Relaxed);
        Self(entry)
    }
}

impl Drop for Inflight {
    fn drop(&mut self) {
        self.0.inflight.fetch_sub(1, Ordering::Relaxed);
    }
}

pub enum Pick {
    Backend(Arc<Entry>),
    /// No backend lists the model.
    Unknown,
    /// Backends list it, but none is enabled and healthy.
    Unavailable,
}

#[derive(Default)]
pub struct Backends {
    entries: RwLock<Vec<Arc<Entry>>>,
}

impl Backends {
    /// Replaces the set, keeping the live state and counters of backends that remain.
    pub fn replace(&self, backends: Vec<(Backend, State)>) {
        let mut entries = self.entries.write().unwrap();
        let old = std::mem::take(&mut *entries);
        for (backend, state) in backends {
            let previous = old.iter().find(|e| e.backend.name == backend.name);
            let entry = Entry {
                live: Mutex::new(previous.map(|e| e.live()).unwrap_or_default()),
                inflight: AtomicUsize::new(
                    previous.map_or(0, |e| e.inflight.load(Ordering::Relaxed)),
                ),
                state: Mutex::new(state),
                backend,
            };
            entries.push(Arc::new(entry));
        }
    }

    pub fn all(&self) -> Vec<Arc<Entry>> {
        self.entries.read().unwrap().clone()
    }

    pub fn get(&self, name: &str) -> Option<Arc<Entry>> {
        self.all().into_iter().find(|e| e.backend.name == name)
    }

    pub fn set_state(&self, name: &str, state: State) -> bool {
        match self.get(name) {
            Some(entry) => {
                *entry.state.lock().unwrap() = state;
                true
            }
            None => false,
        }
    }

    pub fn pick(&self, model: &str) -> Pick {
        let entries = self.all();
        if !entries
            .iter()
            .any(|e| e.backend.models.iter().any(|m| m == model))
        {
            return Pick::Unknown;
        }
        entries
            .into_iter()
            .filter(|e| e.usable(model))
            .min_by(|a, b| a.load().total_cmp(&b.load()))
            .map_or(Pick::Unavailable, Pick::Backend)
    }

    /// Models with at least one enabled, healthy backend.
    pub fn available_models(&self) -> BTreeSet<String> {
        self.all()
            .iter()
            .filter(|e| e.state() == State::Enabled && e.live.lock().unwrap().healthy)
            .flat_map(|e| e.backend.models.clone())
            .collect()
    }

    /// The `/v1/models` card for `model`: the first healthy backend's own card when it
    /// lists one by that id, else a minimal one.
    pub fn card(&self, model: &str) -> Value {
        for entry in self.all() {
            if entry.usable(model)
                && let Some(card) = entry
                    .live
                    .lock()
                    .unwrap()
                    .cards
                    .iter()
                    .find(|c| c["id"] == model)
            {
                return card.clone();
            }
        }
        serde_json::json!({"id": model, "object": "model", "created": 0, "owned_by": "herkules"})
    }
}

/// Checks one backend: `/health` decides health; `/metrics` and `/v1/models` add load and
/// model cards when they answer.
pub async fn check(http: &reqwest::Client, backend: &Backend) -> Live {
    let get = |path: &str| {
        let mut headers = HeaderMap::new();
        backend.credential.apply(&mut headers);
        http.get(format!("{}{path}", backend.url))
            .headers(headers)
            .timeout(CHECK_TIMEOUT)
            .send()
    };
    let mut live = Live {
        checked_at: Some(Utc::now()),
        ..Live::default()
    };
    match get("/health").await {
        Ok(r) if r.status().is_success() => live.healthy = true,
        Ok(r) => live.error = Some(format!("/health answered {}", r.status())),
        Err(e) => live.error = Some(format!("/health: {}", without_url(&e))),
    }
    if !live.healthy {
        return live;
    }
    if let Ok(r) = get("/metrics").await
        && r.status().is_success()
        && let Ok(text) = r.text().await
    {
        live.running = metric(&text, "vllm:num_requests_running");
        live.waiting = metric(&text, "vllm:num_requests_waiting");
    }
    if let Ok(r) = get("/v1/models").await
        && r.status().is_success()
        && let Ok(body) = r.json::<Value>().await
        && let Some(cards) = body["data"].as_array()
    {
        live.cards.clone_from(cards);
    }
    live
}

/// A reqwest error's message without its URL, which holds the backend address.
fn without_url(error: &reqwest::Error) -> String {
    let mut text = error.to_string();
    if let Some(url) = error.url() {
        text = text.replace(url.as_str(), "backend");
    }
    text
}

/// The sum of a Prometheus gauge over its label sets; 0 when absent.
pub fn metric(text: &str, name: &str) -> f64 {
    text.lines()
        .filter(|line| !line.starts_with('#'))
        .filter_map(|line| {
            let rest = line.strip_prefix(name)?;
            let rest = match rest.chars().next()? {
                '{' => &rest[rest.find('}')? + 1..],
                ' ' => rest,
                _ => return None,
            };
            rest.split_whitespace().next()?.parse::<f64>().ok()
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn backend(name: &str, models: &[&str]) -> Backend {
        Backend {
            name: name.into(),
            url: format!("http://{name}"),
            models: models.iter().map(|m| (*m).to_owned()).collect(),
            credential: Credential::None,
            source: Source::File,
        }
    }

    fn healthy(entry: &Entry, running: f64, waiting: f64) {
        let mut live = entry.live.lock().unwrap();
        live.healthy = true;
        live.running = running;
        live.waiting = waiting;
    }

    #[test]
    fn parses_gauges_with_and_without_labels() {
        let text = "# HELP vllm:num_requests_running x\n\
            vllm:num_requests_running{model_name=\"m\"} 2\n\
            vllm:num_requests_running_total 9\n\
            vllm:num_requests_waiting 1.0\n";
        assert_eq!(metric(text, "vllm:num_requests_running"), 2.0);
        assert_eq!(metric(text, "vllm:num_requests_waiting"), 1.0);
        assert_eq!(metric(text, "vllm:absent"), 0.0);
    }

    #[test]
    fn picks_the_least_loaded_enabled_healthy_backend() {
        let backends = Backends::default();
        backends.replace(vec![
            (backend("a", &["m"]), State::Enabled),
            (backend("b", &["m"]), State::Enabled),
            (backend("c", &["m"]), State::Disabled),
            (backend("d", &["other"]), State::Enabled),
        ]);
        assert!(matches!(backends.pick("m"), Pick::Unavailable));
        assert!(matches!(backends.pick("nope"), Pick::Unknown));
        let all = backends.all();
        healthy(&all[0], 3.0, 1.0);
        healthy(&all[1], 1.0, 0.0);
        healthy(&all[2], 0.0, 0.0);
        let Pick::Backend(chosen) = backends.pick("m") else {
            panic!("no backend")
        };
        assert_eq!(chosen.backend.name, "b");
        // This gateway's open requests count when the server has not reported them yet.
        let _held: Vec<_> = (0..5).map(|_| Inflight::new(Arc::clone(&all[1]))).collect();
        let Pick::Backend(chosen) = backends.pick("m") else {
            panic!("no backend")
        };
        assert_eq!(chosen.backend.name, "a");
        assert!(backends.set_state("a", State::Draining));
        let Pick::Backend(chosen) = backends.pick("m") else {
            panic!("no backend")
        };
        assert_eq!(chosen.backend.name, "b");
        assert_eq!(
            backends.available_models().into_iter().collect::<Vec<_>>(),
            ["m"]
        );
    }

    #[test]
    fn replace_keeps_live_state() {
        let backends = Backends::default();
        backends.replace(vec![(backend("a", &["m"]), State::Enabled)]);
        healthy(&backends.all()[0], 0.0, 0.0);
        backends.replace(vec![
            (backend("a", &["m"]), State::Enabled),
            (backend("b", &["m"]), State::Enabled),
        ]);
        assert!(backends.get("a").unwrap().live().healthy);
        assert!(!backends.get("b").unwrap().live().healthy);
    }
}
