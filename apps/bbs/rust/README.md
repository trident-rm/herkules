# BBS Rust service

Incremental BBS migration to Rust, Askama SSR and Vite-built static assets. The existing Hono application remains the deployed application. See the [migration sequence](../MIGRATION.md) for scope and cutover gates.

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

`BBS_RUST_LISTEN` defaults to `127.0.0.1:3203`. `BBS_RUST_DB_CONNECTIONS` defaults to 2 and accepts 1–10. Connections use read-only transactions, a five-second statement timeout and five-second acquisition timeout. For deployment, use a database role granted only corpus SELECT privileges. `RUST_LOG` controls tracing. SIGINT and SIGTERM initiate graceful shutdown.

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

Corpus reads are anonymous, matching the existing application. This process has no login, session, membership or authenticated MCP implementation. Keep it on loopback or the private service network during this increment. The reader now includes a sticky desktop sidebar with a table of contents, AI overview, specifications and resources. On narrow screens, anchor controls reach the same sections; specifications use native disclosures. The React mobile sheet, lightbox and active-heading indicator are still pending, along with feed/search/knowledge-base SSR and account pages. See the [frontend direction](../MIGRATION.md#frontend-direction) for the React widget plan.

Askama escapes metadata and plain-text fallback bodies. Only stored `content_html` is rendered as HTML: the existing corpus writer owns sanitization. The page sets a script-free CSP, `no-store`, `nosniff` and `no-referrer`.

## Delegate existing API and MCP reads

Set this in the **existing Node BBS service** environment and restart it:

```sh
BBS_RUST_READ_ORIGIN=http://127.0.0.1:3203
```

Both services must point at the same Postgres corpus. The `Library` adapter delegates all twelve corpus read methods, including both head metadata methods. Node still owns API validation and presentation, OAuth/session checks, MCP transport and token validation, admission, article-refresh hooks, migrations, crawler and bot. Delegation requires `SEARCH_INDEX=trgm`; both Node configuration and Rust startup reject another search index. It sends no browser cookies or bearer tokens to Rust. Upstream errors fail the request; they do not silently switch back to Node. Remove the variable and restart Node to restore all original reads.

This option does not change browser page routing: open the Rust port directly for the SSR preview. Do not replace the production `/articles/*` routes yet, because navigation and reader interaction parity are incomplete.

## Feed contract

`GET /api/articles` accepts the existing `q`, `scope=all|title|kb`, `tag`, `group`,
`cursor` and `limit` parameters. Limits default to 20 (`0` also means default)
and cap at 100. Queries use the existing folded `article_search` and `kb_search`
documents, AND at most eight literal substring terms, and keep date order.
Cursors use the same base64url JSON tuple as Node, so pages can cross the adapter
boundary. Invalid cursors preserve the `invalid_cursor` 400 envelope. Every read
filters out non-fetched articles. The browser feed route is not implemented yet.

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

The parity task builds web assets and Rust, creates a uniquely named database, runs the existing migration and fixture loader, compares both implementations on the same rows, checks rendered HTML and CSS, stops Rust, and drops only its own database. It does not use the existing corpus database. CI runs parity against Postgres 18; `vp run ready` includes Rust formatting, Clippy and unit tests plus the existing JavaScript checks.
