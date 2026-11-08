import { expect, test } from "bun:test";
import { ManagedConversationPool, conversationHistoryFingerprint, conversationPredecessorFingerprint } from "../src/adapters/chatgpt-web/managed-conversation";
import { chatGptConversationKey, retainedConversationResumeRequest } from "../src/adapters/chatgpt-web/conversation-key";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
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
  expect(resume.context.messages).toHaveLength(2);
  expect(resume.context.messages[0]!.role).toBe("assistant");
  expect(resume.context.messages[0]!.content).toEqual([{ type: "text", text: "ONE" }]);
  expect(resume.context.messages[1]!.content).toBe("now TWO");
  const branch = parseRequest({ model: "chatgpt-web/gpt-6-high", input: [
    { role: "user", content: "different initial goal" }, ...input.slice(1),
    { role: "assistant", content: "ONE" }, { role: "user", content: "now TWO" }] });
  expect(conversationPredecessorFingerprint(branch.context.messages)).not.toBe(expected);
});

test("ambiguous follow-ups carry their own preceding answer across concurrent topics", () => {
  const make = (session: string, answer: string) => parseRequest({
    model: "gpt-6", _dshSessionId: session, input: [
      { role: "user", content: "Please research the available information." },
      { role: "assistant", content: answer },
      { role: "user", content: "Are there iPhone apps that already have all this information?" },
    ],
  });
  const transit = make("transit-session", "Metro Lisboa, CP trains and Carris buses: LISBON_TOPIC_REFERENCE");
  const vista = make("vista-session", "Vista streams Linux Wayland applications: VISTA_TOPIC_REFERENCE");
  expect(chatGptConversationKey(transit, "provider")).not.toBe(chatGptConversationKey(vista, "provider"));
  for (const [input, own, other] of [[transit, "LISBON_TOPIC_REFERENCE", "VISTA_TOPIC_REFERENCE"],
    [vista, "VISTA_TOPIC_REFERENCE", "LISBON_TOPIC_REFERENCE"]] as const) {
    const resume = retainedConversationResumeRequest(input)!;
    const compiled = compileChatGptWebPrompt(resume, { localToolsEnabled: false, solAvailable: true, proAvailable: false });
    expect(compiled.text).toContain(own);
    expect(compiled.text).not.toContain(other);
    expect(compiled.text).toContain("Are there iPhone apps");
    expect(compiled.text).toContain("Do not substitute topics from ChatGPT account memories");
  }
});
