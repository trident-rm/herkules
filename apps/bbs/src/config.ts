/**
 * Boundary: process.env -> Config. The only file in apps/bbs that reads the
 * environment; fail at boot, never at request time (services/auth convention).
 *
 * bbs is the first thing in this monorepo that lives on TWO origins:
 *   PUBLIC_ORIGIN  https://herkules.dev      the platform: the issuer and both audiences derive
 *                                            from it (`/api/bbs` is an identifier only; `/mcp/bbs`
 *                                            is the path Caddy routes to this container).
 *   APP_ORIGIN     https://bbs.herkules.dev  this product: the OAuth redirect URI, the cookie
 *                                            scope, `og:url` and `<link rel=canonical>`.
 * Dev: APP_ORIGIN=http://localhost:3003 is this app's Vite server (it IS the origin, proxying to
 * PORT=3103); PUBLIC_ORIGIN=http://localhost:3000 is services/web's dev server.
 */
import { resolve } from "node:path";
import { z } from "zod";

/** Registry name; must match the two `RESOURCE_SPECS` lines and the FIRST_PARTY_CLIENTS entry in services/auth. */
export const RESOURCE_NAME = "bbs";
export const SITE_TITLE = "RM 文库";

export const configSchema = z.object({
  PUBLIC_ORIGIN: z.string().url(),
  APP_ORIGIN: z.string().url(),
  /** Base URL this process uses to reach the auth service (JWKS, token, user-info). Defaults to PUBLIC_ORIGIN. */
  AUTH_INTERNAL_URL: z.string().url().optional(),
  /** `postgres://…/bbs` | `pglite://memory` | `pglite:///path`. Same two-host rule as services/auth. */
  DATABASE_URL: z.string().min(1),
  /** The confidential client's secret; services/auth seeds the `bbs` row from the same variable. */
  BBS_CLIENT_SECRET: z.string().min(16),
  /** Seals the session and login cookies (@herkules/oauth-client). Rotating it signs everyone out. */
  BBS_COOKIE_SECRET: z.string().min(32),
  /** Built SPA (index.html + assets/). Absent = dev: the Vite dev server serves the SPA and proxies here. */
  WEB_DIR: z.string().min(1).optional(),
  /** The search seam (db/search). `pgroonga` is the FRAME check-5 fallback and needs the custom image. */
  SEARCH_INDEX: z.enum(["trgm", "pgroonga"]).default("trgm"),
  /** Optional Rust feed/article/content/tag/AI reads; OAuth and the other queries remain here. */
  BBS_RUST_READ_ORIGIN: z.string().url().optional(),
  /** `false` skips the boot-time CREATE DATABASE probe (db/index.ts ensureDatabase); run `createdb bbs` once instead. */
  BBS_CREATE_DATABASE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  PORT: z.coerce.number().int().positive().default(3003),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export interface Config {
  /** Platform origin. Not where the browser is. */
  readonly origin: string;
  /** This app's origin. Where the browser is. */
  readonly appOrigin: string;
  /** `iss` of every accepted token: `${origin}/auth`. */
  readonly issuer: string;
  /** `aud` for browser sessions: `${origin}/api/bbs`. Requested at authorize time; nothing routes it. */
  readonly apiResource: string;
  /** `aud` for agents: `${origin}/mcp/bbs`. */
  readonly mcpResource: string;
  readonly authInternal: string;
  readonly databaseUrl: string;
  readonly clientSecret: string;
  readonly cookieSecret: string;
  /** Absolute path, or null when static serving is off (dev). */
  readonly webDir: string | null;
  readonly searchIndex: "trgm" | "pgroonga";
  readonly rustReadOrigin: string | null;
  readonly createDatabase: boolean;
  readonly port: number;
  readonly isProduction: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = configSchema.parse(env);
  const origin = new URL(raw.PUBLIC_ORIGIN).origin;
  const appOrigin = new URL(raw.APP_ORIGIN).origin;
  const authInternal = raw.AUTH_INTERNAL_URL ? new URL(raw.AUTH_INTERNAL_URL).origin : origin;
  let rustReadOrigin: string | null = null;
  if (raw.BBS_RUST_READ_ORIGIN) {
    const url = new URL(raw.BBS_RUST_READ_ORIGIN);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new TypeError(
        "BBS_RUST_READ_ORIGIN must be an HTTP(S) origin without credentials or a path",
      );
    if (!/^postgres(ql)?:\/\//.test(raw.DATABASE_URL)) {
      throw new TypeError("BBS_RUST_READ_ORIGIN requires the shared Postgres corpus, not PGlite");
    }
    rustReadOrigin = url.origin;
  }
  return Object.freeze({
    origin,
    appOrigin,
    issuer: `${origin}/auth`,
    apiResource: `${origin}/api/${RESOURCE_NAME}`,
    mcpResource: `${origin}/mcp/${RESOURCE_NAME}`,
    authInternal,
    databaseUrl: raw.DATABASE_URL,
    clientSecret: raw.BBS_CLIENT_SECRET,
    cookieSecret: raw.BBS_COOKIE_SECRET,
    webDir: raw.WEB_DIR ? resolve(raw.WEB_DIR) : null,
    searchIndex: raw.SEARCH_INDEX,
    rustReadOrigin,
    createDatabase: raw.BBS_CREATE_DATABASE,
    port: raw.PORT,
    isProduction: raw.NODE_ENV === "production",
  });
}
