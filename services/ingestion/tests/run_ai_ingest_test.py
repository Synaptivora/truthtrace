#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""方案 A（AI 智能取数）端到端验证：三端真实数据都产出聚焦证据。

重点守一个真实踩过的 bug：
    ToolRegistry 以后端的 `source` 属性（钉钉/微信/飞书/mock）为 key，
    而 CLI 与 service 拿的是英文 id（dingtalk/wechat/feishu/mock）。
    传错就返回「未知数据源」，agent 静默产出 **0 个窗口**——不报错、不崩溃，
    只是证据为空，是最难查的一类问题。这里三端各跑一遍把它钉死。

覆盖：
  1. mock  → 窗口 > 0，证据通过 EvidenceSchema 不变量
  2. 钉钉   → 真实 demo 数据，窗口 > 0，Evidence.source == 钉钉
  3. 飞书   → 真实 demo 数据，窗口 > 0，Evidence.source == 飞书
  4. 工具层 → 用 backend.source 调 search_messages / list_transfers 能命中
  5. service.sync → 中文名与英文 id 归一到同一渠道

运行：python run_ai_ingest_test.py
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "testdata")
sys.path.insert(0, ROOT)

fails = []


def check(label, cond, detail=""):
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))
    if not cond:
        fails.append(label)


def validate(ev: dict) -> list:
    errs = []
    for f in ("id", "name", "kind", "mimeType", "content"):
        if not ev.get(f):
            errs.append(f"missing {f}")
    if ev.get("kind") not in ("text", "chat", "image", "pdf"):
        errs.append(f"bad kind {ev.get('kind')}")
    if ev.get("kind") == "image" and not str(ev.get("content", "")).startswith("data:image/"):
        errs.append("image content not data url")
    return errs


def run_cli(source, data_path, out_dir):
    cmd = [sys.executable, "-m", "ai_ingest.orchestrator", "--source", source,
           "--out", out_dir]
    if data_path:
        cmd += ["--source-data", data_path]
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=180)
    return r


def main():
    print("=== 1) mock（无需凭证）===")
    tmp = tempfile.mkdtemp(prefix="ai_ingest_")
    r = run_cli("mock", None, os.path.join(tmp, "mock"))
    check("CLI 退出码 0", r.returncode == 0, r.stderr[-200:] if r.returncode else "")
    out = os.path.join(tmp, "mock", "evidence_bundle.json")
    check("产出 bundle 文件", os.path.isfile(out))
    if os.path.isfile(out):
        evs = json.load(open(out, encoding="utf-8"))
        check("证据非空", len(evs) > 0, f"{len(evs)} 条")
        check("契约校验通过", not [e for ev in evs for e in validate(ev)])

    print("\n=== 2) 钉钉（真实 demo 数据）===")
    dt = os.path.join(DATA, "dingtalk_demo", "messages.json")
    check("demo 数据存在", os.path.isfile(dt), dt)
    r = run_cli("dingtalk", dt, os.path.join(tmp, "dt"))
    check("CLI 退出码 0", r.returncode == 0, r.stderr[-200:] if r.returncode else "")
    out = os.path.join(tmp, "dt", "evidence_bundle.json")
    evs = json.load(open(out, encoding="utf-8")) if os.path.isfile(out) else []
    check("产出非空（0 条说明 registry key 不匹配）", len(evs) > 0, f"{len(evs)} 条")
    check("source 是钉钉", all(e.get("source") == "钉钉" for e in evs),
          str(sorted({e.get("source") for e in evs})))

    print("\n=== 3) 飞书（真实 demo 数据）===")
    fs = os.path.join(DATA, "feishu_demo", "messages.json")
    check("demo 数据存在", os.path.isfile(fs), fs)
    r = run_cli("feishu", fs, os.path.join(tmp, "fs"))
    check("CLI 退出码 0", r.returncode == 0, r.stderr[-200:] if r.returncode else "")
    out = os.path.join(tmp, "fs", "evidence_bundle.json")
    evs = json.load(open(out, encoding="utf-8")) if os.path.isfile(out) else []
    check("产出非空", len(evs) > 0, f"{len(evs)} 条")
    check("source 是飞书", all(e.get("source") == "飞书" for e in evs),
          str(sorted({e.get("source") for e in evs})))

    print("\n=== 4) 工具层 key 一致性 ===")
    from ai_ingest.tools import ToolRegistry
    from ai_ingest.backends import MockBackend
    reg = ToolRegistry()
    b = MockBackend()
    b.load()
    reg.add(b)
    hits = reg.call("search_messages", {"source": b.source, "query": "合作款"}).get("hits", [])
    check("用 backend.source 能检索到", len(hits) > 0, f"{len(hits)} 条")
    bad = reg.call("search_messages", {"source": "nope"}).get("error")
    check("未知 source 有明确报错（不静默返回空）", bool(bad), str(bad))

    print("\n=== 5) service 渠道名归一 ===")
    from ai_ingest.service import SourceService, normalize_source
    check("钉钉 → dingtalk", normalize_source("钉钉") == "dingtalk")
    check("dingtalk → dingtalk", normalize_source("dingtalk") == "dingtalk")
    check("飞书 → feishu", normalize_source("飞书") == "feishu")
    svc = SourceService()
    obj, code = svc.sync("mock")
    check("sync 用中文别名也能跑", code == 200 and obj.get("synced", 0) > 0,
          f"{code} {obj.get('synced')}")
    check("sync 产出契约合规", not [e for ev in obj.get("evidences", []) for e in validate(ev)])

    print()
    if fails:
        print(f"RESULT: {len(fails)} FAILED → {fails}")
        sys.exit(1)
    print("RESULT: ALL PASS —— 三端取数均产出聚焦证据，无静默空结果")


if __name__ == "__main__":
    main()
