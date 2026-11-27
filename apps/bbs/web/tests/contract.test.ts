/**
 * The hook layer without React: the real Hono app (PGlite, fixture corpus) behind
 * `createApi`, a bare `QueryClient` in front of `createQueries`. What it pins is
 * the behaviour the screens rely on and the compiler cannot state — 404 as data,
 * cursor exhaustion, the anonymous viewer, cross-filtered facets. The
 * compile-time claims live once, in `tests/rpc.test.ts`.
 */
import { QueryClient } from "@tanstack/react-query";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { resourceCatalog, resourcePages } from "../../src/db/schema.ts";
import type { TestBbs } from "../../tests/helpers.ts";
import { APP_ORIGIN, createTestBbs, fetchVia } from "../../tests/helpers.ts";
import { ApiError, createApi } from "../src/api/client.ts";
import type { BbsApi } from "../src/api/client.ts";
import { createQueries } from "../src/api/queries.ts";
import type { Queries } from "../src/api/queries.ts";
import { feedSearch, kbSearch, rankedSearch } from "../src/url.ts";

/** A syntactically valid ULID the fixture does not contain (`fixtureId` pads with digits). */
const UNKNOWN_ID = "01J0000000000000000000000Z";

describe("q.* against the real app (fixture corpus)", () => {
  let bbs: TestBbs;
  let api: BbsApi;
  let q: Queries;
  let qc: QueryClient;
  let firstId: string;

  beforeAll(async () => {
    bbs = await createTestBbs({ importFixture: true });
    // The app's own origin: `createSpaHandler`/oauth are configured for it, and
    // `fetchVia` hands the whole URL to `app.request`.
    api = createApi({ origin: APP_ORIGIN, fetch: fetchVia(bbs.app) });
    q = createQueries(api);
    qc = new QueryClient();
    firstId = (await api.articles({})).items[0]!.id;
  }, 60_000);
  afterAll(async () => {
    qc?.clear();
    await bbs?.close();
  });

  it("article and ai return null for an unknown id, the DTO for a known one", async () => {
    expect(await qc.fetchQuery(q.article(UNKNOWN_ID))).toBeNull();
    expect(await qc.fetchQuery(q.ai(UNKNOWN_ID))).toBeNull();
    const article = await qc.fetchQuery(q.article(firstId));
    expect(article).toMatchObject({ id: firstId });
    expect(typeof article!.titleParts.topic).toBe("string");
    const ai = await qc.fetchQuery(q.ai(firstId));
    expect(["pending", "ready", "failed"]).toContain(ai!.status);
  });

  it("a malformed id is an ApiError with the status, not a null", async () => {
    // 400, not 404: the row could never exist, so it is a caller mistake.
    const error = await caught(api.article("not-a-ulid"));
    expect(error.status).toBe(400);
    expect(error.code).toBe("invalid_request");
    // A blank ranked search is the same shape of mistake; `/search`'s redirect is what prevents it.
    expect((await caught(api.search({ q: "" }))).status).toBe(400);
  });

  it("the feed pages by cursor until nextCursor is null", async () => {
    const page = await qc.fetchInfiniteQuery(q.feed(feedSearch.parse({})));
    expect(page.pages[0]!.items.length).toBeGreaterThan(0);
    // The whole fixture fits one default page, so the factory's own first page ends the list.
    expect(page.pages.at(-1)!.nextCursor).toBeNull();

    // Cursor exhaustion itself needs more than one page: the same route with limit=2.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const next = await api.articles({ limit: "2", cursor });
      seen.push(...next.items.map((a) => a.id));
      cursor = next.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(cursor).toBeUndefined();
    expect(new Set(seen).size).toBe(seen.length); // no row is served twice across cursors
    expect(seen).toContain(firstId);
    expect(seen.length).toBe(page.pages[0]!.items.length);
  });

  it("viewer is null anonymous and a Viewer after signIn", async () => {
    expect(await qc.fetchQuery(q.viewer())).toEqual({ viewer: null }); // never a 401
    const { cookie, subject } = await bbs.signIn("reader_contract");
    const withCookie = createQueries(
      createApi({ origin: APP_ORIGIN, fetch: withCookieHeader(fetchVia(bbs.app), cookie) }),
    );
    const signedIn = new QueryClient();
    const { viewer } = await signedIn.fetchQuery(withCookie.viewer());
    expect(viewer).toMatchObject({ id: subject });
    expect(["admin", "member"]).toContain(viewer!.role);
    signedIn.clear();
  });

  it("kbBrowse facets never contain their own filter", async () => {
    const all = await qc.fetchQuery(q.kbBrowse(kbSearch.parse({})));
    expect(all.cards.length).toBeGreaterThan(0);
    const domain = all.domains[0]!.name;
    const filtered = await qc.fetchQuery(q.kbBrowse(kbSearch.parse({ domain })));
    expect(filtered.cards.every((c) => c.domain.includes(domain))).toBe(true);
    expect(filtered.total).toBeLessThanOrEqual(all.total);
    // The domain axis is counted under the OTHER filters, so filtering by a domain
    // leaves every domain chip clickable with the same count.
    expect(filtered.domains).toEqual(all.domains);
  });

  it("entity by display name and by key agree", async () => {
    const name = (await qc.fetchQuery(q.kbBrowse(kbSearch.parse({})))).cards.flatMap(
      (c) => c.entities,
    )[0]!;
    const byName = await qc.fetchQuery(q.entity(name));
    expect(byName).not.toBeNull();
    const byKey = await qc.fetchQuery(q.entity(byName!.entity.key));
    expect(byKey).toEqual(byName);
    expect(byName!.articles.length).toBe(byName!.entity.articleCount);
    expect(await qc.fetchQuery(q.entity("没有这个条目"))).toBeNull();
  });

  it("search echoes the folded terms and returns segment snippets", async () => {
    const term = (await qc.fetchQuery(q.article(firstId)))!.titleParts.topic.slice(0, 2);
    const s = rankedSearch.parse({ q: term });
    const page = await qc.fetchInfiniteQuery(q.search({ ...s, q: term }));
    const hits = page.pages.flatMap((p) => p.items);
    expect(page.pages[0]!.terms).toEqual([term]);
    expect(hits.map((h) => h.id)).toContain(firstId);
    const snippet = hits.find((h) => h.snippet)!.snippet!;
    // Segments, not bracket-marked prose: the SPA renders `hit` runs as <mark>.
    expect(snippet.some((seg) => seg.hit)).toBe(true);
    expect(snippet.every((seg) => typeof seg.text === "string")).toBe(true);
  });

  it("tags and status answer without a query key of their own", async () => {
    const tags = await qc.fetchQuery(q.tags());
    expect(tags.total).toBeGreaterThan(0);
    expect(tags.groups.length).toBeGreaterThan(0);
    const status = await qc.fetchQuery(q.status());
    expect(status.articles.fetched).toBe(tags.total);
    expect(status.importedAt).not.toBeNull();
  });

  it("serves the resource catalog and pages to anonymous readers", async () => {
    expect(await api.resourceCatalog()).toEqual({ tree: [], syncedAt: null });
    const node = { id: "804039", title: "比赛规则 Rulebooks", children: [] };
    const at = new Date("2026-10-28T06:15:00Z");
    const page = {
      id: node.id,
      title: node.title,
      html: "<p>Competition rules</p>",
      attachments: [{ name: "Rules", url: "https://files.example/rules.pdf" }],
      updatedAt: at,
    };
    await bbs.service.db.insert(resourceCatalog).values({ tree: [node], syncedAt: at });
    await bbs.service.db
      .insert(resourcePages)
      .values([
        page,
        { ...page, html: "<p>Staged revision</p>", staged: true },
        { ...page, id: "804051", staged: true },
      ]);
    expect(await qc.fetchQuery(q.resourceCatalog())).toEqual({
      tree: [node],
      syncedAt: at.toISOString(),
    });
    expect(await qc.fetchQuery(q.resourcePage(node.id))).toEqual({
      ...page,
      updatedAt: at.toISOString(),
    });
    expect(await qc.fetchQuery(q.resourcePage("804051"))).toBeNull();
    expect(await qc.fetchQuery(q.resourcePage("99999"))).toBeNull();
    expect((await caught(api.resourcePage("bad-id"))).status).toBe(400);
  });
});

/** Asserts the call failed with an `ApiError` and hands it over. */
async function caught(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected an ApiError");
}

/** The browser sends the session cookie itself (`credentials: "same-origin"`); in-process it is explicit. */
function withCookieHeader(fetch: typeof globalThis.fetch, cookie: string): typeof globalThis.fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("cookie", cookie);
    return fetch(input, { ...init, headers });
  };
}
