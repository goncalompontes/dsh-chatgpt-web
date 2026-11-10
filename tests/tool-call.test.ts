import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runChatGptMcpServer } from "../src/adapters/chatgpt-web/mcp-server";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";

async function fixture(contract: "native" | "safe" = "native") {
  const directory = mkdtempSync(join(tmpdir(), "tool-call-"));
  const broker = TurnBroker.forSocket(join(directory, "broker.sock"));
  const environment: ChatGptTurnEnvironment = {
    cwd: directory, roots: [directory], writableRoots: [],
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    tools: [
      { name: "read", description: "Read a file", parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"], additionalProperties: false } },
      { name: "custom_freeform", description: "Native freeform fixture", freeform: true, parameters: {} },
    ],
  };
  const token = await broker.register(environment);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await runChatGptMcpServer({ brokerSocketPath: broker.socketPath, contract, transport: serverTransport });
  const client = new Client({ name: "tool-call-regression", version: "1" });
  await client.connect(clientTransport);
  return { broker, token, client, close: async () => {
    await client.close(); await server.close(); await broker.close();
    rmSync(directory, { recursive: true, force: true });
  } };
}

test("one tool_call delivers distinct native calls together and preserves mixed out-of-order results", async () => {
  const { broker, token, client, close } = await fixture();
  try {
    const waiting = broker.nextToolBatch(token);
    const response = client.callTool({ name: "tool_call", arguments: { session_token: token, calls: [
      { wire_name: "read", arguments: { file_path: "first" } },
      { wire_name: "read", arguments: { file_path: "missing" } },
      { wire_name: "custom_freeform", input: "third native input" },
    ] } });
    const batch = await waiting;
    expect(batch.map(call => call.wireName)).toEqual(["read", "read", "custom_freeform"]);
    expect(new Set(batch.map(call => call.callId)).size).toBe(3);
    expect(batch[2]).toMatchObject({ freeform: true, input: "third native input" });
    broker.completeTool(token, batch[2]!.callId, { content: [{ type: "image", mimeType: "image/png", data: "Zml4dHVyZS1pbWFnZQ==" }] });
    broker.completeTool(token, batch[1]!.callId, { isError: true, content: [{ type: "text", text: "file not found" }] });
    broker.completeTool(token, batch[0]!.callId, { content: [{ type: "text", text: "first succeeded" }] });
    const result = await response;
    expect(result.isError).toBe(true);
    const results = (result.structuredContent as any).results;
    expect(results.map((entry: any) => [entry.index, entry.wire_name, entry.isError === true])).toEqual([
      [0, "read", false], [1, "read", true], [2, "custom_freeform", false],
    ]);
    expect(results[0].content).toEqual([{ type: "text", text: "first succeeded" }]);
    expect(result.content).toContainEqual({ type: "image", mimeType: "image/png", data: "Zml4dHVyZS1pbWFnZQ==" });
    expect(broker.beginCompletionFence(token)).toBeDefined(); // No orphaned MCP activity.
  } finally { await close(); }
});

test("invalid later entries, unavailable tools and schema limits never dispatch a valid prefix", async () => {
  const { broker, token, client, close } = await fixture();
  try {
    const valid = { wire_name: "read", arguments: { file_path: "safe" } };
    for (const calls of [
      [valid, { wire_name: "unavailable", arguments: {} }],
      [valid, { wire_name: "custom_freeform", arguments: { bad: true }, input: "input" }],
    ]) {
      const result = await client.callTool({ name: "tool_call", arguments: { session_token: token, calls } });
      expect(result.isError).toBe(true);
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 20);
      try { await expect(broker.nextToolBatch(token, abort.signal)).rejects.toThrow("aborted"); }
      finally { clearTimeout(timeout); }
    }
    for (const calls of [[], Array.from({ length: 9 }, () => valid)]) {
      expect((await client.callTool({ name: "tool_call", arguments: { session_token: token, calls } })).isError).toBe(true);
    }
  } finally { await close(); }
});

test("inventory returns the live turn's tools with schemas", async () => {
  const { token, client, close } = await fixture();
  try {
    const result = await client.callTool({
      name: "tool_call",
      arguments: { session_token: token, action: "inventory", query: "read" },
    });
    expect(result.isError).not.toBe(true);
    const inventory = result.structuredContent as any;
    expect(inventory.total).toBe(1);
    expect(inventory.tools[0]).toMatchObject({
      wire_name: "read",
      kind: "function",
      parameters: { type: "object" },
    });
    expect(inventory.next_offset).toBeNull();
  } finally { await close(); }
});

test("the connector exposes only tool_call in the native contract and nothing in Zero Risk", async () => {
  const native = await fixture("native");
  try {
    expect((await native.client.listTools()).tools.map(tool => tool.name)).toEqual(["tool_call"]);
  } finally { await native.close(); }
  const safe = await fixture("safe");
  try {
    const names = (await safe.client.listTools()).tools.map(tool => tool.name);
    expect(names).not.toContain("tool_call");
    expect(names).not.toContain("dsh_parallel");
  } finally { await safe.close(); }
});
