import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadTypescript } from "./helpers/load-typescript.mjs";

// P3-09：SSE 事件流、浏览器同步客户端、变更通知与「无常态整图轮询」。
const dir = await mkdtemp(path.join(os.tmpdir(), "grok-canvas-sync-"));
process.env.GROK_CANVAS_DATA_DIR = dir;
const stream = await loadTypescript("lib/db/event-stream.ts");
const client = await loadTypescript("lib/canvas-runtime/sync-client.ts");
const bus = await loadTypescript("lib/canvas-runtime/change-bus.ts");
const store = await loadTypescript("lib/canvas-store.ts");
const service = await loadTypescript("lib/canvas-runtime/command-service.ts", { packages: true });
after(async () => {
  for (const loaded of [stream, client, bus, store, service]) await loaded.dispose();
  await rm(dir, { recursive: true, force: true });
});
const { createCanvasEventStream } = stream.module;
const { createCanvasSync, createAckReporter } = client.module;
const { subscribeCanvasChanged, notifyCanvasChanged, changeListenerCount } = bus.module;

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

/** 读 SSE 字节流，按事件块解析。 */
function reader(readable) {
  const decoder = new TextDecoder();
  const r = readable.getReader();
  let buffer = "";
  const events = [];
  let done = false;
  (async () => {
    for (;;) {
      const { value, done: end } = await r.read();
      if (end) { done = true; return; }
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const type = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (type) events.push({ type, data: JSON.parse(data) });
      }
    }
  })();
  return { events, done: () => done, cancel: () => r.cancel() };
}

function fakeStream(options = {}) {
  let revision = options.revision ?? 3;
  let exists = true;
  const listeners = new Set();
  const controller = new AbortController();
  const readable = createCanvasEventStream({
    canvasId: "c1",
    probe: async () => (exists ? { revision } : null),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    signal: controller.signal,
    coalesceMs: 5,
    probeMs: options.probeMs ?? 60_000,
    heartbeatMs: 60_000,
  });
  return {
    read: reader(readable),
    listeners,
    abort: () => controller.abort(),
    write: (next, actorId) => { revision = next; for (const l of listeners) l({ canvasId: "c1", revision: next, actorId }); },
    silentWrite: next => { revision = next; },
    remove: () => { exists = false; },
  };
}

test("事件流：先发当前修订；写入方通知合并推送并带 actor；修订不前进不推送", async () => {
  const s = fakeStream();
  await tick(10);
  assert.deepEqual(s.read.events[0], { type: "revision", data: { canvasId: "c1", revision: 3, actors: [], initial: true } });
  s.write(4, A);
  s.write(5, A);
  await tick(30);
  assert.equal(s.read.events.length, 2, "50ms 内的两次写入合并为一条");
  assert.deepEqual(s.read.events[1].data, { canvasId: "c1", revision: 5, actors: [A] });
  for (const l of s.listeners) l({ canvasId: "c1", revision: 5, actorId: B }); // 重复通知
  await tick(30);
  assert.equal(s.read.events.length, 2, "修订未前进不推送");
  s.write(6, null);
  await tick(30);
  assert.deepEqual(s.read.events[2].data.actors.sort(), [B, null].sort(), "未知写入方以 null 表示");
  s.abort();
  await tick(10);
  assert.equal(s.listeners.size, 0, "连接关闭后注销订阅");
});

test("事件流：漏通知由修订探测兜底（actor 未知）；画布删除发 gone 并关闭", async () => {
  const s = fakeStream({ probeMs: 20 });
  await tick(10);
  s.silentWrite(9);
  await tick(50);
  assert.deepEqual(s.read.events.at(-1).data, { canvasId: "c1", revision: 9, actors: [null] });
  s.remove();
  await tick(50);
  assert.equal(s.read.events.at(-1).type, "gone");
  assert.equal(s.listeners.size, 0);
  assert.ok(s.read.done(), "流已结束");
});

class FakeSource {
  static all = [];
  constructor(url) { this.url = url; this.listeners = new Map(); this.closed = false; this.onopen = null; this.onerror = null; FakeSource.all.push(this); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  close() { this.closed = true; }
  emit(type, data) { this.listeners.get(type)?.({ data: JSON.stringify(data) }); }
}
const open = () => FakeSource.all.filter(s => !s.closed);
function makeSync(extra = {}) {
  const pulls = [];
  let hidden = false;
  const visibilityListeners = new Set();
  const sync = createCanvasSync({
    canvasId: "c1",
    actorId: () => A,
    onRemoteChange: revision => pulls.push(revision),
    createSource: url => new FakeSource(url),
    visibility: { hidden: () => hidden, subscribe: l => { visibilityListeners.add(l); return () => visibilityListeners.delete(l); } },
    ...extra,
  });
  const source = () => FakeSource.all.at(-1);
  return { sync, pulls, source, setHidden: value => { hidden = value; for (const l of visibilityListeners) l(); }, visibilityListeners };
}

test("同步客户端：首条事件补拉一次；自己写入不拉，别人写入才拉；重复/乱序丢弃；迟到的旧画布流忽略", () => {
  FakeSource.all = [];
  const { sync, pulls, source } = makeSync();
  assert.equal(source().url, "/api/canvases/c1/events");
  source().emit("revision", { canvasId: "c1", revision: 3, actors: [], initial: true });
  assert.deepEqual(pulls, [3], "连接建立后补拉断线/加载期间的变化");
  source().emit("revision", { canvasId: "c1", revision: 4, actors: [A] });
  assert.deepEqual(pulls, [3], "只有自己的命令：回执已确认，不拉整图");
  source().emit("revision", { canvasId: "c1", revision: 6, actors: [A, B] });
  source().emit("revision", { canvasId: "c1", revision: 5, actors: [B] });
  source().emit("revision", { canvasId: "c1", revision: 6, actors: [B] });
  assert.deepEqual(pulls, [3, 6], "乱序与重复事件不重复拉取");
  source().emit("revision", { canvasId: "c2", revision: 99, actors: [B] });
  assert.deepEqual(pulls, [3, 6], "其他画布的事件不污染当前画布");
  source().emit("revision", { canvasId: "c1", revision: 7, actors: [null] });
  assert.deepEqual(pulls, [3, 6, 7], "未知写入方按外部写入处理");
  sync.dispose();
});

test("同步客户端：断线重连后的第一条事件补拉；页面隐藏断开、显示重连；gone 停止", () => {
  FakeSource.all = [];
  const { sync, pulls, source, setHidden } = makeSync();
  source().onopen?.();
  assert.equal(sync.status(), "live");
  source().emit("revision", { canvasId: "c1", revision: 3, actors: [] });
  source().onerror?.();
  assert.equal(sync.status(), "reconnecting");
  source().emit("revision", { canvasId: "c1", revision: 3, actors: [] });
  assert.deepEqual(pulls, [3, 3], "重连后同修订也补拉一次（断线期间的变化可能已被同修订覆盖）");
  setHidden(true);
  assert.equal(open().length, 0, "后台页面不占连接");
  assert.equal(sync.status(), "paused");
  setHidden(false);
  assert.equal(open().length, 1);
  source().emit("gone", { canvasId: "c1" });
  assert.equal(sync.status(), "gone");
  assert.equal(open().length, 0);
  sync.dispose();
});

test("同步客户端：反复切换画布 100 次，连接与可见性监听回到常数", () => {
  FakeSource.all = [];
  const listeners = new Set();
  const visibility = { hidden: () => false, subscribe: l => { listeners.add(l); return () => listeners.delete(l); } };
  for (let i = 0; i < 100; i++) {
    const sync = createCanvasSync({ canvasId: `c${i}`, actorId: () => A, onRemoteChange: () => {}, createSource: url => new FakeSource(url), visibility });
    sync.dispose();
  }
  assert.equal(open().length, 0);
  assert.equal(listeners.size, 0);
});

test("确认水位上报：节流只发最高值；失败不前移已发送；dispose 尽力发出", async () => {
  const posted = [];
  let fail = false;
  let fire = null;
  const acks = createAckReporter({
    canvasId: "c1", actorId: A,
    post: async body => { if (fail) throw new Error("offline"); posted.push(body); },
    schedule: fn => { fire = fn; return () => { fire = null; }; },
  });
  acks.report(1); acks.report(3); acks.report(2);
  fire(); await tick();
  assert.deepEqual(posted, [{ actorId: A, ackSeq: 3 }]);
  fail = true;
  acks.report(5);
  fire(); await tick();
  assert.deepEqual(acks.state(), { highest: 5, sent: 3 });
  fail = false;
  acks.dispose(); await tick();
  assert.deepEqual(posted.at(-1), { actorId: A, ackSeq: 5 });
});

test("变更通知：旧整图保存与领域命令成功后都通知；重放的命令不再通知；修订探测读得到新修订", async () => {
  const { saveCanvas, canvasRevision } = store.module;
  const { executeCommand, JSON_STORAGE_EPOCH } = service.module;
  const seen = [];
  const unsubscribe = subscribeCanvasChanged("sync-a", change => seen.push(change));
  const saved = await saveCanvas({ id: "sync-a", name: "同步", schemaVersion: 1, createdAt: "2026-01-01T00:00:00.000Z", viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [{ id: "t1", type: "canvasText", position: { x: 0, y: 0 }, width: 300, height: 200, data: { name: "文本", content: "正文" } }], edges: [] }, -1);
  assert.ok(saved);
  assert.deepEqual(seen.at(-1), { canvasId: "sync-a", revision: saved.revision, actorId: null });
  assert.deepEqual(await canvasRevision("sync-a"), { revision: saved.revision });
  const cmd = { schemaVersion: 1, commandId: "00000000-0000-4000-8000-000000000001", actorId: A, actorSeq: 1, canvasId: "sync-a", storageEpoch: JSON_STORAGE_EPOCH, baseRevision: saved.revision,
    kind: "patch_nodes", payload: { items: [{ nodeId: "t1", field: "name", expectedVersion: 0, value: "新名字" }] } };
  const receipt = await executeCommand(cmd, { origin: "client" });
  assert.deepEqual(seen.at(-1), { canvasId: "sync-a", revision: receipt.revision, actorId: A });
  const count = seen.length;
  assert.equal((await executeCommand(structuredClone(cmd), { origin: "client" })).replayed, true);
  assert.equal(seen.length, count, "重放不产生新通知");
  assert.deepEqual(await canvasRevision("sync-a"), { revision: receipt.revision }, "mtime 变化后探测读到新修订");
  assert.equal(await canvasRevision("missing-canvas"), null);
  unsubscribe();
  assert.equal(changeListenerCount("sync-a"), 0);
  notifyCanvasChanged({ canvasId: "sync-a", revision: 99, actorId: null }); // 无订阅者不报错
});

test("FlowCanvas：删除常态 2 秒整图轮询，改由 SSE 驱动拉取并上报确认水位", async () => {
  const source = await readFile(new URL("../components/canvas/flow-canvas.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /setInterval\(\(\) => \{\s*if \(draftReadyRef\.current && saveOkRef\.current/, "不再定时调用 save 拉整图");
  assert.match(source, /createCanvasSync\(/);
  assert.match(source, /onAcked: actorSeq => acks\.report\(actorSeq\)/);
  const route = await readFile(new URL("../app/api/canvases/[id]/events/route.ts", import.meta.url), "utf8");
  assert.match(route, /text\/event-stream/);
  assert.match(route, /createCanvasEventStream/);
});
