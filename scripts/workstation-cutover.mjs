#!/usr/bin/env node
/**
 * 存储权威切换工具（P3-08）。默认只做 preflight（列出阻断项），不写任何文件；必须显式 --execute 才切换。
 *   node scripts/workstation-cutover.mjs --data=<数据目录>                                   # 只检查
 *   node scripts/workstation-cutover.mjs --data=<数据目录> --execute --clients-drained       # 切换
 *   node scripts/workstation-cutover.mjs --data=<数据目录> --rollback                         # 切换后会被拒绝
 * 当前用户真实库的切换需要用户再次明确授权；先在复制出的隔离数据目录演练。
 */
import { createRequire } from "node:module";
import path from "node:path";
import { loadTypescript } from "../tests/helpers/load-typescript.mjs";

const require = createRequire(import.meta.url);
const { runCutover, preflight, refuseRollback } = require("../lib/db/cutover.cjs");
const arg = (name) => { const hit = process.argv.find(a => a.startsWith(`--${name}=`)); return hit ? hit.slice(name.length + 3) : undefined; };
const flag = (name) => process.argv.includes(`--${name}`);
const data = arg("data");
if (!data) { console.error("用法：node scripts/workstation-cutover.mjs --data=<数据目录> [--execute --clients-drained] [--no-backup] [--rollback]"); process.exit(2); }
const dataDir = path.resolve(data);

try {
  if (flag("rollback")) {
    console.log(JSON.stringify(refuseRollback(dataDir)));
  } else if (!flag("execute")) {
    const blockers = await preflight(dataDir, flag("clients-drained"));
    console.log(JSON.stringify({ mode: "preflight", blockers }, null, 2));
    process.exitCode = blockers.length ? 1 : 0;
  } else {
    const legacy = await loadTypescript("lib/canvas-runtime/legacy-document.ts", { packages: true });
    const catalog = await loadTypescript("lib/db/import-catalog.ts");
    try {
      const result = await runCutover({ dataDir, clientsDrained: flag("clients-drained"), backup: !flag("no-backup"), convert: { fromCanvasDoc: legacy.module.fromCanvasDoc, classifySource: catalog.module.classifySource } });
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.status === "committed" ? 0 : 1;
    } finally { await legacy.dispose(); await catalog.dispose(); }
  }
} catch (error) {
  console.error(`切换失败（${error.code ?? "error"}）：${error.message}`);
  process.exitCode = 1;
}
