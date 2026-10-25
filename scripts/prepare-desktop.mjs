import { access, cp, mkdir, rm } from "node:fs/promises";
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

// pnpm standalone dependencies are junctions. electron-builder skips them, so
// only copy the compiled server here and install a flat production tree next.
await cp(standalone, destination, {
  recursive: true,
  filter: (source) => path.basename(source) !== "node_modules",
});
await cp(path.join(root, "package.json"), path.join(destination, "package.json"));
await cp(path.join(root, "pnpm-lock.yaml"), path.join(destination, "pnpm-lock.yaml"));
await cp(staticFiles, path.join(destination, ".next", "static"), { recursive: true });
await cp(publicFiles, path.join(destination, "public"), { recursive: true });

console.log(`Prepared desktop server at ${destination}`);
