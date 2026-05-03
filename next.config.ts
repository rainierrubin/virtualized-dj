import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  // Standalone output for the Electron main process to spawn as a child server.
  output: "standalone",
};

export default nextConfig;
