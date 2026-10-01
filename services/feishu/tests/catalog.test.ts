import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { expect, test } from "vite-plus/test";
import { z } from "zod";
import { AllTools } from "@larksuiteoapi/lark-mcp/dist/mcp-tool/tools/index.js";
import { presetTools } from "@larksuiteoapi/lark-mcp/dist/mcp-tool/constants.js";
import { filterTools } from "@larksuiteoapi/lark-mcp/dist/mcp-tool/utils/filter-tools.js";
import { TokenMode } from "@larksuiteoapi/lark-mcp/dist/mcp-tool/types/index.js";
import { selectedTools, userToolNames, botToolNames } from "../src/catalog.generated.ts";

// Compare the actual upstream definition and schema, including defaults and constraints.
test("the lean catalog preserves upstream user/bot selection and every schema", () => {
  expect(userToolNames).toEqual([
    ...new Set([...presetTools["preset.default"], ...presetTools["preset.calendar.default"]]),
  ]);
  for (const [allowTools, tokenMode, count] of [
    [userToolNames, TokenMode.USER_ACCESS_TOKEN, 20],
    [botToolNames, TokenMode.TENANT_ACCESS_TOKEN, 5],
  ] as const) {
    const old = filterTools(AllTools, { allowTools: [...allowTools], tokenMode });
    const lean = filterTools(selectedTools, { allowTools: [...allowTools], tokenMode });
    expect(lean).toHaveLength(count);
    expect(lean.map((tool) => tool.name)).toEqual(old.map((tool) => tool.name));
    for (const [index, tool] of lean.entries()) {
      const { schema, ...metadata } = tool;
      const { schema: original, ...originalMetadata } = old[index]!;
      expect(metadata).toEqual(originalMetadata);
      expect(z.toJSONSchema(z.object(schema))).toEqual(z.toJSONSchema(z.object(original)));
    }
  }
});

test("runtime imports never load the generated API families or translated catalog", () => {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("../src/tools.ts");
  const modules = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { createRequire } from "node:module";
      await import(${JSON.stringify(entry)});
      const require = createRequire(import.meta.url);
      console.log(JSON.stringify(Object.keys(require.cache)));
    `,
      ],
      { encoding: "utf8" },
    ),
  ) as string[];
  expect(modules.some((path) => path.includes("/tools/en/gen-tools/"))).toBe(false);
  expect(modules.some((path) => path.includes("/tools/zh/"))).toBe(false);
});
