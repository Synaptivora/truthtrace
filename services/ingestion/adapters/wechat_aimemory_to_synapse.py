#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
wechat_aimemory_to_synapse.py
-----------------------------
把 wechat-ai-memory 导出的 **Version 1 JSON** 转换成 TruthTrace A 环节可直接消费的聊天记录。

输入：wechat-ai-memory 的 `--json` 产物（顶层 {version, conversations[]}）。
      同级目录下的 `<导出名>_assets/` 为图片/文件附件目录。

输出：在 --out 目录（默认 synapse_input/）下，每个会话生成一个
      `<会话名>_<首条消息日期>.json`，内容为 records 列表：
          [{seq, type, sender, time, text, media}, ...]
      该 schema 直接兼容 services/ingestion/server.py 的 POST /parse_chat
      （图片/文件消息的 media 为相对 _assets 的路径；--post 时把 media_dir 一并传过去）。

用法：
  # 仅生成 synapse_input/*.json
  python wechat_aimemory_to_synapse.py path/to/export.json

  # 生成并直接推给本地解析服务
  python wechat_aimemory_to_synapse.py export.json --post http://localhost:8000/parse_chat

  # 指定输出目录
  python wechat_aimemory_to_synapse.py export.json --out synapse_input

  # 附件目录名不是 <导出名>_assets 时必须显式指定，否则媒体全变「缺失」占位
  python wechat_aimemory_to_synapse.py export.json --assets path/to/any_assets
"""
import argparse
import base64
import json
import mimetypes
import os
import re
import sys

# A 侧约定的聊天消息类型（与 services/ingestion/server.py 的 CHAT_MSG_TYPES 对齐）
# text/system/emoji 进对话文本；image/file 进对话(标记)+独立证据；voice 进对话(标记)
_KNOWN_TYPES = {
    "text", "system", "emoji", "image", "file",
    "voice", "transfer", "link", "location", "card",
}


def _sanitize(name: str) -> str:
    """会话名 → 文件名安全字符串。"""
    s = re.sub(r'[\\/:*?"<>|\r\n]+', "_", name or "chat").strip(" ._")
    return s[:60] or "chat"


def _first_date(messages: list) -> str:
    for m in messages:
        ts = (m.get("timestamp") or "")[:10]
        if re.match(r"\d{4}-\d{2}-\d{2}", ts):
            return ts
    return "unknown"


def _looks_like_path(v: str) -> bool:
    """判断 content 是否是真实附件引用。

    真机实测发现：小程序/链接/文件消息的 content 常是「[小程序] xxx.md」这类
    **标签文本**，虽然以 .md 结尾却不是路径。以 '[' 开头的标签一律按纯文本处理，
    否则会被当成附件去 _assets 里找，最终变成「媒体文件缺失」占位。
    """
    if not v or v.lstrip().startswith("["):
        return False
    return bool(v) and (os.path.sep in v or v.lower().endswith(
        (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".emf", ".heic",
         ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
         ".txt", ".log", ".csv", ".md", ".json", ".xml", ".html",
         ".zip", ".rar", ".7z", ".tar", ".gz",
         ".mp3", ".wav", ".silk", ".amr", ".m4a", ".mp4", ".mov", ".avi")))


def convert_conversation(conv: dict) -> list:
    """wechat-ai-memory 的单个 conversation → A 侧 records 列表。"""
    msgs = conv.get("messages") or []
    # 防御性按时间排序（示例里本已有序）
    msgs = sorted(msgs, key=lambda m: m.get("timestamp", ""))

    records = []
    for idx, m in enumerate(msgs, start=1):
        raw_type = str(m.get("type") or "text").lower()
        if raw_type not in _KNOWN_TYPES:
            raw_type = "text"

        is_out = bool(m.get("is_outgoing"))
        sender = "我" if is_out else (m.get("sender") or "未知")
        time = m.get("timestamp") or ""
        content = m.get("content", "") or ""

        media = ""
        text = content

        if raw_type in ("image", "file"):
            if _looks_like_path(content):
                media = content
                text = ""  # 真实内容在附件里，对话里只留标记
            else:
                # 没有真实附件（如图片未解密、小程序/链接卡片）：保留标签文本，别丢掉
                text = content or ("[图片]" if raw_type == "image" else "[文件]")
        elif raw_type == "voice":
            # 真机实测：开启语音转写后，wechat-ai-memory 会额外给出 transcript 字段。
            # 有转写就直接当文本进对话（下游 B 能直接读），音频只是旁证，不再单独占一条证据。
            transcript = (m.get("transcript") or "").strip()
            if transcript:
                raw_type = "text"
                text = f"[语音] {transcript}"
            elif _looks_like_path(content):
                media = content
                text = ""  # 只有音频路径、没有转写：音频进独立证据，对话里留标记
            else:
                raw_type = "text"  # 已是 [语音消息 · 待转写] 之类占位，原样进对话
        elif raw_type in ("transfer",):
            text = content  # 金额/说明已在 content
        # text / system / emoji / link / location / card → text=content 原样进对话

        records.append({
            "seq": idx,
            "type": raw_type,
            "sender": sender,
            "time": time,
            "text": text,
            "media": media,
        })
    return records


def find_assets_dir(json_path: str, explicit: str | None = None) -> str | None:
    """定位附件目录：优先 --assets 显式指定，否则按 <导出名>_assets / assets 顺序找。

    真机踩坑：export_target.py 的 --assets 可以自定义目录名（如 cache_assets），
    只按名字猜会找不到，导致所有图片/文件变成「缺失」占位。
    """
    if explicit:
        return explicit if os.path.isdir(explicit) else None
    d = os.path.dirname(os.path.abspath(json_path))
    stem = os.path.splitext(os.path.basename(json_path))[0]
    candidates = [
        os.path.join(d, stem + "_assets"),
        os.path.join(d, "assets"),
    ]
    for c in candidates:
        if os.path.isdir(c):
            return c
    return None


def process_file(json_path: str, out_dir: str, post_url: str | None,
                 assets: str | None = None):
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    if data.get("version") != 1:
        raise SystemExit(f"[!] 仅支持 Version 1 JSON，当前 version={data.get('version')!r}: {json_path}")

    conversations = data.get("conversations") or []
    if not conversations:
        raise SystemExit(f"[!] conversations 为空: {json_path}")

    assets_dir = find_assets_dir(json_path, assets)
    os.makedirs(out_dir, exist_ok=True)

    summary = []
    for conv in conversations:
        name = conv.get("name") or conv.get("id") or "chat"
        records = convert_conversation(conv)
        date = _first_date(conv.get("messages") or [])
        out_name = f"{_sanitize(name)}_{date}.json"
        out_path = os.path.join(out_dir, out_name)
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(records, f, ensure_ascii=False, indent=2)

        # 统计媒体项
        n_img = sum(1 for r in records if r["type"] == "image")
        n_file = sum(1 for r in records if r["type"] == "file")
        summary.append((out_name, len(records), n_img, n_file))

        if post_url:
            _post_to_server(post_url, name, records, assets_dir)

    return summary, assets_dir


def _post_to_server(url: str, name: str, records: list, assets_dir: str | None):
    import urllib.request
    # source 显式声明：/parse_chat 的默认值已改为「用户上传」，适配器不传就会丢掉微信溯源。
    payload = {"name": name, "records": records, "source": "微信"}
    if assets_dir:
        payload["media_dir"] = os.path.abspath(assets_dir)
    req = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    evs = body.get("evidences", [])
    print(f"    → POST {url} [{name}] 返回 {len(evs)} 条 evidence")


def main():
    ap = argparse.ArgumentParser(description="wechat-ai-memory Version 1 JSON → Synapse A4/A6 聊天记录")
    ap.add_argument("input", help="wechat-ai-memory 导出的 Version 1 JSON 文件")
    ap.add_argument("--out", default="synapse_input", help="输出目录（默认 synapse_input/）")
    ap.add_argument("--post", default=None, help="可选：解析服务地址，如 http://localhost:8000/parse_chat")
    ap.add_argument("--assets", default=None,
                    help="可选：附件目录（默认按 <导出名>_assets / assets 自动查找）")
    args = ap.parse_args()

    if not os.path.isfile(args.input):
        raise SystemExit(f"[!] 输入文件不存在: {args.input}")

    summary, assets = process_file(args.input, args.out, args.post, args.assets)
    print(f"[✓] 处理完成：{args.input}")
    assets_hint = assets or "(未找到，图片/文件将以缺失占位)"
    print(f"    _assets 目录：{assets_hint}")
    print(f"    输出目录：{os.path.abspath(args.out)}")
    for name, n, ni, nf in summary:
        print(f"    · {name}  ({n} 条消息, 图片 {ni}, 文件 {nf})")


if __name__ == "__main__":
    main()
