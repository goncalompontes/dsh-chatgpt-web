import { expect, test } from "bun:test";
import {
  assertChatGptWebInputWithinLimits,
  assertChatGptWebMultipartInputWithinLimits,
} from "../src/adapters/chatgpt-web/browser-worker";
import { resolveChatGptWebTuning, validateChatGptWebTuning } from "../src/config";

const plusCapabilities = {
  localToolsEnabled: true,
  solAvailable: true,
  proAvailable: false,
  experimentalBiggerContext: false,
};

test("GPT-6 turns are not rejected by the Plus transport limit gate", () => {
  expect(() => assertChatGptWebInputWithinLimits(100, 100, "gpt-6", "low", plusCapabilities, 10)).not.toThrow();
  expect(() => assertChatGptWebInputWithinLimits(100, 100, "gpt-6", "medium", plusCapabilities, 10)).not.toThrow();
  expect(() => assertChatGptWebInputWithinLimits(100, 100, "gpt-6", "high", plusCapabilities, 10)).not.toThrow();
});

test("default tuning preserves model-specific composer boundaries instead of Luna's 120k cap", () => {
  const tuning = resolveChatGptWebTuning();
  expect(tuning.composerCharLimit).toBeUndefined();
  expect(() => assertChatGptWebInputWithinLimits(50_000, 40_000, "gpt-6", "high", plusCapabilities,
    177_350, tuning.composerCharLimit)).not.toThrow();
  expect(() => assertChatGptWebInputWithinLimits(50_000, 40_000, "gpt-6", "high", plusCapabilities,
    177_350, 120_000)).toThrow(/120,000/);
  expect(validateChatGptWebTuning({ composerCharLimit: 211_256 })).toEqual({ composerCharLimit: 211_256 });
});

test("GPT-6 still enforces the Sol-class context window", () => {
  expect(() => assertChatGptWebInputWithinLimits(10_000_000, 100, "gpt-6", "low", plusCapabilities, 10))
    .toThrow(/exceeds the/);
});

test("a submission above the route's compaction threshold never reaches the browser", () => {
  // Observed failure: a 40,765-token Instant submission passed the 41,000-token transport window
  // check and ChatGPT still rejected it as "too long", because the remaining margin belonged to
  // ChatGPT's own platform prompt. The compaction threshold is the boundary that leaves headroom.
  expect(() => assertChatGptWebInputWithinLimits(40_765, 40_765, "gpt-6", "low", plusCapabilities, 133_403))
    .toThrow(/32,000-token ChatGPT Web submission boundary/);
  expect(() => assertChatGptWebInputWithinLimits(32_000, 32_000, "gpt-6", "low", plusCapabilities, 100_000))
    .not.toThrow();
  expect(() => assertChatGptWebInputWithinLimits(80_001, 80_001, "gpt-6", "high", plusCapabilities, 200_000))
    .toThrow(/80,000-token ChatGPT Web submission boundary/);
  expect(() => assertChatGptWebInputWithinLimits(80_000, 80_000, "gpt-6", "high", plusCapabilities, 200_000))
    .not.toThrow();
});

test("unknown models are still rejected", () => {
  expect(() => assertChatGptWebInputWithinLimits(100, 100, "gpt-9", "low", plusCapabilities, 10))
    .toThrow(/context limit is not defined for model: gpt-9/);
});

test("GPT-6 reaches Bigger Context instead of the model gate", () => {
  let message = "";
  try {
    assertChatGptWebMultipartInputWithinLimits(100, 100, "gpt-6", "low", plusCapabilities, 1_000, 2);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).not.toMatch(/not defined for model/);
});

test("Luna is still refused by Bigger Context", () => {
  expect(() => assertChatGptWebMultipartInputWithinLimits(100, 100, "gpt-5.6-luna", "low", plusCapabilities, 1_000, 2))
    .toThrow(/Bigger Context is unavailable for Luna/);
});
