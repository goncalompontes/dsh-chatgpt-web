import { expect, test } from "bun:test";
import { ManagedConversationPool, conversationHistoryFingerprint, conversationPredecessorFingerprint } from "../src/adapters/chatgpt-web/managed-conversation";
import { retainedConversationResumeRequest } from "../src/adapters/chatgpt-web/conversation-key";
import { parseRequest } from "../src/responses/parser";

class Page {
  closed = false;
  isClosed() { return this.closed; }
  async close() { this.closed = true; }
}

test("only an exact completed history reuses a managed conversation", async () => {
  const pool = new ManagedConversationPool<Page>(2);
  const page = new Page();
  await pool.put("session-one", page);
  pool.commit("session-one", "history-one");
  expect(await pool.take("session-two", "history-one")).toBeUndefined();
  expect(await pool.take("session-one", "history-one")).toBe(page);
  expect(page.closed).toBe(false);
  await pool.put("session-one", page);
  pool.commit("session-one", "history-one");
  expect(await pool.take("session-one", "edited-history")).toBeUndefined();
  expect(page.closed).toBe(true);
});

test("uncommitted, closed and evicted pages cannot lose canonical history", async () => {
  const pool = new ManagedConversationPool<Page>(1);
  const first = new Page(), second = new Page();
  await pool.put("one", first);
  expect(await pool.take("one", "uncommitted")).toBeUndefined();
  expect(first.closed).toBe(true);
  await pool.put("one", new Page());
  await pool.put("two", second);
  expect(await pool.take("one", "anything")).toBeUndefined();
  await pool.close();
  expect(second.closed).toBe(true);
});

test("canonical tool rounds and pi-ai replay metadata preserve the predecessor proof", () => {
  const input = [{ role: "user", content: "run two commands" },
    { type: "function_call", call_id: "call_1", name: "bash", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "ONE" }];
  const before = parseRequest({ model: "chatgpt-web/gpt-6-high", input });
  const expected = conversationHistoryFingerprint([...before.context.messages,
    { role: "assistant", content: [{ type: "text", text: "ONE" }], timestamp: 0 }]);
  const next = parseRequest({ model: "chatgpt-web/gpt-6-high", input: [...input,
    { role: "assistant", content: "ONE" }, { role: "user", content: "now TWO" }] });
  expect(conversationPredecessorFingerprint(next.context.messages)).toBe(expected);
  const resume = retainedConversationResumeRequest(next)!;
  expect(resume.context.messages).toHaveLength(1);
  expect(resume.context.messages[0]!.content).toBe("now TWO");
  const branch = parseRequest({ model: "chatgpt-web/gpt-6-high", input: [
    { role: "user", content: "different initial goal" }, ...input.slice(1),
    { role: "assistant", content: "ONE" }, { role: "user", content: "now TWO" }] });
  expect(conversationPredecessorFingerprint(branch.context.messages)).not.toBe(expected);
});
