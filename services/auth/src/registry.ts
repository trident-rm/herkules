/**
 * The static resource registry: ONE checked-in type, and every audience-shaped
 * decision in the service derived from it.
 *
 *   ResourceSpec { name: "bbs", kind: "mcp" }
 *     ──> audience        = `${origin}/mcp/bbs`                          (the JWT `aud`, byte for byte)
 *     ──> metadataUrl     = resourceMetadataUrlFor(audience)              (RFC 9728 path-inserted; the SAME
 *                                                                          derivation the verifier package uses)
 *     ──> oauthResource   row seeded into Better Auth (resourceSeedMode "overwrite": the DB is a projection)
 *     ──> PRM document    served by app.ts for EVERY entry (the mcp plugin serves only its canonical one)
 *     ──> dev-token menu  (GET /auth/api/registry)
 *     ──> user-info API   audience policy (bearer.ts: any registry audience)
 *
 * Checked in, not env: an audience string is a security boundary and belongs in
 * a reviewed diff, not a text field on the VPS. Adding a resource server is one
 * line here and a deploy. Pure: no I/O, no clock, no Better Auth import beyond
 * two types/constants.
 */
import type { OAuthResourceInput } from "@better-auth/oauth-provider";
import { resourceMetadataUrlFor } from "@herkules/auth-middleware";
import { DPOP_SIGNING_ALGORITHMS } from "better-auth/oauth2";

export type ResourceKind = "mcp" | "api";

/** What a human writes when adding a resource. Everything else is derived. */
export interface ResourceSpec {
  /** Path segment under `/mcp/` or `/api/`; `[a-z0-9][a-z0-9-]*`. */
  readonly name: string;
  readonly kind: ResourceKind;
  /** Shown on the consent screen and the dev-token picker (`resource_name` in the PRM document). */
  readonly title: string;
  /**
   * Exactly one `mcp` entry carries this: it is the `resource` the mcp() plugin
   * insists on. A flag, not "first entry wins", so a re-ordering is a boot
   * failure instead of a silent reassignment.
   */
  readonly canonical?: true;
  /** Override the 15-minute default. Seconds. Only shorten. */
  readonly accessTokenTtlSeconds?: number;
}

/** THE registry. */
export const RESOURCE_SPECS: readonly ResourceSpec[] = [
  { name: "feishu", kind: "mcp", title: "Feishu (MCP)" },
  { name: "bbs", kind: "api", title: "RM 文库" },
  { name: "bbs", kind: "mcp", title: "RM 文库 (MCP)", canonical: true },
];

/**
 * Per-resource `allowedScopes`: the intersection FILTER Better Auth applies to
 * requested scopes (not a gate). Pinning it to `offline_access` is load-bearing:
 * it strips `openid`, which would otherwise append `${issuer}/oauth2/userinfo`
 * to `aud` and turn it into an array, and it is the one scope a client must
 * hold to be issued a refresh token. The AS-level `scopes` list keeps the OIDC
 * vocabulary for future first-party OIDC clients (the BBS); MCP resources never see it.
 */
export const ALLOWED_SCOPES: Readonly<Record<ResourceKind, readonly string[]>> = {
  mcp: ["offline_access"],
  api: ["offline_access"],
};

export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 900;

/** A resolved entry. Every field is a pure function of the spec and the origin. */
export interface RegistryEntry {
  readonly name: string;
  readonly kind: ResourceKind;
  readonly title: string;
  readonly canonical: boolean;
  /** `/mcp/bbs` — what Caddy routes. */
  readonly pathname: string;
  /** Canonical resource URL === the exact `aud` value. No trailing slash, query or fragment. */
  readonly audience: string;
  /** `https://herkules.dev/.well-known/oauth-protected-resource/mcp/bbs` */
  readonly metadataUrl: string;
  /** Path part of `metadataUrl`; the PRM route's lookup key. */
  readonly metadataPathname: string;
  readonly accessTokenTtlSeconds: number;
  readonly allowedScopes: readonly string[];
}

/**
 * RFC 9728 document, hand-built (the plugin only builds it for its canonical
 * resource). A domain type kept stable for the Python/Rust readers of
 * docs/tokens.md §13, not a Better Auth type.
 */
export interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorization_servers: readonly [string];
  readonly bearer_methods_supported: readonly ["header"];
  readonly dpop_signing_alg_values_supported: readonly string[];
  /** The scopes an MCP client should request: `["offline_access"]`, so it is issued a refresh token. */
  readonly scopes_supported: readonly string[];
  readonly resource_name: string;
}

/** The lookups the service performs, and no others; every one is a map built at boot. */
export interface Registry {
  readonly issuer: string;
  readonly entries: readonly RegistryEntry[];
  /** The `resource` handed to `mcp({ resource })`. Non-optional: the invariant is in the type. */
  readonly canonical: RegistryEntry;
  /** Every audience, for `cachedResources` and the user-info audience policy. */
  readonly audiences: ReadonlySet<string>;
  byAudience(audience: string): RegistryEntry | undefined;
  /** `/.well-known/oauth-protected-resource/mcp/bbs` -> entry. */
  byMetadataPathname(pathname: string): RegistryEntry | undefined;
  /** True when `aud` (string or array) names at least one registry audience. */
  hasKnownAudience(aud: string | readonly string[] | undefined): boolean;
  /** `mcp({ resources })` input, canonical included (mcp() dedupes when it appends its own). */
  oauthResources(): readonly OAuthResourceInput[];
  metadataFor(entry: RegistryEntry): ProtectedResourceMetadata;
}

/**
 * @param origin public origin with no trailing slash, e.g. https://herkules.dev or http://localhost:3000
 * @param issuer `${origin}/auth`
 * @throws TypeError at boot on a malformed or duplicate name, or when the number of
 *   canonical `mcp` entries is not exactly one — a registry typo must be a failed
 *   container start, not a 404 an IDE user discovers.
 */
export function buildRegistry(input: {
  readonly origin: string;
  readonly issuer: string;
  readonly specs: readonly ResourceSpec[];
}): Registry {
  const { origin, issuer, specs } = input;
  const seen = new Set<string>();
  const entries: RegistryEntry[] = specs.map((s) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(s.name))
      throw new TypeError(`registry: bad resource name ${JSON.stringify(s.name)}`);
    const key = `${s.kind}/${s.name}`;
    if (seen.has(key)) throw new TypeError(`registry: duplicate resource ${key}`);
    seen.add(key);
    if (s.canonical && s.kind !== "mcp")
      throw new TypeError(`registry: canonical must be an mcp entry (${key})`);
    const ttl = s.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
    if (ttl > DEFAULT_ACCESS_TOKEN_TTL_SECONDS || ttl <= 0) {
      throw new TypeError(
        `registry: accessTokenTtlSeconds may only shorten the ${DEFAULT_ACCESS_TOKEN_TTL_SECONDS}s default (${key})`,
      );
    }
    const pathname = `/${key}`;
    const audience = `${origin}${pathname}`;
    const metadataUrl = resourceMetadataUrlFor(audience);
    return {
      name: s.name,
      kind: s.kind,
      title: s.title,
      canonical: s.canonical === true,
      pathname,
      audience,
      metadataUrl,
      metadataPathname: new URL(metadataUrl).pathname,
      accessTokenTtlSeconds: ttl,
      allowedScopes: ALLOWED_SCOPES[s.kind],
    };
  });
  const canonicals = entries.filter((e) => e.canonical);
  if (canonicals.length !== 1) {
    throw new TypeError(
      `registry: exactly one mcp entry must be canonical (found ${canonicals.length})`,
    );
  }
  const canonical = canonicals[0]!;
  const byAudience = new Map(entries.map((e) => [e.audience, e]));
  const byMetadataPathname = new Map(entries.map((e) => [e.metadataPathname, e]));

  return {
    issuer,
    entries,
    canonical,
    audiences: new Set(byAudience.keys()),
    byAudience: (audience) => byAudience.get(audience),
    byMetadataPathname: (pathname) => byMetadataPathname.get(pathname),
    hasKnownAudience: (aud) =>
      typeof aud === "string"
        ? byAudience.has(aud)
        : Array.isArray(aud) && aud.some((a) => byAudience.has(a)),
    oauthResources: () =>
      entries.map((e) => ({
        identifier: e.audience,
        signingAlgorithm: "EdDSA", // API/MCP verifiers retain their existing algorithm contract.
        name: e.title,
        accessTokenTtl: e.accessTokenTtlSeconds,
        allowedScopes: [...e.allowedScopes],
      })),
    metadataFor: (e) => ({
      resource: e.audience,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
      dpop_signing_alg_values_supported: [...DPOP_SIGNING_ALGORITHMS],
      scopes_supported: [...e.allowedScopes],
      resource_name: e.title,
    }),
  };
}
