/**
 * The `bbs` database: rm-wenku's SQLite shape (migrations 0001–0006) as
 * Postgres, by way of herkules-old's measured translation — ms INTEGER ->
 * `timestamptz(3)`, 0/1 -> `boolean`, JSON TEXT -> `jsonb`, `title_labels` ->
 * `text[]`, FTS5 virtual tables -> real tables. Dropped per FRAME: `users` /
 * `sessions` / `api_tokens` (identity is the issuer's), `article_chunks` +
 * pgvector, every PGroonga index, and `article_ai.context_text`.
 *
 * Ownership rule: every table here except `import_runs` and `corpus_versions` is written by
 * `bbs import` (truncate-and-reload — DEPRECATED since Frame 2: the cutover tool and dev loader)
 * and, from Frame 2, by `bbs-worker` through crawl/corpus.ts — the only runtime writer. The API
 * process has exactly one write: articles.refresh_requested_at (crawl/corpus.ts noteArticleRead,
 * called from the REST GET article route). Derived columns are computed by the same four functions
 * on both write paths (content/render.ts, content/title.ts, import/derive.ts buildDocument +
 * resolveLinkTarget) and are versioned in `corpus_versions`; they are never synchronised, only
 * rederived (crawl/rederive.ts). The AI tables stay import-only: no phase writes them yet.
 * Column names are byte-identical to the source so the import's TableSpecs
 * and read-back digests need no mapping.
 *
 * Five departures from a byte-faithful port, each derived at import (never synced):
 *  1. `articles.content_html` — rm-wenku rendered HTML on every read (5 queries + a
 *     sanitiser). The corpus changes only when the import runs, so it is rendered once, there.
 *     `import_runs.render_version` records which renderer produced it.
 *  2. `article_links.target_article_id` — in-library link resolution, once instead of per read.
 *  3. `article_search.document` / `kb_search.document` — ONE normalised, newline-joined copy of
 *     the row's text columns, the only thing the `gin_trgm_ops` index covers. The fold
 *     (db/search/normalize.ts) is LENGTH-PRESERVING and the CHECK below proves it row by row:
 *     that is what makes `substr(document, …)` slices the folded fields (ranking) and what makes
 *     TypeScript snippets over the raw fields correct.
 *  4. `article_tags.group_name` — a GENERATED column: the `group/name` string convention gets
 *     exactly one home.
 *  5. `article_ai.context_text` is NOT ported: only chat read it, chat is out of scope, it never
 *     reached a response. A re-import restores it if chat lands here.
 *
 * `drizzle/0000_*.sql` is generated from this file; `CREATE EXTENSION IF NOT EXISTS pg_trgm;`
 * is hand-added at its top (see drizzle/README.md).
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { ResourceAttachment, ResourceNode } from "../library/resources.ts";

/** rm-wenku stored Unix milliseconds; precision 3 makes the round-trip exact. */
const ms = (name: string) => timestamp(name, { withTimezone: true, precision: 3, mode: "date" });

/** Joins a search row's fields into `document`. One character, never in a query term (terms are whitespace-split). */
export const DOCUMENT_SEPARATOR = "\n";

export const sources = pgTable("sources", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  siteUrl: text("site_url").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  backfillNextPage: integer("backfill_next_page").notNull().default(2),
  backfillCompletedAt: ms("backfill_completed_at"),
  initializedAt: ms("initialized_at"),
  lastCheckedAt: ms("last_checked_at"),
  createdAt: ms("created_at").notNull(),
  updatedAt: ms("updated_at").notNull(),
});

export const articles = pgTable(
  "articles",
  {
    id: text("id").primaryKey(), // ULID: lexicographic order is time order, so `id DESC` is a stable tiebreak
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    sourceArticleId: text("source_article_id").notNull(), // forum post id, numeric string
    canonicalUrl: text("canonical_url").notNull(),
    urlHash: text("url_hash").notNull(),
    title: text("title").notNull(),
    author: text("author"),
    publishedAt: ms("published_at"),
    discoveredAt: ms("discovered_at").notNull(),
    fetchedAt: ms("fetched_at"),
    listingPosition: integer("listing_position").notNull().default(0),
    isPinned: boolean("is_pinned").notNull().default(false),
    introduction: text("introduction"),
    contentFormat: text("content_format"), // 'html' | 'markdown' | NULL (skipped rows)
    contentRaw: text("content_raw"), // kept: serves format=markdown verbatim and is what a re-render reads
    /** DERIVED at import from (content_format, content_raw, canonical_url, title, links). NULL iff content_raw is NULL. */
    contentHtml: text("content_html"),
    bodyText: text("body_text"),
    contentHash: text("content_hash"),
    parserVersion: text("parser_version"),
    status: text("status").notNull().default("pending"), // pending|fetched|skipped|failed; every public read pins 'fetched'
    skipReason: text("skip_reason"),
    lastError: text("last_error"),
    createdAt: ms("created_at").notNull(),
    updatedAt: ms("updated_at").notNull(),
    refreshRequestedAt: ms("refresh_requested_at"), // set by a stale REST GET (24 h), consumed by the ladder, cleared by storeDetail / finishRefreshFailed
    contentChangedAt: ms("content_changed_at"),
    titleSeason: text("title_season"),
    titleTeam: text("title_team"),
    titleTopic: text("title_topic"), // non-null on every row of the snapshot (migration 6 backfill ran)
    titleLabels: text("title_labels").array(),
  },
  (t) => [
    uniqueIndex("articles_source_article_uq").on(t.sourceId, t.sourceArticleId),
    uniqueIndex("articles_source_url_uq").on(t.sourceId, t.urlHash),
    index("articles_status_idx").on(t.sourceId, t.status, t.updatedAt),
    /**
     * THE feed index. rm-wenku ordered by `COALESCE(published_at, discovered_at)` while indexing
     * `published_at` — its index could never serve its sort (ground-A #7). This is the expression,
     * in the exact key order the list and every keyset cursor use, partial on the only status the
     * public sees. Verify the generated SQL by hand after `drizzle-kit generate`.
     */
    index("articles_feed_idx")
      .on(
        sql`coalesce(${t.publishedAt}, ${t.discoveredAt}) DESC`,
        sql`${t.listingPosition} ASC`,
        sql`${t.id} DESC`,
      )
      .where(sql`${t.status} = 'fetched'`),
    /** Link resolution at import matches on canonical URL; `articles_source_article_uq` covers the post-id match. */
    index("articles_canonical_url_idx").on(t.canonicalUrl),
  ],
);

export const articleTags = pgTable(
  "article_tags",
  {
    articleId: text("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    /** `group/name`, e.g. `硬件/机器人硬件`. */
    tag: text("tag").notNull(),
    /** Source listing order; SQLite kept it in `rowid`, the import recomputes it with ROW_NUMBER(). */
    position: integer("position").notNull().default(0),
    /** DERIVED: the group half of `group/name`, or the whole tag without a `/`. The one home of the convention. */
    groupName: text("group_name")
      .notNull()
      .generatedAlwaysAs(sql`split_part(tag, '/', 1)`),
  },
  (t) => [
    primaryKey({ columns: [t.articleId, t.tag] }),
    index("article_tags_tag_idx").on(t.tag),
    index("article_tags_group_idx").on(t.groupName),
    index("article_tags_article_pos_idx").on(t.articleId, t.position),
  ],
);

export const articleLinks = pgTable(
  "article_links",
  {
    id: text("id").primaryKey(),
    articleId: text("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    kind: text("kind").notNull(), // repository|document|download|video|cloud_drive|other
    label: text("label"),
    position: integer("position").notNull(),
    /**
     * DERIVED at import: the in-library article this URL points at, matched by canonical URL or
     * by the numeric post id in `…/article/{n}` (import/derive.ts). Set for ANY target status —
     * an unlabelled link inherits the target's title regardless — while the read path exposes
     * `articleId` only when the joined target is `fetched`.
     */
    targetArticleId: text("target_article_id").references(() => articles.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    uniqueIndex("article_links_article_url_uq").on(t.articleId, t.url),
    index("article_links_article_pos_idx").on(t.articleId, t.position),
  ],
);

export const articleImages = pgTable(
  "article_images",
  {
    id: text("id").primaryKey(),
    articleId: text("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    url: text("url").notNull(), // hot-linked to the forum CDN; nothing is stored locally
    alt: text("alt"),
    position: integer("position").notNull(),
    caption: text("caption"), // AI-written; `COALESCE(NULLIF(alt,''), caption)` on read
    imageKind: text("image_kind"),
    imageText: text("image_text"),
  },
  (t) => [
    uniqueIndex("article_images_article_url_uq").on(t.articleId, t.url),
    index("article_images_article_pos_idx").on(t.articleId, t.position),
  ],
);

export const pollRuns = pgTable(
  "poll_runs",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    trigger: text("trigger").notNull(),
    status: text("status").notNull(),
    startedAt: ms("started_at").notNull(),
    finishedAt: ms("finished_at"),
    listed: integer("listed").notNull().default(0),
    discovered: integer("discovered").notNull().default(0),
    fetched: integer("fetched").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    error: text("error"),
    refreshed: integer("refreshed").notNull().default(0),
  },
  (t) => [index("poll_runs_started_idx").on(t.sourceId, t.startedAt.desc())],
);

/** One jsonb GuardState per source (guard/store.ts owns the wire keys), upserted on every request. */
export const sourceGuardState = pgTable("source_guard_state", {
  sourceId: text("source_id").primaryKey(),
  stateJson: jsonb("state_json").notNull(),
  updatedAt: ms("updated_at").notNull(),
});

/** The published RoboMaster wiki tree and the last complete check. */
export const resourceCatalog = pgTable(
  "resource_catalog",
  {
    id: integer("id").primaryKey().default(1),
    tree: jsonb("tree").$type<ResourceNode[]>().notNull(),
    syncedAt: ms("synced_at").notNull(),
  },
  (t) => [check("resource_catalog_singleton", sql`${t.id} = 1`)],
);

export const resourcePages = pgTable(
  "resource_pages",
  {
    id: text("id").notNull(),
    staged: boolean("staged").notNull().default(false),
    title: text("title").notNull(),
    html: text("html").notNull(),
    attachments: jsonb("attachments").$type<ResourceAttachment[]>().notNull(),
    updatedAt: ms("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.id, t.staged] })],
);

/** Completed changes awaiting a Feishu delivery. The bot consumes them transactionally. */
export const resourceUpdates = pgTable("resource_updates", {
  syncedAt: ms("synced_at").primaryKey(),
  changes: jsonb("changes").notNull(),
});

/**
 * APP-OWNED singleton: which RENDER_VERSION / NORMALIZE_VERSION / TITLE_VERSION produced the derived
 * columns on disk. Absent (fresh database, or first boot after this migration) means "unknown":
 * the next migrate/boot rederives everything and writes the row. NOT in IMPORTED_TABLES: an import
 * does not touch it, so the rederive after an import is the proof that both write paths agree
 * (Frame 2 done predicate 4). "There is one corpus" is a CHECK, not a convention.
 */
export const corpusVersions = pgTable(
  "corpus_versions",
  {
    id: integer("id").primaryKey().default(1),
    renderVersion: text("render_version").notNull(),
    normalizeVersion: text("normalize_version").notNull(),
    titleVersion: text("title_version").notNull(),
    updatedAt: ms("updated_at").notNull(),
  },
  (t) => [check("corpus_versions_singleton", sql`${t.id} = 1`)],
);

export const articleAi = pgTable(
  "article_ai",
  {
    articleId: text("article_id")
      .primaryKey()
      .references(() => articles.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"), // pending|ready|failed; every read pins 'ready'
    promptVersion: text("prompt_version").notNull(),
    model: text("model"),
    contextHash: text("context_hash"),
    // context_text deliberately not ported — see the header.
    overviewJson: jsonb("overview_json"), // Overview: { tldr, genre, maturity: { status }, … } (library/ai-json.ts)
    kbJson: jsonb("kb_json"), // KbEntry: { problem, domain[], robotTypes[], entities[], pitfalls[], … }
    imagesJson: jsonb("images_json"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    generatedAt: ms("generated_at"),
    updatedAt: ms("updated_at").notNull(),
  },
  (t) => [
    index("article_ai_status_idx").on(t.status, t.updatedAt),
    index("article_ai_generated_idx").on(t.generatedAt),
    // No jsonb indexes: 105 rows; every /kb statement is a scan of one small table.
    // `jsonb` is what removes rm-wenku's `json_valid()` guard class of bug (ground-A #16):
    // `jsonb_exists(NULL, x)` is NULL and `jsonb_array_elements_text(NULL)` yields no rows.
  ],
);

export const kbEntities = pgTable(
  "kb_entities",
  {
    key: text("key").primaryKey(), // entityKey(name): lower-cased alphanumerics only (library/types.ts)
    name: text("name").notNull(),
    articleCount: integer("article_count").notNull().default(0), // denormalised; 0 = orphaned by regeneration, filtered out of every read
    updatedAt: ms("updated_at").notNull(),
  },
  (t) => [index("kb_entities_count_idx").on(t.articleCount.desc(), t.name)],
);

export const articleEntities = pgTable(
  "article_entities",
  {
    articleId: text("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    entityKey: text("entity_key")
      .notNull()
      .references(() => kbEntities.key, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.articleId, t.entityKey] }),
    index("article_entities_entity_idx").on(t.entityKey),
  ],
);

/** Usage ledger. `user_id` = issuer `sub` (via `--user-map`; unmapped -> NULL). Ids are NOT all ULIDs (`legacy-…`, ground-A #13). Read by nothing in v1. */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"),
    articleId: text("article_id").references(() => articles.id, { onDelete: "set null" }),
    kind: text("kind").notNull(), // generate|chat
    model: text("model").notNull(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    createdAt: ms("created_at").notNull(),
  },
  (t) => [
    index("ai_usage_created_idx").on(t.createdAt),
    index("ai_usage_user_idx").on(t.userId, t.createdAt),
  ],
);

/**
 * The article search document (FTS5 `article_search`, `tokenize='trigram'`, read from the
 * virtual table directly — node:sqlite reads FTS5 fine). One row per FETCHED article: 905 of 969.
 *
 * `document` = normalize(title \n author \n tags \n introduction \n body_text), in
 * ARTICLE_SEARCH_FIELDS order (db/search/index.ts). The CHECK proves the length half of the
 * fold's invariant on every row: `+ 4` is the four separators.
 */
export const articleSearch = pgTable(
  "article_search",
  {
    articleId: text("article_id")
      .primaryKey()
      .references(() => articles.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    author: text("author").notNull(),
    tags: text("tags").notNull(), // space-joined
    introduction: text("introduction").notNull(),
    bodyText: text("body_text").notNull(),
    /** DERIVED at import (import/derive.ts buildDocument). The only column the trgm index covers. */
    document: text("document").notNull(),
  },
  (t) => [
    index("article_search_document_trgm").using("gin", t.document.op("gin_trgm_ops")),
    check(
      "article_search_document_aligned",
      sql`length(${t.document}) = length(${t.title}) + length(${t.author}) + length(${t.tags}) + length(${t.introduction}) + length(${t.bodyText}) + 4`,
    ),
  ],
);

/**
 * The knowledge-base search document (FTS5 `kb_search`), flattened by the AI pipeline.
 * `tldr` here is NOT the tldr: it is `"{tldr} {summary}\n{faq}\n{extras}"` (ground-A #17).
 * These columns are matched against and snippeted from, never returned as fields. `+ 9`.
 */
export const kbSearch = pgTable(
  "kb_search",
  {
    articleId: text("article_id")
      .primaryKey()
      .references(() => articles.id, { onDelete: "cascade" }),
    tldr: text("tldr").notNull(),
    problem: text("problem").notNull(),
    approach: text("approach").notNull(),
    components: text("components").notNull(),
    parameters: text("parameters").notNull(),
    decisions: text("decisions").notNull(),
    pitfalls: text("pitfalls").notNull(),
    entities: text("entities").notNull(),
    keywords: text("keywords").notNull(),
    captions: text("captions").notNull(),
    document: text("document").notNull(),
  },
  (t) => [
    index("kb_search_document_trgm").using("gin", t.document.op("gin_trgm_ops")),
    check(
      "kb_search_document_aligned",
      sql`length(${t.document}) = length(${t.tldr}) + length(${t.problem}) + length(${t.approach}) + length(${t.components}) + length(${t.parameters}) + length(${t.decisions}) + length(${t.pitfalls}) + length(${t.entities}) + length(${t.keywords}) + length(${t.captions}) + 9`,
    ),
  ],
);

/**
 * APP-OWNED, append-only import history — the only table apps/bbs writes, written only by
 * `bbs import`, never truncated. The last `ok` row is (a) "imported at" on the Status page and
 * (b) the memory that makes a re-run on the same dump a genuine no-op: equal per-table source
 * digests AND equal render/normalize versions -> no transaction is opened (`noop: true` row).
 */
export const importRuns = pgTable(
  "import_runs",
  {
    id: text("id").primaryKey(), // uuid v7
    startedAt: ms("started_at").notNull(),
    finishedAt: ms("finished_at"),
    /** The `<app.db>` path as given, plus its size — enough to recognise a stale dump. */
    sourcePath: text("source_path").notNull(),
    sourceBytes: integer("source_bytes").notNull(),
    ok: boolean("ok").notNull(),
    noop: boolean("noop").notNull().default(false),
    /** `ImportReport["tables"]`: per table rows + checksum (source columns only) + verified. */
    tables: jsonb("tables").notNull(),
    notes: jsonb("notes").notNull(),
    renderVersion: text("render_version").notNull(),
    normalizeVersion: text("normalize_version").notNull(),
  },
  (t) => [index("import_runs_started_idx").on(t.startedAt.desc())],
);

/**
 * Bot-owned state. These tables survive the deprecated corpus import and deliberately have no
 * foreign keys into imported tables. Stable source keys and frozen article snapshots keep pending
 * delivery work meaningful if a corpus row is replaced.
 */
export const botDeliveries = pgTable(
  "bot_deliveries",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(), // article|digest|reply|update|resources
    logicalKey: text("logical_key").notNull(),
    chatId: text("chat_id").notNull(),
    replyToMessageId: text("reply_to_message_id"),
    msgType: text("msg_type").notNull(),
    content: text("content").notNull(), // exact JSON string sent to Feishu
    payloadHash: text("payload_hash").notNull(),
    uuid: text("uuid").notNull(),
    scheduledAt: ms("scheduled_at").notNull(),
    state: text("state").notNull().default("pending"), // pending|leased|sent|cancelled|permanent
    leaseToken: text("lease_token"),
    leasedUntil: ms("leased_until"),
    nextAttemptAt: ms("next_attempt_at").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    feishuMessageId: text("feishu_message_id"),
    lastError: text("last_error"),
    createdAt: ms("created_at").notNull(),
    updatedAt: ms("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("bot_deliveries_logical_key_uq").on(t.logicalKey),
    uniqueIndex("bot_deliveries_uuid_uq").on(t.uuid),
    index("bot_deliveries_due_idx").on(t.state, t.nextAttemptAt, t.scheduledAt),
    check(
      "bot_deliveries_kind_ck",
      sql`${t.kind} in ('article', 'digest', 'reply', 'update', 'resources')`,
    ),
    check(
      "bot_deliveries_state_ck",
      sql`${t.state} in ('pending', 'leased', 'sent', 'cancelled', 'permanent')`,
    ),
  ],
);

export const botState = pgTable(
  "bot_state",
  {
    id: integer("id").primaryKey().default(1),
    activatedAt: ms("activated_at").notNull(),
    announcementChatId: text("announcement_chat_id").notNull(),
    lastReconciledAt: ms("last_reconciled_at"),
  },
  (t) => [check("bot_state_singleton", sql`${t.id} = 1`)],
);

export const botDays = pgTable(
  "bot_days",
  {
    assignmentDay: date("assignment_day", { mode: "string" }).primaryKey(),
    sealedAt: ms("sealed_at"),
    digestDeliveryId: text("digest_delivery_id").references(() => botDeliveries.id),
    createdAt: ms("created_at").notNull(),
  },
  (t) => [uniqueIndex("bot_days_digest_delivery_uq").on(t.digestDeliveryId)],
);

export const botArticleDecisions = pgTable(
  "bot_article_decisions",
  {
    sourceId: text("source_id").notNull(),
    sourceArticleId: text("source_article_id").notNull(),
    status: text("status").notNull(), // baseline|ineligible_*|immediate|overflow
    decidedAt: ms("decided_at").notNull(),
    assignmentDay: date("assignment_day", { mode: "string" }).references(
      () => botDays.assignmentDay,
    ),
    immediateSlot: integer("immediate_slot"),
    articleId: text("article_id"),
    title: text("title"),
    excerpt: text("excerpt"),
    publishedAt: ms("published_at"),
    articleLink: text("article_link"),
    deliveryId: text("delivery_id").references(() => botDeliveries.id),
    digestDeliveryId: text("digest_delivery_id").references(() => botDeliveries.id),
    digestOrdinal: integer("digest_ordinal"),
  },
  (t) => [
    primaryKey({ columns: [t.sourceId, t.sourceArticleId] }),
    uniqueIndex("bot_decisions_day_slot_uq")
      .on(t.assignmentDay, t.immediateSlot)
      .where(sql`${t.immediateSlot} is not null`),
    uniqueIndex("bot_decisions_delivery_uq").on(t.deliveryId),
    uniqueIndex("bot_decisions_digest_ordinal_uq")
      .on(t.digestDeliveryId, t.digestOrdinal)
      .where(sql`${t.digestDeliveryId} is not null`),
    index("bot_decisions_digest_members_idx").on(t.assignmentDay, t.status, t.digestOrdinal),
    check(
      "bot_decisions_status_ck",
      sql`${t.status} in ('baseline', 'ineligible_null_publication', 'ineligible_pre_activation', 'immediate', 'overflow')`,
    ),
    check(
      "bot_decisions_slot_ck",
      sql`${t.immediateSlot} is null or ${t.immediateSlot} between 1 and 3`,
    ),
  ],
);

export const botDeliveryAttempts = pgTable(
  "bot_delivery_attempts",
  {
    id: text("id").primaryKey(),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => botDeliveries.id, { onDelete: "cascade" }),
    leaseToken: text("lease_token").notNull(),
    attemptNo: integer("attempt_no").notNull(),
    startedAt: ms("started_at").notNull(),
    finishedAt: ms("finished_at"),
    outcome: text("outcome"), // sent|not_sent|ambiguous|permanent
    code: text("code"),
  },
  (t) => [
    uniqueIndex("bot_attempts_delivery_no_uq").on(t.deliveryId, t.attemptNo),
    uniqueIndex("bot_attempts_lease_token_uq").on(t.leaseToken),
    index("bot_attempts_unfinished_idx").on(t.finishedAt, t.startedAt),
    check(
      "bot_attempts_outcome_ck",
      sql`${t.outcome} is null or ${t.outcome} in ('sent', 'not_sent', 'ambiguous', 'permanent')`,
    ),
  ],
);

export const botInboundReceipts = pgTable(
  "bot_inbound_receipts",
  {
    messageId: text("message_id").primaryKey(),
    chatId: text("chat_id").notNull(),
    chatType: text("chat_type").notNull(),
    rawContentType: text("raw_content_type").notNull(),
    content: text("content").notNull(),
    createdAtFeishu: ms("created_at_feishu").notNull(),
    admittedAt: ms("admitted_at").notNull(),
    state: text("state").notNull().default("pending"), // pending|leased|planned|ignored
    leaseToken: text("lease_token"),
    leasedUntil: ms("leased_until"),
    replyDeliveryId: text("reply_delivery_id").references(() => botDeliveries.id),
    lastError: text("last_error"),
  },
  (t) => [
    index("bot_inbound_pending_idx").on(t.state, t.admittedAt),
    uniqueIndex("bot_inbound_reply_delivery_uq").on(t.replyDeliveryId),
    check("bot_inbound_chat_type_ck", sql`${t.chatType} in ('p2p', 'group')`),
    check("bot_inbound_state_ck", sql`${t.state} in ('pending', 'leased', 'planned', 'ignored')`),
  ],
);

/** Every table `bbs import` truncates and reloads, in foreign-key order. Thirteen; `import_runs` is deliberately absent. */
export const IMPORTED_TABLES = [
  "sources",
  "articles",
  "article_tags",
  "article_links",
  "article_images",
  "poll_runs",
  "source_guard_state",
  "article_ai",
  "kb_entities",
  "article_entities",
  "ai_usage",
  "article_search",
  "kb_search",
] as const;
