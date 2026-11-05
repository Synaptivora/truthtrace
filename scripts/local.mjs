import { localSecret } from './local-secrets.mjs';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { detect, runSetup, toolEnvironment } from './setup.mjs';

// 一键启动本机全链路：Next 前端 + A 端证据解析服务(Python) + 自主调查员后台。
// 用法：npm run dev:local（开发）/ npm run start:local（生产构建）。
// 前端退出或 Ctrl+C 时停止本次启动的子进程；渠道后台失败不再连带杀死前端。
//
// 默认直接启动，渠道工具在接入时按需准备。
// 需要预装全部渠道依赖时：设置 SYNAPSE_AUTO_SETUP=1，或运行 npm run setup。

const mode = process.argv.includes('--production') ? 'start' : 'dev';

/** Python 不会自己读 .env.local，这里解析后统一注入给三个子进程。 */
function loadEnvLocal() {
  const out = {};
  if (!existsSync('.env.local')) return out;
  for (const line of readFileSync('.env.local', 'utf-8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (match) out[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

// ---- 启动前自动装配（只补缺的，不重复装）----
if (process.env.SYNAPSE_AUTO_SETUP === '1' && process.env.SYNAPSE_SKIP_AUTO_SETUP !== '1') {
  try {
    const before = await detect();
    if (before.ready) {
      console.log('[local] 本机渠道工具已就绪，跳过自动装配。');
    } else {
      console.log('[local] 首次运行：检测到有工具未就绪，开始自动装配（只会补装缺的部分）…');
      const report = await runSetup(step => {
        if (!step.label || !step.detail) return;
        const icon = { ok: '✓', skipped: '·', warn: '!', failed: '✗' }[step.status] || '…';
        console.log(`[setup] ${icon} ${step.label} — ${step.detail}`);
      });
      console.log(`[local] 自动装配${report.status === 'ok' ? '完成' : '部分失败，请查看上面日志'}。`);
    }
  } catch (error) {
    // 装配失败不该让服务起不来：前端仍可用示例材料与手动上传
    console.warn(`[local] 自动装配跳过：${error instanceof Error ? error.message : String(error)}`);
  }
}

const envLocal = loadEnvLocal();
const configuredToken = process.env.TRUTHTRACE_INGESTION_TOKEN || envLocal.TRUTHTRACE_INGESTION_TOKEN;
if (configuredToken && configuredToken.length < 32) {
  console.error('[local] TRUTHTRACE_INGESTION_TOKEN 至少需要 32 个字符，请修正后重新启动。');
  process.exit(1);
}
const INGESTION_URL = process.env.INGESTION_SERVICE_URL
  || envLocal.INGESTION_SERVICE_URL || 'http://127.0.0.1:8000';
const INGESTION_PORT = new URL(INGESTION_URL).port || '80';
const startupEnv = toolEnvironment({ ...envLocal, ...process.env });
const env = toolEnvironment({
  ...startupEnv,
  INGESTION_SERVICE_URL: INGESTION_URL,
  INGESTION_HOST: new URL(INGESTION_URL).hostname.replace(/^\[|\]$/g, ""),
  TRUTHTRACE_INGESTION_TOKEN: localSecret('TRUTHTRACE_INGESTION_TOKEN', startupEnv),
  TRUTHTRACE_LOCAL_BOOTSTRAP: "1",
  TRUTHTRACE_SESSION_SECRET: localSecret('TRUTHTRACE_SESSION_SECRET', startupEnv),
});

const children = [];

function launch(label, command, args, options = {}) {
  const child = spawn(command, args, { stdio: 'inherit', windowsHide: true, env, ...options });
  child.on('spawn', () => console.log(`[local] ${label} 已启动 (pid ${child.pid})`));
  child.on('error', error => console.error(`[local] ${label} 启动失败：${error.message}`));
  children.push(child);
  return child;
}

// 1) A 端证据解析服务：services/ingestion/server.py（依赖已装则直接可用）
if (existsSync('services/ingestion/server.py')) {
  launch('A 解析服务 (' + INGESTION_PORT + ')', env.SYNAPSE_PYTHON || (process.platform==='win32'?'python':'python3'), ['server.py','--port',INGESTION_PORT], { cwd: 'services/ingestion' });
} else {
  console.warn('[local] 未找到 services/ingestion/server.py，跳过 A 解析服务');
}

// 2) Next 前端（读取 .env.local 里的 INGESTION_SERVICE_URL）
const frontend=launch('Next 前端', process.execPath, ['node_modules/next/dist/bin/next', mode, '--hostname', '127.0.0.1']);

// 3) 自主调查员后台
if (existsSync('scripts/investigator-worker.ts')) {
  launch('调查员后台', process.execPath, ['--import', 'tsx', 'scripts/investigator-worker.ts']);
}

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
}
for (const child of children) child.on('exit', code => { if(child===frontend){stop();process.exitCode=code||0;}else if(!stopping)console.warn(`[local] 后台进程退出 (${code})，前端继续运行；可在界面重新连接。`); });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
