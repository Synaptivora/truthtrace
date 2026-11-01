#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dingtalk_to_synapse.py — 钉钉端 A6 取数适配器（dws CLI → A4 chat 证据）
=====================================================================
把钉钉 `dws` CLI 导出的聊天记录，归一化成与微信侧**完全一致**的下游输入
`[{seq, sender, time, text, type, media, amount}]`，直接喂 A4（`POST /parse_chat`）
即可产出 `kind="chat"` 证据 + 独立媒体证据，B / C 零改动。

已适配 dws v1.0.39 真实返回：
    { "success": true,
      "result": {
        "conversationMessagesList": [
          { "title": "...", "openConversationId": "cid...==", "singleChat": false,
            "messages": [ {"sender":"张三","createTime":"2026-11-01 08:37:40",
                           "content":"...markdown...","sendType":"user",
                           "openMessageId":"...","senderOpenDingTalkId":"..."} ] } ],
        "hasMore": true, "nextCursor": "..." } }

关键差异（相对微信）：dws 消息**没有 msgType**，类型需从 content 的 markdown 推断
（`![image](@mediaId)` = 图片）；媒体用 `dws chat message download-media` 官方下载，
无需 Frida / 图片密钥 / XOR 解码。

取数命令（只读）：
    # 群聊
    dws chat message list --group <openConversationId> --limit 500 -f json > messages.json
    # 单聊
    dws chat message list-direct --user <userId> -f json > messages.json
    # 跨会话按时间（含单聊+群聊，singleChat 字段区分）——最适合 Synapse
    dws chat message list-all --start "2026-10-01 00:00:00" --end "2026-11-01 23:59:59" \
        --limit 500 -f json > messages.json

用法：
    python dingtalk_to_synapse.py --in messages.json --out synapse_input
    python dingtalk_to_synapse.py --in messages.json --out synapse_input --no-download-media
    python dingtalk_to_synapse.py --in "exports/群_xxx/messages.json" \
        --attachments-dir "exports/群_xxx/attachments"     # 兼容 dingtalk-chat-exporter
    python dingtalk_to_synapse.py --demo                   # 离线自检

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

_TYPE_MAP = {
    "text": "text", "plaintext": "text", "richtext": "link", "markdown": "link",
    "system": "system", "notice": "system",
    "picture": "image", "image": "image", "img": "image", "photo": "image",
    "file": "file", "attachment": "file", "document": "file", "doc": "file",
    "video": "file", "audio": "voice", "voice": "voice", "sound": "voice",
    "link": "link", "card": "card", "location": "location",
    "emotion": "emoji", "emoji": "emoji", "sticker": "emoji",
    "transfer": "transfer", "redpacket": "transfer", "redpacketenvelope": "transfer",
}

_K_SENDER = ("sender", "senderNick", "senderName", "from", "name", "senderId", "nick")
_K_TIME = ("createTime", "sendTime", "timestamp", "time", "gmtCreate", "msgTime")
_K_TEXT = ("content", "text", "msg", "body", "plainText")
_K_TYPE = ("msgType", "messageType", "type", "kind", "contentType")
_K_ATT = ("attachments", "resources", "resourceList", "fileList", "files", "mediaList")
_K_ATT_NAME = ("fileName", "name", "title", "displayName")
_K_ATT_PATH = ("localPath", "path", "filePath", "savedPath", "downloadPath", "storagePath")
_K_ATT_URL = ("downloadUrl", "url", "resourceUrl", "fileUrl")

_AMOUNT_RE = re.compile(r"[¥￥]\s*([0-9]+(?:\.[0-9]+)?)")
_IMG_MD_RE = re.compile(r"!\[[^\]]*\]\((@[^)\s]+)\)")
_MD_LINK_RE = re.compile(r"\[[^\]]*\]\([^)]*\)")
_FILE_RE = re.compile(r"\[文件\]|\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|txt|csv)\b", re.I)
_VOICE_RE = re.compile(r"\[(语音|audio)\]", re.I)
_AMOUNT_HINT_RE = re.compile(r"(转账|收款|付款|红包)")


def _first(rec: Dict[str, Any], keys) -> Any:
    for k in keys:
        v = rec.get(k)
        if v not in (None, ""):
            return v
    return ""


def _norm_time(v: Any) -> str:
    if v in (None, ""):
        return ""
    if isinstance(v, str):
        s = v.strip()
        if re.fullmatch(r"\d{10,13}", s):
            v = int(s)
        else:
            return s
    if isinstance(v, (int, float)):
        n = float(v)
        if n > 1e12:
            n /= 1000.0
        try:
            return _dt.datetime.fromtimestamp(n).strftime("%Y-%m-%d %H:%M:%S")
        except (OverflowError, OSError, ValueError):
            return str(v)
    return str(v)


def _attachments(rec: Dict[str, Any]) -> List[Dict[str, Any]]:
    for k in _K_ATT:
        v = rec.get(k)
        if isinstance(v, list) and v:
            return [x for x in v if isinstance(x, dict)]
    return []


def _strip_md(s: str) -> str:
    s = _IMG_MD_RE.sub("", s or "")
    s = _MD_LINK_RE.sub("", s)
    return s.strip()


def _infer_type(rec: Dict[str, Any], content: str, has_attachment: bool) -> str:
    raw = _first(rec, _K_TYPE)
    if raw:
        t = str(raw).strip().lower()
        if t in _TYPE_MAP:
            return _TYPE_MAP[t]
    # 钉钉资源优先按 resources[].resourceType 判定（图片/文件/视频/语音）
    res = _attachments(rec)
    if res:
        rt = str(res[0].get("resourceType") or "").lower()
        if rt in ("image", "picture"):
            return "image"
        if rt in ("audio", "voice"):
            return "voice"
        if rt in ("video", "file"):
            return "file"
    c = content or ""
    # 第二种图片形态：`[图片消息](mediaId=$...)`，视频/语音同理
    if re.search(r"\[图片消息\]", c):
        return "image"
    if re.search(r"\[视频消息\]", c):
        return "file"
    if re.search(r"\[语音消息\]", c):
        return "voice"
    imgs = _IMG_MD_RE.findall(c)
    stripped = _strip_md(c)
    if has_attachment:
        return "file"
    if imgs and len(stripped) <= 20:
        return "image"
    if _VOICE_RE.search(c):
        return "voice"
    if _FILE_RE.search(c):
        return "file"
    if re.search(r"\]\((https?://|dingtalk://)", c):
        # 只有「整条消息基本就是一个链接/卡片」才归 link；普通正文里带链接仍按 text
        if len(stripped) <= 8:
            return "link"
    if _AMOUNT_HINT_RE.search(c) and _AMOUNT_RE.search(c):
        return "transfer"
    send_type = str(rec.get("sendType") or "").lower()
    if send_type in ("system", "bot") and not stripped:
        return "system"
    return "text"


def _file_name(content: str, fallback: str) -> str:
    """从 `[文件] 261-11.docx fileId: ...` 里取文件名。"""
    m = re.search(r"^\[文件\]\s*(.+?)(?:\s+fileId:|\s+url:|$)", content or "", re.S)
    name = m.group(1).strip() if m else fallback
    return re.sub(r'[\\/:*?"<>|]+', "_", name).strip() or "attachment"


def _find_local(att: Dict[str, Any], attachments_dir: Optional[str]) -> Optional[str]:
    name = str(_first(att, _K_ATT_NAME) or "").strip()
    path = str(_first(att, _K_ATT_PATH) or "").strip()
    cands = [path] if path else []
    if name and attachments_dir:
        cands.append(os.path.join(attachments_dir, name))
    for cand in cands:
        if not cand:
            continue
        p = cand if os.path.isabs(cand) else os.path.join(attachments_dir or "", cand)
        p = os.path.abspath(p)
        if os.path.isfile(p):
            return p.replace("\\", "/")
    return None


def _download_media(conv_id: str, msg_id: str, media_id: str, out_dir: str,
                    dws_bin: str) -> Optional[str]:
    """调 dws 官方 download-media 下载一条媒体，返回本地路径；失败返回 None。"""
    os.makedirs(out_dir, exist_ok=True)
    before = set(os.listdir(out_dir))
    try:
        subprocess.run(
            [dws_bin, "chat", "message", "download-media", "--type", "mediaId",
             "--resource-id", media_id, "--message-id", msg_id,
             "--open-conversation-id", conv_id, "--output", out_dir],
            capture_output=True, timeout=120, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    after = set(os.listdir(out_dir)) - before
    if not after:
        return None
    newest = max((os.path.join(out_dir, n) for n in after), key=os.path.getmtime)
    return os.path.abspath(newest).replace("\\", "/")


def _drive_download(node: str, out_path: str, dws_bin: str) -> Optional[str]:
    """钉盘文件用 `dws drive download --node <fileId>` 下载。"""
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    try:
        subprocess.run(
            [dws_bin, "drive", "download", "--node", node, "--output", out_path],
            capture_output=True, timeout=300, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if os.path.isfile(out_path) and os.path.getsize(out_path) > 0:
        return os.path.abspath(out_path).replace("\\", "/")
    return None


def _coerce_message(rec: Dict[str, Any], seq: int, conv: Dict[str, Any],
                    attachments_dir: Optional[str], dws_bin: Optional[str],
                    media_dir: str) -> Optional[Dict[str, Any]]:
    if not isinstance(rec, dict):
        return None
    content = str(_first(rec, _K_TEXT) or "")
    atts = _attachments(rec)
    mtype = _infer_type(rec, content, bool(atts))
    msg_id = str(rec.get("openMessageId") or "")
    conv_id = str(conv.get("openConversationId") or "")

    media = ""
    # 1) 附件里已落地的本地真实文件（exporter 产物）
    for att in atts:
        local = _find_local(att, attachments_dir)
        if local:
            media = local
            break

    # 2) 官方下载：文件走 drive，图片/视频/语音走 download-media
    if not media and atts and dws_bin:
        rtype = str(atts[0].get("resourceType") or "").lower()
        rid = str(atts[0].get("resourceId") or "")
        if rid:
            if rtype == "file":
                media = _drive_download(rid, os.path.join(media_dir, _file_name(content, rid)), dws_bin) or ""
            elif conv_id and msg_id:
                media = _download_media(conv_id, msg_id, rid, media_dir, dws_bin) or ""

    # 3) 无 resources 的 ![image](@mediaId) 形态
    if not media and mtype == "image":
        imgs = _IMG_MD_RE.findall(content)
        if imgs:
            if dws_bin and conv_id and msg_id:
                media = _download_media(conv_id, msg_id, imgs[0], media_dir, dws_bin) or ""
            if not media:
                media = imgs[0]  # 未下载时保留 mediaId，证据里可追溯

    # 4) 兜底：URL / resourceId
    if not media and atts:
        media = str(_first(atts[0], _K_ATT_URL) or atts[0].get("resourceId") or "")

    text = content
    if mtype == "image":
        text = ""
    elif mtype != "text":
        text = _strip_md(content)

    amount = ""
    m = _AMOUNT_RE.search(content)
    if m:
        amount = m.group(1)

    return {
        "seq": seq,
        "sender": str(_first(rec, _K_SENDER) or "未知"),
        "time": _norm_time(_first(rec, _K_TIME)),
        "text": text,
        "type": mtype,
        "media": media,
        "amount": amount,
    }


def _iter_conversations(obj: Any) -> Iterable[Dict[str, Any]]:
    """从多种信封里产出会话块 {title, openConversationId, singleChat, messages}。"""
    if isinstance(obj, list):
        yield {"title": "", "openConversationId": "", "singleChat": None, "messages": obj}
        return
    if not isinstance(obj, dict):
        return
    # 1) dws v1.0.39 真实信封
    res = obj.get("result") if isinstance(obj.get("result"), dict) else obj
    cml = res.get("conversationMessagesList")
    if isinstance(cml, list) and cml:
        for c in cml:
            if isinstance(c, dict) and isinstance(c.get("messages"), list):
                yield {
                    "title": c.get("title") or "",
                    "openConversationId": c.get("openConversationId") or "",
                    "singleChat": c.get("singleChat"),
                    "messages": c["messages"],
                }
        return
    # 2) 平铺 {messages:[...]}（exporter / 旧版）
    for key in ("messages", "records", "data", "items", "list"):
        v = obj.get(key)
        if isinstance(v, list):
            yield {"title": obj.get("title") or obj.get("name") or "",
                   "openConversationId": obj.get("openConversationId") or "",
                   "singleChat": obj.get("singleChat"), "messages": v}
            return
        if isinstance(v, dict):
            for c in _iter_conversations(v):
                yield c
            return


def normalize(results: List[Tuple[Dict[str, Any], List[Dict[str, Any]]]],
              source: str = "钉钉") -> List[Dict[str, Any]]:
    """把多个会话归一化成 {source, conversation, messages:[...]} 列表。"""
    out = []
    for conv, records in results:
        out.append({
            "source": source,
            "conversation": conv.get("title") or "钉钉会话",
            "openConversationId": conv.get("openConversationId") or "",
            "singleChat": conv.get("singleChat"),
            "fetched_at": _dt.datetime.now().isoformat(timespec="seconds"),
            "message_count": len(records),
            "messages": records,
        })
    return out


def to_markdown(conv: Dict[str, Any]) -> str:
    kind = "单聊" if conv.get("singleChat") else ("群聊" if conv.get("singleChat") is False else "会话")
    lines = [
        f"# 钉钉聊天记录 · {conv['conversation']}（{kind}）",
        "",
        f"> 来源：{conv['source']}（dws CLI）；归一化时间：{conv['fetched_at']}",
        f"> 消息条数：{conv['message_count']}",
        "",
        "---",
        "",
    ]
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


def _safe(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|\s]+', "_", name).strip("_") or "dingtalk"


def convert(in_path: str, out_dir: str, attachments_dir: Optional[str] = None,
            name: Optional[str] = None, source: str = "钉钉",
            download_media: bool = True, media_dir: Optional[str] = None) -> List[Dict[str, Any]]:
    with open(in_path, encoding="utf-8") as f:
        obj = json.load(f)

    dws_bin = shutil.which("dws") if download_media else None
    media_dir = media_dir or os.path.join(out_dir, "_media")
    if not download_media:
        dws_bin = None

    results: List[Tuple[Dict[str, Any], List[Dict[str, Any]]]] = []
    for conv in _iter_conversations(obj):
        if name:
            conv["title"] = name
        records: List[Dict[str, Any]] = []
        for i, m in enumerate(conv["messages"], start=1):
            r = _coerce_message(m, i, conv, attachments_dir, dws_bin, media_dir)
            if r:
                records.append(r)
        if records:
            # 统一按时间正序（createTime 为 "YYYY-MM-DD HH:MM:SS"，可直接字典序）
            records.sort(key=lambda r: r.get("time") or "")
            for i, r in enumerate(records, start=1):
                r["seq"] = i
            results.append((conv, records))

    convs = normalize(results, source)

    os.makedirs(out_dir, exist_ok=True)
    for c in convs:
        base = _safe(c["conversation"])
        if len(convs) > 1 and c.get("openConversationId"):
            base = f"{base}_{_safe(c['openConversationId'][-8:])}"
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
# 离线 demo：模拟 dws v1.0.39 真实信封（含真实 PNG），跑通全链路
# --------------------------------------------------------------------------- #
_PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
)


def demo(out_dir: str = os.path.join(HERE, "synapse_input")) -> List[Dict[str, Any]]:
    demo_dir = os.path.join(HERE, "dingtalk_demo")
    att_dir = os.path.join(demo_dir, "attachments")
    os.makedirs(att_dir, exist_ok=True)
    with open(os.path.join(att_dir, "转账截图.png"), "wb") as f:
        f.write(_PNG_1PX)

    msgs = [
        {"sender": "张三", "createTime": "2026-07-26 09:20:00", "sendType": "user",
         "openMessageId": "msg1", "senderOpenDingTalkId": "Do1",
         "content": "王五，那笔合作款你什么时候打？合同里写的是 8 月 1 日前。"},
        {"sender": "王五", "createTime": "2026-07-26 09:21:00", "sendType": "user",
         "openMessageId": "msg2", "senderOpenDingTalkId": "Do2",
         "content": "下周吧，最近资金紧。"},
        {"sender": "王五", "createTime": "2026-07-26 09:22:00", "sendType": "user",
         "openMessageId": "msg3", "senderOpenDingTalkId": "Do2",
         "content": "这是当时的转账记录\n![image](@demoMediaId)"},
        {"sender": "张三", "createTime": "2026-07-26 09:23:00", "sendType": "user",
         "openMessageId": "msg4", "senderOpenDingTalkId": "Do1",
         "content": "你上次也说下周，已经拖了两个月了。"},
        {"sender": "王五", "createTime": "2026-07-26 09:24:00", "sendType": "user",
         "openMessageId": "msg5", "senderOpenDingTalkId": "Do2",
         "content": "[语音]"},
        {"sender": "张三", "createTime": "2026-07-26 09:25:00", "sendType": "user",
         "openMessageId": "msg6", "senderOpenDingTalkId": "Do1",
         "content": "已转 ¥2000 定金，转账记录在群里。"},
    ]
    # 让图片消息走 exporter 风格附件（demo 不走网络下载）
    msgs[2]["attachments"] = [{"fileName": "转账截图.png"}]
    sample = {"success": True, "result": {
        "conversationMessagesList": [{
            "title": "demo_供应商催款群", "openConversationId": "cidDemo==",
            "singleChat": False, "messages": msgs,
        }],
        "hasMore": False, "nextCursor": "0",
    }}
    in_path = os.path.join(demo_dir, "messages.json")
    with open(in_path, "w", encoding="utf-8") as f:
        json.dump(sample, f, ensure_ascii=False, indent=2)

    print("[demo] 已生成模拟 dws 输出：", in_path)
    return convert(in_path, out_dir, attachments_dir=att_dir, download_media=False)


def main():
    p = argparse.ArgumentParser(description="钉钉 dws 聊天记录 → Synapse A4 输入")
    p.add_argument("--in", dest="in_path", help="dws 导出的 messages.json")
    p.add_argument("--attachments-dir", help="附件目录（dingtalk-chat-exporter 的 attachments/）")
    p.add_argument("--out", default=os.path.join(HERE, "synapse_input"), help="输出目录")
    p.add_argument("--name", help="会话名（单会话时可直接指定）")
    p.add_argument("--source", default="钉钉", help='证据来源标注，默认"钉钉"')
    p.add_argument("--no-download-media", action="store_true",
                   help="不调用 dws 下载图片（默认会自动下载，失败则留 mediaId）")
    p.add_argument("--demo", action="store_true", help="离线自检，无需 dws / 登录")
    args = p.parse_args()

    if args.demo:
        demo(args.out)
        return
    if not args.in_path:
        p.error("需提供 --in <messages.json>，或加 --demo 离线自检。")
    convert(args.in_path, args.out, args.attachments_dir, args.name, args.source,
            download_media=not args.no_download_media)


if __name__ == "__main__":
    main()
