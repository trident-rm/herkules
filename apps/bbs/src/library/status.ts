/**
 * Library counts for `/api/status`, the Status page and MCP `library_status`.
 *
 * rm-wenku's status was a live crawler/AI console over SSE. None of that has a
 * data source here — the crawler and the generator run on the old box — so what
 * is left is genuinely static between imports: counts plus "when did this
 * corpus arrive". ONE query of scalar subselects:
 *   total/fetched/skipped articles, tags, images, links, ai ready, ai missing
 *   (fetched with no article_ai row), entities with article_count > 0,
 *   max(poll_runs.started_at), max(sources.backfill_completed_at), the sources
 *   row's name/site_url, max(import_runs.finished_at) WHERE ok AND NOT noop.
 * Deliberately NOT reported: cost totals and the AI budget (`ai_usage.cost_usd`
 * is a frozen historical number that would read as live spend).
 */
import { sql } from "drizzle-orm";

import { rowsOf } from "../db/index.ts";
import {
  botState,
  articleAi,
  articleImages,
  articleLinks,
  articleTags,
  articles,
  importRuns,
  kbEntities,
  pollRuns,
  sources,
} from "../db/schema.ts";
import { FETCHED, date, num, str } from "./articles.ts";
import type { LibraryDeps } from "./index.ts";
import type { LibraryStatus } from "./types.ts";

const ageSeconds = (d: Date | null): number | null =>
  d ? Math.max(0, Math.round((Date.now() - d.getTime()) / 1000)) : null;

export async function getStatus(deps: LibraryDeps): Promise<LibraryStatus> {
  const r = rowsOf(
    await deps.db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM ${articles}) AS total,
        (SELECT count(*)::int FROM ${articles} WHERE ${FETCHED}) AS fetched,
        (SELECT count(*)::int FROM ${articles} WHERE ${articles.status} = 'skipped') AS skipped,
        (SELECT count(*)::int FROM ${articleTags} JOIN ${articles} ON ${articles.id} = ${articleTags.articleId} AND ${FETCHED}) AS tags,
        (SELECT count(*)::int FROM ${articleImages} JOIN ${articles} ON ${articles.id} = ${articleImages.articleId} AND ${FETCHED}) AS images,
        (SELECT count(*)::int FROM ${articleLinks} JOIN ${articles} ON ${articles.id} = ${articleLinks.articleId} AND ${FETCHED}) AS links,
        (SELECT count(*)::int FROM ${articleAi} JOIN ${articles} ON ${articles.id} = ${articleAi.articleId} AND ${FETCHED} WHERE ${articleAi.status} = 'ready') AS ai_ready,
        (SELECT count(*)::int FROM ${articles} WHERE ${FETCHED} AND NOT EXISTS (SELECT 1 FROM ${articleAi} WHERE ${articleAi.articleId} = ${articles.id})) AS ai_missing,
        (SELECT count(*)::int FROM ${kbEntities} WHERE ${kbEntities.articleCount} > 0) AS entities,
        (SELECT ${botState.lastReconciledAt} FROM ${botState} WHERE ${botState.id} = 1) AS bot_reconciled_at,
        (SELECT max(${pollRuns.startedAt}) FROM ${pollRuns}) AS last_checked_at,
        (SELECT max(${sources.backfillCompletedAt}) FROM ${sources}) AS backfill_completed_at,
        (SELECT ${sources.name} FROM ${sources} ORDER BY ${sources.createdAt} LIMIT 1) AS site_name,
        (SELECT ${sources.siteUrl} FROM ${sources} ORDER BY ${sources.createdAt} LIMIT 1) AS site_url,
        (SELECT max(${importRuns.finishedAt}) FROM ${importRuns} WHERE ${importRuns.ok} AND NOT ${importRuns.noop}) AS imported_at`),
  )[0];
  return {
    site: { name: str(r?.site_name) ?? "RM 论坛", url: str(r?.site_url) ?? "" },
    articles: {
      total: num(r?.total),
      fetched: num(r?.fetched),
      skipped: num(r?.skipped),
      tags: num(r?.tags),
      images: num(r?.images),
      links: num(r?.links),
    },
    ai: { ready: num(r?.ai_ready), missing: num(r?.ai_missing), entities: num(r?.entities) },
    crawler: {
      lastCheckedAt: date(r?.last_checked_at),
      // Gatus conditions cannot diff timestamps; the status page checks this number (tools/deploy/gatus.yaml).
      lastCheckedAgeSeconds: ageSeconds(date(r?.last_checked_at)),
      backfillCompletedAt: date(r?.backfill_completed_at),
    },
    bot: {
      lastReconciledAt: date(r?.bot_reconciled_at),
      lastReconciledAgeSeconds: ageSeconds(date(r?.bot_reconciled_at)),
    },
    importedAt: date(r?.imported_at),
  };
}
