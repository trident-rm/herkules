import { afterAll, expect, test } from "vite-plus/test";
import { ensureFirstPartyClients } from "../src/clients.ts";
import { createTestService } from "../src/testing.ts";

const t = await createTestService();
afterAll(() => t.close());

test("client reconciliation disables an existing New API login", async () => {
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

  t.github.user({ id: 11, login: "ai-member", org: "active" });
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
