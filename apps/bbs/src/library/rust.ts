/** Incremental read delegation. The caller still owns OAuth, refresh requests and errors.
 * All corpus read methods move; identity and transports stay with the caller.
 * No browser credentials are forwarded to this anonymous corpus service.
 */
import type {
  ArticleDTO,
  ArticleAiDTO,
  ArticlePageDTO,
  ArticleSummaryDTO,
  SearchPageDTO,
  KbBrowseDTO,
  EntityDetailDTO,
  LibraryStatusDTO,
} from "../api/dto.ts";
import { QueryError } from "./types.ts";
import type { Library } from "./index.ts";
import type {
  Article,
  ArticleId,
  ArticleLink,
  ArticleSummary,
  Cursor,
  ContentFormat,
  TagIndex,
  HeadMeta,
  EntityCount,
  EntityKey,
} from "./types.ts";

export function withRustReads(
  local: Library,
  options: { readonly origin: string; readonly fetch?: typeof fetch },
): Library {
  const fetcher = options.fetch ?? fetch;
  const request = async (path: string): Promise<Response | null> => {
    const response = await fetcher(`${options.origin}${path}`, {
      signal: AbortSignal.timeout(6_000),
      redirect: "error",
      headers: { accept: path.includes("/content?") ? "*/*" : "application/json" },
    });
    if (response.status === 400) {
      const body: unknown = await response.json();
      if (
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        (body.error === "invalid_cursor" || body.error === "empty_query")
      ) {
        throw new QueryError(
          body.error,
          body.error === "empty_query" ? "search needs at least one term" : "unusable cursor",
        );
      }
      throw new Error("BBS Rust read failed (400)");
    }
    if (response.status === 404) {
      const body: unknown = await response.json();
      if (
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        body.error === "not_found" &&
        "error_description" in body &&
        body.error_description === "no such row"
      )
        return null;
    }
    if (!response.ok) throw new Error(`BBS Rust read failed (${response.status})`);
    return response;
  };
  return {
    ...local,
    articles: async (query) => {
      const response = await request(`/api/articles?${queryParams(query)}`);
      if (!response) throw new Error("BBS Rust feed route is unavailable");
      const page = (await response.json()) as ArticlePageDTO;
      return {
        items: page.items.map(summaryFromWire),
        nextCursor: page.nextCursor as Cursor | null,
      };
    },
    search: async (query) => {
      const response = await request(`/api/search?${queryParams(query)}`);
      if (!response) throw new Error("BBS Rust search route is unavailable");
      const page = (await response.json()) as SearchPageDTO;
      return {
        items: page.items.map((hit) => ({ ...hit, ...summaryFromWire(hit) })),
        nextCursor: page.nextCursor as Cursor | null,
        terms: page.terms,
      };
    },
    kbBrowse: async (query) => {
      const response = await request(`/api/kb/browse?${queryParams(query)}`);
      if (!response) throw new Error("BBS Rust KB route is unavailable");
      const page = (await response.json()) as KbBrowseDTO;
      return {
        ...page,
        cards: page.cards.map((card) => ({
          ...card,
          articleId: card.articleId as ArticleId,
          publishedAt: date(card.publishedAt),
        })),
      };
    },
    entities: async (query) => {
      const response = await request(`/api/kb/entities?${queryParams(query)}`);
      if (!response) throw new Error("BBS Rust entities route is unavailable");
      const page = (await response.json()) as { items: EntityCount[] };
      return page.items;
    },
    entity: async (key) => {
      const response = await request(`/api/kb/entities/key?${queryParams({ key })}`);
      if (!response) return null;
      const detail = (await response.json()) as EntityDetailDTO;
      return {
        entity: { ...detail.entity, key: detail.entity.key as EntityKey },
        articles: detail.articles.map((article) => ({
          ...article,
          articleId: article.articleId as ArticleId,
          publishedAt: date(article.publishedAt),
        })),
      };
    },
    head: async (id) => {
      const response = await request(`/api/articles/${encodeURIComponent(id)}/head`);
      if (!response) return null;
      const head = (await response.json()) as Omit<HeadMeta, "publishedAt"> & {
        publishedAt: string | null;
      };
      return { ...head, publishedAt: date(head.publishedAt) };
    },
    entityHead: async (key) => {
      const response = await request(`/api/kb/entities/key/head?${queryParams({ key })}`);
      if (!response) return null;
      const head = (await response.json()) as Omit<HeadMeta, "publishedAt"> & {
        publishedAt: string | null;
      };
      return { ...head, publishedAt: date(head.publishedAt) };
    },
    status: async () => {
      const response = await request("/api/status");
      if (!response) throw new Error("BBS Rust status route is unavailable");
      const status = (await response.json()) as LibraryStatusDTO;
      return {
        ...status,
        bot: { ...status.bot, lastReconciledAt: date(status.bot.lastReconciledAt) },
        importedAt: date(status.importedAt),
        crawler: {
          ...status.crawler,
          lastCheckedAt: date(status.crawler.lastCheckedAt),
          backfillCompletedAt: date(status.crawler.backfillCompletedAt),
        },
      };
    },
    article: async (id) => {
      const response = await request(`/api/articles/${encodeURIComponent(id)}`);
      if (!response) return null;
      const article = (await response.json()) as ArticleDTO;
      return articleFromWire(article);
    },
    content: async (id, format) => {
      const response = await request(
        `/api/articles/${encodeURIComponent(id)}/content?format=${format}`,
      );
      if (!response) return null;
      const actual = response.headers.get("x-content-format");
      if (actual !== "text" && actual !== "markdown" && actual !== "html") {
        throw new Error("BBS Rust content response is missing its format");
      }
      return { format: actual satisfies ContentFormat, body: await response.text() };
    },
    ai: async (id) => {
      const response = await request(`/api/articles/${encodeURIComponent(id)}/ai`);
      if (!response) return null;
      const ai = (await response.json()) as ArticleAiDTO;
      return { ...ai, articleId: ai.articleId as ArticleId, generatedAt: date(ai.generatedAt) };
    },
    tags: async () => {
      const response = await request("/api/tags");
      if (!response) throw new Error("BBS Rust tags route is unavailable");
      return (await response.json()) as TagIndex;
    },
  };
}

function date(raw: string | null): Date | null {
  if (raw === null) return null;
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) throw new Error("BBS Rust response contains an invalid date");
  return value;
}

function summaryFromWire(article: ArticleSummaryDTO): ArticleSummary {
  return {
    ...article,
    id: article.id as ArticleId,
    publishedAt: date(article.publishedAt),
    discoveredAt: date(article.discoveredAt)!,
    fetchedAt: date(article.fetchedAt),
  };
}

function articleFromWire(article: ArticleDTO): Article {
  return {
    ...article,
    ...summaryFromWire(article),
    links: article.links.map((link): ArticleLink => ({
      ...link,
      articleId: link.articleId as ArticleId | null,
    })),
  };
}

function queryParams(query: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}
