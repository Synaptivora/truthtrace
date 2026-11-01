#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pywxdump_to_synapse.py  ——  A6 真机取数（替代原 wechat-mcp 方案，草稿）
============================================================================
把 PyWxDump 解密后的微信本地库，转换成 A4 聊天证据要的输入格式：

    synapse_input/<user>_<date>.json       =  [ {seq, sender, time, text}, ... ]
    synapse_input/<user>_<date>.media.json =  [ {seq, type, path, decode_needed}, ... ]

设计要点（与「微信端选型结论.md」一致）：
  - 文本消息：原样进 text。
  - 文档 / 视频：text 写「可读引用 + 本地路径」，agent 直接按路径读原文件（零解码）。
  - 图片 / 语音：text 写「类型标记 + 本地路径」，并额外产出 .media.json，
                 记录 {seq, type, path, decode_needed}，供 media_decode.py 按需懒解码。
  - 不碰 wechat-ai-memory；解码交给 media_decode.py（PyWxDump 自带 dat2img / silk2audio 思路）。

用法：
  # 直接读 PyWxDump 解密库（推荐）
  python pywxdump_to_synapse.py --db ./decrypted/merge_all.db \
      --talker wxid_xxxx --date 2026-03-22 --out ./synapse_input

  # 也可吃 PyWxDump 导出的 JSON
  python pywxdump_to_synapse.py --json ./export/xxx.json --out ./synapse_input

说明：
  - 微信消息类型 Type：1=文本 3=图片 34=语音 43=视频 49=文件/卡片 10000=系统。
  - 本脚本对 PyWxDump 解密库的列名做「存在性探测」，换版本字段改名也不至于直接崩。
  - 图片 / 语音在库里的本地路径提取为 best-effort：能解析就给绝对路径，解析不到则留空，
    由 media_decode.py 在需要时再定位（路径通常在 xwechat_files/.../msg/attach|voice）。
"""

import sys
import os
import re
import json
import sqlite3
import argparse
from datetime import datetime, timezone, timedelta


# --------------------------------------------------------------------------- #
# 1. 读取 PyWxDump 解密库
# --------------------------------------------------------------------------- #
def _table_columns(conn: sqlite3.Connection, table: str):
    cur = conn.execute(f"PRAGMA table_info({table})")
    return [r[1] for r in cur.fetchall()]


def _pick(cols, *candidates):
    """从可用列里挑第一个存在的。"""
    lower = {c.lower(): c for c in cols}
    for cand in candidates:
        if cand.lower() in lower:
            return lower[cand.lower()]
    return None


def read_messages_from_db(db_path, talker=None, date=None):
    """读取 MSG 表，按 talker(可选) 与 date(YYYY-MM-DD, 可选) 过滤。
    返回 list[dict]，字段尽量统一为 seq/time_unix/sender_wxid/type/content。"""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cols = _table_columns(conn, "MSG")
    if not cols:
        raise RuntimeError(f"在 {db_path} 未找到 MSG 表，确认是否为 PyWxDump 解密库。")

    c_seq = _pick(cols, "localId", "ROWID", "MsgSvrID") or "ROWID"
    c_time = _pick(cols, "CreateTime") or "CreateTime"
    c_sender = _pick(cols, "Sender") or "Sender"
    c_talker = _pick(cols, "StrTalker") or "StrTalker"
    c_type = _pick(cols, "Type", "MsgType") or "Type"
    c_content = _pick(cols, "StrContent", "Content") or "StrContent"

    where = []
    params = []
    if talker:
        where.append(f"{c_talker} = ?")
        params.append(talker)
    if date:
        # date 当天 00:00:00 ~ 23:59:59（微信 CreateTime 为秒级 unix 时间戳，东八区）
        d = datetime.strptime(date, "%Y-%m-%d")
        tz = timezone(timedelta(hours=8))
        start = int(d.replace(tzinfo=tz).timestamp())
        end = start + 24 * 3600
        where.append(f"{c_time} >= ? AND {c_time} < ?")
        params += [start, end]

    sql = (f"SELECT {c_seq} AS seq, {c_time} AS ctime, {c_sender} AS sender, "
           f"{c_talker} AS talker, {c_type} AS mtype, {c_content} AS content "
           f"FROM MSG")
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += f" ORDER BY {c_seq} ASC"

    rows = conn.execute(sql, params).fetchall()
    conn.close()

    out = []
    for r in rows:
        out.append({
            "seq": r["seq"],
            "time_unix": r["ctime"],
            "sender_wxid": (r["sender"] or "").strip(),
            "talker_wxid": (r["talker"] or "").strip(),
            "type": r["mtype"],
            "content": r["content"] or "",
        })
    return out


# --------------------------------------------------------------------------- #
# 2. 联系人显示名解析
# --------------------------------------------------------------------------- #
def build_contact_map(db_path):
    """从解密库 Contact 表解析 wxid -> 显示名（备注优先，否则昵称）。"""
    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cols = _table_columns(conn, "Contact")
        if not cols:
            return {}
        c_uid = _pick(cols, "UserName") or "UserName"
        c_remark = _pick(cols, "Remark", "RemarkName")
        c_nick = _pick(cols, "NickName", "Nickname")
        sel = f"SELECT {c_uid} AS uid"
        if c_remark:
            sel += f", {c_remark} AS remark"
        if c_nick:
            sel += f", {c_nick} AS nick"
        sel += " FROM Contact"
        rows = conn.execute(sel).fetchall()
        conn.close()
        m = {}
        for r in rows:
            name = (r["remark"] or "") or (r["nick"] or "") or r["uid"]
            m[r["uid"]] = name
        return m
    except Exception:
        return {}


# --------------------------------------------------------------------------- #
# 3. 媒体路径 best-effort 提取
# --------------------------------------------------------------------------- #
_PATH_HINT = re.compile(r"([A-Za-z]:[\\/][^<>\"\r\n]+\.(dat|silk|mp4|jpg|png|pdf|docx?|xlsx?|pptx?|zip))",
                        re.IGNORECASE)


def extract_media_path(content: str):
    m = _PATH_HINT.search(content or "")
    return m.group(1) if m else None


# --------------------------------------------------------------------------- #
# 4. 映射到 A4 输入
# --------------------------------------------------------------------------- #
MEDIA_TYPES = {3: "image", 34: "voice", 43: "video", 49: "file"}
DECODE_NEEDED = {3: True, 34: True, 43: False, 49: False}  # 图片/语音需解码；视频/文件直读


def to_iso(ts):
    if not ts:
        return ""
    try:
        return datetime.fromtimestamp(int(ts), tz=timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return str(ts)


def normalize(messages, contact_map, self_wxid=None):
    """返回 (chat_records, media_records)。"""
    chat = []
    media = []
    for m in messages:
        mtype = m["type"]
        sender_wxid = m["sender_wxid"] or m["talker_wxid"]
        # 说话人显示名：自己 -> "我"，否则查联系人表
        if self_wxid and sender_wxid == self_wxid:
            sender = "我"
        else:
            sender = contact_map.get(sender_wxid, sender_wxid or "未知")
        time_str = to_iso(m["time_unix"])

        if mtype == 1:
            text = m["content"]
        elif mtype in MEDIA_TYPES:
            kind = MEDIA_TYPES[mtype]
            path = extract_media_path(m["content"])
            label = {"image": "图片", "voice": "语音", "video": "视频", "file": "文件"}[kind]
            text = f"[{label}] {path or '本地路径待解析'}"
            media.append({
                "seq": m["seq"],
                "type": kind,
                "path": path,
                "decode_needed": DECODE_NEEDED.get(mtype, False),
            })
        else:
            text = f"[类型{mtype}] {m['content']}"

        chat.append({
            "seq": m["seq"],
            "sender": sender,
            "time": time_str,
            "text": text,
        })
    return chat, media


# --------------------------------------------------------------------------- #
# 5. 入口
# --------------------------------------------------------------------------- #
def main():
    ap = argparse.ArgumentParser(description="PyWxDump 解密库 -> A4 聊天证据输入")
    ap.add_argument("--db", help="PyWxDump 解密库路径（如 merge_all.db）")
    ap.add_argument("--json", help="或直接吃 PyWxDump 导出的聊天 JSON")
    ap.add_argument("--talker", help="对方/群 wxid（StrTalker）")
    ap.add_argument("--date", help="日期过滤 YYYY-MM-DD")
    ap.add_argument("--self", help="自己的 wxid（用于把发送者标记为『我』）")
    ap.add_argument("--out", default="./synapse_input", help="输出目录")
    ap.add_argument("--user", help="输出文件名用的用户标识（默认用 talker）")
    args = ap.parse_args()

    if not args.db and not args.json:
        ap.error("必须提供 --db 或 --json 之一")

    contact_map = {}
    if args.db:
        messages = read_messages_from_db(args.db, talker=args.talker, date=args.date)
        contact_map = build_contact_map(args.db)
    else:
        # PyWxDump 导出 JSON 形态不固定，这里给一个最小兼容：假设是消息数组
        with open(args.json, "r", encoding="utf-8") as f:
            raw = json.load(f)
        messages = []
        for i, item in enumerate(raw if isinstance(raw, list) else raw.get("messages", [])):
            messages.append({
                "seq": item.get("seq", item.get("MsgSvrID", i)),
                "time_unix": item.get("time_unix", item.get("CreateTime")),
                "sender_wxid": item.get("sender_wxid", item.get("Sender", "")),
                "talker_wxid": item.get("talker_wxid", item.get("StrTalker", "")),
                "type": item.get("type", item.get("Type", 1)),
                "content": item.get("content", item.get("StrContent", "")),
            })

    chat, media = normalize(messages, contact_map, self_wxid=args.self)

    user = args.user or args.talker or "chat"
    date_tag = args.date or "all"
    name = f"{user}_{date_tag}"
    os.makedirs(args.out, exist_ok=True)
    chat_path = os.path.join(args.out, f"{name}.json")
    media_path = os.path.join(args.out, f"{name}.media.json")

    with open(chat_path, "w", encoding="utf-8") as f:
        # 写成信封而不是裸数组：/parse 靠信封里的 source 才能把来源认回「微信」，
        # 裸数组会被标成「用户上传」（钉钉/飞书适配器也是同一套信封规范）。
        json.dump({"source": "微信", "messages": chat}, f, ensure_ascii=False, indent=2)
    with open(media_path, "w", encoding="utf-8") as f:
        json.dump(media, f, ensure_ascii=False, indent=2)

    print(f"[ok] 聊天记录: {chat_path}  ({len(chat)} 条)")
    print(f"[ok] 媒体侧车: {media_path}  ({len(media)} 条, 需解码 {sum(1 for m in media if m['decode_needed'])} 条)")
    print(f"[hint] 把 {chat_path} 交给 A -> POST /parse (kind=chat, source=微信；信封已带 source)")


if __name__ == "__main__":
    main()
