import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createGrants } from "./grants.ts";
import { createSeal } from "./seal.ts";

const config = loadConfig(process.env);
const seal = createSeal(Buffer.from(config.FEISHU_STORAGE_KEY, "hex"));
const grants = createGrants({ config, seal });
const app = createApp(config, grants, seal);
serve({ fetch: app.fetch, port: config.PORT });
console.info(`Feishu MCP listening on port ${config.PORT}`);
