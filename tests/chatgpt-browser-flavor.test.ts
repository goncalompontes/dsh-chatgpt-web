import { expect, test } from "bun:test";
import {
  CHATGPT_WEB_BROWSER_USER_AGENT,
  chatGptBrowserLaunchProfile,
  resolveChatGptBrowserFlavor,
} from "../src/adapters/chatgpt-web/browser-worker";

const chrome = "/usr/bin/google-chrome-stable";
const shell = "/opt/chrome-headless-shell-linux64/chrome-headless-shell";

test("the headless shell build is recognized by its executable name", () => {
  expect(resolveChatGptBrowserFlavor(shell)).toBe("headless-shell");
  expect(resolveChatGptBrowserFlavor("/opt/chrome_headless_shell")).toBe("headless-shell");
  expect(resolveChatGptBrowserFlavor("/opt/chrome-headless-shell")).toBe("headless-shell");
  expect(resolveChatGptBrowserFlavor(chrome)).toBe("chrome");
  expect(resolveChatGptBrowserFlavor("/usr/bin/chromium")).toBe("chrome");
});

test("the configured headless binary only replaces the login Chrome for headless turns", () => {
  const headless = chatGptBrowserLaunchProfile({
    chromeExecutablePath: chrome,
    headlessBrowserExecutablePath: shell,
    headed: false,
  });
  expect(headless).toMatchObject({ flavor: "headless-shell", executablePath: shell, headless: true });

  // Login and other headed flows still need the full Chrome build.
  const headed = chatGptBrowserLaunchProfile({
    chromeExecutablePath: chrome,
    headlessBrowserExecutablePath: shell,
    headed: true,
  });
  expect(headed).toMatchObject({ flavor: "chrome", executablePath: chrome, headless: false });
  expect(headed.args).not.toContain("--headless=new");
});

test("a headless-shell launch keeps the automation args but drops the manual headless switch", () => {
  const profile = chatGptBrowserLaunchProfile({
    chromeExecutablePath: chrome,
    headlessBrowserExecutablePath: shell,
    headed: false,
  });
  expect(profile.args).not.toContain("--headless=new");
  expect(profile.args).toContain("--disable-blink-features=AutomationControlled");
  expect(profile.args).toContain("--window-size=1280,800");
  expect(profile.args).toContain(`--user-agent=${CHATGPT_WEB_BROWSER_USER_AGENT}`);
});

test("full Chrome keeps its explicit headless switch and UA override", () => {
  const profile = chatGptBrowserLaunchProfile({ chromeExecutablePath: chrome, headed: false });
  expect(profile).toMatchObject({ flavor: "chrome", executablePath: chrome, headless: false });
  expect(profile.args).toContain("--headless=new");
  expect(profile.args).toContain(`--user-agent=${CHATGPT_WEB_BROWSER_USER_AGENT}`);
});

test("headed Chrome omits both the headless switch and the UA override", () => {
  const profile = chatGptBrowserLaunchProfile({ chromeExecutablePath: chrome, headed: true });
  expect(profile.headless).toBe(false);
  expect(profile.args).not.toContain("--headless=new");
  expect(profile.args.some(arg => arg.startsWith("--user-agent="))).toBe(false);
});

test("a shell binary cannot serve a headed turn", () => {
  expect(() => chatGptBrowserLaunchProfile({ chromeExecutablePath: shell, headed: true }))
    .toThrow(/headless-shell cannot run headed/i);
});
