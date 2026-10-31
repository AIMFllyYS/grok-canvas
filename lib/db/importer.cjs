"use strict";
/**
 * 可重入 staging 导入（P3-06，contracts.md C5/C6）：把旧 JSON 数据目录导入一个独立 staging SQLite。
 * - 源目录只读：只 readdir/stat/readFile；auth/OAuth 文件只按名称分类，从不打开。
 * - prepare：逐文件 sha256 得到 source manifest 与 digest；同一 staging 只能在相同 digest 上续跑，
 *   源文件变化报 source_changed（可用 reset 重新准备），不在旧 cursor 上追加。
 * - 导入单元（素材批、生成记录、画布、会话、视频任务、app-state）按固定顺序编号，每个单元一个事务，
 *   单元写入与 cursor/报告推进在同一事务里，中断后重跑不会重复也不会跳过。
 * - 坏结构（非法 JSON、断边、重复 ID、未来 schema）阻断该来源并记入报告，不静默跳过；缺媒体显式 missing。
 * - 结束时调用 import-validator 做数量/规范化 hash/外键/integrity 校验，输出 ready_to_switch 或 blocked 报告；
 *   绝不写 storage-state.json，不修改旧 JSON，不建立双写。
 * 画布转换（fromCanvasDoc）与源分类（classifySource）由调用方注入，与 TS 实现保持单一来源。
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { openDatabase } = require("./driver.cjs");
const { migrate } = require("./migrate.cjs");
const canvasRepo = require("./repositories/canvas.cjs");
const assetsRepo = require("./repositories/assets.cjs");
const tasksRepo = require("./repositories/tasks.cjs");
const conversationsRepo = require("./repositories/conversations.cjs");
const controlRepo = require("./repositories/control.cjs");
const { validateImport, canonicalJson, nodesHash, messagesHash } = require("./import-validator.cjs");

const DB_FILE = "grok-canvas.sqlite";
const REPORT_FILE = "import-report.json";
const ASSET_BATCH = 200;
const BLOCKING_ISSUES = new Set(["duplicate_id", "dangling_edge", "unknown_type", "invalid_geometry"]);
const fail = (code, message, extra) => Object.assign(new Error(message), { code, ...extra });
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const own = (record, key) => (isRecord(record) && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined);

/**
 * 已退役的节点类型（workflow / text / prompt）与 studio 控制连线：应用读取画布时本来就会过滤掉
 * （lib/canvas-cleanup.ts 的 cleanCanvas，规则相同），导入时同样去掉，并在报告里计数；原 JSON 文件不改。
 */
const RETIRED_TYPES = new Set(["workflow", "text", "prompt"]);
function retireLegacyNodes(doc) {
  if (!Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) return { doc, dropped: 0 };
  const nodes = doc.nodes.filter(node => !(isRecord(node) && RETIRED_TYPES.has(node.type))).map(node => {
    if (!isRecord(node) || !isRecord(node.data) || !("studioProjectId" in node.data)) return node;
    const { studioProjectId: _old, ...data } = node.data;
    return { ...node, data };
  });
  const ids = new Set(nodes.filter(isRecord).map(node => node.id));
  const edges = doc.edges.filter(edge => isRecord(edge) && ids.has(edge.source) && ids.has(edge.target) && !(isRecord(edge.data) && edge.data.studioControl));
  return { doc: { ...doc, nodes, edges }, dropped: doc.nodes.length - nodes.length };
}
const inside = (child, parent) => { const rel = path.relative(parent, child); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); };

async function hashFile(file) {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  for await (const chunk of fs.createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest("hex"), bytes };
}

async function walk(dir, base = dir, out = []) {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

/** 路径检查：源/目标必须是用户显式给出的绝对路径，互不包含，目标不是已切换的库。 */
function checkPaths(sourceDir, stagingDir) {
  if (typeof sourceDir !== "string" || !path.isAbsolute(sourceDir)) throw fail("invalid_request", "必须显式指定源数据目录（绝对路径）");
  if (typeof stagingDir !== "string" || !path.isAbsolute(stagingDir)) throw fail("invalid_request", "必须显式指定 staging 目录（绝对路径）");
  const source = path.resolve(sourceDir), staging = path.resolve(stagingDir);
  if (inside(staging, source) || inside(source, staging)) throw fail("invalid_request", "staging 目录不能等于、位于或包含源数据目录");
  if (fs.existsSync(path.join(staging, "storage-state.json"))) throw fail("invalid_request", "目标目录已有 storage-state.json（已切换的库），拒绝写入");
  return { source, staging };
}

/** source manifest：每个文件的分类、字节数与 sha256（auth 只记名称）；digest 覆盖清单与内容。 */
async function prepareSource(sourceDir, convert, options = {}) {
  const exists = await fsp.stat(sourceDir).then(s => s.isDirectory(), () => false);
  if (!exists) throw fail("invalid_request", `源数据目录不存在：${sourceDir}`);
  const files = [];
  for (const rel of (await walk(sourceDir)).sort()) {
    const classified = convert.classifySource(rel);
    if (classified.excluded) { files.push({ path: rel, kind: classified.kind, excluded: true }); continue; }
    options.onOpen?.(rel);
    const { sha256: hash, bytes } = await hashFile(path.join(sourceDir, rel));
    files.push({ path: rel, kind: classified.kind, bytes, sha256: hash });
  }
  const digest = sha256(files.map(f => `${f.path}\t${f.kind}\t${f.excluded ? "excluded" : `${f.bytes}\t${f.sha256}`}`).join("\n"));
  return { files, digest };
}

/** 导入单元的固定顺序：素材先于画布（canvas_assets 外键），画布先于会话（会话外键）。 */
function planUnits(manifest) {
  const byKind = (kind) => manifest.files.filter(f => f.kind === kind && !f.excluded);
  const units = [];
  const assets = byKind("asset");
  for (let i = 0; i < assets.length; i += ASSET_BATCH) units.push({ kind: "asset-batch", files: assets.slice(i, i + ASSET_BATCH).map(f => f.path) });
  for (const kind of ["generation", "canvas", "agent", "studio", "video-task", "app-state"]) for (const file of byKind(kind)) units.push({ kind, files: [file.path] });
  for (const file of byKind("unknown")) units.push({ kind: "unknown", files: [file.path] });
  return units;
}

function emptyReport(runId, manifest) {
  return {
    version: 1, runId, sourceDigest: manifest.digest, status: "running",
    files: {}, blocking: [], missingMedia: [], expectations: { canvases: {}, conversations: {}, tasks: [], generations: {} },
    excluded: manifest.files.filter(f => f.excluded).map(f => f.path),
    unitsDone: 0, unitsTotal: 0,
  };
}

function epochFor(digest) { return `sqlite-${digest.slice(0, 12)}`; }

/** 单个源文件读取：先核对 sha256 与 manifest 一致（源在导入中途被改 → source_changed）。 */
function readVerified(sourceDir, manifest, rel, options) {
  const entry = manifest.files.find(f => f.path === rel);
  options.onOpen?.(rel);
  const bytes = fs.readFileSync(path.join(sourceDir, rel));
  if (!entry || sha256(bytes) !== entry.sha256) throw fail("source_changed", `源文件 ${rel} 在导入过程中发生变化，需要重新准备`);
  return bytes;
}

function parseJson(bytes) { try { return { value: JSON.parse(bytes.toString("utf8")) }; } catch (error) { return { error: error.message }; } }

const block = (report, file, code, detail) => { report.files[file] = { outcome: code, detail }; report.blocking.push({ file, code, detail }); };
const kindOfAsset = (name, fallback) => fallback === "video" || fallback === "image" ? fallback : /\.(mp4|webm|mov)$/i.test(name) ? "video" : "image";

function ensureAssetRow(db, name, kind, report, referencedBy) {
  if (db.prepare("select 1 from assets where asset_name = ?").get(name)) return false;
  assetsRepo.putAsset(db, { assetName: name, relativePath: `assets/${name}`, kind, status: "missing" });
  report.missingMedia.push({ assetName: name, referencedBy });
  return true;
}

const importers = {
  "asset-batch"(ctx, unit) {
    for (const rel of unit.files) {
      const entry = ctx.manifest.files.find(f => f.path === rel);
      const name = rel.slice("assets/".length);
      assetsRepo.putAsset(ctx.db, { assetName: name, relativePath: rel, kind: kindOfAsset(name), bytes: entry.bytes, sha256: entry.sha256, status: "ready" });
      ctx.report.files[rel] = { outcome: "ok", tables: { assets: 1 } };
    }
  },

  generation(ctx, unit) {
    const rel = unit.files[0];
    const parsed = parseJson(readVerified(ctx.sourceDir, ctx.manifest, rel, ctx.options));
    if (parsed.error) return block(ctx.report, rel, "corrupt_json", parsed.error);
    const { schemaVersion = 1, assetName, savedAt, ...snapshot } = parsed.value;
    if (schemaVersion !== 1) return block(ctx.report, rel, "unsupported_version", `schemaVersion ${schemaVersion}`);
    const expectedName = path.basename(rel, ".json");
    if (assetName !== undefined && assetName !== expectedName) return block(ctx.report, rel, "invalid_value", `assetName ${assetName} 与文件名不一致`);
    tasksRepo.putGenerationRecord(ctx.db, { assetName: expectedName, schemaVersion, snapshot, savedAt: savedAt ?? new Date(0).toISOString() });
    ctx.report.expectations.generations[expectedName] = sha256(canonicalJson(snapshot));
    ctx.report.files[rel] = { outcome: "ok", tables: { generation_records: 1 } };
  },

  canvas(ctx, unit) {
    const rel = unit.files[0];
    const { db, report } = ctx;
    const parsed = parseJson(readVerified(ctx.sourceDir, ctx.manifest, rel, ctx.options));
    if (parsed.error) return block(report, rel, "corrupt_json", parsed.error);
    const cleaned = isRecord(parsed.value) ? retireLegacyNodes(parsed.value) : { doc: parsed.value, dropped: 0 };
    const doc = cleaned.doc;
    const canvasId = path.basename(rel, ".json");
    if (!isRecord(doc) || !Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) return block(report, rel, "corrupt_structure", "缺少 nodes/edges 数组");
    if ((doc.schemaVersion ?? 1) !== 1) return block(report, rel, "unsupported_version", `schemaVersion ${doc.schemaVersion}`);
    if (doc.id !== canvasId) return block(report, rel, "invalid_value", `文档 id ${doc.id} 与文件名不一致`);
    const state = isRecord(doc.commandState) ? doc.commandState : {};
    const documentIds = new Map(Object.entries(isRecord(state.documentIds) ? state.documentIds : {}));
    const converted = ctx.convert.fromCanvasDoc(doc, { documentIds });
    const fatal = converted.issues.filter(issue => BLOCKING_ISSUES.has(issue.code) || (issue.code === "invalid_value" && issue.detail.includes("缺少 ID")));
    if (fatal.length || converted.seed.nodes.length !== doc.nodes.length || converted.seed.edges.length !== doc.edges.length) {
      return block(report, rel, "invalid_structure", (fatal.length ? fatal : converted.issues).slice(0, 5).map(i => `${i.entity} ${i.id}: ${i.code} ${i.detail}`).join("；") || "实体数量与源不一致");
    }
    const versions = isRecord(state.nodes) ? state.nodes : {};
    const nodes = converted.seed.nodes.map(node => { const v = own(versions, node.id) ?? {}; return { ...node, entityVersion: v.entity ?? 0, geometryVersion: v.geometry ?? 0 }; });
    const documents = converted.seed.documents.map(record => ({ ...record, version: own(own(versions, record.nodeId)?.fields, "content") ?? 0 }));
    const edgeVersions = isRecord(state.edges) ? state.edges : {};
    const edges = converted.seed.edges.map(edge => ({ ...edge, version: own(edgeVersions, edge.id) ?? 0 }));
    const fieldVersions = {};
    for (const node of nodes) {
      const fields = own(versions, node.id)?.fields;
      if (!isRecord(fields)) continue;
      const rest = Object.fromEntries(Object.entries(fields).filter(([field]) => field !== "content"));
      if (Object.keys(rest).length) fieldVersions[node.id] = rest;
    }
    const epoch = epochFor(ctx.manifest.digest);
    canvasRepo.putCanvas(db, {
      canvas: { id: canvasId, name: String(doc.name ?? ""), revision: Number(doc.revision) || 0, nameVersion: Number(state.nameVersion) || 0, storageEpoch: epoch, createdAt: doc.createdAt, updatedAt: doc.updatedAt ?? doc.createdAt },
      nodes, documents, edges, fieldVersions,
    });
    // 画布素材归属：libraryAssets 与 commandState.assets；文件缺失时显式 missing。
    const owned = new Map();
    for (const item of Array.isArray(doc.libraryAssets) ? doc.libraryAssets : []) if (isRecord(item) && typeof item.assetName === "string") owned.set(item.assetName, { createdAt: item.addedAt, kind: undefined });
    for (const [name, value] of Object.entries(isRecord(state.assets) ? state.assets : {})) owned.set(name, { createdAt: value.createdAt ?? owned.get(name)?.createdAt, kind: value.kind });
    for (const [name, meta] of owned) {
      const missing = ensureAssetRow(db, name, kindOfAsset(name, meta.kind), report, canvasId) || db.prepare("select status from assets where asset_name = ?").get(name).status === "missing";
      assetsRepo.linkCanvasAsset(db, { canvasId, assetName: name, createdAt: meta.createdAt ?? doc.createdAt, missing });
    }
    // 节点引用的素材文件缺失：保留节点元数据，只在报告中列出。
    for (const node of nodes) {
      const name = node.data && typeof node.data.assetName === "string" ? node.data.assetName : null;
      if (name && !db.prepare("select 1 from assets where asset_name = ? and status = 'ready'").get(name) && !report.missingMedia.some(m => m.assetName === name && m.referencedBy === `${canvasId}/${node.id}`)) {
        report.missingMedia.push({ assetName: name, referencedBy: `${canvasId}/${node.id}` });
      }
    }
    let receipts = 0;
    for (const [commandId, stored] of Object.entries(isRecord(state.receipts) ? state.receipts : {})) {
      if (!isRecord(stored) || !Number.isSafeInteger(stored.actorSeq) || stored.actorSeq < 1) continue;
      db.prepare("insert into command_receipts (command_id, canvas_id, actor_id, actor_seq, request_hash, receipt_json, created_at) values (?, ?, ?, ?, ?, ?, ?)")
        .run(commandId, canvasId, stored.actorId, stored.actorSeq, stored.hash, JSON.stringify(stored.error ? { error: stored.error } : { receipt: stored.receipt }), doc.updatedAt ?? doc.createdAt);
      receipts++;
    }
    let actors = 0;
    for (const [actorId, value] of Object.entries(isRecord(state.actors) ? state.actors : {})) {
      controlRepo.putWatermark(db, { canvasId, actorId, acceptedSeq: Number(value.acceptedSeq) || 0, storageEpoch: epoch });
      actors++;
    }
    const operationIds = Array.isArray(doc.appliedOperationIds) ? doc.appliedOperationIds.map(String) : [];
    if (operationIds.length) controlRepo.recordLegacyOperationIds(db, { canvasId, operationIds });
    let claims = 0;
    for (const [nodeId, claim] of Object.entries(isRecord(doc.generationClaims) ? doc.generationClaims : {})) {
      if (!isRecord(claim) || (claim.state !== "pending" && claim.state !== "unknown")) continue;
      tasksRepo.putClaim(db, { canvasId, nodeId, claimId: String(claim.id), state: claim.state, taskId: claim.taskId });
      claims++;
    }
    // 节点墓碑（P3-10）：以 deleted_at 占位行导入，旧客户端不能用已删除的 ID 复活节点；占位行不参与任何读取。
    // 连线墓碑只有版本号、没有端点，按外键无法落成行：只计数报告（重建同 ID 连线不会造成重复执行）。
    let nodeTombstones = 0;
    const tombAt = doc.updatedAt ?? doc.createdAt ?? new Date().toISOString();
    const exists = db.prepare("select 1 from nodes where canvas_id = ? and id = ?");
    const insertTomb = db.prepare("insert into nodes (canvas_id, id, type, schema_version, x, y, width, height, entity_version, geometry_version, document_id, data_json, deleted_at) values (?, ?, 'canvasText', 1, 0, 0, 1, 1, ?, ?, null, '{}', ?)");
    for (const [nodeId, versions] of Object.entries(isRecord(state.tombstones?.nodes) ? state.tombstones.nodes : {})) {
      if (exists.get(canvasId, nodeId)) continue;
      const v = isRecord(versions) ? versions : {};
      insertTomb.run(canvasId, nodeId, Math.max(0, Number(v.entity) || 0), Math.max(0, Number(v.geometry) || 0), tombAt);
      nodeTombstones++;
    }
    const edgeTombstones = Object.keys(isRecord(state.tombstones?.edges) ? state.tombstones.edges : {}).length;
    // CanvasDoc 的画布字段：视口与完整素材库条目（名称/来源）保存在偏好表，SQLite 模式按旧形状还原（P3-08）。
    if (isRecord(doc.viewport)) controlRepo.setPreference(db, { key: `viewport:${canvasId}`, value: doc.viewport });
    if (Array.isArray(doc.libraryAssets)) controlRepo.setPreference(db, { key: `library:${canvasId}`, value: doc.libraryAssets });
    report.expectations.canvases[canvasId] = { revision: Number(doc.revision) || 0, nodes: nodes.length, documents: documents.length, edges: edges.length, nodesHash: nodesHash(nodes), operationIds: operationIds.length, claims, receipts, actors };
    report.files[rel] = {
      outcome: "ok",
      tables: { canvases: 1, nodes: nodes.length, documents: documents.length, edges: edges.length, canvas_assets: owned.size, command_receipts: receipts, actor_watermarks: actors, legacy_operation_ids: operationIds.length, generation_claims: claims },
      warnings: converted.issues.filter(i => !fatal.includes(i)).map(i => `${i.entity} ${i.id}: ${i.code}`),
      ...(nodeTombstones ? { nodeTombstones } : {}),
      ...(edgeTombstones ? { edgeTombstonesNotImported: edgeTombstones } : {}),
      ...(cleaned.dropped ? { retiredNodesDropped: cleaned.dropped } : {}),
    };
  },

  agent(ctx, unit) {
    const rel = unit.files[0];
    const { db, report } = ctx;
    const parsed = parseJson(readVerified(ctx.sourceDir, ctx.manifest, rel, ctx.options));
    if (parsed.error) return block(report, rel, "corrupt_json", parsed.error);
    const canvasId = path.basename(rel, ".json");
    if (!db.prepare("select 1 from canvases where id = ?").get(canvasId)) {
      report.files[rel] = { outcome: "orphan", detail: "对应画布不在 staging（不存在或已被阻断）" };
      return;
    }
    const state = { ...parsed.value, canvasId };
    const list = conversationsRepo.conversationsFromAgentState(state);
    for (const { messages } of list) {
      const bad = messages.find(m => !isRecord(m) || typeof m.id !== "string" || typeof m.role !== "string");
      if (bad) return block(report, rel, "invalid_structure", "存在缺少 id/role 的消息");
    }
    let total = 0;
    for (const { conversation, messages } of list) {
      conversationsRepo.putConversation(db, { canvasId, conversation: { ...conversation, createdAt: conversation.createdAt ?? state.createdAt, updatedAt: conversation.updatedAt ?? state.updatedAt ?? state.createdAt }, messages });
      report.expectations.conversations[`${canvasId}/${conversation.id}`] = { messages: messages.length, idsHash: messagesHash(messages) };
      total += messages.length;
    }
    if (typeof state.activeConversationId === "string") controlRepo.setPreference(db, { key: `activeConversation:${canvasId}`, value: state.activeConversationId });
    report.files[rel] = { outcome: "ok", tables: { agent_conversations: list.length, agent_messages: total } };
  },

  studio(ctx, unit) {
    // 更早的 studio 会话：按 lib/agent/store.ts 的规则映射到 canvasId（工具记录转成文字保存）。
    // 该画布已有 agent/ 新文件时以新文件为准（应用本身也是这样读取的）。
    const rel = unit.files[0];
    const { db, report } = ctx;
    const parsed = parseJson(readVerified(ctx.sourceDir, ctx.manifest, rel, ctx.options));
    if (parsed.error) { report.files[rel] = { outcome: "corrupt_ignored", detail: parsed.error }; return; }
    const old = parsed.value;
    const canvasId = isRecord(old) && typeof old.canvasId === "string" ? old.canvasId : null;
    if (!canvasId) { report.files[rel] = { outcome: "skipped", detail: "没有 canvasId 的旧会话，应用也不会读取" }; return; }
    if (ctx.manifest.files.some(file => file.path === `agent/${canvasId}.json`)) { report.files[rel] = { outcome: "superseded", detail: `agent/${canvasId}.json 已是新格式` }; return; }
    if (!db.prepare("select 1 from canvases where id = ?").get(canvasId)) { report.files[rel] = { outcome: "orphan", detail: "对应画布不在 staging" }; return; }
    const toText = (part) => (isRecord(part) && typeof part.type === "string" && part.type.startsWith("tool-")
      ? { type: "text", text: `历史工具记录：${part.type.slice(5)}\n\n\`\`\`json\n${JSON.stringify(part)}\n\`\`\`` }
      : part);
    const conversations = Array.isArray(old.conversations) ? old.conversations.map(chat => ({ ...chat, messages: Array.isArray(chat?.messages) ? chat.messages.map(m => ({ ...m, parts: Array.isArray(m?.parts) ? m.parts.map(toText) : [] })) : [] })) : [];
    const state = { canvasId, conversations, messages: Array.isArray(old.messages) ? old.messages : [], activeConversationId: old.activeConversationId ?? "", createdAt: old.createdAt, updatedAt: old.updatedAt };
    const list = conversationsRepo.conversationsFromAgentState(state);
    let total = 0;
    for (const { conversation, messages } of list) {
      if (messages.some(m => !isRecord(m) || typeof m.id !== "string" || typeof m.role !== "string")) continue;
      conversationsRepo.putConversation(db, { canvasId, conversation: { ...conversation, createdAt: conversation.createdAt ?? state.createdAt ?? new Date(0).toISOString(), updatedAt: conversation.updatedAt ?? state.updatedAt ?? state.createdAt ?? new Date(0).toISOString() }, messages });
      report.expectations.conversations[`${canvasId}/${conversation.id}`] = { messages: messages.length, idsHash: messagesHash(messages) };
      total += messages.length;
    }
    report.files[rel] = { outcome: "ok", tables: { agent_conversations: list.length, agent_messages: total } };
  },

  "video-task"(ctx, unit) {
    const rel = unit.files[0];
    const parsed = parseJson(readVerified(ctx.sourceDir, ctx.manifest, rel, ctx.options));
    if (parsed.error) return block(ctx.report, rel, "corrupt_json", parsed.error);
    const record = parsed.value;
    if ((record.schemaVersion ?? 1) !== 1) return block(ctx.report, rel, "unsupported_version", `schemaVersion ${record.schemaVersion}`);
    if (typeof record.taskId !== "string" || typeof record.requestId !== "string" || typeof record.canvasId !== "string") return block(ctx.report, rel, "invalid_structure", "缺少 taskId/requestId/canvasId");
    tasksRepo.putTaskRun(ctx.db, record);
    ctx.report.expectations.tasks.push(record.taskId);
    ctx.report.files[rel] = { outcome: "ok", tables: { task_runs: 1 }, ...(ctx.db.prepare("select 1 from canvases where id = ?").get(record.canvasId) ? {} : { warning: "任务所属画布不在 staging" }) };
  },

  "app-state"(ctx, unit) {
    const rel = unit.files[0];
    const parsed = parseJson(readVerified(ctx.sourceDir, ctx.manifest, rel, ctx.options));
    // app-state 损坏只忽略偏好并报告，不阻断画布导入（catalog onCorrupt）。
    if (parsed.error) { ctx.report.files[rel] = { outcome: "corrupt_ignored", detail: parsed.error }; return; }
    if (typeof parsed.value?.lastCanvasId === "string") controlRepo.setPreference(ctx.db, { key: "lastCanvas", value: parsed.value.lastCanvasId });
    ctx.report.files[rel] = { outcome: "ok", tables: { workspace_preferences: 1 } };
  },

  unknown(ctx, unit) {
    block(ctx.report, unit.files[0], "unknown_source", "未登记的源文件，需要人工确认");
  },
};

/** dry-run：只分类与解析检查，不创建任何文件。 */
async function dryRun(params) {
  const { sourceDir, convert, options = {} } = params;
  if (typeof sourceDir !== "string" || !path.isAbsolute(sourceDir)) throw fail("invalid_request", "必须显式指定源数据目录（绝对路径）");
  const manifest = await prepareSource(sourceDir, convert, options);
  const counts = {};
  for (const file of manifest.files) counts[file.kind] = (counts[file.kind] ?? 0) + 1;
  return { mode: "dry-run", sourceDigest: manifest.digest, counts, units: planUnits(manifest).length, excluded: manifest.files.filter(f => f.excluded).map(f => f.path), unknown: manifest.files.filter(f => f.kind === "unknown").map(f => f.path) };
}

/**
 * 执行或续跑导入。params: { sourceDir, stagingDir, convert: { classifySource, fromCanvasDoc }, reset?, options?: { failAfterUnits?, onOpen? } }。
 * 返回最终报告；status 为 ready_to_switch 或 blocked。
 */
async function runImport(params) {
  const { convert, options = {} } = params;
  const { source, staging } = checkPaths(params.sourceDir, params.stagingDir);
  const manifest = await prepareSource(source, convert, options);
  await fsp.mkdir(staging, { recursive: true });
  const dbFile = path.join(staging, DB_FILE);
  let db = openDatabase(dbFile, { busyTimeoutMs: 5000 });
  try {
    migrate(db);
    const runs = db.prepare("select id, source_digest, status from import_runs order by created_at").all();
    if (runs.some(run => run.status === "committed")) throw fail("invalid_request", "staging 库已被标记为切换后的库，拒绝覆盖");
    const stale = runs.find(run => run.source_digest !== manifest.digest);
    if (stale) {
      if (!params.reset) throw fail("source_changed", "源数据已变化，不能在旧 cursor 上续写；请使用 reset 重新准备 staging");
      db.close();
      for (const suffix of ["", "-wal", "-shm"]) await fsp.rm(`${dbFile}${suffix}`, { force: true });
      await fsp.rm(path.join(staging, REPORT_FILE), { force: true });
      db = openDatabase(dbFile, { busyTimeoutMs: 5000 });
      migrate(db);
    }
    const runId = `import-${manifest.digest.slice(0, 16)}`;
    const units = planUnits(manifest);
    let run = controlRepo.getImportRun(db, { id: runId });
    if (!run) {
      controlRepo.startImportRun(db, { id: runId, sourceDigest: manifest.digest });
      controlRepo.updateImportRun(db, { id: runId, status: "running", cursor: "-1", report: { ...emptyReport(runId, manifest), unitsTotal: units.length } });
      run = controlRepo.getImportRun(db, { id: runId });
    }
    if (run.status === "verified" || run.status === "failed") return run.report;
    const report = run.report;
    const ctx = { db, sourceDir: source, manifest, convert, options, report };
    let done = 0;
    for (let index = Number(run.cursor) + 1; index < units.length; index++) {
      const unit = units[index];
      db.transaction(() => {
        importers[unit.kind](ctx, unit);
        report.unitsDone = index + 1;
        controlRepo.updateImportRun(db, { id: runId, cursor: String(index), report });
      })();
      done++;
      if (options.failAfterUnits !== undefined && done >= options.failAfterUnits) throw fail("interrupted", `模拟中断：已完成 ${index + 1}/${units.length} 个单元`);
    }
    const validation = validateImport(db, report.expectations);
    report.validation = validation;
    report.status = report.blocking.length === 0 && validation.ok ? "ready_to_switch" : "blocked";
    report.storageEpoch = epochFor(manifest.digest);
    controlRepo.updateImportRun(db, { id: runId, status: report.status === "ready_to_switch" ? "verified" : "failed", report });
    await fsp.writeFile(path.join(staging, REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    if (db.open) db.close();
  }
}

module.exports = { runImport, dryRun, prepareSource, planUnits, checkPaths, DB_FILE, REPORT_FILE };
