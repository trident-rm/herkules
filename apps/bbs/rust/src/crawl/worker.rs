//! Two supervised loops; refresh > pending fetch > backfill.
use super::{
    Error, Result,
    corpus::{Corpus, MIN_BODY, Outcome, Work},
    guard::{Guard, Priority},
    source::{Detail, Listing, Source},
};
use std::{sync::Arc, time::Duration};
use tokio::sync::{Notify, watch};
pub trait Forum: Send + Sync {
    fn list(
        &self,
        page: i32,
        size: i32,
        priority: Priority,
    ) -> impl std::future::Future<Output = Result<Listing>> + Send;
    fn detail(
        &self,
        id: &str,
        priority: Priority,
    ) -> impl std::future::Future<Output = Result<Detail>> + Send;
}
impl Forum for Source {
    async fn list(&self, page: i32, size: i32, p: Priority) -> Result<Listing> {
        Source::list(self, page, size, p).await
    }
    async fn detail(&self, id: &str, p: Priority) -> Result<Detail> {
        Source::detail(self, id, p).await
    }
}
#[derive(Clone, Copy)]
pub struct Budget {
    pub fetch: usize,
    pub refresh: usize,
    pub backfill: usize,
}
pub const ONCE: Budget = Budget {
    fetch: 10,
    refresh: 5,
    backfill: 1,
};
pub const DISCOVERY: Budget = Budget {
    fetch: 0,
    refresh: 0,
    backfill: 0,
};
#[derive(Debug)]
pub enum WorkOutcome {
    Stored,
    Skipped,
    Failed,
    Backfill,
    Throttled(Option<i64>),
    Nothing,
}
pub struct Worker<S> {
    pub corpus: Corpus,
    pub source: S,
    pub guard: Guard,
}
impl<S: Forum> Worker<S> {
    async fn throttle(&self, until: i64) -> WorkOutcome {
        WorkOutcome::Throttled(
            self.guard
                .refusal(Priority::Background)
                .await
                .and_then(|r| r.until)
                .or(Some(until)),
        )
    }
    pub async fn run_work(&self, work: Work) -> Result<WorkOutcome> {
        match work {
            Work::Idle => Ok(WorkOutcome::Nothing),
            Work::Backfill(page) => {
                let listing = match self.source.list(page, 20, Priority::Background).await {
                    Ok(l) => l,
                    Err(Error::Throttled { until, .. }) => return Ok(self.throttle(until).await),
                    Err(e) => return Err(e),
                };
                let new = self.corpus.discover(&listing.items).await?;
                self.corpus.advance(page + 1, listing.is_last).await?;
                tracing::info!(
                    page,
                    listed = listing.items.len(),
                    discovered = new,
                    completed = listing.is_last,
                    "crawler backfill"
                );
                Ok(WorkOutcome::Backfill)
            }
            Work::Fetch(a) => self.article(a, false).await,
            Work::Refresh(a) => self.article(a, true).await,
        }
    }
    async fn article(&self, a: super::corpus::Article, refresh: bool) -> Result<WorkOutcome> {
        if !refresh && a.pinned {
            self.corpus.skip(&a.id, "pinned").await?;
            return Ok(WorkOutcome::Skipped);
        }
        let detail = match self
            .source
            .detail(
                &a.source_id,
                if refresh {
                    Priority::Interactive
                } else {
                    Priority::Background
                },
            )
            .await
        {
            Ok(d) => d,
            Err(Error::Throttled { until, .. }) => return Ok(self.throttle(until).await),
            Err(e @ Error::Source { .. }) | Err(e @ Error::Http(_)) => {
                self.corpus.failed(&a.id, &e.to_string(), refresh).await?;
                tracing::warn!(id=%a.source_id,%e,refresh,"crawler article fetch failed");
                return Ok(WorkOutcome::Failed);
            }
            Err(e) => {
                self.corpus
                    .failed(&a.id, &format!("internal error: {e}"), refresh)
                    .await?;
                return Err(e);
            }
        };
        if detail.extracted.body_text.chars().count() < MIN_BODY {
            if refresh {
                self.corpus
                    .failed(&a.id, "refresh returned a too-short body", true)
                    .await?;
                return Ok(WorkOutcome::Failed);
            }
            self.corpus.skip(&a.id, "too_short").await?;
            return Ok(WorkOutcome::Skipped);
        }
        match self.corpus.store(&a.id, &detail).await {
            Ok(changed) => {
                tracing::info!(id=%a.source_id,title=%a.title,refresh,changed,"crawler stored article");
                Ok(WorkOutcome::Stored)
            }
            Err(e) => {
                self.corpus
                    .failed(&a.id, &format!("internal error: {e}"), refresh)
                    .await?;
                Err(e)
            }
        }
    }
    pub async fn cycle(&self, trigger: &str, budget: Budget) -> Result<Outcome> {
        let run = self.corpus.start(trigger).await?;
        let mut o = Outcome::default();
        if let Err(e) = self.cycle_inner(budget, &mut o).await {
            o.error = Some(e.to_string().chars().take(500).collect());
        }
        self.corpus.finish(&run, &o).await?;
        if let Some(e) = &o.error {
            tracing::warn!(trigger,error=%e,"crawler poll failed");
        }
        Ok(o)
    }
    async fn cycle_inner(&self, b: Budget, o: &mut Outcome) -> Result<()> {
        let first = self.source.list(1, 20, Priority::Background).await?;
        let mut listed = first.items;
        for _ in 0..b.backfill {
            let Work::Backfill(page) = self.corpus.next(false, false, true).await? else {
                break;
            };
            if self.guard.refusal(Priority::Background).await.is_some() {
                break;
            }
            let listing = match self.source.list(page, 20, Priority::Background).await {
                Ok(l) => l,
                Err(Error::Throttled { .. }) => break,
                // Preserve successful discovery and retry this backfill page later.
                Err(Error::Source { .. }) | Err(Error::Http(_)) => break,
                Err(e) => return Err(e),
            };
            listed.extend(listing.items);
            self.corpus.advance(page + 1, listing.is_last).await?;
            if listing.is_last {
                break;
            }
        }
        o.listed = listed.len() as i32;
        o.discovered = self.corpus.discover(&listed).await?;
        self.corpus.checked().await?;
        for _ in 0..b.fetch {
            let Work::Fetch(a) = self.corpus.next(false, true, false).await? else {
                break;
            };
            match self.article(a, false).await? {
                WorkOutcome::Stored => o.fetched += 1,
                WorkOutcome::Skipped => o.skipped += 1,
                WorkOutcome::Failed => o.failed += 1,
                WorkOutcome::Throttled(_) => break,
                _ => {}
            }
        }
        for _ in 0..b.refresh {
            let Work::Refresh(a) = self.corpus.next(true, false, false).await? else {
                break;
            };
            match self.article(a, true).await? {
                WorkOutcome::Stored | WorkOutcome::Failed => o.refreshed += 1,
                WorkOutcome::Throttled(_) => break,
                _ => {}
            }
        }
        Ok(())
    }
    async fn discovery_loop(&self, wake: &Notify, stop: watch::Receiver<bool>) -> Result<()> {
        if *stop.borrow() {
            return Ok(());
        }
        let o = self.cycle("startup", DISCOVERY).await?;
        if o.discovered > 0 {
            wake.notify_one();
        }
        while !*stop.borrow() {
            let delay = 600_000 + (rand::random::<f64>() * 30_000.) as u64;
            if sleep(delay, stop.clone()).await {
                break;
            }
            let o = self.cycle("scheduled", DISCOVERY).await?;
            if o.discovered > 0 {
                wake.notify_one();
            }
        }
        Ok(())
    }
    async fn fetch_loop(&self, wake: &Notify, stop: watch::Receiver<bool>) -> Result<()> {
        while !*stop.borrow() {
            let work = self.corpus.next(true, true, true).await?;
            if matches!(work, Work::Idle) {
                wait(wake, 60_000, stop.clone()).await;
                continue;
            }
            if matches!(work, Work::Fetch(_) | Work::Backfill(_))
                && let Some(r) = self.guard.refusal(Priority::Background).await
            {
                let now = chrono::Utc::now().timestamp_millis();
                let delay = r.until.unwrap_or(now + 900_000).min(now + 900_000) - now;
                tracing::info!(reason = r.reason, delay, "crawler paused");
                wait(wake, delay.max(0) as u64, stop.clone()).await;
                continue;
            }
            let outcome = match work {
                Work::Refresh(a) => self.article(a, true).await,
                w => self.run_work(w).await,
            };
            let delay = match outcome {
                Ok(WorkOutcome::Stored | WorkOutcome::Failed | WorkOutcome::Backfill) => 10_000,
                Ok(WorkOutcome::Throttled(until)) => {
                    (until.unwrap_or(0) - chrono::Utc::now().timestamp_millis())
                        .clamp(60_000, 3_600_000) as u64
                }
                Ok(_) => 0,
                Err(e) => {
                    tracing::warn!(%e,"crawler work crashed; pausing");
                    60_000
                }
            };
            if sleep(delay, stop.clone()).await {
                break;
            }
        }
        Ok(())
    }
    async fn supervised(
        &self,
        name: &str,
        wake: &Notify,
        stop: watch::Receiver<bool>,
    ) -> Result<()> {
        let mut backoff = 30_000;
        while !*stop.borrow() {
            let started = tokio::time::Instant::now();
            let result = if name == "discovery" {
                self.discovery_loop(wake, stop.clone()).await
            } else {
                self.fetch_loop(wake, stop.clone()).await
            };
            match result {
                Ok(()) => return Ok(()),
                Err(e) => {
                    if *stop.borrow() {
                        return Ok(());
                    }
                    if started.elapsed() >= Duration::from_secs(600) {
                        backoff = 30_000;
                    }
                    tracing::warn!(loop_name=name,%e,backoff,"crawler loop crashed; restarting");
                    if sleep(backoff, stop.clone()).await {
                        break;
                    }
                    backoff = (backoff * 2).min(600_000);
                }
            }
        }
        Ok(())
    }
    pub async fn work(&self, stop: watch::Receiver<bool>) -> Result<()> {
        let wake = Arc::new(Notify::new());
        tracing::info!("crawler started");
        tokio::try_join!(
            self.supervised("discovery", &wake, stop.clone()),
            self.supervised("fetch", &wake, stop)
        )?;
        tracing::info!("crawler stopped");
        Ok(())
    }
}
async fn sleep(ms: u64, mut stop: watch::Receiver<bool>) -> bool {
    if *stop.borrow() {
        return true;
    }
    tokio::select! {_=tokio::time::sleep(Duration::from_millis(ms))=>false,_=stop.changed()=>true}
}
async fn wait(wake: &Notify, ms: u64, stop: watch::Receiver<bool>) {
    tokio::select! {_=wake.notified()=>{},_=sleep(ms,stop)=>{}}
}
