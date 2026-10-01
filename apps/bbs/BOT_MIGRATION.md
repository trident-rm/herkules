# Rust Feishu bot migration gates

The deployed bot is still Node. This plan preserves the behavior in the BBS README
and `src/bot/`; it does not change announcement or delivery policy.

## Shape and reuse

Add `herkules-bbs bot` to the existing Rust image and run it as a separate
container. Reuse the Rust Library for search, latest articles, status and knowledge
base reads. Keep the current tables and advisory lock `0x42425342`, including lock
loss monitoring and graceful shutdown. There must never be two active senders.

Shared Feishu transport code can live in `packages/feishu-rust`, used later by the
hosted MCP service. Commands, cards, baseline/day assignment, outbox leasing,
settlement and corpus policy remain in BBS.

## Transport selection must preserve delivery evidence

The published `larkoapi` 0.5.2 source was inspected on 2026-10-01. It supports raw
WebSocket events, ping/pong and fragment reassembly, but its convenience message
helpers omit the caller's persisted UUID and return string errors containing
upstream bodies. Those helpers cannot substitute for `FeishuTransport.send`.
Its event loop also records a seen event before awaiting the handler, and the
handler cannot return a durable-admission failure. It has no connected callback
for the current first-connected baseline rule. Its fragment cleanup retains every
entry instead of expiring incomplete messages. Reuse requires addressing those
behaviors, not simply adding the dependency.

`larksuite-oapi-sdk-rs` 0.3.12 is a stronger candidate for the first transport
prototype: its published source has WebSocket ready/disconnect callbacks, raw
handlers that return errors, failure acknowledgements, expiring fragments,
caller-supplied message UUIDs and configurable HTTP retries. Use raw single-attempt
API calls with `max_retries(0)` rather than channel chunking/fallback behavior.
It requires Rust 1.95, above BBS's declared 1.88 minimum; adoption therefore needs
an explicit minimum-version update and build/image verification. Its generated
service surface and fragment resource bounds still need a compile/RSS and failure
fixture check before selection. Neither candidate has been added to Cargo yet.

A transport must provide:

- A connected signal before activation/baseline, bounded handshake/request times,
  reconnect supervision and clean shutdown.
- Message normalization matching mention policy, direct-message search, content
  type and creation time; raw card-action and `application.bot.menu_v6` handling.
- Durable receipt admission before acknowledging success. A database failure must
  not silently mark an event handled. Bound fragment count/bytes/lifetime and
  reconnect/dedup memory.
- Single-attempt create/reply/patch requests with the frozen content and persisted
  UUID. Return structured status/provider codes without logging tokens, secrets,
  callback query strings or upstream bodies.
- The existing `sent`, `not_sent`, `ambiguous` and `permanent` classifications.
  HTTP 401/403 are fatal; 429 respects Retry-After; a connection failure after a
  possible send is ambiguous. The Postgres outbox owns retries.

## Port in three increments

1. Port command/action/menu parsing and card presentation. Differential fixtures
   cover every alias, group mention policy, Unicode limits, invalid/stale actions,
   five-result search pages, cursor trails, nonce receipts and card schema 2.0.
2. Port the transactional store. Use disposable Postgres and the Node bot tests as
   the behavioral oracle: activation baseline, immutable announcement chat, three
   immediate slots per Hong Kong day, next-day 09:00 digest, receipt deduplication,
   reply planning, lease expiry, stale settlement, frozen payloads and retry UUIDs.
   In particular, only definitely-not-sent immediate messages may join a digest;
   ambiguous sends must not be delivered again as digest entries.
3. Wire transport and the worker loop, then test cross-runtime restart/rollback.
   A pending Node delivery must be sendable by Rust with the same UUID/content;
   Rust-created state must be readable by Node. Exercise lock contention/loss,
   shutdown during a send, reconnect, message/action/menu admission and a failed
   database write. Keep source/Feishu network access fake in automated tests.

Expose `bot_state.last_reconciled_at` and its age through both status adapters,
then add an infrastructure monitor. This resolves the heartbeat gap in
`KNOWN_ISSUES.md` entry 27 only when both the API signal and monitor are present.
Do not remove that entry merely because the Rust process exists.

## Cutover

The infrastructure change selects the Rust image for `bbs-bot` with command
`["bot"]`, preserving the bot environment, single replica and shutdown grace.
Stop the old sender before starting the replacement; do not run a production
shadow sender. Verify lock ownership, heartbeat, fresh inbound receipts and
outbox progress, then compare process RSS and container working memory separately
under comparable uptime/load. Sending a real message for validation requires an
explicitly authorized test recipient. Retain the Node bot image as rollback until
restart/delivery compatibility is proven.
