import { Client as LarkClient } from "@larksuiteoapi/node-sdk";
import { selectedTools, userToolNames, botToolNames } from "./catalog.generated.ts";
import { filterTools } from "@larksuiteoapi/lark-mcp/dist/mcp-tool/utils/filter-tools.js";
import { TokenMode } from "@larksuiteoapi/lark-mcp/dist/mcp-tool/types/index.js";
import { larkOapiHandler } from "@larksuiteoapi/lark-mcp/dist/mcp-tool/utils/handler.js";
import { logger } from "@larksuiteoapi/lark-mcp/dist/utils/logger.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.ts";
import { MCP_PATH } from "./config.ts";
import type { Grants } from "./grants.ts";
import { ConnectionError } from "./grants.ts";

// Upstream logs errors and request details to disk. This gateway owns safe logging.
for (const method of ["log", "error", "warn", "info", "debug"] as const) logger[method] = () => {};
const quiet = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };

export function createTools(config: Config, grants: Grants) {
  const client = new LarkClient({
    appId: config.FEISHU_APP_ID,
    appSecret: config.FEISHU_APP_SECRET,
    logger: quiet,
  });
  const user = filterTools(selectedTools, {
    tokenMode: TokenMode.USER_ACCESS_TOKEN,
    allowTools: userToolNames,
  });
  const bot = filterTools(selectedTools, {
    tokenMode: TokenMode.TENANT_ACCESS_TOKEN,
    allowTools: botToolNames,
  });

  return (subject: string) => {
    const server = new McpServer(
      { name: "herkules-feishu", version: "1.0.0" },
      {
        instructions: `Feishu user tools always act as the authenticated member. Tools prefixed bot_ act as the shared Herkules MCP application, not the member. Ask the person before sending messages, changing calendars/data, or adding collaborators. Connect or reconnect your own Feishu account at ${config.PUBLIC_ORIGIN}${MCP_PATH}/connect.`,
      },
    );
    server.registerTool(
      "feishu_connection_status",
      {
        description: "Check whether your own Feishu account is connected and obtain the setup URL.",
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              connected: await grants.connected(subject),
              setupUrl: `${config.PUBLIC_ORIGIN}${MCP_PATH}/connect`,
            }),
          },
        ],
      }),
    );

    for (const [definition, asUser] of [
      [user, true],
      [bot, false],
    ] as const) {
      for (const tool of definition) {
        const name = `${asUser ? "" : "bot_"}${tool.name.replaceAll(".", "_")}`;
        const readOnly = /\.(get|list|search|rawContent|primary|batchGetId|getNode)$/.test(
          tool.name,
        );
        server.registerTool(
          name,
          {
            description: `${asUser ? "Your Feishu account" : "Shared application identity"}: ${tool.description}`,
            inputSchema: tool.schema,
            annotations: {
              readOnlyHint: readOnly,
              destructiveHint: !readOnly,
              openWorldHint: true,
            },
          },
          async (params: Record<string, unknown>): Promise<CallToolResult> => {
            try {
              // A caller must authorize their own account even to use the shared bot.
              const accessToken = await grants.accessToken(subject);
              const handler = tool.customHandler ?? larkOapiHandler;
              const result = await handler(
                client,
                { ...params, useUAT: asUser },
                {
                  tool,
                  ...(asUser ? { userAccessToken: accessToken } : {}),
                },
              );
              // Upstream handlers serialize API errors; never let credentials enter a result.
              return {
                ...result,
                content: result.content.map((item) =>
                  item.type === "text"
                    ? {
                        ...item,
                        text: item.text
                          .replaceAll(accessToken, "[redacted]")
                          .replaceAll(config.FEISHU_APP_SECRET, "[redacted]"),
                      }
                    : item,
                ),
              };
            } catch (error) {
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text:
                      error instanceof ConnectionError
                        ? `${error.message} ${config.PUBLIC_ORIGIN}${MCP_PATH}/connect`
                        : "Feishu request failed. Read the current state before retrying a change.",
                  },
                ],
              };
            }
          },
        );
      }
    }
    return server;
  };
}
