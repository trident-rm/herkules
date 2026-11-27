/**
 * THE QUERY LAYER. One module; the REST API (src/api) and the MCP tools
 * (src/mcp) are two presentations of it and hold no SQL of their own.
 *
 * Everything the archive can be asked is twelve methods, each a COMPLETE
 * answer — the caller never composes two calls to get one screen, which is the
 * difference from rm-wenku's `ArticleQuery` (its `/kb/entities/{name}` ran a
 * five-query article fetch per result; its MCP `list_articles` fetched tldrs one
 * row at a time). Query counts per method are part of the contract.
 *
 * Hidden here: keyset cursors, term parsing, bm25-shaped ranking, snippets,
 * jsonb facet cross-filtering, the `status='fetched'` rule that keeps
 * unpublished rows out of every public answer, and which search engine is
 * installed. Exposed: domain query objects in, domain results out. No Drizzle
 * type and no `SQL` value crosses this boundary in either direction.
 *
 * Deliberately not here: writes (v1 has none), auth (callers are verified
 * before they get here; every method is anonymous-safe), caching (the corpus
 * changes only on import), identity (`/api/me` is the oauth-client's and the
 * user-info API's, not the archive's).
 *
 * Module map (src/library):
 *   index.ts    this file — `Library` + createLibrary. The public surface.
 *   types.ts    domain vocabulary.       cursor.ts   opaque keyset codec.
 *   ai-json.ts  lenient AI JSON parse.   articles.ts feed / detail / content / ai / head.
 *   search.ts   the ranked page.         tags.ts / kb.ts / status.ts.
 * Trace for `/api/articles?q=`: api/routes.ts -> articles.ts -> db/search/trgm.ts. Three files.
 */
import type { SearchIndex } from "../db/search/index.ts";
import type { BbsDb } from "../db/index.ts";
import { getArticle, getArticleAi, getContent, getHead, listArticles } from "./articles.ts";
import { getEntity, getEntityHead, kbBrowse, listEntities } from "./kb.ts";
import { getResourceCatalog, getResourcePage } from "./resources.ts";
import type { ResourceCatalog, ResourcePage } from "./resources.ts";
import { search } from "./search.ts";
import { getStatus } from "./status.ts";
import { getTags } from "./tags.ts";
import type {
  Article,
  ArticleAi,
  ArticleContent,
  ArticleId,
  ArticleListQuery,
  ArticleSummary,
  ContentFormat,
  EntityCount,
  EntityDetail,
  EntityKey,
  HeadMeta,
  KbBrowse,
  KbFilter,
  LibraryStatus,
  Page,
  SearchPage,
  SearchQuery,
  TagIndex,
} from "./types.ts";

export * from "./types.ts";

export interface LibraryDeps {
  readonly db: BbsDb;
  /** `trgm` in v1; `pgroonga` after a check-5 failure. Nothing else in the app knows which. */
  readonly search: SearchIndex;
}

export interface Library {
  /** The feed: fetched, newest first, filtered by tag/group, optionally narrowed by `q` (filters, never reorders). 1 query. */
  articles(query: ArticleListQuery): Promise<Page<ArticleSummary>>;
  /** Everything the reader page needs, HTML included; null for a missing or non-fetched id. 1 query (rm-wenku: 6 + a render). */
  article(id: ArticleId): Promise<Article | null>;
  /** The raw body in one of three renderings; `markdown` on an HTML source yields `text`. 1 query. */
  content(id: ArticleId, format: ContentFormat): Promise<ArticleContent | null>;
  /** Overview + KB entry + captions in one object; `status: "pending"` when there is no AI row; null when the article is missing. 1 query. */
  ai(id: ArticleId): Promise<ArticleAi | null>;
  /** Two columns for head injection; null when missing/not fetched. 1 query. */
  head(id: ArticleId): Promise<HeadMeta | null>;
  /** Tag counts, group counts and the fetched total. 1 query (rm-wenku: 4). */
  tags(): Promise<TagIndex>;
  /** Ranked search with snippets. `q` must be non-blank (QueryError otherwise). 2 queries: corpus stats, then the page. */
  search(query: SearchQuery): Promise<SearchPage>;
  /** Cards plus the three cross-filtered facet axes. 2 queries (rm-wenku: 5). */
  kbBrowse(filter: KbFilter): Promise<KbBrowse>;
  /** Entities with at least one article, optionally filtered by a name substring. 1 query. */
  entities(options: {
    readonly q?: string;
    readonly limit: number;
  }): Promise<readonly EntityCount[]>;
  /** The entity and every fetched article that mentions it, feed-ordered. 1 query (rm-wenku: N+1). */
  entity(key: EntityKey): Promise<EntityDetail | null>;
  /** Head injection for /kb/:name; null when unknown or orphaned. 1 query. */
  entityHead(key: EntityKey): Promise<HeadMeta | null>;
  /** Counts for the Status page and MCP `library_status`. 1 query. */
  status(): Promise<LibraryStatus>;
  resourceCatalog(): Promise<ResourceCatalog>;
  resourcePage(id: string): Promise<ResourcePage | null>;
}

export function createLibrary(deps: LibraryDeps): Library {
  return {
    articles: (query) => listArticles(deps, query),
    article: (id) => getArticle(deps, id),
    content: (id, format) => getContent(deps, id, format),
    ai: (id) => getArticleAi(deps, id),
    head: (id) => getHead(deps, id),
    tags: () => getTags(deps),
    search: (query) => search(deps, query),
    kbBrowse: (filter) => kbBrowse(deps, filter),
    entities: (options) => listEntities(deps, options),
    entity: (key) => getEntity(deps, key),
    entityHead: (key) => getEntityHead(deps, key),
    status: () => getStatus(deps),
    resourceCatalog: () => getResourceCatalog(deps.db),
    resourcePage: (id) => getResourcePage(deps.db, id),
  };
}
