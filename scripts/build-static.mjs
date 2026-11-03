// 静态导出构建脚本（GitHub Pages 用）
// 原理：Next.js 静态导出(output: export)与 API 路由(force-dynamic)不兼容，
// 且 tests/ 会引用 API 模块导致类型检查失败。构建前临时移出这两处，
// 构建完成后恢复。源码目录保持干净。
import { renameSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const apiDir = join(root, "src", "app", "api");
const testsDir = join(root, "tests");
const nextDir = join(root, ".next");
const apiBackup = join(root, ".api-static-export-backup");
const testsBackup = join(root, ".tests-static-export-backup");

let exitCode = 0;

function run(cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error(`\n[build-static] 命令失败: ${cmd} ${args.join(" ")}`);
    exitCode = r.status ?? 1;
  }
}

// 0. 清理 .next 缓存（避免旧的类型校验器引用已移出的 API 模块）
if (existsSync(nextDir)) {
  rmSync(nextDir, { recursive: true, force: true });
  console.log("[build-static] 已清理 .next 缓存");
}

// 1. 移出 API 目录与 tests 目录
if (existsSync(apiDir)) {
  renameSync(apiDir, apiBackup);
  console.log("[build-static] 已临时移出 src/app/api");
}
if (existsSync(testsDir)) {
  renameSync(testsDir, testsBackup);
  console.log("[build-static] 已临时移出 tests");
}

// 2. 执行静态构建（不立即退出，保证 finally 能恢复目录）
try {
  run("npx", ["next", "build"]);
} finally {
  // 3. 无论成败都恢复目录
  if (existsSync(apiBackup)) {
    renameSync(apiBackup, apiDir);
    console.log("[build-static] 已恢复 src/app/api");
  }
  if (existsSync(testsBackup)) {
    renameSync(testsBackup, testsDir);
    console.log("[build-static] 已恢复 tests");
  }
}

process.exit(exitCode);
