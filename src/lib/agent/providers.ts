import { z } from "zod";

export const ProtocolSchema = z.enum(["openai", "anthropic", "responses"]);
export type Protocol = z.infer<typeof ProtocolSchema>;
export const providers = [
  { id: "openai", name: "OpenAI", group: "国际旗舰", baseUrl: "https://api.openai.com/v1", protocol: "openai" },
  { id: "anthropic", name: "Anthropic Claude", group: "国际旗舰", baseUrl: "https://api.anthropic.com/v1", protocol: "anthropic" },
  { id: "gemini", name: "Google Gemini", group: "国际旗舰", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", protocol: "openai" },
  { id: "xai", name: "xAI Grok", group: "国际旗舰", baseUrl: "https://api.x.ai/v1", protocol: "openai" },
  { id: "mistral", name: "Mistral AI", group: "国际旗舰", baseUrl: "https://api.mistral.ai/v1", protocol: "openai" },
  { id: "deepseek", name: "深度求索 DeepSeek", group: "国产大模型", baseUrl: "https://api.deepseek.com", protocol: "openai" },
  { id: "qwen", name: "通义千问 · 百炼", group: "国产大模型", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", protocol: "openai" },
  { id: "kimi", name: "月之暗面 Kimi", group: "国产大模型", baseUrl: "https://api.moonshot.cn/v1", protocol: "openai" },
  { id: "glm", name: "智谱 GLM", group: "国产大模型", baseUrl: "https://open.bigmodel.cn/api/paas/v4", protocol: "openai" },
  { id: "minimax", name: "MiniMax", group: "国产大模型", baseUrl: "https://api.minimax.cn/v1", protocol: "openai" },
  { id: "mimo", name: "小米 MiMo", group: "国产大模型", baseUrl: "https://api.xiaomimimo.com/v1", protocol: "openai" },
  { id: "hunyuan", name: "腾讯混元", group: "国产大模型", baseUrl: "https://api.hunyuan.cloud.tencent.com/v1", protocol: "openai" },
  { id: "ollama", name: "本地 Ollama", group: "聚合 / 本地", baseUrl: "http://127.0.0.1:11434/v1", protocol: "openai" },
  { id: "siliconflow", name: "硅基流动 SiliconFlow", group: "聚合 / 本地", baseUrl: "https://api.siliconflow.cn/v1", protocol: "openai" },
  { id: "openrouter", name: "OpenRouter", group: "聚合 / 本地", baseUrl: "https://openrouter.ai/api/v1", protocol: "openai" },
  { id: "opencode", name: "OpenCode Zen", group: "聚合 / 本地", baseUrl: "https://opencode.ai/inference/openai/v1", protocol: "openai" },
  { id: "huggingface", name: "Hugging Face Inference", group: "聚合 / 本地", baseUrl: "https://router.huggingface.co/v1", protocol: "openai" },
  { id: "commandcode", name: "CommandCode", group: "聚合 / 本地", baseUrl: "https://api.commandcode.ai/provider/v1", protocol: "openai" },
  { id: "custom", name: "自定义兼容服务", group: "聚合 / 本地", baseUrl: "", protocol: "openai" },
] as const;

export const ConnectionSchema = z.object({
  provider: z.string().max(50), protocol: ProtocolSchema,
  baseUrl: z.string().max(500), model: z.string().trim().min(1).max(200),
  apiKey: z.string().max(2000).default(""), tools: z.boolean().default(true),
});
export type Connection = z.infer<typeof ConnectionSchema>;
export function serverConnection(): Connection | null {
  const provider=process.env.AGENT_PROVIDER ?? process.env.AI_PROVIDER ?? (process.env.AGENT_API_KEY||process.env.AI_API_KEY?"openai":"mock");
  if (["mock","rule"].includes(provider) || provider==="auto"&&!process.env.AGENT_API_KEY&&!process.env.AI_API_KEY) return null;
  const preset = providers.find(p => p.id === provider);
  return ConnectionSchema.parse({
    provider: preset?.id ?? "openai",
    protocol: process.env.AGENT_PROTOCOL ?? preset?.protocol ?? "openai",
    baseUrl: process.env.AGENT_BASE_URL ?? process.env.AI_BASE_URL ?? preset?.baseUrl ?? "https://api.openai.com/v1",
    model: process.env.AGENT_MODEL ?? process.env.AI_MODEL ?? (provider==="deepseek"?"deepseek-flash":undefined),
    apiKey: process.env.AGENT_API_KEY ?? process.env.AI_API_KEY ?? "",
    tools: process.env.AGENT_TOOLS !== "false",
  });
}

// Never attach the server credential to a client-selected URL.
export function resolveConnection(input?: Connection): Connection | null {
  const config = input ?? serverConnection();
  if (!config) return null;
  const url = new URL(config.baseUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) throw new Error("模型地址需使用 HTTPS；本地服务可使用 localhost HTTP。");
  if (!config.apiKey && config.provider !== "ollama") throw new Error("请在模型设置填写 API Key，或使用服务端配置。");
  return { ...config, baseUrl: config.baseUrl.replace(/\/+$/, "") };
}
