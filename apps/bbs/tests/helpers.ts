/**
 * Test harness. Two facts decide its whole shape:
 *
 *  1. PGlite 0.5.8 ships `pg_trgm` as a constructor extension; `createDb` passes
 *     it, so this file only points `DATABASE_URL` at `pglite://memory`.
 *  2. `fetchVia` (from `@herkules/auth-middleware/testing`) is the repo's whole
 *     test architecture: one in-process Hono app's `fetch` becomes another
 *     service's outbound transport. bbs keeps the seam (`ServiceDeps.fetch`),
 *     so a bbs test drives the REAL auth service on PGlite via
 *     `@herkules/auth/testing`, and the fast suites use
 *     `@herkules/oauth-client/testing`'s `createFakeIssuer()` instead.
 *
 * WHAT RUNS WHERE
 *   PGlite, in CI, no Docker — everything: the migration incl. both GIN trigram
 *   indexes and both alignment CHECKs; the full import from a fixture app.db,
 *   twice (no-op) and with a delta; every Library method; search recall, ranking
 *   order and snippet markers; cursor round-trips; the API over `app.request()`
 *   anonymous and signed in; MCP over an in-process SDK client incl. the
 *   wrong-audience 401; head injection against a fixture index.html; the renderer's
 *   adversarial cases.
 *   Real Postgres, opt-in via BBS_TEST_DATABASE_URL (`describe.skipIf`) — only what
 *   PGlite cannot answer: the bot's dedicated advisory lock and its serialization
 *   of competing quota assignment (tests/bot.test.ts). The crawler's equivalent
 *   lock is not covered yet. There is no EXPLAIN/index-usage check and no
 *   relevance harness: the golden set was retired, and the corpus is not checked
 *   in, so neither could run in CI. Search quality is asserted by the ranked
 *   assertions in tests/search.test.ts instead.
 *
 * THREE HARNESSES, smallest first:
 *   fakeLibrary()     a hand-rolled `Library` with two articles — presenters, routes, head injection.
 *   createFakeApp()   the whole HTTP app over fakeLibrary() and createFakeIssuer() — API and MCP contracts.
 *   createTestBbs()   the real service (`createService`) on PGlite with the fixture corpus imported, behind
 *                     the fake issuer or (`realIssuer`) the real auth service — the done-predicate walk.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiResource, mcpResource } from "@herkules/auth-middleware";
import { fetchVia } from "@herkules/auth-middleware/testing";
import { createUserInfo } from "@herkules/auth-middleware/userinfo";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createOAuthClient } from "@herkules/oauth-client";
import { honoOAuth } from "@herkules/oauth-client/hono";
import { absorbCookies, createFakeIssuer } from "@herkules/oauth-client/testing";
import type { FakeIssuer } from "@herkules/oauth-client/testing";
import type { Hono } from "hono";

import { createApp } from "../src/app.ts";
import type { AppDeps } from "../src/app.ts";
import type {
  Article,
  ArticleAi,
  ArticleId,
  ArticleSummary,
  EntityCount,
  EntityKey,
  HeadMeta,
  KbBrowse,
  KbCard,
  KbEntry,
  Library,
  LibraryStatus,
  Overview,
  SearchHit,
  TagIndex,
} from "../src/library/index.ts";
import { QueryError } from "../src/library/index.ts";
import { createService } from "../src/main.ts";
import { createSpaHandler } from "../src/spa/static.ts";

export const ORIGIN = "http://localhost:3000";
export const APP_ORIGIN = "http://localhost:3003";
export const ISSUER = `${ORIGIN}/auth`;
export const API_RESOURCE = `${ORIGIN}/api/bbs`;
export const MCP_RESOURCE = `${ORIGIN}/mcp/bbs`;
export const CLIENT_SECRET = "bbs-secret-".padEnd(48, "x");
export const COOKIE_SECRET = "c".repeat(32);

// Re-exported so bbs tests reach the harness through one import.
export { fetchVia };

/** An SDK 2.0 client connected over an in-process fetch with a Bearer token. */
export async function connect(
  url: string,
  token: string | undefined,
  fetch: typeof globalThis.fetch,
) {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch,
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
  });
  await client.connect(transport);
  return client;
}

/** A 2025-era JSON-RPC POST with no envelope: what Claude Code and VS Code send today. */
export async function legacyCall(
  url: string,
  token: string | undefined,
  fetch: typeof globalThis.fetch,
  method: string,
  params: unknown = {},
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

// ── fakeLibrary ─────────────────────────────────────────────────────────────

export const FAKE = {
  id: "01J0000000000000000000000A" as ArticleId,
  otherId: "01J0000000000000000000000B" as ArticleId,
  /** A ULID that the fake library does not know. */
  unknownId: "01J0000000000000000000000Z" as ArticleId,
  entityKey: "hpm5361" as EntityKey,
  entityName: "HPM5361",
  /** Contains every character the head escaper must neutralise. */
  title: '【RM2026-开源】步兵底盘 <b>&"quoted"</b>',
} as const;

const summary: ArticleSummary = {
  id: FAKE.id,
  sourceArticleId: "1",
  url: "https://bbs.robomaster.com/article/1",
  title: FAKE.title,
  titleParts: { season: "RM2026", team: null, labels: ["开源"], topic: "步兵底盘" },
  author: "Kaiser",
  publishedAt: new Date("2026-03-01T17:30:00.000Z"),
  discoveredAt: new Date("2026-03-05T00:00:00.000Z"),
  fetchedAt: new Date("2026-03-05T00:01:00.000Z"),
  isPinned: false,
  tags: ["硬件/机器人硬件", "算法/控制"],
  introduction: "简介：全国产方案",
  excerpt: "简介：全国产方案",
  bodyChars: 1234,
  linkCount: 1,
  imageCount: 1,
  tldr: "一句话总结",
};

const other: ArticleSummary = {
  ...summary,
  id: FAKE.otherId,
  sourceArticleId: "2",
  url: "https://bbs.robomaster.com/article/2",
  title: "PID 整定经验",
  titleParts: { season: null, team: null, labels: [], topic: "PID 整定经验" },
  publishedAt: null,
  tags: ["算法/控制"],
  tldr: null,
};

const overview: Overview = {
  genre: "教程",
  tldr: "一句话总结",
  summary: "摘要",
  keyPoints: ["要点一"],
  appliesWhen: null,
  package: [],
  maturity: { status: "已验证", evidence: null },
  caveats: [],
  readingGuide: null,
  extras: {
    quickStart: [],
    portingChecklist: [],
    compat: [],
    lessons: [],
    thesis: null,
    arguments: [],
    actions: [],
  },
  faq: [{ question: "Q", answer: "A", source: null }],
};

const kb: KbEntry = {
  domain: ["控制"],
  robotTypes: ["步兵"],
  problem: "底盘打滑",
  approach: "PID",
  components: [{ name: "HPM5361", kind: "MCU", spec: null, role: "主控", source: null }],
  parameters: [],
  interfaces: [],
  toolchain: [],
  designDecisions: [],
  pitfalls: ["积分饱和"],
  cost: null,
  references: [],
  entities: ["HPM5361"],
  claims: [],
  openQuestions: [],
  searchKeywords: ["PID"],
};

const article: Article = {
  ...summary,
  contentFormat: "markdown",
  contentHtml: "<p>大学步兵开源底盘</p>",
  bodyText: "大学步兵开源底盘，PID 整定经验。",
  links: [
    {
      url: "https://bbs.robomaster.com/article/2",
      kind: "document",
      label: "PID 整定经验",
      articleId: FAKE.otherId,
      position: 0,
    },
  ],
  images: [{ url: "https://cdn.example/1.png", alt: "封面", position: 0 }],
};

const ai: ArticleAi = {
  articleId: FAKE.id,
  status: "ready",
  overview,
  kb,
  images: [{ index: 1, kind: "截图", caption: "封面", textInImage: null, facts: [] }],
  model: "test-model",
  generatedAt: new Date("2026-03-06T00:00:00.000Z"),
  error: null,
};

const card: KbCard = {
  articleId: FAKE.id,
  title: FAKE.title,
  author: "Kaiser",
  publishedAt: summary.publishedAt,
  tldr: overview.tldr,
  genre: overview.genre,
  maturity: "已验证",
  problem: kb.problem,
  domain: kb.domain,
  robotTypes: kb.robotTypes,
  entities: kb.entities,
  pitfalls: kb.pitfalls,
};

const entity: EntityCount = { key: FAKE.entityKey, name: FAKE.entityName, articleCount: 1 };

const hit: SearchHit = {
  ...other,
  score: 2.5,
  snippet: [
    { text: "…经验上 ", hit: false },
    { text: "PID", hit: true },
    { text: " ", hit: false },
    { text: "整定", hit: true },
    { text: " 先调 P…", hit: false },
  ],
};

const status: LibraryStatus = {
  site: { name: "RM 论坛", url: "https://bbs.robomaster.com" },
  articles: { total: 2, fetched: 2, skipped: 0, tags: 2, images: 1, links: 1 },
  ai: { ready: 1, missing: 1, entities: 1 },
  crawler: {
    lastCheckedAt: new Date("2026-03-07T00:00:00.000Z"),
    lastCheckedAgeSeconds: 600,
    backfillCompletedAt: null,
  },
  bot: { lastReconciledAt: null, lastReconciledAgeSeconds: null },
  importedAt: new Date("2026-03-08T00:00:00.000Z"),
};

const headOf = (path: string, title: string, type: HeadMeta["type"]): HeadMeta => ({
  title,
  description: "  简介：全国产   方案  ",
  path,
  type,
  image: type === "article" ? "https://cdn.example/1.png" : null,
  publishedAt: type === "article" ? summary.publishedAt : null,
  author: type === "article" ? "Kaiser" : null,
});

/** Two articles, one entity, deterministic. `calls` records every method invoked, for "one call per request" assertions. */
export function fakeLibrary(): Library & { readonly calls: string[] } {
  const calls: string[] = [];
  const note = <T>(name: string, value: T): T => {
    calls.push(name);
    return value;
  };
  const tags: TagIndex = {
    items: [
      { name: "算法/控制", count: 2 },
      { name: "硬件/机器人硬件", count: 1 },
    ],
    groups: [
      { name: "算法", count: 2 },
      { name: "硬件", count: 1 },
    ],
    total: 2,
  };
  const browse: KbBrowse = {
    total: 1,
    domains: [{ name: "控制", count: 1 }],
    robotTypes: [{ name: "步兵", count: 1 }],
    genres: [{ name: "教程", count: 1 }],
    cards: [card],
  };
  return {
    calls,
    articles: async (q) =>
      note("articles", { items: q.tag === "none" ? [] : [summary, other], nextCursor: null }),
    article: async (id) => note("article", id === FAKE.id ? article : null),
    content: async (id, format) =>
      note(
        "content",
        id === FAKE.id
          ? format === "html"
            ? { format: "html", body: article.contentHtml! }
            : format === "markdown"
              ? { format: "markdown", body: "# 大学步兵开源底盘" }
              : { format: "text", body: article.bodyText! }
          : null,
      ),
    ai: async (id) =>
      note(
        "ai",
        id === FAKE.id
          ? ai
          : id === FAKE.otherId
            ? {
                ...ai,
                articleId: FAKE.otherId,
                status: "pending",
                overview: null,
                kb: null,
                images: [],
                model: null,
                generatedAt: null,
              }
            : null,
      ),
    head: async (id) =>
      note("head", id === FAKE.id ? headOf(`/articles/${id}`, FAKE.title, "article") : null),
    tags: async () => note("tags", tags),
    search: async (q) => {
      if (!q.q.trim()) throw new QueryError("empty_query", "q is blank");
      if (q.cursor === "bad")
        throw new QueryError("invalid_cursor", "cursor is not from this query");
      return note("search", { items: [hit], nextCursor: null, terms: q.q.trim().split(/\s+/) });
    },
    kbBrowse: async () => note("kbBrowse", browse),
    entities: async () => note("entities", [entity]),
    entity: async (key) =>
      note(
        "entity",
        key === FAKE.entityKey
          ? {
              entity,
              articles: [
                {
                  articleId: FAKE.id,
                  title: FAKE.title,
                  author: "Kaiser",
                  publishedAt: summary.publishedAt,
                  tldr: overview.tldr,
                  kb,
                },
              ],
            }
          : null,
      ),
    entityHead: async (key) =>
      note(
        "entityHead",
        key === FAKE.entityKey
          ? headOf(`/kb/${FAKE.entityName}`, FAKE.entityName, "website")
          : null,
      ),
    status: async () => note("status", status),
  };
}

// ── createFakeApp ───────────────────────────────────────────────────────────

/** The whole HTTP app over fakeLibrary() and the fake issuer: what the API and MCP contract tests exercise. */
export async function createFakeApp(
  options?: Partial<Pick<AppDeps, "onArticleRead" | "onError" | "ping">> & {
    decorateLibrary?: (local: Library) => Library;
  },
) {
  const fake = await createFakeIssuer({
    issuer: ISSUER,
    client: { id: "bbs", secret: CLIENT_SECRET, redirectUri: `${APP_ORIGIN}/callback` },
    resource: API_RESOURCE,
  });
  const library = fakeLibrary();
  const reads = options?.decorateLibrary?.(library) ?? library;
  const api = apiResource({ resource: API_RESOURCE, issuer: ISSUER, fetch: fake.fetch });
  const mcp = mcpResource({ resource: MCP_RESOURCE, issuer: ISSUER, fetch: fake.fetch });
  const oauth = honoOAuth(
    createOAuthClient({
      auth: api,
      client: { id: "bbs", secret: CLIENT_SECRET },
      origin: APP_ORIGIN,
      cookieSecret: COOKIE_SECRET,
      fetch: fake.fetch,
    }),
  );
  const built = createApp({
    library: reads,
    oauth,
    mcp,
    userInfo: createUserInfo({ baseUrl: ORIGIN, fetch: fake.fetch }),
    spa: await createSpaHandler({ webDir: null, library: reads, appOrigin: APP_ORIGIN }),
    appOrigin: APP_ORIGIN,
    ping: options?.ping ?? (async () => {}),
    onArticleRead: options?.onArticleRead,
    onError: options?.onError,
  });
  return {
    app: built.app,
    fake,
    library,
    fetch: appFetch(built.app),
    signIn: (subject = "u1", role: "admin" | "member" = "member") =>
      fake.signIn(built.app, { subject, role }),
    token: (audience = MCP_RESOURCE, subject = "u1") =>
      fake.mint({ audience, subject, role: "member", clientId: "ide_test" }),
    close: () => built.close(),
  };
}

function appFetch(app: { request: Hono["request"] }) {
  return async (path: string, init?: RequestInit & { cookie?: string }): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (init?.cookie) headers.set("cookie", init.cookie);
    return app.request(path.startsWith("http") ? path : `${APP_ORIGIN}${path}`, {
      ...init,
      headers,
      redirect: "manual",
    });
  };
}

// ── createTestBbs ───────────────────────────────────────────────────────────

export interface TestBbs {
  readonly app: Hono;
  /** `fetch(path, init & { cookie? })` against the bbs app. */
  fetch(path: string, init?: RequestInit & { cookie?: string }): Promise<Response>;
  /** Signs a browser in through the issuer and returns the session cookie. */
  signIn(subject?: string): Promise<{ cookie: string; subject: string }>;
  /** A bearer token for `${origin}/mcp/bbs`, or for another audience to test rejection. */
  token(audience?: string): Promise<string>;
  readonly service: Awaited<ReturnType<typeof createService>>;
  close(): Promise<void>;
}

/** The env `createTestBbs` boots the service with. Exported so a test can show it. */
export async function testEnv(): Promise<NodeJS.ProcessEnv> {
  const webDir = await mkdtemp(join(tmpdir(), "bbs-web-"));
  await writeFile(
    join(webDir, "index.html"),
    await readFile(new URL("./fixtures/index.html", import.meta.url), "utf8"),
  );
  return {
    PUBLIC_ORIGIN: ORIGIN,
    APP_ORIGIN,
    DATABASE_URL: "pglite://memory",
    BBS_CLIENT_SECRET: CLIENT_SECRET,
    BBS_COOKIE_SECRET: COOKIE_SECRET,
    WEB_DIR: webDir,
    SEARCH_INDEX: "trgm",
    BBS_CREATE_DATABASE: "true",
    NODE_ENV: "test",
  };
}

/**
 * Boots: the issuer (`createFakeIssuer()` by default; `{ realIssuer: true }` uses
 * `@herkules/auth/testing` with `bbs` seeded in FIRST_PARTY_CLIENTS), then the
 * bbs service on its own PGlite with `deps.fetch` routed in-process, then imports
 * the fixture `app.db`. One call, because a test that wires five things wires
 * them differently each time.
 */
export async function createTestBbs(options?: {
  realIssuer?: boolean;
  importFixture?: boolean;
}): Promise<TestBbs> {
  const env = await testEnv();
  const importFixture = options?.importFixture ?? true;

  let fetch: typeof globalThis.fetch;
  let fake: FakeIssuer | undefined;
  let auth: import("@herkules/auth/testing").TestService | undefined;
  if (options?.realIssuer) {
    const { createTestService } = await import("@herkules/auth/testing");
    auth = await createTestService({
      env: { BBS_ORIGIN: APP_ORIGIN, BBS_CLIENT_SECRET: CLIENT_SECRET },
    });
    fetch = fetchVia(auth.app);
  } else {
    fake = await createFakeIssuer({
      issuer: ISSUER,
      client: { id: "bbs", secret: CLIENT_SECRET, redirectUri: `${APP_ORIGIN}/callback` },
      resource: API_RESOURCE,
    });
    fetch = fake.fetch;
  }

  const service = await createService({ env, fetch });
  if (importFixture) {
    const [{ buildFixtureDb }, { runImport }] = await Promise.all([
      import("./fixture.ts"),
      import("../src/import/run.ts"),
    ]);
    const sqlitePath = await buildFixtureDb(await mkdtemp(join(tmpdir(), "bbs-fixture-")));
    const report = await runImport({ db: service.db, sqlitePath });
    if (!report.ok) throw new Error(`fixture import failed: ${JSON.stringify(report)}`);
  }

  let authCookie: string | undefined;
  let githubIds = 100;

  const signIn: TestBbs["signIn"] = async (subject) => {
    if (fake) {
      const who = subject ?? "user_test";
      const { cookie } = await fake.signIn(service.app, { subject: who });
      return { cookie, subject: who };
    }
    const login = subject ?? "alice";
    auth!.github.user({ id: githubIds++, login, org: "active" });
    const logged = await auth!.login(login);
    if (!logged.ok) throw new Error(`auth login failed: ${logged.error}`);
    authCookie = logged.cookie;
    const start = await service.app.request(`${APP_ORIGIN}/login?next=/`, { redirect: "manual" });
    if (start.status !== 303) throw new Error(`/login: ${start.status} ${await start.text()}`);
    const loginCookie = absorbCookies("", start);
    const authz = await auth!.app.request(start.headers.get("location") ?? "", {
      headers: { cookie: logged.cookie },
      redirect: "manual",
    });
    const callback = authz.headers.get("location");
    if (!callback || !callback.startsWith(`${APP_ORIGIN}/callback?`)) {
      throw new Error(`authorize: ${authz.status} ${callback ?? (await authz.text())}`);
    }
    const done = await service.app.request(callback, {
      headers: { cookie: loginCookie },
      redirect: "manual",
    });
    if (done.status !== 303) throw new Error(`/callback: ${done.status} ${await done.text()}`);
    return { cookie: absorbCookies(loginCookie, done), subject: logged.userId };
  };

  const token: TestBbs["token"] = async (audience = MCP_RESOURCE) => {
    if (fake)
      return fake.mint({ audience, subject: "user_test", role: "member", clientId: "ide_test" });
    if (!authCookie) await signIn();
    return (await auth!.mcpClient(authCookie!, audience)).accessToken;
  };

  return {
    app: service.app as unknown as Hono,
    service,
    fetch: appFetch(service.app),
    signIn,
    token,
    close: async () => {
      await service.close();
      await auth?.close();
    },
  };
}
