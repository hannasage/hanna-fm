import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The tests start several copies of the site, each with its own build folder.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
};

export default nextConfig;
