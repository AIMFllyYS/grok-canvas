import type { NextConfig } from "next";
import { resolveBuildDir, traceExcludes } from "./scripts/build-root.mjs";

const projectRoot = process.cwd();
// 与 start/stage/desktop 脚本共用同一个解析器：非法 GROK_CANVAS_BUILD_DIR 在这里直接报错。
const distDir = resolveBuildDir(process.env.GROK_CANVAS_BUILD_DIR, projectRoot).name;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  distDir,
  // 开发徽标固定停在左下角，正好压住创作 Agent 启动器，开发时关掉它。
  devIndicators: false,
  // Electron ships this build as its local production server.
  output: "standalone",
  // 排除列表见 traceExcludes：从不排除当前 distDir，better-sqlite3 与 lib/db 只经 db-runtime 白名单进入产物。
  outputFileTracingExcludes: {
    "/*": traceExcludes(distDir, projectRoot),
  },
};

export default nextConfig;
