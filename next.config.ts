import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  distDir: process.env.GROK_CANVAS_BUILD_DIR || ".next",
  // Electron ships this build as its local production server.
  output: "standalone",
  outputFileTracingExcludes: {
    "/*": ["./artifacts/**/*", "./release/**/*", "./.desktop/**/*", "./.tmp-*/**/*", "./.tmp-*", "./.agents/**/*", "./.git/**/*", "./app/**/*.ts", "./app/**/*.tsx", "./components/**/*", "./lib/**/*.ts", "./tests/**/*", "./scripts/**/*", "./docs/**/*", "./build/**/*"],
  },
};

export default nextConfig;
