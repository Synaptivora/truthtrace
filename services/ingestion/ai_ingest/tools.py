#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""方案 A · 工具注册与分发（Agent 可见的 5 个统一工具）。

Agent（无论 Mock 还是 LLM）只看到这 5 个平台无关的工具；
微信/钉钉/飞书各自实现 backend，新增渠道只加一个 backend，工具层不变。
"""
from .backends import MockBackend, DingTalkBackend, WeChatBackend, FeishuBackend


class ToolRegistry:
    def __init__(self):
        self.backends = {}

    def add(self, backend: object):
        self.backends[backend.source] = backend

    def list_sources(self) -> list:
        return list(self.backends.keys())

    def call(self, name: str, args: dict | None = None) -> dict:
        args = args or {}
        if name == "list_sources":
            return {"sources": self.list_sources()}
        src = args.get("source")
        if not src:
            src = self.list_sources()[0] if self.list_sources() else None
        if src not in self.backends:
            return {"error": f"未知数据源 {src}，可用：{self.list_sources()}"}
        b = self.backends[src]
        if name == "list_conversations":
            return {"conversations": b.list_conversations()}
        if name == "search_messages":
            return {"hits": b.search(args.get("query", ""), args.get("time_start"),
                                    args.get("time_end"), int(args.get("limit", 20)))}
        if name == "get_window":
            return {"records": b.get_window(args.get("conv"), args.get("center_seq"),
                                           int(args.get("before", 5)), int(args.get("after", 5)))}
        if name == "list_transfers":
            return {"transfers": b.list_transfers(args.get("time_start"), args.get("time_end"))}
        return {"error": f"未知工具 {name}"}

    # ---- 给 LLM 的 JSON Schema（function calling）----
    def list_tools_schema(self) -> list:
        return [
            {
                "type": "function",
                "function": {
                    "name": "list_conversations",
                    "description": "列出某数据源下有哪些会话（群聊/单聊），返回 id/标题/消息数/时间范围。",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "source": {"type": "string", "description": "数据源：钉钉/微信/mock"}
                        },
                        "required": ["source"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "search_messages",
                    "description": "在指定数据源/时间窗内按关键词精准检索消息，返回命中消息（含会话与序号）。",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "source": {"type": "string"},
                            "query": {"type": "string", "description": "关键词，如 合作款/退款/转账"},
                            "time_start": {"type": "string", "description": "可选，起始时间 YYYY-MM-DD HH:MM:SS"},
                            "time_end": {"type": "string"},
                            "limit": {"type": "integer", "default": 20},
                        },
                        "required": ["source", "query"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "get_window",
                    "description": "取某条消息前后若干条，作为聚焦证据窗口（不要整段导出）。",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "source": {"type": "string"},
                            "conv": {"type": "string", "description": "会话 id"},
                            "center_seq": {"type": "integer", "description": "中心消息序号"},
                            "before": {"type": "integer", "default": 5},
                            "after": {"type": "integer", "default": 5},
                        },
                        "required": ["source", "conv", "center_seq"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "list_transfers",
                    "description": "列出某数据源/时间窗内的全部转账、红包、收款类消息，便于聚拢资金往来。",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "source": {"type": "string"},
                            "time_start": {"type": "string"},
                            "time_end": {"type": "string"},
                        },
                        "required": ["source"],
                    },
                },
            },
        ]


def build_backend(source: str, data_path: str | None) -> object:
    if source in ("feishu", "飞书"):
        return FeishuBackend()
    if source == "mock":
        return MockBackend()
    if source == "dingtalk":
        return DingTalkBackend()
    if source == "wechat":
        return WeChatBackend()
    raise SystemExit(f"[!] 未知数据源 {source}，可选：mock / dingtalk / wechat / feishu")
