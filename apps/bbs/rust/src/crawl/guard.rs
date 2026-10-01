//! Persisted source limits. Wire keys are shared with the existing Node worker.
use super::{Error, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::Mutex;

const DAY: i64 = 86_400_000;
#[derive(Clone, Copy, Debug)]
pub struct Policy {
    pub spacing: i64,
    pub jitter: i64,
    pub minute: u64,
    pub day: u64,
    pub reserve: u64,
    pub max_wait: i64,
    pub cooldown_max: i64,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            spacing: 2000,
            jitter: 1000,
            minute: 20,
            day: 2000,
            reserve: 200,
            max_wait: 30_000,
            cooldown_max: DAY,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct State {
    pub consecutive_failures: u64,
    pub open_until_ms: Option<i64>,
    pub minute_bucket_start_ms: i64,
    pub minute_count: u64,
    pub day_bucket_start_ms: i64,
    pub day_count: u64,
    pub last_request_at_ms: Option<i64>,
    pub last_failure_at_ms: Option<i64>,
    pub last_failure_reason: Option<String>,
    pub total_requests: u64,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Priority {
    Interactive,
    Background,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Refusal {
    pub reason: &'static str,
    pub until: Option<i64>,
}
impl State {
    pub fn new(now: i64) -> Self {
        Self {
            consecutive_failures: 0,
            open_until_ms: None,
            minute_bucket_start_ms: now,
            minute_count: 0,
            day_bucket_start_ms: now.div_euclid(DAY) * DAY,
            day_count: 0,
            last_request_at_ms: None,
            last_failure_at_ms: None,
            last_failure_reason: None,
            total_requests: 0,
        }
    }
    pub fn roll(&mut self, now: i64) {
        if now - self.minute_bucket_start_ms >= 60_000 {
            self.minute_bucket_start_ms = now;
            self.minute_count = 0;
        }
        let day = now.div_euclid(DAY) * DAY;
        if day > self.day_bucket_start_ms {
            self.day_bucket_start_ms = day;
            self.day_count = 0;
        }
    }
    pub fn decide(&mut self, p: Policy, now: i64, jitter: i64) -> Option<Refusal> {
        self.roll(now);
        if let Some(until) = self.open_until_ms.filter(|&u| u > now) {
            return Some(Refusal {
                reason: "circuitOpen",
                until: Some(until),
            });
        }
        if self.day_count >= p.day {
            return Some(Refusal {
                reason: "dayExhausted",
                until: Some(now.div_euclid(DAY) * DAY + DAY),
            });
        }
        if self.minute_count >= p.minute {
            return Some(Refusal {
                reason: "minuteExhausted",
                until: Some(self.minute_bucket_start_ms + 60_000),
            });
        }
        if let Some(until) = self
            .last_request_at_ms
            .map(|n| n + p.spacing + jitter)
            .filter(|&u| u > now)
        {
            return Some(Refusal {
                reason: "spacing",
                until: Some(until),
            });
        }
        None
    }
    pub fn refusal(&mut self, p: Policy, priority: Priority, now: i64) -> Option<Refusal> {
        self.roll(now);
        if let Some(until) = self.open_until_ms.filter(|&u| u > now) {
            return Some(Refusal {
                reason: "circuitOpen",
                until: Some(until),
            });
        }
        if self.day_count >= p.day {
            return Some(Refusal {
                reason: "dayExhausted",
                until: Some(now.div_euclid(DAY) * DAY + DAY),
            });
        }
        if priority == Priority::Interactive {
            return None;
        }
        if self.consecutive_failures > 0 {
            return Some(Refusal {
                reason: "degraded",
                until: None,
            });
        }
        if self.day_count.saturating_add(p.reserve) >= p.day {
            return Some(Refusal {
                reason: "reserveHeld",
                until: Some(now.div_euclid(DAY) * DAY + DAY),
            });
        }
        None
    }
    pub fn proceed(&mut self, now: i64) {
        self.roll(now);
        self.minute_count += 1;
        self.day_count += 1;
        self.total_requests += 1;
        self.last_request_at_ms = Some(now);
    }
    pub fn success(&mut self) {
        self.consecutive_failures = 0;
        self.open_until_ms = None;
    }
    pub fn failure(&mut self, p: Policy, kind: &str, retry: Option<i64>, message: &str, now: i64) {
        self.consecutive_failures += 1;
        let steps = [60_000, 300_000, 1_800_000, 7_200_000, DAY];
        let step = steps[(self.consecutive_failures.min(5) - 1) as usize];
        self.open_until_ms = Some(
            now + step
                .max(retry.unwrap_or(0).saturating_mul(1000))
                .min(p.cooldown_max),
        );
        self.last_failure_at_ms = Some(now);
        self.last_failure_reason = Some(format!("{kind}: {message}").chars().take(200).collect());
    }
}
#[derive(Clone)]
pub struct Guard {
    state: Arc<Mutex<State>>,
    pool: PgPool,
    policy: Policy,
}
impl Guard {
    pub async fn load(pool: PgPool, policy: Policy) -> Result<Self> {
        let blob: Option<serde_json::Value> = sqlx::query_scalar(
            "SELECT state_json FROM source_guard_state WHERE source_id='robomaster'",
        )
        .fetch_optional(&pool)
        .await?;
        let state = blob
            .and_then(|b| match serde_json::from_value(b) {
                Ok(s) => Some(s),
                Err(e) => {
                    tracing::warn!(%e,"invalid persisted crawler guard; starting fresh");
                    None
                }
            })
            .unwrap_or_else(|| State::new(Utc::now().timestamp_millis()));
        Ok(Self {
            state: Arc::new(Mutex::new(state)),
            pool,
            policy,
        })
    }
    async fn persist(&self, s: &State) -> Result<()> {
        sqlx::query("INSERT INTO source_guard_state (source_id,state_json,updated_at) VALUES ('robomaster',$1,$2) ON CONFLICT (source_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at").bind(serde_json::to_value(s)?).bind(Utc::now()).execute(&self.pool).await?;
        Ok(())
    }
    pub async fn refusal(&self, priority: Priority) -> Option<Refusal> {
        self.state
            .lock()
            .await
            .refusal(self.policy, priority, Utc::now().timestamp_millis())
    }
    pub async fn acquire(&self) -> Result<()> {
        let mut state = self.state.lock().await;
        loop {
            let now = Utc::now().timestamp_millis();
            let jitter = (rand::random::<f64>() * self.policy.jitter as f64) as i64;
            match state.decide(self.policy, now, jitter) {
                None => {
                    state.proceed(now);
                    self.persist(&state).await?;
                    return Ok(());
                }
                Some(r) => {
                    let until = r.until.expect("decisions have a deadline");
                    let wait = until - now;
                    if wait > self.policy.max_wait {
                        return Err(Error::Throttled {
                            until,
                            reason: r.reason,
                        });
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(wait.max(0) as u64)).await;
                }
            }
        }
    }
    pub async fn settle(&self, failure: Option<(&str, Option<i64>, &str)>) -> Result<()> {
        let mut state = self.state.lock().await;
        if let Some((kind, retry, message)) = failure {
            state.failure(
                self.policy,
                kind,
                retry,
                message,
                Utc::now().timestamp_millis(),
            );
        } else {
            state.success();
        }
        self.persist(&state).await
    }
}
#[cfg(test)]
pub(super) fn test_guard() -> Guard {
    Guard {
        state: Arc::new(Mutex::new(State::new(0))),
        pool: sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://test@localhost/test")
            .unwrap(),
        policy: Policy::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_and_reserve() {
        let p = Policy::default();
        let mut s = State::new(DAY - 500);
        s.day_count = 1800;
        assert_eq!(
            s.refusal(p, Priority::Background, DAY - 100)
                .unwrap()
                .reason,
            "reserveHeld"
        );
        assert!(s.refusal(p, Priority::Interactive, DAY - 100).is_none());
        s.roll(DAY);
        assert_eq!(s.day_count, 0);
        s.proceed(DAY);
        assert_eq!(s.decide(p, DAY + 100, 900).unwrap().until, Some(DAY + 2900));
        s.minute_count = 20;
        assert_eq!(
            s.decide(p, DAY + 3000, 0).unwrap().reason,
            "minuteExhausted"
        );
        s.roll(DAY + 60_000);
        assert_eq!(s.minute_count, 0);
    }
    #[test]
    fn cooldown_and_wire_roundtrip() {
        let p = Policy::default();
        let mut s = State::new(0);
        for wait in [60_000, 300_000, 1_800_000, 7_200_000, DAY, DAY] {
            s.failure(p, "forbidden", None, "403", 0);
            assert_eq!(s.open_until_ms, Some(wait));
        }
        s.success();
        s.failure(p, "rateLimited", Some(180), "429", 0);
        assert_eq!(s.open_until_ms, Some(180_000));
        let blob = serde_json::to_value(&s).unwrap();
        assert!(blob.get("minute_bucket_start_ms").is_some());
        assert_eq!(serde_json::from_value::<State>(blob).unwrap(), s);
        s.roll(DAY);
        assert_eq!(
            s.refusal(p, Priority::Background, DAY).unwrap().reason,
            "degraded"
        );
        assert!(s.refusal(p, Priority::Interactive, DAY).is_none());
    }
}
