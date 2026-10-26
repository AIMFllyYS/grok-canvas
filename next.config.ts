import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  distDir: process.env.GROK_CANVAS_BUILD_DIR || ".next",
  // 开发徽标固定停在左下角，正好压住创作 Agent 启动器，开发时关掉它。
  devIndicators: false,
  // Electron ships this build as its local production server.
  output: "standalone",
  outputFileTracingExcludes: {
    "/*": ["./artifacts/**/*", "./release/**/*", "./.desktop/**/*", "./.tmp-*/**/*", "./.tmp-*", "./.agents/**/*", "./.git/**/*", "./app/**/*.ts", "./app/**/*.tsx", "./components/**/*", "./lib/**/*.ts", "./tests/**/*", "./scripts/**/*", "./docs/**/*", "./build/**/*"],
  },
};

export default nextConfig;
