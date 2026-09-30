import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

/**
 * The SPA's build and dev server, separate from the package's `vite.config.ts`
 * (`vp pack`): two tools, two files, no shared `root`. Run as `vp -C web dev`
 * / `vp -C web build` (`root` is also set explicitly so a bare `vite` from
 * the package root agrees). In dev this server IS bbs's origin (:3003) and
 * forwards everything the Hono process owns to :3103.
 */
const HONO = "http://localhost:3103";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  server: {
    port: 3003,
    strictPort: true,
    proxy: Object.fromEntries(
      ["/api", "/login", "/callback", "/logout", "/healthz", "/mcp"].map((p) => [p, HONO]),
    ),
  },
  build: {
    manifest: true,
    outDir: "../dist/client",
    emptyOutDir: true,
    sourcemap: false,
    rolldownOptions: {
      input: {
        app: `${import.meta.dirname}/index.html`,
        ssr: `${import.meta.dirname}/src/ssr.css`,
      },
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
  define: {
    __PUBLIC_ORIGIN__: JSON.stringify(process.env.PUBLIC_ORIGIN ?? "https://herkules.dev"),
  },
});
