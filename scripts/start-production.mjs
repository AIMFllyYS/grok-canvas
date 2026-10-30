import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkStandalone, currentBuildDir } from "./build-root.mjs";
import { verifyDbRuntime } from "./db-runtime.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let build;
try {
  build = checkStandalone(currentBuildDir(root));
  // pnpm build 的 stage-standalone 已放好 public/static/db-runtime；这里只复核，不再从仓库补拷。
  await verifyDbRuntime(path.join(build.standalone, "db-runtime"));
} catch (error) {
  throw new Error(`Production build is missing or incomplete. Run pnpm build first.\n${error instanceof Error ? error.message : String(error)}`);
}
process.env.NODE_ENV = "production";
process.env.HOSTNAME = "127.0.0.1";
process.env.PORT = "3210";
await import(pathToFileURL(build.server).href);
