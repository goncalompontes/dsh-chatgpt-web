import { expect, test } from "bun:test";
import { chatGptConversationIdentity } from "../src/adapters/chatgpt-web/browser-worker";

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

