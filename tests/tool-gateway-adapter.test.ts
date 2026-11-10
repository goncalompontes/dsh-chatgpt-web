import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolGatewayAdapter, type ToolGatewaySession } from "../src/tool-gateway/adapter";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { runChatGptMcpServer } from "../src/adapters/chatgpt-web/mcp-server";

test("a harness adapter registers a session and completes tool_call end to end", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tool-gateway-"));
  const socketPath = join(directory, "broker.sock");
  const broker = TurnBroker.forSocket(socketPath);
  await broker.listen();
  const adapter = ToolGatewayAdapter.connect(socketPath);
  const session: ToolGatewaySession = {
    cwd: directory,
    roots: [directory],
    writableRoots: [],
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    tools: [{
      name: "read",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { file_path: { type: "string" } },
        required: ["file_path"],
        additionalProperties: false,
      },
    }],
  };
  const token = await adapter.register(session, { traceId: "adapter-test" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await runChatGptMcpServer({ brokerSocketPath: socketPath, transport: serverTransport });
  const client = new Client({ name: "tool-gateway-adapter-test", version: "1" });
  await client.connect(clientTransport);
  const abort = new AbortController();
  const serving = adapter.run(token, call => ({
    content: [{ type: "text", text: `ok:${call.wireName}` }],
  }), abort.signal);
  try {
    const result = await client.callTool({
      name: "tool_call",
      arguments: {
        session_token: token,
        calls: [{ wire_name: "read", arguments: { file_path: "README.md" } }],
      },
    });
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as any).results[0].content).toEqual([
      { type: "text", text: "ok:read" },
    ]);
  } finally {
    abort.abort();
    await serving.catch(() => undefined);
    await client.close();
    await server.close();
    await broker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the adapter rejects an unknown tool without executing it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tool-gateway-"));
  const socketPath = join(directory, "broker.sock");
  const broker = TurnBroker.forSocket(socketPath);
  await broker.listen();
  const adapter = ToolGatewayAdapter.connect(socketPath);
  const token = await adapter.register({
    cwd: directory,
    roots: [directory],
    writableRoots: [],
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await runChatGptMcpServer({ brokerSocketPath: socketPath, transport: serverTransport });
  const client = new Client({ name: "tool-gateway-adapter-test", version: "1" });
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "tool_call",
      arguments: {
        session_token: token,
        calls: [{ wire_name: "write", arguments: {} }],
      },
    });
    expect(result.isError).toBe(true);
    expect(String((result.content as any)[0]?.text)).toContain("not available");
  } finally {
    await client.close();
    await server.close();
    await broker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
