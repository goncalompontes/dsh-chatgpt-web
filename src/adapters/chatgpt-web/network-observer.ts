import type { Page } from "playwright-core";

/**
 * Network-native observation for the browser fallback.
 *
 * The page keeps owning submission, connector approval and the visible transcript, but the model
 * stream is the authoritative source for answer text, completion and upstream errors. This module
 * installs a non-destructive `fetch` tee in the page and exposes the captured SSE buffer to Node.
 *
 * The tee clones the response before returning it, so the page's own reader is untouched. It only
 * captures `/backend-api/conversation` and `/backend-api/f/conversation` requests.
 */

export interface ChatGptNetworkPageStream {
  id: number;
  url: string;
  method: string;
  startedAt: number;
  done: boolean;
  error?: string;
  /** Raw SSE bytes received so far, or only the new suffix when `offset` was supplied. */
  buffer: string;
  /** Start offset of the returned buffer in the full stream. */
  offset: number;
  /** Total bytes captured for this stream. */
  totalLength: number;
  truncated: boolean;
}

interface ChatGptNetworkPageState {
  nextId: number;
  streams: ChatGptNetworkPageStream[];
}

const MAX_STREAMS = 32;

/**
 * Installed in the page before application code. Must stay self-contained: Playwright serializes
 * this function, so it cannot close over Node-side values.
 */
export function installChatGptNetworkObserverInPage(): void {
  const scope = globalThis as unknown as {
    fetch: typeof fetch;
    __DSH_CHATGPT_NETWORK__?: ChatGptNetworkPageState;
    __DSH_CHATGPT_NETWORK_INSTALLED__?: boolean;
  };
  if (scope.__DSH_CHATGPT_NETWORK_INSTALLED__) return;
  scope.__DSH_CHATGPT_NETWORK_INSTALLED__ = true;
  const state: ChatGptNetworkPageState = scope.__DSH_CHATGPT_NETWORK__ ??= {
    nextId: 0,
    streams: [],
  };
  const originalFetch = scope.fetch;
  if (typeof originalFetch !== "function") return;

  const isConversationUrl = (url: string): boolean => (
    /\/backend-api\/(?:f\/)?conversation(?:[?#]|$)/.test(url)
  );

  scope.fetch = (async function capturedFetch(this: typeof globalThis, ...args: Parameters<typeof fetch>): Promise<Response> {
    const response = await originalFetch.apply(this, args);
    try {
      const input = args[0];
      const url = typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : String(input);
      if (!isConversationUrl(url) || !response.body) return response;
      const method = typeof input === "string"
        ? (args[1]?.method ?? "GET")
        : input instanceof Request
          ? input.method
          : (args[1]?.method ?? "GET");
      const stream: ChatGptNetworkPageStream = {
        id: ++state.nextId,
        url,
        method,
        startedAt: Date.now(),
        done: false,
        buffer: "",
        offset: 0,
        totalLength: 0,
        truncated: false,
      };
      state.streams.push(stream);
      while (state.streams.length > 32) state.streams.shift();
      const clone = response.clone();
      void (async () => {
        const reader = clone.body?.getReader();
        if (!reader) {
          stream.done = true;
          return;
        }
        const decoder = new TextDecoder();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (stream.truncated) continue;
          const text = decoder.decode(chunk.value, { stream: true });
          if (stream.buffer.length + text.length > 8_000_000) {
            stream.truncated = true;
            continue;
          }
          stream.buffer += text;
        }
        stream.done = true;
      })().catch(error => {
        stream.error = error instanceof Error ? error.message : String(error);
        stream.done = true;
      });
      return response;
    } catch {
      // Observation must never break the page's request.
      return response;
    }
  }) as typeof fetch;
}

/** Install the tee for the current page (idempotent) and for every later navigation. */
export async function installChatGptNetworkObservation(page: Page): Promise<void> {
  await page.addInitScript(installChatGptNetworkObserverInPage);
  await page.evaluate(installChatGptNetworkObserverInPage);
}

/**
 * Read the newest conversation stream started at or after `since`.
 *
 * The caller feeds the returned buffer into `ChatGptNetworkStreamParser`. Reading the raw buffer
 * instead of parsed JSON keeps this module protocol-agnostic and avoids page-side parsing.
 */
export async function readChatGptNetworkStream(
  page: Page,
  since: number,
  offset = 0,
): Promise<ChatGptNetworkPageStream | undefined> {
  return page.evaluate(({ since, maxStreams, offset }) => {
    const scope = globalThis as unknown as {
      __DSH_CHATGPT_NETWORK__?: ChatGptNetworkPageState;
    };
    const state = scope.__DSH_CHATGPT_NETWORK__;
    if (!state || !Array.isArray(state.streams)) return undefined;
    const streams = state.streams
      .filter(stream => stream.startedAt >= since)
      .slice(-maxStreams);
    const stream = streams[streams.length - 1];
    if (!stream) return undefined;
    const start = Math.max(0, Math.min(offset, stream.buffer.length));
    return {
      id: stream.id,
      url: stream.url,
      method: stream.method,
      startedAt: stream.startedAt,
      done: stream.done,
      ...(stream.error ? { error: stream.error } : {}),
      buffer: stream.buffer.slice(start),
      offset: start,
      totalLength: stream.buffer.length,
      truncated: stream.truncated,
    };
  }, { since, maxStreams: MAX_STREAMS, offset });
}
