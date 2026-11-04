import { ingestionFetch } from "@/lib/ingestion/service";
import { EvidenceSchema, type Evidence } from "../contracts";
import { ingestionUrl } from "./service";

// 聊天信封走 /parse_chat 时没有体积闸门，上限只在 B 这一侧守；
// 超了就退回 /parse，让 A 的单条路径去处理（含超限说明）。
const MAX_CHAT_JSON = 32 * 1024 * 1024;
const MAX_BUNDLES = 40; // 一个文件里最多展开多少个会话，防止异常导出把服务打满
const CHAT_KEYS = ["messages", "records", "msgs", "chatRecords", "items", "data"];
const CONVERSATION_KEYS = ["conversationMessagesList", "conversations", "chats", "sessions"];

type ChatBundle = { records: unknown[]; name?: string; source?: string };

function evidenceKind(file: File): Evidence["kind"] {
  if (file.type.startsWith("image/")) return "image";
  if (file.type === "application/pdf") return "pdf";
  if (/chat|message|微信|聊天/i.test(file.name)) return "chat";
  return "text";
}

function errorOf(detail: unknown, fallback: string): Error {
  const message = detail && typeof detail === "object" && typeof (detail as { error?: unknown }).error === "string"
    ? (detail as { error: string }).error
    : fallback;
  return new Error(message);
}

async function parseRemotely(file: File, serviceUrl: string): Promise<Evidence> {
  const body = new FormData();
  body.append("file", file);

  const response = await ingestionFetch(`${serviceUrl.replace(/\/$/, "")}/parse`, {
    method: "POST",
    body,
    signal: AbortSignal.timeout(240_000),
  });

  if (!response.ok) {
    throw errorOf(await response.json().catch(() => null), `证据解析服务返回 ${response.status}`);
  }

  const result = await response.json();
  return EvidenceSchema.parse(result.evidence ?? result);
}

/** 归一化过的记录长这样：有 type 或 text（A 的 /parse_chat 认这套字段）。 */
function looksNormalized(records: unknown[]): boolean {
  return records.some(item => item && typeof item === "object"
    && ("type" in (item as Record<string, unknown>) || "text" in (item as Record<string, unknown>)));
}

/** 把「一个会话对象」变成 bundle；拿不到消息或不是归一化格式就返回 null。 */
function bundleOf(raw: unknown, fallbackName: string, source?: string): ChatBundle | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const key = CHAT_KEYS.find(name => Array.isArray(item[name]) && (item[name] as unknown[]).length > 0);
  if (!key) return null;
  const records = item[key] as unknown[];
  // 渠道原始导出（dws 的 sendType/createTime/content、微信 Version 1）不是这套字段，
  // 归一化是适配器的职责；这里不认，交给 /parse，避免 B 里再长出一套渠道映射。
  if (!looksNormalized(records)) return null;
  const title = [item.title, item.name, item.nickname, item.chatName]
    .find(value => typeof value === "string" && value.trim()) as string | undefined;
  return {
    records,
    name: title?.trim() || fallbackName,
    ...(source ? { source } : {}),
  };
}

/**
 * 识别「渠道导出」的四种真实形态，返回按会话拆好的 bundle 列表：
 *   1. 裸数组                                   → 单个会话
 *   2. dws list-all：{result:{conversationMessagesList:[{title, messages}]}}  → 多会话
 *   3. wechat-ai-memory Version 1：{conversations:[{name, messages}]}        → 多会话
 *   4. 适配器信封：{source, messages|records|msgs|...:[...]}                 → 单个会话
 * 认出任何一种就改走 A 的 /parse_chat —— 它是唯一能把一条聊天变成
 * 「1 条 chat + N 条独立图片/文件证据」的入口；走 /parse 的话图片会被丢掉。
 */
function collectBundles(payload: unknown, fileName: string): ChatBundle[] | null {
  if (Array.isArray(payload)) {
    return payload.length && looksNormalized(payload) ? [{ records: payload, name: fileName }] : null;
  }
  if (!payload || typeof payload !== "object") return null;

  const root = payload as Record<string, unknown>;
  const source = typeof root.source === "string" ? root.source : undefined;
  const result = (root.result && typeof root.result === "object" ? root.result : root) as Record<string, unknown>;

  for (const key of CONVERSATION_KEYS) {
    const list = result[key] ?? root[key];
    if (!Array.isArray(list) || !list.length) continue;
    const bundles = list
      .map(item => bundleOf(item, fileName, source))
      .filter((item): item is ChatBundle => item !== null)
      .slice(0, MAX_BUNDLES);
    if (bundles.length) return bundles;
  }

  const single = bundleOf(root, fileName, source);
  return single ? [single] : null;
}

async function chatBundles(file: File): Promise<ChatBundle[] | null> {
  if (!/\.json$/i.test(file.name) && !file.type.includes("json")) return null;
  if (file.size > MAX_CHAT_JSON) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    return null; // 不是合法 JSON：交给 /parse，它会按文本处理
  }
  return collectBundles(payload, file.name);
}

async function parseChatRemotely(bundle: ChatBundle, serviceUrl: string): Promise<Evidence[]> {
  const response = await ingestionFetch(`${serviceUrl.replace(/\/$/, "")}/parse_chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      records: bundle.records,
      ...(bundle.name ? { name: bundle.name } : {}),
      // 信封自带来源才传；没有就让 A 按「用户上传」标，B 不替它猜平台
      ...(bundle.source ? { source: bundle.source } : {}),
    }),
    signal: AbortSignal.timeout(240_000),
  });
  if (!response.ok) {
    throw errorOf(await response.json().catch(() => null), `聊天记录解析服务返回 ${response.status}`);
  }
  const result = await response.json();
  return EvidenceSchema.array().min(1).parse(result.evidences ?? []);
}

/** 一个文件 → 一条或多条证据（聊天导出会按会话展开成 chat + 媒体）。 */
export async function parseEvidenceFile(file: File): Promise<Evidence[]> {
  if (file.size > 25*1024*1024) throw new Error("Request too large");
  if (file.size === 0) throw new Error(`${file.name} 是空文件`);

  const serviceUrl = process.env.INGESTION_SERVICE_URL || (/\.(pdf|json)$/i.test(file.name)?ingestionUrl():undefined);
  if (serviceUrl) {
    const bundles = await chatBundles(file);
    if (bundles) {
      const evidences: Evidence[] = [];
      for (const bundle of bundles) {
        evidences.push(...await parseChatRemotely(bundle, serviceUrl));
      }
      if (evidences.length) return evidences;
    }
    return [await parseRemotely(file, serviceUrl)];
  }

  const kind = evidenceKind(file);
  const base = {
    id: crypto.randomUUID(),
    name: file.name,
    kind,
    mimeType: file.type || "application/octet-stream",
    source: "用户上传",
  };

  if (file.type.startsWith("text/") || /\.(txt|md|json|csv|log)$/i.test(file.name)) {
    return [EvidenceSchema.parse({ ...base, content: await file.text() })];
  }

  if (kind === "image") {
    const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    return [EvidenceSchema.parse({
      ...base,
      content: `data:${base.mimeType};base64,${base64}`,
    })];
  }

  throw new Error(`${file.name} 暂不能由内置解析器处理。请上传文本，或由 A 配置 INGESTION_SERVICE_URL。`);
}
