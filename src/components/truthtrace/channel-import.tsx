"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { AnalysisResultSchema, EvidenceSchema } from "@/lib/contracts";
import { describeEmptyImport } from "./api-client";
import type { CaseAnalysis, ImportNotice } from "./api-client";
import { ChannelAuth } from "./channel-auth";
import { DateTimeField } from "./datetime-field";

export type ChannelId = "dingtalk" | "wechat";

type ConversationMeta = { id: string; title: string; count: number; start: string; end: string };
type PreviewMessage = {
  seq: number | null;
  sender: string;
  sender_id?: string;
  self?: boolean;
  time: string;
  type: string;
  text: string;
  amount?: string;
  image?: string;
  has_media?: boolean;
};
type SenderMeta = { id: string; name: string; count: number; self: boolean };
type PreviewConversation = {
  id: string;
  title: string;
  source: string;
  total: number;
  total_in_range: number;
  truncated: boolean;
  messages: PreviewMessage[];
  senders?: SenderMeta[];
};
type SelfIdentity = { id?: string; name?: string; via?: string };
/**
 * 一次导入最多从 A 取多少条证据。
 * 以前是 30 —— 但一条聊天会带出十几张图，图把配额吃光后真正的聊天反而被截掉。
 * 现在放宽到与 B 的 /api/analyze 同量级；真正的筛选在服务端按类型分档做
 * （图片单独限额，文本受字符预算保护），并且会通过 meta 如实回传放弃了什么。
 */
const MAX_EXTRACT_EVIDENCE = 200;
type SourceStatus = {
  source?: string;
  authorized?: boolean;
  status?: string;
  detail?: string;
  action?: string;
  hint?: string;
};

const CHANNEL: Record<ChannelId, {
  name: string;
  source: string;
  steps: string[];
  exportTip: string;
  command: string;
  authHint: string;
}> = {
  dingtalk: {
    name: "钉钉",
    source: "dingtalk",
    steps: [
      "授权：终端执行 dws auth login，手机扫码（只需一次）",
      "取数：直接按时间范围读取，或把 dws 导出的 JSON 拖进来",
      "导入：左侧选会话与时间范围，勾选要保留的消息后导入",
    ],
    exportTip: "支持 dws 导出的 messages.json / <会话名>.records.json，也兼容 dingtalk-chat-exporter 的原始格式。",
    command:
      'dws chat message list-all --start "2026-10-01 00:00:00" --end "2026-11-01 23:59:59" --limit 500 -f json > messages.json',
    authHint: "dws auth login",
  },
  wechat: {
    name: "微信",
    source: "wechat",
    steps: [
      "授权：关闭微信客户端，手机扫码抓取 SQLCipher 密钥（只需一次）",
      "导出：用 wechat-ai-memory 把会话导出为 Version 1 JSON",
      "导入：把导出的 JSON 拖进来，左侧勾选会话与时间范围",
    ],
    exportTip: "支持 wechat-ai-memory 的 Version 1 JSON（conversations[].messages[]）。",
    command: "python -m adapters.wechat_aimemory_to_synapse --in exports/wechat.json --out exports/",
    authHint: "python -m adapters.wechat_key_cache import",
  },
};

// 两个渠道现在都走「先读取、再挑」：钉钉靠 dws，微信靠 wechat-ai-memory 的本地数据源
const LIVE_COPY: Record<ChannelId, { title: string; badge: string; desc: string; note: string }> = {
  dingtalk: {
    title: "直接从钉钉读取",
    badge: "已登录 dws 时可用",
    desc: "选一个时间范围，扫一次清单；勾好要的会话再读取正文。扫描只做一次，读取沿用这份清单。",
    note: "先获取范围内的会话清单；只有选中的内容才会导入案件。清单可能不完整，请留意覆盖提示。",
  },
  wechat: {
    title: "直接从微信读取",
    badge: "本机已缓存数据库密钥时可用",
    desc: "选一个时间范围，扫一次本机会话清单；勾好要的会话再读取正文，不必先导出 JSON。",
    note: "首次需要抓一次数据库密钥（会重启微信一次），之后走缓存；读不到时可用下方「导出的 JSON 文件」。",
  },
};

function pad(value: number) { return String(value).padStart(2, "0"); }

function toLocalInput(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function dayOnly(value: string) { return (value || "").slice(0, 10); }
function prettyTime(value: string) { return (value || "").slice(11, 16) || "—"; }
// 直读快照可能跨年（「全部」会往前拉一年），日期必须带年份，否则两端都显示 11-02
function stamp(value: string) { return `${dayOnly(value)} ${prettyTime(value)}`; }
function shortRange(start: string, end: string) {
  const a = dayOnly(start), b = dayOnly(end);
  if (!a && !b) return "无时间信息";
  if (a && b && a === b) return a;
  return `${a || "最早"} → ${b || "最新"}`;
}

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  let data: unknown = null;
  try { data = await response.json(); } catch { /* 非 JSON 时用 fallback 文案 */ }
  if (!response.ok) {
    const message = data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string"
      ? (data as { error: string }).error
      : fallback;
    throw new Error(message);
  }
  if (data === null) throw new Error(fallback);
  return data as T;
}

async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  return readJson<T>(response, "请求失败，请稍后重试");
}

type ScanInfo = {
  pages: number;
  messages: number;
  earliest: string;
  latest: string;
  complete: boolean;
  stop?: string;
  // 钉钉图片取回统计：dws 只给 mediaId，必须下载成文件，证据里才是真图
  media?: { downloaded?: number; failed?: number; skipped?: number; reused?: number };
};

type LiveReply = {
  conversations?: ConversationMeta[];
  handle?: string | null;
  detail?: string;
  hint?: string;
  total?: number;
  scan?: ScanInfo;
  truncated?: boolean;
};

// 「先列清单、再勾选读取」用的会话条目：只有身份信息，不含消息
type SessionMeta = {
  id: string;
  title: string;
  single?: boolean;
  count?: number | null;
  start?: string;
  end?: string;
};
type SessionsReply = {
  sessions?: SessionMeta[];
  scan?: { scanned?: number; complete?: boolean; pages?: number };
  detail?: string;
  hint?: string;
};

// 单会话预览上限：一次渲染太多会卡，但太小又会让「逐条勾选」够不到长会话的后半段。
const PREVIEW_LIMIT = 500;

export function ChannelImport({
  channel,
  existing,
  goal,
  onClose,
  onReady,
}: {
  channel: ChannelId;
  existing?: CaseAnalysis;
  goal?: string;
  onClose: () => void;
  onReady: (result: CaseAnalysis) => void | Promise<void>;
}) {
  const meta = CHANNEL[channel];
  const [activeSource, setActiveSource] = useState(meta.source);
  const [status, setStatus] = useState<SourceStatus | null>(null);
  const [handle, setHandle] = useState<string | null>(null);
  const [sessionSearch,setSessionSearch]=useState("");
  const [authRefresh,setAuthRefresh]=useState(0);
  const autoListed=useRef(false);
  const [pathDraft, setPathDraft] = useState("");
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [loadingSource, setLoadingSource] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const [sourceNotice, setSourceNotice] = useState("");

  const now = useMemo(() => new Date(), []);
  const [start, setStart] = useState(() => toLocalInput(new Date(now.getFullYear(), now.getMonth() - 1, now.getDate(), 0, 0)));
  const [end, setEnd] = useState(() => toLocalInput(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59)));

  // 勾选模型：默认「全选」，只记录被排除的东西。
  // 这样即使某个会话有上千条、预览只渲染前 200 条，也不会因为「没渲染到」而丢消息。
  const [convOff, setConvOff] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<Record<string, number[]>>({});

  const [activeId, setActiveId] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [preview, setPreview] = useState<PreviewConversation | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [selfPick, setSelfPick] = useState<{ id: string; name: string } | null>(null);
  const [selfIdent, setSelfIdent] = useState<SelfIdentity | null>(null);
  const [selfMenu, setSelfMenu] = useState(false);

  // 钉钉免导出直读：直读本身就要按时间范围向渠道取数，所以范围放在第一步选
  const [liveStart, setLiveStart] = useState(() => toLocalInput(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7, 0, 0)));
  const [liveEnd, setLiveEnd] = useState(() => toLocalInput(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59)));
  const [liveMode, setLiveMode] = useState(false);
  const [fetchedRange, setFetchedRange] = useState<{ start: string; end: string } | null>(null);
  // 取数进度：钉钉每页约 100 条，近 30 天要翻十几页（十几秒），
  // 不显示秒表的话用户会以为界面卡死，然后猛点按钮。
  const [sweepSeconds, setSweepSeconds] = useState(0);
  const [scan, setScan] = useState<ScanInfo | null>(null);
  // 读取前的会话清单：默认全选，只记录被排除的 id。
  // 勾选后只读这几段——没勾的群一条都不读，也不进证据。
  const [sessList, setSessList] = useState<SessionMeta[] | null>(null);
  const [sessOff, setSessOff] = useState<string[]>([]);
  const [sessLoading, setSessLoading] = useState(false);
  const [sessSeconds, setSessSeconds] = useState(0);
  const [sessError, setSessError] = useState("");
  const [sessRange, setSessRange] = useState<{ start: string; end: string } | null>(null);
  // 清单扫描只做一次：多久扫完、是不是直接命中缓存，都要说清楚，
  // 否则用户点「读取」时再等一次就以为是重复读了两遍。
  const [sessMs, setSessMs] = useState<number | null>(null);
  const [sessCached, setSessCached] = useState(false);
  const [previewError, setPreviewError] = useState("");
  // 预览失败后手动重试：effect 依赖里加一个计数器，比整页刷新轻
  const [previewNonce, setPreviewNonce] = useState(0);
  // 单会话重读：list-all 是按会话截断的，某一段「只有几天」时只能按群再拉一遍
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [rowNote, setRowNote] = useState<{ id: string; text: string; bad?: boolean } | null>(null);

  const [caseName, setCaseName] = useState("");
  const [busy, setBusy] = useState<"idle" | "extract" | "analyze">("idle");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const fileInput = useRef<HTMLInputElement>(null);
  const started = conversations.length > 0;

  // 授权状态只做「提示」，不阻断：文件已经在本地，导出/导入并不依赖当前机器已登录
  useEffect(() => {
    let alive = true;
    const refresh=()=>fetch(`/api/source/status?source=${encodeURIComponent(meta.source)}`)
      .then(response => readJson<SourceStatus>(response, "无法读取渠道状态"))
      .then(data => { if (alive) setStatus(data); })
      .catch(() => { if (alive) setStatus({ authorized: false, hint: "无法连接数据源服务" }); });
    void refresh();const timer=setInterval(refresh,3000);
    return () => { alive = false;clearInterval(timer); };
  }, [meta.source,authRefresh]);

  const resetPicks = () => {
    setConvOff([]);
    setExcluded({});
    setSelfPick(null);
    setSelfMenu(false);
  };

  const takeConversations = useCallback((reply: { conversations?: ConversationMeta[]; handle?: string | null }) => {
    const list = reply.conversations || [];
    if (!list.length) {
      setSourceError("这个文件里没有解析出会话，请确认是渠道导出的聊天 JSON。");
      return;
    }
    setConversations(list);
    setHandle(reply.handle ?? null);
    setActiveId(list[0].id);
    resetPicks();
    setSourceError("");
    setLiveMode(false);
    setFetchedRange(null);
    // 默认时间范围盖住全部会话：先看到全部，再自己收窄——反过来会让人以为「没有消息」
    const first = list.map(item => item.start).filter(Boolean).sort()[0] || "";
    const last = list.map(item => item.end).filter(Boolean).sort().pop() || "";
    if (first) setStart(toLocalInput(new Date(first.replace(" ", "T"))));
    if (last) setEnd(toLocalInput(new Date(last.replace(" ", "T"))));
    // 默认名用「今天」，不用会话最后一条的日期：导入是今天发生的，
    // 拿 7 月的消息日期当案件名会让人误以为案件发生在 7 月。
    setCaseName(current => current || `${meta.name}聊天记录 · ${dayOnly(toLocalInput(new Date()))}`);
  }, [meta.name]);

  const loadDemo = useCallback(async () => {
    setLoadingSource(true);
    setSourceError("");
    setSourceNotice("正在载入演示会话（不读取真实聊天数据）");
    try {
      const reply = await postJson<{ conversations?: ConversationMeta[]; handle?: string | null }>(
        "/api/source/conversations", { source: "mock" });
      setActiveSource("mock");
      takeConversations(reply);
      setSourceNotice("演示数据：3 段虚构会话，用于体验勾选与预览");
    } catch (cause) {
      setSourceError(cause instanceof Error ? cause.message : "载入演示会话失败");
      setSourceNotice("");
    } finally {
      setLoadingSource(false);
    }
  }, [takeConversations]);

  const uploadFile = useCallback(async (file: File) => {
    setLoadingSource(true);
    setSourceError("");
    setSourceNotice(`正在读取 ${file.name}…`);
    try {
      const body = new FormData();
      body.append("source", meta.source);
      body.append("file", file);
      const response = await fetch("/api/source/conversations", { method: "POST", body });
      const reply = await readJson<{ conversations?: ConversationMeta[]; handle?: string | null }>(
        response, "读取导出文件失败");
      setActiveSource(meta.source);
      takeConversations(reply);
      setSourceNotice(`已读取 ${file.name}`);
    } catch (cause) {
      setSourceError(cause instanceof Error ? cause.message : "读取导出文件失败");
      setSourceNotice("");
    } finally {
      setLoadingSource(false);
    }
  }, [meta.source, takeConversations]);

  const loadPath = useCallback(async () => {
    const path = pathDraft.trim();
    if (!path) { setSourceError("请填写导出文件在服务器上的绝对路径"); return; }
    setLoadingSource(true);
    setSourceError("");
    setSourceNotice("正在读取服务器上的导出文件…");
    try {
      const reply = await postJson<{ conversations?: ConversationMeta[]; handle?: string | null }>(
        "/api/source/conversations", { source: meta.source, source_data: path });
      setActiveSource(meta.source);
      takeConversations(reply);
      setSourceNotice(`已读取 ${path}`);
    } catch (cause) {
      setSourceError(cause instanceof Error ? cause.message : "读取失败");
      setSourceNotice("");
    } finally {
      setLoadingSource(false);
    }
  }, [meta.source, pathDraft, takeConversations]);

  /** 读取前的会话清单：只列「这段时间里有消息的会话」，不落盘、不导入。
   *  用户先勾好再读，没勾的群不会被再读出来。
   *
   *  为什么不在进页面时自动扫：扫描本身就是一次渠道读取（钉钉 30 天约 20 秒）。
   *  自动扫一次、用户改完范围再扫一次、点「读取」还等一次，等于同一段数据读三遍。
   *  现在只在用户按下按钮时扫一次，并按「渠道 + 起止时间」缓存，来回改范围也不重扫。 */
  const scanCache = useRef(new Map<string, { list: SessionMeta[]; at: number }>());

  const loadSessions = useCallback(async (from: string, to: string, force = false) => {
    if (!from || !to) { setSessError("请先选择开始与结束时间"); return; }
    if (from >= to) { setSessError("开始时间必须早于结束时间"); return; }
    setSessError("");
    const key = `${meta.source}|${from}|${to}`;
    if (!force) {
      const hit = scanCache.current.get(key);
      if (hit && Date.now() - hit.at < 10 * 60_000) {
        setSessList(hit.list);
        setSessOff(hit.list.map(item=>item.id)); // 用户明确勾选后才导入
        setSessRange({ start: from, end: to });
        setSessCached(true);
        setSessMs(0);
        return;
      }
    }
    setSessLoading(true);
    setSessCached(false);
    setSessSeconds(0);
    const t0 = Date.now();
    try {
      // 钉钉要翻页扫一遍（30 天约 20 秒），微信读本机库（首次约 5 秒）
      const reply = await postJson<SessionsReply>("/api/source/sessions", {
        source: meta.source, time_start: from, time_end: to,
        limit: 100, max_pages: 60, budget: 120,
      });
      const list = reply.sessions || [];
      if (!list.length) throw new Error("这段时间里没有可读会话，请放宽时间范围");
      scanCache.current.set(key, { list, at: Date.now() });
      setSessList(list);
      setSessOff(list.map(item=>item.id)); // 用户明确勾选后才导入
      setSessRange({ start: from, end: to });
      setSessMs(Math.max(1, Math.round((Date.now() - t0) / 1000)));
    } catch (cause) {
      scanCache.current.delete(key);
      setSessError(cause instanceof Error ? cause.message : "读取会话清单失败");
      setSessList(null);
      setSessMs(null);
    } finally {
      setSessLoading(false);
    }
  }, [meta.source]);

  useEffect(()=>{if(!status?.authorized||autoListed.current)return;const timer=setTimeout(()=>{autoListed.current=true;void loadSessions(liveStart,liveEnd);},0);return()=>clearTimeout(timer);},[channel,status?.authorized,loadSessions,liveStart,liveEnd]);

  /** 向钉钉取一个时间范围的快照。进入选择页与「改了范围重新读取」共用这一条路径，
   *  区别只在是否把左侧范围同步成这次取数的范围。 */
  const fetchLive = useCallback(async (from: string, to: string, mode: "enter" | "refetch",
                                       picked?: SessionMeta[]) => {
    if (!from || !to) { setSourceError("请先选择开始与结束时间"); return; }
    if (from >= to) { setSourceError("开始时间必须早于结束时间"); return; }
    // 逐条勾选是绑在这一份快照上的（seq 按快照重排），换快照就必须重置，
    // 否则「第 3 条」会滑到另一条消息上——会话级勾选可以保留，它不依赖 seq。
    const hadMessagePicks = Object.values(excluded).some(list => list.length > 0);
    setSweepSeconds(0);
    setLoadingSource(true);
    setSourceError("");
    setSourceNotice(mode === "enter"
      ? (picked && picked.length
        ? `正在读取选中的 ${picked.length} 段会话…（清单已扫过，通常几秒）`
        : (channel === "wechat"
          ? "正在读取本机微信库…（首次要解密建索引，约 5~10 秒）"
          : "正在向钉钉读取该时间范围的会话…（范围越长翻页越多，可能需要十几秒）"))
      : "正在按新范围重新读取…");
    try {
      // 只把勾中的会话发给后端：没勾的群不会被读取，也不会进证据。
      const chosen = (picked ?? (sessList ?? []).filter(item => !sessOff.includes(item.id)))
        .map(item => ({ id: item.id, title: item.title, single: !!item.single }));
      const reply = await postJson<LiveReply>("/api/source/live", {
        source: meta.source, time_start: from, time_end: to, limit: 100, max_pages: 60, budget: 120,
        conversations: chosen.length ? chosen : undefined,
      });
      const list = reply.conversations || [];
      if (!list.length) throw new Error("该时间范围内没有可读消息，请放宽范围后重试");
      setActiveSource(meta.source);
      setHandle(reply.handle ?? null);
      setConversations(list);
      setLiveMode(true);
      setFetchedRange({ start: from, end: to });
      // 保留已有勾选：还在的会话沿用原状态，新出现的默认选中，消失的清掉
      setConvOff(prev => prev.filter(id => list.some(item => item.id === id)));
      setExcluded({});
      setActiveId(prev => (prev && list.some(item => item.id === prev) ? prev : list[0].id));
      if (mode === "enter") { setStart(from); setEnd(to); }
      setCaseName(current => current || `${meta.name}聊天记录 · ${dayOnly(toLocalInput(new Date()))}`);
      const info = reply.scan;
      setScan(info ?? null);
      // 说清楚「这份快照覆盖到哪一天」：取不全时必须当场讲，否则用户会以为
      // 自己选的 30 天里真的只有最近 3 天有消息。
      const covered = info?.earliest
        ? `实际覆盖 ${dayOnly(info.earliest)} → ${dayOnly(info.latest || to)}，共 ${info.messages} 条`
        : `共 ${list.length} 段会话`;
      setSourceNotice(
        `已读取 ${list.length} 段会话（${covered}）`
        + (picked && picked.length ? "，其余会话未读取" : "")
        + (info && !info.complete ? "；⚠️ 还没翻到范围起点，建议缩小范围再读" : "")
        + (hadMessagePicks && mode === "refetch" ? "；范围变化后逐条勾选已重置" : ""),
      );
    } catch (cause) {
      setSourceError(cause instanceof Error ? cause.message : "直读失败，请改用导出文件");
      setSourceNotice("");
    } finally {
      setLoadingSource(false);
    }
  }, [excluded, channel, meta.source, meta.name, sessList, sessOff]);

  // 取数秒表：只在真正向渠道取数时跑，让「十几秒」看起来是在干活而不是卡住
  useEffect(() => {
    if (!loadingSource) return;
    const t0 = Date.now();
    const timer = setInterval(() => setSweepSeconds(Math.round((Date.now() - t0) / 1000)), 500);
    return () => clearInterval(timer);
  }, [loadingSource]);

  // 扫描清单的秒表（钉钉 30 天要约 20 秒）
  useEffect(() => {
    if (!sessLoading) return;
    const t0 = Date.now();
    const timer = setInterval(() => setSessSeconds(Math.round((Date.now() - t0) / 1000)), 500);
    return () => clearInterval(timer);
  }, [sessLoading]);

  const pickedSessions = useMemo(
    () => (sessList ?? []).filter(item => !sessOff.includes(item.id)),
    [sessList, sessOff]);

  const loadLive = useCallback(() => {
    if (!pickedSessions.length) {
      setSourceError("先勾选至少一段会话，再点读取");
      return;
    }
    void fetchLive(liveStart, liveEnd, "enter", pickedSessions);
  }, [fetchLive, liveStart, liveEnd, pickedSessions]);

  // 全选/取消全选：默认全选（sessOff 为空），所以只需记被排除的
  const allPicked = !!sessList?.length && pickedSessions.length === sessList.length;
  const toggleAllPicks = () => {
    setSessOff(pickedSessions.length ? (sessList ?? []).map(item => item.id) : []);
  };
  const toggleSessionPick = (id: string) => {
    setSessOff(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  };
  // 范围改过但清单还是旧的：读取会按旧范围取，必须提示重扫
  const sessStale = !!sessRange && (sessRange.start !== liveStart || sessRange.end !== liveEnd);
  // 清单与当前范围一致：再按「扫描」是用户主动要刷新，走强制扫
  const sessFresh = !!sessList && !!sessRange && !sessStale;

  // 单会话重读：只把这一段按群翻一遍（实测 3~10 秒），不动其他会话已调好的勾选。
  // 为什么需要它：整批取数走 list-all，那是「多会话聚合分页」，翻到后面某一段就
  // 滚出结果集了（党校/积极分子都因此被截断），只有按会话拉才能把这一段读全。
  const refreshOne = useCallback(async (item: ConversationMeta) => {
    if (!handle || refreshingId) return;
    setRefreshingId(item.id);
    setRowNote(null);
    setSourceError("");
    try {
      const reply = await postJson<{
        status?: string;
        handle?: string;
        conversation?: ConversationMeta;
        preview?: PreviewConversation;
        self?: SelfIdentity;
        scan?: { pages?: number; messages?: number; before?: number; complete?: boolean;
                 earliest?: string; latest?: string; stop?: string; mode?: string };
      }>("/api/source/conversation/refresh", {
        source: activeSource,
        handle,
        conversation_id: item.id,
        title: item.title,
        time_start: start,
        time_end: end,
      });
      const next = reply.conversation;
      if (next) {
        setConversations(prev => prev.map(row => (row.id === next.id
          ? { ...row, count: next.count, start: next.start, end: next.end }
          : row)));
      }
      // 重读会把快照写进新文件，handle 跟着换；不换的话后续预览还读旧快照
      if (reply.handle) setHandle(reply.handle);
      const pv = reply.preview;
      if (pv) {
        setCounts(prev => ({ ...prev, [pv.id]: pv.total_in_range }));
        if (activeId === pv.id) setPreview(pv);
      }
      if (reply.self?.name || reply.self?.id) setSelfIdent(reply.self);
      // 消息的 seq 是「按快照重排」的，重读后必须清掉这一段的逐条勾选，
      // 否则「第 5 条」会挂到另一条消息上（会话级勾选不依赖 seq，保留）。
      setExcluded(prev => {
        if (!(item.id in prev)) return prev;
        const copy = { ...prev };
        delete copy[item.id];
        return copy;
      });
      const before = reply.scan?.before ?? item.count;
      const after = next?.count ?? item.count;
      const span = next ? shortRange(next.start, next.end) : "";
      setRowNote({
        id: item.id,
        text: after > before
          ? `已补齐 ${after - before} 条（${before} → ${after} 条 · ${span}）`
          : `已重读，仍为 ${after} 条（${span}）· ${meta.name}里就这些`,
      });
    } catch (cause) {
      setRowNote({
        id: item.id,
        text: cause instanceof Error ? cause.message : "重读失败",
        bad: true,
      });
    } finally {
      setRefreshingId(null);
    }
  }, [handle, refreshingId, activeSource, start, end, activeId, meta.name]);

  // 左侧每条会话「范围内有多少条」：只取 total_in_range，不拉正文（limit=1）
  useEffect(() => {
    if (!started) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      postJson<{ conversations?: { id: string; total_in_range: number }[] }>("/api/source/preview", {
        source: activeSource,
        handle,
        conversation_ids: conversations.map(item => item.id),
        time_start: start,
        time_end: end,
        limit: 1,
      }, controller.signal)
        .then(reply => {
          const next: Record<string, number> = {};
          (reply.conversations || []).forEach(item => { next[item.id] = item.total_in_range; });
          setCounts(next);
        })
        .catch(() => { /* 计数失败不影响主流程，右侧预览会显示真实错误 */ });
    }, 280);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [started, activeSource, handle, conversations, start, end]);

  // 右侧预览：只拉当前选中的那一段，避免一次把全部正文塞进浏览器
  useEffect(() => {
    if (!started || !activeId) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setPreviewLoading(true);
      setPreviewError("");
      postJson<{ conversations?: PreviewConversation[]; self?: SelfIdentity }>("/api/source/preview", {
        source: activeSource,
        handle,
        conversation_ids: [activeId],
        time_start: start,
        time_end: end,
        limit: PREVIEW_LIMIT,
      }, controller.signal)
        .then(reply => {
          setPreview((reply.conversations || [])[0] ?? null);
          if (reply.self?.name || reply.self?.id) setSelfIdent(reply.self);
        })
        .catch(cause => {
          // 切换会话失败时不能只留一片空白：用户会以为「这段没消息」或「点了没反应」
          if (controller.signal.aborted) return;
          setPreview(null);
          setPreviewError(cause instanceof Error ? cause.message : "读取这一段失败");
        })
        .finally(() => { if (!controller.signal.aborted) setPreviewLoading(false); });
    }, 280);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [started, activeSource, handle, activeId, start, end, previewNonce]);

  /* ---------------- 会话切换 ---------------- */
  // 勾了多段却只会看第一段的根因是「左边点不出去 / 点了没反应」：
  // 整行可点、当前行自动滚进视野、再加一组上一段/下一段，多条会话也能翻。
  const activeIndex = conversations.findIndex(item => item.id === activeId);
  const stepConv = (delta: number) => {
    const next = conversations[activeIndex + delta];
    if (next) setActiveId(next.id);
  };
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  useEffect(() => {
    if (!activeId) return;
    rowRefs.current[activeId]?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  /* ---------------- 勾选 ---------------- */
  const excludedOf = (id: string) => excluded[id] ?? [];
  const totalOf = (id: string) => counts[id];

  const convChecked = (id: string) => {
    if (convOff.includes(id)) return false;
    const total = totalOf(id);
    if (total === undefined) return true;
    // 一条都不剩时，会话按设计应显示为未选中
    return excludedOf(id).length < total;
  };

  const toggleConv = (id: string) => {
    if (convChecked(id)) {
      setConvOff(current => (current.includes(id) ? current : [...current, id]));
    } else {
      setConvOff(current => current.filter(item => item !== id));
    }
    // 整段取消 = 该段所有消息一起取消；重新勾选 = 全部恢复
    setExcluded(current => ({ ...current, [id]: [] }));
  };

  const msgChecked = (convId: string, seq: number | null) => {
    if (convOff.includes(convId)) return false;
    if (seq === null) return false;
    return !excludedOf(convId).includes(seq);
  };

  const toggleMessage = (convId: string, seq: number | null) => {
    if (seq === null) return;
    const wasChecked = msgChecked(convId, seq);
    setExcluded(current => {
      const list = current[convId] ?? [];
      const next = wasChecked ? [...list, seq] : list.filter(item => item !== seq);
      return { ...current, [convId]: next };
    });
    if (!wasChecked) setConvOff(current => current.filter(item => item !== convId));
  };

  const setConvMessages = (convId: string, seqs: number[], keep: boolean) => {
    setExcluded(current => ({ ...current, [convId]: keep ? [] : seqs }));
    if (keep) setConvOff(current => current.filter(item => item !== convId));
  };

  const checkedConvs = conversations.filter(item => convChecked(item.id));
  const allChecked = conversations.length > 0 && checkedConvs.length === conversations.length;
  const someChecked = checkedConvs.length > 0 && !allChecked;

  const toggleAll = () => {
    if (allChecked) {
      setConvOff(conversations.map(item => item.id));
    } else {
      setConvOff([]);
    }
    setExcluded({});
  };

  const selectedTotal = checkedConvs.reduce((sum, item) => {
    const total = totalOf(item.id);
    if (total === undefined) return sum;
    return sum + Math.max(0, total - excludedOf(item.id).length);
  }, 0);

  const rangeDirty = Boolean(
    liveMode && fetchedRange && (start !== fetchedRange.start || end !== fetchedRange.end),
  );

  const applyRange = (from: string, to: string) => {
    setStart(from);
    setEnd(to);
    // 返回上一步时范围要跟着变，否则重进第一步看到的是旧范围
    setLiveStart(from);
    setLiveEnd(to);
    // 直读模式下范围就是取数范围：改了就重新问渠道要，否则界面上「改了却没生效」。
    // 仍然只取第一步勾中的那几段（不因为改范围就把没勾的群也读出来）。
    if (liveMode) {
      const keep = (sessList ?? []).filter(item => !sessOff.includes(item.id));
      void fetchLive(from, to, "refetch", keep);
    }
  };

  const runImport = async () => {
    const chosen = checkedConvs.filter(item => {
      const total = totalOf(item.id);
      return total === undefined || excludedOf(item.id).length < total;
    });
    if (!chosen.length || !caseName.trim() || busy !== "idle") return;
    setError("");
    setNotice("");
    setBusy("extract");
    try {
      const exclude: Record<string, number[]> = {};
      chosen.forEach(item => {
        const seqs = excludedOf(item.id);
        if (seqs.length) exclude[item.id] = seqs;
      });
      const extracted = await postJson<{
        evidences?: unknown[]; note?: string; synced?: number; truncated?: boolean;
        status?: string; hint?: string;
        skipped?: { title: string; reason: string }[];
      }>(
        "/api/source/extract",
        {
          source: activeSource,
          handle,
          conversation_ids: chosen.map(item => item.id),
          time_start: start,
          time_end: end,
          max_evidence: MAX_EXTRACT_EVIDENCE,
          exclude,
        },
      );
      // 一个群都没读到时停在弹层里说明原因：这时既没有证据可分析，也不能把
      // Zod 的 too_small 原始报错当提示甩出来（用户看不懂也不可能照它去改时间）。
      if (!(extracted.evidences || []).length) {
        setBusy("idle");
        setError(describeEmptyImport(extracted));
        return;
      }
      const imported = EvidenceSchema.array().min(1).parse(extracted.evidences || []);
      const evidence=[...(existing?.evidence||[]),...imported.map(item=>existing?.evidence.some(old=>old.id===item.id)?{...item,id:crypto.randomUUID()}:item)];
      setBusy("analyze");
      const analysed = await postJson<{
        analysis?: unknown;
        meta?: { truncated?: number; droppedEvidence?: number; droppedImages?: number;analysisError?:string };
      }>("/api/analyze", { evidence,allowFallback:true });
      const analysis = AnalysisResultSchema.parse(analysed.analysis);
      document.body.classList.remove("case-entry");
      // 这些提示不能只 setNotice：成功后会立刻 onReady → 关弹层，用户根本看不到。
      // 所以挂到结果上，由工作台顶部的横幅展示（skipped 尤其重要：不显示等于骗人「都导进来了」）。
      const notice: ImportNotice = {};
      if (typeof extracted.synced === "number") notice.synced = extracted.synced;
      if (extracted.truncated) notice.truncated = true;
      if (extracted.note) notice.note = extracted.note;
      if(analysed.meta?.analysisError)notice.note=`${notice.note||""} 材料已保留，模型分析尚未完成：${analysed.meta.analysisError}`;
      if (extracted.skipped?.length) notice.skipped = extracted.skipped;
      if (analysed.meta?.truncated) notice.truncatedChars = analysed.meta.truncated;
      if (analysed.meta?.droppedEvidence) notice.droppedEvidence = analysed.meta.droppedEvidence;
      if (analysed.meta?.droppedImages) notice.droppedImages = analysed.meta.droppedImages;
      await onReady({
        evidence, analysis, caseId:existing?.caseId, goal:goal||existing?.goal, caseName: existing?.caseName||goal?.slice(0,60)||caseName.trim(),
        ...(Object.keys(notice).length ? { notice } : {}),
      });
    } catch (cause) {
      setBusy("idle");
      setError(cause instanceof Error ? cause.message : "导入失败，请稍后重试");
    }
  };

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(meta.command);
      setNotice("导出命令已复制");
    } catch {
      setNotice("复制失败，请手动选中命令");
    }
  };

  /* ---------------- 聊天预览 ---------------- */
  // 本人名字：优先手动指定 → 后端识别结果 → 本段里被标记为 self 的发送者。
  // 注意即使「本段没有我的发言」也要显示识别的名字，否则会被误读成「没认出我」。
  const selfIdentityName = useMemo(() => {
    if (selfPick) return selfPick.name;
    if (selfIdent?.name) return selfIdent.name;
    const flagged = preview?.senders?.find(item => item.self);
    return flagged?.name || "";
  }, [preview, selfPick, selfIdent]);

  const isSelf = (message: PreviewMessage) => {
    if (selfPick) {
      return selfPick.id ? message.sender_id === selfPick.id : message.sender === selfPick.name;
    }
    return Boolean(message.self);
  };

  const previewSeqs = (preview?.messages || [])
    .map(message => (typeof message.seq === "number" ? message.seq : null))
    .filter((seq): seq is number => seq !== null);
  const pickedInPreview = preview
    ? (preview.messages || []).filter(message => msgChecked(preview.id, message.seq)).length
    : 0;

  return (
    <div className="ci-overlay" role="dialog" aria-modal="true" aria-label={`从${meta.name}导入聊天记录`}>
      <div
        className={`ci-shell ${started ? "" : "is-source"} ${!started ? "is-live-only" : ""}`}
        data-channel={channel}
      >
        <header className="ci-header">
          <button className="ci-back" type="button" onClick={started ? () => {
            setConversations([]);
            setPreview(null);
            setCounts({});
            resetPicks();
            setSourceNotice("");
            setSourceError("");
          } : onClose} aria-label={started ? "更换数据来源" : "返回案件首页"}>
            ←
          </button>
          <div className="ci-title">
            <strong>从{meta.name}导入聊天记录</strong>
            <small>{started ? "选择会话与时间范围，逐条勾选后导入" : "按时间范围直接读取，无需导出文件"}</small>
          </div>
          <span className={`ci-status ${status?.status === "ready" ? "ok" : "warn"}`}>
            {status?.status === "ready" ? "已连接" : "等待连接"}
          </span>
          <button className="ci-close" type="button" onClick={onClose} aria-label="关闭">×</button>
        </header>

        {!started ? (
          <div className="ci-source">
            {/* 两个渠道的主路径都是「先读取、再挑」：钉钉走 dws，微信走 wechat-ai-memory
                的本地数据源。导出文件只是微信侧的兜底（没缓存密钥时），折叠起来不占视线。 */}
            <section className="ci-card ci-live">
              <div className="ci-live-head">
                <h3>{LIVE_COPY[channel].title}</h3>
                <span>{LIVE_COPY[channel].badge}</span>
              </div>
              <p>选择相关联系人或群，再核对时间范围与消息。默认最近一周。</p>{!status?.authorized&&<ChannelAuth channel={channel} onAuthorized={()=>{setStatus({authorized:true,status:"ready"});setAuthRefresh(v=>v+1);}}/>}
              <div className="ci-live-row">
                <DateTimeField label="开始" value={liveStart} onChange={setLiveStart} ariaLabel="直读开始时间" />
                <DateTimeField label="结束" value={liveEnd} onChange={setLiveEnd} ariaLabel="直读结束时间" />
                <button
                  type="button"
                  onClick={() => void loadSessions(liveStart, liveEnd, sessFresh)}
                  disabled={sessLoading || loadingSource}
                >
                  {sessLoading
                    ? `扫描中… ${sessSeconds}s`
                    : sessFresh ? "重新扫描" : "扫描会话"}
                </button>
              </div>
              <p className="ci-hint">{LIVE_COPY[channel].note}</p>

              {/* 先勾再读：清单只是标题与条数，勾中的会话才会被真正读取 */}
              <div className="ci-sess">
                <div className="ci-sess-head">
                  <label className="ci-sess-all">
                    <input
                      type="checkbox"
                      checked={allPicked}
                      ref={el => { if (el) el.indeterminate = pickedSessions.length > 0 && !allPicked; }}
                      onChange={toggleAllPicks}
                      disabled={!sessList?.length || sessLoading}
                    />
                    <span>全选</span>
                  </label>
                  <span className="ci-sess-count">
                    {sessLoading
                      ? `正在扫描会话清单… ${sessSeconds}s`
                      : sessList
                        ? `已选 ${pickedSessions.length} / ${sessList.length} 段`
                        : "尚未扫描"}
                  </span>
                  {sessList && !sessLoading && sessCached && (
                    <span className="ci-sess-cache">同一范围刚扫过，直接复用（0 秒）</span>
                  )}
                  {sessList && !sessLoading && !sessCached && sessMs !== null && (
                    <span className="ci-sess-cache">这次扫描用了 {sessMs}s</span>
                  )}
                  {sessStale && !sessLoading && <span className="ci-sess-stale">范围已改，重新扫描</span>}
                </div>

                {sessError && <p className="ci-error" role="alert">{sessError}</p>}

                {!sessList && !sessLoading && (
                  <div className="ci-sess-empty">
                    <p>
                      选好时间范围后点「扫描会话」：<b>只列清单</b>（会话名、条数、起止日期），
                      选中需要的会话，再预览要导入的内容。
                    </p>

                  </div>
                )}

                {sessList && sessList.length > 0 && (
                  <div className="ci-sess-list"><label>搜索联系人或群名<input aria-label="搜索联系人或群名" value={sessionSearch} onChange={e=>setSessionSearch(e.target.value)} placeholder="输入联系人或群名称"/></label>
                    {sessList.filter(item=>item.title.toLowerCase().includes(sessionSearch.toLowerCase())).map(item => {
                      const on = !sessOff.includes(item.id);
                      return (
                        <label key={item.id} className={`ci-sess-row ${on ? "" : "off"}`}>
                          <input type="checkbox" checked={on} onChange={() => toggleSessionPick(item.id)} />
                          <span className="ci-sess-name">{item.title}</span>
                          <span className="ci-sess-meta">
                            {item.single ? "单聊" : "群聊"}
                            {typeof item.count === "number" ? ` · ${item.count} 条` : ""}
                            {item.start ? ` · ${dayOnly(item.start)} → ${dayOnly(item.end || item.start)}` : ""}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>

              {sessList && sessList.length > 0 && (
                <div className="ci-sess-foot">
                  <span>
                    只读勾中的 {pickedSessions.length} 段，其余不读；
                    清单已缓存，点读取不会再扫一遍
                  </span>
                  <button
                    type="button"
                    className="ci-sess-read"
                    onClick={() => void loadLive()}
                    disabled={loadingSource || sessLoading || !pickedSessions.length}
                  >
                    {loadingSource
                      ? `读取中… ${sweepSeconds}s`
                      : `读取选中的 ${pickedSessions.length} 段`}
                  </button>
                </div>
              )}
            </section>

            {channel === "wechat" && (
              <details className="ci-fallback">
                <summary>暂不连接微信？导入已导出的 JSON 文件</summary>
                <ol className="ci-steps">
                  {meta.steps.map((step, index) => (
                    <li key={step}><b>{String(index + 1).padStart(2, "0")}</b><span>{step}</span></li>
                  ))}
                </ol>

                <div className="ci-source-grid">
                  <section className="ci-card">
                    <h3>导入导出文件</h3>
                    <p>{meta.exportTip}</p>
                    <label
                      className="ci-drop"
                      onDragOver={event => event.preventDefault()}
                      onDrop={event => {
                        event.preventDefault();
                        const file = event.dataTransfer.files?.[0];
                        if (file) void uploadFile(file);
                      }}
                    >
                      <span>把 JSON 拖到这里</span>
                      <small>或点击选择文件</small>
                      <input
                        ref={fileInput}
                        type="file"
                        accept=".json,.txt,.md,application/json"
                        onChange={event => {
                          const file = event.target.files?.[0];
                          if (file) void uploadFile(file);
                          event.target.value = "";
                        }}
                      />
                    </label>
                    {loadingSource && <p className="ci-hint">正在读取…</p>}
                  </section>

                  <section className="ci-card">
                    <h3>使用服务器上的导出文件</h3>
                    <p>文件已在跑 A 服务的机器上时，直接填绝对路径，省一次上传。</p>
                    <form className="ci-path" onSubmit={event => { event.preventDefault(); void loadPath(); }}>
                      <input
                        type="text"
                        value={pathDraft}
                        onChange={event => setPathDraft(event.target.value)}
                        placeholder="/data/exports/messages.json"
                        aria-label="导出文件在服务器上的绝对路径"
                      />
                      <button type="submit" disabled={loadingSource}>读取</button>
                    </form>
                    <div className="ci-command">
                      <code>{meta.command}</code>
                      <button type="button" onClick={() => void copyCommand()}>复制命令</button>
                    </div>
                    <p className="ci-hint">
                      未授权时先执行 <code>{meta.authHint}</code>；授权仍然要人扫码，工具不会替你点。
                    </p>
                  </section>
                </div>
              </details>
            )}

            <div className="ci-demo">
              <div>
                <strong>先看看效果？</strong>
                <p>用 3 段虚构会话走完「勾选 → 预览 → 导入」，不读取你本机任何聊天数据。</p>
              </div>
              <button type="button" onClick={() => void loadDemo()} disabled={loadingSource}>载入演示会话</button>
            </div>

            {sourceNotice && <p className="ci-note">{sourceNotice}</p>}
            {sourceError && <p className="ci-error" role="alert">{sourceError}</p>}
            {(status?.detail || status?.hint) && (
              <p className="ci-hint">渠道状态：{status.detail || status.hint}</p>
            )}
          </div>
        ) : (
          <>
            <div className="ci-body">
              <aside className="ci-left">
                <section className="ci-range">
                  <h3>时间范围</h3>
                  <div className="ci-range-inputs">
                    <DateTimeField label="开始" value={start} onChange={setStart} ariaLabel="筛选开始时间" />
                    <DateTimeField label="结束" value={end} onChange={setEnd} ariaLabel="筛选结束时间" />
                  </div>
                  <div className="ci-chips">
                    <button type="button" onClick={() => {
                      const to = new Date();
                      applyRange(
                        toLocalInput(new Date(to.getFullYear(), to.getMonth(), to.getDate() - 7, 0, 0)),
                        toLocalInput(new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59)),
                      );
                    }}>近 7 天</button>
                    <button type="button" onClick={() => {
                      const to = new Date();
                      applyRange(
                        toLocalInput(new Date(to.getFullYear(), to.getMonth() - 1, to.getDate(), 0, 0)),
                        toLocalInput(new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59)),
                      );
                    }}>近 30 天</button>
                    <button type="button" onClick={() => {
                      if (liveMode) {
                        // 直读模式下「全部」= 往前拉一年重新读，不能只把本地筛选放宽：
                        // 快照里没有的消息，再怎么放宽范围也变不出来。
                        const to = new Date();
                        applyRange(
                          toLocalInput(new Date(to.getFullYear() - 1, to.getMonth(), to.getDate(), 0, 0)),
                          toLocalInput(new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59)),
                        );
                        return;
                      }
                      const first = conversations.map(item => item.start).filter(Boolean).sort()[0];
                      const last = conversations.map(item => item.end).filter(Boolean).sort().pop();
                      setStart(first ? toLocalInput(new Date(first.replace(" ", "T"))) : start);
                      setEnd(last ? toLocalInput(new Date(last.replace(" ", "T"))) : end);
                    }}>全部</button>
                  </div>
                  <p className="ci-precision">渠道记录精确到秒，这里按分钟筛选；筛选不改写原始消息。</p>
                  {liveMode && fetchedRange && (
                    <p className="ci-precision">
                      直读快照：{stamp(fetchedRange.start)} → {stamp(fetchedRange.end)}
                    </p>
                  )}
                  {liveMode && scan && (
                    <p className={`ci-precision ${scan.complete ? "" : "ci-precision-warn"}`}>
                      {/* 微信是本地库直读，没有「翻页」这一说，写 0 页只会让人困惑 */}
                      {scan.pages > 0 ? `已翻 ${scan.pages} 页 / ${scan.messages} 条` : `已读取 ${scan.messages} 条`}
                      ，覆盖 {dayOnly(scan.earliest) || "—"}
                      {" → "}{dayOnly(scan.latest) || "—"}
                      {scan.pages > 0
                        ? (scan.complete ? "（已到范围起点）" : "（未翻完，请缩小范围）")
                        : ""}
                      {/* 图片是真去下载了才有的数字：不写出来，用户只会觉得「读取变慢了」 */}
                      {scan.media?.downloaded
                        ? `，取回 ${scan.media.downloaded} 张图片`
                        : ""}
                      {scan.media?.failed
                        ? `（${scan.media.failed} 张下载失败，正文里保留标记）`
                        : ""}
                      {scan.media?.skipped
                        ? `（还有 ${scan.media.skipped} 张超过单次上限未取）`
                        : ""}
                    </p>
                  )}
                  {loadingSource && (
                    <p className="ci-precision">正在取数… 已用 {sweepSeconds}s</p>
                  )}
                  {rangeDirty && (
                    <button
                      type="button"
                      className="ci-refetch"
                      onClick={() => void fetchLive(
                        start, end, "refetch",
                        (sessList ?? []).filter(item => !sessOff.includes(item.id)),
                      )}
                      disabled={loadingSource}
                    >
                      {loadingSource ? `正在重新读取… ${sweepSeconds}s` : "按新范围重新读取会话"}
                    </button>
                  )}
                </section>

                <section className="ci-convs">
                  <div className="ci-convs-head">
                    <label>
                      <input
                        type="checkbox"
                        checked={allChecked}
                        data-partial={someChecked ? "true" : undefined}
                        onChange={toggleAll}
                        aria-label="全选会话"
                      />
                      <span>全选</span>
                    </label>
                    <small>已选 {checkedConvs.length} / {conversations.length} 段</small>
                  </div>
                  <div className="ci-conv-list">
                    {conversations.map(item => {
                      const inRange = counts[item.id] ?? 0;
                      const checked = convChecked(item.id);
                      const dropped = excludedOf(item.id).length;
                      const kept = counts[item.id] === undefined ? inRange : Math.max(0, inRange - dropped);
                      return (
                        <div
                          key={item.id}
                          ref={el => { rowRefs.current[item.id] = el; }}
                          className={`ci-conv ${activeId === item.id ? "active" : ""} ${checked ? "checked" : ""} ${inRange === 0 ? "empty" : ""}`}
                          onClick={() => setActiveId(item.id)}
                          data-active={activeId === item.id ? "true" : undefined}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={counts[item.id] === 0}
                            onClick={event => event.stopPropagation()}
                            onChange={() => toggleConv(item.id)}
                            aria-label={`选择会话 ${item.title}`}
                          />
                          <button
                            type="button"
                            className="ci-conv-main"
                            onClick={() => setActiveId(item.id)}
                            aria-current={activeId === item.id ? "true" : undefined}
                          >
                            <strong>{item.title}</strong>
                            <span>
                              {shortRange(item.start, item.end)} · 共 {item.count} 条
                            </span>
                            <em>
                              {counts[item.id] === undefined
                                ? "范围内统计中…"
                                : dropped > 0 && checked
                                  ? `范围内 ${inRange} 条 · 已选 ${kept} 条`
                                  : `范围内 ${inRange} 条`}
                            </em>
                          </button>
                          <button
                            type="button"
                            className={`ci-conv-refresh ${refreshingId === item.id ? "busy" : ""}`}
                            onClick={() => void refreshOne(item)}
                            disabled={refreshingId === item.id || loadingSource}
                            title="重新读取这一段（按会话精确拉取，可补齐整批取数漏掉的消息）"
                            aria-label={`重新读取 ${item.title}`}
                          >
                            <RefreshCw size={12} />
                          </button>
                          {rowNote?.id === item.id && (
                            <p className={`ci-conv-note ${rowNote.bad ? "bad" : ""}`}>{rowNote.text}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              </aside>

              <section className="ci-right">
                {preview ? (
                  <>
                    <header className="ci-chat-head">
                      <div>
                        <strong>{preview.title}</strong>
                        <small>{preview.source} · 范围内 {preview.total_in_range} 条 / 会话共 {preview.total} 条</small>
                      </div>
                      <div className="ci-chat-tools">
                        {/* 多段会话时最缺的就是「换一段看看」：左列表 + 这组翻页按钮同时给 */}
                        {conversations.length > 1 && (
                          <div className="ci-switch">
                            <button
                              type="button"
                              onClick={() => stepConv(-1)}
                              disabled={activeIndex <= 0}
                              aria-label="上一段会话"
                            >‹</button>
                            <span>{activeIndex + 1} / {conversations.length}</span>
                            <button
                              type="button"
                              onClick={() => stepConv(1)}
                              disabled={activeIndex < 0 || activeIndex >= conversations.length - 1}
                              aria-label="下一段会话"
                            >›</button>
                          </div>
                        )}
                        <span className={`ci-chat-badge ${convChecked(preview.id) ? "" : "off"}`}>
                          {convChecked(preview.id) ? "会导入" : "未勾选"}
                        </span>
                        <span className="ci-chat-count">已选 {pickedInPreview} / {preview.messages.length} 条</span>
                        <button
                          type="button"
                          className="ci-mini"
                          onClick={() => setConvMessages(preview.id, previewSeqs, true)}
                        >
                          全选本条
                        </button>
                        <button
                          type="button"
                          className="ci-mini"
                          onClick={() => setConvMessages(preview.id, previewSeqs, false)}
                        >
                          全不选
                        </button>
                        <div className="ci-self">
                          <button
                            type="button"
                            className="ci-mini ci-self-btn"
                            onClick={() => setSelfMenu(value => !value)}
                            aria-expanded={selfMenu}
                          >
                            本人：{selfIdentityName || "未识别"} ▾
                          </button>
                          {selfMenu && (
                            <div className="ci-self-menu" role="menu">
                              <p>以谁的身份查看？（决定气泡左右）</p>
                              <button
                                type="button"
                                role="menuitem"
                                className={selfPick ? "" : "on"}
                                onClick={() => { setSelfPick(null); setSelfMenu(false); }}
                              >
                                自动识别{selfIdentityName ? `（${selfIdentityName}）` : "（未识别）"}
                              </button>
                              {(preview.senders || []).map(sender => (
                                <button
                                  key={`${sender.id}-${sender.name}`}
                                  type="button"
                                  role="menuitem"
                                  className={selfPick?.name === sender.name ? "on" : ""}
                                  onClick={() => { setSelfPick({ id: sender.id, name: sender.name }); setSelfMenu(false); }}
                                >
                                  {sender.name}
                                  <small>{sender.count} 条</small>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </header>
                    <div className={`ci-chat ci-chat-${channel}`}>
                      {preview.messages.map((message, index) => {
                        const previous = preview.messages[index - 1];
                        const newDay = !previous || dayOnly(previous.time) !== dayOnly(message.time);
                        const self = isSelf(message);
                        const picked = msgChecked(preview.id, message.seq);
                        return (
                          <div key={`${message.seq ?? index}-${message.time}`} className="ci-msg-wrap">
                            {newDay && <div className="ci-day">{dayOnly(message.time) || "时间未知"}</div>}
                            <div className="ci-msg-row">
                              {/* 类名必须是 ci-pick：ci-sess 是「会话清单容器」，套到消息行上会多出一圈边框 */}
                              <label className="ci-pick" title={picked ? "取消这条" : "选中这条"}>
                                <input
                                  type="checkbox"
                                  checked={picked}
                                  disabled={message.seq === null}
                                  onChange={() => toggleMessage(preview.id, message.seq)}
                                  aria-label={`选择 ${message.sender} 在 ${message.time} 的消息`}
                                />
                              </label>
                              <div className={`ci-msg ${self ? "self" : "other"} ${picked ? "" : "dropped"}`}>
                                <span className="ci-avatar" aria-hidden="true">{message.sender.slice(0, 1)}</span>
                                <div className="ci-bubble-box">
                                  {!self && <span className="ci-sender">{message.sender}</span>}
                                  <div className={`ci-bubble type-${message.type}`}>
                                    {message.type === "image" ? (
                                      message.image
                                        ? <img src={message.image} alt="聊天图片" />
                                        : <span className="ci-media">［图片］</span>
                                    ) : message.type === "voice" ? (
                                      <span className="ci-media">［语音{message.has_media ? " · 有音频" : ""}］</span>
                                    ) : message.type === "file" ? (
                                      // 文件消息的正文常带长直链和换行，直接 pre-wrap 会撑出一大块空白
                                      <span className="ci-media">［文件］{message.text.replace(/\s+/g, " ").trim().slice(0, 72)}</span>
                                    ) : message.type === "transfer" ? (
                                      <span className="ci-transfer">转账 {message.amount ? `¥${message.amount}` : ""}</span>
                                    ) : message.type === "system" ? (
                                      <span className="ci-system">{message.text}</span>
                                    ) : (
                                      message.text || "（空消息）"
                                    )}
                                  </div>
                                  <span className="ci-time">{prettyTime(message.time)}</span>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                      {preview.truncated && (
                        <p className="ci-truncated">
                          预览只显示前 {PREVIEW_LIMIT} 条；这里取消勾选会精确作用到这些消息，其余仍按所选范围完整导入。
                        </p>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="ci-chat-empty">
                    {previewLoading ? (
                      <span>正在读取会话…</span>
                    ) : previewError ? (
                      <div className="ci-chat-fail">
                        <span>这一段没读出来：{previewError}</span>
                        <button type="button" onClick={() => setPreviewNonce(n => n + 1)}>重试这一段</button>
                      </div>
                    ) : (
                      <span>在左侧会话列表里点一段，查看它的原始聊天。</span>
                    )}
                  </div>
                )}
              </section>
            </div>

            <footer className="ci-footer">
              <label className="ci-case">
                <span>案件名称</span>
                <input
                  type="text"
                  value={caseName}
                  maxLength={60}
                  onChange={event => setCaseName(event.target.value)}
                  placeholder="例如：供应商催款纠纷"
                />
              </label>
              <div className="ci-footer-meta">
                <span>已选 {checkedConvs.length} 段 · 已勾选约 {selectedTotal} 条消息</span>
                {activeSource === "mock" && <em>演示数据</em>}
              </div>
              {notice && <p className="ci-note">{notice}</p>}
              {error && <p className="ci-error" role="alert">{error}</p>}
              <button
                className="ci-import"
                type="button"
                onClick={() => void runImport()}
                disabled={!checkedConvs.length || !caseName.trim() || busy !== "idle"}
              >
                {busy === "extract" ? "正在按选择取数…" : busy === "analyze" ? "正在生成分析…" : "导入并继续"}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
