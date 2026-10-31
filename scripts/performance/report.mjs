#!/usr/bin/env node
/**
 * 测量报告（P6-01）：读取脱敏的 metrics snapshot（可多份：冷/热媒体、production/runtime）与可选 trace 摘要，
 * 按 C9 目标给出 pass / fail / unmeasured。缺指标一律“未测”，空样本不判通过。
 * 用法：node scripts/performance/report.mjs --samples a.json [--samples b.json] [--trace trace-summary.json] [--out report.json]
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** C9 性能目标；value 单位 ms，比较的分位数。 */
export const TARGETS = [
  { metric: "frame_interval_ms", quantile: "p95", max: 20 },
  { metric: "frame_interval_ms", quantile: "p99", max: 50 },
  { metric: "pointer_to_paint_ms", quantile: "p95", max: 50 },
  { metric: "event_to_visible_ms", quantile: "p95", max: 200 },
  { metric: "local_commit_ms", quantile: "p95", max: 100 },
];
const REQUIRED_ENVIRONMENT = ["media", "build", "hardware", "version"];

export function evaluate(snapshot) {
  const rows = TARGETS.map(target => {
    const summary = snapshot?.metrics?.[target.metric];
    if (!summary || summary.status !== "measured" || !summary.count) return { ...target, status: "unmeasured", value: null, count: 0 };
    const value = summary[target.quantile];
    return { ...target, status: value <= target.max ? "pass" : "fail", value, count: summary.count };
  });
  const environment = snapshot?.environment ?? {};
  const missingEnvironment = REQUIRED_ENVIRONMENT.filter(key => environment[key] === undefined || environment[key] === "");
  const statuses = new Set(rows.map(row => row.status));
  const overall = statuses.has("fail") ? "fail" : statuses.has("unmeasured") || missingEnvironment.length ? "incomplete" : "pass";
  return { overall, rows, environment, missingEnvironment, dropped: snapshot?.dropped ?? 0, overwritten: snapshot?.overwritten ?? 0 };
}

export function buildReport(snapshots, trace = null) {
  const runs = snapshots.map(({ label, snapshot }) => ({ label, ...evaluate(snapshot) }));
  const overall = runs.some(run => run.overall === "fail") ? "fail" : runs.length && runs.every(run => run.overall === "pass") ? "pass" : "incomplete";
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), overall, runs, trace: trace ?? { status: "unmeasured", note: "未提供用户 trace 摘要" } };
}

async function main() {
  const argv = process.argv.slice(2);
  const samples = [], out = { file: null }, trace = { file: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--samples") samples.push(argv[++i]);
    else if (argv[i] === "--trace") trace.file = argv[++i];
    else if (argv[i] === "--out") out.file = argv[++i];
    else throw new Error(`未知参数：${argv[i]}`);
  }
  if (!samples.length) throw new Error("至少需要一个 --samples 文件");
  const snapshots = await Promise.all(samples.map(async file => ({ label: path.basename(file), snapshot: JSON.parse(await readFile(file, "utf8")) })));
  const report = buildReport(snapshots, trace.file ? JSON.parse(await readFile(trace.file, "utf8")) : null);
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (out.file) await writeFile(out.file, text, { flag: "wx" }); else process.stdout.write(text);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
