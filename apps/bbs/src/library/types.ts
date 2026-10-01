/**
 * The domain vocabulary of the archive. These types are what the REST API and
 * the MCP tools both receive; neither ever sees a Drizzle row, a jsonb blob or
 * a SQL fragment. Dates are `Date` — the two transports disagree about how to
 * render one (HTTP: ISO 8601; MCP: `YYYY-MM-DD` in Asia/Shanghai) and the
 * disagreement belongs in their presenters (api/dto.ts, mcp/present.ts).
 *
 * Brands are not ceremony here: `/kb/:name` accepts a display name or a key and
 * rm-wenku normalised in three places; `EntityKey` can only be made by
 * `entityKey()`, so a raw name cannot reach a `WHERE key = …`. `Cursor` can
 * only be made by library/cursor.ts.
 *
 * Validation lives at the boundaries (api/schemas.ts, mcp/server.ts zod,
 * import/ for data); inside `library/` these are trusted.
 */

export type ArticleId = string & { readonly __brand: "ArticleId" };
export type EntityKey = string & { readonly __brand: "EntityKey" };
/** Opaque to every caller. Encoded/decoded only by library/cursor.ts. */
export type Cursor = string & { readonly __brand: "Cursor" };

/** ULID shape check: 26 Crockford base32 characters. null otherwise. */
export function articleId(raw: string): ArticleId | null {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(raw) ? (raw.toUpperCase() as ArticleId) : null;
}

/** rm-wenku's `entity_key()`: keep `\p{L}\p{N}`, lower-case. Total, never fails. */
export function entityKey(nameOrKey: string): EntityKey {
  return nameOrKey.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase() as EntityKey;
}

/** Thrown for caller mistakes the boundary could not see. The API renders 400. */
export class QueryError extends Error {
  readonly code: "invalid_cursor" | "empty_query";
  constructor(code: "invalid_cursor" | "empty_query", message: string) {
    super(message);
    this.name = "QueryError";
    this.code = code;
  }
}

// ── paging ──────────────────────────────────────────────────────────────────

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: Cursor | null;
}

export type SearchScope = "all" | "title" | "kb";

export interface ArticleListQuery {
  /** Filters the DATE-ordered feed (the SPA's search box). `search()` is the ranked one. */
  readonly q?: string;
  /** Meaning of `q`; default "all". Ignored without `q`. */
  readonly scope?: SearchScope;
  /** Exact `group/name`. */
  readonly tag?: string;
  /** Matches `article_tags.group_name`. */
  readonly group?: string;
  readonly cursor?: Cursor;
  /** Already clamped by the boundary (API 1..100 default 20; MCP 1..50). */
  readonly limit: number;
}

export interface SearchQuery extends ArticleListQuery {
  readonly q: string;
}

// ── articles ────────────────────────────────────────────────────────────────

/** The season/team/labels/topic split migration 0006 backfilled; `topic` is always present. */
export interface TitleParts {
  readonly season: string | null;
  readonly team: string | null;
  readonly labels: readonly string[];
  readonly topic: string;
}

/** The list/search row. Always a `status='fetched'` article; `refreshRequestedAt` is gone with the crawler. */
export interface ArticleSummary {
  readonly id: ArticleId;
  readonly sourceArticleId: string;
  /** The forum permalink. */
  readonly url: string;
  readonly title: string;
  readonly titleParts: TitleParts;
  readonly author: string | null;
  readonly publishedAt: Date | null;
  readonly discoveredAt: Date;
  readonly fetchedAt: Date | null;
  readonly isPinned: boolean;
  /** `group/name`, in the source's listing order. */
  readonly tags: readonly string[];
  readonly introduction: string | null;
  /** `introduction`, else the first 200 chars of the whitespace-collapsed body. */
  readonly excerpt: string | null;
  readonly bodyChars: number;
  readonly linkCount: number;
  readonly imageCount: number;
  /** `overview_json ->> 'tldr'` of a ready AI row, in the same SELECT — on the LIST, so MCP `list_articles` has no N+1. */
  readonly tldr: string | null;
}

export type LinkKind = "repository" | "document" | "download" | "video" | "cloud_drive" | "other";

export interface ArticleLink {
  readonly url: string;
  readonly kind: LinkKind;
  /** The crawler's label, else the in-library target's title, else null. */
  readonly label: string | null;
  /** Set when the link resolves to a FETCHED article in this library; the SPA routes it internally. */
  readonly articleId: ArticleId | null;
  readonly position: number;
}

export interface ArticleImage {
  /** Hot-linked forum CDN URL; rendered with `referrerpolicy=no-referrer`. */
  readonly url: string;
  /** `NULLIF(alt, '')` else the AI caption — the consumer cannot tell them apart, as before (ground-A #4). */
  readonly alt: string | null;
  readonly position: number;
}

export interface Article extends ArticleSummary {
  readonly contentFormat: "html" | "markdown" | null;
  /** Sanitised at import (content/render.ts); safe to inject as-is. Null for `skipped` rows. */
  readonly contentHtml: string | null;
  readonly bodyText: string | null;
  readonly links: readonly ArticleLink[];
  readonly images: readonly ArticleImage[];
}

export type ContentFormat = "text" | "markdown" | "html";

export interface ArticleContent {
  /** What was actually produced — asking for `markdown` on an HTML source yields `text`. */
  readonly format: ContentFormat;
  readonly body: string;
}

/** One run of snippet text; `hit` runs are the matched terms, cut from the RAW field (original case and width). */
export interface SnippetSegment {
  readonly text: string;
  readonly hit: boolean;
}

export interface SearchHit extends ArticleSummary {
  /** Engine-specific, higher is better; comparable only within one response. */
  readonly score: number;
  /**
   * Segments rather than a `[term]`-marked string: forum prose contains literal `[1]`
   * reference markers, so brackets cannot be parsed back out. `…` at cuts is a plain
   * non-hit segment. Null when no term occurs in snippet material.
   */
  readonly snippet: readonly SnippetSegment[] | null;
}

export interface SearchPage extends Page<SearchHit> {
  /** Terms actually searched, after folding and de-duplication. */
  readonly terms: readonly string[];
}

// ── AI artefacts (rm-wenku's Overview / KbEntry / ImageCaption, parsed leniently) ──

export interface Overview {
  readonly genre: string;
  readonly tldr: string;
  readonly summary: string;
  readonly keyPoints: readonly string[];
  readonly appliesWhen: string | null;
  readonly package: readonly string[];
  readonly maturity: { readonly status: string; readonly evidence: string | null };
  readonly caveats: readonly string[];
  readonly readingGuide: string | null;
  readonly extras: {
    readonly quickStart: readonly string[];
    readonly portingChecklist: readonly string[];
    readonly compat: readonly string[];
    readonly lessons: readonly {
      readonly constraint: string;
      readonly decision: string;
      readonly outcome: string | null;
      readonly transferable: string | null;
    }[];
    readonly thesis: string | null;
    readonly arguments: readonly { readonly claim: string; readonly evidence: string | null }[];
    readonly actions: readonly string[];
  };
  readonly faq: readonly {
    readonly question: string;
    readonly answer: string;
    readonly source: string | null;
  }[];
}

export interface KbEntry {
  readonly domain: readonly string[];
  readonly robotTypes: readonly string[];
  readonly problem: string | null;
  readonly approach: string | null;
  readonly components: readonly {
    readonly name: string;
    readonly kind: string | null;
    readonly spec: string | null;
    readonly role: string | null;
    readonly source: string | null;
  }[];
  readonly parameters: readonly {
    readonly name: string;
    readonly value: string;
    readonly unit: string | null;
    readonly context: string | null;
    readonly source: string | null;
  }[];
  readonly interfaces: readonly string[];
  readonly toolchain: readonly string[];
  readonly designDecisions: readonly {
    readonly decision: string;
    readonly alternatives: string | null;
    readonly rationale: string | null;
    readonly source: string | null;
  }[];
  readonly pitfalls: readonly string[];
  readonly cost: string | null;
  readonly references: readonly {
    readonly title: string;
    readonly url: string | null;
    readonly relation: string | null;
  }[];
  readonly entities: readonly string[];
  readonly claims: readonly {
    readonly claim: string;
    readonly evidence: string | null;
    readonly source: string | null;
  }[];
  readonly openQuestions: readonly string[];
  readonly searchKeywords: readonly string[];
}

export interface ImageCaption {
  readonly index: number;
  readonly kind: string | null;
  readonly caption: string;
  readonly textInImage: string | null;
  readonly facts: readonly string[];
}

/** One object for what rm-wenku served as /ai/overview and /ai/kb. No AI row -> status "pending". */
export interface ArticleAi {
  readonly articleId: ArticleId;
  readonly status: "pending" | "ready" | "failed";
  readonly overview: Overview | null;
  readonly kb: KbEntry | null;
  readonly images: readonly ImageCaption[];
  readonly model: string | null;
  readonly generatedAt: Date | null;
  readonly error: string | null;
}

// ── tags ────────────────────────────────────────────────────────────────────

export interface TagCount {
  readonly name: string;
  readonly count: number;
}

export interface TagIndex {
  /** Every `group/name` with its article count, most used first. */
  readonly items: readonly TagCount[];
  /** Groups with COUNT(DISTINCT article): a group's count is NOT the sum of its tags' (rm-wenku shipped this; the SPA relies on it). */
  readonly groups: readonly TagCount[];
  /** Fetched articles. */
  readonly total: number;
}

// ── knowledge base ──────────────────────────────────────────────────────────

export interface KbFilter {
  /** Substring search over kb_search, pushed into SQL (MCP `search_kb` no longer intersects two result sets). */
  readonly q?: string;
  readonly domain?: string;
  readonly robot?: string;
  readonly genre?: string;
  /** 1..1000, default 200. */
  readonly limit: number;
}

export interface KbCard {
  readonly articleId: ArticleId;
  readonly title: string;
  readonly author: string | null;
  readonly publishedAt: Date | null;
  readonly tldr: string;
  readonly genre: string;
  readonly maturity: string;
  readonly problem: string | null;
  readonly domain: readonly string[];
  readonly robotTypes: readonly string[];
  readonly entities: readonly string[];
  readonly pitfalls: readonly string[];
}

/** Invariant: each facet axis is counted under the OTHER filters (and `q`), never its own, so a chip never disables itself. */
export interface KbBrowse {
  readonly total: number;
  readonly domains: readonly TagCount[];
  readonly robotTypes: readonly TagCount[];
  readonly genres: readonly TagCount[];
  readonly cards: readonly KbCard[];
}

export interface EntityCount {
  readonly key: EntityKey;
  readonly name: string;
  readonly articleCount: number;
}

export interface EntityArticle {
  readonly articleId: ArticleId;
  readonly title: string;
  readonly author: string | null;
  readonly publishedAt: Date | null;
  readonly tldr: string;
  readonly kb: KbEntry;
}

export interface EntityDetail {
  readonly entity: EntityCount;
  /** Newest first by COALESCE(published_at, discovered_at). */
  readonly articles: readonly EntityArticle[];
}

// ── status / head ───────────────────────────────────────────────────────────

/** What `/api/status`, the Status page and MCP `library_status` all read. Static between imports. */
export interface LibraryStatus {
  readonly site: { readonly name: string; readonly url: string };
  readonly articles: {
    readonly total: number;
    readonly fetched: number;
    readonly skipped: number;
    readonly tags: number;
    readonly images: number;
    readonly links: number;
  };
  readonly ai: {
    readonly ready: number;
    /** Fetched articles with no article_ai row. */
    readonly missing: number;
    readonly entities: number;
  };
  /** The newest `poll_runs` row (this box's crawler since the 2026-08-28 cutover). */
  readonly crawler: {
    readonly lastCheckedAt: Date | null;
    /** Seconds since `lastCheckedAt` at response time; null when the crawler has never run. */
    readonly lastCheckedAgeSeconds: number | null;
    readonly backfillCompletedAt: Date | null;
  };
  readonly bot: {
    readonly lastReconciledAt: Date | null;
    readonly lastReconciledAgeSeconds: number | null;
  };
  /** From `import_runs`: when this corpus arrived. Replaces rm-wenku's live SSE console. */
  readonly importedAt: Date | null;
}

/** What spa/head.ts injects for /articles/:id and /kb/:name. Two columns, no children. */
export interface HeadMeta {
  readonly title: string;
  readonly description: string;
  /** App-relative path; spa/head.ts prefixes the app origin for `og:url` / canonical. */
  readonly path: string;
  readonly type: "article" | "website";
  readonly image: string | null;
  readonly publishedAt: Date | null;
  readonly author: string | null;
}

/** The signed-in caller, as `/api/viewer`, `/api/me` and the account page see them. */
export interface Viewer {
  readonly id: string;
  readonly role: "admin" | "member";
  readonly displayName: string;
  readonly avatarUrl: string | null;
}
