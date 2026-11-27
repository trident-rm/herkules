import { defineConfig } from "vite-plus";

/** Tests for the portal's pure modules. The SPA's own build lives in web/vite.config.ts. */
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"] },
});
