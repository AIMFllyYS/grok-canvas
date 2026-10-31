"use strict";
/**
 * better-sqlite3 驱动封装（contracts.md C4）。可直接随包运行的 CommonJS，不经过 TypeScript。
 * 打开时设置 WAL / synchronous=FULL / foreign_keys=ON / busy_timeout，并回读实际值；
 * SQLite 版本低于 3.51.3 或配置不符时 health.ok=false，调用方不得据此降低可靠性配置。
 */
const Database = require("better-sqlite3");
const driverPackage = require("better-sqlite3/package.json");

const MIN_SQLITE_VERSION = "3.51.3";

function versionAtLeast(a, b) {
  const left = String(a).split(".").map(Number), right = String(b).split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const x = left[index] || 0, y = right[index] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

function runtimeLabel() {
  const v = process.versions;
  return `${process.platform}-${process.arch}，node ${v.node}，modules ${v.modules}，napi ${v.napi || "无"}${v.electron ? `，electron ${v.electron}` : ""}，execPath ${process.execPath}`;
}

let nativeChecked = false;
/** 第一次打开前先加载 native：失败时给出二进制路径与运行时 ABI，不回退到其他运行时或驱动。 */
function ensureNative() {
  if (nativeChecked) return;
  try {
    new Database(":memory:").close();
  } catch (error) {
    const reason = error && error.message ? error.message : String(error);
    throw Object.assign(new Error(`DB native 加载失败：${nativeBindingPath() || "未找到 better_sqlite3 native"}（${runtimeLabel()}）：${reason}`), { code: "storage_unavailable" });
  }
  nativeChecked = true;
}

function openDatabase(file, options) {
  const busyTimeoutMs = Number.isSafeInteger(options && options.busyTimeoutMs) ? options.busyTimeoutMs : 2000;
  ensureNative();
  const db = new Database(file, { timeout: busyTimeoutMs });
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  return db;
}

/** 与 better-sqlite3 lib/binding.js 相同的查找顺序：prebuilds 优先，其次 node-gyp 的 Debug / Release。 */
function nativeBindingPath() {
  try {
    const path = require("node:path");
    const fs = require("node:fs");
    const dir = path.dirname(require.resolve("better-sqlite3/package.json"));
    const musl = process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime;
    for (const candidate of [
      path.join(dir, "prebuilds", `${musl ? "linuxmusl" : process.platform}-${process.arch}.node`),
      path.join(dir, "build", "Debug", "better_sqlite3.node"),
      path.join(dir, "build", "Release", "better_sqlite3.node"),
    ]) if (fs.existsSync(candidate)) return candidate;
  } catch { /* ignore */ }
  return null;
}

function readHealth(db, file, expected) {
  const sqliteVersion = db.prepare("select sqlite_version() as v").get().v;
  const pragmas = {
    journal_mode: String(db.pragma("journal_mode", { simple: true })).toLowerCase(),
    synchronous: Number(db.pragma("synchronous", { simple: true })),
    foreign_keys: Number(db.pragma("foreign_keys", { simple: true })),
    busy_timeout: Number(db.pragma("busy_timeout", { simple: true })),
  };
  const sqliteVersionOk = versionAtLeast(sqliteVersion, MIN_SQLITE_VERSION);
  const configOk = pragmas.journal_mode === "wal" && pragmas.synchronous === 2 && pragmas.foreign_keys === 1 && pragmas.busy_timeout === expected.busyTimeoutMs;
  return {
    ok: sqliteVersionOk && configOk,
    driver: "better-sqlite3",
    driverVersion: driverPackage.version,
    sqliteVersion,
    sqliteVersionOk,
    pragmas,
    configOk,
    compileOptions: db.pragma("compile_options").map((row) => row.compile_options),
    runtime: {
      node: process.version,
      modules: process.versions.modules,
      napi: process.versions.napi || null,
      electron: process.versions.electron || null,
      platform: process.platform,
      arch: process.arch,
      execPath: process.execPath,
    },
    file,
    nativeBinding: nativeBindingPath(),
  };
}

module.exports = { openDatabase, readHealth, versionAtLeast, MIN_SQLITE_VERSION, driverVersion: driverPackage.version };
