# Incremental BBS migration

The target is a Rust backend with Askama server-rendered pages and Vite-built CSS and JavaScript assets. API and MCP behavior move before the complete browser UI. Better Auth remains the identity service throughout the BBS migration; changing identity implementations is a later project.

## Current increment

Implemented an Axum/Tokio/SQLx service for all twelve corpus read methods: feed pagination/filtering, ranked search/snippets, article/content/AI, tags, KB cards/facets/entities, status and head metadata. An opt-in `Library` adapter delegates these reads from the existing REST and MCP presenters. Askama renders the article reader with its restored sidebar. Browser feed and other pages, identity/transports and writers continue on Node. The [Rust README](rust/README.md) covers running, enabling and reversing the increment.

Real-Postgres differential checks cover all read methods, including Unicode snippets, cross-filtered facets, malformed AI arrays, orphaned entities and cursor interchange. Query counts retain the existing one/two-query bounds; representative query-plan review is still pending before cutover.

The existing TypeScript schema, Drizzle migration history and corpus writer remain authoritative. Rust reads the same database and uses independent runtime SQL. Generated migration SQL is unchanged. There is no production container or route cutover in this increment.

## Sequence and completion gates

| Stage                            | Work                                                                                                                 | Gate before replacing existing behavior                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — article slice (implemented)  | Feed/article/content/tags/AI reads; Askama reader and sidebar; optional Node delegation                              | Unit tests, full existing suite, real-Postgres differential checks                                                                                    |
| 2 — read implementation complete | Search/ranking/snippets, KB/facets/entities, status and head metadata; trgm only                                     | Differential checks over all `Library` methods, Unicode and ordering edge cases; query-count and representative query-plan review                     |
| 3 — native API and MCP           | Rust REST presenters, MCP Streamable HTTP, discovery, audience-specific OAuth validation, browser OAuth and sessions | Existing API/MCP contract tests against Rust, anonymous access, wrong-audience rejection, refresh hooks, browser login/logout and membership behavior |
| 4 — complete SSR UI              | Askama feed/search/reader/KB/tags/status/account; progressive enhancement from Vite for interactive controls         | Usable navigation and forms without JS, pagination/filter URL parity, reader/AI/image interactions, accessibility and metadata checks                 |
| 5 — writers and integrations     | Import/derive/sanitization, migration ownership, crawler/AI jobs, locks, Feishu bot and durable delivery             | Fixture import parity, adversarial sanitizer tests, real-Postgres locking/retry tests, restart and backup/restore checks                              |
| 6 — deployment cutover           | Rust container, reverse-proxy routes, readiness, worker processes and rollback                                       | Representative corpus/load benchmarks, measured RSS/CPU/latency, deployment smoke tests, explicit compatible-schema rollback procedure                |

Each stage can ship smaller slices through the same adapter pattern. The database schema stays compatible until both implementations have been checked. Move migration ownership once, retaining the complete applied history; avoid independent Rust and Drizzle migration streams against the same database.

## Frontend direction

Use Askama to render the feed, reader and other public content pages, and retain React for richer browser widgets built by Vite. This keeps the deployed frontend assets static and the request-time page renderer in Rust. A frontend JavaScript SSR service is not required.

React is the preferred widget framework for this repository because `packages/ui` already owns the shared React/shadcn/Radix primitives. Date pickers, custom selectors, chart panels, mobile sheets and lightboxes can mount in explicitly designated widget roots. Askama owns article bodies, feed rows, metadata, pagination links and the basic filter forms. Do not attempt to hydrate arbitrary Askama markup: framework hydration requires matching framework-generated HTML.

Keep filter state in the URL, submit through ordinary GET forms, and preserve a useful initial document when JavaScript is unavailable. React roots own their DOM descendants and must not compete with imperative updates to the same nodes. Load chart/widget dependencies only on pages that use them. The current restored sidebar is rendered entirely on the server; mobile controls are anchor links and specifications use native disclosures. A React mobile sheet and lightbox are subsequent enhancements, not yet implemented in the Rust preview.

Svelte and Solid remain viable widget alternatives, but introducing either would replace existing component reuse with a second UI stack. Qwik resumability requires Qwik-produced serialized rendering state and is not a drop-in enhancement to Askama documents. Reconsider the frontend choice only when a measured interaction or maintenance problem justifies the migration.

## Resource evaluation

Do not infer resource savings from choosing Rust. The first increment adds a second process, and Node workers and authentication remain. Measure release builds against the current deployment using the same corpus and Postgres configuration: idle and loaded RSS, CPU, p50/p95 latency, concurrent reads, query counts and connection use. Account for the database, search indexes, Argon2 authentication service and crawler/AI workloads separately. The Rust reader requires no frontend runtime or hydration; Vite runs at build time.

## Deferred

The platform site and Better Auth migration are outside this work. Native BBS OAuth remains a consumer of the existing identity contract; implementing that client and resource-server behavior does not require replacing the identity provider. Rauthy evaluation and a custom Rust identity service can resume after BBS contracts and deployment are stable.
