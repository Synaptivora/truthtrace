#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""方案 A · 编排器 CLI 入口。

把「调查目标」交给 AI agent，agent 持有取数工具做 agentic 检索，
产出多份聚焦 evidence（而非整段聊天 dump），写进 evidence_bundle.json。
B/C 零改动：产物满足 EvidenceSchema，可直接进 analyze。

运行（项目根目录）：
    python -m ai_ingest.orchestrator   # 在 services/ingestion/ 下执行 --source mock
    python -m ai_ingest.orchestrator   # 在 services/ingestion/ 下执行 --goal "..." --source mock --out services/ingestion/ai_ingest/output
    python -m ai_ingest.orchestrator   # 在 services/ingestion/ 下执行 --source dingtalk --source-data exports/群.json --post http://localhost:8000/parse_chat
"""
import argparse
import json
import os
import sys
import urllib.request

from .config import llm_config_from_env, has_llm_key, OpenAICompatibleClient
from .tools import ToolRegistry, build_backend
from .agent import MockAgent, OpenAIAgent
from . import evidence

DEFAULT_GOAL = "查王五和张三之间关于合作款、转账的沟通，找出承诺与履约差异"


def _post_windows(windows: list, url: str, out_dir: str):
    server_evs = []
    for w in windows:
        payload = {"name": w.get("conv_title"), "records": w["records"], "source": w["source"]}
        req = urllib.request.Request(
            url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                body = json.loads(r.read().decode("utf-8"))
            server_evs.extend(body.get("evidences", []))
        except Exception as e:  # noqa
            print(f"  [!] POST {url} 失败：{e}")
    if server_evs:
        p = os.path.join(out_dir, "evidence_bundle.server.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump(server_evs, f, ensure_ascii=False, indent=2)
        print(f"    服务端校验副本：{p} ({len(server_evs)} 条)")


def main():
    ap = argparse.ArgumentParser(description="A 智能取数编排器（方案 A）：让 AI 用透取数工具")
    ap.add_argument("--goal", default=DEFAULT_GOAL, help="调查目标")
    ap.add_argument("--source", default="mock", choices=["mock", "dingtalk", "wechat"],
                    help="数据源")
    ap.add_argument("--source-data", default=None, help="dingtalk/wechat 的导出 JSON 路径")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "output"), help="证据输出目录")
    ap.add_argument("--post", default=None, help="可选：解析服务地址，如 http://localhost:8000/parse_chat")
    ap.add_argument("--mode", default="auto", choices=["auto", "mock", "llm"])
    ap.add_argument("--max-windows", type=int, default=8)
    ap.add_argument("--demo", action="store_true", help="等价于 --source mock")
    args = ap.parse_args()
    if args.demo:
        args.source = "mock"

    # 1) 建 registry + 加载后端
    reg = ToolRegistry()
    backend = build_backend(args.source, args.source_data)
    backend.load(args.source_data)
    reg.add(backend)

    # 2) 选 agent（auto 时仅在有 key 才用 LLM）
    cfg = llm_config_from_env()
    use_llm = (args.mode in ("auto", "llm")) and args.mode != "mock" and has_llm_key(cfg)
    if use_llm:
        agent = OpenAIAgent(OpenAICompatibleClient(cfg), reg)
        print(f"[agent] OpenAIAgent (model={cfg['model']})")
    else:
        agent = MockAgent(reg)
        print(f"[agent] MockAgent（无 LLM key 或 --mode mock）")

    # 3) 跑 agentic 检索
    #    必须传 backend.source（钉钉/微信/mock）而不是 args.source（dingtalk/wechat/...）：
    #    ToolRegistry 以后端的 source 属性为 key，传英文 id 会返回「未知数据源」，静默产出 0 个窗口。
    windows = agent.run(args.goal, sources=[backend.source], max_windows=args.max_windows)

    # 4) 组装聚焦证据（每窗口 -> chat 证据 + 媒体独立证据）
    bundle = []
    for i, w in enumerate(windows):
        title = w.get("conv_title") or w.get("conv_id") or "会话"
        name = f"{title} · 聚焦#{i + 1} (center seq {w.get('center_seq')})"
        bundle.extend(evidence.build_chat_bundle(w["records"], name=name, source=w["source"]))

    # 5) 契约校验
    errs_total = 0
    for ev in bundle:
        e = evidence.validate_evidence(ev)
        if e:
            errs_total += len(e)
            print(f"  [!] evidence 校验失败 {ev.get('name')}: {e}")

    os.makedirs(args.out, exist_ok=True)
    out_path = os.path.join(args.out, "evidence_bundle.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(bundle, f, ensure_ascii=False, indent=2)

    # 6) 汇报
    print(f"[✓] 目标：{args.goal}")
    print(f"    聚焦窗口：{len(windows)} 个 -> 证据 {len(bundle)} 条（chat + 媒体独立证据）")
    print(f"    输出：{out_path}")
    for i, w in enumerate(windows):
        print(f"    · #{i + 1} {w.get('conv_title')}  center={w.get('center_seq')}  "
              f"消息数={len(w['records'])}  source={w['source']}")

    if args.post:
        _post_windows(windows, args.post, args.out)

    if errs_total:
        print(f"[!] 共 {errs_total} 处契约校验问题")
        sys.exit(2)


if __name__ == "__main__":
    main()
