import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import type { Page } from "playwright-core";
import { assertAuthenticatedChatGptPage } from "../src/chatgpt-session";

function pageFor({
  visible = true,
  origin = "https://chatgpt.com",
  session = { user: { id: "test-user" } } as unknown,
  responseOk = true,
  failure = false,
  malformed = false,
  status = responseOk ? 200 : 503,
  responses,
  loadingProfile = false,
}: {
  visible?: boolean; origin?: string; session?: unknown; responseOk?: boolean; failure?: boolean;
  malformed?: boolean; status?: number; loadingProfile?: boolean;
  responses?: Array<{ session?: unknown; status?: number; failure?: boolean; malformed?: boolean }>;
} = {}): Page {
  let calls = 0;
  return {
    url: () => `${origin}/?temporary-chat=true`,
    locator: () => ({ count: async () => 1, nth: () => ({ isVisible: async () => visible }) }),
    isClosed: () => false,
    waitForTimeout: async () => {},
    evaluate: async (callback: () => Promise<unknown>) => runInNewContext(`(${callback.toString()})()`, {
      AbortSignal,
      document: { querySelectorAll: () => loadingProfile ? [{ textContent: "Loading profile" }] : [] },
      fetch: async (url: string, options: RequestInit) => {
        expect(url).toBe("/api/auth/session");
        expect(options.credentials).toBe("include");
        expect(options.cache).toBe("no-store");
        expect(options.signal).toBeDefined();
        const current = responses?.[Math.min(calls++, responses.length - 1)];
        if (current?.failure ?? failure) throw new Error("Network unavailable");
        const responseStatus = current?.status ?? status;
        return {
          ok: responseStatus >= 200 && responseStatus < 300,
          status: responseStatus,
          json: async () => {
            if (current?.malformed ?? malformed) throw new SyntaxError("Invalid JSON");
            return current && "session" in current ? current.session : session;
          },
        };
      },
    }),
  } as unknown as Page;
}

test("a guest composer is not authenticated", async () => {
  await expect(assertAuthenticatedChatGptPage(pageFor({ session: {} }))).rejects.toThrow(/sign in/i);
});

test("authentication requires a visible composer", async () => {
  await expect(assertAuthenticatedChatGptPage(pageFor({ visible: false }))).rejects.toThrow("no visible composer");
});

test("authentication rejects other origins", async () => {
  await expect(assertAuthenticatedChatGptPage(pageFor({ origin: "https://example.com" }))).rejects.toThrow("unexpected page origin");
});

test("an authenticated ChatGPT session with a composer is accepted", async () => {
  await assertAuthenticatedChatGptPage(pageFor());
});

test("network, server, challenge and malformed responses do not invalidate the saved login", async () => {
  for (const config of [{ status: 503 }, { status: 403 }, { failure: true }, { malformed: true }]) {
    await expect(assertAuthenticatedChatGptPage(pageFor(config))).rejects.toMatchObject({
      status: 503, errorType: "server_error", code: "chatgpt_session_check_unavailable", retryable: true,
    });
  }
});

test("session checks recover from boot-time network failures and profile hydration", async () => {
  await assertAuthenticatedChatGptPage(pageFor({ responses: [{ failure: true }, { session: {} }, { session: { user: { id: "restored-user" } } }] }));
});

test("an unfinished profile is not classified as an expired login", async () => {
  await expect(assertAuthenticatedChatGptPage(pageFor({ session: {}, loadingProfile: true }))).rejects.toMatchObject({
    status: 503, code: "chatgpt_session_check_unavailable", retryable: true,
  });
});

test("an explicit rejected session requests login while rate limiting remains retryable", async () => {
  await expect(assertAuthenticatedChatGptPage(pageFor({ status: 401 }))).rejects.toMatchObject({
    status: 401, code: "chatgpt_session_expired", retryable: false,
  });
  await expect(assertAuthenticatedChatGptPage(pageFor({ status: 429 }))).rejects.toMatchObject({
    status: 429, code: "rate_limit_exceeded", retryable: true,
  });
});

test("authentication requires a nonempty string user id", async () => {
  for (const session of [null, { user: {} }, { user: { id: "" } }, { user: { id: 42 } }]) {
    await expect(assertAuthenticatedChatGptPage(pageFor({ session }))).rejects.toThrow(/sign in/i);
  }
});
