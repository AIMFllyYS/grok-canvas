import type { StudioProject, StudioConversation, AgentSettings } from "./schema";
import { finalizeInterruptedMessages } from "./messages";

/** Migration preserves the complete original transcript, and never merges separate chats. */
export function ensureConversations(p: StudioProject) {
  if (!p.conversations?.length) {
    const id = `${p.id}-original`;
    p.conversations = [{ id, title: p.messages.length ? "原有对话" : "新对话", messages: p.messages, settings: {}, createdAt: p.createdAt, updatedAt: p.updatedAt }];
    p.activeConversationId = id;
  }
  const active = p.conversations.find(c => c.id === p.activeConversationId) ?? p.conversations[0]!;
  p.activeConversationId = active.id;
  p.messages = active.messages;
  return active;
}
export function newConversation(p: StudioProject): StudioConversation {
  const previous = ensureConversations(p);
  const now = new Date().toISOString();
  const chat = { id: crypto.randomUUID(), title: "新对话", messages: [], settings: { ...previous.settings }, createdAt: now, updatedAt: now };
  p.conversations!.unshift(chat);
  p.activeConversationId = chat.id;
  p.messages = chat.messages;
  return chat;
}
export function saveConversation(p: StudioProject, id: string, messages: StudioConversation["messages"], settings?: AgentSettings) {
  ensureConversations(p);
  const chat = p.conversations!.find(c => c.id === id);
  if (!chat) throw new Error("对话不存在，请重新选择对话");
  chat.messages = messages;
  if (settings) chat.settings = settings;
  chat.updatedAt = new Date().toISOString();
  const text = messages.find(m => m.role === "user")?.parts.find(part => part.type === "text");
  if (text?.type === "text") chat.title = text.text.replace(/\s+/g, " ").slice(0, 48) || "新对话";
  if (p.activeConversationId === id) p.messages = messages;
}
export function finalizeConversations(p: StudioProject) {
  ensureConversations(p);
  for (const c of p.conversations!) c.messages = finalizeInterruptedMessages(c.messages, c.id);
  ensureConversations(p);
}
