#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""方案 A · 配置与零依赖 LLM 客户端（OpenAI 兼容）。

无 API key 时自动降级为 Mock（由 agent 层决定用 LLM 还是确定性 planner）。
"""
import json
import os
import urllib.request

DEFAULT_BASE_URL = "https://api.openai.com/v1"


def llm_config_from_env() -> dict:
    return {
        "base_url": os.environ.get("SYNAPSE_LLM_BASE_URL", DEFAULT_BASE_URL).rstrip("/"),
        "api_key": os.environ.get("SYNAPSE_LLM_API_KEY", ""),
        "model": os.environ.get("SYNAPSE_LLM_MODEL", "gpt-4o-mini"),
        "timeout": int(os.environ.get("SYNAPSE_LLM_TIMEOUT", "60")),
    }


def has_llm_key(cfg: dict) -> bool:
    return bool(cfg.get("api_key"))


class OpenAICompatibleClient:
    """极简 OpenAI 兼容 chat/completions 客户端（仅用标准库）。"""

    def __init__(self, cfg: dict):
        self.cfg = cfg

    def chat_with_tools(self, system: str, user: str, tools: list,
                        executor, max_steps: int = 8) -> str:
        """跑 agentic loop：把 tool_calls 交给 executor(call_list)->[(id,name,content)]。

        返回最后一条 assistant 文本（或空串）。executor 负责真正执行工具并把结果回填。
        """
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
        for _ in range(max_steps):
            body = {
                "model": self.cfg["model"],
                "messages": messages,
                "tools": tools,
                "tool_choice": "auto",
            }
            resp = self._post("chat/completions", body)
            msg = resp["choices"][0]["message"]
            if msg.get("tool_calls"):
                messages.append(msg)
                results = executor(msg["tool_calls"])
                for r in results:
                    messages.append({
                        "role": "tool",
                        "tool_call_id": r["call_id"],
                        "name": r["name"],
                        "content": r["content"],
                    })
                continue
            return msg.get("content", "")
        return ""

    def _post(self, path: str, body: dict) -> dict:
        from .secure_transport import post_json
        return post_json(self.cfg, path, body)
