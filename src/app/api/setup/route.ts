import { authUrlFromLines } from "@/lib/security/auth-url";
import { secureRoute } from "@/lib/security/boundary";
import { NextResponse } from "next/server";
import { ensureIngestion } from "@/lib/ingestion/service";
import {
  actionCaptureWechatKey,
  actionDingtalkLogin,
  detect,
  runSetup,
  type SetupStep,
} from "../../../../scripts/setup.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// 「一键配置」会装全局 npm 包、改 .env.local、甚至重启微信：
// 只允许本机访问，且可用 SYNAPSE_SETUP_ENABLED=0 彻底关掉。
type Job = {
  id: string;
  action: string;
  status: "running" | "ok" | "failed";
  steps: SetupStep[];
  lines: string[];
  startedAt: number;
  finishedAt?: number;
  note?: string;
  ok?: boolean;
  error?: string;
};

const globalStore = globalThis as typeof globalThis & { __ttSetupJobs?: Map<string, Job> };
const jobs = globalStore.__ttSetupJobs ?? (globalStore.__ttSetupJobs = new Map<string, Job>());

function localOnly(request: Request): boolean {
  if (process.env.SYNAPSE_SETUP_ENABLED === "0") return false;
  try {
    const url = new URL(request.url);
    const host = new URL(`http://${request.headers.get("host") || ""}`).hostname;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) return false;
    const origin = request.headers.get("origin");
    // Next may internally rewrite 127.0.0.1 to localhost; compare browser Origin to Host.
    if (origin && origin !== `${url.protocol}//${request.headers.get("host")}`) return false;
    return request.headers.get("sec-fetch-site") !== "cross-site";
  } catch { return false; }
}

function snapshot(job: Job) {
  return {
    id: job.id,
    action: job.action,
    authUrl: job.action === "login-dingtalk" && job.status === "running" ? authUrlFromLines(job.lines) : undefined,
    status: job.status,
    steps: job.steps.map((step,index)=>({id:`step-${index}`,index,status:step.status,label:`配置步骤 ${index+1}`,detail:step.status==="failed"?"步骤失败，请在本机检查配置":"状态已更新"})),
    lines: job.lines.length ? ["执行进度已更新；原始日志仅限本机查看。"] : [],
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    note: job.status==="ok"?"配置完成":job.status==="failed"?"配置未完成，请在本机检查并重试":"配置进行中",
    ok: job.ok,
    error: job.error ? "配置执行失败，请在本机检查并重试" : undefined,
  };
}

/** GET /api/setup            → 只读检测结果（零副作用）
 *  GET /api/setup?job=<id>   → 轮询某个配置任务的进度 */
async function rawGET(request: Request) {
  if (!localOnly(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const url = new URL(request.url);
  const id = url.searchParams.get("job");
  if (id) {
    const job = jobs.get(id);
    if (!job) return NextResponse.json({ error: "任务不存在或已过期" }, { status: 404 });
    return NextResponse.json(snapshot(job));
  }
  const result = await detect();
  // Detection contains command output and user-specific paths: preserve shape, not raw strings.
  const safe = JSON.parse(JSON.stringify(result, (key,value) => typeof value === "string" ? (key === "id" && ["login-dingtalk","capture-wechat-key"].includes(value) ? value : key === "platform" && ["win32","linux","darwin"].includes(value) ? value : "本机检查项") : value));
  return NextResponse.json(safe, { headers: { "Cache-Control": "no-store" } });
}

/** POST /api/setup {"action":"install"|"login-dingtalk"|"capture-wechat-key"} */
async function rawPOST(request: Request) {
  if (!localOnly(request)) {
    return NextResponse.json(
      { error: "本机配置接口只允许 localhost 访问（或被 SYNAPSE_SETUP_ENABLED=0 关闭）" },
      { status: 403 },
    );
  }
  const body = await request.json().catch(() => null);
  const action = body && typeof body === "object" ? body.action : undefined;
  if (!["install", "login-dingtalk", "capture-wechat-key", "start-services"].includes(action)) {
    return NextResponse.json({ error: `未知操作 ${action}` }, { status: 400 });
  }
  for (const job of jobs.values()) {
    if (job.status === "running") {
      return NextResponse.json({ error: "已有配置任务在运行", jobId: job.id }, { status: 409 });
    }
  }

  const id = `setup-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const job: Job = {
    id, action, status: "running", steps: [], lines: [], startedAt: Date.now(),
  };
  jobs.set(id, job);
  // 任务异步跑，POST 立即返回 jobId，前端轮询 GET 拿进度。
  void (async () => {
    try {
      if (action === "start-services") {
        await ensureIngestion();job.status="ok";job.ok=true;job.note="材料服务已就绪";
      } else if (action === "install") {
        const report = await runSetup(step => {
          if (typeof step.log === "string") {
            job.lines.push(step.log);
            return;
          }
          if (typeof step.index === "number") job.steps[step.index] = { ...step };
        });
        const failed = report.status !== "ok" || !report.after.ready;
        job.status = failed ? "failed" : "ok";
        job.note = failed ? "部分步骤失败，请查看日志" : "配置完成，可刷新渠道状态";
        job.ok = !failed;
      } else {
        job.lines.push("正在准备材料读取服务…");await ensureIngestion();job.lines.push("材料读取服务已就绪");
        const result = action === "login-dingtalk"
          ? await actionDingtalkLogin(line => job.lines.push(line))
          : await actionCaptureWechatKey(line => job.lines.push(line));
        job.status = result.ok ? "ok" : "failed";
        job.ok = result.ok;
        job.note = result.note;
        if (!result.ok) job.lines.push(result.output.slice(-2000));
      }
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
    } finally {
      job.finishedAt = Date.now();
    }
  })();

  return NextResponse.json({ jobId: id, status: "running" });
}

export const GET = secureRoute(rawGET);

export const POST = secureRoute(rawPOST);
