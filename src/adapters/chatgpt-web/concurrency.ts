/** Shared ceiling for admission, physical workers and retained browser pages. */
export function browserTurnCeiling(value = process.env.DSH_CHATGPT_WEB_MAX_TURNS): number {
  if (value === undefined) return 32;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 128) {
    throw new Error("DSH_CHATGPT_WEB_MAX_TURNS must be an integer between 1 and 128");
  }
  return Number(value);
}

export const MAX_CHATGPT_BROWSER_TABS = browserTurnCeiling();

/**
 * Idle ChatGPT tabs kept resident for conversation continuity, independent of the turn ceiling.
 *
 * Every retained tab is a complete SPA renderer (~300-500 MiB). Retention previously shared the
 * turn ceiling, so a fan-out of subagent threads left one renderer per finished conversation
 * resident: ~30 idle tabs (about 10 GiB) stayed mapped while only two turns were active. A small
 * LRU keeps the ordinary follow-up path warm; a miss only replays canonical history into a fresh
 * Temporary Chat.
 */
export function retainedChatGptTabs(
  value = process.env.DSH_CHATGPT_WEB_RETAINED_TABS,
  ceiling = MAX_CHATGPT_BROWSER_TABS,
): number {
  if (value === undefined || value === "") return Math.min(2, ceiling);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > ceiling) {
    throw new Error(
      `DSH_CHATGPT_WEB_RETAINED_TABS must be an integer between 0 and ${ceiling}`,
    );
  }
  return Number(value);
}

export const MAX_RETAINED_CHATGPT_TABS = retainedChatGptTabs();

/**
 * Minimum admission while throttled/starting. Under the reactive policy the ceiling is the
 * normal capacity, so this only guarantees that an idle host can always probe one tab.
 */
export function browserTurnFloor(
  value = process.env.DSH_CHATGPT_WEB_MIN_TURNS,
  ceiling = MAX_CHATGPT_BROWSER_TABS,
): number {
  if (value === undefined || value === "") return 1;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 128) {
    throw new Error("DSH_CHATGPT_WEB_MIN_TURNS must be an integer between 1 and 128");
  }
  const floor = Number(value);
  if (floor > ceiling) {
    throw new Error("DSH_CHATGPT_WEB_MIN_TURNS must not exceed DSH_CHATGPT_WEB_MAX_TURNS");
  }
  return floor;
}

export const MIN_CHATGPT_BROWSER_TURNS = browserTurnFloor();

/**
 * Memory kept available for the rest of the host. New browser admissions are throttled while
 * MemAvailable is at or below this reserve; running turns are never preempted.
 */
export function browserMemoryReserveBytes(
  value = process.env.DSH_CHATGPT_WEB_MEMORY_RESERVE_MB,
): number {
  if (value === undefined || value === "") return 4 * 1024 ** 3;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 1024 * 1024) {
    throw new Error("DSH_CHATGPT_WEB_MEMORY_RESERVE_MB must be an integer between 0 and 1048576");
  }
  return Number(value) * 1024 ** 2;
}
