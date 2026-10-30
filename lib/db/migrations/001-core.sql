-- P3-03 核心关系 schema（contracts.md C5）。已应用的迁移文件不得原地修改：升级只能新增文件。
-- 所有外部 ID 为 TEXT，版本/序号 INTEGER，时间为 UTC ISO 字符串；删除是显式墓碑（deleted_at）。

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
INSERT INTO projects (id, name, created_at) VALUES ('default-project', '默认项目', '1970-01-01T00:00:00.000Z');

CREATE TABLE canvases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  name TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  name_version INTEGER NOT NULL DEFAULT 0 CHECK (name_version >= 0),
  storage_epoch TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;
CREATE INDEX canvases_project ON canvases (project_id, updated_at DESC, id);

CREATE TABLE nodes (
  canvas_id TEXT NOT NULL REFERENCES canvases (id),
  id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('image', 'video', 'asset', 'canvasText')),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  x REAL NOT NULL,
  y REAL NOT NULL,
  width REAL NOT NULL CHECK (width > 0 AND width <= 100000),
  height REAL NOT NULL CHECK (height > 0 AND height <= 100000),
  entity_version INTEGER NOT NULL DEFAULT 0 CHECK (entity_version >= 0),
  geometry_version INTEGER NOT NULL DEFAULT 0 CHECK (geometry_version >= 0),
  -- 可空；正文在 documents，避免循环外键：先插 node 再插 document。
  document_id TEXT,
  data_json TEXT NOT NULL CHECK (json_valid(data_json) AND json_type(data_json) = 'object'),
  deleted_at TEXT,
  PRIMARY KEY (canvas_id, id)
) STRICT;
CREATE INDEX nodes_type ON nodes (canvas_id, type);

CREATE TABLE documents (
  canvas_id TEXT NOT NULL,
  id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  PRIMARY KEY (canvas_id, id),
  UNIQUE (canvas_id, node_id),
  FOREIGN KEY (canvas_id, node_id) REFERENCES nodes (canvas_id, id)
) STRICT;

CREATE TABLE node_fields (
  canvas_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  field TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 0),
  PRIMARY KEY (canvas_id, node_id, field),
  FOREIGN KEY (canvas_id, node_id) REFERENCES nodes (canvas_id, id)
) STRICT;

CREATE TABLE edges (
  canvas_id TEXT NOT NULL,
  id TEXT NOT NULL,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  role TEXT CHECK (role IS NULL OR role IN ('first', 'last', 'reference')),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  deleted_at TEXT,
  PRIMARY KEY (canvas_id, id),
  CHECK (source <> target),
  -- 复合外键：端点必须在同一画布内。
  FOREIGN KEY (canvas_id, source) REFERENCES nodes (canvas_id, id),
  FOREIGN KEY (canvas_id, target) REFERENCES nodes (canvas_id, id)
) STRICT;
CREATE INDEX edges_source ON edges (canvas_id, source);
CREATE INDEX edges_target ON edges (canvas_id, target);

-- 媒体只存元数据与相对路径，不存 BLOB。
CREATE TABLE assets (
  asset_name TEXT PRIMARY KEY,
  relative_path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  bytes INTEGER CHECK (bytes IS NULL OR bytes >= 0),
  sha256 TEXT,
  width INTEGER,
  height INTEGER,
  duration REAL,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'missing', 'pending'))
) STRICT;
CREATE INDEX assets_sha256 ON assets (sha256);

-- 画布对素材的归属：独立于全局 assets，A 能看到的素材不会自动出现在 B 的目录。
CREATE TABLE canvas_assets (
  canvas_id TEXT NOT NULL REFERENCES canvases (id),
  asset_name TEXT NOT NULL REFERENCES assets (asset_name),
  created_at TEXT NOT NULL,
  missing INTEGER NOT NULL DEFAULT 0 CHECK (missing IN (0, 1)),
  PRIMARY KEY (canvas_id, asset_name)
) STRICT;
CREATE INDEX canvas_assets_asset ON canvas_assets (asset_name);

CREATE TABLE asset_derivatives (
  asset_name TEXT NOT NULL REFERENCES assets (asset_name),
  variant TEXT NOT NULL CHECK (variant IN ('thumb256', 'thumb1024', 'poster')),
  source_hash TEXT NOT NULL,
  relative_path TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  error TEXT,
  PRIMARY KEY (asset_name, variant, source_hash)
) STRICT;
