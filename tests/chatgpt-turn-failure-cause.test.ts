import { expect, test } from "bun:test";
import { chatGptTurnFailureCause, submittedTurnFailure } from "../src/adapters/chatgpt-web/index";

test("turn failure causes keep the concrete error class and message", () => {
  expect(chatGptTurnFailureCause(new TypeError("ChatGPT response DOM observation failed: timeout")))
    .toBe("TypeError: ChatGPT response DOM observation failed: timeout");
  expect(chatGptTurnFailureCause("locator.evaluate: Timeout 2000ms exceeded"))
    .toBe("locator.evaluate: Timeout 2000ms exceeded");
});

test("turn failure causes redact embedded Codex context and bounded turn ids", () => {
  const cause = chatGptTurnFailureCause(new Error(
    "<codex_context_json>{\"secret\":\"prompt\"}</codex_context_json> binding_abcdefghijklmnop",
  ));
  expect(cause).toContain("<codex_context_json>[redacted]</codex_context_json>");
  expect(cause).not.toContain("\"secret\"");
  expect(cause).toContain("binding_[redacted]");
});

test("turn failure causes are truncated", () => {
  const cause = chatGptTurnFailureCause(new Error("x".repeat(500)));
  expect(cause.length).toBe(200);
  expect(cause.endsWith("...")).toBe(true);
});

test("submitted-turn failures include the cause instead of hiding it", () => {
  const session = { runtime: { submission: { phase: "submitted" } } } as any;
  const failure = submittedTurnFailure(session, new Error("ChatGPT response DOM disappeared while the browser turn was active"));
  expect(failure.message).toContain("Cause: Error: ChatGPT response DOM disappeared");
});
