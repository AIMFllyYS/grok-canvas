import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadTypescript } from "./helpers/load-typescript.mjs";

const { IDBFactory, IDBKeyRange } = await import("fake-indexeddb");

/** 每个用例独立的 IndexedDB 与模块实例，保证不共享缓存连接。 */
async function withDb(fn, factory = new IDBFactory()) {
  const previous = { indexedDB: globalThis.indexedDB, IDBKeyRange: globalThis.IDBKeyRange };
  globalThis.indexedDB = factory; globalThis.IDBKeyRange = IDBKeyRange;
  const outbox = await loadTypescript("lib/canvas-runtime/outbox.ts", { packages: true });
  const recovery = await loadTypescript("lib/canvas-runtime/recovery.ts", { packages: true });
  const drafts = await loadTypescript("lib/canvas-drafts.ts", { packages: true });
  try { return await fn({ outbox: outbox.module, recovery: recovery.module, drafts: drafts.module, factory }); }
  finally {
    await outbox.dispose(); await recovery.dispose(); await drafts.dispose();
    Object.assign(globalThis, previous);
  }
}
const session = (initial = {}) => { const map = new Map(Object.entries(initial)); return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), map }; };
const g = (x = 0, y = 0) => ({ x, y, width: 280, height: 240 });
const moveDraft = (nodeId, from, to, expectedVersion = 0) => ({ kind: "move_nodes", payload: { items: [{ nodeId, expectedVersion, from, to }] }, storageEpoch: "json-v1", baseRevision: 0 });
const patchDraft = (nodeId, field, value, expectedVersion = 0) => ({ kind: "patch_nodes", payload: { items: [{ nodeId, field, expectedVersion, value }] }, storageEpoch: "json-v1", baseRevision: 0 });
const receiptFor = (record, revision = 1) => ({ commandId: record.command.commandId, revision, eventSeq: revision, storageEpoch: "json-v1", changedNodeIds: [], changedEdgeIds: [], fieldVersions: [], delta: { canvasId: record.canvasId, fromRevision: revision - 1, revision, nodes: [], documents: [], edges: [], removedNodeIds: [], removedDocumentIds: [], removedEdgeIds: [], assets: [] }, replayed: false });

test("enqueue 在同一事务内分配 actorSeq 与命令；并发分配不重复；重新打开后序号继续", async () => {
  const tab = session();
  let firstActor = "";
  await withDb(async ({ outbox }) => {
    const box = await outbox.openOutbox({ session: tab });
    firstActor = box.actorId;
    const records = await Promise.all(Array.from({ length: 5 }, (_, i) => box.enqueue("A", patchDraft(`n${i}`, "name", `名${i}`))));
    assert.deepEqual(records.map(r => r.actorSeq).sort((a, b) => a - b), [1, 2, 3, 4, 5]);
    assert.equal(new Set(records.map(r => r.command.commandId)).size, 5);
    assert.ok(records.every(r => r.command.actorId === box.actorId && r.command.canvasId === "A" && r.state === "queued"));
    const pending = await box.loadPending("A");
    assert.deepEqual(pending.map(r => r.actorSeq), [1, 2, 3, 4, 5]);
    const reopened = await outbox.openOutbox({ session: tab });
    assert.equal(reopened.actorId, box.actorId, "同一会话保留 actorId");
    assert.equal((await reopened.enqueue("A", patchDraft("z", "name", "x"))).actorSeq, 6);
    const other = await reopened.enqueue("B", patchDraft("z", "name", "x"));
    assert.equal(other.actorSeq, 1, "序号按画布独立");
  });
  await withDb(async ({ outbox }) => {
    const box = await outbox.openOutbox({ session: tab });
    assert.notEqual(box.actorId, firstActor, "本地库丢失时换发新的 actorId，避免旧 actorId 的序号回到 1");
    assert.equal((await box.enqueue("A", patchDraft("z", "name", "x"))).actorSeq, 1);
  });
});

test("queued 同字段合并保留最早 before 与最新 after；sent 不可变，后续改动产生新序号", async () => {
  await withDb(async ({ outbox }) => {
    const box = await outbox.openOutbox({ session: session() });
    const first = await box.enqueue("A", moveDraft("n1", g(0), g(10)));
    const merged = await box.enqueue("A", moveDraft("n1", g(10), g(20), 0));
    assert.equal(merged.actorSeq, first.actorSeq);
    assert.equal(merged.command.commandId, first.command.commandId);
    assert.deepEqual(merged.command.payload.items, [{ nodeId: "n1", expectedVersion: 0, from: g(0), to: g(20) }]);
    assert.equal((await box.loadPending("A")).length, 1);
    await box.enqueue("A", patchDraft("n1", "prompt", "a", 3));
    const promptMerged = await box.enqueue("A", patchDraft("n1", "prompt", "b", 4));
    assert.deepEqual(promptMerged.command.payload.items, [{ nodeId: "n1", field: "prompt", expectedVersion: 3, value: "b" }]);
    const sentRecord = (await box.loadPending("A")).at(-1);
    const frozen = structuredClone(sentRecord.command);
    await box.markSent("A", sentRecord.actorSeq);
    const later = await box.enqueue("A", patchDraft("n1", "prompt", "c", 4));
    assert.equal(later.actorSeq, sentRecord.actorSeq + 1);
    const pending = await box.loadPending("A");
    assert.equal(pending.length, 3);
    assert.deepEqual(pending.find(r => r.actorSeq === sentRecord.actorSeq).command, frozen, "sent 命令载荷与 ID 不变");
    await assert.rejects(box.markSent("A", 99), (error) => error.code === "not_found");
  });
});

test("ack 只清当前命令与其覆盖的检查点；画布 A 的确认不清 B；commandId 不符时整体回滚", async () => {
  await withDb(async ({ outbox }) => {
    const box = await outbox.openOutbox({ session: session() });
    const a1 = await box.enqueue("A", patchDraft("n", "name", "1"));
    const a2 = await box.enqueue("A", patchDraft("m", "name", "2"));
    const b1 = await box.enqueue("B", patchDraft("n", "name", "3"));
    for (const sequence of [9, 10, 11]) await box.saveCheckpoint("A", { sequence, moves: [{ id: "n", from: { x: 0, y: 0 }, to: { x: sequence, y: 0 } }] });
    await box.saveCheckpoint("B", { sequence: 5, moves: [] });
    await box.markSent("A", a1.actorSeq);
    await assert.rejects(box.ack({ ...receiptFor(a1), commandId: "00000000-0000-4000-8000-00000000dead" }, { canvasId: "A", actorSeq: a1.actorSeq, checkpointThrough: 10 }));
    assert.equal((await box.loadPending("A")).length, 2);
    assert.equal((await box.loadCheckpoints("A")).length, 3);
    await box.ack(receiptFor(a1, 7), { canvasId: "A", actorSeq: a1.actorSeq, checkpointThrough: 10 });
    assert.deepEqual((await box.loadPending("A")).map(r => r.actorSeq), [a2.actorSeq]);
    assert.deepEqual((await box.loadPending("B")).map(r => r.actorSeq), [b1.actorSeq]);
    assert.deepEqual((await box.loadCheckpoints("A")).map(c => c.sequence), [11]);
    assert.equal((await box.loadCheckpoints("B")).length, 1);
    assert.deepEqual(await box.watermark("A"), { ackSeq: a1.actorSeq, revision: 7, eventSeq: 7 });
  });
});

test("写入失败（克隆失败）整体 abort：outbox、序号、检查点都不变；超过上限明确拒绝而不丢已接受修改", async () => {
  await withDb(async ({ outbox }) => {
    const box = await outbox.openOutbox({ session: session(), limits: { items: 3, bytes: 16 * 1024 * 1024 } });
    await box.enqueue("A", patchDraft("n", "name", "ok"));
    await box.saveCheckpoint("A", { sequence: 1, moves: [] });
    await assert.rejects(box.enqueue("A", patchDraft("n", "attachmentNames", { bad: () => 1 })));
    assert.equal((await box.loadPending("A")).length, 1);
    assert.equal((await box.enqueue("A", patchDraft("m", "name", "next"))).actorSeq, 2, "失败的事务不消耗序号");
    await box.enqueue("A", patchDraft("k", "name", "third"));
    await assert.rejects(box.enqueue("A", patchDraft("j", "name", "fourth")), (error) => error.code === "queue_full");
    assert.equal((await box.loadPending("A")).length, 3);
    assert.equal((await box.loadCheckpoints("A")).length, 1);
    const tiny = await outbox.openOutbox({ session: session(), limits: { items: 1000, bytes: 64 } });
    await assert.rejects(tiny.enqueue("Z", patchDraft("n", "prompt", "x".repeat(200))), (error) => error.code === "queue_full");
  });
});

test("v2 升级保留 v1 drafts；升级异常回滚，旧数据仍在", async () => {
  const factory = new IDBFactory();
  await new Promise((resolve, reject) => {
    const request = factory.open("grok-canvas-drafts", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts", { keyPath: "key" });
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("drafts", "readwrite");
      tx.objectStore("drafts").put({ key: "A:old-tab", canvasId: "A", base: { id: "A" }, working: { id: "A" } });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
  await withDb(async ({ outbox }) => {
    await assert.rejects(outbox.openCanvasDatabase({ upgradeHook: () => { throw new Error("模拟升级失败"); } }));
  }, factory);
  const version = await new Promise((resolve) => { const r = factory.open("grok-canvas-drafts"); r.onsuccess = () => { const v = r.result.version; const names = [...r.result.objectStoreNames]; r.result.close(); resolve({ v, names }); }; });
  assert.deepEqual(version, { v: 1, names: ["drafts"] }, "升级失败保持 v1");
  await withDb(async ({ outbox, drafts }) => {
    const db = await outbox.openCanvasDatabase();
    assert.equal(db.version, 2);
    assert.deepEqual([...db.objectStoreNames].sort(), ["checkpoints", "client_state", "drafts", "outbox"]);
    const legacy = await drafts.listLegacyDrafts("A");
    assert.deepEqual(legacy.map(d => d.key), ["A:old-tab"]);
  }, factory);
});

test("发送器：一画布一在途；网络不明只重发原命令；冲突暂停；stale_epoch 进入恢复协调；未确认不算已保存", async () => {
  await withDb(async ({ outbox }) => {
    const box = await outbox.openOutbox({ session: session() });
    const first = await box.enqueue("A", patchDraft("n", "name", "1"));
    await box.enqueue("A", patchDraft("m", "name", "2"));
    const posted = [];
    let concurrent = 0, maxConcurrent = 0, mode = "network";
    const post = async (command) => {
      concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      posted.push(structuredClone(command));
      await new Promise(r => setTimeout(r, 2));
      concurrent--;
      if (mode === "network") throw new TypeError("fetch failed");
      if (mode === "conflict") return { ok: false, status: 409, error: { code: "field_conflict", message: "冲突" } };
      if (mode === "epoch") return { ok: false, status: 409, error: { code: "stale_epoch", message: "纪元变化" } };
      return { ok: true, receipt: receiptFor({ canvasId: "A", command }, posted.length) };
    };
    const sender = outbox.createCommandSender({ outbox: box, canvasId: "A", post });
    const [r1, r2] = await Promise.all([sender.flush(), sender.flush()]);
    assert.equal(maxConcurrent, 1);
    assert.deepEqual([r1.status, r1.saved], ["retry", false]);
    assert.equal(r2.status, "retry");
    assert.equal((await box.loadPending("A"))[0].state, "sent");
    mode = "ok";
    const done = await sender.flush();
    assert.deepEqual([done.status, done.saved], ["idle", true]);
    assert.ok(posted.every((c, i) => i === 0 || c.commandId !== posted[0].commandId || JSON.stringify(c) === JSON.stringify(posted[0])), "重发原 envelope");
    assert.equal(posted.filter(c => c.commandId === first.command.commandId).length, 2);
    assert.deepEqual(await box.loadPending("A"), []);
    await box.enqueue("A", patchDraft("x", "name", "3"));
    await box.enqueue("A", patchDraft("y", "name", "4"));
    mode = "conflict";
    const conflicted = await sender.flush();
    assert.deepEqual([conflicted.status, conflicted.saved], ["conflict", false]);
    const pending = await box.loadPending("A");
    assert.deepEqual(pending.map(r => r.state), ["conflict", "queued"], "冲突后暂停，后续命令不发送");
    const count = posted.length;
    await sender.flush();
    assert.equal(posted.length, count, "冲突暂停期间不再发送");
    const box2 = await outbox.openOutbox({ session: session() });
    await box2.enqueue("C", patchDraft("n", "name", "x"));
    mode = "epoch";
    const epoch = await outbox.createCommandSender({ outbox: box2, canvasId: "C", post }).flush();
    assert.deepEqual([epoch.status, epoch.saved], ["recovery_required", false]);
    assert.equal((await box2.loadPending("C"))[0].state, "sent");
  });
});

// ---------------------------------------------------------------- v1 草稿恢复

const legacyDoc = (overrides = {}) => ({
  id: "A", name: "画布", schemaVersion: 1, revision: 3, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [
    { id: "x", type: "image", position: { x: 0, y: 0 }, data: { name: "x", prompt: "base", status: "idle", assetName: "x.png" } },
    { id: "y", type: "image", position: { x: 400, y: 0 }, data: { name: "y", prompt: "p", status: "idle", assetName: "y.png" } },
    { id: "d", type: "image", position: { x: 800, y: 0 }, data: { name: "d", prompt: "", status: "idle", assetName: null } },
  ],
  edges: [], ...overrides,
});
const withNode = (doc, id, change) => ({ ...doc, nodes: doc.nodes.map(n => n.id === id ? change(structuredClone(n)) : n) });
async function serverReader(recovery, doc, versions = {}) {
  return recovery.recoveryReaderFromLegacy(doc, versions);
}

test("v1 恢复：服务端等于 base 的字段生成带当前版本的命令；等于 working 的跳过；新增/删除转换为命令", async () => {
  await withDb(async ({ recovery }) => {
    const base = legacyDoc();
    let working = withNode(base, "x", n => { n.data.prompt = "本地改"; return n; });
    working = withNode(working, "y", n => { n.position = { x: 999, y: 0 }; return n; });
    working = { ...working, nodes: [...working.nodes.filter(n => n.id !== "d"), { id: "new1", type: "canvasText", position: { x: 0, y: 600 }, width: 360, height: 260, data: { name: "新", content: "新正文" } }] };
    const server = withNode(base, "y", n => { n.position = { x: 999, y: 0 }; return n; });
    const result = recovery.recoverLegacy({ key: "A:tab", canvasId: "A", base, working, pending: null }, await serverReader(recovery, server, { nodes: { x: { entity: 4, geometry: 1, fields: { prompt: 7 } }, d: { entity: 2, geometry: 0 } } }));
    assert.equal(result.status, "ready");
    const items = result.drafts.flatMap(d => d.kind === "batch" ? d.payload.commands : [d]);
    const patch = items.find(i => i.kind === "patch_nodes");
    assert.deepEqual(patch.payload.items, [{ nodeId: "x", field: "prompt", expectedVersion: 7, value: "本地改" }]);
    assert.equal(items.some(i => i.kind === "move_nodes"), false, "服务端已等于 working 的位置跳过");
    assert.deepEqual(items.find(i => i.kind === "delete_nodes").payload.items, [{ nodeId: "d", expectedEntityVersion: 2 }]);
    const added = items.find(i => i.kind === "add_nodes").payload;
    assert.deepEqual([added.nodes[0].id, added.documents[0].content], ["new1", "新正文"]);
  });
});

test("v1 恢复冲突：服务端同字段已被他人改动时进入保护态，不生成命令", async () => {
  await withDb(async ({ recovery }) => {
    const base = legacyDoc();
    const working = withNode(base, "x", n => { n.data.prompt = "本地改"; return n; });
    const server = withNode(base, "x", n => { n.data.prompt = "别人改"; return n; });
    const result = recovery.recoverLegacy({ key: "A:tab", canvasId: "A", base, working, pending: null }, await serverReader(recovery, server));
    assert.equal(result.status, "conflict");
    assert.deepEqual(result.conflicts.map(c => `${c.target}/${c.id}/${c.field}`), ["node/x/prompt"]);
    assert.equal(result.drafts.length, 0);
    assert.equal(result.editingPaused, true);
  });
});

test("v1 恢复：inflight 已被服务端应用的部分以快照为基准继续", async () => {
  await withDb(async ({ recovery }) => {
    const base = legacyDoc();
    const snapshot = withNode(base, "x", n => { n.data.prompt = "已发出"; return n; });
    const working = withNode(snapshot, "x", n => { n.data.prompt = "继续改"; return n; });
    const result = recovery.recoverLegacy({ key: "A:tab", canvasId: "A", base, working, pending: { base, snapshot, operations: [] } }, await serverReader(recovery, snapshot, { nodes: { x: { entity: 1, geometry: 0, fields: { prompt: 1 } } } }));
    assert.equal(result.status, "ready");
    const items = result.drafts.flatMap(d => d.kind === "batch" ? d.payload.commands : [d]);
    assert.deepEqual(items[0].payload.items, [{ nodeId: "x", field: "prompt", expectedVersion: 1, value: "继续改" }]);
  });
});

test("v1 转换与迁移标记同事务：中断不留半截，重复执行幂等，完成后才清旧草稿", async () => {
  await withDb(async ({ outbox, recovery, drafts }) => {
    const db = await outbox.openCanvasDatabase();
    await new Promise((resolve, reject) => { const tx = db.transaction("drafts", "readwrite"); tx.objectStore("drafts").put({ key: "A:tab", canvasId: "A", base: legacyDoc(), working: legacyDoc() }); tx.objectStore("drafts").put({ key: "A:tab:geometry:0000000000000001", canvasId: "A", sequence: 1, moves: [] }); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    const box = await outbox.openOutbox({ session: session() });
    const good = [patchDraft("x", "prompt", "恢复")];
    await assert.rejects(recovery.commitLegacyRecovery(box, "A:tab", "A", [...good, patchDraft("y", "attachmentNames", { bad: () => 1 })]));
    assert.deepEqual(await box.loadPending("A"), []);
    assert.ok(await drafts.loadCanvasDraft("A:tab"), "失败时旧草稿保留");
    const done = await recovery.commitLegacyRecovery(box, "A:tab", "A", good);
    assert.equal(done.status, "committed");
    const again = await recovery.commitLegacyRecovery(box, "A:tab", "A", good);
    assert.equal(again.status, "already");
    assert.equal((await box.loadPending("A")).length, 1, "重复启动不产生重复命令");
    assert.equal(await drafts.loadCanvasDraft("A:tab"), undefined);
    assert.deepEqual(await drafts.listLegacyDrafts("A"), []);
  });
});

test("恢复包：可保存的 JSON，只含该画布本地记录且不含认证信息；导出不改变状态", async () => {
  await withDb(async ({ outbox, recovery }) => {
    const db = await outbox.openCanvasDatabase();
    await new Promise((resolve) => { const tx = db.transaction("drafts", "readwrite"); tx.objectStore("drafts").put({ key: "A:tab", canvasId: "A", base: legacyDoc(), working: legacyDoc() }); tx.objectStore("drafts").put({ key: "B:tab", canvasId: "B", base: {}, working: {} }); tx.oncomplete = resolve; });
    const box = await outbox.openOutbox({ session: session() });
    await box.enqueue("A", patchDraft("x", "name", "导出"));
    await box.enqueue("B", patchDraft("x", "name", "别的"));
    const text = await recovery.exportRecoveryBundle("A");
    const bundle = JSON.parse(text);
    assert.equal(bundle.format, "grok-canvas-recovery");
    assert.equal(bundle.canvasId, "A");
    assert.deepEqual(bundle.drafts.map(d => d.key), ["A:tab"]);
    assert.equal(bundle.outbox.length, 1);
    assert.doesNotMatch(text, /oauth|access_token|refresh_token/i);
    assert.equal((await box.loadPending("A")).length, 1);
    assert.equal((await box.loadPending("A"))[0].state, "queued");
  });
});

test("Outbox 测试已登记进 pnpm test", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts["test:commands"], /tests\/canvas-outbox\.test\.mjs/);
});
