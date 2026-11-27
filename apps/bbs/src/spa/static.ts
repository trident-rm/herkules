/**
 * Serving the built SPA from the same container, with head injection. No repo
 * precedent — `services/web` is a Caddy image with `try_files` — so the shape
 * is stated here:
 *
 *   GET /assets/*                     serveStatic, `cache-control: public, max-age=31536000, immutable`
 *   GET /favicon.*, /robots.txt, /fonts/*   serveStatic, `public, max-age=3600`
 *   GET *                             the SPA document, `cache-control: no-cache`; head injected for
 *                                     /articles/:id and /kb/:name. UNKNOWN ids get the plain shell
 *                                     with status 404 so crawlers do not index them (the SPA renders
 *                                     its own not-found screen; a 404 document is still a document).
 *   GET /api/* | /mcp/* | /assets/* | /fonts/*   never a document. The first two are a JSON 404 so a
 *                                     typo in an `hc` call cannot come back as HTML. The last two are
 *                                     a 404 too, and this one is NOT cosmetic: serveStatic calls next()
 *                                     on a miss, so without this arm a request for a hashed chunk that
 *                                     a deploy removed would fall through to the document and `cached`
 *                                     would stamp it `immutable` — pinning an HTML body under a `.js`
 *                                     URL in the browser and any CDN for a year. 404 + no immutable
 *                                     header lets the client re-fetch the fixed document instead.
 *
 * ROUTE ORDER in app.ts is load-bearing: the fallback is registered LAST, after
 * /healthz, /mcp/bbs, /login, /callback, /logout and /api/*, so it can never
 * shadow them and a 404 from /api/* stays JSON.
 *
 * `webDir === null` (dev) disables all of it: the Vite dev server is the origin
 * and proxies the dynamic paths here. Head injection is therefore NOT exercised
 * in dev, which is why it has its own test against a fixture index.html.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ViewerEnv } from "@herkules/oauth-client/hono";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Context, Hono, MiddlewareHandler } from "hono";

import type { HeadMeta, Library } from "../library/index.ts";
import { articleId, entityKey } from "../library/index.ts";
import type { HeadTemplate } from "./head.ts";
import { headRouteOf, loadHeadTemplate } from "./head.ts";

export interface StaticDeps {
  /** Absolute path to the built SPA, or null to disable (dev). */
  readonly webDir: string | null;
  readonly library: Library;
  /** For canonical URLs and `og:url` — the APP origin, never the platform origin. */
  readonly appOrigin: string;
}

export interface SpaHandler {
  /** Registers the asset routes and the fallback on the app, in that order. Call LAST. */
  mount(app: Hono<ViewerEnv>): void;
  /** Null when `webDir` is null. Exposed so a test can render a head without HTTP. */
  readonly template: HeadTemplate | null;
}

export const IMMUTABLE = "public, max-age=31536000, immutable";
export const SHORT_LIVED = "public, max-age=3600";

/** Prefixes the SPA fallback must refuse: a miss under any of these is a 404, never the document. */
const NEVER_A_DOCUMENT = ["/api/", "/mcp/", "/assets/", "/fonts/"];

function resourceHead(title: string, path: string): HeadMeta {
  return {
    title,
    description: "RoboMaster 规则与资料",
    path,
    type: "website",
    image: null,
    publishedAt: null,
    author: null,
  };
}

/** Reads and parses `${webDir}/index.html` once. Throws at boot on a missing file or marker. */
export async function createSpaHandler(deps: StaticDeps): Promise<SpaHandler> {
  const { webDir } = deps;
  if (!webDir) return { mount: () => {}, template: null };
  const template = loadHeadTemplate(await readFile(join(webDir, "index.html"), "utf8"));

  const html = (c: Context, body: string, status: 200 | 404) =>
    c.body(body, status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
    });

  const metaFor = async (pathname: string): Promise<HeadMeta | null | "plain"> => {
    if (pathname === "/resources" || pathname === "/resources/") {
      return resourceHead("规则与资料", "/resources");
    }
    const route = headRouteOf(pathname);
    if (route === null) return "plain";
    // `undefined`: a /kb/:name that does not percent-decode. No document can match
    // it, so it takes the same 404 path an unknown id does.
    if (route === undefined) return null;
    if (route.kind === "article") {
      const id = articleId(route.id);
      return id ? deps.library.head(id) : null;
    }
    if (route.kind === "resource") {
      const page = await deps.library.resourcePage(route.id);
      return page ? resourceHead(page.title, `/resources/${page.id}`) : null;
    }
    return deps.library.entityHead(entityKey(route.id));
  };

  return {
    template,
    mount(app) {
      app.use("/assets/*", cached(IMMUTABLE), serveStatic({ root: webDir }));
      for (const path of ["/favicon.*", "/robots.txt", "/fonts/*"]) {
        app.use(path, cached(SHORT_LIVED), serveStatic({ root: webDir }));
      }
      app.get("*", async (c) => {
        const { pathname } = new URL(c.req.url);
        // `/assets/*` and `/fonts/*` land here when serveStatic misses, and a
        // missing hashed chunk is not a document. Answering 404 here also keeps
        // `cached` from stamping the shell `immutable` for a year. `/api/*` and
        // `/mcp/*` say the same thing for the RPC and MCP surfaces.
        if (NEVER_A_DOCUMENT.some((prefix) => pathname.startsWith(prefix))) {
          return c.json({ error: "not_found", error_description: "no such route" }, 404);
        }
        const meta = await metaFor(pathname);
        if (meta === "plain") return html(c, template.plain, 200);
        return meta
          ? html(c, template.render(meta, deps.appOrigin), 200)
          : html(c, template.plain, 404);
      });
    },
  };
}

/** After serveStatic answered, stamp the cache policy on its response (re-creating it when headers are immutable). */
function cached(value: string): MiddlewareHandler<ViewerEnv> {
  return async (c, next) => {
    await next();
    if (c.res.status !== 200) return;
    try {
      c.res.headers.set("cache-control", value);
    } catch {
      const copy = new Response(c.res.body, c.res);
      copy.headers.set("cache-control", value);
      c.res = copy;
    }
  };
}
