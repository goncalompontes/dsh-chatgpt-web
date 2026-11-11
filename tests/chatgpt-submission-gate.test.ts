import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

/*
 * The gate model is loaded dynamically so the pre-fix state-machine assertions below fail on the
 * behavior (a gated composer is reported ready, and Send is blamed for being disabled) instead of
 * on a missing module export.
 */
const gateModel = () => import("../src/adapters/chatgpt-web/browser-worker");

const executablePath = process.env.CHROME_EXECUTABLE_PATH ?? "/usr/bin/google-chrome-stable";
const browserTest = existsSync(executablePath) ? test : test.skip;

// Verbatim notice from trace 827d10e4af5e (diagnostics browser-turns/827d10e4af5e-8788e144):
// ChatGPT kept the composer editable but disabled Send because the account was being checked.
const LIVE_GATE_NOTICE =
  "We're doing a quick check to keep ChatGPT reliable. Try again after 4:01 PM.";

const GATED_COMPOSER_HTML = `<!doctype html>
<body>
  <form>
    <div id="prompt-textarea" role="textbox" contenteditable="true" class="ProseMirror"></div>
    <button data-testid="send-button" aria-label="Send" disabled>Send</button>
  </form>
  <aside role="status">${LIVE_GATE_NOTICE}</aside>
  <div role="status"></div>
  <span role="status" style="position:absolute;width:1px;height:1px;overflow:hidden"></span>
</body>`;

test("recognizes the live reliability gate and not ordinary status notices", async () => {
  const { chatGptSubmissionGateText } = await gateModel();
  expect(chatGptSubmissionGateText(LIVE_GATE_NOTICE)).toBe(LIVE_GATE_NOTICE);
  expect(chatGptSubmissionGateText(
    "Our systems have detected unusual activity coming from your system. Please try again later",
  )).toContain("unusual activity");
  // Composer/rehydration notices are not admission verdicts; treating them as a gate would fail
  // healthy turns.
  expect(chatGptSubmissionGateText("Loading profile")).toBeUndefined();
  expect(chatGptSubmissionGateText("Response complete")).toBeUndefined();
  expect(chatGptSubmissionGateText("Medium, 2 of 3.")).toBeUndefined();
});

test("gate verdict is an upstream 429 that names the announced resume time", async () => {
  const { chatGptSubmissionGateError, chatGptSubmissionGateResumeAt } = await gateModel();
  const now = new Date(2026, 10, 11, 11, 29, 57);
  const error = chatGptSubmissionGateError(LIVE_GATE_NOTICE, now);
  expect(error).toBeInstanceOf(ChatGptWebAdapterError);
  expect(error.status).toBe(429);
  expect(error.errorType).toBe("rate_limit_error");
  expect(error.code).toBe("chatgpt_submission_gated");
  // The gate outlives this turn by hours; an in-request replay cannot succeed.
  expect(error.retryable).toBe(false);
  expect(error.message).toContain("4:01");
  expect(error.message).toContain("quick check");

  const resume = chatGptSubmissionGateResumeAt(LIVE_GATE_NOTICE, now);
  expect(resume?.getFullYear()).toBe(2026);
  expect(resume?.getMonth()).toBe(10);
  expect(resume?.getDate()).toBe(11);
  expect(resume?.getHours()).toBe(16);
  expect(resume?.getMinutes()).toBe(1);
});

test("gate resume time boundary: a clock time already passed is tomorrow's resume", async () => {
  const { chatGptSubmissionGateResumeAt } = await gateModel();
  const before = chatGptSubmissionGateResumeAt(
    LIVE_GATE_NOTICE,
    new Date(2026, 10, 11, 15, 59, 0),
  );
  expect(before?.getDate()).toBe(11);
  expect(before?.getHours()).toBe(16);

  // At the announced minute the gate has not been withdrawn yet; the next occurrence is tomorrow.
  const atDeadline = chatGptSubmissionGateResumeAt(
    LIVE_GATE_NOTICE,
    new Date(2026, 10, 11, 16, 1, 0),
  );
  expect(atDeadline?.getDate()).toBe(12);
  expect(atDeadline?.getHours()).toBe(16);

  const relative = chatGptSubmissionGateResumeAt(
    "We're doing a quick check to keep ChatGPT reliable. Try again in 5 minutes.",
    new Date(2026, 10, 11, 11, 29, 0),
  );
  expect(relative?.getTime()).toBe(new Date(2026, 10, 11, 11, 34, 0).getTime());
});

browserTest("a gated composer is not reported as ready for prompt staging", async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://chatgpt.com/?temporary-chat=true", route => route.fulfill({
      contentType: "text/html",
      body: GATED_COMPOSER_HTML,
    }));
    await page.goto("https://chatgpt.com/?temporary-chat=true");

    const { readChatGptSubmissionGate } = await gateModel();
    expect(await readChatGptSubmissionGate(page)).toBe(LIVE_GATE_NOTICE);

    const worker: any = Object.create(ChatGptBrowserWorker.prototype);
    const error = await worker.prepareTemporaryChatSurface(page).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ChatGptWebAdapterError);
    expect((error as ChatGptWebAdapterError).code).toBe("chatgpt_submission_gated");
    expect((error as ChatGptWebAdapterError).retryable).toBe(false);
  } finally {
    await browser.close();
  }
}, 20_000);

browserTest("a gate disables the send boundary instead of submitting or blaming the control", async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(GATED_COMPOSER_HTML);
    let enterPresses = 0;
    await page.exposeFunction("__recordEnter", () => { enterPresses += 1; });
    await page.evaluate(() => {
      document.addEventListener("keydown", event => {
        if (event.key === "Enter") (globalThis as any).__recordEnter();
      });
    });

    const worker: any = Object.create(ChatGptBrowserWorker.prototype);
    worker.config = { tuning: { sendEnableGraceMs: 100 } };
    const error = await worker
      .sendAttachedPrompt(page, {}, undefined, undefined, undefined, undefined, undefined, undefined)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ChatGptWebAdapterError);
    expect((error as ChatGptWebAdapterError).code).toBe("chatgpt_submission_gated");
    expect((error as ChatGptWebAdapterError).message).toContain("4:01");
    expect(enterPresses).toBe(0);
  } finally {
    await browser.close();
  }
}, 20_000);
