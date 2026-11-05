#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""方案 A · 证据构造（复用 server.py 的内联标记约定，保证 B/C 零改动）。

与 services/ingestion/server.py 的 build_chat_content / build_chat_bundle 保持同一套约定：
  - 媒体/特殊类型插入内联标记：[图片@t: 名 见独立证据] / [文件:名@t 见独立证据] / [语音@t] / [转账 ¥x@t]
  - 图片产出独立 image 证据（data URL）；非图片媒体产出 text 占位证据（绝不伪造 image URL）
  - source 由调用方显式传入（微信/钉钉），不替调用方猜平台
"""
import base64
import mimetypes
import os
import uuid

KNOWN_TYPES = {
    "text", "system", "emoji", "image", "file",
    "voice", "transfer", "link", "location", "card",
}

KINDS = {"text", "chat", "image", "pdf"}

_MEDIA_LABEL = {"image": "图片", "file": "文件", "voice": "语音"}


def _media_display_name(media: str, kind: str, time: str) -> str:
    """媒体的展示名。

    dws 这类接口给的是 mediaId（一长串带 ?x-oss-... 的标识），不是文件名；
    直接 basename 会把它当名字写进证据标题，前端列表里就是一屏乱码。
    只有「看起来像文件」时才用 basename，否则退回「图片 · 时间」。
    """
    label = _MEDIA_LABEL.get(kind, "媒体")
    if media.startswith("data:"):
        return f"{label}(内嵌)"
    base = os.path.basename(media)
    looks_like_file = bool(base) and len(base) <= 80 and "?" not in base and "=" not in base \
        and os.path.splitext(base)[1]
    if looks_like_file:
        return base
    return f"{label} · {time}" if time else label


def _coerce_record(rec: dict) -> dict | None:
    if not isinstance(rec, dict):
        return None
    t = str(rec.get("type") or "text").lower()
    if t not in KNOWN_TYPES:
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
    """把聊天记录拼成对话文本，对媒体/特殊类型插入内联标记。返回 (chat_text, media_list)。"""
    lines: list[str] = []
    media_list: list[dict] = []
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
                lines.append(f"{ts}{sender}: {text or '[图片]'}")
                continue
            name = _media_display_name(media, "image", time)
            lines.append(f"{ts}{sender}: [图片@{time}: {name} 见独立证据]")
            media_list.append({"name": name, "media_ref": media, "kind_hint": "image", "time": time})
        elif t == "file":
            if not media:
                lines.append(f"{ts}{sender}: {text or '[文件]'}")
                continue
            name = _media_display_name(media, "file", time)
            lines.append(f"{ts}{sender}: [文件:{name}@{time} 见独立证据]")
            media_list.append({"name": name, "media_ref": media, "kind_hint": "file", "time": time})
        elif t == "voice":
            if media:
                vname = _media_display_name(media, "voice", time)
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


def _media_to_evidence(item: dict, source: str) -> dict:
    """把一条媒体项落成合法 Evidence（image=data URL；其余=text 占位，绝不伪造 image URL）。"""
    media = item.get("media_ref") or ""
    name = item.get("name") or "媒体"
    if media.startswith("data:"):
        return {
            "id": str(uuid.uuid4()), "name": name, "kind": "image",
            "mimeType": "image/png", "content": media, "source": source,
        }
    if media and os.path.isfile(media):
        mime, _ = mimetypes.guess_type(media)
        if mime and mime.startswith("image/"):
            with open(media, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("ascii")
            return {
                "id": str(uuid.uuid4()), "name": name, "kind": "image",
                "mimeType": mime, "content": f"data:{mime};base64,{b64}", "source": source,
            }
        return {
            "id": str(uuid.uuid4()), "name": name, "kind": "text",
            "mimeType": "text/plain",
            "content": f"[媒体文件: {media}] 类型={mime or '未知'} 需按需解码",
            "source": source,
        }
    return {
        "id": str(uuid.uuid4()), "name": name, "kind": "text",
        "mimeType": "text/plain",
        # 未下载的媒体：只说「没有文件体」，不把渠道内部 mediaId 当正文倒给模型和用户
        "content": f"[未下载的媒体：{name}] 渠道导出时未包含文件体，如需原件请在渠道内单独导出",
        "source": source,
    }


def clip_text(text: str, budget: int) -> tuple[str, bool, int, int]:
    """按行把正文裁到预算内，返回 (正文, 是否裁剪, 保留行数, 总行数)。

    与 server.py 的 apply_text_budget 同语义：**按整行保留**，不把一条消息拦腰截断；
    只有单行本身就超预算时才硬切。裁剪一定在正文尾部留说明，绝不静默丢内容。
    """
    raw = text or ""
    lines = raw.split("\n")
    total = len(lines)
    if budget <= 0 or len(raw) <= budget:
        return raw, False, total, total

    kept: list[str] = []
    used = 0
    for line in lines:
        cost = len(line) + 1
        if used + cost > budget:
            break
        kept.append(line)
        used += cost
    if not kept:
        kept = [raw[: max(0, budget)]]

    tail = f"\n…（已截断：原文共 {total} 行 / {len(raw)} 字，本次只保留前 {len(kept)} 行）"
    return "\n".join(kept) + tail, True, len(kept), total


def build_chat_bundle(records, name: str | None = None, source: str = "用户上传") -> list:
    """聚焦窗口 -> [chat 证据, *媒体独立证据]，结构与 server.py/build_chat_bundle 一致。"""
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
        evidences.append(_media_to_evidence(item, source))
    return evidences


def validate_evidence(ev: dict) -> list[str]:
    """轻量 EvidenceSchema 校验（不变量：B 的校验同此）。返回错误列表。"""
    errs: list[str] = []
    for f in ("id", "name", "kind", "mimeType", "content"):
        if not ev.get(f):
            errs.append(f"missing {f}")
    if ev.get("kind") not in KINDS:
        errs.append(f"bad kind {ev.get('kind')}")
    if ev.get("kind") == "image" and not str(ev.get("content", "")).startswith("data:image/"):
        errs.append("image content not data url")
    return errs
