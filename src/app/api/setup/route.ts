import { NextResponse } from "next/server";
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
  const host = (request.headers.get("host") || "").split(":")[0].toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

function snapshot(job: Job) {
  return {
    id: job.id,
    action: job.action,
    status: job.status,
    steps: job.steps,
    lines: job.lines.slice(-120),
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    note: job.note,
    ok: job.ok,
    error: job.error,
  };
}

/** GET /api/setup            → 只读检测结果（零副作用）
 *  GET /api/setup?job=<id>   → 轮询某个配置任务的进度 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("job");
  if (id) {
    const job = jobs.get(id);
    if (!job) return NextResponse.json({ error: "任务不存在或已过期" }, { status: 404 });
    return NextResponse.json(snapshot(job));
  }
  const result = await detect();
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}

/** POST /api/setup {"action":"install"|"login-dingtalk"|"capture-wechat-key"} */
export async function POST(request: Request) {
  if (!localOnly(request)) {
    return NextResponse.json(
      { error: "本机配置接口只允许 localhost 访问（或被 SYNAPSE_SETUP_ENABLED=0 关闭）" },
      { status: 403 },
    );
  }
  const body = await request.json().catch(() => ({})) as { action?: string };
  const action = body.action || "install";
  if (!["install", "login-dingtalk", "capture-wechat-key"].includes(action)) {
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
      if (action === "install") {
        await runSetup(step => {
          if (typeof step.log === "string") {
            job.lines.push(step.log);
            return;
          }
          if (typeof step.index === "number") job.steps[step.index] = { ...step };
        });
        const failed = job.steps.some(step => step.status === "failed");
        job.status = failed ? "failed" : "ok";
        job.note = failed ? "部分步骤失败，请查看日志" : "配置完成，可刷新渠道状态";
        job.ok = !failed;
      } else {
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
