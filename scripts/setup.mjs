#!/usr/bin/env node
// 本机渠道工具「一键配置」：检测 → 缺什么装什么 → 写 .env.local → 复检。
//
// 设计原则：
//   1) 幂等：每步先检测，已就绪就跳过；重复运行不会重复安装。
//   2) 只装「能自动装」的部分。扫码授权 / 微信取密钥必须人工参与，单独放 action 里。
//   3) 不碰密钥明文：不读取、不上传 wechat_db_keys.json 的内容，只判断文件是否存在。
//   4) 三种调用方式：CLI（node scripts/setup.mjs）、npm run setup、
//      以及被 /api/setup 路由 import 后由前端按钮触发。
//
// 用法：
//   node scripts/setup.mjs              # 检测 + 自动安装（人读进度）
//   node scripts/setup.mjs --check     # 只检测，输出 JSON，不装任何东西
//   node scripts/setup.mjs --json      # 检测 + 自动安装，最后输出 JSON

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { tmpdir, homedir, platform } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = homedir();
const IS_WIN = platform() === 'win32';
const PYTHON = process.env.SYNAPSE_PYTHON || (IS_WIN ? 'python' : 'python3');

// 工具统一装到用户目录，避免污染全局（全局 npm 装不上时的兜底路径）
const TOOLS_HOME = join(HOME, '.synapse', 'tools');
const NPM_LOCAL_BIN = join(TOOLS_HOME, 'npm', 'node_modules', '.bin');
// A 端 wechat_live.resolve_src() 内置的默认探测路径，装到这里连环境变量都不用配
const WAM_SRC_ROOT = join(HOME, 'wam_probe', 'src');
const WAM_DEFAULT_SRC = join(WAM_SRC_ROOT, 'wechat-ai-memory-main', 'src');
const PATCH_FILE = join(ROOT, 'scripts', 'patches', 'wechat4_key_capture.py');

const DWS_PKG = 'dingtalk-workspace-cli';
const LARK_PKG = '@larksuite/cli';
const WAM_URLS = [
  'https://codeload.github.com/PC267/wechat-ai-memory/zip/refs/heads/main',
  'https://codeload.github.com/congjin/wechat-ai-memory/zip/refs/heads/main',
  'https://codeload.github.com/ldfpku/wechat-ai-memory/zip/refs/heads/main',
];
const PY_DEPS = [
  ['pypdf', 'pypdf'], ['pymupdf', 'fitz'], ['pillow', 'PIL'],
  ['python-docx', 'docx'], ['openpyxl', 'openpyxl'], ['python-pptx', 'pptx'],
  ['zstandard', 'zstandard'], ['pycryptodome', 'Crypto'],
];

// ---------------------------------------------------------------- 进程封装

function quote(arg) {
  const text = String(arg);
  return /[\s&|<>^"']/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

/** 统一走 shell，兼容 Windows 上 npm.cmd / dws.cmd 这类批处理入口。 */
function run(command, args = [], options = {}) {
  const { timeout = 120_000, onLine, cwd = ROOT, env = process.env } = options;
  const line = [command, ...args.map(quote)].join(' ');
  return new Promise(resolvePromise => {
    let done = false;
    let output = '';
    let child;
    try {
      child = spawn(line, { shell: true, cwd, env, windowsHide: true });
    } catch (error) {
      resolvePromise({ code: -1, output: String(error), timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      if (done) return;
      child.kill();
      finish(-1, `\n[超时] 命令超过 ${Math.round(timeout / 1000)} 秒，已终止`, true);
    }, timeout);
    function finish(code, extra = '', timedOut = false) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (extra) output += extra;
      resolvePromise({ code, output, timedOut });
    }
    const feed = chunk => {
      const text = chunk.toString();
      output += text;
      for (const l of text.split(/\r?\n/)) if (l.trim() && onLine) onLine(l.trim());
    };
    child.stdout?.on('data', feed);
    child.stderr?.on('data', feed);
    child.on('error', error => finish(-1, `\n[启动失败] ${error.message}`));
    child.on('close', code => finish(code ?? -1));
  });
}

async function quick(command, args = [], options = {}) {
  const result = await run(command, args, { timeout: 25_000, ...options });
  return { ok: result.code === 0, out: result.output.trim() };
}

function tmpScript(contents, name = 'synapse_setup_probe.py') {
  const path = join(tmpdir(), name);
  writeFileSync(path, contents, 'utf-8');
  return path;
}

// ---------------------------------------------------------------- 检测

export function readEnvLocal() {
  const path = join(ROOT, '.env.local');
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/** 写 .env.local：保留用户已有的每一行，只补缺失的键（幂等、不覆盖手填的 Key）。 */
export function writeEnvLocal(updates) {
  const path = join(ROOT, '.env.local');
  const original = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const lines = original.split(/\r?\n/);
  const present = new Set(
    lines.map(l => (l.match(/^\s*([A-Z0-9_]+)\s*=/i) || [])[1]).filter(Boolean),
  );
  const added = [];
  for (const [key, value] of Object.entries(updates)) {
    if (!value || present.has(key)) continue;
    lines.push(`${key}=${value}`);
    added.push(key);
  }
  if (added.length) {
    if (lines[lines.length - 1] !== '') lines.push('');
    writeFileSync(path, lines.join('\n'), 'utf-8');
  }
  return { path, added, existed: Boolean(original) };
}

export function wamCandidates() {
  const env = { ...readEnvLocal(), ...process.env };
  const list = [];
  if (env.SYNAPSE_WECHAT_SRC) list.push(env.SYNAPSE_WECHAT_SRC);
  list.push(
    WAM_DEFAULT_SRC,
    join(TOOLS_HOME, 'wechat-ai-memory-main', 'src'),
    join(ROOT, 'services', 'ingestion', 'adapters', 'wechat-ai-memory', 'src'),
    join(ROOT, 'services', 'ingestion', 'wechat-ai-memory', 'src'),
  );
  if (existsSync(WAM_SRC_ROOT)) {
    for (const dir of readdirSync(WAM_SRC_ROOT, { withFileTypes: true })) {
      if (dir.isDirectory()) list.push(join(WAM_SRC_ROOT, dir.name, 'src'));
    }
  }
  return [...new Set(list)];
}

export function findWamSrc() {
  for (const candidate of wamCandidates()) {
    if (!existsSync(join(candidate, 'wechat_context_exporter', 'sources', 'wechat4_source.py'))) continue;
    const capture = join(candidate, 'wechat_context_exporter', 'sources', 'wechat4_key_capture.py');
    let patched = false;
    try { patched = readFileSync(capture, 'utf-8').includes('CACHE_ENV'); } catch { /* 文件缺失当未打补丁 */ }
    return { path: candidate, patched };
  }
  return null;
}

export function keyCachePath() {
  return process.env.SYNAPSE_WECHAT_KEY_CACHE
    || readEnvLocal().SYNAPSE_WECHAT_KEY_CACHE
    || (process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Synapse', 'wechat_db_keys.json')
      : join(HOME, 'Synapse', 'wechat_db_keys.json'));
}

function keyCacheInfo() {
  const path = keyCachePath();
  let accounts = 0;
  if (existsSync(path)) {
    try { accounts = Object.keys(JSON.parse(readFileSync(path, 'utf-8')).keys || {}).length; }
    catch { /* 文件损坏就当没有，下一步会提示重新抓密钥 */ }
  }
  return { path, exists: existsSync(path), accounts };
}

function localZips() {
  const dirs = [join(HOME, 'wam_probe'), join(HOME, 'Downloads'), join(ROOT, '.tools')];
  const found = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (/wechat-ai-memory.*\.zip$/i.test(name)) found.push(join(dir, name));
    }
  }
  return found;
}

/** 只读检测，零副作用。前端 GET /api/setup 直接拿这个结果。 */
export async function detect() {
  const envLocal = readEnvLocal();
  const pyCheck = tmpScript(
    'import importlib.util\n' +
    `mods = ${JSON.stringify(PY_DEPS)}\n` +
    'print(",".join(name for name, mod in mods if importlib.util.find_spec(mod) is None))\n',
  );

  const [node, npm, python, dws, lark, deps, dwsAuth] = await Promise.all([
    Promise.resolve({ ok: true, out: process.version }),
    quick('npm', ['-v']),
    quick(PYTHON, ['--version']),
    quick('dws', ['--version']),
    quick('lark-cli', ['--version']),
    quick(PYTHON, [pyCheck]),
    quick('dws', ['auth', 'status', '-f', 'json'], { timeout: 20_000 }),
  ]);

  let auth = { authenticated: false, token_valid: false, expires_at: '', user: '' };
  try {
    const start = dwsAuth.out.indexOf('{');
    if (start >= 0) {
      const payload = JSON.parse(dwsAuth.out.slice(start));
      auth = {
        authenticated: Boolean(payload.authenticated),
        token_valid: Boolean(payload.token_valid),
        expires_at: String(payload.expires_at || ''),
        user: [payload.user_name, payload.corp_name].filter(Boolean).join('@'),
      };
    }
  } catch { /* 非 JSON 输出当未登录 */ }

  const missing = deps.ok ? deps.out.split(',').map(s => s.trim()).filter(Boolean) : PY_DEPS.map(d => d[0]);
  const wam = findWamSrc();
  const cache = keyCacheInfo();

  const checks = {
    runtime: python.ok && npm.ok,
    dws: { installed: dws.ok, version: dws.out, ...auth, ok: dws.ok && auth.authenticated && auth.token_valid },
    lark: { installed: lark.ok, version: lark.out },
    python: { version: python.out, ok: python.ok, missing },
    wam: { found: Boolean(wam), path: wam?.path || '', patched: wam?.patched || false, localZips: localZips() },
    keyCache: cache,
    envLocal: {
      exists: existsSync(join(ROOT, '.env.local')),
      ingestion: envLocal.INGESTION_SERVICE_URL || process.env.INGESTION_SERVICE_URL || '',
      wamSrc: envLocal.SYNAPSE_WECHAT_SRC || '',
    },
  };
  const ready = Boolean(checks.runtime && dws.ok && missing.length === 0
    && wam && checks.envLocal.ingestion);
  return {
    platform: platform(),
    node: node.out,
    checks,
    ready,
    // 人工步骤：装完工具后仍需用户本人完成的动作
    manual: [
      ...(!auth.authenticated || !auth.token_valid
        ? [{ id: 'login-dingtalk', label: '钉钉扫码授权', why: 'OAuth 必须本人确认，脚本无法代签' }] : []),
      ...(!cache.exists
        ? [{ id: 'capture-wechat-key', label: '微信首次取密钥', why: '会关闭并重启微信，需手机确认；仅首次一次' }] : []),
    ],
  };
}

// ---------------------------------------------------------------- 安装步骤

async function ensureNpmGlobal(pkg, probe, onLine, optional = false) {
  if ((await quick(probe, ['--version'])).ok) return { status: 'skipped', detail: `${probe} 已安装` };
  onLine?.(`安装 ${pkg} …`);
  const primary = await run('npm', ['i', '-g', pkg, '--no-audit', '--no-fund'], { timeout: 180_000, onLine });
  if ((await quick(probe, ['--version'])).ok) return { status: 'ok', detail: `全局安装 ${pkg} 成功` };
  // 全局目录没写权限时，退到用户目录，由 scripts/local.mjs 把 .bin 加进 PATH
  mkdirSync(TOOLS_HOME, { recursive: true });
  onLine?.(`全局安装不可用，改装到 ${TOOLS_HOME} …`);
  const fallback = await run('npm', ['install', '--prefix', join(TOOLS_HOME, 'npm'), pkg,
    '--no-audit', '--no-fund'], { timeout: 180_000, onLine });
  if (existsSync(join(NPM_LOCAL_BIN, IS_WIN ? `${probe}.cmd` : probe))) {
    return { status: 'ok', detail: `已装到用户目录（${NPM_LOCAL_BIN}），启动脚本会自动加入 PATH` };
  }
  const detail = `安装 ${pkg} 失败：${(primary.output + fallback.output).slice(-400)}`;
  return { status: optional ? 'warn' : 'failed', detail };
}

async function ensurePythonDeps(missing, onLine) {
  if (!missing.length) return { status: 'skipped', detail: 'A 服务与微信直读所需 Python 依赖齐全' };
  onLine?.(`安装 Python 依赖：${missing.join(', ')} …`);
  const result = await run(PYTHON, ['-m', 'pip', 'install', '-r',
    join(ROOT, 'services', 'ingestion', 'requirements.txt'),
    'zstandard', 'pycryptodome'], { timeout: 300_000, onLine });
  const after = await quick(PYTHON, [tmpScript(
    'import importlib.util\n' +
    `mods = ${JSON.stringify(PY_DEPS)}\n` +
    'print(",".join(name for name, mod in mods if importlib.util.find_spec(mod) is None))\n',
  )]);
  const still = after.ok ? after.out.split(',').filter(Boolean) : [];
  if (still.length) return { status: 'failed', detail: `仍缺依赖：${still.join(', ')}；${result.output.slice(-300)}` };
  return { status: 'ok', detail: 'Python 依赖安装完成' };
}

async function ensureWamSource(onLine) {
  const found = findWamSrc();
  if (found) {
    if (!found.patched && existsSync(PATCH_FILE)) {
      copyFileSync(PATCH_FILE, join(found.path, 'wechat_context_exporter', 'sources', 'wechat4_key_capture.py'));
      onLine?.('已为 wechat-ai-memory 补上 A 侧密钥缓存补丁');
      return { status: 'ok', detail: `源码已就绪并打好补丁：${found.path}` };
    }
    return { status: 'skipped', detail: `源码已就绪：${found.path}` };
  }

  let zip = localZips()[0];
  if (!zip) {
    const urls = process.env.SYNAPSE_WAM_ZIP_URL
      ? [process.env.SYNAPSE_WAM_ZIP_URL, ...WAM_URLS] : WAM_URLS;
    onLine?.('本机没有 wechat-ai-memory 源码包，尝试从社区镜像下载（约 2~5MB，可能需 1~2 分钟）…');
    mkdirSync(join(ROOT, '.tools'), { recursive: true });
    const target = join(ROOT, '.tools', 'wechat-ai-memory-main.zip');
    for (const url of urls) {
      // curl 支持断点/重试，比 Node fetch 在国内网络下稳；失败再退回 fetch
      const pulled = await run('curl', ['-fsSL', '--retry', '2', '--connect-timeout', '15',
        '--max-time', '180', '-o', target, url], { timeout: 200_000, onLine });
      if (pulled.code === 0 && existsSync(target) && statSync(target).size > 100_000) {
        zip = target;
        onLine?.(`下载成功：${url}`);
        break;
      }
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
        if (!response.ok) continue;
        writeFileSync(target, Buffer.from(await response.arrayBuffer()));
        if (statSync(target).size < 100_000) continue;
        zip = target;
        onLine?.(`下载成功（fetch）：${url}`);
        break;
      } catch { /* 换下一个镜像 */ }
    }
  }
  if (!zip) {
    return {
      status: 'warn',
      detail: '源码包下载失败（网络受限）。可手动把 wechat-ai-memory 的 zip 放到 ~/wam_probe/ 后重试，'
        + '或用 SYNAPSE_WAM_ZIP_URL 指定可访问的下载地址',
    };
  }

  mkdirSync(WAM_SRC_ROOT, { recursive: true });
  onLine?.(`解压 ${basename(zip)} 到 ${WAM_SRC_ROOT} …`);
  const extract = tmpScript(
    'import sys, zipfile\n' +
    'zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])\n' +
    'print("extracted")\n',
  );
  const unzip = await run(PYTHON, [extract, zip, WAM_SRC_ROOT], { timeout: 120_000, onLine });
  if (unzip.code !== 0) return { status: 'failed', detail: `解压失败：${unzip.output.slice(-300)}` };

  const target = findWamSrc();
  if (!target) return { status: 'failed', detail: '解压后未找到 wechat_context_exporter/sources/wechat4_source.py' };
  if (!target.patched && existsSync(PATCH_FILE)) {
    copyFileSync(PATCH_FILE, join(target.path, 'wechat_context_exporter', 'sources', 'wechat4_key_capture.py'));
    onLine?.('已打上 A 侧密钥缓存补丁（GitHub 镜像原版不带这个补丁）');
  }
  return { status: 'ok', detail: `源码已就绪：${target.path}` };
}

const STEP_DEFS = [
  { id: 'runtime', label: '检查 Node / npm / Python 运行环境' },
  { id: 'dws', label: '安装钉钉 dws CLI（dingtalk-workspace-cli）' },
  { id: 'lark', label: '安装飞书 lark-cli（可选）' },
  { id: 'python', label: '安装 A 解析服务与微信直读的 Python 依赖' },
  { id: 'wam', label: '准备 wechat-ai-memory 源码并打补丁' },
  { id: 'env', label: '写入 .env.local 配置' },
  { id: 'verify', label: '复检全部工具与授权状态' },
];

/** 逐项执行；onStep(step) 会在每一步状态变化时被调用。 */
export async function runSetup(onStep = () => {}) {
  const before = await detect();
  const steps = STEP_DEFS.map(s => ({ ...s, status: 'pending', detail: '' }));
  const lines = [];
  const emit = (index, patch) => {
    Object.assign(steps[index], patch);
    onStep({ ...steps[index], index });
  };
  const log = text => {
    lines.push(text);
    if (lines.length > 300) lines.shift();
    onStep({ log: text });
  };

  let failed = false;
  for (let i = 0; i < steps.length; i += 1) {
    emit(i, { status: 'running' });
    try {
      let result;
      switch (steps[i].id) {
        case 'runtime':
          result = before.checks.runtime
            ? { status: 'ok', detail: `Node ${before.node} · npm · ${before.checks.python.version}` }
            : { status: 'failed', detail: '未找到可用的 npm 或 Python；请先安装 Node 18+ 与 Python 3.10+' };
          break;
        case 'dws':
          result = await ensureNpmGlobal(DWS_PKG, 'dws', log);
          break;
        case 'lark':
          result = await ensureNpmGlobal(LARK_PKG, 'lark-cli', log, true);
          break;
        case 'python':
          result = await ensurePythonDeps(before.checks.python.missing, log);
          break;
        case 'wam':
          result = await ensureWamSource(log);
          break;
        case 'env': {
          const wam = findWamSrc();
          const wrote = writeEnvLocal({
            INGESTION_SERVICE_URL: 'http://127.0.0.1:8000',
            SYNAPSE_WECHAT_SRC: wam?.path || '',
            SYNAPSE_WECHAT_KEY_CACHE: keyCacheInfo().exists ? keyCachePath() : '',
          });
          result = { status: 'ok', detail: wrote.added.length
            ? `已写入 ${wrote.added.join('、')} 到 .env.local`
            : '.env.local 已就绪，无需改动' };
          break;
        }
        case 'verify': {
          const after = await detect();
          const missing = [];
          if (!after.checks.dws.installed) missing.push('dws');
          if (after.checks.python.missing.length) missing.push(`Python 依赖(${after.checks.python.missing.length})`);
          if (!after.checks.wam.found) missing.push('wechat-ai-memory 源码');
          result = missing.length
            ? { status: 'warn', detail: `仍缺：${missing.join('、')}；其余工具已就绪` }
            : { status: 'ok', detail: '工具全部就绪；扫码 / 取密钥仍需本人确认一次' };
          break;
        }
        default:
          result = { status: 'skipped', detail: '' };
      }
      if (result.status === 'failed') failed = true;
      emit(i, { status: result.status, detail: result.detail });
      if (result.detail) log(`[${steps[i].label}] ${result.detail}`);
    } catch (error) {
      failed = true;
      emit(i, { status: 'failed', detail: String(error) });
      log(`[异常] ${String(error)}`);
    }
  }
  const after = await detect();
  return { status: failed ? 'failed' : 'ok', steps, lines, before, after };
}

// ---------------------------------------------------------------- 人工步骤（点按钮触发，需本人确认）

/** 钉钉设备流登录：把 URL / user_code 回显到前端，用户点开完成授权。 */
export async function actionDingtalkLogin(onLine = () => {}) {
  const result = await run('dws', ['auth', 'login', '--device', '--no-browser'], {
    timeout: 240_000, onLine,
  });
  const auth = await quick('dws', ['auth', 'status', '-f', 'json'], { timeout: 20_000 });
  let ok = false;
  try {
    const payload = JSON.parse(auth.out.slice(auth.out.indexOf('{')));
    ok = Boolean(payload.authenticated && payload.token_valid);
  } catch { /* 非 JSON */ }
  return { ok, output: result.output, note: ok ? '钉钉授权完成' : '授权未完成或已取消，可重试' };
}

/** 微信首次取密钥：会 taskkill 微信并重启，必须用户在手机上确认。绝不自动执行。 */
export async function actionCaptureWechatKey(onLine = () => {}) {
  const wam = findWamSrc();
  if (!wam) return { ok: false, output: '', note: '未找到 wechat-ai-memory 源码，请先点「一键配置」' };
  const venv = join(HOME, 'wam_probe', 'venv', 'Scripts', 'python.exe');
  const python = existsSync(venv) ? venv : PYTHON;
  const env = { ...process.env, SYNAPSE_WECHAT_SRC: wam.path };
  const frida = await quick(python, ['-c', 'import frida'], { env });
  if (!frida.ok) {
    onLine('缺少 frida，正在安装（首次取密钥需要）…');
    await run(python, ['-m', 'pip', 'install', 'frida', 'pycryptodome', 'zstandard'],
      { timeout: 300_000, onLine, env });
  }
  onLine('⚠ 接下来微信会被关闭并重新拉起，请在手机上确认登录…');
  const result = await run(python, [join(ROOT, 'scripts', 'prime_wechat_key.py')],
    { timeout: 300_000, onLine, env });
  const ok = result.code === 0 && keyCacheInfo().exists;
  return {
    ok,
    output: result.output,
    note: ok ? '密钥已写入本机缓存，之后导入不再需要重启微信' : '取密钥未完成，请确认微信已登录、手机已确认后重试',
  };
}

// ---------------------------------------------------------------- CLI

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // 包在 async IIFE 里：顶层 await 会让 Next 的打包器拒绝 import 这个模块。
  void (async () => {
    const args = process.argv.slice(2);
    if (args.includes('--check')) {
      console.log(JSON.stringify(await detect(), null, 2));
      return;
    }
    const json = args.includes('--json');
    const report = await runSetup(step => {
      if (json || !step.label) return;
      const icon = { running: '…', ok: '✓', skipped: '·', warn: '!', failed: '✗' }[step.status] || ' ';
      console.log(`[${icon}] ${step.label}${step.detail ? ` — ${step.detail}` : ''}`);
    });
    console.log(json ? JSON.stringify(report.after, null, 2)
      : `\n配置${report.status === 'ok' ? '完成' : '部分失败'}。运行 npm run dev:local 启动全链路。`);
  })();
}
