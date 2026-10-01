/**
 * THE CORPUS WRITE MODULE. Every statement that changes an imported table
 * from a running process is in this file: discovery upserts, the article
 * write transaction, status marks, the refresh request, the backfill cursor,
 * poll_runs and the `sources` row. It also owns the ONE read the crawler
 * needs, `nextWork` — the fetch ladder as a single SQL statement.
 *
 * What it hides: SQL, ULID minting, the four derived columns
 * (renderArticleHtml / splitTitle / buildDocument / resolveLinkTarget — the
 * same functions `bbs import` calls; a crawler-only derivation would be the
 * FRAME's second kill criterion), the link back-fill (links.ts, forward-only),
 * the image upsert that keeps AI captions, and every COALESCE rule rm-wenku's
 * articles.rs had. What it does not know: HTTP, the forum, the guard, time
 * (every method takes `now`).
 *
 * IDEMPOTENCE, per operation:
 *   ensureSource     INSERT … ON CONFLICT (id) DO UPDATE kind/name/site_url. Any number of times.
 *   abandonRunning   UPDATE WHERE status='running'. Second call: 0 rows.
 *   discover         one statement per item, ON CONFLICT (source_id, source_article_id) DO UPDATE
 *                    listing_position/is_pinned/introduction(COALESCE) WHERE they differ; tags inserted
 *                    only when the row is new. Re-listing the same page: 0 changes. Dangling links resolved
 *                    only when ≥ 1 row was new.
 *   storeDetail      ONE transaction. Dies half-way → nothing visible. Same detail twice →
 *                    same rows, content_changed_at untouched (hash equal), updated_at/fetched_at bumped.
 *   markSkipped/markFailed/finishRefreshFailed   single UPDATEs; repeatable.
 *   noteArticleRead  UPDATE … WHERE refresh_requested_at IS NULL: the second caller writes 0 rows.
 *   advanceBackfill  writes the cursor it is given (absolute); a re-run of the same page re-discovers the same rows (0 changes).
 *   Two workers by mistake: excluded at process start by the advisory lock (index.ts); every write above is
 *   keyed by (source_id, source_article_id) or a single row, so even then the corpus stays consistent.
 */
import type { SQL } from "drizzle-orm";
import { and, eq, isNull, notInArray, sql } from "drizzle-orm";

import { renderArticleHtml } from "../content/render.ts";
import { sha256Hex, truncateChars } from "../content/text.ts";
import { splitTitle } from "../content/title.ts";
import type { BbsDb } from "../db/index.ts";
import { rowsOf } from "../db/index.ts";
import {
  articleImages,
  articleLinks,
  articleSearch,
  articleTags,
  articles,
  pollRuns,
  sources,
} from "../db/schema.ts";
import { buildDocument, resolveLinkTarget } from "../import/derive.ts";
import type { ArticleDetail, ListedArticle, SourceId } from "../source/index.ts";
import { loadLinkTargets, resolveDanglingLinks } from "./links.ts";
import { ulid } from "./ulid.ts";

export type ArticleRowId = string & { readonly __articleRowId: unique symbol }; // a ULID
export type RunId = string & { readonly __runId: unique symbol };

export type PollTrigger = "startup" | "scheduled" | "manual";
export type SkipReason = "pinned" | "too_short";

/** What the ladder hands the worker. Ordered: refresh beats fetch beats backfill. */
export type Work =
  | { readonly kind: "refresh"; readonly article: PendingArticle }
  | { readonly kind: "fetch"; readonly article: PendingArticle }
  | { readonly kind: "backfill"; readonly nextPage: number }
  | { readonly kind: "idle" };

export interface PendingArticle {
  readonly id: ArticleRowId;
  readonly sourceArticleId: string;
  readonly title: string;
  readonly isPinned: boolean;
}

export interface RunOutcome {
  listed: number;
  discovered: number;
  fetched: number;
  skipped: number;
  failed: number;
  refreshed: number;
  error: string | null;
}

/**
 * A Date inside a raw sql`` fragment is NOT mapped by the column (drizzle only maps values it
 * assigns to a column): postgres.js then sends it untyped as Date#toString(), which real Postgres
 * rejects ("Fri Aug 28 2026 … (Coordinated Universal Time)") while PGlite accepts it. Every raw
 * timestamp parameter goes through here: ISO text with an explicit cast.
 */
const ts = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`;
const tsOrNull = (d: Date | null): SQL => (d ? ts(d) : sql`NULL::timestamptz`);

export interface Corpus {
  ensureSource(seed: { kind: string; name: string; siteUrl: string }, now: Date): Promise<void>;
  abandonRunning(now: Date): Promise<number>;
  startRun(trigger: PollTrigger, now: Date): Promise<RunId>;
  /** status = error ? 'failed' : 'succeeded'; error clipped to 500 chars. */
  finishRun(runId: RunId, outcome: RunOutcome, now: Date): Promise<void>;
  /** sources.last_checked_at = now, initialized_at = COALESCE(initialized_at, now). */
  markChecked(now: Date): Promise<void>;
  /** ONE transaction per listing page. Returns how many were NEW. Tags for new rows only; dangling links resolved when new > 0. */
  discover(listed: readonly ListedArticle[], now: Date): Promise<number>;
  /** Disabled rungs (budget 0) are excluded from the statement. */
  nextWork(
    now: Date,
    enabled: { refresh: boolean; fetch: boolean; backfill: boolean },
  ): Promise<Work>;
  advanceBackfill(nextPage: number, completedAt: Date | null, now: Date): Promise<void>;
  /** THE article transaction. Returns whether body_text's hash changed. */
  storeDetail(id: ArticleRowId, detail: ArticleDetail, now: Date): Promise<{ changed: boolean }>;
  markSkipped(id: ArticleRowId, reason: SkipReason, now: Date): Promise<void>;
  markFailed(id: ArticleRowId, error: string, now: Date): Promise<void>;
  /** refresh_requested_at = NULL, last_error = error; status and content untouched. */
  finishRefreshFailed(id: ArticleRowId, error: string, now: Date): Promise<void>;
}

/** Failed rows return to the ladder once updated_at < now - this. */
export const FAILED_RETRY_MS = 3_600_000;
/** rm-wenku config.rs:115 `min_body_chars: 100`. Code points (content/text.ts countChars). First fetch: skipped too_short; refresh: content kept. */
export const MIN_BODY_CHARS = 100;
/** How old a fetched article may be before a reader's GET queues a refresh. rm-wenku refresh_stale_after_hours 24. */
export const REFRESH_STALE_AFTER_MS = 24 * 3_600_000;

const ERROR_CHARS = 500;

function titleColumns(title: string) {
  const parts = splitTitle(title);
  return {
    titleSeason: parts.season,
    titleTeam: parts.team,
    titleTopic: parts.topic,
    titleLabels: [...parts.labels],
  };
}

export function createCorpus(db: BbsDb, sourceId: SourceId): Corpus {
  return {
    async ensureSource(seed, now) {
      await db
        .insert(sources)
        .values({
          id: sourceId,
          kind: seed.kind,
          name: seed.name,
          siteUrl: seed.siteUrl,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: sources.id,
          set: { kind: seed.kind, name: seed.name, siteUrl: seed.siteUrl, updatedAt: now },
        });
    },

    async abandonRunning(now) {
      const rows = await db
        .update(pollRuns)
        .set({
          status: "failed",
          finishedAt: now,
          error: "interrupted: the process stopped before the run finished",
        })
        .where(eq(pollRuns.status, "running"))
        .returning({ id: pollRuns.id });
      return rows.length;
    },

    async startRun(trigger, now) {
      const id = ulid(now.getTime());
      await db
        .insert(pollRuns)
        .values({ id, sourceId, trigger, status: "running", startedAt: now });
      return id as RunId;
    },

    async finishRun(runId, outcome, now) {
      await db
        .update(pollRuns)
        .set({
          status: outcome.error ? "failed" : "succeeded",
          finishedAt: now,
          listed: outcome.listed,
          discovered: outcome.discovered,
          fetched: outcome.fetched,
          skipped: outcome.skipped,
          failed: outcome.failed,
          refreshed: outcome.refreshed,
          error: outcome.error ? truncateChars(outcome.error, ERROR_CHARS) : null,
        })
        .where(eq(pollRuns.id, runId));
    },

    async markChecked(now) {
      await db
        .update(sources)
        .set({
          lastCheckedAt: now,
          initializedAt: sql`coalesce(${sources.initializedAt}, ${ts(now)})`,
          updatedAt: now,
        })
        .where(eq(sources.id, sourceId));
    },

    discover(listed, now) {
      return db.transaction(async (tx) => {
        let newCount = 0;
        for (const item of listed) {
          const rows = await tx
            .insert(articles)
            .values({
              id: ulid(now.getTime()),
              sourceId,
              sourceArticleId: item.sourceArticleId,
              canonicalUrl: item.url,
              urlHash: sha256Hex(item.url),
              title: item.title,
              ...titleColumns(item.title),
              author: item.author,
              publishedAt: item.publishedAt,
              discoveredAt: now,
              listingPosition: item.listingPosition,
              isPinned: item.isPinned,
              introduction: item.introduction,
              status: "pending",
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [articles.sourceId, articles.sourceArticleId],
              set: {
                listingPosition: sql`excluded.listing_position`,
                isPinned: sql`excluded.is_pinned`,
                introduction: sql`coalesce(${articles.introduction}, excluded.introduction)`,
                updatedAt: sql`excluded.updated_at`,
              },
              setWhere: sql`${articles.listingPosition} <> excluded.listing_position OR ${articles.isPinned} <> excluded.is_pinned OR (${articles.introduction} IS NULL AND excluded.introduction IS NOT NULL)`,
            })
            .returning({ id: articles.id, inserted: sql<boolean>`(xmax = 0)` });
          const row = rows[0];
          if (!row?.inserted) continue;
          newCount += 1;
          if (item.tags.length > 0) {
            await tx
              .insert(articleTags)
              .values(item.tags.map((tag, position) => ({ articleId: row.id, tag, position })))
              .onConflictDoNothing();
          }
        }
        if (newCount > 0) await resolveDanglingLinks(tx, await loadLinkTargets(tx, sourceId));
        return newCount;
      });
    },

    async nextWork(now, enabled) {
      const rungs = [];
      if (enabled.refresh) {
        rungs.push(sql`(SELECT 1 AS rank, id, source_article_id, title, is_pinned, NULL::int AS page
          FROM articles WHERE source_id = ${sourceId} AND status = 'fetched' AND refresh_requested_at IS NOT NULL
          ORDER BY refresh_requested_at ASC, id ASC LIMIT 1)`);
      }
      if (enabled.fetch) {
        const retryBefore = new Date(now.getTime() - FAILED_RETRY_MS);
        rungs.push(sql`(SELECT 2 AS rank, id, source_article_id, title, is_pinned, NULL::int AS page
          FROM articles WHERE source_id = ${sourceId}
            AND (status = 'pending' OR (status = 'failed' AND updated_at < ${ts(retryBefore)}))
          ORDER BY coalesce(published_at, discovered_at) DESC, listing_position ASC, id DESC LIMIT 1)`);
      }
      if (enabled.backfill) {
        rungs.push(sql`(SELECT 3 AS rank, NULL::text AS id, NULL::text AS source_article_id, NULL::text AS title, NULL::boolean AS is_pinned, greatest(backfill_next_page, 2) AS page
          FROM sources WHERE id = ${sourceId} AND backfill_completed_at IS NULL)`);
      }
      if (rungs.length === 0) return { kind: "idle" };
      const query = sql`SELECT * FROM (${sql.join(rungs, sql` UNION ALL `)}) AS ladder ORDER BY rank LIMIT 1`;
      const row = rowsOf(await db.execute(query))[0];
      if (!row) return { kind: "idle" };
      const rank = Number(row.rank);
      if (rank === 3) return { kind: "backfill", nextPage: Number(row.page) };
      const article: PendingArticle = {
        id: String(row.id) as ArticleRowId,
        sourceArticleId: String(row.source_article_id),
        title: String(row.title),
        isPinned: Boolean(row.is_pinned),
      };
      return { kind: rank === 1 ? "refresh" : "fetch", article };
    },

    async advanceBackfill(nextPage, completedAt, now) {
      await db
        .update(sources)
        .set({ backfillNextPage: nextPage, backfillCompletedAt: completedAt, updatedAt: now })
        .where(eq(sources.id, sourceId));
    },

    storeDetail(id, detail, now) {
      return db.transaction(async (tx) => {
        const prev = (
          await tx
            .select({ contentHash: articles.contentHash, canonicalUrl: articles.canonicalUrl })
            .from(articles)
            .where(eq(articles.id, id))
            .for("update")
        )[0];
        if (!prev) throw new Error(`storeDetail: no article ${id}`);
        const { extracted } = detail;
        const hash = sha256Hex(extracted.bodyText);
        const changed = prev.contentHash !== hash;
        const links = [...extracted.links].sort((a, b) => a.position - b.position);
        const contentHtml = renderArticleHtml({
          format: detail.format,
          raw: detail.raw,
          baseUrl: prev.canonicalUrl,
          title: detail.title,
          links: links.map((l) => ({ url: l.url, label: l.label })),
        });
        await tx
          .update(articles)
          .set({
            title: detail.title,
            ...titleColumns(detail.title),
            author: sql`coalesce(${detail.author}, ${articles.author})`,
            publishedAt: sql`coalesce(${tsOrNull(detail.publishedAt)}, ${articles.publishedAt})`,
            introduction: sql`coalesce(${detail.introduction}, ${articles.introduction})`,
            isPinned: detail.isPinned,
            contentFormat: detail.format,
            contentRaw: detail.raw,
            contentHtml, // INVARIANT: non-null wherever content_raw is; written together here.
            bodyText: extracted.bodyText,
            contentHash: hash,
            parserVersion: detail.parserVersion,
            status: "fetched",
            skipReason: null,
            lastError: null,
            fetchedAt: now,
            updatedAt: now,
            refreshRequestedAt: null,
            contentChangedAt: changed
              ? now
              : sql`coalesce(${articles.contentChangedAt}, ${ts(now)})`,
          })
          .where(eq(articles.id, id));

        // rm-wenku replace_tags: replaced when the detail carries tags, left alone when it carries none.
        if (detail.tags.length > 0) {
          await tx.delete(articleTags).where(eq(articleTags.articleId, id));
          await tx
            .insert(articleTags)
            .values(detail.tags.map((tag, position) => ({ articleId: id, tag, position })))
            .onConflictDoNothing();
        }
        const tags = (
          await tx
            .select({ tag: articleTags.tag })
            .from(articleTags)
            .where(eq(articleTags.articleId, id))
            .orderBy(articleTags.position)
        ).map((t) => t.tag);

        const index = await loadLinkTargets(tx, sourceId);
        await tx.delete(articleLinks).where(eq(articleLinks.articleId, id));
        if (links.length > 0) {
          await tx
            .insert(articleLinks)
            .values(
              links.map((l) => ({
                id: ulid(now.getTime()),
                articleId: id,
                url: l.url,
                kind: l.kind,
                label: l.label,
                position: l.position,
                targetArticleId: resolveLinkTarget(index, l.url),
              })),
            )
            .onConflictDoNothing();
        }

        const images = [...extracted.images].sort((a, b) => a.position - b.position);
        const imageUrls = images.map((i) => i.url);
        await tx
          .delete(articleImages)
          .where(
            imageUrls.length === 0
              ? eq(articleImages.articleId, id)
              : and(eq(articleImages.articleId, id), notInArray(articleImages.url, imageUrls)),
          );
        for (const image of images) {
          // caption / image_kind / image_text survive — that is the point of the upsert.
          await tx
            .insert(articleImages)
            .values({
              id: ulid(now.getTime()),
              articleId: id,
              url: image.url,
              alt: image.alt,
              position: image.position,
            })
            .onConflictDoUpdate({
              target: [articleImages.articleId, articleImages.url],
              set: { alt: image.alt, position: image.position },
            });
        }

        // article_search: ARTICLE_SEARCH_FIELDS order (title, author, tags, introduction, body_text),
        // '' for nulls — rm-wenku refresh_search. The alignment CHECK fires inside this transaction.
        const fields = {
          title: detail.title,
          author: detail.author ?? "",
          tags: tags.join(" "),
          introduction: detail.introduction ?? "",
          bodyText: extracted.bodyText,
        };
        const searchRow = {
          ...fields,
          document: buildDocument([
            fields.title,
            fields.author,
            fields.tags,
            fields.introduction,
            fields.bodyText,
          ]),
        };
        await tx
          .insert(articleSearch)
          .values({ articleId: id, ...searchRow })
          .onConflictDoUpdate({ target: articleSearch.articleId, set: searchRow });

        return { changed };
      });
    },

    async markSkipped(id, reason, now) {
      await db
        .update(articles)
        .set({ status: "skipped", skipReason: reason, lastError: null, updatedAt: now })
        .where(eq(articles.id, id));
    },

    async markFailed(id, error, now) {
      await db
        .update(articles)
        .set({ status: "failed", lastError: truncateChars(error, ERROR_CHARS), updatedAt: now })
        .where(eq(articles.id, id));
    },

    async finishRefreshFailed(id, error, now) {
      await db
        .update(articles)
        .set({
          refreshRequestedAt: null,
          lastError: truncateChars(error, ERROR_CHARS),
          updatedAt: now,
        })
        .where(eq(articles.id, id));
    },
  };
}

/**
 * The API process's ONE write (rm-wenku ingest/refresh.rs::request_refresh_if_stale, called from the
 * REST GET article handler — and only there: MCP reads do not queue refreshes, as in rm-wenku).
 * The route reports a fact ("someone read this article now"); the SQL is the whole policy, so it is
 * idempotent and race-free without a read first. Returns true iff a row was written. The worker
 * notices within FETCH_IDLE_RECHECK_MS (60 s).
 */
export async function noteArticleRead(db: BbsDb, id: string, now: Date): Promise<boolean> {
  const staleBefore = new Date(now.getTime() - REFRESH_STALE_AFTER_MS);
  const rows = await db
    .update(articles)
    .set({ refreshRequestedAt: now, updatedAt: now })
    .where(
      and(
        eq(articles.id, id),
        eq(articles.status, "fetched"),
        isNull(articles.refreshRequestedAt),
        sql`coalesce(${articles.fetchedAt}, '-infinity'::timestamptz) < ${ts(staleBefore)}`,
      ),
    )
    .returning({ id: articles.id });
  return rows.length === 1;
}
