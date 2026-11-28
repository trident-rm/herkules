/** The portal's JSON API on its own origin. A 401 means "not signed in". */

export type Level = "metadata" | "full";

export type BodyRetention =
  | { mode: "default" }
  | { mode: "days"; days: number }
  | { mode: "forever" };

export interface Me {
  sub: string;
  role: "admin" | "member";
  displayName: string;
  avatarUrl: string | null;
  apiOrigin: string;
  models: string[];
  logging: { user: Level | null; models: Record<string, Level>; default: Level };
}

export interface Key {
  id: number;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  requests30d: number;
  promptTokens30d: number;
  cachedTokens30d: number;
  outputTokens30d: number;
}

export interface RequestRow {
  id: number;
  at: string;
  sub: string;
  keyName: string | null;
  model: string | null;
  backend: string | null;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  streamed: boolean;
  cancelled: boolean;
  effort: string | null;
  error: string | null;
  promptTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  ttftMs: number | null;
  decodeTps: number | null;
  tokensPerRound: number | null;
  level: Level;
  hasBody: boolean;
}

export interface Bodies {
  request: string;
  requestBytes: number;
  requestTruncated: boolean;
  response: string;
  responseBytes: number;
  responseTruncated: boolean;
}

export interface RoutingSettings {
  strategy: "leastLoaded" | "roundRobin" | "single";
  waitSeconds: number;
}

export interface BackendPolicy {
  priority: number;
  maxStreams: number | null;
}

export type BackendState = "enabled" | "disabled" | "draining";

interface MetricInterval {
  tokens: number;
  seconds: number;
}

export interface BackendView {
  name: string;
  models: string[];
  state: BackendState;
  inflight: number;
  live: {
    healthy: boolean;
    running: number;
    waiting: number;
    parked: number | null;
    kvFreePages: number | null;
    kvTotalPages: number | null;
    processStartedAt: number | null;
    speculativeAcceptance: number | null;
    fallbackSteps: number | null;
    prefixCache: Partial<Record<"gpu" | "ram" | "ssd", MetricInterval>>;
    rejections: Partial<Record<"queue_full" | "draining" | "engine_unavailable", number>>;
    decodeByStreams: Record<string, MetricInterval>;
    prefilling: number | null;
    decoding: number | null;
    maxStreams: number | null;
    promptTps: number | null;
    prefillTps: number | null;
    decodeTps: number | null;
    sampledAt: string | null;
    checkedAt: string | null;
    error: string | null;
    tunnel: string | null;
  };
  source?: { kind: "file" } | { kind: "tunnel"; hostname: string; port: number };
}

export interface Median {
  model: string | null;
  backend: string | null;
  requests: number;
  ttftMs: number | null;
  decodeTps: number | null;
  tokensPerRound: number | null;
}

export interface LiveBackends {
  backends: BackendView[];
  tunnels: boolean;
}

export interface Performance extends LiveBackends {
  medians: Median[];
}

export interface Person {
  displayName: string;
  avatarUrl: string | null;
}

/** Whose data a page shows. Members only ever get their own; the server enforces it. */
export interface Scope {
  all?: boolean;
  sub?: string;
}

export type StatusFilter = "ok" | "error" | "cancelled";

export interface LogFilter extends Scope {
  q?: string;
  model?: string;
  backend?: string;
  route?: string;
  key?: number;
  status?: StatusFilter;
  from?: string;
  to?: string;
}

export type Range = "1h" | "24h" | "7d" | "30d";
export type StatsWindow = { range: Range } | { from: string; to: string };

export interface Totals {
  requests: number;
  errors: number;
  cancelled: number;
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
  ttftP50: number | null;
  ttftP95: number | null;
  tpsP50: number | null;
  tpsP95: number | null;
}

export interface Stats {
  range: Range | "custom";
  bucketSeconds: number;
  from: string;
  to: string;
  totals: Totals;
  series: (Totals & { t: string })[];
  models: (Totals & { model: string | null })[];
  backends: (Totals & { backend: string | null })[];
  decodeByLoad: {
    model: string;
    backend: string;
    admittedInflight: number;
    samples: number;
    tpsP50: number;
  }[];
  keys: (Totals & { keyId: number; keyName: string | null })[];
  users: (Totals & { sub: string; displayName: string | null; avatarUrl: string | null })[];
  recentErrors: RequestRow[];
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error_description?: string };
    throw new HttpError(response.status, body.error_description ?? response.statusText);
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

/** Query parameters from an object, skipping empty values. */
export function query(params: Record<string, string | number | boolean | undefined>): string {
  const out = new URLSearchParams();
  for (const [name, value] of Object.entries(params))
    if (value !== undefined && value !== "" && value !== false) out.set(name, String(value));
  return out.toString();
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const api = {
  me: () => call<Me>("/me"),
  keys: () => call<{ keys: Key[] }>("/keys"),
  createKey: (name: string) => call<{ key: Key; secret: string }>("/keys", send("POST", { name })),
  revokeKey: (id: number) => call<void>(`/keys/${id}`, send("DELETE")),
  requests: (filter: LogFilter, page: { before?: number; after?: number; limit?: number }) =>
    call<{ requests: RequestRow[]; users: Record<string, Person> }>(
      `/requests?${query({ ...filter, ...page })}`,
    ),
  request: (id: number) => call<{ request: RequestRow }>(`/requests/${id}`),
  bodies: (id: number) => call<Bodies>(`/requests/${id}/body`),
  stats: (window: StatsWindow, scope: Scope) =>
    call<Stats>(`/stats?${query({ ...window, ...scope })}`),
  liveBackends: () => call<LiveBackends>("/backends/live"),
  performance: () => call<Performance>("/performance"),
  routing: () =>
    call<{ settings: RoutingSettings; backends: Record<string, BackendPolicy> }>("/admin/routing"),
  setRouting: (settings: RoutingSettings) => call<void>("/admin/routing", send("PUT", settings)),
  setBackendPolicy: (name: string, policy: BackendPolicy) =>
    call<void>(`/admin/backends/${encodeURIComponent(name)}/routing`, send("PUT", policy)),
  setBackendState: (name: string, state: BackendState) =>
    call<void>(`/admin/backends/${encodeURIComponent(name)}/state`, send("PUT", { state })),
  addBackend: (body: { name: string; models: string[]; port: number }) =>
    call<{ name: string; hostname: string; install: string }>(
      "/admin/backends",
      send("POST", body),
    ),
  removeBackend: (name: string) =>
    call<void>(`/admin/backends/${encodeURIComponent(name)}`, send("DELETE")),
  logging: () =>
    call<{
      overrides: { users: Record<string, Level>; models: Record<string, Level> };
      users: Record<string, Person>;
      models: string[];
      retention: Record<string, BodyRetention>;
      defaultRetentionDays: number;
      bodyLimitBytes: number;
    }>("/admin/logging"),
  setLogging: (scope: "user" | "model", subject: string, level: Level | null) =>
    call<void>("/admin/logging", send("PUT", { scope, subject, level })),
  setBodyRetention: (model: string, retention: BodyRetention) =>
    call<void>("/admin/logging/retention", send("PUT", { model, ...retention })),
  logStorage: () =>
    call<{
      storage: {
        requestRecords: number;
        bodyRecords: number;
        requestDiskBytes: number;
        bodyDiskBytes: number;
      };
      nextCleanup: string | null;
    }>("/admin/logging/storage"),
};
