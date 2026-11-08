import { createHash } from "node:crypto";
import { dshCompactionEpoch } from "../../responses/dsh-context";
import type { AdapterEvent, CodexParsedRequest } from "../../types";
import type { BrokerToolRequest } from "./turn-broker";
import { chatGptBrowserTabClosedError } from "./adapter-error";
import {
  extractChatGptCompactionSourceRevision,
  extractChatGptTurnIdentity,
  extractChatGptTurnUserRevision,
} from "./environment";
import { MAX_CHATGPT_BROWSER_TABS } from "./concurrency";
import { ChatGptBrowserAdmission } from "./browser-admission";
import { BrowserAdmissionCapacityMonitor } from "./browser-capacity-monitor";
import { BrowserCapacityController, type BrowserCapacitySample } from "./browser-capacity";
import { BrowserWorkloadSampler } from "./browser-workload";
import type { ChatGptExternalTurnProgress } from "./turn-progress";

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    // Keep the underlying retirement promise observed even when the caller arrived after abort;
    // another owner may still depend on its eventual settlement and rejection must not become an
    // unhandled process-level error.
    void promise.catch(() => {});
    return Promise.reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export type ChatGptBrowserOutcome =
  | { type: "final"; answer: string }
  | { type: "error"; error: Error };

/** Match native wire ids first, then the response-item suffix added by DSH/pi-ai. */
export function outstandingChatGptToolCallId(
  value: string,
  session: Pick<ChatGptTurnSession, "hasOutstanding">,
): string | undefined {
  if (session.hasOutstanding(value)) return value;
  // DSH/pi-ai appends a pipe-delimited response-item suffix. Native call ids can
  // themselves contain pipes, so choose the longest outstanding prefix to avoid
  // delivering a result to a different pending invocation.
  for (let separator = value.lastIndexOf("|"); separator > 0; separator = value.lastIndexOf("|", separator - 1)) {
    const base = value.slice(0, separator);
    if (session.hasOutstanding(base)) return base;
  }
  return undefined;
}

export interface ChatGptTraceEvent {
  kind: "reasoning" | "commentary";
  text: string;
  continuation?: boolean;
}

interface TraceWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class ChatGptTraceFeed {
  private readonly queued: ChatGptTraceEvent[] = [];
  private readonly waiters = new Set<TraceWaiter>();

  push(event: ChatGptTraceEvent): void {
    const normalized = event.continuation ? event.text : event.text.trim();
    if (!normalized) return;
    const normalizedEvent = { ...event, text: normalized };
    this.queued.push(normalizedEvent);
    const waiter = this.waiters.values().next().value as TraceWaiter | undefined;
    if (!waiter) return;
    this.waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve();
  }

  drain(): ChatGptTraceEvent[] {
    return this.queued.splice(0);
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (this.queued.length > 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new DOMException("trace wait aborted", "AbortError"));
    return new Promise<void>((resolveWait, rejectWait) => {
      const waiter: TraceWaiter = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters.delete(waiter);
          rejectWait(new DOMException("trace wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }
}

interface TextWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Append-only browser Markdown feed. Waiters are notifications; `drain` owns consumption. */
export class ChatGptTextFeed {
  private readonly queued: string[] = [];
  private readonly waiters = new Set<TextWaiter>();
  private text = "";

  push(delta: string): void {
    if (!delta) return;
    this.text += delta;
    this.queued.push(delta);
    const waiter = this.waiters.values().next().value as TextWaiter | undefined;
    if (!waiter) return;
    this.waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve();
  }

  drain(): string[] {
    return this.queued.splice(0);
  }

  value(): string {
    return this.text;
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (this.queued.length > 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new DOMException("text wait aborted", "AbortError"));
    return new Promise<void>((resolveWait, rejectWait) => {
      const waiter: TextWaiter = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters.delete(waiter);
          rejectWait(new DOMException("text wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }
}

interface ChatGptTurnRuntimeBase {
  browser: Promise<string>;
  /** Physical helper/Playwright settlement, including the launcher end/release acknowledgement. */
  physicalSettlement: Promise<void>;
  trace: ChatGptTraceFeed;
  text: ChatGptTextFeed;
  usageInput?: CodexParsedRequest;
  inputAccounting?: import("./usage").ChatGptWebInputAccounting;
  /** Most recently delivered MCP input, retained when a settled response is replayed. */
  continuationInputAccounting?: import("./usage").ChatGptWebInputAccounting;
  conversationKey?: string;
  releaseRetainedConversation?: () => Promise<void>;
  /** Idempotently retire the turn-bound MCP capability after browser and observer settlement. */
  retireCapability?: () => void | Promise<void>;
  submission?: { phase: "prepared" | "send_activated" | "accepted" };
  /** Present only when the visible ChatGPT tab is driven manually through the Codex Zero Risk MCP contract. */
  manualControl?: { surfaceNonce: string };
  cancel: (reason?: Error) => void;
}

export type ChatGptTurnRuntime =
  | (ChatGptTurnRuntimeBase & {
    mode: "tools";
    token: Promise<string>;
    externalProgress: ChatGptExternalTurnProgress;
  })
  | (ChatGptTurnRuntimeBase & { mode: "read-only" });

function executionKey(parsed: CodexParsedRequest, payload: unknown): string {
  return createHash("sha256").update(JSON.stringify({
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning,
    payload,
  })).digest("hex");
}

function compactionInputRevision(parsed: CodexParsedRequest): unknown[] {
  const body = parsed._rawBody;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("ChatGPT web compaction requires the complete native Codex request body");
  }
  const input = (body as { input?: unknown }).input;
  if (!Array.isArray(input)) {
    throw new Error("ChatGPT web compaction requires the complete native Codex input history");
  }
  return input;
}

export function chatGptTurnExecutionKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  const checkpoint = dshCompactionEpoch(parsed);
  if (!identity.turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-session replay");
  return executionKey(parsed, {
    threadId: identity.threadId,
    turnId: identity.turnId,
    ...(checkpoint ? { dshCheckpoint: checkpoint } : {}),
    purpose: parsed._compactionRequest ? "compaction" : "response",
    revision: parsed._compactionRequest
      ? compactionInputRevision(parsed)
      : extractChatGptTurnUserRevision(parsed),
  });
}

/** Exact canonical Responses request identity inside one long-lived browser execution. */
export function chatGptTurnRoundKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for round replay");
  const body = parsed._rawBody;
  if (!body || typeof body !== "object" || Array.isArray(body)
    || !Array.isArray((body as { input?: unknown }).input)) {
    throw new Error("ChatGPT web requires the complete native Codex input for round replay");
  }
  return executionKey(parsed, {
    threadId: identity.threadId,
    turnId: identity.turnId,
    purpose: parsed._compactionRequest ? "compaction" : "response",
    input: (body as { input: unknown[] }).input,
  });
}

/** Stable identity for limiting automatic retries of one native Codex turn. */
export function chatGptTurnRetryKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  const checkpoint = dshCompactionEpoch(parsed);
  if (!identity.turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-turn retry budgeting");
  return createHash("sha256").update(JSON.stringify({
    threadId: identity.threadId,
    turnId: identity.turnId,
    ...(checkpoint ? { dshCheckpoint: checkpoint } : {}),
    purpose: parsed._compactionRequest ? "compaction" : "response",
  })).digest("hex");
}

/** One native Codex thread may own at most one live ChatGPT browser surface. */
export function chatGptThreadOwnershipKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  const owner = identity.threadId
    ? { kind: "thread", id: identity.threadId }
    : identity.promptCacheKey
      ? { kind: "prompt_cache", id: identity.promptCacheKey }
      : identity.turnId
        ? { kind: "turn", id: identity.turnId }
        : undefined;
  if (!owner) throw new Error("ChatGPT web requires native Codex turn identity metadata for browser ownership");
  return createHash("sha256").update(JSON.stringify(owner)).digest("hex");
}

/** Locate the browser response that a native mid-turn compaction replaces. */
export function chatGptCompactionSourceExecutionKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-session replay");
  const source = extractChatGptCompactionSourceRevision(parsed);
  return executionKey(parsed, {
    threadId: identity.threadId,
    turnId: source.turnId ?? identity.turnId,
    purpose: "response",
    revision: source.content,
  });
}

export class ChatGptTurnSession {
  /** Prevent delayed requests from rolling a live native turn back to a retired checkpoint. */
  readonly supersededCheckpointKeys = new Set<string>();
  readonly createdAt = Date.now();
  private lastTouchedAt = this.createdAt;
  readonly browserOutcome: Promise<ChatGptBrowserOutcome>;
  readonly physicalSettlement: Promise<void>;
  private readonly outstandingById = new Map<string, BrokerToolRequest>();
  private readonly deliveredResultIds = new Set<string>();
  private outstandingReasoning: string[] = [];
  private finalReasoning: string[] = [];
  private outstandingPrelude: AdapterEvent[] = [];
  private finalPrelude: AdapterEvent[] = [];
  private settledBrowserOutcome?: ChatGptBrowserOutcome;
  private settledPhysical = false;
  private attachedConversationKey: string | undefined;
  private tail: Promise<void> = Promise.resolve();
  private capabilityRetirementScheduled = false;
  private readonly rounds = new Map<string, {
    events: AdapterEvent[];
    reasoning: string[];
    completed: boolean;
    failure?: Error;
  }>();

  constructor(
    readonly runtime: ChatGptTurnRuntime,
    readonly traceId?: string,
    readonly ownerKey?: string,
    readonly nativeTurnId?: string,
    readonly nativeThreadId?: string,
    readonly dshCheckpointEpoch?: string,
  ) {
    this.attachedConversationKey = runtime.conversationKey;
    this.physicalSettlement = runtime.physicalSettlement.then(
      () => { this.settledPhysical = true; },
      error => {
        this.settledPhysical = true;
        throw error;
      },
    );
    this.browserOutcome = runtime.browser
      .then(answer => ({ type: "final", answer }) as ChatGptBrowserOutcome)
      .catch(error => ({ type: "error", error: error instanceof Error ? error : new Error(String(error)) }) as ChatGptBrowserOutcome)
      .then(outcome => {
      this.settledBrowserOutcome = outcome;
      return outcome;
    });
  }

  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    this.touch();
    const run = this.tail.then(task);
    this.tail = run.then(() => undefined, () => undefined);
    this.scheduleCapabilityRetirement();
    return run;
  }

  touch(): void {
    this.lastTouchedAt = Date.now();
  }

  lastUsedAt(): number {
    return this.lastTouchedAt;
  }

  outstanding(): BrokerToolRequest[] {
    return [...this.outstandingById.values()];
  }

  settledOutcome(): ChatGptBrowserOutcome | undefined {
    return this.settledBrowserOutcome;
  }

  conversationKey(): string | undefined {
    return this.attachedConversationKey;
  }

  detachConversation(conversationKey: string): boolean {
    if (this.attachedConversationKey !== conversationKey) return false;
    this.attachedConversationKey = undefined;
    return true;
  }

  isActive(): boolean {
    return this.settledBrowserOutcome === undefined;
  }

  /** The client-visible browser result can settle before launcher/helper cleanup does. */
  isPhysicallySettled(): boolean {
    return this.settledPhysical;
  }

  setOutstanding(requests: BrokerToolRequest[], reasoning: string[] = [], prelude: AdapterEvent[] = []): void {
    if (this.outstandingById.size > 0) throw new Error("cannot emit a new ChatGPT tool batch while the previous batch is unresolved");
    for (const request of requests) {
      if (this.deliveredResultIds.has(request.callId) || this.outstandingById.has(request.callId)) {
        throw new Error(`duplicate ChatGPT bridge tool call id: ${request.callId}`);
      }
      this.outstandingById.set(request.callId, request);
    }
    this.outstandingReasoning = [...reasoning];
    this.outstandingPrelude = [...prelude];
  }

  hasOutstanding(callId: string): boolean {
    return this.outstandingById.has(callId);
  }

  markResultDelivered(callId: string): void {
    if (!this.outstandingById.delete(callId)) throw new Error(`ChatGPT bridge tool result does not match an outstanding call: ${callId}`);
    this.deliveredResultIds.add(callId);
    if (this.outstandingById.size === 0) {
      this.outstandingReasoning = [];
      this.outstandingPrelude = [];
    }
  }

  reasoningForOutstandingReplay(): string[] {
    return [...this.outstandingReasoning];
  }

  eventsForOutstandingReplay(): AdapterEvent[] {
    return [...this.outstandingPrelude];
  }

  setFinalReasoning(reasoning: string[]): void {
    this.finalReasoning = [...reasoning];
  }

  reasoningForFinalReplay(): string[] {
    return [...this.finalReasoning];
  }

  setFinalEvents(events: AdapterEvent[]): void {
    this.finalPrelude = [...events];
  }

  eventsForFinalReplay(): AdapterEvent[] {
    return [...this.finalPrelude];
  }

  roundEvents(key: string): AdapterEvent[] {
    return [...this.round(key).events];
  }

  roundReasoning(key: string): string[] {
    return [...this.round(key).reasoning];
  }

  appendRoundEvent(key: string, event: AdapterEvent): void {
    this.appendRoundEvents(key, [event]);
  }

  appendRoundEvents(key: string, events: readonly AdapterEvent[]): void {
    if (events.length === 0) return;
    const round = this.round(key);
    if (round.completed) throw new Error("cannot append to a completed ChatGPT native round");
    round.events.push(...events);
  }

  appendRoundReasoning(key: string, values: readonly string[]): void {
    if (values.length === 0) return;
    const round = this.round(key);
    if (round.completed) throw new Error("cannot append reasoning to a completed ChatGPT native round");
    round.reasoning.push(...values);
  }

  completeRound(key: string): void {
    this.round(key).completed = true;
  }

  failRound(key: string, error: Error): void {
    const round = this.round(key);
    round.failure = error;
    round.completed = true;
  }

  roundCompleted(key: string): boolean {
    return this.rounds.get(key)?.completed === true;
  }

  roundFailure(key: string): Error | undefined {
    return this.rounds.get(key)?.failure;
  }

  roundHasTerminalEvent(key: string): boolean {
    return this.rounds.get(key)?.events.some(event => event.type === "done" || event.type === "error") === true;
  }

  cancel(reason?: Error): void {
    this.runtime.cancel(reason);
  }

  private scheduleCapabilityRetirement(): void {
    if (this.capabilityRetirementScheduled || !this.runtime.retireCapability) return;
    this.capabilityRetirementScheduled = true;
    // Register only after the first observer entered `runExclusive`. This ensures an immediately
    // completed mocked/real browser cannot revoke its token ahead of the browser-outcome branch.
    // At physical settlement, read the current tail so every tool-result/reconnect observer that
    // was already admitted finishes before the capability is retired.
    void this.physicalSettlement
      // Teardown can reject after the browser turn has physically ended. The capability must
      // still be revoked, but the original settlement failure remains visible to its callers.
      .then(() => this.tail, () => this.tail)
      .then(() => this.runtime.retireCapability!())
      .catch(error => {
        console.error(
          `[chatgpt-web] failed to retire settled turn capability: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  private round(key: string) {
    let round = this.rounds.get(key);
    if (round) return round;
    round = { events: [], reasoning: [], completed: false };
    this.rounds.set(key, round);
    while (this.rounds.size > 512) {
      const oldestCompleted = [...this.rounds].find(([, candidate]) => candidate.completed);
      if (!oldestCompleted) {
        throw new Error("ChatGPT native round journal is full (512 unfinished rounds)");
      }
      this.rounds.delete(oldestCompleted[0]);
    }
    return round;
  }
}

export class ChatGptTurnSessions {
  private readonly entries = new Map<string, ChatGptTurnSession>();
  private readonly conversationHeads = new Map<string, ChatGptTurnSession>();
  private readonly retirements = new Map<string, Promise<void>>();
  private readonly ownerRetirements = new Map<string, Promise<void>>();
  private readonly checkpointPredecessors = new Map<string, { keys: Set<string>; updatedAt: number }>();
  private readonly conversationRetirements = new Map<string, Promise<void>>();
  private readonly admission = new ChatGptBrowserAdmission(MAX_CHATGPT_BROWSER_TABS);
  private readonly capacityMonitor?: BrowserAdmissionCapacityMonitor;

  constructor(
    private readonly ttlMs = 30 * 60_000,
    private readonly maxEntries = 256,
    adaptiveSample?: (active: number) => BrowserCapacitySample | null,
  ) {
    if (adaptiveSample) {
      this.capacityMonitor = new BrowserAdmissionCapacityMonitor(
        this.admission, new BrowserCapacityController(), () => adaptiveSample(this.admission.snapshot().active),
      );
    }
  }

  getOrCreate(
    key: string,
    start: () => ChatGptTurnRuntime,
    traceId?: string,
    ownerKey?: string,
    nativeTurnId?: string,
    nativeThreadId?: string,
    dshCheckpointEpoch?: string,
  ): ChatGptTurnSession {
    this.prune();
    const existing = this.entries.get(key);
    if (existing) {
      existing.touch();
      return existing;
    }
    const active = [...this.entries.values()].filter(session => session.isActive()).length;
    if (active >= MAX_CHATGPT_BROWSER_TABS) {
      throw new Error(
        `ChatGPT Web supports at most ${MAX_CHATGPT_BROWSER_TABS} simultaneous browser turns; close or finish a browser tab before starting another`,
      );
    }
    if (this.entries.size >= this.maxEntries) throw new Error(`ChatGPT web session registry is full (${this.maxEntries} entries)`);
    const session = new ChatGptTurnSession(start(), traceId, ownerKey, nativeTurnId, nativeThreadId, dshCheckpointEpoch);
    this.entries.set(key, session);
    const conversationKey = session.conversationKey();
    if (conversationKey) this.conversationHeads.set(conversationKey, session);
    return session;
  }

  async getOrCreateAfterOwnerRetirement(
    key: string,
    ownerKey: string,
    start: () => ChatGptTurnRuntime,
    traceId?: string,
    signal?: AbortSignal,
    nativeTurnId?: string,
    nativeThreadId?: string,
    dshCheckpointEpoch?: string,
  ): Promise<ChatGptTurnSession> {
    const checkpointOwner = JSON.stringify([ownerKey, nativeThreadId, nativeTurnId]);
    for (;;) {
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      if (this.checkpointPredecessors.get(checkpointOwner)?.keys.has(key)) throw new Error("DSH request refers to a superseded checkpoint execution");
      if ([...this.entries.values()].some(session => session.ownerKey === ownerKey
        && session.nativeThreadId === nativeThreadId && session.nativeTurnId === nativeTurnId
        && session.supersededCheckpointKeys.has(key))) {
        throw new Error("DSH request refers to a superseded checkpoint execution");
      }
      const existing = this.entries.get(key);
      if (existing) {
        existing.touch();
        return existing;
      }
      const pending = this.retirements.get(key) ?? this.ownerRetirements.get(ownerKey);
      if (pending) {
        await awaitWithAbort(pending, signal);
        continue;
      }
      const activeOwner = [...this.entries].find(([ownedKey, session]) => (
        ownedKey !== key && session.ownerKey === ownerKey && !session.isPhysicallySettled()
      ));
      if (activeOwner) {
        const [ownedKey, ownedSession] = activeOwner;
        if (ownedSession.supersededCheckpointKeys.has(key)) throw new Error("DSH request refers to a superseded checkpoint execution");
        if (dshCheckpointEpoch && nativeTurnId && nativeThreadId
          && ownedSession.nativeTurnId === nativeTurnId && ownedSession.nativeThreadId === nativeThreadId
          && ownedSession.dshCheckpointEpoch !== dshCheckpointEpoch) {
          // Native compaction can replace history after a tool ran but before its
          // result reaches this waiting browser. That execution can never finish
          // normally. Retire its capability and wait for physical cleanup before
          // opening the new checkpoint; never re-invoke its delivered tool.
          if (ownedSession.supersededCheckpointKeys.size >= 1024) throw new Error("DSH checkpoint transition limit reached");
          for (const [owner, pending] of this.checkpointPredecessors) {
            if (pending.updatedAt < Date.now() - this.ttlMs) this.checkpointPredecessors.delete(owner);
          }
          if (!this.checkpointPredecessors.has(checkpointOwner) && this.checkpointPredecessors.size >= this.maxEntries) {
            throw new Error("DSH checkpoint retirement registry is full");
          }
          this.checkpointPredecessors.set(checkpointOwner, {
            keys: new Set([...ownedSession.supersededCheckpointKeys, ownedKey]), updatedAt: Date.now(),
          });
          this.entries.delete(ownedKey);
          this.forgetConversationHead(ownedSession);
          await awaitWithAbort(this.beginRetirement(ownedKey, ownedSession), signal);
          continue;
        }
        // A different native message for the same thread is sequential work, not permission to
        // kill the response already using that retained conversation. Wait for its complete
        // browser/launcher settlement. Only an explicit lifecycle operation or the
        // same-turn checkpoint transition above may preempt an active owner.
        // A failed launcher teardown has still physically settled. Do not poison the next
        // native owner's admission with the previous helper's cleanup error.
        await awaitWithAbort(ownedSession.physicalSettlement.then(() => {}, () => {}), signal);
        continue;
      }
      this.capacityMonitor?.start();
      const release = await this.admission.acquire(signal);
      let transferred = false;
      try {
        if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
        const raced = this.entries.get(key);
        if (raced) {
          raced.touch();
          return raced;
        }
        const competingOwner = [...this.entries].some(([ownedKey, session]) => (
          ownedKey !== key && session.ownerKey === ownerKey && !session.isPhysicallySettled()
        ));
        if (competingOwner || this.ownerRetirements.has(ownerKey) || this.retirements.has(key)) {
          continue;
        }
        // Admission may have waited while another request replaced this checkpoint.
        if (this.checkpointPredecessors.get(checkpointOwner)?.keys.has(key)
          || [...this.entries.values()].some(session => session.ownerKey === ownerKey
            && session.nativeThreadId === nativeThreadId && session.nativeTurnId === nativeTurnId
            && session.supersededCheckpointKeys.has(key))) {
          throw new Error("DSH request refers to a superseded checkpoint execution");
        }
        const session = this.getOrCreate(key, start, traceId, ownerKey, nativeTurnId, nativeThreadId, dshCheckpointEpoch);
        // Keep the transition journal on the registry until a replacement really
        // starts: the request initiating retirement may be cancelled while draining.
        const predecessors = this.checkpointPredecessors.get(checkpointOwner);
        if (predecessors) {
          for (const previous of predecessors.keys) session.supersededCheckpointKeys.add(previous);
          this.checkpointPredecessors.delete(checkpointOwner);
        }
        // A lease outlives the logical response until the browser/helper physically settles.
        void session.physicalSettlement.then(release, release);
        transferred = true;
        return session;
      } finally {
        if (!transferred) release();
      }
    }
  }

  find(key: string): ChatGptTurnSession | undefined {
    const session = this.entries.get(key);
    session?.touch();
    return session;
  }

  findConversationHead(conversationKey: string): ChatGptTurnSession | undefined {
    const session = this.conversationHeads.get(conversationKey);
    session?.touch();
    return session;
  }

  /** Wait for a retained conversation epoch that has been detached but not physically released. */
  async waitForConversationRetirement(conversationKey: string, signal?: AbortSignal): Promise<void> {
    const pending = this.conversationRetirements.get(conversationKey);
    if (pending) await awaitWithAbort(pending, signal);
  }

  async retireConversationAndWait(conversationKey: string): Promise<number> {
    return this.closeConversationAndWait(conversationKey);
  }

  /**
   * Close the physical retained-chat epoch without discarding a terminal response that won the
   * compaction race before any compaction instruction reached that response. The detached logical
   * session remains addressable by its exact Responses execution key, so the post-compaction
   * native round can consume the already-committed answer instead of opening another browser turn.
   */
  async retireConversationPreservingFinalResponse(
    conversationKey: string,
    preserved: ChatGptTurnSession,
    preservedExecutionKey: string,
  ): Promise<number> {
    if (!preservedExecutionKey) throw new Error("Preserved ChatGPT response execution key is required");
    const outcome = preserved.settledOutcome();
    if (!outcome || outcome.type !== "final") {
      throw new Error("Only a settled final ChatGPT response can survive retained-conversation retirement");
    }
    return this.closeConversationAndWait(conversationKey, {
      session: preserved,
      executionKey: preservedExecutionKey,
    });
  }

  private async closeConversationAndWait(
    conversationKey: string,
    preserved?: { session: ChatGptTurnSession; executionKey: string },
  ): Promise<number> {
    const pending = this.conversationRetirements.get(conversationKey);
    if (pending) {
      await pending;
      return 0;
    }
    const matches = [...this.entries].filter(([, session]) => (
      session.conversationKey() === conversationKey
    ));
    if (matches.length === 0) return 0;
    if (preserved && !matches.some(([, session]) => session === preserved.session)) {
      throw new Error("The final ChatGPT response does not own the retained conversation being retired");
    }
    const target = preserved ? this.entries.get(preserved.executionKey) : undefined;
    if (target && target !== preserved?.session) {
      throw new Error("The compacted ChatGPT response execution key is already owned by another session");
    }
    this.conversationHeads.delete(conversationKey);
    for (const [key, session] of matches) {
      if (this.entries.get(key) === session
        && (session !== preserved?.session || key !== preserved.executionKey)) {
        this.entries.delete(key);
      }
      if (session.isActive()) session.cancel();
      if (!session.detachConversation(conversationKey)) {
        throw new Error("ChatGPT retained-conversation ownership changed during retirement");
      }
    }
    if (preserved) this.entries.set(preserved.executionKey, preserved.session);
    const release = matches.findLast(([, session]) => (
      session.runtime.releaseRetainedConversation !== undefined
    ))?.[1].runtime.releaseRetainedConversation;
    // Release the retained browser epoch even if launcher teardown fails. A rejected
    // physical settlement must remain visible to the caller, not strand the retained tab.
    const retirement = Promise.all(matches.map(([, session]) => session.physicalSettlement))
      .then(() => undefined)
      .finally(async () => { await release?.(); });
    this.conversationRetirements.set(conversationKey, retirement);
    try {
      await retirement;
    } finally {
      if (this.conversationRetirements.get(conversationKey) === retirement) {
        this.conversationRetirements.delete(conversationKey);
      }
    }
    return matches.length;
  }

  async waitForRetirement(key: string): Promise<void> {
    await this.retirements.get(key);
  }

  async retireAndWait(key: string, signal?: AbortSignal): Promise<boolean> {
    const pending = this.retirements.get(key);
    if (pending) {
      await awaitWithAbort(pending, signal);
      return true;
    }
    const session = this.entries.get(key);
    if (!session) return false;

    this.entries.delete(key);
    this.forgetConversationHead(session);
    await awaitWithAbort(this.beginRetirement(key, session), signal);
    return true;
  }

  retire(key: string, session: ChatGptTurnSession): boolean {
    if (this.entries.get(key) !== session) return false;
    this.entries.delete(key);
    this.forgetConversationHead(session);
    this.beginRetirement(key, session);
    return true;
  }

  /** Cancel only active responses whose exact native turn ids Codex marked as interrupted. */
  retireAbortedOwnerTurns(
    ownerKey: string,
    abortedTurnIds: ReadonlySet<string>,
    keepKey: string,
  ): number {
    const matches = [...this.entries].filter(([key, session]) => (
      key !== keepKey
      && session.ownerKey === ownerKey
      && session.nativeTurnId !== undefined
      && abortedTurnIds.has(session.nativeTurnId)
      && session.isActive()
    ));
    for (const [key, session] of matches) {
      this.entries.delete(key);
      this.forgetConversationHead(session);
      this.beginRetirement(key, session);
    }
    return matches.length;
  }

  clear(): number {
    const cancelled = this.entries.size;
    for (const [key, session] of this.entries) this.beginRetirement(key, session);
    this.entries.clear();
    this.conversationHeads.clear();
    return cancelled;
  }

  async cancelTrace(traceId: string, reason = chatGptBrowserTabClosedError()): Promise<number> {
    const sessions = [...this.entries.values()]
      .filter(session => session.traceId === traceId && session.isActive());
    for (const session of sessions) session.cancel(reason);
    await Promise.all(sessions.map(session => session.physicalSettlement));
    return sessions.length;
  }

  /**
   * Begin retiring only the browser execution owned by the exact native Codex turn.
   *
   * Codex runs Interrupt hooks synchronously with a short deadline. Ownership is removed and the
   * abort is delivered before this method returns; physical helper cleanup remains represented by
   * `settlement`, so replacement turns still serialize behind the real teardown without blocking
   * the hook acknowledgement itself.
   */
  cancelNativeTurn(
    threadId: string,
    turnId: string,
    reason: Error,
  ): { cancelled: number; settlement: Promise<void> } {
    const matches = [...this.entries].filter(([, session]) => (
      session.nativeThreadId === threadId
      && session.nativeTurnId === turnId
    ));
    for (const [key, session] of matches) {
      if (this.entries.get(key) !== session) continue;
      this.entries.delete(key);
      this.forgetConversationHead(session);
    }
    const settlement = Promise.all(
      matches.map(([key, session]) => this.beginRetirement(key, session, reason)),
    ).then(() => undefined);
    return { cancelled: matches.length, settlement };
  }

  cancelledError(traceId: string): Error | undefined {
    for (const session of this.entries.values()) {
      if (session.traceId !== traceId) continue;
      const outcome = session.settledOutcome();
      if (outcome?.type !== "error") continue;
      if ("code" in outcome.error && outcome.error.code === "client_cancelled") return outcome.error;
    }
    return undefined;
  }

  activeCount(): number {
    this.prune();
    let active = 0;
    for (const session of this.entries.values()) if (session.isActive()) active += 1;
    return active;
  }

  admissionMetrics() {
    return { ...this.admission.metrics(), maxCapacity: MAX_CHATGPT_BROWSER_TABS,
      resources: this.capacityMonitor?.resources() ?? null };
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, session] of this.entries) {
      if (session.isActive() || session.lastUsedAt() >= cutoff) continue;
      session.cancel();
      this.entries.delete(key);
      this.forgetConversationHead(session);
    }
  }

  private forgetConversationHead(session: ChatGptTurnSession): void {
    const conversationKey = session.conversationKey();
    if (conversationKey && this.conversationHeads.get(conversationKey) === session) {
      this.conversationHeads.delete(conversationKey);
    }
  }

  private beginRetirement(key: string, session: ChatGptTurnSession, reason?: Error): Promise<void> {
    const existing = this.retirements.get(key);
    if (existing) return existing;
    const conversationKey = session.conversationKey();
    session.cancel(reason);
    const retirement = session.physicalSettlement;
    // A rejected physical teardown is an error to the caller, but it must not strand the
    // registry's admission barriers or generate unhandled cleanup-chain rejections.
    const settled = retirement.then(() => {}, () => {});
    this.retirements.set(key, settled);
    void settled.then(() => {
      if (this.retirements.get(key) === settled) this.retirements.delete(key);
    });
    if (session.ownerKey) {
      const previous = this.ownerRetirements.get(session.ownerKey);
      const ownerRetirement = previous
        ? Promise.all([previous, settled]).then(() => undefined)
        : settled;
      this.ownerRetirements.set(session.ownerKey, ownerRetirement);
      void ownerRetirement.then(() => {
        if (this.ownerRetirements.get(session.ownerKey!) === ownerRetirement) {
          this.ownerRetirements.delete(session.ownerKey!);
        }
      });
    }
    if (conversationKey) {
      const previous = this.conversationRetirements.get(conversationKey);
      const conversationRetirement = previous
        ? Promise.all([previous, settled]).then(() => undefined)
        : settled;
      this.conversationRetirements.set(conversationKey, conversationRetirement);
      const forgetConversationRetirement = () => {
        if (this.conversationRetirements.get(conversationKey) === conversationRetirement) {
          this.conversationRetirements.delete(conversationKey);
        }
      };
      void conversationRetirement.then(
        forgetConversationRetirement,
        forgetConversationRetirement,
      );
    }
    return retirement;
  }
}

// Keep tests and auxiliary registries deterministic; only the production singleton
// samples host pressure. Workers independently enforce the shared configured ceiling.
const browserWorkloadSampler = new BrowserWorkloadSampler();
export const chatGptTurnSessions = new ChatGptTurnSessions(undefined, undefined, active => browserWorkloadSampler.sample(active));
