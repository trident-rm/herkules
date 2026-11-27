/**
 * The REST surface, in route order, and the source of `AppType` — the SPA's
 * whole type contract. No OpenAPI, no codegen, no `/api/v1` compatibility:
 * `hc<AppType>` reads this file at compile time.
 *
 * MECHANICAL CONSTRAINTS (both verified against the compiler):
 *  1. Hono RPC infers from ONE chained expression. A route added with
 *     `api.get(...)` on a later statement compiles, runs, and is invisible to
 *     `hc`. Every route is in the single chain below and `AppType` is its type.
 *     `basePath("/api")` (mounted with `app.route("/", …)`) is what makes the
 *     RPC client's paths match the mounted paths.
 *  2. Inputs are typed ONLY through validator middleware. Parsing inside the
 *     handler (`schema.parse(c.req.query())`) leaves the RPC input as `{}`, so
 *     `api.articles.$get({ query: { scpoe: "x" } })` would compile. Every query
 *     string and path param goes through `zValidator`, and the handler reads
 *     `c.req.valid(...)`; the SPA's typo becomes a compile error, which is the
 *     point of having a typed client at all.
 *
 * ACCESS POLICY: every route is a read — no POST/PUT/PATCH/DELETE. The one
 * side effect an HTTP request has (Frame 2) is `onArticleRead` after a
 * successful GET /articles/:id: a single guarded UPDATE of
 * `articles.refresh_requested_at` that queues a crawler refresh of a stale
 * article, never changes the response, and is idempotent per 24 h. So
 * FRAME's "every non-read requires a member" is vacuously satisfied, and
 * `oauth.guard()` protects exactly one route, `/api/me`, because knowing who
 * you are requires being someone. `/api/viewer` answers "who is looking?" with
 * 200 + null for nobody, so anonymous page loads never 401; `/api/me` answers
 * "who am I?" and is done-predicate 3's member-only route (401 anonymous).
 */
import type { Principal } from "@herkules/auth-middleware";
import type { UserInfo } from "@herkules/auth-middleware/userinfo";
import type { HonoOAuth, ViewerEnv } from "@herkules/oauth-client/hono";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import type { ArticleId, Cursor, Library, Viewer } from "../library/index.ts";
import { QueryError, entityKey } from "../library/index.ts";
import * as s from "./schemas.ts";

export interface ApiDeps {
  readonly library: Library;
  readonly oauth: HonoOAuth;
  /** Display name and avatar, fetched with the caller's own token. */
  readonly userInfo: UserInfo;
  readonly onError?: (error: Error) => void;
  /** After a successful GET /articles/:id (app.ts AppDeps). Awaited in try/catch: it never changes the response. */
  readonly onArticleRead?: (id: string) => Promise<boolean>;
}

const CONTENT_TYPES = {
  text: "text/plain; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8",
} as const;

const notFound = { error: "not_found", error_description: "no such row" } as const;
const ARTICLE_READ_ERROR_LOG_INTERVAL_MS = 60_000;

/** The repo's error envelope for a validation failure, instead of zValidator's default body. */
const query = <T extends z.ZodType>(schema: T) =>
  zValidator("query", schema, (result, c) =>
    result.success
      ? undefined
      : c.json({ error: "invalid_request", error_description: z.prettifyError(result.error) }, 400),
  );
/** A malformed id/name is a caller mistake (400), not a missing row (404): the row could never exist. */
const param = <T extends z.ZodType>(schema: T) =>
  zValidator("param", schema, (result, c) =>
    result.success
      ? undefined
      : c.json({ error: "invalid_request", error_description: z.prettifyError(result.error) }, 400),
  );

const idParam = z.object({ id: s.articleIdParam });
const nameParam = z.object({ name: s.entityNameParam });
const resourceParam = z.object({ id: z.string().regex(/^[1-9]\d{0,18}$/) });

export function createApi(deps: ApiDeps) {
  const lib = deps.library;
  const id = (raw: string) => raw.toUpperCase() as ArticleId;
  let lastArticleReadErrorAt: number | undefined;

  const reportArticleReadError = (error: Error) => {
    if (!deps.onError) return;
    const now = Date.now();
    if (
      lastArticleReadErrorAt === undefined ||
      now < lastArticleReadErrorAt ||
      now - lastArticleReadErrorAt >= ARTICLE_READ_ERROR_LOG_INTERVAL_MS
    ) {
      lastArticleReadErrorAt = now;
      deps.onError(error);
    }
  };

  return new Hono<ViewerEnv>()
    .basePath("/api")
    .use("*", deps.oauth.viewer())
    .onError((err, c) => {
      if (err instanceof QueryError) {
        return c.json({ error: err.code, error_description: err.message }, 400);
      }
      deps.onError?.(err);
      return c.json({ error: "internal", error_description: "internal error" }, 500);
    })
    .get("/articles", query(s.articleListQuery), async (c) => {
      const q = c.req.valid("query");
      return c.json(await lib.articles({ ...q, cursor: q.cursor as Cursor | undefined }));
    })
    .get("/articles/:id", param(idParam), async (c) => {
      const article = await lib.article(id(c.req.valid("param").id));
      if (!article) return c.json(notFound, 404);
      if (deps.onArticleRead) {
        try {
          await deps.onArticleRead(article.id);
        } catch (e) {
          reportArticleReadError(e as Error);
        }
      }
      return c.json(article);
    })
    .get("/articles/:id/content", param(idParam), query(s.contentQuery), async (c) => {
      const { format } = c.req.valid("query");
      const content = await lib.content(id(c.req.valid("param").id), format);
      if (!content) return c.json(notFound, 404);
      return c.body(content.body, 200, {
        "content-type": CONTENT_TYPES[content.format],
        "x-content-format": content.format,
        "x-content-type-options": "nosniff",
      });
    })
    .get("/articles/:id/ai", param(idParam), async (c) => {
      const ai = await lib.ai(id(c.req.valid("param").id));
      return ai ? c.json(ai) : c.json(notFound, 404);
    })
    .get("/tags", async (c) => c.json(await lib.tags()))
    .get("/resources", async (c) => c.json(await lib.resourceCatalog()))
    .get("/resources/:id", param(resourceParam), async (c) => {
      const page = await lib.resourcePage(c.req.valid("param").id);
      return page ? c.json(page) : c.json(notFound, 404);
    })
    .get("/search", query(s.searchQuery), async (c) => {
      const q = c.req.valid("query");
      return c.json(await lib.search({ ...q, cursor: q.cursor as Cursor | undefined }));
    })
    .get("/kb/browse", query(s.kbBrowseQuery), async (c) =>
      c.json(await lib.kbBrowse(c.req.valid("query"))),
    )
    .get("/kb/entities", query(s.entityListQuery), async (c) =>
      c.json({ items: await lib.entities(c.req.valid("query")) }),
    )
    .get("/kb/entities/:name", param(nameParam), async (c) => {
      const detail = await lib.entity(entityKey(c.req.valid("param").name));
      return detail ? c.json(detail) : c.json(notFound, 404);
    })
    .get("/status", async (c) => c.json(await lib.status()))
    .get("/viewer", async (c) => c.json({ viewer: await viewerOf(c.var.principal, deps.userInfo) }))
    .get("/me", deps.oauth.guard({ role: "member" }), async (c) =>
      c.json(await viewerOf(c.var.principal, deps.userInfo)),
    );
}

/** What `hc<AppType>` is instantiated with in the SPA. Exported as a type only. */
export type AppType = ReturnType<typeof createApi>;

/**
 * Principal -> Viewer. The archive knows a `sub` and a role; display name and
 * avatar come from `GET /auth/api/users/:id` with the caller's OWN token. This
 * app never holds a credential for user data, and a banned user's token is
 * refused there. A user-info outage
 * degrades to id + role rather than failing the request. `undefined` -> null.
 */
export async function viewerOf(
  principal: Principal | undefined,
  userInfo: UserInfo,
): Promise<Viewer | null> {
  if (!principal) return null;
  const m = await userInfo.member(principal.token, principal.subject).catch(() => undefined);
  return {
    id: principal.subject,
    role: principal.role,
    displayName: m?.displayName ?? principal.subject,
    avatarUrl: m?.avatarUrl ?? null,
  };
}
