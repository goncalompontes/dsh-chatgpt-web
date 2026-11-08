import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { captureChatGptMedia, chatGptArtifactName, chatGptImageExtension, exportableChatGptImageUrl } from "../src/adapters/chatgpt-web/media";

const executablePath = process.env.CHROME_EXECUTABLE_PATH ?? "/usr/bin/google-chrome-stable";
const browserTest = existsSync(executablePath) ? test : test.skip;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6bAAAAABJRU5ErkJggg==", "base64");

test("media export validates image bytes, origins and attachment names", () => {
  expect(chatGptImageExtension(png)).toBe("png");
  expect(chatGptImageExtension(Buffer.from('<script>not an image</script>'))).toBeUndefined();
  expect(exportableChatGptImageUrl("https://chatgpt.com/backend-api/file/test")).toBe(true);
  expect(exportableChatGptImageUrl("blob:https://chatgpt.com/id")).toBe(true);
  for (const value of ["http://127.0.0.1/private", "https://chatgpt.com.attacker.test/a", "file:///etc/passwd",
    "data:text/html;base64,PHNjcmlwdD4=", "blob:https://attacker.test/id"]) {
    expect(exportableChatGptImageUrl(value)).toBe(false);
  }
  expect(chatGptArtifactName('../../.hidden<script>.csv')).toBe('hidden_script_.csv');
  expect(chatGptArtifactName('')).toBe('attachment');
});

browserTest("exports authenticated images and sandbox downloads from only the bound reply", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-media-export-"));
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    await context.addInitScript("globalThis.__name = value => value");
    await context.addCookies([{ name: "smoke_auth", value: "test-only", domain: "chatgpt.com", path: "/", secure: true }]);
    const page = await context.newPage();
    const cookies: string[] = [];
    await page.route("https://chatgpt.com/**", async route => {
      if (route.request().url().includes("/backend-api/")) {
        cookies.push(route.request().headers().cookie ?? "");
        await route.fulfill({ contentType: "image/png", body: png });
      } else {
        await route.fulfill({ contentType: "text/html", body: `<article id="reply">
          <img src="/backend-api/image" alt="Generated chart" width="128" height="128">
          <a id="file" href="sandbox:/mnt/data/report.csv">Report</a>
          <button id="button" aria-label="Download button.csv">Download button.csv</button></article>
          <img src="/backend-api/unrelated" alt="Unrelated" width="128" height="128">` });
      }
    });
    await page.goto("https://chatgpt.com/media-fixture");
    await page.locator("#file").evaluate(anchor => anchor.addEventListener("click", () => {
      const link = anchor as HTMLAnchorElement;
      link.href = URL.createObjectURL(new Blob(["column,value\nanswer,42\n"], { type: "text/csv" }));
      link.download = "report.csv";
    }));
    await page.locator("#button").evaluate(button => button.addEventListener("click", () => {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob(["button download\n"], { type: "text/csv" }));
      link.download = "button.csv";
      link.click();
      URL.revokeObjectURL(link.href);
    }));
    const appendix = await captureChatGptMedia(page.locator("#reply"), directory);
    expect(appendix).toContain("![Generated chart](<");
    expect(appendix).toContain("[Report](<");
    expect(appendix).not.toContain("Unrelated");
    expect(appendix).not.toContain("unavailable");
    const files = readdirSync(directory);
    expect(files).toHaveLength(3);
    expect(readFileSync(join(directory, files.find(file => file.endsWith(".png"))!))).toEqual(png);
    expect(readFileSync(join(directory, files.find(file => file.endsWith("-report.csv"))!), "utf8")).toBe("column,value\nanswer,42\n");
    expect(readFileSync(join(directory, files.find(file => file.endsWith("-button.csv"))!), "utf8")).toBe("button download\n");
    expect(cookies.every(cookie => cookie.includes("smoke_auth=test-only"))).toBe(true);
    for (const file of files) expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600);
  } finally { await browser.close(); rmSync(directory, { recursive: true, force: true }); }
});

browserTest("oversized or disguised image responses produce an explicit fallback without saving bytes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-media-reject-"));
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript("globalThis.__name = value => value");
    const page = await context.newPage();
    await page.route("https://chatgpt.com/**", async route => {
      const url = route.request().url();
      if (url.endsWith("/oversized")) await route.fulfill({ contentType: "image/png", body: png,
        headers: { "content-length": String(9 * 1024 ** 2) } });
      else if (url.endsWith("/disguised")) await route.fulfill({ contentType: "image/png", body: "<html>not image bytes</html>" });
      else await route.fulfill({ contentType: "text/html", body: '<article id="reply"><img width="128" height="128" alt="Large image" src="/oversized"><img width="128" height="128" alt="Invalid image" src="/disguised"></article>' });
    });
    await page.goto("https://chatgpt.com/media-fixture", { waitUntil: "domcontentloaded" });
    const appendix = await captureChatGptMedia(page.locator("#reply"), directory);
    expect(appendix).toContain("Large image: export unavailable");
    expect(appendix).toContain("Invalid image: export unavailable");
    expect(readdirSync(directory)).toEqual([]);
    const abort = new AbortController();
    abort.abort();
    await expect(captureChatGptMedia(page.locator("#reply"), directory, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
  } finally { await browser.close(); rmSync(directory, { recursive: true, force: true }); }
});

browserTest("media export explains untrusted images and attachments beyond the export cap", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-media-limit-"));
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<article id="reply">' + Array.from({ length: 9 }, (_, index) =>
      `<img width="128" height="128" alt="External image ${index}" src="https://example.invalid/${index}.png">`).join('') + '</article>');
    const appendix = await captureChatGptMedia(page.locator('#reply'), directory);
    expect(appendix).toContain('External image 0: export unavailable');
    expect(appendix).toContain('Additional attachments are available in ChatGPT.');
    expect(readdirSync(directory)).toEqual([]);
  } finally { await browser.close(); rmSync(directory, { recursive: true, force: true }); }
});

browserTest("exports labelled canvas and SVG visuals from the bound response as real PNGs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-media-visual-"));
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<article id="reply"><canvas aria-label="Blue chart" width="128" height="128"></canvas>
      <svg width="128" height="128"><title>Red diagram</title><rect width="128" height="128" fill="red"/></svg>
      <svg width="16" height="16" aria-label="Icon"></svg></article>
      <canvas width="128" height="128" aria-label="Unrelated"></canvas>`);
    await page.locator('#reply canvas').evaluate(node => {
      const canvas = node as HTMLCanvasElement;
      const context = canvas.getContext('2d')!;
      context.fillStyle = 'blue';
      context.fillRect(0, 0, 128, 128);
    });
    const expected = await Promise.all(['#reply canvas', '#reply svg'].map(selector =>
      page.locator(selector).first().screenshot({ type: 'png', scale: 'css' })));
    const appendix = await captureChatGptMedia(page.locator('#reply'), directory);
    expect(appendix).toContain('![Blue chart](<');
    expect(appendix).toContain('![Red diagram](<');
    expect(appendix).not.toContain('Unrelated');
    expect(appendix).not.toContain('Icon');
    const files = readdirSync(directory);
    expect(files).toHaveLength(2);
    const exported = files.map(file => readFileSync(join(directory, file)));
    for (const pixels of expected) expect(exported.some(bytes => bytes.equals(pixels))).toBe(true);
    for (const file of files) {
      const bytes = readFileSync(join(directory, file));
      expect(chatGptImageExtension(bytes)).toBe('png');
      expect(bytes.readUInt32BE(16)).toBe(128);
      expect(bytes.readUInt32BE(20)).toBe(128);
    }
  } finally { await browser.close(); rmSync(directory, { recursive: true, force: true }); }
});
