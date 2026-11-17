import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { resolveChatGptToolConfirmation } from "../src/adapters/chatgpt-web/browser-worker";

const executablePath = process.env.CHROME_EXECUTABLE_PATH ?? "/usr/bin/google-chrome-stable";
const browserTest = existsSync(executablePath) ? test : test.skip;

browserTest("approval survives delayed details rendering and detached action replacement", async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div role="alert" id="approval">
        Allow ChatGPT to use local-shell-dsh?
        <button id="details">See details</button>
      </div>
      <script>
        document.querySelector('#details').addEventListener('click', () => {
          setTimeout(() => {
            const panel = document.createElement('div');
            panel.setAttribute('role', 'dialog');
            panel.id = 'details-panel';
            document.body.append(panel);
            const addAllow = () => {
              const allow = document.createElement('div');
              allow.setAttribute('role', 'menuitem');
              allow.tabIndex = 0;
              allow.textContent = 'Allow once⌄';
              allow.id = 'allow-once';
              allow.onclick = () => {
                document.querySelector('#approval').remove();
                panel.remove();
              };
              panel.append(allow);
            };
            addAllow();
            setTimeout(() => {
              document.querySelector('#allow-once').remove();
              setTimeout(addAllow, 260);
            }, 30);
          }, 180);
        });
      </script>
    `);

    const result = await resolveChatGptToolConfirmation(
      page,
      "local-shell-dsh",
      true,
      undefined,
      4_000,
    );
    expect(result).toBe(true);
    expect(await page.locator("#approval").count()).toBe(0);
    expect(await page.locator("#details-panel").count()).toBe(0);
  } finally {
    await browser.close();
  }
}, 15_000);

browserTest("approval never clicks another connector's Allow once action", async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div role="alert" id="target">Allow ChatGPT to use local-shell-dsh?
        <button id="target-details">See details</button>
      </div>
      <div role="alert" id="other">Allow ChatGPT to use unrelated-connector?
        <button id="other-allow" onclick="this.closest('[role=alert]').remove()">Allow once</button>
      </div>
    `);
    const startedAt = performance.now();
    await expect(resolveChatGptToolConfirmation(page, "local-shell-dsh", true, undefined, 300))
      .rejects.toThrow("did not expose an Allow once action");
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(await page.locator("#other-allow").count()).toBe(1);
    expect(await page.locator("#target").count()).toBe(1);
  } finally {
    await browser.close();
  }
}, 15_000);

browserTest("approval expands a disclosure covered by the fixed composer", async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.setContent(`
      <style>
        html, body { margin: 0; height: 100%; }
        #scroller { position: absolute; inset: 0; overflow-y: auto; }
        #spacer { height: 620px; }
        #approval { margin: 0 220px; padding: 10px; border: 1px solid #ccc; }
        #details { display: block; margin-left: auto; }
        #composer { position: fixed; left: 200px; right: 200px; bottom: 0; height: 140px; background: white; z-index: 100; }
        #effort { position: absolute; left: 0; right: 0; top: 0; height: 120px; }
      </style>
      <div id="scroller">
        <div id="spacer"></div>
        <div role="alert" id="approval">
          <div>ChatGPT Web Tools</div>
          <div>Allow ChatGPT to use local-shell-dsh?</div>
          <div>Run the shell tool with the command echo FIRST_STEP.
            <button id="details" aria-expanded="false">See details</button>
          </div>
        </div>
        <div style="height: 900px"></div>
      </div>
      <div id="composer"><button id="effort">Thinking effort 5.6 Instant</button></div>
      <script>
        // The approval card starts under the fixed composer: its disclosure control's centre
        // belongs to the composer's model/effort button, not to "See details".
        document.querySelector('#effort').addEventListener('click', () => {
          document.querySelector('#effort').textContent = 'Thinking effort menu opened';
        });
        document.querySelector('#details').addEventListener('click', () => {
          document.querySelector('#details').setAttribute('aria-expanded', 'true');
          const allow = document.createElement('button');
          allow.id = 'allow-once';
          allow.textContent = 'Allow once';
          allow.onclick = () => document.querySelector('#approval').remove();
          document.querySelector('#approval').append(allow);
        });
      </script>
    `);

    const result = await resolveChatGptToolConfirmation(
      page,
      "local-shell-dsh",
      true,
      undefined,
      4_000,
    );
    expect(result).toBe(true);
    expect(await page.locator("#approval").count()).toBe(0);
    expect(await page.locator("#details").count()).toBe(0);
    // The covered composer control must not receive the approval click.
    expect(await page.locator("#effort").innerText()).toBe("Thinking effort 5.6 Instant");
  } finally {
    await browser.close();
  }
}, 15_000);

browserTest("approval failure is bounded and reports a recoverable UI state", async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div role="alert">Allow ChatGPT to use local-shell-dsh?</div>');
    let failure: unknown;
    try {
      await resolveChatGptToolConfirmation(page, "local-shell-dsh", true, undefined, 300);
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toContain("did not expose an Allow once action");
  } finally {
    await browser.close();
  }
}, 15_000);
