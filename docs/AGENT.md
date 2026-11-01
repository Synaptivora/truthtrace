# 对话 Agent

## 使用
右下角「和咪探长聊聊」在首页、示例案件和真实案件中均可打开。打开齿轮 → 选择供应商 → 填写 API Base URL、当前账号可用的模型 ID 和 API Key → 测试连接 → 发送问题。

支持普通聊天、多轮追问、证据关键词检索、分页读取原文、读取已有分析、点击来源查看原文。示例案件始终标注虚构；真实案件与全局对话按证据 ID 隔离。当前标签页内保留历史和未发送草稿；刷新后清除，不把案件或密钥写入 localStorage/sessionStorage。

模型设置只用于对话 Agent；原有上传后的结构化分析仍使用 AI_* 配置。未配置 Agent 时沿用 AI_*；AI_PROVIDER=mock 时明确显示本地演示。演示只提供操作说明与关键词摘录，不冒充模型推理。

## 供应商与协议
所有预设均支持编辑地址和手填模型 ID，不把可能过期的模型目录硬编码。地域、账号权限、付费套餐与模型能力必须匹配。18 个供应商预设加一个自定义入口：

| 供应商 | 默认协议 | 默认 Base URL |
|---|---|---|
| OpenAI | Chat Completions，可改 Responses | https://api.openai.com/v1 |
| Anthropic | Messages | https://api.anthropic.com/v1 |
| Google Gemini | 官方 OpenAI 兼容接口 | https://generativelanguage.googleapis.com/v1beta/openai |
| xAI Grok | Chat Completions | https://api.x.ai/v1 |
| Mistral | Chat Completions | https://api.mistral.ai/v1 |
| DeepSeek | Chat Completions | https://api.deepseek.com |
| Qwen / 百炼 | Chat Completions | https://dashscope.aliyuncs.com/compatible-mode/v1 |
| Kimi | Chat Completions | https://api.moonshot.cn/v1 |
| GLM | Chat Completions | https://open.bigmodel.cn/api/paas/v4 |
| MiniMax | Chat Completions | https://api.minimax.cn/v1 |
| MiMo | Chat Completions，附 api-key 头 | https://api.xiaomimimo.com/v1 |
| Hunyuan | Chat Completions | https://api.hunyuan.cloud.tencent.com/v1 |
| Ollama | Chat Completions | http://127.0.0.1:11434/v1 |
| SiliconFlow | Chat Completions | https://api.siliconflow.cn/v1 |
| OpenRouter | Chat Completions | https://openrouter.ai/api/v1 |
| OpenCode Zen | 按模型选择 Chat / Responses / Messages | https://opencode.ai/inference/openai/v1 |
| Hugging Face Inference | Chat Completions | https://router.huggingface.co/v1 |
| CommandCode | 按模型选择 Chat / Responses / Messages | https://api.commandcode.ai/provider/v1 |

OpenCode 切换 Messages 时默认地址同步切为 /inference/anthropic/v1。原生 Gemini 接口及非聊天专用模型不在此通用适配范围；Google 使用官方兼容接口。CommandCode Claude 模型需选 Messages。Ollama 模型需先安装；容器部署时 localhost 指容器自身，可配置受信任网关的 HTTPS 地址。

测试连接会产生一次真实模型请求，仅验证文本回复；不保证当前模型支持工具或视觉。工具不支持时可关闭「允许 Agent 检索、读取案件材料」，改用普通问答：最多提供前 5 份文本的各 6000 字片段，以及视觉启用时前 2 张图，并明确记录范围。工具开启时由模型按需检索和分页读取。

## 服务端配置
在未提交的 .env.local 中设置，修改后重启 Next：
```dotenv
AGENT_PROVIDER=deepseek
AGENT_PROTOCOL=openai
AGENT_BASE_URL=https://api.deepseek.com
AGENT_MODEL=填写当前可用模型ID
AGENT_API_KEY=填写自己的密钥
AGENT_TOOLS=true
```
AGENT_PROVIDER 可以填写目录 ID；AGENT_PROTOCOL 支持 openai、anthropic、responses。API Key 只在服务器环境或当前浏览器内存中使用，不回显到配置查询接口。浏览器自定义地址从不借用服务端密钥，重定向不会携带凭据继续请求。

## 工具、来源与数据流
- search_evidence：在当前案件文本及文件名中按关键词检索，最多 5 份。
- read_evidence：按 E1 等会话目录编号读取，每次最多 6000 字，返回 nextOffset。
- case_overview：读取已有分析，标明 mock/model 和待核查性质。
- 图片默认不发送像素。显式勾选视觉后，read_evidence 才把 PNG/JPEG/WebP/GIF 的 data URL 附给模型；普通问答模式最多前 2 张。图片识别质量由视觉模型决定。
- 每个问题最多 5 次模型调用，每次最多 6 个工具；110 秒超时，请求上限 12 MB。模型输出最长 12000 字，对话发送最近 23 条。
- 接口使用 NDJSON 返回真实执行状态与最终完整回答；不展示内部思维，不模拟逐字输出。最终引用校验通过后才保存回复。
- E 编号必须对应本轮实际提供给模型的来源，否则拦截回答。它不是事实正确性认证，原文仍需人工核对。
- 工具只能读取当前请求明确提供的材料；没有 shell、外部联网搜索、自动取渠道数据、自动改写或删除案件能力。
- 关闭助手、切换案件/模型或停止会中断客户端请求并向上游传播取消；已经被供应商处理的请求可能仍计费。
- 默认按本地单用户场景使用。若部署到公网，应在反向代理/应用入口配置认证和限流；本次未新增账号系统。

## 验证
单元测试覆盖工具循环、未知引用拦截、调用次数上限、无工具回退、三种协议、图片发送开关、取消、密钥隔离、同源检查和配置脱敏。
浏览器验收使用本机模拟模型服务，覆盖首页聊天、供应商设置、连接测试、真实上传后问答、来源展开、三协议连续追问、停止、草稿、窄屏及密钥不落浏览器存储。
没有使用用户真实凭据，未宣称 18 家服务均完成线上实测。

## 参考资料（2026-11-01 核对）
交互参考 [LearnNote 全局助手](https://github.com/hurry060215-tech/learnnote-assistant/blob/main/docs/GLOBAL_ASSISTANT.md)，实现为独立代码，未复制其源码。
- [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)、[Gemini 兼容接口](https://ai.google.dev/gemini-api/docs/openai)
- [xAI](https://docs.x.ai/developers/rest-api-reference/inference)、[Mistral](https://docs.mistral.ai/resources/migration-guides)、[DeepSeek](https://api-docs.deepseek.com/quick_start/agent_integrations/)
- [Qwen 区域地址](https://help.aliyun.com/en/model-studio/base-url)、[Kimi](https://platform.kimi.com/docs/get-api-key)、[GLM](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction)
- [MiniMax](https://platform.minimax.cn/docs/api-reference/text-openai-api)、[MiMo](https://mimo.mi.com/docs/zh-CN/quick-start/summary/first-api-call)、[Hunyuan](https://cloud.tencent.com/document/product/1729/111007)
- [Ollama](https://docs.ollama.com/api/openai-compatibility)、[SiliconFlow](https://api-docs.siliconflow.cn/docs/userguide/quickstart)、[OpenRouter](https://openrouter.ai/developers)
- [OpenCode 模型协议](https://opencode.ai/v2/docs/console/models/)、[Hugging Face](https://huggingface.co/docs/inference-providers/index)、[CommandCode](https://commandcode.ai/docs/provider)

浏览器回归：启动应用后执行 `npx playwright install chromium`，再执行 `npm run test:browser`；可用 AGENT_TEST_URL 指定地址。测试创建的案件仅在测试浏览器中，图片保存在被 Git 忽略的 artifacts/agent/。
