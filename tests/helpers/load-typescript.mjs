import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

// 与现有测试保持相同的临时转译方式，递归处理纯逻辑模块的相对依赖。
export async function loadTypescript(entry, { packages = false } = {}) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const directory = await mkdtemp(path.join(os.tmpdir(), "grok-workspace-test-"));
  const seen = new Set();
  if (packages) await symlink(path.join(root, "node_modules"), path.join(directory, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
  async function emit(relative) {
    if (seen.has(relative)) return;
    seen.add(relative);
    const source = await readFile(path.join(root, relative), "utf8");
    let code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const dependencies = [];
    code = code.replace(/from (["'])(\.{1,2}\/[^"']+)\1/g, (_match, quote, name) => {
      const dependency = path.normalize(path.join(path.dirname(relative), name.endsWith(".ts") ? name : `${name}.ts`));
      dependencies.push(dependency);
      return `from ${quote}${name.replace(/\.ts$/, "")}.js${quote}`;
    });
    // 按需动态加载的相对模块（如存储模式切换后的 SQL 实现）同样转译并改写扩展名。
    code = code.replace(/import\(([\"'])(\.{1,2}\/[^\"']+)\1\)/g, (_match, quote, name) => {
      const dependency = path.normalize(path.join(path.dirname(relative), name.endsWith(".ts") ? name : `${name}.ts`));
      dependencies.push(dependency);
      return `import(${quote}${name.replace(/\.ts$/, "")}.js${quote})`;
    });
    for (const dependency of dependencies) await emit(dependency);
    const destination = path.join(directory, relative.replace(/\.ts$/, ".js"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, code);
  }
  try {
    await emit(entry);
    return { directory, module: await import(pathToFileURL(path.join(directory, entry.replace(/\.ts$/, ".js"))).href), dispose: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
