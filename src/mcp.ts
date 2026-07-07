import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolResult } from "./render.js";

export interface ToolInfo {
  name: string;
  description?: string;
}

export interface ConnectedClient {
  listTools(): Promise<{ tools: ToolInfo[] }>;
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<ToolResult>;
  close(): Promise<void>;
}

export type ClientFactory = (endpoint: string) => Promise<ConnectedClient>;

/** Open one MCP connection over Streamable HTTP. Caller must close(). */
export const connect: ClientFactory = async (endpoint: string) => {
  const client = new Client({ name: "playwright-mcp-cli", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint));
  try {
    await client.connect(transport);
  } catch (e) {
    await transport.close().catch(() => {});
    throw e;
  }

  return {
    listTools: () => client.listTools(),
    callTool: (params) => client.callTool(params) as Promise<ToolResult>,
    close: () => client.close(),
  };
};
