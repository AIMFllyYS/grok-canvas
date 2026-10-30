import { access, rename, rm, readFile, readdir, cp, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentBuildDir } from "./build-root.mjs";
import { auditPackage, verifyDbRuntime } from "./db-runtime.mjs";

const require = createRequire(import.meta.url);
const { readDesktopManifest } = require("../desktop/runtime.cjs");

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = path.join(root, ".desktop", "app");
const manifest = readDesktopManifest(destination);
// finish 只处理 prepare 刚生成的 staging：distDir 与 BUILD_ID 都必须与本次构建一致。
const buildDir = currentBuildDir(root);
if (manifest.distDir !== buildDir.name) throw new Error(`desktop staging 的 distDir（${manifest.distDir}）与当前构建目录 ${buildDir.name} 不一致，请重新运行 desktop:prepare`);
const distOut = path.join(destination, ...manifest.distDir.split("/"));
const stagedId = (await readFile(path.join(distOut, "BUILD_ID"), "utf8")).trim();
if (stagedId !== manifest.buildId) throw new Error(`desktop staging BUILD_ID（${stagedId}）与 desktop-runtime.json（${manifest.buildId}）不一致`);
await verifyDbRuntime(path.join(destination, "db-runtime"));

const modules = path.join(destination, "node_modules");
const runtimeModules = path.join(distOut, "node_modules");
await access(path.join(modules, "next", "package.json"));
await access(path.join(modules, "@swc", "helpers", "package.json"));
await rm(runtimeModules, { recursive: true, force: true });
await rename(modules, runtimeModules);

// pnpm 的安装元数据记录 store 绝对路径（用户目录），运行时用不到。
for (const entry of await readdir(runtimeModules)) {
  if (entry === ".bin" || entry === ".modules.yaml" || entry.startsWith(".pnpm-workspace-state") || entry === ".package-lock.json") {
    await rm(path.join(runtimeModules, entry), { recursive: true, force: true });
  }
}
// 服务端只通过 DB Worker 使用 better-sqlite3；包内唯一一份在 db-runtime/，
// 删掉生产依赖安装带进来的副本（含全部平台 prebuild 与 SQLite 源码）以及仅编译期使用的 node-addon-api。
for (const duplicate of ["better-sqlite3", "node-addon-api"]) {
  await rm(path.join(runtimeModules, duplicate), { recursive: true, force: true });
}

const aliases = JSON.parse(await readFile(path.join(distOut, "desktop-externals.json"), "utf8"));
for (const { alias, packageName } of aliases) {
  if (alias !== packageName) await cp(path.join(runtimeModules, packageName), path.join(runtimeModules, alias), { recursive: true, dereference: true });
}

const audit = await auditPackage(destination, { projectRoot: root });
const natives = audit.files.filter((file) => file.endsWith(".node"));
let bytes = 0;
for (const file of audit.files) bytes += (await stat(path.join(destination, file))).size;
await writeFile(path.join(root, ".desktop", "app-files.json"), `${JSON.stringify({
  distDir: manifest.distDir,
  buildId: manifest.buildId,
  target: manifest.target,
  fileCount: audit.files.length,
  bytes,
  natives,
  forbidden: audit.forbidden,
  files: audit.files,
}, null, 2)}\n`);
if (audit.forbidden.length) {
  throw new Error(`桌面包审计失败：\n${audit.forbidden.map((item) => `- ${item.path}：${item.reason}`).join("\n")}`);
}

console.log(`Prepared desktop dependencies at ${runtimeModules}; ${audit.files.length} files, natives: ${natives.join(", ")}`);
