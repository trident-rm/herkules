/** The portal's JSON API on its own origin. A 401 means "not signed in". */

export type Level = "metadata" | "full";

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
}

export interface UsageDay {
  day: string;
  sub: string;
  requests: number;
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
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

export type BackendState = "enabled" | "disabled" | "draining";

export interface BackendView {
  name: string;
  models: string[];
  state: BackendState;
  inflight: number;
  live: {
    healthy: boolean;
    running: number;
    waiting: number;
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

export interface Performance {
  medians: Median[];
  backends: BackendView[];
  tunnels: boolean;
}

export interface Person {
  displayName: string;
  avatarUrl: string | null;
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

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const api = {
  me: () => call<Me>("/me"),
  keys: () => call<{ keys: Key[] }>("/keys"),
  createKey: (name: string) => call<{ key: Key; secret: string }>("/keys", send("POST", { name })),
  revokeKey: (id: number) => call<void>(`/keys/${id}`, send("DELETE")),
  usage: (days = 30) => call<{ days: UsageDay[] }>(`/usage?days=${days}`),
  requests: (q: { before?: number; sub?: string; all?: boolean }) => {
    const params = new URLSearchParams();
    if (q.before) params.set("before", String(q.before));
    if (q.sub) params.set("sub", q.sub);
    if (q.all) params.set("all", "true");
    return call<{ requests: RequestRow[] }>(`/requests?${params}`);
  },
  bodies: (id: number) => call<Bodies>(`/requests/${id}/body`),
  performance: () => call<Performance>("/performance"),
  adminUsage: (days = 30) =>
    call<{ days: UsageDay[]; users: Record<string, Person> }>(`/admin/usage?days=${days}`),
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
    }>("/admin/logging"),
  setLogging: (scope: "user" | "model", subject: string, level: Level | null) =>
    call<void>("/admin/logging", send("PUT", { scope, subject, level })),
};
