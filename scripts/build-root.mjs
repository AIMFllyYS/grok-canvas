/**
 * 唯一的构建目录（distDir）解析器（contracts.md C4）。
 * next.config、start、stage-standalone、desktop prepare/finish、smoke 都只通过这里取构建根目录，
 * 不再各自硬编码 `.next`。没有顶层 await，next.config.ts 可以同步 require。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ENV = "GROK_CANVAS_BUILD_DIR";
// 源码、依赖、静态资源、Electron 资源与产物目录：distDir 落在这里会被 cleanDistDir 清空或混入包。
const PROTECTED = new Set([
  "node_modules", "public", "app", "lib", "components", "hooks", "scripts", "tests", "docs", "desktop",
  "build", ".desktop", "release", ".git", ".github", "data", "artifacts", ".agents",
]);

function reject(value, reason) {
  return new Error(`${ENV}=${JSON.stringify(value)} 无效：${reason}。只接受项目内的相对目录，例如 .tmp-workstation-check`);
}

/**
 * @param {string | undefined} value 环境变量原值
 * @param {string} projectRoot 项目根目录
 * @returns {{ name: string, absolute: string }}
 */
export function resolveBuildDir(value, projectRoot) {
  if (value === undefined || value === "") return { name: ".next", absolute: path.join(projectRoot, ".next") };
  if (typeof value !== "string") throw reject(value, "不是字符串");
  if (value.includes(":")) throw reject(value, "不能包含盘符或冒号");
  let text = value.replace(/\\/g, "/");
  if (text.startsWith("/")) throw reject(value, "不能是绝对路径或 UNC 路径");
  while (text.startsWith("./")) text = text.slice(2);
  if (text === "" || text === ".") throw reject(value, "不能是项目根目录");
  const segments = text.split("/");
  for (const segment of segments) {
    if (segment === "") throw reject(value, "不能包含空路径段");
    if (segment === "." || segment === "..") throw reject(value, "不能包含 . 或 .. 路径段");
  }
  if (PROTECTED.has(segments[0].toLowerCase())) throw reject(value, `${segments[0]} 是受保护目录`);
  const absolute = path.join(projectRoot, ...segments);
  const relative = path.relative(projectRoot, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw reject(value, "越出项目目录");
  return { name: segments.join("/"), absolute };
}

/** 从环境变量解析当前构建目录。 */
export function currentBuildDir(projectRoot, env = process.env) {
  return resolveBuildDir(env[ENV], projectRoot);
}

/**
 * Next/Turbopack 用 picomatch `contains: true` 匹配追踪文件路径，模式会在路径的任意位置按子串命中，
 * 不只是项目根下：`./build/**` 会命中 `.tmp-db-smoke-build/server/chunks/…` 和 `next/dist/build/…`，
 * `./components/**` 会命中 `next/dist/client/components/…`，`./.tmp-*` 会命中 `.tmp-*` 隔离构建自己的 chunk
 * （standalone 运行时 500）。所以这里只用「文件类型」或「确切文件」模式，不用裸目录名通配。
 */
const STATIC_EXCLUDES = [
  "./artifacts/**/*", "./release/**/*", "./.desktop/**/*", "./.agents/**/*", "./.git/**/*",
  "./app/**/*.ts", "./app/**/*.tsx", "./components/**/*.ts", "./components/**/*.tsx", "./lib/**/*.ts",
  "./tests/**/*.mjs", "./scripts/**/*.mjs", "./scripts/**/*.cjs", "./docs/**/*.md", "./docs/**/*.json", "./build/icon.png",
  // 服务端只经 DB Worker 使用 better-sqlite3；Worker、驱动与 native 由 db-runtime 白名单拷贝，不走文件追踪。
  "./lib/db/*.cjs", "./lib/db/migrations/**/*", "./node_modules/better-sqlite3/**/*", "./node_modules/.pnpm/better-sqlite3@*/**/*",
];

/**
 * next.config 的 outputFileTracingExcludes 列表（匹配语义见 STATIC_EXCLUDES 注释）。
 * 其他构建目录按名字列出，从不排除当前 distDir。
 * @param {string} distDir resolveBuildDir 返回的 name
 * @param {string} projectRoot
 * @param {string[]} [entries] 项目根目录下的条目名（测试注入；默认读取磁盘）
 */
export function traceExcludes(distDir, projectRoot, entries) {
  const top = distDir.split("/")[0];
  const names = entries ?? readdirSync(projectRoot);
  const otherBuilds = [];
  if (top.startsWith(".tmp-")) {
    for (const name of names) if (name.startsWith(".tmp-") && name !== top) otherBuilds.push(`./${name}/**/*`);
  } else {
    otherBuilds.push("./.tmp-*/**/*");
  }
  if (top !== ".next") otherBuilds.push("./.next/**/*");
  for (const name of names) if (name.startsWith(".next.") && name !== top) otherBuilds.push(`./${name}/**/*`);
  return [...STATIC_EXCLUDES, ...otherBuilds];
}

function readBuildId(file, label) {
  if (!existsSync(file)) throw new Error(`${label} 缺少 BUILD_ID：${file}`);
  return readFileSync(file, "utf8").trim();
}

/**
 * 校验 standalone 产物确实来自当前 distDir 的同一次构建，拒绝旧目录或混拼产物。
 * @param {{ name: string, absolute: string }} buildDir
 */
export function checkStandalone(buildDir) {
  const standalone = path.join(buildDir.absolute, "standalone");
  const server = path.join(standalone, "server.js");
  if (!existsSync(server)) throw new Error(`缺少 standalone/server.js：${server}。请先运行 pnpm build`);
  const match = /"distDir":"([^"]*)"/.exec(readFileSync(server, "utf8"));
  const embedded = match ? match[1].replace(/\\/g, "/").replace(/^(\.\/)+/, "") : null;
  if (embedded !== buildDir.name) {
    throw new Error(`standalone/server.js 中的 distDir（${embedded ?? "未找到"}）与当前构建目录 ${buildDir.name} 不一致，拒绝使用旧产物`);
  }
  const buildId = readBuildId(path.join(buildDir.absolute, "BUILD_ID"), "构建目录");
  const standaloneId = readBuildId(path.join(standalone, ...buildDir.name.split("/"), "BUILD_ID"), "standalone");
  if (buildId !== standaloneId) throw new Error(`standalone BUILD_ID（${standaloneId}）与构建目录 BUILD_ID（${buildId}）不一致`);
  return { distDir: buildDir.name, buildId, standalone, server, staticDir: path.join(buildDir.absolute, "static") };
}
