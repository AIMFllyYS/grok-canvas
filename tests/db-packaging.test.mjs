import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadTypescript } from "./helpers/load-typescript.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const scratch = await mkdtemp(path.join(os.tmpdir(), "grok-canvas-pack-"));
after(() => rm(scratch, { recursive: true, force: true }));

const buildRoot = await import(pathToFileURL(path.join(root, "scripts", "build-root.mjs")).href);
const dbRuntime = await import(pathToFileURL(path.join(root, "scripts", "db-runtime.mjs")).href);
const desktop = require("../desktop/runtime.cjs");
const probe = path.join(root, "scripts", "db-runtime-probe.cjs");

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort();
}

function runProbe(workerPath, dataDir, execPath = process.execPath, env = process.env) {
  const result = spawnSync(execPath, [probe, workerPath, dataDir], { encoding: "utf8", timeout: 60_000, env });
  const line = (result.stdout || "").split(/\r?\n/).find((l) => l.startsWith("DB_PROBE "));
  return { status: result.status, stderr: result.stderr, report: line ? JSON.parse(line.slice(9)) : null };
}

test("buildRoot：默认 .next，自定义目录规范化为项目内相对路径", () => {
  assert.deepEqual(buildRoot.resolveBuildDir(undefined, root), { name: ".next", absolute: path.join(root, ".next") });
  assert.equal(buildRoot.resolveBuildDir("", root).name, ".next");
  assert.equal(buildRoot.resolveBuildDir(".tmp-workstation-check", root).name, ".tmp-workstation-check");
  assert.equal(buildRoot.resolveBuildDir("out\\desk", root).name, "out/desk");
  assert.equal(buildRoot.resolveBuildDir("./dist-check", root).name, "dist-check");
  assert.equal(buildRoot.resolveBuildDir("dist-check", root).absolute, path.join(root, "dist-check"));
});

test("buildRoot：拒绝绝对路径、目录穿越、项目根和受保护目录", () => {
  // build/ 是 electron-builder 的资源目录（icon.png），被 cleanDistDir 清空会丢图标。
  for (const bad of ["../x", "..", "a/../../b", "a/../b", "/abs", "C:\\abs", "C:rel", "\\\\server\\share", ".", "./", "node_modules", "node_modules/x", "public", "app", "lib", "build", "desktop", ".desktop", "release", ".git", "a//b", "a:b"]) {
    assert.throws(() => buildRoot.resolveBuildDir(bad, root), /GROK_CANVAS_BUILD_DIR/, `应拒绝 ${bad}`);
  }
});

test("buildRoot：standalone 来源必须与当前 distDir 和 BUILD_ID 一致", async () => {
  const project = path.join(scratch, "project");
  const make = async (name, embedded, rootId, standaloneId) => {
    const absolute = path.join(project, name);
    await rm(absolute, { recursive: true, force: true });
    await mkdir(path.join(absolute, "standalone", name), { recursive: true });
    await writeFile(path.join(absolute, "BUILD_ID"), rootId);
    await writeFile(path.join(absolute, "standalone", "server.js"), `const nextConfig = {"env":{},"distDir":"${embedded}","cleanDistDir":true}`);
    if (standaloneId !== null) await writeFile(path.join(absolute, "standalone", name, "BUILD_ID"), standaloneId);
    return { name, absolute };
  };
  const good = buildRoot.checkStandalone(await make(".x", "./.x", "abc", "abc"));
  assert.equal(good.buildId, "abc");
  assert.equal(good.standalone, path.join(project, ".x", "standalone"));
  assert.throws(() => buildRoot.checkStandalone({ name: ".y", absolute: path.join(project, ".y") }), /server\.js/);
  const stale = await make(".z", "./.next", "abc", "abc");
  assert.throws(() => buildRoot.checkStandalone(stale), /distDir/);
  const mixed = await make(".w", "./.w", "new", "old");
  assert.throws(() => buildRoot.checkStandalone(mixed), /BUILD_ID/);
  const missing = await make(".v", "./.v", "abc", null);
  assert.throws(() => buildRoot.checkStandalone(missing), /BUILD_ID/);
});

test("traceExcludes：按 Next 的 contains 匹配，从不排除当前 distDir 与 Next 运行时文件", () => {
  // 实测语义：模式去掉 ./ 后以 picomatch contains+dot 在路径任意位置命中（与 3 次隔离构建的实际 trace 一致）。
  const picomatch = require("next/dist/compiled/picomatch");
  const entries = [".tmp-db-smoke-build", ".tmp-db-smoke", ".tmp-workstation-check", ".next", ".next.stale-1", "app", "lib"];
  const compile = (globs) => picomatch(globs.map((glob) => glob.replace(/^\.\//, "")), { contains: true, dot: true });
  // 根因复现：旧列表的裸目录通配吃掉隔离构建自己的 chunk 和 next/dist 的运行时文件。
  const legacy = compile(["./.tmp-*", "./build/**/*", "./components/**/*"]);
  assert.equal(legacy(".tmp-workstation-check/server/chunks/ssr/x.js"), true);
  assert.equal(legacy("node_modules/next/dist/build/define-env.js"), true);
  assert.equal(legacy("node_modules/next/dist/client/components/app-router.js"), true);
  const nextRuntime = [
    "node_modules/.pnpm/next@16.3.5/node_modules/next/dist/server/next.js",
    "node_modules/.pnpm/next@16.3.5/node_modules/next/dist/build/define-env.js",
    "node_modules/.pnpm/next@16.3.5/node_modules/next/dist/client/components/app-router.js",
    "node_modules/.pnpm/next@16.3.5/node_modules/next/dist/compiled/picomatch/index.js",
  ];
  for (const distDir of [".tmp-db-smoke-build", ".tmp-workstation-check", ".next"]) {
    const excluded = compile(buildRoot.traceExcludes(distDir, root, entries));
    for (const own of ["server/chunks/ssr/[turbopack]_runtime.js", "server/chunks/[root-of-the-server]__0u0d614._.js", "server/app/page.js"]) {
      assert.equal(excluded(`${distDir}/${own}`), false, `${distDir} 不能排除自己的 ${own}`);
    }
    for (const file of nextRuntime) assert.equal(excluded(file), false, `${distDir} 不能排除 ${file}`);
    for (const other of [".tmp-db-smoke-build", ".tmp-workstation-check", ".next"].filter((name) => name !== distDir)) {
      assert.equal(excluded(`${other}/server/x.js`), true, `${distDir} 构建应排除 ${other}`);
    }
    assert.equal(excluded(".next.stale-1/server/x.js"), true);
    assert.equal(excluded("lib/db/worker.cjs"), true, "lib/db 只经 db-runtime 进入产物");
    assert.equal(excluded("node_modules/.pnpm/better-sqlite3@13.0.3/node_modules/better-sqlite3/lib/index.js"), true);
    assert.equal(excluded("build/icon.png"), true);
  }
});

test("db-runtime：只拷贝 worker/driver 与目标平台的一个 native，清单哈希可复核", async () => {
  const destination = path.join(scratch, "stage-node", "db-runtime");
  const manifest = await dbRuntime.stageDbRuntime({ projectRoot: root, destination });
  const target = dbRuntime.nativeTarget();
  assert.equal(manifest.target, target);
  assert.equal(manifest.driverVersion, require("better-sqlite3/package.json").version);
  assert.equal(manifest.worker, "lib/db/worker.cjs");
  assert.equal(manifest.native, `node_modules/better-sqlite3/prebuilds/${target}.node`);
  const files = await walk(destination);
  const natives = files.filter((f) => f.endsWith(".node"));
  assert.deepEqual(natives, [manifest.native]);
  assert.ok(files.includes("lib/db/worker.cjs") && files.includes("lib/db/driver.cjs"));
  for (const f of files) {
    assert.ok(f === "manifest.json" || f.startsWith("lib/db/") || f.startsWith("node_modules/better-sqlite3/"), `白名单外文件 ${f}`);
    assert.ok(!f.endsWith(".ts") && !f.includes("/src/") && !f.includes("/deps/") && !f.endsWith("binding.gyp"), `源码进入运行包 ${f}`);
  }
  const listed = manifest.files.map((f) => f.path).sort();
  assert.deepEqual(listed, files.filter((f) => f !== "manifest.json"));
  for (const entry of manifest.files) {
    const hash = createHash("sha256").update(await readFile(path.join(destination, entry.path))).digest("hex");
    assert.equal(entry.sha256, hash, entry.path);
  }
  assert.equal((await dbRuntime.verifyDbRuntime(destination)).target, target);
  await writeFile(path.join(destination, "lib", "db", "driver.cjs"), "// tampered\n", { flag: "a" });
  await assert.rejects(dbRuntime.verifyDbRuntime(destination), /driver\.cjs/);
  await rm(destination, { recursive: true, force: true });
});

test("db-runtime：重复 staging 先清空旧产物，不复用", async () => {
  const destination = path.join(scratch, "stage-fresh", "db-runtime");
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, "stale.txt"), "old");
  await dbRuntime.stageDbRuntime({ projectRoot: root, destination });
  assert.ok(!(await walk(destination)).includes("stale.txt"));
  await rm(destination, { recursive: true, force: true });
});

test("probe：staging 里的 worker 用当前运行时完成建表、回滚、重启读取和备份", async () => {
  const destination = path.join(scratch, "stage-probe", "db-runtime");
  const manifest = await dbRuntime.stageDbRuntime({ projectRoot: root, destination });
  const data = path.join(scratch, "probe-data");
  const { status, report, stderr } = runProbe(path.join(destination, manifest.worker), data);
  assert.equal(status, 0, stderr);
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.health.ok, true);
  assert.equal(report.health.runtime.modules, process.versions.modules);
  assert.equal(report.health.runtime.execPath, process.execPath);
  assert.equal(path.resolve(report.health.nativeBinding), path.resolve(destination, manifest.native));
  assert.deepEqual(report.health.pragmas, { journal_mode: "wal", synchronous: 2, foreign_keys: 1, busy_timeout: 2000 });
  assert.deepEqual(report.steps, {
    schema: true, write: 1, rollback: { rejected: true, count: 1 }, restartRead: 1, backup: { count: 1, sqliteVersion: report.health.sqliteVersion },
    migrate: { applied: [1, 2], current: 2 },
    formalBackup: { status: "complete", verified: true, problems: [], restoredDb: "grok-canvas.sqlite", restoredCount: 1 },
  });
  await rm(destination, { recursive: true, force: true });
});

test("probe：native 换成其他平台的二进制时明确报错，不回退", async () => {
  const destination = path.join(scratch, "stage-wrong", "db-runtime");
  const manifest = await dbRuntime.stageDbRuntime({ projectRoot: root, destination });
  const prebuilds = path.join(path.dirname(require.resolve("better-sqlite3/package.json")), "prebuilds");
  const other = (await readdir(prebuilds)).find((f) => f !== `${manifest.target}.node` && !f.startsWith(process.platform));
  assert.ok(other, "需要一个其他平台的 prebuild 作为错误二进制");
  await copyFile(path.join(prebuilds, other), path.join(destination, manifest.native));
  const { status, report } = runProbe(path.join(destination, manifest.worker), path.join(scratch, "wrong-data"));
  assert.notEqual(status, 0);
  assert.equal(report.ok, false);
  assert.match(report.error, /DB native 加载失败/);
  assert.match(report.error, new RegExp(`${process.platform}-${process.arch}`));
  assert.match(report.error, /modules \d+/);
  await rm(destination, { recursive: true, force: true });
});

test("service：缺少 worker 资源时立即明确失败，不登记单例", async () => {
  const loaded = await loadTypescript("lib/db/service.ts");
  try {
    const { getDbService, activeDbServiceCount } = loaded.module;
    const before = activeDbServiceCount();
    const missing = path.join(scratch, "missing", "worker.cjs");
    assert.throws(() => getDbService({ file: path.join(scratch, "m.sqlite"), workerPath: missing }), (error) => {
      assert.equal(error.code, "storage_unavailable");
      assert.match(error.message, /缺少 DB Worker/);
      assert.ok(error.message.includes(missing));
      return true;
    });
    assert.equal(activeDbServiceCount(), before);
  } finally {
    await loaded.module.closeAllDbServices?.();
    await loaded.dispose();
  }
});

test("service：未指定路径时优先使用 GROK_CANVAS_DB_WORKER，其次 <cwd>/db-runtime", async () => {
  const loaded = await loadTypescript("lib/db/service.ts");
  const previous = process.env.GROK_CANVAS_DB_WORKER;
  try {
    const { resolveDbWorkerPath } = loaded.module;
    process.env.GROK_CANVAS_DB_WORKER = path.join(scratch, "env-worker.cjs");
    assert.equal(resolveDbWorkerPath(root), path.join(scratch, "env-worker.cjs"));
    delete process.env.GROK_CANVAS_DB_WORKER;
    assert.equal(resolveDbWorkerPath(root), path.join(root, "lib", "db", "worker.cjs"));
    const app = path.join(scratch, "fake-app");
    await mkdir(path.join(app, "db-runtime", "lib", "db"), { recursive: true });
    await writeFile(path.join(app, "db-runtime", "lib", "db", "worker.cjs"), "");
    assert.equal(resolveDbWorkerPath(app), path.join(app, "db-runtime", "lib", "db", "worker.cjs"));
  } finally {
    if (previous === undefined) delete process.env.GROK_CANVAS_DB_WORKER; else process.env.GROK_CANVAS_DB_WORKER = previous;
    await loaded.dispose();
  }
});

test("包审计：发现 auth/.env/数据库/媒体文件与用户目录绝对路径", async () => {
  const pkg = path.join(scratch, "audit");
  const home = os.homedir();
  await mkdir(path.join(pkg, ".next", "static", "media"), { recursive: true });
  await mkdir(path.join(pkg, "node_modules", "x"), { recursive: true });
  await writeFile(path.join(pkg, "server.js"), `const root=${JSON.stringify(root)};`);
  await writeFile(path.join(pkg, ".next", "static", "media", "font.woff2"), "x");
  await writeFile(path.join(pkg, ".next", "static", "media", "logo.png"), "x");
  await writeFile(path.join(pkg, "node_modules", "x", "index.js"), "module.exports=1");
  const clean = await dbRuntime.auditPackage(pkg, { projectRoot: root });
  assert.deepEqual(clean.forbidden, [], JSON.stringify(clean.forbidden));
  assert.equal(clean.files.length, 4);

  await writeFile(path.join(pkg, ".env.local"), "XAI_API_KEY=1");
  await writeFile(path.join(pkg, "auth.json"), "{}");
  await writeFile(path.join(pkg, "canvas.sqlite"), "");
  await writeFile(path.join(pkg, "canvas.sqlite-wal"), "");
  await writeFile(path.join(pkg, "clip.mp4"), "");
  await writeFile(path.join(pkg, "leak.json"), JSON.stringify({ dir: path.join(home, ".grok-canvas", "data") }));
  await writeFile(path.join(pkg, ".modules.yaml"), `storeDir: ${path.join(home, "pnpm-store").split(path.sep).join("/")}\n`);
  const dirty = await dbRuntime.auditPackage(pkg, { projectRoot: root });
  const flagged = dirty.forbidden.map((f) => f.path).sort();
  assert.deepEqual(flagged, [".env.local", ".modules.yaml", "auth.json", "canvas.sqlite", "canvas.sqlite-wal", "clip.mp4", "leak.json"]);
});

test("包审计：包内链接允许，指向包外的链接报错", async () => {
  const pkg = path.join(scratch, "audit-links");
  const outside = path.join(scratch, "outside-target");
  await mkdir(path.join(pkg, "node_modules", ".pnpm", "real"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(pkg, "node_modules", ".pnpm", "real", "index.js"), "module.exports=1");
  const kind = process.platform === "win32" ? "junction" : "dir";
  await symlink(path.join(pkg, "node_modules", ".pnpm", "real"), path.join(pkg, "node_modules", "inside"), kind);
  const ok = await dbRuntime.auditPackage(pkg, { projectRoot: root });
  assert.deepEqual(ok.forbidden, []);
  assert.deepEqual(ok.links, ["node_modules/inside"]);
  await symlink(outside, path.join(pkg, "node_modules", "escape"), kind);
  const bad = await dbRuntime.auditPackage(pkg, { projectRoot: root });
  assert.deepEqual(bad.forbidden, [{ path: "node_modules/escape", reason: "链接指向包外" }]);
  // 包根本身经别名路径访问（Windows 8.3 短名 / 符号链接目录）时，包内链接仍算包内。
  const alias = path.join(scratch, "audit-alias");
  await symlink(pkg, alias, kind);
  const viaAlias = await dbRuntime.auditPackage(alias, { projectRoot: root });
  assert.deepEqual(viaAlias.forbidden, [{ path: "node_modules/escape", reason: "链接指向包外" }]);
});

test("desktop runtime：读取 desktop-runtime.json 的 distDir 与 worker，并注入服务环境", async () => {
  const resources = path.join(scratch, "resources");
  const app = path.join(resources, "app");
  await mkdir(app, { recursive: true });
  await writeFile(path.join(app, "desktop-runtime.json"), JSON.stringify({ schema: 1, distDir: ".tmp-workstation-check", buildId: "b1", dbWorker: "db-runtime/lib/db/worker.cjs", target: "win32-x64" }));
  const manifest = desktop.readDesktopManifest(app);
  assert.equal(manifest.distDir, ".tmp-workstation-check");
  const launch = desktop.serverLaunch({ packaged: true, resourcesPath: resources, appPath: "", manifest });
  assert.equal(launch.nodePath, path.join(app, ".tmp-workstation-check", "node_modules"));
  assert.equal(launch.dbWorker, path.join(app, "db-runtime", "lib", "db", "worker.cjs"));
  const env = desktop.serverEnvironment({ GROK_CANVAS_DB_WORKER: "stale" }, launch.nodePath, launch.dbWorker);
  assert.equal(env.GROK_CANVAS_DB_WORKER, launch.dbWorker);
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1");

  for (const bad of ["../x", "/abs", "C:\\abs", "a/../b", ""]) {
    await writeFile(path.join(app, "desktop-runtime.json"), JSON.stringify({ schema: 1, distDir: bad, buildId: "b1", dbWorker: "db-runtime/lib/db/worker.cjs" }));
    assert.throws(() => desktop.readDesktopManifest(app), /desktop-runtime\.json/, bad);
  }
  await writeFile(path.join(app, "desktop-runtime.json"), JSON.stringify({ schema: 1, distDir: ".next", buildId: "b1", dbWorker: "../../evil.cjs" }));
  assert.throws(() => desktop.readDesktopManifest(app), /desktop-runtime\.json/);
  await rm(path.join(app, "desktop-runtime.json"));
  assert.throws(() => desktop.readDesktopManifest(app), /desktop-runtime\.json/);
});

test("打包配置：禁用 electron-builder 自动 rebuild，依赖脚本保持关闭，build 会完成 standalone staging", async () => {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.build.npmRebuild, false);
  assert.match(pkg.scripts["desktop:deps"], /--ignore-scripts/);
  assert.match(pkg.scripts.build, /^next build && node scripts\/stage-standalone\.mjs$/);
  assert.match(pkg.scripts["test:db"], /tests\/db-packaging\.test\.mjs/);
  for (const [name, script] of Object.entries(pkg.scripts)) assert.doesNotMatch(script, /enable-pre-post-scripts|--config\.ignore-scripts=false|ignore-scripts=false/, name);
  for (const file of ["prepare-desktop.mjs", "finish-desktop.mjs", "start-production.mjs", "stage-standalone.mjs", "db-runtime-smoke.mjs"]) {
    const source = await readFile(path.join(root, "scripts", file), "utf8");
    assert.match(source, /build-root\.mjs/, `${file} 必须使用统一 buildRoot 解析器`);
    assert.doesNotMatch(source, /path\.join\(root, "\.next"/, `${file} 不能硬编码 .next`);
  }
  const config = await readFile(path.join(root, "next.config.ts"), "utf8");
  assert.match(config, /build-root\.mjs/);
});

test("CI：Windows 任务执行三端 smoke，Electron 缺失不能跳过", async () => {
  const ci = await readFile(path.join(root, ".github", "workflows", "workstation-ci.yml"), "utf8");
  for (const target of ["node", "standalone", "electron"]) assert.match(ci, new RegExp(`db-runtime-smoke\\.mjs --target=${target}`));
  assert.match(ci, /node_modules\/electron\/install\.js/);
  assert.match(ci, /\.tmp-db-smoke/);
  assert.doesNotMatch(ci, /continue-on-error/);
  const smoke = await readFile(path.join(root, "scripts", "db-runtime-smoke.mjs"), "utf8");
  assert.doesNotMatch(smoke, /require\(["']electron["']\)|import\(["']electron["']\)/, "不能借 require('electron') 自动下载二进制");
});
