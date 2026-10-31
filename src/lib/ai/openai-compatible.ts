import { z } from "zod";
import { AnalysisPayloadSchema, type AnalysisResult, type Evidence } from "../contracts";
import { investigationSystemPrompt } from "./prompt";
import { validateAnalysis } from "./validate";

type ChatContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail: "high" } };

export async function createModelAnalysis(evidence: Evidence[]): Promise<AnalysisResult> {
  const apiKey = process.env.AI_API_KEY;
  const baseUrl = process.env.AI_BASE_URL ?? "https://api.openai.com/v1";
  const model = process.env.AI_MODEL ?? "gpt-4.1-mini";

  if (!apiKey) {
    throw new Error("AI_PROVIDER=openai 时必须配置 AI_API_KEY");
  }

  const content: ChatContent[] = [
    {
      type: "text",
      text: "请分析以下证据。所有引用只能使用这里给出的 evidenceId。文本证据按原文处理，图像证据需先识别可见文字；看不清的内容不要猜测。",
    },
  ];

  for (const item of evidence) {
    if (item.kind === "image") {
      content.push({ type: "text", text: `evidenceId=${item.id}；文件名=${item.name}；图像如下：` });
      content.push({ type: "image_url", image_url: { url: item.content, detail: "high" } });
    } else {
      content.push({
        type: "text",
        text: `evidenceId=${item.id}\n文件名=${item.name}\n来源=${item.source ?? "用户上传"}\n原文：\n${item.content}`,
      });
    }
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
    signal: AbortSignal.timeout(90_000),
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

  return validateAnalysis(payload, evidence, "model");
}
