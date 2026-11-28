//! Backends: where each model is served, whether each server is up, and which one a request
//! goes to.
//!
//! Backends come from the server-owned `AI_BACKENDS_FILE` and from the `backends` table,
//! which holds the tunnel backends admins add in the portal. Their enabled, disabled or
//! draining state lives in `backend_state`. A poller reads each backend's `/health` and
//! `/metrics` every [`POLL`]; a request goes to an enabled, healthy backend for its model
//! according to the routing policy and available capacity.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use chrono::{DateTime, Utc};
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Notify;

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

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Strategy {
    #[default]
    LeastLoaded,
    RoundRobin,
    Single,
}

impl Strategy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LeastLoaded => "leastLoaded",
            Self::RoundRobin => "roundRobin",
            Self::Single => "single",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "roundRobin" => Self::RoundRobin,
            "single" => Self::Single,
            _ => Self::LeastLoaded,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Routing {
    pub strategy: Strategy,
    pub wait_seconds: u32,
}

impl Default for Routing {
    fn default() -> Self {
        Self {
            strategy: Strategy::LeastLoaded,
            wait_seconds: 30,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendPolicy {
    pub priority: u16,
    pub max_streams: Option<u16>,
}

/// What the last check found.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Live {
    pub healthy: bool,
    pub running: f64,
    pub waiting: f64,
    pub max_streams: Option<f64>,
    pub prefilling: Option<f64>,
    pub decoding: Option<f64>,
    pub prefill_tps: Option<f64>,
    pub parked: Option<f64>,
    pub kv_free_pages: Option<f64>,
    pub kv_total_pages: Option<f64>,
    pub process_started_at: Option<f64>,
    pub speculative_acceptance: Option<f64>,
    pub fallback_steps: Option<f64>,
    pub prefix_cache: BTreeMap<&'static str, IntervalPair>,
    pub rejections: BTreeMap<&'static str, f64>,
    pub decode_by_streams: BTreeMap<u32, IntervalPair>,
    pub sampled_at: Option<DateTime<Utc>>,
    pub prompt_tps: Option<f64>,
    pub decode_tps: Option<f64>,
    #[serde(skip)]
    tokens: TokenSample,
    pub checked_at: Option<DateTime<Utc>>,
    pub error: Option<String>,
    /// `/v1/models` entries, kept for the gateway's own model list.
    #[serde(skip)]
    pub cards: Vec<Value>,
    /// The tunnel's status from Cloudflare: `healthy`, `degraded`, `down` or `inactive`.
    pub tunnel: Option<String>,
}

#[derive(Clone, Debug, Default)]
struct TokenSample {
    at: Option<Instant>,
    prompt: Option<f64>,
    prefill: Option<f64>,
    generated: Option<f64>,
    proposed: Option<f64>,
    accepted: Option<f64>,
    fallback_steps: Option<f64>,
    prefix_cache: BTreeMap<&'static str, IntervalPair>,
    rejections: BTreeMap<&'static str, f64>,
    decode: BTreeMap<u32, IntervalPair>,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct IntervalPair {
    tokens: f64,
    seconds: f64,
}

impl IntervalPair {
    fn since(self, last: Self) -> Option<Self> {
        Some(Self {
            tokens: delta(self.tokens, last.tokens)?,
            seconds: delta(self.seconds, last.seconds)?,
        })
    }
}

fn delta(current: f64, last: f64) -> Option<f64> {
    let diff = current - last;
    (diff >= 0.0).then_some(diff)
}

pub struct Entry {
    pub backend: Backend,
    pub state: Mutex<State>,
    pub live: Arc<Mutex<Live>>,
    /// Requests this gateway has open on the backend.
    pub inflight: Arc<AtomicUsize>,
}

impl Entry {
    pub fn state(&self) -> State {
        *self.state.lock().unwrap()
    }

    pub fn live(&self) -> Live {
        self.live.lock().unwrap().clone()
    }

    fn usable(&self, model: &str) -> bool {
        self.state() == State::Enabled
            && self.live.lock().unwrap().healthy
            && self.backend.models.iter().any(|m| m == model)
    }
}

/// Counts a request against a backend until dropped.
pub struct Inflight {
    pub entry: Arc<Entry>,
    pub admitted_inflight: i32,
    changed: Arc<Notify>,
}

impl Drop for Inflight {
    fn drop(&mut self) {
        self.entry.inflight.fetch_sub(1, Ordering::Relaxed);
        self.changed.notify_waiters();
    }
}

pub enum Pick {
    Backend(Inflight),
    /// No backend lists the model.
    Unknown,
    /// No server was ready before the admission deadline.
    Unavailable,
}

#[derive(Default)]
struct Pool {
    entries: Vec<Arc<Entry>>,
    policies: HashMap<String, BackendPolicy>,
    routing: Routing,
    last_used: HashMap<String, String>,
}

#[derive(Default)]
pub struct Backends {
    pool: RwLock<Pool>,
    changed: Arc<Notify>,
}

impl Backends {
    /// Replaces the set while retaining the counters held by active requests.
    pub fn replace(&self, backends: Vec<(Backend, State)>) {
        let mut pool = self.pool.write().unwrap();
        let old = std::mem::take(&mut pool.entries);
        for (backend, state) in backends {
            let previous = old.iter().find(|entry| entry.backend.name == backend.name);
            pool.entries.push(Arc::new(Entry {
                live: previous.map(|e| Arc::clone(&e.live)).unwrap_or_default(),
                inflight: previous
                    .map(|e| Arc::clone(&e.inflight))
                    .unwrap_or_default(),
                state: Mutex::new(state),
                backend,
            }));
        }
        self.changed.notify_waiters();
    }

    pub fn all(&self) -> Vec<Arc<Entry>> {
        self.pool.read().unwrap().entries.clone()
    }

    pub fn get(&self, name: &str) -> Option<Arc<Entry>> {
        self.all().into_iter().find(|e| e.backend.name == name)
    }

    pub fn set_state(&self, name: &str, state: State) -> bool {
        let pool = self.pool.read().unwrap();
        let Some(entry) = pool.entries.iter().find(|e| e.backend.name == name) else {
            return false;
        };
        *entry.state.lock().unwrap() = state;
        self.changed.notify_waiters();
        true
    }

    pub fn routing(&self) -> Routing {
        self.pool.read().unwrap().routing
    }

    pub fn set_routing(&self, routing: Routing) {
        self.pool.write().unwrap().routing = routing;
        self.changed.notify_waiters();
    }

    pub fn policies(&self) -> HashMap<String, BackendPolicy> {
        let pool = self.pool.read().unwrap();
        pool.entries
            .iter()
            .map(|entry| {
                let name = &entry.backend.name;
                (
                    name.clone(),
                    pool.policies.get(name).copied().unwrap_or_default(),
                )
            })
            .collect()
    }

    pub fn set_policy(&self, name: String, policy: BackendPolicy) {
        self.pool.write().unwrap().policies.insert(name, policy);
        self.changed.notify_waiters();
    }

    pub fn delete_policy(&self, name: &str) {
        self.pool.write().unwrap().policies.remove(name);
    }

    pub fn update_live(&self, entry: &Entry, mut live: Live) {
        let mut previous = entry.live.lock().unwrap();
        live.tunnel = previous.tunnel.take();
        if live.sampled_at.is_none() {
            live.max_streams = previous.max_streams;
        }
        live.set_rates(&previous);
        *previous = live;
        self.changed.notify_waiters();
    }

    fn pick(&self, model: &str) -> Pick {
        // Select and count the request under the same lock so simultaneous arrivals
        // cannot oversubscribe an admission limit or pick the same round-robin slot.
        let mut pool = self.pool.write().unwrap();
        let mut matching = pool
            .entries
            .iter()
            .filter(|e| e.backend.models.iter().any(|m| m == model))
            .peekable();
        if matching.peek().is_none() {
            return Pick::Unknown;
        }
        let mut candidates: Vec<_> = matching
            .filter_map(|entry| {
                if entry.state() != State::Enabled {
                    return None;
                }
                let live = entry.live.lock().unwrap();
                if !live.healthy {
                    return None;
                }
                let policy = pool
                    .policies
                    .get(&entry.backend.name)
                    .copied()
                    .unwrap_or_default();
                let open = entry.inflight.load(Ordering::Relaxed) as f64;
                let capacity_used = open.max(live.running + live.waiting);
                let limit = policy.max_streams.map(f64::from).or(live.max_streams);
                let full = limit.is_some_and(|limit| capacity_used >= limit);
                let load = open.max(live.running) + live.waiting;
                Some((policy.priority, entry, full, load))
            })
            .collect();
        if !matches!(pool.routing.strategy, Strategy::Single) {
            candidates.retain(|(_, _, full, _)| !full);
        }
        candidates.sort_unstable_by(|a, b| (a.0, &a.1.backend.name).cmp(&(b.0, &b.1.backend.name)));
        let Some(&(priority, first, full, _)) = candidates.first() else {
            return Pick::Unavailable;
        };
        let tier = candidates
            .iter()
            .take_while(|candidate| candidate.0 == priority);
        let chosen = match pool.routing.strategy {
            Strategy::Single if full => return Pick::Unavailable,
            Strategy::Single => first,
            Strategy::LeastLoaded => tier
                .min_by(|a, b| a.3.total_cmp(&b.3))
                .map_or(first, |c| c.1),
            Strategy::RoundRobin => pool
                .last_used
                .get(model)
                .and_then(|last| tier.map(|c| c.1).find(|entry| entry.backend.name > *last))
                .unwrap_or(first),
        };
        let entry = Arc::clone(chosen);
        if matches!(pool.routing.strategy, Strategy::RoundRobin) {
            pool.last_used
                .insert(model.to_owned(), entry.backend.name.clone());
        }
        let previous = entry.inflight.fetch_add(1, Ordering::Relaxed);
        Pick::Backend(Inflight {
            admitted_inflight: i32::try_from(previous + 1).unwrap_or(i32::MAX),
            entry,
            changed: Arc::clone(&self.changed),
        })
    }

    /// Temporarily stops admission after a connection failure. The next health check
    /// can restore the backend. Keep a successful check that started after the send.
    pub fn connection_failed(&self, entry: &Entry, sent_at: DateTime<Utc>) {
        let mut live = entry.live.lock().unwrap();
        if live.checked_at.is_some_and(|checked| checked > sent_at) {
            return;
        }
        *live = Live {
            checked_at: live.checked_at,
            max_streams: live.max_streams,
            tunnel: live.tunnel.take(),
            error: Some("connection to backend failed".into()),
            ..Live::default()
        };
        self.changed.notify_waiters();
    }

    pub async fn acquire(&self, model: &str, deadline: tokio::time::Instant) -> Pick {
        loop {
            // Register before selecting so a slot opening during selection wakes us.
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            match self.pick(model) {
                Pick::Unavailable => {}
                result => return result,
            }
            if tokio::time::Instant::now() >= deadline
                || tokio::time::timeout_at(deadline, changed).await.is_err()
            {
                return Pick::Unavailable;
            }
        }
    }

    pub fn enabled_models(&self) -> BTreeSet<String> {
        self.all()
            .iter()
            .filter(|e| e.state() == State::Enabled)
            .flat_map(|e| e.backend.models.clone())
            .collect()
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
    let (metrics, models) = tokio::join!(
        async {
            let text = get("/metrics").await?.error_for_status()?.text().await?;
            Ok::<_, reqwest::Error>((text, Utc::now(), Instant::now()))
        },
        async {
            get("/v1/models")
                .await?
                .error_for_status()?
                .json::<Value>()
                .await
        },
    );
    if let Ok((text, sampled_at, sampled_instant)) = metrics {
        live.read_metrics(&text, sampled_at, sampled_instant);
    }
    if let Ok(body) = models
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

impl Live {
    fn read_metrics(&mut self, text: &str, sampled_at: DateTime<Utc>, sampled_instant: Instant) {
        self.running = metric(text, "vllm:num_requests_running").unwrap_or_default();
        self.waiting = metric(text, "vllm:num_requests_waiting").unwrap_or_default();
        self.max_streams = metric(text, "siphon:max_concurrent_streams")
            .filter(|value| *value >= 1.0 && value.fract() == 0.0);
        self.prefilling = metric(text, "siphon:num_requests_prefilling");
        self.decoding = metric(text, "siphon:num_requests_decoding");
        self.parked = metric(text, "siphon:num_requests_parked");
        self.kv_free_pages = metric(text, "siphon:kv_pool_free_pages");
        self.kv_total_pages = metric(text, "siphon:kv_pool_total_pages");
        self.process_started_at = metric(text, "process_start_time_seconds");
        self.sampled_at = Some(sampled_at);
        let cache_tokens = labeled_metrics(text, "siphon:prefix_cache_hit_tokens_total", "tier");
        let mut cache_seconds =
            labeled_metrics(text, "siphon:prefix_cache_restore_seconds_total", "tier");
        let mut rejections = labeled_metrics(text, "siphon:admission_rejections_total", "reason");
        let decode_tokens = labeled_metrics(text, "siphon:decode_tokens_total", "streams");
        let mut decode_seconds = labeled_metrics(text, "siphon:decode_seconds_total", "streams");
        self.tokens = TokenSample {
            at: Some(sampled_instant),
            prompt: metric(text, "vllm:prompt_tokens_total"),
            prefill: metric(text, "siphon:prefill_tokens_total"),
            generated: metric(text, "vllm:generation_tokens_total"),
            proposed: metric(text, "siphon:speculative_proposed_tokens_total"),
            accepted: metric(text, "siphon:speculative_accepted_tokens_total"),
            fallback_steps: metric(text, "siphon:speculative_fallback_steps_total"),
            prefix_cache: ["gpu", "ram", "ssd"]
                .into_iter()
                .filter_map(|tier| {
                    Some((
                        tier,
                        IntervalPair {
                            tokens: *cache_tokens.get(tier)?,
                            seconds: cache_seconds.remove(tier)?,
                        },
                    ))
                })
                .collect(),
            rejections: ["queue_full", "draining", "engine_unavailable"]
                .into_iter()
                .filter_map(|reason| Some((reason, rejections.remove(reason)?)))
                .collect(),
            decode: decode_tokens
                .into_iter()
                .filter_map(|(label, tokens)| {
                    let streams = label.parse::<u32>().ok()?;
                    Some((
                        streams,
                        IntervalPair {
                            tokens,
                            seconds: decode_seconds.remove(label)?,
                        },
                    ))
                })
                .collect(),
        };
    }

    fn set_rates(&mut self, previous: &Self) {
        let (Some(at), Some(last_at)) = (self.tokens.at, previous.tokens.at) else {
            return;
        };
        if matches!((self.process_started_at, previous.process_started_at), (Some(a), Some(b)) if a != b)
        {
            return;
        }
        let seconds = at.duration_since(last_at).as_secs_f64();
        let rate = |current: Option<f64>, last: Option<f64>| {
            let delta = current? - last?;
            (seconds > 0.0 && delta >= 0.0).then(|| delta / seconds)
        };
        self.prefill_tps = rate(self.tokens.prefill, previous.tokens.prefill);
        self.prompt_tps = rate(self.tokens.prompt, previous.tokens.prompt);
        self.decode_tps = rate(self.tokens.generated, previous.tokens.generated);
        let proposed = self
            .tokens
            .proposed
            .zip(previous.tokens.proposed)
            .and_then(|(a, b)| delta(a, b));
        let accepted = self
            .tokens
            .accepted
            .zip(previous.tokens.accepted)
            .and_then(|(a, b)| delta(a, b));
        self.speculative_acceptance = proposed
            .zip(accepted)
            .filter(|(proposed, accepted)| *proposed > 0.0 && accepted <= proposed)
            .map(|(proposed, accepted)| accepted / proposed);
        self.fallback_steps = self
            .tokens
            .fallback_steps
            .zip(previous.tokens.fallback_steps)
            .and_then(|(a, b)| delta(a, b));
        self.prefix_cache =
            interval_pairs(&self.tokens.prefix_cache, &previous.tokens.prefix_cache);
        self.decode_by_streams = interval_pairs(&self.tokens.decode, &previous.tokens.decode);
        self.decode_by_streams
            .retain(|_, sample| sample.seconds > 0.0);
        self.rejections = self
            .tokens
            .rejections
            .iter()
            .filter_map(|(&reason, &current)| {
                Some((
                    reason,
                    delta(current, *previous.tokens.rejections.get(reason)?)?,
                ))
            })
            .collect();
    }
}

fn interval_pairs<K: Copy + Ord>(
    current: &BTreeMap<K, IntervalPair>,
    previous: &BTreeMap<K, IntervalPair>,
) -> BTreeMap<K, IntervalPair> {
    current
        .iter()
        .filter_map(|(&key, &value)| Some((key, value.since(*previous.get(&key)?)?)))
        .collect()
}

/// Siphon writes these families with exactly one label.
fn labeled_metrics<'a>(text: &'a str, metric: &str, label: &str) -> BTreeMap<&'a str, f64> {
    let prefix = format!(r#"{metric}{{{label}=""#);
    text.lines()
        .filter_map(|line| {
            let (key, sample) = line.strip_prefix(&prefix)?.split_once(r#""}"#)?;
            let value = sample.split_whitespace().next()?.parse::<f64>().ok()?;
            (value.is_finite() && value >= 0.0).then_some((key, value))
        })
        .collect()
}

/// The sum of a Prometheus metric over its label sets.
fn metric(text: &str, name: &str) -> Option<f64> {
    let mut values = text.lines().filter_map(|line| {
        let rest = line.strip_prefix(name)?;
        let rest = match rest.chars().next()? {
            '{' => &rest[rest.rfind('}')? + 1..],
            c if c.is_ascii_whitespace() => rest,
            _ => return None,
        };
        let value = rest.split_whitespace().next()?.parse::<f64>().ok()?;
        (value.is_finite() && value >= 0.0).then_some(value)
    });
    let first = values.next()?;
    let sum = first + values.sum::<f64>();
    sum.is_finite().then_some(sum)
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
        assert_eq!(metric(text, "vllm:num_requests_running"), Some(2.0));
        assert_eq!(metric(text, "vllm:num_requests_waiting"), Some(1.0));
        assert_eq!(metric(text, "vllm:absent"), None);
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
        assert_eq!(chosen.entry.backend.name, "b");
        // This gateway's open requests count when the server has not reported them yet.
        all[1].inflight.store(5, Ordering::Relaxed);
        let Pick::Backend(chosen) = backends.pick("m") else {
            panic!("no backend")
        };
        assert_eq!(chosen.entry.backend.name, "a");
        assert!(backends.set_state("a", State::Draining));
        let Pick::Backend(chosen) = backends.pick("m") else {
            panic!("no backend")
        };
        assert_eq!(chosen.entry.backend.name, "b");
        assert_eq!(
            backends.available_models().into_iter().collect::<Vec<_>>(),
            ["m"]
        );
    }

    fn admitted(pick: Pick) -> Inflight {
        let Pick::Backend(inflight) = pick else {
            panic!("no backend")
        };
        inflight
    }

    #[test]
    fn round_robin_uses_the_highest_priority_tier_with_capacity() {
        let backends = Backends::default();
        backends.set_routing(Routing {
            strategy: Strategy::RoundRobin,
            ..Routing::default()
        });
        backends.replace(vec![
            (backend("fallback", &["m"]), State::Enabled),
            (backend("b", &["m"]), State::Enabled),
            (backend("a", &["m"]), State::Enabled),
        ]);
        for entry in backends.all() {
            healthy(&entry, 0.0, 0.0);
            backends.set_policy(
                entry.backend.name.clone(),
                BackendPolicy {
                    priority: u16::from(entry.backend.name == "fallback"),
                    max_streams: Some(1),
                },
            );
        }
        assert_eq!(admitted(backends.pick("m")).entry.backend.name, "a");
        assert_eq!(admitted(backends.pick("m")).entry.backend.name, "b");
        let a = admitted(backends.pick("m"));
        let b = admitted(backends.pick("m"));
        assert_eq!(a.entry.backend.name, "a");
        assert_eq!(b.entry.backend.name, "b");
        assert_eq!(a.admitted_inflight, 1);
        assert_eq!(admitted(backends.pick("m")).entry.backend.name, "fallback");
    }

    #[tokio::test]
    async fn single_waits_for_its_server_and_resumes_after_release() {
        let backends = Backends::default();
        backends.set_routing(Routing {
            strategy: Strategy::Single,
            ..Routing::default()
        });
        let entries = || {
            vec![
                (backend("a", &["m"]), State::Enabled),
                (backend("b", &["m"]), State::Enabled),
            ]
        };
        backends.replace(entries());
        let a = backends.get("a").unwrap();
        healthy(&a, 0.0, 0.0);
        healthy(&backends.get("b").unwrap(), 0.0, 0.0);
        a.live.lock().unwrap().max_streams = Some(1.0);
        let held = admitted(backends.pick("m"));

        // An existing request owns its slot even across a set reload.
        backends.replace(entries());
        let waiting = backends.acquire("m", tokio::time::Instant::now() + Duration::from_secs(1));
        tokio::pin!(waiting);
        assert!(futures_util::poll!(&mut waiting).is_pending());
        drop(held);
        assert_eq!(admitted(waiting.await).entry.backend.name, "a");

        backends.connection_failed(&a, Utc::now());
        assert_eq!(admitted(backends.pick("m")).entry.backend.name, "b");
        backends.connection_failed(&backends.get("b").unwrap(), Utc::now());
        assert!(matches!(
            backends.acquire("m", tokio::time::Instant::now()).await,
            Pick::Unavailable
        ));
    }

    #[test]
    fn scheduler_intervals_preserve_labels_and_detect_restarts() {
        let scrape = |boot, tokens, seconds, accepted, rejections, reused| {
            format!(
                "process_start_time_seconds {boot}\n\
                 siphon:num_requests_parked 2\n\
                 siphon:decode_tokens_total{{streams=\"2\"}} {tokens}\n\
                 siphon:decode_seconds_total{{streams=\"2\"}} {seconds}\n\
                 siphon:speculative_proposed_tokens_total {tokens}\n\
                 siphon:speculative_accepted_tokens_total {accepted}\n\
                 siphon:admission_rejections_total{{reason=\"queue_full\"}} {rejections}\n\
                 siphon:prefix_cache_hit_tokens_total{{tier=\"ssd\"}} {reused}\n\
                 siphon:prefix_cache_restore_seconds_total{{tier=\"ssd\"}} {seconds}\n"
            )
        };
        let at = Instant::now();
        let mut previous = Live::default();
        previous.read_metrics(&scrape(100, 40, 1, 20, 2, 10), Utc::now(), at);
        let mut current = Live::default();
        current.read_metrics(
            &scrape(100, 60, 2, 36, 3, 40),
            Utc::now(),
            at + Duration::from_secs(5),
        );
        current.set_rates(&previous);
        assert_eq!(current.parked, Some(2.0));
        assert_eq!(current.decode_by_streams[&2].tokens, 20.0);
        assert_eq!(current.decode_by_streams[&2].seconds, 1.0);
        assert_eq!(current.prefix_cache["ssd"].tokens, 30.0);
        assert_eq!(current.speculative_acceptance, Some(0.8));
        assert_eq!(current.rejections["queue_full"], 1.0);

        let mut restarted = Live::default();
        restarted.read_metrics(
            &scrape(101, 80, 4, 50, 4, 60),
            Utc::now(),
            at + Duration::from_secs(10),
        );
        restarted.set_rates(&current);
        assert!(restarted.decode_by_streams.is_empty());
        assert!(restarted.rejections.is_empty());
        assert_eq!(restarted.speculative_acceptance, None);
    }

    #[test]
    fn live_rates_reset_when_counters_decrease() {
        let start = Instant::now();
        let previous = Live {
            tokens: TokenSample {
                at: Some(start),
                prompt: Some(200.0),
                prefill: Some(100.0),
                generated: Some(300.0),
                ..TokenSample::default()
            },
            ..Live::default()
        };
        let mut next = Live {
            tokens: TokenSample {
                at: Some(start + Duration::from_secs(5)),
                prompt: Some(225.0),
                prefill: None,
                generated: Some(10.0),
                ..TokenSample::default()
            },
            ..Live::default()
        };
        next.set_rates(&previous);
        assert_eq!(next.prompt_tps, Some(5.0));
        assert_eq!(next.prefill_tps, None);
        assert_eq!(next.decode_tps, None);
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
