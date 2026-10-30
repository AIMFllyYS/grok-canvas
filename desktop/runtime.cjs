const fs = require("node:fs");
const path = require("node:path");

const LOCAL_ORIGIN = "http://127.0.0.1:3210";
const DESKTOP_MANIFEST = "desktop-runtime.json";
const DEFAULT_DB_WORKER = "db-runtime/lib/db/worker.cjs";

/** 包内相对路径：不允许绝对路径、盘符、空段、. 或 ..。 */
function safeRelative(value) {
  if (typeof value !== "string" || value === "" || value.includes(":") || /^[\\/]/.test(value)) return null;
  const segments = value.replace(/\\/g, "/").split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  return segments.join("/");
}

/** 读取 prepare-desktop 写入的 desktop-runtime.json；缺失或字段非法都拒绝启动。 */
function readDesktopManifest(appDir) {
  const file = path.join(appDir, DESKTOP_MANIFEST);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`无法读取 ${DESKTOP_MANIFEST}：${file}（${error instanceof Error ? error.message : String(error)}）`);
  }
  const distDir = manifest && safeRelative(manifest.distDir);
  const dbWorker = manifest && safeRelative(manifest.dbWorker);
  if (!manifest || manifest.schema !== 1 || !distDir || !dbWorker || typeof manifest.buildId !== "string" || !manifest.buildId) {
    throw new Error(`${DESKTOP_MANIFEST} 无效：${file}`);
  }
  return { ...manifest, distDir, dbWorker };
}

function serverLaunch({ packaged, resourcesPath, appPath, manifest }) {
  if (packaged) {
    const cwd = path.join(resourcesPath, "app");
    const distDir = manifest ? manifest.distDir : ".next";
    return {
      cwd,
      entry: path.join(cwd, "server.js"),
      nodePath: path.join(cwd, ...distDir.split("/"), "node_modules"),
      dbWorker: path.join(cwd, ...(manifest ? manifest.dbWorker : DEFAULT_DB_WORKER).split("/")),
    };
  }
  return {
    cwd: appPath,
    entry: path.join(appPath, ".next", "standalone", "server.js"),
  };
}

function serverEnvironment(baseEnv, nodePath, dbWorker) {
  return {
    ...baseEnv,
    ...(nodePath ? { NODE_PATH: nodePath } : {}),
    ...(dbWorker ? { GROK_CANVAS_DB_WORKER: dbWorker } : {}),
    PORT: "3210",
    HOSTNAME: "127.0.0.1",
    NEXT_TELEMETRY_DISABLED: "1",
    GROK_CANVAS_DESKTOP: "1",
    ELECTRON_RUN_AS_NODE: "1",
  };
}

function externalHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url.toString();
}

function isAppUrl(value, origin = LOCAL_ORIGIN) {
  try {
    return new URL(value).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

module.exports = {
  LOCAL_ORIGIN,
  DESKTOP_MANIFEST,
  readDesktopManifest,
  serverLaunch,
  serverEnvironment,
  externalHttpUrl,
  isAppUrl,
};
