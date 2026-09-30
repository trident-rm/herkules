/**
 * Composition root and argv dispatcher. Boot order is dependency order; nothing
 * here has logic (services/auth/src/main.ts states the rule).
 *
 *   node dist/main.mjs                     serve: ensureDatabase, migrate (idempotent), rederive if stale, listen
 *   node dist/main.mjs migrate             manual one-shot (docker compose run --rm bbs migrate); serve migrates at boot anyway
 *   node dist/main.mjs work [--once]       the bbs-worker container / the manual check   (crawl/cli.ts)
 *   node dist/main.mjs bot                 the Feishu bot process                         (bot/cli.ts)
 *   node dist/main.mjs rederive [--force]  recompute derived columns                     (crawl/cli.ts)
 *   node dist/main.mjs import <app.db>     DEPRECATED: the cutover tool and dev loader    (import/cli.ts)
 *
 * Every arm is `(argv) => Promise<number>` and builds its own dependencies:
 * `work` returns before createService, so the worker never constructs the
 * Hono app, the OAuth client, the MCP handler or the SPA handler.
 *
 * The Docker target sets ENTRYPOINT ["node","dist/main.mjs"] so
 * `docker compose run --rm bbs work --once` appends arguments: one image, one
 * entrypoint, no `scripts/` directory that exists only in the repo.
 */
import { serve } from "@hono/node-server";
import { apiResource, mcpResource } from "@herkules/auth-middleware";
import { createOAuthClient } from "@herkules/oauth-client";
import { honoOAuth } from "@herkules/oauth-client/hono";
import { sql } from "drizzle-orm";

import { createApp } from "./app.ts";
import { runBotCli } from "./bot/cli.ts";
import { RESOURCE_NAME, loadConfig } from "./config.ts";
import { runMigrateCli, runRederiveCli, runWorkCli } from "./crawl/cli.ts";
import { noteArticleRead } from "./crawl/index.ts";
import { rederive } from "./crawl/rederive.ts";
import { createDb, ensureDatabase, migrate } from "./db/index.ts";
import { selectSearchIndex } from "./db/search/index.ts";
import { runImportCli } from "./import/cli.ts";
import { createLibrary } from "./library/index.ts";
import { withRustReads } from "./library/rust.ts";
import { createSpaHandler } from "./spa/static.ts";
import { createUserInfo } from "@herkules/auth-middleware/userinfo";

export interface ServiceDeps {
  readonly env?: NodeJS.ProcessEnv;
  /**
   * The single injected I/O boundary for outbound HTTP: JWKS, the token endpoint
   * and the user-info API. Tests route it in-process to the auth app with
   * `fetchVia(auth.app)`, which lets the whole suite run with no network and
   * no Docker.
   */
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
}

const COMMANDS: Record<string, (argv: readonly string[]) => Promise<number>> = {
  bot: (a) => runBotCli(a, { env: process.env }),
  import: (a) => runImportCli(a, { env: process.env }),
  migrate: (a) => runMigrateCli(a, { env: process.env }),
  rederive: (a) => runRederiveCli(a, { env: process.env }),
  work: (a) => runWorkCli(a, { env: process.env, fetch: globalThis.fetch }),
};

/** Builds the whole service without listening. Tests call this with pglite://memory and an in-process fetch. */
export async function createService(deps: ServiceDeps = {}) {
  const config = loadConfig(deps.env);
  const now = deps.now ?? (() => new Date());
  if (config.createDatabase) await ensureDatabase(config.databaseUrl);
  const db = await createDb(config.databaseUrl);
  // The serving container is what migrates (compose has no one-shot since 2026-08-28); idempotent, and every test boots a fresh pglite://memory.
  await migrate(db);
  await rederive(db, { now, log: (l) => console.log("[bbs]", l) }); // one SELECT when corpus_versions matches

  const search = selectSearchIndex(config.searchIndex, async (q) => db.execute(q));
  const localLibrary = createLibrary({ db, search });
  const library = config.rustReadOrigin
    ? withRustReads(localLibrary, { origin: config.rustReadOrigin, fetch: deps.fetch })
    : localLibrary;

  const jwksUrl = `${config.authInternal}/auth/jwks`;
  const api = apiResource({
    resource: config.apiResource,
    issuer: config.issuer,
    jwksUrl,
    fetch: deps.fetch,
  });
  const mcp = mcpResource({
    resource: config.mcpResource,
    issuer: config.issuer,
    jwksUrl,
    fetch: deps.fetch,
  });
  const client = createOAuthClient({
    auth: api,
    client: { id: RESOURCE_NAME, secret: config.clientSecret },
    origin: config.appOrigin,
    cookieSecret: config.cookieSecret,
    issuerInternal: `${config.authInternal}/auth`,
    fetch: deps.fetch,
    now: deps.now,
    onEvent: (e) => console.log("[bbs oauth]", e.kind),
  });
  const oauth = honoOAuth(client, {
    // A failed callback lands on the SPA's account page, which maps the code to a message (round 2).
    onLoginFailure: (f, c) =>
      c.redirect(`/account?login_error=${encodeURIComponent(f.error)}`, 303),
  });
  const userInfo = createUserInfo({ baseUrl: config.authInternal, fetch: deps.fetch });
  const spa = await createSpaHandler({
    webDir: config.webDir,
    library,
    appOrigin: config.appOrigin,
  });

  const { app, close } = createApp({
    library,
    oauth,
    mcp,
    userInfo,
    spa,
    appOrigin: config.appOrigin,
    ping: async () => {
      await db.execute(sql`select 1`);
    },
    onError: (err) => console.error("[bbs]", err),
    onArticleRead: (id) => noteArticleRead(db, id, now()),
  });
  console.log(`[bbs] redirect URI ${client.redirectUri} — must equal the issuer's seeded value`);
  return {
    app,
    config,
    db,
    library,
    close: async () => {
      await close();
      await db.close();
    },
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const name = argv[0];
  const command = name === undefined ? undefined : COMMANDS[name];
  if (command) process.exit(await command(argv.slice(1)));
  if (name !== undefined) throw new TypeError(`unknown bbs command: ${name}`);
  const service = await createService();
  const server = serve({ fetch: service.app.fetch, port: service.config.port }, (info) => {
    console.log(
      `bbs listening on :${info.port} as ${service.config.appOrigin} (mcp ${service.config.mcpResource})`,
    );
  });
  const shutdown = () => {
    server.close();
    void service.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[1] && /[/\\]main\.(ts|mjs|js)$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
