/** Every Library method except ranked search (search.test.ts), over the drizzle seed on PGlite. */
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import type { Library } from "../src/library/index.ts";
import { QueryError, articleId, entityKey } from "../src/library/index.ts";
import type { ArticleId, ArticleSummary, Cursor } from "../src/library/types.ts";
import { ARTICLES, FEED_ORDER, ID, day, seedLibrary } from "./seed.ts";

let seeded: Awaited<ReturnType<typeof seedLibrary>>;
let lib: Library;

beforeAll(async () => {
  seeded = await seedLibrary();
  lib = seeded.library;
});
afterAll(() => seeded.close());

async function walk(query: {
  tag?: string;
  group?: string;
  q?: string;
  scope?: "all" | "title" | "kb";
  limit: number;
}) {
  const ids: ArticleId[] = [];
  let cursor: Cursor | undefined;
  for (let i = 0; i < 20; i++) {
    const page = await lib.articles({ ...query, cursor });
    ids.push(...page.items.map((a) => a.id));
    if (!page.nextCursor) return ids;
    cursor = page.nextCursor;
  }
  throw new Error("cursor never ended");
}

describe("articles()", () => {
  it("returns the fetched feed newest first, listing position then id as tiebreaks", async () => {
    const page = await lib.articles({ limit: 100 });
    expect(page.items.map((a) => a.id)).toEqual(FEED_ORDER);
    expect(page.nextCursor).toBeNull();
    // E has no published_at: it sorts by discovered_at, between D (day 8) and F (day 6).
    expect(page.items[4]!.id).toBe(ID.E);
  });

  it("pages by keyset with no duplicates and no gaps, at every page size", async () => {
    for (const limit of [1, 3, 4, 10]) {
      expect(await walk({ limit })).toEqual(FEED_ORDER);
    }
  });

  it("fills the summary row from one statement", async () => {
    const a = (await lib.articles({ limit: 1 })).items[0]!;
    expect(a).toMatchObject<Partial<ArticleSummary>>({
      id: ID.A,
      sourceArticleId: "1",
      url: "https://bbs.robomaster.com/article/1",
      title: ARTICLES[0]!.title,
      titleParts: {
        season: "RM2026",
        team: null,
        labels: ["开源"],
        topic: "ＨＰＭ5361 步兵底盘控制板",
      },
      author: "Kaiser",
      isPinned: false,
      tags: ["硬件/机器人硬件", "开源/PCB"],
      introduction: ARTICLES[0]!.intro,
      excerpt: ARTICLES[0]!.intro,
      linkCount: 1,
      imageCount: 2,
      tldr: "全国产步兵底盘主控板",
    });
    expect(a.publishedAt).toEqual(day(10));
    expect(a.bodyChars).toBe(ARTICLES[0]!.body!.length);
    const b = (await lib.articles({ limit: 2 })).items[1]!;
    expect(b.tldr).toBe("先调 P 再调 D");
    expect(b.introduction).toBeNull();
    expect(b.excerpt!.startsWith("经验上 PID 整定")).toBe(true);
    const c = (await lib.articles({ limit: 3 })).items[2]!;
    expect(c.tldr).toBeNull();
  });

  it("filters by tag and by group, keeping feed order", async () => {
    expect(await walk({ tag: "机械/结构", limit: 2 })).toEqual([ID.D, ID.H, ID.J]);
    expect(await walk({ group: "硬件", limit: 2 })).toEqual([ID.A, ID.F, ID.H, ID.K]);
    expect(await walk({ group: "硬件", tag: "硬件/电机", limit: 5 })).toEqual([ID.F]);
  });

  it("narrows by q without reordering; scope=title and scope=kb apply", async () => {
    expect(await walk({ q: "步兵", limit: 2 })).toEqual([ID.A, ID.B, ID.H, ID.J]);
    expect(
      await walk({
        q: "步兵",
        limit: 5,
        scope: "title",
      }),
    ).toEqual([ID.A, ID.H]);
    const kb = await lib.articles({ q: "m3508", scope: "kb", limit: 5 });
    expect(kb.items.map((a) => a.id)).toEqual([ID.A, ID.B]);
    const blank = await lib.articles({ q: "   ", limit: 100 });
    expect(blank.items).toHaveLength(FEED_ORDER.length);
  });

  it("rejects a foreign or garbled cursor with QueryError(invalid_cursor)", async () => {
    await expect(lib.articles({ limit: 5, cursor: "zzz" as Cursor })).rejects.toMatchObject({
      name: "QueryError",
      code: "invalid_cursor",
    });
    const ranked = await lib.search({ q: "步兵", limit: 1 });
    await expect(lib.articles({ limit: 5, cursor: ranked.nextCursor! })).rejects.toBeInstanceOf(
      QueryError,
    );
  });
});

describe("article() / content() / ai() / head()", () => {
  it("returns the reader page in one statement, links resolved and images collapsed", async () => {
    const a = (await lib.article(ID.A))!;
    expect(a.contentFormat).toBe("markdown");
    expect(a.contentHtml).toContain("<p>");
    expect(a.links).toEqual([
      {
        url: "https://github.com/example/hpm-board",
        kind: "repository",
        label: "仓库",
        articleId: null,
        position: 0,
      },
    ]);
    expect(a.images).toEqual([
      { url: "https://cdn.example/a1.png", alt: "PCB 实物", position: 0 },
      { url: "https://cdn.example/a2.png", alt: "原理图", position: 1 },
    ]);
    const f = (await lib.article(ID.F))!;
    // Unlabelled in-library link: label from the target's title, articleId set because the target is fetched.
    expect(f.links[0]).toMatchObject({ label: ARTICLES[0]!.title, articleId: ID.A });
    const h = (await lib.article(ID.H))!;
    // Target is a skipped article: title still borrowed, but no internal route.
    expect(h.links[0]).toMatchObject({ label: "跳过的帖子", articleId: null });
    expect(h.isPinned).toBe(true);
  });

  it("serves content in three renderings with the documented fallbacks", async () => {
    expect(await lib.content(ID.A, "markdown")).toMatchObject({ format: "markdown" });
    expect((await lib.content(ID.A, "markdown"))!.body.startsWith("# ")).toBe(true);
    expect(await lib.content(ID.B, "markdown")).toMatchObject({ format: "text" });
    expect(await lib.content(ID.B, "html")).toMatchObject({ format: "html" });
    expect(await lib.content(ID.B, "text")).toEqual({ format: "text", body: ARTICLES[1]!.body });
  });

  it("merges overview, kb and captions; pending when there is no AI row", async () => {
    const a = (await lib.ai(ID.A))!;
    expect(a.status).toBe("ready");
    expect(a.overview).toMatchObject({
      genre: "开源项目",
      tldr: "全国产步兵底盘主控板",
      keyPoints: ["四路 CAN"],
    });
    expect(a.overview!.maturity).toEqual({ status: "已验证", evidence: "上过赛场" });
    expect(a.kb).toMatchObject({
      domain: ["硬件", "嵌入式"],
      robotTypes: ["步兵"],
      entities: ["HPM5361", "M3508"],
    });
    expect(a.kb!.parameters).toEqual([
      { name: "CAN 波特率", value: "1", unit: "Mbps", context: null, source: null },
    ]);
    expect(a.images).toEqual([
      { index: 1, kind: "实物照片", caption: "PCB 实物", textInImage: null, facts: [] },
    ]);
    expect(a.model).toBe("test-model");
    expect(a.generatedAt).toEqual(day(10));
    const c = (await lib.ai(ID.C))!;
    expect(c).toMatchObject({
      status: "pending",
      overview: null,
      kb: null,
      images: [],
      model: null,
    });
  });

  it("head() reads two columns' worth: title, description, first image", async () => {
    expect(await lib.head(ID.A)).toEqual({
      title: ARTICLES[0]!.title,
      description: ARTICLES[0]!.intro,
      path: `/articles/${ID.A}`,
      type: "article",
      image: "https://cdn.example/a1.png",
      publishedAt: day(10),
      author: "Kaiser",
    });
    const b = (await lib.head(ID.B))!;
    expect(b.image).toBe("https://cdn.example/b1.png");
    expect(b.description.startsWith("经验上 PID")).toBe(true);
  });

  it("keeps skipped and pending articles out of every read", async () => {
    for (const id of [ID.SKIPPED, ID.PENDING]) {
      expect(await lib.article(id)).toBeNull();
      expect(await lib.content(id, "text")).toBeNull();
      expect(await lib.ai(id)).toBeNull();
      expect(await lib.head(id)).toBeNull();
    }
    expect(await walk({ limit: 100 })).not.toContain(ID.SKIPPED);
    expect((await lib.articles({ q: "跳过", limit: 10 })).items).toEqual([]);
    expect(await lib.article(articleId("01J000000000000000000000ZZ")!)).toBeNull();
  });
});

describe("tags()", () => {
  it("counts tags per row and groups per distinct article, over fetched articles only", async () => {
    const t = await lib.tags();
    expect(t.total).toBe(10);
    expect(t.items.slice(0, 2)).toEqual([
      { name: "机械/结构", count: 3 },
      { name: "硬件/机器人硬件", count: 2 },
    ]);
    // 硬件/通信 belongs to K (fetched) and SKIPPED: counted once.
    expect(t.items.find((x) => x.name === "硬件/通信")).toEqual({ name: "硬件/通信", count: 1 });
    // H has two 硬件-group... no: H has 机械 + 硬件; group 硬件 = A, F, H, K = 4 distinct articles, 5 tag rows would be wrong.
    expect(t.groups.find((g) => g.name === "硬件")).toEqual({ name: "硬件", count: 4 });
    expect(t.groups.map((g) => g.name)).toEqual(["硬件", "算法", "机械", "开源"]); // 4, 3, 3, 1
  });
});

describe("kbBrowse() / entities() / entity() / entityHead()", () => {
  it("returns cards newest first with parsed facets and a total before LIMIT", async () => {
    const kb = await lib.kbBrowse({ limit: 2 });
    expect(kb.total).toBe(3);
    expect(kb.cards.map((c) => c.articleId)).toEqual([ID.A, ID.B]);
    expect(kb.cards[0]).toMatchObject({
      title: ARTICLES[0]!.title,
      tldr: "全国产步兵底盘主控板",
      genre: "开源项目",
      maturity: "已验证",
      problem: "底盘主控国产化",
      domain: ["硬件", "嵌入式"],
      robotTypes: ["步兵"],
      entities: ["HPM5361", "M3508"],
      pitfalls: ["CAN 终端电阻"],
    });
    // Ties break by code point (host-independent), not by any collation.
    expect(kb.domains).toEqual([
      { name: "嵌入式", count: 1 },
      { name: "机械", count: 1 },
      { name: "硬件", count: 1 },
      { name: "算法", count: 1 },
    ]);
    expect(kb.robotTypes).toEqual([
      { name: "步兵", count: 2 },
      { name: "工程", count: 1 },
      { name: "英雄", count: 1 },
    ]);
    expect(kb.genres).toEqual([
      { name: "开源项目", count: 2 },
      { name: "经验分享", count: 1 },
    ]);
  });

  it("never lets a facet narrow itself: each axis is counted under the OTHER filters", async () => {
    const kb = await lib.kbBrowse({ domain: "硬件", limit: 10 });
    expect(kb.cards.map((c) => c.articleId)).toEqual([ID.A]);
    expect(kb.total).toBe(1);
    // domain axis ignores the domain filter -> every domain still listed
    expect(kb.domains.map((d) => d.name)).toEqual(["嵌入式", "机械", "硬件", "算法"]);
    // the other axes ARE filtered by domain
    expect(kb.robotTypes).toEqual([{ name: "步兵", count: 1 }]);
    expect(kb.genres).toEqual([{ name: "开源项目", count: 1 }]);
    const both = await lib.kbBrowse({ robot: "步兵", genre: "经验分享", limit: 10 });
    expect(both.cards.map((c) => c.articleId)).toEqual([ID.B]);
    expect(both.robotTypes).toEqual([
      { name: "步兵", count: 1 },
      { name: "英雄", count: 1 },
    ]); // under genre only: B's two robot types
    expect(both.genres).toEqual([
      { name: "开源项目", count: 1 },
      { name: "经验分享", count: 1 },
    ]); // under robot only
  });

  it("pushes q into the kb statement", async () => {
    const kb = await lib.kbBrowse({ q: "m3508", limit: 10 });
    expect(kb.cards.map((c) => c.articleId)).toEqual([ID.A, ID.B]);
    expect(kb.domains.map((d) => d.name)).toEqual(["嵌入式", "硬件", "算法"]);
    expect((await lib.kbBrowse({ q: "不存在的词", limit: 10 })).total).toBe(0);
  });

  it("lists entities with articles, most used first, with a name substring filter", async () => {
    expect(await lib.entities({ limit: 10 })).toEqual([
      { key: "m3508", name: "M3508", articleCount: 2 },
      { key: "hpm5361", name: "HPM5361", articleCount: 1 },
      { key: "m2006", name: "M2006", articleCount: 1 },
    ]);
    expect((await lib.entities({ q: "hpm", limit: 10 })).map((e) => e.key)).toEqual(["hpm5361"]);
    expect((await lib.entities({ q: "50%", limit: 10 })).map((e) => e.key)).toEqual([]);
    expect(await lib.entities({ limit: 1 })).toHaveLength(1);
  });

  it("entity(): header plus every fetched article that mentions it, feed-ordered, in one statement", async () => {
    const e = (await lib.entity(entityKey("M3508")))!;
    expect(e.entity).toEqual({ key: "m3508", name: "M3508", articleCount: 2 });
    expect(e.articles.map((a) => a.articleId)).toEqual([ID.A, ID.B]);
    expect(e.articles[0]).toMatchObject({
      title: ARTICLES[0]!.title,
      tldr: "全国产步兵底盘主控板",
    });
    expect(e.articles[0]!.kb.entities).toEqual(["HPM5361", "M3508"]);
    expect(e.articles[1]!.publishedAt).toEqual(day(9));
    const orphan = (await lib.entity(entityKey("Orphan")))!;
    expect(orphan.entity.articleCount).toBe(0);
    expect(orphan.articles).toEqual([]);
    expect(await lib.entity(entityKey("nobody"))).toBeNull();
  });

  it("entityHead(): name and count only, null when orphaned", async () => {
    expect(await lib.entityHead(entityKey("HPM5361"))).toEqual({
      title: "HPM5361",
      description: "HPM5361：1 篇相关文章",
      path: "/kb/HPM5361",
      type: "website",
      image: null,
      publishedAt: null,
      author: null,
    });
    expect(await lib.entityHead(entityKey("Orphan"))).toBeNull();
  });
});

describe("status()", () => {
  it("counts the corpus in one statement", async () => {
    expect(await lib.status()).toEqual({
      site: { name: "RM 论坛", url: "https://bbs.robomaster.com" },
      articles: { total: 12, fetched: 10, skipped: 1, tags: 12, images: 3, links: 3 },
      ai: { ready: 3, missing: 7, entities: 3 },
      crawler: {
        lastCheckedAt: day(10),
        lastCheckedAgeSeconds: expect.any(Number),
        backfillCompletedAt: day(9),
      },
      bot: { lastReconciledAt: null, lastReconciledAgeSeconds: null },
      importedAt: day(11),
    });
  });
});
