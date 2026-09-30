import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Config } from "./config.ts";
import { FEISHU_DOMAIN, FEISHU_SCOPES } from "./config.ts";
import type { Seal } from "./seal.ts";

const grantSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().positive(),
  scopes: z.array(z.string()),
  tenantKey: z.string().min(1),
  openId: z.string().min(1),
});
export type Grant = z.infer<typeof grantSchema>;
export type Grants = ReturnType<typeof createGrants>;

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
});

export class ConnectionError extends Error {
  constructor(message = "Feishu connection unavailable. Reconnect on the setup page.") {
    super(message);
    this.name = "ConnectionError";
  }
}

export function createGrants(input: {
  config: Pick<Config, "GRANTS_DIR" | "FEISHU_APP_ID" | "FEISHU_APP_SECRET" | "FEISHU_TENANT_KEY">;
  seal: Seal;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}) {
  const { config, seal } = input;
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const now = input.now ?? Date.now;
  const pending = new Map<string, Promise<unknown>>();
  const filename = (subject: string) =>
    join(config.GRANTS_DIR, `${createHash("sha256").update(subject).digest("hex")}.json.enc`);

  async function locked<T>(subject: string, fn: () => Promise<T>): Promise<T> {
    const previous = pending.get(subject) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    pending.set(subject, next);
    try {
      return await next;
    } finally {
      if (pending.get(subject) === next) pending.delete(subject);
    }
  }

  async function load(subject: string): Promise<Grant | undefined> {
    try {
      const raw = await readFile(filename(subject), "utf8");
      const grant = grantSchema.parse(seal.decrypt(raw, `grant:${subject}`));
      if (grant.tenantKey !== config.FEISHU_TENANT_KEY) throw new ConnectionError();
      return grant;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw new ConnectionError();
    }
  }

  async function save(subject: string, grant: Grant) {
    const validated = grantSchema.parse(grant);
    if (validated.tenantKey !== config.FEISHU_TENANT_KEY) throw new ConnectionError();
    await mkdir(config.GRANTS_DIR, { recursive: true, mode: 0o700 });
    const temporary = `${filename(subject)}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, seal.encrypt(validated, `grant:${subject}`), {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, filename(subject));
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async function tokenRequest(body: Record<string, string>) {
    let response: Response;
    try {
      response = await fetchImpl(`${FEISHU_DOMAIN}/open-apis/authen/v2/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: config.FEISHU_APP_ID,
          client_secret: config.FEISHU_APP_SECRET,
          ...body,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const parsed = tokenSchema.safeParse(await response.json());
      if (!response.ok || !parsed.success) throw new ConnectionError();
      return parsed.data;
    } catch {
      throw new ConnectionError();
    }
  }

  return {
    async connected(subject: string) {
      return locked(subject, async () => !!(await load(subject)));
    },
    async disconnect(subject: string) {
      await locked(subject, () => rm(filename(subject), { force: true }));
    },
    async accessToken(subject: string): Promise<string> {
      return locked(subject, async () => {
        const grant = await load(subject);
        if (!grant)
          throw new ConnectionError("Connect your own Feishu account on the setup page first.");
        if (grant.expiresAt > now() / 1000 + 60) return grant.accessToken;
        const token = await tokenRequest({
          grant_type: "refresh_token",
          refresh_token: grant.refreshToken,
        });
        const updated = {
          ...grant,
          accessToken: token.access_token,
          refreshToken: token.refresh_token ?? grant.refreshToken,
          expiresAt: now() / 1000 + token.expires_in,
          scopes: token.scope?.split(" ").filter(Boolean) ?? grant.scopes,
        };
        await save(subject, updated); // Persist rotation before returning the new access token.
        return updated.accessToken;
      });
    },
    async authorize(subject: string, code: string, verifier: string, redirectUri: string) {
      await locked(subject, async () => {
        const token = await tokenRequest({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
        });
        const scopes = token.scope?.split(" ").filter(Boolean) ?? [];
        if (!token.refresh_token || FEISHU_SCOPES.some((scope) => !scopes.includes(scope)))
          throw new ConnectionError(
            "Grant all requested permissions, including continued access, then reconnect.",
          );
        let profile;
        try {
          const response = await fetchImpl(`${FEISHU_DOMAIN}/open-apis/authen/v1/user_info`, {
            headers: { Authorization: `Bearer ${token.access_token}` },
            signal: AbortSignal.timeout(10_000),
          });
          const parsed = z
            .object({
              code: z.literal(0),
              data: z.object({
                tenant_key: z.string().min(1),
                open_id: z.string().min(1),
              }),
            })
            .safeParse(await response.json());
          if (!response.ok || !parsed.success) throw new ConnectionError();
          profile = parsed.data.data;
        } catch {
          throw new ConnectionError();
        }
        if (profile.tenant_key !== config.FEISHU_TENANT_KEY)
          throw new ConnectionError("Authorize an account in the team's Feishu organization.");
        await save(subject, {
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          expiresAt: now() / 1000 + token.expires_in,
          scopes,
          tenantKey: profile.tenant_key,
          openId: profile.open_id,
        });
      });
    },
  };
}
