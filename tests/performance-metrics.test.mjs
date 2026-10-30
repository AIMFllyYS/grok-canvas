import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadTypescript } from "./helpers/load-typescript.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const metricsModule = await loadTypescript("lib/canvas-runtime/metrics.ts");
const dir = await mkdtemp(path.join(os.tmpdir(), "grok-canvas-perf-"));
after(async () => { await metricsModule.dispose(); await rm(dir, { recursive: true, force: true }); });
const { createMetrics, percentile, sanitizeMetadata, measurePointerToPaint } = metricsModule.module;
const { generateFixture, SIZES } = await import("../scripts/performance/fixture.mjs");
const { evaluate, buildReport } = await import("../scripts/performance/report.mjs");

test("百分位：已知序列的最近秩结果；空样本不给数字", () => {
  const sorted = Float64Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(sorted, 50), 50);
  assert.equal(percentile(sorted, 95), 95);
  assert.equal(percentile(sorted, 99), 99);
  assert.equal(percentile(Float64Array.from([7]), 99), 7);
  assert.throws(() => percentile(new Float64Array(0), 50));
});

test("空数据是 unmeasured 而不是 0ms；异常数值丢弃并计数", () => {
  const metrics = createMetrics({ enabled: true });
  const empty = metrics.snapshot();
  assert.deepEqual(empty.metrics.frame_interval_ms, { status: "unmeasured", count: 0 });
  for (const bad of [NaN, Infinity, -1]) assert.equal(metrics.record("frame_interval_ms", bad), false);
  assert.equal(metrics.record("not_a_metric", 1), false);
  assert.equal(metrics.snapshot().dropped, 4);
  metrics.record("frame_interval_ms", 16);
  metrics.record("frame_interval_ms", 18);
  const summary = metrics.snapshot().metrics.frame_interval_ms;
  assert.equal(summary.status, "measured");
  assert.deepEqual([summary.count, summary.p50, summary.max, summary.mean], [2, 16, 18, 17]);
});

test("环形缓冲不增长：超过容量覆盖最旧样本并计数", () => {
  const metrics = createMetrics({ enabled: true, capacity: 100 });
  for (let i = 0; i < 1000; i++) metrics.record("react_commit_ms", i);
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.size, 100);
  assert.equal(snapshot.overwritten, 900);
  assert.equal(snapshot.metrics.react_commit_ms.count, 100);
  assert.equal(snapshot.metrics.react_commit_ms.p50, 949, "只保留最新 100 个（900..999）");
});

test("诊断关闭：record 直接返回，不写入缓冲；metadata 只留白名单数值与脱敏 ID，不记录正文/token", () => {
  const metrics = createMetrics();
  assert.equal(metrics.record("frame_interval_ms", 16), false);
  assert.equal(metrics.size(), 0);
  assert.deepEqual(sanitizeMetadata({ phase: "update", nodeCount: 1000, content: "用户正文", token: "sk-123", canvas: "../etc", kind: "drag" }), { phase: "update", nodeCount: 1000, kind: "drag" });
  assert.equal(sanitizeMetadata({ prompt: "一只猫" }), undefined);
});

test("pointer-to-paint：rAF 关联记录延迟；无帧回调时记为 unmeasured，不估算", async () => {
  const metrics = createMetrics({ enabled: true });
  measurePointerToPaint(100, metrics, (cb) => { cb(112); return 1; });
  measurePointerToPaint(200, metrics, () => 1);
  await new Promise(resolve => setTimeout(resolve, 130));
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.metrics.pointer_to_paint_ms.p50, 12);
  assert.equal(snapshot.metrics.pointer_to_paint_unmeasured.count, 1);
  const off = createMetrics();
  let called = false;
  measurePointerToPaint(1, off, () => { called = true; return 1; });
  assert.equal(called, false, "关闭时不注册 rAF");
});

test("fixture：数量、类型比例、边唯一性与长文长度准确，不用空节点替代混合负载", () => {
  for (const size of SIZES) {
    const fixture = generateFixture({ size, topology: "2n", longText: size === 1000 });
    assert.equal(fixture.nodes.length, size);
    const counts = Object.groupBy(fixture.nodes, node => node.type);
    assert.equal(counts.canvasText.length, size / 2);
    assert.equal(counts.video.length, size / 20);
    assert.equal(counts.image.length + counts.asset.length, size - size / 2 - size / 20);
    assert.equal(fixture.edges.length, size * 2);
    assert.equal(new Set(fixture.edges.map(e => `${e.source}->${e.target}`)).size, fixture.edges.length, "边唯一");
    assert.equal(new Set(fixture.nodes.map(n => n.id)).size, size);
    assert.ok(fixture.nodes.every(n => n.data && Object.keys(n.data).length >= 1 && n.data.name));
  }
  assert.equal(generateFixture({ size: 100, topology: "sparse" }).edges.length, 100);
  const dense = generateFixture({ size: 1000, topology: "dense" });
  assert.ok(new Set(dense.edges.map(e => e.source)).size <= 100, "局部密集：源集中在 100 个文本节点");
  const long = generateFixture({ size: 1000, topology: "2n", longText: true });
  const bytes = Buffer.byteLength(long.nodes[0].data.content);
  assert.ok(bytes >= 99 * 1024 && bytes <= 101 * 1024, `100KB 长文（实际 ${bytes}）`);
  assert.throws(() => generateFixture({ size: 123 }));
});

test("fixture CLI：必须显式指定输出；默认不覆盖已有文件", async () => {
  const cli = path.join(root, "scripts", "performance", "fixture.mjs");
  const none = spawnSync(process.execPath, [cli, "--size", "100"], { encoding: "utf8" });
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /--out|--import-url/);
  const out = path.join(dir, "f.json");
  assert.equal(spawnSync(process.execPath, [cli, "--size", "100", "--out", out], { encoding: "utf8" }).status, 0);
  assert.equal(JSON.parse(await readFile(out, "utf8")).nodes.length, 100);
  await writeFile(out, "keep");
  assert.notEqual(spawnSync(process.execPath, [cli, "--size", "100", "--out", out], { encoding: "utf8" }).status, 0);
  assert.equal(await readFile(out, "utf8"), "keep", "wx 不覆盖");
});

test("报告：缺指标标未测、空样本不判通过；超目标为 fail；缺环境信息为 incomplete", () => {
  const empty = createMetrics({ enabled: true }).snapshot({ media: "cold", build: "production", hardware: "ci", version: "x" });
  assert.equal(evaluate(empty).overall, "incomplete");
  assert.ok(evaluate(empty).rows.every(row => row.status === "unmeasured"));
  const metrics = createMetrics({ enabled: true });
  for (let i = 0; i < 100; i++) { metrics.record("frame_interval_ms", 16); metrics.record("pointer_to_paint_ms", 30); metrics.record("event_to_visible_ms", 120); metrics.record("local_commit_ms", 60); }
  const good = evaluate(metrics.snapshot({ media: "hot", build: "production", hardware: "dev-laptop", version: "p6-01" }));
  assert.equal(good.overall, "pass");
  metrics.record("frame_interval_ms", 80);
  for (let i = 0; i < 10; i++) metrics.record("frame_interval_ms", 80);
  assert.equal(evaluate(metrics.snapshot({ media: "hot", build: "production", hardware: "x", version: "y" })).overall, "fail");
  assert.equal(evaluate(createMetrics({ enabled: true }).snapshot()).missingEnvironment.length, 4);
  assert.equal(buildReport([]).overall, "incomplete");
  assert.equal(buildReport([{ label: "a", snapshot: empty }]).trace.status, "unmeasured");
});

test("接线：Scene/手势/同步/DB 诊断 hook 默认关闭且不记录正文", async () => {
  const scene = await readFile(path.join(root, "components", "canvas", "canvas-scene.tsx"), "utf8");
  const flow = await readFile(path.join(root, "components", "canvas", "flow-canvas.tsx"), "utf8");
  const service = await readFile(path.join(root, "lib", "db", "service.ts"), "utf8");
  assert.match(scene, /<Profiler id="canvas-scene"/);
  assert.match(scene, /frame_interval_ms/);
  assert.match(flow, /measurePointerToPaint\(/);
  assert.match(flow, /record\("outbox_items"/);
  assert.match(service, /onTiming\?: \(op: DbOp, ms: number\) => void/);
  const metricsSource = await readFile(path.join(root, "lib", "canvas-runtime", "metrics.ts"), "utf8");
  assert.match(metricsSource, /enabled: typeof localStorage/);
});
