# syntax=docker/dockerfile:1.7
# Application images: --target auth | bbs | bbs-web | ai | platform.
# The build stage installs the whole workspace once; runtime images get only
# `pnpm deploy --prod` output (auth, bbs), a Rust binary with static assets (bbs-web, ai)
# or static assets and routes (platform).

# Static musl binaries for the whole Cargo workspace; Node remains for BBS migrations/import
# and rollback.
FROM rust:1.95-alpine AS rust-build
RUN apk add --no-cache build-base cmake perl protobuf
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY apps/bbs/rust apps/bbs/rust
COPY packages/auth-rust packages/auth-rust
COPY packages/feishu-rust packages/feishu-rust
COPY services/ai/Cargo.toml services/ai/Cargo.toml
COPY services/ai/src services/ai/src
COPY services/ai/migrations services/ai/migrations
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release -p herkules-bbs -p herkules-ai --locked \
 && cp target/release/herkules-bbs /herkules-bbs && cp target/release/herkules-ai /herkules-ai

FROM node:24-alpine AS base
RUN npm install -g pnpm@11.24.0
WORKDIR /app

FROM base AS build
# Dependencies first, source second: `pnpm fetch` reads only the lockfile (plus the workspace
# settings), so this layer and its store stay cached until pnpm-lock.yaml changes. No cache
# mount on purpose: CI restores layers from the GHA cache but never cache mounts, so the store
# has to live in the layer for the offline install below to find it.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --ignore-scripts
COPY . .
# --ignore-scripts: the root `prepare` (vp config) wires git hooks; nothing to build natively.
RUN pnpm install --offline --frozen-lockfile --ignore-scripts
# --sort is pnpm's topological order over the workspace dependency graph
# (auth-middleware -> oauth-client -> auth -> bbs -> web), so adding, renaming or deleting a
# package needs no edit here. Packages without a `build` script are skipped, not failed.
# bbs round 2: the SPA build (`vp build` -> apps/bbs/dist/client) is part of @herkules/bbs's `build` script.
RUN pnpm -r --filter '!@herkules/training' --sort run build
# --ignore-scripts again: `pnpm deploy` otherwise runs the root `prepare` (vp config), which wants git.
RUN pnpm --filter @herkules/auth deploy --prod --legacy --ignore-scripts /out/auth \
 && pnpm --filter @herkules/bbs deploy --prod --legacy --ignore-scripts /out/bbs \
 && pnpm --filter @herkules/feishu deploy --prod --legacy --ignore-scripts /out/feishu

# ── runtime base for the two Node services ─────────────────────────────────
# auth and bbs differ only in port, env, entrypoint and the /out directory they copy.
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
USER node

# ── auth ────────────────────────────────────────────────────────────────────
FROM runtime AS auth
ENV PORT=3001 MIGRATIONS_DIR=/app/drizzle AVATAR_DIR=/data/avatars
COPY --from=build --chown=node:node /out/auth /app
COPY --from=build --chown=node:node /out/feishu /feishu
# The `avatars` named volume inherits this directory's ownership, so it has to exist and be
# node-owned in the image; only root can create it, hence the two USER lines.
USER root
RUN apk add --no-cache tzdata ca-certificates && mkdir -p /data/avatars /data/grants && chmod 0700 /data/grants && chown -R node:node /data
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=2s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/auth/healthz || exit 1
CMD ["node", "dist/main.mjs"]

# ── bbs (API + MCP + SPA; `files` carries dist/ and drizzle/) ───────────────
FROM runtime AS bbs
ENV PORT=3003 MIGRATIONS_DIR=/app/drizzle WEB_DIR=/app/dist/client BBS_RUST_NATIVE=true
COPY --from=build --chown=node:node /out/bbs /app
COPY --from=rust-build /herkules-bbs /usr/local/bin/herkules-bbs
USER root
RUN apk add --no-cache ca-certificates
USER node
EXPOSE 3003
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=2s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3003/healthz || exit 1
# ENTRYPOINT, not CMD: `docker compose run --rm bbs import /import/app.db` appends argv (main.ts dispatches).
ENTRYPOINT ["node", "dist/main.mjs"]

# Rust-only web process. The existing bbs image remains the jobs/migration image
# and compatible rollback target. Vite/Node are build-time dependencies only.
FROM alpine:3.23 AS bbs-web
RUN apk add --no-cache ca-certificates && addgroup -g 1000 bbs && adduser -D -u 1000 -G bbs bbs
WORKDIR /app
ENV WEB_DIR=/app/dist/client BBS_RUST_LISTEN=0.0.0.0:3003
COPY --from=rust-build /herkules-bbs /usr/local/bin/herkules-bbs
COPY --from=build --chown=bbs:bbs /app/apps/bbs/dist/client /app/dist/client
USER bbs
EXPOSE 3003
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=2s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3003/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/herkules-bbs"]

# AI gateway and portal (services/ai): one Rust process for ai-api and ai-portal.
# It applies its own migrations at start; its database is separate from the others.
FROM alpine:3.23 AS ai
RUN apk add --no-cache ca-certificates && addgroup -g 1000 ai && adduser -D -u 1000 -G ai ai
WORKDIR /app
ENV WEB_DIR=/app/dist/client AI_LISTEN=0.0.0.0:4010
COPY --from=rust-build /herkules-ai /usr/local/bin/herkules-ai
COPY --from=build --chown=ai:ai /app/services/ai/dist/client /app/dist/client
USER ai
EXPOSE 4010
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=2s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4010/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/herkules-ai"]

# Static platform artifact consumed by herkules-infra; never run as a service.
FROM scratch AS platform
COPY --from=build /app/services/web/dist /srv
COPY tools/images/caddy /caddy
CMD ["/artifact-only"]
