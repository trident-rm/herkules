import { createTestIssuer } from "@herkules/auth-middleware/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test } from "vite-plus/test";
import { createApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import type { Grants } from "../src/grants.ts";
import { createSeal } from "../src/seal.ts";

const config: Config = {
  PUBLIC_ORIGIN: "https://herkules.test",
  AUTH_INTERNAL_URL: "https://herkules.test",
  PORT: 3005,
  FEISHU_APP_ID: "app",
  FEISHU_APP_SECRET: "secret",
  FEISHU_TENANT_KEY: "team",
  FEISHU_STORAGE_KEY: "aa".repeat(32),
  GRANTS_DIR: "/unused",
};
async function fixture() {
  const issuer = await createTestIssuer({ issuer: `${config.PUBLIC_ORIGIN}/auth` });
  let subject = "alice";
  let disabled = false;
  const authorized: string[] = [];
  const grants: Grants = {
    connected: async (id) => id === "alice",
    disconnect: async () => {},
    accessToken: async () => {
      throw new Error("must not fetch upstream");
    },
    authorize: async (id) => {
      authorized.push(id);
    },
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.endsWith("/jwks")) return issuer.fetch(input, init);
    if (url.endsWith("/get-session"))
      return Response.json({ session: {}, user: { id: subject, banned: disabled } });
    if (url.endsWith("/api/me"))
      return disabled
        ? Response.json({}, { status: 403 })
        : Response.json(
            init?.headers && new Headers(init.headers).has("authorization")
              ? {
                  kind: "token",
                  userId: "alice",
                  role: "member",
                  clientId: "client",
                  audiences: [`${config.PUBLIC_ORIGIN}/mcp/feishu`],
                  jti: "jti",
                }
              : { kind: "session", userId: subject },
          );
    throw new Error("unexpected fetch");
  };
  const app = createApp(config, grants, createSeal(Buffer.alloc(32, 4)), fetch);
  return {
    issuer,
    app,
    authorized,
    disable: () => {
      disabled = true;
    },
    switchUser: () => {
      subject = "bob";
    },
  };
}

test("requires exact resource audience and refuses disabled members", async () => {
  const f = await fixture();
  const missing = await f.app.request("/mcp/feishu");
  expect(missing.status).toBe(401);
  expect(missing.headers.get("www-authenticate")).toContain("oauth-protected-resource/mcp/feishu");
  const wrong = await f.issuer.mint({
    audience: `${config.PUBLIC_ORIGIN}/mcp/bbs`,
    subject: "alice",
  });
  expect(
    (await f.app.request("/mcp/feishu", { headers: { authorization: `Bearer ${wrong}` } })).status,
  ).toBe(401);
  const right = await f.issuer.mint({
    audience: `${config.PUBLIC_ORIGIN}/mcp/feishu`,
    subject: "alice",
  });
  f.disable();
  expect(
    (await f.app.request("/mcp/feishu", { headers: { authorization: `Bearer ${right}` } })).status,
  ).toBe(403);
});

test("serves the official tool catalog through stateless streamable HTTP", async () => {
  const f = await fixture();
  const token = await f.issuer.mint({
    audience: `${config.PUBLIC_ORIGIN}/mcp/feishu`,
    subject: "alice",
  });
  const client = new Client({ name: "test", version: "1" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${config.PUBLIC_ORIGIN}/mcp/feishu`),
    {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: async (input, init) => f.app.fetch(new Request(input, init)),
    },
  );
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(26);
    expect(tools.some((tool) => tool.name === "calendar_v4_calendar_primary")).toBe(true);
    expect(tools.some((tool) => tool.name === "bot_im_v1_message_create")).toBe(true);
    const result = await client.callTool({ name: "feishu_connection_status" });
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          connected: true,
          setupUrl: `${config.PUBLIC_ORIGIN}/mcp/feishu/connect`,
        }),
      },
    ]);
  } finally {
    await client.close();
  }
});

test("rejects cross-origin authorization and account-switched callbacks", async () => {
  const f = await fixture();
  const headers = { cookie: "session=test", origin: config.PUBLIC_ORIGIN };
  expect(
    (
      await f.app.request("/mcp/feishu/connect", {
        method: "POST",
        headers: { ...headers, origin: "https://other.test" },
      })
    ).status,
  ).toBe(403);
  const start = await f.app.request("/mcp/feishu/connect", { method: "POST", headers });
  expect(start.status).toBe(302);
  const location = new URL(start.headers.get("location")!);
  expect(location.searchParams.get("code_challenge_method")).toBe("S256");
  const cookie = start.headers.get("set-cookie")!.split(";")[0];
  f.switchUser();
  const response = await f.app.request(
    `/mcp/feishu/callback?code=test&state=${location.searchParams.get("state")}`,
    { headers: { cookie: `session=test; ${cookie}` } },
  );
  expect(response.status).toBe(400);
  expect(f.authorized).toEqual([]);
});
