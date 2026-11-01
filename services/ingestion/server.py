#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
A 环节 · 证据解析服务 (server.py)
================================
独立 HTTP 服务，暴露：
    POST /parse      多文件上传（multipart/form-data, 字段 file），返回 { "evidence": {...} }
                     —— 严格满足 TruthTrace 的 EvidenceSchema（单条，B 当前直接兼容）
    POST /parse_chat 聊天记录 JSON（application/json），返回 { "evidences": [...] }
                     —— A 侧「媒体感知」扩展：一条 chat 证据 + 若干独立 image/pdf 证据
                        （B 的 parser.ts 当前写死单条，启用此 bundle 需 B 改 parser 支持数组，见提案）
    GET  /source/list              渠道列表（方案 A：数据源连接）
    GET  /source/status?source=钉钉 渠道授权状态
    POST /source/connect           触发/探测渠道授权（扫码类授权仍需人做）
    POST /source/sync              按调查目标做 AI 精准取数，返回 { evidences: [...] }
                     —— 全部纯新增，不改上面三个既有端点，B/C 不调用即为死代码

实现状态：
    A0 骨架 + /parse 接口 + 契约返回 + 类型路由
    A1 文本(text) 零依赖           A2 图片(image) 零依赖 base64
    A3 PDF(pdf) pypdf 抽文本；扫描件回退 image 待 A5 OCR
    A8 其他文档(docx/xlsx/pptx) 抽文本当 text（python-docx/openpyxl/python-pptx 可选依赖）
    A4/A6 聊天(chat) 媒体感知：识别 text/image/file/voice/transfer/system 等类型；
          文本/系统进对话；图片/文件生成内联标记 + 独立 evidence；
          /parse 对聊天 JSON 返回单条 chat（含内联标记，B 兼容）；
          /parse_chat 返回 bundle（chat + 独立媒体，供联动）。

设计铁律（见 A环节任务拆解.md 第 0 节）：不单方面改 contracts.ts；
只用现有 4 种 kind + content + source + 内联标记表达一切。

运行（零第三方依赖即可跑 text/image/chat；PDF 需 pypdf）：
    python server.py                # 监听 8000
    python server.py --port 9000
    PORT=9000 python server.py

测试：见 tests/（本目录）
"""

import sys
import os
import re
import json
import uuid
import base64
import mimetypes
import io
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, quote

# 唯一的体积闸门：**单份附件**超过这个值就完全不读内容，只回「下载链接 + 解释」。
#
# 三个刻意的选择：
#   1. 不拒收（没有 413）。用户要的是「原件仍能拿到」，拒收只会让人一无所有。
#   2. 量的是解析出来的 file 字段字节数，不是请求体——multipart 请求体必然更大
#      （边界串 + 其他字段），按 Content-Length 卡会把「正好 100MB 的文件」误杀。
#   3. 判定放在解析之前，因为解析才是耗时/耗内存的元凶，不能解析完再判断。
#
# 100MB 以内一律按正常流程走：扫描件渲染成图给视觉模型、文本型 PDF 抽文本、
# office 抽正文、纯文本直接读——只受字符预算约束（MAX_CONTENT_CHARS），不再按体积二次拦截。
MAX_CONTENT_SIZE = int(os.environ.get(
    "MAX_CONTENT_SIZE",
    os.environ.get("MAX_PARSE_SIZE") or os.environ.get("MAX_FILE_SIZE") or str(100 * 1024 * 1024),
))
MAX_CONTENT_SIZE_MB = MAX_CONTENT_SIZE / 1024 / 1024

# 视觉模型普遍有「单图」上限，各家不同（常见 5–20MB），A 不替模型做决定。
# 超过这个值时只在证据名上标注体积，内容一字不改——让模型有机会自己说「看不清」，
# 而不是被静默截断后照常编造。可用 VISION_IMAGE_HINT_MB 覆盖，设 0 关闭标注。
VISION_IMAGE_HINT = int(os.environ.get("VISION_IMAGE_HINT_MB", "8")) * 1024 * 1024

# ---- 方案 A：数据源服务（/source/*）----
# 懒加载且可缺席：ai_ingest 依赖 LLM 客户端与适配器，import 失败不能让整个解析服务起不来。
# 缺席时 /source/* 返回 501 并说明原因，/parse 与 /parse_chat 不受影响。
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

try:
    from ai_ingest.service import SourceService  # noqa: E402
    _SOURCE_SVC = SourceService()
    _SOURCE_ERR = None
except Exception as _e:  # noqa: BLE001
    SourceService = None
    _SOURCE_SVC = None
    _SOURCE_ERR = f"{type(_e).__name__}: {_e}"

# 超限文件的落盘目录与对外基址（用于拼 content 里的下载链接）。
# PUBLIC_BASE_URL 为空时按请求的 Host 头推断（本地演示即 http://127.0.0.1:8000）。
UPLOAD_DIR = os.environ.get(
    "UPLOAD_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "_uploads"))
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "").rstrip("/")


# ---------------------------------------------------------------------------
# 1) 解析 multipart/form-data 的 file 字段（标准库，兼容 py3.13+）
# ---------------------------------------------------------------------------
def parse_file_field(body: bytes, content_type: str):
    """返回 (filename, data_bytes, part_content_type)。"""
    raw = b"Content-Type: " + content_type.encode("utf-8", "ignore") + b"\r\n\r\n" + body
    msg = BytesParser(policy=default).parsebytes(raw)
    for part in msg.walk():
        cd = part.get("Content-Disposition", "") or ""
        m = re.search(r'name="([^"]*)"', cd)
        if m and m.group(1) == "file":
            return part.get_filename(), part.get_payload(decode=True), part.get_content_type()
    for part in msg.walk():
        if part.get_filename():
            return part.get_filename(), part.get_payload(decode=True), part.get_content_type()
    return None, None, None


# ---------------------------------------------------------------------------
# 2) 类型路由（与 truthtrace/src/lib/ingestion/parser.ts 的 evidenceKind 对齐）
# ---------------------------------------------------------------------------
# 文件名里的「聊天」线索：含三平台中英文名，兼容各适配器的命名习惯
_CHAT_NAME_RE = re.compile(
    r"chat|message|msgs?|会话|聊天|微信|weixin|wechat|"
    r"dingtalk|dingding|钉钉|feishu|lark|飞书",
    re.I,
)


def evidence_kind(filename: str, mime: str, data: bytes | None = None) -> str:
    """类型路由：决定这条证据走哪条消费通道。

    kind 表达「证据的物理形态 / B 的消费通道」，**不是来源平台**——
    微信、钉钉、飞书的聊天记录一律 kind="chat"，平台差异写在 source。
    判定顺序：MIME → 内容嗅探（聊天 JSON）→ 文件名关键词 → 兜底 text。
    """
    if (mime or "").startswith("image/"):
        return "image"
    if mime == "application/pdf":
        return "pdf"
    # 1) 内容嗅探优先：钉钉/飞书适配器产物是 <会话名>.json / <会话名>.records.json，
    #    文件名里没有「聊天」二字，只靠文件名会被误判成 text，
    #    结果聊天记录被当成一坨 JSON 原文丢给 B（kind 错、无内联标记、媒体全丢）。
    if data and _looks_like_chat_json(data):
        return "chat"
    # 2) 文件名关键词兜底（三平台中英文名都覆盖）
    if _CHAT_NAME_RE.search(filename or ""):
        return "chat"
    return "text"


def decode_text(data: bytes) -> str:
    for enc in ("utf-8", "gbk"):
        try:
            return data.decode(enc)
        except Exception:
            continue
    # 走到这里说明整份字节流按 utf-8/gbk 都不合法。最常见的原因是**尾部被截断**
    # （按字节切片时切在多字节字符中间），此时直接 latin-1 会把全文变成乱码
    # （每个汉字变 3 个怪字符）。所以先按 utf-8 容错解一次：
    # 坏字符占比极低（<1%）说明本来就是 utf-8，只是尾巴坏了，用容错结果；
    # 占比高说明真是别的编码，才退回 latin-1。
    soft = data.decode("utf-8", "replace")
    bad = soft.count("\ufffd")
    if bad and bad / max(1, len(soft)) < 0.01:
        return soft
    return data.decode("latin-1")


# 判定「聊天记录 JSON」用的字段别名（覆盖微信/钉钉/飞书三套适配器）
_CHAT_SENDER_KEYS = (
    "sender", "senderName", "sender_name", "from", "fromUser", "speaker",
    "nick", "nickname", "userName", "sendUserName", "senderId",
)
_CHAT_TEXT_KEYS = (
    "text", "content", "msg", "body", "plainText", "msgContent", "message",
)
_CHAT_LIST_KEYS = ("messages", "records", "msgs", "chatRecords", "items", "data")


def _looks_like_chat_json(data: bytes) -> bool:
    """内容嗅探：这份 JSON 是不是聊天记录？

    只认「有发送者字段 + 有正文字段」的记录，避免把普通配置/数据 JSON 误判成聊天。
    支持裸数组和 {source, messages:[...]} 信封两种形态。
    """
    if not data:
        return False
    stripped = decode_text(data).strip()
    if not stripped or stripped[0] not in "[{":
        return False
    try:
        obj = json.loads(stripped)
    except Exception:
        return False

    records = None
    if isinstance(obj, list):
        records = obj
    elif isinstance(obj, dict):
        for k in _CHAT_LIST_KEYS:
            v = obj.get(k)
            if isinstance(v, list):
                records = v
                break
    if not records:
        return False

    for rec in records[:20]:
        if not isinstance(rec, dict):
            continue
        has_sender = any(k in rec for k in _CHAT_SENDER_KEYS)
        has_text = any(k in rec for k in _CHAT_TEXT_KEYS)
        if has_sender and has_text:
            return True
    return False


# ---------------------------------------------------------------------------
# 2.5) 视觉通道收口：kind="image" 的 content 必须是「视觉模型能吃的图片 data URL」
# ---------------------------------------------------------------------------
# B 的 openai-compatible.ts 对 kind=image 一律走：
#     content.push({ type: "image_url", image_url: { url: item.content, detail: "high" } })
# 也就是把 content **原样当成图片 URL** 发给视觉模型。所以 content 必须满足：
#   1) 是 data URL；2) MIME 是模型支持的图片格式（png / jpeg / webp / gif）。
# 若发 application/pdf 的 data URL，或发一段中文占位文本，模型 API 会直接拒绝，
# 导致整个 analyze 请求失败（B 返回 502）——所以这里统一收口，杜绝非法形态。
VISION_MIMES = {
    "image/png": "png",
    "image/jpeg": "jpeg",
    "image/jpg": "jpeg",
    "image/webp": "webp",
    "image/gif": "gif",
}


def image_data_url(mime: str, raw: bytes):
    """把图片字节转成「视觉模型能吃的」data URL；做不到时返回 None。

    - 已是模型支持的格式 → 直接 base64
    - bmp / tiff 等 → 用 Pillow 转 PNG（Pillow 不可用则 None）
    - 非图片（audio / video / pdf / svg 等）→ None
    返回 None 表示「这条不能走 image 通道」，调用方必须降级，绝不能硬塞。
    """
    mime = (mime or "").lower().split(";")[0].strip()
    if not raw:
        return None
    if mime in VISION_MIMES:
        return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"
    if not mime.startswith("image/"):
        return None
    try:
        from PIL import Image

        buf = io.BytesIO()
        img = Image.open(io.BytesIO(raw))
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGBA")
        img.save(buf, format="PNG")
        return f"data:image/png;base64,{base64.b64encode(buf.getvalue()).decode('ascii')}"
    except Exception:
        return None


def render_pdf_page_png(data: bytes, page: int = 0, zoom: float = 2.0):
    """把 PDF 指定页渲染成 PNG，返回 (png_bytes, 总页数)。

    PyMuPDF 不可用或渲染失败返回 (None, 0)。
    用途：扫描件 PDF 没有文本层，模型又只收图片，只能先渲染成图再走 image 通道。
    几百页的扫描件不可能全部渲染（每页 base64 后体积巨大），调用方只渲染一页，
    并把「共 N 页、当前第几页」写进文件名，避免下游误以为这就是完整文档。
    """
    # 优先用新包名 pymupdf：1.24+ 起 `fitz` 只是弃用别名，1.28 会往 stderr 打警告；
    # 老版本没有 pymupdf 顶层模块时才回退 fitz。
    # ⚠️ 版本坑：pymupdf 2.0 在本机（Windows + Python 3.14.3）**`import` 即 SIGSEGV**。
    # 段错误不是异常，try/except 兜不住，整个服务进程会直接死掉——比不装更糟。
    # 因此 requirements.txt 锁 <2.0（实测 1.28.2 正常）。
    try:
        import pymupdf as fitz
    except ImportError:
        try:
            import fitz
        except ImportError:
            return None, 0
    try:
        doc = fitz.open(stream=data or b"", filetype="pdf")
        n = doc.page_count
        if n == 0:
            return None, 0
        p = doc.load_page(min(max(page, 0), n - 1))
        return p.get_pixmap(matrix=fitz.Matrix(zoom, zoom)).tobytes("png"), n
    except Exception:
        return None, 0


# ---------------------------------------------------------------------------
# 3) A3 · PDF 文本抽取（pypdf）+ 大文档预算裁剪
# ---------------------------------------------------------------------------
# 单条证据的正文预算（字符）。B 对 content 长度没有任何限制，会全量拼进 prompt；
# 300 页 PDF 实测能到 76 万字符 ≈ 48 万 token，会直接拖垮 90 秒超时并击穿小窗口模型。
# 这里做「页级预算裁剪」：小文档原样透传，超预算才挑选代表性页。
MAX_CONTENT_CHARS = int(os.environ.get("MAX_CONTENT_CHARS", "30000"))

# 反诈/纠纷场景的「关键页」信号词：命中越多，这一页越可能藏着决定性的物证。
_PDF_HOT_WORDS = (
    "转账", "汇款", "退款", "退款", "支付", "收款", "付款", "金额", "元", "¥", "￥",
    "CNY", "RMB", "USD", "借", "欠", "还款", "利息", "本金",
    "账号", "帐号", "卡号", "账户", "帐户", "银行卡", "支付宝", "微信支付", "开户",
    "身份证", "证件号", "护照", "手机号", "联系电话",
    "甲方", "乙方", "借款人", "出借人", "担保", "保证人", "当事人",
    "承诺", "保证", "约定", "同意", "确认", "授权",
    "合同", "协议", "编号", "条款", "签字", "盖章", "签约", "生效", "到期", "违约",
    "诈骗", "冒充", "客服", "刷单", "投资", "返利", "冻结",
)


def _pdf_page_score(text: str) -> int:
    """给一页打分：命中不同关键词的个数（去重，避免长页靠重复词刷分）。"""
    hits = {w for w in _PDF_HOT_WORDS if w in text}
    return len(hits)


def extract_pdf_pages(data: bytes):
    """逐页抽文本，返回 ([(页码, 文本)], 总页数)。pypdf 不可用或解析失败返回 (None, 0)。"""
    try:
        from pypdf import PdfReader
    except ImportError:
        return None, 0
    try:
        reader = PdfReader(io.BytesIO(data))
        total = len(reader.pages)
        pages = []
        for i, page in enumerate(reader.pages, 1):
            t = (page.extract_text() or "").strip()
            if t:
                pages.append((i, t))
        return pages, total
    except Exception:
        return None, 0


def extract_pdf_text(data: bytes):
    pages, _ = extract_pdf_pages(data)
    if not pages:
        return None
    return "\n".join(t for _, t in pages)


def select_pdf_pages(pages, budget: int, sequential: bool = False):
    """在字符预算内挑出代表性页，返回 (选中页, 是否裁剪)。

    策略（保证「整页保留、不改写原文」，这样 B 的逐字引用校验仍然成立）：
      1. 总字数不超预算 → 全要，不做任何加工（小文档行为与以前完全一致）
      2. sequential=True（调用方用 ?pages= 指定了范围）→ 按页码顺序装满，
         因为此时用户意图是「看这一段」，跳跃采样反而不好
      3. 否则 → 首页（标题/当事人）+ 末页（落款/签字/日期）必留，
         剩余预算按「关键词得分降序」装入高分页，还有余量再均匀采样补足
    """
    total_chars = sum(len(t) for _, t in pages)
    if total_chars <= budget:
        return list(pages), False

    if sequential:
        keep, used = {}, 0
        for no, t in pages:
            if used + len(t) > budget:
                break
            keep[no] = t
            used += len(t)
        if not keep:
            no, t = pages[0]
            cut = max(0, len(t) - budget)
            keep[no] = t[:budget] + (f"...[本页后续 {cut} 字符已截断]" if cut else "")
        return [(no, keep[no]) for no in sorted(keep)], True

    n = len(pages)
    keep = {}
    used = 0

    # 首页 + 末页必留（合同主体、落款签字通常就在这两处）
    for idx in (0, n - 1):
        no, t = pages[idx]
        if no in keep:
            continue
        if used + len(t) <= budget:
            keep[no] = t
            used += len(t)

    # 高分页优先（得分相同按页码升序，保持阅读顺序可预期）
    ranked = sorted(range(n), key=lambda i: (-_pdf_page_score(pages[i][1]), i))
    for idx in ranked:
        no, t = pages[idx]
        if no in keep:
            continue
        if used + len(t) > budget:
            continue
        keep[no] = t
        used += len(t)

    # 余量均匀采样：按页码均匀铺开，填补仍空着的区间
    if used < budget * 0.9:
        remaining = [i for i in range(n) if pages[i][0] not in keep]
        step = max(1, len(remaining) // 20)
        for idx in remaining[::step]:
            no, t = pages[idx]
            if used + len(t) > budget:
                continue
            keep[no] = t
            used += len(t)

    # 兜底：预算比单页还小时（如 ?max_chars=2000 配 3000 字/页），上面的整页装入
    # 会一页都装不下。此时至少保留首页开头一段并明确标注，绝不返回空 content
    # ——空内容会被契约拒绝，B 也就完全拿不到这份文档的任何信息。
    if not keep:
        no, t = pages[0]
        cut = max(0, len(t) - budget)
        keep[no] = t[:budget] + (f"...[本页后续 {cut} 字符已截断]" if cut else "")

    selected = [(no, keep[no]) for no in sorted(keep)]
    return selected, True


def join_pdf_pages(selected, total_pages: int, total_chars: int,
                   truncated: bool, page_range: str | None = None) -> str:
    """把选中页拼成 content；裁剪时加页标记与截断说明。"""
    if not truncated:
        return "\n".join(t for _, t in selected)

    parts = []
    for no, t in selected:
        parts.append(f"--- 第 {no} 页 ---\n{t}")
    body = "\n\n".join(parts)
    note = (
        f"\n\n[内容已裁剪：原文档共 {total_pages} 页 / 约 {total_chars:,} 字符，"
        f"此处仅保留 {len(selected)} 页（首页、末页、关键信息页与均匀采样页）。"
        f"如需查看指定范围，可用 POST /parse?pages=起-止 重新上传该文档。"
        f"裁剪只按整页取舍，未改写任何原文，所保留内容均可逐字引用。]"
    )
    if page_range:
        note = note.replace("如需查看指定范围", f"当前按 {page_range} 指定范围选取；如需其他范围")
    return body + note


# ---------------------------------------------------------------------------
# 3.5) 文本类预算控制（Word / Excel / PPT / 纯文本 / 聊天记录 通用）
#     背景：PDF 有页边界可以整页取舍，但 Word/Excel 抽出来是一大串行。
#     几十万字符的 Word 和三百页 PDF 一样会击穿 B 的上下文窗口，
#     所以这里用同一套预算规则做「行级取舍」：只挑行，不改写行。
# ---------------------------------------------------------------------------
_TEXT_HOT_WORDS = _PDF_HOT_WORDS


def _line_score(line: str) -> int:
    """给一行打分：命中的不同反诈关键词个数（去重，避免长行刷分）。"""
    return len({w for w in _TEXT_HOT_WORDS if w in line})


def select_text_lines(lines, budget: int):
    """在字符预算内挑出代表性行，返回 (保留行字典{行号:文本}, 是否裁剪)。

    与 PDF 的整页取舍同源，保证「保留内容逐字未改」，B 的引用校验仍然成立：
      1. 总字数不超预算 → 原样全留（小文档行为不变）
      2. 头 30 行（标题/字段名）+ 尾 30 行（落款/合计/签字）必留
      3. Excel 的 `# Sheet: xxx` 标题行必留（否则后续行失去归属）
      4. 剩余预算按关键词得分装高分行
      5. 还有余量 → 均匀采样，避免只留下开头
    """
    total = sum(len(l) + 1 for l in lines)
    if total <= budget:
        return dict(enumerate(lines)), False

    n = len(lines)
    keep: dict[int, str] = {}
    used = 0

    def take(i: int):
        nonlocal used
        if i in keep:
            return
        cost = len(lines[i]) + 1
        if used + cost > budget:
            return
        keep[i] = lines[i]
        used += cost

    for i in range(min(30, n)):
        take(i)
    for i in range(max(0, n - 30), n):
        take(i)
    for i, line in enumerate(lines):
        if line.startswith("# Sheet"):
            take(i)
    for i in sorted(range(n), key=lambda i: (-_line_score(lines[i]), i)):
        take(i)
    if used < budget * 0.9:
        rest = [i for i in range(n) if i not in keep]
        step = max(1, len(rest) // 20)
        for i in rest[::step]:
            take(i)

    # 兜底：预算比单行还小时（?max_chars 极小），至少保留首行开头并标注，
    # 绝不返回空 content（空内容会被 EvidenceSchema 直接拒绝）。
    if not keep:
        first = lines[0]
        cut = max(0, len(first) - max(1, budget))
        keep[0] = first[:max(1, budget)] + (f"...[本行后续 {cut} 字符已截断]" if cut else "")
    return keep, True


def join_text_lines(keep: dict, total_lines: int, total_chars: int, truncated: bool) -> str:
    """把保留行按原顺序拼成 content；被跳过的区间显式标注省略行数。"""
    if not truncated:
        return "\n".join(keep[i] for i in sorted(keep))

    parts, prev = [], -1
    for i in sorted(keep):
        if i - prev > 1 and parts:
            parts.append(f"[…… 已省略 {i - prev - 1} 行 ……]")
        parts.append(keep[i])
        prev = i
    if prev < total_lines - 1:
        parts.append(f"[…… 已省略 {total_lines - 1 - prev} 行 ……]")

    body = "\n".join(parts)
    note = (
        f"\n\n[内容已裁剪：原文约 {total_lines} 行 / {total_chars:,} 字符，"
        f"此处保留 {len(keep)} 行（开头、结尾、关键信息行与均匀采样行）。"
        f"裁剪只按整行取舍，未改写任何保留内容，均可逐字引用。"
        f"如需查看完整内容，可用 POST /parse?max_chars=更大数值 重新上传。]"
    )
    return body + note


def apply_text_budget(text: str, budget: int):
    """对文本类 content 做预算裁剪，返回 (content, 是否裁剪, 保留行数, 总行数)。"""
    raw = text or ""
    lines = raw.split("\n")
    keep, truncated = select_text_lines(lines, budget)
    content = join_text_lines(keep, len(lines), len(raw), truncated)
    return content, truncated, len(keep), len(lines)


def _slice_by_page_range(pages, page_range: str):
    """按 '10-20' / '5' / '5-' 解析页码范围。解析失败返回 None。"""
    try:
        s = (page_range or "").strip()
        if not s:
            return None
        if "-" in s:
            a, b = s.split("-", 1)
            start = int(a) if a.strip() else 1
            end = int(b) if b.strip() else 10 ** 9
        else:
            start = end = int(s)
        if start <= 0 or end < start:
            return None
    except ValueError:
        return None
    return [(no, t) for no, t in pages if start <= no <= end]


def _first_page_no(page_range: str | None) -> int:
    """从 page_range 里取起始页码（1-based），用于扫描件只渲染一页时定位。"""
    s = (page_range or "").strip()
    if not s:
        return 1
    head = s.split("-", 1)[0].strip()
    try:
        return max(1, int(head)) if head else 1
    except ValueError:
        return 1


def build_pdf_evidence(filename, mime, data: bytes, origin: str | None = None,
                       max_chars: int | None = None, page_range: str | None = None) -> dict:
    pages, total_pages = extract_pdf_pages(data)
    if pages:
        total_chars = sum(len(t) for _, t in pages)
        sliced = _slice_by_page_range(pages, page_range) if page_range else None
        if page_range and sliced:
            pages = sliced
        budget = MAX_CONTENT_CHARS if max_chars is None else max(1000, int(max_chars))
        selected, truncated = select_pdf_pages(pages, budget,
                                               sequential=bool(page_range and sliced))
        content = join_pdf_pages(selected, total_pages, total_chars, truncated,
                                 page_range=page_range)
        name = filename or "未命名文件"
        if truncated:
            name = f"{name} [保留 {len(selected)}/{total_pages} 页]"
        return {
            "id": str(uuid.uuid4()),
            "name": name,
            "kind": "pdf",
            "mimeType": mime or "application/pdf",
            "content": content,
            "source": source_label("pdf", origin),
        }
    try:
        import pypdf  # noqa: F401
    except ImportError:
        raise RuntimeError("PDF 解析需要 pypdf，请先执行: python -m pip install pypdf")

    # pypdf 已装但抽不到文本 = 图片型扫描件。视觉模型不收 application/pdf，
    # 所以必须渲染成 PNG 才能进 kind=image 通道；渲染不了就安全降级为 kind=text 说明，
    # 绝不把 PDF 的 data URL 当 image_url 发出去（那会让整个分析请求 502）。
    # 几百页扫描件不可能全渲染（每页 base64 后体积巨大），只渲染一页（默认第 1 页，
    # 可用 ?pages=N 指定），并把「共 N 页 / 当前第几页」写进 name，避免下游误判为完整文档。
    want_page = _first_page_no(page_range) - 1
    png, page_total = render_pdf_page_png(data or b"", page=want_page)
    if png:
        shown = min(max(want_page + 1, 1), page_total)
        name = filename or "未命名文件"
        if page_total > 1:
            name = f"{name} [仅第 {shown} 页 / 共 {page_total} 页]"
        return {
            "id": str(uuid.uuid4()),
            "name": name,
            "kind": "image",
            "mimeType": "image/png",
            "content": f"data:image/png;base64,{base64.b64encode(png).decode('ascii')}",
            "source": source_label("pdf", origin),
        }
    return {
        "id": str(uuid.uuid4()),
        "name": filename or "未命名文件",
        "kind": "text",
        # mimeType 保留真实格式（说明原文件是 PDF），kind 表示「按文本处理」
        "mimeType": mime or "application/pdf",
        "content": (
            f"[扫描件 PDF：{filename or '未命名'} 没有可抽取的文字层，且未能渲染成图片。"
            f"常见原因：未安装 PyMuPDF（python -m pip install pymupdf）、PDF 已加密、"
            f"或文件损坏。请让用户直接提供截图或原件，**不要猜测文件内容**。"
            f"也可用 ?pages=N 指定其他页重试]"
        ),
        "source": source_label("pdf", origin),
    }


# ---------------------------------------------------------------------------
# 3.5) A8 · 其他文档（docx / xlsx / pptx）文本抽取
#      这些格式本质是 OOXML（zip），不能当纯文本解码，否则是乱码。
#      抽成纯文本后当 kind="text" 交给 B —— B 对「非 image」一律当文本分析，
#      所以零契约改动、B 原生态接住。依赖可选，缺失时给出清晰安装提示。
# ---------------------------------------------------------------------------
OFFICE_EXTS = {"docx", "xlsx", "pptx"}
OFFICE_MIMES = {
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
}


def _office_format(filename: str, mime: str):
    ext = ""
    if filename and "." in filename:
        ext = filename.rsplit(".", 1)[-1].lower()
    if ext in OFFICE_EXTS:
        return ext
    return OFFICE_MIMES.get(mime)


def extract_legacy_doc_text(data: bytes) -> str | None:
    """尽力抽取 Word 97-2003 (.doc, CFB 容器) 正文。

    真机实测：微信里大量公文仍是旧版 .doc，python-docx 读不了、当二进制解码又是乱码。
    这里用 olefile 取 WordDocument 流，按 UTF-16LE 解码后切出连续可读片段——
    对中文公文效果好（实测 9k+ 字通顺正文），属于「尽力而为」而非规范解析：
    表格/页眉顺序可能不严格，但足够作为证据文本给下游。
    返回 None 表示 olefile 未装或不是可用的 .doc。
    """
    try:
        import olefile
    except ImportError:
        return None
    try:
        ole = olefile.OleFileIO(io.BytesIO(data or b""))
    except Exception:
        return None
    try:
        if not ole.exists("WordDocument"):
            return None
        raw = ole.openstream("WordDocument").read()
    except Exception:
        return None
    finally:
        try:
            ole.close()
        except Exception:
            pass
    txt = raw.decode("utf-16-le", errors="ignore")
    runs = re.findall(
        r"[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef0-9A-Za-z\-—\.%（）]+", txt
    )
    runs = [r.strip() for r in runs if re.search(r"[\u4e00-\u9fa5]", r) and len(r.strip()) >= 4]
    if not runs:
        return None
    joined = "\n".join(runs)
    cjk = len(re.findall(r"[\u4e00-\u9fa5]", joined))
    if cjk < 30:  # 太少说明没抽到正文，别拿噪声充证据
        return None
    return joined


def extract_office_text(filename: str, mime: str, data: bytes):
    """返回 (text, engine)。text=None 表示未装依赖或解析失败；engine 提示缺哪个库。

    纯文本类（csv/json/md/log/老版 .doc/.xls 二进制）不走这里，仍由 decode_text 处理。
    """
    fmt = _office_format(filename, mime)
    if fmt is None:
        return None, None
    import tempfile
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(suffix="." + fmt, delete=False) as f:
            f.write(data or b"")
            tmp = f.name
        if fmt == "docx":
            try:
                from docx import Document
            except ImportError:
                return None, "docx"
            doc = Document(tmp)
            parts = [p.text for p in doc.paragraphs if p.text and p.text.strip()]
            return "\n".join(parts), "docx"
        if fmt == "xlsx":
            try:
                from openpyxl import load_workbook
            except ImportError:
                return None, "xlsx"
            wb = load_workbook(tmp, read_only=True, data_only=True)
            lines = []
            for ws in wb.worksheets:
                lines.append(f"# Sheet: {ws.title}")
                for row in ws.iter_rows(values_only=True):
                    cells = ["" if c is None else str(c) for c in row]
                    # 真机实测：模板表常被格式化到几百列，尾部全是空单元格，
                    # 不裁掉会让一条证据膨胀到十几万字符的制表符噪声。
                    while cells and not cells[-1].strip():
                        cells.pop()
                    if any(c.strip() for c in cells):
                        lines.append("\t".join(cells))
            return "\n".join(lines), "xlsx"
        if fmt == "pptx":
            try:
                from pptx import Presentation
            except ImportError:
                return None, "pptx"
            prs = Presentation(tmp)
            parts = []
            for slide in prs.slides:
                for shape in slide.shapes:
                    if shape.has_text_frame and shape.text_frame.text.strip():
                        parts.append(shape.text_frame.text.strip())
            return "\n".join(parts), "pptx"
    except Exception:
        return None, fmt
    finally:
        if tmp and os.path.isfile(tmp):
            try:
                os.unlink(tmp)
            except Exception:
                pass
    return None, fmt


# ---------------------------------------------------------------------------
# 4) A4/A6 · 媒体感知聊天解析
# ---------------------------------------------------------------------------
# 聊天消息支持的类型（A 侧约定，离线可测）
CHAT_MSG_TYPES = {
    "text", "system", "emoji",      # 直接进对话文本
    "image", "file",                # 进对话(内联标记) + 独立 evidence
    "voice",                        # 进对话(标记)，转写留后续
    "transfer",                     # 进对话(金额标记)
    "link", "location", "card",     # 进对话(文本/链接)
}


def _coerce_record(rec: dict) -> dict | None:
    """归一化一条聊天消息，兼容多种字段命名。"""
    if not isinstance(rec, dict):
        return None
    t = (rec.get("type") or rec.get("msgType") or rec.get("kind") or "text")
    t = str(t).lower()
    if t not in CHAT_MSG_TYPES:
        t = "text"
    return {
        "type": t,
        "sender": rec.get("sender") or rec.get("from") or rec.get("speaker") or "未知",
        "time": rec.get("time") or rec.get("timestamp") or rec.get("date") or "",
        "text": rec.get("text") or rec.get("content") or rec.get("msg") or "",
        "media": rec.get("media") or rec.get("path") or rec.get("file") or rec.get("url") or "",
        "amount": rec.get("amount") or rec.get("money") or "",
    }


def build_chat_content(records) -> tuple[str, list]:
    """把聊天记录（list[dict]）拼成对话文本，对媒体/特殊类型插入【内联标记】。
    返回 (chat_text, media_list)；media_list 为需独立成证的媒体项
    （{name, media_ref, kind_hint, time}）。

    内联标记约定（A 侧，便于 B/C 理解，不强制改契约）：
        [图片@14:05: 名 见独立证据]   [文件:名@14:10 见独立证据]
        [语音@14:15]                  [转账 ¥500@14:12]
    """
    lines = []
    media_list = []
    for rec in records:
        r = _coerce_record(rec)
        if r is None:
            continue
        t, sender, time, text, media, amount = (
            r["type"], r["sender"], r["time"], r["text"], r["media"], r["amount"])
        ts = f"[{time}] " if time else ""
        if t in ("text", "system", "emoji"):
            body = text if text else ("[表情]" if t == "emoji" else "")
            lines.append(f"{ts}{sender}: {body}")
        elif t == "image":
            if not media:
                # 没有真实附件（未解密 / 纯标记）：只留文本，不产出「缺失」占位证据
                lines.append(f"{ts}{sender}: {text or '[图片]'}")
                continue
            name = "图片(内嵌)" if media.startswith("data:") else (media.rsplit("/", 1)[-1] or "图片")
            lines.append(f"{ts}{sender}: [图片@{time}: {name} 见独立证据]")
            media_list.append({"name": name, "media_ref": media, "kind_hint": "image", "time": time})
        elif t == "file":
            if not media:
                # 小程序卡片/链接式文件消息只有标题文本，没有可读附件
                lines.append(f"{ts}{sender}: {text or '[文件]'}")
                continue
            name = "文件(内嵌)" if media.startswith("data:") else (media.rsplit("/", 1)[-1] or "文件")
            lines.append(f"{ts}{sender}: [文件:{name}@{time} 见独立证据]")
            media_list.append({"name": name, "media_ref": media, "kind_hint": "file", "time": time})
        elif t == "voice":
            if media:
                # 语音有附件路径时也独立成证，便于后续按需转写（SILK→WAV）
                vname = "语音(内嵌)" if media.startswith("data:") else (media.rsplit("/", 1)[-1] or "语音")
                lines.append(f"{ts}{sender}: [语音@{time}: {vname} 见独立证据]")
                media_list.append({"name": vname, "media_ref": media, "kind_hint": "voice", "time": time})
            else:
                lines.append(f"{ts}{sender}: [语音@{time}]")
        elif t == "transfer":
            amt = f"¥{amount}" if amount else "转账"
            lines.append(f"{ts}{sender}: [转账 {amt}@{time}]")
        elif t == "link":
            lines.append(f"{ts}{sender}: {text or '[链接]'} {media}".strip())
        else:
            lines.append(f"{ts}{sender}: {text}")
    return "\n".join(lines), media_list


def media_kind(name: str, mime: str) -> str:
    """聊天媒体附件 → 契约内的 kind（text/chat/image/pdf 四选一）。

    注意：这里**不看**「文件名是否含 chat」，否则「聊天记录.docx」会被
    evidence_kind() 误判成 chat，导致把 OOXML 二进制当对话文本解码出乱码。
    音视频在契约里没有原生 kind，落成 text 的描述性占位（B 对非 image 一律当文本）。
    """
    m = (mime or "").lower()
    lower = (name or "").lower()
    if m.startswith("image/"):
        return "image"
    if m == "application/pdf" or lower.endswith(".pdf"):
        return "pdf"
    return "text"


_BINARY_MIMES = {
    "application/zip", "application/x-zip-compressed", "application/x-rar-compressed",
    "application/vnd.rar", "application/x-7z-compressed", "application/gzip",
    "application/x-tar", "application/octet-stream",
}
_BINARY_EXTS = (".zip", ".rar", ".7z", ".gz", ".tar", ".exe", ".dll", ".bin", ".apk", ".dmg", ".iso")
# 旧版 Office（CFB 二进制，不是 OOXML）：python-docx/openpyxl/python-pptx 都读不了，
# 直接 decode_text 会把二进制解成乱码噪声，因此单独给占位说明。
_LEGACY_OFFICE_EXTS = (".doc", ".xls", ".ppt")


def _is_binary_mime(mime: str, name: str) -> bool:
    """压缩包/可执行文件等不抽文本：避免把二进制解码成几十万字噪声塞给 B。"""
    m = (mime or "").lower()
    lower = (name or "").lower()
    return m in _BINARY_MIMES or lower.endswith(_BINARY_EXTS)


def _media_placeholder(name: str, ref: str, time: str,
                       origin: str | None = None) -> dict:
    """附件读不到时的合法占位。

    必须是 kind="text" 而不是 image：B 会把 kind=image 的 content 原样当图片 URL
    发给视觉模型，而这里是纯文本描述，发出去必然被模型 API 拒绝，拖垮整个分析。
    改成 text 后 B 当文本读，模型看到「媒体文件缺失」就知道这条证据缺了，
    还能在 evidenceGaps 里建议补证。
    """
    return {
        "id": str(uuid.uuid4()),
        "name": name,
        "kind": "text",
        "mimeType": "text/plain",
        "content": f"[媒体文件缺失: {ref or name}]",
        "source": origin or "聊天媒体",
    }


def build_media_evidence(item: dict, media_dir: str | None = None,
                         origin: str | None = None) -> dict:
    """把一条媒体项转成独立 evidence。

    media_ref 支持：data URL / 纯 base64 / 路径(相对或绝对)。
    按真实 mime 分流：图片→base64 data URL；PDF→抽文本；纯文本/OOXML→文本；
    音视频等二进制→描述性占位（不把 base64 塞进 image，避免 B 拿音视频去走视觉分析）。
    文件不存在或无法读取 → 返回合法占位（标记缺失），契约仍通过。
    """
    name = item["name"]
    ref = item.get("media_ref") or ""
    hint = item.get("kind_hint")
    time = item.get("time", "")
    mime = "application/octet-stream"
    raw = None

    if ref.startswith("data:"):
        header, _, b64 = ref.partition(",")
        mime = header.replace("data:", "").split(";")[0] or "application/octet-stream"
        try:
            raw = base64.b64decode(b64)
        except Exception:
            raw = b""
    elif re.match(r"^[A-Za-z0-9+/=\s]{60,}$", ref or ""):
        mime = "image/png"
        try:
            raw = base64.b64decode(ref.strip())
        except Exception:
            return _media_placeholder(name, ref, time, origin)
    else:
        path = ref
        if media_dir and path and not os.path.isabs(path):
            path = os.path.join(media_dir, path)
        if path and os.path.isfile(path):
            with open(path, "rb") as f:
                raw = f.read()
            mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
        else:
            return _media_placeholder(name, ref, time, origin)

    # ⚠️ 与 /parse 共用同一道闸门，且同样**只治文档**：PDF / Office / 文本要抽正文，
    # 体积直接决定耗时；图片只做 base64、不解析，不受此限（与上传侧保持一致）。
    # 本函数原先完全没有体积判断，超大文档会整段进解析流程，这里补上的是文档那一半。
    kind = media_kind(name, mime)
    if raw and len(raw) > MAX_CONTENT_SIZE and kind != "image":
        return oversize_evidence(name, mime, raw, origin or "聊天媒体")

    if kind == "image":
        url = image_data_url(mime, raw or b"")
        if url:
            content = url
            if VISION_IMAGE_HINT and raw and len(raw) > VISION_IMAGE_HINT:
                name = (f"{name} [原图 {len(raw) / 1024 / 1024:.1f} MB，"
                        f"可能超出模型单图上限]")
            mime = (mime or "").lower().split(";")[0] or "image/png"
            if mime == "image/jpg":
                mime = "image/jpeg"
            if mime not in VISION_MIMES:  # Pillow 转码过，实际是 PNG
                mime = "image/png"
        else:
            # svg / bmp 转码失败等：降级为文本说明，绝不把非法内容塞进 image 通道
            kind = "text"
            content = (f"[图片 {name} ({mime}, {len(raw or b'')} 字节) "
                       f"无法转换为视觉模型可读的图片格式，原件见导出目录]")
    elif kind == "pdf":
        try:
            ev = build_pdf_evidence(name, mime, raw or b"", origin)
        except RuntimeError as e:  # pypdf 未装：降级成文本提示，不让整个 bundle 失败
            ev = {"id": str(uuid.uuid4()), "name": name, "kind": "text",
                  "mimeType": mime, "content": f"[PDF {name} 未抽取: {e}]"}
        ev["source"] = origin or "聊天媒体"
        return ev
    else:  # text：OOXML 抽文本 / 纯文本解码 / 音视频给描述性占位
        if _office_format(name, mime):
            text, engine = extract_office_text(name, mime, raw or b"")
            if text is not None:
                content = text
            else:
                content = f"[文档 {name} 需解析引擎 {engine}，暂未抽取正文]"
        elif mime.startswith(("audio/", "video/")) or (hint or "") in ("voice", "video"):
            content = (f"[媒体文件: {name} ({mime}, {len(raw or b'')} 字节)，"
                       f"未解析，原件见导出目录]")
        elif (name or "").lower().endswith(".doc"):
            legacy = extract_legacy_doc_text(raw or b"")
            content = legacy or (
                f"[旧版 Office 文档: {name} ({len(raw or b'')} 字节)，"
                f"未抽取到正文（需 .doc→.docx 转换），原件见导出目录]")
        elif (name or "").lower().endswith(_LEGACY_OFFICE_EXTS):
            content = (f"[旧版 Office 文档: {name} ({len(raw or b'')} 字节)，"
                       f"需 .doc/.xls/.ppt → OOXML 转换后才能抽取正文，原件见导出目录]")
        elif _is_binary_mime(mime, name):
            content = (f"[压缩包/二进制文件: {name} ({mime}, {len(raw or b'')} 字节)，"
                       f"未解析，原件见导出目录]")
        else:
            content = decode_text(raw or b"")

    if kind == "text" and len(content) > 30000:
        content = content[:30000] + f"\n... [正文过长已截断，原文 {len(content)} 字]"

    return {
        "id": str(uuid.uuid4()),
        "name": name,
        "kind": kind,
        "mimeType": mime,
        "content": content,
        "source": origin or "聊天媒体",
    }


def build_chat_from_text(filename: str, data: bytes) -> str:
    """兼容两种 chat 输入：
    - JSON 数组（结构化，带 type）→ 媒体感知，返回含内联标记的对话文本
    - 纯文本对话稿（如 raw_sample.txt）→ 直接当 content
    """
    text = decode_text(data)
    stripped = text.strip()
    try:
        obj = json.loads(stripped)
        if isinstance(obj, list):
            chat_text, _media = build_chat_content(obj)
            return chat_text
        if isinstance(obj, dict):
            # 兼容钉钉/飞书适配器输出的信封：{"source":"钉钉","messages":[...]}
            records = obj.get("messages") or obj.get("records") or []
            if isinstance(records, list) and records:
                chat_text, _media = build_chat_content(records)
                return chat_text
    except Exception:
        pass
    return text


def build_chat_bundle(records, name: str | None = None, media_dir: str | None = None,
                      source: str = "用户上传") -> list:
    """返回 [chat_evidence, *media_evidences]。用于 /parse_chat（A 侧扩展）。

    source 由调用方显式给（微信/钉钉/飞书）；不给就按「用户上传」标，
    不替调用方猜平台——猜错会让 C 的溯源 chip 显示假来源。"""
    chat_text, media_list = build_chat_content(records)
    evidences = [{
        "id": str(uuid.uuid4()),
        "name": name or "聊天记录",
        "kind": "chat",
        "mimeType": "text/plain",
        "content": chat_text,
        "source": source,
    }]
    for item in media_list:
        # 媒体证据的 source 也继承平台（微信/钉钉/飞书），便于 B/C 溯源
        evidences.append(build_media_evidence(item, media_dir, source))
    return evidences


# ---------------------------------------------------------------------------
# 5) 单条 evidence 构造（/parse 用）
# ---------------------------------------------------------------------------
def source_label(kind: str, origin: str | None = None) -> str:
    """source 只表示「来源渠道」：微信 / 钉钉 / 飞书 / 用户上传。

    文件格式不写进 source——格式由 name（含 .docx/.xlsx 后缀）+ mimeType 表达，
    content 自身也保留结构线索（如 Excel 的 `# Sheet:`）。
    契约里 source 是自由字符串，加平台值零校验风险。

    默认值（无 origin 时）一律为「用户上传」：人工上传入口 /parse 的 origin 恒为 None，
    聊天 JSON 无平台信封时 chat_origin 也返回 None。此前的「chat 默认微信」会把用户手敲 /
    飞书·钉钉导出的聊天裸文件误标成微信，属平台溯源造假。真实平台来源由聊天信封的
    source 字段或适配器显式传入的 source 覆盖（/parse_chat 自带 source，不受影响）。
    """
    if origin and str(origin).strip():
        return str(origin).strip()
    return "用户上传"


def chat_origin(data: bytes) -> str | None:
    """从聊天 JSON 信封里读来源平台。

    钉钉适配器输出的 `<会话名>.json` 形如 {"source":"钉钉","messages":[...]}，
    这里把它识别出来；裸数组 / 纯文本稿则返回 None（由调用方决定默认值）。
    """
    try:
        obj = json.loads(decode_text(data).strip())
        if isinstance(obj, dict):
            s = obj.get("source")
            if isinstance(s, str) and s.strip():
                return s.strip()
    except Exception:
        pass
    return None


def save_upload(data: bytes, filename: str) -> str:
    """把原件落盘，返回可访问的存储文件名；失败返回空串。

    存储名必须是纯 ASCII（<uuid12>.<ext>），否则中文文件名会让下载 URL
    变成非 ASCII 字符串——浏览器会自动转义，但 HTTP 客户端和模型转述时极易断链。
    原始文件名写进同名 .name 旁注文件，下载时再还原。
    """
    try:
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        ext = re.sub(r"[^a-z0-9]", "", os.path.splitext(filename or "")[1].lower())[:10]
        stored = f"{uuid.uuid4().hex[:12]}" + (f".{ext}" if ext else "")
        fp = os.path.join(UPLOAD_DIR, stored)
        with open(fp, "wb") as f:
            f.write(data or b"")
        try:
            with open(fp + ".name", "w", encoding="utf-8") as f:
                f.write(filename or stored)
        except Exception:
            pass
        return stored
    except Exception:
        return ""


def oversize_evidence(filename, mime, data: bytes, origin: str | None = None,
                      base_url: str | None = None) -> dict:
    """超过 100MB 的附件：完全不读内容，只回传「下载链接 + 解释」。

    设计意图：模型读不了这个 PDF，但它可以把链接原样转述给用户，
    所以 content 里必须带上可直接点击的地址，而不是一句空话。
    原件照样落盘，所以链接是真能下载的。
    """
    name = filename or "未命名文件"
    size_mb = len(data or b"") / 1024 / 1024
    stored = save_upload(data or b"", name)
    base = (PUBLIC_BASE_URL or base_url or "").rstrip("/")
    link = f"{base}/files/{stored}" if (stored and base) else ""

    lines = [
        f"[附件过大，未解析] 文件：{name}（{size_mb:.1f} MB）",
        f"原因：超过单份附件上限 {MAX_CONTENT_SIZE_MB:.0f} MB。"
        f"超过上限的文件服务端不读取内容（不抽文本、不做 OCR），因此这里没有原文。",
    ]
    if link:
        lines.append(f"下载链接：{link}")
        lines.append("请将上述链接原样告知用户，由用户自行下载查看；不要猜测文件内容。")
    else:
        lines.append("（未能生成下载链接，请让用户直接提供原件）")
    lines.append(f"如需直接分析，请拆分到 {MAX_CONTENT_SIZE_MB:.0f} MB 以内再上传。")

    return {
        "id": str(uuid.uuid4()),
        "name": name,
        "kind": "text",
        "mimeType": mime or "application/octet-stream",
        "content": "\n".join(lines),
        "source": source_label("text", origin),
    }


_MAGIC_SIGNS = (
    (b"%PDF", "application/pdf"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
)


def sniff_mime(data: bytes):
    """按文件头猜类型。只用于 MIME 缺失/为 octet-stream 时兜底。

    为什么需要：浏览器或转发层偶尔报 application/octet-stream，
    此时 PDF 会被判成 text，二进制内容被 decode_text 直接倒进 content，
    一份几十 MB 的 PDF 就变成一坨乱码文本送给下游。
    """
    head = (data or b"")[:16]
    for magic, mime in _MAGIC_SIGNS:
        if head.startswith(magic):
            return mime
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    return None


def build_evidence(filename, mime, data: bytes, origin: str | None = None,
                   max_chars: int | None = None, page_range: str | None = None,
                   base_url: str | None = None) -> dict:
    # MIME 不可靠时按魔数兜底（否则 PDF 会被当文本，二进制倒进 content）。
    # 放在闸门之前，是因为闸门要按类型决定适不适用——判断类型需要可靠的 MIME。
    if (mime or "").lower() in ("", "application/octet-stream", "binary/octet-stream"):
        mime = sniff_mime(data) or mime

    # 唯一的体积闸门：>100MB 不读内容，只回「链接 + 解释」。
    # ⚠️ **只管需要解析的文档**（PDF / Word / Excel / 文本）：抽正文、渲染页面的耗时
    # 随体积线性增长，必须在解析之前止损——这道闸门存在的全部理由就是防解析超时。
    # 图片不解析，只是 base64 塞进 content，不存在「解析太久」，因此**不受此限**。
    # （图片若大到模型收不下，那是 analyze 那一跳的事，应由 B 按 content 长度处理，
    #   不是在这里按文件体积拦——这里拦了反而会让「图能进、文档不能进」的怪现象。）
    if data and len(data) > MAX_CONTENT_SIZE and media_kind(filename or "", mime or "") != "image":
        return oversize_evidence(filename, mime, data, origin, base_url)

    kind = evidence_kind(filename or "", mime or "", data)
    if kind == "image":
        url = image_data_url(mime or "", data or b"")
        if url:
            content = url
            m = (mime or "").lower().split(";")[0]
            mime = "image/jpeg" if m == "image/jpg" else (
                m if m in VISION_MIMES else "image/png")
        else:
            # 转不成视觉模型能吃的格式（svg / bmp 且 Pillow 失败等）：降级为文本说明
            kind = "text"
            content = (f"[图片 {filename or '未命名'} ({mime}, {len(data or b'')} 字节) "
                       f"无法转换为视觉模型可读的图片格式]")
    elif kind == "text":
        # A8: docx/xlsx/pptx 等 OOXML 文档先抽文本，避免把二进制当文本解码产生乱码
        if _office_format(filename or "", mime or ""):
            text, engine = extract_office_text(filename or "", mime or "", data)
            if text is not None:
                content = text
            elif engine is not None:
                raise RuntimeError(
                    f"解析 {engine.upper()} 需要 python-{engine} 库，请先执行: "
                    f"python -m pip install python-docx openpyxl python-pptx"
                )
            else:
                content = decode_text(data or b"")
        else:
            content = decode_text(data or b"")
    elif kind == "pdf":
        return build_pdf_evidence(filename, mime, data, origin,
                                  max_chars=max_chars, page_range=page_range)
    else:  # chat
        content = build_chat_from_text(filename or "", data)
        if not origin:
            origin = chat_origin(data)  # 钉钉/飞书信封里自带 source 时自动识别

    # 文本 / 聊天也要守预算：几十万字符的 Word、几万条消息的聊天记录，
    # 和三百页 PDF 一样会击穿 B 的上下文窗口（B 对 content 长度零限制）。
    name = filename or "未命名文件"
    if kind in ("text", "chat"):
        budget = MAX_CONTENT_CHARS if max_chars is None else max(1000, int(max_chars))
        content, truncated, kept, total_lines = apply_text_budget(content, budget)
        if truncated:
            name = f"{name} [保留 {kept}/{total_lines} 行]"

    return {
        "id": str(uuid.uuid4()),
        "name": name,
        "kind": kind,
        "mimeType": mime or "application/octet-stream",
        "content": content,
        "source": source_label(kind, origin),
    }


# ---------------------------------------------------------------------------
# 6) HTTP 服务
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    # CORS：默认全开，因为存在「C 直连 A」的部署形态（大文件绕开 B 的 8MB 前置检查）。
    # 走 B 转发时这些头无害；直连时没有它们，浏览器连 OPTIONS 预检都过不去。
    CORS_ALLOW_ORIGIN = os.environ.get("CORS_ALLOW_ORIGIN", "*")

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", self.CORS_ALLOW_ORIGIN)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")

    def _send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        """预检请求：只回 204 + CORS 头，不读请求体。"""
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path.rstrip("/")
        if path == "/health":
            self._send_json({"status": "ok"})
        elif path.startswith("/files/"):
            self._serve_file(path[len("/files/"):])
        # ---- /source/* 必须排在兜底之前：兜底是「200 + 服务说明」而不是 404，
        #      一旦被它接住，前端拿到 200 却读不到 status 字段，是静默错误，比 500 难查。
        elif path == "/source/list":
            self._source_list()
        elif path == "/source/status":
            self._source_status()
        else:
            self._send_json({"service": "TruthTrace A 解析服务",
                             "endpoints": ["POST /parse", "POST /parse_chat",
                                           "GET /files/<id>", "GET /health",
                                           "GET /source/list", "GET /source/status",
                                           "POST /source/connect", "POST /source/sync"]})

    # ---------------------------------------------------------------- /source
    def _source_unavailable(self):
        self._send_json({"error": "数据源服务不可用", "detail": _SOURCE_ERR,
                         "hint": "ai_ingest 依赖缺失；/parse 与 /parse_chat 不受影响"}, 501)

    def _source_list(self):
        if not _SOURCE_SVC:
            return self._source_unavailable()
        self._send_json(_SOURCE_SVC.list_sources())

    def _source_status(self):
        if not _SOURCE_SVC:
            return self._source_unavailable()
        q = parse_qs(urlparse(self.path).query)
        obj, code = _SOURCE_SVC.status(q.get("source", [None])[0])
        self._send_json(obj, code)

    def _base_url(self) -> str:
        """推断本服务的对外基址，用于拼超限文件的下载链接。"""
        host = self.headers.get("Host") or f"127.0.0.1:{self.server.server_port}"
        return f"http://{host}"

    def _serve_file(self, stored: str):
        """提供超限原件的下载（只读，白名单校验存储名，禁止目录穿越）。"""
        safe = os.path.basename(stored or "")
        if not re.fullmatch(r"[0-9a-f]{12}(\.[A-Za-z0-9]{1,10})?", safe):
            self._send_json({"error": "非法的文件标识"}, 404)
            return
        fp = os.path.join(UPLOAD_DIR, safe)
        if not os.path.isfile(fp):
            self._send_json({"error": "文件不存在或已被清理"}, 404)
            return

        disp = safe
        namefile = fp + ".name"
        if os.path.isfile(namefile):
            try:
                with open(namefile, encoding="utf-8") as f:
                    disp = f.read().strip() or safe
            except Exception:
                pass

        ctype = mimetypes.guess_type(disp)[0] or "application/octet-stream"
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(os.path.getsize(fp)))
        self.send_header("Content-Disposition",
                         f"attachment; filename*=UTF-8''{quote(disp)}")
        self.end_headers()
        with open(fp, "rb") as f:
            while True:
                chunk = f.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)

    def _read_body(self):
        """读完整请求体，**不设大小上限**。

        为什么不对请求体设限：multipart 的体积天然大于文件本身，用 Content-Length
        当闸门会让边界值（正好 100MB 的文件）被误拒，而且拒的是「请求」不是「附件」。
        体积判断只对解析出来的 file 字段做，见 build_evidence 的 MAX_CONTENT_SIZE。
        """
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            self._send_json({"error": "Content-Length 非法"}, 400)
            return None
        if length == 0:
            self._send_json({"error": "请求体为空"}, 400)
            return None
        return self.rfile.read(length)

    def do_POST(self):
        parsed_url = urlparse(self.path)
        path = parsed_url.path.rstrip("/")
        query = parse_qs(parsed_url.query)
        # 三个可选开关（不带则用默认值，C 侧现有调用完全不受影响）：
        #   ?max_chars=8000   单条证据正文预算（字符）
        #   ?pages=100-120    只看指定页码范围
        #   ?source=钉钉      来源渠道（用户上传 / 微信 / 钉钉 / 飞书），优先级高于信封与文件名
        q_max_chars = query.get("max_chars", [None])[0]
        q_pages = query.get("pages", [None])[0]
        q_source = query.get("source", [None])[0]

        # ---- /parse_chat：聊天记录 JSON → {evidences:[...]}（A 侧媒体感知扩展）----
        if path == "/parse_chat":
            body = self._read_body()
            if body is None:
                return
            try:
                payload = json.loads(body.decode("utf-8"))
                records = payload.get("records") or payload.get("messages") or []
                name = payload.get("name")
                media_dir = payload.get("media_dir")
                # 默认「用户上传」而不是「微信」：调用方没说是哪个平台，就不该替它编一个。
                # 三个适配器（微信/钉钉/飞书）都显式传 source，不受影响；
                # 手敲/粘贴的聊天稿走默认值，标成「用户上传」才是诚实的溯源。
                source = payload.get("source") or "用户上传"
                if not isinstance(records, list) or not records:
                    self._send_json({"error": "records 必须是非空数组"}, 400)
                    return
                evidences = build_chat_bundle(records, name, media_dir, source)
                self._send_json({"evidences": evidences})
            except json.JSONDecodeError:
                self._send_json({"error": "请求体必须是 JSON"}, 400)
            except Exception as e:  # noqa: BLE001
                self._send_json({"error": f"解析聊天失败: {e}"}, 400)
            return

        # ---- /source/connect|sync（方案 A：数据源连接与 AI 精准取数）----
        # 排在 /parse 兜底之前，理由同 do_GET：兜底不是 404，被它接住就是静默错误。
        if path in ("/source/connect", "/source/sync"):
            if not _SOURCE_SVC:
                return self._source_unavailable()
            body = self._read_body()
            if body is None:
                return
            try:
                payload = json.loads(body.decode("utf-8")) if body.strip() else {}
            except json.JSONDecodeError:
                self._send_json({"error": "请求体必须是 JSON"}, 400)
                return
            if path == "/source/connect":
                obj, code = _SOURCE_SVC.connect(payload.get("source"))
            else:
                try:
                    mw = int(payload.get("max_windows", 8))
                except (TypeError, ValueError):
                    mw = 8
                obj, code = _SOURCE_SVC.sync(
                    payload.get("source"),
                    goal=payload.get("goal"),
                    source_data=payload.get("source_data"),
                    mode=payload.get("mode", "auto"),
                    max_windows=mw,
                )
            self._send_json(obj, code)
            return

        # ---- /parse：单文件 → {evidence:{...}}（B 当前直接兼容）----
        if path != "/parse":
            self._send_json({"error": "仅支持 POST /parse 与 POST /parse_chat"}, 404)
            return
        body = self._read_body()
        if body is None:
            return
        ctype = self.headers.get("Content-Type", "")
        try:
            filename, data, part_ctype = parse_file_field(body, ctype)
        except Exception as e:  # noqa: BLE001
            self._send_json({"error": f"解析上传失败: {e}"}, 400)
            return
        if not data:
            self._send_json({"error": "未收到 file 字段或文件为空"}, 400)
            return
        # 这里**不做体积拒收**：>100MB 的判定在 build_evidence 里，走「链接 + 解释」而非报错。
        # 用户要的是「原件仍拿得到」，413 只会让他一无所获。
        mime = part_ctype or mimetypes.guess_type(filename or "")[0] or "application/octet-stream"
        try:
            max_chars = int(q_max_chars) if q_max_chars else None
        except ValueError:
            self._send_json({"error": "max_chars 必须是整数"}, 400)
            return
        try:
            evidence = build_evidence(filename, mime, data, origin=q_source,
                                      max_chars=max_chars, page_range=q_pages,
                                      base_url=self._base_url())
        except RuntimeError as e:
            self._send_json({"error": str(e)}, 500)
            return
        self._send_json({"evidence": evidence})


def main():
    port = int(os.environ.get("PORT", "8000"))
    if "--port" in sys.argv:
        i = sys.argv.index("--port")
        if i + 1 < len(sys.argv):
            try:
                port = int(sys.argv[i + 1])
            except ValueError:
                pass
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"[A 解析服务] 已启动: http://localhost:{port}")
    print(f"  POST /parse      单文件 → 单条 evidence (B 当前兼容)")
    print(f"  POST /parse_chat 聊天JSON → evidences[] bundle (需 B 改 parser 支持数组)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[A 解析服务] 已停止")


if __name__ == "__main__":
    main()
