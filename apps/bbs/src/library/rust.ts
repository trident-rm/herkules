/** Incremental read delegation. The caller still owns OAuth, refresh requests and errors.
 * Only these four methods move; other reads keep their existing implementation.
 * No browser credentials are forwarded to this anonymous corpus service.
 */
import type { ArticleDTO, ArticleAiDTO } from "../api/dto.ts";
import type { Library } from "./index.ts";
import type { Article, ArticleId, ArticleLink, ContentFormat, TagIndex } from "./types.ts";

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

function articleFromWire(article: ArticleDTO): Article {
  return {
    ...article,
    id: article.id as ArticleId,
    publishedAt: date(article.publishedAt),
    discoveredAt: date(article.discoveredAt)!,
    fetchedAt: date(article.fetchedAt),
    links: article.links.map((link): ArticleLink => ({
      ...link,
      articleId: link.articleId as ArticleId | null,
    })),
  };
}
