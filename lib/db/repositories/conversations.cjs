"use strict";
/**
 * Agent 会话 repository（contracts.md C5，P3-04）：会话与消息分表，消息按稳定 ordinal 分页（每页 ≤50）。
 * parts_json 原样保存 SDK UIMessage parts：工具调用与结果在同一条消息中配对，按消息分页不会拆开它们。
 * 旧 AgentState（顶层 messages + conversations）映射去重，同一段历史不导入两份。
 */
const LIST_LIMIT = 50;
const invalid = (message) => Object.assign(new Error(message), { code: "invalid_request" });
const canvasOf = (params) => { if (!params || typeof params.canvasId !== "string" || !params.canvasId) throw invalid("缺少 canvasId：每个查询都必须按画布过滤"); return params.canvasId; };

function putConversation(db, params) {
  const canvasId = canvasOf(params);
  const { conversation, messages = [] } = params;
  db.transaction(() => {
    db.prepare("insert into agent_conversations (canvas_id, id, title, settings_json, created_at, updated_at) values (?, ?, ?, ?, ?, ?) on conflict(canvas_id, id) do update set title = excluded.title, settings_json = excluded.settings_json, updated_at = excluded.updated_at")
      .run(canvasId, conversation.id, conversation.title ?? "", JSON.stringify(conversation.settings ?? {}), conversation.createdAt, conversation.updatedAt);
    db.prepare("delete from agent_messages where canvas_id = ? and conversation_id = ?").run(canvasId, conversation.id);
    const insert = db.prepare("insert into agent_messages (canvas_id, conversation_id, id, ordinal, role, parts_json, metadata_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)");
    messages.forEach((message, ordinal) => insert.run(canvasId, conversation.id, message.id, ordinal, message.role, JSON.stringify(message.parts ?? []), message.metadata === undefined ? null : JSON.stringify(message.metadata), message.createdAt ?? null));
  })();
  return { ok: true, messages: messages.length };
}

function listConversations(db, params) {
  const canvasId = canvasOf(params);
  const limit = params.limit ?? LIST_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_LIMIT) throw invalid(`limit 必须在 1..${LIST_LIMIT}`);
  const rows = db.prepare("select id, title, settings_json, created_at, updated_at from agent_conversations where canvas_id = ? order by updated_at desc, id limit ? offset ?").all(canvasId, limit + 1, Number(params.offset) || 0);
  return { items: rows.slice(0, limit).map(r => ({ id: r.id, title: r.title, settings: JSON.parse(r.settings_json), createdAt: r.created_at, updatedAt: r.updated_at })), hasMore: rows.length > limit };
}

function listMessages(db, params) {
  const canvasId = canvasOf(params);
  const limit = params.limit ?? LIST_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_LIMIT) throw invalid(`limit 必须在 1..${LIST_LIMIT}`);
  const after = Number.isSafeInteger(params.afterOrdinal) ? params.afterOrdinal : -1;
  const rows = db.prepare("select id, ordinal, role, parts_json, metadata_json, created_at from agent_messages where canvas_id = ? and conversation_id = ? and ordinal > ? order by ordinal limit ?").all(canvasId, String(params.conversationId ?? ""), after, limit + 1);
  const items = rows.slice(0, limit).map(r => {
    const message = { id: r.id, role: r.role, parts: JSON.parse(r.parts_json) };
    if (r.metadata_json !== null) message.metadata = JSON.parse(r.metadata_json);
    if (r.created_at !== null) message.createdAt = r.created_at;
    return message;
  });
  return { items, nextOrdinal: rows.length > limit ? rows[limit - 1].ordinal : null };
}

const sameMessages = (a, b) => a.length === b.length && a.every((m, i) => m.id === b[i].id);

/** 旧 AgentState → 待导入会话：顶层 messages 与某会话相同则只保留会话；只有顶层消息时生成确定 ID 的旧会话。 */
function conversationsFromAgentState(state) {
  const list = Array.isArray(state.conversations) ? state.conversations : [];
  const out = list.map(conversation => ({ conversation: { id: conversation.id, title: conversation.title, settings: conversation.settings ?? {}, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt }, messages: conversation.messages ?? [] }));
  const top = Array.isArray(state.messages) ? state.messages : [];
  if (top.length && !list.some(conversation => sameMessages(conversation.messages ?? [], top))) {
    out.push({ conversation: { id: `legacy-${state.canvasId ?? state.id}`, title: "旧会话", settings: {}, createdAt: state.createdAt, updatedAt: state.updatedAt }, messages: top });
  }
  return out;
}

module.exports = { putConversation, listConversations, listMessages, conversationsFromAgentState };
