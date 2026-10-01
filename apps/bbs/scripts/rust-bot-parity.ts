/** Fixture-only bot parity checks. No Feishu network access; creates/drops disposable databases. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
import { createDb, migrate } from "../src/db/index.ts";
import { sources, articles, articleSearch } from "../src/db/schema.ts";
import { buildDocument } from "../src/import/derive.ts";
import { BotStore } from "../src/bot/store.ts";
import { parseCommand, parseMenuCommand, parseAction } from "../src/bot/command.ts";
import * as present from "../src/bot/present.ts";
import { hongKongDay, digestDueAt } from "../src/bot/time.ts";
import { createLibrary } from "../src/library/index.ts";
import { selectSearchIndex } from "../src/db/search/index.ts";
import type { IncomingMessage, SendOutcome } from "../src/bot/contract.ts";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const probe = spawn(join(root, "target/debug/examples/bot_probe"), [], {
  stdio: ["pipe", "pipe", "inherit"],
});
const iterator = createInterface({ input: probe.stdout })[Symbol.asyncIterator]();
let checks = 0;
async function call(input: object): Promise<any> {
  probe.stdin.write(`${JSON.stringify(input)}\n`);
  const line = await iterator.next();
  if (line.done) throw new Error("Rust bot probe exited");
  const value = JSON.parse(line.value);
  if (value?.error) throw new Error(value.error);
  return value;
}
function same(a: unknown, b: unknown, label: string) {
  assert.deepEqual(a, b, label);
  checks++;
}
const origin = "https://bbs.example.test";
const chat = "oc_announcement";
const activation = new Date("2026-09-30T00:00:00.000Z");
function message(content: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: "om_fixture",
    chatId: "oc_chat",
    chatType: "p2p",
    content,
    rawContentType: "text",
    mentionedBot: false,
    createTime: activation.getTime(),
    ...overrides,
  };
}
function payload(a: any, b: any, label: string) {
  same(a.msgType, b.msgType, label);
  same(JSON.parse(a.content), JSON.parse(b.content), label);
  same(
    b.hash,
    createHash("sha256").update(`${b.msgType}\0${b.content}`).digest("hex"),
    "Rust frozen payload hash",
  );
}
const maintenance = process.env.BBS_RUST_TEST_POSTGRES;
if (!maintenance)
  throw new Error("Set BBS_RUST_TEST_POSTGRES to a disposable maintenance URL (CREATEDB required)");
const admin = postgres(maintenance, { max: 1, onnotice: () => {} });
const names: string[] = [];
const dbs: Awaited<ReturnType<typeof createDb>>[] = [];
const raw: ReturnType<typeof postgres>[] = [];
try {
  for (const content of [
    "",
    " /help ",
    "/HELP",
    "/?",
    "/search 云台 PID",
    "/s PID",
    "/title 电机",
    "/标题 电机",
    "/知识库 云台",
    "搜索PID",
    "搜索 PID",
    "search PID",
    "searching motors",
    "latest news",
    "status update",
    "帮助",
    "/unknown",
    "/",
    "/ search",
    "/new ignored",
    "/kb",
    "x".repeat(200),
    "x".repeat(201),
    "🤖".repeat(100),
    "🤖".repeat(101),
    "/search\uFEFFPID",
    "/search a\nb",
  ]) {
    for (const options of [
      {},
      { chatType: "group" as const, mentionedBot: true },
      { chatType: "group" as const, mentionedBot: false },
      { rawContentType: "post" },
    ]) {
      const m = message(content, options);
      same(
        await call({ op: "command", message: m }),
        parseCommand(m),
        `command ${content.slice(0, 20)}`,
      );
    }
  }
  for (const key of [
    "help",
    "status",
    "latest",
    "search",
    "kb",
    "title",
    "new",
    "帮助",
    "nope",
    " status ",
  ])
    same(await call({ op: "menu", key }), parseMenuCommand(key), "menu");
  const action = {
    v: 1,
    cmd: "search",
    q: "PID",
    scope: "all",
    trail: ["cursor"],
    chatType: "group",
    nonce: "nonce",
  };
  for (const value of [
    action,
    { ...action, extra: true },
    { ...action, v: 2 },
    { ...action, q: "" },
    { ...action, q: "🤖".repeat(101) },
    { ...action, trail: Array(51).fill("x") },
    { ...action, trail: [""] },
    { ...action, nonce: "" },
    { ...action, scope: "bad" },
    null,
  ])
    same(await call({ op: "action", value }), parseAction(value), "action validation");
  for (const chatType of ["p2p", "group"] as const)
    payload(
      present.presentHelp(chatType),
      await call({ op: "present", kind: "help", chatType }),
      "help",
    );
  for (const reason of ["empty", "too_long"] as const)
    payload(
      present.presentInvalid(reason),
      await call({ op: "present", kind: "invalid", reason }),
      "invalid",
    );
  payload(
    present.presentUnknown("a[*]"),
    await call({ op: "present", kind: "unknown", name: "a[*]" }),
    "unknown",
  );
  const article = {
    title: "PID [1] * 电机",
    excerpt: "🤖".repeat(210),
    articleLink: `${origin}/articles/01J00000000000000000000000`,
  };
  payload(
    present.presentArticle(article),
    await call({ op: "present", kind: "article", article }),
    "article",
  );
  payload(
    present.presentDigest("2026-09-30", [article, { ...article, excerpt: null }]),
    await call({
      op: "present",
      kind: "digest",
      day: "2026-09-30",
      articles: [article, { ...article, excerpt: null }],
    }),
    "digest",
  );
  const item: any = {
    id: "01J00000000000000000000000",
    title: article.title,
    author: "Alice",
    publishedAt: activation,
    tags: ["group/tag", "group/other"],
    excerpt: "excerpt",
    tldr: "TLDR",
    snippet: [
      { text: "prefix ".repeat(20), hit: false },
      { text: "PID [x]", hit: true },
      { text: "suffix ".repeat(20), hit: false },
    ],
  };
  payload(
    present.presentLatest([item], origin),
    await call({ op: "present", kind: "latest", items: [item], origin }),
    "latest",
  );
  payload(
    present.presentLatest([], origin),
    await call({ op: "present", kind: "latest", items: [], origin }),
    "empty latest",
  );
  for (const scope of ["all", "title", "kb"] as const)
    for (const trail of [[], ["previous"]])
      for (const items of [[], [item]]) {
        const view: any = {
          query: "PID [电机]",
          scope,
          trail,
          chatType: "group",
          page: { items, nextCursor: "next", terms: ["PID", "电机"] },
          appOrigin: origin,
          nonce: "nonce",
        };
        payload(
          present.presentSearch(view),
          await call({ op: "present", kind: "search", view }),
          "search page",
        );
      }
  for (const at of [
    "2026-09-30T15:59:59.999Z",
    "2026-09-30T16:00:00.000Z",
    "2026-12-31T20:00:00.000Z",
  ])
    same(
      await call({ op: "day", at, day: hongKongDay(new Date(at)) }),
      { day: hongKongDay(new Date(at)), due: digestDueAt(hongKongDay(new Date(at))).toISOString() },
      "Hong Kong boundary",
    );
  const urls: string[] = [];
  for (let i = 0; i < 2; i++) {
    const name = `bbs_bot_parity_${randomUUID().replaceAll("-", "")}`;
    names.push(name);
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    const url = new URL(maintenance);
    url.pathname = `/${name}`;
    urls.push(url.toString());
    const db = await createDb(url.toString());
    dbs.push(db);
    await migrate(db);
    await db.insert(sources).values({
      id: "src",
      kind: "robomaster",
      name: "RM",
      siteUrl: "https://bbs.robomaster.com",
      createdAt: activation,
      updatedAt: activation,
    });
    raw.push(postgres(url.toString(), { max: 1, onnotice: () => {} }));
  }
  const node = new BotStore({
    db: dbs[0]!,
    appOrigin: origin,
    announcementChatId: chat,
    random: () => 0,
  });
  const rust = (op: string, at: Date, extra: object = {}) =>
    call({ op, database: urls[1], origin, chat, at: at.toISOString(), ...extra });
  async function add(index: number, published: Date) {
    const id = `01J000000000000000000000${index.toString(16).toUpperCase()}`.padEnd(26, "0");
    for (const db of dbs) {
      const title = `Article ${index}`,
        body = `PID body ${index}`;
      await db.insert(articles).values({
        id,
        sourceId: "src",
        sourceArticleId: String(index),
        canonicalUrl: `https://bbs.robomaster.com/article/${index}`,
        urlHash: `hash-${index}`,
        title,
        publishedAt: published,
        discoveredAt: published,
        fetchedAt: published,
        introduction: `Excerpt ${index}`,
        bodyText: body,
        contentFormat: "markdown",
        contentRaw: body,
        contentHtml: `<p>${body}</p>`,
        status: "fetched",
        createdAt: published,
        updatedAt: published,
      });
      await db.insert(articleSearch).values({
        articleId: id,
        title,
        author: "",
        tags: "",
        introduction: `Excerpt ${index}`,
        bodyText: body,
        document: buildDocument([title, "", "", `Excerpt ${index}`, body]),
      });
    }
  }
  await add(0, new Date(activation.getTime() - 1000));
  same(
    await rust("activate", activation),
    await node.activateAndBaseline(activation),
    "first baseline",
  );
  same(
    await rust("activate", activation),
    await node.activateAndBaseline(activation),
    "repeat baseline",
  );
  for (let i = 1; i <= 7; i++) await add(i, new Date(activation.getTime() + i * 1000));
  const at = new Date(activation.getTime() + 60000);
  same(await rust("reconcile", at), await node.reconcile(at), "three slots and overflow");
  async function compareState(label: string) {
    const snapshot = async (sql: ReturnType<typeof postgres>) => ({
      decisions:
        await sql`SELECT source_article_id,status,assignment_day::text,immediate_slot,title,excerpt,digest_ordinal FROM bot_article_decisions ORDER BY source_article_id`,
      deliveries: (
        await sql`SELECT kind,logical_key,state,msg_type,content,scheduled_at FROM bot_deliveries ORDER BY logical_key`
      ).map((r) => ({ ...r, content: JSON.parse(r.content) })),
    });
    same(await snapshot(raw[1]!), await snapshot(raw[0]!), label);
  }
  await compareState("initial announcements");
  const nd = await node.leaseNext(at);
  const rd = await rust("lease", at);
  assert(nd && rd);
  same(rd.uuid.length, nd.uuid.length, "UUID format");
  same(JSON.parse(rd.content), JSON.parse(nd.content), "leased card");
  const ambiguous: SendOutcome = { kind: "ambiguous", code: "network" };
  same(
    await rust("settle", at, { delivery: rd, outcome: ambiguous }),
    await node.settle(nd, ambiguous, at),
    "ambiguous settlement",
  );
  // Equal-time deliveries have unspecified tie order; isolate the retry being checked.
  for (const [i, d] of [nd, rd].entries())
    await raw[
      i
    ]!`UPDATE bot_deliveries SET next_attempt_at=${new Date(at.getTime() + 120000)} WHERE id<>${d.id}`;
  const retryAt = new Date(at.getTime() + 6000);
  const nd2 = await node.leaseNext(retryAt);
  const rd2 = await rust("lease", retryAt);
  assert(nd2 && rd2);
  same(rd2.uuid, rd.uuid, "Rust retry UUID unchanged");
  same(nd2.uuid, nd.uuid, "Node retry UUID unchanged");
  same(rd2.content, rd.content, "Rust frozen payload unchanged");
  const rejected: SendOutcome = { kind: "not_sent", code: "429", retryAfterMs: 100000 };
  await node.settle(nd2, rejected, retryAt);
  await rust("settle", retryAt, { delivery: rd2, outcome: rejected });
  // The first delivery has an ambiguous attempt and must never be absorbed into a digest.
  const nextDay = new Date("2026-10-01T01:00:00.000Z");
  same(
    await rust("reconcile", nextDay),
    await node.reconcile(nextDay),
    "digest due and ambiguous exclusion",
  );
  await compareState("sealed digest membership");
  const m = message("/help", { messageId: "om_help" });
  same(
    await rust("accept", nextDay, { message: m }),
    await node.accept({ kind: "message", message: m }, nextDay),
    "admit receipt",
  );
  same(
    await rust("accept", nextDay, { message: m }),
    await node.accept({ kind: "message", message: m }, nextDay),
    "deduplicate receipt",
  );
  const library = createLibrary({
    db: dbs[0]!,
    search: selectSearchIndex("trgm", async (q) => dbs[0]!.execute(q)),
  });
  same(
    await rust("plan", nextDay),
    await node.planNextReply(library, nextDay),
    "plan durable reply",
  );
  await compareState("frozen reply");
  const status = await library.status();
  payload(
    present.presentStatus(status, origin),
    await call({ op: "present", kind: "status", status, origin }),
    "status card",
  );
  const rustStatus = await rust("status", nextDay);
  same(
    rustStatus.bot.lastReconciledAt,
    status.bot.lastReconciledAt?.toISOString(),
    "bot heartbeat timestamp",
  );
  assert(
    Math.abs(rustStatus.bot.lastReconciledAgeSeconds - status.bot.lastReconciledAgeSeconds!) <= 2,
  );

  // A Node outbox is consumed by Rust without rewriting UUID/content, then consumed by Node again.
  const cross = (op: string, at: Date, extra: object = {}) =>
    call({ op, database: urls[0], origin, chat, at: at.toISOString(), ...extra });
  const crossLease = await cross("lease", nextDay);
  assert(crossLease);
  const original = await raw[0]!`SELECT uuid,content FROM bot_deliveries WHERE id=${crossLease.id}`;
  same(crossLease.uuid, original[0]!.uuid, "Node-to-Rust UUID");
  same(crossLease.content, original[0]!.content, "Node-to-Rust bytes");
  await cross("settle", nextDay, {
    delivery: crossLease,
    outcome: { kind: "not_sent", code: "429", retryAfterMs: 1 },
  });
  const again = await node.leaseNext(new Date(nextDay.getTime() + 2));
  assert(again);
  same(again.uuid, crossLease.uuid, "Rust-to-Node UUID");
  same(again.content, crossLease.content, "Rust-to-Node bytes");
  const expired = new Date(nextDay.getTime() + 120003);
  await cross("reconcile", expired);
  const reclaimed = await node.leaseNext(expired);
  assert(reclaimed);
  same(reclaimed.uuid, again.uuid, "expired lease retains UUID");
  const sent: SendOutcome = { kind: "sent", messageId: "om_sent" };
  same(
    await cross("settle", expired, { delivery: again, outcome: sent }),
    false,
    "stale confirmed success wins",
  );
  const state = await raw[0]!`SELECT state FROM bot_deliveries WHERE id=${again.id}`;
  same(state[0]!.state, "sent", "confirmed success remains terminal");
  // Exercise normalized raw messages and callbacks against durable receipts.
  const rawMessage = {
    message: {
      message_id: "om_raw",
      chat_id: "oc_chat",
      chat_type: "group",
      message_type: "text",
      create_time: String(activation.getTime()),
      content: JSON.stringify({ text: "@_user_1 /search PID @_user_2" }),
      mentions: [
        { key: "@_user_1", id: { open_id: "ou_bot" }, name: "Bot" },
        { key: "@_user_2", id: { open_id: "ou_other" }, name: "Alice" },
      ],
    },
  };
  await rust("admit", nextDay, { event: rawMessage, botId: "ou_bot" });
  const receipt = await raw[1]!`SELECT content FROM bot_inbound_receipts WHERE message_id='om_raw'`;
  same(receipt[0]!.content, "/search PID @Alice", "mention normalization");
  await rust("admit", nextDay, {
    event: {
      message: {
        ...rawMessage.message,
        message_id: "om_all",
        content: JSON.stringify({ text: "@_user_1 /help @_all" }),
      },
    },
    botId: "ou_bot",
  });
  same(
    (
      await raw[1]!`SELECT count(*)::int AS count FROM bot_inbound_receipts WHERE message_id='om_all'`
    )[0]!.count,
    0,
    "mention-all group policy",
  );
  await rust("admit", nextDay, {
    event: {
      context: { open_message_id: "om_card", open_chat_id: "oc_chat" },
      action: { value: action },
    },
    botId: "ou_bot",
  });
  same(
    (
      await raw[1]!`SELECT count(*)::int AS count FROM bot_inbound_receipts WHERE message_id='action:om_card:nonce:1'`
    )[0]!.count,
    1,
    "raw action receipt",
  );
  await rust("admit", nextDay, {
    event: {
      operator: { operator_id: { open_id: "ou_operator" } },
      event_key: "help",
      timestamp: 1234,
    },
    botId: "ou_bot",
  });
  same(
    (
      await raw[1]!`SELECT count(*)::int AS count FROM bot_inbound_receipts WHERE message_id='menu:ou_operator:help:1234'`
    )[0]!.count,
    1,
    "raw menu receipt",
  );
  // Lock contention must exit before using the intentionally fake Feishu credentials.
  const lock = postgres(urls[0]!, { max: 1 });
  try {
    await lock`SELECT pg_advisory_lock(${0x42425342})`;
    const child = spawn(join(root, "target/debug/herkules-bbs"), ["bot"], {
      env: {
        ...process.env,
        DATABASE_URL: urls[0],
        APP_ORIGIN: origin,
        FEISHU_APP_ID: "fixture-app",
        FEISHU_APP_SECRET: "fixture-secret",
        FEISHU_ANNOUNCEMENT_CHAT_ID: chat,
        SEARCH_INDEX: "trgm",
      },
      stdio: ["ignore", "ignore", "inherit"],
    });
    same((await once(child, "exit"))[0], 3, "competing bot exits without contacting Feishu");
  } finally {
    await lock.end();
  }
  // Exercise the production worker against an in-process fake Feishu gateway.
  async function lifecycle(mode: string) {
    await raw[1]!.unsafe(
      "TRUNCATE bot_deliveries, bot_inbound_receipts, bot_article_decisions, bot_days, bot_state CASCADE",
    );
    const child = spawn(join(root, "target/debug/examples/bot_worker_fixture"), [urls[1]!, mode], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const exit = once(child, "exit");
    const lines = createInterface({ input: child.stdout });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`worker lifecycle timeout: ${mode}`)), 30000);
    });
    try {
      const marker = mode === "slow" ? "send_started" : "connected";
      await Promise.race([
        new Promise<void>((resolve) => {
          lines.on("line", (line) => {
            if (line === marker) resolve();
          });
        }),
        deadline,
      ]);
      if (mode === "slow") {
        child.kill("SIGTERM");
        const lock = await raw[1]!`SELECT pg_try_advisory_lock(${0x42425342}) AS acquired`;
        same(lock[0]!.acquired, false, "shutdown retains lock during in-flight send");
        same((await Promise.race([exit, deadline]))[0], 0, "SIGTERM shuts down cleanly");
        same(
          (await raw[1]!`SELECT state FROM bot_deliveries WHERE kind='reply'`)[0]!.state,
          "sent",
          "shutdown settles successful in-flight send",
        );
      } else {
        // Dedicated lock connection loss must stop the worker.
        const locks =
          await raw[1]!`SELECT pid FROM pg_locks WHERE locktype='advisory' AND objid=${0x42425342} AND granted`;
        same(locks.length, 1, "worker holds singleton lock");
        await raw[1]!`SELECT pg_terminate_backend(${locks[0]!.pid})`;
        same((await Promise.race([exit, deadline]))[0], 1, "lost lock terminates worker");
      }
      const released = await raw[1]!`SELECT pg_try_advisory_lock(${0x42425342}) AS acquired`;
      same(released[0]!.acquired, true, "worker releases singleton lock");
      await raw[1]!`SELECT pg_advisory_unlock(${0x42425342})`;
    } finally {
      clearTimeout(timer);
      lines.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exit;
      }
    }
  }
  await lifecycle("slow");
  await lifecycle("idle");
  console.log(`Rust/Node bot parity passed (${checks} checks)`);
} finally {
  probe.stdin.end();
  probe.kill();
  for (const db of dbs) await db.close();
  for (const sql of raw) await sql.end();
  for (const name of names) await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH(FORCE)`);
  await admin.end();
}
