#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
feishu_to_synapse.py — 飞书端 A6 取数适配器（lark-cli → A4 chat 证据）
=====================================================================
把飞书官方 CLI `lark-cli` 导出的聊天记录，归一化成与微信/钉钉侧**完全一致**的
下游输入 `[{seq, sender, time, text, type, media, amount}]`，直接喂 A4
（`POST /parse_chat`）即可产出 `kind="chat"` 证据 + 独立媒体证据，B / C 零改动。

已适配 lark-cli v1.0.98 真实返回（`+chat-messages-list --format json`）：
    { "messages": [
        { "message_id": "om_xxx",
          "msg_type": "text",                       # text/post/image/file/audio/media/...
          "create_time": "1761984000000",           # 毫秒时间戳（字符串）
          "sender": {"id":"ou_xxx","sender_type":"user","name":"张三"},
          "content": "{\"text\":\"...\"}",          # OpenAPI 原始 JSON 串，或 CLI 渲染后的文本
          "deleted": false,
          "resources": [{"message_id":"om_xxx","key":"img_v3_xxx","type":"image",
                         "local_path":"lark-im-resources/xxx.png","size_bytes":1234}]
        } ],
      "total": 50, "has_more": true, "page_token": "..." }

关键差异（相对钉钉 dws）：
  1. 飞书 `msg_type` 是**显式**的，不需要从 markdown 推断（钉钉没有 msgType）。
  2. `content` 可能是 OpenAPI 原始 JSON 字符串（`{"text":"..."}`），也可能是
     CLI 渲染后的可读文本（图片渲染成 `![Image](img_xxx)`）；两种都要能吃。
  3. 媒体靠 `--download-resources` 一次性落地，返回 `resources[]`（含 local_path），
     比钉钉「逐条 download-media」更省事；未加该参数时回退解析标记 + 单条下载。

取数命令（只读）：
    # 群聊 / 单聊历史（按时间窗，正序，自动翻页，顺带下载图片文件）
    lark-cli im +chat-messages-list --chat-id oc_xxx \
        --start "2026-10-01" --end "2026-11-01" \
        --order asc --page-all --download-resources --format json > messages.json

    # 单聊（用对方 open_id，自动解析 p2p chat_id）
    lark-cli im +chat-messages-list --user-id ou_xxx --order asc --page-all -f json > messages.json

    # 会话清单（把 chat_id 映射成群名，可选）
    lark-cli im +chat-list --types group,p2p --page-all -f json > chats.json

用法：
    python feishu_to_synapse.py --in messages.json --out synapse_input
    python feishu_to_synapse.py --in messages.json --chats chats.json --name "供应商催款群"
    python feishu_to_synapse.py --in messages.json --no-download-media   # 不补下载，留 file_key
    python feishu_to_synapse.py --demo                                   # 离线自检

产物（每个会话一套）：
    <会话名>.json          # {source, conversation, message_count, messages:[...]}
    <会话名>.records.json  # 裸数组，直接 POST /parse_chat
    <会话名>.md            # 纯文本对话稿（docling / langextract）
"""

from __future__ import annotations

import argparse
import base64
import datetime as _dt
import json
import os
import re
import shutil
import subprocess
from typing import Any, Dict, Iterable, List, Optional, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))

# A4 支持的聊天消息类型（与 services/ingestion/server.py 的 CHAT_MSG_TYPES 对齐）
MSG_TYPES = {"text", "system", "emoji", "image", "file", "voice", "transfer", "link", "location", "card"}

# 飞书 msg_type → A4 类型
_TYPE_MAP = {
    "text": "text",
    "post": "text",          # 富文本：正文抽出来当 text，纯图 post 再降级成 image
    "image": "image",
    "file": "file",
    "folder": "file",
    "audio": "voice",
    "media": "file",         # 视频
    "video_chat": "file",
    "sticker": "emoji",
    "interactive": "card",   # 消息卡片
    "share_chat": "link",
    "share_user": "link",
    "system": "system",
    "location": "location",
    "calendar": "card",
    "todo": "card",
    "vote": "card",
    "merge_forward": "card",
    "hongbao": "transfer",
}

_K_ATT_NAME = ("file_name", "name", "title")
_AMOUNT_RE = re.compile(r"[¥￥]\s*([0-9]+(?:\.[0-9]+)?)")
_AMOUNT_HINT_RE = re.compile(r"(转账|收款|付款|红包|打款)")
_IMG_MARK_RE = re.compile(r"!\[[^\]]*\]\((img[^)\s]+)\)")
_FILE_MARK_RE = re.compile(r'<file\s+key="([^"]+)"(?:\s+name="([^"]*)")?')
_AUDIO_MARK_RE = re.compile(r'<audio\s+key="([^"]+)"')
_VIDEO_MARK_RE = re.compile(r'<video\s+key="([^"]+)"')
_MD_LINK_RE = re.compile(r"\[[^\]]*\]\([^)]*\)")
_REVOKED_RE = re.compile(r"消息已撤回|已撤回")


# --------------------------------------------------------------------------- #
# 基础工具
# --------------------------------------------------------------------------- #
def _norm_time(v: Any) -> str:
    """飞书 create_time 是毫秒时间戳（字符串），也可能已是 ISO/可读时间。"""
    if v in (None, ""):
        return ""
    if isinstance(v, str):
        s = v.strip()
        if re.fullmatch(r"\d{10,13}", s):
            v = int(s)
        elif re.fullmatch(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?", s):
            try:
                d = _dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
                if d.tzinfo is not None:
                    d = d.astimezone()
                return d.strftime("%Y-%m-%d %H:%M:%S")
            except ValueError:
                return s
        else:
            return s
    if isinstance(v, (int, float)):
        n = float(v)
        if n > 1e12:          # 毫秒 → 秒
            n /= 1000.0
        try:
            return _dt.datetime.fromtimestamp(n).strftime("%Y-%m-%d %H:%M:%S")
        except (OverflowError, OSError, ValueError):
            return str(v)
    return str(v)


def _safe(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|\s]+', "_", name).strip("_") or "feishu"


def _sender_name(rec: Dict[str, Any]) -> str:
    s = rec.get("sender")
    if isinstance(s, dict):
        for k in ("name", "sender_name", "id", "open_id"):
            v = s.get(k)
            if v:
                return str(v)
    if isinstance(s, str) and s:
        return s
    for k in ("sender_name", "senderName", "from"):
        if rec.get(k):
            return str(rec[k])
    return "未知"


# --------------------------------------------------------------------------- #
# content 解析：兼容「OpenAPI 原始 JSON 串」与「CLI 渲染后的文本」
# --------------------------------------------------------------------------- #
def _flatten_post(node: Any, out_text: List[str], out_media: List[Tuple[str, str]]) -> None:
    """飞书 post 富文本：content 是 [[{tag,text|image_key|file_key}, ...], ...]。"""
    if isinstance(node, list):
        for x in node:
            _flatten_post(x, out_text, out_media)
        return
    if not isinstance(node, dict):
        return
    tag = str(node.get("tag") or "")
    if tag == "text" or "text" in node and not tag:
        t = node.get("text")
        if t:
            out_text.append(str(t))
    elif tag in ("a", "md"):
        t = node.get("text") or node.get("href") or ""
        if t:
            out_text.append(str(t))
    elif tag in ("img", "image"):
        k = node.get("image_key")
        if k:
            out_media.append(("image", str(k)))
    elif tag in ("file", "media", "audio", "video"):
        k = node.get("file_key")
        if k:
            out_media.append((tag if tag != "file" else "file", str(k)))
    elif tag == "at":
        n = node.get("user_name") or node.get("user_id") or ""
        if n:
            out_text.append(f"@{n}")
    elif tag == "emotion":
        out_text.append("[表情]")


def _parse_content(raw: Any, msg_type: str) -> Dict[str, Any]:
    """返回 {text, media_keys:[(type,key)], file_name}。"""
    text_parts: List[str] = []
    media_keys: List[Tuple[str, str]] = []
    file_name = ""

    obj: Any = raw
    if isinstance(raw, str):
        s = raw.strip()
        if s[:1] in ("{", "["):
            try:
                obj = json.loads(s)
            except (ValueError, TypeError):
                obj = s
        else:
            obj = s

    if isinstance(obj, dict):
        mt = str(obj.get("msg_type") or msg_type or "").lower()
        if mt == "post" or "content" in obj and isinstance(obj.get("content"), list):
            title = obj.get("title")
            if title:
                text_parts.append(str(title))
            _flatten_post(obj.get("content"), text_parts, media_keys)
        elif "text" in obj:
            text_parts.append(str(obj.get("text") or ""))
        # 结构化单资源消息
        if obj.get("image_key"):
            media_keys.append(("image", str(obj["image_key"])))
        if obj.get("file_key"):
            kind = {"audio": "audio", "media": "video", "folder": "file"}.get(mt, "file")
            media_keys.append((kind, str(obj["file_key"])))
            for k in _K_ATT_NAME:
                if obj.get(k):
                    file_name = str(obj[k])
                    break
        if obj.get("chat_id") and mt == "share_chat":
            text_parts.append(f"[分享群聊] {obj.get('chat_id')}")
        if obj.get("user_id") and mt == "share_user":
            text_parts.append(f"[分享联系人] {obj.get('user_id')}")
        if mt == "location":
            nm = obj.get("name") or ""
            text_parts.append(f"[位置] {nm}".strip())
    elif isinstance(obj, str):
        text_parts.append(obj)

    text = "".join(t for t in text_parts if t).strip()

    # CLI 渲染形态：![Image](img_xxx) / <file key="file_x" name="a.pdf"/> / <audio .../>
    if not media_keys:
        for m in _IMG_MARK_RE.finditer(text):
            media_keys.append(("image", m.group(1)))
        for m in _FILE_MARK_RE.finditer(text):
            media_keys.append(("file", m.group(1)))
            if m.group(2):
                file_name = file_name or m.group(2)
        for m in _AUDIO_MARK_RE.finditer(text):
            media_keys.append(("audio", m.group(1)))
        for m in _VIDEO_MARK_RE.finditer(text):
            media_keys.append(("video", m.group(1)))

    return {"text": text, "media_keys": media_keys, "file_name": file_name}


def _clean_text(text: str) -> str:
    """去掉 CLI 渲染的资源标记，只留人可读正文。"""
    t = _IMG_MARK_RE.sub("", text or "")
    t = _FILE_MARK_RE.sub("", t)
    t = _AUDIO_MARK_RE.sub("", t)
    t = _VIDEO_MARK_RE.sub("", t)
    return t.strip()


# --------------------------------------------------------------------------- #
# 类型判定
# --------------------------------------------------------------------------- #
def _resolve_type(rec: Dict[str, Any], parsed: Dict[str, Any], has_local_media: bool) -> str:
    raw = str(rec.get("msg_type") or "").strip().lower()
    base = _TYPE_MAP.get(raw)
    text = parsed["text"]
    keys = parsed["media_keys"]

    if raw == "post":
        # 富文本：有正文就是 text；纯图/纯文件的 post 按资源类型走
        if _clean_text(text):
            return "text"
        if keys:
            k = keys[0][0]
            return {"image": "image", "audio": "voice", "video": "file", "file": "file"}.get(k, "text")
        return "text"
    if base:
        return base if base in MSG_TYPES else "text"
    # 无 msg_type（少数导出形态）：按资源标记推断
    if keys:
        k = keys[0][0]
        return {"image": "image", "audio": "voice", "video": "file", "file": "file"}.get(k, "file")
    if has_local_media:
        return "file"
    if _AMOUNT_HINT_RE.search(text) and _AMOUNT_RE.search(text):
        return "transfer"
    return "text"


# --------------------------------------------------------------------------- #
# 媒体落地
# --------------------------------------------------------------------------- #
def _media_from_resources(rec: Dict[str, Any]) -> Tuple[str, str]:
    """lark-cli --download-resources 已落地的 resources[]，取第一份可用的。"""
    res = rec.get("resources")
    if not isinstance(res, list):
        return "", ""
    for r in res:
        if not isinstance(r, dict):
            continue
        p = r.get("local_path") or r.get("path") or r.get("saved_path")
        if p and os.path.isfile(p):
            return os.path.abspath(p).replace("\\", "/"), str(r.get("key") or "")
        if p:
            cand = p if os.path.isabs(p) else os.path.join(os.getcwd(), p)
            if os.path.isfile(cand):
                return os.path.abspath(cand).replace("\\", "/"), str(r.get("key") or "")
    return "", ""


def _download_one(msg_id: str, key: str, rtype: str, out_dir: str,
                  lark_bin: str) -> Optional[str]:
    """回退路径：单条下载消息资源（图片走 image，其余走 file）。"""
    os.makedirs(out_dir, exist_ok=True)
    kind = "image" if rtype == "image" else "file"
    safe_key = _safe(key)
    out_path = os.path.join(out_dir, safe_key)
    try:
        subprocess.run(
            [lark_bin, "im", "+messages-resources-download",
             "--message-id", msg_id, "--file-key", key, "--type", kind,
             "--output", out_path],
            capture_output=True, timeout=120, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    for cand in (out_path, *[os.path.join(out_dir, n) for n in os.listdir(out_dir)
                             if n.startswith(safe_key)]):
        if os.path.isfile(cand) and os.path.getsize(cand) > 0:
            return os.path.abspath(cand).replace("\\", "/")
    return None


def _coerce_message(rec: Dict[str, Any], seq: int, conv: Dict[str, Any],
                    lark_bin: Optional[str], media_dir: str) -> Optional[Dict[str, Any]]:
    if not isinstance(rec, dict):
        return None

    parsed = _parse_content(rec.get("content"), str(rec.get("msg_type") or ""))
    text = parsed["text"]

    # 撤回消息：保留占位，维持证据链顺序完整
    if rec.get("deleted") or _REVOKED_RE.search(text):
        return {
            "seq": seq,
            "sender": _sender_name(rec),
            "time": _norm_time(rec.get("create_time") or rec.get("update_time")),
            "text": "[该消息已撤回]",
            "type": "system",
            "media": "",
            "amount": "",
        }

    media, media_key = _media_from_resources(rec)
    mtype = _resolve_type(rec, parsed, bool(media))

    # 未落地时：优先按 resources[] 里的 key 补下载，其次按内容标记
    if not media and lark_bin:
        msg_id = str(rec.get("message_id") or "")
        keys: List[Tuple[str, str]] = []
        res = rec.get("resources")
        if isinstance(res, list):
            for r in res:
                if isinstance(r, dict) and r.get("key"):
                    keys.append((str(r.get("type") or "file"), str(r["key"])))
        if not keys:
            keys = parsed["media_keys"]
        if msg_id and keys:
            k_type, k_key = keys[0]
            media = _download_one(msg_id, k_key, k_type, media_dir, lark_bin) or ""

    if not media:
        # 兜底：留 key 便于追溯（与钉钉端「未下载保留 mediaId」一致）
        res = rec.get("resources")
        if isinstance(res, list) and res and isinstance(res[0], dict) and res[0].get("key"):
            media = str(res[0]["key"])
            media_key = media_key or media
        elif parsed["media_keys"]:
            media = parsed["media_keys"][0][1]

    body = text
    if mtype == "image":
        body = ""
    elif mtype != "text":
        body = _clean_text(text)

    amount = ""
    m = _AMOUNT_RE.search(text or "")
    if m:
        amount = m.group(1)

    return {
        "seq": seq,
        "sender": _sender_name(rec),
        "time": _norm_time(rec.get("create_time") or rec.get("update_time")),
        "text": body,
        "type": mtype,
        "media": media,
        "amount": amount,
    }


# --------------------------------------------------------------------------- #
# 信封解析 / 会话名解析
# --------------------------------------------------------------------------- #
def _iter_conversations(obj: Any) -> Iterable[Dict[str, Any]]:
    """从 lark-cli 的输出信封里产出会话块 {title, chat_id, messages}。"""
    if isinstance(obj, list):
        yield {"title": "", "chat_id": "", "messages": obj}
        return
    if not isinstance(obj, dict):
        return

    # 1) lark-cli +chat-messages-list 真实信封
    msgs = obj.get("messages")
    if isinstance(msgs, list):
        yield {
            "title": obj.get("chat_name") or obj.get("name") or obj.get("title") or "",
            "chat_id": obj.get("chat_id") or obj.get("container_id") or "",
            "messages": msgs,
        }
        return

    # 2) 多会话导出：data.items / chats[] 各自带 messages
    for key in ("items", "data", "list", "records", "chats"):
        v = obj.get(key)
        if isinstance(v, list) and v:
            if all(isinstance(x, dict) and isinstance(x.get("messages"), list) for x in v):
                for c in v:
                    yield {
                        "title": c.get("name") or c.get("chat_name") or c.get("title") or "",
                        "chat_id": c.get("chat_id") or "",
                        "messages": c["messages"],
                    }
                return
            yield {"title": "", "chat_id": "", "messages": v}
            return
        if isinstance(v, dict):
            yield from _iter_conversations(v)
            return


def _load_chat_names(chat_json: Optional[str]) -> Dict[str, str]:
    """从 `+chat-list` 输出里建 chat_id → 群名 映射。"""
    if not chat_json or not os.path.isfile(chat_json):
        return {}
    try:
        with open(chat_json, encoding="utf-8") as f:
            obj = json.load(f)
    except (OSError, ValueError):
        return {}
    items = obj.get("items") if isinstance(obj, dict) else obj
    if isinstance(obj, dict) and not isinstance(items, list):
        for k in ("chats", "data", "list"):
            if isinstance(obj.get(k), list):
                items = obj[k]
                break
    if not isinstance(items, list):
        return {}
    out = {}
    for c in items:
        if isinstance(c, dict) and c.get("chat_id"):
            out[str(c["chat_id"])] = str(c.get("name") or c.get("chat_name") or "")
    return out


# --------------------------------------------------------------------------- #
# 归一化 / 落盘
# --------------------------------------------------------------------------- #
def normalize(results: List[Tuple[Dict[str, Any], List[Dict[str, Any]]]],
              source: str = "飞书") -> List[Dict[str, Any]]:
    out = []
    for conv, records in results:
        out.append({
            "source": source,
            "conversation": conv.get("title") or "飞书会话",
            "chat_id": conv.get("chat_id") or "",
            "fetched_at": _dt.datetime.now().isoformat(timespec="seconds"),
            "message_count": len(records),
            "messages": records,
        })
    return out


def to_markdown(conv: Dict[str, Any]) -> str:
    lines = [
        f"# 飞书聊天记录 · {conv['conversation']}",
        "",
        f"> 来源：{conv['source']}（lark-cli）；归一化时间：{conv['fetched_at']}",
        f"> 消息条数：{conv['message_count']}",
    ]
    if conv.get("chat_id"):
        lines.append(f"> 会话 ID：{conv['chat_id']}")
    lines += ["", "---", ""]
    last = None
    for m in conv["messages"]:
        speaker = m.get("sender") or "（未知）"
        time = m.get("time") or ""
        t = m.get("type")
        body = m.get("text") or ""
        if t == "image":
            body = f"[图片] {os.path.basename(m.get('media') or '')}".strip()
        elif t == "file":
            body = body or f"[文件] {os.path.basename(m.get('media') or '')}".strip()
        elif t == "voice":
            body = "[语音]"
        elif t == "transfer":
            body = f"[转账 ¥{m.get('amount') or '?'}]"
        if speaker != last:
            lines.append(f"**{speaker}** {time}".rstrip())
            last = speaker
        else:
            lines.append(f"　　{time}".rstrip())
        lines.append(body)
        lines.append("")
    return "\n".join(lines)


def convert(in_path: str, out_dir: str, name: Optional[str] = None,
            source: str = "飞书", download_media: bool = True,
            media_dir: Optional[str] = None,
            chat_json: Optional[str] = None) -> List[Dict[str, Any]]:
    with open(in_path, encoding="utf-8") as f:
        obj = json.load(f)

    lark_bin = shutil.which("lark-cli") if download_media else None
    media_dir = media_dir or os.path.join(out_dir, "_media")
    names = _load_chat_names(chat_json)

    results: List[Tuple[Dict[str, Any], List[Dict[str, Any]]]] = []
    for conv in _iter_conversations(obj):
        cid = str(conv.get("chat_id") or "")
        if not conv.get("title") and cid and names.get(cid):
            conv["title"] = names[cid]
        if name:
            conv["title"] = name
        records: List[Dict[str, Any]] = []
        for i, m in enumerate(conv["messages"], start=1):
            r = _coerce_message(m, i, conv, lark_bin, media_dir)
            if r:
                records.append(r)
        if records:
            records.sort(key=lambda r: r.get("time") or "")
            for i, r in enumerate(records, start=1):
                r["seq"] = i
            results.append((conv, records))

    convs = normalize(results, source)

    os.makedirs(out_dir, exist_ok=True)
    for c in convs:
        base = _safe(c["conversation"])
        if len(convs) > 1 and c.get("chat_id"):
            base = f"{base}_{_safe(c['chat_id'][-8:])}"
        json_path = os.path.join(out_dir, f"{base}.json")
        rec_path = os.path.join(out_dir, f"{base}.records.json")
        md_path = os.path.join(out_dir, f"{base}.md")
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(c, f, ensure_ascii=False, indent=2)
        with open(rec_path, "w", encoding="utf-8") as f:
            json.dump(c["messages"], f, ensure_ascii=False, indent=2)
        with open(md_path, "w", encoding="utf-8") as f:
            f.write(to_markdown(c))
        print(f"[+] {c['conversation']}：{c['message_count']} 条")
        print(f"    JSON         -> {json_path}")
        print(f"    records.json -> {rec_path}   <- 直接喂 POST /parse_chat")
        print(f"    MD           -> {md_path}")
    if len(convs) > 1:
        print(f"[i] 共 {len(convs)} 个会话；已按会话分别落盘。")
    return convs


# --------------------------------------------------------------------------- #
# 离线 demo：模拟 lark-cli v1.0.98 真实信封（含真实 PNG），跑通全链路
# --------------------------------------------------------------------------- #
_PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
)


def demo(out_dir: str = os.path.join(HERE, "synapse_input")) -> List[Dict[str, Any]]:
    demo_dir = os.path.join(HERE, "feishu_demo")
    res_dir = os.path.join(demo_dir, "lark-im-resources")
    os.makedirs(res_dir, exist_ok=True)
    png = os.path.join(res_dir, "img_v3_demo.png")
    with open(png, "wb") as f:
        f.write(_PNG_1PX)

    msgs = [
        {"message_id": "om_demo1", "msg_type": "text", "create_time": "1761441600000",
         "sender": {"id": "ou_1", "sender_type": "user", "name": "张三"},
         "content": json.dumps({"text": "王五，那笔合作款你什么时候打？合同写的是 8 月 1 日前。"},
                               ensure_ascii=False),
         "deleted": False},
        {"message_id": "om_demo2", "msg_type": "text", "create_time": "1761441660000",
         "sender": {"id": "ou_2", "sender_type": "user", "name": "王五"},
         "content": json.dumps({"text": "下周吧，最近资金紧。"}, ensure_ascii=False),
         "deleted": False},
        {"message_id": "om_demo3", "msg_type": "image", "create_time": "1761441720000",
         "sender": {"id": "ou_2", "sender_type": "user", "name": "王五"},
         "content": json.dumps({"image_key": "img_v3_demo"}, ensure_ascii=False),
         "deleted": False,
         "resources": [{"message_id": "om_demo3", "key": "img_v3_demo", "type": "image",
                        "local_path": png.replace("\\", "/"), "size_bytes": len(_PNG_1PX)}]},
        {"message_id": "om_demo4", "msg_type": "text", "create_time": "1761441780000",
         "sender": {"id": "ou_1", "sender_type": "user", "name": "张三"},
         "content": json.dumps({"text": "你上次也说下周，已经拖了两个月了。"}, ensure_ascii=False),
         "deleted": False},
        # 富文本 post（正文 + @人）
        {"message_id": "om_demo5", "msg_type": "post", "create_time": "1761441840000",
         "sender": {"id": "ou_2", "sender_type": "user", "name": "王五"},
         "content": json.dumps({
             "title": "还款计划",
             "content": [[
                 {"tag": "text", "text": "我先还 "},
                 {"tag": "text", "text": "¥2000 定金"},
                 {"tag": "at", "user_id": "ou_1", "user_name": "张三"},
                 {"tag": "text", "text": "，剩下的月底给。"},
             ]],
         }, ensure_ascii=False),
         "deleted": False},
        # 语音
        {"message_id": "om_demo6", "msg_type": "audio", "create_time": "1761441900000",
         "sender": {"id": "ou_2", "sender_type": "user", "name": "王五"},
         "content": json.dumps({"file_key": "file_v3_voice", "duration": 3200},
                               ensure_ascii=False),
         "deleted": False},
        # 撤回
        {"message_id": "om_demo7", "msg_type": "text", "create_time": "1761441960000",
         "sender": {"id": "ou_1", "sender_type": "user", "name": "张三"},
         "content": json.dumps({"text": "算了不说了"}, ensure_ascii=False),
         "deleted": True},
    ]
    sample = {"messages": msgs, "total": len(msgs), "has_more": False, "page_token": ""}
    in_path = os.path.join(demo_dir, "messages.json")
    with open(in_path, "w", encoding="utf-8") as f:
        json.dump(sample, f, ensure_ascii=False, indent=2)

    print("[demo] 已生成模拟 lark-cli 输出：", in_path)
    return convert(in_path, out_dir, name="demo_飞书供应商催款群",
                   download_media=False)


def main():
    p = argparse.ArgumentParser(description="飞书 lark-cli 聊天记录 → Synapse A4 输入")
    p.add_argument("--in", dest="in_path", help="lark-cli +chat-messages-list 导出的 JSON")
    p.add_argument("--chats", dest="chat_json", help="lark-cli +chat-list 导出的 JSON（映射 chat_id→群名）")
    p.add_argument("--out", default=os.path.join(HERE, "synapse_input"), help="输出目录")
    p.add_argument("--name", help="会话名（单会话时可直接指定）")
    p.add_argument("--source", default="飞书", help='证据来源标注，默认"飞书"')
    p.add_argument("--no-download-media", action="store_true",
                   help="不调用 lark-cli 补下载图片/文件（默认会补，失败则留 file_key）")
    p.add_argument("--demo", action="store_true", help="离线自检，无需 lark-cli / 登录")
    args = p.parse_args()

    if args.demo:
        demo(args.out)
        return
    if not args.in_path:
        p.error("需提供 --in <messages.json>，或加 --demo 离线自检。")
    convert(args.in_path, args.out, args.name, args.source,
            download_media=not args.no_download_media, chat_json=args.chat_json)


if __name__ == "__main__":
    main()
