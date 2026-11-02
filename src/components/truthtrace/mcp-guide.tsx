"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Cable, Check, Copy, QrCode, RefreshCw, Terminal } from "lucide-react";
import type { Evidence } from "@/lib/contracts";

type SourceItem = {
  id: string;
  name: string;
  auth: string;
  authorized: boolean;
  status: string;
  last_sync: string | null;
  count: number;
};

type StatusResp = {
  source?: string;
  authorized?: boolean;
  status?: string;
  detail?: string;
  action?: string;
  hint?: string;
  last_sync?: string | null;
  count?: number;
  // A 端现场探测的时间戳（HH:MM:SS）：让「已就绪」可核对，而不是一句形容
  checked_at?: string;
  last_action?: string;
  error?: string;
};

type SyncResp = {
  source?: string;
  synced?: number;
  evidences?: Evidence[];
  windows?: number;
  agent?: string;
  status?: string;
  hint?: string;
  detail?: string;
  error?: string;
};

type Step = { label: string; cmd?: string; note?: string };

const STATUS_LABEL: Record<string, string> = {
  ready: "已就绪",
  not_connected: "未连接",
  need_auth: "待授权",
  need_data: "待提供导出文件",
  busy: "同步中",
  error: "异常",
  unsupported: "不支持",
};

const GUIDES: Record<string, { intro: string; steps: Step[] }> = {
  dingtalk: {
    intro: "使用钉钉 dws 工具连接，首次需要本人扫码授权。",
    steps: [
      { label: "安装并确认 dws", cmd: "dws --version", note: "建议 v1.0.39 及以上" },
      { label: "扫码登录", cmd: "dws auth login", note: "登录后返回这里，点击检测连接。" },
      {
        label: "按时间范围导出（可选）",
        cmd: 'dws chat message list-all --start "2026-10-01 00:00:00" --end "2026-11-01 23:59:59" --limit 200 -f json',
      },
      { label: "导出登录凭证（可选）", cmd: "dws auth export" },
    ],
  },
  wechat: {
    intro: "支持 Windows 本机微信。首次配置会重启微信并获取数据库密钥，之后使用缓存。",
    steps: [
      { label: "首次抓取密钥（会重启微信一次）", cmd: "python -m adapters.wechat_key_cache import" },
      { label: "校验密钥是否有效", cmd: "python wechat_key_cache.py --verify" },
      { label: "缓存位置（可用 SYNAPSE_WECHAT_KEY_CACHE 覆盖）", note: "%LOCALAPPDATA%\\Synapse\\wechat_db_keys.json" },
      { label: "已有导出文件？", note: "在读取选项中填写文件路径，再同步材料。" },
    ],
  },
  feishu: {
    intro: "通过 lark-cli 登录个人账号后读取会话；仅有机器人授权时无法读取个人聊天。",
    steps: [{ label: "安装并授权", cmd: "lark-cli auth login", note: "授权后 `lark-cli auth status` 里 user 身份应为 ready" }],
  },
  mock: {
    intro: "内置演示数据，无需任何凭证，可直接同步体验整条链路。",
    steps: [{ label: "直接点击「同步取数」即可", note: "无需 goal 与导出文件" }],
  },
};

export function McpGuide({ onClose }: { onClose: () => void }) {
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [selected, setSelected] = useState("dingtalk");
  const [status, setStatus] = useState<StatusResp | null>(null);
  const [notice, setNotice] = useState("");
  const [listError, setListError] = useState(false);
  const [busy, setBusy] = useState<"" | "connect" | "sync">("");
  const [goal, setGoal] = useState("");
  const [sourceData, setSourceData] = useState("");
  const [maxWindows, setMaxWindows] = useState(8);
  const [result, setResult] = useState<SyncResp | null>(null);
  const [preview, setPreview] = useState<Evidence | null>(null);
  const [copied, setCopied] = useState("");
  // 清单请求是否成功过：A 刚启动时会连不上，靠它决定要不要自动重试一次
  const gotList = useRef(false);

  const loadList = useCallback(async () => {
    try {
      const response = await fetch("/api/source/list", { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setNotice(data.hint || data.error || `渠道列表获取失败（${response.status}）`);
        setListError(true);
        return;
      }
      const list = Array.isArray(data.sources) ? data.sources : [];
      gotList.current = true;
      setSources(list);
      setNotice("");
      setListError(false);
    } catch {
      setListError(true);
      setNotice("无法获取渠道列表，请确认 A 解析服务已启动、且已配置 INGESTION_SERVICE_URL。");
    }
  }, []);

  const loadStatus = useCallback(async (id: string) => {
    try {
      const response = await fetch(`/api/source/status?source=${encodeURIComponent(id)}`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      setStatus(response.ok ? data : { status: "error", error: data.hint || data.error || `状态获取失败（${response.status}）` });
    } catch {
      setStatus({ status: "error", error: "无法连接 A 解析服务。" });
    }
  }, []);

  useEffect(() => {
    // 放到宏任务里执行：同步调用会在 effect 里触发级联渲染（react-hooks/set-state-in-effect）
    const first = setTimeout(() => void loadList(), 0);
    // A 还没监听时第一次必然失败：2.5 秒后补一次，别让面板卡在「正在读取渠道…」
    const retry = setTimeout(() => { if (!gotList.current) void loadList(); }, 2500);
    return () => { clearTimeout(first); clearTimeout(retry); };
  }, [loadList]);

  useEffect(() => {
    let alive = true;
    fetch(`/api/source/status?source=${encodeURIComponent(selected)}`, { cache: "no-store" })
      .then(async response => ({ ok: response.ok, status: response.status, data: await response.json().catch(() => ({})) }))
      .then(({ ok, status, data }) => {
        if (!alive) return;
        setStatus(ok ? data : { status: "error", error: data.hint || data.error || `状态获取失败（${status}）` });
      })
      .catch(() => {
        if (alive) setStatus({ status: "error", error: "无法连接 A 解析服务。" });
      });
    return () => { alive = false; };
  }, [selected]);

  async function connect() {
    setBusy("connect");
    setNotice("");
    try {
      const response = await fetch("/api/source/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: selected }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok && data.error) {
        setNotice(data.hint || data.error);
      } else {
        setStatus({ source: data.source, ...data });
        if (data.status === "need_auth" && data.hint) setNotice(data.hint);
      }
      void loadList();
    } catch {
      setNotice("检测失败：无法连接 A 解析服务。");
    } finally {
      setBusy("");
    }
  }

  async function sync() {
    setBusy("sync");
    setNotice("");
    setResult(null);
    try {
      const payload: Record<string, unknown> = { source: selected, max_windows: maxWindows };
      if (goal.trim()) payload.goal = goal.trim();
      if (sourceData.trim()) payload.source_data = sourceData.trim();
      const response = await fetch("/api/source/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data: SyncResp = await response.json().catch(() => ({}));
      if (!response.ok) {
        setNotice(data.hint || data.detail || data.error || `同步失败（${response.status}）`);
        if (data.status) setStatus(previous => ({ ...(previous || {}), status: data.status, detail: data.detail, hint: data.hint }));
      } else {
        setResult(data);
        void loadList();
        void loadStatus(selected);
      }
    } catch {
      setNotice("同步失败：无法连接 A 解析服务。");
    } finally {
      setBusy("");
    }
  }

  async function copy(text?: string) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied(""), 1500);
    } catch {
      /* 忽略剪贴板权限问题 */
    }
  }

  const guide = GUIDES[selected] || GUIDES.mock;
  const currentStatus = status?.status || "";
  const evidences = result?.evidences || [];
  const message = notice || status?.error || "";
  const serviceUnavailable = /INGESTION_SERVICE_URL|未配置.*解析服务|无法连接.*解析服务/.test(message);

  return (
    <section className="mcp-guide" aria-label="聊天来源连接">
      <header className="mcp-head">
        <button onClick={onClose} aria-label="返回对话"><ArrowLeft size={18} /></button>
        <div><strong>聊天来源</strong><small>连接与授权</small></div>
      </header>

      <div className="mcp-body">
        <div className="mcp-channels">
          {sources.length === 0 && !listError && <span className="mcp-empty">正在检测聊天来源…</span>}
          {sources.map(item => (
            <button
              key={item.id}
              type="button"
              className={`mcp-channel ${selected === item.id ? "active" : ""}`}
              onClick={() => {
                // 点「当前已选中」的卡片时 setSelected 不会变，effect 不重跑，
                // 状态框被清空后就永远空着——这里直接补一次状态请求。
                if (item.id === selected) { void loadStatus(item.id); return; }
                setSelected(item.id); setStatus(null);
                setResult(null); setPreview(null); setNotice("");
              }}
            >
              <span className="mcp-dot" data-status={item.status} />
              <span className="mcp-channel-name"><strong>{item.name}</strong><small>{item.auth}</small></span>
              <em>{STATUS_LABEL[item.status] || item.status}</em>
            </button>
          ))}
        </div>

        {(status || message) && (
          <div className="mcp-status" data-status={currentStatus}>
            <div className="mcp-status-row">
              {currentStatus !== "error" && !serviceUnavailable && <span className={`mcp-badge ${status?.authorized ? "ok" : "warn"}`}>{status?.authorized ? "已授权" : "待授权"}</span>}
              <span className="mcp-status-text">{serviceUnavailable ? "接入服务未连接" : STATUS_LABEL[currentStatus] || "连接提示"}</span>
              {status?.count !== undefined && status.count > 0 && (
                <span className="mcp-count">最近一次 {status.count} 条</span>
              )}
              {status?.checked_at && <span className="mcp-count mcp-checked">检测于 {status.checked_at}</span>}
            </div>
            {serviceUnavailable ? <p className="mcp-detail">启动本机接入服务后，点击检测连接。</p> : status?.detail && status.detail !== message && <p className="mcp-detail">{status.detail}</p>}
            {(status?.last_action || (status?.last_sync && (status.count ?? 0) > 0)) && (
              <p className="mcp-detail">
                最近一次取数：{status.last_action || `${status.count} 条`}
                {status.last_sync ? ` · ${status.last_sync.slice(5, 16)}` : ""}
              </p>
            )}
            {message && (serviceUnavailable ? <details className="mcp-diagnostic"><summary>查看配置说明</summary><p>{message}</p></details> : <p className="mcp-detail error" role="status">{message}</p>)}
            {status?.action && (
              <div className="mcp-action">
                <Terminal size={13} />
                <code>{status.action}</code>
                <button type="button" onClick={() => void copy(status.action)} aria-label="复制授权命令">
                  {copied === status.action ? <Check size={13} /> : <Copy size={13} />}
                </button>
              </div>
            )}
            {status?.hint && !serviceUnavailable && status.hint !== message && status.hint !== status.detail && <p className="mcp-hint">{status.hint}</p>}
          </div>
        )}

        <details className="mcp-block mcp-setup">
          <summary><QrCode size={16} /><span>首次连接设置</span></summary>
          <div className="mcp-setup-content">
          <p className="mcp-guide-name">{sources.find(item => item.id === selected)?.name || ({ dingtalk: "钉钉", wechat: "微信", feishu: "飞书", mock: "演示数据" }[selected])}</p>
          <p className="mcp-intro">{guide.intro}</p>
          <ol className="mcp-steps">
            {guide.steps.map((step, index) => (
              <li key={index}>
                <span className="mcp-step-label">{step.label}</span>
                {step.cmd && (
                  <div className="mcp-cmd">
                    <code>{step.cmd}</code>
                    <button type="button" onClick={() => void copy(step.cmd)} aria-label="复制命令">
                      {copied === step.cmd ? <Check size={13} /> : <Copy size={13} />}
                    </button>
                  </div>
                )}
                {step.note && <small>{step.note}</small>}
              </li>
            ))}
          </ol>
          </div>
        </details>

        <section className="mcp-block">
          <div className="mcp-block-title"><Cable size={16} /><span>读取材料</span></div>
          <p className="mcp-intro">检测授权状态后，同步聊天材料。</p>
          {selected !== "mock" && (
            <details className="mcp-options">
              <summary>读取选项</summary>
              <label className="mcp-field">
                <span>关注的问题（可选）</span>
                <input value={goal} onChange={event => setGoal(event.target.value)} placeholder="例如：核对押金金额与退款时间" />
              </label>
              <label className="mcp-field">
                <span>本机导出文件路径（如有）</span>
                <input value={sourceData} onChange={event => setSourceData(event.target.value)} placeholder="D:\export\session.json" />
              </label>
              <label className="mcp-field inline">
                <span>检索窗口数</span>
                <input type="number" min={1} max={20} value={maxWindows} onChange={event => setMaxWindows(Number(event.target.value) || 8)} />
              </label>
              <small>范围 1–20，默认 8。</small>
            </details>
          )}
          <div className="mcp-actions">
            <button type="button" className="mcp-btn" disabled={busy !== ""} onClick={() => void connect()}>
              <RefreshCw size={14} />{busy === "connect" ? "检测中…" : "检测连接"}
            </button>
            <button type="button" className="mcp-btn primary" disabled={busy !== ""} onClick={() => void sync()}>
              <Cable size={14} />{busy === "sync" ? "同步中…" : "同步取数"}
            </button>
          </div>
        </section>

        {result && (
          <section className="mcp-block mcp-result">
            <div className="mcp-block-title"><Check size={14} /><span>同步结果</span></div>
            <p className="mcp-result-summary">
              已同步 <strong>{result.synced ?? evidences.length}</strong> 条证据
              {result.windows ? ` · ${result.windows} 个聚焦窗口` : ""}
              {result.agent ? ` · ${result.agent}` : ""}
            </p>
            {evidences.length > 0 && (
              <ul className="mcp-evidence-list">
                {evidences.map(item => (
                  <li key={item.id}>
                    <button type="button" onClick={() => setPreview(item)} title="查看内容">
                      <span className={`mcp-kind ${item.kind}`}>{item.kind}</span>
                      <span className="mcp-evidence-name">{item.name}</span>
                      <span className="mcp-source">{item.source}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {preview && (
              <div className="mcp-preview">
                <header>
                  <strong>{preview.name}</strong>
                  <button type="button" onClick={() => setPreview(null)} aria-label="关闭预览">×</button>
                </header>
                {preview.kind === "image" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={preview.content} alt={preview.name} />
                ) : (
                  <pre>{preview.content}</pre>
                )}
              </div>
            )}
          </section>
        )}

      </div>
    </section>
  );
}
