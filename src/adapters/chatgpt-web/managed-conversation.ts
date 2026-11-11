import { createHash } from "node:crypto";
import type { CodexMessage } from "../../types";

/** Ignore parser timestamps and provider reasoning, which are not the visible assistant reply. */
export function conversationHistoryFingerprint(messages: readonly CodexMessage[]): string {
  return createHash("sha256").update(JSON.stringify(messages.map(message => {
    const { timestamp: _, ...fields } = message;
    const content = typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content.filter(part => part.type !== "thinking");
    // Model and phase are replay metadata; they can be absent when pi-ai reconstructs history.
    const { model: _model, phase: _phase, ...stable } = fields as typeof fields & { model?: string; phase?: string };
    return { ...stable, content };
  }))).digest("hex");
}

export function conversationPredecessorFingerprint(messages: readonly CodexMessage[]): string | undefined {
  const last = messages.findLastIndex(message => message.role === "assistant");
  return last < 0 ? undefined : conversationHistoryFingerprint(messages.slice(0, last + 1));
}

interface PageHandle { isClosed(): boolean; close(): Promise<unknown> }

/** Only idle, completed pages are retained. A canonical history mismatch always opens a new chat. */
export class ManagedConversationPool<T extends PageHandle> {
  private readonly idle = new Map<string, { page: T; fingerprint?: string }>();
  constructor(private readonly maxEntries: number) {}

  async take(key: string, fingerprint?: string): Promise<T | undefined> {
    const entry = this.idle.get(key);
    if (!entry) return undefined;
    this.idle.delete(key);
    if (!entry.page.isClosed() && fingerprint && fingerprint === entry.fingerprint) return entry.page;
    await entry.page.close();
    return undefined;
  }

  async put(key: string, page: T): Promise<void> {
    await this.release(key);
    if (page.isClosed()) return;
    // Retention can be disabled entirely on a memory-constrained host; keeping the page would
    // then leak one full renderer per completed conversation.
    if (this.maxEntries <= 0) {
      await page.close();
      return;
    }
    while (this.idle.size >= this.maxEntries) await this.release(this.idle.keys().next().value!);
    this.idle.set(key, { page });
  }

  commit(key: string, fingerprint: string): void {
    const entry = this.idle.get(key);
    if (entry) entry.fingerprint = fingerprint;
  }

  async trim(limit: number): Promise<void> {
    while (this.idle.size > Math.max(0, limit)) await this.release(this.idle.keys().next().value!);
  }

  async release(key: string): Promise<void> {
    const entry = this.idle.get(key);
    this.idle.delete(key);
    if (entry && !entry.page.isClosed()) await entry.page.close();
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled([...this.idle.keys()].map(key => this.release(key)));
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}
