#!/usr/bin/env node
/**
 * 工作站迁移工具（P3-06）。默认 dry-run，只读源目录并输出分类/digest，不写任何文件；
 * 只有显式 --staging=<新目录> 才导入到隔离 staging 库。永不写 storage-state.json，也不修改源 JSON。
 *   node scripts/workstation-migrate.mjs --source=<旧数据目录>                 # dry-run
 *   node scripts/workstation-migrate.mjs --source=<旧数据目录> --staging=<目录> # 导入/续跑
 *   ... --reset   源数据变化后丢弃 staging 库并重新准备
 * 真实用户数据只在用户明确授权后运行；本仓库测试全部使用临时目录。
 */
import { createRequire } from "node:module";
import path from "node:path";
import { loadTypescript } from "../tests/helpers/load-typescript.mjs";

const require = createRequire(import.meta.url);
const importer = require("../lib/db/importer.cjs");
const arg = (name) => { const hit = process.argv.find(a => a.startsWith(`--${name}=`)); return hit ? hit.slice(name.length + 3) : undefined; };
const source = arg("source");
const staging = arg("staging");
const reset = process.argv.includes("--reset");

if (!source) {
  console.error("用法：node scripts/workstation-migrate.mjs --source=<旧数据目录> [--staging=<新目录>] [--reset]");
  process.exit(2);
}

// 画布转换与源分类复用 TS 实现（单一来源），用仓库的转译加载器载入。
const legacy = await loadTypescript("lib/canvas-runtime/legacy-document.ts", { packages: true });
const catalog = await loadTypescript("lib/db/import-catalog.ts");
const convert = { fromCanvasDoc: legacy.module.fromCanvasDoc, classifySource: catalog.module.classifySource };
try {
  const resolvedSource = path.resolve(source);
  const result = staging
    ? await importer.runImport({ sourceDir: resolvedSource, stagingDir: path.resolve(staging), convert, reset })
    : await importer.dryRun({ sourceDir: resolvedSource, convert });
  const summary = staging
    ? { status: result.status, blocking: result.blocking, missingMedia: result.missingMedia.length, validationProblems: result.validation?.problems ?? [], report: path.join(path.resolve(staging), importer.REPORT_FILE) }
    : result;
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = staging && result.status !== "ready_to_switch" ? 1 : 0;
} catch (error) {
  console.error(`迁移失败（${error.code ?? "error"}）：${error.message}`);
  process.exitCode = 1;
} finally {
  await legacy.dispose();
  await catalog.dispose();
}
