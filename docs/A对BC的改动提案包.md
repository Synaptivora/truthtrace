# A → B / C 改动提案包

> 交付方：A（数据接入）　接收方：B（分析编排）、C（前端展示）
> 生成时间：2026-11-01
> 配套代码：`services/ingestion/`（本仓库内，已可运行）
>
> **一句话**：A 侧已全部落地并完成自测，**不需要 B/C 改任何一行就能跑通现有链路**。
> 下面 12 条是「不做也能演示、做了会更好」的增强项，按优先级排，每条都标了
> **谁改 / 改几行 / 不做会怎样**。请 B/C 认领，不认领的按「不做」处理，A 不等待。

---

## 0. A 已交付什么（先看清现状，避免重复讨论）

| 项 | 位置 | 状态 |
|---|---|---|
| 解析服务 | `services/ingestion/server.py` | 可运行，`python server.py --port 8000` |
| 依赖声明 | `services/ingestion/requirements.txt` | `pip install -r requirements.txt` |
| 渠道适配器 | `services/ingestion/adapters/` | 钉钉 / 微信 / 飞书 / pywxdump / 媒体解码 |
| AI 智能取数（方案 A） | `services/ingestion/ai_ingest/` | 5 工具 + agent loop，mock 可无凭证演示 |
| 测试 | `services/ingestion/tests/` | 12 套，全 PASS |
| 测试数据 | `services/ingestion/testdata/` | 构造数据（张三/王五催款场景），可提交 |

对外端点（**后 4 个是新增，前 4 个是原有，零改动**）：

| 端点 | 说明 | 谁在用 |
|---|---|---|
| `POST /parse` | 单文件 → `{evidence}` | B 的 `parser.ts` |
| `POST /parse_chat` | 聊天 JSON → `{evidences:[...]}` | A 的适配器 / 编排器 |
| `GET /files/<id>` | 超限原件下载 | C（可选） |
| `GET /health` | 健康检查 | 运维 |
| `GET /source/list` | 渠道列表 | **新增**，C 连接面板 |
| `GET /source/status` | 渠道授权状态 | **新增**，C 连接面板 |
| `POST /source/connect` | 探测/触发授权 | **新增**，C 连接面板 |
| `POST /source/sync` | AI 精准取数 → `{evidences:[...]}` | **新增**，C 连接面板 |

**契约不变量（A 保证，B 可放心依赖）**：`kind ∈ {text,chat,image,pdf}`；
`kind=image` 时 `content` 必为 `data:image/{png,jpeg,webp,gif};base64,...`；
`id/name/kind/mimeType/content` 五字段必填非空。

---

## 1. P0 · 会直接影响演示效果（建议本期做）

### P0-1　B 的 8MB 前置检查挡掉了 A 的大文件处理

- **现状**：`src/lib/ingestion/parser.ts:3` 常量 8MB，`:32` 的检查在 `:35` 的
  `if (serviceUrl) return parseRemotely(...)` **之前**执行。
- **影响**：>8MB 的文件经 B 转发时直接抛错，被 `parse/route.ts:27` 包成 **422**。
  A 侧「>100MB 只回链接 + 解释」的逻辑在这条链路上**永远走不到**。
- **建议（B，改 1 行）**：`MAX_FILE_SIZE` 从 8MB 提到 **20MB**。
  - 理由：本地 `npm run dev` 无平台上限；20MB 与演示材料量级匹配；语义清晰。
  - ⚠️ 若部署 Vercel：平台 **request body 上限 4.5MB** 在 B 的代码之前生效，
    改 100MB 也没用。那种形态下 >4.5MB 必须**直连 A**——A 已开 CORS（见 §3 第 6 条），随时可直连。
- **不做会怎样**：大附件场景演示不了「回链接」，但不影响小文件全链路。

### P0-2　B 转发时吞掉了 A 的错误正文

- **现状**：`parser.ts` 只抛 `证据解析服务返回 ${status}`，`parse/route.ts:27` 统一 422。
- **影响**：A 精心写的「单个文件不能超过 100MB（当前 101.5MB），请拆分后上传」
  在链路上全部丢失，用户只看到「上传失败」。
- **建议（B，约 5 行）**：`parseRemotely` 失败时把 A 的 JSON `error` 字段透传到 422 的响应体。
- **不做会怎样**：错误提示不友好，但功能可用。

### P0-3　B 不透传查询参数，`?source` / `?pages` / `?max_chars` 全失效

- **现状**：`parser.ts:16` 只拼 `${serviceUrl}/parse`，不带 query。
- **影响**：C 想标注「这条证据来自钉钉」或「只看 PDF 第 3 页」，经 B 转发时**静默失效**，
  且没有任何报错——这类问题在联调现场极难定位。
- **建议（B，约 3 行）**：把这三个参数从 `parse` route 透传给 A。
- **A 侧现状**：参数已实现且单测覆盖，直连 A 时完全生效。

---

## 2. P1 · 工程质量（有余力就做）

### P1-1　`parse` 的 abort 与 `maxDuration` 完全相等

- **现状**：`parser.ts:19` `AbortSignal.timeout(60_000)` = `parse/route.ts:5` `maxDuration = 60`。
- **影响**：两边同时到点，平台终止进程和客户端 abort 一起触发，应用层来不及返回干净 JSON，
  用户看到的是平台错误页而不是「解析超时，请拆分文件」。
- **建议（B，改 1 个数字）**：abort 设为 **55s**（同理 `analyze` 侧
  `openai-compatible.ts:60` 的 90s 与 `analyze/route.ts:7` 的 `maxDuration = 90` 也相等，建议 85s）。
- **附带**：`parse/route.ts:20` 是 `for (const file of files)` **串行**，
  单次最多 20 个文件共享同一个 60s 预算，不是每份 60s。多文件上传时容易整体超时。

### P1-2　`parser.ts` 只认单条 `evidence`

- **现状**：`:27` `EvidenceSchema.parse(result.evidence ?? result)`，写死单条。
- **影响**：A 的 `/parse_chat`（一次聊天 → chat + 多张独立图片）无法经 B 转发使用。
- **建议（B，约 10 行）**：若响应里有 `evidences` 数组则返回数组，否则保持单条（向后兼容）。
- **不做会怎样**：A 已用「多次调用 `/parse`」绕开，功能不缺，只是多几次 HTTP。

### P1-3　大附件的下载链接需要模型转述

- **现状**：A 对 >100MB 的附件返回 `kind=text`，content 里写清体积、原因和**下载链接**。
  但模型不会主动把链接说给用户。
- **建议（B，prompt 加一句，约 1 行）**：在 `src/lib/ai/prompt.ts` 补：
  > 若证据正文里出现「下载链接」，请将其原样告知用户，不要猜测文件内容。
- **不做会怎样**：用户拿不到链接，等于白给。
- **注**：`openai-compatible.ts:22` 已有「看不清的内容不要猜测」，图像侧的约束是够的，
  缺的只是链接转述这一条。

---

## 3. P2 · 产品形态（需要 B/C 拍板，A 不阻塞）

| # | 提案 | 归属 | 内容 | A 的备用方案（零契约改动） |
|---|---|---|---|---|
| 3-1 | 前端关联展示 | **C** | 图片/文件证据怎么挂到时间线上 | A 已在 chat 正文插内联标记 `[图片@t: 名 见独立证据]`，C 可直接文本渲染 |
| 3-2 | 关联/分组字段 | B + C | 是否给 `Evidence` 加 `groupId` / `relatedTo` | 不加也能跑，靠内联标记表达关联 |
| 3-3 | `doc` 原生 kind | A+B+C | Word/Excel 是否要有独立 kind | A 已降级 `kind=text`，格式靠 `name` 后缀体现 |
| 3-4 | 案件级分组 | A+B+C | 一次分析多份证据的分组协议 | 本期不做，多次上传即可 |
| 3-5 | source 词表 | B + C | 取值约定：`微信`/`钉钉`/`飞书`/`用户上传`/`mock` | 自由字符串，不碰 `contracts.ts` |
| 3-6 | 数据源连接面板 | **C 主负责** + B 桥接 | 见下 §4 | A 已提供 `/source/*`，C 不接即为死代码，零影响 |

---

## 4. 方案 B：数据源连接面板（跨团队，需认领）

A 已完成并冻结 `/source/*` 四个接口（契约见 §5）。要实现「前端点一下就同步聊天记录」，
还差两层：

| 层 | 归属 | 工作量 | 内容 |
|---|---|---|---|
| 桥接路由 `/api/source/*` | **B** | 约 30 行 | 把前端请求转发给 `INGESTION_SERVICE_URL`，带超时与错误处理 |
| 连接面板 UI | **C** | 约 1 个组件 | 渠道列表、授权状态、扫码提示、同步按钮、进度 |

**为什么不会崩**：前端与 A 之间只有 3 个硬编码调用点
（`investigation-workbench.tsx` 的 `/api/evidence/parse` 与 `/api/analyze`、
`parser.ts:16` 的 `${INGESTION_SERVICE_URL}/parse`），
**没有任何「遍历所有接口」的逻辑**——A 新开的 `/source/*`，C 不调就是死代码。

**唯一真正会报错的地方**：`parser.ts:27` 的 zod 严格校验。
sync 推来的 evidence 字段不齐必抛错。A 侧 `ai_ingest/evidence.py` 已按同一套约定产出并自校验
（`run_source_api_test.py` 逐条验过），此路已安全。

**建议发布顺序**：先冻结返回结构 → A 单独上线（已完成）→ C 之后再接。
期间前端完全无感。

---

## 5. 已冻结的 `/source/*` 契约（C 可直接照此对接）

```
GET  /source/list
     → { "sources": [
           { "id":"钉钉", "name":"钉钉", "auth":"dws 扫码登录",
             "authorized":true, "status":"ready",
             "last_sync":"2026-11-01 19:00:00", "count":128 } ] }

GET  /source/status?source=钉钉
     → { "source":"dingtalk", "authorized":true, "status":"ready",
         "detail":"dws 已登录 / 未安装 / token 过期",
         "last_sync":null, "count":0 }

POST /source/connect   {"source":"钉钉"}
     → { "source":"dingtalk", "authorized":false, "status":"need_auth",
         "action":"dws auth login", "hint":"请扫码授权后重试" }

POST /source/sync      {"source":"mock"}
     → { "source":"mock", "synced":6, "evidences":[ ...Evidence[]... ],
         "windows":3, "agent":"MockAgent" }
```

约束：

- 渠道名支持中英文别名（`钉钉`/`dingtalk`/`dws`、`微信`/`wechat`、`飞书`/`feishu`），归一到英文 id。
- `sync` 受 single-flight 锁保护，并发请求返回 **409 `{"status":"busy"}`**，不会二次执行。
- `sync` 产出的 `Evidence.source` 是**渠道名**，不会落回「用户上传」。
- 扫码类授权**必须人做**（`dws auth login`、微信密钥抓取），A 只做探测并返回 `need_auth + action + hint`，
  **不替用户完成授权**——这是授权机制决定的，不是实现偷懒。

验收（A 侧 12 套测试已覆盖，也可手工跑）：

```bash
cd services/ingestion
python server.py --port 8000 &
curl http://127.0.0.1:8000/source/list
curl "http://127.0.0.1:8000/source/status?source=%E9%92%89%E9%92%89"
curl -X POST http://127.0.0.1:8000/source/connect -H 'Content-Type: application/json' -d '{"source":"mock"}'
curl -X POST http://127.0.0.1:8000/source/sync    -H 'Content-Type: application/json' -d '{"source":"mock"}'
```

---

## 6. 环境配置（需要 B/C 知道的）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `INGESTION_SERVICE_URL` | 空 | 已在 `.env.example`，A 服务的基址；不设则 B 走本地解析 |
| `CORS_ALLOW_ORIGIN` | `*` | **新增**，A 侧 CORS。已全开，直连即可，通常无需改 |
| `MAX_CONTENT_SIZE` | 100MB | **新增**，A 侧唯一体积闸门，超限只回链接不拒收 |
| `PUBLIC_BASE_URL` | 按 Host 推断 | 超限附件的下载链接前缀 |

---

## 7. 决策表（请 B/C 填写后回传）

| # | 提案 | 归属 | 建议 | 决定（待填） |
|---|---|---|---|---|
| P0-1 | 8MB → 20MB | B | 做 | ☐ 做　☐ 不做　☐ 改直连 |
| P0-2 | 透传错误正文 | B | 做 | ☐ |
| P0-3 | 透传 query | B | 做 | ☐ |
| P1-1 | abort 55s / 85s | B | 做 | ☐ |
| P1-2 | `evidences[]` 批量 | B | 有余力做 | ☐ |
| P1-3 | prompt 转述链接 | B | 做 | ☐ |
| 3-1 | 媒体挂时间线 | C | 需拍板 | ☐ |
| 3-2 | `groupId` 字段 | B+C | 本期不做 | ☐ |
| 3-3 | `doc` kind | A+B+C | 本期不做 | ☐ |
| 4 | 连接面板 | C 主 + B 桥接 | 视排期 | ☐ |

---

## 8. A 不会做的事（已确认，避免重复讨论）

- **A5 聊天截图 OCR**：不做。视觉模型读中文聊天截图本就比 RapidOCR 准；
  转成 `kind=chat` 会让 `validate.ts:39` 从「豁免校验」变成「强制逐字命中」，
  OCR 的中文间空格会让整条 analyze 400；且 OCR 错字会被"校验通过"洗白，更危险。
- **改 `contracts.ts`**：不做。A 只用现有 4 种 kind + 内联标记表达一切。
- **改 B/C 的任何文件**：不做。本包只是建议，实际改动由 B/C 自行认领。
