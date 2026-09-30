import { mkdtemp, readFile, readdir, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, test } from "vite-plus/test";
import { FEISHU_SCOPES } from "../src/config.ts";
import { createGrants } from "../src/grants.ts";
import { createSeal } from "../src/seal.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(tenant = "team") {
  const dir = await mkdtemp(join(tmpdir(), "feishu-test-"));
  dirs.push(dir);
  let clock = 1000000;
  const requests: Record<string, string>[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    if ((url instanceof Request ? url.url : url.toString()).endsWith("user_info"))
      return Response.json({ code: 0, data: { tenant_key: tenant, open_id: "open-test" } });
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
      string,
      string
    >;
    requests.push(body);
    return Response.json({
      access_token: body.code ? `access-${body.code}` : "access-rotated",
      refresh_token: body.code ? `refresh-${body.code}` : "refresh-rotated",
      expires_in: 7200,
      scope: FEISHU_SCOPES.join(" "),
    });
  };
  const grants = createGrants({
    config: {
      GRANTS_DIR: dir,
      FEISHU_APP_ID: "app",
      FEISHU_APP_SECRET: "secret",
      FEISHU_TENANT_KEY: "team",
    },
    seal: createSeal(Buffer.alloc(32, 3)),
    fetch,
    now: () => clock,
  });
  return {
    dir,
    requests,
    grants,
    advance: () => {
      clock += 7200000;
    },
  };
}

test("isolates members, encrypts credentials, and rejects swapped grants", async () => {
  const { grants, dir } = await fixture();
  await grants.authorize("alice", "alice", "verifier", "https://example.test/callback");
  await grants.authorize("bob", "bob", "verifier", "https://example.test/callback");
  expect(await grants.accessToken("alice")).toBe("access-alice");
  expect(await grants.accessToken("bob")).toBe("access-bob");
  await expect(grants.accessToken("charlie")).rejects.toThrow("Connect your own");
  for (const file of await readdir(dir))
    expect(await readFile(join(dir, file), "utf8")).not.toContain("access-");
  const filename = (subject: string) =>
    join(dir, `${createHash("sha256").update(subject).digest("hex")}.json.enc`);
  await copyFile(filename("alice"), filename("bob"));
  await expect(grants.accessToken("bob")).rejects.toThrow("unavailable");
  await grants.disconnect("bob");
  expect(await grants.connected("alice")).toBe(true);
  expect(await grants.connected("bob")).toBe(false);
});

test("serializes concurrent refresh and persists the rotated refresh token", async () => {
  const f = await fixture();
  await f.grants.authorize("alice", "alice", "verifier", "https://example.test/callback");
  f.advance();
  expect(await Promise.all(Array.from({ length: 8 }, () => f.grants.accessToken("alice")))).toEqual(
    Array(8).fill("access-rotated"),
  );
  expect(f.requests.filter((r) => r.grant_type === "refresh_token")).toHaveLength(1);
  f.advance();
  await f.grants.accessToken("alice");
  expect(f.requests.at(-1)?.refresh_token).toBe("refresh-rotated");
});

test("refuses grants from another Feishu tenant", async () => {
  const { grants } = await fixture("other-team");
  await expect(
    grants.authorize("alice", "alice", "verifier", "https://example.test/callback"),
  ).rejects.toThrow("team's Feishu");
  expect(await grants.connected("alice")).toBe(false);
});
