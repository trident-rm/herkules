import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { createTestService, type TestService } from "../src/testing.ts";
import { FEISHU_USER_INFO, type FeishuProfile } from "../src/feishu.ts";
import { account, user, session as sessionTable } from "../src/db/schema.ts";
import { loadConfig } from "../src/config.ts";

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
function absorb(cookie: string, res: Response) {
  const jar = new Map(
    cookie
      .split("; ")
      .filter(Boolean)
      .map((pair) => {
        const at = pair.indexOf("=");
        return [pair.slice(0, at), pair.slice(at + 1)];
      }),
  );
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(";")[0]!;
    const at = pair.indexOf("=");
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return Array.from(jar, ([k, v]) => `${k}=${v}`).join("; ");
}
class FakeFeishu {
  profiles = new Map<string, FeishuProfile>();
  codes = new Map<string, { token: string; challenge: string; redirect: string }>();
  refreshes = 0;
  unavailable = false;
  fetch: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    if (req.url === "https://accounts.feishu.cn/oauth/v3/token") {
      const body = new URLSearchParams(await req.text());
      expect(body.get("client_secret")).toBe("test-feishu-secret");
      expect(body.get("grant_type")).toBe("refresh_token");
      this.refreshes++;
      return Response.json({
        access_token: body.get("refresh_token")!.slice(8),
        token_type: "Bearer",
        expires_in: 7200,
        refresh_token: body.get("refresh_token"),
        refresh_token_expires_in: 604800,
      });
    }
    if (req.url === "https://open.feishu.cn/open-apis/authen/v2/oauth/token") {
      expect(req.method).toBe("POST");
      expect(req.headers.get("content-type")).toBe("application/json");
      const body = (await req.json()) as Record<string, string>;
      expect(body).toMatchObject({
        client_id: "feishu-test",
        client_secret: "test-feishu-secret",
        grant_type: "authorization_code",
      });
      const code = this.codes.get(body.code ?? "");
      this.codes.delete(body.code ?? "");
      const verifier = body.code_verifier ?? "";
      if (
        !code ||
        !/^[A-Za-z0-9_-]{43}$/.test(verifier) ||
        createHash("sha256").update(verifier).digest("base64url") !== code.challenge ||
        body.redirect_uri !== code.redirect
      )
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({
        code: 0,
        access_token: code.token,
        token_type: "Bearer",
        expires_in: 7200,
        refresh_token: `refresh:${code.token}`,
        refresh_token_expires_in: 604800,
        scope: "contact:user.base:readonly contact:user.email:readonly offline_access",
      });
    }
    if (req.url === FEISHU_USER_INFO) {
      if (this.unavailable) return Response.json({ code: 999 }, { status: 503 });
      return Response.json({
        code: 0,
        data: this.profiles.get(req.headers.get("authorization")?.slice(7) ?? ""),
      });
    }
    throw new Error(`Unexpected Feishu request: ${req.url}`);
  };
}

describe("Feishu OAuth and explicit identity linking", () => {
  let t: TestService;
  const fake = new FakeFeishu();
  let counter = 0;
  beforeAll(async () => {
    t = await createTestService({
      feishuFetch: fake.fetch,
      env: {
        FEISHU_APP_ID: "feishu-test",
        FEISHU_APP_SECRET: "test-feishu-secret",
        FEISHU_TENANT_KEY: "team",
      },
    });
  });
  afterAll(() => t.close());
  const profile = (id: string, extra: Partial<FeishuProfile> = {}): FeishuProfile => ({
    tenant_key: "team",
    open_id: `ou_${id}`,
    name: id,
    email: `${id}@example.com`,
    ...extra,
  });
  async function login(p: FeishuProfile, cookie = "", oauthQuery?: string) {
    const start = await t.fetch(cookie ? "/auth/link-social" : "/auth/sign-in/social", {
      ...json({
        provider: "feishu",
        callbackURL: "/connect-github",
        ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
      }),
      cookie,
    });
    expect(start.status).toBe(200);
    const url = new URL(((await start.json()) as { url: string }).url);
    expect(url.origin).toBe("https://accounts.feishu.cn");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toContain("contact:user.email:readonly");
    const code = `code-${++counter}`;
    const token = `${p.tenant_key}:${p.open_id}`;
    fake.profiles.set(token, p);
    fake.codes.set(code, {
      token,
      challenge: url.searchParams.get("code_challenge")!,
      redirect: url.searchParams.get("redirect_uri")!,
    });
    cookie = absorb(cookie, start);
    const cb = await t.fetch(
      `/auth/callback/feishu?code=${code}&state=${url.searchParams.get("state")}`,
      { cookie, headers: { accept: "text/html", "sec-fetch-mode": "navigate" } },
    );
    const location = cb.headers.get("location") ?? "";
    expect([302, 303]).toContain(cb.status);
    cookie = absorb(cookie, cb);
    const session = (await (await t.fetch("/auth/get-session", { cookie })).json()) as {
      user: {
        id: string;
        email: string;
        emailVerified: boolean;
        githubId?: string;
        feishuOpenId?: string;
      };
    } | null;
    return {
      cookie,
      location,
      error: new URL(location, t.origin).searchParams.get("error"),
      session,
    };
  }
  async function linkGithub(
    cookie: string,
    id: number,
    loginName: string,
    emails?: readonly { email: string; verified: boolean; primary: boolean }[],
    org: "active" | "none" = "none",
  ) {
    const { code } = t.github.user({
      id,
      login: loginName,
      email: `${loginName}@personal.example`,
      emails,
      org,
    });
    const start = await t.fetch("/auth/link-social", {
      ...json({ provider: "github", callbackURL: "/connect-github" }),
      cookie,
    });
    expect(start.status).toBe(200);
    const url = new URL(((await start.json()) as { url: string }).url);
    return t.fetch(`/auth/callback/github?code=${code}&state=${url.searchParams.get("state")}`, {
      cookie: absorb(cookie, start),
    });
  }
  async function mergePair(
    label: string,
    options: { githubUsed?: boolean; feishuUsed?: boolean } = {},
  ) {
    const id = 10_000 + ++counter;
    t.github.user({ id, login: label, org: "active" });
    const github = await t.login(label);
    if (!github.ok) throw new Error(github.error);
    if (options.githubUsed) await t.mcpClient(github.cookie, t.service.registry.canonical.audience);
    const feishu = await login(profile(label + "-work"));
    if (options.feishuUsed) await t.mcpClient(feishu.cookie, t.service.registry.canonical.audience);
    const callback = await linkGithub(feishu.cookie, id, label, undefined, "active");
    return {
      github,
      feishu,
      id,
      error: new URL(callback.headers.get("location")!, t.origin).searchParams.get("error"),
    };
  }
  const mergeRequest = (cookie: string, id: string, origin = t.origin) =>
    t.app.request(`${t.origin}/auth/identity-merge`, {
      ...json({ id }),
      headers: { "content-type": "application/json", origin, cookie },
    });
  async function mergePreview(cookie: string) {
    const r = await t.fetch("/auth/identity-merge", { cookie });
    expect(r.status).toBe(200);
    return (await r.json()) as { id: string; retainedAccount: { id: string } };
  }
  test("confirmed merge retains the established ID, permissions and both logins; revokes both sessions", async () => {
    const pair = await mergePair("merge-established", { githubUsed: true });
    expect(pair.error).toBe("merge_available");
    await t.makeAdmin(pair.github.userId);
    const preview = await mergePreview(pair.feishu.cookie);
    expect(preview.retainedAccount.id).toBe(pair.github.userId);
    // OAuth proof alone does not move either identity.
    expect((await t.service.db.users.byId(pair.feishu.session!.user.id))?.githubId).toBeNull();
    expect((await mergeRequest(pair.feishu.cookie, preview.id)).status).toBe(200);
    const kept = await t.service.db.users.byId(pair.github.userId);
    expect(kept).toMatchObject({
      role: "admin",
      feishuOpenId: "ou_merge-established-work",
      email: "merge-established-work@example.com",
      emailVerified: false,
    });
    expect(await t.service.db.users.byId(pair.feishu.session!.user.id)).toMatchObject({
      banned: true,
      mergedInto: pair.github.userId,
      feishuOpenId: null,
    });
    for (const cookie of [pair.feishu.cookie, pair.github.cookie]) {
      expect(await (await t.fetch("/auth/get-session", { cookie })).json()).toBeNull();
    }
    expect((await mergeRequest(pair.feishu.cookie, preview.id)).status).toBe(401);
    expect((await login(profile("merge-established-work"))).session?.user.id).toBe(
      pair.github.userId,
    );
    expect(await t.login("merge-established")).toMatchObject({
      ok: true,
      userId: pair.github.userId,
    });
    expect(await t.audit()).toContainEqual({
      type: "identity.merged",
      event: expect.objectContaining({
        userId: pair.github.userId,
        previousUserId: pair.feishu.session!.user.id,
      }),
    });
    await expect(
      t.service.users.setDisabled(
        { kind: "system", job: "test" },
        pair.feishu.session!.user.id,
        false,
      ),
    ).rejects.toMatchObject({ code: "account_merged" });
  });
  test("merge request is session bound, origin checked, cancellable and cannot be replayed", async () => {
    const pair = await mergePair("merge-bound");
    expect(pair.error).toBe("merge_available");
    const preview = await mergePreview(pair.feishu.cookie);
    expect(
      (await mergeRequest(pair.feishu.cookie, preview.id, "https://attacker.example")).status,
    ).toBe(403);
    expect((await mergeRequest(pair.feishu.cookie, preview.id, "")).status).toBe(403);
    expect((await mergeRequest(pair.github.cookie, preview.id)).status).toBe(409);
    expect((await mergeRequest("", preview.id)).status).toBe(401);
    const anotherSession = await login(profile("merge-bound-work"));
    expect((await mergeRequest(anotherSession.cookie, preview.id)).status).toBe(409);
    expect(
      (
        await t.fetch("/auth/identity-merge", {
          method: "DELETE",
          cookie: pair.feishu.cookie,
          headers: { origin: t.origin },
        })
      ).status,
    ).toBe(200);
    expect((await mergeRequest(pair.feishu.cookie, preview.id)).status).toBe(409);
    expect((await t.service.db.users.byId(pair.feishu.session!.user.id))?.banned).toBe(false);
  });
  test("expired OAuth proof and old source sessions cannot authorize a merge", async () => {
    const pair = await mergePair("merge-expired");
    const preview = await mergePreview(pair.feishu.cookie);
    t.clock.advance(601);
    try {
      expect((await mergeRequest(pair.feishu.cookie, preview.id)).status).toBe(409);
    } finally {
      t.clock.advance(-601);
    }
    await t.service.db
      .update(sessionTable)
      .set({ createdAt: new Date(Date.now() - 601_000) })
      .where(eq(sessionTable.userId, pair.feishu.session!.user.id));
    const cb = await linkGithub(pair.feishu.cookie, pair.id, "merge-expired", undefined, "active");
    expect(new URL(cb.headers.get("location")!, t.origin).searchParams.get("error")).toBe(
      "merge_reauthentication_required",
    );
  });
  test("ban introduced after OAuth proof prevents confirmation", async () => {
    const pair = await mergePair("merge-banned");
    const preview = await mergePreview(pair.feishu.cookie);
    await t.service.users.setDisabled({ kind: "system", job: "test" }, pair.github.userId, true);
    expect((await mergeRequest(pair.feishu.cookie, preview.id)).status).toBe(409);
    expect((await t.service.db.users.byId(pair.feishu.session!.user.id))?.githubId).toBeNull();
  });
  test("two accounts with application history require migration instead of losing data", async () => {
    const pair = await mergePair("merge-two-used", { githubUsed: true, feishuUsed: true });
    expect(pair.error).toBe("merge_requires_migration");
    expect((await t.service.db.users.byId(pair.feishu.session!.user.id))?.banned).toBe(false);
  });
  test("reverse direction preserves the Feishu account if it has application history", async () => {
    const pair = await mergePair("merge-reverse", { feishuUsed: true });
    expect(pair.error).toBe("merge_available");
    // Authenticate Feishu while signed in to the independent GitHub account.
    const linked = await login(profile("merge-reverse-work"), pair.github.cookie);
    expect(linked.error).toBe("merge_available");
    const preview = await mergePreview(pair.github.cookie);
    expect(preview.retainedAccount.id).toBe(pair.feishu.session!.user.id);
    expect((await mergeRequest(pair.github.cookie, preview.id)).status).toBe(200);
    expect(await t.login("merge-reverse")).toMatchObject({
      ok: true,
      userId: pair.feishu.session!.user.id,
    });
  });
  test("application usage after preview cannot silently change which account survives", async () => {
    const pair = await mergePair("merge-changed");
    const preview = await mergePreview(pair.feishu.cookie);
    expect(preview.retainedAccount.id).toBe(pair.github.userId);
    await t.mcpClient(pair.feishu.cookie, t.service.registry.canonical.audience);
    const response = await mergeRequest(pair.feishu.cookie, preview.id);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "merge_changed" });
    expect((await t.service.db.users.byId(pair.feishu.session!.user.id))?.banned).toBe(false);
  });
  test("failed audit rolls back the entire merge, and concurrent confirmations merge only once", async () => {
    const pair = await mergePair("merge-atomic");
    const preview = await mergePreview(pair.feishu.cookie);
    const record = t.service.audit.record.bind(t.service.audit);
    const spy = vi.spyOn(t.service.audit, "record").mockImplementation(async (event, tx) => {
      if (event.type === "identity.merged") throw new Error("audit unavailable");
      return record(event, tx);
    });
    try {
      expect((await mergeRequest(pair.feishu.cookie, preview.id)).status).toBe(500);
      expect((await t.service.db.users.byId(pair.feishu.session!.user.id))?.banned).toBe(false);
      expect((await t.service.db.users.byId(pair.github.userId))?.feishuOpenId).toBeNull();
    } finally {
      spy.mockRestore();
    }
    const outcomes = await Promise.all([
      mergeRequest(pair.feishu.cookie, preview.id),
      mergeRequest(pair.feishu.cookie, preview.id),
    ]);
    expect(outcomes.filter((r) => r.status === 200)).toHaveLength(1);
    expect(outcomes.every((r) => [200, 401, 409].includes(r.status))).toBe(true);
    expect(
      (await t.audit()).filter(
        (row) =>
          row.type === "identity.merged" &&
          row.event !== null &&
          typeof row.event === "object" &&
          "userId" in row.event &&
          row.event.userId === pair.github.userId,
      ),
    ).toHaveLength(1);
  });
  test("downstream bearer tokens cannot confirm a merge", async () => {
    const pair = await mergePair("merge-bearer", { githubUsed: true });
    const preview = await mergePreview(pair.feishu.cookie);
    const client = await t.mcpClient(pair.github.cookie, t.service.registry.canonical.audience);
    const response = await t.app.request(`${t.origin}/auth/identity-merge`, {
      ...json({ id: preview.id }),
      headers: {
        "content-type": "application/json",
        origin: t.origin,
        authorization: `Bearer ${client.accessToken}`,
      },
    });
    expect(response.status).toBe(401);
  });
  test("team member gets a Feishu-only account and unverified real email", async () => {
    const r = await login(profile("member"));
    expect(r.error).toBeNull();
    expect(r.session?.user).toMatchObject({
      email: "member@example.com",
      emailVerified: false,
      feishuOpenId: "ou_member",
    });
    expect(await t.service.db.users.byId(r.session!.user.id)).toMatchObject({
      githubId: null,
      githubLogin: null,
      admittedVia: "feishu-tenant",
    });
    expect(await t.audit()).toContainEqual({
      type: "identity.connected",
      event: expect.objectContaining({ provider: "feishu", userId: r.session!.user.id }),
    });
  });
  test.each([undefined, null, "", "   ", "invalid"])(
    "refuses missing or invalid Feishu email (%s) without provisioning",
    async (email) => {
      const p = profile(`missing${++counter}`, { email });
      const r = await login(p);
      expect(r.error).toBeTruthy();
      expect(r.session).toBeNull();
      expect(await t.service.db.users.byFeishu(p.tenant_key, p.open_id)).toBeUndefined();
    },
  );
  test("returning user cannot use stored email when Feishu stops returning it", async () => {
    const p = profile("lostemail");
    await login(p);
    const r = await login({ ...p, email: undefined });
    expect(r.error).toBeTruthy();
    expect(r.session).toBeNull();
  });
  test("external admission uses exact tenant + open ID; allowlist does not waive email", async () => {
    const p = profile("external", { tenant_key: "partner" });
    expect((await login(p)).error).toBe("feishu_not_admitted");
    await t.service.users.feishuAllowlistAdd({ kind: "system", job: "test" }, "partner", p.open_id);
    expect((await login({ ...p, email: null })).error).toBeTruthy();
    expect((await login({ ...p, tenant_key: "other" })).error).toBe("feishu_not_admitted");
    expect((await login(p)).error).toBeNull();
    expect((await login({ ...p, open_id: "ou_External", email: "case@example.com" })).error).toBe(
      "feishu_not_admitted",
    );
  });
  test("GitHub links without matching email; independent login still requires its own admission gate", async () => {
    const r = await login(profile("linker"));
    const cb = await linkGithub(r.cookie, 701, "optional-github");
    expect(new URL(cb.headers.get("location")!, t.origin).searchParams.get("error")).toBeNull();
    expect(await t.service.db.users.byId(r.session!.user.id)).toMatchObject({
      githubId: "701",
      githubLogin: "optional-github",
      feishuOpenId: "ou_linker",
    });
    expect((await login(profile("linker"))).session?.user.email).toBe("linker@example.com");
    expect(await t.login("optional-github")).toMatchObject({
      ok: false,
      error: "not_org_member",
    });
    t.github.user({ id: 701, login: "optional-github", org: "active" });
    const githubLogin = await t.login("optional-github");
    expect(githubLogin).toMatchObject({ ok: true, userId: r.session!.user.id });
    const stored = await t.service.db.users.byId(r.session!.user.id);
    expect(stored?.email).toBe("linker@example.com");
    expect(stored?.emailVerified).toBe(false);
    if (!githubLogin.ok) return;
    fake.unavailable = true;
    try {
      const client = await t.mcpClient(githubLogin.cookie, t.service.registry.canonical.audience);
      expect(client.accessToken).toBeTruthy();
    } finally {
      fake.unavailable = false;
    }
  });
  test("connecting GitHub also requires its own verified email", async () => {
    const r = await login(profile("no-github-email"));
    const cb = await linkGithub(r.cookie, 798, "no-email-link", []);
    expect(new URL(cb.headers.get("location")!, t.origin).searchParams.get("error")).toBe(
      "github_email_required",
    );
    expect((await t.service.db.users.byId(r.session!.user.id))?.githubId).toBeNull();
  });
  test("GitHub remains an independent login option when Feishu is enabled", async () => {
    t.github.user({ id: 799, login: "new-github", org: "active" });
    expect(await t.login("new-github")).toMatchObject({ ok: true });
    expect(await t.service.db.users.byGithubId("799")).toBeDefined();
  });
  test("existing GitHub user explicitly connects Feishu, preserving user ID and role", async () => {
    // Pre-existing rows represent users created before Feishu was enabled.
    await t.service.db.insert(user).values({
      id: "legacy-user",
      name: "Legacy",
      email: "legacy@example.com",
      emailVerified: true,
      githubId: "702",
      githubLogin: "legacy",
      role: "member",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await t.service.db.insert(account).values({
      id: "legacy-account",
      userId: "legacy-user",
      providerId: "github",
      accountId: "702",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    t.github.user({ id: 702, login: "legacy", org: "active", email: "legacy@example.com" });
    const old = await t.login("legacy");
    if (!old.ok) throw new Error(old.error);
    await t.makeAdmin(old.userId);
    expect((await login(profile("legacy"))).error).toBe("account_not_linked");
    const linked = await login(profile("legacy", { email: "work@example.com" }), old.cookie);
    expect(linked.error).toBeNull();
    expect(await t.service.db.users.byId(old.userId)).toMatchObject({
      role: "admin",
      feishuOpenId: "ou_legacy",
    });
    const again = await login(profile("legacy", { email: "work@example.com" }));
    expect(again.session?.user.id).toBe(old.userId);
    expect(again.session?.user.email).toBe("work@example.com");
  });
  test("an already owned GitHub account cannot be attached to a second user", async () => {
    const r = await login(profile("second"));
    const cb = await linkGithub(r.cookie, 701, "optional-github", undefined, "active");
    expect(new URL(cb.headers.get("location")!, t.origin).searchParams.get("error")).toBe(
      "merge_identity_conflict",
    );
    expect((await t.service.db.users.byId(r.session!.user.id))?.githubId).toBeNull();
  });
  test("external allowlist removal rejects refresh even before the cached check expires", async () => {
    const p = profile("removed", { tenant_key: "partner" });
    await t.service.users.feishuAllowlistAdd(
      { kind: "system", job: "test" },
      p.tenant_key,
      p.open_id,
    );
    const r = await login(p);
    const client = await t.mcpClient(r.cookie, t.service.registry.canonical.audience);
    await t.service.users.feishuAllowlistRemove(
      { kind: "system", job: "test" },
      p.tenant_key,
      p.open_id,
    );
    expect((await client.refresh()).status).toBe(400);
    expect((await login(p)).error).toBe("feishu_not_admitted");
  });
  test("grant recheck refreshes an expired upstream token and fails closed on email loss", async () => {
    const p = profile("refresh");
    const r = await login(p);
    const client = await t.mcpClient(r.cookie, t.service.registry.canonical.audience);
    await t.service.db
      .update(account)
      .set({ accessTokenExpiresAt: new Date(0) })
      .where(eq(account.userId, r.session!.user.id));
    t.clock.advance(601);
    expect((await client.refresh()).status).toBe(200);
    expect(fake.refreshes).toBeGreaterThan(0);
    fake.profiles.set(`${p.tenant_key}:${p.open_id}`, { ...p, email: null });
    t.clock.advance(601);
    expect((await client.refresh()).status).toBe(400);
  });
  test.each([false, true])(
    "signed OAuth login continues through linking or merging (%s) to the original client",
    async (merge) => {
      t.clock.advance((Date.now() - t.clock.now().getTime()) / 1000);
      const suffix = merge ? "merged" : "linked";
      const ghId = merge ? 12712 : 12711;
      if (merge) {
        t.github.user({ id: ghId, login: `continuation-${suffix}`, org: "active" });
        expect(await t.login(`continuation-${suffix}`)).toMatchObject({ ok: true });
      }
      const redirect = "http://127.0.0.1:4949/callback";
      const registered = await t.fetch(
        "/auth/oauth2/register",
        json({
          client_name: "Feishu IDE",
          redirect_uris: [redirect],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      );
      const { client_id: clientId } = (await registered.json()) as { client_id: string };
      const verifier = "v".repeat(43);
      const q = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirect,
        response_type: "code",
        scope: "offline_access",
        resource: t.service.registry.canonical.audience,
        state: "original-client-state",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
      });
      const authorization = await t.fetch(`/auth/oauth2/authorize?${q.toString()}`);
      const loginUrl = new URL(authorization.headers.get("location")!, t.origin);
      const r = await login(profile(`continuation-${suffix}-work`), "", loginUrl.search.slice(1));
      const onboarding = new URL(r.location, t.origin);
      expect(onboarding.pathname).toBe("/connect-github");
      expect(onboarding.searchParams.get("sig")).toBeTruthy();
      const { code } = t.github.user({
        id: ghId,
        login: `continuation-${suffix}`,
        org: merge ? "active" : "none",
      });
      const start = await t.fetch("/auth/link-social", {
        ...json({
          provider: "github",
          callbackURL: onboarding.pathname + onboarding.search,
          errorCallbackURL: onboarding.pathname + onboarding.search,
        }),
        cookie: r.cookie,
      });
      const url = new URL(((await start.json()) as { url: string }).url);
      const linked = await t.fetch(
        `/auth/callback/github?code=${code}&state=${url.searchParams.get("state")}`,
        { cookie: absorb(r.cookie, start) },
      );
      let cookie = r.cookie;
      let consentUrl: URL;
      if (merge) {
        const outcome = new URL(linked.headers.get("location")!, t.origin);
        expect(outcome.searchParams.get("error")).toBe("merge_available");
        expect(outcome.searchParams.get("sig")).toBe(onboarding.searchParams.get("sig"));
        const preview = await mergePreview(cookie);
        expect((await mergeRequest(cookie, preview.id)).status).toBe(200);
        const again = await login(
          profile(`continuation-${suffix}-work`),
          "",
          onboarding.search.slice(1),
        );
        cookie = again.cookie;
        consentUrl = new URL(again.location, t.origin);
      } else {
        expect(new URL(linked.headers.get("location")!, t.origin).search).toBe(onboarding.search);
        await t.fetch("/auth/api/me/identity-setup", { method: "POST", cookie });
        const continued = await t.fetch("/auth/oauth2/continue", {
          ...json({ postLogin: true, oauth_query: onboarding.search.slice(1) }),
          cookie,
        });
        const continueBody = (await continued.json()) as { url?: string; redirect_uri?: string };
        consentUrl = new URL((continueBody.url ?? continueBody.redirect_uri)!, t.origin);
      }
      expect(consentUrl.pathname).toBe("/consent");
      const consent = await t.fetch("/auth/oauth2/consent", {
        ...json({ accept: true, oauth_query: consentUrl.search.slice(1) }),
        cookie,
      });
      const consentBody = (await consent.json()) as { url?: string; redirect_uri?: string };
      const target = new URL((consentBody.url ?? consentBody.redirect_uri)!);
      expect(target.searchParams.get("state")).toBe("original-client-state");
      const tokens = await t.fetch("/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          redirect_uri: redirect,
          code: target.searchParams.get("code")!,
          code_verifier: verifier,
        }).toString(),
      });
      expect(tokens.status).toBe(200);
    },
  );
  test("Feishu allowlist API is admin-only, idempotent and audited", async () => {
    const r = await login(profile("allowlistadmin"));
    const path = "/auth/api/admin/feishu-allowlist/partner/ou_API";
    expect((await t.fetch(path, { ...json({}), method: "PUT" })).status).toBe(401);
    expect((await t.fetch(path, { ...json({}), method: "PUT", cookie: r.cookie })).status).toBe(
      403,
    );
    await t.makeAdmin(r.session!.user.id);
    expect(
      await (
        await t.fetch(path, { ...json({ note: "invited" }), method: "PUT", cookie: r.cookie })
      ).json(),
    ).toEqual({ changed: true });
    expect(
      await (await t.fetch(path, { ...json({}), method: "PUT", cookie: r.cookie })).json(),
    ).toEqual({ changed: false });
    expect(await (await t.fetch(path, { method: "DELETE", cookie: r.cookie })).json()).toEqual({
      changed: true,
    });
    expect(
      (await t.audit()).filter(
        (e) =>
          e.type === "admin.feishu_allowlist_added" &&
          (e.event as { openId?: string }).openId === "ou_API",
      ),
    ).toHaveLength(1);
  });
  test("an outage fails closed on returning login and grant recheck", async () => {
    const r = await login(profile("outage"));
    const client = await t.mcpClient(r.cookie, t.service.registry.canonical.audience);
    fake.unavailable = true;
    try {
      expect((await login(profile("outage"))).error).toBeTruthy();
      t.clock.advance(601);
      expect((await client.refresh()).status).toBe(400);
    } finally {
      fake.unavailable = false;
    }
  });
  test("disabled Feishu users cannot sign in or link GitHub", async () => {
    const r = await login(profile("disabled"));
    await t.service.users.setDisabled({ kind: "system", job: "test" }, r.session!.user.id, true);
    expect((await login(profile("disabled"))).error).toBe("banned");
    const res = await t.fetch("/auth/link-social", {
      ...json({ provider: "github", callbackURL: "/settings" }),
      cookie: r.cookie,
    });
    expect(res.status).toBe(401);
  });
});

test("partial Feishu configuration fails at boot", () => {
  expect(() =>
    loadConfig({
      PUBLIC_ORIGIN: "http://localhost:3000",
      AUTH_SECRET: "x".repeat(32),
      DATABASE_URL: "pglite://memory",
      GITHUB_CLIENT_ID: "x",
      GITHUB_CLIENT_SECRET: "x",
      GITHUB_ORG: "x",
      FEISHU_APP_ID: "x",
    }),
  ).toThrow("must be set together");
});
