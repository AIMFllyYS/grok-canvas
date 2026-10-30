/**
 * DB 运行资源（contracts.md C4）：Worker 入口、驱动封装、迁移 SQL 与 better-sqlite3 的一个目标平台 native。
 * 只按白名单拷贝，写入带 sha256 的 manifest.json；Node standalone 与 Electron 各自 staging，互不覆盖。
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const DRIVER = "better-sqlite3";
const WORKER = "lib/db/worker.cjs";

function isLinuxMusl() {
  return process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime;
}

/** 与 better-sqlite3 lib/binding.js 的 prebuild 选择规则一致。 */
export function nativeTarget(platform = process.platform, arch = process.arch) {
  const base = platform === "linux" && platform === process.platform && isLinuxMusl() ? "linuxmusl" : platform;
  return `${base}-${arch}`;
}

const toPosix = (value) => value.split(path.sep).join("/");

/** links 传数组时只记录符号链接/junction（不跟随，目标本身也在包内被遍历）；不传则视为错误。 */
async function walk(dir, base = dir, links = null) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full, base, links));
    else if (entry.isFile()) out.push(toPosix(path.relative(base, full)));
    else if (links && entry.isSymbolicLink()) links.push(toPosix(path.relative(base, full)));
    else throw new Error(`运行包里不允许符号链接或特殊文件：${full}`);
  }
  return out.sort();
}

const sha256 = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");

function driverDirectory(projectRoot) {
  const require = createRequire(path.join(projectRoot, "package.json"));
  return path.dirname(require.resolve(`${DRIVER}/package.json`));
}

/**
 * @param {{ projectRoot: string, destination: string, target?: string }} options
 */
export async function stageDbRuntime({ projectRoot, destination, target = nativeTarget() }) {
  if (!/^[a-z][a-z0-9]*-[a-z0-9]+$/.test(target)) throw new Error(`无效的 native 目标：${target}`);
  const driverDir = driverDirectory(projectRoot);
  const driverPackage = JSON.parse(await readFile(path.join(driverDir, "package.json"), "utf8"));
  const native = path.join(driverDir, "prebuilds", `${target}.node`);
  if (!existsSync(native)) throw new Error(`${DRIVER}@${driverPackage.version} 没有 ${target} 的预编译二进制：${native}`);

  await rm(destination, { recursive: true, force: true });
  const dbDir = path.join(destination, "lib", "db");
  await mkdir(dbDir, { recursive: true });
  for (const file of ["worker.cjs", "driver.cjs", "migrate.cjs", "backup.cjs", "restore.cjs"]) await cp(path.join(projectRoot, "lib", "db", file), path.join(dbDir, file));
  const repositories = path.join(projectRoot, "lib", "db", "repositories");
  if (existsSync(repositories)) {
    await cp(repositories, path.join(dbDir, "repositories"), { recursive: true, filter: (source) => !path.extname(source) || path.extname(source) === ".cjs" });
  }
  const migrations = path.join(projectRoot, "lib", "db", "migrations");
  if (existsSync(migrations)) {
    await cp(migrations, path.join(dbDir, "migrations"), { recursive: true, filter: (source) => !path.extname(source) || path.extname(source) === ".sql" });
  }

  const driverOut = path.join(destination, "node_modules", DRIVER);
  await mkdir(path.join(driverOut, "prebuilds"), { recursive: true });
  await cp(path.join(driverDir, "package.json"), path.join(driverOut, "package.json"));
  if (existsSync(path.join(driverDir, "LICENSE"))) await cp(path.join(driverDir, "LICENSE"), path.join(driverOut, "LICENSE"));
  await cp(path.join(driverDir, "lib"), path.join(driverOut, "lib"), { recursive: true, filter: (source) => !path.extname(source) || path.extname(source) === ".js" });
  await cp(native, path.join(driverOut, "prebuilds", `${target}.node`));

  const files = [];
  for (const file of await walk(destination)) {
    const full = path.join(destination, file);
    files.push({ path: file, bytes: (await stat(full)).size, sha256: await sha256(full) });
  }
  const manifest = {
    schema: 1,
    driver: DRIVER,
    driverVersion: driverPackage.version,
    target,
    worker: WORKER,
    native: `node_modules/${DRIVER}/prebuilds/${target}.node`,
    files,
  };
  await writeFile(path.join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** 复核 staging：文件集合与哈希都必须与 manifest 一致，多一个少一个都拒绝。 */
export async function verifyDbRuntime(destination) {
  const manifestFile = path.join(destination, "manifest.json");
  if (!existsSync(manifestFile)) throw new Error(`缺少 DB 运行资源清单：${manifestFile}`);
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const actual = (await walk(destination)).filter((file) => file !== "manifest.json");
  const listed = manifest.files.map((file) => file.path).sort();
  const extra = actual.filter((file) => !listed.includes(file));
  const missing = listed.filter((file) => !actual.includes(file));
  if (extra.length || missing.length) throw new Error(`DB 运行资源与清单不一致：多出 ${extra.join(", ") || "无"}；缺少 ${missing.join(", ") || "无"}`);
  for (const entry of manifest.files) {
    if (await sha256(path.join(destination, entry.path)) !== entry.sha256) throw new Error(`DB 运行资源哈希不符：${entry.path}`);
  }
  for (const key of ["worker", "native"]) if (!listed.includes(manifest[key])) throw new Error(`清单缺少 ${key}：${manifest[key]}`);
  return manifest;
}

const SECRET = [/^\.env(\..+)?$/i, /^auth(\..+)?\.json$/i, /\.(pem|key)$/i];
const DATABASE = /\.(sqlite3?|db)(-wal|-shm|-journal)?$/i;
const MEDIA = /\.(mp4|mov|webm|mkv|avi|m4a|mp3|wav|png|jpe?g|gif|webp|avif)$/i;
const TEXT = /\.(c?js|mjs|json|ya?ml|txt|html?|css|md|map)$|^\.[\w.-]+$/i;
const TEXT_LIMIT = 16 * 1024 * 1024;

function pathVariants(value) {
  const forward = value.replace(/\\/g, "/");
  const back = value.replace(/\//g, "\\");
  return [...new Set([value, forward, back, back.replace(/\\/g, "\\\\"), forward.replace(/\//g, "\\/")])].filter((v) => v.length > 3);
}

/**
 * 运行包审计：凭据、数据库、用户媒体，以及包含用户目录绝对路径的文本文件。
 * 构建机的项目路径会被 Next 固化在 server.js / required-server-files.json 里（outputFileTracingRoot），
 * 先剔除它再查用户目录，避免 CI（项目在 home 下）误报；它不是用户数据路径。
 * @param {string} dir
 * @param {{ projectRoot: string, home?: string }} options
 */
export async function auditPackage(dir, { projectRoot, home = os.homedir() }) {
  const links = [];
  const files = await walk(dir, dir, links);
  const forbidden = [];
  // 包根也要 realpath：Windows 上 tmpdir 可能是 8.3 短名（RUNNER~1），而 realpath 返回长名。
  const packageRoot = await realpath(path.resolve(dir));
  for (const link of links) {
    // 链接只能指向包内；指向仓库或用户目录意味着包离开构建机就会坏，或把外部内容带进来。
    const resolved = await realpath(path.join(dir, link)).catch(() => null);
    const relative = resolved ? path.relative(packageRoot, resolved) : "..";
    if (relative.startsWith("..") || path.isAbsolute(relative)) forbidden.push({ path: link, reason: "链接指向包外" });
  }
  const fold = process.platform === "win32" ? (value) => value.toLowerCase() : (value) => value;
  const project = pathVariants(path.resolve(projectRoot).replace(/[\\/]+$/, "")).map(fold);
  const homes = pathVariants(path.resolve(home).replace(/[\\/]+$/, "")).map(fold);
  for (const file of files) {
    const name = path.posix.basename(file);
    const segments = file.split("/");
    if (SECRET.some((rule) => rule.test(name))) { forbidden.push({ path: file, reason: "凭据文件" }); continue; }
    if (DATABASE.test(name)) { forbidden.push({ path: file, reason: "数据库文件" }); continue; }
    if (MEDIA.test(name) && !segments.includes("node_modules") && !segments.includes("static") && segments[0] !== "public") {
      forbidden.push({ path: file, reason: "媒体文件" });
      continue;
    }
    if (!TEXT.test(name)) continue;
    const full = path.join(dir, file);
    if ((await stat(full)).size > TEXT_LIMIT) continue;
    let text = fold(await readFile(full, "utf8"));
    for (const variant of project) text = text.split(variant).join("<project>");
    if (homes.some((variant) => text.includes(variant))) forbidden.push({ path: file, reason: "包含用户目录绝对路径" });
  }
  return { files, links, forbidden };
}
