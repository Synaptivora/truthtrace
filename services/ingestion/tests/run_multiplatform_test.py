#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""三端来源实测：微信 / 钉钉 / 飞书 走同一套 A4 代码，平台差异只进 source 不进 kind。

覆盖：
  1. 钉钉真产物（synapse_input/…records.json）→ chat + 独立媒体，source=钉钉
  2. 飞书真产物 → 同结构，source=飞书
  3. 微信群聊（构造，带图片）→ source=微信，媒体继承
  4. 三端 kind 完全一致（都只有 chat / image / pdf，没有平台 kind）
  5. 钉钉信封 .json 直接投 /parse → kind=chat, source=钉钉
  6. 同一信封投 /parse_chat → source=钉钉（records / messages 两个键都认）
  7. 不传 source → 用户上传（不替调用方猜平台）
  8. 内联标记齐全：转账金额、语音占位

零外部依赖（只用标准库 + 本地 server 模块），可直接复跑。
"""
import sys
import os
import json
import time
import base64
import uuid
import threading
import mimetypes
import urllib.request
import security_test_auth

WS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "testdata")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server  # noqa: E402

PORT = 8014
BASE = f"http://127.0.0.1:{PORT}"

srv = server.ThreadingHTTPServer(("127.0.0.1", PORT), server.Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
time.sleep(1)

results = []


def check(name, got, want):
    ok = got == want
    results.append(ok)
    print(f"[{'OK ' if ok else 'FAIL'}] {name}: 期望={want} 实际={got}")


def post_json(obj):
    req = urllib.request.Request(BASE + "/parse_chat",
                                 data=json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                                 method="POST")
    req.add_header("Content-Type", "application/json; charset=utf-8")
    return json.loads(urllib.request.urlopen(req, timeout=120).read())


def post_file(path, qs=""):
    mt = mimetypes.guess_type(path)[0] or "application/octet-stream"
    boundary = "----m%s" % uuid.uuid4().hex
    head = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
            f"filename=\"{os.path.basename(path)}\"\r\nContent-Type: {mt}\r\n\r\n").encode("utf-8")
    tail = f"\r\n--{boundary}--\r\n".encode()
    with open(path, "rb") as f:
        raw = f.read()
    req = urllib.request.Request(BASE + "/parse" + qs, data=head + raw + tail, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    return json.loads(urllib.request.urlopen(req, timeout=120).read())


# ---------- 三端输入 ----------
dt_records = json.load(open(os.path.join(WS, "synapse_input", "demo_供应商催款群.records.json"),
                            encoding="utf-8"))
fs_records = json.load(open(os.path.join(WS, "synapse_input", "demo_飞书供应商催款群.records.json"),
                            encoding="utf-8"))

PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC")
wx_png = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_tiny_mp.png")
open(wx_png, "wb").write(PNG_1PX)
wx_data_url = "data:image/png;base64," + base64.b64encode(PNG_1PX).decode()

wx_records = [
    {"seq": 1, "sender": "张三", "time": "2026-11-01 09:00:00",
     "text": "保证金已经转给你了", "type": "text", "media": "", "amount": ""},
    {"seq": 2, "sender": "张三", "time": "2026-11-01 09:01:00",
     "text": "", "type": "image", "media": wx_data_url, "amount": ""},
    {"seq": 3, "sender": "李四", "time": "2026-11-01 09:02:00",
     "text": "", "type": "voice", "media": "", "amount": ""},
    {"seq": 4, "sender": "张三", "time": "2026-11-01 09:03:00",
     "text": "已转 ¥2000 定金", "type": "transfer", "media": "", "amount": "2000"},
]

print("=== 1) 钉钉真产物 → /parse_chat(source=钉钉) ===")
dt = post_json({"records": dt_records, "name": "钉钉_供应商催款群",
                "media_dir": os.path.join(WS, "dingtalk_demo", "attachments"),
                "source": "钉钉"})["evidences"]
check("钉钉 证据条数 >1（chat + 媒体）", len(dt) > 1, True)
check("钉钉 chat 是第一条", dt[0]["kind"], "chat")
check("钉钉 chat 来源", dt[0]["source"], "钉钉")
check("钉钉 chat 含对方原话", "合作款你什么时候打" in dt[0]["content"], True)
check("钉钉 转账金额进正文", "¥2000" in dt[0]["content"], True)
check("钉钉 语音有占位标记", "语音" in dt[0]["content"], True)
check("钉钉 媒体全部继承平台", all(e["source"] == "钉钉" for e in dt), True)
kinds_dt = sorted({e["kind"] for e in dt})
print(f"     钉钉产出: {[(e['kind'], e['content'][:14]) for e in dt]}")

print("\n=== 2) 飞书真产物 → /parse_chat(source=飞书) ===")
fs = post_json({"records": fs_records, "name": "飞书_供应商催款群", "source": "飞书"})["evidences"]
check("飞书 chat 来源", fs[0]["source"], "飞书")
check("飞书 媒体全部继承平台", all(e["source"] == "飞书" for e in fs), True)
kinds_fs = sorted({e["kind"] for e in fs})

print("\n=== 3) 微信群聊（含图片）→ source=微信 ===")
wx = post_json({"records": wx_records, "name": "张三_2026-11-01", "source": "微信"})["evidences"]
check("微信 chat 来源", wx[0]["source"], "微信")
check("微信 图片是独立 image 证据", any(e["kind"] == "image" for e in wx), True)
check("微信 图片证据来源继承", [e["source"] for e in wx if e["kind"] == "image"][0], "微信")
check("微信 图片是 data URL", [e["content"][:22] for e in wx if e["kind"] == "image"][0],
      "data:image/png;base64,")
kinds_wx = sorted({e["kind"] for e in wx})

print("\n=== 4) 平台差异不进 kind（kind 只在契约四值内）===")
ALLOWED = {"text", "chat", "image", "pdf"}
check("钉钉 kind 全在契约内", set(kinds_dt) <= ALLOWED, True)
check("飞书 kind 全在契约内", set(kinds_fs) <= ALLOWED, True)
check("微信 kind 全在契约内", set(kinds_wx) <= ALLOWED, True)
check("三端 chat 都是同一 kind", [evs[0]["kind"] for evs in (dt, fs, wx)],
      ["chat", "chat", "chat"])
check("kind 里没有平台值", [k for k in (kinds_dt + kinds_fs + kinds_wx)
                            if k in ("微信", "钉钉", "飞书")], [])

print("\n=== 5) 钉钉信封 .json 直接投 /parse（用户直接提供）===")
env_path = os.path.join(WS, "synapse_input", "demo_供应商催款群.json")
ev = post_file(env_path)["evidence"]
check("信封 kind", ev["kind"], "chat")
check("信封来源", ev["source"], "钉钉")

print("\n=== 6) 同一信封投 /parse_chat ===")
env = json.load(open(env_path, encoding="utf-8"))
b = post_json(env)["evidences"]
check("信封走 bundle 来源", b[0]["source"], "钉钉")
check("信封走 bundle 条数 >1", len(b) > 1, True)

print("\n=== 7) 不传 source 不猜平台 ===")
check("裸调用默认用户上传", post_json({"records": dt_records})["evidences"][0]["source"], "用户上传")

print("\n=== 8) 手存文本：文件名不决定来源 ===")
plain = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_手存钉钉聊天.txt")
open(plain, "w", encoding="utf-8").write("张三：那笔合作款你什么时候打\n王五：下周一定")
check("文件名含钉钉但仍为 用户上传", post_file(plain)["evidence"]["source"], "用户上传")
check("?source= 显式声明才标钉钉",
      post_file(plain, "?source=%E9%92%89%E9%92%89")["evidence"]["source"], "钉钉")

print("\nRESULT:", "ALL PASS" if all(results) else f"{results.count(False)} FAILED")
sys.exit(0 if all(results) else 1)
