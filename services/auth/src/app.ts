/**
 * The Hono app: the complete HTTP surface of services/auth, in route order.
 * Routes we own come first; everything else under /auth/* and /.well-known/*
 * is Better Auth's. This is the file to read to answer "who serves X".
 *
 * Call chains: app -> users/bearer -> db (3 files); app -> registry (2); app -> auth (Better Auth).
 */
import { metadataResponse } from "@better-auth/oauth-provider";
import { Hono } from "hono";
import { z } from "zod";

import type { Actor, AuditType } from "./audit.ts";
import { CursorError } from "./audit.ts";
import type { Auth } from "./auth.ts";
import type { Avatars } from "./avatars.ts";
import type { Bearer, Caller } from "./bearer.ts";
import { FIRST_PARTY_CLIENTS } from "./clients.ts";
import { MergeError, type Merges } from "./db/merges.ts";
import type { Config } from "./config.ts";
import type { Registry } from "./registry.ts";
import type { Users } from "./users.ts";
import { UsersError } from "./users.ts";

export interface AppDeps {
  readonly merges: Merges;
  readonly config: Config;
  readonly auth: Auth;
  readonly registry: Registry;
  readonly users: Users;
  readonly bearer: Bearer;
  readonly avatars: Avatars;
  /** Liveness: DB reachable and the JWKS has a key. */
  readonly healthy: () => Promise<boolean>;
}

type Env = { Variables: { caller: Caller } };

const roleSchema = z.enum(["admin", "member"]);
const batchSchema = z.object({ ids: z.array(z.string().min(1)).max(100) });
const roleBody = z.object({ role: roleSchema });
const disabledBody = z.object({ disabled: z.boolean(), reason: z.string().max(500).optional() });
const allowlistBody = z.object({ note: z.string().max(500).optional() }).default({});
const auditQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  type: z.string().optional(),
  userId: z.string().optional(),
});
const listQuery = z.object({
  search: z.string().max(100).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

const actorOf = (caller: Caller): Actor => ({ kind: "user", userId: caller.userId });

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const { auth, registry, users, bearer, avatars } = deps;

  // ── Resource servers and MCP clients (no auth) ─────────────────────────────
  // RFC 9728 PRM for EVERY registry entry, including the canonical one (so one code path builds all documents).
  // Registered before the Better Auth catch-all below, so the mcp plugin's own PRM route is shadowed on purpose.
  app.on(["GET", "HEAD"], "/.well-known/oauth-protected-resource/*", (c) => {
    const entry = registry.byMetadataPathname(new URL(c.req.url).pathname);
    if (!entry) return c.notFound();
    const res = metadataResponse(registry.metadataFor(entry));
    return c.req.method === "HEAD"
      ? new Response(null, { status: res.status, headers: res.headers })
      : res;
  });
  // AS metadata (root path-inserted alias and /auth/.well-known/*) and JWKS: Better Auth's plugin onRequest answers these.
  app.on(["GET", "HEAD"], "/.well-known/*", (c) => auth.handler(c.req.raw));

  app.get("/auth/login-options", (c) =>
    c.json({ feishu: !!deps.config.FEISHU_APP_ID, github: true }),
  );
  app.get("/auth/healthz", async (c) => {
    const ok = await deps.healthy().catch(() => false);
    return c.json({ ok }, ok ? 200 : 503);
  });
  app.on(["GET", "HEAD"], "/auth/avatars/:userId", (c) =>
    avatars.serve(c.req.param("userId"), c.req.raw),
  );

  // Account merging needs a browser session, never a downstream bearer token.
  // Require exact Origin on mutations; these routes are outside Better Auth's CSRF middleware.
  app.on(["GET", "POST", "DELETE"], "/auth/identity-merge", async (c) => {
    c.header("Cache-Control", "no-store");
    if (c.req.method !== "GET" && c.req.header("origin") !== deps.config.PUBLIC_ORIGIN)
      return c.json({ error: "invalid_origin" }, 403);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session || (session.user as Record<string, unknown>).banned)
      return c.json({ error: "unauthorized" }, 401);
    try {
      if (c.req.method === "GET")
        return c.json(await deps.merges.preview(session.session.id, session.user.id));
      if (c.req.method === "DELETE") {
        await deps.merges.cancel(session.session.id);
        return c.json({ ok: true });
      }
      const body = z
        .object({ id: z.string().uuid() })
        .safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "invalid_request" }, 400);
      return c.json(await deps.merges.confirm(session.session.id, session.user.id, body.data.id));
    } catch (error) {
      if (error instanceof MergeError)
        return c.json({ error: error.code, error_description: error.message }, 409);
      throw error;
    }
  });

  // ── Our API: session cookie or any-audience herkules JWT ───────────────────
  const api = new Hono<Env>();
  api.onError((err, c) => {
    if (err instanceof UsersError)
      return c.json({ error: err.code, error_description: err.message }, err.status);
    // A cursor this service cannot parse is the client's mistake, not a 500.
    if (err instanceof CursorError)
      return c.json({ error: "invalid_request", error_description: err.message }, 400);
    if (err instanceof z.ZodError)
      return c.json({ error: "invalid_request", error_description: z.prettifyError(err) }, 400);
    throw err;
  });
  const identified =
    (role?: "admin") =>
    async (
      c: { req: { raw: Request }; set: (k: "caller", v: Caller) => void },
      next: () => Promise<void>,
    ) => {
      const who = await bearer.identify(c.req.raw, role ? { role } : undefined);
      if (!who.ok) return who.response;
      c.set("caller", who.caller);
      await next();
    };
  const parseJson = async (c: { req: { json: () => Promise<unknown> } }): Promise<unknown> =>
    c.req.json().catch(() => ({}));

  api.use("*", identified());

  // Directory (resource servers forward the caller's token; the SPA uses its cookie).
  api.get("/users/:id", async (c) => {
    const u = await users.info(c.req.param("id"));
    return u ? c.json(u) : c.notFound();
  });
  api.post("/users/batch", async (c) => {
    const { ids } = batchSchema.parse(await parseJson(c));
    return c.json({ users: await users.infoMany(ids) });
  });
  api.get("/users", async (c) => c.json({ users: await users.directory() }));
  // Dev-token page: the audiences to choose from. The SPA then runs a real PKCE flow against /auth/oauth2/authorize.
  api.get("/registry", (c) =>
    c.json({
      issuer: registry.issuer,
      devTokenClientId: FIRST_PARTY_CLIENTS[0].clientId,
      resources: registry.entries.map((e) => ({
        name: e.name,
        kind: e.kind,
        title: e.title,
        audience: e.audience,
        metadataUrl: e.metadataUrl,
      })),
    }),
  );
  // Settings: connected clients and disconnect (consent + refresh tokens + audit).
  api.post("/me/identity-setup", async (c) => {
    await users.finishIdentitySetup(c.var.caller.userId);
    return c.json({ ok: true });
  });
  api.get("/me", (c) => c.json(c.var.caller));
  api.get("/me/clients", async (c) =>
    c.json({ clients: await users.connectedClients(c.var.caller.userId) }),
  );
  api.delete("/me/clients/:clientId", async (c) =>
    c.json(
      await users.revokeClient(actorOf(c.var.caller), c.var.caller.userId, c.req.param("clientId")),
    ),
  );

  // Admin: every route requires role admin; actor = the caller.
  const adminApi = new Hono<Env>();
  adminApi.use("*", identified("admin"));
  adminApi.get("/users", async (c) => c.json(await users.list(listQuery.parse(c.req.query()))));
  adminApi.put("/users/:id/role", async (c) => {
    const { role } = roleBody.parse(await parseJson(c));
    return c.json(await users.setRole(actorOf(c.var.caller), c.req.param("id"), role));
  });
  adminApi.put("/users/:id/disabled", async (c) => {
    const { disabled, reason } = disabledBody.parse(await parseJson(c));
    return c.json(
      await users.setDisabled(actorOf(c.var.caller), c.req.param("id"), disabled, reason),
    );
  });
  adminApi.delete("/users/:id/sessions", async (c) =>
    c.json(await users.revokeSessions(actorOf(c.var.caller), c.req.param("id"))),
  );
  adminApi.delete("/users/:id/clients/:clientId", async (c) =>
    c.json(
      await users.revokeClient(actorOf(c.var.caller), c.req.param("id"), c.req.param("clientId")),
    ),
  );
  adminApi.get("/feishu-allowlist", async (c) =>
    c.json({ entries: await users.feishuAllowlist() }),
  );
  adminApi.put("/feishu-allowlist/:tenantKey/:openId", async (c) => {
    const { note } = allowlistBody.parse(await parseJson(c));
    return c.json(
      await users.feishuAllowlistAdd(
        actorOf(c.var.caller),
        c.req.param("tenantKey"),
        c.req.param("openId"),
        note,
      ),
    );
  });
  adminApi.delete("/feishu-allowlist/:tenantKey/:openId", async (c) =>
    c.json(
      await users.feishuAllowlistRemove(
        actorOf(c.var.caller),
        c.req.param("tenantKey"),
        c.req.param("openId"),
      ),
    ),
  );
  adminApi.get("/allowlist", async (c) => c.json({ entries: await users.allowlist() }));
  adminApi.put("/allowlist/:githubLogin", async (c) => {
    const { note } = allowlistBody.parse(await parseJson(c));
    return c.json(
      await users.allowlistAdd(actorOf(c.var.caller), c.req.param("githubLogin"), note),
    );
  });
  adminApi.delete("/allowlist/:githubLogin", async (c) =>
    c.json(await users.allowlistRemove(actorOf(c.var.caller), c.req.param("githubLogin"))),
  );
  adminApi.get("/audit", async (c) => {
    const q = auditQuery.parse(c.req.query());
    return c.json(await users.audit({ ...q, type: q.type as AuditType | undefined }));
  });
  api.route("/admin", adminApi);
  app.route("/auth/api", api);

  // ── Better Auth: sign-in/social, callback/github, get-session, sign-out, oauth2/*, jwks ──
  app.all("/auth/*", (c) => auth.handler(c.req.raw));

  return app;
}
