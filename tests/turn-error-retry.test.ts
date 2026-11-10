import { expect, test } from "bun:test";
import { adapterFailureFromMessage, classifyError, isChatGptSignedOutMessage } from "../src/lib/errors";
import {
  CHATGPT_WEB_RETRY_MAX_DELAY_MS,
  chatGptWebBackoffDelayMs,
  chatGptWebRetryAfterMs,
} from "../src/adapters/chatgpt-web/backoff";
import { isChatGptLoginRedirectUrl } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptWebTurnRetryPolicy } from "../src/adapters/chatgpt-web/retry-policy";

test("an expired ChatGPT login is reported as an auth failure, never as overload", () => {
  const message = "ChatGPT web login is expired or the Temporary Chat surface is unavailable";
  expect(isChatGptSignedOutMessage(message)).toBe(true);
  const failure = adapterFailureFromMessage(message);
  expect(failure.httpStatus).toBe(401);
  expect(failure.error.type).toBe("authentication_error");
  expect(failure.error.code).toBe("chatgpt_session_expired");
  expect(failure.error.code).not.toBe("server_is_overloaded");

  // Even when a caller labels the transport failure as 503, the credential state wins.
  expect(classifyError(503, "server_error", message)).toMatchObject({
    type: "authentication_error",
    code: "chatgpt_session_expired",
  });
});

test("genuine upstream overload and session-check outages keep their retryable classification", () => {
  expect(adapterFailureFromMessage("The server is overloaded. Please try again later.")).toMatchObject({
    httpStatus: 503,
    error: { type: "server_error", code: "server_is_overloaded" },
  });
  const sessionCheck = adapterFailureFromMessage(
    "ChatGPT session check is temporarily unavailable (network_error). Retry after the network and profile finish loading; your saved login has not been changed.",
  );
  expect(sessionCheck.httpStatus).toBe(503);
  expect(sessionCheck.error.type).toBe("server_error");
  expect(sessionCheck.error.code).toBe("server_is_overloaded");
});

test("temporary chat preparation failures use exponential backoff with jitter and a cap", () => {
  const delays = [1, 2, 3, 4].map(attempt => chatGptWebBackoffDelayMs(attempt, {
    baseMs: 1_000,
    maxMs: 8_000,
    jitterRatio: 0,
  }));
  expect(delays).toEqual([1_000, 2_000, 4_000, 8_000]);
  // Jitter only extends a delay and never ignores the cap.
  const jittered = chatGptWebBackoffDelayMs(3, { baseMs: 1_000, maxMs: 4_000, jitterRatio: 0.25, random: () => 0.5 });
  expect(jittered).toBeGreaterThan(4_000 - 1);
  expect(jittered).toBeLessThanOrEqual(4_000);
  expect(chatGptWebBackoffDelayMs(50, { baseMs: 1_000, random: () => 1 }))
    .toBe(CHATGPT_WEB_RETRY_MAX_DELAY_MS);
});

test("an upstream retry-after hint overrides the computed backoff", () => {
  expect(chatGptWebRetryAfterMs("Too many requests. Please try again in 12s.")).toBe(12_000);
  expect(chatGptWebRetryAfterMs("ChatGPT rate limit: too many requests.")).toBeUndefined();
});

test("the turn retry policy paces caller retries and then reports exhaustion", () => {
  const policy = new ChatGptWebTurnRetryPolicy();
  const error = new ChatGptWebAdapterError("server overloaded", {
    status: 503,
    errorType: "server_error",
    code: "server_is_overloaded",
    retryable: true,
  });
  expect(policy.retryDelayMs("turn")).toBe(0);
  policy.recordRetryableFailure("turn", error, 1_000);
  expect(policy.retryDelayMs("turn", 1_000)).toBeGreaterThanOrEqual(1_000);
  policy.recordRetryableFailure("turn", error, 2_000);
  expect(policy.retryDelayMs("turn", 2_000)).toBeGreaterThanOrEqual(2_000);
  policy.recordRetryableFailure("turn", error, 3_000);
  expect(policy.retryDelayMs("turn", 3_000)).toBeGreaterThanOrEqual(4_000);
  policy.recordRetryableFailure("turn", error, 4_000);
  expect(policy.retryDelayMs("turn", 4_000)).toBe(0);
  expect(policy.recordRetryableFailure("turn", error, 5_000)).toMatchObject({ retryable: false });
});

test("only the ChatGPT login route is treated as a signed-out redirect", () => {
  expect(isChatGptLoginRedirectUrl("https://chatgpt.com/auth/login?next=%2F%3Ftemporary-chat%3Dtrue")).toBe(true);
  expect(isChatGptLoginRedirectUrl("https://chatgpt.com/auth/signin")).toBe(true);
  expect(isChatGptLoginRedirectUrl("https://chatgpt.com/?temporary-chat=true")).toBe(false);
  expect(isChatGptLoginRedirectUrl("https://chatgpt.com/c/abc")).toBe(false);
  expect(isChatGptLoginRedirectUrl("https://example.com/auth/login")).toBe(false);
  expect(isChatGptLoginRedirectUrl("about:blank")).toBe(false);
});
