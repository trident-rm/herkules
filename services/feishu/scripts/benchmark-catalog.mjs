import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const sdk = require.resolve("@larksuiteoapi/node-sdk");
const entries = {
  full: require.resolve("@larksuiteoapi/lark-mcp/dist/mcp-tool/tools/index.js"),
  lean: fileURLToPath(new URL("../src/catalog.generated.ts", import.meta.url)),
};
const samples = { full: [], lean: [] };
// Fresh processes isolate caches; forced GC measures retained imports, not peak allocation.
for (let sample = 0; sample < 5; sample++) {
  for (const [mode, entry] of Object.entries(entries)) {
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--expose-gc",
          "--input-type=module",
          "-e",
          `
      await import(${JSON.stringify(sdk)});
      await import(${JSON.stringify(entry)});
      global.gc();
      const {rss, heapUsed} = process.memoryUsage();
      console.log(JSON.stringify({rss, heapUsed}));
    `,
        ],
        { encoding: "utf8" },
      ),
    );
    samples[mode].push(result);
  }
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summary = Object.fromEntries(
  Object.entries(samples).map(([mode, values]) => [
    mode,
    {
      rssMiB: median(values.map((value) => value.rss)) / 1048576,
      heapMiB: median(values.map((value) => value.heapUsed)) / 1048576,
    },
  ]),
);
console.log(
  JSON.stringify(
    {
      scope: "SDK and catalog imports only; five fresh processes per catalog; median after GC",
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      ...summary,
    },
    null,
    2,
  ),
);
