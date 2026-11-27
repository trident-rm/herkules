# AI gateway

`herkules-ai` is one Rust process that serves two hosts:

- `ai-api.herkules.dev`: an OpenAI- and Anthropic-compatible API. Members call it with an `sk-hk-` key, and the gateway forwards each request to a GPU machine that serves the requested model.
- `ai-portal.herkules.dev`: the portal, where members sign in with Herkules, create keys, copy client setup and read their usage and request log, and admins manage backends and logging.

The gateway owns its Postgres database. The portal SPA in `web/` is built by Vite and served by the same process from `WEB_DIR`. Deployment is in the [runbook](https://github.com/trident-rm/herkules-infra/blob/main/tools/deploy/README.md).

## API

| Route                                                                                                        | Handling                                                              |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `POST /v1/chat/completions`, `/v1/completions`, `/v1/messages`, `/v1/messages/count_tokens`, `/v1/responses` | Forwarded                                                             |
| `POST /tokenize`, `/detokenize`, `/v1/tokenize`, `/v1/detokenize`, `/v1/token/encode`, `/v1/token/decode`    | Forwarded                                                             |
| `GET /v1/models`, `GET /v1/models/{id}`                                                                      | Answered by the gateway: models that have an enabled, healthy backend |
| Anything else, including `/metrics` and `/health`                                                            | 404                                                                   |

Every route needs a key, sent as `Authorization: Bearer <key>` or `x-api-key: <key>`. Errors use Anthropic's shape on `/v1/messages*` and OpenAI's elsewhere.

The gateway reads `model` from the JSON body to choose a backend and forwards the body bytes unchanged. A tokenizer request without `model` goes to the only available model when there is exactly one. The gateway drops the client's `Authorization`, `x-api-key`, cookies, `cf-*` and forwarding headers, hop-by-hop headers and `Accept-Encoding`, then adds the backend's credentials and `Accept-Encoding: identity`, so the log holds uncompressed bytes. The response streams back chunk by chunk without buffering. When the client disconnects, the gateway drops the upstream connection, and Siphon aborts the job.

There are no quotas or rate limits.

## Keys and membership

A key is `sk-hk-` followed by 43 base64url characters (32 random bytes). The database stores its SHA-256, the owner's Herkules `sub`, a name, a 12-character prefix for display, and created, last-used and revoked times. The portal shows a new key once.

Every request checks the owner with the auth service's private `POST /auth/internal/ai-membership` (see the [auth README](../auth/README.md#ai-portal)). Answers are cached for 20 seconds, so a disabled or removed member's keys stop within 20 seconds. If the auth service does not answer, the request fails with 503.

## Backends

A backend is a model server: a name, a base URL, the model ids it serves, and a credential. Backends come from two places:

- **`AI_BACKENDS_FILE`**: a server-owned JSON list for fixed or local machines:

  ```json
  [
    {
      "name": "gpu-a",
      "url": "https://gpu-a.example",
      "models": ["inkling-2-mini"],
      "credentials": "/run/ai/gpu-a.json"
    }
  ]
  ```

  The credentials file holds `{"bearer": "<key>"}` or `{"cf_access_client_id": "…", "cf_access_client_secret": "…"}`. Without `credentials`, requests carry none.

- **Tunnel backends**: an admin adds a machine in the portal with a name, its model ids and the local port of `siphon-serve`. See [Tunnel backends](#tunnel-backends).

Every 5 seconds the gateway reads each backend's `/health`, `/metrics` (`vllm:num_requests_running` and `vllm:num_requests_waiting`) and `/v1/models`, sending the backend's credential. A backend is healthy when `/health` answers 2xx. A request goes to an enabled, healthy backend that lists its model, with the lowest load. Load is the larger of the gateway's open requests to that backend and its reported running count, plus its waiting count.

Admins set each backend to enabled, disabled or draining. The state lives in `backend_state` and survives restarts. Disabled and draining backends get no new requests; open requests finish. The portal shows open requests per backend, so an admin can tell when a draining backend is idle.

## Tunnel backends

With `AI_CLOUDFLARE_FILE`, an admin adds a GPU machine from the portal. The gateway:

1. creates a remotely managed Cloudflare Tunnel named `herkules-ai-gpu-<8 hex>`;
2. sets its ingress to `http://localhost:<port>` for the hostname, with a 404 catch-all;
3. creates a proxied CNAME `gpu-<8 hex>.<zone>` to `<tunnel id>.cfargotunnel.com`, with the comment `managed by herkules-ai`;
4. stores the backend row.

The portal then shows `sudo cloudflared service install <token>` once. The tunnel token is not stored. Run `siphon-serve` on the machine bound to `127.0.0.1` at that port, so only the tunnel reaches it.

The Terraform-managed Access application covers `gpu-*.<zone>` and admits only the gateway's service token, so a new hostname needs no Access change. The gateway sends that service token to every tunnel backend.

Removing a tunnel backend first checks whether it is busy. If it is, the gateway sets it to draining and asks the admin to remove it again later. When it is idle, the gateway deletes the DNS record, then the tunnel, then the row. Cloudflare refuses to delete a tunnel while a connector is attached, so stop `cloudflared` on the machine first. The portal shows the tunnel status from Cloudflare (`healthy`, `degraded`, `down` or `inactive`) next to `/health` and `/metrics`.

The gateway reads a tunnel or record back before it changes or deletes it. It refuses unless the tunnel name starts with `herkules-ai-`, or the record has the exact comment and a name of the form `gpu-<8 hex>.<zone>`. It never touches Terraform-managed objects.

The Cloudflare API token needs exactly:

- Account › Cloudflare Tunnel › Edit (API name "Cloudflare Tunnel Write"), on the account;
- Zone › DNS › Edit (API name "DNS Write"), on the one zone.

`AI_CLOUDFLARE_FILE` is a server-owned JSON file. The token never goes in the database.

```json
{
  "api_token": "…",
  "account_id": "…",
  "zone_id": "…",
  "zone": "herkules.dev",
  "access_client_id": "…",
  "access_client_secret": "…"
}
```

## Request log

Each forwarded request writes one `requests` row: time, user, key, model, backend, method, route, status, duration, whether it streamed, whether the client cancelled, reasoning effort, prompt tokens (the whole prompt, cached tokens included), cached tokens, output tokens, TTFT, decode tok/s, tokens per round, and its logging level. A request refused before forwarding, for a missing or unknown key or a disallowed route, writes no row.

Token counts and speeds come from Siphon's llama.cpp-style `timings`: at the top level of a plain body, or in a stream's late event. When a response has no `timings`, they come from `usage` in OpenAI's, Anthropic's or the Responses API's shape. The effort comes from `reasoning_effort`, `reasoning.effort` or `output_config.effort`; `thinking: {"type": "disabled"}` records `none`. A client that leaves before the response begins is logged with status 499.

### Logging levels

A request is logged at `metadata` or `full`. `full` also stores the request and response bodies in `request_bodies`, zstd-compressed. Each body is cut at `AI_LOG_BODY_BYTES` before compression, and the row records the original size and whether it was cut. Stored bodies are deleted after `AI_LOG_RETENTION_DAYS`; the metadata rows stay.

The level is the owner's override if an admin set one, else the model's default if set, else `metadata`. The portal shows each member their level. Members can read their own stored bodies, and admins can read anyone's.

## Configuration

| Variable                            | Default          | Meaning                                                                                      |
| ----------------------------------- | ---------------- | -------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                      | required         | `postgres://` URL of the gateway's own database. Migrations in `migrations/` run at start.   |
| `PUBLIC_ORIGIN`                     | required         | The Herkules origin, `https://herkules.dev`. The issuer is `${PUBLIC_ORIGIN}/auth`.          |
| `AUTH_INTERNAL_URL`                 | `PUBLIC_ORIGIN`  | The auth service on the private network, for JWKS, token exchange, user info and membership. |
| `AI_API_ORIGIN`, `AI_PORTAL_ORIGIN` | required         | The two public origins. Requests are routed by their `Host`.                                 |
| `AI_CLIENT_SECRET`                  | required         | Secret of the `ai` OAuth client, the same value as in the auth service.                      |
| `AI_COOKIE_SECRET`                  | required         | Encrypts portal session cookies, at least 32 characters. Rotating it signs everyone out.     |
| `AI_SYNC_SECRET`                    | required         | Credential for the membership endpoint, the same value as in the auth service.               |
| `AI_BACKENDS_FILE`                  | unset            | Fixed backends, as above.                                                                    |
| `AI_CLOUDFLARE_FILE`                | unset            | Enables tunnel backends.                                                                     |
| `AI_LISTEN`                         | `127.0.0.1:4010` | Listen address. The image sets `0.0.0.0:4010`.                                               |
| `WEB_DIR`                           | unset            | The built portal. The image sets `/app/dist/client`.                                         |
| `AI_MAX_REQUEST_BYTES`              | 67108864         | Largest request body, images included.                                                       |
| `AI_LOG_BODY_BYTES`                 | 1048576          | Bytes of each body kept at the `full` level.                                                 |
| `AI_LOG_RETENTION_DAYS`             | 30               | Days to keep stored bodies.                                                                  |
| `AI_DB_CONNECTIONS`                 | 5                | Postgres pool size.                                                                          |

`GET /healthz` answers on any host, for the container health check.

## Run and test

```sh
cargo test -p herkules-ai --locked
cargo clippy -p herkules-ai --all-targets --locked -- -D warnings
vp run @herkules/ai#build   # the portal, into dist/client
vp run @herkules/ai#test    # setup snippets and formatting
```

To run it locally, start Postgres and the auth service, then:

```sh
DATABASE_URL=postgres://ai:ai@127.0.0.1:5432/ai \
PUBLIC_ORIGIN=http://localhost:3000 AUTH_INTERNAL_URL=http://localhost:3001 \
AI_LISTEN=127.0.0.1:4110 \
AI_API_ORIGIN=http://ai-api.localhost:4110 AI_PORTAL_ORIGIN=http://localhost:4010 \
AI_CLIENT_SECRET=… AI_COOKIE_SECRET=… AI_SYNC_SECRET=… \
AI_BACKENDS_FILE=./backends.json \
cargo run -p herkules-ai
vp run @herkules/ai#dev     # the portal on :4010, forwarding /api, /login, /callback and /logout
```

Set `AI_PORTAL_ORIGIN`, `AI_CLIENT_SECRET` and `AI_SYNC_SECRET` in the auth service's `.env` to the same values. The Vite server keeps the `Host` header, so the gateway serves the portal for `localhost:4010`. API clients call `http://ai-api.localhost:4110/v1`.

## Code map

- `src/api.rs`: the allowlist, key checks, forwarding, and the request log row
- `src/usage.rs`: token counts and speeds from bodies and streams; the effort field
- `src/backends.rs`: backend set, health and load checks, selection
- `src/cloudflare.rs`: tunnel, ingress and DNS calls with their ownership checks
- `src/portal.rs`: portal routes, OAuth session and admin actions
- `src/membership.rs`, `src/keys.rs`, `src/levels.rs`, `src/db.rs`, `src/config.rs`
- `migrations/`: the schema
- `web/`: the portal SPA
