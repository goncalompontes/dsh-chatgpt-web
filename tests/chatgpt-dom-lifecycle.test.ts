import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { ChatGptBrowserWorker, ChatGptTurnDomHealthTracker, CHATGPT_RESPONSE_DOM_GRACE_MS, chatGptTurnLocator, throwIfChatGptPageErrorAlert } from "../src/adapters/chatgpt-web/browser-worker";
import { activateChatGptEffortMenu } from "../src/chatgpt-session";

const executablePath = process.env.CHROME_EXECUTABLE_PATH ?? "/usr/bin/google-chrome-stable";
const browserTest = existsSync(executablePath) ? test : test.skip;

// Chrome cold-start and cleanup can exceed Bun's 5s unit-test default under CI load.
// Keep a bounded, browser-specific deadline without changing suite-wide timeouts.
browserTest("effort activation recovers when picker handlers hydrate after the first activation cycle", async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<button id="control" aria-controls="picker" aria-expanded="false">Model</button>
      <div id="picker" role="menu" hidden><span role="menuitemradio">GPT-6</span></div>
      <script>
        const control = document.getElementById('control');
        let hydrated = false;
        control.addEventListener('pointerdown', () => {
          hydrated = true;
          control.dataset.hydrated = 'true';
        });
        control.addEventListener('keydown', event => {
          if (event.key === 'Enter' && hydrated) {
            document.getElementById('picker').hidden = false;
            control.setAttribute('aria-expanded', 'true');
          }
        });
      </script>`);
    const activation = await activateChatGptEffortMenu(page, page.locator('#control'), { settleMs: 50 });
    expect(activation.method).toBe('keyboard');
    expect(await page.locator('#control').getAttribute('data-hydrated')).toBe('true');
    expect(await activation.menu.isVisible()).toBe(true);
  } finally {
    await browser.close();
  }
}, 15_000);

browserTest("image-only and labelled canvas answers survive DOM extraction and completion checks", async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript("globalThis.__name = value => value");
    const page = await context.newPage();
    const worker: any = Object.create(ChatGptBrowserWorker.prototype);
    await page.setContent('<main><section id="turn"><div class="markdown"><picture><img alt="Diagram" src="https://example.org/diagram.png"></picture></div></section><button data-testid="copy-turn-action-button">Copy</button></main>');
    const image = await worker.responseDomSnapshot(page.locator("#turn"), {});
    expect(image.visibleText).toContain('![Diagram](https://example.org/diagram.png)');
    expect(image.completionActionVisible).toBe(true);
    await page.setContent('<main><section id="turn"><div class="markdown"><p>Result</p><canvas aria-label="Revenue chart"></canvas><picture><img alt="Diagram" src="https://example.org/diagram.png"></picture></div></section></main>');
    const mixed = await worker.responseDomSnapshot(page.locator("#turn"), {});
    expect(mixed.markdownSegments.map((s: any) => s.html).join("")).toContain('Revenue chart');
    expect(mixed.markdownSegments.map((s: any) => s.html).join("")).toContain('diagram.png');
  } finally {
    await browser.close();
  }
});

browserTest("iframe-only answers and roadmap prose survive the browser-to-Markdown pipeline", async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript("globalThis.__name = value => value");
    const page = await context.newPage();
    const worker: any = Object.create(ChatGptBrowserWorker.prototype);
    await page.setContent('<main><section id="turn"><div class="markdown"><iframe title="Revenue explorer"></iframe></div></section><button data-testid="copy-turn-action-button">Copy</button></main>');
    const cache = {};
    const frame = await worker.responseDomSnapshot(page.locator('#turn'), cache);
    expect(frame.visibleText).toContain('Revenue explorer (interactive content available in ChatGPT)');
    expect(frame.markdownSegments.map((segment: any) => segment.html).join('')).toContain('Revenue explorer');
    expect(frame.completionActionVisible).toBe(true);
    await page.locator('iframe').evaluate(node => node.setAttribute('title', 'Updated explorer'));
    const updated = await worker.responseDomSnapshot(page.locator('#turn'), cache);
    expect(updated.visibleText).toContain('Updated explorer');
    await page.setContent('<main><section id="turn"><div class="markdown"><section aria-label="Roadmap" class="roadmap-container"><p>Keep the entire plan.</p></section></div></section></main>');
    const roadmap = await worker.responseDomSnapshot(page.locator('#turn'), {});
    expect(roadmap.visibleText).toContain('Keep the entire plan.');
    expect(roadmap.markdownSegments.map((segment: any) => segment.html).join('')).toContain('Keep the entire plan.');
  } finally {
    await browser.close();
  }
});

browserTest("page-level terminal alerts outside a detached assistant preserve their real cause", async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<main><div data-message-author-role="user">Submitted context</div><aside role="alert">The messages you submitted were too long, please edit them and resubmit.<button>Retry</button></aside></main>');
    await expect(throwIfChatGptPageErrorAlert(page)).rejects.toMatchObject({
      code: "context_length_exceeded", status: 400, errorType: "invalid_request_error", retryable: false,
    });
    await page.setContent('<main><aside role="alert">The message you submitted was too long, please edit and resubmit.</aside></main>');
    await expect(throwIfChatGptPageErrorAlert(page)).rejects.toMatchObject({
      code: "context_length_exceeded", status: 400, errorType: "invalid_request_error", retryable: false,
    });
    await page.setContent('<main><aside role="alert">Something went wrong. Please try again<button>Retry</button></aside></main>');
    await expect(throwIfChatGptPageErrorAlert(page)).rejects.toMatchObject({
      code: "upstream_server_error", status: 502, retryable: false,
    });
    // Quoted history, hidden alerts, and unrelated notifications are not submission failures.
    await page.setContent('<aside role="alert">The messages you submitted were too long, please edit them and resubmit.</aside><aside role="alert">The message you submitted was too long, please edit and resubmit.</aside><main><p>Something went wrong. Please try againRetry</p><aside role="alert" hidden>The messages you submitted were too long, please edit them and resubmit.</aside><aside role="alert" hidden>The message you submitted was too long, please edit and resubmit.</aside><aside role="alert">Allow ChatGPT to use local-shell-dsh?</aside></main>');
    await throwIfChatGptPageErrorAlert(page);
  } finally {
    await browser.close();
  }
});

browserTest("a stream ChatGPT abandoned is the turn's cause, not a disappeared response DOM", async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    // Trace 8816046438ee at failure: ChatGPT retired the in-progress assistant turn and left the
    // previous answer plus one alert. The bound locator resolves to nothing, and the alert is the
    // only statement about why the turn ended.
    await page.setContent(`<main>
      <div data-message-author-role="assistant"><div class="markdown"><p>Previous answer</p></div></div>
      <div data-chatgpt-search-unit-key="de47df26-8c4c-4a12-b40d-4aae8790ccd1:2:assistant"><div class="markdown"><p>Abandoned partial answer</p></div></div>
      <div role="alert">Error in message stream<button>Retry</button></div>
    </main>`);
    const bound = chatGptTurnLocator(page, "709d947e-2bc3-52aa-ae06-92722505f893:2:assistant");
    expect(await bound.count()).toBe(0);
    // Charging that absence to the missing-response grace is what produced the wrong verdict: it
    // cannot tell a turn ChatGPT ended from a renderer that lost a live response.
    const health = new ChatGptTurnDomHealthTracker();
    expect(health.update({
      responsePresent: true, running: true, currentText: "Working", completionActionVisible: false,
    }, 0)).toBeUndefined();
    expect(health.update({
      responsePresent: false, running: false, currentText: "", completionActionVisible: false,
    }, 1)).toBeUndefined();
    expect(health.update({
      responsePresent: false, running: false, currentText: "", completionActionVisible: false,
    }, 1 + CHATGPT_RESPONSE_DOM_GRACE_MS)).toContain("response DOM disappeared");
    // The terminal surface must win: it names the upstream failure the DOM verdict hides, and the
    // browser conversation still holds the prompt and every recorded tool result, so the retry is
    // the one ChatGPT itself offers.
    await expect(throwIfChatGptPageErrorAlert(page)).rejects.toMatchObject({
      code: "upstream_server_error", status: 502, errorType: "server_error", retryable: true,
    });

    // Nothing about the answer text is terminal by itself: a transcript that quotes the banner, a
    // hidden alert, and ChatGPT's tool approval card must all stay non-terminal.
    await page.setContent(`<main>
      <div data-message-author-role="assistant"><div class="markdown"><p>Logged: Error in message stream Retry</p></div></div>
      <aside role="alert" hidden>Error in message stream<button>Retry</button></aside>
      <div role="alert">ChatGPT Web ToolsAllow ChatGPT to use local-shell-dsh?The call attempts to apply a repository patch.<button>Allow once</button></div>
    </main>`);
    await throwIfChatGptPageErrorAlert(page);
    // ChatGPT can drop the partial answer and render the banner alone before any turn is bound, so
    // the pre-binding wait must reach the same conclusion.
    await page.setContent('<main><div role="alert">Error in message stream<button>Retry</button></div></main>');
    await expect(throwIfChatGptPageErrorAlert(page)).rejects.toMatchObject({
      code: "upstream_server_error", retryable: true,
    });
  } finally {
    await browser.close();
  }
}, 20_000);

browserTest("completion action outside the answer root invalidates the DOM cache", async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript("globalThis.__name = value => value");
    const page = await context.newPage();
    await page.setContent('<main><section id="turn"><div class="markdown"><p>Final answer</p></div></section><div id="actions"></div></main>');
    const worker: any = Object.create(ChatGptBrowserWorker.prototype);
    const cache = {};
    const response = page.locator("#turn");
    const before = await worker.responseDomSnapshot(response, cache);
    expect(before.visibleText).toBe("Final answer");
    expect(before.completionActionVisible).toBe(false);
    await page.locator("#actions").evaluate(element => {
      element.innerHTML = '<button data-testid="copy-turn-action-button">Copy</button>';
    });
    const after = await worker.responseDomSnapshot(response, cache);
    expect(after.completionActionVisible).toBe(true);
    expect(after.visibleText).toBe("Final answer");

    await page.locator("#turn .markdown").evaluate(element => { element.innerHTML = "<p>42</p>"; });
    const numeric = await worker.responseDomSnapshot(response, cache);
    expect(numeric.visibleText).toBe("42");
    expect(numeric.markdownSegments.map((segment: any) => segment.text)).toEqual(["42"]);

    // The current renderer exposes a native content-search key; its chatgpt-search alias
    // can disappear during re-rendering. Both discovery and subsequent binding must work.
    await page.setContent('<main><div data-content-search-unit-key="fallback-turn-0:0:user">Task</div><div data-content-search-unit-key="fallback-turn-0:1:assistant"><div class="markdown"><p>Answer</p></div></div></main>');
    const state = await worker.submissionDomState(page);
    expect(state.userIdentities).toEqual(["fallback-turn-0:0:user"]);
    expect(state.responseIdentities).toEqual(["fallback-turn-0:1:assistant"]);
    const native = chatGptTurnLocator(page, state.responseIdentities[0]);
    expect(await native.count()).toBe(1);
    await native.evaluate(element => element.setAttribute("data-chatgpt-search-unit-key", "fallback-turn-0:1:assistant"));
    const withAlias = await worker.submissionDomState(page);
    expect(withAlias.responseIdentities).toEqual(state.responseIdentities);
    expect(await chatGptTurnLocator(page, state.responseIdentities[0]).count()).toBe(1);
    await page.setContent('<main><div data-content-search-unit-key="fallback-turn-0:0:user"><div data-chatgpt-search-unit-key="fallback-turn-0:0:user">Task</div></div><div data-content-search-unit-key="fallback-turn-0:1:assistant"><div data-chatgpt-search-unit-key="fallback-turn-0:1:assistant"><div class="markdown"><p>Answer</p></div></div></div></main>');
    const nested = await worker.submissionDomState(page);
    expect(nested.userIdentities).toEqual(state.userIdentities);
    expect(nested.responseIdentities).toEqual(state.responseIdentities);
    expect(await chatGptTurnLocator(page, state.responseIdentities[0]).count()).toBe(1);
    // The same locator must follow a native-only replacement without being recreated.
    const rebound = chatGptTurnLocator(page, state.responseIdentities[0]);
    await page.locator('[data-chatgpt-search-unit-key$=":assistant"]').evaluate(element => element.removeAttribute("data-chatgpt-search-unit-key"));
    expect(await rebound.count()).toBe(1);
    await page.locator("main").evaluate(element => element.insertAdjacentHTML("beforeend", '<div data-content-search-unit-key="fallback-turn-0:1:assistant">Duplicate</div>'));
    await expect(worker.submissionDomState(page)).rejects.toThrow("duplicate conversation turn identities");

    // The Nov 17 renderer scopes the unit key with the conversation UUID instead of
    // `fallback-turn-<n>`. It is the same `<scope>:<index>:<role>` identity contract, so
    // discovery and binding must accept it rather than require the retired literal prefix.
    await page.setContent('<main><div data-content-search-unit-key="6afbd553-37ac-83ed-aa90-f4857a09aeb2:1:user"><div data-chatgpt-search-unit-key="6afbd553-37ac-83ed-aa90-f4857a09aeb2:1:user">Task</div></div><div data-content-search-unit-key="af452a82-e53d-5a9a-adc1-8f1bffa69c14:2:assistant"><div data-chatgpt-search-unit-key="af452a82-e53d-5a9a-adc1-8f1bffa69c14:2:assistant"><div class="markdown"><p>Answer</p></div></div></div></main>');
    const conversationScoped = await worker.submissionDomState(page);
    expect(conversationScoped.userIdentities).toEqual(["6afbd553-37ac-83ed-aa90-f4857a09aeb2:1:user"]);
    expect(conversationScoped.responseIdentities).toEqual(["af452a82-e53d-5a9a-adc1-8f1bffa69c14:2:assistant"]);
    expect(await chatGptTurnLocator(page, conversationScoped.responseIdentities[0]).count()).toBe(1);
    // An alias naming the other role must still be rejected instead of binding the wrong turn.
    await page.setContent('<main><div data-content-search-unit-key="af452a82-e53d-5a9a-adc1-8f1bffa69c14:2:assistant" data-chatgpt-search-unit-key="af452a82-e53d-5a9a-adc1-8f1bffa69c14:2:user">Mislabelled</div></main>');
    await expect(worker.submissionDomState(page)).rejects.toThrow("no stable identity");
  } finally {
    await browser.close();
  }
});

browserTest("a finished turn's own response state proves completion when its footer action is not the last node", async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript("globalThis.__name = value => value");
    const page = await context.newPage();
    const worker: any = Object.create(ChatGptBrowserWorker.prototype);
    const cache = {};
    // ChatGPT's connector rounds leave tool cards after the assistant message, so the turn's copy
    // action is not the last Markdown node. The client's own turn state is the completion owner.
    await page.setContent(`<main><section id="turn" data-dil-talvt-response-state="pending">
      <div class="markdown"><p>Final answer</p></div>
      <button data-testid="copy-turn-action-button">Copy</button>
      <div class="markdown"><p>Connector tool result</p></div>
    </section></main>`);
    const response = page.locator("#turn");
    const pending = await worker.responseDomSnapshot(response, cache);
    expect(pending.responseState).toBe("pending");
    expect(pending.completionActionVisible).toBe(false);

    // The same DOM, now finalized by the client. The copy action still precedes the trailing tool
    // card, so only the turn state can prove completion. This transition must also invalidate the
    // observation cache or the finished turn would never be observed as complete.
    await page.locator("#turn").evaluate(element => {
      element.setAttribute("data-dil-talvt-response-state", "complete");
    });
    const complete = await worker.responseDomSnapshot(response, cache);
    expect(complete.responseState).toBe("complete");
    expect(complete.completionActionVisible).toBe(true);

    // A wrapper may own the state instead of the bound turn element itself.
    await page.setContent(`<main><div data-dil-talvt-response-state="complete"><section id="wrapped">
      <div class="markdown"><p>Wrapped answer</p></div>
    </section></div></main>`);
    const wrapped = await worker.responseDomSnapshot(page.locator("#wrapped"), {});
    expect(wrapped.responseState).toBe("complete");
    expect(wrapped.completionActionVisible).toBe(true);
  } finally {
    await browser.close();
  }
});

test("snapshot evaluation failures are distinguished from missing response nodes", async () => {
  const worker: any = Object.create(ChatGptBrowserWorker.prototype);
  const response: any = {
    evaluate: async () => { throw new Error("renderer probe failed"); },
    page: () => ({ isClosed: () => false }),
    count: async () => 1,
  };
  await expect(worker.responseDomSnapshot(response)).rejects.toThrow("renderer probe failed");
  response.count = async () => 0;
  expect((await worker.responseDomSnapshot(response)).responsePresent).toBe(false);
});

browserTest("assistant rebinding proves a late user node belongs to the submitted prompt", async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript("globalThis.__name = value => value");
    const page = await context.newPage();
    const worker: any = Object.create(ChatGptBrowserWorker.prototype);
    worker.config = { appName: "local-shell-dsh" };
    await page.setContent('<main></main>');
    const render = (html: string) => page.locator("main").evaluate((root, markup) => { root.outerHTML = markup; }, html);
    const baseline = await worker.captureSubmissionBaseline(page);
    baseline.submittedPromptText = "Execute task\nwith its exact context";
    await render('<main><div data-content-search-unit-key="fallback-turn-0:1:assistant">Working</div></main>');
    const original = {
      identity: "fallback-turn-0:1:assistant",
      locator: chatGptTurnLocator(page, "fallback-turn-0:1:assistant"),
      acceptedUserTurnIdentities: [],
    };
    // Connector confirmation hydrates the original user node and renumbers the answer.
    await render('<main><div data-content-search-unit-key="fallback-turn-0:0:user"><div data-chatgpt-search-unit-key="fallback-turn-0:0:user"><div data-user-message-bubble><span app-mention-name="local-shell-dsh">local-shell-dsh</span>Execute task\nwith its exact context<button>Copy</button></div></div></div><div data-content-search-unit-key="fallback-turn-0:2:assistant"><p>Final answer</p></div></main>');
    const rebound = await worker.reconcileAssistantTurnBinding(page, baseline, original);
    expect(rebound.identity).toBe("fallback-turn-0:2:assistant");
    expect(rebound.acceptedUserTurnIdentities).toEqual(["fallback-turn-0:0:user"]);
    expect(await rebound.locator.count()).toBe(1);
    expect(await rebound.locator.innerText({ timeout: 1000 })).toBe("Final answer");

    // The hydrated user bubble renders composer newlines as separate paragraphs,
    // and some builds expose the connector's plain label instead of a tagged pill.
    await render('<main><div data-content-search-unit-key="fallback-turn-0:0:user"><div data-user-message-bubble><span>local-shell-dsh</span><p>Execute task</p><p>with its exact context</p><button>Show more</button></div></div><div data-content-search-unit-key="fallback-turn-0:2:assistant">Final answer</div></main>');
    expect((await worker.reconcileAssistantTurnBinding(page, baseline, original)).identity).toBe("fallback-turn-0:2:assistant");

    // A long reused Temporary Chat virtualizes its transcript. An older user turn can mount (or
    // re-render under a new key) while our submitted prompt is still the newest user turn. That
    // is history hydration, not a competing message, so the detached answer must rebind.
    const history = {
      identity: "fallback-turn-0:2:assistant",
      locator: chatGptTurnLocator(page, "fallback-turn-0:2:assistant"),
      acceptedUserTurnIdentities: ["fallback-turn-0:1:user"],
    };
    await render('<main><div data-content-search-unit-key="fallback-turn-0:0:user">Earlier task</div><div data-content-search-unit-key="fallback-turn-0:1:user"><div data-user-message-bubble>Execute task\nwith its exact context</div></div><div data-content-search-unit-key="fallback-turn-0:3:assistant">Final answer</div></main>');
    const hydrated = await worker.reconcileAssistantTurnBinding(page, baseline, history);
    expect(hydrated.identity).toBe("fallback-turn-0:3:assistant");
    expect(hydrated.acceptedUserTurnIdentities).toEqual(["fallback-turn-0:0:user", "fallback-turn-0:1:user"]);

    // A genuinely different message must not be accepted as late hydration.
    await render('<main><div data-content-search-unit-key="fallback-turn-0:0:user">Different task</div><div data-content-search-unit-key="fallback-turn-0:2:assistant">Wrong answer</div></main>');
    await expect(worker.reconcileAssistantTurnBinding(page, baseline, original)).rejects.toThrow("another user turn");

    // Even identical text is competing input when the submitted user is still present.
    await render('<main><div data-content-search-unit-key="fallback-turn-0:0:user">Execute task with its exact context</div><div data-content-search-unit-key="fallback-turn-0:2:user">Execute task with its exact context</div><div data-content-search-unit-key="fallback-turn-0:3:assistant">Wrong answer</div></main>');
    await expect(worker.reconcileAssistantTurnBinding(page, baseline, rebound)).rejects.toThrow("another user turn");

    await render('<main><div data-content-search-unit-key="fallback-turn-0:0:user">Execute task with its exact context</div><div data-content-search-unit-key="fallback-turn-0:2:assistant">One</div><div data-content-search-unit-key="fallback-turn-0:3:assistant">Two</div></main>');
    await expect(worker.reconcileAssistantTurnBinding(page, baseline, original)).rejects.toThrow("2 new conversation turns");
  } finally {
    await browser.close();
  }
}, 20_000);
