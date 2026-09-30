# BBS Rust service

Incremental BBS migration to Rust, Askama SSR and Vite-built static assets. The `bbs-web` image runs only Rust and serves the existing Vite-built browser frontend alongside native REST/MCP/OAuth and the Askama reader. The existing `bbs` image remains the Node jobs/migration image and a compatible rollback target. See the [migration sequence](../MIGRATION.md) for scope and cutover gates.

## Run

From the repository root, with Rust installed:

```sh
vp install
vp run "@herkules/bbs#build"
: "${BBS_POSTGRES_URL:?Set BBS_POSTGRES_URL to your real, migrated Postgres corpus URL}"
DATABASE_URL="$BBS_POSTGRES_URL" \
APP_ORIGIN=http://localhost:3203 \
WEB_DIR="$PWD/apps/bbs/dist/client" \
cargo run -p herkules-bbs --locked
```

Use a corpus already migrated by the existing BBS service. Rust neither creates the database nor runs migrations. It supports Postgres, not PGlite. Without `WEB_DIR`, the SSR preview renders unstyled HTML; with it, startup requires a valid Vite manifest and SSR stylesheet. `APP_ORIGIN` controls canonical URLs and must be an HTTP(S) origin.

### Default local setup uses PGlite

The normal `apps/bbs/.env` config uses `pglite://…`. SQLx cannot connect to that database or open its data directory. Rust does not load `apps/bbs/.env` automatically either: use a real Postgres URL in the environment. A URL containing `user:password` is an example, not provisioned credentials.

If you already have a reachable Postgres corpus, set `BBS_POSTGRES_URL` to its actual connection URL and use the run command above. A Docker hostname such as `postgres` is usually reachable only inside its Docker network; a Rust process running on the host needs the published host port.

For a separate local database, with Docker running:

```sh
docker run -d --name herkules-bbs-rust-postgres \
  -p 127.0.0.1:5433:5432 \
  -e POSTGRES_USER=bbs -e POSTGRES_PASSWORD=local-preview \
  -e POSTGRES_DB=bbs postgres:18
export BBS_POSTGRES_URL='postgres://bbs:local-preview@127.0.0.1:5433/bbs'
# Repeat until the database reports that it accepts connections.
docker exec herkules-bbs-rust-postgres pg_isready -U bbs -d bbs
```

This creates a separate, initially empty database; it does not move the existing PGlite corpus. Apply the existing migrations from the BBS directory, using your configured `.env` for the other required settings:

```sh
(cd apps/bbs && DATABASE_URL="$BBS_POSTGRES_URL" \
  node --env-file=.env --experimental-strip-types src/main.ts migrate)
```

You can then run Rust against the empty migrated database. To populate this **new database**, explicitly run the existing importer with a compatible SQLite corpus:

```sh
(cd apps/bbs && DATABASE_URL="$BBS_POSTGRES_URL" \
  node --env-file=.env --experimental-strip-types src/main.ts import /absolute/path/to/app.db)
```

The importer replaces the target corpus. Keep this URL pointing to the separate preview database. Copying the PGlite directory into Postgres is not a supported migration path.

`PoolTimedOut` during startup means the connection pool could not establish a usable connection in time. Check the server, published port, credentials and database name before changing the pool size. Once connected, an `articles`-table error means the existing BBS migrations still need to run.

`BBS_RUST_LISTEN` defaults to `127.0.0.1:3203`. `BBS_RUST_DB_CONNECTIONS` defaults to 2 and accepts 1–10. Corpus connections use read-only transactions, a five-second statement timeout and five-second acquisition timeout. In adapter mode, use a database role granted only corpus SELECT privileges. Native mode also opens one writable connection for article refresh requests; grant UPDATE on `articles.refresh_requested_at` and `articles.updated_at`. `RUST_LOG` controls tracing. SIGINT and SIGTERM initiate graceful shutdown.

| Route                                                    | Behavior                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------- |
| `/api/articles`                                          | Date-ordered feed, tag/group/text filters and compatible keyset cursors |
| `/api/search`                                            | Ranked trgm search, highlight segments and compatible rank cursors      |
| `/api/kb/browse`                                         | KB cards and cross-filtered domain/robot/genre facets                   |
| `/api/kb/entities`                                       | Entity counts with literal name filtering                               |
| `/api/kb/entities/{name}`                                | Entity detail; optional `key` query preserves an already-normalized key |
| `/api/status`                                            | Corpus, AI, entity and crawler counts and dates                         |
| `/api/articles/{id}/head`                                | Lightweight article metadata for the existing Node head presenter       |
| `/api/kb/entities/{name}/head`                           | Entity metadata; optional `key` query as above                          |
| `/healthz`                                               | Database read readiness                                                 |
| `/api/articles/{id}`                                     | Existing article DTO, fetched rows only                                 |
| `/api/articles/{id}/content?format=text\|markdown\|html` | Existing content fallback and `X-Content-Format` contract               |
| `/api/articles/{id}/ai`                                  | Normalized overview, specifications, image captions and AI status       |
| `/api/tags`                                              | Existing tag/group counts and ordering                                  |
| `/articles/{id}`                                         | Askama article reader preview with full body and metadata               |
| `/assets/*`                                              | Vite build assets when `WEB_DIR` is set                                 |

Corpus reads are anonymous, matching the existing application. Without native authentication configuration, this process is a read adapter and SSR preview: MCP is unavailable and authenticated requests fail closed. Keep this mode on loopback or the private service network. The reader now includes a sticky desktop sidebar with a table of contents, AI overview, specifications and resources. On narrow screens, anchor controls reach the same sections; specifications use native disclosures. The React mobile sheet, lightbox and active-heading indicator are still pending, along with feed/search/knowledge-base SSR and account pages. See the [frontend direction](../MIGRATION.md#frontend-direction) for the React widget plan.

Askama escapes metadata and plain-text fallback bodies. Only stored `content_html` is rendered as HTML: the existing corpus writer owns sanitization. The page sets a script-free CSP, `no-store`, `nosniff` and `no-referrer`.

## Delegate existing API and MCP reads

Set this in the **existing Node BBS service** environment and restart it:

```sh
BBS_RUST_READ_ORIGIN=http://127.0.0.1:3203
```

Both services must point at the same Postgres corpus. The entity and entity-head adapter query keys work in both anonymous and native-auth Rust modes; already-normalized keys are preserved exactly, including Unicode lowercase expansions. The `Library` adapter delegates all twelve corpus read methods, including both head metadata methods. Node still owns API validation and presentation, OAuth/session checks, MCP transport and token validation, admission, article-refresh hooks, migrations, crawler and bot. Delegation requires `SEARCH_INDEX=trgm`; both Node configuration and Rust startup reject another search index. It sends no browser cookies or bearer tokens to Rust. Upstream errors fail the request; they do not silently switch back to Node. Remove the variable and restart Node to restore all original reads.

This option does not change browser page routing: open the Rust port directly for the SSR preview. Do not replace the production `/articles/*` routes yet, because navigation and reader interaction parity are incomplete.

## Native REST, MCP and browser OAuth

Token verification and OAuth/session handling live in the shared [`herkules-auth` crate](../../../packages/auth-rust/README.md). BBS configures its client/audiences and owns routes, admission and viewer presentation.

Set `PUBLIC_ORIGIN` to enable native BBS authentication and MCP. This is the platform identity origin, such as `https://herkules.dev`, not the BBS origin. Set `APP_ORIGIN` to the BBS browser origin. Rust derives the issuer `/auth`, API audience `/api/bbs` and MCP audience `/mcp/bbs` from `PUBLIC_ORIGIN`. Optional `AUTH_INTERNAL_URL` changes the origin used for server-to-server requests, preserving the public issuer and audiences.

```sh
: "${PUBLIC_ORIGIN:?Set the identity platform origin}"
: "${BBS_CLIENT_SECRET:?Set the existing confidential bbs OAuth client secret}"
: "${BBS_COOKIE_SECRET:?Set the existing BBS cookie encryption secret}"
export PUBLIC_ORIGIN BBS_CLIENT_SECRET BBS_COOKIE_SECRET
DATABASE_URL="$BBS_POSTGRES_URL" APP_ORIGIN=http://localhost:3203 \
WEB_DIR="$PWD/apps/bbs/dist/client" cargo run -p herkules-bbs --locked
```

Both secrets require at least 32 characters. Register the exact `APP_ORIGIN/callback` redirect with the existing `bbs` OAuth client before testing another port. Rust does not load `.env` files. Do not inherit auth variables when intentionally running the anonymous read adapter.

Native mode serves `/api/viewer`, guarded `/api/me`, `/login`, `/callback`, POST-only `/logout`, authenticated Streamable HTTP `/mcp/bbs` and public `/mcp/bbs/healthz`. The official Rust MCP SDK handles transport negotiation; all ten existing tools and three resource templates preserve the Node metadata and presenters. Bearer tokens use Ed25519 signatures, strict issuer/audience/claim checks and bounded JWKS caching. API and MCP audiences are separate; an explicit invalid bearer never falls back to a cookie. MCP requires bearer authentication and does not use browser cookies.

Browser login uses the existing confidential client with PKCE, encrypted multi-attempt state, safe return paths, encrypted session cookies and refresh-token rotation. Cookie format and keys match Node, allowing compatible sessions during a staged switch. Concurrent refreshes share an in-flight request; successful rotations are retained briefly for other tabs. Logout clears both cookies and attempts issuer revocation. User profile lookup stays with the existing identity service. Better Auth remains TypeScript; Rust is its OAuth client and resource server.

Native article reads retain the existing best-effort stale-article refresh request. MCP article reads remain read-only. No schema, crawler, AI worker or bot ownership moves in this increment.

### Rust-only web image

Build the serving image with `docker build --target bbs-web -t herkules-bbs-web .`.
It contains the static musl Rust binary, CA certificates and Vite's `dist/client`,
with a nonroot Rust process as PID 1. It contains no Node runtime or node_modules.
`BBS_RUST_LISTEN` defaults to `0.0.0.0:3003` **in this image**; the standalone
binary retains its loopback preview default. Use the existing database/auth
variables above. `/healthz` checks database readiness, and SIGTERM stops Rust
gracefully. Vite and Node run only in the build stages.

With `WEB_DIR`, Rust validates and loads the SPA document at startup, serves
`/assets/*` with immutable caching, and public fonts/favicon/robots with one-hour
caching. Missing assets never fall through to HTML. Browser feed/search/KB/tags/
status/account routes use the existing React SPA document with `no-cache`; KB
entity routes retain escaped metadata and unknown-entity 404s. Article documents
continue to use Askama. This removes the frontend server runtime without claiming
complete feed/KB SSR migration.

Before starting Rust, run the existing Node image's `migrate` command as a separate
one-shot preparation job. It applies the authoritative Drizzle history and
rederives stale corpus data, then exits. Start Rust only after that job succeeds;
keep workers and the bot on the Node `bbs` image. Production Compose and immutable
release selection live in `herkules-infra`; the coordinated infrastructure change
adds a preparation dependency and selects the separately published `bbs-web` digest.

The existing `bbs` image still supports supervised hybrid serving and all commands.
Set `BBS_RUST_NATIVE=false` and unset `BBS_RUST_READ_ORIGIN` for its original Node
implementation. Rolling back the complete immutable infrastructure release restores
the previous image/configuration tuple; database migrations are not reversed.
Invalid REST parameter responses preserve status/error codes, but some validation
descriptions remain generic instead of the Node Zod diagnostic text.

MCP metadata is generated from the Node contract; regenerate it from `apps/bbs` after intentional tool contract changes:

```sh
node --experimental-strip-types scripts/rust-mcp-contract.ts
vp check --fix
```

## Feed contract

`GET /api/articles` accepts the existing `q`, `scope=all|title|kb`, `tag`, `group`,
`cursor` and `limit` parameters. Limits default to 20 (`0` also means default)
and cap at 100. Queries use the existing folded `article_search` and `kb_search`
documents, AND at most eight literal substring terms, and keep date order.
Cursors use the same base64url JSON tuple as Node, so pages can cross the adapter
boundary. Invalid cursors preserve the `invalid_cursor` 400 envelope. Every read
filters out non-fetched articles. The browser feed is served as the existing Vite SPA; Askama feed rendering remains pending.

## Ranked search and KB contracts

Ranked search uses the existing trgm substring recall and BM25-shaped ranking,
with the same twelve-significant-digit constants and `(score, id)` cursor.
It performs two queries: corpus statistics, then the bounded page. Snippets
choose the window covering the most distinct terms, preserve original case and
width, merge overlapping hits, and use UTF-16 offsets without cutting a surrogate
pair at the window edges. Empty parsed terms preserve `empty_query`.

KB browsing performs two queries: limited cards with total, then all three
facet axes. Each axis counts under the other two filters and the query, leaving
its own choices available. Scalar AI values become empty arrays as in Node.
Entities, entity/article heads and status each use one query. Status freshness is
computed at response time; requests compared across processes can differ by a
second. Entity heads hide orphaned entities while entity detail preserves their
header, matching the existing library.

These are fixture-based correctness checks, not production performance results.
Representative query plans and release-build resource measurements remain cutover
gates. The existing KB card limit behavior is preserved, including the UI gap
recorded in `KNOWN_ISSUES.md`.

## Verify

```sh
vp run check:rust
vp run test:rust
# A disposable Postgres server; this account needs CREATEDB.
BBS_RUST_TEST_POSTGRES=postgres://bbs_test:password@localhost/postgres \
vp run "@herkules/bbs#test:rust:parity"
```

The parity task builds web assets and Rust, creates a uniquely named database, runs the existing migration and fixture loader, compares both implementations on the same rows, checks rendered HTML and CSS, native REST/MCP contracts, cookie interoperability, concurrency/outage behavior, and login/refresh/revocation against a disposable real Better Auth issuer with fake GitHub; stops Rust, and drops only its own database. It does not use the existing corpus database. CI runs parity against Postgres 18; `vp run ready` includes Rust formatting, Clippy and unit tests plus the existing JavaScript checks.

CI also builds both actual release images and runs `sh tools/images/bbs-web.test.sh`
against a disposable Postgres container. It checks preparation, health, browser
assets/API, the absence of Node, nonroot Rust PID 1 and graceful shutdown. Run it
locally after building image tags `herkules-bbs-jobs:test` (`bbs`) and
`herkules-bbs-web:test` (`bbs-web`), or override `BBS_JOBS_TEST_IMAGE` and
`BBS_WEB_TEST_IMAGE`.
