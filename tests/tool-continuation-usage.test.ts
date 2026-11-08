import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { TurnBroker, callTurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultConfig, providerConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { bridgeToResponsesSSE } from "../src/bridge";
import type { AdapterEvent } from "../src/types";

test("sequential MCP continuations account only for delivered results and preserve successful stop", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-usage-"));
  const broker = TurnBroker.forSocket(join(home, "broker.sock"));
  const results: unknown[] = [];
  const fake = {
    async run(turn: any) {
      const prompt = await turn.prepare();
      const token = prompt.text.match(/turn_[a-zA-Z0-9_-]{32}/)![0];
      const { bindingId } = await callTurnBroker<{ bindingId: string }>(broker.socketPath, { method: "claim", token });
      for (const value of ["ONE", "TWO"]) {
        const observed = turn.externalProgress.waitForChange(turn.externalProgress.snapshot().revision)
          .then((snapshot: any) => turn.externalProgress.acknowledgeToolBatch(snapshot.lastToolBatchRevision));
        const [result] = await Promise.all([callTurnBroker(broker.socketPath, { method: "invoke", bindingId,
          wireName: "bash", arguments: { command: `echo ${value}`, description: `Echo ${value}` } }), observed]);
        results.push(result);
      }
      prompt.release();
      turn.onTextDelta("ONE and TWO");
      return "ONE and TWO";
    },
    commitManagedConversation() {},
    async releaseManagedConversation() {},
  };
  const spy = spyOn(ChatGptBrowserWorker, "forProvider").mockReturnValue(fake as any);
  try {
    const provider = providerConfig({ ...defaultConfig(), purpose: "dsh", brokerSocketPath: broker.socketPath,
      externalMcp: { connectorName: "local-shell-dsh", serverName: "dsh", workspace: home, sandboxPolicy: "workspaceWrite" } });
    provider.chatgptWeb!.threadEnvironmentStatePath = join(home, "environments.json");
    const adapter = createChatGptWebAdapter(provider, { broker });
    const input: unknown[] = [{ role: "user", content: "echo ONE, then TWO" }];
    const rounds: AdapterEvent[][] = [];
    for (let index = 0; index < 3; index++) {
      const parsed = parseRequest({ model: "gpt-6", reasoning: { effort: "low" }, _dshSessionId: "usage-test",
        input, tools: [{ type: "function", name: "bash", description: "Run bash", parameters: { type: "object" } }] });
      const events: AdapterEvent[] = [];
      await adapter.runTurn(parsed, { headers: new Headers(), abortSignal: AbortSignal.timeout(5_000) }, event => events.push(event));
      rounds.push(events);
      expect(events.find(event => event.type === "error")).toBeUndefined();
      const call = events.find(event => event.type === "tool_call_start");
      if (index < 2) {
        expect(call).toBeDefined();
        if (call?.type !== "tool_call_start") throw new Error("Expected tool call");
        input.push({ type: "function_call", call_id: call.id, name: "bash", arguments: "{}" },
          { type: "function_call_output", call_id: `${call.id}|provider-response`, output: index === 0 ? "ONE" : "TWO" });
      }
    }
    expect(results).toHaveLength(2);
    expect(rounds[0]!.find(event => event.type === "done")).toMatchObject({ usage: { inputScope: "browser_submission" } });
    for (const round of rounds.slice(1)) {
      const done = round.find(event => event.type === "done");
      expect(done).toMatchObject({ usage: { inputScope: "tool_results", estimated: true } });
      expect(done?.type === "done" && done.usage!.inputTokens).toBeLessThan(100);
    }
    expect(rounds[2]!.find(event => event.type === "done")).toMatchObject({ stopReason: "stop", endTurn: true });
    async function* terminalEvents() { yield* rounds[2]!; }
    const sse = await new Response(bridgeToResponsesSSE(terminalEvents(), "gpt-6")).text();
    expect(sse).toContain('"estimated":true');
    expect(sse).toContain('"input_tokens_scope":"tool_results"');
    expect(sse).toContain("response.completed");
    expect(sse).toContain("[DONE]");
    // A reconnect after DSH refreshes contextual metadata must retain the terminal accounting.
    const replay = parseRequest({ model: "gpt-6", reasoning: { effort: "low" }, _dshSessionId: "usage-test",
      input: [...input, { role: "user", content: "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\nclock=updated" }],
      tools: [{ type: "function", name: "bash", description: "Run bash", parameters: { type: "object" } }] });
    const replayEvents: AdapterEvent[] = [];
    await adapter.runTurn(replay, { headers: new Headers() }, event => replayEvents.push(event));
    expect(replayEvents.find(event => event.type === "done")).toMatchObject({
      stopReason: "stop", usage: { inputScope: "tool_results" },
    });
    expect(results).toHaveLength(2);
  } finally {
    spy.mockRestore();
    await broker.close();
    rmSync(home, { recursive: true, force: true });
  }
});
