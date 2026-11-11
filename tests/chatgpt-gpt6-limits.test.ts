import { expect, test } from "bun:test";
import {
  assertChatGptWebInputWithinLimits,
  assertChatGptWebMultipartInputWithinLimits,
} from "../src/adapters/chatgpt-web/browser-worker";
import { resolveChatGptWebTransportLimits } from "../src/chatgpt-web-models";
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

test("a submission above the route's measured one-message boundary never reaches the browser", () => {
  // Observed Instant failure: a 40,765-token Instant submission passed the 41,000-token transport
  // window check and ChatGPT still rejected it as "too long", because the remaining margin belonged
  // to ChatGPT's own platform prompt. The compaction threshold is the boundary that leaves headroom.
  expect(() => assertChatGptWebInputWithinLimits(40_765, 40_765, "gpt-6", "low", plusCapabilities, 133_403))
    .toThrow(/32,000-token ChatGPT Web submission boundary/);
  expect(() => assertChatGptWebInputWithinLimits(32_000, 32_000, "gpt-6", "low", plusCapabilities, 100_000))
    .not.toThrow();

  // Live 2026-11-11 Temporary Chat evidence on this Plus account (effort High). The accepted
  // submission (trace 9c61bb446812) carried 36,867 visible message tokens, 45,059 with the platform
  // reserve, and 115,320 characters. The rejected submission (trace f2781d4b9926) carried 43,155 /
  // 51,347 / 145,551 and ChatGPT remounted the chat with "The message you submitted was too long".
  // The route's 90,000-token value is its model context window, not the size of one browser message,
  // so the old preflight let both payloads reach the composer.
  expect(() => assertChatGptWebInputWithinLimits(45_059, 36_867, "gpt-6", "high", plusCapabilities, 115_320))
    .not.toThrow();
  expect(() => assertChatGptWebInputWithinLimits(51_347, 43_155, "gpt-6", "high", plusCapabilities, 145_551))
    .toThrow(/40,000-token ChatGPT browser message boundary/);
  expect(() => assertChatGptWebInputWithinLimits(51_415, 43_223, "gpt-5.6-sol", "high", plusCapabilities, 145_766))
    .toThrow(/40,000-token ChatGPT browser message boundary/);
  expect(() => assertChatGptWebInputWithinLimits(51_415, 43_223, "gpt-6", "medium", plusCapabilities, 145_766))
    .toThrow(/40,000-token ChatGPT browser message boundary/);
});

test("the High-effort temporary-chat overflow is stopped by the measured message boundary", () => {
  // Trace a9848e58328a (this report). The preflight admitted the turn because the route's
  // 1,048,572-character composer limit covers 194,182 characters and the 80,000-token compaction
  // fallback covers 57,456 estimated input tokens; ChatGPT then rendered "The messages you
  // submitted were too long, please edit them and resubmit" (diagnostic 19-turn-failed.png). The
  // single compiled message carried 49,264 visible tokens (57,456 minus the 8,192 platform
  // reserve), which is above the measured 40,000-token one-message acceptance boundary. The gate
  // must therefore reject it as a browser *message* boundary before it reaches the composer, so
  // transportFits() runs the history trim instead of submitting an oversized replay.
  expect(() => assertChatGptWebInputWithinLimits(
    57_456,
    49_264,
    "gpt-6",
    "high",
    plusCapabilities,
    194_182,
  )).toThrow(/40,000-token ChatGPT browser message boundary/);
});

test("Plus medium/high routes expose a measured one-message boundary, not just a composer box", () => {
  // The 2026-11-11 sentinel failure happened because the transport model returned only a composer
  // character limit for these routes, so the preflight fell through to the 80,000-token compaction
  // threshold. A composer accepting text is not ChatGPT accepting it.
  for (const modelId of ["gpt-6", "gpt-5.6-sol"] as const) {
    for (const effort of ["medium", "high"] as const) {
      const limits = resolveChatGptWebTransportLimits(modelId, effort, plusCapabilities);
      expect(limits.browserMessageTokenLimit).toBe(40_000);
      // The composer boundary stays a separate, much larger surface.
      expect(limits.browserComposerCharLimit).toBe(1_048_572);
    }
  }
  // Instant keeps its own measured message boundary; it must not inherit the medium/high one.
  expect(resolveChatGptWebTransportLimits("gpt-6", "low", plusCapabilities).browserMessageTokenLimit)
    .toBeUndefined();
});

test("the last captured overflow replay is rejected while the largest answered one still passes", () => {
  // Trace 1f1d407c48b7 (2026-11-11T01:58Z, the last too-long failure before the fix deployed)
  // submitted 199,224 characters and 54,035 visible tokens (62,227 with the platform reserve).
  expect(() => assertChatGptWebInputWithinLimits(62_227, 54_035, "gpt-6", "high", plusCapabilities, 199_224))
    .toThrow(/40,000-token ChatGPT browser message boundary/);

  // The largest submission that ChatGPT actually answered on this deployment stays admissible.
  expect(() => assertChatGptWebInputWithinLimits(45_059, 36_867, "gpt-6", "high", plusCapabilities, 115_320))
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
