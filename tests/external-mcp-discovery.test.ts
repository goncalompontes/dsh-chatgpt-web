import { expect, test } from "bun:test";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { parseRequest } from "../src/responses/parser";

const capabilities = {
  localToolsEnabled: true, solAvailable: true, proAvailable: false,
  externalMcp: { connectorName: "local-shell-dsh", serverName: "dsh", workspace: "/workspace",
    sandboxPolicy: "workspaceWrite" as const },
};

test("external MCP carries the current profile's native schema and the single tool_call route", () => {
  const parameters = { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] };
  const parsed = parseRequest({ model: "gpt-6", reasoning: { effort: "high" }, input: [
    { role: "user", content: "Inspect this project" },
  ], tools: [{ type: "function", name: "read", description: "Read a DSH file", parameters }] });
  const prompt = compileChatGptWebPrompt(parsed, capabilities, "turn_current_capability_12345").text;
  const inventory = JSON.parse(prompt.split("<dsh_tool_inventory_json>\n")[1]!.split("\n</dsh_tool_inventory_json>")[0]!);
  expect(inventory).toEqual([{ wire_name: "read", description: "Read a DSH file", kind: "function", parameters }]);
  expect(prompt).toContain("The connector exposes exactly one tool: tool_call");
  expect(prompt).toContain('"action":"inventory"');
  expect(prompt).toContain("tool_call.calls");
  expect(prompt).toContain("Report an unavailable tool instead");
  expect(prompt).toContain("Report an invalid-token failure only when an actual tool response proves it");
  expect(prompt).not.toContain("mcp_tool_search");
  expect(prompt).not.toContain("mcp_tool_call");
  expect(prompt).not.toContain("dsh_parallel");
});

test("compaction never receives the DSH inventory or discovery instructions", () => {
  const parsed = parseRequest({ model: "gpt-6", input: [{ role: "user", content: "Summarize" }] });
  parsed._compactionRequest = true;
  const prompt = compileChatGptWebPrompt(parsed, { ...capabilities, localToolsEnabled: false, externalMcp: undefined }).text;
  expect(prompt).not.toContain("<dsh_tool_inventory_json>");
  expect(prompt).not.toContain("tool_call");
});

test("a fresh browser with recorded tool results resumes remaining work instead of restarting", () => {
  const parsed = parseRequest({ model: "gpt-6", input: [
    { role: "user", content: "Run the marker command, then read README.md" },
    { role: "user", content: "Turn checkpoint: Pending: run the marker command, then read README.md" },
    { type: "function_call", call_id: "before-checkpoint", name: "bash", arguments: '{"command":"printf DONE"}' },
    { type: "function_call_output", call_id: "before-checkpoint", output: "DONE" },
  ] });
  const prompt = compileChatGptWebPrompt(parsed, capabilities, "turn_after_checkpoint");
  const context = JSON.parse(prompt.text.split("<codex_context_json>\n")[1]!.split("\n</codex_context_json>")[0]!);
  expect(context.messages.at(-1)).toMatchObject({ role: "tool_result", tool_call_id: "before-checkpoint" });
  expect(prompt.awaitingToolResultAnswer).toBe(true);
  expect(prompt.text.split("<dsh_transport_resume>")[1]).toContain("The last tool has already executed");
  expect(prompt.text.split("<dsh_transport_resume>")[1]).not.toContain("Execute the latest active user request now");
});
