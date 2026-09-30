# syntax=docker/dockerfile:1.7
# Application images: --target auth | bbs | ai | platform.
# The build stage installs the whole workspace once; runtime images get only
# `pnpm deploy --prod` output (auth, bbs, ai) or static assets and routes (platform).

# Checksum-pinned New API source, with isolated subscription funding pools.
FROM oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6 AS ai-portal
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
COPY tools/ai/new-api /new-api
COPY tools/ai/portal/build.mjs tools/ai/portal/edits.json ./
RUN bun build.mjs /portal

FROM golang:1.26.1-alpine@sha256:2389ebfa5b7f43eeafbd6be0c3700cc46690ef842ad962f6c5bd6be49ed82039 AS ai-backend
ENV CGO_ENABLED=0 GOWORK=off
WORKDIR /build
COPY --from=ai-portal /portal/portal-source.tar.gz /tmp/source.tar.gz
RUN tar -xzf /tmp/source.tar.gz -C /build
COPY --from=ai-portal /portal /build/web/dist
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    go test ./model -run TestHerkules -count=1 && go build -ldflags "-s -w -X github.com/QuantumNous/new-api/common.Version=v1.0.0-rc.37-herkules-pools" -o /new-api .

FROM calciumion/new-api:v1.0.0-rc.37@sha256:8b6cf781e479e6dfcaa5f1ddd86f0e20f12352980029d0d0dfb35cf8cbd1792b AS new-api
COPY --from=ai-backend /new-api /new-api

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
RUN pnpm -r --sort run build
# --ignore-scripts again: `pnpm deploy` otherwise runs the root `prepare` (vp config), which wants git.
RUN pnpm --filter @herkules/auth deploy --prod --legacy --ignore-scripts /out/auth \
 && pnpm --filter @herkules/bbs deploy --prod --legacy --ignore-scripts /out/bbs \
 && pnpm --filter @herkules/feishu deploy --prod --legacy --ignore-scripts /out/feishu \
 && pnpm --filter @herkules/inference deploy --prod --legacy --ignore-scripts /out/inference

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
RUN apk add --no-cache tzdata ca-certificates && mkdir -p /data/avatars /data/grants && chown -R node:node /data
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=2s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/auth/healthz || exit 1
CMD ["node", "dist/main.mjs"]

# ── ai (the `ai` Compose profile: inference gateway + portal, and New API) ──
# Its own image, so an AI change neither rebuilds nor restarts auth. Compose runs it twice:
# `node /ai/dist/main.mjs` (inference) and `/new-api` (working_dir /data); both define their
# healthchecks there.
FROM runtime AS ai
COPY --from=build --chown=node:node /out/inference /ai
COPY --from=ai-portal --chown=node:node /portal /ai/portal
COPY --from=ai-backend /new-api /new-api
USER root
RUN apk add --no-cache tzdata ca-certificates && mkdir -p /data && chown node:node /data
USER node

# ── bbs (API + MCP + SPA; `files` carries dist/ and drizzle/) ───────────────
FROM runtime AS bbs
ENV PORT=3003 MIGRATIONS_DIR=/app/drizzle WEB_DIR=/app/dist/client
COPY --from=build --chown=node:node /out/bbs /app
EXPOSE 3003
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=2s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3003/healthz || exit 1
# ENTRYPOINT, not CMD: `docker compose run --rm bbs import /import/app.db` appends argv (main.ts dispatches).
ENTRYPOINT ["node", "dist/main.mjs"]

# Static platform artifact consumed by herkules-infra; never run as a service.
FROM scratch AS platform
COPY --from=build /app/services/web/dist /srv
COPY --from=build /app/apps/training/dist /srv/training
COPY tools/images/caddy /caddy
CMD ["/artifact-only"]
