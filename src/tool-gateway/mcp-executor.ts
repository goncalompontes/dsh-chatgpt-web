/**
 * Harness-agnostic MCP executor.
 *
 * When the bridge fronts a standard MCP server, `tool_call` can execute tools
 * over MCP instead of routing through a native harness adapter. This covers
 * T3's `/mcp`, OpenCode/Codex/Claude MCP servers, and any stdio or Streamable
 * HTTP MCP endpoint.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { BrokerToolResult } from "../adapters/chatgpt-web/turn-broker";

export type McpExecutorConfig =
  | {
    transport: "stdio";
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    /** Strip this prefix from the model-facing wire name before the MCP call. */
    namePrefix?: string;
  }
  | {
    transport: "http";
    url: string;
    headers?: Record<string, string>;
    /** Strip this prefix from the model-facing wire name before the MCP call. */
    namePrefix?: string;
  };

export interface ToolExecutor {
  call(
    wireName: string,
    payload: { arguments?: Record<string, unknown>; input?: string },
    signal?: AbortSignal,
  ): Promise<BrokerToolResult>;
  close(): Promise<void>;
}

function asToolResult(result: {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: unknown;
}): BrokerToolResult {
  return {
    content: Array.isArray(result.content) ? result.content : [],
    ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    ...(result.isError === true ? { isError: true } : {}),
    ...(result._meta !== undefined ? { _meta: result._meta } : {}),
  };
}

/** Wrap an already-connected MCP client. Used by tests and by the bridge. */
export function createMcpExecutor(client: Client, namePrefix?: string): ToolExecutor {
  return {
    async call(wireName, payload) {
      const name = namePrefix && wireName.startsWith(namePrefix)
        ? wireName.slice(namePrefix.length)
        : wireName;
      const args = payload.arguments ?? (payload.input === undefined ? {} : { input: payload.input });
      const result = await client.callTool({ name, arguments: args });
      return asToolResult(result as never);
    },
    async close() {
      await client.close();
    },
  };
}

/** Connect to a configured MCP server and return a reusable executor. */
export async function connectMcpExecutor(config: McpExecutorConfig): Promise<ToolExecutor> {
  const client = new Client({ name: "chatgpt-web-bridge", version: "1" });
  if (config.transport === "stdio") {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      ...(config.env === undefined ? {} : { env: config.env }),
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    });
    await client.connect(transport);
  } else {
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers ?? {} },
    });
    await client.connect(transport);
  }
  return createMcpExecutor(client, config.namePrefix);
}
