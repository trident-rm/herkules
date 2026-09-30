import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

/**
 * Dev: this server IS the public origin (http://localhost:3000), so the auth
 * service and BBS run with PUBLIC_ORIGIN=http://localhost:3000 and are reached
 * through the proxy exactly as Caddy routes them in production.
 */
const AUTH = "http://localhost:3001";
const BBS = "http://localhost:3103"; // apps/bbs's Hono process; its SPA dev server on :3003 is a separate origin

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3000,
    strictPort: true,
    proxy: {
      "/auth": AUTH,
      "/.well-known": AUTH,
      "/mcp/bbs": BBS,
    },
  },
  build: {
    sourcemap: false,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // Keep the shared React runtime cacheable across application changes.
            {
              name: "react-vendor",
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
            },
          ],
        },
      },
    },
  },
  test: {
    // Pure modules only (api client, dev-token flow, formatting); the flow test runs the real auth service on PGlite.
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    // Integration workers start PGlite databases; keep concurrent instances bounded.
    maxWorkers: 2,
  },
});
