"use client";

import { safeAuthUrl } from "@/lib/security/auth-url";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, ExternalLink, Loader2, Play, RefreshCw, Wrench } from "lucide-react";

type Detect = {
  platform: string;
  node: string;
  ready: boolean;
  checks: {
    runtime: boolean;
    dws: { installed: boolean; version: string; ok: boolean; user: string; expires_at: string };
    python: { version: string; ok: boolean; missing: string[] };
    wam: { found: boolean; path: string; patched: boolean };
    keyCache: { exists: boolean; accounts: number };
    envLocal: { exists: boolean; ingestion: string };
  };
  manual: Array<{ id: string; label: string; why: string }>;
};

type Step = { id: string; label: string; status: string; detail: string };
type Job = {
  id: string;
  action: string;
  status: "running" | "ok" | "failed";
  steps: Step[];
  lines: string[];
  authUrl?: string;
  note?: string;
  ok?: boolean;
  error?: string;
};

const ICON: Record<string, string> = {
  pending: "·", running: "…", ok: "✓", skipped: "·", warn: "!", failed: "✗",
};

export function SetupTools({ onDone }: { onDone?: () => void }) {
  const [detect, setDetect] = useState<Detect | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const running = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/setup", { cache: "no-store" });
      if (!response.ok) throw new Error(`检测失败（${response.status}）`);
      setDetect(await response.json() as Detect);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    // 放宏任务里，避免在 effect 中同步 setState 触发级联渲染
    const timer = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(timer);
  }, [refresh]);

  async function start(action: "install" | "login-dingtalk" | "capture-wechat-key") {
    if (running.current) return;
    if (action === "capture-wechat-key" &&
      !window.confirm("抓取微信密钥会【关闭并重启微信】，需要你在手机上确认登录。\n\n确定现在执行吗？")) return;
    running.current = true;
    setBusy(action);
    setJob(null);
    setError("");
    try {
      const response = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await response.json().catch(() => ({})) as { jobId?: string; error?: string };
      if (!response.ok || !data.jobId) throw new Error(data.error || `启动失败（${response.status}）`);
      // 轮询任务进度：装包可能几十秒，不能用一次性请求等结果
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 800));
        const poll = await fetch(`/api/setup?job=${encodeURIComponent(data.jobId)}`, { cache: "no-store" });
        const snapshot = await poll.json().catch(() => ({})) as Job;
        if (!poll.ok || !Array.isArray(snapshot.steps) || !Array.isArray(snapshot.lines)) {
          throw new Error(snapshot.error || `读取配置进度失败（${poll.status}），请重新检测`);
        }
        setJob(snapshot);
        if (snapshot.status !== "running") break;
      }
      await refresh();
      onDone?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      running.current = false;
      setBusy("");
    }
  }

  const c = detect?.checks;
  const url = safeAuthUrl(job?.authUrl);
  const chips = c ? [
    { key: "dws", label: "dws", ok: c.dws.installed, note: c.dws.ok ? `已授权 ${c.dws.user}` : "待扫码" },
    { key: "python", label: "Python 依赖", ok: c.python.missing.length === 0, note: c.python.missing.length ? `缺 ${c.python.missing.length} 项` : "齐全" },
    { key: "wam", label: "微信源码", ok: c.wam.found, note: c.wam.found ? (c.wam.patched ? "已打补丁" : "未打补丁") : "缺失" },
    { key: "key", label: "微信密钥", ok: c.keyCache.exists, note: c.keyCache.exists ? `缓存 ${c.keyCache.accounts} 账户` : "待首次抓取" },
    { key: "env", label: ".env.local", ok: Boolean(c.envLocal.ingestion), note: c.envLocal.ingestion || "未配置" },
  ] : [];

  return (
    <section className="tt-setup" aria-label="本机工具一键配置">
      <div className="tt-setup-head">
        <span className="tt-setup-title"><Wrench size={14} />本机工具一键配置</span>
        <button type="button" className="tt-setup-refresh" onClick={() => void refresh()} aria-label="重新检测">
          <RefreshCw size={13} />
        </button>
      </div>

      <p className="tt-setup-lead">
        项目启动时会自动检测并补装缺失工具；也可点下面的按钮立即配置。
        装包、依赖、源码、环境变量全自动，<strong>只有扫码和首次取密钥需要本人确认</strong>。
      </p>

      <div className="tt-setup-chips">
        {chips.map(chip => (
          <span key={chip.key} className={`tt-chip ${chip.ok ? "ok" : "warn"}`} title={chip.note}>
            <i data-ok={chip.ok} />{chip.label}<em>{chip.note}</em>
          </span>
        ))}
        {!c && <span className="tt-setup-loading"><Loader2 size={12} />正在检测本机工具…</span>}
      </div>

      <div className="tt-setup-actions">
        <button type="button" className="tt-btn primary" disabled={Boolean(busy)} onClick={() => void start("install")}>
          {busy === "install" ? <Loader2 size={13} className="tt-spin" /> : <Play size={13} />}
          {busy === "install" ? "配置中…" : "一键配置本机工具"}
        </button>
        <button type="button" className="tt-btn" disabled={Boolean(busy)} onClick={() => void start("login-dingtalk")}>
          {busy === "login-dingtalk" ? <Loader2 size={13} className="tt-spin" /> : <ExternalLink size={13} />}
          钉钉扫码授权
        </button>
        <button type="button" className="tt-btn danger" disabled={Boolean(busy)} onClick={() => void start("capture-wechat-key")}>
          <AlertTriangle size={13} />抓取微信密钥
        </button>
      </div>

      {error && <p className="tt-setup-error" role="alert">{error}</p>}

      {job && (
        <div className={`tt-job ${job.status}`}>
          {job.steps.length > 0 && (
            <ol className="tt-steps">
              {job.steps.map(step => (
                <li key={step.id} data-status={step.status}>
                  <span className="tt-step-icon">{ICON[step.status] || "·"}</span>
                  <span><strong>{step.label}</strong>{step.detail && <small>{step.detail}</small>}</span>
                </li>
              ))}
            </ol>
          )}
          {url && job.action === "login-dingtalk" && (
            <a className="tt-login-link" href={url} target="_blank" rel="noreferrer">
              打开钉钉授权页 <ExternalLink size={12} />
            </a>
          )}
          {job.lines.length > 0 && (
            <details className="tt-log">
              <summary>查看执行日志（{job.lines.length} 行）</summary>
              <pre>{job.lines.join("\n")}</pre>
            </details>
          )}
          {job.status !== "running" && (
            <p className="tt-job-result">
              {job.ok ? <Check size={13} /> : <AlertTriangle size={13} />}
              {job.note || job.error || (job.ok ? "完成" : "未完成")}
            </p>
          )}
        </div>
      )}

      {detect && detect.manual.length > 0 && !job && (
        <p className="tt-setup-manual">
          还差人工一步：{detect.manual.map(item => `${item.label}（${item.why}）`).join("；")}
        </p>
      )}
    </section>
  );
}
