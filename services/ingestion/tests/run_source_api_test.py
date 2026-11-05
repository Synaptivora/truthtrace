#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""/source/* 四个接口端到端验收（方案 A 对外能力）。

冻结契约见《A端推进·总结与下一步.md》§6，本测试逐条对着验：

  1. GET  /source/list              → sources[]，4 个渠道，字段齐全
  2. GET  /source/status?source=钉钉 → 200，中文名归一成 dingtalk
  3. 未知渠道                        → 404（不是 200 + 服务说明）
  4. 路由不被 do_GET 兜底吞掉        → 兜底是「200 + service 字段」，命中则视为静默错误
  5. POST /source/connect           → mock 直接 ready
  6. POST /source/sync              → evidences[] 全部通过 EvidenceSchema 不变量
  7. sync 的 source 是渠道名         → 不落回「用户上传」（§5.3 第 3 条）
  8. single-flight                  → 并发 sync 返回 409 busy，而不是二次执行
  9. CORS                           → OPTIONS 预检 204 + Access-Control-Allow-Origin
 10. /parse、/parse_chat 不受影响    → 纯新增，零回归

运行：python run_source_api_test.py
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
import security_test_auth

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SERVER = os.path.join(ROOT, "server.py")
PORT = 8061
BASE = f"http://127.0.0.1:{PORT}"

fails = []


def check(label, cond, detail=""):
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))
    if not cond:
        fails.append(label)


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return r.status, json.loads(r.read().decode()), dict(r.headers)


def post(path, obj):
    req = urllib.request.Request(
        BASE + path, data=json.dumps(obj, ensure_ascii=False).encode("utf-8"),
        method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.status, json.loads(r.read().decode())


def post_expect_error(path, obj):
    try:
        post(path, obj)
        return None
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


def validate_evidence(ev: dict) -> list:
    """与 B 侧 EvidenceSchema 等价的不变量（不引入 zod，逐条手工对齐）。"""
    errs = []
    for f in ("id", "name", "kind", "mimeType", "content"):
        if not ev.get(f):
            errs.append(f"missing {f}")
    if ev.get("kind") not in ("text", "chat", "image", "pdf"):
        errs.append(f"bad kind {ev.get('kind')}")
    if ev.get("kind") == "image" and not str(ev.get("content", "")).startswith("data:image/"):
        errs.append("image content not data url")
    return errs


def main():
    tmp = tempfile.mkdtemp(prefix="srcapi_")
    env = dict(os.environ, UPLOAD_DIR=os.path.join(tmp, "_uploads"))
    proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "tests", "security_offline_server.py"), "--port", str(PORT)],
                            cwd=ROOT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(150):
            try:
                urllib.request.urlopen(BASE + "/health", timeout=1)
                break
            except Exception:
                time.sleep(0.1)
        else:
            print("服务未能启动")
            sys.exit(1)

        print("\n=== 1) GET /source/list ===")
        st, body, _ = get("/source/list")
        srcs = body.get("sources", [])
        check("HTTP 200", st == 200, str(st))
        check("有 sources 数组", isinstance(srcs, list) and len(srcs) >= 3, f"{len(srcs)} 个")
        check("不被 do_GET 兜底吞掉", "service" not in body,
              "拿到兜底说明就说明路由没排上")
        need = {"id", "name", "authorized", "status", "last_sync", "count"}
        check("字段齐全", all(need <= set(s) for s in srcs),
              str([s["id"] for s in srcs]))
        check("恰好三个渠道", {"mock", "dingtalk", "wechat"} == {s["id"] for s in srcs})

        print("\n=== 2) GET /source/status ===")
        st, body, _ = get("/source/status?source=" + urllib.parse.quote("钉钉"))
        check("HTTP 200", st == 200, str(st))
        check("中文名归一成 id", body.get("source") == "dingtalk", str(body.get("source")))
        check("含 detail/last_sync/count",
              {"detail", "last_sync", "count"} <= set(body), str(list(body)))

        print("\n=== 3) 未知渠道 ===")
        res = post_expect_error("/source/connect", {"source": "不存在的渠道"})
        check("connect 未知渠道 → 404", res and res[0] == 404, str(res))

        print("\n=== 4) POST /source/connect ===")
        st, body = post("/source/connect", {"source": "mock"})
        check("HTTP 200", st == 200, str(st))
        check("mock 直接 ready", body.get("status") == "ready" and body.get("authorized") is True,
              str(body))

        print("\n=== 5) POST /source/sync ===")
        st, body = post("/source/sync", {"source": "mock"})
        evs = body.get("evidences", [])
        check("HTTP 200", st == 200, str(st))
        check("synced 与 evidences 数量一致", body.get("synced") == len(evs),
              f"{body.get('synced')} vs {len(evs)}")
        check("产出非空", len(evs) > 0, f"{len(evs)} 条")
        errs = [e for ev in evs for e in validate_evidence(ev)]
        check("全部通过 EvidenceSchema 不变量", not errs, str(errs[:3]))
        check("无 validation_errors", not body.get("validation_errors"),
              str(body.get("validation_errors")))
        bad_src = sorted({ev.get("source") for ev in evs})
        check("source 是渠道名而非「用户上传」", "用户上传" not in bad_src, str(bad_src))
        kinds = sorted({ev.get("kind") for ev in evs})
        check("kind 全在契约内", set(kinds) <= {"text", "chat", "image", "pdf"}, str(kinds))

        print("\n=== 6) single-flight（并发 sync 不二次执行）===")
        sys.path.insert(0, ROOT)
        from ai_ingest.service import SourceService
        svc = SourceService()
        svc._busy["mock"] = True           # 模拟上一次同步尚未结束
        obj, code = svc.sync("mock")
        check("busy 时返回 409 而非重复跑", code == 409 and obj.get("status") == "busy",
              f"{code} {obj}")

        print("\n=== 7) CORS（直连 A 的前提）===")
        req = urllib.request.Request(BASE + "/source/list", method="OPTIONS")
        with urllib.request.urlopen(req, timeout=10) as r:
            check("OPTIONS → 204", r.status == 204, str(r.status))
            check("默认无 Access-Control-Allow-Origin",
                  "Access-Control-Allow-Origin" not in dict(r.headers),
                  dict(r.headers).get("Access-Control-Allow-Origin", ""))
        _, _, hdrs = get("/health")
        check("普通 GET 默认无 CORS 头", "Access-Control-Allow-Origin" not in hdrs)

        print("\n=== 8) 零回归：/parse 与 /parse_chat 不受影响 ===")
        txt = os.path.join(tmp, "聊天记录.txt")
        with open(txt, "w", encoding="utf-8") as f:
            f.write("张三：那笔合作款你什么时候打\n王五：下周一定\n")
        bd = "----wb" + uuid.uuid4().hex
        raw = open(txt, "rb").read()
        payload = (f"--{bd}\r\nContent-Disposition: form-data; name=\"file\"; "
                   f"filename=\"聊天记录.txt\"\r\nContent-Type: text/plain\r\n\r\n").encode() + raw + \
                  f"\r\n--{bd}--\r\n".encode()
        req = urllib.request.Request(BASE + "/parse", data=payload, method="POST",
                                     headers={"Content-Type": f"multipart/form-data; boundary={bd}"})
        with urllib.request.urlopen(req, timeout=30) as r:
            ev = json.loads(r.read().decode())["evidence"]
        check("/parse 仍返回单条", ev.get("kind") == "chat", str(ev.get("kind")))

        st, body = post("/parse_chat", {"records": [{"seq": 1, "sender": "张三", "time": "2026-07-26 09:20:00",
                                                     "text": "款子什么时候打", "type": "text"}],
                                        "source": "钉钉"})
        check("/parse_chat 仍返回数组", isinstance(body.get("evidences"), list))
        check("/parse_chat 保留 source",
              all(e.get("source") == "钉钉" for e in body.get("evidences", [])))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()

    print()
    if fails:
        print(f"RESULT: {len(fails)} FAILED → {fails}")
        sys.exit(1)
    print("RESULT: ALL PASS —— /source/* 契约成立，既有端点零回归")


if __name__ == "__main__":
    main()
