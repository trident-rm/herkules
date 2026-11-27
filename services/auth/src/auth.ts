/**
 * The Better Auth instance: every plugin option, hook and callback in one
 * readable place. This file IS the authorization server; the rest of the
 * service is what Better Auth cannot do (registry PRM, audited admin ops,
 * user-info, avatars).
 *
 * Reading order for the two flows that matter:
 *   login:   socialProviders.github.getUserInfo (gate.stampLogin: allowlist first, then org check — has the token;
 *            also copies the stamp onto the returned user, which is how additional fields reach the row)
 *            -> user.validateUserInfo (reads the stamp; rejects + audits)
 *            -> databaseHooks.user.create.before (seed admin role from env)
 *            -> hooks.after "/callback/:id" (login audit, avatar refresh)
 *   grant:   customTokenResponseFields (gate.recheck on EVERY grant; throw = clean invalid_grant)
 *            -> customAccessTokenClaims (role stamp)
 *            -> hooks.after "/oauth2/token" (token.issued audit)
 */
import { cimd } from "@better-auth/cimd";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { mcp } from "@better-auth/mcp";
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";
import { betterAuth, type BetterAuthOptions, type BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { admin } from "better-auth/plugins/admin";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import {
  FEISHU_AUTHORIZE,
  FEISHU_TOKEN,
  FEISHU_SCOPES,
  FEISHU_ERRORS,
  feishuEmail,
  feishuPkce,
  feishuSubject,
  type Feishu,
  type FeishuProfile,
} from "./feishu.ts";
import { jwt } from "better-auth/plugins/jwt";
import { signingOptions } from "./signing.ts";

import type { Audit } from "./audit.ts";
import { auditAfterHook } from "./audit.ts";
import { isDevTokenClient, isRoleInIdTokenClient, registerBeforeHook } from "./clients.ts";
import { clientSecretStore } from "./secrets.ts";
import type { Config } from "./config.ts";
import { MergeError, type Merges } from "./db/merges.ts";
import type { AuthDb } from "./db/index.ts";
import * as schema from "./db/schema.ts";
import type { Gate, GateReason } from "./gate.ts";
import { gateUserRowOf, isStamped } from "./gate.ts";
import type { GithubApi } from "./github.ts";
import type { Registry } from "./registry.ts";
import type { Role } from "./users.ts";
import { roleOf } from "./users.ts";

const DAY = 86_400;

export interface AuthDeps {
  readonly merges: Merges;
  readonly config: Config;
  readonly db: AuthDb;
  readonly registry: Registry;
  readonly gate: Gate;
  readonly audit: Audit;
  readonly github: GithubApi;
  readonly feishu: Feishu;
  readonly now: () => Date;
  /** Called after a login completes (avatar refresh). Injected to keep users.ts/avatars.ts out of this file's imports. */
  readonly onLogin: (userId: string) => Promise<void>;
  /** Transport for CIMD documents (main.ts injects the Node guard; tests inject a fake). Only used when CIMD_ENABLED. */
  readonly fetchClientMetadataResource: ClientMetadataResourceFetch;
}

/**
 * Endpoints we refuse to expose. Better Auth matches these EXACTLY (no globs:
 * the router does `disabledPaths.includes(normalizedPath)`), so every admin
 * mutation is listed by name. Every mutation goes through /auth/api/admin
 * (audited, transactional); the admin plugin stays for the role/banned columns
 * and its session-create ban check only.
 */
export const DISABLED_PATHS: readonly string[] = [
  "/token", //                 jwt plugin's session->JWT mint; only oauth2/token issues access tokens (and it would carry no aud)
  "/update-user", //           additional fields are input:true so mapProfileToUser can set them; nobody else may
  "/delete-user", //           FRAME: disable, never delete (audit integrity)
  "/change-email",
  "/unlink-account", // primary Feishu identity cannot be removed to bypass its admission policy
  "/get-access-token", // upstream credentials are server-only
  "/refresh-token",
  // DCR is the only supported client-registration surface. Client mutations must
  // not bypass its redirect policy or our audited consent-revocation route.
  "/oauth2/create-client",
  "/oauth2/update-client",
  "/oauth2/delete-client",
  "/oauth2/client/rotate-secret",
  "/oauth2/update-consent",
  "/oauth2/delete-consent", // replaced by /auth/api/me/clients/:id (also revokes refresh tokens + audits)
  "/admin/set-role",
  "/admin/ban-user", //        ban without refresh-token revocation leaves the IDE working for 30 days
  "/admin/unban-user",
  "/admin/create-user", //     GitHub is the only way in
  "/admin/remove-user",
  "/admin/set-user-password",
  "/admin/update-user",
  "/admin/impersonate-user",
  "/admin/stop-impersonating",
  "/admin/revoke-user-session",
  "/admin/revoke-user-sessions",
  "/admin/list-users", //      reads too: one admin surface, with our projection (connected clients, last login)
  "/admin/get-user",
  "/admin/list-user-sessions",
  "/admin/has-permission",
];

/** Options the schema generator and the runtime must agree on: build once, use in both. */
export function authOptions(deps: AuthDeps) {
  const { config, registry, gate, audit } = deps;
  const recordAudit = auditAfterHook(audit);
  const markApplicationUse = async (userId: string) => {
    try {
      await deps.merges.markApplicationUse(userId);
    } catch (error) {
      if (error instanceof MergeError)
        throw new APIError("BAD_REQUEST", {
          error: "invalid_grant",
          error_description: error.message,
        });
      throw error;
    }
  };
  const validatedProfiles = new WeakMap<
    object,
    | { provider: "feishu"; profile: FeishuProfile }
    | { provider: "github"; profile: import("./gate.ts").StampedProfile }
  >();
  /**
   * Typed as BetterAuthPlugin[] on purpose: spreading cimd()'s own return type
   * conditionally makes the plugins tuple unnameable for declaration emit
   * (TS2883 in `vp pack`); a typed rest spread keeps jwt/admin/mcp inference.
   */
  const cimdPlugins: BetterAuthPlugin[] = config.CIMD_ENABLED
    ? [
        cimd({
          fetchClientMetadataResource: deps.fetchClientMetadataResource,
          metadataProfile: "mcp-2026-07-28", // MCP pins draft-00's required client_name + redirect_uris
          isMetadataDocumentUrlAllowed: (clientIdUrl) =>
            config.CIMD_ALLOWED_ORIGINS.length === 0 ||
            config.CIMD_ALLOWED_ORIGINS.includes(new URL(clientIdUrl).origin),
          /** Discovery never passes /oauth2/register, so the audit after-hook cannot see it. */
          onClientCreated: async ({ client, clientMetadataDocument }) => {
            await audit.record({
              type: "client.registered",
              clientId: client.clientId,
              ...(typeof clientMetadataDocument.client_name === "string"
                ? { name: clientMetadataDocument.client_name }
                : {}),
              redirectUris: clientMetadataDocument.redirect_uris ?? [],
              discovery: "cimd",
            });
          },
        }),
      ]
    : [];
  return {
    appName: "herkules",
    baseURL: config.issuer, // path in baseURL wins over basePath -> handler mounts at /auth/*
    secret: config.AUTH_SECRET,
    database: drizzleAdapter(deps.db, { provider: "pg", schema }),
    trustedOrigins: [config.PUBLIC_ORIGIN],
    disabledPaths: [...DISABLED_PATHS],
    onAPIError: { errorURL: "/login" }, // gate rejections land on the SPA login page as ?error=<code>&error_description=

    socialProviders: {
      github: {
        clientId: config.GITHUB_CLIENT_ID,
        clientSecret: config.GITHUB_CLIENT_SECRET,
        scope: ["read:org"], // appended to read:user,user:email
        overrideUserInfoOnSignIn: true, // name/image/githubLogin mirrored from GitHub each login (FRAME)
        /**
         * The gate's EVIDENCE half runs here and nowhere else: this is the only
         * callback that holds the fresh GitHub token before the account row exists.
         * Returns { user, data }; `data` becomes validateUserInfo's `source.oauth.profile`.
         */
        getUserInfo: async (tokens) => {
          if (!tokens.accessToken) return null;
          const profile = await gate.stampLogin(tokens.accessToken);
          if (!profile) return null;
          const { verdict, checkedAt } = profile.herkules;
          if (!profile.email) {
            await gate.reject(
              { githubLogin: profile.login, githubId: String(profile.id) },
              "github_email_required",
              "login",
            );
          }
          const existing = await deps.db.users.byGithubId(String(profile.id));
          const keepFeishuProfile = existing?.feishuOpenId && profile.email ? existing : undefined;
          return {
            user: {
              // No `id`: Better Auth derives the account subject from the provider's numeric profile id itself.
              name: keepFeishuProfile?.name ?? profile.name ?? profile.login,
              email: keepFeishuProfile?.email ?? profile.email ?? "",
              image: keepFeishuProfile?.image ?? profile.avatar_url,
              emailVerified: keepFeishuProfile ? keepFeishuProfile.emailVerified : !!profile.email,
              // Every other key lands on the user row as an additional field (input: true), on create AND on
              // each returning sign-in (overrideUserInfoOnSignIn). mapProfileToUser is NOT called when
              // getUserInfo is overridden, so the stamp is copied here.
              githubLogin: profile.login,
              githubId: String(profile.id),
              ...(verdict.ok ? { admittedVia: verdict.via, gateCheckedAt: checkedAt } : {}),
            },
            // Our stamped subset rides where Better Auth expects GitHub's full wire profile; only validateUserInfo reads it.
            data: profile as never,
          };
        },
      },
    },

    user: {
      additionalFields: {
        githubLogin: { type: "string", required: false, input: true },
        githubId: { type: "string", required: false, input: true },
        feishuTenantKey: { type: "string", required: false, input: true },
        feishuOpenId: { type: "string", required: false, input: true },
        mergedInto: { type: "string", required: false, input: false },
        githubConnectionOffered: {
          type: "boolean",
          required: false,
          input: false,
          defaultValue: false,
        },
        admittedVia: {
          type: [
            "admin",
            "allowlist",
            "org",
            "org-stale",
            "feishu-tenant",
            "feishu-allowlist",
          ] as const,
          required: false,
          input: true,
        },
        gateCheckedAt: { type: "number", required: false, input: true }, // epoch seconds
      },
      /**
       * The gate's DECISION half: enforced on create-user, link-account and
       * every returning sign-in. Reads the stamp; never calls GitHub.
       * Returning { error } sends the browser to onAPIError.errorURL.
       */
      validateUserInfo: async ({ source, user }, ctx) => {
        const oauth = source.method === "oauth" ? source.oauth : undefined;
        const offerMerge = async (provider: "github" | "feishu", accountId: string) => {
          const session = await getSessionFromCtx(ctx);
          if (!session || session.user.id !== user.id)
            return {
              error: "merge_reauthentication_required",
              errorDescription: "Sign in again before connecting an identity.",
            };
          try {
            if (await deps.merges.prepare(session.session.id, user.id!, provider, accountId))
              return {
                error: "merge_available",
                errorDescription: "You own two accounts. Review and confirm merging them.",
              };
          } catch (error) {
            if (error instanceof MergeError)
              return { error: error.code, errorDescription: error.message };
            throw error;
          }
          return undefined;
        };
        if (oauth?.providerId === "feishu") {
          const profile = oauth.profile?.feishu as FeishuProfile | undefined;
          if (!profile)
            return {
              error: "feishu_unavailable",
              errorDescription: FEISHU_ERRORS.feishu_unavailable,
            };
          const verdict = await deps.feishu.decide(
            profile,
            source.action === "create-user" ? undefined : user.id,
          );
          if (!verdict.ok) {
            await deps.feishu.reject(verdict.reason, "login", profile, user.id);
            return { error: verdict.reason, errorDescription: FEISHU_ERRORS[verdict.reason] };
          }
          if (source.action === "link-account") {
            const existing = await deps.db.users.byId(user.id!);
            if (
              existing?.feishuOpenId &&
              (existing.feishuOpenId !== profile.open_id ||
                existing.feishuTenantKey !== profile.tenant_key)
            )
              return {
                error: "identity_already_connected",
                errorDescription: "A Feishu identity is already connected to this account.",
              };
          }
          if (source.action === "link-account") {
            const ownerVerdict = await deps.feishu.decide(profile);
            if (!ownerVerdict.ok)
              return {
                error: ownerVerdict.reason,
                errorDescription: FEISHU_ERRORS[ownerVerdict.reason],
              };
            const merge = await offerMerge("feishu", feishuSubject(profile));
            if (merge) return merge;
          }
          validatedProfiles.set(ctx.context, { provider: "feishu", profile });
          return undefined;
        }
        if (!oauth || oauth.providerId !== "github") {
          return {
            error: "unsupported_login",
            errorDescription: "Use one of the configured sign-in providers.",
          };
        }
        const p: unknown = oauth.profile;
        if (!isStamped(p))
          return { error: "server_error", errorDescription: "Sign-in could not be verified." };
        const existing = user.id ? await deps.db.users.byId(user.id) : undefined;
        if (existing?.banned) return { error: "banned", errorDescription: FEISHU_ERRORS.banned };
        if (!p.email)
          return {
            error: "github_email_required",
            errorDescription: DESCRIPTIONS.github_email_required,
          };
        if (existing?.feishuOpenId && source.action === "link-account") {
          if (existing.githubId && existing.githubId !== String(p.id))
            return {
              error: "identity_already_connected",
              errorDescription: "A GitHub account is already connected.",
            };
          const verdict = await deps.feishu.recheck(gateUserRowOf({ ...existing }));
          if (!verdict.ok)
            return { error: verdict.reason, errorDescription: FEISHU_ERRORS[verdict.reason] };
          const owner = await deps.db.users.byGithubId(String(p.id));
          if (owner && owner.id !== existing.id) {
            if (!p.herkules.verdict.ok)
              return {
                error: p.herkules.verdict.reason,
                errorDescription: DESCRIPTIONS[p.herkules.verdict.reason],
              };
            const merge = await offerMerge("github", String(p.id));
            if (merge) return merge;
          }
          validatedProfiles.set(ctx.context, { provider: "github", profile: p });
          return undefined;
        }
        validatedProfiles.set(ctx.context, { provider: "github", profile: p });
        const { verdict } = p.herkules;
        if (verdict.ok) return undefined;
        await gate.reject(
          { githubLogin: p.login, githubId: String(p.id) },
          verdict.reason,
          "login",
        );
        return { error: verdict.reason, errorDescription: DESCRIPTIONS[verdict.reason] };
      },
    },
    account: {
      updateAccountOnSignIn: true,
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        allowDifferentEmails: true,
        trustedProviders: ["github", "feishu"],
        updateUserInfoOnLink: false,
      },
    }, // stored GitHub token refreshed each login; gate.recheck reads it

    session: {
      expiresIn: 30 * DAY,
      updateAge: 1 * DAY,
      // No cookieCache: it would keep a disabled user's browser session alive for
      // its maxAge on every device — exactly the lag Users.setDisabled exists to
      // remove. Postgres is on the same box; one session read per request is fine.
    },

    databaseHooks: {
      account: {
        create: {
          after: async (account, ctx) => {
            if (!ctx) return;
            const validated = validatedProfiles.get(ctx.context);
            if (!validated || validated.provider !== account.providerId) return;
            await deps.db.transaction(async (tx) => {
              if (validated.provider === "feishu") {
                const p = validated.profile;
                await tx.users.update(account.userId, {
                  feishuTenantKey: p.tenant_key,
                  feishuOpenId: p.open_id,
                  email: feishuEmail(p)!,
                  emailVerified: false,
                  name: p.name,
                  image: p.avatar_url ?? null,
                });
              } else {
                await tx.users.update(account.userId, {
                  githubId: String(validated.profile.id),
                  githubLogin: validated.profile.login,
                });
              }
              await audit.record(
                {
                  type: "identity.connected",
                  userId: account.userId,
                  provider: account.providerId,
                  accountId: account.accountId,
                },
                tx,
              );
            });
          },
        },
      },
      user: {
        create: {
          /** Seed: an env-listed login is CREATED as admin. Payload role beats the admin plugin's defaultRole. Never demotes (users.ts). */
          before: async (user) => {
            const login =
              typeof user.githubLogin === "string" ? user.githubLogin.toLowerCase() : "";
            if (login && config.ADMIN_GITHUB_LOGINS.includes(login))
              return { data: { ...user, role: "admin" } };
            return undefined;
          },
        },
      },
    },

    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Only one before-hook is allowed; branch by path. Client quirks live in clients.ts.
        if (ctx.path === "/oauth2/register") return registerBeforeHook(ctx);
        return undefined;
      }),
      after: createAuthMiddleware(async (ctx) => {
        await recordAudit(ctx); // login / token / consent / register rows (awaited)
        if (ctx.path === "/callback/:id" && ctx.context.newSession) {
          await deps.onLogin(ctx.context.newSession.user.id);
        }
      }),
    },

    plugins: [
      ...(config.FEISHU_APP_ID
        ? [
            genericOAuth({
              config: [
                {
                  providerId: "feishu",
                  clientId: config.FEISHU_APP_ID,
                  clientSecret: config.FEISHU_APP_SECRET!,
                  authorizationUrl: FEISHU_AUTHORIZE,
                  tokenUrl: FEISHU_TOKEN,
                  scopes: FEISHU_SCOPES,
                  pkce: true,
                  authentication: "post",
                  overrideUserInfo: true,
                  getUserInfo: async (tokens) => {
                    const p = tokens.accessToken
                      ? await deps.feishu.profile(tokens.accessToken)
                      : null;
                    if (!p) {
                      await deps.feishu.reject("feishu_unavailable", "login");
                      return null;
                    }
                    const email = feishuEmail(p);
                    if (!email) await deps.feishu.reject("feishu_email_required", "login", p);
                    const verdict = await deps.feishu.decide(p);
                    return {
                      id: feishuSubject(p),
                      name: p.name,
                      email: email ?? "",
                      emailVerified: false,
                      image: p.avatar_url ?? undefined,
                      feishu: p,
                      ...(verdict.ok
                        ? {
                            admittedVia: verdict.via,
                            gateCheckedAt: Math.floor(deps.now().getTime() / 1000),
                          }
                        : {}),
                    };
                  },
                  mapProfileToUser: (raw) => {
                    const p = raw.feishu as FeishuProfile;
                    return {
                      feishuTenantKey: p.tenant_key,
                      feishuOpenId: p.open_id,
                      admittedVia: raw.admittedVia,
                      gateCheckedAt: raw.gateCheckedAt,
                    };
                  },
                },
              ],
            }),
            feishuPkce,
          ]
        : []),
      jwt({
        ...signingOptions(config.issuer),
      }),
      admin({
        defaultRole: "member" satisfies Role,
        adminRoles: ["admin" satisfies Role],
        // No adminUserIds: the env seeds the role column instead, so there is one source of authority (the row).
      }),
      mcp({
        loginPage: "/login",
        consentPage: "/consent",
        postLogin: {
          page: "/connect-github",
          consentReferenceId: () => undefined,
          shouldRedirect: ({ user }) =>
            !!user.feishuOpenId && !user.githubId && !user.githubConnectionOffered,
        },
        resource: registry.canonical.audience,
        resources: [...registry.oauthResources()], // mcp() appends `resource` again and dedupes; overwrite mode makes the registry authoritative
        resourceSeedMode: "overwrite",
        cachedResources: new Set(registry.audiences), // no oauth_resource read per token request
        enforcePerClientResources: false, // FRAME: any IDE client may request any registry resource; consent is still per client per resource (Better Auth re-prompts for a new resource)
        /**
         * AS vocabulary. MCP resources never grant openid/profile/email: the
         * per-resource allowedScopes filter (registry.ts) intersects them away,
         * which keeps `aud` a single string and mints no id_token. The OIDC
         * scopes stay advertised for future first-party OIDC clients (the BBS).
         */
        scopes: ["openid", "profile", "email", "offline_access"],
        grantTypes: ["authorization_code", "refresh_token"],
        accessTokenExpiresIn: 900,
        refreshTokenExpiresIn: 30 * DAY,
        refreshTokenReuseInterval: 30,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true, // Claude Code registers with no credentials
        clientRegistrationRequirePKCE: true,
        storeTokens: "hashed",
        storeClientSecret: clientSecretStore, // secrets.ts owns the format; clients.ts seeds rows with the same function
        rateLimit: { register: { window: 3600, max: 20 } }, // IDEs re-register per session; 5/min default is too tight for a team behind one NAT
        /**
         * The grant re-check, for EVERY grant type. Runs before any token is
         * created, with the DB user row but no request context; the gate
         * reaches DB/GitHub through its own closures (allowlist + ban are local
         * rows; GitHub only when the cached verdict is older than
         * GATE_RECHECK_TTL). Throwing rejects the grant cleanly as
         * invalid_grant; gate.reject has already revoked the refresh family and
         * written the audit row.
         */
        customTokenResponseFields: async ({ grantType, user, metadata }) => {
          if (grantType === "refresh_token" && isDevTokenClient(metadata)) {
            throw new APIError("BAD_REQUEST", {
              error: "unauthorized_client",
              error_description: "Dev tokens cannot be refreshed. Mint a new one.",
            });
          }
          if (!user) return {};
          const row = gateUserRowOf(user); // boundary: throws (500) on a row the gate never admitted
          if (row.admittedVia === "feishu-tenant" || row.admittedVia === "feishu-allowlist") {
            const verdict = await deps.feishu.recheck(row);
            if (verdict.ok) {
              await markApplicationUse(row.id);
              return {};
            }
            await deps.feishu.reject(verdict.reason, "grant", undefined, row.id);
            throw new APIError("BAD_REQUEST", {
              error: "invalid_grant",
              error_description: FEISHU_ERRORS[verdict.reason],
            });
          }
          const verdict = await gate.recheck(row);
          if (verdict.ok) {
            await markApplicationUse(row.id);
            return {};
          }
          await gate.reject(
            {
              githubLogin: row.githubLogin,
              githubId: typeof user.githubId === "string" ? user.githubId : "",
              userId: row.id,
            },
            verdict.reason,
            "grant",
          );
          throw new APIError("BAD_REQUEST", {
            error: "invalid_grant",
            error_description: DESCRIPTIONS[verdict.reason],
          });
        },
        // LarkAI checks UserInfo on each request: roles and disabling take effect
        // from the current user row, never an app-local admin list or stale ID token.
        customUserInfoClaims: async ({ user, jwt }) => {
          if (jwt.client_id !== "larkai") return {};
          if (user.banned) throw new APIError("UNAUTHORIZED", { error: "invalid_token" });
          return { role: roleOf(user) };
        },
        // Cloudflare and Kellnr read email from the ID token rather than fetching UserInfo.
        // Kellnr also takes its admin flag and username from it (clients.ts `kellnr`).
        customIdTokenClaims: async ({ user, scopes, metadata }) => ({
          ...(scopes.includes("email")
            ? { email: user.email, email_verified: user.emailVerified }
            : {}),
          ...(isRoleInIdTokenClient(metadata)
            ? {
                role: roleOf(user),
                ...(scopes.includes("profile") && typeof user.githubLogin === "string"
                  ? { preferred_username: user.githubLogin.toLowerCase() }
                  : {}),
              }
            : {}),
        }),
        /** Role stamp. `user` is the DB row; the admin plugin owns `role`. A row without a valid role never becomes a token. */
        customAccessTokenClaims: async ({ user }) => {
          if (!user) throw new APIError("BAD_REQUEST", { error: "invalid_grant" });
          return { role: roleOf(user) };
        },
      }),
      /**
       * CIMD (client_id is an HTTPS URL; the issuer fetches the document).
       * Behind CIMD_ENABLED because the deployed host cannot fetch documents
       * from claude.ai/chatgpt.com (docs/auth.md). Since oauth-provider 1.7.3
       * the redirect matcher grants RFC 8252 port variance to `localhost` as
       * well as 127.0.0.1/[::1], so Claude Code's port-less
       * `http://localhost/callback` document authorizes on its per-run port
       * (tests/cimd.test.ts). CIMD clients bypass clients.ts's DCR quirks: their
       * redirect URIs come from the document, and consent per client per
       * resource is what stands between a stranger's document and a token.
       * CIMD_ALLOWED_ORIGINS narrows which documents are fetched at all.
       */
      ...cimdPlugins,
    ],

    // Better Auth 1.7.4 creates OpenTelemetry spans per request by default; nothing here consumes them.
    experimental: { instrumentation: { enabled: false } },

    advanced: {
      cookiePrefix: "herkules",
      useSecureCookies: config.isProduction,
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"], trustedProxies: config.TRUSTED_PROXIES },
    },
    rateLimit: { enabled: config.isProduction, storage: "memory" }, // one container; plugin per-endpoint rules apply on top
  } satisfies BetterAuthOptions;
}

export function createAuth(deps: AuthDeps) {
  return betterAuth(authOptions(deps));
}

export type Auth = ReturnType<typeof createAuth>;

/** Client-visible reason text. Short; never names the org or echoes the login (errorDescription reaches the client). */
export const DESCRIPTIONS: Readonly<Record<GateReason, string>> = {
  github_email_required:
    "GitHub must provide a real, verified email address. Verify an email in GitHub settings and grant email access, then try again.",
  not_org_member: "This GitHub account is not permitted to sign in.",
  banned: "This account has been disabled.",
  github_unreachable: "GitHub could not be reached to verify your membership. Try again.",
  github_token_revoked: "Your GitHub authorization was revoked. Sign in again.",
};
