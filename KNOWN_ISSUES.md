# Known issues

The backlog of real defects and design gaps found by a codebase-wide review, kept
here so they are not rediscovered. Every entry names the file, what is wrong, why it
matters, and the shape of the fix. Entries are grouped by workspace and ordered
best-first inside each group.

**Confidence is labelled honestly.** `confirmed` means the mechanism was checked
against the installed dependency or reproduced against the real code. `reported`
means the mechanism is clearly real in the source but the consequence was not
exercised end to end. Nothing here is a guess about intent: where the current
behaviour looks deliberate, the entry says so and proposes a documentation change
rather than a code change.

Line numbers are anchors to help you find the code, not contracts. They were correct
at the time of the review and will drift.

This file is not a substitute for the decision records: binding behaviour lives in
each workspace's `README.md` and in [`docs/`](docs/README.md).

## What is already fixed

- Application Actions are pinned to commit hashes and watched by Dependabot.
  This does not claim that infrastructure workflow pins have been updated.
- Documentation-only application changes skip image publication; application CI
  no longer performs production deployment after the infrastructure extraction.

- OAuth client-management mutations are disabled; DCR and the audited application
  routes remain the supported surfaces. The authenticated endpoint regression test
  also verifies the normal consent and refresh flow remains available.
- Login continuations reject backslashes and whitespace (fixed during Feishu work);
  explicit redirect regression tests now cover those browser-normalization cases.

Recorded so the same ground is not re-covered. Each of these shipped with a
regression test.

- `apps/bbs/src/spa/static.ts` — a missing `/assets/*` or `/fonts/*` fell through to
  the SPA shell and was stamped `immutable` for a year, pinning an HTML body under a
  hashed `.js` URL. Now a JSON 404.
- `apps/bbs/src/spa/head.ts` — `/kb/%` (undecodable) returned 200 with the site's own
  metadata; now 404. Description truncation is code-point aware.
- `apps/bbs/src/bot/present.ts`, `apps/bbs/src/library/articles.ts` — card and
  excerpt truncation could split a surrogate pair (U+FFFD in output). Both now use
  `truncateChars`.
- `packages/oauth-client/src/session.ts` — the cookie CSRF guard rejected only
  `Sec-Fetch-Site: cross-site`, which `SameSite=Lax` already covers, and admitted
  `same-site`, which it does not. Now allow-lists `same-origin`.
- `packages/ui/src/theme.css`, `components/skeleton.tsx` — `accent-foreground` was
  `--ink` against the brand-green `accent` (unreadable hover text); `Skeleton` pulsed
  brand green. Both corrected.
- `services/auth/src/config.ts` — an `http://` `PUBLIC_ORIGIN` in production now
  fails at boot instead of silently looping the login; a misattached `BBS_ORIGIN`
  JSDoc was moved to its own field.
- `services/auth/src/audit.ts`, `app.ts` — a malformed `cursor` returned 500; now 400
  via `CursorError`.
- Dead code removed: `UsersDeps.auth`, `testing.ts`'s unused `jar` helper.
- `vite.config.ts` — `.direnv/` was being linted (~285 findings that buried the real
  ones). Excluded via `lint.ignorePatterns`/`fmt.ignorePatterns`.
- `.dockerignore` — `.terraform`, `*.tfstate*`, `.wrangler`, `.direnv` were shipped
  into every image build (~490 MB locally, and a local state file could reach a
  layer). `image-targets.mjs` now treats `.dockerignore` as a build input.
- `package.json` — `test:deploy` now runs the Cloudflare route/rollback tests, so
  `vp run ready` matches CI.
- Doc drift: five references to a non-existent `apps/bbs/DESIGN.md`; the auth
  README's account of the self-demote/self-disable ordering; the Terraform README's
  token-permission list (missing `SSL and Certificates`) and test-file count.

---

## Security and authorization

### 2. Last-admin guard is a TOCTOU race

- **Where**: `services/auth/src/users.ts:251`, `:276`;
  `services/auth/src/db/index.ts` (`countActiveAdmins`)
- **Confidence**: confirmed in the source; not reproducible under PGlite (single
  connection), so it needs Postgres to exercise
- **What**: `mustLock` takes `SELECT … FOR UPDATE` on the target row, but
  `countActiveAdmins()` is a plain `count()` that locks nothing. Two admins
  concurrently demoting or disabling each other each read `count = 2` (the other's
  change is uncommitted) and both commit, leaving zero active admins. The README's
  guarantee holds only serially.
- **Fix**: serialize the guard. Either take a transaction-scoped advisory lock at the
  top of `setRole`/`setDisabled`, or replace `countActiveAdmins()` inside the
  transaction with `SELECT id FROM user WHERE role='admin' AND banned IS NOT TRUE
ORDER BY id FOR UPDATE` and count those rows so a concurrent transaction blocks and
  re-reads after commit.

### 3. `resourceMetadataUrl` is unvalidated; a control character turns every 401 into a 500

- **Where**: `packages/auth-middleware/src/index.ts:146` (option declared at `:51`),
  throw site `packages/auth-middleware/src/challenge.ts` (`quoteAuthParam`)
- **Confidence**: confirmed
- **What**: unlike `resource`, the `resourceMetadataUrl` override is stored raw and
  must survive a re-encoding step. `renderFailure` → `challengeHeader` →
  `quoteAuthParam` throws `TypeError` on any C0/DEL character, so one stray byte in an
  environment value makes every unauthenticated request a 500 and the RFC 9728
  challenge — the point of the package — never renders. A non-URL value silently emits
  a challenge clients cannot resolve.
- **Fix**: at boot, parse the resolved value with `new URL`, require http(s), reject
  control characters, and throw a `TypeError` naming the option.

### 4. Issuer with a trailing slash fetches keys fine but rejects every token

- **Where**: `packages/auth-middleware/src/index.ts:144` (issuer passed to jose
  verbatim) vs `packages/auth-middleware/src/resource.ts` (`jwksUrlFor` strips trailing
  slashes)
- **Confidence**: confirmed
- **What**: `issuer: "https://x/auth/"` fetches `https://x/auth/jwks` but requires
  `iss === "https://x/auth/"`, so every token fails `invalid_token`/`wrong_issuer` with
  no hint that the config string is the cause. `resource` is strictly validated at
  boot; `issuer` is not.
- **Fix**: validate `issuer` once in `createResourceAuth` and reject a trailing slash,
  or normalize the single value used for both `iss` and `jwksUrlFor`.

### 5. `classify()` reports unrecognised errors as a JWKS outage

- **Where**: `packages/auth-middleware/src/verify.ts` (terminal branch of `classify`)
- **Confidence**: reported
- **What**: the catch-all maps anything unrecognised to `jwks_unavailable` (503 +
  `Retry-After`). That swallows jose's own claim-set `TypeError`s, any future jose
  error class, and bugs in this package — reporting "authorization keys unavailable,
  retry" for what is a rejected token, and sending the client into a retry loop.
  Exploitation needs an issuer-signed malformed claim, so this is diagnosis rather than
  a live hole.
- **Fix**: tag the transport wrapper so only marked transport rejections (plus
  `JWKSTimeout`/`JWKSInvalid`) become `jwks_unavailable`, and map everything else to
  `invalid("malformed")`. Test both directions: mis-tagging would render 401 during a
  real outage, which `docs/tokens.md` forbids.

### 7. Avatar responses echo an unvalidated `Content-Type` and lack `nosniff`

- **Where**: `services/auth/src/avatars.ts:102`, `services/auth/src/github.ts`
- **Confidence**: reported
- **What**: GitHub's `content-type` is reflected verbatim on a response served from the
  issuer origin, with no allowlist and no `X-Content-Type-Options: nosniff`. `image` is
  not attacker-controlled today, but this is the one place a non-image body could be
  rendered as active content on the issuer origin.
- **Fix**: store only `image/*` in `avatars.refresh` (falling back to `image/png`) and
  add `nosniff` plus a restrictive CSP to `serve`. Decide deliberately whether to admit
  `image/svg+xml`.

### 8. CIMD client-creation audit is fail-open

- **Where**: `services/auth/src/auth.ts` (`onClientCreated`)
- **Confidence**: reported (only reachable with `CIMD_ENABLED=true`, off in production)
- **What**: the CIMD plugin wraps the `onClientCreated` callback in try/catch and only
  logs, so a failed audit insert does not fail client creation — contradicting the audit
  module's fail-closed invariant.
- **Fix**: record the row inside the plugin's own transaction if it exposes such a hook;
  otherwise reconcile CIMD registrations from the `/oauth2/authorize` path. At minimum,
  document that CIMD audit is best-effort.

---

## `services/web`

### 18. One failed session fetch is cached as "signed out" for the life of the tab

- **Where**: `services/web/src/session.tsx:27` (with `main.tsx` and `session.tsx:39`)
- **Confidence**: confirmed
- **What**: `queryFn: () => api.session().catch(() => null)` converts _every_ failure —
  network error, 502 from the proxy during a deploy, 5xx — into a successful `null`.
  Combined with `staleTime: Infinity`, global `retry: false` and
  `refetchOnWindowFocus: false`, that `null` is cached permanently: every authed route
  redirects to `/login`, the shell offers "Sign in", and nothing rechecks until a full
  reload. A transient blip becomes a sticky, unexplained sign-out. `Consent.tsx` bounces
  a signed-in user the same way.
- **Fix**: map only the deliberate "not a session" case to `null` and let real transport
  errors surface (`if (e instanceof ApiError && e.code === "invalid_response") return
null; throw e;`), then redirect only on a settled `null`. This needs a
  `defaultErrorComponent` (see #23) to be useful.

### 19. Sign-out fails silently and can be double-clicked

- **Where**: `services/web/src/shell.tsx:16` (button at `:63`)
- **Confidence**: confirmed
- **What**: `signOut()` awaits `api.signOut()` then navigates, with no `try/catch` and no
  pending state. If the POST rejects the rejection is unhandled: no message, no
  navigation, the user is still signed in, and a second click fires a second request.
  Every other mutation in the app goes through `useMutation` + `ErrorNotice`.
- **Fix**: use `useMutation`, render `ErrorNotice`, and disable the button while pending.

### 20. `loginErrorMessage` renders attacker-supplied text as the service's words

- **Where**: `services/web/src/pages/Login.tsx:19`, `services/web/src/format.ts:16`
- **Confidence**: reported
- **What**: the refusal notice prefers `error_description` from the query string. Anyone
  can send `https://herkules.dev/login?error=access_denied&error_description=<any text>`
  and have it rendered inside the real login card above a real "Continue with GitHub"
  button. React escapes it, so this is social engineering rather than XSS.
- **Fix**: render only the SPA's own copy for known `error` codes (extend the `REASONS`
  table), ignore `error_description` otherwise, and truncate.

### 21. The token endpoint's response is never validated

- **Where**: `services/web/src/api.ts` (`token()`), consumer `pages/DevToken.tsx`
- **Confidence**: reported
- **What**: `session()` validates every field; `token()` returns the parsed body
  unchecked. A `200 {}` (misconfigured proxy, partial outage, future shape change) makes
  `decodeJwtPayload(undefined)` throw during render and renders the literal `undefined`
  into the copyable `curl` string.
- **Fix**: validate `access_token`/`token_type` and return the existing
  `invalid_response` outcome, which already has a UI branch.

### 22. The PKCE pending record is destroyed before the exchange

- **Where**: `services/web/src/devtoken.ts:76`, `pages/DevToken.tsx:95`
- **Confidence**: confirmed
- **What**: `storage.removeItem(KEY)` runs _before_ `api.token()`. If the exchange fails
  the verifier is gone, so retrying or refreshing can only yield `invalid_state` and the
  user must restart from `/dev-token`. The `exchange.error` branch also omits the "Start
  again" link that the other failure branch has, making it a dead end.
- **Fix**: remove the pending record only after a successful exchange (or a terminal
  `invalid_grant`), and render "Start again" in both failure branches. The replay test
  still holds because the first call consumes the record on success.

### 23. No `pendingComponent`/`errorComponent`, so deep links render blank

- **Where**: `services/web/src/routes.tsx:155`
- **Confidence**: confirmed
- **What**: `defaultPendingMs`/`defaultPendingMinMs` are configured but
  `defaultPendingComponent` is never supplied, and TanStack Router's `renderPending`
  returns `null` when neither the route nor the router defines one — so the thresholds
  have no effect. A cold deep link to `/settings` awaits the session fetch with an empty
  viewport. There is also no `defaultErrorComponent`, so the moment any `beforeLoad`
  legitimately throws (see #18) the user gets the library's bare error UI.
- **Fix**: `defaultPendingComponent: () => <Loading />` and a small
  `defaultErrorComponent` wrapping the existing `Notice`.

### 24. Shared mutation state in the admin pages loses per-row busy state

- **Where**: `services/web/src/pages/AdminUsers.tsx:50`, `pages/Settings.tsx:27`
- **Confidence**: confirmed
- **What**: one `useMutation` per page with `busyId` derived from `act.variables.id`,
  which only ever holds the _latest_ call. Starting an action on one row re-enables
  another row's buttons while its request is still in flight, and the first failure's
  error is overwritten by the second's. Server-enforced and audited, so this is a
  UI-truthfulness bug rather than a privilege one.
- **Fix**: track in-flight ids explicitly (`onMutate`/`onSettled` with a `Set`) and
  disable per row; include the failed row's name in the message.

### 25. `auditGroup()` and its `data-group` attribute have no consumer

- **Where**: `services/web/src/format.ts:71`, `pages/AdminAudit.tsx:103`
- **Confidence**: confirmed (nothing in the repo reads it)
- **What**: a per-row function call and an exported union kept alive for nothing.
- **Fix**: delete both. Fold the nearly identical five-line loading/error gate repeated
  in the four data pages into one `<Async>` helper in `layout.tsx` while you are there.

### 26. Accessibility cluster in `services/web`

- **Where**: `layout.tsx:27` (`Loading`), `pages/Consent.tsx:71`, `pages/Home.tsx:58`,
  `pages/AdminUsers.tsx:131`
- **Confidence**: confirmed mechanisms
- **What**: four separate, small, real problems. `Loading` is a bare `<p>` with no live
  region, so every async transition in the app is silent to assistive tech.
  `Consent.tsx` puts `aria-label` on a role-less `div`, which drops the name, and the
  client→resource relationship is carried only by layout. `Home.tsx` has no `<h1>` (the
  outline starts at `h2`), so heading navigation lands mid-page. Your own admin row
  renders permanently disabled buttons whose only explanation is `title`, which is not
  exposed on focus or touch.
- **Fix**: `role="status" aria-live="polite"` on `Loading`; `role="group"` or a `<dl>`
  plus one visually-hidden sentence in `Consent`; promote the brand to `<h1>`; replace
  the self-row buttons with a visible sentence (the rule is enforced server-side anyway,
  so the disabled controls are redundant decoration).

---

## `apps/bbs`

### 27. The bot heartbeat has no deployment monitor

- **Where**: `apps/bbs/src/library/status.ts:66` (crawler),
  `apps/bbs/src/bot/store.ts:295` (`last_reconciled_at`), `tools/deploy/gatus.yaml`
- **Confidence**: confirmed
- **What**: `bot_state.last_reconciled_at` is refreshed every 30 s by `reconcile()` but
  now exposed in `/api/status`, but the deployment has no bot freshness monitor.
  The bot container has no port and no real healthcheck. A bot stuck
  in a crash loop (for example the announcement-chat mismatch that throws on every boot,
  with `restart: unless-stopped`) is indistinguishable from "no new posts"; the only
  symptom is silence. `/api/status` already carries `crawler.lastCheckedAgeSeconds` for
  exactly this purpose, and gatus watches it.
- **Fix**: the Node and Rust status adapters now expose `bot: { lastReconciledAt,
lastReconciledAgeSeconds }` from the one-row table. Add an infrastructure Gatus
  row mirroring the crawler freshness check; keep this entry until it is deployed.

---

## Rust Feishu transport

### 49. SDK fragment reassembly lacks an aggregate resource cap

- **Where**: `packages/feishu-rust/src/lib.rs` WebSocket wrapper; pinned SDK 0.3.12
  `ws.rs` `FragEntry::new` and `WsFrameHandler::event_payload`
- **Confidence**: confirmed in the published dependency source
- **What**: Herkules bounds individual WebSocket frames/messages at 1 MiB. The SDK
  expires incomplete fragment entries after five seconds but allocates its fragment
  vector from the advertised count and has no aggregate count/byte cap. A malformed
  gateway frame or many concurrent incomplete events can exceed the intended
  low-memory budget before expiry. This is the provider channel, not a public
  application WebSocket endpoint.
- **Fix**: add count/byte limits in the upstream SDK or a bounded Herkules fragment
  adapter, with malformed-count and incomplete-fragment load fixtures. Keep the SDK
  pinned until a tested fix is available.

---

## `packages/ui`

### 31. The token package has no tests, and it is where the bugs were

- **Where**: `packages/ui/package.json` (`scripts` has no `test`); root `ready` runs
  `vp run -r test`
- **Confidence**: confirmed
- **What**: `vp run -r test` silently skips `@herkules/ui` — the package with the highest
  blast radius, since one cascade feeds both SPAs. The two token-mapping defects fixed in
  this pass (`accent-foreground`, `Skeleton`) were exactly the kind a five-line test
  catches.
- **Fix**: add `"test": "vp test"` and assert that (a) every `--color-*` in the
  `@theme inline` block resolves to a runtime token defined in `:root`, and (b) the pairs
  components actually use (`accent`/`accent-foreground`,
  `primary`/`primary-foreground`, `destructive`/`-foreground`,
  `secondary`/`-foreground`) keep adequate contrast, via a small relative-luminance
  helper.

### 32. `text-muted` paints a background colour

- **Where**: `packages/ui/src/theme.css` (`--color-muted: var(--surface-2)`)
- **Confidence**: confirmed
- **What**: the herkules token named `muted` is a _text_ grey, but Tailwind's `muted`
  colour is bound to a near-white surface, so the class an author naturally writes for
  grey text renders near-white text in light mode. The comment acknowledges the split;
  the class name still lies.
- **Fix**: rename the runtime text token (for example `--ink-3`) and expose
  `--color-ink-3` alongside `--color-muted: var(--surface-2)`. Touches app CSS, so the
  cheap alternative is documentation plus a lint rule banning `text-muted`.

### 33. `components.json` aliases point at exports that do not exist

- **Where**: `packages/ui/components.json` vs `packages/ui/package.json` `exports`
- **Confidence**: confirmed
- **What**: the README tells contributors to add components with the shadcn CLI. Any
  component importing a hook is generated as `@herkules/ui/hooks/...` and a bare
  `@herkules/ui/lib` is equally unresolvable; neither has an `exports` entry, so the next
  `vp check` fails on generated code with an error naming shadcn's output rather than the
  config.
- **Fix**: add `"./hooks/*"` (and `"./lib"`) to `exports`, or remove those aliases from
  `components.json`.

---

## Deployment, CI and infrastructure

Entries referencing `tools/deploy` now belong to the private `herkules-infra`
repository. They are retained here as the historical review record, not a claim
that these files still live in the application checkout.

### 34. `apply-release.sh` reports a failed rollback as a successful one

- **Where**: `tools/deploy/apply-release.sh:139` (`restore_previous`), `:52` (`finish`)
- **Confidence**: confirmed
- **What**: every recovery step is error-suppressed (`compose pull --quiet || true` at
  `:154`, `compose up … || true` at `:155`, `--force-recreate … || true` at `:159`) and
  `finish` exits with the _original_ failure status. Nothing re-checks the restored
  release. A restore that itself fails leaves production on the broken stack while the
  log, the exit code, and the GitHub status all read as a clean rollback — the worst-case
  deploy failure is the one a human must notice.
- **Fix**: accumulate failures in `restore_previous`, print an explicit "restore FAILED:
  production is on the failed release", and exit with a distinct code (3) when it fails;
  re-run the public `curl` probes after a successful restore as positive proof.

### 35. Archive-safety guards become no-ops when `tar` fails

- **Where**: `tools/deploy/apply-release.sh:75`, `:79` (`set -eu`, POSIX `sh`, no
  `pipefail`)
- **Confidence**: confirmed
- **What**: `tar … | grep -Eq …` tests only `grep`'s status, so on a truncated or corrupt
  archive `grep` sees partial input, returns 1, and the traversal and
  "regular-files-only" checks pass vacuously. `tar -xzf` is then the only thing that
  fails. `set -e` still stops the release today, so this is latent rather than
  exploitable — but the traversal guard must not depend on a later step failing.
- **Fix**: list once into a temp file with the exit status checked, then grep that file
  twice. One `tar` pass instead of two, and a clear "release archive is unreadable".

### 37. Base images that produce production artifacts are tag-pinned, not digest-pinned

- **Where**: `Dockerfile` (`node:24-alpine`, `caddy:2.10-alpine`, `rclone/rclone:1.72`,
  `alpine:3.23`); `tools/deploy/docker-compose.yml` (`postgres:17-alpine`, gatus, beszel)
- **Confidence**: confirmed
- **What**: four production images resolve `node`, `caddy`,
  `rclone` and `alpine` from moving tags on every rebuild. `postgres:17-alpine` moves
  within the major against a `pgdata` volume whose client is an unpinned `apk` package.
- **Fix**: resolve and pin the six bases to digests and
  add a `docker` Dependabot ecosystem so the pins keep moving. If digests are rejected, at
  minimum pin `postgres:17.<minor>-alpine`.

## `tools/ai` and tooling

### 45. `benchmarks/probe.py` discards a failed 128K attempt and writes results twice

- **Where**: `tools/ai/benchmarks/probe.py:39`
- **Confidence**: confirmed
- **What**: on an exception in the 131072-token iteration the handler only appends when
  `ctx == 65536`, so a model that fails at 128K but passes at 64K leaves no record of the
  failure — the outcome the benchmark exists to capture. A duplicated `write_text` two
  lines later is dead.
- **Fix**: append a per-context result in both branches; delete the duplicate write.

## Smaller, worth batching

- `apps/bbs/rust/src/http.rs` — native REST validation preserves status/error codes,
  but some malformed parameter descriptions are generic instead of the Node Zod
  diagnostic text. Align these descriptions before claiming exact error-body parity.

- `apps/bbs/web/src/feed/LoadMore.tsx:25` — a failed page re-arms the
  `IntersectionObserver` while the sentinel is still in view, so a persistent API failure
  becomes an unbounded request storm (2 requests per cycle with `retry: 1`), and the
  failure is silent. Guard the observer on `isError` and render a retry row.
- `apps/bbs/web/src/kb/KbPage.tsx:100` — the KB card query caps at 300 while the header
  prints the untruncated `total` from `count(*) OVER ()`, and the summary tallies are
  derived from the truncated array. Show `cards.length / total`, or compute tallies
  server-side.
- `apps/bbs/web/src/reader/ReaderSidebar.tsx:37`, `reader/Resources.tsx:40` — the reader's
  dock and expanded state survive navigation between articles, because the route component
  is not remounted when only `$id` changes. Key the stateful children on `article.id`.
- `apps/bbs/web/src/shell/AccountChip.tsx:16` — `data === undefined` conflates "loading"
  with "errored", so after a failed viewer query the header's only link to `/login`
  disappears for the rest of the session. Treat an error as anonymous.
- `apps/bbs/web/src/feed/ArticleRow.tsx:85` — the router-free tag-chip fallback exists only
  so the smoke test can render it, has already drifted from the production chips, and
  means the markup users actually see has no render coverage. Extract one `TagChips`.
- `apps/bbs/web/src/shell/ThemeToggle.tsx:15`, `shell/Skeletons.tsx:11` — the toggle's
  `aria-label` overrides the visible current-theme label, so assistive tech cannot read the
  state; `aria-label` on the skeleton `div`s is invalid on a `role=generic` element and is
  dropped. Fold the state into the label; use `role="status"` with real text.
- `apps/bbs/web/src/feed/SearchBar.tsx:61` — the `to` prop and its `to="/"` branch are dead
  (both call sites pass `/search`), inside a union wide enough that the compiler cannot
  flag it. Drop the prop.
- `apps/bbs/web/src/kb/EntitySectionsView.tsx:79` — the 其他参数 table has no `<th>`, so a
  screen reader gets unlabelled columns in the one place the page is about comparing
  numbers. Reuse the sibling table's `TableHeader`.
- `apps/bbs/src/bot/present.ts:74` and `spa/head.ts` — `clip`/`cutDescription` now delegate
  to `truncateChars`; `library/articles.ts` and `mcp/present.ts` were already correct. No
  action, listed only so the next reader does not re-audit them.
