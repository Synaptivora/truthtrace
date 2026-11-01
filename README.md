# TruthTrace · AI 现实档案调查局

上传聊天记录、截图和文件，AI 识别人物、还原事件、追踪承诺，并标出证据之间值得核查的差异，且每一条结论都可点回原始证据。

赛题四：网络安全与反诈。主体开发使用 WorkBuddy。

## 三人解耦边界

| 成员 | 模块 | 接入点 |
| --- | --- | --- |
| B（骨架/编排） | API、模型提供器、专用 Prompt、Zod 数据契约 | `src/app/api/*`、`src/lib/ai/*`、`src/lib/contracts.ts` |
| A（数据接入） | 文件/OCR/MCP 解析 | `src/lib/ingestion/parser.ts` 通过 `INGESTION_SERVICE_URL` 外接 |
| C（前端展示） | 侦探工作台、关系图、时间线、交互 | `src/components/*`、`src/app/globals.css` |

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
