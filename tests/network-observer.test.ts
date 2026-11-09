import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import {
  installChatGptNetworkObserverInPage,
  readChatGptNetworkStream,
} from "../src/adapters/chatgpt-web/network-observer";

const executablePath = process.env.CHROME_EXECUTABLE_PATH ?? "/usr/bin/google-chrome-stable";
const browserTest = existsSync(executablePath) ? test : test.skip;

const BODY = [
  'event: delta_encoding\ndata: "v1"',
  'event: delta\ndata: {"p":"","o":"add","v":{"message":{"id":"m1","author":{"role":"assistant"},"content":{"parts":[""]},"channel":"final"},"conversation_id":"c1"}}',
  'event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":"Hello from the stream"}',
  "data: [DONE]",
].map(frame => `${frame}\n\n`).join("");

browserTest("the fetch tee captures the conversation stream without consuming the page body", async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(installChatGptNetworkObserverInPage);
    const page = await context.newPage();
    await page.route("**/*", route => {
      const url = route.request().url();
      if (url.endsWith("/backend-api/f/conversation")) {
        return route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
          body: BODY,
        });
      }
      if (url === "https://chatgpt.com/") {
        return route.fulfill({
          status: 200,
          headers: { "content-type": "text/html" },
          body: "<!doctype html><title>fixture</title>",
        });
      }
      return route.fulfill({ status: 404, body: "" });
    });
    await page.goto("https://chatgpt.com/");
    const pageBody = await page.evaluate(async () => {
      const response = await fetch("/backend-api/f/conversation", { method: "POST", body: "{}" });
      return response.text();
    });
    expect(pageBody).toBe(BODY);

    let stream = await readChatGptNetworkStream(page, 0);
    for (let attempt = 0; attempt < 40 && !stream?.done; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 25));
      stream = await readChatGptNetworkStream(page, 0);
    }
    expect(stream?.buffer).toBe(BODY);
    expect(stream?.done).toBe(true);
    expect(stream?.url).toContain("/backend-api/f/conversation");

    const suffix = await readChatGptNetworkStream(page, 0, 5);
    expect(suffix?.offset).toBe(5);
    expect(suffix?.totalLength).toBe(BODY.length);
    expect(suffix?.buffer).toBe(BODY.slice(5));
  } finally {
    await browser.close();
  }
});

browserTest("the observer ignores unrelated requests", async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(installChatGptNetworkObserverInPage);
    const page = await context.newPage();
    await page.route("**/*", route => route.fulfill({
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<!doctype html><title>fixture</title>",
    }));
    await page.goto("https://chatgpt.com/");
    await page.evaluate(async () => {
      await fetch("/backend-api/models");
    });
    expect(await readChatGptNetworkStream(page, 0)).toBeUndefined();
  } finally {
    await browser.close();
  }
});
