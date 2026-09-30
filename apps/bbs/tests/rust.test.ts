import { describe, expect, it, vi } from "vite-plus/test";
import { withRustReads } from "../src/library/rust.ts";
import {
  FAKE,
  MCP_RESOURCE,
  connect,
  createFakeApp,
  fakeLibrary,
  fetchVia,
  legacyCall,
} from "./helpers.ts";

describe("incremental Rust reads", () => {
  it("delegates feed filters through REST and MCP, restores dates and preserves cursor errors", async () => {
    const local = fakeLibrary();
    const wire = JSON.parse(JSON.stringify(await local.articles({ limit: 2 })));
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(wire));
    const app = await createFakeApp({
      decorateLibrary: (local) => withRustReads(local, { origin: "http://rust", fetch: transport }),
    });
    let client: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      const response = await app.fetch(
        "/api/articles?q=%E6%AD%A5%E5%85%B5&scope=title&group=%E7%A1%AC%E4%BB%B6&limit=2",
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(wire);
      const requestUrl = transport.mock.calls[0]![0];
      if (typeof requestUrl !== "string") throw new Error("expected an upstream URL string");
      const url = new URL(requestUrl);
      expect(Object.fromEntries(url.searchParams)).toEqual({
        q: "步兵",
        scope: "title",
        group: "硬件",
        limit: "2",
      });
      const fetch = fetchVia(app.app);
      client = await connect(MCP_RESOURCE, await app.token(), fetch);
      const page = await client.callTool({ name: "list_articles", arguments: { limit: 2 } });
      expect(page.isError).toBeFalsy();
      expect(page.structuredContent).toMatchObject({ articles: [{ id: FAKE.id }, {}] });
      transport.mockResolvedValueOnce(
        Response.json(
          { error: "invalid_cursor", error_description: "unusable cursor" },
          { status: 400 },
        ),
      );
      const invalid = await app.fetch("/api/articles?cursor=bad");
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({
        error: "invalid_cursor",
        error_description: "unusable cursor",
      });
    } finally {
      await client?.close();
      await app.close();
    }
  });
  it("delegates through REST and authenticated MCP while retaining the read hook and audience checks", async () => {
    const fixture = fakeLibrary();
    const wire = JSON.parse(JSON.stringify(await fixture.article(FAKE.id)));
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(wire));
    const onArticleRead = vi.fn(async () => true);
    const app = await createFakeApp({
      onArticleRead,
      decorateLibrary: (local) => withRustReads(local, { origin: "http://rust", fetch: transport }),
    });
    let client: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      const response = await app.fetch(`/api/articles/${FAKE.id}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(wire);
      expect(onArticleRead).toHaveBeenCalledWith(FAKE.id);
      const fetch = fetchVia(app.app);
      const denied = await legacyCall(
        MCP_RESOURCE,
        await app.token("https://other.example/api"),
        fetch,
        "tools/list",
      );
      expect(denied.status).toBe(401);
      expect(transport).toHaveBeenCalledTimes(1);
      client = await connect(MCP_RESOURCE, await app.token(), fetch);
      const article = await client.callTool({
        name: "get_article",
        arguments: { id: FAKE.id, include: [] },
      });
      expect(article.isError).toBeFalsy();
      expect(article.structuredContent).toMatchObject({ id: FAKE.id });
      expect(transport).toHaveBeenCalledTimes(2);
    } finally {
      await client?.close();
      await app.close();
    }
  });

  it("rehydrates dates, keeps unported methods local and sends no credentials", async () => {
    const local = fakeLibrary();
    const wire = JSON.parse(JSON.stringify(await local.article(FAKE.id)));
    local.calls.length = 0;
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(wire));
    const rust = withRustReads(local, { origin: "http://127.0.0.1:3203", fetch: transport });
    const article = await rust.article(FAKE.id);
    expect(article?.publishedAt).toBeInstanceOf(Date);
    expect(article?.discoveredAt).toBeInstanceOf(Date);
    expect(local.calls).toEqual([]);
    await rust.search({ q: "PID", limit: 5 });
    await rust.status();
    expect(local.calls).toEqual(["search", "status"]);
    const [url, init] = transport.mock.calls[0]!;
    expect(url).toBe(`http://127.0.0.1:3203/api/articles/${FAKE.id}`);
    expect(init?.headers).toEqual({ accept: "application/json" });
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("accepts a missing row but rejects missing routes and upstream failures without fallback", async () => {
    const local = fakeLibrary();
    const transport = vi.fn<typeof fetch>();
    const rust = withRustReads(local, { origin: "http://rust", fetch: transport });
    transport.mockResolvedValueOnce(
      Response.json({ error: "not_found", error_description: "no such row" }, { status: 404 }),
    );
    expect(await rust.article(FAKE.unknownId)).toBeNull();
    transport.mockResolvedValueOnce(
      Response.json({ error: "not_found", error_description: "no such route" }, { status: 404 }),
    );
    await expect(rust.article(FAKE.id)).rejects.toThrow("404");
    transport.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await expect(rust.article(FAKE.id)).rejects.toThrow("503");
    expect(local.calls).toEqual([]);
  });

  it("rehydrates AI timestamps for MCP", async () => {
    const local = fakeLibrary();
    const wire = JSON.parse(JSON.stringify(await local.ai(FAKE.id)));
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json(wire));
    const rust = withRustReads(local, { origin: "http://rust", fetch: transport });
    const ai = await rust.ai(FAKE.id);
    expect(ai?.generatedAt).toBeInstanceOf(Date);
    expect(JSON.parse(JSON.stringify(ai))).toEqual(wire);
  });

  it("uses the returned content format and rejects responses missing that contract", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("plain fallback", { headers: { "x-content-format": "text" } }),
      )
      .mockResolvedValueOnce(new Response("ambiguous"));
    const rust = withRustReads(fakeLibrary(), { origin: "http://rust", fetch: transport });
    expect(await rust.content(FAKE.id, "markdown")).toEqual({
      format: "text",
      body: "plain fallback",
    });
    await expect(rust.content(FAKE.id, "html")).rejects.toThrow("missing its format");
  });
});
