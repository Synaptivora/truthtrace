import type { Metadata } from "next";
import "@xyflow/react/dist/style.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "TruthTrace · AI 现实档案调查局",
  description: "可追溯的校园纠纷证据整理、矛盾核验与补证规划工作台",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
