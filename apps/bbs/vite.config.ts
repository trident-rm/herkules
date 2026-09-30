import { defineConfig } from "vite-plus";

/**
 * A service AND (round 2) a SPA from one package:
 *   `vp pack`  → dist/main.mjs      the Node process; drizzle/postgres/pglite/node:sqlite stay external
 *   `vp build` → dist/client/**     the SPA (round 2 adds `root: "web"`, `build.outDir`, and the dev
 *                                   proxy: Vite on :3003 IS the app origin and forwards /api, /login,
 *                                   /callback, /logout, /healthz, /mcp to the Hono process on :3103)
 * `files: ["dist", "drizzle"]` carries both outputs through `pnpm deploy --prod`.
 */
export default defineConfig({
  pack: {
    entry: ["src/main.ts"],
    platform: "node",
    // `dist/client` (the SPA) lives beside main.mjs; a bare `vp pack` must not delete it.
    clean: false,
    external: [/^drizzle-orm/, "postgres", /^@electric-sql\/pglite/, "node:sqlite"],
  },
  test: {
    include: ["tests/**/*.test.ts", "web/tests/**/*.test.ts"],
    testTimeout: 20_000,
    // Integration workers start PGlite databases; keep concurrent instances bounded.
    maxWorkers: 2,
  },
});
