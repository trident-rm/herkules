import { defineConfig } from "vite-plus";

export default defineConfig({
  // A service, not a library: one entry, no dts, bundled for the container image.
  pack: {
    entry: ["src/main.ts"],
    platform: "node",
    // Better Auth and drizzle stay external: they load plugin schemas by path at runtime.
    external: [
      /^better-auth/,
      /^@better-auth\//,
      /^drizzle-orm/,
      "postgres",
      "@electric-sql/pglite",
    ],
  },
  test: {
    // PGlite + fake GitHub: no services needed. Integration tests live next to unit tests.
    include: ["tests/**/*.test.ts"],
    testTimeout: 20_000,
    // Each integration worker starts PGlite; cap concurrent databases on developer machines.
    maxWorkers: 2,
  },
});
