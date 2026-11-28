/**
 * The portal's URL contract. Filters, the time range, the admin scope and the open log
 * entry live in search parameters, so every view can be linked and survives a reload.
 * `/login`, `/callback`, `/logout` and `/api` belong to the gateway, not to this router.
 */
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from "@tanstack/react-router";

import type { Range, StatusFilter } from "./api.ts";
import { RANGES, type ScopeSearch } from "./session.ts";
import { Root } from "./shell.tsx";

/* Each page is its own chunk; Recharts only loads with the overview. */
const AdminBackendsPage = lazyRouteComponent(
  () => import("./pages/AdminBackends.tsx"),
  "AdminBackendsPage",
);
const AdminLoggingPage = lazyRouteComponent(
  () => import("./pages/AdminLogging.tsx"),
  "AdminLoggingPage",
);
const KeysPage = lazyRouteComponent(() => import("./pages/Keys.tsx"), "KeysPage");
const LogsPage = lazyRouteComponent(() => import("./pages/Logs.tsx"), "LogsPage");
const ModelsPage = lazyRouteComponent(() => import("./pages/Models.tsx"), "ModelsPage");
const OverviewPage = lazyRouteComponent(() => import("./pages/Overview.tsx"), "OverviewPage");
const SetupPage = lazyRouteComponent(() => import("./pages/Setup.tsx"), "SetupPage");

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
const int = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
};
const oneOf = <T extends string>(v: unknown, values: readonly T[]) =>
  values.includes(v as T) ? (v as T) : undefined;

function scopeSearch(s: Record<string, unknown>): ScopeSearch {
  return { scope: oneOf(s.scope, ["all"] as const), user: str(s.user) };
}

export interface OverviewSearch extends ScopeSearch {
  range?: Range;
  from?: string;
  to?: string;
}

export interface LogsSearch extends ScopeSearch {
  q?: string;
  model?: string;
  backend?: string;
  route?: string;
  key?: number;
  status?: StatusFilter;
  range?: Range;
  /** The request open in the side panel. */
  id?: number;
}

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Root,
});
const parent = () => rootRoute;

const overviewRoute = createRoute({
  getParentRoute: parent,
  path: "/",
  validateSearch: (s: Record<string, unknown>): OverviewSearch => ({
    ...scopeSearch(s),
    range: oneOf(s.range, RANGES),
    from: str(s.from),
    to: str(s.to),
  }),
  component: OverviewPage,
});

const logsRoute = createRoute({
  getParentRoute: parent,
  path: "/logs",
  validateSearch: (s: Record<string, unknown>): LogsSearch => ({
    ...scopeSearch(s),
    q: str(s.q),
    model: str(s.model),
    backend: str(s.backend),
    route: str(s.route),
    key: int(s.key),
    status: oneOf(s.status, ["ok", "error", "cancelled"] as const),
    range: oneOf(s.range, RANGES),
    id: int(s.id),
  }),
  component: LogsPage,
});

const modelsRoute = createRoute({ getParentRoute: parent, path: "/models", component: ModelsPage });
const keysRoute = createRoute({ getParentRoute: parent, path: "/keys", component: KeysPage });
const setupRoute = createRoute({ getParentRoute: parent, path: "/setup", component: SetupPage });
const adminBackendsRoute = createRoute({
  getParentRoute: parent,
  path: "/admin/backends",
  component: AdminBackendsPage,
});
const adminLoggingRoute = createRoute({
  getParentRoute: parent,
  path: "/admin/logging",
  component: AdminLoggingPage,
});

const routeTree = rootRoute.addChildren([
  overviewRoute,
  logsRoute,
  modelsRoute,
  keysRoute,
  setupRoute,
  adminBackendsRoute,
  adminLoggingRoute,
]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({ routeTree, context: { queryClient }, defaultPreload: "intent" });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
