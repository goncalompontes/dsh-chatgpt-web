import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertChatGptWebInputWithinLimits, ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import {
  compiledChatGptWebMaxMessageChars,
  estimateCompiledChatGptWebInputTokens,
  estimateCompiledChatGptWebMessageTokens,
} from "../src/adapters/chatgpt-web/input-tokens";
import { chatGptRetainedConversationUnavailableError } from "../src/adapters/chatgpt-web/adapter-error";
import {
  CHATGPT_WEB_MODEL_ROUTES,
  resolveChatGptWebContextLimits,
} from "../src/chatgpt-web-models";
import { buildChatGptWebModel } from "../src/model-catalog";
import { defaultConfig, providerConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent } from "../src/types";

const plusCapabilities = { solAvailable: true, proAvailable: false };

test("the catalog advertises the conversation capacity, not the browser message ceiling", () => {
  const limits = resolveChatGptWebContextLimits("gpt-6", "high", plusCapabilities);
  // The internal transport gate keeps the measured browser boundary.
  expect(limits.contextWindow).toBe(90_000);
  // The harness must not compact on the bridge's behalf: ChatGPT Web compacts its own chat.
  expect(limits.reportedContextWindow).toBe(1_050_000);
  expect(limits.reportedAutoCompactTokenLimit).toBe(1_050_000);

  const route = CHATGPT_WEB_MODEL_ROUTES.find(candidate => candidate.slug === "chatgpt-web/high")!;
  const model = buildChatGptWebModel({
    slug: "gpt-5.6-sol",
    visibility: "list",
    multi_agent_version: "v2",
    supported_reasoning_levels: [{ effort: "high", description: "native" }],
  }, route, defaultConfig());
  expect(model.context_window).toBe(1_050_000);
  expect(model.max_context_window).toBe(1_050_000);
  expect(model.auto_compact_token_limit).toBe(1_050_000);
  expect(model.effective_context_window_percent).toBe(100);
});

test("pure chat fits an oversized replay and then resumes the retained conversation", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-context-continuation-"));
  const broker = TurnBroker.forSocket(join(home, "broker.sock"));
  const commits = new Map<string, string>();
  const prompts: Array<{ text: string; resumed: boolean; retained: boolean }> = [];
  const fake = {
    async run(turn: any) {
      const resumed = Boolean(turn.conversationKey && turn.conversationPredecessor
        && commits.get(turn.conversationKey) === turn.conversationPredecessor);
      if (turn.requireRetainedConversation && !resumed) throw chatGptRetainedConversationUnavailableError();
      await turn.onPreparedSelected?.(resumed);
      const compiled = await (resumed && turn.prepareResume ? turn.prepareResume() : turn.prepare());
      prompts.push({ text: compiled.text, resumed, retained: Boolean(turn.retainConversation) });
      // The adapter must never hand the browser a prompt outside its real transport boundary.
      assertChatGptWebInputWithinLimits(
        estimateCompiledChatGptWebInputTokens(compiled, turn.modelId),
        estimateCompiledChatGptWebMessageTokens(compiled, turn.modelId),
        turn.modelId,
        turn.capabilities.localToolsEnabled ? "high" : "low",
        turn.capabilities,
        compiledChatGptWebMaxMessageChars(compiled),
      );
      turn.onTextDelta("READY");
      compiled.release();
      return "READY";
    },
    commitManagedConversation(key: string, fingerprint: string) { commits.set(key, fingerprint); },
    async releaseManagedConversation(key: string) { commits.delete(key); },
  };
  const spy = spyOn(ChatGptBrowserWorker, "forProvider").mockReturnValue(fake as any);
  try {
    const provider = providerConfig({
      ...defaultConfig(),
      purpose: "dsh" as const,
      brokerSocketPath: broker.socketPath,
    });
    const adapter = createChatGptWebAdapter(provider, { broker });
    const history = [
      { role: "user", content: "preserve the oldest requirement\n" + "old verified source evidence ".repeat(40_000) },
      { role: "assistant", content: "READY" },
      { role: "user", content: "continue the investigation" },
    ];
    const run = async (input: unknown[]) => {
      const parsed = parseRequest({ model: "gpt-6", reasoning: { effort: "low" }, input,
        _dshSessionId: "pure-chat-continuation" });
      const events: AdapterEvent[] = [];
      await adapter.runTurn(parsed, { headers: new Headers() }, event => events.push(event));
      expect(events.find(event => event.type === "error")).toBeUndefined();
      expect(events.some(event => event.type === "done")).toBe(true);
      return parsed;
    };

    // A fresh pure-chat replay keeps ChatGPT's conversation id but cannot replay the whole
    // transcript: the oldest complete turn is omitted and the newest turn continues.
    await run(history);
    expect(prompts[0]!.retained).toBe(true);
    expect(prompts[0]!.resumed).toBe(false);
    expect(prompts[0]!.text).not.toContain("old verified source evidence");
    expect(prompts[0]!.text).toContain("continue the investigation");
    expect(prompts[0]!.text).toContain("omitted earlier conversation history");
    expect(commits.size).toBe(1);

    // The completed chat is retained, so the next turn sends only its new instruction.
    await run([...history, { role: "assistant", content: "READY" }, { role: "user", content: "next step" }]);
    expect(prompts[1]!.resumed).toBe(true);
    expect(prompts[1]!.text).toContain("next step");
    expect(prompts[1]!.text).not.toContain("old verified source evidence");
    expect(prompts[1]!.text).not.toContain("omitted earlier conversation history");
  } finally {
    spy.mockRestore();
    await broker.close();
    rmSync(home, { recursive: true, force: true });
  }
});
