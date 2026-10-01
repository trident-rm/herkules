# RM 文库

`@herkules/bbs` is the archive and search application at `https://bbs.herkules.dev`.
The production `bbs-web` image runs Rust Axum for the API, MCP, browser OAuth,
Askama article reader and Vite-built React assets. It stores the corpus in its
own Postgres database. The crawler now has a Rust `work` command in the same
image; the Node `bbs` image retains the crawler for rollback and owns migrations,
import/rederivation and a bot rollback target. Production worker selection is coordinated
in `herkules-infra`.

The Node `bbs` image also retains supervised Rust/Hono hybrid serving for rollback.
Rust implements the crawler and its transactional corpus writer, with fixture
parity checks; production worker cutover requires the matching infrastructure
image promotion. Complete SSR navigation and import/rederivation remain pending; the Rust bot
implementation awaits its separate production image switch. See the [migration sequence](MIGRATION.md) and
[Rust run/test instructions](rust/README.md). Better Auth remains the identity
service.

The web UI has its own README, owned separately: [`web/README.md`](web/README.md).

## Run and test

Copy `.env.example` to `.env`, then:

```sh
vp run dev
vp run dev:web
vp run export <directory>
vp test
vp check
vp run build
```

The config default is port 3003. The checked-in `.env.example` sets Hono to 3103 so the SPA dev server can own port 3003 and proxy through `web/vite.config.ts`. One image, six commands, dispatched in `src/main.ts`: serve (the default), `migrate`, `work [--once]`, `bot`, `rederive`, and `import`, the deprecated cutover tool and dev loader. Deployment, worker startup, bot setup, import, cutover, and backup commands live in [`../../tools/deploy/README.md`](https://github.com/trident-rm/herkules-infra/blob/main/tools/deploy/README.md).

## Exporting the public archive

[`scripts/export.mjs`](scripts/export.mjs) is a standalone Node 22+ script. It uses only Node built-ins and the anonymous REST API, so it can be copied out of this repository and needs no BBS database, `.env` file, package install, or authentication. It writes one JSON file per article, including its AI record and local image mapping, plus `manifest.json`, `tags.json`, `status.json`, and deduplicated image files. The default source is `https://bbs.herkules.dev`.

```sh
node scripts/export.mjs ./bbs-export
node scripts/export.mjs ./bbs-export --origin http://localhost:3103 --concurrency 8
# Inside this workspace, the shorter equivalent is:
vp run export ./bbs-export
```

Rerun the same directory to resume an interrupted export. The command refreshes JSON and reuses completed image files. It records failed articles and images in `manifest.json` and exits 1 until a later run completes them.

## Feishu bot

The Rust image supports `herkules-bbs bot`; production still selects the Node
bot until the infrastructure switch. [Rust migration gates](BOT_MIGRATION.md)
record parity and cutover requirements. Both runtimes use the same Postgres tables,
lock and persisted delivery UUIDs.

`bbs bot` connects an internal self-built Feishu app through a WebSocket long connection. It has
no public callback route. Replies are interactive cards (card schema 2.0); the command table in
`src/bot/command.ts` is what `/help` renders and what the bot menu resolves against:

| Command           | Aliases                      | Result                                                    |
| ----------------- | ---------------------------- | --------------------------------------------------------- |
| `/search <terms>` | `/s`, bare `搜索` / `search` | Ranked full-text search, five hits per page with snippets |
| `/title <terms>`  | `/t`, `/标题`                | Same, titles only                                         |
| `/kb <terms>`     | `/知识库`                    | Same, knowledge-base entries                              |
| `/latest`         | `/new`, `/最新`              | The five most recent articles                             |
| `/status`         | `/状态`                      | Corpus and AI counts                                      |
| `/help`           | `/h`, bare `help` / `帮助`   | The command list                                          |

In groups, mention the bot and send a command. In a direct message, ordinary text is a full-text
search. Unknown `/commands` get an error card that points at `/help`. Search cards carry
`上一页`/`下一页` buttons: a click arrives as a `card.action.trigger` callback, the bot re-runs
`Library.search()` with the cursor trail the button carries, and patches the same card in place
(delivery kind `update`). Button values are validated by `parseAction`, and each render stamps a
nonce so a double click collapses into one receipt while paging back and forth still works. Bot-menu
clicks (`application.bot.menu_v6`, `event_key` = command name) are answered in the operator's direct
chat; commands that need a query show the help card instead. Search results use the same
deterministic `Library.search()` order and cursors as the site.

One configured group receives new-article announcements. The first connected boot records the
existing corpus as its baseline. Later fetched and indexed posts get at most three immediate
messages per Hong Kong day; overflow becomes one digest at 09:00 the following day. Bot state,
inbound deduplication, payloads, attempts, and retry UUIDs live in Postgres and survive restarts.

For local use, create `.env.bot` from the commented block in [`.env.example`](.env.example), make
sure the normal BBS process has applied migrations, then run `vp run bot`. Production setup and
the separate `.env.bot` file are documented in
[`../../tools/deploy/.env.example`](https://github.com/trident-rm/herkules-infra/blob/main/tools/deploy/.env.example). The announcement chat ID is
fixed at first activation; changing the configured ID later makes the bot exit instead of moving
pending messages to another group.

## Decisions that bind

- BBS owns its database, corpus, API, MCP tools, crawl state, and search behavior. `services/auth` owns users and resource registration.
- `PUBLIC_ORIGIN` is the platform origin. It determines issuer and API/MCP audiences. `APP_ORIGIN` is the browser origin. It determines the OAuth callback, cookie, canonical URLs, and page metadata. `src/config.ts` is the boundary.
- Browser sessions use the `api/bbs` audience through `@herkules/oauth-client`. Agents use the `mcp/bbs` audience through `@herkules/auth-middleware`. Both produce the same `Principal`.
- Reads are anonymous. `/api/me` and future user-owned writes require membership. Per-user data keys only on `principal.subject`.

## Connecting an MCP client

`https://herkules.dev/mcp/bbs` is the read-only MCP endpoint. `web/src/account/McpGuide.tsx` renders the same instructions in Chinese on the account page.

- **Claude Code.** Run `claude mcp add --transport http rm-wenku https://herkules.dev/mcp/bbs`, then `/mcp` in a session. OAuth uses DCR; there is no token to paste.
- **Cursor.** Put `{ "mcpServers": { "rm-wenku": { "url": "https://herkules.dev/mcp/bbs" } } }` in `.cursor/mcp.json` for the project or `~/.cursor/mcp.json` globally. Save, open Customize → MCPs, and connect `rm-wenku`. Cursor's documented web and desktop callbacks are both allowed.
- **VS Code 1.106+.** Put `{ "servers": { "rm-wenku": { "type": "http", "url": "https://herkules.dev/mcp/bbs" } } }` in the workspace's `.vscode/mcp.json` or in the profile opened by the "MCP: Open User Configuration" command (or answer "MCP: Add Server" → HTTP), then sign in from the server's entry. OAuth uses CIMD or DCR at VS Code's choice.
- **Codex.** Run `codex mcp add rm-wenku --url https://herkules.dev/mcp/bbs` then `codex mcp login rm-wenku`. The `~/.codex/config.toml` equivalent is a `[mcp_servers.rm-wenku]` table with `url`. In the IDE extension, choose gear → MCP servers → Add server → Streamable HTTP → URL → Save, restart the extension, then authenticate. OAuth uses CIMD or DCR.
- **Zed.** Use Add Server → Add Remote Server in the Agent settings page, or put `{ "context_servers": { "rm-wenku": { "url": "https://herkules.dev/mcp/bbs" } } }` in Zed's `settings.json`. Leave out `Authorization`; Zed starts the MCP OAuth flow itself.
- **Gemini CLI.** Run `gemini mcp add --transport http --scope user rm-wenku https://herkules.dev/mcp/bbs`, then run `/mcp auth rm-wenku` inside Gemini CLI. Automatic OAuth discovery uses DCR and a loopback callback.
- **GitHub Copilot CLI.** Run `/mcp add` and enter the name, HTTP transport, URL, headers, and tools `*`. The equivalent `~/.copilot/mcp-config.json` entry is `{ "mcpServers": { "rm-wenku": { "type": "http", "url": "https://herkules.dev/mcp/bbs", "tools": ["*"] } } }`. There is no auth path.

Copilot CLI is not supported: it has no OAuth flow for remote servers and can only send static headers, while this platform issues no long-lived tokens. The only stopgap is a 15-minute JWT from [`/dev-token`](https://herkules.dev/dev-token) for the `mcp/bbs` audience, passed as `"headers": { "Authorization": "Bearer <token>" }`. It is enough for one test, not for daily use. The Copilot coding agent on github.com does not support remote OAuth MCP at all.

## MCP tools

All ten tools are read-only and served by the same library layer as the REST API (`src/mcp/server.ts`):

- `search_articles`: ranked substring search over titles, authors, tags, introductions and bodies (`scope=all`), titles only, or the knowledge-base entries (`scope=kb`); every whitespace-separated term must occur; returns snippets with `[term]` markers.
- `list_articles`: the date-ordered feed (newest first), optionally filtered by tag or group.
- `get_article`: one article as text or markdown, in selectable parts (`content`, `overview`, `kb`, `links`, `images`).
- `get_overview`: the model-written overview (tldr, summary, key points, FAQ) of one article; status pending when none exists.
- `get_kb`: the structured knowledge-base entry (problem, approach, components, parameters, decisions, pitfalls, entities) plus image captions of one article.
- `search_kb`: knowledge-base cards filtered by a substring query and/or domain, robot type, genre; returns the cards and the facet counts.
- `list_entities`: named entities (parts, boards, algorithms, teams) with article counts, most-cited first; `query` filters by name substring.
- `get_entity`: one entity by name or key with every article that mentions it (newest first).
- `list_tags`: every `group/name` tag with its article count, the group counts, and the fetched total.
- `library_status`: counts of the archive, when the corpus was imported, and who is asking.

## Corpus and search

- `src/db/schema.ts` owns the Postgres schema. Timestamps use `timestamptz(3)`, structured payloads use `jsonb`, title labels use `text[]`, and `ai_usage.user_id` stores the issuer `sub`.
- `src/import/run.ts` is a destructive full-corpus replacement intended for cutover and development. It reads SQLite in foreign-key order, verifies order-independent SHA-256 digests after writing, records the run, and becomes a no-op only when source digests and derivation versions match.
- `src/db/search/` owns the search implementation selected by `SEARCH_INDEX`. `trgm` is the default on stock Postgres; `pgroonga` is the explicit fallback.
- Derived output versions live beside their algorithms. Current constants are `RENDER_VERSION` in `src/content/render.ts`, `NORMALIZE_VERSION` in `src/db/search/normalize.ts`, and `TITLE_VERSION` in `src/content/title.ts`. Bump the owning constant whenever existing rows must be rebuilt under changed logic.
- Public response shapes belong to `src/api/schemas.ts` and `src/api/dto.ts`; routes belong to `src/api/routes.ts`. The SPA consumes the Hono RPC contract rather than a parallel OpenAPI description.

## Crawler policy

- `src/guard/policy.ts` owns the fixed source-safety policy: at least 2 seconds plus up to 1 second jitter between requests, 20 requests per minute, 2,000 per UTC day, and 200 daily requests reserved from background work. Cooldowns step through 60 seconds, 5 minutes, 30 minutes, 2 hours, and 24 hours.
- Interactive work may use the reserve. Background work stops while degraded or while the reserve is held. A wait longer than 30 seconds surfaces as throttled work instead of sleeping in a request.
- `src/crawl/worker.ts` owns scheduling. Discovery runs at startup and every 10 minutes with up to 30 seconds jitter. Manual `work --once` allows one backfill page, ten fetches, and five refreshes.
- One worker process runs two supervised loops and holds a Postgres advisory lock. A second worker exits before issuing a source request.
- The crawler only reads the public RoboMaster forum. It does not log in, bypass access controls, crawl other hosts, generate AI content, or delete articles missing from listings.

## Operational stop condition

Do not work around source blocking. If the deployed Hong Kong host cannot fetch both required public forum endpoints with the configured user agent, or the fixed policy still causes sustained 403 or 429 responses, stop the worker and reassess the source and deployment location. The relevant boundaries are in `src/source/robomaster.ts`, `src/source/http.ts`, and `src/guard/policy.ts`.

## Page rendering

The SPA is static. Optional Cloudflare delivery serves ordinary documents and
public client files; API/OAuth and the entire `/articles*` and `/kb*` prefixes stay
on the origin. See [edge delivery](https://github.com/trident-rm/herkules-infra/blob/main/tools/deploy/cloudflare/README.md).
The server injects `<title>`, description, canonical and `og:*` for `/articles/:id` and `/kb/:name` (`src/spa/head.ts`, `src/spa/static.ts`, the marker block in `web/index.html`). That is what Feishu and WeChat link cards need; Baidu indexing of article bodies is not a goal.

TanStack Start was evaluated on 2026-08-28 and not adopted. Measured on the repo's toolchain (vite-plus 0.3.0 = Vite 8.2.2/Rolldown, Node 24, TypeScript 7): `@tanstack/react-start@1.168.49` builds and serves without Nitro, with Hono as the outer server, at about 90 MB RSS and 7 ms per server-rendered request; `vp dev` works; none of the open Vite 8 issues reproduced. It is still a release candidate patched every few days and its document handler cannot run under Vitest. Nothing the product lacks justifies that dependency.

Revisit when an app needs a server-rendered document with per-user data (the member onboarding app is the candidate) or when Start ships 1.0. If adopted, the shape is fixed: Hono outer; the built `dist/server/server.js` imported by `main.ts` and mounted as the last route; loaders keep the Hono RPC client with an in-process `fetch`; no server functions, no Start server routes, no Nitro; exact version pins; `ssr: false` on `/account`.

## Code map

- `src/app.ts`, `src/main.ts`: composition, commands, routes, static serving
- `src/library/`: query layer and search results
- `src/mcp/`: MCP presentation and tools
- `src/import/`: SQLite conversion and verification
- `src/crawl/`, `src/guard/`, `src/source/`: worker, request policy, forum adapter
- `tests/import.test.ts`, `tests/search.test.ts`, `tests/crawl.test.ts`, `tests/e2e.test.ts`: binding behavior
