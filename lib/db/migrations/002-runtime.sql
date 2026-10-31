-- P3-04 运行记录 schema（contracts.md C5）：生成来源、会话、任务、工具调用、占用/租约、事件/回执/水位、
-- 旧 operationId、工作站偏好、导入运行与备份清单。已应用的迁移不得原地修改。

CREATE TABLE generation_records (
  asset_name TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  snapshot_sha256 TEXT NOT NULL,
  saved_at TEXT NOT NULL
) STRICT;

CREATE TABLE agent_conversations (
  canvas_id TEXT NOT NULL REFERENCES canvases (id),
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  settings_json TEXT NOT NULL CHECK (json_valid(settings_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (canvas_id, id)
) STRICT;
CREATE INDEX agent_conversations_updated ON agent_conversations (canvas_id, updated_at DESC);

CREATE TABLE agent_messages (
  canvas_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  role TEXT NOT NULL,
  -- SDK UIMessage parts 原样保存：工具调用与结果在同一条消息中配对。
  parts_json TEXT NOT NULL CHECK (json_valid(parts_json)),
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  created_at TEXT,
  PRIMARY KEY (canvas_id, conversation_id, id),
  UNIQUE (canvas_id, conversation_id, ordinal),
  FOREIGN KEY (canvas_id, conversation_id) REFERENCES agent_conversations (canvas_id, id)
) STRICT;

CREATE TABLE task_runs (
  task_id TEXT PRIMARY KEY,
  canvas_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  generation_id TEXT,
  claim_node_id TEXT,
  upstream_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'failed', 'save_failed', 'expired')),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  remote_url TEXT,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  error TEXT,
  claim_released INTEGER CHECK (claim_released IS NULL OR claim_released IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX task_runs_canvas ON task_runs (canvas_id, state);

CREATE TABLE tool_calls (
  run_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  event_seq INTEGER,
  command_id TEXT,
  mapping_json TEXT CHECK (mapping_json IS NULL OR json_valid(mapping_json)),
  error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, tool_call_id)
) STRICT;
CREATE INDEX tool_calls_canvas ON tool_calls (canvas_id, updated_at);

CREATE TABLE generation_claims (
  canvas_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'unknown')),
  task_id TEXT,
  expires_at TEXT,
  PRIMARY KEY (canvas_id, node_id)
) STRICT;

CREATE TABLE edit_leases (
  canvas_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  field TEXT NOT NULL CHECK (field IN ('geometry', 'content', 'prompt')),
  owner TEXT NOT NULL,
  token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (canvas_id, node_id, field)
) STRICT;

CREATE TABLE canvas_events (
  canvas_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL CHECK (event_seq >= 1),
  revision INTEGER NOT NULL,
  command_id TEXT,
  delta_json TEXT NOT NULL CHECK (json_valid(delta_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (canvas_id, event_seq)
) STRICT;
CREATE INDEX canvas_events_revision ON canvas_events (canvas_id, revision);

CREATE TABLE command_receipts (
  command_id TEXT PRIMARY KEY,
  canvas_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_seq INTEGER NOT NULL CHECK (actor_seq >= 1),
  request_hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  created_at TEXT NOT NULL,
  UNIQUE (canvas_id, actor_id, actor_seq)
) STRICT;

CREATE TABLE actor_watermarks (
  canvas_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  accepted_seq INTEGER NOT NULL DEFAULT 0,
  ack_seq INTEGER NOT NULL DEFAULT 0,
  retired_before INTEGER NOT NULL DEFAULT 0,
  storage_epoch TEXT NOT NULL,
  PRIMARY KEY (canvas_id, actor_id)
) STRICT;

-- 旧 operations 协议的 operationId 全量保留：不因缺少 hash 而自动允许重放。
CREATE TABLE legacy_operation_ids (
  canvas_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  PRIMARY KEY (canvas_id, operation_id)
) STRICT, WITHOUT ROWID;

-- 最后画布/每画布相机等本机偏好；不保存 OAuth/auth。
CREATE TABLE workspace_preferences (
  key TEXT PRIMARY KEY CHECK (key NOT LIKE 'auth%' AND key NOT LIKE 'oauth%'),
  value_json TEXT NOT NULL CHECK (json_valid(value_json))
) STRICT;

CREATE TABLE import_runs (
  id TEXT PRIMARY KEY,
  source_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'running', 'verified', 'failed', 'committed')),
  cursor TEXT,
  report_json TEXT CHECK (report_json IS NULL OR json_valid(report_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE backup_manifests (
  id TEXT PRIMARY KEY,
  revision_manifest_json TEXT NOT NULL CHECK (json_valid(revision_manifest_json)),
  media_manifest_json TEXT NOT NULL CHECK (json_valid(media_manifest_json)),
  status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
  created_at TEXT NOT NULL
) STRICT;
