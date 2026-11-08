import type { Locator, Page } from "playwright-core";
import { ChatGptWebAdapterError } from "./adapters/chatgpt-web/adapter-error";
import {
  CHATGPT_WEB_MODEL_ROW_LABELS,
  type ChatGptWebAccountCapabilities,
} from "./chatgpt-web-models";

export const CHATGPT_TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
export const CHATGPT_COMPOSER_SELECTOR = [
  '[data-testid="prompt-textarea"]',
  "#prompt-textarea",
  '[contenteditable="true"][data-lexical-editor="true"]',
  '[role="textbox"][aria-label="Ask ChatGPT"]',
  '.ProseMirror[contenteditable="true"]',
].join(", ");
export const CHATGPT_EFFORT_CONTROL_SELECTOR = [
  'button[aria-haspopup="menu"][data-tone="neutral"]',
  'button[data-testid="model-switcher-dropdown-button"][aria-haspopup="menu"]',
  // 2026-10 UI: a plain button whose stable hooks are aria-haspopup="menu" plus a localized
  // aria-label. Match the zh label and a bilingual pattern so the probe does not silently
  // degrade to a Luna-only account on non-English UI.
  'button[aria-haspopup="menu"][aria-label="选择 ChatGPT 模型"]',
  'button[aria-haspopup="menu"][aria-label*="ChatGPT"][aria-label*="model" i]',
].join(", ");
export const CHATGPT_EFFORT_MENU_SELECTOR = [
  '[data-testid="composer-intelligence-picker-content"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider], [data-model-picker-power-slider])',
  '[role="menu"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider], [data-model-picker-power-slider])',
  '[role="group"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider], [data-model-picker-power-slider])',
].join(", ");
export const CHATGPT_EFFORT_ITEM_SELECTOR = '[role="menuitemradio"]';
// 2026-10 UI renamed the wrapper attribute to data-model-picker-power-slider. Keep the old
// anchor so a rollback still resolves the slider.
export const CHATGPT_EFFORT_SLIDER_SELECTOR = [
  '[data-model-picker-power-slider] [role="slider"]',
  '[data-model-reasoning-effort-slider] [role="slider"]',
].join(", ");
export const CHATGPT_EFFORT_SLIDER_MAX_OPTIONS = 5;
export const CHATGPT_STOP_BUTTON_SELECTOR = [
  '[data-testid="stop-button"]',
  'button[aria-label="Stop"]',
].join(", ");
export const CHATGPT_COMPLETION_ACTION_SELECTOR = [
  'button[data-testid="copy-turn-action-button"]',
  'button[aria-label="Copy"]',
].join(", ");
export const CHATGPT_ASSISTANT_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="assistant"]',
  '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])',
  '[data-chatgpt-search-unit-key$=":assistant"]',
  '[data-content-search-unit-key$=":assistant"]',
].join(", ");
export const CHATGPT_USER_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="user"]',
  '[data-testid^="conversation-turn-"][data-message-author-role="user"]',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="user"])',
  '[data-chatgpt-search-unit-key$=":user"]',
  '[data-content-search-unit-key$=":user"]',
].join(", ");

export interface ChatGptEffortSliderState {
  min: number;
  max: number;
  value: number;
}

export interface ChatGptEffortActivation {
  method: "already-open" | "keyboard" | "click" | "pointerdown";
  menu: Locator;
  slider: Locator;
}

export interface ChatGptModelRowSelection {
  status: "selected" | "already-selected" | "not-applicable" | "unavailable" | "unconfirmed";
  label: string;
  availableLabels: string[];
  /** Picker menu after selection; it may have been reopened if selecting a row closed it. */
  menu: Locator;
}

function effortMenuSelectorForId(menuId: string): string {
  return `[id=${JSON.stringify(menuId)}]`;
}

export async function chatGptEffortMenuForControl(page: Page, control: Locator): Promise<Locator> {
  const menuId = await control.getAttribute("aria-controls").catch(() => null);
  if (menuId) return page.locator(effortMenuSelectorForId(menuId));
  return page.locator(CHATGPT_EFFORT_MENU_SELECTOR).filter({ visible: true }).last();
}

async function visibleEffortSurface(
  page: Page,
  control: Locator,
): Promise<{ menu: Locator; slider: Locator } | undefined> {
  const menu = await chatGptEffortMenuForControl(page, control);
  const slider = page.locator(CHATGPT_EFFORT_SLIDER_SELECTOR).filter({ visible: true }).last();
  if (await menu.isVisible().catch(() => false) || await slider.isVisible().catch(() => false)) {
    return { menu, slider };
  }
  return undefined;
}

async function waitForEffortSurface(
  page: Page,
  control: Locator,
  timeoutMs: number,
): Promise<{ menu: Locator; slider: Locator } | undefined> {
  const deadline = Date.now() + timeoutMs;
  do {
    const surface = await visibleEffortSurface(page, control);
    if (surface) return surface;
    if (Date.now() >= deadline) return undefined;
    await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
  } while (true);
}

async function clearGhostEffortState(page: Page, control: Locator): Promise<void> {
  const expanded = await control.getAttribute("aria-expanded").catch(() => null);
  const state = await control.getAttribute("data-state").catch(() => null);
  if (expanded === "true" || state === "open") {
    await page.keyboard.press("Escape").catch(() => {});
  }
}

export async function activateChatGptEffortMenu(
  page: Page,
  control: Locator,
  options: { settleMs?: number } = {},
): Promise<ChatGptEffortActivation> {
  const settleMs = options.settleMs ?? 3_000;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const openSurface = await visibleEffortSurface(page, control);
      if (openSurface) return { method: "already-open", ...openSurface };
      await clearGhostEffortState(page, control);

      // Prefer a semantic keyboard activation before any pointer input: pointer coordinates break
      // easily when ChatGPT overlays or re-renders the composer mid-turn.
      const keyboardFocused = await control.focus().then(
        () => control.evaluate(element => element === document.activeElement).catch(() => false),
        () => false,
      );
      if (keyboardFocused) {
        await control.press("Enter").catch(() => {});
        const keyboardSurface = await waitForEffortSurface(page, control, settleMs);
        if (keyboardSurface) return { method: "keyboard", ...keyboardSurface };
        await clearGhostEffortState(page, control);
      }

      await control.click({ force: true, timeout: Math.max(1, settleMs) });
      const clickedSurface = await waitForEffortSurface(page, control, settleMs);
      if (clickedSurface) return { method: "click", ...clickedSurface };

      await clearGhostEffortState(page, control);
      await control.dispatchEvent("pointerdown", {
        button: 0,
        buttons: 1,
        pointerType: "mouse",
        isPrimary: true,
      });
      const pointerSurface = await waitForEffortSurface(page, control, settleMs);
      if (pointerSurface) return { method: "pointerdown", ...pointerSurface };
    } catch (error) {
      lastError = error;
    }
    await clearGhostEffortState(page, control);
    if (attempt < 2) {
      await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
    }
  }
  throw new Error(
    "ChatGPT effort control did not expose its owned menu or structural slider after three activation attempts",
    { cause: lastError },
  );
}

function normalizeChatGptPickerLabel(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function matchesChatGptPickerLabel(name: string, label: string): boolean {
  return name === label || name.startsWith(`${label} `);
}

interface ChatGptPickerRow {
  row: Locator;
  names: string[];
  checked: string | null;
}

interface ChatGptPickerSnapshot {
  labels: string[];
  rows: ChatGptPickerRow[];
}

async function snapshotChatGptPickerMenu(menu: Locator): Promise<ChatGptPickerSnapshot> {
  const rows = menu.locator(CHATGPT_EFFORT_ITEM_SELECTOR);
  const count = await rows.count().catch(() => 0);
  const snapshot: ChatGptPickerSnapshot = { labels: [], rows: [] };
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const text = normalizeChatGptPickerLabel(await row.innerText().catch(() => null));
    const ariaLabel = normalizeChatGptPickerLabel(await row.getAttribute("aria-label").catch(() => null));
    const names = [...new Set([text, ariaLabel].filter(name => name.length > 0))];
    if (names[0]) snapshot.labels.push(names[0]);
    snapshot.rows.push({
      row,
      names,
      checked: await row.getAttribute("aria-checked").catch(() => null),
    });
  }
  return snapshot;
}

function findChatGptPickerRow(
  snapshot: ChatGptPickerSnapshot,
  label: string,
): ChatGptPickerRow | undefined {
  return snapshot.rows.find(({ names }) => names.some(name => matchesChatGptPickerLabel(name, label)));
}

function chatGptPickerExposesKnownModel(labels: readonly string[], knownLabels: readonly string[]): boolean {
  return labels.some(label => knownLabels.some(known => matchesChatGptPickerLabel(label, known)));
}

const CHATGPT_MODEL_VIEW_TOGGLE_SELECTOR = [
  '[data-model-picker-view-toggle="true"]',
  '[role="menuitem"][aria-label="Select model"]',
].join(", ");

async function chatGptModelRowIsInteractive(row: Locator): Promise<boolean> {
  // The default "simple" picker view renders the model-family list inert behind the effort
  // slider. A radio row there can be read but not activated.
  return row.evaluate(element => element.closest("[inert]") === null).catch(() => false);
}

/**
 * The picker opens in its "simple" effort view on most accounts. Its model-family rows live in
 * the alternate "advanced" view and are inert until the `Select model` toggle is activated.
 */
async function ensureChatGptModelListView(menu: Locator, label: string): Promise<boolean> {
  const target = findChatGptPickerRow(await snapshotChatGptPickerMenu(menu), label);
  if (!target) return false;
  if (await chatGptModelRowIsInteractive(target.row)) return true;
  const toggle = menu.locator(CHATGPT_MODEL_VIEW_TOGGLE_SELECTOR).first();
  if (await toggle.count().catch(() => 0) === 0) return false;
  await toggle.focus().catch(() => {});
  if (!await toggle.evaluate(element => element === document.activeElement).catch(() => false)) {
    return false;
  }
  await toggle.press("Enter").catch(() => {});
  const deadline = Date.now() + 5_000;
  do {
    const current = findChatGptPickerRow(await snapshotChatGptPickerMenu(menu), label);
    if (current && await chatGptModelRowIsInteractive(current.row)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
  } while (true);
}

async function waitForChatGptModelRowChecked(
  menu: Locator,
  label: string,
  timeoutMs: number,
): Promise<"checked" | "unchecked" | "absent"> {
  const deadline = Date.now() + timeoutMs;
  do {
    const snapshot = await snapshotChatGptPickerMenu(menu);
    const target = findChatGptPickerRow(snapshot, label);
    const state = target === undefined
      ? "absent"
      : target.checked === "true"
        ? "checked"
        : target.checked === "false"
          ? "unchecked"
          : "absent";
    if (state === "checked") return state;
    if (state === "absent" && !await menu.isVisible().catch(() => false)) return state;
    if (Date.now() >= deadline) return state;
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
  } while (true);
}

/**
 * Select the ChatGPT model-family row (for example `GPT-6` versus `GPT-5.6 Sol`) with semantic
 * keyboard actions only. The composer picker exposes model families as `menuitemradio` rows next
 * to the effort slider, so pointer coordinates are never used here.
 *
 * Returns `not-applicable` when the picker is a legacy effort-only menu with no model rows, and
 * `unavailable` when the picker exposes model families but not the requested one. The caller must
 * fail the turn in the latter case instead of silently running another family.
 */
export async function selectChatGptModelRow(
  page: Page,
  control: Locator,
  menu: Locator,
  label: string,
): Promise<ChatGptModelRowSelection> {
  const knownLabels = Object.values(CHATGPT_WEB_MODEL_ROW_LABELS);
  let currentMenu = menu;
  let snapshot = await snapshotChatGptPickerMenu(currentMenu);
  const availableLabels = snapshot.labels;
  // A model-family picker always carries the `Select model` view toggle, even if a future UI
  // renames the visible families. Use it to distinguish "family missing" from a legacy
  // effort-only menu where model rows never existed.
  const hasModelViewToggle = await currentMenu.locator(CHATGPT_MODEL_VIEW_TOGGLE_SELECTOR)
    .count().catch(() => 0) > 0;
  const initial = findChatGptPickerRow(snapshot, label);
  if (!initial) {
    return {
      status: hasModelViewToggle || chatGptPickerExposesKnownModel(snapshot.labels, knownLabels)
        ? "unavailable"
        : "not-applicable",
      label,
      availableLabels,
      menu: currentMenu,
    };
  }
  if (initial.checked === "true") {
    // If the picker is already in its advanced model-list view, activate the checked row once to
    // return to the effort view the caller drives next.
    if (await chatGptModelRowIsInteractive(initial.row)) {
      await initial.row.focus().catch(() => {});
      await initial.row.press("Enter").catch(() => {});
      await waitForChatGptModelRowChecked(currentMenu, label, 3_000);
    }
    if (!await currentMenu.isVisible().catch(() => false)) {
      try {
        currentMenu = (await activateChatGptEffortMenu(page, control)).menu;
      } catch {
        // The caller reopens from its activation handle if the menu closed.
      }
    }
    return { status: "already-selected", label, availableLabels, menu: currentMenu };
  }
  if (initial.checked !== "false") {
    return { status: "unavailable", label, availableLabels, menu: currentMenu };
  }

  if (!await ensureChatGptModelListView(currentMenu, label)) {
    return { status: "unconfirmed", label, availableLabels, menu: currentMenu };
  }

  for (const key of ["Enter", "Space"] as const) {
    const target = findChatGptPickerRow(await snapshotChatGptPickerMenu(currentMenu), label);
    if (!target || !await chatGptModelRowIsInteractive(target.row)) break;
    await target.row.focus().catch(() => {});
    if (!await target.row.evaluate(element => element === document.activeElement).catch(() => false)) {
      continue;
    }
    await target.row.press(key).catch(() => {});
    if (await waitForChatGptModelRowChecked(currentMenu, label, 4_000) === "checked") {
      // A successful activation normally returns the picker to its effort view without closing
      // it. If a build closes it instead, reopen so the caller can still drive the slider.
      if (!await currentMenu.isVisible().catch(() => false)) {
        try {
          currentMenu = (await activateChatGptEffortMenu(page, control)).menu;
        } catch {
          break;
        }
      }
      return { status: "selected", label, availableLabels, menu: currentMenu };
    }
  }

  const finalSnapshot = await snapshotChatGptPickerMenu(currentMenu);
  return {
    status: findChatGptPickerRow(finalSnapshot, label)
      ? "unconfirmed"
      : hasModelViewToggle || chatGptPickerExposesKnownModel(finalSnapshot.labels, knownLabels)
        ? "unavailable"
        : "unconfirmed",
    label,
    availableLabels: finalSnapshot.labels.length > 0 ? finalSnapshot.labels : availableLabels,
    menu: currentMenu,
  };
}

function safeIntegerAttribute(value: string | null): number | undefined {
  if (value === null || !/^-?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function parseChatGptEffortSliderState(
  rawMin: string | null,
  rawMax: string | null,
  rawValue: string | null,
): ChatGptEffortSliderState | undefined {
  const min = safeIntegerAttribute(rawMin);
  const max = safeIntegerAttribute(rawMax);
  const value = safeIntegerAttribute(rawValue);
  if (min === undefined || max === undefined || value === undefined) return undefined;
  const optionCount = max - min + 1;
  if (optionCount < 1 || optionCount > CHATGPT_EFFORT_SLIDER_MAX_OPTIONS) return undefined;
  if (value < min || value > max) return undefined;
  return { min, max, value };
}

async function anyVisible(locator: Locator): Promise<boolean> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

export async function assertAuthenticatedChatGptPage(page: Page): Promise<void> {
  const composer = page.locator(
    CHATGPT_COMPOSER_SELECTOR,
  );
  if (!await anyVisible(composer)) {
    throw new Error("ChatGPT authentication could not be verified: no visible composer is present");
  }
  if (new URL(page.url()).origin !== "https://chatgpt.com") {
    throw new Error("ChatGPT authentication could not be verified: unexpected page origin");
  }
  type SessionProbe = {
    kind: "authenticated" | "signed_out" | "profile_loading" | "http_error" | "invalid_response" | "network_error";
    status?: number;
  };
  let probe: SessionProbe = { kind: "network_error" };
  // A visible composer precedes profile/session hydration, particularly just after boot.
  // Retry this read-only check before treating an empty session as a lost login. Never
  // collapse network, challenge, rate-limit, or server failures into a credential error.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      probe = await page.evaluate(async (): Promise<SessionProbe> => {
        const signedOut = (status: number): SessionProbe => ({
          kind: [...document.querySelectorAll('[role="status"]')].some(element => (
            /^Loading (?:profile|chats)$/i.test(element.textContent?.trim() ?? "")
          )) ? "profile_loading" : "signed_out",
          status,
        });
        try {
          const response = await fetch("/api/auth/session", {
            credentials: "include",
            cache: "no-store",
            signal: AbortSignal.timeout(10_000),
          });
          if (response.status === 401) return signedOut(response.status);
          if (!response.ok) return { kind: "http_error", status: response.status };
          try {
            const session = await response.json();
            return typeof session?.user?.id === "string" && session.user.id.length > 0
              ? { kind: "authenticated", status: response.status } : signedOut(response.status);
          } catch {
            return { kind: "invalid_response", status: response.status };
          }
        } catch {
          return { kind: "network_error" };
        }
      });
    } catch (error) {
      if (page.isClosed()) throw error;
      probe = { kind: "network_error" };
    }
    if (probe.kind === "authenticated") return;
    console.warn(`[chatgpt-web] session_check attempt=${attempt + 1} outcome=${probe.kind} status=${probe.status ?? "none"}`);
    if (attempt < 2) await page.waitForTimeout(500 * (attempt + 1));
  }
  if (probe.kind === "signed_out") {
    throw new ChatGptWebAdapterError(
      "ChatGPT login is expired or signed out. Sign in to your account using the plugin's login command.",
      { status: 401, errorType: "authentication_error", code: "chatgpt_session_expired", retryable: false },
    );
  }
  throw new ChatGptWebAdapterError(
    `ChatGPT session check is temporarily unavailable (${probe.kind}${probe.status ? `, HTTP ${probe.status}` : ""}). Retry after the network and profile finish loading; your saved login has not been changed.`,
    { status: probe.status === 429 ? 429 : 503, errorType: probe.status === 429 ? "rate_limit_error" : "server_error",
      code: probe.status === 429 ? "rate_limit_exceeded" : "chatgpt_session_check_unavailable", retryable: true },
  );
}

export async function assertTemporaryChatPage(page: Page): Promise<void> {
  const url = new URL(page.url());
  const expected = new URL(CHATGPT_TEMPORARY_CHAT_URL);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.searchParams.get("temporary-chat") !== "true") {
    throw new Error(`ChatGPT left the isolated Temporary Chat surface (${page.url()})`);
  }
}

export async function detectChatGptAccountCapabilities(
  page: Page,
  options: { selectorTimeoutMs?: number; stableAbsenceMs?: number } = {},
): Promise<ChatGptWebAccountCapabilities> {
  const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
  const composer = composers.last();
  const composerForm = composer.locator("xpath=ancestor::form[1]");
  const effortButton = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).last();
  const deadline = Date.now() + (options.selectorTimeoutMs ?? 30_000);
  const stableAbsenceMs = options.stableAbsenceMs ?? 3_000;
  let absenceSince: number | undefined;
  let presenceObservations = 0;
  while (true) {
    const effortVisible = await effortButton.isVisible().catch(() => false);
    if (effortVisible) {
      presenceObservations += 1;
      absenceSince = undefined;
      if (presenceObservations >= 2) break;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
      continue;
    }
    presenceObservations = 0;
    const composerReady = await composers.count().then(count => count === 1).catch(() => false);
    const formReady = await composerForm.count().then(count => count === 1).catch(() => false);
    const documentReady = await page.evaluate(() => document.readyState === "complete").catch(() => false);
    if (composerReady && formReady && documentReady) {
      absenceSince ??= Date.now();
      if (Date.now() - absenceSince >= stableAbsenceMs) {
        return { solAvailable: false, proAvailable: false };
      }
    } else {
      absenceSince = undefined;
    }
    if (Date.now() >= deadline) {
      throw new Error("ChatGPT account capability probe did not reach a stable composer state");
    }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
  }
  const menu = page.locator(CHATGPT_EFFORT_MENU_SELECTOR).last();
  const menuVisible = await menu.isVisible().catch(() => false);
  const menuExpanded = await effortButton.getAttribute("aria-expanded").catch(() => null);
  if (!menuVisible && menuExpanded !== "true") await effortButton.press("Enter");
  try {
    const efforts = menu.locator(CHATGPT_EFFORT_ITEM_SELECTOR);
    const slider = page.locator(CHATGPT_EFFORT_SLIDER_SELECTOR).filter({ visible: true }).last();
    const waitAbort = new AbortController();
    try {
      const ready = await Promise.race([
        efforts.first().waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal })
          .then(() => "items" as const),
        slider.waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal })
          .then(() => "slider" as const),
      ]);
      const sliderVisible = ready === "slider" || await slider.isVisible().catch(() => false);
      if (!sliderVisible) {
        return { solAvailable: true, proAvailable: await efforts.count() >= 5 };
      }
      const state = parseChatGptEffortSliderState(
        await slider.getAttribute("aria-valuemin"),
        await slider.getAttribute("aria-valuemax"),
        await slider.getAttribute("aria-valuenow"),
      );
      if (!state) {
        throw new Error(
          "ChatGPT model controls are unavailable. Reload ChatGPT and run Repair again.",
          { cause: new Error("ChatGPT effort slider exposed an invalid ARIA range") },
        );
      }
      return { solAvailable: true, proAvailable: state.max - state.min + 1 >= 5 };
    } finally {
      waitAbort.abort();
    }
  } finally {
    await page.keyboard.press("Escape").catch(() => {});
  }
}
