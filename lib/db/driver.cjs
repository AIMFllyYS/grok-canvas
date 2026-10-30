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

function openDatabase(file, options) {
  const busyTimeoutMs = Number.isSafeInteger(options && options.busyTimeoutMs) ? options.busyTimeoutMs : 2000;
  const db = new Database(file, { timeout: busyTimeoutMs });
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  return db;
}

function nativeBindingPath() {
  try {
    const dir = require("node:path").dirname(require.resolve("better-sqlite3/package.json"));
    const fs = require("node:fs");
    for (const candidate of [
      require("node:path").join(dir, "build", "Release", "better_sqlite3.node"),
      require("node:path").join(dir, "prebuilds", `${process.platform}-${process.arch}.node`),
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
