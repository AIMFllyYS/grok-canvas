import { cp, mkdir, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkStandalone, currentBuildDir } from "./build-root.mjs";
import { stageDbRuntime } from "./db-runtime.mjs";
import { stageMediaRuntime } from "./media-runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
// 只接受与当前 GROK_CANVAS_BUILD_DIR 一致、BUILD_ID 对得上的 standalone，拒绝旧产物或混拼目录。
const build = checkStandalone(currentBuildDir(root));
const distSegments = build.distDir.split("/");
const desktopRoot = path.join(root, ".desktop");
const destination = path.join(desktopRoot, "app");
// 桌面安装包只发 Windows x64（electron-builder --win nsis x64）。
const target = process.env.GROK_CANVAS_DESKTOP_TARGET || "win32-x64";

await rm(desktopRoot, { recursive: true, force: true });
await mkdir(destination, { recursive: true });

// Copy an explicit runtime allowlist. Dynamic filesystem tracing can include
// local QA media or old release folders; those must never enter a desktop package.
// pnpm junctions are replaced by a flat production dependency tree next.
await cp(build.server, path.join(destination, "server.js"));
const distOut = path.join(destination, ...distSegments);
await cp(path.join(build.standalone, ...distSegments), distOut, { recursive: true, filter: source => path.basename(source) !== "node_modules" });
// Turbopack gives some ESM externals hashed package aliases. Record the aliases
// now, then materialize them beside flat dependencies without Windows symlinks.
const aliasRoot = path.join(build.standalone, ...distSegments, "node_modules");
const aliases = [];
for (const alias of await readdir(aliasRoot).catch(() => [])) {
  const manifest = JSON.parse(await readFile(path.join(aliasRoot, alias, "package.json"), "utf8"));
  if (!/^[\w.-]+$/.test(alias) || !/^(?:@[\w.-]+\/)?[\w.-]+$/.test(manifest.name)) throw new Error("Invalid external alias");
  aliases.push({ alias, packageName: manifest.name });
}
await writeFile(path.join(distOut, "desktop-externals.json"), JSON.stringify(aliases));
await cp(path.join(root, "package.json"), path.join(destination, "package.json"));
await cp(path.join(root, "pnpm-lock.yaml"), path.join(destination, "pnpm-lock.yaml"));
await rm(path.join(distOut, "static"), { recursive: true, force: true });
await cp(build.staticDir, path.join(distOut, "static"), { recursive: true });
if (existsSync(path.join(root, "public"))) await cp(path.join(root, "public"), path.join(destination, "public"), { recursive: true });

// Electron 的 DB 运行资源单独 staging，不复用 standalone 里给系统 Node 准备的那份。
const db = await stageDbRuntime({ projectRoot: root, destination: path.join(destination, "db-runtime"), target });
// 媒体派生 Worker 与 sharp native（P4-02）：服务端 cwd 为包根，derivatives.ts 默认从 media-runtime/ 加载。
const media = await stageMediaRuntime({ projectRoot: root, destination: path.join(destination, "media-runtime"), target });
await writeFile(path.join(destination, "desktop-runtime.json"), `${JSON.stringify({
  schema: 1,
  distDir: build.distDir,
  buildId: build.buildId,
  dbWorker: `db-runtime/${db.worker}`,
  target: db.target,
  driverVersion: db.driverVersion,
  mediaWorker: `media-runtime/${media.worker}`,
  sharpVersion: media.version,
}, null, 2)}\n`);

console.log(`Prepared desktop server at ${destination} (distDir ${build.distDir}, BUILD_ID ${build.buildId}, db-runtime ${db.target})`);
