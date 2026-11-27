/**
 * THE query-key factory. Keys are `["bbs", kind, ...args]`; nobody else writes a
 * queryKey. Cache policy lives with the key, and `q` travels in the router
 * context (no module singleton) so loaders, screens and the contract test all
 * go through one instance built from one `BbsApi`.
 */
import { infiniteQueryOptions, keepPreviousData, queryOptions } from "@tanstack/react-query";

import type { FeedSearch, KbSearch, RankedSearch } from "../url.ts";
import type { BbsApi } from "./client.ts";

const MIN = 60_000;

export function createQueries(api: BbsApi) {
  return {
    resourceCatalog: () =>
      queryOptions({
        queryKey: ["bbs", "resource-catalog"] as const,
        queryFn: () => api.resourceCatalog(),
        staleTime: 10 * MIN,
      }),
    resourcePage: (id: string) =>
      queryOptions({
        queryKey: ["bbs", "resource-page", id] as const,
        queryFn: () => api.resourcePage(id),
        staleTime: 10 * MIN,
      }),
    feed: (s: FeedSearch) =>
      infiniteQueryOptions({
        queryKey: ["bbs", "feed", s] as const,
        queryFn: ({ pageParam }) => api.articles({ ...s, cursor: pageParam }),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        placeholderData: keepPreviousData, // a tab click re-renders over the previous rows, never an empty page
        staleTime: 10 * MIN,
        gcTime: 15 * MIN, // returning from an article must not collapse the list
      }),
    search: (s: RankedSearch & { q: string }) =>
      infiniteQueryOptions({
        queryKey: ["bbs", "search", s] as const,
        queryFn: ({ pageParam }) => api.search({ ...s, cursor: pageParam }),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        placeholderData: keepPreviousData,
        staleTime: 10 * MIN,
      }),
    article: (id: string) =>
      queryOptions({
        queryKey: ["bbs", "article", id] as const,
        queryFn: () => api.article(id),
        staleTime: 30 * MIN,
      }),
    ai: (id: string) =>
      queryOptions({
        queryKey: ["bbs", "ai", id] as const,
        queryFn: () => api.ai(id),
        staleTime: 30 * MIN,
      }),
    tags: () =>
      queryOptions({
        queryKey: ["bbs", "tags"] as const,
        queryFn: () => api.tags(),
        staleTime: 5 * MIN,
      }),
    kbBrowse: (s: KbSearch) =>
      queryOptions({
        queryKey: ["bbs", "kb", s] as const,
        queryFn: () => api.kbBrowse({ ...s, limit: "300" }),
        placeholderData: keepPreviousData, // 300 cards per facet click; never flash empty
        staleTime: 5 * MIN,
      }),
    entity: (name: string) =>
      queryOptions({
        queryKey: ["bbs", "entity", name] as const,
        queryFn: () => api.entity(name),
        staleTime: 5 * MIN,
      }),
    status: () =>
      queryOptions({
        queryKey: ["bbs", "status"] as const,
        queryFn: () => api.status(),
        staleTime: Infinity,
      }),
    viewer: () =>
      queryOptions({
        queryKey: ["bbs", "viewer"] as const,
        queryFn: () => api.viewer(),
        staleTime: 30_000,
        refetchOnWindowFocus: true, // a sign-in in another tab shows up
      }),
  };
}
export type Queries = ReturnType<typeof createQueries>;
