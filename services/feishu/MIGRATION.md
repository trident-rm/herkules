# Feishu memory reduction and Rust migration

This is an implementation sequence, not a claim that the hosted connector is
already Rust. Better Auth remains the issuer. BBS bot and hosted Feishu MCP remain
separate processes and application identities.

## 1. Load only the hosted catalog

The pinned `@larksuiteoapi/lark-mcp` 0.5.1 root catalog imports 1,274 English tool
definitions plus the Chinese catalog before runtime filtering. Generate the
selected definitions instead. The hosted service registers 20 user tools, five
bot tools and its connection-status tool; their union has 24 upstream definitions.

`src/catalog.generated.ts` retains upstream Zod expressions, descriptions,
methods, paths and token capabilities. The two document builtins still use their
original handlers. `tests/catalog.test.ts` compares selection, ordering, metadata,
handlers and JSON schemas with upstream, and checks a fresh runtime process does
not import the API-family catalogs or Chinese definitions. Generation rejects a
new upstream version until its extraction format and custom handlers are audited.

Regenerate after changing the hosted tool selection or upgrading upstream:

```sh
vp run "@herkules/feishu#generate:catalog"
vp run "@herkules/feishu#test"
vp run "@herkules/feishu#benchmark:catalog"
```

The benchmark measures only SDK/catalog imports after GC, in five fresh processes
per variant. On Linux ARM64 with Node 24.20.0 on 2026-10-01, median RSS was
307.4 MiB for the full catalog and 130.0 MiB for the selected catalog; retained JS
heap was 130.3 and 21.6 MiB respectively. This is not a production measurement,
request-load test, or estimate of the AMD64 container's final working memory.
Production comparison must use the same RSS/container metric before and after
promotion, with comparable traffic and uptime.

## 2. Migrate the BBS bot

The bot belongs to BBS, and should use the existing Rust Library and corpus
connection. Run `herkules-bbs bot` in its own container from the existing Rust
image. Keep its credentials, Postgres tables, announcement chat, advisory lock,
restart policy and deployment boundary. See [the bot migration gates](../../apps/bbs/BOT_MIGRATION.md).

A shared `packages/feishu-rust` crate is appropriate for HTTP transport, application
tokens, structured errors and event framing if both consumers need that code.
Keep BBS command parsing, cards, announcement decisions and outbox SQL in BBS.
Do not extract the bot's product policy into the shared crate.

## 3. Replace the hosted connector runtime

Use an independent Rust service with Axum, `rmcp`, `herkules-auth::Verifier` and a
small reqwest executor. Build JSON-schema/API metadata from the selected official
catalog during development/build; the deployed executable must not need Node to
load it. Do not port all 1,274 upstream endpoints.

First port grant persistence and test it against the Node implementation:

- Preserve SHA-256 subject filenames, AES-256-GCM bytes (`12-byte nonce`, `16-byte
tag`, ciphertext, base64url), and `grant:<subject>` associated data. Keep the
  existing volume and storage key so a switch does not require reconnection.
- Preserve private directory/file modes and atomic file replacement. Serialize
  refresh, connect and disconnect per subject. Persist refresh-token rotation
  before returning an access token; isolate different subjects.
- Preserve tenant validation, required scopes, expiry and safe error messages.
  Test Node-write/Rust-read and Rust-write/Node-read, corrupt ciphertext, wrong
  purpose/subject, missing files, refresh failure and concurrent disconnect.

Then port browser connection routes and MCP admission:

- Verify the exact MCP audience and current issuer membership on every request.
  Standalone `Verifier` fits this connector; its browser connection page uses
  the issuer's existing session, not a new first-party OAuth client registration.
- Preserve Origin checks, refusal of impersonated sessions, subject agreement
  between session/member endpoints, PKCE, callback cookie/path/security settings,
  state expiry, callback subject binding and exact registered redirect URI.
- Preserve headers, discovery challenges, stateless MCP transport, setup URL,
  tool names, annotations, schemas and result envelopes. Even shared bot tools
  require the caller's own valid Feishu grant.

Port generic API execution with fixture parity before live use. The server must
choose user or application identity; caller-supplied `useUAT` cannot change it.
Encode path parameters as segments, reproduce query/body handling and upstream
`.data` unwrapping, redact credentials, and never automatically retry a write
with an ambiguous outcome.

Two builtins require explicit implementations:

| Tool                  | Required behavior                                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docx.builtin.search` | POST `/open-apis/suite/docs-api/search/object` with the member's token, preserving the upstream result envelope                                             |
| `docx.builtin.import` | Upload Markdown using media multipart, create an import task, then poll the ticket using the same member identity; preserve errors and completion semantics |

The import handler is a multi-step write, so tests must cover partial success and
poll timeout without silently re-uploading or creating another import task.
Capture outbound request fixtures from the current SDK using a fake upstream;
compare Rust requests and MCP results for every hosted tool. Run the existing
admission/connect tests against the Rust service too, including disabled users,
wrong audiences and switching browser accounts during authorization.

Only switch the infrastructure service after grant interoperability and all tool
fixtures pass. Use the same secrets and volume, one replica, an immutable Rust
image, health probes and a rollback target that can still read the grant files.
Measure RSS and container working memory independently after switching. The Node
connector stays available for rollback until the Rust service passes these gates.
