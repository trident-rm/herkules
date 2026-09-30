/** Differential checks against a fresh database, never the caller's corpus.
 * BBS_RUST_TEST_POSTGRES is a maintenance connection with CREATEDB privileges.
 * This script creates, seeds and drops its own randomly named database.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadHeadTemplate } from "../src/spa/head.ts";
import { nativeParity } from "./rust-native-parity.ts";
import { issuerParity } from "./rust-issuer-parity.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import postgres from "postgres";
import { ID, FEED_ORDER, seedLibrary } from "../tests/seed.ts";
import { buildDocument } from "../src/import/derive.ts";
import { withRustReads } from "../src/library/rust.ts";
import type {
  ArticleListQuery,
  SearchPage,
  ArticleSummary,
  Page,
  Cursor,
  ArticleId,
} from "../src/library/types.ts";

import { entityKey } from "../src/library/types.ts";

const maintenance = process.env.BBS_RUST_TEST_POSTGRES;
if (!maintenance)
  throw new Error(
    "Set BBS_RUST_TEST_POSTGRES to a disposable Postgres server's maintenance URL (CREATEDB required)",
  );
const root = fileURLToPath(new URL("../../../", import.meta.url));
const databaseName = `bbs_rust_parity_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = postgres(maintenance, { max: 1, onnotice: () => {} });
const databaseUrl = new URL(maintenance);
databaseUrl.pathname = `/${databaseName}`;
let fixture: Awaited<ReturnType<typeof seedLibrary>> | undefined;
let child: ReturnType<typeof spawn> | undefined;
let created = false;
try {
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  created = true;
  fixture = await seedLibrary(databaseUrl.href);
  child = spawn(process.env.BBS_RUST_BINARY ?? resolve(root, "target/debug/herkules-bbs"), [], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl.href,
      APP_ORIGIN: "https://bbs.example",
      BBS_RUST_LISTEN: "127.0.0.1:0",
      WEB_DIR: resolve(root, "apps/bbs/dist/client"),
      RUST_LOG: "info",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const running = child;
  const origin = await new Promise<string>((accept, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error("Rust service did not become ready in 15 seconds")),
      15_000,
    );
    const finish = (error?: Error, value?: string) => {
      clearTimeout(timer);
      if (error) reject(error);
      else accept(value!);
    };
    running.once("error", (error) => finish(error));
    running.once("exit", (code) =>
      finish(new Error(`Rust service exited before readiness (${code})`)),
    );
    running.stdout!.on("data", (chunk: Buffer) => {
      output += stripVTControlCharacters(chunk.toString());
      const match = /address=127\.0\.0\.1:(\d+)/.exec(output);
      if (match) finish(undefined, `http://127.0.0.1:${match[1]}`);
    });
    running.stderr!.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  });
  const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
  const rust = withRustReads(fixture.library, { origin });
  let checks = await nativeParity(databaseUrl.href, fixture.library, fixture.db, root);
  checks += await issuerParity(databaseUrl.href, root);
  const feedQueries: ArticleListQuery[] = [
    { limit: 1 },
    { limit: 2 },
    { limit: 3 },
    { limit: 100 },
    { tag: "机械/结构", limit: 2 },
    { group: "硬件", limit: 2 },
    { group: "硬件", tag: "硬件/电机", limit: 1 },
    { group: "missing", limit: 2 },
    { tag: "x' OR true --", limit: 2 },
    ...[
      "步兵",
      "ＰＩＤ",
      '"步兵" 底盘',
      "m3508",
      " ",
      '""',
      "100%",
      "%",
      "_",
      "\\",
      "a_b",
      "C:\\bin",
      "İ",
      "𐐀",
      "a b c d e f g h i",
    ].flatMap((q) => (["all", "title", "kb"] as const).map((scope) => ({ q, scope, limit: 2 }))),
  ];
  for (const query of feedQueries) {
    let cursor: Cursor | undefined;
    const seen: string[] = [];
    do {
      const expected: Page<ArticleSummary> = await fixture.library.articles({ ...query, cursor });
      const actual: Page<ArticleSummary> = await rust.articles({ ...query, cursor });
      assert.deepEqual(
        json(actual),
        json(expected),
        `feed ${JSON.stringify({ ...query, cursor })}`,
      );
      assert.ok(
        actual.items.every((item) => item.discoveredAt instanceof Date),
        "feed MCP dates",
      );
      seen.push(...actual.items.map((item) => item.id));
      assert.equal(new Set(seen).size, seen.length, "paging contains no duplicates");
      cursor = actual.nextCursor ?? undefined;
      checks++;
    } while (cursor);
  }
  for (const query of feedQueries.filter((q) => q.q?.trim() && q.q !== '""')) {
    let cursor: Cursor | undefined;
    do {
      const expected: SearchPage = await fixture.library.search({ ...query, q: query.q!, cursor });
      const actual: SearchPage = await rust.search({ ...query, q: query.q!, cursor });
      assert.deepEqual(
        json(actual),
        json(expected),
        `search ${JSON.stringify({ ...query, cursor })}`,
      );
      cursor = actual.nextCursor ?? undefined;
      checks++;
    } while (cursor);
  }
  for (const q of ['""', '" "']) {
    await assert.rejects(() => rust.search({ q, limit: 2 }), { code: "empty_query" });
    checks++;
  }
  for (const q of [undefined, "步兵", "PID", "%", '""', "m3508"]) {
    for (const domain of [undefined, "控制", "机械", "missing"]) {
      for (const robot of [undefined, "步兵", "机械臂"]) {
        for (const genre of [undefined, "开源项目", "经验分享"]) {
          const query = { q, domain, robot, genre, limit: 1 };
          assert.deepEqual(
            json(await rust.kbBrowse(query)),
            json(await fixture.library.kbBrowse(query)),
            `KB ${JSON.stringify(query)}`,
          );
          checks++;
        }
      }
    }
  }
  for (const q of [undefined, "m3508", "PID", "%", "_", "\\", "missing"]) {
    for (const limit of [1, 200, 500]) {
      const query = { q, limit };
      assert.deepEqual(
        json(await rust.entities(query)),
        json(await fixture.library.entities(query)),
        `entities ${JSON.stringify(query)}`,
      );
      checks++;
    }
  }
  const entities = await fixture.library.entities({ limit: 500 });
  for (const key of [...entities.map((e) => e.key), entityKey("missing")]) {
    assert.deepEqual(
      json(await rust.entity(key)),
      json(await fixture.library.entity(key)),
      `entity ${key}`,
    );
    assert.deepEqual(
      json(await rust.entityHead(key)),
      json(await fixture.library.entityHead(key)),
      `entity head ${key}`,
    );
    checks += 2;
  }
  for (const id of [...Object.values(ID), "01J0000000000000000000000Z" as ArticleId]) {
    assert.deepEqual(json(await rust.head(id)), json(await fixture.library.head(id)), `head ${id}`);
    checks++;
  }
  const expectedStatus = await fixture.library.status();
  const actualStatus = await rust.status();
  assert.ok(
    Math.abs(
      (actualStatus.crawler.lastCheckedAgeSeconds ?? 0) -
        (expectedStatus.crawler.lastCheckedAgeSeconds ?? 0),
    ) <= 1,
    "status age within request time",
  );
  assert.deepEqual(
    json({
      ...actualStatus,
      crawler: {
        ...actualStatus.crawler,
        lastCheckedAgeSeconds: expectedStatus.crawler.lastCheckedAgeSeconds,
      },
    }),
    json(expectedStatus),
    "status counts and dates",
  );
  checks++;
  for (const path of [
    "/api/articles?limit=-1",
    "/api/articles?limit=1.5",
    "/api/articles?scope=other",
    `/api/articles?q=${"a".repeat(201)}`,
  ]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 400, path);
    assert.equal(((await response.json()) as { error: string }).error, "invalid_request");
    checks++;
  }
  const rankedCursor = (await fixture.library.search({ q: "步兵", limit: 1 })).nextCursor!;
  for (const cursor of ["garbled", rankedCursor]) {
    await assert.rejects(rust.articles({ limit: 2, cursor: cursor as Cursor }), {
      name: "QueryError",
      code: "invalid_cursor",
    });
    checks++;
  }
  for (const [raw, limit] of [
    ["0", 20],
    ["1000", 100],
    ["2e1", 20],
    ["0x14", 20],
    ["0b10", 2],
    ["0o2", 2],
    ["", 20],
  ] as const) {
    const response = await fetch(`${origin}/api/articles?limit=${raw}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), json(await fixture.library.articles({ limit })));
    checks++;
  }

  // Exercise the last tie-breaker independently of the seed's date/position ordering.
  const tieEdits = postgres(databaseUrl.href, { max: 1 });
  const original =
    await tieEdits`SELECT id, published_at, listing_position FROM articles WHERE id IN (${ID.C}, ${ID.D}, ${ID.E})`;
  try {
    await tieEdits`UPDATE articles SET published_at='2026-01-07T08:00:00.000Z', listing_position=12 WHERE id IN (${ID.C}, ${ID.D}, ${ID.E})`;
    let cursor: Cursor | undefined;
    const ids: string[] = [];
    do {
      const expected: Page<ArticleSummary> = await fixture.library.articles({ limit: 1, cursor });
      const actual: Page<ArticleSummary> = await rust.articles({ limit: 1, cursor });
      assert.deepEqual(json(actual), json(expected), "feed date/position/id ties");
      ids.push(...actual.items.map((item) => item.id));
      cursor = actual.nextCursor ?? undefined;
      checks++;
    } while (cursor);
    assert.equal(new Set(ids).size, FEED_ORDER.length);
  } finally {
    for (const row of original) {
      await tieEdits`UPDATE articles SET published_at=${row.published_at}, listing_position=${row.listing_position} WHERE id=${row.id}`;
    }
    await tieEdits.end();
  }
  for (const id of [
    ...FEED_ORDER,
    ID.SKIPPED,
    ID.PENDING,
    "01J0000000000000000000000Z" as ArticleId,
  ]) {
    assert.deepEqual(
      json(await rust.article(id)),
      json(await fixture.library.article(id)),
      `article ${id}`,
    );
    checks++;
    assert.deepEqual(json(await rust.ai(id)), json(await fixture.library.ai(id)), `AI ${id}`);
    checks++;
    for (const format of ["text", "markdown", "html"] as const) {
      assert.deepEqual(
        await rust.content(id, format),
        await fixture.library.content(id, format),
        `${id} ${format}`,
      );
      checks++;
    }
  }
  assert.deepEqual(
    await rust.tags(),
    await fixture.library.tags(),
    "tag and distinct-group counts",
  );
  checks++;
  assert.equal(
    (await rust.article(ID.A))?.publishedAt instanceof Date,
    true,
    "MCP receives Date values",
  );
  checks++;
  const lowercase = await fetch(`${origin}/api/articles/${ID.A.toLowerCase()}`);
  assert.deepEqual(await lowercase.json(), json(await fixture.library.article(ID.A)));
  checks++;
  for (const path of ["/api/articles/bad", `/api/articles/${ID.A}/content?format=pdf`]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: string }).error, "invalid_request");
    checks++;
  }
  for (const id of [ID.SKIPPED, ID.PENDING]) {
    assert.equal((await fetch(`${origin}/articles/${id}`)).status, 404);
    checks++;
  }
  const page = await fetch(`${origin}/articles/${ID.A}`);
  assert.equal(page.status, 200);
  checks++;
  assert.equal(page.headers.get("cache-control"), "no-store");
  checks++;
  assert.match(page.headers.get("content-security-policy")!, /default-src 'none'/);
  checks++;
  const html = await page.text();
  const article = (await fixture.library.article(ID.A))!;
  assert.ok(html.includes(article.contentHtml!), "the initial document contains the article body");
  checks++;
  assert.ok(!html.includes("<script"), "reader requires no hydration");
  checks++;
  assert.ok(html.includes(`https://bbs.example/articles/${ID.A}`));
  checks++;
  const stylesheet = /href="(\/assets\/[^"]+\.css)"/.exec(html)?.[1];
  assert.ok(stylesheet, "reader references the Vite manifest stylesheet");
  checks++;
  const css = await fetch(`${origin}${stylesheet}`);
  assert.equal(css.status, 200);
  checks++;
  assert.match(await css.text(), /ssr-reader/);
  checks++;
  assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  checks++;
  // Rust serves every browser document and public asset without a Node proxy.
  const indexHtml = await readFile(resolve(root, "apps/bbs/dist/client/index.html"), "utf8");
  for (const path of [
    "/",
    "/feed?q=PID",
    "/search?q=PID",
    "/kb",
    "/tags",
    "/status",
    "/account",
    "/unknown-browser-route",
  ]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("cache-control"), "no-cache");
    assert.equal(await response.text(), indexHtml, path);
    checks++;
  }
  const headPage = await fetch(`${origin}/account`, { method: "HEAD" });
  assert.equal(headPage.status, 200);
  assert.equal(await headPage.text(), "");
  checks++;
  assert.equal((await fetch(`${origin}/account`, { method: "POST" })).status, 405);
  checks++;
  for (const path of [
    "/assets/missing.js",
    "/fonts/missing.woff2",
    "/api/not-a-route",
    "/mcp/not-a-route",
    "/assets/%2e%2e%2findex.html",
  ]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 404, path);
    assert.notEqual(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.deepEqual(
      await response.json(),
      { error: "not_found", error_description: "no such route" },
      path,
    );
    checks++;
  }
  assert.equal(css.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const appAsset = /src="(\/assets\/[^"]+\.js)"/.exec(indexHtml)![1];
  const asset = await fetch(`${origin}${appAsset}`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type")!, /javascript/);
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
  checks++;
  const robots = await fetch(`${origin}/robots.txt`);
  assert.equal(robots.status, 200);
  assert.equal(robots.headers.get("cache-control"), "public, max-age=3600");
  checks++;
  for (const name of [...entities.map((entity) => entity.name), "missing", "%"]) {
    const path = `/kb/${encodeURIComponent(name)}`;
    const meta = await fixture.library.entityHead(entityKey(name));
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, meta ? 200 : 404);
    assert.equal(
      await response.text(),
      meta ? loadHeadTemplate(indexHtml).render(meta, "https://bbs.example") : indexHtml,
    );
    checks++;
  }
  assert.equal((await fetch(`${origin}/kb/%`)).status, 404);
  checks++;
  // Adversarial metadata and a plain-text fallback must stay escaped in SSR.
  const edits = postgres(databaseUrl.href, { max: 1 });
  try {
    await edits`UPDATE articles SET title = ${'<script>alert("title")</script>'},
      content_html = NULL, body_text = ${"<img src=x onerror=alert(1)>"} WHERE id = ${ID.A}`;
    const escaped = await (await fetch(`${origin}/articles/${ID.A}`)).text();
    assert.ok(!escaped.includes("<script>"));
    checks++;
    assert.ok(!escaped.includes("<img src=x"));
    checks++;
    assert.match(escaped, /(?:&lt;|&#60;|&#x3c;)script(?:&gt;|&#62;|&#x3e;)/i);
    checks++;
    assert.match(escaped, /(?:&lt;|&#60;|&#x3c;)img/i);
    checks++;
  } finally {
    await edits.end();
  }
  // Model blobs have several historical shapes. Compare lenient normalization
  // and failed/pending state handling against the existing parser.
  const aiEdits = postgres(databaseUrl.href, { max: 1 });
  try {
    for (const [status, overview, kb, images] of [
      [
        "ready",
        {
          keyPoints: [2, "ok"],
          extras: { lessons: [null, {}, { constraint: "x" }] },
          faq: [1, {}],
        },
        { parameters: [null, {}, { name: "gain", value: 2 }], interfaces: ["CAN", 2] },
        [false, { index: 2.0 }, { index: 1.5 }],
      ],
      ["ready", "broken", [], "bad"],
      ["failed", { tldr: "hidden" }, {}, []],
      ["unexpected", {}, {}, []],
    ] as const) {
      await aiEdits`UPDATE article_ai SET status=${status}, overview_json=${aiEdits.json(overview)}, kb_json=${aiEdits.json(kb)}, images_json=${aiEdits.json(images)} WHERE article_id=${ID.A}`;
      assert.deepEqual(
        json(await rust.ai(ID.A)),
        json(await fixture.library.ai(ID.A)),
        `AI state ${status}`,
      );
      checks++;
    }
    // Reader heading anchors and sidebar content render in the initial document.
    await aiEdits`UPDATE articles SET content_html=${"<h2>First &amp; safe</h2><p>body</p><h3>Second &lt;title&gt;</h3>"} WHERE id=${ID.A}`;
    const sidebar = await (await fetch(`${origin}/articles/${ID.A}`)).text();
    assert.match(sidebar, /aria-label="文章辅助"/);
    assert.match(sidebar, /href="#sec-1"/);
    assert.match(sidebar, /id="sec-2"/);
    assert.match(sidebar, /reader-side-resources/);
    checks += 4;
  } finally {
    await aiEdits.end();
  }
  // Exercise UTF-16 snippet boundaries, overlap merging, field choice and the
  // per-term occurrence cap on actual ranked responses.
  const edgeEdits = postgres(databaseUrl.href, { max: 1 });
  try {
    const base = (
      await edgeEdits`SELECT title, author, tags, introduction FROM article_search WHERE article_id=${ID.A}`
    )[0]!;
    for (const [body, queries] of [
      ["🤖".repeat(31) + "ＰＩＤ\t电机\n" + "🤖".repeat(40), ["pid", "PID 电机", "🤖"]],
      [
        "prefix\uFEFF" + "PID ".repeat(70) + "底盘 PID 电机 suffix",
        ["pid", "底盘 pid", "pid 电机"],
      ],
      [
        "x".repeat(150) + "机器机器人\n\t[1] ＰＩＤ" + "x".repeat(150),
        ["机器 机器人", "机器人 pid", "[1]"],
      ],
      ["İ 𐐀 𐐨 100% a_b C:\\bin ", ["İ", "𐐀", "𐐨", "100%", "a_b", "C:\\bin"]],
    ] as const) {
      const document = buildDocument([
        String(base.title),
        String(base.author),
        String(base.tags),
        String(base.introduction),
        body,
      ]);
      await edgeEdits`UPDATE article_search SET body_text=${body},document=${document} WHERE article_id=${ID.A}`;
      await edgeEdits`UPDATE articles SET body_text=${body} WHERE id=${ID.A}`;
      for (const q of queries) {
        let cursor: Cursor | undefined;
        do {
          const expected: SearchPage = await fixture.library.search({ q, limit: 1, cursor });
          const actual: SearchPage = await rust.search({ q, limit: 1, cursor });
          assert.deepEqual(json(actual), json(expected), `snippet edge ${q}`);
          cursor = actual.nextCursor ?? undefined;
          checks++;
        } while (cursor);
      }
    }
    for (const kb of [
      { domain: "scalar", robotTypes: false },
      {
        domain: ["控制", null, 2, "控制", "🤖", "𐐀"],
        robotTypes: ["步兵", {}, true],
        entities: [1, "PID"],
        pitfalls: [null, "test"],
      },
    ]) {
      await edgeEdits`UPDATE article_ai SET status='ready',overview_json=${edgeEdits.json({ genre: 123 })},kb_json=${edgeEdits.json(kb)} WHERE article_id=${ID.A}`;
      for (const query of [
        { limit: 1000 },
        { domain: "控制", limit: 1 },
        { robot: "步兵", limit: 2 },
      ]) {
        assert.deepEqual(
          json(await rust.kbBrowse(query)),
          json(await fixture.library.kbBrowse(query)),
          "malformed facet arrays",
        );
        checks++;
      }
    }
    for (const name of ["İ", "Σ ΟΣ", "𐐀", "控制 🤖", "Name/(!'*.)"]) {
      const key = entityKey(name);
      await edgeEdits`INSERT INTO kb_entities (key,name,article_count,updated_at) VALUES (${key},${name},1,now())`;
      await edgeEdits`INSERT INTO article_entities (article_id,entity_key) VALUES (${ID.A},${key})`;
      assert.deepEqual(
        json(await rust.entity(key)),
        json(await fixture.library.entity(key)),
        `Unicode entity ${name}`,
      );
      assert.deepEqual(
        json(await rust.entityHead(key)),
        json(await fixture.library.entityHead(key)),
        `Unicode entity head ${name}`,
      );
      const direct = await fetch(`${origin}/api/kb/entities/${encodeURIComponent(name)}`);
      assert.deepEqual(
        await direct.json(),
        json(await fixture.library.entity(key)),
        `display name entity ${name}`,
      );
      checks += 3;
    }
    const orphan = entityKey("orphan");
    assert.deepEqual(
      json(await rust.entity(orphan)),
      json(await fixture.library.entity(orphan)),
      "orphan detail survives",
    );
    assert.equal(await rust.entityHead(orphan), null, "orphan head hidden");
    checks += 2;
  } finally {
    await edgeEdits.end();
  }
  console.log(
    `Rust parity passed: ${checks} checks, shared Postgres fixture, rendered reader and Vite CSS`,
  );
} finally {
  try {
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit");
      const kill = setTimeout(() => child?.kill("SIGKILL"), 5_000);
      child.kill("SIGTERM");
      await stopped;
      clearTimeout(kill);
    }
  } finally {
    await fixture?.close();
    if (created) await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin.end();
  }
}
