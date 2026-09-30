import { createHash, randomBytes } from "node:crypto";
import { mcpResource } from "@herkules/auth-middleware";
import { toAuthInfo } from "@herkules/auth-middleware/mcp";
import { createUserInfo, UserInfoError } from "@herkules/auth-middleware/userinfo";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import { FEISHU_DOMAIN, FEISHU_SCOPES, MCP_PATH, type Config } from "./config.ts";
import { ConnectionError, type Grants } from "./grants.ts";
import type { Seal } from "./seal.ts";
import { createTools } from "./tools.ts";

const stateSchema = z.object({
  subject: z.string(),
  state: z.string(),
  verifier: z.string(),
  expires: z.number(),
});
const sessionSchema = z.object({
  session: z.object({ impersonatedBy: z.string().nullish() }),
  user: z.object({ id: z.string(), banned: z.boolean().nullish() }),
});
const cookieName = "herkules-feishu-oauth";

export function createApp(
  config: Config,
  grants: Grants,
  seal: Seal,
  fetchImpl = globalThis.fetch,
) {
  const app = new Hono();
  const auth = mcpResource({
    resource: `${config.PUBLIC_ORIGIN}${MCP_PATH}`,
    issuer: `${config.PUBLIC_ORIGIN}/auth`,
    jwksUrl: `${config.AUTH_INTERNAL_URL}/auth/jwks`,
    fetch: fetchImpl,
  });
  const users = createUserInfo({ baseUrl: config.AUTH_INTERNAL_URL, fetch: fetchImpl });
  const tools = createTools(config, grants);
  const callback = `${config.PUBLIC_ORIGIN}${MCP_PATH}/callback`;
  const cookieOptions = {
    path: `${MCP_PATH}/callback`,
    httpOnly: true,
    secure: config.PUBLIC_ORIGIN.startsWith("https:"),
    sameSite: "Lax" as const,
    maxAge: 600,
  };

  async function session(request: Request): Promise<string | undefined> {
    const cookie = request.headers.get("cookie");
    if (!cookie) return undefined;
    const response = await fetchImpl(`${config.AUTH_INTERNAL_URL}/auth/get-session`, {
      headers: { cookie },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return undefined;
    const parsed = sessionSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.user.banned || parsed.data.session.impersonatedBy)
      return undefined;
    const member = await fetchImpl(`${config.AUTH_INTERNAL_URL}/auth/api/me`, {
      headers: { cookie },
      signal: AbortSignal.timeout(5000),
    });
    const caller = z
      .object({ kind: z.literal("session"), userId: z.string() })
      .safeParse(await member.json());
    return member.ok && caller.success && caller.data.userId === parsed.data.user.id
      ? caller.data.userId
      : undefined;
  }

  app.onError(() => new Response("Service unavailable. Please try again.", { status: 503 }));
  app.use(`${MCP_PATH}/*`, async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    );
    await next();
  });
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get(`${MCP_PATH}/connect`, async (c) => {
    const subject = await session(c.req.raw);
    if (!subject) return c.redirect(`/login?next=${encodeURIComponent(`${MCP_PATH}/connect`)}`);
    const connected = await grants.connected(subject);
    return c.html(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Feishu · Herkules</title><style>body{font:17px system-ui;max-width:680px;margin:64px auto;padding:24px;line-height:1.6}button{font:inherit;padding:10px 20px;cursor:pointer}code{overflow-wrap:anywhere}form{margin:24px 0}</style><h1>Connect your Feishu account</h1><p>${connected ? "Your account is connected." : "Authorize Feishu to use this connector."} Each Herkules member connects their own account. User tools access your data; tools prefixed <code>bot_</code> use the shared application identity.</p><p>Hosted MCP URL: <code>${config.PUBLIC_ORIGIN}${MCP_PATH}</code></p><form method="post" action="${MCP_PATH}/connect"><button>${connected ? "Reconnect Feishu" : "Authorize Feishu"}</button></form>${connected ? `<form method="post" action="${MCP_PATH}/disconnect"><button>Disconnect my account</button></form>` : ""}<p>Disconnecting removes your saved grant from Herkules. You can also revoke application access in Feishu.</p></html>`,
    );
  });
  app.post(`${MCP_PATH}/connect`, async (c) => {
    if (c.req.header("origin") !== config.PUBLIC_ORIGIN) return c.text("Invalid origin", 403);
    const subject = await session(c.req.raw);
    if (!subject) return c.text("Sign in first", 401);
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    setCookie(
      c,
      cookieName,
      seal.encrypt({ subject, state, verifier, expires: Date.now() + 600000 }, "oauth-state"),
      cookieOptions,
    );
    const url = new URL(`${FEISHU_DOMAIN}/open-apis/authen/v1/authorize`);
    url.search = new URLSearchParams({
      client_id: config.FEISHU_APP_ID,
      response_type: "code",
      redirect_uri: callback,
      scope: FEISHU_SCOPES.join(" "),
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    return c.redirect(url.toString());
  });
  app.get(`${MCP_PATH}/callback`, async (c) => {
    const sealed = getCookie(c, cookieName);
    deleteCookie(c, cookieName, cookieOptions);
    let state;
    try {
      state = stateSchema.parse(seal.decrypt(sealed ?? "", "oauth-state"));
    } catch {
      return c.text("Authorization expired. Start again from the connection page.", 400);
    }
    const subject = await session(c.req.raw);
    if (
      !subject ||
      subject !== state.subject ||
      state.expires < Date.now() ||
      c.req.query("state") !== state.state ||
      !c.req.query("code")
    )
      return c.text("Authorization did not match your current account. Start again.", 400);
    try {
      await grants.authorize(subject, c.req.query("code")!, state.verifier, callback);
    } catch (error) {
      return c.text(
        error instanceof ConnectionError
          ? error.message
          : "Authorization failed. Please reconnect.",
        400,
      );
    }
    return c.redirect(`${MCP_PATH}/connect`);
  });
  app.post(`${MCP_PATH}/disconnect`, async (c) => {
    if (c.req.header("origin") !== config.PUBLIC_ORIGIN) return c.text("Invalid origin", 403);
    const subject = await session(c.req.raw);
    if (!subject) return c.text("Sign in first", 401);
    await grants.disconnect(subject);
    return c.redirect(`${MCP_PATH}/connect`, 303);
  });
  app.all(MCP_PATH, async (c) => {
    const outcome = await auth.authenticate(c.req.raw);
    if (!outcome.ok) return outcome.response;
    try {
      const caller = await users.me(outcome.principal.token);
      if (caller.kind !== "token" || caller.userId !== outcome.principal.subject)
        return auth.deny.permission("Account unavailable");
    } catch (error) {
      return error instanceof UserInfoError && (error.status === 401 || error.status === 403)
        ? auth.deny.permission("Account unavailable")
        : auth.deny.unavailable();
    }
    const server = tools(outcome.principal.subject);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw, { authInfo: toAuthInfo(outcome.principal) });
    } finally {
      await server.close();
    }
  });
  return app;
}
