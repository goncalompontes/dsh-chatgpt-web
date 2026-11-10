import { parseRetryAfterFromMessage } from "../../lib/errors";

/** Base delay for the first retry after a transient ChatGPT Web failure. */
export const CHATGPT_WEB_RETRY_BASE_DELAY_MS = 1_000;
/** Upper bound for a single computed backoff delay. */
export const CHATGPT_WEB_RETRY_MAX_DELAY_MS = 30_000;

export interface ChatGptWebBackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** Fraction of the delay added as random jitter, e.g. 0.25 for +0–25%. */
  jitterRatio?: number;
  random?: () => number;
}

/**
 * Exponential backoff for transient ChatGPT Web failures: base, 2×base, 4×base, …
 * capped at maxMs. Jitter keeps concurrent turns from retrying in lockstep; it only ever
 * extends a delay, so the cap still bounds behavior.
 */
export function chatGptWebBackoffDelayMs(
  attempt: number,
  options: ChatGptWebBackoffOptions = {},
): number {
  const baseMs = options.baseMs ?? CHATGPT_WEB_RETRY_BASE_DELAY_MS;
  const maxMs = options.maxMs ?? CHATGPT_WEB_RETRY_MAX_DELAY_MS;
  const jitterRatio = options.jitterRatio ?? 0.25;
  const random = options.random ?? Math.random;
  const exponent = Math.max(0, Math.min(16, Math.trunc(attempt) - 1));
  const exponential = Math.min(maxMs, baseMs * 2 ** exponent);
  const jitter = Math.max(0, random()) * jitterRatio * exponential;
  return Math.min(maxMs, Math.round(exponential + jitter));
}

/**
 * Delay requested by an upstream ChatGPT limit message ("try again in 20s"), converted to
 * milliseconds. Returns undefined when the message carries no usable hint.
 */
export function chatGptWebRetryAfterMs(message: string): number | undefined {
  const seconds = parseRetryAfterFromMessage(message);
  return seconds === undefined ? undefined : seconds * 1_000;
}

/** Wait for a retry delay without throwing for ordinary timer resolution. */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
