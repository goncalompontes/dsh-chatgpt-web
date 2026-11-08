import { expect, test, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultConfig, providerConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { conversationHistoryFingerprint, conversationPredecessorFingerprint } from "../src/adapters/chatgpt-web/managed-conversation";
import { estimateChatGptWebInputTokens } from "../src/adapters/chatgpt-web/usage";
import { chatGptRetainedConversationUnavailableError } from "../src/adapters/chatgpt-web/adapter-error";
import type { AdapterEvent } from "../src/types";

test("adapter commits canonical history, resumes only its exact successor, and isolates compaction", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-managed-adapter-"));
  const broker = TurnBroker.forSocket(join(home, "broker.sock"));
  const commits = new Map<string, string>();
  const prompts: Array<{ text: string; resumed: boolean; retained: boolean }> = [];
  let lastEvents: AdapterEvent[] = [];
  const fake = {
    async run(turn: any) {
      const resumed = Boolean(turn.conversationKey && turn.conversationPredecessor
        && commits.get(turn.conversationKey) === turn.conversationPredecessor);
      if (turn.requireRetainedConversation && !resumed) throw chatGptRetainedConversationUnavailableError();
      await turn.onPreparedSelected?.(resumed);
      const compiled = await (resumed ? turn.prepareResume() : turn.prepare());
      prompts.push({ text: compiled.text, resumed, retained: Boolean(turn.retainConversation) });
      turn.onTextDelta("READY");
      compiled.release();
      return "READY";
    },
    commitManagedConversation(key: string, fingerprint: string) { commits.set(key, fingerprint); },
    async releaseManagedConversation(key: string) { commits.delete(key); },
  };
  const spy = spyOn(ChatGptBrowserWorker, "forProvider").mockReturnValue(fake as any);
  try {
    const provider = providerConfig({ ...defaultConfig(), purpose: "dsh", brokerSocketPath: join(home, "broker.sock"),
      externalMcp: { connectorName: "local-shell-dsh", serverName: "dsh", workspace: home, sandboxPolicy: "workspaceWrite" } });
    provider.chatgptWeb!.threadEnvironmentStatePath = join(home, "thread-environments.json");
    provider.chatgptWeb!.lunaCheckpointStatePath = join(home, "checkpoints.json");
    const adapter = createChatGptWebAdapter(provider, { broker });
    const initial = { role: "user", content: "remember ORIGINAL-HISTORY" };
    const run = async (input: unknown[], purpose?: string) => {
      const parsed = parseRequest({ model: "gpt-6", reasoning: { effort: "low" }, input,
        _dshSessionId: "isolated-test-session" });
      parsed._dshRequestPurpose = purpose;
      const events: AdapterEvent[] = [];
      await adapter.runTurn(parsed, { headers: new Headers() }, event => events.push(event));
      lastEvents = events;
      expect(events.find(event => event.type === "error")).toBeUndefined();
      expect(events.some(event => event.type === "done")).toBe(true);
      if (purpose === "compaction") {
        expect(events.filter(event => event.type === "text_delta").map(event => event.text).join(""))
          .not.toContain("Pure Chat Mode");
      }
      return parsed;
    };
    await run([initial]);
    const next = await run([initial, { role: "assistant", content: "READY" }, { role: "user", content: "continue" }]);
    expect(commits.size).toBe(1);
    expect(prompts[1]!.resumed).toBe(true);
    expect(prompts[1]!.text).not.toContain("ORIGINAL-HISTORY");
    expect(prompts[1]!.text).toContain("continue");
    expect(conversationPredecessorFingerprint(next.context.messages)).toBeDefined();
    // Model an idle chat that accumulated a large canonical history over earlier successful
    // turns. Its next request still transmits only the suffix, regardless of transcript size.
    const history = [initial, { role: "assistant", content: "READY" },
      { role: "user", content: "old transcript evidence ".repeat(40_000) }, { role: "assistant", content: "READY" }];
    commits.set([...commits.keys()][0]!, conversationHistoryFingerprint(parseRequest({ model: "gpt-6", input: history }).context.messages));
    const retained = await run([...history, { role: "user", content: "continue after the large transcript" }]);
    expect(prompts[2]!.resumed).toBe(true);
    expect(estimateChatGptWebInputTokens(retained, { localToolsEnabled: true, solAvailable: true, proAvailable: false,
      externalMcp: provider.chatgptWeb!.externalMcp })).toBeGreaterThan(90_000);
    const done = lastEvents.findLast(event => event.type === "done");
    expect(done?.type === "done" && done.stopReason).toBe("stop");
    expect(done?.type === "done" && done.usage?.inputScope).toBe("browser_submission");
    expect(done?.type === "done" && done.usage!.inputTokens).toBeLessThan(10_000);
    const beforeRetainedCheckpoint = prompts.length;
    await run([...(retained._rawBody as any).input, { role: "assistant", content: "READY" },
      { role: "user", content: "summarize all progress" }], "compaction");
    expect(prompts.length - beforeRetainedCheckpoint).toBe(1);
    expect(prompts[beforeRetainedCheckpoint]!.resumed).toBe(true);
    expect(prompts[beforeRetainedCheckpoint]!.text).not.toContain("old transcript evidence");
    await run([initial, { role: "assistant", content: "READY" }, { role: "user", content: "summarize" }], "compaction");
    expect(prompts.at(-1)!.retained).toBe(false);
    expect(prompts.at(-1)!.text).not.toContain("turn_token");
    // Oversized fresh compaction must process all history instead of failing at the same gate
    // that blocked /compact in the reported TUI session.
    const beforeCompaction = prompts.length;
    await run([...history, { role: "user", content: "summarize all progress including the oldest evidence" }], "compaction");
    expect(prompts.length - beforeCompaction).toBeGreaterThan(2);
    expect(prompts.slice(beforeCompaction).every(prompt => !prompt.retained)).toBe(true);
    expect(lastEvents.findLast(event => event.type === "done")).toMatchObject({
      stopReason: "stop", usage: { inputScope: "browser_submission", estimated: true },
    });
  } finally {
    spy.mockRestore();
    await broker.close();
    rmSync(home, { recursive: true, force: true });
  }
});
