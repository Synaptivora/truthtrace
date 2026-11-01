#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""kind 类型路由实测：验证三平台聊天都能被正确判成 chat，且普通 JSON 不被误判。

重点回归的真实 bug：
  钉钉/飞书适配器产物是 <会话名>.json / <会话名>.records.json，
  文件名里没有「聊天/微信/message」等关键词，
  旧逻辑会把它们判成 kind=text（聊天记录变成一坨 JSON 原文丢给 B）。
"""
import sys, os, threading, time, json, base64, uuid, mimetypes
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server

WS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "testdata")
PORT = 8013
BASE = f"http://127.0.0.1:{PORT}"

srv = server.ThreadingHTTPServer(("127.0.0.1", PORT), server.Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
time.sleep(1)


def post_file(path):
    mt = mimetypes.guess_type(path)[0] or "application/octet-stream"
    boundary = "----t%s" % uuid.uuid4().hex
    fn = os.path.basename(path)
    raw = open(path, "rb").read()
    head = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
            f"filename=\"{fn}\"\r\nContent-Type: {mt}\r\n\r\n").encode()
    tail = f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(BASE + "/parse", data=head + raw + tail, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    return json.loads(urllib.request.urlopen(req, timeout=60).read())["evidence"]


results = []


def check(name, got, want):
    ok = got == want
    results.append((name, ok))
    print(f"[{'OK ' if ok else 'FAIL'}] {name}\n        期望={want!r} 实际={got!r}")


tmp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_kind")
os.makedirs(tmp, exist_ok=True)

records = [
    {"seq": 1, "sender": "张三", "time": "2026-11-01 09:00:00",
     "text": "退款什么时候到", "type": "text"},
    {"seq": 2, "sender": "李四", "time": "2026-11-01 09:01:00",
     "text": "明天", "type": "text"},
]

# --- 1. 钉钉裸数组，文件名是纯会话名（最危险的形态）---
p = os.path.join(tmp, "张三.json")
json.dump(records, open(p, "w", encoding="utf-8"), ensure_ascii=False)
ev = post_file(p)
check("钉钉 张三.json（裸数组）kind", ev["kind"], "chat")
check("钉钉 张三.json 含对话正文", "退款什么时候到" in ev["content"], True)

# --- 2. 钉钉 .records.json 后缀 ---
p = os.path.join(tmp, "项目群.records.json")
json.dump(records, open(p, "w", encoding="utf-8"), ensure_ascii=False)
check("钉钉 项目群.records.json kind", post_file(p)["kind"], "chat")

# --- 3. 钉钉信封 {source, messages} ---
p = os.path.join(tmp, "催收群.json")
json.dump({"source": "钉钉", "conversation": "催收群", "messages": records},
          open(p, "w", encoding="utf-8"), ensure_ascii=False)
ev = post_file(p)
check("钉钉信封 kind", ev["kind"], "chat")
check("钉钉信封 source", ev["source"], "钉钉")

# --- 4. 飞书裸数组（文件名无人话关键词）---
p = os.path.join(tmp, "任务组.json")
json.dump(records, open(p, "w", encoding="utf-8"), ensure_ascii=False)
check("飞书 任务组.json kind", post_file(p)["kind"], "chat")

# --- 5. 普通配置 JSON 不能被误判成 chat ---
p = os.path.join(tmp, "config.json")
json.dump({"name": "truthtrace", "threshold": 500,
           "items": [{"content": "a"}, {"content": "b"}]},
          open(p, "w", encoding="utf-8"), ensure_ascii=False)
check("普通 config.json 不误判", post_file(p)["kind"], "text")

# --- 6. 数据 JSON（数组但无 sender）不能被误判 ---
p = os.path.join(tmp, "交易明细.json")
json.dump([{"date": "2026-03-22", "amount": 500}, {"date": "2026-03-23", "amount": 1200}],
          open(p, "w", encoding="utf-8"), ensure_ascii=False)
check("交易明细.json 不误判", post_file(p)["kind"], "text")

# --- 7. 纯文本/图片仍走原通道 ---
p = os.path.join(tmp, "记录.txt")
open(p, "w", encoding="utf-8").write("张三: 在吗")
check("纯文本 记录.txt kind", post_file(p)["kind"], "text")

p = os.path.join(tmp, "图.png")
open(p, "wb").write(base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC"))
check("图片 kind", post_file(p)["kind"], "image")

# --- 8. 文件名含「聊天」的纯文本稿保持 chat（历史行为）---
p = os.path.join(tmp, "聊天记录.txt")
open(p, "w", encoding="utf-8").write("张三: 在吗\n我: 在的")
check("聊天记录.txt kind", post_file(p)["kind"], "chat")

bad = [n for n, ok in results if not ok]
print("\nRESULT:", "ALL PASS" if not bad else f"{len(bad)} FAILED -> {bad}")
sys.exit(0 if not bad else 1)
