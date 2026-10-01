/** Fixture-only crawler migration checks. Creates and drops its own Postgres databases. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import postgres from "postgres";
import { parseDocument, DomUtils } from "htmlparser2";
import { extract } from "../src/content/extract.ts";
import { renderArticleHtml } from "../src/content/render.ts";
import { createCrawler, WORKER_LOCK_KEY } from "../src/crawl/index.ts";
import { createCorpus } from "../src/crawl/corpus.ts";
import { createDb, migrate } from "../src/db/index.ts";
import { rederive } from "../src/crawl/rederive.ts";
import { PERMISSIVE_GUARD } from "../src/guard/index.ts";
import { fakeForum, post } from "../tests/crawl-helpers.ts";
import { createRobomasterSource } from "../src/source/robomaster.ts";
import { createGuard } from "../src/guard/index.ts";
import { memoryGuardStore } from "../src/guard/store.ts";
import { systemClock } from "../src/guard/clock.ts";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const binary = process.env.BBS_RUST_BINARY ?? join(root, "target/debug/herkules-bbs");
const probe = spawn(join(root, "target/debug/examples/crawler_probe"), [], {
  stdio: ["pipe", "pipe", "inherit"],
});
const lines = createInterface({ input: probe.stdout });
const iterator = lines[Symbol.asyncIterator]();
let checks = 0;
async function call(input: object): Promise<any> {
  probe.stdin.write(`${JSON.stringify(input)}\n`);
  const next = await iterator.next();
  if (next.done) throw new Error("Rust crawler fixture probe exited");
  return JSON.parse(next.value);
}
function same(a: unknown, b: unknown, label: string) {
  assert.deepEqual(a, b, label);
  checks++;
}
// Compare browser trees, allowing serializer attribute ordering and void-tag spelling.
function tree(html: string): unknown {
  function node(n: ReturnType<typeof parseDocument>["children"][number]): unknown {
    if (DomUtils.isText(n)) return n.data.trim() ? { text: n.data } : null;
    if (!DomUtils.isTag(n)) return null;
    const attrs = Object.fromEntries(
      Object.entries(n.attribs).sort(([a], [b]) => a.localeCompare(b)),
    );
    return {
      tag: n.name,
      attrs,
      children: n.children.flatMap((child) => {
        // HTML5 inserts an implicit tbody around bare tr rows; browsers render these identically.
        if (
          DomUtils.isTag(child) &&
          child.name === "tbody" &&
          Object.keys(child.attribs).length === 0
        )
          return child.children.map(node).filter(Boolean);
        return [node(child)].filter(Boolean);
      }),
    };
  }
  return parseDocument(html).children.map(node).filter(Boolean);
}
const baseUrl = "https://bbs.robomaster.com/article/1";
const contentCases: [string, string, string?][] = [
  [
    "html",
    '<h2>框架</h2><p>文本 <strong>加粗</strong></p><pre>one\n  two  \n</pre><a href="https://GitHub.com/a?utm_x=1&b=2">源码</a><img src="/a.png" alt="图">',
  ],
  ["html", "<table><tr><th>名称</th><th>值</th></tr><tr><td>a</td><td>1</td></tr></table>"],
  [
    "html",
    "<ul><li>Item 1<ul><li>Sub</li></ul></li><li><p>Item 2</p></li></ul><blockquote><p>a quote</p><p>b quote</p></blockquote>",
  ],
  ["html", "<p>visible</p><script>alert(1)</script><style>p{}</style><noscript>no js</noscript>"],
  [
    "html",
    '<h1>Title</h1><p onclick="x()">Hello <a href="javascript:alert(1)">bad</a><img src="data:x" onerror="x()"></p>',
  ],
  [
    "html",
    '<p style="text-align:center;color:rgb(0,0,0);position:fixed">Hello</p><p style="background-color:#ff0000;width:33px">World</p>',
  ],
  [
    "html",
    '<iframe src="https://player.bilibili.com/player.html?bvid=1"></iframe><iframe src="https://example.com/video"></iframe>',
  ],
  [
    "html",
    '<video src="/a.mp4" poster="" width="auto"><source src="/a.webm" type="video/webm"></video>',
  ],
  [
    "html",
    '<p><span data-w-e-type="reference" data-link="bbs://reference.com/x/y/123/1">[1]</span></p>',
  ],
  [
    "html",
    '<p>延迟 <span data-w-e-type="mathLatex" data-content="x^2"><math><mi>x</mi></math></span>以内</p><math><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">x^2</annotation></semantics></math>',
  ],
  [
    "html",
    '<input type="checkbox" checked><input type="text"><code class="language-rust bad">code</code>',
  ],
  [
    "markdown",
    "## 框架\n\n使用插件系统。\n\n[仓库](https://gitee.com/a/b)\n\n![图](https://cdn.example.com/power.png)\n",
  ],
  ["markdown", "- [x] Done\n- [ ] Todo\n\n```rust\nlet x = 1;\n```\n\n~~strike~~ **bold**\n"],
  ["markdown", "|名称|值|\n|---|---|\n|a|1|\n"],
  [
    "markdown",
    '<img src="https://example.com/a.png">\n\nText <a href="https://example.com/x">link</a>',
  ],
];
const maintenance = process.env.BBS_RUST_TEST_POSTGRES;
if (!maintenance)
  throw new Error(
    "Set BBS_RUST_TEST_POSTGRES to a disposable Postgres maintenance URL (CREATEDB required)",
  );
const admin = postgres(maintenance, { max: 1, onnotice: () => {} });
const databases: string[] = [];
const connections: ReturnType<typeof postgres>[] = [];
const handles: Awaited<ReturnType<typeof createDb>>[] = [];
try {
  for (const [format, raw, title = "Title"] of contentCases) {
    const expected = extract(format as "html" | "markdown", raw, baseUrl);
    const actual = await call({ op: "derive", format, raw, baseUrl, title });
    same(actual.extracted, expected, `extraction: ${raw}`);
    same(
      tree(actual.html),
      tree(
        renderArticleHtml({
          format: format as "html" | "markdown",
          raw,
          baseUrl,
          title,
          links: expected.links,
        }),
      ),
      `render: ${raw}`,
    );
  }
  for (const name of ["post_html", "post_markdown"]) {
    const json = JSON.parse(
      await readFile(new URL(`../tests/fixtures/robomaster/${name}.json`, import.meta.url), "utf8"),
    );
    const forum = fakeForum({ posts: [json.data] });
    const guard = await createGuard({
      sourceId: "robomaster",
      store: memoryGuardStore(),
      clock: systemClock,
      config: PERMISSIVE_GUARD,
    });
    const expected = await createRobomasterSource({ fetch: forum.fetch, guard }).fetchDetail(
      String(json.data.id),
      "background",
    );
    const actual = await call({ op: "detail", json });
    if (actual.publishedAt) actual.publishedAt = new Date(actual.publishedAt).toISOString();
    same(actual, JSON.parse(JSON.stringify(expected)), `${name} adapter`);
  }
  for (let i = 0; i < 2; i++) {
    const name = `bbs_crawl_parity_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    databases.push(name);
    const url = new URL(maintenance);
    url.pathname = `/${name}`;
    const db = await createDb(url.href);
    handles.push(db);
    await migrate(db);
    await rederive(db);
    connections.push(postgres(url.href, { max: 1, onnotice: () => {} }));
  }
  const [nodeDb] = handles;
  const [nodeSql, rustSql] = connections;
  const rustUrl = new URL(maintenance);
  rustUrl.pathname = `/${databases[1]}`;
  const entries = [
    post(1),
    post(2, { top: true }),
    post(3, { htmlContent: "<p>short</p>" }),
    post(4),
    post(5, {
      title: "【RM2026-开源】深圳大学 RobotPilots战队",
      htmlContent: `<p>${"正文测试".repeat(40)}</p><a href="${baseUrl}">参考</a><img src="https://example.com/a.png">`,
    }),
  ];
  entries.push(post(6));
  const pages = [entries.slice(0, 3), entries.slice(3)];
  const posts = Object.fromEntries(entries.filter((p) => p.id !== 6).map((p) => [String(p.id), p]));
  const forum = fakeForum({ pages, posts: entries, total: entries.length });
  forum.posts.delete("6");
  const crawler = createCrawler({
    db: nodeDb,
    fetch: forum.fetch,
    guard: PERMISSIVE_GUARD,
    log: () => {},
  });
  async function cycle() {
    const expected = await crawler.once();
    same(
      await call({ op: "cycle", database: rustUrl.href, pages, posts, total: entries.length }),
      expected,
      "manual cycle counters",
    );
  }
  async function snapshot(sql: ReturnType<typeof postgres>) {
    const articles =
      await sql`SELECT source_article_id,canonical_url,url_hash,title,title_season,title_team,title_topic,title_labels,author,published_at,listing_position,is_pinned,introduction,content_format,content_raw,body_text,content_hash,parser_version,status,skip_reason,last_error FROM articles ORDER BY source_article_id`;
    const tags =
      await sql`SELECT a.source_article_id,t.tag,t.position FROM article_tags t JOIN articles a ON a.id=t.article_id ORDER BY a.source_article_id,t.position`;
    const links =
      await sql`SELECT a.source_article_id,l.url,l.kind,l.label,l.position,target.source_article_id AS target FROM article_links l JOIN articles a ON a.id=l.article_id LEFT JOIN articles target ON target.id=l.target_article_id ORDER BY a.source_article_id,l.position`;
    const images =
      await sql`SELECT a.source_article_id,i.url,i.alt,i.position,i.caption,i.image_kind,i.image_text FROM article_images i JOIN articles a ON a.id=i.article_id ORDER BY a.source_article_id,i.position`;
    const search =
      await sql`SELECT a.source_article_id,s.title,s.author,s.tags,s.introduction,s.body_text,s.document FROM article_search s JOIN articles a ON a.id=s.article_id ORDER BY a.source_article_id`;
    const sources =
      await sql`SELECT backfill_next_page,backfill_completed_at IS NOT NULL AS completed,last_checked_at IS NOT NULL AS checked FROM sources`;
    return JSON.parse(JSON.stringify({ articles, tags, links, images, search, sources }));
  }
  await cycle();
  same(await snapshot(rustSql), await snapshot(nodeSql), "stored corpus and search parity");
  const before = await snapshot(rustSql);
  await cycle();
  same(await snapshot(rustSql), before, "repeat crawl is idempotent");
  // A later search-write failure rolls back the entire article/link/image transaction.
  const rejected = { ...entries[4], title: "Reject fixture write" };
  for (const sql of connections)
    await sql.unsafe(
      "ALTER TABLE article_search ADD CONSTRAINT fixture_write_failure CHECK (title <> 'Reject fixture write')",
    );
  const nodeSource = createRobomasterSource({
    fetch: fakeForum({ posts: [rejected] }).fetch,
    guard: await createGuard({
      sourceId: "robomaster",
      store: memoryGuardStore(),
      clock: systemClock,
      config: PERMISSIVE_GUARD,
    }),
  });
  const rejectedDetail = await nodeSource.fetchDetail("5", "background");
  const nodeId = (await nodeSql`SELECT id FROM articles WHERE source_article_id='5'`)[0].id;
  const rustId = (await rustSql`SELECT id FROM articles WHERE source_article_id='5'`)[0].id;
  await assert.rejects(
    createCorpus(nodeDb, "robomaster").storeDetail(nodeId, rejectedDetail, new Date()),
  );
  checks++;
  assert.ok(
    (
      await call({
        op: "store",
        database: rustUrl.href,
        id: rustId,
        json: { success: true, data: rejected },
      })
    ).error,
  );
  checks++;
  same(await snapshot(rustSql), before, "failed write rolls back corpus, links, images and index");
  for (const sql of connections)
    await sql.unsafe("ALTER TABLE article_search DROP CONSTRAINT fixture_write_failure");
  // Missing introduction is filled even when position/pinning do not change.
  const updated = { ...entries[0], introduction: "New introduction" };
  const listing = { success: true, data: { total: 1, list: [updated] } };
  const guard = await createGuard({
    sourceId: "robomaster",
    store: memoryGuardStore(),
    clock: systemClock,
    config: PERMISSIVE_GUARD,
  });
  const listed = await createRobomasterSource({
    fetch: fakeForum({ pages: [[updated]] }).fetch,
    guard,
  }).listPage(1, 20, "background");
  await createCorpus(nodeDb, "robomaster").discover(listed.items, new Date());
  await call({ op: "discover", database: rustUrl.href, json: listing });
  same(
    (await rustSql`SELECT introduction FROM articles WHERE source_article_id='1'`)[0].introduction,
    "New introduction",
    "introduction backfill regression",
  );
  same(await snapshot(rustSql), await snapshot(nodeSql), "discovery upsert parity");
  // Refresh consumes the queued request and retains AI captions / unchanged content timestamp.
  for (const sql of connections) {
    await sql`UPDATE articles SET refresh_requested_at=now() WHERE source_article_id='5'`;
    await sql`UPDATE article_images SET caption='Keep me',image_kind='diagram',image_text='text'`;
  }
  const originalChanged = (
    await rustSql`SELECT content_changed_at FROM articles WHERE source_article_id='5'`
  )[0].content_changed_at;
  await cycle();
  same(await snapshot(rustSql), await snapshot(nodeSql), "refresh and caption preservation");
  same(
    (await rustSql`SELECT content_changed_at FROM articles WHERE source_article_id='5'`)[0]
      .content_changed_at,
    originalChanged,
    "unchanged content timestamp preserved",
  );
  same(
    (
      await rustSql`SELECT count(*)::int AS n FROM articles WHERE refresh_requested_at IS NOT NULL`
    )[0].n,
    0,
    "refresh queue consumed",
  );
  // A bad refresh leaves the already-public body and captions intact, but consumes its queue entry.
  const retained = await snapshot(rustSql);
  const short = { ...entries[4], htmlContent: "<p>short</p>" };
  posts["5"] = short;
  forum.posts.set("5", short);
  for (const sql of connections)
    await sql`UPDATE articles SET refresh_requested_at=now() WHERE source_article_id='5'`;
  await cycle();
  same(await snapshot(rustSql), await snapshot(nodeSql), "short refresh failure parity");
  const afterShort = await snapshot(rustSql);
  same(
    afterShort.articles.find((a: any) => a.source_article_id === "5").body_text,
    retained.articles.find((a: any) => a.source_article_id === "5").body_text,
    "failed refresh retains fetched content",
  );
  same(afterShort.images, retained.images, "failed refresh retains image captions");
  posts["5"] = entries[4];
  forum.posts.set("5", entries[4]);
  // Recover failed articles on the same hourly retry schedule.
  for (const sql of connections)
    await sql`UPDATE articles SET status='failed',updated_at=now()-interval '2 hours' WHERE source_article_id='1'`;
  await cycle();
  same(await snapshot(rustSql), await snapshot(nodeSql), "failed article retry parity");
  // A failed backfill page must not discard page-one discovery or move the cursor.
  for (const sql of connections) {
    await sql`UPDATE sources SET backfill_completed_at=NULL,backfill_next_page=2`;
  }
  const failingForum = fakeForum({ pages, posts: entries, total: entries.length });
  const normalFetch = failingForum.fetch;
  const failFetch: typeof fetch = (input, init) => {
    if (JSON.parse(typeof init?.body === "string" ? init.body : "{}").pageNo === 2)
      return Promise.resolve(new Response("unavailable", { status: 503 }));
    return normalFetch(input, init);
  };
  const expectedFailure = await createCrawler({
    db: nodeDb,
    fetch: failFetch,
    guard: PERMISSIVE_GUARD,
    log: () => {},
  }).once();
  same(
    await call({
      op: "cycle",
      database: rustUrl.href,
      pages,
      posts,
      total: entries.length,
      backfillFails: true,
    }),
    expectedFailure,
    "backfill failure preserves discovery",
  );
  same(
    (
      await rustSql`SELECT backfill_next_page,last_checked_at IS NOT NULL AS checked FROM sources`
    )[0].backfill_next_page,
    2,
    "backfill failure retains cursor",
  );
  // Production binary refuses both daemon and --once before a forum request when Node's lock is held.
  await rustSql`SELECT pg_advisory_lock(${WORKER_LOCK_KEY})`;
  for (const argv of [["work"], ["work", "--once"]]) {
    let status = 0;
    try {
      execFileSync(binary, argv, {
        env: { ...process.env, DATABASE_URL: rustUrl.href },
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      status = (e as { status: number }).status;
    }
    same(status, 3, `${argv.join(" ")} refuses existing worker lock`);
  }
  await rustSql`SELECT pg_advisory_unlock(${WORKER_LOCK_KEY})`;
  // Acquire persists counters before any source request, and a restart retains the breaker.
  const initial = {
    consecutive_failures: 0,
    open_until_ms: null,
    minute_bucket_start_ms: Date.now(),
    minute_count: 0,
    day_bucket_start_ms: Math.floor(Date.now() / 86_400_000) * 86_400_000,
    day_count: 4,
    last_request_at_ms: null,
    last_failure_at_ms: null,
    last_failure_reason: null,
    total_requests: 13,
  };
  await rustSql`INSERT INTO source_guard_state(source_id,state_json,updated_at) VALUES ('robomaster',${rustSql.json(initial)},now()) ON CONFLICT(source_id) DO UPDATE SET state_json=excluded.state_json`;
  same(
    await call({ op: "guard", database: rustUrl.href }),
    "acquired",
    "guard acquires with production policy",
  );
  const counted = (await rustSql`SELECT state_json FROM source_guard_state`)[0].state_json;
  same(
    [counted.minute_count, counted.day_count, counted.total_requests],
    [1, 5, 14],
    "request is charged durably before HTTP",
  );
  same(
    await call({ op: "guard", database: rustUrl.href, settle: true }),
    "acquired",
    "guard resumes spacing after reload",
  );
  const failedState = (await rustSql`SELECT state_json FROM source_guard_state`)[0].state_json;
  same(
    failedState.last_failure_reason,
    "forbidden: forbidden (http 403)",
    "persisted breaker wire and reason",
  );
  assert.ok((await call({ op: "guard", database: rustUrl.href })).error.includes("circuitOpen"));
  checks++;
  same(
    (await rustSql`SELECT state_json FROM source_guard_state`)[0].state_json.total_requests,
    15,
    "throttle does not charge a request",
  );
  // Start with persisted open circuit so this production-policy smoke sends no forum requests.
  const state = {
    consecutive_failures: 1,
    open_until_ms: Date.now() + 3_600_000,
    minute_bucket_start_ms: Date.now(),
    minute_count: 0,
    day_bucket_start_ms: Math.floor(Date.now() / 86_400_000) * 86_400_000,
    day_count: 0,
    last_request_at_ms: null,
    last_failure_at_ms: Date.now(),
    last_failure_reason: "fixture safety",
    total_requests: 123,
  };
  await rustSql`INSERT INTO source_guard_state(source_id,state_json,updated_at) VALUES ('robomaster',${rustSql.json(state)},now()) ON CONFLICT(source_id) DO UPDATE SET state_json=excluded.state_json`;
  const worker = spawn(binary, ["work"], {
    env: { ...process.env, DATABASE_URL: rustUrl.href, RUST_LOG: "info" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("worker did not start")), 10_000);
      worker.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("crawler started")) {
          clearTimeout(timer);
          resolve();
        }
      });
      worker.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`worker exited ${code}: ${output}`));
      });
    });
    const lockDb = await createDb(rustUrl.href, { max: 1 });
    try {
      await assert.rejects(
        createCrawler({
          db: handles[1],
          lockDb,
          fetch: async () => {
            throw new Error("must not send a source request");
          },
          log: () => {},
        }).work(new AbortController().signal),
        /another bbs worker holds the lock/,
      );
      checks++;
    } finally {
      await lockDb.close();
    }
    const exit = once(worker, "exit");
    worker.kill("SIGTERM");
    same((await exit)[0], 0, "SIGTERM stops supervised crawler");
    same(
      (await rustSql`SELECT state_json FROM source_guard_state`)[0].state_json.total_requests,
      123,
      "restart preserves guard counters; no fixture source traffic",
    );
    same(
      (await rustSql`SELECT pg_try_advisory_lock(${WORKER_LOCK_KEY}) AS locked`)[0].locked,
      true,
      "SIGTERM releases worker lock",
    );
    await rustSql`SELECT pg_advisory_unlock(${WORKER_LOCK_KEY})`;
  } finally {
    if (worker.exitCode === null) worker.kill("SIGKILL");
  }
  // Losing the dedicated lock session is fatal, rather than continuing unprotected.
  const lostWorker = spawn(binary, ["work"], {
    env: { ...process.env, DATABASE_URL: rustUrl.href, RUST_LOG: "info" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("second worker did not start")), 10_000);
      lostWorker.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("crawler started")) {
          clearTimeout(timer);
          resolve();
        }
      });
      lostWorker.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`second worker exited ${code}`));
      });
    });
    const holders =
      await rustSql`SELECT p.pid FROM pg_locks l JOIN pg_stat_activity p ON p.pid=l.pid WHERE l.locktype='advisory' AND l.objid=${WORKER_LOCK_KEY}::oid AND p.datname=${databases[1]}`;
    same(holders.length, 1, "worker owns one dedicated lock session");
    const exited = once(lostWorker, "exit");
    await admin`SELECT pg_terminate_backend(${holders[0].pid})`;
    same(
      (
        await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            const timer = setTimeout(
              () => reject(new Error("worker ignored loss of its lock")),
              12_000,
            );
            timer.unref();
          }),
        ])
      )[0],
      1,
      "lock loss stops worker with failure",
    );
    same(
      (await rustSql`SELECT state_json FROM source_guard_state`)[0].state_json.total_requests,
      123,
      "lock-loss smoke sends no source requests",
    );
  } finally {
    if (lostWorker.exitCode === null) lostWorker.kill("SIGKILL");
  }
  console.log(
    `Rust crawler parity: ${checks} checks passed; no requests sent to the public forum.`,
  );
} finally {
  probe.stdin.end();
  lines.close();
  probe.kill();
  await Promise.all(handles.map((db) => db.close()));
  await Promise.all(connections.map((sql) => sql.end()));
  for (const name of databases) await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
}
