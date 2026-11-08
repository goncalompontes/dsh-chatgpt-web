import { expect, test } from "bun:test";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { parseRequest } from "../src/responses/parser";

const capabilities = {
  localToolsEnabled: true, solAvailable: true, proAvailable: false,
  externalMcp: { connectorName: "local-shell-dsh", serverName: "dsh", workspace: "/workspace",
    sandboxPolicy: "workspaceWrite" as const },
};

test("external MCP carries the current profile's native schema and a DSH-only recovery route", () => {
  const parameters = { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] };
  const parsed = parseRequest({ model: "gpt-6", reasoning: { effort: "high" }, input: [
    { role: "user", content: "Inspect this project" },
  ], tools: [{ type: "function", name: "read", description: "Read a DSH file", parameters }] });
  const prompt = compileChatGptWebPrompt(parsed, capabilities, "turn_current_capability_12345").text;
  const inventory = JSON.parse(prompt.split("<dsh_tool_inventory_json>\n")[1]!.split("\n</dsh_tool_inventory_json>")[0]!);
  expect(inventory).toEqual([{ wire_name: "read", description: "Read a DSH file", kind: "function", parameters }]);
  expect(prompt).toContain('{"query":"dsh","server":"dsh","limit":100}');
  expect(prompt).toContain('name "dsh:<wire_name>"');
  expect(prompt).toContain("Do not use dsh:codex_tool_inventory or dsh:codex_tool_call for recovery");
  expect(prompt).not.toContain("only as a compatibility fallback");
  expect(prompt).toContain("Report an invalid-token failure only when an actual tool response proves it");
});

test("compaction never receives the DSH inventory or discovery instructions", () => {
  const parsed = parseRequest({ model: "gpt-6", input: [{ role: "user", content: "Summarize" }] });
  parsed._compactionRequest = true;
  const prompt = compileChatGptWebPrompt(parsed, { ...capabilities, localToolsEnabled: false, externalMcp: undefined }).text;
  expect(prompt).not.toContain("<dsh_tool_inventory_json>");
  expect(prompt).not.toContain("mcp_tool_search");
});
