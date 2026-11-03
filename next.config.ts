import type { NextConfig } from "next";

// GitHub Pages 部署时通过 CI 传入 NEXT_PUBLIC_BASE_PATH=/truthtrace，
// 本地开发保持为空（不设 basePath）。
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  // GitHub Pages 静态导出配置
  output: "export",
  images: {
    unoptimized: true,
  },
  basePath: basePath || undefined,
};

export default nextConfig;
