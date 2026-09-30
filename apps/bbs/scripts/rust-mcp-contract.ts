/** Regenerate Rust MCP metadata from the existing Node server contract. Run from apps/bbs. */
import { writeFile } from "node:fs/promises";
import { createFakeApp, connect, fetchVia, MCP_RESOURCE } from "../tests/helpers.ts";
const app = await createFakeApp();
const client = await connect(MCP_RESOURCE, await app.token(), fetchVia(app.app));
try {
  await writeFile(
    "rust/src/mcp-tools.json",
    JSON.stringify((await client.listTools()).tools, null, 2) + "\n",
  );
  await writeFile(
    "rust/src/mcp-resources.json",
    JSON.stringify(await client.listResourceTemplates(), null, 2) + "\n",
  );
} finally {
  await client.close();
  await app.close();
}
