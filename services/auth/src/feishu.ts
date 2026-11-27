/** Feishu profile and admission policy. OAuth state, PKCE and token exchange belong to Better Auth. */
import { createHash } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { z } from "zod";
import type { Audit } from "./audit.ts";
import type { Config } from "./config.ts";
import type { AuthDb } from "./db/index.ts";
import type { AdmittedVia, GatePhase, GateUserRow } from "./gate.ts";

export const FEISHU_AUTHORIZE = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
export const FEISHU_TOKEN = "https://accounts.feishu.cn/oauth/v3/token";
export const FEISHU_USER_INFO = "https://open.feishu.cn/open-apis/authen/v1/user_info";
export const FEISHU_SCOPES = [
  "contact:user.base:readonly",
  "contact:user.email:readonly",
  "offline_access",
];

function feishuCodeVerifier(verifier: string): string {
  // Use the 43-character format in Feishu's OAuth example. Better Auth stores
  // the random source in OAuth state, so both requests derive the same verifier.
  return createHash("sha256").update(verifier).digest("base64url");
}

export const feishuPkce: BetterAuthPlugin = {
  id: "feishu-pkce",
  init(ctx) {
    const socialProviders = ctx.socialProviders.map((provider): typeof provider => {
      if (provider.id !== "feishu") return provider;
      return {
        ...provider,
        createAuthorizationURL: (data) =>
          provider.createAuthorizationURL({
            ...data,
            codeVerifier: feishuCodeVerifier(data.codeVerifier),
          }),
        validateAuthorizationCode: (data) =>
          provider.validateAuthorizationCode({
            ...data,
            codeVerifier: data.codeVerifier && feishuCodeVerifier(data.codeVerifier),
          }),
      };
    });
    return { context: { socialProviders } };
  },
};

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const profileSchema = z.object({
  tenant_key: identity,
  open_id: identity,
  name: z.string().min(1),
  email: z.string().nullish(),
  avatar_url: z.string().url().nullish(),
});
export type FeishuProfile = z.infer<typeof profileSchema>;
export const feishuSubject = (p: FeishuProfile) => `${p.tenant_key}:${p.open_id}`;
export function feishuEmail(p: FeishuProfile): string | undefined {
  const result = z.string().email().safeParse(p.email?.trim());
  return result.success ? result.data.toLowerCase() : undefined;
}
export const FEISHU_ERRORS = {
  feishu_email_required:
    "Feishu must provide a readable email address. Ask your administrator to set your contact email and enable email access for this app.",
  feishu_not_admitted:
    "This Feishu account is outside the team tenant and is not on the allowlist.",
  feishu_unavailable: "Feishu access could not be verified. Sign in with Feishu again.",
  banned: "This account has been disabled.",
} as const;
type Reason = keyof typeof FEISHU_ERRORS;
type Verdict = { ok: true; via: AdmittedVia } | { ok: false; reason: Reason };
export interface Feishu {
  profile(token: string): Promise<FeishuProfile | null>;
  decide(profile: FeishuProfile, userId?: string): Promise<Verdict>;
  reject(reason: Reason, phase: GatePhase, profile?: FeishuProfile, userId?: string): Promise<void>;
  recheck(user: GateUserRow): Promise<Verdict>;
}
export function createFeishu(deps: {
  config: Config;
  db: AuthDb;
  audit: Audit;
  now: () => Date;
  fetch?: typeof globalThis.fetch;
  accessToken: (userId: string) => Promise<string>;
}): Feishu {
  const { config, db, audit, now } = deps;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  // The service has one process. Coalesce checks (including rotating refresh tokens) per user.
  const checking = new Map<string, Promise<Verdict>>();
  const self: Feishu = {
    async profile(token) {
      try {
        const res = await fetchImpl(FEISHU_USER_INFO, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return null;
        const body = z
          .object({ code: z.literal(0), data: profileSchema })
          .safeParse(await res.json());
        return body.success ? body.data.data : null;
      } catch {
        return null;
      }
    },
    async decide(profile, userId) {
      const row = userId
        ? await db.users.byId(userId)
        : await db.users.byFeishu(profile.tenant_key, profile.open_id);
      if (row?.banned) return { ok: false, reason: "banned" };
      if (!feishuEmail(profile)) return { ok: false, reason: "feishu_email_required" };
      if (config.FEISHU_TENANT_KEY && profile.tenant_key === config.FEISHU_TENANT_KEY)
        return { ok: true, via: "feishu-tenant" };
      if (
        config.FEISHU_APP_ID &&
        (await db.feishuAllowlist.has(profile.tenant_key, profile.open_id))
      )
        return { ok: true, via: "feishu-allowlist" };
      return { ok: false, reason: "feishu_not_admitted" };
    },
    async reject(reason, phase, profile, userId) {
      await audit.record({
        type: "feishu.rejected",
        reason,
        phase,
        ...(profile ? { tenantKey: profile.tenant_key, openId: profile.open_id } : {}),
        ...(userId ? { userId } : {}),
      });
      if (phase === "grant" && userId) await db.tokens.revokeAllRefreshTokens(userId);
    },
    async recheck(user) {
      if (user.banned) return { ok: false, reason: "banned" };
      // External allowlist removal takes effect at the next grant, even within the profile TTL.
      if (!config.FEISHU_APP_ID || !user.feishuTenantKey || !user.feishuOpenId)
        return { ok: false, reason: "feishu_unavailable" };
      const tenant = user.feishuTenantKey === config.FEISHU_TENANT_KEY;
      if (!tenant && !(await db.feishuAllowlist.has(user.feishuTenantKey, user.feishuOpenId)))
        return { ok: false, reason: "feishu_not_admitted" };
      const via = tenant ? "feishu-tenant" : "feishu-allowlist";
      if (
        user.admittedVia === via &&
        user.gateCheckedAt != null &&
        now().getTime() / 1000 - user.gateCheckedAt < config.GATE_RECHECK_TTL
      )
        return { ok: true, via };
      const pending = checking.get(user.id);
      if (pending) return pending;
      const check = async (): Promise<Verdict> => {
        let token: string;
        try {
          token = await deps.accessToken(user.id);
        } catch {
          return { ok: false, reason: "feishu_unavailable" };
        }
        const profile = await self.profile(token);
        if (
          !profile ||
          profile.tenant_key !== user.feishuTenantKey ||
          profile.open_id !== user.feishuOpenId
        )
          return { ok: false, reason: "feishu_unavailable" };
        const verdict = await self.decide(profile, user.id);
        if (verdict.ok) await db.users.writeGate(user.id, verdict, now());
        return verdict;
      };
      const promise = check().finally(() => checking.delete(user.id));
      checking.set(user.id, promise);
      return promise;
    },
  };
  return self;
}
