import { expect, test } from "bun:test";
import { chatGptPromptIdentityMatches } from "../src/adapters/chatgpt-web/browser-worker";

const prompt = "x".repeat(40_000) + " end";

test("an exact prompt identity matches", () => {
  expect(chatGptPromptIdentityMatches(prompt, prompt)).toBe(true);
});

test("a fully visible prefix of the submitted prompt matches without a truncation signal", () => {
  expect(chatGptPromptIdentityMatches(prompt, prompt.slice(0, 8_694))).toBe(true);
});

test("a collapsed Show-more prompt matches on a substantial prefix", () => {
  expect(chatGptPromptIdentityMatches(prompt, prompt.slice(0, 10_000), {
    truncated: true,
    commonPrefixChars: 4_171,
  })).toBe(true);
});

test("a competing message with different leading text is still rejected", () => {
  expect(chatGptPromptIdentityMatches(prompt, "a different user request", {
    truncated: true,
    commonPrefixChars: 0,
  })).toBe(false);
  expect(chatGptPromptIdentityMatches(prompt, "x".repeat(5_000) + " DIFFERENT", {
    truncated: true,
    commonPrefixChars: 10,
  })).toBe(false);
  expect(chatGptPromptIdentityMatches(prompt, "", { truncated: true })).toBe(false);
});

test("a bare short prefix without truncation evidence does not prove identity", () => {
  expect(chatGptPromptIdentityMatches(prompt, prompt.slice(0, 1_000), { commonPrefixChars: 1_000 })).toBe(true);
  expect(chatGptPromptIdentityMatches(prompt, "x".repeat(1_000) + "other", {
    commonPrefixChars: 1_000,
  })).toBe(false);
});
