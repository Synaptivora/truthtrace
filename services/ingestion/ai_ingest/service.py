#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""方案 A · 服务层：connect / status / sync。

供 server.py 的 `/source/*` 路由调用，把「AI 驱动取数」能力暴露成三个动作。
返回结构严格遵循《A端推进·总结与下一步.md》§6 冻结的契约，B/C 可以照此对接：

    GET  /source/list                → { sources: [ {id,name,authorized,status,last_sync,count} ] }
    GET  /source/status?source=钉钉  → { source, authorized, status, detail, last_sync, count }
    POST /source/connect {"source"}  → { source, authorized, status, action, hint }
    POST /source/sync    {"source"}  → { source, synced, evidences: [Evidence...] }

三条硬约束（来自 §5.3，踩过就很难查）：
  1. 路由分支必须排在 do_GET / do_POST 的兜底之前，否则被 200 + 服务说明吞掉；
  2. sync 必须受 single-flight 锁保护，否则多线程下 backend 内存态互相覆盖；
  3. sync 产出的 evidence 必须显式带 source（渠道取数不能落回「用户上传」）。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time

from .backends import MockBackend, DingTalkBackend, WeChatBackend, FeishuBackend
from .tools import ToolRegistry
from .agent import MockAgent, OpenAIAgent
from .config import llm_config_from_env, has_llm_key, OpenAICompatibleClient
from . import evidence

DEFAULT_GOAL = "查王五和张三之间关于合作款、转账的沟通，找出承诺与履约差异"

# 渠道别名：前端可能传中文名，也可能传英文 id，统一归一到内部 id
ALIASES = {
    "mock": "mock", "演示": "mock", "demo": "mock",
    "钉钉": "dingtalk", "dingtalk": "dingtalk", "dws": "dingtalk",
    "微信": "wechat", "wechat": "wechat", "weixin": "wechat",
    "飞书": "feishu", "feishu": "feishu", "lark": "feishu",
}

# 展示名：Evidence.source 用这个（B 的 prompt 会原样显示给用户）
DISPLAY = {"mock": "mock", "dingtalk": "钉钉", "wechat": "微信", "feishu": "飞书"}

CATALOG = [
    {"id": "mock", "name": "演示数据源", "auth": "none"},
    {"id": "dingtalk", "name": "钉钉", "auth": "dws 扫码登录"},
    {"id": "wechat", "name": "微信", "auth": "手机扫码抓 SQLCipher 密钥"},
    {"id": "feishu", "name": "飞书", "auth": "lark-cli 授权"},
]


def normalize_source(raw: str | None) -> str:
    if not raw:
        return "mock"
    key = str(raw).strip().lower()
    return ALIASES.get(key, ALIASES.get(str(raw).strip(), key))


def _backend_cls(source_id: str):
    return {"mock": MockBackend, "dingtalk": DingTalkBackend,
            "wechat": WeChatBackend, "feishu": FeishuBackend}.get(source_id)


class SourceService:
    """渠道连接状态机 + sync 编排。

    状态是进程内内存态（ThreadingHTTPServer 多线程共享），所以 sync 必须 single-flight。
    """

    def __init__(self):
        self._lock = threading.Lock()          # 保护 _state / _busy / _store
        self._busy: dict[str, bool] = {}
        self._state: dict[str, dict] = {}
        self._store: dict[str, list] = {}      # source -> 上次 sync 的 evidences
        self._loaded: dict[str, object] = {}   # source -> 已 load 的 backend

    # ------------------------------------------------------------------ 状态
    def _ensure(self, source_id: str) -> dict:
        st = self._state.get(source_id)
        if st is None:
            st = {"authorized": False, "status": "not_connected",
                  "detail": "尚未连接", "last_sync": None, "count": 0}
            self._state[source_id] = st
        return st

    def list_sources(self) -> dict:
        out = []
        for c in CATALOG:
            sid = c["id"]
            with self._lock:
                st = self._ensure(sid)
                out.append({
                    "id": sid,
                    "name": c["name"],
                    "auth": c["auth"],
                    "authorized": st["authorized"],
                    "status": st["status"],
                    "last_sync": st["last_sync"],
                    "count": st["count"],
                })
        return {"sources": out}

    def status(self, raw_source: str | None) -> tuple[dict, int]:
        sid = normalize_source(raw_source)
        if _backend_cls(sid) is None:
            return {"error": f"未知数据源 {raw_source}，可用：{list(ALIASES)}"}, 404
        with self._lock:
            st = dict(self._ensure(sid))
        return {"source": sid, **st}, 200

    # ------------------------------------------------------------------ 连接
    def connect(self, raw_source: str | None) -> tuple[dict, int]:
        sid = normalize_source(raw_source)
        if _backend_cls(sid) is None:
            return {"error": f"未知数据源 {raw_source}，可用：{list(ALIASES)}"}, 404

        probe = self._probe(sid)
        with self._lock:
            st = self._ensure(sid)
            st.update({"authorized": probe["authorized"], "status": probe["status"],
                       "detail": probe["detail"]})
        return {"source": sid, **probe}, 200

    def _probe(self, sid: str) -> dict:
        """探测渠道是否可用。

        只做「能否在本机找到可用凭证/命令」的检查，**不替用户做授权**
        （扫码这件事由授权机制本身决定，只能人做，见总结文档 §2.1）。
        """
        if sid == "mock":
            return {"authorized": True, "status": "ready", "detail": "内置演示数据，无需凭证"}
        if sid == "dingtalk":
            dws = shutil.which("dws")
            if not dws:
                return {"authorized": False, "status": "need_auth",
                        "action": "dws auth login",
                        "hint": "未检测到 dws 命令行工具；安装后执行 `dws auth login` 扫码授权"}
            try:
                r = subprocess.run([dws, "auth", "status"], capture_output=True,
                                   timeout=8, text=True)
                ok = r.returncode == 0 and "not logged" not in (r.stdout or "").lower()
            except Exception as e:  # noqa: BLE001
                return {"authorized": False, "status": "need_auth",
                        "action": "dws auth login",
                        "hint": f"探测 dws 状态失败：{e}；请手动执行 `dws auth login`"}
            return ({"authorized": True, "status": "ready", "detail": "dws 已登录"}
                    if ok else
                    {"authorized": False, "status": "need_auth", "action": "dws auth login",
                     "hint": "dws 未登录，请扫码授权后重试"})
        if sid == "wechat":
            cache = os.environ.get("SYNAPSE_WECHAT_KEY_CACHE") or os.path.join(
                os.environ.get("LOCALAPPDATA", tempfile.gettempdir()),
                "Synapse", "wechat_db_keys.json")
            if os.path.isfile(cache):
                return {"authorized": True, "status": "ready",
                        "detail": f"已缓存微信数据库密钥（{cache}）"}
            return {"authorized": False, "status": "need_auth",
                    "action": "python -m adapters.wechat_key_cache import",
                    "hint": "未找到微信密钥缓存；需关闭微信 → 手机扫码 → 抓取 SQLCipher 密钥（只做一次）"}
        if sid == "feishu":
            lark = shutil.which("lark-cli")
            if not lark:
                return {"authorized": False, "status": "need_auth",
                        "action": "lark-cli auth login",
                        "hint": "未检测到 lark-cli；安装并授权后可拉取飞书会话"}
            return {"authorized": True, "status": "ready", "detail": "lark-cli 可用"}
        return {"authorized": False, "status": "unsupported", "detail": f"未支持的渠道 {sid}"}

    # ------------------------------------------------------------------ 同步
    def sync(self, raw_source: str | None, goal: str | None = None,
             source_data: str | None = None, mode: str = "auto",
             max_windows: int = 8) -> tuple[dict, int]:
        sid = normalize_source(raw_source)
        cls = _backend_cls(sid)
        if cls is None:
            return {"error": f"未知数据源 {raw_source}，可用：{list(ALIASES)}"}, 404

        # single-flight：并发 sync 返回 busy，而不是让后端内存态互相覆盖
        with self._lock:
            if self._busy.get(sid):
                return {"source": sid, "status": "busy",
                        "hint": "上一次同步尚未结束，请稍后重试"}, 409
            self._busy[sid] = True

        try:
            backend = cls()
            try:
                backend.load(source_data)
            except SystemExit as e:
                with self._lock:
                    self._ensure(sid).update(
                        {"authorized": False, "status": "need_data",
                         "detail": str(e).strip("[]! ")})
                return {"source": sid, "status": "need_data",
                        "detail": str(e).strip("[]! "),
                        "hint": "请在请求体带 source_data（导出 JSON 的绝对路径）"}, 400
            except Exception as e:  # noqa: BLE001
                return {"source": sid, "status": "error", "detail": f"取数失败: {e}"}, 500

            reg = ToolRegistry()
            reg.add(backend)

            cfg = llm_config_from_env()
            use_llm = (mode in ("auto", "llm")) and mode != "mock" and has_llm_key(cfg)
            agent = (OpenAIAgent(OpenAICompatibleClient(cfg), reg) if use_llm
                     else MockAgent(reg))

            # ToolRegistry 以后端的 source 属性为 key（钉钉/微信/飞书/mock），
            # 传英文 id 会让 registry.call 返回「未知数据源」，这里必须传 backend.source。
            windows = agent.run(goal or DEFAULT_GOAL, sources=[backend.source],
                                max_windows=max_windows)

            bundle: list = []
            for i, w in enumerate(windows):
                title = w.get("conv_title") or w.get("conv_id") or "会话"
                name = f"{title} · 聚焦#{i + 1} (center seq {w.get('center_seq')})"
                # window 自带 source（来自 backend），落进 Evidence.source 才是诚实的溯源
                bundle.extend(evidence.build_chat_bundle(
                    w["records"], name=name,
                    source=w.get("source") or DISPLAY.get(sid, sid)))

            errs = []
            for ev in bundle:
                errs.extend(evidence.validate_evidence(ev))

            with self._lock:
                st = self._ensure(sid)
                st.update({"authorized": True, "status": "ready",
                           "detail": f"已同步 {len(windows)} 个聚焦窗口",
                           "last_sync": time.strftime("%Y-%m-%d %H:%M:%S"),
                           "count": len(bundle)})
                self._store[sid] = bundle

            out = {"source": sid, "synced": len(bundle), "evidences": bundle,
                   "windows": len(windows), "agent": type(agent).__name__}
            if errs:
                out["validation_errors"] = errs
            return out, 200
        finally:
            with self._lock:
                self._busy[sid] = False

    def last_evidences(self, raw_source: str | None) -> list:
        with self._lock:
            return list(self._store.get(normalize_source(raw_source), []))
