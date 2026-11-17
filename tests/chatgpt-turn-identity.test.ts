import { expect, test } from "bun:test";
import { chatGptTurnIdentityIsStable } from "../src/adapters/chatgpt-web/browser-worker";

// Observed in diagnostics browser-turns/76956558babd-9784e84b: the Nov 17 renderer scopes a
// search unit key with the conversation UUID instead of the retired `fallback-turn-<n>` token.
const CONVERSATION_SCOPED_ASSISTANT = "af452a82-e53d-5a9a-adc1-8f1bffa69c14:2:assistant";

test("conversation-scoped search unit keys are stable turn identities", () => {
  expect(chatGptTurnIdentityIsStable(CONVERSATION_SCOPED_ASSISTANT, "assistant")).toBe(true);
  expect(chatGptTurnIdentityIsStable("af452a82-e53d-5a9a-adc1-8f1bffa69c14:1:user", "user")).toBe(true);
  // The previous scope format obeys the same `<scope>:<index>:<role>` contract.
  expect(chatGptTurnIdentityIsStable("fallback-turn-2:1:assistant", "assistant")).toBe(true);
  // Legacy test ids carry the identity without a role suffix.
  expect(chatGptTurnIdentityIsStable("conversation-turn-7", "assistant")).toBe(true);
});

test("a key for the other role, without an index, or without identity is not stable", () => {
  expect(chatGptTurnIdentityIsStable("af452a82-e53d-5a9a-adc1-8f1bffa69c14:2:user", "assistant")).toBe(false);
  expect(chatGptTurnIdentityIsStable("fallback-turn-2:assistant", "assistant")).toBe(false);
  expect(chatGptTurnIdentityIsStable("some-testid", "assistant")).toBe(false);
  expect(chatGptTurnIdentityIsStable("", "assistant")).toBe(false);
  expect(chatGptTurnIdentityIsStable(null, "assistant")).toBe(false);
});
