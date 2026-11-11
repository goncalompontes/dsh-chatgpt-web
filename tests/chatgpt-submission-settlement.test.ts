import { expect, test } from "bun:test";
import {
  ChatGptBrowserStageTimeoutError,
  chatGptActivatedSubmissionSettlement,
} from "../src/adapters/chatgpt-web/browser-worker";

test("submission DOM evidence settles an activated send as accepted", () => {
  for (const evidence of ["user_turn", "assistant_turn", "generation_running", "mcp_tool_call"] as const) {
    expect(chatGptActivatedSubmissionSettlement({ evidence, composerText: "", submittedPromptText: "prompt" }))
      .toEqual({ kind: "accepted", evidence });
  }
});

test("a composer still holding the submitted prompt proves the send never happened", () => {
  const prompt = `Continue the investigation.\n\n${"tool output ".repeat(400)}END-OF-PROMPT`;
  expect(chatGptActivatedSubmissionSettlement({
    composerText: prompt.replace(/\s+/g, " "), submittedPromptText: prompt,
  })).toEqual({ kind: "not_submitted" });
  // ChatGPT re-renders whitespace and zero-width characters in the composer; the tail still proves it.
  expect(chatGptActivatedSubmissionSettlement({
    composerText: `  ${prompt.replace(/\n/g, "\u00a0")}\u200b `, submittedPromptText: prompt,
  })).toEqual({ kind: "not_submitted" });
});

test("an emptied composer proves the prompt left the input while it is still ingesting", () => {
  const prompt = "Continue the investigation with the next patch";
  expect(chatGptActivatedSubmissionSettlement({ composerText: "", submittedPromptText: prompt }))
    .toEqual({ kind: "accepted", evidence: "composer_cleared" });
  // The prompt may keep trailing whitespace in the DOM after the editor re-renders it away.
  expect(chatGptActivatedSubmissionSettlement({ composerText: "\u00a0\u200b ", submittedPromptText: prompt }))
    .toEqual({ kind: "accepted", evidence: "composer_cleared" });
});

test("an unrecognized composer state stays unknown rather than inventing an outcome", () => {
  const prompt = "Continue the investigation with the next patch";
  expect(chatGptActivatedSubmissionSettlement({ composerText: "unrelated draft", submittedPromptText: prompt }))
    .toEqual({ kind: "unknown" });
  expect(chatGptActivatedSubmissionSettlement({ composerText: prompt })).toEqual({ kind: "unknown" });
  expect(chatGptActivatedSubmissionSettlement({})).toEqual({ kind: "unknown" });
});

test("a stage timeout keeps the historical message but is typed for settlement", () => {
  const error = new ChatGptBrowserStageTimeoutError("send", 20_000);
  expect(error.message).toBe("ChatGPT browser stage timed out: send");
  expect(error.stage).toBe("send");
  expect(error.timeoutMs).toBe(20_000);
  expect(error).toBeInstanceOf(Error);
});
