import { expect, test } from "bun:test";
import {
  ChatGptTurnDomHealthTracker,
  CHATGPT_RESPONSE_DOM_GRACE_MS,
  chatGptConversationIdentity,
  chatGptRemountDecision,
  chatGptRemountRetainsTurn,
} from "../src/adapters/chatgpt-web/browser-worker";

test("conversation identity distinguishes local and server temporary chats", () => {
  expect(chatGptConversationIdentity(
    "https://chatgpt.com/c/local-chatgpt%3Ae5f50f28-e8d7-4541-aa7f-a5fbc057f2f9?temporary-chat=true",
  )).toBe("local-chatgpt:e5f50f28-e8d7-4541-aa7f-a5fbc057f2f9");
  expect(chatGptConversationIdentity(
    "https://chatgpt.com/c/6af3992c-70b8-83ed-b0f0-a81795389d02?temporary-chat=true",
  )).toBe("6af3992c-70b8-83ed-b0f0-a81795389d02");
  expect(chatGptConversationIdentity("https://chatgpt.com/?temporary-chat=true")).toBeUndefined();
  expect(chatGptConversationIdentity("https://example.com/c/abc")).toBeUndefined();
  expect(chatGptConversationIdentity("about:blank")).toBeUndefined();
});

test("a remount is only observable while the new transcript still carries the submitted turn", () => {
  const fresh = { initialUserTurnCount: 0, initialResponseTurnCount: 0 };
  // ChatGPT migrated the Temporary Chat into a fresh, empty conversation. Binding to it would
  // wait for a response that the navigation already destroyed.
  expect(chatGptRemountRetainsTurn({ userTurnCount: 0, assistantTurnCount: 0 }, fresh)).toBe(false);
  // The rebuilt transcript still shows the submitted prompt.
  expect(chatGptRemountRetainsTurn({ userTurnCount: 1, assistantTurnCount: 0 }, fresh)).toBe(true);
  // Or it already rendered the assistant turn for that prompt.
  expect(chatGptRemountRetainsTurn({ userTurnCount: 1, assistantTurnCount: 1 }, fresh)).toBe(true);
  // A retained conversation with history is judged against the pre-submission baseline, not zero.
  const history = { initialUserTurnCount: 4, initialResponseTurnCount: 3 };
  expect(chatGptRemountRetainsTurn({ userTurnCount: 4, assistantTurnCount: 3 }, history)).toBe(false);
  expect(chatGptRemountRetainsTurn({ userTurnCount: 5, assistantTurnCount: 3 }, history)).toBe(true);
});

test("an elapsed remount grace replays the turn unless the rebuilt transcript has a new assistant turn", () => {
  const fresh = { initialUserTurnCount: 0, initialResponseTurnCount: 0 };
  // Empty conversation: replay on a fresh Temporary Chat.
  expect(chatGptRemountDecision({ userTurnCount: 0, assistantTurnCount: 0 }, fresh)).toBe("replay");
  // The prompt survived but its generation did not: replay rather than wait for an answer that
  // no live turn will ever produce.
  expect(chatGptRemountDecision({ userTurnCount: 1, assistantTurnCount: 0 }, fresh)).toBe("replay");
  // The rebuilt transcript already carries the answer: bind to it and keep the turn.
  expect(chatGptRemountDecision({ userTurnCount: 1, assistantTurnCount: 1 }, fresh)).toBe("bind");
  // A historical assistant turn is not the submitted turn's answer.
  const history = { initialUserTurnCount: 4, initialResponseTurnCount: 3 };
  expect(chatGptRemountDecision({ userTurnCount: 5, assistantTurnCount: 3 }, history)).toBe("replay");
  expect(chatGptRemountDecision({ userTurnCount: 5, assistantTurnCount: 4 }, history)).toBe("bind");
});

test("suspending the missing-response window for a remount keeps the evidence that a response existed", () => {
  const tracker = new ChatGptTurnDomHealthTracker();
  const visible = {
    responsePresent: true,
    running: false,
    currentText: "Thinking",
    completionActionVisible: false,
  };
  tracker.update(visible, 0);
  // A conversation remount rebuilds the DOM without ending the turn: pause the window instead of
  // constructing a fresh tracker, which used to forget that a response had already appeared.
  tracker.clearMissingResponse();
  expect(tracker.update({ ...visible, responsePresent: false, currentText: "" }, 1_000)).toBeUndefined();
  expect(tracker.update(
    { ...visible, responsePresent: false, currentText: "" },
    1_000 + CHATGPT_RESPONSE_DOM_GRACE_MS,
  )).toContain("response DOM disappeared");
});

