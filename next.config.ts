import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Electron ships this build as its local production server.
  output: "standalone",
};

export default nextConfig;
