import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { startScheduleRunner } from "./scheduler.js";
import { registerTools } from "./tools/register.js";

const server = new McpServer({ name: "social-media-mcp", version: "1.0.0" });
await startScheduleRunner();
registerTools(server);
await server.connect(new StdioServerTransport());