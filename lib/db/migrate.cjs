"use strict";
/**
 * Schema 迁移（contracts.md C5）：lib/db/migrations/NNN-name.sql 按编号顺序执行，每个文件一个事务。
 * schema_migrations 保存 version + sha256 checksum：
 * - 已应用文件内容变化 → schema_checksum，拒绝继续（升级只能新增文件）；
 * - 库里有代码不认识的版本 → schema_future，拒绝启动；
 * - 文件执行失败整个事务回滚，不留半张表，也不写迁移记录。
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_DIR = path.join(__dirname, "migrations");
const NAME = /^(\d{3})-[a-z0-9-]+\.sql$/;

function fail(code, message) { return Object.assign(new Error(message), { code }); }

function loadMigrations(dir = DEFAULT_DIR) {
  const files = fs.readdirSync(dir).filter(name => NAME.test(name)).sort();
  const seen = new Set();
  return files.map(name => {
    const version = Number(NAME.exec(name)[1]);
    if (seen.has(version)) throw fail("schema_invalid", `迁移版本重复：${version}`);
    seen.add(version);
    const sql = fs.readFileSync(path.join(dir, name), "utf8").replace(/\r\n/g, "\n");
    return { version, name, sql, checksum: crypto.createHash("sha256").update(sql).digest("hex") };
  });
}

function migrate(db, options = {}) {
  const migrations = loadMigrations(options.dir);
  db.exec("create table if not exists schema_migrations (version integer primary key, name text not null, checksum text not null, applied_at text not null) strict");
  const byVersion = new Map(migrations.map(m => [m.version, m]));
  const applied = db.prepare("select version, name, checksum from schema_migrations order by version").all();
  for (const row of applied) {
    const known = byVersion.get(row.version);
    if (!known) throw fail("schema_future", `数据库包含未知的 schema 版本 ${row.version}（${row.name}），请使用更新的程序`);
    if (known.checksum !== row.checksum) throw fail("schema_checksum", `已应用的迁移 ${row.name} 内容已变化，拒绝继续；升级必须新增迁移文件`);
  }
  const done = new Set(applied.map(row => row.version));
  const record = db.prepare("insert into schema_migrations (version, name, checksum, applied_at) values (?, ?, ?, ?)");
  const ran = [];
  for (const migration of migrations) {
    if (done.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, migration.checksum, new Date().toISOString());
    })();
    ran.push(migration.version);
  }
  const current = migrations.length ? migrations[migrations.length - 1].version : 0;
  return { applied: ran, current };
}

module.exports = { migrate, loadMigrations, MIGRATIONS_DIR: DEFAULT_DIR };
