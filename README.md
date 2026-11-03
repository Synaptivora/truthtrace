# TruthTrace
上传聊天记录、截图和文件，AI 识别人物、还原事件、追踪承诺，并标出证据之间值得核查的差异，且每一条结论都可点回原始证据。
## 运行

```bash
npm install
npm run dev
```

打开 `http://localhost:3000`。默认 `AI_PROVIDER=mock`，无需密钥即可跑通完整演示（虚构校园退款纠纷）。

## 启用真实多模态模型

复制 `.env.example` 为 `.env.local`：

```bash
AI_PROVIDER=openai
AI_API_KEY=你的密钥
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4.1-mini
```

模型输出会先经过 `src/lib/ai/validate.ts` 校验：引用不存在的证据或人物会被服务端拒绝，防止凭空编造来源。

## A 接入解析服务

设置 `INGESTION_SERVICE_URL` 指向独立的证据解析服务；该服务需响应 `POST /parse`（`multipart/form-data`，字段 `file`），返回 `{ evidence: {...} }`，结构见 `src/lib/contracts.ts` 的 `EvidenceSchema`。未设置时内置解析器仅支持文本与图片转 base64。

## 脚本

- `npm run dev` 开发服务器
- `npm run build` 生产构建
- `npm run typecheck` 严格类型检查
- `npm run lint` 代码规范检查
- `npm run test` 契约单元测试

## 数据契约

`src/lib/contracts.ts` 定义 `Evidence`、`AnalysisResult`（人物、关系、事件、矛盾、承诺、补证建议），并以 Zod 校验。前端只消费经过校验的结构化结果，不理解 MCP 或模型提示词。

## 已知边界（首版）

- 默认分析为模拟结果，界面上以“模拟分析”标注，不会伪装成真实 AI 结论。
- PDF、聊天截图 OCR 与微信 MCP 尚未接入，属 A 的接续范围。
- 证据为内存态，未接入数据库或用户系统。

## 接续验收（2026-11-01）

当前框架适合三人并行完成黑客松原型；尚不代表生产环境或真实模型效果已验证。

- A：保持 POST /parse 的 file 字段与 Evidence 契约；验收文本、截图 OCR、PDF、空文件和服务超时。每份证据使用唯一 ID；文本引文必须能在 content 中逐字定位。
- B：维护 API 和分析校验。输入错误返回 400，模型调用或输出失败返回 502；不向浏览器回传模型服务原始错误。真实模型文本引用须匹配原文，图像引用仍需人工核验。后续完成真实模型回归集、身份消歧与部署访问控制。
- C：保留 mock/model 标识、错误反馈和证据回溯；验收空态、上传失败、分析失败和移动端布局。消费现有 AnalysisResult，不自行改变 API 字段。

GitHub Actions 对推送和 PR 执行 lint、测试、生产构建及类型检查。部署前仍需接入持久化、访问控制和请求总大小/频率限制；目前仅适用于受控演示，不宜公开接收敏感材料。

## 对话 Agent

点击右下角「和咪探长聊聊」可直接对话或围绕当前案件追问。模型设置包含 18 家供应商预设及自定义接口，支持 Chat Completions、Anthropic Messages 和 Responses；无需密钥可体验明确标注的本地演示。使用与配置详见 [Agent 文档](docs/AGENT.md)。

浏览器回归：运行应用后执行 `npx playwright install chromium` 和 `npm run test:browser`。

## 按目标调查（2026-11-03）

进入案件后点击「自主调查」，输入想查清的问题。界面根据目标关键词推荐流程，也可以手动选择：

| 方式 | 适用目标 | 步骤数 |
| --- | --- | --- |
| 核查一个问题 | 是否有明确日期、说法是否有原文依据 | 5 |
| 梳理事件经过 | 时间线、承诺、事件先后 | 6 |
| 开展完整调查 | 多方说法、人物关系、矛盾与其他解释 | 8 |

三种方式均保留证据读取、主张提取、独立核查和报告。推荐不是模型分类；不明确的目标默认使用完整流程。调查方式随任务持久保存，旧任务继续使用八阶段。修订目标沿用原方式，更换方式需在原任务结束后新建调查。

完成后先查看主张支持状态和原文，再处理补证事项；“报告已生成”不等于所有问题已经核实。当前案件与调查任务已支持本地 SQLite 持久化。上文 2026-11-01 的内存态及未接入能力描述为早期验收记录，以当前实现和专项文档为准。

验证：`npm test` 覆盖三种流程、持久化、引用校验与恢复；构建后执行 `npm run test:investigator`，使用隔离目录及本地模型桩验证完整调查、自动推荐的单点核查、刷新恢复和移动端布局，不使用真实账户。

