/** Native REST/MCP/OAuth differential checks. Uses the caller's disposable fixture DB,
 * a loopback fake issuer and an ephemeral Rust child. All processes close in finally.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { serve } from "@hono/node-server";
import { apiResource, mcpResource } from "@herkules/auth-middleware";
import { createUserInfo } from "@herkules/auth-middleware/userinfo";
import { createOAuthClient } from "@herkules/oauth-client";
import { honoOAuth } from "@herkules/oauth-client/hono";
import { createSealer } from "@herkules/oauth-client/testing";
import { safePath, createCookieJar } from "@herkules/oauth-client/testing";
import { absorbCookies, createFakeIssuer } from "@herkules/oauth-client/testing";
import type { Library } from "../src/library/index.ts";
import { createApp, type AppDeps } from "../src/app.ts";
import { createSpaHandler } from "../src/spa/static.ts";
import { connect, fetchVia, legacyCall } from "../tests/helpers.ts";
import { ID } from "../tests/seed.ts";
import type { BbsDb } from "../src/db/index.ts";
import { sql, eq } from "drizzle-orm";
import { withRustReads } from "../src/library/rust.ts";
import { entityKey } from "../src/library/types.ts";
import { articles } from "../src/db/schema.ts";

export async function nativeParity(databaseUrl: string, library: Library, db: BbsDb, root: string) {
  const appOrigin = "https://bbs.example";
  const clientSecret = "native-test-secret-".padEnd(48, "x");
  const cookieSecret = "native-cookie-".padEnd(48, "x");
  let offline = false;
  let jwksCalls = 0;
  let fake: Awaited<ReturnType<typeof createFakeIssuer>>;
  const issuerServer = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (offline) return new Response("offline", { status: 503 });
      if (new URL(request.url).pathname === "/auth/jwks") jwksCalls++;
      if (new URL(request.url).pathname.startsWith("/auth/api/users/"))
        return Response.json({
          id: "native-user",
          displayName: "Native tester",
          avatarUrl: "",
          githubId: "test",
        });
      return fake.fetch(request);
    },
  });
  await once(issuerServer, "listening");
  const address = issuerServer.address();
  assert.ok(address && typeof address !== "string");
  const publicOrigin = `http://127.0.0.1:${address.port}`;
  const issuer = `${publicOrigin}/auth`;
  const api = `${publicOrigin}/api/bbs`;
  const mcp = `${publicOrigin}/mcp/bbs`;
  fake = await createFakeIssuer({
    issuer,
    resource: api,
    client: { id: "bbs", secret: clientSecret, redirectUri: `${appOrigin}/callback` },
  });
  const outbound: typeof fetch = (input, init) => fetch(input, init);
  const verifier = apiResource({
    issuer,
    resource: api,
    jwksUrl: `${issuer}/jwks`,
    fetch: outbound,
  });
  const oauth = createOAuthClient({
    auth: verifier,
    client: { id: "bbs", secret: clientSecret },
    origin: appOrigin,
    cookieSecret,
    issuerInternal: issuer,
    fetch: outbound,
  });
  const appDeps: AppDeps = {
    library,
    oauth: honoOAuth(oauth, {
      onLoginFailure: (f, c) =>
        c.redirect(`/account?login_error=${encodeURIComponent(f.error)}`, 303),
    }),
    mcp: mcpResource({ issuer, resource: mcp, jwksUrl: `${issuer}/jwks`, fetch: outbound }),
    userInfo: createUserInfo({ baseUrl: publicOrigin }),
    spa: await createSpaHandler({
      webDir: resolve(root, "apps/bbs/dist/client"),
      library,
      appOrigin,
    }),
    appOrigin,
    ping: async () => {},
  };
  const node = createApp(appDeps);
  const child = spawn(resolve(root, "target/debug/herkules-bbs"), [], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      APP_ORIGIN: appOrigin,
      PUBLIC_ORIGIN: publicOrigin,
      AUTH_INTERNAL_URL: publicOrigin,
      BBS_CLIENT_SECRET: clientSecret,
      BBS_COOKIE_SECRET: cookieSecret,
      BBS_RUST_LISTEN: "127.0.0.1:0",
      WEB_DIR: resolve(root, "apps/bbs/dist/client"),
      RUST_LOG: "info",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let checks = 0;
  try {
    const origin = await new Promise<string>((accept, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("Native Rust startup timed out")), 15000);
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Native Rust exited ${code}`));
      });
      child.stdout!.on("data", (b: Buffer) => {
        output += stripVTControlCharacters(b.toString());
        const match = /address=127\.0\.0\.1:(\d+)/.exec(output);
        if (match) {
          clearTimeout(timer);
          accept(`http://127.0.0.1:${match[1]}`);
        }
      });
      child.stderr!.on("data", (b: Buffer) => process.stderr.write(b));
    });
    const rustRequest = (path: string, init?: RequestInit) =>
      fetch(`${origin}${path}`, { ...init, redirect: "manual" });
    const testable = {
      request: ((input: string | Request, init?: RequestInit) => {
        const u = new URL(typeof input === "string" ? input : input.url, appOrigin);
        return rustRequest(u.pathname + u.search, init);
      }) as typeof node.app.request,
    };
    const nodeFetch = fetchVia(node.app);
    const paths = [
      "/api/articles?limit=2",
      `/api/articles/${ID.A}`,
      `/api/articles/${ID.A}/ai`,
      `/api/articles/${ID.PENDING}`,
      "/api/search?q=PID&limit=2",
      "/api/kb/browse?domain=控制",
      "/api/kb/entities?limit=2",
      "/api/kb/entities/PID",
      "/api/tags",
      "/api/viewer",
    ];
    for (const path of paths) {
      const a = await rustRequest(path);
      const b = await node.app.request(path);
      assert.equal(a.status, b.status, path);
      assert.deepEqual(await a.json(), await b.json(), path);
      checks++;
    }
    // Delegation must work with native auth enabled, including literal "key"
    // collisions and Unicode keys whose lowercase expansion is not idempotent.
    const delegated = withRustReads(library, { origin });
    await db.execute(
      sql`INSERT INTO kb_entities (key, name, article_count, updated_at) VALUES ('key', 'key', 1, now()), (${entityKey("İ")}, 'İ', 1, now())`,
    );
    await db.execute(
      sql`INSERT INTO article_entities (article_id, entity_key) VALUES (${ID.A}, 'key'), (${ID.A}, ${entityKey("İ")})`,
    );
    try {
      for (const name of ["PID", "İ", "key", "missing entity"]) {
        const key = entityKey(name);
        assert.deepEqual(
          await delegated.entity(key),
          await library.entity(key),
          `native adapter entity ${name}`,
        );
        checks++;
        assert.deepEqual(
          await delegated.entityHead(key),
          await library.entityHead(key),
          `native adapter entity head ${name}`,
        );
        checks++;
      }
    } finally {
      await db.execute(
        sql`DELETE FROM article_entities WHERE entity_key IN ('key', ${entityKey("İ")})`,
      );
      await db.execute(sql`DELETE FROM kb_entities WHERE key IN ('key', ${entityKey("İ")})`);
    }
    for (const format of ["text", "markdown", "html"]) {
      const path = `/api/articles/${ID.A}/content?format=${format}`;
      const a = await rustRequest(path);
      const b = await node.app.request(path);
      for (const h of ["content-type", "x-content-format", "x-content-type-options"])
        assert.equal(a.headers.get(h), b.headers.get(h), h);
      assert.equal(await a.text(), await b.text());
      checks++;
    }
    for (const path of [
      "/api/search?q=%22%22",
      "/api/articles?cursor=bad",
      "/api/articles/not-id",
      "/api/kb/entities?limit=-1",
      "/api/search?q=",
      "/api/articles?scope=oops",
    ]) {
      const a = await rustRequest(path);
      const b = await node.app.request(path);
      assert.equal(a.status, b.status, path);
      assert.equal(
        ((await a.json()) as { error: string }).error,
        ((await b.json()) as { error: string }).error,
        path,
      );
      checks++;
    }
    const token = await fake.mint({ audience: api, subject: "native-user" });
    const mcpToken = await fake.mint({ audience: mcp, subject: "native-user" });
    const proxy = createApp({ ...appDeps, nativeRustOrigin: origin });
    try {
      const response = await proxy.app.request("/api/articles?limit=2");
      assert.deepEqual(
        await response.json(),
        await (await rustRequest("/api/articles?limit=2")).json(),
      );
      checks++;
      assert.equal((await proxy.app.request("/")).status, 200, "Node still serves the feed SPA");
      checks++;
      const reader = await proxy.app.request(`/articles/${ID.A}`);
      assert.ok((await reader.text()).includes("ssr-reader"), "hard navigations use Askama reader");
      checks++;
      const signed = await fake.signIn(proxy.app, { subject: "native-user", next: "/account" });
      const viewer = await proxy.app.request("/api/me", { headers: { cookie: signed.cookie } });
      assert.equal(viewer.status, 200, "OAuth cookies survive the native proxy");
      assert.equal(((await viewer.json()) as { id: string }).id, "native-user");
      checks++;
      const viaProxy = fetchVia(proxy.app);
      const sdk = await connect(mcp, mcpToken, (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("host", new URL(publicOrigin).host);
        headers.set("transfer-encoding", "chunked");
        headers.set("connection", "keep-alive, x-hop-test");
        headers.set("x-hop-test", "connection-specific");
        return viaProxy(input, { ...init, headers });
      });
      try {
        assert.equal((await sdk.listTools()).tools.length, 10);
        checks++;
      } finally {
        await sdk.close();
      }
      assert.equal(
        (
          await proxy.app.request("/logout", { method: "POST", headers: { cookie: signed.cookie } })
        ).headers.getSetCookie().length,
        2,
      );
      checks++;
    } finally {
      await proxy.close();
    }

    for (const path of ["/api/me", "/api/viewer", "/api/articles?limit=1"]) {
      for (const authorization of [
        undefined,
        `Bearer ${token}`,
        `Bearer ${mcpToken}`,
        "Bearer junk",
        "DPoP x",
        "Bearer",
      ]) {
        const init = { headers: authorization ? { authorization } : {} };
        const a = await rustRequest(path, init);
        const b = await node.app.request(path, init);
        assert.equal(a.status, b.status, `${path} auth`);
        assert.deepEqual(await a.json(), await b.json());
        assert.equal(a.headers.get("www-authenticate"), b.headers.get("www-authenticate"));
        checks++;
      }
    }
    for (const badToken of [
      undefined,
      token,
      "garbage",
      await fake.mint({ audience: mcp, role: null }),
      await fake.mint({ audience: mcp, expiresIn: -120 }),
      await fake.mint({ audience: mcp, claims: { cnf: {} } }),
      await fake.mint({ audience: mcp, typ: "JWT" }),
      await fake.mint({ audience: mcp, signWith: "foreign" }),
    ]) {
      const a = await legacyCall(`${origin}/mcp/bbs`, badToken, fetch, "tools/list");
      const b = await legacyCall(mcp, badToken, nodeFetch, "tools/list");
      assert.equal(a.status, b.status);
      assert.equal(a.headers.get("www-authenticate"), b.headers.get("www-authenticate"));
      assert.deepEqual(await a.json(), await b.json());
      checks++;
    }
    const evilOrigin = await legacyCall(
      `${origin}/mcp/bbs`,
      mcpToken,
      (input, init) =>
        fetch(input, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init?.headers)),
            origin: "https://evil.example",
          },
        }),
      "tools/list",
    );
    assert.equal(evilOrigin.status, 403);
    checks++;
    const allowedOrigin = await legacyCall(
      `${origin}/mcp/bbs`,
      mcpToken,
      (input, init) =>
        fetch(input, {
          ...init,
          headers: { ...Object.fromEntries(new Headers(init?.headers)), origin: appOrigin },
        }),
      "tools/list",
    );
    assert.equal(allowedOrigin.status, 200);
    checks++;
    const rustClient = await connect(`${origin}/mcp/bbs`, mcpToken, fetch);
    const nodeClient = await connect(mcp, mcpToken, nodeFetch);
    try {
      assert.deepEqual(await rustClient.listTools(), await nodeClient.listTools());
      checks++;
      assert.deepEqual(
        await rustClient.listResourceTemplates(),
        await nodeClient.listResourceTemplates(),
      );
      checks++;
      assert.deepEqual(await rustClient.listResources(), await nodeClient.listResources());
      checks++;
      const calls = [
        { name: "search_articles", arguments: { query: " " } },
        { name: "search_articles", arguments: { query: "x".repeat(201) } },
        { name: "list_articles", arguments: { tag: "x".repeat(121) } },
        { name: "search_kb", arguments: { query: "x".repeat(201), domain: "x".repeat(65) } },
        { name: "list_entities", arguments: { query: "x".repeat(121) } },
        { name: "list_articles", arguments: { limit: 2 } },
        { name: "list_articles", arguments: { tag: "硬件/机器人硬件", limit: 1 } },
        { name: "list_articles", arguments: { cursor: "bad" } },
        { name: "search_articles", arguments: { query: "PID" } },
        { name: "search_articles", arguments: { query: '""' } },
        { name: "get_article", arguments: { id: ID.A } },
        {
          name: "get_article",
          arguments: {
            id: ID.A.toLowerCase(),
            include: ["content", "overview", "kb", "images", "links"],
            format: "markdown",
            max_chars: 8,
            offset: 1,
          },
        },
        { name: "get_article", arguments: { id: "bad" } },
        { name: "get_overview", arguments: { id: ID.A } },
        { name: "get_overview", arguments: { id: ID.C } },
        { name: "get_kb", arguments: { id: ID.A } },
        { name: "search_kb", arguments: { domain: "控制", limit: 2 } },
        { name: "list_entities", arguments: {} },
        { name: "get_entity", arguments: { name: "PID", compact: false } },
        { name: "get_entity", arguments: { name: "missing" } },
        { name: "list_tags", arguments: {} },
        { name: "library_status", arguments: {} },
      ];
      for (const call of calls) {
        assert.deepEqual(
          await rustClient.callTool(call),
          await nodeClient.callTool(call),
          call.name,
        );
        checks++;
      }
      for (const uri of [
        `rm://articles/${ID.A}`,
        `rm://articles/${ID.A}/overview`,
        `rm://articles/${ID.A}/kb`,
      ]) {
        const a = await rustClient.readResource({ uri });
        const b = await nodeClient.readResource({ uri });
        // JSON object key order is immaterial inside resource JSON text.
        if (a.contents[0]?.mimeType === "application/json") {
          const av = a.contents[0] as { text: string };
          const bv = b.contents[0] as { text: string };
          assert.deepEqual(JSON.parse(av.text), JSON.parse(bv.text));
          av.text = bv.text;
        }
        assert.deepEqual(a, b);
        checks++;
      }
      for (const call of [
        { name: "list_articles", arguments: { limit: 0 } },
        { name: "get_article", arguments: {} },
        { name: "get_article", arguments: { id: ID.A, include: ["bad"] } },
      ]) {
        await assert.rejects(() => rustClient.callTool(call));
        checks++;
      }
    } finally {
      await rustClient.close();
      await nodeClient.close();
    }
    assert.ok(jwksCalls <= 3, `JWKS cached, got ${jwksCalls}`);
    checks++;
    // Login both directions verifies Node <-> Rust cookie interoperability.
    for (const app of [node.app, testable]) {
      const signed = await fake.signIn(app, { subject: "native-user", next: "/kb" });
      assert.equal(signed.location, "/kb");
      for (const request of [
        rustRequest,
        (path: string, init?: RequestInit) => node.app.request(path, init),
      ]) {
        const r = await request("/api/me", { headers: { cookie: signed.cookie } });
        assert.equal(r.status, 200);
        assert.equal(((await r.json()) as { id: string }).id, "native-user");
        checks++;
      }
    }
    const unicodeLogin = await fake.signIn(testable, {
      subject: "native-user",
      next: "/kb?query=机械",
    });
    assert.equal(unicodeLogin.location, "/kb?query=%E6%9C%BA%E6%A2%B0");
    checks++;
    const expiredLoginCookie = (
      await jarForTests(cookieSecret).writeLogin({
        attempts: [
          {
            state: "expired",
            codeVerifier: "verifier",
            next: safePath("/"),
            issuedAt: Date.now() - 600001,
          },
        ],
      })
    ).split(";")[0]!;
    const oldCallback = await rustRequest("/callback?state=expired&code=unused", {
      headers: { cookie: expiredLoginCookie },
    });
    assert.equal(oldCallback.headers.get("location"), "/account?login_error=invalid_state");
    checks++;
    const start1 = await rustRequest("/login?next=//evil.example");
    const cookie1 = absorbCookies("", start1);
    const u1 = new URL(start1.headers.get("location")!);
    assert.equal(u1.searchParams.get("resource"), api);
    assert.equal(u1.searchParams.get("code_challenge_method"), "S256");
    const start2 = await rustRequest("/login?next=/tags", { headers: { cookie: cookie1 } });
    const cookie2 = absorbCookies(cookie1, start2);
    const back1 = (await fake.fetch(u1)).headers.get("location")!;
    const done1 = await rustRequest(new URL(back1).pathname + new URL(back1).search, {
      headers: { cookie: cookie2 },
    });
    assert.equal(done1.headers.get("location"), "/");
    const after1 = absorbCookies(cookie2, done1);
    const replay = await rustRequest(new URL(back1).pathname + new URL(back1).search, {
      headers: { cookie: after1 },
    });
    assert.equal(replay.headers.get("location"), "/account?login_error=invalid_state");
    checks++;
    const back2 = (await fake.fetch(start2.headers.get("location")!)).headers.get("location")!;
    const done2 = await rustRequest(new URL(back2).pathname + new URL(back2).search, {
      headers: { cookie: after1 },
    });
    assert.equal(done2.headers.get("location"), "/tags");
    checks++;
    const jar = jarForTests(cookieSecret);
    const wrongCookie = (
      await jar.writeSession({ accessToken: mcpToken, refreshToken: "unused" })
    ).split(";")[0]!;
    const wrong = await rustRequest("/api/viewer", { headers: { cookie: wrongCookie } });
    assert.deepEqual(await wrong.json(), { viewer: null });
    assert.ok(wrong.headers.getSetCookie().some((c) => c.includes("Max-Age=0")));
    checks++;
    fake.accessTokenTtlSeconds = -120;
    const expired = await fake.signIn(testable, { subject: "native-user" });
    fake.accessTokenTtlSeconds = 900;
    const before = fake.grants.length;
    const tabs = await Promise.all(
      Array.from({ length: 10 }, () =>
        rustRequest("/api/me", { headers: { cookie: expired.cookie } }),
      ),
    );
    assert.equal(fake.grants.length - before, 1, "ten tabs share one refresh");
    for (const r of tabs) {
      assert.equal(r.status, 200);
      assert.equal(((await r.json()) as { id: string }).id, "native-user");
      assert.ok(r.headers.getSetCookie().some((s) => s.startsWith("__Host-hk_session=")));
    }
    const remembered = await rustRequest("/api/me", { headers: { cookie: expired.cookie } });
    assert.equal(remembered.status, 200);
    assert.equal(fake.grants.length - before, 1);
    checks++;
    const renewed = absorbCookies(expired.cookie, remembered);
    const explicit = await rustRequest("/api/viewer", {
      headers: { cookie: renewed, authorization: "Bearer invalid" },
    });
    assert.equal(explicit.status, 401);
    assert.equal(explicit.headers.getSetCookie().length, 0);
    checks++;
    const logout = await rustRequest("/logout", {
      method: "POST",
      headers: { cookie: renewed, "content-type": "application/x-www-form-urlencoded" },
      body: "next=%2Ftags",
    });
    assert.equal(logout.headers.get("location"), "/tags");
    assert.equal(logout.headers.getSetCookie().length, 2);
    assert.equal((await rustRequest("/logout")).status, 405);
    checks++;
    const denied = await rustRequest("/api/me", {
      headers: { cookie: absorbCookies(renewed, logout) },
    });
    assert.equal(denied.status, 401);
    checks++;
    fake.accessTokenTtlSeconds = -120;
    const outageCookie = (await fake.signIn(testable, { subject: "native-user" })).cookie;
    offline = true;
    const anonymous = await rustRequest("/api/viewer", { headers: { cookie: outageCookie } });
    assert.equal(anonymous.status, 200);
    assert.deepEqual(await anonymous.json(), { viewer: null });
    assert.equal(anonymous.headers.getSetCookie().length, 0);
    assert.equal((await rustRequest("/api/me", { headers: { cookie: outageCookie } })).status, 503);
    checks++;
    assert.equal(
      (await rustRequest("/api/me", { headers: { authorization: `Bearer ${token}` } })).status,
      200,
      "cached JWKS during issuer outage",
    );
    checks++;
    offline = false;
    // Only REST article reads queue stale refreshes; MCP and other reads don't.
    await db.execute(sql`update articles set refresh_requested_at = null where id = ${ID.A}`);
    const hookClient = await connect(`${origin}/mcp/bbs`, mcpToken, fetch);
    try {
      await hookClient.callTool({ name: "get_article", arguments: { id: ID.A } });
    } finally {
      await hookClient.close();
    }
    const refreshRows = () =>
      db
        .select({ refresh_requested_at: articles.refreshRequestedAt })
        .from(articles)
        .where(eq(articles.id, ID.A));
    let rows = await refreshRows();
    assert.equal(rows[0]!.refresh_requested_at, null);
    await rustRequest(`/api/articles/${ID.A}`);
    rows = await refreshRows();
    assert.ok(rows[0]!.refresh_requested_at);
    const stamp = rows[0]!.refresh_requested_at;
    await rustRequest(`/api/articles/${ID.A}`);
    rows = await refreshRows();
    assert.deepEqual(rows[0]!.refresh_requested_at, stamp);
    checks++;
    console.log(`Rust native REST/MCP/OAuth parity: ${checks} checks passed`);
    return checks;
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
    await node.close();
    await new Promise<void>((done) => issuerServer.close(() => done()));
  }
}

function jarForTests(secret: string) {
  return createCookieJar({
    sealer: createSealer(secret, "bbs"),
    secure: true,
    now: () => new Date(),
  });
}
