import { z } from "zod";
import { AnalysisPayloadSchema, type AnalysisResult, type Evidence } from "../contracts";
import { investigationSystemPrompt } from "./prompt";
import { validateAnalysis } from "./validate";

type ChatContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail: "high" } };

export type AnalyzeOutcome = {
  analysis: AnalysisResult;
  meta: {
    truncated: number; // 正文被字符预算截断的条数
    droppedEvidence: number; // 超出总条数上限没送进模型的条数
    droppedImages: number; // 超出图片上限/字节预算没送进模型的图片数
    images: number; // 真正送进模型的图片数
  };
};

export type ModelBudget = {
  maxEvidence: number; // 单批总条数上限（文本类基本用不完）
  maxImages: number; // 图片张数上限：每张都是一次视觉输入 + 一段 base64 请求体
  imageBudgetBytes: number; // 图片总字节预算
  maxImageBytes: number; // 单张上限，超了直接跳过（压缩失败的原图会击穿请求体）
  totalChars: number; // 文本总字符预算
};

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * 模型侧的容量闸门。
 *
 * 以前是一个「一刀切 30 条」的硬上限，问题是它不区分类型：
 *   文本/聊天已经受字符预算保护（多一条只是把 20 万字分薄一点），
 *   而每张图片都是一段 base64 请求体 + 一次视觉输入，和文本不是同一种成本。
 * 于是微信一次导入（1 段聊天 + 20 张图）就把配额吃光，真正的聊天反而被挤掉。
 * 现在拆成四档，全部可用环境变量覆写，默认值按「本地演示够用」取。
 */
export function modelBudget(): ModelBudget {
  return {
    maxEvidence: envInt("ANALYZE_MAX_EVIDENCE", 200),
    maxImages: envInt("ANALYZE_MAX_IMAGES", 20),
    // 本工具是本地运行的，请求体不经任何网关/平台（没有 Vercel 那种 4.5MB 限制），
    // 所以图片字节预算可以给得比较大方；张数上限才是视觉输入与耗时的真实约束。
    imageBudgetBytes: envInt("ANALYZE_IMAGE_BUDGET_MB", 64) * 1024 * 1024,
    maxImageBytes: envInt("ANALYZE_IMAGE_MAX_MB", 8) * 1024 * 1024,
    totalChars: envInt("ANALYZE_CHAR_BUDGET", 200_000),
  };
}

/** data URL 里的 base64 解码后大概多少字节（不真解码，只算长度）。 */
function base64Bytes(content: string): number {
  if (!content.startsWith("data:")) return content.length;
  const comma = content.indexOf(",");
  const body = comma >= 0 ? content.slice(comma + 1) : content;
  return Math.ceil((body.replace(/=+$/, "").length * 3) / 4);
}

/** 纯函数：按预算挑出真正送进模型的证据，并把「放弃了什么」数清楚。 */
export function selectForModel(
  evidence: Evidence[],
  budget: ModelBudget = modelBudget(),
): { selected: Evidence[]; meta: Omit<AnalyzeOutcome["meta"], "truncated"> } {
  const selected: Evidence[] = [];
  let images = 0;
  let imageBytes = 0;
  let droppedImages = 0;
  let droppedEvidence = 0;

  for (const item of evidence) {
    if (selected.length >= budget.maxEvidence) { droppedEvidence += 1; continue; }
    if (item.kind === "image") {
      const size = base64Bytes(item.content);
      if (images >= budget.maxImages) { droppedImages += 1; continue; }
      if (size > budget.maxImageBytes) { droppedImages += 1; continue; }
      if (imageBytes + size > budget.imageBudgetBytes) { droppedImages += 1; continue; }
      images += 1;
      imageBytes += size;
      selected.push(item);
      continue;
    }
    selected.push(item);
  }

  return { selected, meta: { droppedEvidence, droppedImages, images } };
}

const TIMEOUT_MS = envInt("AI_TIMEOUT_MS", 180_000);

export async function createModelAnalysis(evidence: Evidence[]): Promise<AnalyzeOutcome> {
  const apiKey = process.env.AI_API_KEY;
  const baseUrl = process.env.AI_BASE_URL ?? "https://api.openai.com/v1";
  const model = process.env.AI_MODEL ?? "gpt-4.1-mini";

  if (!apiKey) {
    throw new Error("AI_PROVIDER=openai 时必须配置 AI_API_KEY");
  }

  // 先按类型分档挑一次：超出部分记进 meta，由 C 明确告诉用户「有什么没被分析」，
  // 而不是像以前那样在 C 侧悄悄 slice(0, 30)。
  const { selected, meta } = selectForModel(evidence);
  const budget = modelBudget();

  const content: ChatContent[] = [
    {
      type: "text",
      text: "请分析以下证据。所有引用只能使用这里给出的 evidenceId。文本证据按原文处理，图像证据需先识别可见文字；看不清的内容不要猜测。",
    },
  ];

  let used = 0;
  let truncated = 0;
  // 被字符预算截断的证据，模型可能引用到被裁掉的部分；对它们放宽「引文必须逐字命中」，
  // 否则证据一多就大面积 502（这条规则只对模型生效，rule/mock 不受影响）。
  const loose = new Set<string>();

  for (const item of selected) {
    if (item.kind === "image") {
      content.push({ type: "text", text: `evidenceId=${item.id}；文件名=${item.name}；图像如下：` });
      content.push({ type: "image_url", image_url: { url: item.content, detail: "high" } });
      continue;
    }
    const room = Math.max(0, budget.totalChars - used);
    if (item.content.length > room) {
      const kept = item.content.slice(0, room);
      content.push({
        type: "text",
        text: `evidenceId=${item.id}\n文件名=${item.name}\n来源=${item.source ?? "用户上传"}\n原文：\n${kept}`
          + `\n（正文已截断：原文共 ${item.content.length} 字，本次只读前 ${room} 字）`,
      });
      used = budget.totalChars;
      truncated += 1;
      loose.add(item.id);
      continue;
    }
    used += item.content.length;
    content.push({
      type: "text",
      text: `evidenceId=${item.id}\n文件名=${item.name}\n来源=${item.source ?? "用户上传"}\n原文：\n${item.content}`,
    });
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: investigationSystemPrompt },
        { role: "user", content },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "truthtrace_analysis",
          strict: false,
          schema: z.toJSONSchema(AnalysisPayloadSchema),
        },
      },
    }),
    // 证据变多之后 90 秒不够用（20 张图 + 长正文），默认放宽到 180 秒，可用 AI_TIMEOUT_MS 覆写。
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`模型服务返回 ${response.status}：${detail}`);
  }

  const result = await response.json();
  const rawContent = result?.choices?.[0]?.message?.content;
  if (typeof rawContent !== "string") {
    throw new Error("模型服务未返回可解析的文本内容");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawContent);
  } catch {
    throw new Error("模型返回的内容不是有效 JSON");
  }

  return {
    analysis: validateAnalysis(payload, selected, "model", { looseQuoteIds: loose }),
    meta: { truncated, ...meta },
  };
}
