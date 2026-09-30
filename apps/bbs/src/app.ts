/**
 * The complete HTTP surface of the bbs container, in route order. This is the
 * file to read to answer "who serves X".
 *
 *   GET  /healthz                       db ping                                    (anon)
 *   GET  /mcp/bbs/healthz                                                          (anon)
 *   GET|POST|DELETE /mcp/bbs            honoAuth(mcp) then the MCP handler         (bearer, member)
 *   GET  /login  GET /callback  POST /logout   @herkules/oauth-client routes       (anon)
 *   GET  /api/*                         oauth.viewer() then api/routes.ts          (anon; /api/me guarded)
 *   GET  /assets/*                      immutable static                           (anon)
 *   GET  *                              SPA shell, head-injected for /articles/:id and /kb/:name; 404 shell for unknown ids
 *
 * ROUTE ORDER IS LOAD-BEARING: the SPA fallback is `app.get("*")` and is
 * registered last, or it swallows the API's 404s and turns them into HTML
 * (services/auth documents the same discipline for its Better Auth catch-all).
 *
 * TWO AUDIENCES, ONE APP: browsers arrive with a sealed cookie carrying a token
 * for `${origin}/api/bbs` (verified by `apiResource`, inside `oauth`); agents
 * arrive with a bearer for `${origin}/mcp/bbs` (verified by `mcpResource`). A
 * token for one is rejected by the other — done-predicate 4. What they share is
 * `Principal`: `oauth.viewer()`, `oauth.guard()` and `honoAuth()` all write the
 * same `c.var.principal`, so no handler knows what kind of caller it has.
 */
import type { ResourceAuth } from "@herkules/auth-middleware";
import { honoAuth } from "@herkules/auth-middleware/hono";
import { principalOf, toAuthInfo } from "@herkules/auth-middleware/mcp";
import type { HonoOAuth, ViewerEnv } from "@herkules/oauth-client/hono";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { Hono } from "hono";

import { createApi } from "./api/routes.ts";
import { RESOURCE_NAME } from "./config.ts";
import type { Library } from "./library/index.ts";
import { createBbsServer } from "./mcp/server.ts";
import type { SpaHandler } from "./spa/static.ts";
import type { UserInfo } from "@herkules/auth-middleware/userinfo";

export interface AppDeps {
  readonly library: Library;
  /** Login/callback/logout + viewer()/guard(). Built over `apiResource` in main.ts. */
  readonly oauth: HonoOAuth;
  /** Audience `${origin}/mcp/bbs`. Guards the MCP route; every MCP call needs a member. */
  readonly mcp: ResourceAuth;
  readonly userInfo: UserInfo;
  readonly spa: SpaHandler;
  readonly appOrigin: string;
  /** Private native service; browser documents still use the SPA fallback. */
  readonly nativeRustOrigin?: string;
  /** `db.execute(sql\`select 1\`)`; the only thing /healthz can meaningfully check. */
  readonly ping: () => Promise<void>;
  readonly onError?: (error: Error) => void;
  /**
   * Called with the article id after a successful REST GET /api/articles/:id — the API's one write
   * (crawl/corpus.ts noteArticleRead queues a refresh for a stale article). Optional so tests over
   * fakeLibrary need not wire it; MCP reads never call it (rm-wenku parity).
   */
  readonly onArticleRead?: (id: string) => Promise<boolean>;
}

export function createApp(deps: AppDeps) {
  const handler = createMcpHandler(
    (ctx) => {
      if (!ctx.authInfo) throw new Error("MCP request reached the handler without authInfo");
      return createBbsServer(principalOf(ctx.authInfo), {
        library: deps.library,
        appOrigin: deps.appOrigin,
      });
    },
    { onerror: deps.onError },
  );

  const app = new Hono<ViewerEnv>();
  if (deps.nativeRustOrigin) {
    const origin = deps.nativeRustOrigin;
    app.on(
      ["GET", "POST", "DELETE", "PUT", "PATCH", "OPTIONS", "HEAD"],
      ["/api/*", "/mcp/bbs", "/mcp/bbs/healthz", "/login", "/callback", "/logout", "/articles/:id"],
      async (c) => {
        const url = new URL(c.req.url);
        const upstream = new URL(url.pathname + url.search, origin);
        try {
          const request = new Request(upstream, c.req.raw);
          const connectionHeaders = request.headers.get("connection")?.split(",") ?? [];
          for (const name of [
            ...connectionHeaders,
            "connection",
            "keep-alive",
            "proxy-authenticate",
            "proxy-authorization",
            "proxy-connection",
            "te",
            "trailer",
            "transfer-encoding",
            "upgrade",
          ]) {
            request.headers.delete(name.trim());
          }
          request.headers.set("host", upstream.host);
          // Preserve streaming MCP responses and all Set-Cookie headers; redirects
          // must reach the browser, never be followed by this private proxy.
          return await fetch(request, { redirect: "manual" });
        } catch (error) {
          deps.onError?.(error instanceof Error ? error : new Error(String(error)));
          return c.json(
            { error: "unavailable", error_description: "native BBS unavailable, retry" },
            503,
            { "cache-control": "no-store", "retry-after": "5" },
          );
        }
      },
    );
  }
  const mcpPath = `/mcp/${RESOURCE_NAME}`;

  app.get("/healthz", async (c) => {
    try {
      await deps.ping();
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });
  app.get(`${mcpPath}/healthz`, (c) => c.json({ ok: true }));
  app.on(["GET", "POST", "DELETE"], mcpPath, honoAuth(deps.mcp), (c) =>
    handler.fetch(c.req.raw, { authInfo: toAuthInfo(c.var.principal) }),
  );
  app.route("/", deps.oauth.routes);
  app.route(
    "/",
    createApi({
      library: deps.library,
      oauth: deps.oauth,
      userInfo: deps.userInfo,
      onError: deps.onError,
      onArticleRead: deps.onArticleRead,
    }),
  );
  deps.spa.mount(app); // LAST

  return { app, close: () => handler.close() };
}
