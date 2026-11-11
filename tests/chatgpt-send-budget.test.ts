import { expect, test } from "bun:test";
import {
  CHATGPT_SEND_BUDGET_MAX_MS,
  CHATGPT_SEND_BUDGET_PER_CHAR_MS,
  browserStageTimeouts,
  chatGptSendBudgetMs,
} from "../src/adapters/chatgpt-web/browser-worker";

test("ordinary prompts keep the flat submission budget", () => {
  expect(chatGptSendBudgetMs(0)).toBe(browserStageTimeouts.send);
  expect(chatGptSendBudgetMs(1_000)).toBe(browserStageTimeouts.send);
  expect(chatGptSendBudgetMs(browserStageTimeouts.send / CHATGPT_SEND_BUDGET_PER_CHAR_MS))
    .toBe(browserStageTimeouts.send);
});

test("a large prompt gets acceptance time proportional to its payload", () => {
  // The observed failure: ~133k visible characters (~40k estimated tokens) reported
  // "stage=send failed durationMs=20251", which then surfaced as an ambiguous submission.
  const observedFailure = 133_403;
  expect(chatGptSendBudgetMs(observedFailure)).toBeGreaterThan(20_251);
  expect(chatGptSendBudgetMs(observedFailure)).toBe(66_702);
  expect(chatGptSendBudgetMs(observedFailure * 2)).toBeGreaterThan(chatGptSendBudgetMs(observedFailure));
});

test("the submission budget stays bounded for huge or invalid payloads", () => {
  expect(chatGptSendBudgetMs(10_000_000)).toBe(CHATGPT_SEND_BUDGET_MAX_MS);
  expect(chatGptSendBudgetMs(Number.NaN)).toBe(browserStageTimeouts.send);
  expect(chatGptSendBudgetMs(Number.POSITIVE_INFINITY)).toBe(browserStageTimeouts.send);
  expect(chatGptSendBudgetMs(-5)).toBe(browserStageTimeouts.send);
});
