import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

/**
 * The portal SPA. In dev this server is the portal origin (:4010) and forwards what the
 * Rust gateway owns to it on :4110, keeping the Host header so the gateway serves the
 * portal (AI_PORTAL_ORIGIN=http://localhost:4010). Run as `vp -C web dev`.
 */
const GATEWAY = "http://127.0.0.1:4110";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  server: {
    port: 4010,
    strictPort: true,
    proxy: Object.fromEntries(["/api", "/login", "/callback", "/logout"].map((p) => [p, GATEWAY])),
  },
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
    sourcemap: false,
  },
});
