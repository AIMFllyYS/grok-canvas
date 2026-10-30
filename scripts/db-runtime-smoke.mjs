/**
 * 三端 DB 运行时 smoke（P3-02，contracts.md C4）。
 *   node        Node 开发：系统 node + 仓库 lib/db/worker.cjs
 *   standalone  pnpm build 产物：系统 node + <distDir>/standalone/db-runtime，并从产物启动 server.js
 *   electron    .desktop/app：Electron 可执行文件的服务运行模式（ELECTRON_RUN_AS_NODE=1）+ 包内 db-runtime
 * 每端都跑：probe（建表/回滚/重启读取/备份）、缺资源副本必须失败、错误平台 native 副本必须明确报错。
 * 报告写到 .tmp-db-smoke/<target>-report.json（项目与用户目录已脱敏）。任一项失败退出码 1，不跳过。
 */
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkStandalone, currentBuildDir } from "./build-root.mjs";
import { auditPackage, nativeTarget, stageDbRuntime, verifyDbRuntime } from "./db-runtime.mjs";

const require = createRequire(import.meta.url);
const desktop = require("../desktop/runtime.cjs");
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const probe = path.join(root, "scripts", "db-runtime-probe.cjs");
const target = (process.argv.find((arg) => arg.startsWith("--target=")) || "").slice(9);
if (!["node", "standalone", "electron"].includes(target)) {
  console.error("用法：node scripts/db-runtime-smoke.mjs --target=node|standalone|electron");
  process.exit(2);
}
const outRoot = path.join(root, ".tmp-db-smoke");
const work = path.join(outRoot, target);
await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });

const failures = [];
const expect = (condition, message) => { if (!condition) failures.push(message); };

function sanitize(value) {
  let text = JSON.stringify(value);
  const swap = (from, to) => {
    for (const variant of new Set([from, from.replace(/\\/g, "/"), JSON.stringify(from).slice(1, -1)])) {
      if (variant.length > 3) text = text.split(variant).join(to);
    }
  };
  swap(path.resolve(root), "<repo>");
  swap(os.homedir(), "<home>");
  return JSON.parse(text);
}

function runProbe(execPath, workerPath, dataDir, env) {
  const result = spawnSync(execPath, [probe, workerPath, dataDir], { encoding: "utf8", timeout: 90_000, env, windowsHide: true });
  const line = (result.stdout || "").split(/\r?\n/).find((l) => l.startsWith("DB_PROBE "));
  return { status: result.status, signal: result.signal, stderr: (result.stderr || "").slice(-2000), report: line ? JSON.parse(line.slice(9)) : null };
}

async function negativeChecks(execPath, runtimeDir, env, label) {
  const prebuilds = path.join(path.dirname(require.resolve("better-sqlite3/package.json")), "prebuilds");
  const manifest = JSON.parse(await readFile(path.join(runtimeDir, "manifest.json"), "utf8"));
  const results = {};

  const missing = path.join(work, "neg-missing-driver");
  await cp(runtimeDir, missing, { recursive: true });
  await rm(path.join(missing, "lib", "db", "driver.cjs"));
  const a = runProbe(execPath, path.join(missing, manifest.worker), path.join(work, "neg-missing-data"), env);
  results.missingDriver = { exitCode: a.status, error: a.report && a.report.error };
  expect(a.status !== 0 && a.report && a.report.ok === false && /driver\.cjs/.test(a.report.error || ""), `${label}: 删除 driver.cjs 的副本必须启动失败并指出缺失文件`);

  const noWorker = path.join(work, "neg-missing-worker");
  await cp(runtimeDir, noWorker, { recursive: true });
  await rm(path.join(noWorker, "lib", "db", "worker.cjs"));
  const b = runProbe(execPath, path.join(noWorker, manifest.worker), path.join(work, "neg-noworker-data"), env);
  results.missingWorker = { exitCode: b.status, error: b.report && b.report.error };
  expect(b.status !== 0 && /缺少 DB Worker/.test((b.report && b.report.error) || ""), `${label}: 删除 worker.cjs 的副本必须启动失败`);

  const wrong = path.join(work, "neg-wrong-native");
  await cp(runtimeDir, wrong, { recursive: true });
  const host = process.platform;
  const other = (await readdir(prebuilds)).find((f) => f !== `${manifest.target}.node` && !f.startsWith(host));
  await cp(path.join(prebuilds, other), path.join(wrong, manifest.native));
  const c = runProbe(execPath, path.join(wrong, manifest.worker), path.join(work, "neg-wrong-data"), env);
  results.wrongNative = { substituted: other, exitCode: c.status, error: c.report && c.report.error };
  expect(c.status !== 0 && /DB native 加载失败/.test((c.report && c.report.error) || "") && /modules \d+/.test(c.report.error), `${label}: 错误平台 native 必须明确报错（含 ABI），不能回退`);
  return results;
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  else child.kill("SIGKILL");
}

async function bootServer(execPath, entry, cwd, env, port) {
  const url = `http://127.0.0.1:${port}/`;
  try { await fetch(url, { signal: AbortSignal.timeout(500) }); return { ok: false, error: `端口 ${port} 已被占用` }; } catch { /* free */ }
  // GROK_CANVAS_PORT 与监听端口一致，否则本机访问守卫（lib/local-access.ts）会按 Host 拒绝为 403。
  const child = spawn(execPath, [entry], { cwd, env: { ...env, PORT: String(port), GROK_CANVAS_PORT: String(port), HOSTNAME: "127.0.0.1", NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let log = "";
  child.stdout.on("data", (chunk) => { log = `${log}${chunk}`.slice(-4000); });
  child.stderr.on("data", (chunk) => { log = `${log}${chunk}`.slice(-4000); });
  const started = Date.now();
  try {
    while (Date.now() - started < 45_000) {
      if (child.exitCode !== null) return { ok: false, error: `服务提前退出（code ${child.exitCode}）`, log };
      try {
        const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2000) });
        const ok = response.status >= 200 && response.status < 400;
        if (!ok) await new Promise((resolve) => setTimeout(resolve, 500));
        return { ok, status: response.status, readyMs: Date.now() - started, ...(ok ? {} : { log }) };
      } catch { await new Promise((resolve) => setTimeout(resolve, 300)); }
    }
    return { ok: false, error: "45 秒内未就绪", log };
  } finally {
    killTree(child);
  }
}

const report = { target, host: { platform: process.platform, arch: process.arch, node: process.version } };
const dataRoot = path.join(work, "data");
const baseEnv = { ...process.env, GROK_CANVAS_DATA_DIR: path.join(work, "app-data") };
delete baseEnv.GROK_CANVAS_DB_WORKER;
delete baseEnv.ELECTRON_RUN_AS_NODE;

try {
  if (target === "node") {
    const workerPath = path.join(root, "lib", "db", "worker.cjs");
    const result = runProbe(process.execPath, workerPath, dataRoot, baseEnv);
    report.probe = result.report;
    expect(result.status === 0 && result.report?.ok, `node: probe 失败 ${result.report?.error || result.stderr}`);
    expect(result.report?.health?.runtime.execPath === process.execPath, "node: probe 必须由当前 node 执行");
    const copy = path.join(work, "runtime");
    await stageDbRuntime({ projectRoot: root, destination: copy });
    report.negative = await negativeChecks(process.execPath, copy, baseEnv, "node");
  } else if (target === "standalone") {
    const build = checkStandalone(currentBuildDir(root));
    const runtimeDir = path.join(build.standalone, "db-runtime");
    const manifest = await verifyDbRuntime(runtimeDir);
    report.build = { distDir: build.distDir, buildId: build.buildId, dbTarget: manifest.target, driverVersion: manifest.driverVersion };
    expect(manifest.target === nativeTarget(), `standalone: db-runtime 目标 ${manifest.target} 与本机 ${nativeTarget()} 不符`);
    const result = runProbe(process.execPath, path.join(runtimeDir, manifest.worker), dataRoot, baseEnv);
    report.probe = result.report;
    expect(result.status === 0 && result.report?.ok, `standalone: probe 失败 ${result.report?.error || result.stderr}`);
    expect(path.resolve(result.report?.health?.nativeBinding || "") === path.resolve(runtimeDir, manifest.native), "standalone: 必须加载产物内的 native");
    report.server = await bootServer(process.execPath, build.server, build.standalone, baseEnv, 3291);
    expect(report.server.ok, `standalone: server.js 启动失败 ${report.server.error || report.server.status}`);
    report.negative = await negativeChecks(process.execPath, runtimeDir, baseEnv, "standalone");
    const audit = await auditPackage(build.standalone, { projectRoot: root });
    // Windows + pnpm 下 Next 把 standalone/node_modules 写成指回仓库 store 的 junction：standalone 只在构建机运行，
    // 不分发；分发的桌面包由 desktop:deps 重新平铺安装，electron 目标对任何包外链接都判失败。
    const externalLinks = audit.forbidden.filter((item) => item.reason === "链接指向包外");
    const forbidden = audit.forbidden.filter((item) => item.reason !== "链接指向包外");
    expect(!externalLinks.some((item) => item.path.startsWith("db-runtime/")), "standalone: db-runtime 内不允许链接");
    report.package = { fileCount: audit.files.length, natives: audit.files.filter((f) => f.endsWith(".node")), nextExternalLinks: externalLinks.length, forbidden };
    expect(forbidden.length === 0, `standalone: 产物审计失败 ${JSON.stringify(forbidden.slice(0, 5))}`);
  } else {
    const electronDir = path.join(root, "node_modules", "electron");
    const pathFile = path.join(electronDir, "path.txt");
    const electronExe = existsSync(pathFile) ? path.join(electronDir, "dist", readFileSync(pathFile, "utf8").trim()) : null;
    if (!electronExe || !existsSync(electronExe)) throw new Error("缺少 Electron 二进制：先运行 node node_modules/electron/install.js（依赖脚本默认关闭，必须显式下载），不能跳过");
    const electronVersion = JSON.parse(readFileSync(path.join(electronDir, "package.json"), "utf8")).version;
    const resources = path.join(root, ".desktop");
    const appDir = path.join(resources, "app");
    const manifest = desktop.readDesktopManifest(appDir);
    const launch = desktop.serverLaunch({ packaged: true, resourcesPath: resources, appPath: "", manifest });
    const runtimeDir = path.join(appDir, "db-runtime");
    const dbManifest = await verifyDbRuntime(runtimeDir);
    expect(dbManifest.target === nativeTarget(), `electron: db-runtime 目标 ${dbManifest.target} 与本机 ${nativeTarget()} 不符`);
    // 与 desktop/main.cjs 完全相同的服务环境：Electron 可执行文件 + ELECTRON_RUN_AS_NODE=1。
    const env = desktop.serverEnvironment(baseEnv, launch.nodePath, launch.dbWorker);
    report.build = { distDir: manifest.distDir, buildId: manifest.buildId, dbTarget: dbManifest.target, driverVersion: dbManifest.driverVersion, electron: electronVersion };
    const result = runProbe(electronExe, launch.dbWorker, dataRoot, env);
    report.probe = result.report;
    const runtime = result.report?.health?.runtime;
    expect(result.status === 0 && result.report?.ok, `electron: probe 失败 ${result.report?.error || result.stderr}`);
    expect(runtime?.electron === electronVersion, `electron: probe 必须运行在 Electron ${electronVersion}，实际 ${runtime?.electron}`);
    expect(path.resolve(runtime?.execPath || "") === path.resolve(electronExe), "electron: execPath 必须是 Electron 可执行文件，不能用系统 node 代替");
    expect(runtime?.modules !== process.versions.modules, `electron: modules ABI（${runtime?.modules}）不能等于系统 node（${process.versions.modules}）`);
    expect(path.resolve(result.report?.health?.nativeBinding || "") === path.resolve(runtimeDir, dbManifest.native), "electron: 必须加载包内 db-runtime 的 native");
    report.server = await bootServer(electronExe, launch.entry, launch.cwd, env, 3292);
    expect(report.server.ok, `electron: 包内 server.js 启动失败 ${report.server.error || report.server.status}`);
    report.negative = await negativeChecks(electronExe, runtimeDir, env, "electron");
    const audit = await auditPackage(appDir, { projectRoot: root });
    report.package = { fileCount: audit.files.length, natives: audit.files.filter((f) => f.endsWith(".node")), forbidden: audit.forbidden };
    expect(audit.forbidden.length === 0, `electron: 包审计失败 ${JSON.stringify(audit.forbidden.slice(0, 5))}`);
    const sqliteNatives = report.package.natives.filter((file) => /better[-_]sqlite3/.test(file));
    expect(sqliteNatives.length === 1 && sqliteNatives[0] === `db-runtime/${dbManifest.native}`, `electron: 包内应只有 db-runtime 里的 1 个 better-sqlite3 native，实际 ${sqliteNatives.join(", ")}`);
  }
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
}

report.failures = failures;
report.ok = failures.length === 0;
const clean = sanitize(report);
await writeFile(path.join(outRoot, `${target}-report.json`), `${JSON.stringify(clean, null, 2)}\n`);
const h = clean.probe?.health;
console.log(`DB_SMOKE ${JSON.stringify({ target, ok: clean.ok, execPath: h?.runtime.execPath, electron: h?.runtime.electron, modules: h?.runtime.modules, napi: h?.runtime.napi, driver: h?.driverVersion, sqlite: h?.sqliteVersion, worker: clean.probe?.workerPath, native: h?.nativeBinding, steps: clean.probe?.steps, server: clean.server, failures })}`);
process.exitCode = clean.ok ? 0 : 1;
