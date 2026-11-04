#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""kind=chat 与 kind=text 的实质差异实测。

四组对照，看 content 到底差在哪：
  1) 聊天 JSON  -> chat ：A4 结构化成「发送者: 正文」+ 内联标记
  2) 同一份 JSON 改名 .txt -> text：原样 JSON 字符串（未经加工）
  3) 纯文本对话稿 文件名含「聊天」-> chat：content 就是原文，不做加工
  4) 同一份纯文本 文件名普通     -> text：content 也是原文
结论：3 与 4 的 content 完全一样，只有 kind 不同 —— kind 只是标签，content 才是实质。
"""
import sys, os, threading, time, json, uuid, mimetypes
import urllib.request
import security_test_auth

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server

WS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "testdata")
PORT = 8014
BASE = f"http://127.0.0.1:{PORT}"

srv = server.ThreadingHTTPServer(("127.0.0.1", PORT), server.Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
time.sleep(1)


def post(path):
    mt = mimetypes.guess_type(path)[0] or "application/octet-stream"
    boundary = "----t%s" % uuid.uuid4().hex
    raw = open(path, "rb").read()
    head = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
            f"filename=\"{os.path.basename(path)}\"\r\nContent-Type: {mt}\r\n\r\n").encode()
    tail = f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(BASE + "/parse", data=head + raw + tail, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    return json.loads(urllib.request.urlopen(req, timeout=60).read())["evidence"]


tmp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_kinddemo")
os.makedirs(tmp, exist_ok=True)

records = [
    {"seq": 1, "sender": "张三", "time": "2026-11-01 09:00:00", "text": "退款 500 什么时候到", "type": "text"},
    {"seq": 2, "sender": "我", "time": "2026-11-01 09:01:00", "text": "明天给你", "type": "text"},
    {"seq": 3, "sender": "张三", "time": "2026-11-01 09:02:00", "text": "",
     "type": "image", "media": "refund_proof.png"},
]

# 1) 聊天 JSON -> chat
p1 = os.path.join(tmp, "张三.json")
json.dump(records, open(p1, "w", encoding="utf-8"), ensure_ascii=False)

# 2) 同一份内容，改成 .txt 后缀 -> text（内容嗅探只看能否解析成聊天结构，这里仍能解析，
#    所以为展示「text 分支的原始形态」，用同样的 JSON 换一个非聊天文件名 + 让它嗅探失败）
#    最直接的对照：把 JSON 写成一整行「不像聊天记录」的形态不现实，改用下面的纯文本组做对照。
p2 = os.path.join(tmp, "张三.txt")
json.dump(records, open(p2, "w", encoding="utf-8"), ensure_ascii=False)

# 3) 纯文本对话稿，文件名含「聊天」-> chat
dialogue = "张三: 退款 500 什么时候到\n我: 明天给你\n张三: [图片]"
p3 = os.path.join(tmp, "聊天记录.txt")
open(p3, "w", encoding="utf-8").write(dialogue)

# 4) 同一份纯文本，文件名普通 -> text
p4 = os.path.join(tmp, "记录.txt")
open(p4, "w", encoding="utf-8").write(dialogue)

for label, p in [("1) 聊天JSON  张三.json", p1),
                 ("2) 同一内容  张三.txt", p2),
                 ("3) 对话稿  聊天记录.txt", p3),
                 ("4) 同一对话稿  记录.txt", p4)]:
    ev = post(p)
    print(f"\n===== {label} =====")
    print(f"  kind    = {ev['kind']}")
    print(f"  source  = {ev.get('source')}")
    print(f"  content = {ev['content']!r}")

e3, e4 = post(p3), post(p4)
print("\n[关键结论] 3) 与 4) 的 content 是否完全相同:",
      e3["content"] == e4["content"])
print("[关键结论] 3) 与 4) 的 kind 是否不同:", e3["kind"], "/", e4["kind"])

import shutil
shutil.rmtree(tmp, ignore_errors=True)
