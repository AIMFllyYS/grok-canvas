import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// P6-04：发布前的静态闸门。只读仓库文件，不启动服务、不碰数据目录。
const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

/** 从 pnpm test 出发，展开 `pnpm <script>` 链，收集所有被执行的测试文件。 */
function reachableTests() {
  const seen = new Set(), files = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const command = pkg.scripts[name];
    assert.ok(command, `脚本 ${name} 不存在`);
    for (const match of command.matchAll(/pnpm (?:run )?([\w:-]+)/g)) visit(match[1]);
    for (const match of command.matchAll(/tests\/[\w.-]+\.test\.mjs/g)) files.add(match[0]);
  };
  visit("test");
  return files;
}

test("每个 tests/*.test.mjs 都在 pnpm test 链里（新增测试不会被漏跑）", async () => {
  const all = (await readdir(path.join(root, "tests"))).filter(name => name.endsWith(".test.mjs")).map(name => `tests/${name}`);
  const reachable = reachableTests();
  const missing = all.filter(file => !reachable.has(file));
  assert.deepEqual(missing, [], `未进入全量测试：${missing.join(", ")}`);
});

test("原生依赖精确锁定版本（ABI 与预编译包一致）", () => {
  for (const name of ["better-sqlite3", "sharp"]) {
    const version = pkg.dependencies[name];
    assert.ok(version, `${name} 是直接依赖`);
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} 必须是精确版本，当前 ${version}`);
  }
});

test("打包的 DB 运行时包含 Worker 实际 require 的全部本地模块", async () => {
  const staging = await readFile(path.join(root, "scripts", "db-runtime.mjs"), "utf8");
  const listed = new Set([...staging.matchAll(/"([\w.-]+\.cjs)"/g)].map(match => match[1]));
  const required = new Set();
  const walk = async (file) => {
    const source = await readFile(path.join(root, "lib", "db", file), "utf8");
    for (const match of source.matchAll(/require\(["']\.\/([\w.-]+\.cjs)["']\)/g)) {
      if (required.has(match[1])) continue;
      required.add(match[1]);
      await walk(match[1]);
    }
  };
  await walk("worker.cjs");
  const missing = [...required].filter(file => !listed.has(file) && !file.startsWith("repositories"));
  assert.deepEqual(missing, [], `打包列表缺少：${missing.join(", ")}`);
  assert.match(staging, /repositories/, "repositories 目录随运行时打包");
  assert.match(staging, /migrations/, "迁移 SQL 随运行时打包");
});

test("证据与报告里没有本机私人路径或疑似密钥", async () => {
  const dir = path.join(root, "docs", "workstation-plan", "evidence");
  const files = (await readdir(dir, { recursive: true })).filter(name => /\.(json|md)$/.test(String(name)));
  for (const name of files) {
    const text = await readFile(path.join(dir, String(name)), "utf8");
    assert.doesNotMatch(text, /[A-Za-z]:\\\\?Users\\\\?[^\\\s"]+/, `${name} 含本机用户目录`);
    assert.doesNotMatch(text, /\b(sk|xai)-[A-Za-z0-9]{20,}\b/, `${name} 含疑似密钥`);
  }
});

test("可靠性测试进入全量 CI", () => {
  const reachable = reachableTests();
  for (const file of ["tests/workstation-faults.test.mjs", "tests/performance-soak.test.mjs", "tests/workstation-release.test.mjs"]) assert.ok(reachable.has(file), file);
});
