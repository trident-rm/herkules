import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/main.ts"],
    platform: "node",
    external: [/^@larksuiteoapi\//, /^@modelcontextprotocol\/sdk/],
  },
  test: { include: ["tests/**/*.test.ts"] },
});
