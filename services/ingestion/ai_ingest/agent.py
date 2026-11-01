#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""方案 A · Agent（决策层）。

两种实现：
- MockAgent：无 LLM key 时的确定性 planner。按目标提取关键词 -> search_messages -> get_window，
  并聚拢 list_transfers，产出聚焦窗口。行为可复现、可演示（与项目 mock 分析模式同思路）。
- OpenAIAgent：OpenAI 兼容 function-calling。读 SYNAPSE_LLM_*，由模型自主决定查什么、要不要追问，
  最后调 finalize_evidence 汇总窗口。

两者都只产出「聚焦窗口列表」：[{source, conv_id, conv_title, center_seq, records}]，
由编排器再转成 Evidence。
"""
import json
import re

from .tools import ToolRegistry


def _extract_keywords(goal: str) -> list:
    """从调查目标里抽中文/数字关键词（长度>=2），并补一套反诈默认词。"""
    tokens = re.findall(r"[\u4e00-\u9fa5]{2,}|[0-9]+", goal or "")
    kws = [t for t in tokens if len(t) >= 2]
    fallback = ["转账", "退款", "合作款", "承诺", "付款", "红包", "定金"]
    for w in fallback:
        if w not in kws:
            kws.append(w)
    # 去重保序，限 8 个
    seen, out = set(), []
    for w in kws:
        if w not in seen:
            seen.add(w)
            out.append(w)
    return out[:8]


class MockAgent:
    def __init__(self, registry: ToolRegistry):
        self.registry = registry

    def run(self, goal: str, sources: list | None = None, max_windows: int = 8) -> list:
        avail = self.registry.list_sources()
        sources = sources or avail
        keywords = _extract_keywords(goal)
        windows = []
        seen = set()

        for src in sources:
            # 1) 关键词精准检索 -> 拉上下文窗口
            for kw in keywords:
                hits = self.registry.call("search_messages",
                                          {"source": src, "query": kw, "limit": 10}).get("hits", [])
                for h in hits:
                    center = h.get("seq")
                    key = (src, h.get("conv"), center)
                    if key in seen:
                        continue
                    seen.add(key)
                    recs = self.registry.call("get_window",
                                              {"source": src, "conv": h.get("conv"),
                                               "center_seq": center, "before": 4, "after": 4}).get("records", [])
                    if recs:
                        windows.append(self._mk_window(src, h, center, recs))
            # 2) 资金往来汇总 -> 单独小窗口（与关键词检索共用去重键，避免同一中心重复）
            trs = self.registry.call("list_transfers", {"source": src}).get("transfers", [])
            for tr in trs:
                center = tr.get("seq")
                key = (src, tr.get("conv"), center)
                if key in seen:
                    continue
                seen.add(key)
                recs = self.registry.call("get_window",
                                          {"source": src, "conv": tr.get("conv"),
                                           "center_seq": center, "before": 3, "after": 3}).get("records", [])
                if recs:
                    windows.append(self._mk_window(src, tr, center, recs))

        return windows[:max_windows]

    @staticmethod
    def _mk_window(src, hit, center, recs) -> dict:
        return {
            "source": src,
            "conv_id": hit.get("conv"),
            "conv_title": hit.get("conv_title"),
            "center_seq": center,
            "records": recs,
        }


_SYSTEM_PROMPT = (
    "你是反诈调查取证助手，负责从聊天记录中精准抽取「高信号证据窗口」。\n"
    "规则：\n"
    "1. 不要整段导出会话；先用 search_messages 按关键词检索，再用 get_window 只取命中点前后几条。\n"
    "2. 用 list_transfers 聚拢资金往来，对每笔转账单独取窗口。\n"
    "3. 发现线索可继续检索相关人/关键词做交叉验证（循环）。\n"
    "4. 证据够用时调用 finalize_evidence 汇总窗口；每个窗口要带 source/conv_id/center_seq/before/after。"
)

_FINALIZE_SCHEMA = {
    "type": "function",
    "function": {
        "name": "finalize_evidence",
        "description": "把收集到的聚焦窗口汇编成证据。调用即代表检索已完成。",
        "parameters": {
            "type": "object",
            "properties": {
                "windows": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "source": {"type": "string"},
                            "conv_id": {"type": "string"},
                            "center_seq": {"type": "integer"},
                            "before": {"type": "integer"},
                            "after": {"type": "integer"},
                        },
                        "required": ["source", "conv_id", "center_seq"],
                    },
                }
            },
            "required": ["windows"],
        },
    },
}


class OpenAIAgent:
    def __init__(self, client, registry: ToolRegistry):
        self.client = client
        self.registry = registry

    def run(self, goal: str, sources: list | None = None, max_steps: int = 12,
            max_windows: int = 8) -> list:
        sources = sources or self.registry.list_sources()
        tools = self.registry.list_tools_schema() + [_FINALIZE_SCHEMA]
        user_msg = f"调查目标：{goal}\n可用数据源：{sources}"

        def executor(tool_calls):
            results = []
            for tc in tool_calls:
                fn = tc.get("function", {})
                name = fn.get("name")
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except Exception:
                    args = {}
                if name == "finalize_evidence":
                    # 捕获窗口，但先返回一个确认，让 loop 在下一轮读取
                    self._last_windows = self._windows_from_args(args)
                    results.append({"call_id": tc.get("id"), "name": name,
                                    "content": json.dumps({"ok": True, "n": len(self._last_windows)},
                                                          ensure_ascii=False)})
                    return results
                try:
                    out = self.registry.call(name, args)
                    content = json.dumps(out, ensure_ascii=False)
                except Exception as e:  # noqa
                    content = json.dumps({"error": str(e)}, ensure_ascii=False)
                results.append({"call_id": tc.get("id"), "name": name, "content": content})
            return results

        self._last_windows = []
        self.client.chat_with_tools(_SYSTEM_PROMPT, user_msg, tools, executor, max_steps=max_steps)
        return self._last_windows[:max_windows]

    def _windows_from_args(self, args: dict) -> list:
        out = []
        for w in args.get("windows", []):
            recs = self.registry.call("get_window",
                                     {"source": w.get("source"), "conv": w.get("conv_id"),
                                      "center_seq": w.get("center_seq"),
                                      "before": w.get("before", 5), "after": w.get("after", 5)}).get("records", [])
            if recs:
                out.append({
                    "source": w.get("source"),
                    "conv_id": w.get("conv_id"),
                    "conv_title": recs[0].get("conv_title") if recs[0].get("conv_title") else "",
                    "center_seq": w.get("center_seq"),
                    "records": recs,
                })
        return out
