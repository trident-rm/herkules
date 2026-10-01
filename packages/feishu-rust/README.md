# Rust Feishu transport

`herkules-feishu` is Herkules-owned transport code for Rust Lark/Feishu apps. The
first consumer is the BBS bot. It wraps the community-maintained
[`larksuite-oapi-sdk-rs`](https://github.com/adamcavendish/larksuite-oapi-sdk-rs)
0.3.12 for WebSocket event dispatch; it is not an official Lark SDK. Outgoing
messages use a small reqwest client to preserve durable UUIDs, frozen content,
structured error classifications and single-attempt delivery.

Rust 1.95+ and a protobuf compiler are required for the SDK's build script:
`brew install protobuf` on macOS or `apt-get install protobuf-compiler` on Debian.
The application container installs protobuf only in its Rust build stage.

## Boundaries

- Construct `Feishu` with explicit application credentials. The crate reads no
  environment variables and has no database or product policy.
- Application tokens are cached and serialized per client instance. HTTP calls
  have deadlines, no redirects, no environment proxy and no automatic retries.
  Responses are capped at 1 MiB. Secrets and raw upstream bodies are never
  returned in transport errors. Do not log credentials or outbound content.
- `send` returns `sent`, `not_sent`, `ambiguous` or `permanent`. Applications own
  persistent retry decisions; retrying a write must retain its UUID/content.
- `websocket` calls the application's async raw-event handler. It acknowledges
  success only when the handler succeeds. Commit durable admission before
  returning success. `Connection::connected` waits for the first ready signal;
  `close` bounds shutdown and awaits/aborts the receiver task.
- WebSocket dial and write times are bounded, and individual WebSocket messages
  and frames are capped at 1 MiB. The SDK expires incomplete Feishu fragments
  after five seconds; aggregate fragment count/bytes remain an upstream gap.
- The application must disable the SDK tracing target to avoid SDK diagnostics
  exposing upstream bodies or gateway query strings. BBS adds
  `larksuite_oapi_sdk_rs=off` after loading `RUST_LOG`. Herkules transport errors
  remain safe to report separately.

Command parsing, cards, mention policy, announcement quotas, receipts, locks,
leases and retries belong to the application. The crate does not provide
per-member OAuth grant persistence yet; the hosted Feishu MCP migration will
add that independently without mixing member and application identities.
`with_origin` is an explicit injection point for fake loopback servers; BBS uses
the fixed Feishu origin in production.

## Verify

```sh
cargo test -p herkules-feishu --locked
vp run ready
```

Local HTTP/WebSocket fixtures verify persistent UUID/content, single-attempt
requests, token caching, failure classifications, safe errors, readiness/shutdown,
and a failed admission followed by retry of the same event. Tests issue no real
Feishu messages or authorization requests.
