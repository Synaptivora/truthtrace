import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  outputFileTracingExcludes: { "/*": [".truthtrace/**/*", ".env*", "artifacts/**/*", "out/**/*"] },
  // API、SQLite 和本机渠道连接需要 Node 服务端，不能静态导出。
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
