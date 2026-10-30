/**
 * 媒体派生运行资源（P4-02，contracts.md C7）：derivative-worker.cjs + sharp@0.35.4 与一个目标平台的 native
 * （@img/sharp-<target>，Linux 另含同目录相对引用的 @img/sharp-libvips-<target>）。
 * 与 db-runtime 相同：只按白名单复制真实文件（不跟随 pnpm 链接），写带 sha256 的 manifest.json；
 * standalone 与 Electron 各自 staging。sharp 走 N-API，同一 native 可在 Node 与 Electron 中加载。
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { nativeTarget } from "./db-runtime.mjs";

const WORKER = "lib/media/derivative-worker.cjs";
const toPosix = (value) => value.split(path.sep).join("/");
const sha256 = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full, base));
    else if (entry.isFile()) out.push(toPosix(path.relative(base, full)));
    else throw new Error(`媒体运行包里不允许符号链接或特殊文件：${full}`);
  }
  return out.sort();
}

/** 从 from 目录解析 name 包的真实目录（package.json 不在 exports 里时退回逐级查找 node_modules）。 */
function packageDir(fromDir, name) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", ...name.split("/"));
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`找不到依赖 ${name}（从 ${fromDir} 开始）`);
    dir = parent;
  }
}

const SKIP = new Set(["README.md", "CHANGELOG.md", "install", "src", "docs"]);
async function copyPackage(source, destination, { keepSrc = false } = {}) {
  await mkdir(destination, { recursive: true });
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: (item) => {
      const rel = path.relative(source, item);
      if (!rel) return true;
      const top = rel.split(path.sep)[0];
      if (top === "node_modules") return false;
      if (!keepSrc && SKIP.has(top)) return false;
      return !/\.(d\.[cm]?ts|map|mjs)$/.test(item) || item.endsWith("package.json");
    },
  });
}

/** @param {{ projectRoot: string, destination: string, target?: string }} options */
export async function stageMediaRuntime({ projectRoot, destination, target = nativeTarget() }) {
  if (!/^[a-z][a-z0-9]*-[a-z0-9]+$/.test(target)) throw new Error(`无效的 native 目标：${target}`);
  const require = createRequire(path.join(projectRoot, "package.json"));
  const sharpDir = path.dirname(path.dirname(require.resolve("sharp")));
  const sharpPackage = JSON.parse(await readFile(path.join(sharpDir, "package.json"), "utf8"));
  const nativeName = `@img/sharp-${target}`;
  const libvipsName = `@img/sharp-libvips-${target}`;
  if (!sharpPackage.optionalDependencies?.[nativeName]) throw new Error(`sharp@${sharpPackage.version} 不支持目标 ${target}`);
  const nativeDir = packageDir(sharpDir, nativeName);
  const nativePackage = JSON.parse(await readFile(path.join(nativeDir, "package.json"), "utf8"));
  if (nativePackage.version !== sharpPackage.version) throw new Error(`${nativeName}@${nativePackage.version} 与 sharp@${sharpPackage.version} 版本不一致`);

  await rm(destination, { recursive: true, force: true });
  await mkdir(path.join(destination, "lib", "media"), { recursive: true });
  await cp(path.join(projectRoot, WORKER), path.join(destination, WORKER));
  const modules = path.join(destination, "node_modules");
  await copyPackage(sharpDir, path.join(modules, "sharp"));
  for (const dependency of Object.keys(sharpPackage.dependencies ?? {})) await copyPackage(packageDir(sharpDir, dependency), path.join(modules, ...dependency.split("/")));
  await copyPackage(nativeDir, path.join(modules, ...nativeName.split("/")));
  if (sharpPackage.optionalDependencies?.[libvipsName]) await copyPackage(packageDir(sharpDir, libvipsName), path.join(modules, ...libvipsName.split("/")));

  const files = [];
  for (const file of await walk(destination)) {
    const full = path.join(destination, file);
    files.push({ path: file, bytes: (await stat(full)).size, sha256: await sha256(full) });
  }
  const native = files.find(f => f.path.startsWith(`node_modules/${nativeName}/`) && f.path.endsWith(".node"));
  if (!native) throw new Error(`${nativeName} 中没有 .node 文件`);
  const manifest = { schema: 1, library: "sharp", version: sharpPackage.version, target, worker: WORKER, native: native.path, files };
  await writeFile(path.join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** 复核：文件集合与哈希都必须与 manifest 一致。 */
export async function verifyMediaRuntime(destination) {
  const manifestFile = path.join(destination, "manifest.json");
  if (!existsSync(manifestFile)) throw new Error(`缺少媒体运行资源清单：${manifestFile}`);
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const actual = (await walk(destination)).filter((file) => file !== "manifest.json");
  const listed = manifest.files.map((file) => file.path).sort();
  const extra = actual.filter((file) => !listed.includes(file));
  const missing = listed.filter((file) => !actual.includes(file));
  if (extra.length || missing.length) throw new Error(`媒体运行资源与清单不一致：多出 ${extra.join(", ") || "无"}；缺少 ${missing.join(", ") || "无"}`);
  for (const entry of manifest.files) if (await sha256(path.join(destination, entry.path)) !== entry.sha256) throw new Error(`媒体运行资源哈希不符：${entry.path}`);
  for (const key of ["worker", "native"]) if (!listed.includes(manifest[key])) throw new Error(`清单缺少 ${key}：${manifest[key]}`);
  return manifest;
}
