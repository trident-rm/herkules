/**
 * A drizzle-insert seed for the library tests: ten fetched articles, one
 * skipped, one pending, with the shapes the corpus actually has (two-character
 * terms, full-width titles, 【】 brackets, upper-case part numbers, tag groups,
 * in-library links, AI rows with facets). Independent of the SQLite fixture
 * the import tests build; that path is exercised end to end elsewhere.
 */
import { createDb, migrate } from "../src/db/index.ts";
import type { BbsDb } from "../src/db/index.ts";
import {
  articleAi,
  articleEntities,
  articleImages,
  articleLinks,
  articleSearch,
  articleTags,
  articles,
  importRuns,
  kbEntities,
  kbSearch,
  pollRuns,
  sources,
} from "../src/db/schema.ts";
import { selectSearchIndex } from "../src/db/search/index.ts";
import { buildDocument } from "../src/import/derive.ts";
import { createLibrary } from "../src/library/index.ts";
import type { Library } from "../src/library/index.ts";
import type { ArticleId } from "../src/library/types.ts";

const ulid = (suffix: string) => `01J000000000000000000000${suffix}`.padEnd(26, "0") as ArticleId;

export const ID = {
  A: ulid("0A"),
  B: ulid("0B"),
  C: ulid("0C"),
  D: ulid("0D"),
  E: ulid("0E"),
  F: ulid("0F"),
  G: ulid("0G"),
  H: ulid("0H"),
  J: ulid("0J"),
  K: ulid("0K"),
  SKIPPED: ulid("0M"),
  PENDING: ulid("0N"),
} as const;

/** Feed order of the fetched articles (newest first; C before D by listing position). */
export const FEED_ORDER: readonly ArticleId[] = [
  ID.A,
  ID.B,
  ID.C,
  ID.D,
  ID.E,
  ID.F,
  ID.G,
  ID.H,
  ID.J,
  ID.K,
];

export const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n, 8));

interface Seed {
  id: ArticleId;
  n: number;
  title: string;
  author: string | null;
  tags: string[];
  intro: string | null;
  body: string | null;
  publishedAt: Date | null;
  discoveredAt: Date;
  position?: number;
  pinned?: boolean;
  status?: "fetched" | "skipped" | "pending";
  format?: "html" | "markdown";
  titleParts?: { season: string | null; team: string | null; labels: string[]; topic: string };
}

export const ARTICLES: readonly Seed[] = [
  {
    id: ID.A,
    n: 1,
    title: "【RM2026-开源】ＨＰＭ5361 步兵底盘控制板",
    author: "Kaiser",
    tags: ["硬件/机器人硬件", "开源/PCB"],
    intro: "简介：全国产步兵底盘主控（Ｐｒｏ 版），带四路 CAN。",
    body: "大学步兵开源底盘，基于 HPM5361。步兵底盘的电机驱动走 CAN，步兵的功率控制在主控完成。步兵 底盘 参数见附录。",
    publishedAt: day(10),
    discoveredAt: day(10),
    format: "markdown",
    titleParts: {
      season: "RM2026",
      team: null,
      labels: ["开源"],
      topic: "ＨＰＭ5361 步兵底盘控制板",
    },
  },
  {
    id: ID.B,
    n: 2,
    title: "云台 PID 整定经验分享",
    author: "Lin",
    tags: ["算法/控制"],
    intro: null,
    body: "经验上 PID 整定先调 P，再调 D，最后加 I。云台电机用 GM6020，反馈来自 IMU。整定时步兵静置在台架上。".repeat(
      2,
    ),
    publishedAt: day(9),
    discoveredAt: day(9),
    format: "html",
  },
  {
    id: ID.C,
    n: 3,
    title: "英雄机器人 42mm 弹道分析",
    author: "Zhao",
    tags: ["算法/视觉"],
    intro: "弹道拟合与补偿。",
    body: "英雄 42mm 弹丸的弹道受初速影响明显，本文给出拟合曲线。",
    publishedAt: day(8),
    discoveredAt: day(8),
    position: 0,
  },
  {
    id: ID.D,
    n: 4,
    title: "工程机器人机械臂设计",
    author: "Wang",
    tags: ["机械/结构"],
    intro: null,
    body: "机械臂关节采用 M2006 电机，末端夹爪气动。",
    publishedAt: day(8),
    discoveredAt: day(8),
    position: 1,
  },
  {
    id: ID.E,
    n: 5,
    title: "哨兵导航方案",
    author: null,
    tags: ["算法/导航"],
    intro: null,
    body: "哨兵使用 2D 雷达建图，导航栈基于 ROS2。",
    publishedAt: null,
    discoveredAt: day(7),
  },
  {
    id: ID.F,
    n: 6,
    title: "电机选型指南：M3508 与 M2006",
    author: "Kaiser",
    tags: ["硬件/电机"],
    intro: "电机选型。",
    body: "电机 电机 电机：M3508 电机适合底盘，M2006 电机适合拨弹。电机的减速比决定扭矩。",
    publishedAt: day(6),
    discoveredAt: day(6),
  },
  {
    id: ID.G,
    n: 7,
    title: "视觉识别装甲板",
    author: "Sun",
    tags: ["算法/视觉"],
    intro: null,
    body: "装甲板灯条识别，OpenCV 传统方法。",
    publishedAt: day(5),
    discoveredAt: day(5),
  },
  {
    id: ID.H,
    n: 8,
    title: "步兵机器人整车方案",
    author: "Li",
    tags: ["机械/结构", "硬件/机器人硬件"],
    intro: null,
    body: "整车布局、重心与线束走向。参考 [1] 的做法。",
    publishedAt: day(4),
    discoveredAt: day(4),
    pinned: true,
  },
  {
    id: ID.J,
    n: 9,
    title: "供弹机构设计",
    author: "Li",
    tags: ["机械/结构"],
    intro: null,
    body: "供弹机构服务于步兵的发射系统，拨弹盘由 M2006 驱动。",
    publishedAt: day(3),
    discoveredAt: day(3),
  },
  {
    id: ID.K,
    n: 10,
    title: "无线图传调试",
    author: "Zhou",
    tags: ["硬件/通信"],
    intro: null,
    body: "图传延迟测量方法。",
    publishedAt: day(2),
    discoveredAt: day(2),
  },
  {
    id: ID.SKIPPED,
    n: 11,
    title: "跳过的帖子",
    author: "Nobody",
    tags: ["硬件/通信"],
    intro: null,
    body: null,
    publishedAt: day(1),
    discoveredAt: day(1),
    status: "skipped",
  },
  {
    id: ID.PENDING,
    n: 12,
    title: "尚未抓取",
    author: null,
    tags: [],
    intro: null,
    body: null,
    publishedAt: day(0),
    discoveredAt: day(0),
    status: "pending",
  },
];

export const AI = {
  [ID.A]: {
    overview: {
      genre: "开源项目",
      tldr: "全国产步兵底盘主控板",
      summary: "HPM5361 主控。",
      keyPoints: ["四路 CAN"],
      maturity: { status: "已验证", evidence: "上过赛场" },
    },
    kb: {
      domain: ["硬件", "嵌入式"],
      robotTypes: ["步兵"],
      problem: "底盘主控国产化",
      entities: ["HPM5361", "M3508"],
      pitfalls: ["CAN 终端电阻"],
      parameters: [{ name: "CAN 波特率", value: "1", unit: "Mbps" }],
    },
    images: [{ index: 1, kind: "实物照片", caption: "PCB 实物", textInImage: null, facts: [] }],
  },
  [ID.B]: {
    overview: { genre: "经验分享", tldr: "先调 P 再调 D", maturity: { status: "经验" } },
    kb: {
      domain: ["算法"],
      robotTypes: ["步兵", "英雄"],
      problem: "云台抖动",
      entities: ["M3508"],
      pitfalls: [],
    },
    images: [],
  },
  [ID.D]: {
    overview: { genre: "开源项目", tldr: "气动夹爪机械臂", maturity: { status: "原型" } },
    kb: {
      domain: ["机械"],
      robotTypes: ["工程"],
      problem: "取矿",
      entities: ["M2006"],
      pitfalls: ["气路漏气"],
    },
    images: [],
  },
} as const;

export const KB_TEXT = {
  [ID.A]: {
    tldr: "全国产步兵底盘主控板 HPM5361 主控。",
    problem: "底盘主控国产化",
    entities: "HPM5361 M3508",
  },
  [ID.B]: { tldr: "先调 P 再调 D", problem: "云台抖动", entities: "M3508" },
  [ID.D]: { tldr: "气动夹爪机械臂", problem: "取矿", entities: "M2006" },
} as const;

export interface SeededLibrary {
  db: BbsDb;
  library: Library;
  close(): Promise<void>;
}

export async function seedLibrary(databaseUrl = "pglite://memory"): Promise<SeededLibrary> {
  const db = await createDb(databaseUrl);
  await migrate(db);
  const now = day(11);
  await db.insert(sources).values({
    id: "src",
    kind: "bbs",
    name: "RM 论坛",
    siteUrl: "https://bbs.robomaster.com",
    backfillCompletedAt: day(9),
    createdAt: day(0),
    updatedAt: now,
  });
  await db.insert(pollRuns).values({
    id: "poll1",
    sourceId: "src",
    trigger: "cron",
    status: "ok",
    startedAt: day(10),
    finishedAt: day(10),
  });
  for (const a of ARTICLES) {
    const status = a.status ?? "fetched";
    await db.insert(articles).values({
      id: a.id,
      sourceId: "src",
      sourceArticleId: String(a.n),
      canonicalUrl: `https://bbs.robomaster.com/article/${a.n}`,
      urlHash: `h${a.n}`,
      title: a.title,
      author: a.author,
      publishedAt: a.publishedAt,
      discoveredAt: a.discoveredAt,
      fetchedAt: status === "fetched" ? a.discoveredAt : null,
      listingPosition: a.position ?? 0,
      isPinned: a.pinned ?? false,
      introduction: a.intro,
      contentFormat: a.body ? (a.format ?? "html") : null,
      contentRaw: a.body
        ? a.format === "markdown"
          ? `# ${a.title}\n\n${a.body}`
          : `<p>${a.body}</p>`
        : null,
      contentHtml: a.body ? `<p>${a.body}</p>` : null,
      bodyText: a.body,
      status,
      createdAt: a.discoveredAt,
      updatedAt: now,
      titleSeason: a.titleParts?.season ?? null,
      titleTeam: a.titleParts?.team ?? null,
      titleTopic: a.titleParts?.topic ?? a.title,
      titleLabels: a.titleParts?.labels ?? [],
    });
    if (a.tags.length) {
      await db
        .insert(articleTags)
        .values(a.tags.map((tag, position) => ({ articleId: a.id, tag, position })));
    }
    if (status !== "pending") {
      await db.insert(articleSearch).values({
        articleId: a.id,
        title: a.title,
        author: a.author ?? "",
        tags: a.tags.join(" "),
        introduction: a.intro ?? "",
        bodyText: a.body ?? "",
        document: buildDocument([
          a.title,
          a.author ?? "",
          a.tags.join(" "),
          a.intro ?? "",
          a.body ?? "",
        ]),
      });
    }
  }
  await db.insert(articleLinks).values([
    {
      id: "l1",
      articleId: ID.F,
      url: "https://bbs.robomaster.com/article/1",
      kind: "document",
      label: null,
      position: 0,
      targetArticleId: ID.A,
    },
    {
      id: "l2",
      articleId: ID.A,
      url: "https://github.com/example/hpm-board",
      kind: "repository",
      label: "仓库",
      position: 0,
      targetArticleId: null,
    },
    {
      id: "l3",
      articleId: ID.H,
      url: "https://bbs.robomaster.com/article/11",
      kind: "document",
      label: null,
      position: 0,
      targetArticleId: ID.SKIPPED,
    },
  ]);
  await db.insert(articleImages).values([
    {
      id: "i1",
      articleId: ID.A,
      url: "https://cdn.example/a1.png",
      alt: "",
      position: 0,
      caption: "PCB 实物",
    },
    {
      id: "i2",
      articleId: ID.A,
      url: "https://cdn.example/a2.png",
      alt: "原理图",
      position: 1,
      caption: null,
    },
    {
      id: "i3",
      articleId: ID.B,
      url: "https://cdn.example/b1.png",
      alt: null,
      position: 0,
      caption: null,
    },
  ]);
  for (const [id, ai] of Object.entries(AI)) {
    await db.insert(articleAi).values({
      articleId: id,
      status: "ready",
      promptVersion: "v3",
      model: "test-model",
      overviewJson: ai.overview,
      kbJson: ai.kb,
      imagesJson: ai.images,
      generatedAt: day(10),
      updatedAt: day(10),
    });
    const t = KB_TEXT[id as keyof typeof KB_TEXT];
    const fields = [t.tldr, t.problem, "", "", "", "", "", t.entities, "", ""];
    await db.insert(kbSearch).values({
      articleId: id,
      tldr: fields[0]!,
      problem: fields[1]!,
      approach: "",
      components: "",
      parameters: "",
      decisions: "",
      pitfalls: "",
      entities: fields[7]!,
      keywords: "",
      captions: "",
      document: buildDocument(fields),
    });
  }
  await db.insert(kbEntities).values([
    { key: "hpm5361", name: "HPM5361", articleCount: 1, updatedAt: now },
    { key: "m3508", name: "M3508", articleCount: 2, updatedAt: now },
    { key: "m2006", name: "M2006", articleCount: 1, updatedAt: now },
    { key: "orphan", name: "Orphan", articleCount: 0, updatedAt: now },
  ]);
  await db.insert(articleEntities).values([
    { articleId: ID.A, entityKey: "hpm5361" },
    { articleId: ID.A, entityKey: "m3508" },
    { articleId: ID.B, entityKey: "m3508" },
    { articleId: ID.D, entityKey: "m2006" },
  ]);
  await db.insert(importRuns).values({
    id: "run1",
    startedAt: day(11),
    finishedAt: day(11),
    sourcePath: "/import/app.db",
    sourceBytes: 1,
    ok: true,
    noop: false,
    tables: [],
    notes: [],
    renderVersion: "1",
    normalizeVersion: "1",
  });

  const search = selectSearchIndex("trgm", (q) => db.execute(q));
  const library = createLibrary({ db, search });
  return { db, library, close: () => db.close() };
}
