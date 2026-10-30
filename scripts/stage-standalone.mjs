/**
 * `pnpm build` 的第二步：把 standalone 补齐成可直接启动的 Node 产物（P3-02）。
 * public、<distDir>/static 与 DB 运行资源（db-runtime/）只拷进本次构建自己的 standalone，
 * 不碰仓库根目录，也不复用旧构建。
 */
import { cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkStandalone, currentBuildDir } from "./build-root.mjs";
import { stageDbRuntime } from "./db-runtime.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = currentBuildDir(root);
const build = checkStandalone(buildDir);

// Next 的 standalone 默认不含 public 与 static。
const publicOut = path.join(build.standalone, "public");
const staticOut = path.join(build.standalone, ...build.distDir.split("/"), "static");
await rm(publicOut, { recursive: true, force: true });
await rm(staticOut, { recursive: true, force: true });
if (existsSync(path.join(root, "public"))) await cp(path.join(root, "public"), publicOut, { recursive: true });
await cp(build.staticDir, staticOut, { recursive: true });

const manifest = await stageDbRuntime({ projectRoot: root, destination: path.join(build.standalone, "db-runtime") });
console.log(`Staged standalone ${build.distDir} (BUILD_ID ${build.buildId}); db-runtime ${manifest.driver}@${manifest.driverVersion} ${manifest.target}, ${manifest.files.length} files`);
