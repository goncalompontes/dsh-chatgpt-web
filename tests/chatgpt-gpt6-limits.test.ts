import { expect, test } from "bun:test";
import {
  assertChatGptWebInputWithinLimits,
  assertChatGptWebMultipartInputWithinLimits,
} from "../src/adapters/chatgpt-web/browser-worker";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { resolveChatGptWebTransportLimits } from "../src/chatgpt-web-models";
import { defaultConfig, resolveChatGptWebTuning, validateChatGptWebTuning } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { routeChatGptWebRequest } from "../src/server";

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
  expect(() => assertChatGptWebInputWithinLimits(31_000, 22_808, "gpt-6", "high", plusCapabilities,
    177_350, tuning.composerCharLimit)).not.toThrow();
  expect(() => assertChatGptWebInputWithinLimits(31_000, 22_808, "gpt-6", "high", plusCapabilities,
    177_350, 120_000)).toThrow(/120,000/);
  expect(validateChatGptWebTuning({ composerCharLimit: 211_256 })).toEqual({ composerCharLimit: 211_256 });
});

test("GPT-6 still enforces the Sol-class context window", () => {
  expect(() => assertChatGptWebInputWithinLimits(10_000_000, 100, "gpt-6", "low", plusCapabilities, 10))
    .toThrow(/exceeds the/);
});

test("a submission above the account's measured browser budget never reaches the browser", () => {
  // Observed Instant failure: a 40,765-token Instant submission passed the 41,000-token transport
  // window check and ChatGPT still rejected it as "too long", because the remaining margin belonged
  // to ChatGPT's own platform prompt. The submission budget is the boundary that leaves headroom.
  expect(() => assertChatGptWebInputWithinLimits(40_765, 32_573, "gpt-6", "low", plusCapabilities, 133_403))
    .toThrow(/32,000-token ChatGPT Web submission budget/);
  expect(() => assertChatGptWebInputWithinLimits(32_000, 23_808, "gpt-6", "low", plusCapabilities, 100_000))
    .not.toThrow();

  // Live 2026-11-11 Temporary Chat evidence on this Plus account (effort High). The same deployment
  // answered 44,450 estimated input tokens (trace 2c4c99edbab7, 144,316 characters) and rejected
  // 37,647 (trace 0c02745e9838, 118,154 characters), so no *visible message* boundary can explain
  // acceptance: a smaller payload was rejected while a larger one was answered. The route's
  // 90,000-token value is its model context window, not the browser request that ChatGPT compiles.
  expect(() => assertChatGptWebInputWithinLimits(45_059, 36_867, "gpt-6", "high", plusCapabilities, 115_320))
    .toThrow(/32,000-token ChatGPT Web submission budget/);
  expect(() => assertChatGptWebInputWithinLimits(37_647, 29_455, "gpt-6", "high", plusCapabilities, 118_154))
    .toThrow(/32,000-token ChatGPT Web submission budget/);
  expect(() => assertChatGptWebInputWithinLimits(51_347, 43_155, "gpt-6", "high", plusCapabilities, 145_551))
    .toThrow(/32,000-token ChatGPT Web submission budget/);
  expect(() => assertChatGptWebInputWithinLimits(51_415, 43_223, "gpt-5.6-sol", "high", plusCapabilities, 145_766))
    .toThrow(/32,000-token ChatGPT Web submission budget/);
  expect(() => assertChatGptWebInputWithinLimits(51_415, 43_223, "gpt-6", "medium", plusCapabilities, 145_766))
    .toThrow(/32,000-token ChatGPT Web submission budget/);
});

test("the High-effort temporary-chat overflow is stopped by the measured submission budget", () => {
  // Trace a9848e58328a. The preflight admitted the turn because the route's 1,048,572-character
  // composer limit covers 194,182 characters and the 80,000-token compaction fallback covers
  // 57,456 estimated input tokens; ChatGPT then rendered "The messages you submitted were too
  // long, please edit them and resubmit". The compiled request carried 57,456 estimated input
  // tokens, far above the 32,000-token budget that leaves room for ChatGPT's platform prompt. The
  // gate must therefore reject it before it reaches the composer so transportFits() runs the
  // history trim instead of submitting an oversized replay.
  expect(() => assertChatGptWebInputWithinLimits(
    57_456,
    49_264,
    "gpt-6",
    "high",
    plusCapabilities,
    194_182,
  )).toThrow(/32,000-token ChatGPT Web submission budget/);
});

test("the 2026-11-11 trace 978a32706515 rejection cannot reach the composer", () => {
  // This report. The browser logged input_tokens=41998, maxMessageChars=139909 and 33,806 visible
  // tokens for a GPT-6 High Plus turn, passed the preflight because only the message-token limit was
  // checked, and ChatGPT answered with "The message you submitted was too long, please edit it and
  // resubmit." (diagnostic 21-turn-failed.png) after remounting the temporary chat. The compiled
  // total is 9,998 tokens above the measured 32,000-token submission budget.
  expect(() => assertChatGptWebInputWithinLimits(
    41_998,
    33_806,
    "gpt-6",
    "high",
    plusCapabilities,
    139_909,
  )).toThrow(/32,000-token ChatGPT Web submission budget/);
  // The budget is a total-input boundary, so a payload that only fits it by counting a small
  // message must still fail: the same 33,806-token message is 9,806 visible tokens above the
  // 23,808-token message share of the budget and cannot be submitted alone.
  expect(() => assertChatGptWebInputWithinLimits(
    41_998,
    33_806,
    "gpt-5.6-sol",
    "medium",
    plusCapabilities,
    139_909,
  )).toThrow(/32,000-token ChatGPT Web submission budget/);
});

test("Plus routes expose the submission budget while keeping multipart staging intact", () => {
  // A composer accepting text is not ChatGPT accepting it, and a message boundary is not a request
  // boundary: the same deployment answered 44,450 input tokens and rejected 37,647.
  for (const modelId of ["gpt-6", "gpt-5.6-sol"] as const) {
    for (const effort of ["low", "medium", "high"] as const) {
      const limits = resolveChatGptWebTransportLimits(modelId, effort, plusCapabilities);
      expect(limits.browserSubmissionTokenLimit).toBe(32_000);
      // The composer boundary stays a separate, much larger surface.
      expect(limits.browserComposerCharLimit).toBe(
        effort === "low" ? 211_256 : 1_048_572,
      );
    }
    // The per-message value remains only as the Bigger Context staging ceiling.
    for (const effort of ["medium", "high"] as const) {
      expect(resolveChatGptWebTransportLimits(modelId, effort, plusCapabilities).browserMessageTokenLimit)
        .toBe(40_000);
    }
    expect(resolveChatGptWebTransportLimits(modelId, "low", plusCapabilities).browserMessageTokenLimit)
      .toBeUndefined();
  }
  // Pro routes keep their separately measured one-message boundaries; no Plus budget leaks into them.
  const pro = { ...plusCapabilities, proAvailable: true };
  expect(resolveChatGptWebTransportLimits("gpt-5.6-sol", "high", pro).browserSubmissionTokenLimit)
    .toBeUndefined();
  expect(resolveChatGptWebTransportLimits("gpt-5.6-sol", "high", pro).browserMessageTokenLimit)
    .toBe(103_000);
});

test("the last captured overflow replay is rejected by the submission budget", () => {
  // Trace 1f1d407c48b7 (2026-11-11T01:58Z, the last too-long failure before the first fix deployed)
  // submitted 199,224 characters and 54,035 visible tokens (62,227 with the platform reserve).
  expect(() => assertChatGptWebInputWithinLimits(62_227, 54_035, "gpt-6", "high", plusCapabilities, 199_224))
    .toThrow(/32,000-token ChatGPT Web submission budget/);
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

test("GPT-6 effort slugs pin the browser model row and the effort stop", () => {
  const cases = [
    ["chatgpt-web/gpt-6-light", "low", 0, "Instant (即时)"],
    ["chatgpt-web/gpt-6-medium", "medium", 1, "Medium (中等)"],
    ["chatgpt-web/gpt-6-high", "high", 2, "High (高)"],
  ] as const;
  const config = defaultConfig();
  for (const [slug, effort, uiEffortIndex, displayLabel] of cases) {
    const parsed = parseRequest({ model: slug, input: [{ role: "user", content: "ping" }] });
    routeChatGptWebRequest(parsed, config);
    expect(parsed.modelId).toBe("gpt-6");
    expect(parsed.options.reasoning).toBe(effort);
    expect(resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, plusCapabilities)).toMatchObject({
      modelId: "gpt-6",
      effort,
      uiEffortIndex,
      displayLabel,
    });
  }
  // The Sol slugs must keep the Sol row instead of silently using GPT-6.
  const sol = parseRequest({ model: "chatgpt-web/high", input: [{ role: "user", content: "ping" }] });
  routeChatGptWebRequest(sol, config);
  expect(sol.modelId).toBe("gpt-5.6-sol");
  expect(resolveChatGptWebModelMode(sol.modelId, sol.options.reasoning, plusCapabilities))
    .toMatchObject({ effort: "high", uiEffortIndex: 2, displayLabel: "High (高)" });
});
