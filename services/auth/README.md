# Auth service

`@herkules/auth` is the authorization server at `https://herkules.dev/auth`. It wraps Better Auth 1.7.4 in Hono, admits Feishu and GitHub users through the team gate, issues audience-bound EdDSA access tokens, and owns users, roles, allowlisting, OAuth clients, protected-resource metadata, avatars, and the audit log.

The cross-service model is documented in [`../../docs/auth.md`](../../docs/auth.md). Resource servers must follow [`../../docs/tokens.md`](../../docs/tokens.md).

## Run and test

Copy `.env.example` to `.env`, fill the GitHub OAuth and database settings, then run:

```sh
vp run dev
vp test
vp check
vp run build
```

Development accepts `pglite://` database URLs. Production uses Postgres and applies the checked-in Drizzle migration at boot. See [`../../tools/deploy/README.md`](https://github.com/trident-rm/herkules-infra/blob/main/tools/deploy/README.md) for the deployed stack.

## Decisions that bind

- `src/registry.ts` is the only owner of resource names, canonical audience URLs, protected-resource metadata URLs, allowed scopes, and access-token TTLs. A registry entry is a reviewed code change. Exactly one MCP resource is canonical, and a resource TTL may shorten but not exceed 900 seconds.
- Registry resources allow only `offline_access`. This produces refresh tokens and keeps access-token `aud` a single resource URL. `src/auth.ts` owns the issuer-wide OAuth vocabulary and token hooks.
- `src/gate.ts` owns GitHub admission: disabled user, environment admin, allowlist, then GitHub organization membership. `src/feishu.ts` owns Feishu admission: disabled user, readable email, then configured tenant or exact tenant/open-ID allowlist entry. Each login provider applies its own admission and email checks. Feishu grant checks fail closed without stale grace; external allowlist removal is checked on every grant.
- `ADMIN_GITHUB_LOGINS` seeds administrators but never demotes a user. `src/users.ts` owns role changes, disabling, session and client revocation, the last-admin and self-demote guards, and their transactions.
- An admin may not remove their own authority: `setRole` refuses a self-demotion (403 `self_demote`) and `setDisabled` refuses a self-disable (403 `self_disable`). The two are ordered differently on purpose. `setRole` checks last-admin first, because an admin demoting another admin always leaves two active admins, so 409 `last_admin` is reachable only through the same self-call and reversing the order would make it dead code. `setDisabled` checks self-disable first, so a lone admin disabling themselves gets the precise 403 instead of a `last_admin` that only describes the symptom; 409 `last_admin` for disable is therefore reachable only from a `system` actor. A system actor passes both self-checks.
- Every authority-changing write must produce an awaited audit row. Add plugin events to the exhaustive table in `src/audit.ts`; add administrative changes through `src/users.ts`. Do not add an unaudited Better Auth admin route.
- DCR is the supported dynamic client-registration surface. Session-based client create/update/delete, secret rotation, and consent-update endpoints are disabled; consent revocation uses the audited application route.
- Browser sessions do not use Better Auth's cookie cache. Disabling a user must take effect on the next request.
- `src/clients.ts` owns first-party clients and native-client redirect quirks. DCR is enabled for IDE clients. CIMD is mounted only when `CIMD_ENABLED` is set (off in production: the deployed host cannot fetch client metadata documents). Better Auth 1.7.3 fixed the `localhost` port-variance matcher that used to break Claude Code's port-less document; `tests/cimd.test.ts` covers that path. CIMD clients bypass the DCR quirks, so consent per client per resource and the optional `CIMD_ALLOWED_ORIGINS` are the only controls over a stranger's document. [`../../docs/auth.md`](../../docs/auth.md) owns the full record.
- User-info accepts a session or a JWT for any registered audience. Callers key data by the opaque `sub`; GitHub IDs, names, and avatars are display data.
- The service owns every RFC 9728 protected-resource metadata document. Resource servers emit its URL in challenges but do not serve competing copies.

## Code map

- `src/auth.ts`: Better Auth configuration, grants, claims, disabled routes
- `src/registry.ts`: resource and audience policy
- `src/gate.ts`, `src/github.ts`: admission evidence and GitHub checks
- `src/users.ts`, `src/bearer.ts`: administrative writes and caller identification
- `src/audit.ts`: audit event vocabulary and plugin hooks
- `src/clients.ts`, `src/secrets.ts`: first-party client registration and secret hashing
- `src/avatars.ts`: the GitHub-avatar cache served at `/auth/avatars/:userId` — stored on a volume, refreshed at login and on miss, `ETag`/`If-None-Match`; a stale entry is never a 5xx
- `src/app.ts`: Hono routes, metadata, user-info, avatars, and health
- `src/config.ts`: environment boundary
- `tests/`: end-to-end issuer, client, gate, and audit behavior

## AI portal

`AI_PORTAL_ORIGIN`, `AI_CLIENT_SECRET` and `AI_SYNC_SECRET` are set together or not at
all. They seed the confidential `ai` client for [the AI gateway](../ai/README.md) with
the exact `${AI_PORTAL_ORIGIN}/callback` redirect, PKCE and refresh tokens, for the
`api/ai` registry audience. The retired New API client, `herkules-ai`, is disabled on
every boot.

`POST /auth/internal/ai-membership` takes `{"ids": [...]}`, at most 100, and requires
`Authorization: Bearer <AI_SYNC_SECRET>`. It answers `{"users": [{"id", "enabled"}]}` in
request order; a missing or disabled user is `enabled: false`. The gateway calls it over
the private network. Caddy answers 404 for every `/auth/internal/*` path.

## Cloudflare Access

Set `CLOUDFLARE_TEAM_NAME` (the label before `.cloudflareaccess.com`) and
`CLOUDFLARE_CLIENT_SECRET` together in the auth environment. Boot seeds the
confidential `cloudflare-access` client, requiring PKCE and the exact callback
`https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`.

OIDC ID tokens use ES256 and include email/email_verified when `email` is granted.
Registry API/MCP access tokens remain EdDSA. Boot provisions any missing signing
algorithm before listening and retains old keys; no database schema migration is
needed. The service currently has one auth process. Configure Cloudflare with
`openid email profile`, PKCE enabled, authorization `/auth/oauth2/authorize`, token
`/auth/oauth2/token`, and JWKS `/auth/jwks` on the public issuer origin. SCIM is not
implemented. Use an Access policy restricted to the Herkules login method: the
issuer's existing admission gate checks team membership on token grants. That policy
is `Herkules team` in `tools/deploy/cloudflare/terraform/access.tf`, so recreating
this identity provider means updating the `oidc_idp_id` variable there. Access
sessions remain valid until their own expiry or explicit revocation.

## LarkAI OpenID Connect

`LARKAI_ORIGIN` and `LARKAI_CLIENT_SECRET` seed the confidential `larkai` client
with the exact `/oidc/callback` redirect and mandatory PKCE. It requests
`openid email profile`. UserInfo adds the current `admin | member` role only
for this client and refuses disabled users. LarkAI checks it on each authenticated
request, so role changes are not copied into a separate app admin list.

## Kellnr crate registry

`CRATES_ORIGIN` and `KELLNR_CLIENT_SECRET` seed the confidential `kellnr` client
with Kellnr's fixed `/api/v1/oauth2/callback` redirect and mandatory PKCE. Kellnr
reads everything from the ID token, so for this client only the ID token adds the
current `admin | member` `role` and, with `profile`, `preferred_username` (the
lowercased GitHub login; Feishu-only users fall back to their email's local part in
Kellnr). Infrastructure sets `KELLNR_OAUTH2__ADMIN_GROUP_CLAIM=role` and
`KELLNR_OAUTH2__ADMIN_GROUP_VALUE=admin`, so Herkules admins are Kellnr admins.
Kellnr re-syncs the flag on each SSO login, not per request: a demotion here takes
effect at that user's next Kellnr sign-in, and their cargo tokens keep working until then.

## Feishu sign-in and optional GitHub connection

Set `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, and `FEISHU_TENANT_KEY` together in
`.env` locally or `.env.auth` in production. Unset all three to retain GitHub-only
operation. GitHub remains an independent login option, requiring a verified real
email and its organization/allowlist gate. Connecting providers preserves the
Herkules ID, roles, grants and application data. Accounts are never merged by matching email.
Administrator bootstrapping still uses `ADMIN_GITHUB_LOGINS`; existing roles survive linking.

In the Feishu developer console, enable and publish `contact:user.base:readonly`,
`contact:user.email:readonly`, and `offline_access`, and give users app access.
Register `${PUBLIC_ORIGIN}/auth/callback/feishu` as the redirect URI
(`http://localhost:3000/auth/callback/feishu` locally). Better Auth's generic OAuth
provider handles state, PKCE, code exchange and refresh against the standard
[v3 token endpoint](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token-v3).

The [user-info endpoint](https://open.feishu.cn/document/server-docs/authentication-management/login-state-management/get)
provides `tenant_key`, app-scoped `open_id`, and `email`. Identity is the immutable
`tenant_key:open_id` pair, never email. Empty, missing, inaccessible or malformed
email refuses first and returning logins, including allowlisted users. No GitHub,
enterprise-email or synthetic-email fallback is used. Feishu describes this contact
email as administrator-supplied and not user-verified, so `emailVerified` remains
false. OIDC consumers requiring verified email need a separate verification policy.

Team-tenant users are admitted automatically. Admin → Allowlist accepts external
Feishu tenant keys and open IDs (case-sensitive, from this OAuth app). Rejected
logins with readable profiles record these IDs in the admin audit log, allowing an
administrator to review and add them. The allowlist does not grant Feishu app access;
external users must still be eligible to authorize the app in Feishu. Changing the
Feishu App ID changes open IDs and requires an explicit identity migration.

After Feishu login, users can connect GitHub or skip and connect later in settings.
The optional step also preserves signed MCP/OIDC continuations. Different GitHub
and Feishu emails are allowed for explicit linking. If the identity belongs to
another account, the completed OAuth callback offers a merge review instead of
claiming it automatically. Existing GitHub users can also connect Feishu directly
from settings. Feishu owns profile/email once
connected. GitHub sign-in still checks its own fresh verified email, but does not
overwrite the stored Feishu profile. Identity unlinking is disabled; removing an
identity requires an operator.

Grants use the admission stamp from the latest successful sign-in. Feishu grants
re-fetch Feishu user info after `GATE_RECHECK_TTL`, using Better Auth to
refresh expired upstream tokens. Missing email, unavailable/revoked Feishu access,
or changed identity fails closed and revokes downstream refresh tokens. External
allowlist removal is checked even within that TTL. Existing browser sessions are
not terminated by allowlist removal; use Disable user for immediate session
revocation. Already-issued access tokens retain their maximum 15-minute lifetime.
Upstream tokens are server-only; public token retrieval/refresh routes are disabled.

The generated Drizzle migrations make GitHub user fields nullable and add Feishu
identity fields, an onboarding preference and the Feishu allowlist. Public legacy
user-info projections keep `githubId` as an empty string when unconnected; session
fields are nullable. Regenerate via `vp run db:schema` then `vp run db:generate`.

## GitHub email requirement

Every GitHub login and explicit connection fetches `/user/emails` with the existing
`user:email` scope. A valid, verified primary address is preferred, otherwise a
verified secondary address is used. Private emails work; a public profile email
is not a fallback. Missing, unreadable, unverified, malformed and GitHub noreply
addresses refuse login. No synthetic address is created. Returning users, admins
and allowlisted users follow the same rule. Existing synthetic emails are replaced
on successful GitHub login (unless Feishu owns the linked account's profile).
GitHub grant-time checks retain the existing organization TTL/stale policy; email
is checked afresh on login.

## Merging duplicate identities

Connecting an identity already owned by another account offers a confirmation
when one account is GitHub-only and the other is Feishu-only. The callback must
pass the provider's email/admission checks and prove the second identity; the
original browser session must be at most ten minutes old and not impersonated.
A server-side proof expires after ten minutes and is bound to that exact session.
`GET /auth/identity-merge` previews it, `POST` confirms its ID and `DELETE` cancels.
Mutations require the exact public Origin and browser cookie; bearer tokens do
not authorize merges. Matching emails never authorize a merge.

At most one account may have application history (issued tokens, consent or owned
OAuth clients). That account keeps its ID; otherwise the older account does.
If both have history, an operator must migrate application data first; the auth
service cannot rewrite another service's subjects. Historical audit rows count
even after tokens or consents are removed. An audited first-use marker, locked
against the user row before token issuance, prevents a concurrent grant from
making an apparently unused account unsafe to retire. Usage changes after the
preview that alter the survivor require a new proof and review.

Confirmation rechecks and locks both users and identities in one transaction.
It moves the unused account's identity, preserves administrator access from
either account and uses Feishu's profile. The duplicate becomes a permanently
disabled `mergedInto` tombstone with identity fields cleared and a reserved
`@merged.invalid` email (never a login address); it cannot be re-enabled. Audit
history is retained and `identity.merged` is committed in the same transaction.
All browser sessions and refresh tokens for both users are revoked. Previously
issued JWTs can remain valid at resource servers for up to fifteen minutes;
the retired account never had an application token. Users must sign in again;
the web flow preserves the original signed OAuth continuation.
