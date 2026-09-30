# Authentication model

Herkules uses one self-hosted authorization server at `https://herkules.dev/auth`. Feishu or GitHub proves the external identity. Feishu users require a readable contact email and admission by team tenant or an explicit external-identity allowlist entry; GitHub connection is optional. The auth database owns the stable Herkules user and the `admin | member` role. Resource servers verify short-lived access tokens locally.

[`tokens.md`](tokens.md) is authoritative for token fields, verification, errors, protected-resource metadata, and conformance. This document explains ownership and service interaction.

## Ownership

| Concern                                                   | Owner                                                     |
| --------------------------------------------------------- | --------------------------------------------------------- |
| Users, roles, disabled state, allowlist, GitHub admission | `services/auth/src/gate.ts`, `services/auth/src/users.ts` |
| Resource names, audiences, scopes, token TTLs, metadata   | `services/auth/src/registry.ts`                           |
| OAuth and OIDC endpoints, grants, access-token claims     | `services/auth/src/auth.ts`                               |
| First-party client registration and redirect URIs         | `services/auth/src/clients.ts`                            |
| Resource-server verification and challenges               | `packages/auth-middleware`, governed by `docs/tokens.md`  |
| Browser OAuth sessions in first-party apps                | `packages/oauth-client`                                   |
| Display names, avatars, GitHub IDs                        | Auth user-info API in `services/auth/src/users.ts`        |
| Application data and authorization beyond role            | The consuming app or service                              |

A confirmed identity merge can retire an unused duplicate after proof of both
accounts. The account with application history retains its `sub`; if both have
history, merging requires application-specific data migration. Matching email
addresses never authorize merging. See the auth service README for the proof,
revocation and audit rules.

Only the opaque access-token `sub` identifies a user in application storage. `client_id` identifies software for audit. GitHub IDs, display names, and avatar URLs can change and must not become foreign keys.

## Browser flow

The platform SPA uses the auth service's same-origin session cookie. A first-party product such as BBS is a confidential OAuth client:

1. The app starts authorization code with PKCE for its API audience and `offline_access`.
2. The issuer authenticates through Feishu or GitHub and applies the corresponding admission gate. Feishu users may connect GitHub or skip before continuing consent.
3. The app exchanges the code with `client_secret_basic` and stores only the access and refresh tokens in an encrypted, host-only cookie.
4. `@herkules/oauth-client` verifies the access token through the app's existing `ResourceAuth` and exposes the same `Principal` used for bearer requests.

Browser sessions are stateless in the app. Rotating its cookie secret signs all browsers out. The auth service still owns grant revocation, disabled users, and role changes.

## Remote MCP flow

1. A resource server returns 401 with the exact protected-resource metadata URL in `WWW-Authenticate`.
2. The client fetches that document and discovers the issuer.
3. The client registers through DCR, then completes authorization code with PKCE and consent for the requested resource.
4. The issuer returns a 15-minute, EdDSA-signed token whose `aud` names that resource.
5. The resource server verifies the token against JWKS without calling auth on every request.

Per-client commands and configuration for the MCP clients this platform is known to work with live in [`../apps/bbs/README.md`](../apps/bbs/README.md#connecting-an-mcp-client).

Claude Code registers through DCR by its own choice: it withholds client-ID metadata (CIMD) whenever its loopback redirect carries a port, which is always. Cursor, Zed and Gemini CLI also complete DCR against this issuer. Cursor uses `https://www.cursor.com/agents/mcp/oauth/callback` for web agents and `http://localhost:8787/callback` for the desktop app; both are on the redirect allowlist. Some Cursor DCR requests still include the retired `cursor://anysphere.cursor-mcp/oauth/callback` URI beside a current callback. The Cursor registration quirk removes that URI. A request that offers only the retired URI is rejected. Zed and Gemini CLI use loopback callbacks.

ChatGPT Dots uses DCR with the exact `https://chatgpt.com/connector_platform_oauth_redirect` callback. The issuer advertises RFC 9207 issuer identification, so ChatGPT uses this stable callback. MCP resource connections request `offline_access` with OIDC disabled; each user separately consents for the requested resource.

VS Code, Codex and Claude Code can use CIMD, but CIMD requires the authorization server to fetch each client's metadata document, and `claude.ai` and `chatgpt.com` are unreachable from the Hong Kong host. CIMD is therefore implemented but off: `@better-auth/cimd` is mounted beside DCR only when `CIMD_ENABLED` is set, with the Node fetch guard (resolve-once DNS, public-routable addresses only, no redirects) and the MCP 2026-07-28 metadata profile. DCR remains the supported dynamic path for all documented clients in production. The defect that used to break Claude Code's CIMD path — its document registers `http://localhost/callback` while the authorize request carries `http://localhost:<random>/callback`, and the matcher granted RFC 8252 port variance to `127.0.0.1`/`[::1]` only — was fixed in Better Auth 1.7.3 (better-auth PR #11090); `services/auth/tests/cimd.test.ts` authorizes that exact document shape on an ephemeral port and checks that only the port may vary. Two things differ from DCR: a CIMD client's redirect URIs come from its document and never pass the `clients.ts` quirks, so consent per client per resource is what stands between a stranger's document and a token, and `CIMD_ALLOWED_ORIGINS` can restrict which `client_id` origins are fetched at all. The plugin caches validated documents for an hour but does not serve stale on a failed refetch; that authorize fails as `invalid_client`. Enable CIMD when the auth container gains an egress path to those hosts, then verify VS Code, Codex and Claude Code sign in over CIMD while Cursor, which supports neither CIMD nor a port-less loopback, still uses DCR.

## Admission and revocation

Feishu admission requires a readable email plus the configured tenant or a case-sensitive tenant/open-ID allowlist entry. GitHub login requires a real verified email; admission comes from an environment-seeded administrator, the checked GitHub allowlist, or membership in the configured GitHub organization. Each login provider applies its own gate; grants recheck the admission stamp from the latest successful sign-in. Disabled users are always refused first. The gate runs at login and is rechecked during grants under the TTL and stale-org policy in `services/auth/src/config.ts` and `services/auth/src/gate.ts`.

Access tokens remain valid until expiry. Disabling a user also removes sessions and OAuth refresh tokens. Services that call user-info with the caller's token get an earlier disabled-user check; fully local authorization accepts the remaining short access-token lifetime by design.

All role, allowlist, disable, session, and client changes go through audited transactions. The Better Auth admin endpoints that would bypass this rule are disabled in `services/auth/src/auth.ts`.

## Adding a resource

Add the reviewed resource entry in `services/auth/src/registry.ts`, configure the resource server with the derived public audience and issuer, use `@herkules/auth-middleware` or implement [`tokens.md`](tokens.md), and add the deployment route described by [`../tools/deploy/README.md`](https://github.com/trident-rm/herkules-infra/blob/main/tools/deploy/README.md). The resource server must not serve a second protected-resource metadata document.
