import { test, expect } from "bun:test";
import { compactRequest, responseRequest } from "../src/server";
import { defaultConfig } from "../src/config";
import { extractChatGptTurnIdentity } from "../src/adapters/chatgpt-web/environment";
import type { CodexParsedRequest } from "../src/types";
import { readFileSync } from "node:fs";
import { isLegacyDshTextCompaction } from "../src/responses/dsh-context";
import { parseRequest } from "../src/responses/parser";

const nativeDirective = readFileSync(new URL("./fixtures/dsh-compaction-instruction.txt", import.meta.url), "utf8").trim();

test("DSH session/purpose headers identify a text-only compaction without the Codex item protocol", async () => {
  let captured: CodexParsedRequest | undefined;
  const request = new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST", headers: { "content-type": "application/json", "x-dsh-session-id": "dsh-test-session",
      "x-dsh-request-purpose": "compaction", "x-dsh-turn-id": "dsh-turn-9" }, body: JSON.stringify({
      model: "chatgpt-web/gpt-6-high", stream: false, input: [{ role: "user", content: "summarize the conversation" }],
      tools: [{ type: "function", name: "bash", parameters: { type: "object" } }],
    }),
  });
  const config = { ...defaultConfig(), purpose: "dsh" as const };
  const response = await responseRequest(request, config, () => ({ name: "test", async runTurn(parsed, _incoming, emit) {
    captured = parsed;
    emit({ type: "text_delta", text: "checkpoint" });
    emit({ type: "done", stopReason: "stop", endTurn: true });
  } }), { rememberState: false });
  expect(response.status).toBe(200);
  expect(captured!._dshRequestPurpose).toBe("compaction");
  expect(captured!.context.tools).toBeUndefined();
  expect(captured!._compactionRequest).toBeUndefined();
  expect(extractChatGptTurnIdentity(captured!).threadId).toBe("dsh-dsh-test-session-compaction");
  expect(extractChatGptTurnIdentity(captured!).turnId).toBe("dsh-turn-9");
  const data = await response.json() as any;
  expect(data.output.some((item: any) => item.type === "message")).toBe(true);
  expect(data.output.some((item: any) => item.type === "compaction")).toBe(false);
});

test("headerless ACP native compaction selects bounded text recovery and removes tool capabilities", async () => {
  let captured: CodexParsedRequest | undefined;
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      model: "chatgpt-web/gpt-6-high", input: [
        { role: "user", content: "Preserve the existing implementation and investigate the ACP failure" },
        { role: "assistant", content: "Work was interrupted before completion" },
        { role: "user", content: nativeDirective },
      ], tools: [{ type: "function", name: "bash", parameters: { type: "object" } }],
      tool_choice: "auto", parallel_tool_calls: true,
    }),
  }), { ...defaultConfig(), purpose: "dsh" }, () => ({ name: "capture", async runTurn(parsed, _incoming, emit) {
    captured = parsed;
    emit({ type: "text_delta", text: "checkpoint" });
    emit({ type: "done", stopReason: "stop", endTurn: true });
  } }), { rememberState: false });
  expect(response.status).toBe(200);
  expect(captured!._dshRequestPurpose).toBe("compaction");
  expect(captured!.context.tools).toBeUndefined();
  expect(captured!.options.toolChoice).toBeUndefined();
  expect(captured!.options.parallelToolCalls).toBeUndefined();
  expect(captured!._compactionRequest).toBeUndefined();
  const data = await response.json() as any;
  expect(data.output.some((item: any) => item.type === "compaction")).toBe(false);
});

test("legacy compaction compatibility requires the exact final native directive", () => {
  const parse = (input: unknown[]) => parseRequest({ model: "gpt-6", input });
  expect(isLegacyDshTextCompaction(parse([{ role: "user", content: nativeDirective }]))).toBe(true);
  expect(isLegacyDshTextCompaction(parse([{ role: "user", content: nativeDirective.replaceAll("\n", "\r\n") }]))).toBe(true);
  expect(isLegacyDshTextCompaction(parse([{ role: "user", content: "Please compact the old history" }]))).toBe(false);
  expect(isLegacyDshTextCompaction(parse([{ role: "user", content: nativeDirective },
    { role: "user", content: "Now fix the bug" }]))).toBe(false);
  expect(isLegacyDshTextCompaction(parse([{ role: "user", content: `Quoted template:\n${nativeDirective}` }]))).toBe(false);
  expect(isLegacyDshTextCompaction(parse([{ role: "user", content: nativeDirective.replace("Do NOT mention", "Mention") }]))).toBe(false);
  const explicitPurpose = parse([{ role: "user", content: nativeDirective }]);
  explicitPurpose._dshRequestPurpose = "title";
  expect(isLegacyDshTextCompaction(explicitPurpose)).toBe(false);
  delete explicitPurpose._dshRequestPurpose;
  explicitPurpose._compactionRequest = true;
  expect(isLegacyDshTextCompaction(explicitPurpose)).toBe(false);
});

test("DSH Responses compaction endpoint uses the text checkpoint protocol", async () => {
  let captured: CodexParsedRequest | undefined;
  const response = await compactRequest(new Request("http://127.0.0.1:17841/v1/responses/compact", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      model: "chatgpt-web/gpt-6-high",
      input: [{ role: "user", content: "Preserve this earlier work" }],
      tools: [{ type: "function", name: "bash", parameters: { type: "object" } }],
    }),
  }), { ...defaultConfig(), purpose: "dsh" }, () => ({ name: "capture", async runTurn(parsed, _incoming, emit) {
    captured = parsed;
    emit({ type: "text_delta", text: "Recovered checkpoint" });
    emit({ type: "done", stopReason: "stop", endTurn: true });
  } }), { });
  expect(response.status).toBe(200);
  expect(captured!._dshRequestPurpose).toBe("compaction");
  expect(captured!._compactionRequest).toBeUndefined();
  expect(captured!.context.tools).toBeUndefined();
  const data = await response.json() as any;
  expect(JSON.stringify(data.output)).toContain("Recovered checkpoint");
});
