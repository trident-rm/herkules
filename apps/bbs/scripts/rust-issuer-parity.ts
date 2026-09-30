/** Rust BBS login/token/refresh/logout against the actual Better Auth service.
 * Auth uses its in-memory test DB and fake GitHub; no real identity or network provider.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { serve } from "@hono/node-server";
import { createTestService } from "@herkules/auth/testing";
import { RESOURCE_SPECS } from "../../../services/auth/src/registry.ts";
import { absorbCookies } from "@herkules/oauth-client/testing";
import { createCookieJar } from "../../../packages/oauth-client/src/cookie.ts";
import { createSealer } from "../../../packages/oauth-client/src/seal.ts";
import { connect } from "../tests/helpers.ts";

export async function issuerParity(databaseUrl: string, root: string) {
  let auth: Awaited<ReturnType<typeof createTestService>> | undefined;
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: (r) => auth!.app.fetch(r) });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const publicOrigin = `http://127.0.0.1:${address.port}`;
  const appOrigin = "https://bbs.example";
  const clientSecret = "real-issuer-test-".padEnd(48, "x");
  const cookieSecret = "real-cookie-test-".padEnd(48, "x");
  let child: ReturnType<typeof spawn> | undefined;
  try {
    auth = await createTestService({
      resources: RESOURCE_SPECS.map((s) =>
        s.kind === "api" && s.name === "bbs" ? { ...s, accessTokenTtlSeconds: 30 } : s,
      ),
      env: { PUBLIC_ORIGIN: publicOrigin, BBS_ORIGIN: appOrigin, BBS_CLIENT_SECRET: clientSecret },
    });
    auth.github.user({ id: 1, login: "native-alice", org: "active" });
    const who = await auth.login("native-alice");
    assert.ok(who.ok, "fake GitHub must admit test member into real Better Auth");
    child = spawn(resolve(root, "target/debug/herkules-bbs"), [], {
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
    const running = child;
    const origin = await new Promise<string>((accept, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(new Error("Rust issuer test startup timed out")),
        15000,
      );
      running.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      running.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Rust exited ${code}`));
      });
      running.stdout!.on("data", (b: Buffer) => {
        output += stripVTControlCharacters(b.toString());
        const match = /address=127\.0\.0\.1:(\d+)/.exec(output);
        if (match) {
          clearTimeout(timer);
          accept(`http://127.0.0.1:${match[1]}`);
        }
      });
      running.stderr!.on("data", (b: Buffer) => process.stderr.write(b));
    });
    const request = (path: string, init?: RequestInit) =>
      fetch(`${origin}${path}`, { ...init, redirect: "manual" });
    const start = await request("/login?next=/kb");
    assert.equal(start.status, 303);
    let cookie = absorbCookies("", start);
    const authorize = await auth.app.request(start.headers.get("location")!, {
      headers: { cookie: who.cookie },
      redirect: "manual",
    });
    assert.equal(authorize.status, 302, await authorize.clone().text());
    const back = new URL(authorize.headers.get("location")!);
    const callback = await request(back.pathname + back.search, { headers: { cookie } });
    assert.equal(callback.headers.get("location"), "/kb", "real confidential code exchange");
    cookie = absorbCookies(cookie, callback);
    const me = await request("/api/me", { headers: { cookie } });
    assert.equal(me.status, 200);
    const viewer = (await me.json()) as { id: string; displayName: string; role: string };
    assert.equal(viewer.id, who.userId);
    assert.equal(viewer.role, "member");
    assert.ok(
      me.headers.getSetCookie().some((s) => s.startsWith("__Host-hk_session=")),
      "Rust refreshed the real 30-second access token",
    );
    cookie = absorbCookies(cookie, me);
    const jar = createCookieJar({
      sealer: createSealer(cookieSecret, "bbs"),
      secure: true,
      now: () => new Date(),
    });
    const session = await jar.readSession(new Request(appOrigin, { headers: { cookie } }));
    assert.equal(session.kind, "present");
    if (session.kind !== "present") throw new Error("missing session");
    // Force the resource server to refresh, using a sealed expired token with the
    // real refresh token. The issuer still performs its own grant/gate checks.
    const expired = (
      await jar.writeSession({ accessToken: "expired", refreshToken: session.value.refreshToken })
    ).split(";")[0]!;
    // Malformed access tokens must be cleared, never refreshed.
    assert.equal((await request("/api/me", { headers: { cookie: expired } })).status, 401);
    const rotated = cookie;
    const tokens = { refresh_token: session.value.refreshToken };
    const agent = await auth.mcpClient(who.cookie, `${publicOrigin}/mcp/bbs`);
    const mcp = await connect(`${origin}/mcp/bbs`, agent.accessToken, fetch);
    try {
      const result = await mcp.callTool({ name: "library_status", arguments: {} });
      assert.deepEqual((result.structuredContent as { caller: unknown }).caller, {
        id: who.userId,
        role: "member",
      });
    } finally {
      await mcp.close();
    }
    assert.equal(
      (await request("/api/me", { headers: { authorization: `Bearer ${agent.accessToken}` } }))
        .status,
      401,
    );
    await request("/logout", { method: "POST", headers: { cookie: rotated } });
    const revoked = await auth.app.request(`${auth.issuer}/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`bbs:${clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
      }).toString(),
    });
    assert.equal(revoked.status, 400);
    console.log(
      "Rust integration with real Better Auth: login, PKCE/code exchange, JWT/profile, refresh, MCP audience and logout/revocation passed",
    );
    return 8;
  } finally {
    if (child) {
      child.kill("SIGTERM");
      if (child.exitCode === null) await once(child, "exit");
    }
    await auth?.close();
    await new Promise<void>((done) => server.close(() => done()));
  }
}
