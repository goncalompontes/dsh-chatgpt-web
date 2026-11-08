/** Shared ceiling for admission, physical workers and retained browser pages. */
export function browserTurnCeiling(value = process.env.DSH_CHATGPT_WEB_MAX_TURNS): number {
  if (value === undefined) return 32;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 128) {
    throw new Error("DSH_CHATGPT_WEB_MAX_TURNS must be an integer between 1 and 128");
  }
  return Number(value);
}

export const MAX_CHATGPT_BROWSER_TABS = browserTurnCeiling();
