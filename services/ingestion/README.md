# A 环节 · 证据解析服务

> 位置：`truthtrace/services/ingestion/`（**已进仓库**，A 模块唯一归属目录）
> 独立 HTTP 服务，不参与 Next.js 构建；B 通过 `INGESTION_SERVICE_URL` 开关决定是否启用。
>
> 目录：
> ```
> services/ingestion/
> ├── server.py            解析服务（唯一入口）
> ├── requirements.txt     依赖（pypdf / pymupdf<2.0 / pillow / python-docx / openpyxl / python-pptx）
> ├── ai_ingest/          方案 A：AI 驱动智能取数（5 工具 + agent loop）
> ├── adapters/           钉钉 / 微信 / 飞书 适配器 + 媒体解码 + 密钥缓存 + 语音转写
> │                      ⚠️ pywxdump_to_synapse.py / media_decode.py **已弃用**，仅归档
> ├── tests/              14 套测试，全 PASS（python tests/run_all.py）
> └── testdata/           构造的演示数据（非真实聊天，可提交）
> ```
>
> 给 B/C 的改动建议统一收在 **`docs/A对BC的改动提案包.md`**，不在此重复。

## 环境提醒（真机部署必读）

- 本机存在**多个 Python**：默认 `python` 是 WorkBuddy 自带的 3.14.x，系统 `pip` 可能指向 Anaconda 3.13。
  二者不一致，用 Anaconda 的 `pip install pypdf` 装到的包，**默认 `python` 找不到**。
- **正确做法**：始终用「运行服务的同一个解释器」装依赖：
  ```bash
  python -m pip install pypdf   # 注意是 python -m pip，不是裸 pip
  python -c "import pypdf"      # 装完先验证能 import 成功
  ```
- 若换了虚拟环境 / 解释器，记得重装依赖。

## 运行

```bash
python server.py                # 监听 8000
python server.py --port 9000    # 自定义端口
PORT=9000 python server.py
```

### 依赖

**一句话：`python -m pip install -r requirements.txt`**（依赖清单见同目录 `requirements.txt`）

- A0 / A1 / A2：纯 Python 标准库，**零依赖**（图片转码优先用 Pillow，已装；没装时仅支持 png/jpeg/webp/gif）。
- **A3（PDF）需要 `pypdf` + `pymupdf`**（注意用运行服务的同一个 python 装）。
  - 未装 pypdf 时，上传 PDF 会返回 `500` 并提示安装；装好即恢复文本抽取。
  - **扫描件 PDF（无文本层）**：视觉模型不收 `application/pdf`，必须先渲染成 PNG 才能走 `image` 通道。
    装了 `pymupdf` 就自动渲染首页给模型看（`kind=image`，`mimeType=image/png`）；
    多页时 name 写 `[仅第 1 页 / 共 N 页]`，可用 `?pages=N` 指定页。
    渲染不了（未装 / 加密 / 损坏）才降级成 `kind=text` 说明，**绝不会把 PDF 的 data URL 当图片发出去**。
  - ⚠️ **`pymupdf` 必须锁 `<2.0`**：2.0 在 Windows + Python 3.14.3 上 `import pymupdf` 直接
    **SIGSEGV（段错误）**。段错误不是 `ImportError`，`try/except` 兜不住，会打死整个服务进程——
    比不装更危险。实测 `1.28.2` 正常。详见 `requirements.txt` 的注释与 `run_scan_pdf_test.py`。
- **A8（Word/Excel/PPT）需要可选库**：`python-docx` / `openpyxl` / `python-pptx`（注意用运行服务的同一个 python 装）。
  - 这些 OOXML 文档本质是 zip，不能当纯文本解码（会乱码）；抽成纯文本后当 `kind=text` 交给 B，**B 对非 `image` 一律当文本分析，零契约改动、零联动**。
  - 未装时，上传 docx/xlsx/pptx 返回 `500` 并提示安装；装好即恢复文本抽取。
  - 复杂排版/合并单元格表格若抽文本丢结构，可后续转图当 `kind=image`（B 用视觉模型看更准，需 libreoffice/渲染库，非必需）。
- **不要装 OCR**：截图一律当 `kind=image` 交视觉模型，A 不做本地 OCR（A5 已决策不做）。
  `rapidocr` / `onnxruntime` / `opencv` / `pytesseract` 都不需要，装了只会多占约 110MB。

## 接口

`POST /parse`  —  `multipart/form-data`，字段 `file`（单文件）
  可选查询参数：`?max_chars=N`（正文预算）、`?pages=起-止`（只取指定页，仅 PDF 有效）、
  `?source=钉钉`（来源渠道，优先于信封与文件名；给「手存对话稿」用，需 URL 编码）
返回  `{ "evidence": { id, name, kind, mimeType, content, source } }`
（`evidence` 严格满足 `truthtrace/src/lib/contracts.ts` 的 `EvidenceSchema`；上传聊天 JSON 即返回含内联标记的 `chat` 证据；
若 JSON 信封带 `"source"`（如钉钉适配器输出 `{"source":"钉钉","messages":[...]}`），会自动识别为来源）

`POST /parse_chat`  —  `application/json`，body `{ "records": [...], "name": "...", "source": "钉钉", "media_dir": "..." }`
返回  `{ "evidences": [ chat证据, 独立image/pdf证据, ... ] }`
（A 侧「媒体感知」扩展；**`source` 表示来源渠道（微信 / 钉钉 / 飞书），不传则为「用户上传」，媒体证据继承同一来源**；
`records` 与 `messages` 两个键都认，所以钉钉/飞书适配器产出的 `.json` 信封可以原样投进来；
B 的 `parser.ts` 当前只认单条，启用 bundle 需 B 改 parser，见提案）

> **`source` 的语义：只表示「来源渠道」**（微信 / 钉钉 / 飞书 / 用户上传）。
> 文件格式（Word/Excel/PPT/PDF）**不写进 `source`**——由 `name`（含 `.docx`/`.xlsx` 后缀）+ `mimeType` 表达，
> `content` 自身也保留结构线索（如 Excel 的 `# Sheet:`）。

> **`kind` 的语义：只表示「证据的物理形态 / B 的消费通道」**，不是来源平台、也不是文件格式。
> 三者正交，互不替代：
>
> | 字段 | 回答什么问题 | 取值 |
> |---|---|---|
> | `kind` | B 该怎么消费这条证据 | `text`（当文本读）/ `image`（当图看）/ `chat`（对话文本）/ `pdf`（文档文本） |
> | `source` | 这条证据从哪来 | 微信 / 钉钉 / 飞书 / 用户上传 |
> | `name` + `mimeType` | 原始文件是什么格式 | `交易明细.xlsx` + OOXML MIME |
>
> 所以**微信、钉钉、飞书的聊天记录一律 `kind="chat"`**——平台差异只在 `source`，不需要、也不允许给 kind 加平台值
> （`kind` 是 `contracts.ts` 的四选一枚举，加值必须三方走 PR）。
> 同理 Word/Excel/PPT 抽文本后一律 `kind="text"`，格式靠 `name` 后缀体现。

### 三个来源通道（适配器 / 用户文件 / 用户手存）

| 通道 | 入口 | 产物 | `source` 是谁定的 |
|---|---|---|---|
| 平台适配器 | `adapters/`（钉钉 / 微信 / 飞书 / pywxdump） | `<会话名>.json` 信封 + `<会话名>.records.json` 裸数组 | 适配器显式传（微信/钉钉/飞书），信封里也写一份 |
| 用户上传文件 | C → B → `POST /parse` | 原文件 | 信封有就认，没有就 `用户上传` |
| 用户手存文本 | `POST /parse?source=钉钉` | `.txt` 对话稿 | 调用方显式声明；**不看文件名** |

- 钉钉/飞书适配器产出的 `.json` 信封可以直接投 `/parse_chat`（`records`/`messages` 都认，`source` 会被读走）。
- 不传 `source` 就是 `用户上传`——A 不替调用方猜平台。文件名里的「钉钉」「微信」只用于判 `kind`，不用来定来源。

### kind 是怎么判出来的（类型路由）

顺序：**MIME → 内容嗅探 → 文件名关键词 → 兜底 `text`**。

- MIME 为 `image/*` → `image`；`application/pdf` → `pdf`。
- **内容嗅探**：JSON 里若是「有发送者字段 + 有正文字段」的记录数组（或 `{source, messages:[...]}` 信封），判 `chat`。
  这一步是必需的——钉钉/飞书适配器产物叫 `<会话名>.json` / `<会话名>.records.json`，**文件名里没有「聊天」二字**，
  只靠文件名会被误判成 `text`，聊天记录就变成一坨 JSON 原文丢给 B（kind 错、无内联标记、媒体全丢）。
- 文件名关键词兜底：`chat|message|会话|聊天|微信|weixin|wechat|dingtalk|钉钉|feishu|飞书` → `chat`。
- 其余 → `text`。

> 已知边界：**纯文本对话稿**（如 `<会话名>.md`，形如 `张三: 在吗`）若文件名不含上述关键词，会判成 `text`。
> 内容仍是可读对话原文，B 照样能分析，只是少了内联标记与媒体拆分——属于可接受降级，不强行嗅探以免误判普通文档。

### kind=image 的硬不变量（务必守住）

B 对 `kind=image` 的唯一处理是（`openai-compatible.ts:27-29`）：

```ts
content.push({ type: "image_url", image_url: { url: item.content, detail: "high" } });
```

即 **content 被原样当成图片 URL 发给视觉模型**。所以 `kind=image` 的 content **只能是
「模型支持的图片 data URL」**（png / jpeg / webp / gif）。发别的东西，模型 API 会直接拒绝，
导致整个 `analyze` 请求失败（B 返回 502）。

A 侧曾经产出过三种 `kind=image`，其中两种是**错的**，现已全部收口：

| 形态 | content | 之前 | 现在 |
|---|---|---|---|
| 真实图片 | `data:image/png;base64,...` | ✅ 合法 | ✅ 保持 |
| 扫描件 PDF | `data:application/pdf;base64,...` | ❌ 模型不收 PDF → 502 | 渲染成 PNG（PyMuPDF）；渲染不了 → 降级 `text` 说明 |
| 媒体缺失占位 | `[媒体文件缺失: xxx.pdf]` | ❌ 不是 URL → 502 | 改为 `kind=text`，模型当文本读并可在补证建议里提示 |
| bmp / tiff / svg | 原样 base64 | ❌ 非视觉格式 | bmp/tiff 用 Pillow 转 PNG；svg 转不了 → 降级 `text` |

统一出口是两个函数（`server.py`）：

- `image_data_url(mime, raw)` — 能转成合法图片 data URL 就返回，否则返回 `None`（调用方必须降级）
- `render_pdf_page_png(data, page=0, zoom=2.0)` — 把 PDF 指定页渲染成 PNG，返回 `(png_bytes, 总页数)`；
  pymupdf 不可用或渲染失败返回 `(None, 0)`。优先 `import pymupdf`，老版本回退 `import fitz`。

测试桩 `check_evidence.py` 已内置这条硬校验（`check_image_payload`），任何回归会立即 FAIL。

`GET /files/<存储名>`  —  下载超限原件（只读；存储名 `<uuid12>.<ext>` 白名单校验，防目录穿越）

`GET /health`  —  健康检查

### /source/*（方案 A：数据源连接与 AI 精准取数）

四个端点**全部纯新增**，不改上面任何既有端点；B/C 不调用即为死代码，零影响。

```
GET  /source/list              → { sources:[{id,name,auth,authorized,status,last_sync,count}] }
GET  /source/status?source=钉钉 → { source,authorized,status,detail,last_sync,count }
POST /source/connect {"source"} → { source,authorized,status,action,hint }
POST /source/sync    {"source"} → { source,synced,evidences:[...],windows,agent }
```

- 渠道名支持中英文别名（`钉钉`/`dingtalk`/`dws`、`微信`/`wechat`、`飞书`/`feishu`），归一到英文 id。
- `sync` 受 **single-flight 锁**保护：并发请求返回 `409 {"status":"busy"}`，不会二次执行
  （后端是进程内内存态，多线程下并发 sync 会互相覆盖）。
- `sync` 产出的 `Evidence.source` 是**渠道名**，不会落回「用户上传」。
- 扫码类授权**必须人做**：A 只探测本机凭证并返回 `need_auth + action + hint`，
  **不替用户完成授权**（这是授权机制决定的，不是实现偷懒）。
- 实现见 `ai_ingest/`；契约已冻结并写入 `docs/A对BC的改动提案包.md` §5。

验收：`python tests/run_source_api_test.py`

### CORS

默认 `Access-Control-Allow-Origin: *`（可用 `CORS_ALLOW_ORIGIN` 覆盖），带 `OPTIONS` 预检处理。
存在的理由是**「C 直连 A」的部署形态**——大文件绕开 B 的 8MB 前置检查时必须有。
走 B 转发时这些头无害。

### 大文档（几百页 PDF）怎么处理

**问题**：B 对 `content` 长度**没有任何限制**，会把所有证据的正文全量拼进 prompt
（`openai-compatible.ts:33` 直接 `原文：\n${item.content}`）。实测 300 页文本型 PDF：

| 指标 | 实测 |
|---|---|
| 文件大小 | 0.94 MB（文本型，远没到大小上限） |
| 抽取出的 content | **766,721 字符** |
| 估算 token | **约 48 万** |
| 后果 | 90 秒超时必挂；换任何 128k 窗口的模型直接 `context_length_exceeded`；模型面对 76 万字也抓不住重点 |

**解法**：A 侧做「页级预算裁剪」，默认单条证据正文预算 **30,000 字符**（可用 `MAX_CONTENT_CHARS` 环境变量调）。

| 情况 | 行为 |
|---|---|
| 全文 ≤ 预算 | **原样透传**，不加页标记、不加说明（小文档行为与以前完全一致） |
| 全文 > 预算 | 首页（标题/当事人）+ 末页（落款/签字/日期）必留；剩余预算按**反诈关键词得分**优先装高分页（转账/金额/卡号/身份证/合同/承诺…）；还有余量则**均匀采样**补足 |
| 预算 < 单页 | 保留首页前 `budget` 字符并标注「本页后续 N 字符已截断」，**绝不返回空 content** |

**铁律：只按整页取舍，绝不改写原文。** 因为 B 的 `validate.ts` 要求真实模型模式下
「非 image 证据的引用 quote 必须能在 `content` 中逐字找到」，一旦改写就全部引用失效。
裁剪时每页前会加 `--- 第 N 页 ---` 标记（仅在裁剪时加），页间插入标记不影响引文定位。

被裁剪时，`name` 会变成 `合同全集.pdf [保留 14/300 页]`，`content` 末尾附截断说明，
写明原文档页数/字符数、保留了多少页、以及如何取指定范围——**让模型和用户都知道这是不完整的**。

**两个可选查询参数**（不带则用默认值，C 侧现有调用完全不受影响）：

```bash
# 只看第 100-120 页（此时按页码顺序连续取，不做跳跃采样）
curl -X POST "http://localhost:8000/parse?pages=100-120" -F "file=@大合同.pdf"

# 自定义预算（字符）
curl -X POST "http://localhost:8000/parse?max_chars=8000" -F "file=@大合同.pdf"
```

**扫描件大 PDF 另有限制**：几百页不可能全部渲染成图（每页 base64 后体积巨大），
只渲染一页（默认第 1 页，可用 `?pages=N` 指定），并在 `name` 标注
`扫描件.pdf [仅第 3 页 / 共 300 页]`，避免下游误以为看到了完整文档。
渲染依赖 `pymupdf`（**锁 `<2.0`**）；未装或渲染失败时这条链降级为 `kind=text` 说明。

### 超大附件：只有一道闸门（>100MB 不读内容，只回链接 + 解释）

**这道闸门只治文档，不管图片。** 它存在的唯一理由是防解析超时：

| 类型 | 要不要解析 | 是否受闸门限制 |
|---|---|---|
| PDF / Word / Excel / 文本 | 要（抽正文、渲染页面），耗时随体积线性增长 | ✅ **受限** |
| 图片 | 不要，只是 base64 塞进 `content` | ❌ **不受限** |

| 条件 | 行为 |
|---|---|
| 单份**文档**附件 > **100MB**（`MAX_CONTENT_SIZE`） | **完全不读内容**（不抽文本、不做 OCR、不渲染），`kind=text`，content 写清体积、原因、**下载链接**；HTTP 仍是 200 |
| ≤ 100MB | 按正常流程处理：扫描件渲染成图给视觉模型、文本型 PDF 抽文本、office 抽正文、纯文本直接读，再按字符预算裁剪 |

> 为什么图片不受限：图片不解析，谈不上"解析太久"，限制它只会造成「图能进、文档不能进」的怪现象。
> 图片若真大到模型收不下，那是 `analyze` 那一跳的事，应由 B 按 `content` 长度处理，不是在 A 按文件体积拦。
> 为什么不做 413：用户要的是"原件仍能拿到"。拒收会让他一无所获，而落盘 + 回链接既保留了原件，也让模型有东西可转述。
> 阈值只量**解析出来的 `file` 字段字节数**，**请求体（Content-Length）不设上限**——multipart 请求体必然比文件大（边界串 + 其他字段），按请求体卡会把"正好 100MB 的文件"误杀。

**两条入口共用同一套口径**（2026-11-01 修复）：

| 入口 | 函数 | 修复前 | 修复后 |
|---|---|---|---|
| `POST /parse`（用户上传） | `build_evidence` | 有闸门，但连图片一起管 | 只治文档 |
| `POST /parse_chat` / `POST /source/sync`（聊天媒体） | `build_media_evidence` | **完全没有闸门** | 只治文档 |

> ⚠️ 曾经渠道取数整段绕过闸门：它不经 B 的 `parser.ts`，而 A 侧又只在上传路径写了判断，
> 超大文档会一路进解析流程。现已按同一口径补齐，由 `run_chat_media_gate_test.py` 钉死。
>
> 另外，视觉模型普遍有「单图」上限（各家 5–20MB 不等），A 不替模型做决定：
> 图片原始体积超过 `VISION_IMAGE_HINT_MB`（默认 8MB，设 0 关闭）时**只在 `name` 上标注**
> `xxx.png [原图 12.4 MB，可能超出模型单图上限]`，**content 一字不改**——
> 让模型有机会自己说"看不清"，而不是被静默截断后照常编造。

content 长这样（模型能原样转述给用户）：

```
[附件过大，未解析] 文件：合同扫描件.pdf（138.4 MB）
原因：超过单份附件上限 100 MB。超过上限的文件服务端不读取内容（不抽文本、不做 OCR），因此这里没有原文。
下载链接：http://127.0.0.1:8000/files/9f3a1c2b7d4e.pdf
请将上述链接原样告知用户，由用户自行下载查看；不要猜测文件内容。
如需直接分析，请拆分到 100 MB 以内再上传。
```

设计要点：

- **URL 是给人看的，不是给模型读文件的**。B 不会下载、模型也读不了 PDF；模型只需要把链接转述出去。
- 存储名必须是**纯 ASCII**（`<uuid12>.<ext>`），否则中文文件名会让 URL 变成非 ASCII，客户端和模型转述时极易断链。原始文件名写进同名 `.name` 旁注文件，下载时还原。
- 原件落在 `UPLOAD_DIR`（默认 `services/ingestion/_uploads/`），**不会自动清理**，长期跑要定期清或改到临时目录。
- 内存代价：请求体整份读入内存，峰值约等于「文件体积 + 解析副本」。演示够用；生产要接反向代理的 `client_max_body_size` 并改成流式解析。
- **为什么 100MB 以内可以放心解析**：实测文本型 PDF 抽取约 **0.9 ms/页**（800 页 0.73s），扫描件抽不出文本、只渲染 1 页，所以真正的成本不在"读"，而在"渲染/预算"，这两处都有独立开关（`?pages`、`?max_chars`）。
- `PUBLIC_BASE_URL` 可覆盖链接前缀；不设时按请求的 `Host` 头推断（本地即 `http://127.0.0.1:8000`）。

### MIME 兜底：按文件头猜类型

浏览器/转发层偶尔把 PDF 报成 `application/octet-stream`，此时会被判成 `text`，
二进制内容直接倒进 content（一份几十 MB 的 PDF 变成一坨乱码）。所以 MIME 缺失时按魔数兜底：
`%PDF` → pdf、`\x89PNG` → png、`\xff\xd8\xff` → jpeg、`GIF8` → gif、`RIFF....WEBP` → webp。

> ⚠️ **A 的 100MB 只管单份文档附件，且只在「直连 A」时作数。** 真实链路是 C → Next.js `api/evidence/parse` → A，
> 而 B 的 `parser.ts` 在转发前就有自己的 8MB 前置检查，所以 >8MB 的文件根本到不了 A——A 的阈值也就不会触发。
> 想让大附件走 A 的「链接 + 解释」逻辑，只有两条路：B 把前置检查放宽，或 >8MB 直连 A（需 A 开 CORS，待补）。

## 实现进度（对照 `docs/A/A环节任务拆解.md`）

| 环节 | 状态 | 说明 |
|---|---|---|
| A0 骨架 | ✅ | 服务 + /parse + 契约返回 + 类型路由 |
| A1 文本 | ✅ | 零依赖，content = 文本 |
| A2 图片 | ✅ | 零依赖，content = 图片 data URL；bmp/tiff 用 Pillow 转 PNG，svg 等转不了则降级 text |
| A3 PDF | ✅ | pypdf 抽取文本；扫描件渲染 PNG（PyMuPDF）或安全降级 text；**大文档页级预算裁剪**（默认 3 万字，首页末页+关键词页+均匀采样，整页保留不改写） |
| A4 聊天(媒体感知) | ✅ | 识别 text/image/file/voice/transfer/system；内联标记 + 独立证据；/parse 单条兼容 |
| A4 媒体分流 | ✅ | 附件按真实 MIME 落 kind：图片→image(base64)、PDF→pdf(抽文本)、docx/xlsx/pptx→text(抽文本)、**旧版 .doc→text(olefile 尽力抽正文)**、音视频→text(描述占位)；缺附件仍为 image 占位 |
| A8 其他文档(docx/xlsx/pptx/doc) | ✅ | 抽文本当 text，直接给 B，零联动（python-docx/openpyxl/python-pptx/olefile 可选） |
| A9 超大附件闸门 | ✅ | **只治文档**：单份 PDF / Word / Excel / 文本 >100MB 一律**不读内容**、只回「下载链接 + 解释」（HTTP 200，无拒收）；≤100MB 正常按类型解析（扫描件走图、文本型抽文本）；**图片不受此限**（不解析，只 base64）；请求体不设限；MIME 按魔数兜底 |
| A5 OCR（截图识字） | ⛔ **不做** | 已决策，理由三条：① 视觉模型读中文聊天截图本就比 RapidOCR 准；② 截图一旦 OCR 成 `kind=chat`，B 的 `validate.ts:44` 会对引文**强制逐字命中**，OCR 中文间的空格会让整条 analyze 400；③ OCR 错字会被「校验通过」洗白，比不校验更危险。**扫描件 PDF 是另一条独立通道**：无文本层时渲染成 PNG 走视觉模型，与 OCR 无关 |
| A6 微信真机取数 | ✅ | 取数源 **wechat-ai-memory**（PyWxDump 在 4.1.x 取不到密钥且上游已删库）。真实微信实测通过：文字 34 / 图片 5 / 语音 8 / 真实文件 2 → `/parse_chat` 出 chat + 图片 + 文档证据。密钥已加本机缓存：**仅首次需重启微信 + 手机确认，之后导出不再碰微信** |

## A6 · 微信端取数接入（wechat-ai-memory → A4）

取数源是 **wechat-ai-memory**（第三方工具，**不在本仓库**，需另行获取，见下方「环境」）。
完整接入步骤见 **`docs/A/微信端接入设计.md`**（14 节：数据流、字段映射、契约、媒体矩阵、踩坑清单）。
> **为什么不是 PyWxDump**：本机微信 4.1.15.56 取不到密钥，且上游 GitHub 于 2025-10-20
> 因律师函删库，永无 4.x 偏移。仓库里的 `pywxdump_to_synapse.py` / `media_decode.py`
> 因此**已弃用**，仅作归档保留，不要在新链路里使用。

链路：

```
wechat-ai-memory 导出 Version 1 JSON + <导出名>_assets/   （含 .silk 语音、文件原件、解密图片）
   │  python wechat_voice_transcribe.py <export>.json --model <本地模型目录>   # 可选：补语音转写
   │  python wechat_aimemory_to_synapse.py <export>.json --out synapse_input [--post http://127.0.0.1:8000/parse_chat]
   ▼
synapse_input/<会话名>_<日期>.json   ← [{seq,type,sender,time,text,media}]
   │  POST /parse_chat  {records, name, media_dir}
   ▼
evidences[]  = [chat 证据(source="微信", 含内联标记), *媒体独立证据]
```

- **不用 OCR**：文字直接来自解密后的本地库；图片/文件的 `content` 是 `_assets` 相对路径。
- **字段映射**：`is_outgoing=true` → `sender="我"`；`timestamp` → `time`；`type` 原样（text/image/file/voice/system）。
- **agent 取媒体**：文档/视频按 `_assets` 路径直读原文件（零解码）；图片由取数器解密后落 `_assets`；语音由 `wechat_voice_transcribe.py` 转成文字后内联进对话。
- 已用**本机真实微信**验证：某项目群 47 条消息（34 text / 5 image）→ 6 条证据；某单聊会话（2 语音 + 2 真文件）→ chat + xlsx 正文 + doc 正文；另一单聊会话 6 条语音全部转写。（会话名与联系人已脱敏）
- 取数据库密钥需**先关微信再拉起 + 手机扫码确认**（密钥只在登录派生那一刻可 Hook）；图片密钥另行从运行中的微信进程内存扫描取得，无需重启。
- **`type=49` 不等于文件**：接龙(53)/引用(57)/拍一拍(62) 也是 49，必须读 XML `<type>`；只有 `6` 才是真文件，其余按文本/系统处理（适配器已内置该纠正）。
- 语音转写质量：需 `initial_prompt` 锁简体（否则出繁体），中文建议 `medium` 模型；安装方式与已知坑见上文「语音转写（可选）」。
- 小程序/链接卡片类「文件」消息只有标题文本（形如 `[小程序] xxx.md`），按文本保留，不产出附件证据。

#### A6 环境：wechat-ai-memory 怎么来（不在本仓库）

A 只依赖它的**导出产物**（Version 1 JSON + `<导出名>_assets/`），不 import 它的代码。

- **获取**：原 `LOGO127` 仓库已 404，目前可用社区镜像（`congjin` / `PC267` / `ldfpku` / `ikevss`，v0.3.7-alpha），微信 4.x 原生。
- **放在仓库外**：建议放在仓库外任意目录（例如 `<仓库外>/wam_probe/`），
  因此它**不应进 A 的仓库**，但部署时必须有。
- **密钥缓存补丁（强烈建议）**：上游 `capture_account_key()` 每次都 `taskkill Weixin.exe` 再重启拉起，
  要重新扫码。打补丁后命中缓存约 **700ms**，且**不再需要微信在线**。
  位置：`.../sources/wechat4_key_capture.py`；缓存落 `%LOCALAPPDATA%\Synapse\wechat_db_keys.json`。
- **frida 坑**：wheel 61MB，pypi 直装常被中断 → `curl -C -` 断点续传后本地 `pip install --no-deps`。

### 语音转写（可选，非核心链路）

`adapters/wechat_voice_transcribe.py` 走 SILK → WAV → faster-whisper。
本机实测**全库仅 9 条语音**，按需安装即可：

```bash
python -m pip install pysilk faster-whisper   # 建议独立 3.13 venv：ctranslate2 无 py3.14 轮子
```

- 模型下载：HF 不通、hf-mirror 慢 → 用 **ModelScope `pengzhendong/faster-whisper-*`**（约 15MB/s）。
- 中文默认 `medium`：必须加 `initial_prompt="以下是普通话的句子。"` + `condition_on_previous_text=False`，
  否则**输出繁体**、噪声段还会冒英文幻觉；`small` 会明显错听（「十来块的杯子」→「我死了」）。

### 钉钉 / 飞书端取数（适配器已就绪，依赖外部 CLI）

| 渠道 | 外部工具 | 安装 | 适配器 | 状态 |
|---|---|---|---|---|
| 钉钉 | `dws`（官方开源 CLI） | 官方安装包 / npm | `adapters/dingtalk_to_synapse.py` | ✅ 真实数据跑通（95 条、8 个媒体全部下载成功） |
| 飞书 | `lark-cli`（官方开源 CLI） | `npm i -g @larksuite/cli` | `adapters/feishu_to_synapse.py` | 🟡 demo 通过；真机被租户策略挡住（见下） |

- 两者都要先登录：`dws auth login` / `lark-cli config init --new` + `auth login`。
- 详细接入见 **`docs/A/钉钉端接入设计.md`**（18 节）与 **`docs/A/飞书端选型结论.md`**（含真机验证记录）。
- ⚠️ **飞书尚未真机跑通**：`lark-cli` 与适配器均就位，但取 token 被平台策略 `21001` 拦住
  （当前租户不具备 OpenAPI 资质）。**演示只能用合成样例**，见 **`docs/A/飞书端接入现状.md`**。
  该文档只记现状与阻塞，**未写实现设计**——真机跑通前不固化设计，避免返工。
- 飞书媒体：`im +chat-messages-list --download-resources` 会一次性下到 `./lark-im-resources/`
  并回填 `local_path`，适配器优先读它。
- **飞书的阻塞不是代码问题**：`tenant_access_token` 能拿到（用错误 secret 会返回 `10014`，
  证明凭证链路正常），但所有 API 返回 **21001「scope blocked by data security policy」**
  —— 个人版租户无开放平台资质，需换有资质的企业租户或由管理员放行。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8000 | 服务端口（也可 `python server.py --port 9000`） |
| `MAX_CONTENT_SIZE` | 100MB | 唯一体积闸门；**只作用于文档**，图片不受限 |
| `VISION_IMAGE_HINT_MB` | 8 | 图片超此值只在 `name` 标注「可能超出模型单图上限」；设 `0` 关闭 |
| `PUBLIC_BASE_URL` | 按请求 Host 推断 | 超限附件的下载链接前缀 |
| `CORS_ALLOW_ORIGIN` | `*` | 允许前端直连 A（已全开） |
| `SYNAPSE_LLM_*` | 空 | 方案 A 的 LLM 配置；不设则走 MockAgent（确定性、可演示） |

## 对接 TruthTrace

在 `truthtrace/.env.local` 写入：

```
INGESTION_SERVICE_URL=http://localhost:8000
```

前端上传任意文件 → `truthtrace` 的 `parser.ts` 转发到本服务 → 返回经 `EvidenceSchema` 校验。

> 注：聊天里的图片/文件，建议前端对每个媒体单独调用一次 `/parse`，组装成 `evidence[]` 交给 `analyze`；
> 若希望一次返回多条，需先与 B 对齐「提案二」（`parser.ts` 支持 `evidences[]`）。详见《契约与接口扩展提案》。
