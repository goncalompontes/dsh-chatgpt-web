import { expect, test } from "bun:test";
import {
  chatGptHasT3SubagentTools,
  chatGptRoutedToolInventory,
  chatGptSubagentRoutingContract,
} from "../src/adapters/chatgpt-web/prompt";
import type { CodexTool } from "../src/types";

const tool = (name: string, namespace?: string): CodexTool =>
  ({ name, namespace, description: name, parameters: { type: "object" } }) as CodexTool;

test("T3 delegation is detected from the session tool inventory", () => {
  expect(chatGptHasT3SubagentTools([tool("delegate_task", "t3-code")])).toBe(true);
  expect(chatGptHasT3SubagentTools([tool("create_threads", "t3-code")])).toBe(true);
  expect(chatGptHasT3SubagentTools([tool("subagent"), tool("bash")])).toBe(false);
});

test("native collaboration tools are hidden only when T3 delegation exists", () => {
  const native = [tool("subagent"), tool("subagent_fork"), tool("send_message"), tool("list_agents")];
  const t3 = [tool("delegate_task", "t3-code"), tool("bash")];
  const routed = chatGptRoutedToolInventory([...native, ...t3]);
  expect(routed.map(item => item.name)).toEqual(["delegate_task", "bash"]);
  // Without T3 delegation the native tools remain available.
  expect(chatGptRoutedToolInventory(native).map(item => item.name))
    .toEqual(["subagent", "subagent_fork", "send_message", "list_agents"]);
});

test("the prompt routes subagent work through T3 and explains the visibility problem", () => {
  const contract = chatGptSubagentRoutingContract([tool("delegate_task", "t3-code")]);
  expect(contract.join(" ")).toContain("delegate_task");
  expect(contract.join(" ")).toContain("create_threads");
  expect(contract.join(" ")).toContain("not registered in the T3 subagent list");
  expect(chatGptSubagentRoutingContract([tool("subagent")])).toEqual([]);
});
