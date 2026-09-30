import { z } from "zod";

export const FEISHU_DOMAIN = "https://open.feishu.cn";
export const MCP_PATH = "/mcp/feishu";
export const FEISHU_SCOPES = [
  "offline_access",
  "docx:document:readonly",
  "drive:drive",
  "wiki:wiki",
  "bitable:app",
  "im:chat",
  "calendar:calendar",
  "calendar:calendar:readonly",
] as const;

const schema = z.object({
  PUBLIC_ORIGIN: z.url(),
  AUTH_INTERNAL_URL: z.url(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3005),
  FEISHU_APP_ID: z.string().min(1),
  FEISHU_APP_SECRET: z.string().min(1),
  FEISHU_TENANT_KEY: z.string().min(1),
  FEISHU_STORAGE_KEY: z.string().regex(/^[0-9a-f]{64}$/i),
  GRANTS_DIR: z.string().min(1).default("/data/grants"),
});
export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const config = schema.parse(env);
  const origin = new URL(config.PUBLIC_ORIGIN);
  if (origin.origin !== config.PUBLIC_ORIGIN || !["https:", "http:"].includes(origin.protocol))
    throw new Error("PUBLIC_ORIGIN must be an exact HTTP(S) origin");
  if (origin.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(origin.hostname))
    throw new Error("PUBLIC_ORIGIN requires HTTPS outside loopback");
  const internal = new URL(config.AUTH_INTERNAL_URL);
  if (
    internal.origin !== config.AUTH_INTERNAL_URL ||
    !["http:", "https:"].includes(internal.protocol)
  )
    throw new Error("AUTH_INTERNAL_URL must be an exact origin");
  return config;
}
