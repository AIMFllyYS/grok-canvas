import { access, cp, mkdir, rm, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const standalone = path.join(root, ".next", "standalone");
const staticFiles = path.join(root, ".next", "static");
const publicFiles = path.join(root, "public");
const destination = path.join(root, ".desktop", "app");

await access(path.join(standalone, "server.js"));
await rm(path.join(root, ".desktop"), { recursive: true, force: true });
await mkdir(destination, { recursive: true });

// Copy an explicit runtime allowlist. Dynamic filesystem tracing can include
// local QA media or old release folders; those must never enter a desktop package.
// pnpm junctions are replaced by a flat production dependency tree next.
await cp(path.join(standalone, "server.js"), path.join(destination, "server.js"));
await cp(path.join(standalone, ".next"), path.join(destination, ".next"), { recursive: true, filter: source => path.basename(source) !== "node_modules" });
// Turbopack gives some ESM externals hashed package aliases. Record the aliases
// now, then materialize them beside flat dependencies without Windows symlinks.
const aliasRoot = path.join(standalone, ".next", "node_modules");
const aliases = [];
for (const alias of await readdir(aliasRoot).catch(() => [])) {
  const manifest = JSON.parse(await readFile(path.join(aliasRoot, alias, "package.json"), "utf8"));
  if (!/^[\w.-]+$/.test(alias) || !/^(?:@[\w.-]+\/)?[\w.-]+$/.test(manifest.name)) throw new Error("Invalid external alias");
  aliases.push({ alias, packageName: manifest.name });
}
await writeFile(path.join(destination, ".next", "desktop-externals.json"), JSON.stringify(aliases));
await cp(path.join(root, "package.json"), path.join(destination, "package.json"));
await cp(path.join(root, "pnpm-lock.yaml"), path.join(destination, "pnpm-lock.yaml"));
await cp(staticFiles, path.join(destination, ".next", "static"), { recursive: true });
await cp(publicFiles, path.join(destination, "public"), { recursive: true });

console.log(`Prepared desktop server at ${destination}`);
