/**
 * The loops. Port of wenku-service workers.rs + ingest/{mod,work,refresh}.rs
 * with the event bus, status and AI removed. Two supervised loops share one
 * process, one Source, one Guard and one Wake (Frame 2's process shape):
 *
 *   discovery   startup cycle, then every 600 s (+0–30 s): runCycle(DISCOVERY_ONLY) — list page 1 (20), discover,
 *               markChecked; wake fetch if new
 *   fetch       nextWork() → refresh | fetch | backfill | idle, paced per outcome
 *
 * ONE implementation per rung: `runWork` is what the fetch loop runs AND what
 * `runCycle` runs inside a budgeted cycle (`Budget` replaces rm-wenku's
 * `full: bool`, whose two code paths drifted). `once()` is
 * `runCycle("manual", ONCE)`: discovery + one backfill page + ≤ 10 fetches +
 * ≤ 5 refreshes — rm-wenku's full poll. A poll_runs row brackets every cycle;
 * a crash inside leaves it 'running' for abandonRunning.
 *
 * Shared-state answer: discovery and fetch both write `articles`, but discovery
 * touches only listing columns (guarded upsert) and fetch touches content
 * columns (single transaction) — Postgres row locks serialise them and neither
 * overwrites the other's columns. Both use the same Guard, which serialises
 * requests. No `AlreadyRunning` mutex: nothing can start a second cycle in
 * this process (no admin `poll now`), and a second process is refused by the
 * advisory lock in index.ts.
 */
import { countChars, truncateChars } from "../content/text.ts";
import type { Clock } from "../guard/clock.ts";
import type { Guard, Refusal } from "../guard/index.ts";
import { ThrottledError } from "../guard/index.ts";
import type { Source } from "../source/index.ts";
import { SourceError } from "../source/index.ts";
import type { Corpus, PollTrigger, RunOutcome, Work } from "./corpus.ts";
import { MIN_BODY_CHARS } from "./corpus.ts";

// ── policy constants (rm-wenku config defaults; Frame 2 changes FETCH_IDLE_RECHECK 600 → 60 s) ──
export const POLL_INTERVAL_MS = 600_000;
export const POLL_JITTER_MS = 30_000;
export const DISCOVERY_WINDOW = 20; // page 1 size
export const FETCH_INTERVAL_MS = 10_000;
export const FETCH_IDLE_RECHECK_MS = 60_000;
export const FETCH_ERROR_PAUSE_MS = 60_000;
export const PAUSE_RECHECK_MS = 900_000;
export const THROTTLE_DEFAULT_WAIT_MS = 60_000;
export const THROTTLE_MAX_WAIT_MS = 3_600_000;
export const RESTART_BACKOFF_MIN_MS = 30_000;
export const RESTART_BACKOFF_MAX_MS = 600_000;
export const BACKFILL_PAGE_SIZE = 20;

/** How much of each rung one cycle may do. The ONLY difference between the discovery loop's cycle and `once()`. */
export interface Budget {
  readonly fetch: number;
  readonly refresh: number;
  readonly backfill: number;
}
export const DISCOVERY_ONLY: Budget = { fetch: 0, refresh: 0, backfill: 0 };
/** rm-wenku process_batch_size 10 / refresh_batch_size 5 / backfill_pages_per_run 1. */
export const ONCE: Budget = { fetch: 10, refresh: 5, backfill: 1 };

export interface WorkerDeps {
  readonly corpus: Corpus;
  readonly source: Source;
  readonly guard: Guard;
  readonly clock: Clock;
  readonly log: (line: string) => void;
}

/** One-shot signal with memory: `wake()` before `wait()` resolves the next wait immediately (tokio::Notify semantics). */
export interface Wake {
  wake(): void;
  wait(ms: number, signal?: AbortSignal): Promise<"woken" | "timeout" | "aborted">;
}

export function createWake(clock: Clock): Wake {
  let permit = false;
  let waiting: AbortController | null = null;
  return {
    wake() {
      permit = true;
      waiting?.abort();
    },
    async wait(ms, signal) {
      if (permit) {
        permit = false;
        return "woken";
      }
      if (signal?.aborted) return "aborted";
      const ac = new AbortController();
      waiting = ac;
      const combined = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal;
      const result = await clock.sleep(ms, combined);
      waiting = null;
      if (permit) {
        permit = false;
        return "woken";
      }
      return result === "aborted" ? "aborted" : "timeout";
    },
  };
}

export type WorkOutcome =
  | { readonly kind: "stored" }
  | { readonly kind: "skipped" }
  | { readonly kind: "failed" }
  | {
      readonly kind: "backfillPage";
      readonly listed: number;
      readonly discovered: number;
      readonly completed: boolean;
    }
  | { readonly kind: "throttled"; readonly untilMs: number | null }
  | { readonly kind: "nothing" };

function zeroOutcome(): RunOutcome {
  return { listed: 0, discovered: 0, fetched: 0, skipped: 0, failed: 0, refreshed: 0, error: null };
}

function count(outcome: RunOutcome, o: WorkOutcome, isRefresh: boolean): void {
  if (isRefresh && (o.kind === "stored" || o.kind === "failed")) outcome.refreshed += 1;
  else if (o.kind === "stored") outcome.fetched += 1;
  else if (o.kind === "skipped") outcome.skipped += 1;
  else if (o.kind === "failed") outcome.failed += 1;
}

/**
 * rm-wenku `cycle`. Always writes the poll_runs row, even when the listing throws.
 * Order: list page 1 → (budget.backfill pages, guard permitting; appended to `listed`) → discover → markChecked
 * → budget.fetch × runWork(fetch) → budget.refresh × runWork(refresh). A throttle ends the fetch phases early
 * (no row touched). Only the page-1 listing failure fails the run (rm-wenku: everything else lands on rows).
 */
export async function runCycle(
  deps: WorkerDeps,
  trigger: PollTrigger,
  budget: Budget,
): Promise<RunOutcome> {
  const { corpus, source, guard, clock } = deps;
  const now = () => new Date(clock.now());
  const runId = await corpus.startRun(trigger, now());
  const outcome = zeroOutcome();
  try {
    const first = await source.listPage(1, DISCOVERY_WINDOW, "background");
    const listed = [...first.items];
    for (let i = 0; i < budget.backfill; i++) {
      const w = await corpus.nextWork(now(), { refresh: false, fetch: false, backfill: true });
      if (w.kind !== "backfill" || guard.allows("background")) break;
      let page;
      try {
        page = await source.listPage(w.nextPage, BACKFILL_PAGE_SIZE, "background");
      } catch (e) {
        if (e instanceof ThrottledError || SourceError.is(e)) break;
        throw e;
      }
      listed.push(...page.items);
      await corpus.advanceBackfill(w.nextPage + 1, page.isLast ? now() : null, now());
      if (page.isLast) break;
    }
    outcome.listed = listed.length;
    outcome.discovered = await corpus.discover(listed, now());
    await corpus.markChecked(now());

    for (let i = 0; i < budget.fetch; i++) {
      const w = await corpus.nextWork(now(), { refresh: false, fetch: true, backfill: false });
      if (w.kind !== "fetch") break;
      const o = await runWork(deps, w);
      count(outcome, o, false);
      if (o.kind === "throttled") break;
    }
    for (let i = 0; i < budget.refresh; i++) {
      const w = await corpus.nextWork(now(), { refresh: true, fetch: false, backfill: false });
      if (w.kind !== "refresh") break;
      const o = await runWork(deps, w);
      count(outcome, o, true);
      if (o.kind === "throttled") break;
    }
  } catch (e) {
    outcome.error = truncateChars(e instanceof Error ? e.message : String(e), 500);
  } finally {
    await corpus.finishRun(runId, outcome, now());
  }
  if (outcome.error) deps.log(`poll ${trigger} failed: ${outcome.error}`);
  return outcome;
}

function throttled(deps: WorkerDeps, e: ThrottledError): WorkOutcome {
  const r = deps.guard.allows("background");
  return { kind: "throttled", untilMs: untilOf(r) ?? e.untilMs };
}

export function untilOf(r: Refusal | null): number | null {
  if (!r) return null;
  if (r.kind === "circuitOpen") return r.untilMs;
  if (r.kind === "dayExhausted" || r.kind === "reserveHeld") return r.resetsAtMs;
  return null;
}

/**
 * One unit of ladder work. Never throws for SourceError/ThrottledError; a non-source error is a crash
 * (recorded on the row like rm-wenku record_crash) and rethrown so the loop pauses.
 */
export async function runWork(deps: WorkerDeps, work: Work): Promise<WorkOutcome> {
  const { corpus, source, clock, log } = deps;
  const now = () => new Date(clock.now());
  switch (work.kind) {
    case "idle":
      return { kind: "nothing" };
    case "backfill": {
      let page;
      try {
        page = await source.listPage(work.nextPage, BACKFILL_PAGE_SIZE, "background");
      } catch (e) {
        if (e instanceof ThrottledError) return throttled(deps, e);
        throw e;
      }
      const discovered = await corpus.discover(page.items, now());
      await corpus.advanceBackfill(work.nextPage + 1, page.isLast ? now() : null, now());
      log(
        `backfill page ${work.nextPage}: ${page.items.length} listed, ${discovered} new${page.isLast ? ", completed" : ""}`,
      );
      return {
        kind: "backfillPage",
        listed: page.items.length,
        discovered,
        completed: page.isLast,
      };
    }
    case "fetch": {
      const { article } = work;
      if (article.isPinned) {
        await corpus.markSkipped(article.id, "pinned", now());
        return { kind: "skipped" };
      }
      try {
        let detail;
        try {
          detail = await source.fetchDetail(article.sourceArticleId, "background");
        } catch (e) {
          if (e instanceof ThrottledError) return throttled(deps, e);
          if (SourceError.is(e)) {
            await corpus.markFailed(article.id, e.message, now());
            log(`fetch ${article.sourceArticleId} failed: ${e.message}`);
            return { kind: "failed" };
          }
          throw e;
        }
        if (countChars(detail.extracted.bodyText) < MIN_BODY_CHARS) {
          await corpus.markSkipped(article.id, "too_short", now());
          return { kind: "skipped" };
        }
        await corpus.storeDetail(article.id, detail, now());
        log(`fetched ${article.sourceArticleId} "${article.title}"`);
        return { kind: "stored" };
      } catch (e) {
        await corpus.markFailed(article.id, `internal error: ${describe(e)}`, now());
        throw e;
      }
    }
    case "refresh": {
      const { article } = work;
      try {
        let detail;
        try {
          detail = await source.fetchDetail(article.sourceArticleId, "interactive");
        } catch (e) {
          if (e instanceof ThrottledError) return throttled(deps, e);
          if (SourceError.is(e)) {
            await corpus.finishRefreshFailed(article.id, e.message, now());
            log(`refresh ${article.sourceArticleId} failed: ${e.message}`);
            return { kind: "failed" };
          }
          throw e;
        }
        if (countChars(detail.extracted.bodyText) < MIN_BODY_CHARS) {
          await corpus.finishRefreshFailed(article.id, "refresh returned a too-short body", now());
          return { kind: "failed" };
        }
        const { changed } = await corpus.storeDetail(article.id, detail, now());
        log(`refreshed ${article.sourceArticleId}${changed ? " (content changed)" : ""}`);
        return { kind: "stored" };
      } catch (e) {
        await corpus.finishRefreshFailed(article.id, `internal error: ${describe(e)}`, now());
        throw e;
      }
    }
  }
}

function describe(e: unknown): string {
  return truncateChars(e instanceof Error ? `${e.name}: ${e.message}` : String(e), 400);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/** The fetch loop body, forever. `signal` aborts every sleep (shutdown). */
export async function fetchLoop(deps: WorkerDeps, wake: Wake, signal: AbortSignal): Promise<void> {
  const { corpus, guard, clock, log } = deps;
  while (!signal.aborted) {
    const nowMs = clock.now();
    const work = await corpus.nextWork(new Date(nowMs), {
      refresh: true,
      fetch: true,
      backfill: true,
    });
    if (work.kind === "idle") {
      await wake.wait(FETCH_IDLE_RECHECK_MS, signal);
      continue;
    }
    if (work.kind === "fetch" || work.kind === "backfill") {
      const r = guard.allows("background");
      if (r) {
        const until = Math.min(untilOf(r) ?? Number.POSITIVE_INFINITY, nowMs + PAUSE_RECHECK_MS);
        log(`paused (${r.kind}) for ${Math.round((until - nowMs) / 1000)} s`);
        await wake.wait(Math.max(0, until - nowMs), signal);
        continue;
      }
    }
    let outcome: WorkOutcome;
    try {
      outcome = await runWork(deps, work);
    } catch (e) {
      log(`${work.kind} crashed: ${describe(e)}; pausing ${FETCH_ERROR_PAUSE_MS / 1000} s`);
      await clock.sleep(FETCH_ERROR_PAUSE_MS, signal);
      continue;
    }
    switch (outcome.kind) {
      case "stored":
      case "failed":
      case "backfillPage":
        await clock.sleep(FETCH_INTERVAL_MS, signal);
        break;
      case "throttled": {
        const wait = clamp(
          (outcome.untilMs ?? 0) - clock.now(),
          THROTTLE_DEFAULT_WAIT_MS,
          THROTTLE_MAX_WAIT_MS,
        );
        log(`throttled; waiting ${Math.round(wait / 1000)} s`);
        await clock.sleep(wait, signal);
        break;
      }
      case "skipped":
      case "nothing":
        break;
    }
  }
}

export async function discoveryLoop(
  deps: WorkerDeps,
  wake: Wake,
  signal: AbortSignal,
): Promise<void> {
  const { clock } = deps;
  const first = await runCycle(deps, "startup", DISCOVERY_ONLY);
  if (first.discovered > 0) wake.wake();
  while (!signal.aborted) {
    const delay = POLL_INTERVAL_MS + clock.random() * POLL_JITTER_MS;
    if ((await clock.sleep(delay, signal)) === "aborted") break;
    const o = await runCycle(deps, "scheduled", DISCOVERY_ONLY);
    if (o.discovered > 0) wake.wake();
  }
}

/**
 * Restart-on-crash with doubling backoff 30 s → 600 s; the backoff resets once a run lasted
 * longer than the maximum backoff (a "clean iteration"). A clean return (signal aborted) ends supervision.
 */
export async function supervise(
  name: string,
  deps: WorkerDeps,
  loop: () => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const { clock, log } = deps;
  let backoff = RESTART_BACKOFF_MIN_MS;
  while (!signal.aborted) {
    const startedAt = clock.now();
    try {
      await loop();
      return;
    } catch (e) {
      if (signal.aborted) return;
      if (clock.now() - startedAt >= RESTART_BACKOFF_MAX_MS) backoff = RESTART_BACKOFF_MIN_MS;
      log(`${name} loop crashed: ${describe(e)}; restarting in ${backoff / 1000} s`);
      await clock.sleep(backoff, signal);
      backoff = Math.min(backoff * 2, RESTART_BACKOFF_MAX_MS);
    }
  }
}
