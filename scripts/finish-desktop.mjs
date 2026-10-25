import { access, rename, rm, readFile, cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = path.join(root, ".desktop", "app");
const modules = path.join(destination, "node_modules");
const runtimeModules = path.join(destination, ".next", "node_modules");

await access(path.join(modules, "next", "package.json"));
await access(path.join(modules, "@swc", "helpers", "package.json"));
await rm(runtimeModules, { recursive: true, force: true });
await rename(modules, runtimeModules);
const aliases = JSON.parse(await readFile(path.join(destination, ".next", "desktop-externals.json"), "utf8"));
for (const { alias, packageName } of aliases) {
  if (alias !== packageName) await cp(path.join(runtimeModules, packageName), path.join(runtimeModules, alias), { recursive: true, dereference: true });
}

console.log(`Prepared desktop dependencies at ${runtimeModules}`);
