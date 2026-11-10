import { expect, test } from "bun:test";
import { chatGptDomObservationTimeoutMs } from "../src/adapters/chatgpt-web/browser-worker";

test("the response snapshot budget scales with concurrent browser turns", () => {
  expect(chatGptDomObservationTimeoutMs()).toBe(2_000);
  expect(chatGptDomObservationTimeoutMs(1)).toBe(2_000);
  expect(chatGptDomObservationTimeoutMs(2)).toBe(2_750);
  expect(chatGptDomObservationTimeoutMs(5)).toBe(5_000);
  expect(chatGptDomObservationTimeoutMs(20)).toBe(8_000);
});

test("invalid active-turn counts fall back to the single-turn budget", () => {
  expect(chatGptDomObservationTimeoutMs(Number.NaN)).toBe(2_000);
  expect(chatGptDomObservationTimeoutMs(-3)).toBe(2_000);
  expect(chatGptDomObservationTimeoutMs(2.9)).toBe(2_750);
});
