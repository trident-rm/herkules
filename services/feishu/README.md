# Hosted Feishu MCP

Team connector at `https://herkules.dev/mcp/feishu`, using the official
`@larksuiteoapi/lark-mcp` tool definitions and handlers. Herkules authenticates
remote MCP clients; Feishu separately authorizes each member's upstream data.
The upstream localhost-only OAuth server is not exposed. Runtime loads only the
selected hosted tool schemas; the full official catalog is used for generation
and parity tests. See [memory reduction and Rust migration](MIGRATION.md).

## Commands

```sh
vp install
vp run @herkules/feishu#build
vp run @herkules/feishu#test
vp check
vp run "@herkules/feishu#generate:catalog"  # after changing/upgrading the catalog
vp run "@herkules/feishu#benchmark:catalog" # isolated import-memory comparison
```

Copy `.env.example` to `.env` for local operation; `vp run dev` does not start this
optional connector. It needs a running Herkules issuer and a Feishu custom app.

## Configuration and boundaries

- `PUBLIC_ORIGIN` determines the audience `/mcp/feishu`, issuer `/auth`, and
  exact Feishu callback `/mcp/feishu/callback`. Register the callback in Feishu.
- `AUTH_INTERNAL_URL` is the internal auth origin, without `/auth`.
- `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, and `FEISHU_TENANT_KEY` identify the MCP
  app and team. Do not replace the separate Herkules sign-in app.
- `FEISHU_STORAGE_KEY` is 32 random bytes encoded as 64 hex characters. It seals
  OAuth state and per-member grants with AES-256-GCM. Keep it on the server;
  changing it requires members to reconnect. `GRANTS_DIR` is a persistent volume.
- The single service process serializes refresh, connect, and disconnect per
  subject. Files use hashed Herkules subjects, authenticated encryption bound to
  the subject, atomic replacement, and private permissions. Do not run replicas
  sharing the volume without replacing the file store and locking strategy.
- Every MCP request verifies the exact audience and checks current membership at
  the issuer. Every tool, including bot tools, requires that member's Feishu grant.
  A caller can never supply the upstream identity or token. User tools always use
  that caller's grant; `bot_` tools always use the shared application identity.
- `/mcp/feishu/connect` uses the existing Herkules browser session. Mutations
  require the exact Origin. PKCE, encrypted state, expiry, callback cookie, and
  the current subject bind each Feishu authorization. Impersonated sessions are
  refused. Only the configured Feishu tenant is accepted.
- Disconnect removes the hosted grant. It does not undo operations or revoke
  Feishu authorization globally; members can revoke it in Feishu app settings.
- No credentials, callback query strings, or upstream response bodies are logged.
  Tool annotations distinguish reads from changes, and shared bot tools are named
  explicitly. Client approval rules still govern sending messages and other writes.

Members first open `/mcp/feishu/connect`, sign in, and authorize Feishu. Then add
`https://herkules.dev/mcp/feishu` to their remote MCP client and complete Herkules
OAuth. Clients requesting user data without a Feishu connection receive the setup
URL. The catalog includes the default user tools, calendar tools, and shared bot
messaging/contact tools. It inherits upstream support limits, including the lack
of file upload/download tools.

The auth image carries this service at `/feishu` as a separate Compose process.
Production secrets, volume mounts, promotion and rollback belong to
`herkules-infra`, following `docs/deploy.md`.
