/**
 * The URL contract and the data dependency of every screen, in one file — the
 * browser-side `app.ts`. Read this to answer "what does URL X load".
 */
import type { QueryClient } from "@tanstack/react-query";
import type { SearchMiddleware } from "@tanstack/react-router";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";

import { AboutPage } from "./about/AboutPage.tsx";
import { AccountPage } from "./account/AccountPage.tsx";
import type { Queries } from "./api/queries.ts";
import { FeedPage } from "./feed/FeedPage.tsx";
import { EntityPage } from "./kb/EntityPage.tsx";
import { KbPage } from "./kb/KbPage.tsx";
import { ArticlePage } from "./reader/ArticlePage.tsx";
import { ResourceDirectory, ResourceReader } from "./resources/ResourcePages.tsx";
import { SearchPage } from "./search/SearchPage.tsx";
import { App } from "./shell/App.tsx";
import { NotFound } from "./shell/NotFound.tsx";
import { RouteError } from "./shell/RouteError.tsx";
import { FeedSkeleton, ReaderSkeleton } from "./shell/Skeletons.tsx";
import { StatusPage } from "./status/StatusPage.tsx";
import { TagsPage } from "./tags/TagsPage.tsx";
import type { FeedSearch } from "./url.ts";
import { accountSearch, feedSearch, kbSearch, rankedSearch, stripDerived } from "./url.ts";

/** Hrefs never show the default scope or the derived group (url.ts `stripDerived`). */
const canonical = {
  middlewares: [
    ({ search, next }: { search: FeedSearch; next: (s: FeedSearch) => FeedSearch }) =>
      stripDerived(next(search)),
  ] satisfies SearchMiddleware<FeedSearch>[],
};

/** What every loader and screen can reach without importing a singleton. */
export interface RouterContext {
  readonly queryClient: QueryClient;
  readonly q: Queries;
}

/** The shell. `errorComponent` is deliberately NOT here: a screen's failure must not replace the header. */
export const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: App,
  // Wrapped: `NotFound`'s props are all optional, and TypeScript's weak-type check
  // rejects such a component where the router passes `NotFoundRouteProps`.
  notFoundComponent: () => <NotFound />,
});

const parent = () => rootRoute;
/** Every child route carries the same per-route error boundary; `screen()` as a generic helper erased the path types. */
const errorComponent = RouteError;

export const feedRoute = createRoute({
  getParentRoute: parent,
  errorComponent,
  path: "/",
  validateSearch: feedSearch,
  search: canonical,
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient, q }, deps }) =>
    Promise.all([
      queryClient.ensureQueryData(q.tags()),
      queryClient.ensureInfiniteQueryData(q.feed(deps)),
    ]),
  pendingComponent: FeedSkeleton,
  component: FeedPage,
});

export const searchRoute = createRoute({
  getParentRoute: parent,
  errorComponent,
  path: "/search",
  validateSearch: rankedSearch,
  search: canonical,
  /** A bare or blank search is the feed with the same filters, not an error page. */
  beforeLoad: ({ search }) => {
    if (!search.q) throw redirect({ to: "/", search: { ...search, q: undefined } });
  },
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient, q }, deps }) =>
    queryClient.ensureInfiniteQueryData(q.search({ ...deps, q: deps.q ?? "" })), // q is non-blank past beforeLoad
  pendingComponent: FeedSkeleton,
  component: SearchPage,
});

export const articleRoute = createRoute({
  getParentRoute: parent,
  errorComponent,
  path: "/articles/$id",
  loader: ({ context: { queryClient, q }, params, cause }) => {
    if (cause !== "preload") void queryClient.prefetchQuery(q.ai(params.id)); // hover must not fan out AI reads
    return queryClient.ensureQueryData(q.article(params.id));
  },
  pendingComponent: ReaderSkeleton,
  component: ArticlePage,
});

export const kbRoute = createRoute({
  getParentRoute: parent,
  errorComponent,
  path: "/kb",
  validateSearch: kbSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient, q }, deps }) => queryClient.ensureQueryData(q.kbBrowse(deps)),
  component: KbPage,
});

export const entityRoute = createRoute({
  getParentRoute: parent,
  errorComponent,
  path: "/kb/$name",
  loader: ({ context: { queryClient, q }, params }) =>
    queryClient.ensureQueryData(q.entity(params.name)),
  component: EntityPage,
});

export const tagsRoute = createRoute({
  getParentRoute: parent,
  errorComponent,
  path: "/tags",
  loader: ({ context: { queryClient, q } }) => queryClient.ensureQueryData(q.tags()),
  component: TagsPage,
});

export const resourcesRoute = createRoute({
  getParentRoute: parent,
  errorComponent,
  path: "/resources",
  loader: ({ context: { queryClient, q } }) => queryClient.ensureQueryData(q.resourceCatalog()),
  component: ResourceDirectory,
});

export const resourceRoute = createRoute({
  getParentRoute: parent,
  errorComponent,
  path: "/resources/$id",
  loader: ({ context: { queryClient, q }, params }) =>
    Promise.all([
      queryClient.ensureQueryData(q.resourceCatalog()),
      queryClient.ensureQueryData(q.resourcePage(params.id)),
    ]),
  pendingComponent: ReaderSkeleton,
  component: ResourceReader,
});

export const statusRoute = createRoute({
  getParentRoute: parent,
  errorComponent,
  path: "/status",
  loader: ({ context: { queryClient, q } }) => queryClient.ensureQueryData(q.status()),
  component: StatusPage,
});

export const aboutRoute = createRoute({
  getParentRoute: parent,
  errorComponent,
  path: "/about",
  component: AboutPage,
});

export const accountRoute = createRoute({
  getParentRoute: parent,
  errorComponent,
  path: "/account",
  validateSearch: accountSearch,
  loader: ({ context: { queryClient, q } }) => queryClient.ensureQueryData(q.viewer()),
  component: AccountPage,
});

export const routeTree = rootRoute.addChildren([
  feedRoute,
  searchRoute,
  articleRoute,
  kbRoute,
  entityRoute,
  resourcesRoute,
  resourceRoute,
  tagsRoute,
  statusRoute,
  aboutRoute,
  accountRoute,
]);

export function createAppRouter(context: RouterContext) {
  return createRouter({
    routeTree,
    context,
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0, // React Query owns freshness; the router never caches loader data itself
    defaultPendingMs: 300, // skeletons only for loads that are actually slow…
    defaultPendingMinMs: 300, // …and never for a single frame
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
