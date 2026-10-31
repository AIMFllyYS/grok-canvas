import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { loadTypescript } from "./helpers/load-typescript.mjs";

// 真实旧数据里出现过的三类情况：已退役节点类型、studio 旧会话、原子写入临时文件与退役任务目录。
const require = createRequire(import.meta.url);
const importer = require("../lib/db/importer.cjs");
const { openDatabase } = require("../lib/db/driver.cjs");
const legacy = await loadTypescript("lib/canvas-runtime/legacy-document.ts", { packages: true });
const catalog = await loadTypescript("lib/db/import-catalog.ts");
const root = await mkdtemp(path.join(os.tmpdir(), "grok-canvas-import-legacy-"));
after(async () => { await legacy.dispose(); await catalog.dispose(); await rm(root, { recursive: true, force: true }); });
const convert = { fromCanvasDoc: legacy.module.fromCanvasDoc, classifySource: catalog.module.classifySource };

async function write(dir, rel, value) {
  const file = path.join(dir, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
}

test("旧数据：退役节点去掉并计数；studio 会话映射到画布；临时文件与退役任务目录排除；整体 ready_to_switch", async () => {
  const src = path.join(root, "src"), staging = path.join(root, "staging");
  const canvas = (id, nodes, edges = []) => ({ id, name: id, schemaVersion: 1, revision: 3, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", viewport: { x: 0, y: 0, zoom: 1 }, nodes, edges });
  await write(src, "canvases/c-a.json", canvas("c-a", [
    { id: "keep", type: "canvasText", position: { x: 0, y: 0 }, width: 300, height: 200, data: { name: "保留", content: "x", studioProjectId: "p1" } },
    { id: "wf", type: "workflow", position: { x: 400, y: 0 }, data: { name: "工作流" } },
  ], [{ id: "e1", source: "wf", target: "keep" }]));
  await write(src, "canvases/c-b.json", canvas("c-b", []));
  const message = (id, role, parts) => ({ id, role, parts });
  await write(src, "studio/s1.json", { canvasId: "c-a", activeConversationId: "conv", conversations: [{ id: "conv", title: "旧", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", messages: [message("m1", "user", [{ type: "text", text: "你好" }]), message("m2", "assistant", [{ type: "tool-read_canvas", state: "output-available", output: {} }])] }] });
  await write(src, "agent/c-b.json", { canvasId: "c-b", conversations: [], messages: [], activeConversationId: "" });
  await write(src, "studio/s2.json", { canvasId: "c-b", conversations: [{ id: "x", messages: [] }] });
  await write(src, "app-state.json", { lastCanvasId: "c-a" });
  await write(src, "app-state.json.7bd73bba-a9d2-439a-96f3-bd49e0ebbb48.tmp", "{half");
  await write(src, "studio-image-jobs/job-1.json", { old: true });
  const report = await importer.runImport({ sourceDir: src, stagingDir: staging, convert });
  assert.equal(report.status, "ready_to_switch", JSON.stringify(report.blocking ?? report.blockers ?? null));
  assert.equal(report.files["canvases/c-a.json"].retiredNodesDropped, 1);
  assert.equal(report.files["studio/s1.json"].outcome, "ok");
  assert.equal(report.files["studio/s2.json"].outcome, "superseded", "已有 agent/ 新文件时以新文件为准");
  const db = openDatabase(path.join(staging, importer.DB_FILE ?? "workstation.sqlite"), { busyTimeoutMs: 2000 });
  try {
    assert.deepEqual(db.prepare("select id from nodes where canvas_id = 'c-a' and deleted_at is null").all().map(r => r.id), ["keep"]);
    assert.equal(db.prepare("select count(*) as n from edges where canvas_id = 'c-a'").get().n, 0, "指向退役节点的连线一并去掉");
    const data = JSON.parse(db.prepare("select data_json from nodes where id = 'keep'").get().data_json);
    assert.equal("studioProjectId" in data, false);
    const messages = db.prepare("select id from agent_messages where canvas_id = 'c-a' order by ordinal").all().map(r => r.id);
    assert.deepEqual(messages, ["m1", "m2"]);
  } finally { db.close(); }
});
