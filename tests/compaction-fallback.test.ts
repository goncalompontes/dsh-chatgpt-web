import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import {
  LOCAL_COMPACTION_FALLBACK_MARKER,
  buildLocalCompactionFallback,
} from "../src/adapters/chatgpt-web/local-compaction";
import { responseRequest } from "../src/server";
import { defaultConfig, providerConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { DSH_CHECKPOINT_PREAMBLE } from "../src/responses/dsh-context";
import { decodeCompactionSummary } from "../src/responses/compaction";

const directive = readFileSync(new URL("./fixtures/dsh-compaction-instruction.txt", import.meta.url), "utf8").trim();

test("the local fallback preserves the latest objective, paths, errors, and a bounded transcript", () => {
  const parsed = parseRequest({
    model: "gpt-6",
    prompt_cache_key: "fallback-unit",
    input: [
      { role: "user", content: "Preserve the existing implementation and fix /home/pontes/project/src/server.ts" },
      { role: "assistant", content: "The prior browser turn was interrupted." },
      { type: "function_call", call_id: "call_1", name: "bash", arguments: "{\"cmd\":\"bun test\"}" },
      { type: "function_call_output", call_id: "call_1", output: "error: the test failed with timeout after 30s" },
      { role: "user", content: "Continue from the verified checkpoint and keep the files unchanged." },
      { role: "user", content: directive },
    ],
  });
  const fallback = buildLocalCompactionFallback(parsed, "chatgpt_response_detached");
  expect(fallback).toContain(LOCAL_COMPACTION_FALLBACK_MARKER);
  expect(fallback).toContain("## Primary Request and Intent");
  expect(fallback).toContain("Continue from the verified checkpoint");
  expect(fallback).toContain("/home/pontes/project/src/server.ts");
  expect(fallback).toContain("timeout");
  expect(fallback).not.toContain("You are now acting as a compaction engine");
  expect(fallback.length).toBeLessThan(50_000);
});

test("a browser compaction failure returns a local checkpoint and the next user turn completes", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-compaction-fallback-"));
  const broker = TurnBroker.forSocket(join(home, "broker.sock"));
  const compactionFailures: string[] = [];
  const completedUserTurns: string[] = [];
  const fake = {
    async run(turn: any) {
      if (turn.compaction) {
        compactionFailures.push(turn.traceId);
        throw new ChatGptWebAdapterError(
          "ChatGPT opened another user turn while the bound assistant response was detached",
          {
            status: 502,
            errorType: "server_error",
            code: "chatgpt_response_detached",
            retryable: false,
            phase: "observing",
            retryDisposition: "none",
          },
        );
      }
      await turn.onPreparedSelected?.(false);
      const prompt = await turn.prepare();
      prompt.release();
      await turn.onSendActivated?.();
      turn.onSubmitted?.();
      turn.onTextDelta("CONTINUED_AFTER_COMPACTION");
      completedUserTurns.push(turn.traceId);
      return "CONTINUED_AFTER_COMPACTION";
    },
    commitManagedConversation() {},
    async releaseManagedConversation() {},
  };
  const spy = spyOn(ChatGptBrowserWorker, "forProvider").mockReturnValue(fake as any);
  try {
    const config = {
      ...defaultConfig(),
      purpose: "dsh" as const,
      brokerSocketPath: broker.socketPath,
      externalMcp: {
        connectorName: "local-shell-dsh",
        serverName: "dsh",
        workspace: home,
        sandboxPolicy: "workspaceWrite" as const,
      },
    };
    const provider = providerConfig(config);
    provider.chatgptWeb!.threadEnvironmentStatePath = join(home, "environments.json");
    const adapter = createChatGptWebAdapter(provider, { broker });
    const request = async (input: unknown[], session: string) => responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web/gpt-6-high",
        prompt_cache_key: session,
        input,
        tools: [{ type: "function", name: "bash", parameters: { type: "object" } }],
      }),
    }), config, () => adapter, { rememberState: false });

    const current = { role: "user", content: "Continue the investigation without repeating executed tools." };
    const history = [
      { role: "user", content: "Preserve the existing implementation.\n" + "verified source evidence ".repeat(4_000) },
      { role: "assistant", content: "The previous browser turn was interrupted before completion." },
      current,
    ];

    for (let iteration = 0; iteration < 5; iteration += 1) {
      const session = `compaction-fallback-${iteration}`;
      const compact = await (await request([...history, { role: "user", content: directive }], session)).json() as any;
      expect(compact.status).toBe("completed");
      expect(compact.error).toBeUndefined();
      const compactText = JSON.stringify(compact.output);
      expect(compactText).toContain(LOCAL_COMPACTION_FALLBACK_MARKER);
      expect(compactText).toContain("## Primary Request and Intent");

      const checkpoint = `${DSH_CHECKPOINT_PREAMBLE}\n\n<compacted-summary>\n${compactText}\n</compacted-summary>`;
      const final = await (await request([
        { role: "user", content: checkpoint },
        current,
      ], `${session}-turn`)).json() as any;
      expect(final.status).toBe("completed");
      expect(final.error).toBeUndefined();
      expect(JSON.stringify(final.output)).toContain("CONTINUED_AFTER_COMPACTION");
    }
    expect(compactionFailures).toHaveLength(5);
    expect(completedUserTurns).toHaveLength(5);
  } finally {
    spy.mockRestore();
    await broker.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a structured compaction browser failure also returns a local checkpoint", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-structured-compaction-fallback-"));
  const broker = TurnBroker.forSocket(join(home, "broker.sock"));
  const fake = {
    async run(turn: any) {
      if (turn.compaction) {
        throw new ChatGptWebAdapterError(
          "ChatGPT response DOM disappeared while the browser turn was active",
          {
            status: 502,
            errorType: "server_error",
            code: "chatgpt_response_dom_lost",
            retryable: false,
            phase: "observing",
            retryDisposition: "none",
          },
        );
      }
      await turn.onPreparedSelected?.(false);
      const prompt = await turn.prepare();
      prompt.release();
      await turn.onSendActivated?.();
      turn.onSubmitted?.();
      turn.onTextDelta("CONTINUED_AFTER_STRUCTURED_COMPACTION");
      return "CONTINUED_AFTER_STRUCTURED_COMPACTION";
    },
    commitManagedConversation() {},
    async releaseManagedConversation() {},
  };
  const spy = spyOn(ChatGptBrowserWorker, "forProvider").mockReturnValue(fake as any);
  try {
    const config = {
      ...defaultConfig(),
      purpose: "dsh" as const,
      browserHost: "launcher" as const,
      browserHostDescriptorPath: join(home, "launcher-descriptor.json"),
      brokerSocketPath: broker.socketPath,
      externalMcp: {
        connectorName: "local-shell-dsh",
        serverName: "dsh",
        workspace: home,
        sandboxPolicy: "workspaceWrite" as const,
      },
    };
    const provider = providerConfig(config);
    provider.chatgptWeb!.threadEnvironmentStatePath = join(home, "environments.json");
    const adapter = createChatGptWebAdapter(provider, { broker });
    const request = async (input: unknown[], session: string) => responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web/gpt-6-high",
        prompt_cache_key: session,
        input,
        tools: [{ type: "function", name: "bash", parameters: { type: "object" } }],
      }),
    }), config, () => adapter, { rememberState: false });

    const current = { role: "user", content: "Continue the structured compaction test." };
    const compact = await (await request([
      { role: "user", content: "Preserve the existing implementation and keep src/server.ts intact." },
      { role: "assistant", content: "The browser compaction was interrupted." },
      { type: "compaction_trigger" },
    ], "structured-compaction-fallback")).json() as any;
    expect(compact.status, JSON.stringify(compact.error)).toBe("completed");
    expect(compact.error).toBeUndefined();
    const compactionItem = (compact.output as any[]).find(item => item.type === "compaction");
    expect(compactionItem).toBeDefined();
    const compactText = decodeCompactionSummary(compactionItem.encrypted_content);
    expect(compactText).toContain(LOCAL_COMPACTION_FALLBACK_MARKER);
    expect(compactText).toContain("src/server.ts");
    expect(compactText).not.toContain("You are performing a CONTEXT CHECKPOINT COMPACTION");

    const checkpoint = `${DSH_CHECKPOINT_PREAMBLE}\n\n<compacted-summary>\n${compactText}\n</compacted-summary>`;
    const final = await (await request([
      { role: "user", content: checkpoint },
      current,
    ], "structured-compaction-fallback-turn")).json() as any;
    expect(final.status).toBe("completed");
    expect(JSON.stringify(final.output)).toContain("CONTINUED_AFTER_STRUCTURED_COMPACTION");
  } finally {
    spy.mockRestore();
    await broker.close();
    rmSync(home, { recursive: true, force: true });
  }
});
