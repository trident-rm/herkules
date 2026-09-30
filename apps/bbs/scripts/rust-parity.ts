/** Differential checks against a fresh database, never the caller's corpus.
 * BBS_RUST_TEST_POSTGRES is a maintenance connection with CREATEDB privileges.
 * This script creates, seeds and drops its own randomly named database.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import postgres from "postgres";
import { ID, FEED_ORDER, seedLibrary } from "../tests/seed.ts";
import { withRustReads } from "../src/library/rust.ts";
import type { ArticleId } from "../src/library/types.ts";

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
  let checks = 0;
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
  const lowercase = await fetch(`${origin}/api/articles/${ID.A.toLowerCase()}`);
  assert.deepEqual(await lowercase.json(), json(await fixture.library.article(ID.A)));
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
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(page.headers.get("content-security-policy")!, /default-src 'none'/);
  const html = await page.text();
  const article = (await fixture.library.article(ID.A))!;
  assert.ok(html.includes(article.contentHtml!), "the initial document contains the article body");
  assert.ok(!html.includes("<script"), "reader requires no hydration");
  assert.ok(html.includes(`https://bbs.example/articles/${ID.A}`));
  const stylesheet = /href="(\/assets\/[^"]+\.css)"/.exec(html)?.[1];
  assert.ok(stylesheet, "reader references the Vite manifest stylesheet");
  const css = await fetch(`${origin}${stylesheet}`);
  assert.equal(css.status, 200);
  assert.match(await css.text(), /ssr-reader/);
  assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  // Adversarial metadata and a plain-text fallback must stay escaped in SSR.
  const edits = postgres(databaseUrl.href, { max: 1 });
  try {
    await edits`UPDATE articles SET title = ${'<script>alert("title")</script>'},
      content_html = NULL, body_text = ${"<img src=x onerror=alert(1)>"} WHERE id = ${ID.A}`;
    const escaped = await (await fetch(`${origin}/articles/${ID.A}`)).text();
    assert.ok(!escaped.includes("<script>"));
    assert.ok(!escaped.includes("<img src=x"));
    assert.match(escaped, /(?:&lt;|&#60;|&#x3c;)script(?:&gt;|&#62;|&#x3e;)/i);
    assert.match(escaped, /(?:&lt;|&#60;|&#x3c;)img/i);
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
  checks += 12;
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
