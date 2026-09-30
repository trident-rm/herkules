/**
 * Subpath `@herkules/oauth-client/testing`. An in-process issuer that has what
 * `createTestIssuer` deliberately lacks: an authorize endpoint (auto-approves,
 * redirects with a code), a token endpoint with the REAL rotation policy
 * (every refresh rotates; 30 s replay of the identical response; re-use
 * beyond it revokes the (client, user) family), a revoke endpoint, and JWKS —
 * all behind one `fetch`, keys and minting from `createTestIssuer`.
 *
 * End-to-end against the real Better Auth issuer (PGlite, fake GitHub) is the
 * same test shape with `@herkules/auth/testing`'s TestService and
 * `fetchVia(authApp)` as the app's fetch; that run is the FRAME kill criterion.
 */
import type { MintOptions } from "@herkules/auth-middleware/testing";
import { createTestIssuer } from "@herkules/auth-middleware/testing";
import type { Hono } from "hono";

import { pkceChallenge } from "./login.ts";
import { REPLAY_WINDOW_SECONDS } from "./session.ts";

export interface FakeIssuerOptions {
  readonly issuer?: string; // default http://localhost:3000/auth
  readonly client: { readonly id: string; readonly secret: string; readonly redirectUri: string };
  readonly resource: string;
  readonly now?: () => Date;
  /** Access-token lifetime the fake mints. Negative = already expired (forces a refresh on first use). */
  readonly accessTokenTtlSeconds?: number;
}

export interface GrantRecord {
  readonly grantType: "authorization_code" | "refresh_token";
  readonly subject: string;
  readonly replayed: boolean;
}

export interface FakeIssuer {
  readonly issuer: string;
  readonly fetch: typeof globalThis.fetch;
  /** Every token-endpoint call, in order. Tests assert "ten tabs, one refresh". */
  readonly grants: readonly GrantRecord[];
  /** Mint a bearer directly (same MintOptions as createTestIssuer), for "bearer yields the same principal". */
  mint(options: MintOptions): Promise<string>;
  /** Simulate the issuer killing a user's family (admin revoke, gate failure, late replay). */
  revokeFamily(subject: string): void;
  /** Take an app through /login → authorize → /callback and return the Cookie header value to present. */
  signIn(
    app: TestableApp,
    who: { readonly subject: string; readonly role?: "admin" | "member"; readonly next?: string },
  ): Promise<{ readonly cookie: string; readonly location: string }>;
  accessTokenTtlSeconds: number;
}

/** Any Hono app, whatever its Env: only `request` is needed. */
export type TestableApp = { readonly request: Hono["request"] };

type Role = "admin" | "member";

interface Family {
  readonly subject: string;
  readonly role: Role;
  revoked: boolean;
}

interface RefreshEntry {
  readonly familyId: string;
  /** Set once spent; with the response replayed inside the window. */
  rotatedAt?: number;
  response?: string;
  revoked?: boolean;
}

interface PendingCode {
  readonly subject: string;
  readonly role: Role;
  readonly challenge: string;
  readonly redirectUri: string;
  readonly resource: string;
}

const DEFAULT_ISSUER = "http://localhost:3000/auth";

const random = (): string =>
  Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(16))).toString("base64url");

const json = (status: number, body: unknown, headers?: Record<string, string>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

const oauthError = (status: number, error: string, description: string): Response =>
  json(status, { error, error_description: description });

/** Merge a response's Set-Cookie headers into a Cookie header value (Max-Age=0 deletes). */
export function absorbCookies(cookie: string, response: Response): string {
  const map = new Map<string, string>();
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) map.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  for (const sc of response.headers.getSetCookie()) {
    const [first = "", ...attrs] = sc.split(";");
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a));
    if (value === "" || expired) map.delete(name);
    else map.set(name, value);
  }
  return [...map].map(([k, v]) => `${k}=${v}`).join("; ");
}

export async function createFakeIssuer(options: FakeIssuerOptions): Promise<FakeIssuer> {
  const issuer = (options.issuer ?? DEFAULT_ISSUER).replace(/\/+$/, "");
  const now = options.now ?? (() => new Date());
  const base = await createTestIssuer({ issuer });
  const { client, resource } = options;
  const expectedBasic = `Basic ${Buffer.from(
    `${encodeURIComponent(client.id)}:${encodeURIComponent(client.secret)}`,
    "utf8",
  ).toString("base64")}`;

  const grants: GrantRecord[] = [];
  const codes = new Map<string, PendingCode>();
  const families = new Map<string, Family>();
  const refreshTokens = new Map<string, RefreshEntry>();
  let pendingUser: { readonly subject: string; readonly role: Role } | undefined;

  const tokenResponse = async (family: Family, familyId: string): Promise<string> => {
    const accessToken = await base.mint({
      audience: resource,
      subject: family.subject,
      role: family.role,
      clientId: client.id,
      scopes: ["offline_access"],
      expiresIn: self.accessTokenTtlSeconds,
    });
    const refreshToken = `rt_${random()}`;
    refreshTokens.set(refreshToken, { familyId });
    return JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: self.accessTokenTtlSeconds,
      scope: "offline_access",
    });
  };

  const authorize = (url: URL): Response => {
    const q = url.searchParams;
    if (q.get("client_id") !== client.id)
      return oauthError(400, "invalid_client", "unknown client");
    const redirectUri = q.get("redirect_uri");
    if (redirectUri !== client.redirectUri) {
      return oauthError(400, "invalid_request", "redirect_uri not registered");
    }
    const back = (error: string, description: string): Response => {
      const target = new URL(redirectUri);
      target.searchParams.set("error", error);
      target.searchParams.set("error_description", description);
      const state = q.get("state");
      if (state) target.searchParams.set("state", state);
      return Response.redirect(target.toString(), 302);
    };
    if (q.get("response_type") !== "code") return back("unsupported_response_type", "code only");
    const challenge = q.get("code_challenge");
    if (!challenge || q.get("code_challenge_method") !== "S256") {
      return back("invalid_request", "PKCE S256 required");
    }
    if (q.get("resource") !== resource) return back("invalid_target", "unknown resource");
    if (!(q.get("scope") ?? "").split(" ").includes("offline_access")) {
      return back("invalid_scope", "offline_access required");
    }
    const who = pendingUser ?? { subject: "user_test", role: "member" as Role };
    pendingUser = undefined;
    const code = `code_${random()}`;
    codes.set(code, { subject: who.subject, role: who.role, challenge, redirectUri, resource });
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    const state = q.get("state");
    if (state) target.searchParams.set("state", state);
    return Response.redirect(target.toString(), 302);
  };

  const token = async (req: Request): Promise<Response> => {
    if (req.headers.get("authorization") !== expectedBasic) {
      return json(
        401,
        { error: "invalid_client", error_description: "client authentication failed" },
        {
          "www-authenticate": "Basic",
        },
      );
    }
    const form = new URLSearchParams(await req.text());
    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") {
      const code = form.get("code") ?? "";
      const pending = codes.get(code);
      codes.delete(code);
      if (!pending) return oauthError(400, "invalid_grant", "unknown or used code");
      const verifier = form.get("code_verifier") ?? "";
      if ((await pkceChallenge(verifier)) !== pending.challenge) {
        return oauthError(400, "invalid_grant", "PKCE verification failed");
      }
      if (form.get("redirect_uri") !== pending.redirectUri) {
        return oauthError(400, "invalid_grant", "redirect_uri mismatch");
      }
      const familyId = `fam_${random()}`;
      const family: Family = { subject: pending.subject, role: pending.role, revoked: false };
      families.set(familyId, family);
      grants.push({ grantType: "authorization_code", subject: family.subject, replayed: false });
      return new Response(await tokenResponse(family, familyId), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (grantType === "refresh_token") {
      const presented = form.get("refresh_token") ?? "";
      const entry = refreshTokens.get(presented);
      const family = entry ? families.get(entry.familyId) : undefined;
      if (!entry || !family || entry.revoked || family.revoked) {
        return oauthError(400, "invalid_grant", "refresh token is invalid or revoked");
      }
      if (entry.rotatedAt !== undefined) {
        if (now().getTime() - entry.rotatedAt <= REPLAY_WINDOW_SECONDS * 1000 && entry.response) {
          grants.push({ grantType: "refresh_token", subject: family.subject, replayed: true });
          return new Response(entry.response, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        family.revoked = true;
        return oauthError(400, "invalid_grant", "refresh token reuse detected; family revoked");
      }
      const body = await tokenResponse(family, entry.familyId);
      entry.rotatedAt = now().getTime();
      entry.response = body;
      grants.push({ grantType: "refresh_token", subject: family.subject, replayed: false });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }
    return oauthError(400, "unsupported_grant_type", `grant_type ${String(grantType)}`);
  };

  const revoke = async (req: Request): Promise<Response> => {
    if (req.headers.get("authorization") !== expectedBasic) {
      return json(401, { error: "invalid_client" }, { "www-authenticate": "Basic" });
    }
    const form = new URLSearchParams(await req.text());
    const entry = refreshTokens.get(form.get("token") ?? "");
    if (entry) {
      entry.revoked = true;
      const family = families.get(entry.familyId);
      if (family) family.revoked = true;
    }
    return json(200, {});
  };

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const req = input instanceof Request && !init ? input : new Request(input, init);
    const url = new URL(req.url);
    if (req.url.startsWith(`${issuer}/oauth2/authorize`) && req.method === "GET")
      return authorize(url);
    if (url.href === `${issuer}/oauth2/token` && req.method === "POST") return token(req);
    if (url.href === `${issuer}/oauth2/revoke` && req.method === "POST") return revoke(req);
    return base.fetch(input, init);
  };

  const self: FakeIssuer = {
    issuer,
    fetch,
    grants,
    accessTokenTtlSeconds: options.accessTokenTtlSeconds ?? 900,
    mint: (o) => base.mint(o),
    revokeFamily(subject) {
      for (const family of families.values()) if (family.subject === subject) family.revoked = true;
    },
    async signIn(app, who) {
      pendingUser = { subject: who.subject, role: who.role ?? "member" };
      const origin = new URL(client.redirectUri).origin;
      const start = await app.request(
        `${origin}/login?next=${encodeURIComponent(who.next ?? "/")}`,
        { redirect: "manual" },
      );
      if (start.status !== 303) throw new Error(`/login: ${start.status} ${await start.text()}`);
      const loginCookie = absorbCookies("", start);
      const authz = await fetch(start.headers.get("location") ?? "");
      const callback = authz.headers.get("location");
      if (!callback) throw new Error(`authorize: ${authz.status} ${await authz.text()}`);
      const done = await app.request(callback, {
        headers: { cookie: loginCookie },
        redirect: "manual",
      });
      if (done.status !== 303) throw new Error(`/callback: ${done.status} ${await done.text()}`);
      return {
        cookie: absorbCookies(loginCookie, done),
        location: done.headers.get("location") ?? "",
      };
    },
  };
  return self;
}

// Cookie fixtures for cross-language session interoperability tests.
export { createCookieJar, safePath } from "./cookie.ts";
export { createSealer } from "./seal.ts";
