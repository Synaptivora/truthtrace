# A 环节任务拆解 · 数据接入（低成本逐环节实现 + 测试）

> **📦 代码位置（2026-11-01 更新）**：A 的全部代码已提交进 `truthtrace` 仓库，位于
> `truthtrace/services/ingestion/`（`server.py`、`ai_ingest/`、`adapters/`、`tests/`、`testdata/`）。
> 本文里的 `a-ingestion/` 与 `a-ingestion-tests/` 是**早期草稿路径**，对应到仓库里就是
> `services/ingestion/` 与 `services/ingestion/tests/`。给 B/C 的改动建议统一收在
> `truthtrace/docs/A对BC的改动提案包.md`。


> 角色：**A（数据接入）**。目标：把用户上传的任意证据（文本 / 图片 / PDF / 聊天）转换成符合  
> `EvidenceSchema` 的标准化 `Evidence`，通过**独立解析服务** `POST /parse` 交给 B。  
> 本文把工作拆成 **A0–A7** 七个可独立实现、独立验证的小环节；每个环节都配了「成本最低」测试程序。

---

## 0. 必读：契约不变量（动了就破坏 B/C）

解析服务返回的 `evidence` 必须精确满足 `truthtrace/src/lib/contracts.ts` 的 `EvidenceSchema`：

| 字段         | 类型      | 约束                                               |
| ---------- | ------- | ------------------------------------------------ |
| `id`       | string  | 非空（建议 `uuid`）                                    |
| `name`     | string  | 非空（原始文件名）                                        |
| `kind`     | enum    | **只能是** `text` / `chat` / `image` / `pdf` 之一。语义 = 「B 的消费通道」，**不是来源平台**：微信/钉钉/飞书的聊天一律 `chat`，Word/Excel/PPT 抽文本后一律 `text`     |
| `mimeType` | string  | 非空                                               |
| `content`  | string  | 非空。`image` 放 `data:<mime>;base64,...`；其余放提取出的纯文本 |
| `source`   | string? | 选填，**来源渠道**（微信 / 钉钉 / 飞书 / 用户上传）；不表示文件格式，格式由 `name` 后缀 + `mimeType` 表达                                 |

- 服务返回形态：`{ "evidence": { ... } }`，字段名必须是 `evidence`（TruthTrace 的 `parser.ts` 用 `result.evidence ?? result` 取值）。
- **`kind` / `source` / `name` 三者正交**：`kind` 管「B 怎么消费」（文本 or 图像），`source` 管「从哪来」（平台），`name`+`mimeType` 管「原始格式」。三者不要互相顶替。
- **不要改 `contracts.ts` / `src/app/api/*` / `src/components/*`**；确需加字段时走 PR 并同步 B、C。
- 分支：`feat/ingest`。每个 PR 附 `npm run typecheck && npm run test`。

---

## 1. 技术栈建议（为什么选 Python，成本最低）

A 的服务是「外接服务」，仓库 Next.js 不限制其语言。建议 **Python + 标准库起步**：

- 骨架 / 文本 / 图片 / 聊天离线：纯标准库，**零依赖**。
- PDF：`pypdf`（纯 Python，体积小）。
- 扫描件 PDF：`pymupdf`（PyMuPDF）把页渲染成 PNG 走视觉通道。**不做本地 OCR**（A5 已决策不做，理由见下文 A5 小节）。
- 微信 MCP：工作区 `wechat-mcp-tools/` 全是 Python，直接复用。
- 契约测试：本目录 `check_evidence.py`，纯标准库。

> 若团队坚持统一 TS，可用 Node + `formidable`/`busboy` + `pdf-parse`，思路完全一致。

---

## 2. 共享测试桩（每个环节都用它）

文件：`a-ingestion-tests/check_evidence.py`（纯标准库，零依赖，可离线）。

```bash
cd a-ingestion-tests

# 0) 自检校验器本身（零网络）
python check_evidence.py --self-test

# 1) 离线校验本地 JSON（支持 {evidence:{...}} 或直接是 evidence 对象）
python check_evidence.py --file some_evidence.json --expect-kind chat

# 2) 向运行中的服务 POST 文件，校验返回
python check_evidence.py --url http://localhost:8000/parse --upload sample.pdf --expect-kind pdf
```

退出码：`0`=通过，`1`=失败，`2`=用法错误，可直接塞进循环批量验证。

---

## 2.1 媒体支持矩阵（聊天内容 × 支持情况）

| 聊天内容形式                 | 建议产出 (Evidence.kind)                      | 当前支持状态       | A 怎么产出                                           | 是否需与 B/C 对齐  | 说明                                                                                       |
| ---------------------- | ----------------------------------------- | ------------ | ------------------------------------------------ | ------------ | ---------------------------------------------------------------------------------------- |
| 纯文本消息                  | `chat`                                    | 直接支持         | A4 把 `{seq,sender,time,text}` 拼成对话文本             | 否            | 零依赖，直接进一条 chat 证据                                                                        |
| 图片（截图/证件照/转账截图）        | `image`（独立证据）                             | 直接支持         | 复用 A2：base64 data URL                            | 否（关联靠内联标记）   | B 视觉模型直接消费；chat 文本插 `[图片@时间]` 关联                                                         |
| PDF 文档                 | `pdf`（独立证据）                               | 直接支持         | 复用 A3：抽文本；扫描件渲染成 PNG 走 `image`                   | 否            | 文本型 PDF 抽文本；扫描件由 PyMuPDF 渲染首屏给视觉模型（需装 `pymupdf`）                                            |
| 其他文档（Word/Excel/PPT 等） | `text`（`docx/xlsx/pptx` 抽文本）或 `image`（转图） | **直接支持（A8）** | `docx/xlsx/pptx` 抽纯文本当 `text`；复杂排版表格可转图当 `image` | **否**        | B 对非 `image` 一律当文本喂模型，抽文本即 `text` 即可原生态接住；**无需加 kind、无需 B 改代码**（加原生 `kind` 只是分类标签优化，非必须） |
| 语音消息                   | `chat`（转写后文本）+ 内联标记                       | 暂不支持→条件      | 需接语音转写（如 whisper）再当文本                            | 是（转写工具 + 约定） | 契约无语音 `kind`；转写后按文本 + `@时间` 处理                                                           |
| 红包 / 转账                | `chat` 文本备注                               | 条件支持         | 转成 `[转账 ¥500 @未知时间]` 文本                          | 否（约定格式）      | 微信红包/转账常无时间戳；作金额证据保留                                                                     |
| 链接 / 卡片（钓鱼等）           | `text` / 并入 chat                          | 直接支持         | 当文本或并入对话文本                                       | 否            | 本质是 URL 文本                                                                               |
| 表情 / 系统消息              | 忽略或文本占位                                   | 条件支持         | 忽略或轻量占位                                          | 否            | 一般无调查价值                                                                                  |

> 两个全局限制（与内容形式无关）：① B 的 `parser.ts` 写死单条 `result.evidence`，不支持一次返回多条；  
> ② `Evidence` 无"归属对话/分组"字段。前者可多次上传绕过，后者靠内联标记。详见《契约与接口扩展提案》。

### 2.1.1 三个平台适配器与「用户直接提供」通道

矩阵说明的是**内容形式**，但真实输入有三条来源通道，它们的 `source` 判定规则不同，必须分清：

| 通道 | 谁在跑 | 产物形态 | `source` 怎么定 | 实测 |
|---|---|---|---|---|
| 平台适配器 | `wechat_aimemory_to_synapse.py`（微信）/ `dingtalk_to_synapse.py` / `feishu_to_synapse.py` | `<会话名>.json` 信封 `{source, messages[]}` + `<会话名>.records.json` 裸数组 | 适配器**显式**传 `source`（微信/钉钉/飞书），信封里也写一份 | 钉钉 6 条消息 → chat + image 两条，source=钉钉 ✅ |
| 用户直接提供（文件） | C 上传 → B 转发 → `/parse` | 原始文件 | 无信封 → `用户上传`；带信封（`{"source":"钉钉"}`）→ 识别为 `钉钉` | 上传钉钉信封 `.json` → source=钉钉 ✅ |
| 用户直接提供（手存文本） | 直接 `/parse`，可选 `?source=` | `.txt` 对话稿 | 文件名里的平台名**不**当作来源；要标平台须调 `?source=` | `/parse?source=钉钉` → 钉钉 ✅ |

- 三条通道**共用同一套 `kind`**：平台差异只写在 `source`，不新增 `kind`。
- 适配器产出的 `.json` 信封可直接投 `/parse_chat`（它既认 `records` 也认 `messages`，并读信封里的 `source`），媒体证据会继承同一个平台标签。
- `?source=` 是给「手存文本、没有信封」的场景兜的：不传就老实标 `用户上传`，**不猜平台**——猜错会让 C 的溯源 chip 显示假来源。

## 2.2 责任划分（A 单方 vs 多环节联动）

**A 单方能直接解决（不碰契约 / 不碰 B/C 代码）**：

| 问题                          | A 的解法                                                       | 状态               |
| --------------------------- | ----------------------------------------------------------- | ---------------- |
| 聊天图片/文件被丢掉                  | A4 媒体感知：图片→独立 `image`（复用 A2），文件→独立 `pdf`（复用 A3）             | 已落地              |
| 图片/文件与对话无关联                 | chat 文本内联标记 `[图片@t]` / `[文件:xx@t]`，媒体证据带 `time`/`source`    | 已落地              |
| 非 PDF 文档（docx/xlsx/pptx）当乱码 | A8 抽文本当 `text`（python-docx/openpyxl/python-pptx，可选依赖）       | 已落地（A8）          |
| 红包/转账无时间戳                   | 转文本备注 `[转账 ¥500 @未知时间]`                                     | 已落地（约定格式）        |
| 语音无承载                       | A 接 whisper 转写→文本+`@时间`（内联标记）                               | 待做（需转写工具，A 侧可完成） |
| A1/A2/A3 文本·图片·PDF          | 已实现并实测通过                                                    | 已完成              |
| 离线测试桩 + 样例                  | `check_evidence.py` + `chat_sample.json` + `run_a4_test.py` | 已完成              |

**必须多环节联动（A 不能单方面改，走 PR 同步）**：

| 问题                                    | 涉及方                 | 需做的动作                                              | 为什么必须一起                                     |
| ------------------------------------- | ------------------- | -------------------------------------------------- | ------------------------------------------- |
| 契约加"关联/分组"字段（如 `groupId`/`relatedTo`） | A + B + C           | 改 `contracts.ts`，PR 同步                             | B 的 Zod 校验、C 的展示都依赖它                        |
| 批量返回 `evidences[]` 接口                 | A + B（+C 前端）        | B 改 `parser.ts` 支持数组，或约定多次上传                       | 改的是 B 的代码                                   |
| 非 PDF 文档原生 `kind`（分类标签）               | A + B + C（可选优化，非必须） | 想让 B/C 按 `docx`/`xlsx` 等原生类型展示/分析时加；默认用 `text` 已足够 | 默认 `text` 已能交给 B 分析，仅在「分类展示/针对性分析」有需求时才需三方动 |
| 前端关联展示（图挂时间线）                         | C（依赖 A 的标记 / B 的数据） | C 实现对话-媒体对应展示                                      | C 的前端职责                                     |
| 案件级证据分组 / 上传协议                        | A + B + C           | 约定多证据如何组织、上传                                       | 涉及前后端整体协议                                   |

> 凡是用"现有 4 种 kind + 内联标记 + 独立证据"能表达的，全是 A 的事，现在就能做；  
> 凡是要"给 Evidence 加字段 / 改 B 的接口 / 改 C 的展示 / 定前后端协议"的，必须发起提案、三方对齐、走 PR。  
> 提案文档：[`A契约与接口扩展提案.md`](./A契约与接口扩展提案.md)。

## 3. 任务拆解

### A0 · 服务骨架与契约校验（先把接口跑通）

- **目标**：搭独立 HTTP 服务，暴露 `POST /parse`，接收 `multipart/form-data` 字段 `file`，先「原样 echo」成一个合法 `Evidence` 返回 `{evidence}`。后续每个环节只是替换「如何生成 content/kind」。
- **交付**：可启动的服务 + `/parse` 端点；把地址填进 TruthTrace 的 `.env.local` 的 `INGESTION_SERVICE_URL`。
- **验收**：任意文件上传都返回 200 + 合法 `Evidence`。
- **低成本测试 T0**：
  ```bash
  python check_evidence.py --self-test
  # 起服务后（假设监听 8000）：
  python check_evidence.py --url http://localhost:8000/parse --upload ../wechat-mcp-tools/sample_data/raw_sample.txt
  ```
- **依赖/成本**：**零依赖**（Python `http.server` 即可）。无需模型、无需真机。
- **备注**：骨架建议用一个简单路由：`evidenceKind(file)` 判断类型 → 调对应 handler → 包成 `{evidence}`。把 `evidenceKind` 逻辑先写成和仓库 `parser.ts` 一致。

---

### A1 · 文本类 text

- **目标**：`txt/md/json/csv/log` 及 `text/*` → `kind="text"`，`content` = 文件文本。
- **交付**：文本 handler（A0 骨架里的一个分支）。
- **验收**：返回 `kind=text`，`content` 含原文件全文、非空。
- **低成本测试 T1**：
  ```bash
  python check_evidence.py --url http://localhost:8000/parse \
      --upload ../wechat-mcp-tools/sample_data/raw_sample.txt --expect-kind text
  ```
- **依赖/成本**：**零依赖**（`file.read().decode()`）。
- **备注**：编码兜底（utf-8 / gbk），避免中文文件解码崩。

---

### A2 · 图片类 image

- **目标**：图片 → `kind="image"`，`content="data:image/<png|jpeg|webp|gif>;base64,<...>"`。把仓库 `parser.ts` 已有逻辑迁到服务。
- **交付**：图片 handler。
- **验收**：返回 `kind=image`，`content` 是**视觉模型能吃的**图片 data URL（base64 可解码）。
- **低成本测试 T2**：用任意 png/jpg（或自己截一张）：
  ```bash
  python check_evidence.py --url http://localhost:8000/parse --upload ./sample.png --expect-kind image
  ```
- **依赖/成本**：**零依赖**（`base64` 标准库）；bmp/tiff 转码用 Pillow（已装，可选）。
- **⚠️ 硬不变量**：B 会把 `kind=image` 的 content **原样当 image_url** 发给视觉模型，所以 content 只能是
  png/jpeg/webp/gif 的 data URL。bmp/tiff 用 Pillow 转 PNG；svg 等转不了的一律**降级 `kind=text`**，
  绝不硬塞——否则模型 API 报错、整个 analyze 502。
- **备注**：大小限制沿用仓库 8MB；超大图可压缩后再转 base64（压缩库可选，非必需）。

---

### A3 · PDF 类 pdf（先支持「可提取文本」的 PDF）

- **目标**：`application/pdf` → `kind="pdf"`，`content` = 抽取出的文本；扫描件（无文本层）**渲染成 PNG** 走 image 通道，渲染不了则安全降级 `text`。
- **交付**：PDF handler（文本抽取依赖 `pypdf`；扫描件渲染依赖 `pymupdf`）。
- **验收**：文本型 PDF 返回 `kind=pdf`，`content` 含正文关键词；扫描件返回 `kind=image` 且是**合法 PNG data URL**（多页时 name 标 `[仅第 N 页 / 共 M 页]`）；只有渲染失败才降级 `kind=text` 说明。
- **低成本测试 T3**：
  ```bash
  python -m pip install -r a-ingestion/requirements.txt   # pypdf + pymupdf + Pillow + office 三件套
  python a-ingestion-tests/run_scan_pdf_test.py           # 扫描件专项：渲染 / 多页标注 / ?pages / 文本型不误伤 / 损坏降级
  python a-ingestion-tests/check_evidence.py --url http://localhost:8000/parse --upload ./sample.pdf --expect-kind pdf
  ```
- **依赖/成本**：`pypdf` + `pymupdf` 均必需（清单见 `a-ingestion/requirements.txt`）。
- **⚠️ 版本坑（本机实测）**：`pymupdf 2.0` 在 Windows + Python 3.14.3 上 `import pymupdf` 直接 **SIGSEGV（段错误）**。段错误不是 `ImportError`，`try/except` 兜不住，会打死**整个服务进程**——比不装更危险（不装只是优雅降级成 text 说明）。因此锁 `>=1.24,<2.0`，实测 `1.28.2` 正常。
- **备注（已落地）**：`build_pdf_evidence` 用 `pypdf.PdfReader` 逐页抽文本并拼接；抽取为空时——pypdf 未装则抛 `RuntimeError`（接口 500 提示安装），pypdf 已装则判定为扫描件：
  - `pymupdf` 可用 → `render_pdf_page_png()` 按 `zoom=2.0` 渲染指定页（默认第 1 页，`?pages=N` 可换），返回 `kind=image` + `data:image/png`，视觉模型可直看。实测 600×800 的页渲染成 **1200×1600 PNG，约 9KB**。
  - 渲染失败（未装 / 加密 / 损坏）→ 返回 `kind=text` 说明，并明确要求模型「不要猜测文件内容」。
  - 代码优先 `import pymupdf`，老版本回退 `import fitz`（1.24+ 起 `fitz` 只是弃用别名，1.28 会往 stderr 打警告）。

#### A3-b · 大文档预算裁剪（几百页 PDF，已落地）

- **为什么必须做**：B 对 `content` 长度**没有任何限制**，全量拼进 prompt。实测 300 页文本型 PDF → content **766,721 字符 ≈ 48 万 token**：90 秒超时必挂、换 128k 窗口模型直接 `context_length_exceeded`、模型也抓不住重点。
- **怎么做**：单条证据正文预算默认 **30,000 字符**（`MAX_CONTENT_CHARS` 可调），超预算时做**页级**取舍：
  1. 全文 ≤ 预算 → **原样透传**（小文档行为完全不变，不加任何标记）
  2. 超预算 → 首页（标题/当事人）+ 末页（落款/签字/日期）必留
  3. 剩余预算按**反诈关键词得分**优先装高分页（转账/金额/卡号/身份证/合同/承诺/诈骗…）
  4. 还有余量 → 未选页里**均匀采样**补足，避免只留下开头几页
  5. 预算比单页还小 → 保留首页前 N 字符并标注截断，**绝不返回空 content**
- **铁律：只按整页取舍，绝不改写原文。** B 的 `validate.ts` 要求「非 image 证据的引文必须能在 content 中逐字找到」，改写会让所有引用失效。页标记 `--- 第 N 页 ---` 只在裁剪时插入。
- **可选参数**（不带即默认，C 现有调用零影响）：
  - `?pages=100-120` — 只看指定页范围（此时按页码**顺序连续**取，不跳跃采样）
  - `?max_chars=8000` — 自定义预算
- **扫描件大 PDF**：几百页不可能全渲染，只渲染一页（默认第 1 页，`?pages=N` 可指定），并在 `name` 标注 `[仅第 3 页 / 共 300 页]`。
- **文件大小上限**：**100MB**（`MAX_CONTENT_SIZE` 可调）。≤100MB 一律正常解析（页级预算仍生效），>100MB 只回链接 + 解释，见 A9。
- **低成本测试 T3-b**：`a-ingestion-tests/run_pdf_budget_test.py`（造 300 页 PDF，验证预算、关键页保留、原文未改写、页码范围、兜底非空）
  - **绝不把 `data:application/pdf` 当 image 发出去**（视觉模型不收 PDF，会让整个 analyze 502）。

---

### A4 · 聊天类 chat（媒体感知版，离线 / 样例优先，无需真机）

- **目标**：把聊天记录转成 `kind="chat"` 证据，**并感知其中的图片/文件/语音/转账**：
  - 文本 / 系统消息 → 进对话文本；图片 / 文件 → 各自产出**独立** `image` / `pdf` 证据；转账 / 语音 → 进对话文本并加标记。
  - 输入格式（A 侧约定，兼容 `synapse_wechat_ingest` 的 `[{seq,sender,time,text}]` 并扩展 `type/media/amount`）：见 `a-ingestion/server.py` 的 `_coerce_record`。
  - **内联标记约定**（A 侧，便于 B/C 理解，不强制改契约）：  
    `[图片@时间: 名 见独立证据]`、`[文件:名@时间 见独立证据]`、`[转账 ¥x@时间]`、`[语音@时间]`。
- **交付**：
  - `POST /parse` 上传聊天 JSON → 返回**单条** `chat` 证据（含内联标记），**B 当前直接兼容**。
  - `POST /parse_chat` 返回 `{evidences:[chat, 独立image/pdf...]}` bundle（A 侧扩展，需 B 改 `parser.ts` 支持数组，见《契约与接口扩展提案》）。
- **验收**：返回 `kind=chat`，`content` 含对话、说话人被保留、媒体处有内联标记。
- **低成本测试 T4（已落地，可复跑）**：
  ```bash
  # 启动服务后（假设 8000）：
  python ../a-ingestion-tests/check_evidence.py \
      --url http://localhost:8000/parse --upload ../a-ingestion-tests/chat_sample.json --expect-kind chat
  python ../a-ingestion-tests/check_evidence.py \
      --bundle-url http://localhost:8000/parse_chat --chat-file ../a-ingestion-tests/chat_sample.json --expect-kinds chat,image
  # 或一键回归（含 A1/A2 回归）：python ../a-ingestion-tests/run_a4_test.py
  ```
- **依赖/成本**：**零依赖**（纯字符串拼接 + 标准库）。**无需 Windows / 微信**，用 `a-ingestion-tests/chat_sample.json` 即可开发联调。
- **备注**：A6 真机取数后直接复用本环节逻辑（`type/media` 由 `synapse_wechat_ingest` 归一化产出即可）。媒体感知属 A 单方能力，已落地；是否"一次返回多条"是否启用 `/parse_chat` 取决于提案二的对齐结果。
- **多来源（source）**：`source` 只表示来源渠道（微信 / 钉钉 / 飞书 / 用户上传），**不表示文件格式**（格式由 `name` 后缀 + `mimeType` 表达）。`/parse_chat` 支持 `source` 入参（默认「微信」，媒体证据继承）；`/parse` 上传钉钉/飞书信封（`{"source":"钉钉","messages":[...]}`）会自动识别来源。钉钉适配器见 `dingtalk_to_synapse.py`；飞书需新建 `feishu_to_synapse.py`，只要输出同样的 `{seq,sender,time,text,type,media,amount}`，A4/B/C 零改动。实测：`a-ingestion-tests/run_source_test.py`。

---

### A5 · 聊天截图 OCR —— ❌ 已决策不做（2026-11-01）

> **结论：所有图片（含聊天截图）一律当 `kind="image"` 交给 B 的视觉模型，A 不接本地 OCR 引擎。**
> 本节留档是为了避免后续再被当成待办重开——要重启，先推翻下面四条理由。

**决策理由（按权重排序）**

1. **视觉模型本来就比 OCR 准。** B 走 `image_url` + `detail:"high"`，多模态模型读中文聊天截图（深色模式、小字号、表情混排、气泡版式）强于 RapidOCR。在这件事上，OCR 是**降级**而不是增强。
2. **OCR 会砸掉现有链路。** `validate.ts:44` 对 `kind !== "image"` 强制逐字命中。截图一从 `image` 转成 `chat`，就从"豁免校验"变成"必须逐字命中"；而 OCR 文本的典型特征是**中文之间插空格**（`3 月 1 号 转 账 5000`），模型引用时通常写成 `3月1号转账5000` → `includes()` 失败 → analyze 返回 400 → **整个分析失败**。
3. **OCR 的错误无法被校验出来。** 校验只验"引文在 content 里"，不验"content 本身对不对"。OCR 把 `50000` 认成 `5000`，模型照抄反而顺利通过，错误被"校验通过"洗白，比不校验更危险。
4. **成本不成比例。** `rapidocr-onnxruntime` 实测会拉入 onnxruntime 1.31.1 + opencv-python 5.0.0.93 + numpy + shapely + pyclipper，约 **+110MB**；收益只有"引文可校验"一项，且被第 3 条抵消大半。

**这个缺口怎么补（不写代码）**

- 该修的是 **B 的 prompt**，不是 A 的代码：要求模型在截图不清晰时明确写"无法确认"，而不是推断一个具体金额。一行字，收益大于整个 A5。
- 别把"扫描件 PDF"混进来：那是**另一条独立通道**（PyMuPDF 渲染 PNG → `kind=image` → 视觉模型），不依赖任何 OCR 引擎，已落地。

**什么情况下值得回头做**

- 演示形态改成"截图是唯一输入"，且视觉模型在真实截图上被证实读不准；
- 或 B 愿意改 `validate.ts`，允许"OCR 软校验"（不匹配时降级为警告而非抛错）。
- 两条都不满足时，A5 的净收益为负。

**调研备忘（做过，不是没查）**

- 依赖可装：Python 3.14.3 下 `pymupdf 2.0`、`rapidocr-onnxruntime 1.2.3`、`onnxruntime 1.31.1` 全有轮子（`pip install --dry-run` 实测）。
- 分流判据已设计未实现：有效行 ≥3、说话人前缀行占比 ≥40%、高置信行占比 ≥50%，不达标退回 `image`。
- 适用范围很窄：只有"聊天对话截图"值得 OCR；转账凭证、银行流水、图文混合类必须保留 `image`（版式和位置本身就是证据）。

---

### A6 · 微信真机取数（Windows + 微信 4.x，已落地：wechat-ai-memory 单源）

> ⚠️ 本节已按实测结果改写。原计划的 `wechat-mcp-tools/synapse_wechat_ingest.py` 路线**不可用**（新版微信退化为 OCR，失准），PyWxDump 亦已失效（4.x 无偏移 + 上游删库）。完整论证见 `微信端选型结论.md`。
>
> 📄 **字段映射表、媒体矩阵、11 条踩坑清单、端到端可复现命令**见 `微信端接入设计.md`（本文只留任务口径）。

- **目标**：真机用 **wechat-ai-memory** 导出 Version 1 JSON + `_assets` → 适配器归一化 → `POST /parse_chat` → `kind="chat"` 证据。
- **交付**（均已落地，位于项目总文件夹）：
  - `wechat_aimemory_to_synapse.py`：Version 1 JSON → `[{seq,sender,time,text}]`，支持 `--post`；含类型纠正（`type=49` 读 XML `<type>`，仅 6 为真文件）
  - `wechat_voice_transcribe.py`：SILK → WAV → faster-whisper 本地转写（锁简体 prompt）
  - `wechat_key_cache.py`：数据库密钥缓存运维（首次扫码后不再重启微信）
- **验收**：✅ 真机通过。文字 34 / 图片 5 / 语音 8 / 真实文件 2 → `/parse_chat` 产出 chat + 图片 + 文档证据（`.doc` 抽出 9346 字正文）。
- **可复跑流水线**：
  ```bash
  P=<wam_probe>/venv/Scripts/python.exe
  $P <wam_probe>/prime_key_cache.py          # 仅首次：取密钥并写缓存
  $P <wam_probe>/export_target.py --conv "会话名"   # 导出 Version 1 JSON + _assets
  python wechat_aimemory_to_synapse.py .wam_test/cache_export.json --out synapse_input \
    --post http://127.0.0.1:8000/parse_chat
  ```
- **依赖/成本**：Windows 10/11 + 微信 4.x（本机 4.1.15.56）；独立 Python 3.10~3.13 venv（`ctranslate2` 无 3.14 轮子），需 `frida pycryptodome zstandard Pillow pywinauto openpyxl olefile pysilk(silk-python) faster-whisper`。
- **备注**：
  - 首次取数据库密钥会关闭并重启微信、需手机确认；**加缓存后仅首次需要**，之后导出完全不碰微信（微信关闭也能读库）。
  - 单次导出约 10–15 秒；语音转写另计（medium 模型约 7 秒/条）。
  - `_assets` 与 `.wam_test` 含真实聊天内容，属受控位置，勿提交仓库。

---

### A6-b · 钉钉 / 飞书适配器（同一套信封规范，已落地）

> 📄 **完整实现依据**：`钉钉端接入设计.md`（dws 三条取数命令、时间锚点扫描、类型推断优先级、媒体三通道分流、13 条坑清单）。本节只留任务口径。

- **目标**：把钉钉、飞书的原生导出（`dws` / 飞书开放平台 JSON）归一化成与微信完全一致的 `[{seq,sender,time,text,type,media,amount}]`，**一套 A4 代码吃三端**。
- **交付**（位于项目总文件夹）：
  - `dingtalk_to_synapse.py`：`dws chat message list -f json` → `<会话名>.json` 信封 `{source:"钉钉", messages[]}` + `<会话名>.records.json` 裸数组；媒体走 `dws chat message download-media`（图片/语音/视频）与 `dws drive download`（文件），失败降级为 `[文件:xxx@时间]` 占位。
  - `feishu_to_synapse.py`：飞书导出 JSON → 同款信封与 records，`source="飞书"`。
- **关键设计**：**平台差异只写在 `source`，不新增 `kind`**。三端聊天一律 `kind="chat"`，媒体仍是独立 `image`/`pdf` 证据并继承同一 `source`——所以 B/C 零改动。
- **验收（已实测）**：
  - 钉钉 6 条消息（含 1 张图）→ `/parse_chat` 返回 2 条证据：`chat(source=钉钉)` + `image(source=钉钉)`。
  - 钉钉信封 `.json` 直接投 `/parse` → `kind=chat, source=钉钉`；投 `/parse_chat` 同样保得住 `source`。
  - 飞书 7 条消息 → 同结构，`source=飞书`。
- **低成本测试（已落地，可复跑）**：
  ```bash
  python a-ingestion-tests/run_multiplatform_test.py   # 三端 source + 媒体继承 + 无信封不猜平台
  python a-ingestion-tests/run_source_test.py          # source 语义 14 项断言
  ```
- **备注**：钉钉媒体下载依赖官方 `dws` CLI 已登录；`--no-download-media` 可只取文本。三端适配器都不进 `truthtrace` 仓库，产物落 `synapse_input/`。

---

### A8 · 其他文档（docx / xlsx / pptx → text）【新增，已落地】

- **目标**：`.docx` / `.xlsx` / `.pptx` 等 OOXML 文档 **不能当纯文本解码**（本质是 zip，会出乱码）。把它们抽成纯文本、当 `kind="text"` 交给 B —— **B 对非 `image` 证据一律当文本喂模型**（`openai-compatible.ts` 第 26–36 行），所以零契约改动、B 原生态接住，**不需要加新 `kind`、不需要 B 改代码**。
- **交付**：`server.py` 的 `extract_office_text()` + `build_evidence` 的 `text` 分支路由（docx→段落文本、xlsx→逐 sheet 行列文本、pptx→逐页文本）。
- **验收**：三类文档返回 `kind=text`，`content` 含正文，非乱码。
- **低成本测试 T8（已落地，可复跑）**：
  ```bash
  python -m pip install python-docx openpyxl python-pptx   # 唯一新增依赖（用运行服务的同一 python 装）
  # 起服务后（假设 8000）：
  python ../a-ingestion-tests/check_evidence.py --url http://localhost:8000/parse --upload ./sample.docx --expect-kind text
  python ../a-ingestion-tests/check_evidence.py --url http://localhost:8000/parse --upload ./sample.xlsx --expect-kind text
  python ../a-ingestion-tests/check_evidence.py --url http://localhost:8000/parse --upload ./sample.pptx --expect-kind text
  ```
- **依赖/成本**：**三个可选库**（纯 Python）。未安装时接口返回 `500` 并清晰提示安装命令，不会静默产出乱码。
- **备注**：
  - 纯文本类（`csv/json/md/log`、老版 `.doc`/`.xls` 二进制、无扩展名）仍走 `decode_text`，不受影响。


- 复杂排版/合并单元格的表格，抽文本会丢结构——**此时可转成图片当 `kind=image`**（B 用视觉模型看更准，需 libreoffice 或渲染库），留作 A8 后期增强，非必需。
- 这一节直接回应「Word/Excel 能不能直接给 B」：**能，且 A 单侧即可完成，零联动。**

---

### A9 · 超大附件闸门（>100MB 不读内容，只回链接 + 解释）【已落地】

- **背景**：B 对 `content` 长度零限制，一份 6000 段 Word 抽出 **82.6 万字符**（约 55 万 token），既超时又让模型"中段失明"（lost in the middle：开头/结尾召回 90–99%，中段只有 40–70%）。但这个问题**主要由字符预算解决**（`MAX_CONTENT_CHARS`，默认 3 万字），不需要再按体积二次拦截。
- **目标**：只留一道体积闸门——超过 100MB 就不再读内容，但**原件仍可获取**。
- **设计（关键：URL 是给人看的，不是给模型读文件的）**：

| 条件 | 行为 |
|---|---|
| **单份附件** > 100MB（`MAX_CONTENT_SIZE`） | **完全不读**（不抽文本、不做 OCR、不渲染），`kind=text`，content 写「体积 + 原因 + 下载链接」；**HTTP 200，不拒收** |
| ≤ 100MB | 正常流程：扫描件渲染成图给视觉模型、文本型 PDF 抽文本、office 抽正文、纯文本直接读；输出再按字符预算裁剪 |

- **为什么不拒收（没有 413）**：用户要的是"原件仍拿得到"。413 会让用户一无所获；落盘 + 回链接既保留原件，又给模型可转述的内容。这也是原始需求的原话：**"大于 100MB 就不管文档内容了，直接只传递 url 和解释"**。
- **口径**：阈值只量解析出来的 `file` 字段字节数，**请求体不设上限**。按 `Content-Length` 卡会把"正好 100MB 的文件"误杀，且约束对象变成"一次 HTTP 请求"而不是"一个附件"。
- **≤100MB 一律解析的代价（实测）**：文本型 PDF 抽取约 **0.9 ms/页**（800 页 0.73s）；扫描件抽不出文本、只渲染 1 页。真正的成本在渲染与预算，两者都有独立开关（`?pages`、`?max_chars`）。
- **验收**：超限文件 `kind=text` + 可点击链接 + HTTP 200；链接可下载且字节一致；目录穿越被拒；阈值内文件照常解析。
- **测试 T9（已落地，可复跑）**：
  ```bash
  python a-ingestion-tests/run_size_gate_test.py   # 闸门行为（缩放阈值 1MB）
  python a-ingestion-tests/run_file_gate_test.py   # 单阈值 / 无拒收 / 请求体不设限 / 边界不误杀
  ```
- **踩过的坑（都已在代码里修）**：
  1. **URL 里不能放中文文件名**：中文会让链接变成非 ASCII，HTTP 客户端直接抛 `UnicodeEncodeError`。改为存储名 `<uuid12>.<ext>`（纯 ASCII），原名写进同名 `.name` 旁注文件，下载时还原。
  2. **别按请求体判断体积**：multipart 请求体必然大于文件本身，"正好 100MB" 的合法文件会被误拒。
  3. **别设第二道 20MB 闸门**：一度加过 20MB「不解析」层，属于过度设计——字符预算才是控制上下文的手段，按体积二次拦截会让 20–100MB 的正常文档无谓失去解析机会。
- **附带修复**：MIME 报 `application/octet-stream` 时按**文件头魔数**兜底（`%PDF` / `\x89PNG` / `\xff\xd8\xff` / `GIF8` / `RIFF..WEBP`）——否则 PDF 会被判成 `text`，几十 MB 二进制直接倒进 content。
- **联动项**：模型不会自动转述链接，需 B 在 prompt 加一句（见《契约与接口扩展提案》提案六）；B 转发前的 8MB 前置检查会挡住这道闸门（见《A与C衔接方案》§2.4）。


---

### A7 · 集成联调与交付（端到端）

- **目标**：把服务地址配进 TruthTrace `.env.local` 的 `INGESTION_SERVICE_URL`，跑通「上传 → 解析 → B 分析 → C 展示」全链路；写运行说明；提 `feat/ingest` PR。
- **交付**：可运行的服务 + 一份「如何启动服务 / 如何配置 INGESTION_SERVICE_URL」说明。
- **验收**：TruthTrace 前端上传 text/image/pdf/聊天，四种都能解析并被 B、C 正常消费。
- **低成本测试 T7**：
  ```bash
  # 1) 起你的服务（假设 8000）
  # 2) 起 TruthTrace
  cd ../truthtrace && npm install && npm run dev
  # 3) 浏览器打开 http://localhost:3000，逐个上传四类文件验证
  # 4) 确认未破坏 B 的契约测试：
  npm run typecheck && npm run test
  ```
- **依赖/成本**：需要 Node 环境跑 TruthTrace（团队已有），无需额外。
- **备注**：PR 描述写清「接入了哪些类型、服务如何部署」；附 `typecheck && test` 结果；不提交 `.env`/`node_modules`/`.next`。

---

## 4. 总体验收清单（逐环节勾选）

- [x] A0 服务骨架 + `/parse` 返回合法 `Evidence`（`--self-test` 通过）
- [x] A1 文本 → `kind=text`
- [x] A2 图片 → `kind=image`（base64 data URL）
- [x] A3 PDF（文本型）→ `kind=pdf`
- [x] A4 聊天（媒体感知）→ `kind=chat` + 独立 image/pdf（无需真机）
- [x] A8 其他文档（docx/xlsx/pptx）→ `kind=text`（零联动，B 原生态接住）
- [x] A5 聊天截图 OCR → **不做**（截图一律走 `kind=image` 交视觉模型，理由见上；扫描件 PDF 的 image 通道另行修复）
- [x] A6 微信真机 → `kind=chat`（wechat-ai-memory 单源，文字/图片/语音/文件全通）
- [ ] A7 端到端联调 + `feat/ingest` PR（`typecheck && test` 绿）

## 5. 进度记录

| 环节 | 状态 | 完成日期       | 备注                                                                      |
| -- | -- | ---------- | ----------------------------------------------------------------------- |
| A0 | ✅  | 2026-11-01 | 骨架+接口+契约+类型路由（a-ingestion/server.py）                                    |
| A1 | ✅  | 2026-11-01 | 文本零依赖解析，随 A0 骨架落地                                                       |
| A2 | ✅  | 2026-11-01 | 图片 data URL；bmp/tiff 转 PNG，svg 等降级 text（守住视觉通道合法性）                              |
| A3 | ✅  | 2026-11-01 | pypdf 抽文本；扫描件由 **`pymupdf`（锁 `<2.0`）** 渲染成 PNG 走 `image`（多页标 `[仅第 N 页 / 共 M 页]`、`?pages` 可换），实测 600×800 页 → 1200×1600 PNG；渲染失败才降级 text；**A3-b 大文档预算裁剪**（默认 3 万字，首页末页+关键词页+均匀采样，整页保留不改写）；依赖清单入 `requirements.txt`，专项测试 `run_scan_pdf_test.py` |
| A4 | ✅  | 2026-11-01 | 媒体感知版：内联标记 + 独立图像/文档证据；/parse 单条 + /parse_chat bundle                   |
| A8 | ✅  | 2026-11-01 | docx/xlsx/pptx 抽文本当 text（python-docx/openpyxl/python-pptx 可选）；直接给 B，零联动 |
| A9 | ✅  | 2026-11-01 | 超大附件闸门：**单份附件** >100MB 不读内容、只回下载链接+解释（HTTP 200，无拒收）；≤100MB 一律正常解析；请求体不设限；MIME 魔数兜底 |
| A5 | ⛔ | 2026-11-01 | **不做**：截图统一 `kind=image` 交视觉模型；OCR 会把 image 的校验豁免变成强校验，反而砸掉链路 |
| A6 | ✅  | 2026-11-01 | wechat-ai-memory 单源真机取数：文字/图片/语音(SILK→whisper)/真实文件全通；密钥本机缓存后不再重启微信；详见 `微信端选型结论.md` |
| A6-b | ✅  | 2026-11-01 | 钉钉/飞书适配器：同款 `{source,messages[]}` 信封 + records 裸数组；三端共用 A4，平台差异只进 `source`；信封可直投 `/parse` 与 `/parse_chat` |
| A7 | ⬜  |            |                                                                         |
