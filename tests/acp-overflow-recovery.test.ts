import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, assertChatGptWebInputWithinLimits } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { compiledChatGptWebMaxMessageChars, estimateCompiledChatGptWebInputTokens, estimateCompiledChatGptWebMessageTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { chatGptTurnExecutionKey, chatGptTurnRetryKey } from "../src/adapters/chatgpt-web/turn-execution";
import { chatGptConversationKey } from "../src/adapters/chatgpt-web/conversation-key";
import { extractChatGptTurnIdentity, extractChatGptTurnUserRevision } from "../src/adapters/chatgpt-web/environment";
import { responseRequest } from "../src/server";
import { defaultConfig, providerConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { DSH_CHECKPOINT_PREAMBLE } from "../src/responses/dsh-context";
import { ChatGptWebAdapterError, chatGptRetainedConversationUnavailableError } from "../src/adapters/chatgpt-web/adapter-error";

const directive = readFileSync(new URL("./fixtures/dsh-compaction-instruction.txt", import.meta.url), "utf8").trim();

test("a browser overflow after submission reaches ACP as context_length_exceeded", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-acp-submitted-overflow-"));
  const broker = TurnBroker.forSocket(join(home, "broker.sock"));
  const fake = {
    async run(turn: any) {
      await turn.onPreparedSelected?.(false);
      const prompt = await turn.prepare();
      prompt.release();
      await turn.onSendActivated?.();
      turn.onSubmitted?.();
      throw new ChatGptWebAdapterError("ChatGPT rejected the submitted messages as too long. Compact the conversation before retrying.", {
        status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false,
      });
    },
    async releaseManagedConversation() {},
  };
  const spy = spyOn(ChatGptBrowserWorker, "forProvider").mockReturnValue(fake as any);
  try {
    const config = { ...defaultConfig(), purpose: "dsh" as const, brokerSocketPath: broker.socketPath,
      externalMcp: { connectorName: "local-shell-dsh", serverName: "dsh", workspace: home, sandboxPolicy: "workspaceWrite" as const } };
    const provider = providerConfig(config);
    provider.chatgptWeb!.threadEnvironmentStatePath = join(home, "environments.json");
    const adapter = createChatGptWebAdapter(provider, { broker });
    const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        model: "chatgpt-web/gpt-6-high", prompt_cache_key: "submitted-overflow-test",
        input: [{ role: "user", content: "Continue the investigation" }],
        tools: [{ type: "function", name: "bash", parameters: { type: "object" } }],
      }),
    }), config, () => adapter, { rememberState: false });
    const result = await response.json() as any;
    expect(result.status).toBe("failed");
    expect(result.error.code).toBe("context_length_exceeded");
  } finally {
    spy.mockRestore();
    await broker.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("an oversized ACP replay continues in the browser instead of failing with context_length_exceeded", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-acp-overflow-"));
  const broker = TurnBroker.forSocket(join(home, "broker.sock"));
  const summaries: string[] = [];
  const submitted: string[] = [];
  const fake = {
    async run(turn: any) {
      // This test starts without retained browser state, just like a restarted ACP client.
      if (turn.requireRetainedConversation) throw chatGptRetainedConversationUnavailableError();
      await turn.onPreparedSelected?.(false);
      const prompt = await turn.prepare();
      if (turn.traceId.includes("-compact-")) expect(turn.modelId).toBe("gpt-6");
      // Every prepared submission must stay inside the real browser transport gate. The adapter
      // recovers an oversized canonical replay by omitting the oldest complete turns, so this is
      // enforced against the submitted prompt rather than failing the turn.
      assertChatGptWebInputWithinLimits(estimateCompiledChatGptWebInputTokens(prompt, turn.modelId),
        estimateCompiledChatGptWebMessageTokens(prompt, turn.modelId), turn.modelId, "high", turn.capabilities,
        compiledChatGptWebMaxMessageChars(prompt));
      const summarizing = turn.traceId.includes("-compact-");
      if (summarizing) {
        expect(turn.capabilities.localToolsEnabled).toBe(false);
        expect(prompt.text).not.toContain("turn_token");
        summaries.push(prompt.text);
      } else {
        submitted.push(prompt.text);
      }
      const answer = summarizing ? "Recovered constraint: preserve existing files. Pending: continue the ACP investigation." : "CONTINUED";
      turn.onTextDelta(answer);
      prompt.release();
      return answer;
    },
    commitManagedConversation() {},
    async releaseManagedConversation() {},
  };
  const spy = spyOn(ChatGptBrowserWorker, "forProvider").mockReturnValue(fake as any);
  try {
    const config = { ...defaultConfig(), purpose: "dsh" as const, brokerSocketPath: broker.socketPath,
      externalMcp: { connectorName: "local-shell-dsh", serverName: "dsh", workspace: home, sandboxPolicy: "workspaceWrite" as const } };
    const provider = providerConfig(config);
    provider.chatgptWeb!.threadEnvironmentStatePath = join(home, "environments.json");
    const adapter = createChatGptWebAdapter(provider, { broker });
    const request = async (input: unknown[]) => responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        model: "chatgpt-web/gpt-6-high", prompt_cache_key: "acp-overflow-session", input,
        tools: [{ type: "function", name: "bash", description: "Run bash", parameters: { type: "object" } }],
      }),
    }), config, () => adapter, { rememberState: false });
    const current = { role: "user", content: "continue the ACP investigation" };
    const history = [{ role: "user", content: "preserve existing files\n" + "old verified source evidence ".repeat(40_000) },
      { role: "assistant", content: "The prior browser turn was interrupted" }, current];
    const first = await (await request(history)).json() as any;
    // ChatGPT Web owns its conversation and compacts it itself, so the browser replay is fitted to
    // the transport boundary and the same human turn continues instead of demanding /compact.
    expect(first.status).toBe("completed");
    expect(JSON.stringify(first.output)).toContain("CONTINUED");
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).not.toContain("old verified source evidence");
    expect(submitted[0]).toContain("continue the ACP investigation");
    const compact = await (await request([...history, { role: "user", content: directive }])).json() as any;
    expect(compact.status).toBe("completed");
    expect(summaries.length).toBeGreaterThan(2);
    // A checkpoint must summarize the complete canonical history, so transport fit recovery must
    // never trim it: every source fragment still carries the oldest evidence.
    expect(summaries.join("\n")).toContain("old verified source evidence");
    expect(compact.output.some((item: any) => item.type === "compaction")).toBe(false);
    const checkpoint = `${DSH_CHECKPOINT_PREAMBLE}\n\n<compacted-summary>\nRecovered constraint: preserve existing files.\n</compacted-summary>`;
    const replacement = [{ role: "user", content: checkpoint }, current];
    const parsed = (input: unknown[]) => parseRequest({ model: "gpt-6", prompt_cache_key: "acp-overflow-session", input });
    const before = parsed(history), after = parsed(replacement);
    expect(extractChatGptTurnIdentity(before)).toEqual(extractChatGptTurnIdentity(after));
    expect(extractChatGptTurnUserRevision(after)).toBe(current.content);
    expect(chatGptTurnExecutionKey(after)).not.toBe(chatGptTurnExecutionKey(before));
    expect(chatGptTurnRetryKey(after)).not.toBe(chatGptTurnRetryKey(before));
    expect(chatGptConversationKey(after, "test")).not.toBe(chatGptConversationKey(before, "test"));
    const final = await (await request(replacement)).json() as any;
    expect(final.status).toBe("completed");
    expect(JSON.stringify(final.output)).toContain("CONTINUED");
  } finally {
    spy.mockRestore();
    await broker.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a native ACP checkpoint keeps its execution epoch across sequential tool continuations", () => {
  const input = [
    { role: "user", content: [{ type: "input_text", text: `${DSH_CHECKPOINT_PREAMBLE}\n\n<compacted-summary>\nPrior verified work.\n</compacted-summary>` }] },
    { role: "user", content: "Continue checking the project" },
  ];
  const parse = (items: unknown[]) => parseRequest({ model: "gpt-6", prompt_cache_key: "acp-tool-continuation", input: items });
  const before = parse(input);
  const continuation = parse([...input,
    { type: "function_call", call_id: "call_one", name: "bash", arguments: "{}" },
    { type: "function_call_output", call_id: "call_one", output: "ONE" },
    { type: "function_call", call_id: "call_two", name: "bash", arguments: "{}" },
    { type: "function_call_output", call_id: "call_two", output: "TWO" },
  ]);
  expect(extractChatGptTurnIdentity(continuation)).toEqual(extractChatGptTurnIdentity(before));
  expect(chatGptTurnExecutionKey(continuation)).toBe(chatGptTurnExecutionKey(before));
  expect(chatGptTurnRetryKey(continuation)).toBe(chatGptTurnRetryKey(before));
  expect(chatGptConversationKey(continuation, "test")).toBe(chatGptConversationKey(before, "test"));
});
