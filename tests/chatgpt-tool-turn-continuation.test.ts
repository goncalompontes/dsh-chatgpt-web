import { expect, test } from "bun:test";
import {
  ChatGptCompletionTracker,
  chatGptContinuedAssistantTurn,
} from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptMarkdownBuffer } from "../src/adapters/chatgpt-web/markdown";

// Observed in diagnostics browser-turns/2b549e52ae1c: after the last tool result, ChatGPT rendered
// the final answer (with its own completed action row) as a second assistant turn below the message
// that had issued the tool calls. The adapter kept observing the first message, whose text cannot
// change, and failed the turn with "completed without producing a final answer".
const TOOL_CALL_MESSAGE = "the message that issued the tool calls";

const completedTurn = (currentText: string) => ({
  responsePresent: true,
  running: false,
  currentText,
  completionActionVisible: true,
  externalToolCallsInFlight: false,
});

test("a tool turn follows the assistant message ChatGPT appends below the bound one", () => {
  const initial = ["conv:1:assistant"];
  const bound = "conv:2:assistant";
  const answer = "conv:3:assistant";
  // Still writing into the bound message.
  expect(chatGptContinuedAssistantTurn(initial, [...initial, bound], bound)).toBeUndefined();
  // The next model step is a new assistant turn.
  expect(chatGptContinuedAssistantTurn(initial, [...initial, bound, answer], bound)).toBe(answer);
  // The newest turn is already bound.
  expect(chatGptContinuedAssistantTurn(initial, [...initial, bound, answer], answer)).toBeUndefined();
});

test("hydrated history is never mistaken for a continuation", () => {
  const initial = ["conv:0:assistant"];
  const bound = "conv:1:assistant";
  // A remount can mount an older assistant turn after the bound one's index; it is history.
  expect(chatGptContinuedAssistantTurn(initial, [bound, initial[0]], bound)).toBeUndefined();
  // A conversation whose bound turn vanished has no observable continuation here.
  expect(chatGptContinuedAssistantTurn(initial, [initial[0]], bound)).toBeUndefined();
});

test("the post-tool answer boundary is not satisfied by the tool-call message alone", () => {
  const tracker = new ChatGptCompletionTracker(2_000, 60_000);
  tracker.observeToolBatch(1, TOOL_CALL_MESSAGE);
  expect(tracker.update(completedTurn(TOOL_CALL_MESSAGE), 0)).toBe(false);
  // A turn that really ends after a tool call still fails; the invariant is not weakened.
  expect(() => tracker.update(completedTurn(TOOL_CALL_MESSAGE), 60_000))
    .toThrow("ChatGPT completed without producing a final answer after its last Codex tool call");
});

test("the answer in the appended assistant message completes the turn", () => {
  const tracker = new ChatGptCompletionTracker(2_000, 60_000);
  tracker.observeToolBatch(1, TOOL_CALL_MESSAGE);
  const continued = chatGptContinuedAssistantTurn(
    [],
    ["turn:1:assistant", "turn:2:assistant", "turn:3:assistant"],
    "turn:2:assistant",
  );
  expect(continued).toBe("turn:3:assistant");
  expect(tracker.update(completedTurn("the final answer"), 0)).toBe(false);
  expect(tracker.update(completedTurn("the final answer"), 2_000)).toBe(true);
});

test("a continued message's blocks follow the previous message instead of aliasing it", () => {
  const buffer = new ChatGptMarkdownBuffer();
  buffer.observe([{
    key: "0:p",
    scope: "turn:2:assistant",
    tag: "p",
    html: "<p>Planned the change</p>",
    text: "Planned the change",
    sourceStart: 0,
    sourceEnd: 17,
    streamable: false,
  }]);
  // The message is finished when the next model step appears; its trailing blocks must enter the
  // answer before the new message's blocks, not after them.
  expect(buffer.flushMessage()).toBe("Planned the change");
  buffer.observe([{
    key: "0:p",
    scope: "turn:3:assistant",
    tag: "p",
    html: "<p>Implemented the change</p>",
    text: "Implemented the change",
    // Source offsets restart for a new assistant message.
    sourceStart: 0,
    sourceEnd: 22,
    streamable: false,
  }]);
  expect(buffer.finish().markdown).toBe("Planned the change\n\nImplemented the change");
});

test("message-local block keys do not alias an earlier message", () => {
  const buffer = new ChatGptMarkdownBuffer();
  buffer.observe([{
    key: "0:p", scope: "turn:2:assistant", tag: "p", html: "<p>first</p>", text: "first", streamable: false,
  }]);
  buffer.flushMessage();
  buffer.observe([{
    key: "0:p", scope: "turn:3:assistant", tag: "p", html: "<p>second</p>", text: "second", streamable: false,
  }]);
  expect(buffer.finish().markdown).toBe("first\n\nsecond");
});
