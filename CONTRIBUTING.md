# TruthTrace 协作约定

## 分支

- `main`：仅通过 PR 合并，保持可运行。
- `feat/ingest`：A 的数据接入（OCR / PDF / 微信 MCP 解析服务）。
- `feat/brain`：B 的 AI 推理引擎（证据模型、矛盾核验、测试集）。
- `feat/frontend`：C 的前端展示（工作台、关系图、时间线、交互）。

## 接口边界（勿越界）

- A 只实现解析服务，响应 `POST /parse`（`multipart/form-data`，字段 `file`），返回 `{ evidence: { ... } }`，结构见 `src/lib/contracts.ts` 的 `EvidenceSchema`。
- B 只改 `src/app/api/*`、`src/lib/ai/*`、`src/lib/contracts.ts`。
- C 只改 `src/components/*` 与 `src/app/globals.css`，消费 `AnalysisResult` 类型。

## 协作规则

1. 改契约字段（`contracts.ts`）必须在 PR 里说明，并同步 A、C。
2. 每个 PR 附带运行 `npm run typecheck && npm run test` 的结果。
3. 新增依赖前先说明用途，避免包体积膨胀（成品 ZIP ≤ 100MB）。
4. 不提交 `.env`、`.env.local`、`node_modules`、`.next`。
