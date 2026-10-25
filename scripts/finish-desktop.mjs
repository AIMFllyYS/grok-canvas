import { access, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = path.join(root, ".desktop", "app");
const modules = path.join(destination, "node_modules");
const runtimeModules = path.join(destination, "runtime_modules");

await access(path.join(modules, "next", "package.json"));
await access(path.join(modules, "@swc", "helpers", "package.json"));
await rm(runtimeModules, { recursive: true, force: true });
await rename(modules, runtimeModules);

console.log(`Prepared desktop dependencies at ${runtimeModules}`);
