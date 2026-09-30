# Rust authentication

`herkules-auth` is the shared Rust consumer of the Herkules identity contract. It provides resource-server token verification and first-party browser OAuth sessions for Axum services. Better Auth remains the authorization server; this crate has no user database or identity-provider implementation.

## Use

Add a Cargo path dependency from your service:

```toml
[dependencies]
herkules-auth = { path = "../../packages/auth-rust" }
```

Construct one shared `Auth` and keep it in application state:

```rust,no_run
use herkules_auth::{Auth, AuthConfig};

# fn example() -> Result<(), Box<dyn std::error::Error>> {
let auth = Auth::new(AuthConfig {
    client_id: "training".into(),
    public_origin: "https://herkules.dev".into(),
    internal_origin: "http://auth:3001".into(),
    app_origin: "https://training.example".into(),
    api_resource: "https://herkules.dev/api/training".into(),
    mcp_resource: "https://herkules.dev/mcp/training".into(),
    login_error_path: "/account".into(),
    client_secret: std::env::var("OAUTH_CLIENT_SECRET")?,
    cookie_secret: std::env::var("OAUTH_COOKIE_SECRET")?,
})?;
# let _ = auth;
# Ok(())
# }
```

The identity service must register the confidential client, exact `app_origin/callback` redirect and requested resource. Construction validates origins, distinct audience URLs, local error paths and secrets of at least 32 UTF-16 units. The crate reads no environment variables. HTTPS app origins use Secure `__Host-` cookies.

- `Verifier::new` / `header` / `verify` provide standalone bearer verification against a configured issuer, JWKS URL and caller-supplied HTTP(S) resource audience. `Principal` and `Failure` follow [the token contract](../../docs/tokens.md), including API and MCP OAuth challenges. Reuse the verifier so its JWKS cache is shared.
- `Auth::resolve(headers, method)` resolves bearer/cookie precedence and refreshes sessions. It returns a `Session` with principal, failure, explicit-bearer flag and cookies. The application chooses optional or guarded access; append returned cookies with `with_cookies`, including on error responses. Never ignore an explicit bearer failure.
- `Auth::login`, `callback` and `logout` return Axum responses. Apps mount `/login`, `/callback` and **POST-only** `/logout`; the crate does not mount routes or enforce HTTP methods for you. Login failure redirects to the configured local path with `login_error`.
- `Auth::user_profile` fetches the Herkules user-info endpoint with the principal's token. Applications own their viewer DTO, profile fallback, membership policy and HTML.

## Binding decisions

OAuth endpoints and user-info paths follow the Herkules issuer layout under `/auth`. Client IDs, API/MCP audiences and login error destinations are configurable. The crate is a Herkules integration, not a general-purpose replacement for Better Auth.

Token checks, Ed25519/JWKS behavior and challenges are governed by `docs/tokens.md` and its normative vectors. MCP callers use bearer tokens with the MCP audience; browser cookies use the API audience. An invalid explicit bearer never falls back to cookies. A cross-site unsafe request cannot authenticate with a browser cookie.

Cookie bytes match `@herkules/oauth-client`: AES-256-GCM, HKDF-SHA256 salt equal to the client ID, separate login/session purposes and fixed `hk_login`/`hk_session` names. Different client IDs isolate encryption keys even when a secret is shared. Host-specific app origins isolate cookie names; do not run multiple clients on the same browser origin without a separate cookie naming design. Rotating the secret signs users out.

Login state retains up to three attempts for ten minutes, with PKCE S256 and safe local return paths. Refresh starts within 60 seconds of expiry, shares in-flight requests per refresh token and retains successful rotations for the issuer's 30-second replay window. These durations must remain aligned with the TypeScript client and issuer. Failed refreshes are not memoized. Each refresh has an independently driven owner with a ten-second deadline, so cancelling every HTTP waiter cannot pause it or retain a cycle. Completion changes only its own generation; cancelled callers can recover a successful rotation through the same replay memo. Keep one `Auth` per app process to share caches; cross-process replay depends on the issuer policy.

The application owns route mounting, admission policy, rate limits, discovery, MCP transport, UI, persistence and deployment. BBS retains those concerns; its `auth` module re-exports this crate and its `session` module presents profiles.

## Verify

From the repository root:

```sh
cargo test -p herkules-auth --locked
vp run check:rust
vp run ready
```

Unit tests cover normative tokens, JWKS cache/outages, failed-refresh concurrency, cancellation cleanup, cookie purpose/client isolation and configurable clients. BBS's disposable Postgres parity suite additionally checks Node/Rust cookie interoperability and the actual Better Auth issuer:

```sh
BBS_RUST_TEST_POSTGRES=postgres://test_user:password@localhost/postgres \
vp run "@herkules/bbs#test:rust:parity"
```

This is a Cargo workspace crate, not an npm workspace. No standalone service or extra runtime process is introduced. It remains unpublished.
