import { createHash, randomBytes } from "node:crypto";
import { decodeJwt } from "jose";
import { afterAll, expect, test } from "vite-plus/test";
import { ensureFirstPartyClients } from "../src/clients.ts";
import { loadConfig } from "../src/config.ts";
import { createTestService } from "../src/testing.ts";

const portal = "https://ai-portal.example.test";
const secret = "ai-client-secret-".padEnd(48, "x");
const syncSecret = "ai-sync-secret-".padEnd(48, "x");
const t = await createTestService({
  env: { AI_PORTAL_ORIGIN: portal, AI_CLIENT_SECRET: secret, AI_SYNC_SECRET: syncSecret },
});
afterAll(() => t.close());

test("the ai client signs a member in with PKCE and receives an api/ai token", async () => {
  t.github.user({ id: 10, login: "ai-user", org: "active" });
  const login = await t.login("ai-user");
  if (!login.ok) throw new Error("login failed");
  const audience = `${t.origin}/api/ai`;
  expect(t.service.registry.byAudience(audience)?.title).toBe("Herkules AI");
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: "ai",
    redirect_uri: `${portal}/callback`,
    resource: audience,
    scope: "offline_access",
    state: "state-1",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const authorize = await t.app.request(`${t.issuer}/oauth2/authorize?${query}`, {
    headers: { cookie: login.cookie },
    redirect: "manual",
  });
  expect(authorize.status, await authorize.clone().text()).toBe(302);
  const location = new URL(authorize.headers.get("location")!);
  expect(location.origin + location.pathname).toBe(`${portal}/callback`);
  const exchange = await t.app.request(`${t.issuer}/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`ai:${secret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: location.searchParams.get("code")!,
      redirect_uri: `${portal}/callback`,
      code_verifier: verifier,
    }).toString(),
  });
  const tokens = (await exchange.json()) as { access_token: string; refresh_token?: string };
  expect(exchange.status, JSON.stringify(tokens)).toBe(200);
  expect(tokens.refresh_token).toBeTruthy();
  expect(decodeJwt(tokens.access_token)).toMatchObject({ aud: audience, sub: login.userId });
});

test("membership status requires the dedicated secret and denies missing or disabled users", async () => {
  t.github.user({ id: 11, login: "active-ai", org: "active" });
  t.github.user({ id: 12, login: "disabled-ai", org: "active" });
  const active = await t.login("active-ai");
  const disabled = await t.login("disabled-ai");
  if (!active.ok || !disabled.ok) throw new Error("login failed");
  await t.service.users.setDisabled({ kind: "system", job: "ai-test" }, disabled.userId, true);
  const request = (authorization?: string, body: unknown = { ids: [] }) =>
    t.app.request("/auth/internal/ai-membership", {
      method: "POST",
      headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
      body: JSON.stringify(body),
    });
  expect((await request()).status).toBe(401);
  expect((await request("Bearer incorrect")).status).toBe(401);
  expect((await request(`Bearer ${syncSecret}`, { ids: "x" })).status).toBe(400);
  const answer = await request(`Bearer ${syncSecret}`, {
    ids: [active.userId, disabled.userId, "missing"],
  });
  expect(answer.headers.get("cache-control")).toBe("no-store");
  expect(await answer.json()).toEqual({
    users: [
      { id: active.userId, enabled: true },
      { id: disabled.userId, enabled: false },
      { id: "missing", enabled: false },
    ],
  });
});

test("client reconciliation disables the retired New API login", async () => {
  const { db, config } = t.service;
  const clientId = "herkules-ai";
  const callback = "https://ai-portal.example.test/oauth/herkules";
  const now = () => t.clock.now();
  expect(await db.clients.byId(clientId)).toBeUndefined();
  await db.clients.insert({
    id: crypto.randomUUID(),
    clientId,
    name: "Herkules AI",
    clientSecret: "unused-test-secret",
    redirectUris: [callback],
    skipConsent: true,
    tokenEndpointAuthMethod: "client_secret_basic",
    applicationType: "web",
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    requirePKCE: false,
    disabled: false,
    createdAt: now(),
    updatedAt: now(),
  });

  t.github.user({ id: 13, login: "ai-member", org: "active" });
  const login = await t.login("ai-member");
  if (!login.ok) throw new Error("login failed");
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callback,
    response_type: "code",
    scope: "openid email profile",
    state: "test-state",
  });
  const authorize = () => t.fetch(`/auth/oauth2/authorize?${query}`, { cookie: login.cookie });
  expect((await authorize()).headers.get("location")).toMatch(
    /^https:\/\/ai-portal\.example\.test\//,
  );

  await ensureFirstPartyClients(db, config, now);
  const rejected = await authorize();
  expect(rejected.headers.get("location") ?? "").not.toContain(callback);
});

for (let mask = 0; mask < 8; mask++) {
  test(`AI configuration is all-or-nothing (mask ${mask})`, () => {
    const env = {
      PUBLIC_ORIGIN: "https://herkules.example.test",
      AUTH_SECRET: secret,
      DATABASE_URL: "pglite://memory",
      GITHUB_CLIENT_ID: "test",
      GITHUB_CLIENT_SECRET: "test",
      GITHUB_ORG: "test",
      AI_PORTAL_ORIGIN: mask & 1 ? portal : "",
      AI_CLIENT_SECRET: mask & 2 ? secret : "",
      AI_SYNC_SECRET: mask & 4 ? syncSecret : "",
    };
    if (mask === 0 || mask === 7) expect(() => loadConfig(env)).not.toThrow();
    else expect(() => loadConfig(env)).toThrow("must be set together or not at all");
  });
}
