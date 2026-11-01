#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""方案 A · 取数后端（Backends）。

每个后端持有真实的取数工具（dws CLI / wechat-ai-memory），把「导出全部」升级为「按需查询」。
统一暴露：load / list_conversations / search / get_window / list_transfers。

- MockBackend：内置与 dingtalk_to_synapse.demo() 同构的数据集，无需任何凭证即可演示。
- DingTalkBackend：复用 dingtalk_to_synapse.convert() 把 dws 导出的 JSON 归一为 records，再内存查询。
- WeChatBackend：复用 wechat_aimemory_to_synapse.convert_conversation() 把微信导出归一为 records。
"""
import base64
import os
import re
import sys
import tempfile

# 1px PNG，用于 Mock 演示里的「转账截图」媒体
_PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
)

# adapters/（钉钉/微信/飞书适配器）与本包同级，加进 sys.path 才能懒加载
ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "adapters")
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)


class SourceBackend:
    source = "?"

    def load(self, data_path: str | None = None):
        raise NotImplementedError

    def list_conversations(self) -> list:
        return [{"id": c["id"], "title": c["title"], "count": len(c["records"]),
                 "start": c.get("start", ""), "end": c.get("end", "")}
                for c in self.conversations]

    def search(self, query: str, time_start=None, time_end=None, limit: int = 20) -> list:
        q = (query or "").lower()
        hits = []
        for conv in self.conversations:
            for r in conv["records"]:
                text = (r.get("text") or "").lower()
                sender = (r.get("sender") or "").lower()
                if q and (q in text or q in sender) and self._in_range(r.get("time"), time_start, time_end):
                    hits.append({**r, "conv": conv["id"], "conv_title": conv["title"]})
        return hits[:limit]

    def get_window(self, conv_id, center_seq, before: int = 5, after: int = 5) -> list:
        conv = next((c for c in self.conversations if c["id"] == conv_id), None)
        if not conv:
            return []
        recs = conv["records"]
        idx = next((i for i, r in enumerate(recs) if r.get("seq") == center_seq), None)
        if idx is None:
            return []
        return recs[max(0, idx - before): idx + after + 1]

    def list_transfers(self, time_start=None, time_end=None) -> list:
        res = []
        for conv in self.conversations:
            for r in conv["records"]:
                is_tr = (r.get("type") == "transfer"
                         or bool(str(r.get("amount") or "").strip())
                         or bool(re.search(r"转账|红包|收款|付款", r.get("text") or "")))
                if is_tr and self._in_range(r.get("time"), time_start, time_end):
                    res.append({**r, "conv": conv["id"], "conv_title": conv["title"]})
        return res

    @staticmethod
    def _in_range(t, s, e) -> bool:
        if not t:
            return True
        if s and t < s:
            return False
        if e and t > e:
            return False
        return True

    def _index(self):
        for c in self.conversations:
            c["start"] = c["records"][0]["time"] if c["records"] else ""
            c["end"] = c["records"][-1]["time"] if c["records"] else ""


class MockBackend(SourceBackend):
    source = "mock"

    def load(self, data_path: str | None = None):
        here = os.path.dirname(os.path.abspath(__file__))
        asset_dir = os.path.join(here, "_demo_assets")
        os.makedirs(asset_dir, exist_ok=True)
        png_path = os.path.join(asset_dir, "转账截图.png")
        if not os.path.isfile(png_path):
            with open(png_path, "wb") as f:
                f.write(_PNG_1PX)

        records = [
            {"seq": 1, "sender": "张三", "time": "2026-07-26 09:20:00",
             "text": "王五，那笔合作款你什么时候打？合同里写的是 8 月 1 日前。", "type": "text", "media": "", "amount": ""},
            {"seq": 2, "sender": "王五", "time": "2026-07-26 09:21:00",
             "text": "下周吧，最近资金紧。", "type": "text", "media": "", "amount": ""},
            {"seq": 3, "sender": "王五", "time": "2026-07-26 09:22:00",
             "text": "这是当时的转账记录", "type": "image", "media": png_path, "amount": ""},
            {"seq": 4, "sender": "张三", "time": "2026-07-26 09:23:00",
             "text": "你上次也说下周，已经拖了两个月了。", "type": "text", "media": "", "amount": ""},
            {"seq": 5, "sender": "王五", "time": "2026-07-26 09:24:00",
             "text": "[语音]", "type": "voice", "media": "", "amount": ""},
            {"seq": 6, "sender": "张三", "time": "2026-07-26 09:25:00",
             "text": "已转 ¥2000 定金，转账记录在群里。", "type": "transfer", "media": "", "amount": "2000"},
        ]
        self.conversations = [{
            "id": "cid_demo",
            "title": "demo_供应商催款群",
            "source": "mock",
            "records": records,
        }]
        self._index()


class DingTalkBackend(SourceBackend):
    source = "钉钉"

    def load(self, data_path: str | None = None):
        if not data_path or not os.path.isfile(data_path):
            raise SystemExit(f"[!] 钉钉后端需要 dws 导出的 messages.json：--source-data {data_path or ''}")
        import dingtalk_to_synapse as dts  # 懒加载，避免 mock 模式也被迫依赖
        tmp = tempfile.mkdtemp(prefix="synapse_dt_")
        convs = dts.convert(data_path, tmp, download_media=False)
        self.conversations = [{
            "id": c.get("openConversationId") or c["conversation"],
            "title": c["conversation"],
            "source": "钉钉",
            "records": c["messages"],
        } for c in convs]
        self._index()


class FeishuBackend(SourceBackend):
    source = "飞书"

    def load(self, data_path: str | None = None):
        if not data_path or not os.path.isfile(data_path):
            raise SystemExit(f"[!] 飞书后端需要 lark-cli 导出的 messages.json：--source-data {data_path or ''}")
        import feishu_to_synapse as fts  # 懒加载
        tmp = tempfile.mkdtemp(prefix="synapse_fs_")
        convs = fts.convert(data_path, tmp, download_media=False)
        self.conversations = [{
            "id": c.get("chat_id") or c["conversation"],
            "title": c["conversation"],
            "source": "飞书",
            "records": c["messages"],
        } for c in convs]
        self._index()


class WeChatBackend(SourceBackend):
    source = "微信"

    def load(self, data_path: str | None = None):
        if not data_path or not os.path.isfile(data_path):
            raise SystemExit(f"[!] 微信后端需要 wechat-ai-memory 的 Version 1 JSON：--source-data {data_path or ''}")
        import wechat_aimemory_to_synapse as wts  # 懒加载
        with open(data_path, encoding="utf-8") as f:
            data = __import__("json").load(f)
        conversations = data.get("conversations") or []
        self.conversations = []
        for conv in conversations:
            records = wts.convert_conversation(conv)
            if records:
                self.conversations.append({
                    "id": conv.get("id") or conv.get("name") or f"wx_{len(self.conversations)}",
                    "title": conv.get("name") or "微信会话",
                    "source": "微信",
                    "records": records,
                })
        self._index()
