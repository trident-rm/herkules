/**
 * Test harness: the whole service in-process with PGlite, a fake GitHub and a
 * controllable clock. No network, no Docker. Integration tests drive real
 * HTTP through `app.request`; unit tests import `decide`, `QUIRKS`,
 * `AUDITED_PATHS`, `buildRegistry` directly with literals.
 *
 * GitHub seam: runtime code gets `fetch` injected (github.ts). Better Auth's
 * own provider code (the authorization-code exchange) uses global fetch, so
 * the fake ALSO installs itself as globalThis.fetch for github.com hosts for
 * the harness lifetime; every other host is refused (fail loud).
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";
import type { Hono } from "hono";

import type { OrgMembership } from "./github.ts";
import type { ResourceSpec } from "./registry.ts";
import { RESOURCE_SPECS } from "./registry.ts";
import { createService } from "./main.ts";

export interface FakeGithubUser {
  readonly id: number;
  readonly login: string;
  readonly name?: string;
  readonly email?: string | null;
  readonly emails?: readonly {
    readonly email: string;
    readonly verified: boolean;
    readonly primary: boolean;
  }[];
  readonly avatarUrl?: string;
  readonly org: OrgMembership;
}

export interface FakeGithub {
  /** Register a user; returns the authorization `code` that the fake token endpoint will exchange for this user's token. */
  user(u: FakeGithubUser): { readonly code: string; readonly accessToken: string };
  /** Change membership after login to test the grant re-check. */
  setOrg(login: string, org: OrgMembership): void;
  /** Make api.github.com fail (network) or 401 (revoked) for the next N calls, optionally only for paths matching `only`. */
  fail(mode: "network" | "revoked", times?: number, only?: RegExp): void;
  readonly calls: readonly { readonly path: string; readonly login?: string }[];
}

export interface TestClock {
  now(): Date;
  advance(seconds: number): void;
}

export interface McpClientSession {
  readonly clientId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  /** POST /oauth2/token with grant_type=refresh_token. Rotates the stored refresh token on success. */
  refresh(): Promise<Response>;
}

export interface TestService {
  readonly app: Hono;
  readonly github: FakeGithub;
  readonly clock: TestClock;
  readonly issuer: string;
  readonly origin: string;
  readonly service: Awaited<ReturnType<typeof createService>>;
  /** `app.request` with the Origin header Better Auth's CSRF check wants. */
  fetch(path: string, init?: RequestInit & { cookie?: string }): Promise<Response>;
  /** Run the full sign-in/social -> callback/github flow for a fake user. Returns the session cookie, or the rejection (error code from the /login?error= redirect). */
  login(
    login: string,
    options?: { readonly oauthQuery?: string },
  ): Promise<
    | {
        readonly ok: true;
        readonly cookie: string;
        readonly userId: string;
        readonly location: string;
      }
    | { readonly ok: false; readonly error: string; readonly location: string }
  >;
  /** Registers a DCR client like Claude Code does and completes authorize -> consent -> token. */
  mcpClient(
    cookie: string,
    audience: string,
    options?: {
      readonly clientId?: string;
      readonly redirectUri?: string;
      readonly scope?: string;
      readonly consent?: boolean;
    },
  ): Promise<McpClientSession>;
  /** Promote via the audited API as a system actor (for tests that need an admin without env). */
  makeAdmin(userId: string): Promise<void>;
  audit(): Promise<readonly { readonly type: string; readonly event: unknown }[]>;
  close(): Promise<void>;
}

export interface TestServiceOptions {
  readonly feishuFetch?: typeof globalThis.fetch;
  readonly env?: Partial<Record<string, string>>;
  /** Defaults to RESOURCE_SPECS plus `{ name: "notes", kind: "api" }` so audience binding is testable. */
  readonly resources?: readonly ResourceSpec[];
  readonly adminLogins?: readonly string[];
  readonly startAt?: Date;
  /**
   * Client ID Metadata Documents served by the fake transport, keyed by the
   * exact client_id URL. Setting this also sets CIMD_ENABLED=true unless env
   * says otherwise. Any other URL is a 404.
   */
  readonly cimd?: Readonly<Record<string, unknown>>;
}

export const TEST_ORG = "herkules-test";
const DEFAULT_ORIGIN = "http://localhost:3000";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

class FakeGithubImpl implements FakeGithub {
  private readonly byToken = new Map<string, FakeGithubUser>();
  private readonly byCode = new Map<string, string>();
  private readonly orgs = new Map<string, OrgMembership>();
  private failures: { mode: "network" | "revoked"; left: number; only?: RegExp } | undefined;
  readonly calls: { path: string; login?: string }[] = [];

  user(u: FakeGithubUser) {
    const accessToken = `gho_${randomBytes(12).toString("hex")}`;
    const code = `code_${randomBytes(8).toString("hex")}`;
    this.byToken.set(accessToken, u);
    this.byCode.set(code, accessToken);
    this.orgs.set(u.login, u.org);
    return { code, accessToken };
  }
  setOrg(login: string, org: OrgMembership) {
    this.orgs.set(login, org);
  }
  fail(mode: "network" | "revoked", times = 1, only?: RegExp) {
    this.failures = { mode, left: times, ...(only ? { only } : {}) };
  }

  async handle(
    url: URL,
    init: RequestInit | undefined,
    input: string | URL | Request,
  ): Promise<Response> {
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    if (
      url.host === "github.com" &&
      url.pathname === "/login/oauth/access_token" &&
      method === "POST"
    ) {
      const code = await this.codeOf(init, input);
      const token = code ? this.byCode.get(code) : undefined;
      this.byCode.delete(code ?? "");
      return Response.json(
        token
          ? { access_token: token, token_type: "bearer", scope: "read:user,user:email,read:org" }
          : { error: "bad_verification_code" },
      );
    }
    if (url.host === "avatars.githubusercontent.com") {
      return new Response(PNG, { headers: { "content-type": "image/png" } });
    }
    if (url.host === "api.github.com") {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      const token = headers.get("authorization")?.replace(/^Bearer /i, "") ?? "";
      const u = this.byToken.get(token);
      this.calls.push({ path: url.pathname, ...(u ? { login: u.login } : {}) });
      if (
        this.failures &&
        this.failures.left > 0 &&
        (!this.failures.only || this.failures.only.test(url.pathname))
      ) {
        this.failures.left -= 1;
        if (this.failures.mode === "network")
          throw new TypeError("fetch failed (fake github outage)");
        return Response.json({ message: "Bad credentials" }, { status: 401 });
      }
      if (!u) return Response.json({ message: "Bad credentials" }, { status: 401 });
      if (url.pathname === "/user/emails") {
        return Response.json(
          u.emails ?? [
            { email: u.email ?? `${u.login}@example.com`, verified: true, primary: true },
          ],
        );
      }
      if (url.pathname === "/user") {
        return Response.json({
          id: u.id,
          login: u.login,
          name: u.name ?? null,
          email: u.email ?? null,
          avatar_url: u.avatarUrl ?? `https://avatars.githubusercontent.com/u/${u.id}`,
        });
      }
      const m = /^\/user\/memberships\/orgs\/([^/]+)$/.exec(url.pathname);
      if (m) {
        if (decodeURIComponent(m[1]!) !== TEST_ORG)
          return Response.json({ message: "Not Found" }, { status: 404 });
        switch (this.orgs.get(u.login) ?? "none") {
          case "active":
            return Response.json({ state: "active", role: "member" });
          case "none":
            return Response.json({ message: "Not Found" }, { status: 404 });
          case "revoked":
            return Response.json({ message: "Bad credentials" }, { status: 401 });
          case "unknown":
            throw new TypeError("fetch failed (fake github outage)");
        }
      }
      return Response.json({ message: "Not Found" }, { status: 404 });
    }
    throw new Error(`fake github: unexpected fetch ${method} ${url.href}`);
  }

  private async codeOf(
    init: RequestInit | undefined,
    input: string | URL | Request,
  ): Promise<string | undefined> {
    const body = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    const text =
      typeof body === "string"
        ? body
        : body instanceof URLSearchParams
          ? body.toString()
          : body instanceof Request
            ? await body.text()
            : body
              ? await new Response(body as never).text()
              : "";
    try {
      const json = JSON.parse(text) as { code?: string };
      if (typeof json.code === "string") return json.code;
    } catch {
      /* form-encoded */
    }
    return new URLSearchParams(text).get("code") ?? undefined;
  }
}

/** Merge Set-Cookie headers into an existing cookie string (empty values delete). */
function absorb(cookie: string, res: Response): string {
  const map = new Map<string, string>();
  for (const part of cookie.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0) map.set(part.slice(0, eq), part.slice(eq + 1));
  }
  for (const sc of res.headers.getSetCookie()) {
    const first = sc.split(";")[0]!;
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq);
    const value = first.slice(eq + 1);
    const expired = /max-age=0|expires=thu, 01 jan 1970/i.test(sc);
    if (value === "" || expired) map.delete(name);
    else map.set(name, value);
  }
  return [...map].map(([k, v]) => `${k}=${v}`).join("; ");
}

export async function createTestService(options: TestServiceOptions = {}): Promise<TestService> {
  const ORIGIN = options.env?.PUBLIC_ORIGIN ?? DEFAULT_ORIGIN;
  const github = new FakeGithubImpl();
  let offsetMs = 0;
  const startAt = options.startAt ?? new Date();
  const realNow = Date.now();
  const clock: TestClock = {
    now: () => new Date(startAt.getTime() + (Date.now() - realNow) + offsetMs),
    advance: (seconds) => {
      offsetMs += seconds * 1000;
    },
  };
  const fakeFetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (options.feishuFetch && (url.host === "open.feishu.cn" || url.host === "accounts.feishu.cn"))
      return options.feishuFetch(input, init);
    return github.handle(url, init, input);
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (
      url.host.endsWith("github.com") ||
      url.host === "avatars.githubusercontent.com" ||
      url.host === "open.feishu.cn" ||
      url.host === "accounts.feishu.cn"
    )
      return fakeFetch(input, init);
    return originalFetch(input, init);
  };

  const cimdDocuments = options.cimd ?? {};
  const fetchClientMetadataResource: ClientMetadataResourceFetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    const doc = cimdDocuments[url];
    if (doc === undefined) return new Response("not found", { status: 404 });
    return Response.json(doc, { headers: { "cache-control": "max-age=60" } });
  };

  const env: NodeJS.ProcessEnv = {
    PUBLIC_ORIGIN: ORIGIN,
    AUTH_SECRET: "t".repeat(32),
    DATABASE_URL: "pglite://memory",
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-secret",
    GITHUB_ORG: TEST_ORG,
    ADMIN_GITHUB_LOGINS: (options.adminLogins ?? []).join(","),
    AVATAR_DIR: await mkdtemp(join(tmpdir(), "herkules-avatars-")),
    NODE_ENV: "test",
    ...(options.cimd ? { CIMD_ENABLED: "true" } : {}),
    ...options.env,
  };
  const service = await createService({
    env,
    fetch: fakeFetch,
    fetchClientMetadataResource,
    now: () => clock.now(),
    resources: options.resources ?? [
      ...RESOURCE_SPECS,
      { name: "notes", kind: "api", title: "herkules notes (API)" },
    ],
  });
  const { app } = service;
  const issuer = service.config.issuer;

  const fetch: TestService["fetch"] = async (path, init) => {
    const headers = new Headers(init?.headers);
    headers.set("origin", ORIGIN);
    if (init?.cookie) headers.set("cookie", init.cookie);
    return app.request(path.startsWith("http") ? path : `${ORIGIN}${path}`, {
      ...init,
      headers,
      redirect: "manual",
    });
  };

  const self: TestService = {
    app,
    github,
    clock,
    issuer,
    origin: ORIGIN,
    service,
    fetch,

    async login(login, opts) {
      const u = [
        ...(github as unknown as { byToken: Map<string, FakeGithubUser> }).byToken.values(),
      ]
        .filter((x) => x.login === login)
        .at(-1); // the most recent registration wins (tests re-register to change name/avatar)
      if (!u) throw new Error(`fake github: no user ${login}; call github.user() first`);
      const { code } = github.user(u); // a fresh authorization code for this login
      const start = await fetch("/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "github",
          callbackURL: "/",
          ...(opts?.oauthQuery ? { oauth_query: opts.oauthQuery } : {}),
        }),
      });
      if (start.status !== 200)
        throw new Error(`sign-in/social failed: ${start.status} ${await start.text()}`);
      const { url } = (await start.json()) as { url: string };
      const state = new URL(url).searchParams.get("state");
      if (!state) throw new Error("sign-in/social returned no state");
      let cookie = absorb("", start);
      const cb = await fetch(`/auth/callback/github?code=${code}&state=${state}`, { cookie });
      const location = cb.headers.get("location") ?? "";
      cookie = absorb(cookie, cb);
      const target = new URL(location, ORIGIN);
      const error = target.searchParams.get("error");
      if (error) return { ok: false, error, location };
      if (cb.status !== 302 && cb.status !== 303) {
        throw new Error(`callback/github: ${cb.status} ${await cb.text()}`);
      }
      const session = await fetch("/auth/get-session", { cookie });
      const body = (await session.json()) as { user?: { id: string } } | null;
      if (!body?.user) throw new Error(`login for ${login} produced no session`);
      return { ok: true, cookie, userId: body.user.id, location };
    },

    async mcpClient(cookie, audience, opts) {
      let clientId = opts?.clientId;
      const redirectUri = opts?.redirectUri ?? "http://127.0.0.1:4242/callback";
      if (!clientId) {
        const reg = await fetch("/auth/oauth2/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_name: "Test IDE",
            redirect_uris: [redirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          }),
        });
        if (reg.status !== 201) throw new Error(`register: ${reg.status} ${await reg.text()}`);
        clientId = ((await reg.json()) as { client_id: string }).client_id;
      }
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const q = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: opts?.scope ?? "offline_access",
        resource: audience,
        state: "s123",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const authz = await fetch(`/auth/oauth2/authorize?${q.toString()}`, { cookie });
      let location = authz.headers.get("location") ?? "";
      if (!location) throw new Error(`authorize: ${authz.status} ${await authz.text()}`);
      if (new URL(location, ORIGIN).pathname === "/connect-github") {
        await fetch("/auth/api/me/identity-setup", { method: "POST", cookie });
        const continued = await fetch("/auth/oauth2/continue", {
          method: "POST",
          cookie,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            postLogin: true,
            oauth_query: new URL(location, ORIGIN).search.slice(1),
          }),
        });
        const body = (await continued.json()) as { url?: string; redirect_uri?: string };
        location = body.url ?? body.redirect_uri ?? "";
      }
      if (location.startsWith("/consent") || location.includes("/consent?")) {
        const oauthQuery = new URL(location, ORIGIN).search.slice(1);
        const consent = await fetch("/auth/oauth2/consent", {
          method: "POST",
          cookie,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accept: opts?.consent ?? true, oauth_query: oauthQuery }),
        });
        if (consent.status !== 200)
          throw new Error(`consent: ${consent.status} ${await consent.text()}`);
        const body = (await consent.json()) as { url?: string; redirect_uri?: string };
        location = body.url ?? body.redirect_uri ?? "";
      }
      const redirected = new URL(location);
      const code = redirected.searchParams.get("code");
      if (!code) throw new Error(`authorize did not yield a code: ${location}`);
      const tokenRes = await fetch("/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: verifier,
        }).toString(),
      });
      if (tokenRes.status !== 200)
        throw new Error(`token: ${tokenRes.status} ${await tokenRes.text()}`);
      const tokens = (await tokenRes.json()) as { access_token: string; refresh_token?: string };
      const session = {
        clientId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? "",
        refresh: async () => {
          const res = await fetch("/auth/oauth2/token", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: session.refreshToken,
              client_id: clientId!,
            }).toString(),
          });
          if (res.status === 200) {
            const next = (await res.clone().json()) as {
              access_token: string;
              refresh_token?: string;
            };
            session.accessToken = next.access_token;
            if (next.refresh_token) session.refreshToken = next.refresh_token;
          }
          return res;
        },
      } satisfies McpClientSession & { accessToken: string; refreshToken: string };
      return session;
    },

    async makeAdmin(userId) {
      await service.users.setRole({ kind: "system", job: "test" }, userId, "admin");
    },
    async audit() {
      const rows = await service.db.audit.page({ limit: 1000 });
      return [...rows].reverse().map((r) => ({ type: r.type, event: r.event }));
    },
    async close() {
      globalThis.fetch = originalFetch;
      await service.close();
    },
  };
  return self;
}

export { RESOURCE_SPECS } from "./registry.ts";
