import type { UIMessage } from "ai";
export type AgentSettings = {
  model?: string;
  fast?: boolean;
  contextWindow?: number;
  effort?: string;
};
export type AgentConversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: UIMessage[];
  settings: AgentSettings;
};
export type AgentState = {
  id: string;
  canvasId: string;
  messages: UIMessage[];
  conversations: AgentConversation[];
  activeConversationId: string;
  createdAt: string;
  updatedAt: string;
};
export type Attachment = {
  id: string;
  name: string;
  kind: "image" | "text";
  assetName?: string;
  text?: string;
};
