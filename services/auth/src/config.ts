/**
 * Boundary: process.env -> Config. The only file that reads the environment.
 * Everything downstream receives a validated `Config`; nothing else parses
 * strings. Per boundary-discipline: fail at boot, never at request time.
 * Resources are NOT configured here — see registry.ts.
 */
import { z } from "zod";

const DAY = 86_400;

export const configSchema = z.object({
  /** Public origin of the single-origin deployment, e.g. https://herkules.dev or http://localhost:3000. */
  PUBLIC_ORIGIN: z.string().url(),
  /** Better Auth secret: cookie signing, oauth_query HMAC, private JWK encryption. */
  AUTH_SECRET: z.string().min(32),
  /** postgres://... in compose; `pglite://memory` or `pglite:///path` in tests/dev. */
  DATABASE_URL: z.string().min(1),
  FEISHU_APP_ID: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  FEISHU_APP_SECRET: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  FEISHU_TENANT_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  /** The controlled org whose active members are admitted. */
  GITHUB_ORG: z.string().min(1),
  /**
   * SEED admins by GitHub login. Promotes at boot and at first login; never
   * demotes — the `user.role` column owns the role after that (users.ts).
   */
  ADMIN_GITHUB_LOGINS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    ),
  /** Volume path for cached avatars. */
  AVATAR_DIR: z.string().default("/data/avatars"),
  PORT: z.coerce.number().int().positive().default(3001),
  /** Caddy's address(es) for X-Forwarded-For trust; empty in tests. */
  TRUSTED_PROXIES: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  /** Seconds a grant may reuse the last gate verdict before re-asking GitHub. */
  GATE_RECHECK_TTL: z.coerce.number().int().positive().default(600),
  /** Seconds a prior allow may be kept when GitHub is unreachable at grant time; beyond it the grant is rejected. */
  GATE_STALE_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(1 * DAY),
  /** Unused DCR clients older than this are pruned. */
  DCR_PRUNE_AFTER: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * DAY),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /**
   * Mount Client ID Metadata Document discovery (@better-auth/cimd): a client
   * may present an HTTPS URL as its client_id and the issuer fetches the
   * document. Off by default because the deployed host cannot reach
   * claude.ai/chatgpt.com (docs/auth.md); DCR stays on regardless.
   */
  CIMD_ENABLED: z
    .string()
    .default("false")
    .transform((s) => s === "true" || s === "1"),
  /**
   * Optional comma-separated allowlist of client_id origins for CIMD, e.g.
   * `https://claude.ai,https://chatgpt.com`. Empty: any public origin (the
   * spec default; consent is still per client per resource).
   */
  CIMD_ALLOWED_ORIGINS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().url()))
    .transform((urls) => urls.map((u) => new URL(u).origin)),
  /**
   * The Cloudflare Zero Trust team name: the label before `.cloudflareaccess.com`.
   * Set (with CLOUDFLARE_CLIENT_SECRET): the confidential `cloudflare-access`
   * client is seeded with callback `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`.
   * Unset (or empty): not seeded. Both CLOUDFLARE_* variables or neither.
   */
  LARKAI_ORIGIN: z.preprocess(emptyToUndefined, z.string().url().optional()),
  LARKAI_CLIENT_SECRET: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
  CLOUDFLARE_TEAM_NAME: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
      .optional(),
  ),
  CLOUDFLARE_CLIENT_SECRET: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
  /**
   * apps/bbs's public origin, e.g. https://bbs.herkules.dev (dev: http://localhost:3003).
   * Set: the confidential first-party `bbs` client is seeded with `${BBS_ORIGIN}/callback`.
   * Unset (or empty): not seeded. Both BBS_* variables or neither.
   */
  BBS_ORIGIN: z.preprocess(emptyToUndefined, z.string().url().optional()),
  /** The `bbs` client's secret (>= 32 chars), stored hashed; the same value goes in apps/bbs's env. */
  BBS_CLIENT_SECRET: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
  /**
   * The Beszel hub's origin, e.g. https://ops.herkules.dev (tools/deploy). Set: the
   * confidential first-party `beszel` OIDC client is seeded with PocketBase's fixed
   * redirect `${OPS_ORIGIN}/api/oauth2-redirect`. Unset: not seeded. Both or neither.
   */
  OPS_ORIGIN: z.preprocess(emptyToUndefined, z.string().url().optional()),
  /** The `beszel` client's secret (>= 32 chars), stored hashed; pasted into the hub's OIDC provider settings. */
  BESZEL_CLIENT_SECRET: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
  /**
   * The Kellnr crate registry's origin, e.g. https://crates.herkules.dev (infrastructure).
   * Set: the confidential first-party `kellnr` OIDC client is seeded with Kellnr's fixed
   * redirect `${CRATES_ORIGIN}/api/v1/oauth2/callback`. Unset: not seeded. Both or neither.
   */
  CRATES_ORIGIN: z.preprocess(emptyToUndefined, z.string().url().optional()),
  /** The `kellnr` client's secret (>= 32 chars), stored hashed; the same value goes in `KELLNR_OAUTH2__CLIENT_SECRET`. */
  KELLNR_CLIENT_SECRET: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
});

function emptyToUndefined(value: unknown): unknown {
  return value === "" ? undefined : value;
}

export type Config = z.infer<typeof configSchema> & {
  /** `${PUBLIC_ORIGIN}/auth` — the `iss`, the Better Auth baseURL, the JWKS origin. Derived, never configured. */
  readonly issuer: string;
  readonly isProduction: boolean;
};

/**
 * @throws ZodError with every missing/invalid variable listed at once.
 * Derived fields are computed here so there is exactly one place that knows `/auth`.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.parse(env);
  const origin = new URL(parsed.PUBLIC_ORIGIN).origin;
  const isProduction = parsed.NODE_ENV === "production";
  // `useSecureCookies` follows isProduction (auth.ts), so an http origin in
  // production marks the cookies `Secure`, the browser never sends them back, and
  // sign-in loops with no signal at all. Fail at boot instead, where the name of
  // the variable is still visible.
  if (isProduction && new URL(parsed.PUBLIC_ORIGIN).protocol !== "https:") {
    throw new TypeError(
      "PUBLIC_ORIGIN must be https in production: useSecureCookies would make the session cookie unusable",
    );
  }
  const feishu = [parsed.FEISHU_APP_ID, parsed.FEISHU_APP_SECRET, parsed.FEISHU_TENANT_KEY];
  if (feishu.some(Boolean) && !feishu.every(Boolean)) {
    throw new TypeError(
      "FEISHU_APP_ID, FEISHU_APP_SECRET and FEISHU_TENANT_KEY must be set together",
    );
  }
  if ((parsed.BBS_ORIGIN === undefined) !== (parsed.BBS_CLIENT_SECRET === undefined)) {
    throw new TypeError("BBS_ORIGIN and BBS_CLIENT_SECRET must be set together or not at all");
  }
  if ((parsed.OPS_ORIGIN === undefined) !== (parsed.BESZEL_CLIENT_SECRET === undefined)) {
    throw new TypeError("OPS_ORIGIN and BESZEL_CLIENT_SECRET must be set together or not at all");
  }
  if ((parsed.CRATES_ORIGIN === undefined) !== (parsed.KELLNR_CLIENT_SECRET === undefined)) {
    throw new TypeError(
      "CRATES_ORIGIN and KELLNR_CLIENT_SECRET must be set together or not at all",
    );
  }
  if (
    (parsed.CLOUDFLARE_TEAM_NAME === undefined) !==
    (parsed.CLOUDFLARE_CLIENT_SECRET === undefined)
  ) {
    throw new TypeError(
      "CLOUDFLARE_TEAM_NAME and CLOUDFLARE_CLIENT_SECRET must be set together or not at all",
    );
  }
  if ((parsed.LARKAI_ORIGIN === undefined) !== (parsed.LARKAI_CLIENT_SECRET === undefined)) {
    throw new TypeError(
      "LARKAI_ORIGIN and LARKAI_CLIENT_SECRET must be set together or not at all",
    );
  }
  return Object.freeze({
    ...parsed,
    PUBLIC_ORIGIN: origin,
    BBS_ORIGIN: parsed.BBS_ORIGIN === undefined ? undefined : new URL(parsed.BBS_ORIGIN).origin,
    LARKAI_ORIGIN:
      parsed.LARKAI_ORIGIN === undefined ? undefined : new URL(parsed.LARKAI_ORIGIN).origin,
    OPS_ORIGIN: parsed.OPS_ORIGIN === undefined ? undefined : new URL(parsed.OPS_ORIGIN).origin,
    CRATES_ORIGIN:
      parsed.CRATES_ORIGIN === undefined ? undefined : new URL(parsed.CRATES_ORIGIN).origin,
    issuer: `${origin}/auth`,
    isProduction,
  });
}
