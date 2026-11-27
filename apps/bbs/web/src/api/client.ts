/**
 * The typed adapter over `hc<AppType>`. It owns the two policies rm-wenku spread
 * across eight screens: the `{ error, error_description }` envelope becomes an
 * `ApiError`, and a 404 becomes `null` on routes where a missing id is data.
 * `fetch` is injectable so the contract test drives the real Hono app.
 */
import type { InferRequestType } from "hono/client";
import { hc } from "hono/client";

import type {
  ArticleAiDTO,
  ArticleDTO,
  ArticlePageDTO,
  EntityDetailDTO,
  ErrorDTO,
  KbBrowseDTO,
  LibraryStatusDTO,
  SearchPageDTO,
  TagIndexDTO,
  ViewerDTO,
} from "../../../src/api/dto.ts";
import type { AppType } from "../../../src/api/routes.ts"; // type-only: the whole contract
import type { ResourceCatalog, ResourcePage } from "../../../src/library/resources.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  // Fields are assigned rather than declared as constructor parameters: the
  // package compiles with `erasableSyntaxOnly`, which forbids parameter properties.
  constructor(status: number, code: string, description: string) {
    super(description);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

type Client = ReturnType<typeof hc<AppType>>;
/** Real input types: round 1's `zValidator("query", …)` is what makes `hc` see them (a typo'd key is a compile error). */
export type FeedQuery = InferRequestType<Client["api"]["articles"]["$get"]>["query"];
export type SearchQuery = InferRequestType<Client["api"]["search"]["$get"]>["query"];
export type KbBrowseQuery = InferRequestType<Client["api"]["kb"]["browse"]["$get"]>["query"];

/**
 * One method per route the SPA uses (`/api/kb/entities` has no SPA consumer; `/api/me` is not
 * called — `viewer` answers the same question without a 401).
 */
export interface BbsApi {
  articles(query: FeedQuery): Promise<ArticlePageDTO>;
  search(query: SearchQuery): Promise<SearchPageDTO>;
  article(id: string): Promise<ArticleDTO | null>;
  ai(id: string): Promise<ArticleAiDTO | null>;
  tags(): Promise<TagIndexDTO>;
  kbBrowse(query: KbBrowseQuery): Promise<KbBrowseDTO>;
  entity(name: string): Promise<EntityDetailDTO | null>;
  status(): Promise<LibraryStatusDTO>;
  resourceCatalog(): Promise<ResourceCatalog>;
  resourcePage(id: string): Promise<ResourcePage | null>;
  /** `{ viewer: null }` for nobody — never a 401. */
  viewer(): Promise<{ viewer: ViewerDTO | null }>;
}

export interface ApiOptions {
  readonly origin: string;
  /** Injectable so the contract test drives the in-process Hono app (`fetchVia(app)`). */
  readonly fetch?: typeof globalThis.fetch;
}

/** The response bodies are trusted as `Wire<T>` (one repo compiles both ends); only the error envelope is parsed. */
async function fail(res: Response): Promise<never> {
  const body = (await res.json().catch(() => null)) as Partial<ErrorDTO> | null;
  throw new ApiError(
    res.status,
    body?.error ?? "http_error",
    body?.error_description ?? `${res.status} ${res.statusText}`,
  );
}

async function ok<T>(res: Response): Promise<T> {
  return res.ok ? ((await res.json()) as T) : fail(res);
}

/** Use for routes whose missing rows are valid results. */
async function okOrNull<T>(res: Response): Promise<T | null> {
  if (res.ok) return (await res.json()) as T;
  return res.status === 404 ? null : fail(res);
}

export function createApi(options: ApiOptions): BbsApi {
  const client = hc<AppType>(options.origin, {
    fetch: options.fetch,
    init: { credentials: "same-origin" }, // the session cookie is what /api/viewer reads
  });
  return {
    articles: async (query) => ok<ArticlePageDTO>(await client.api.articles.$get({ query })),
    search: async (query) => ok<SearchPageDTO>(await client.api.search.$get({ query })),
    article: async (id) =>
      okOrNull<ArticleDTO>(await client.api.articles[":id"].$get({ param: { id } })),
    ai: async (id) =>
      okOrNull<ArticleAiDTO>(await client.api.articles[":id"].ai.$get({ param: { id } })),
    tags: async () => ok<TagIndexDTO>(await client.api.tags.$get()),
    kbBrowse: async (query) => ok<KbBrowseDTO>(await client.api.kb.browse.$get({ query })),
    entity: async (name) =>
      okOrNull<EntityDetailDTO>(await client.api.kb.entities[":name"].$get({ param: { name } })),
    status: async () => ok<LibraryStatusDTO>(await client.api.status.$get()),
    resourceCatalog: async () => ok<ResourceCatalog>(await client.api.resources.$get()),
    resourcePage: async (id) =>
      okOrNull<ResourcePage>(await client.api.resources[":id"].$get({ param: { id } })),
    viewer: async () => ok<{ viewer: ViewerDTO | null }>(await client.api.viewer.$get()),
  };
}
export type { ErrorDTO };
