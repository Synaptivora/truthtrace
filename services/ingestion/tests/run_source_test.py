#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""来源（source）渠道实测：用户上传 / 微信 / 钉钉。

验证 source 的语义 = 来源渠道（不是文件格式）：
  - 本地文件上传 → 用户上传
  - /parse 上传钉钉信封 {source:"钉钉",messages:[...]} → 自动识别为 钉钉
  - /parse?source=钉钉 显式覆盖 → 优先于信封/文件名
  - /parse_chat 显式 source → 钉钉，媒体证据也继承平台
  - 不传 source → 默认 用户上传（不替调用方猜平台）
  - 钉钉适配器产出的信封 .json 可直接投 /parse_chat，source 不丢
"""
import sys, os, threading, time, json, base64, uuid, mimetypes
import urllib.request
import security_test_auth
from urllib.parse import quote

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server

WS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "testdata")
PORT = 8012
BASE = f"http://127.0.0.1:{PORT}"

srv = server.ThreadingHTTPServer(("127.0.0.1", PORT), server.Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
time.sleep(1)


def post_file(path, qs=""):
    mt = mimetypes.guess_type(path)[0] or "application/octet-stream"
    boundary = "----t%s" % uuid.uuid4().hex
    fn = os.path.basename(path)
    raw = open(path, "rb").read()
    head = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
            f"filename=\"{fn}\"\r\nContent-Type: {mt}\r\n\r\n").encode()
    tail = f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(BASE + "/parse" + qs, data=head + raw + tail, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    return json.loads(urllib.request.urlopen(req, timeout=60).read())


def post_json(obj):
    req = urllib.request.Request(BASE + "/parse_chat",
                                 data=json.dumps(obj).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    return json.loads(urllib.request.urlopen(req, timeout=60).read())


results = []


def check(name, got, want):
    ok = got == want
    results.append(ok)
    print(f"[{'OK ' if ok else 'FAIL'}] {name}: 期望={want} 实际={got}")


tmp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_src")
os.makedirs(tmp, exist_ok=True)
txt = os.path.join(tmp, "记录.txt")
open(txt, "w", encoding="utf-8").write("张三: 在吗")

from docx import Document
docx_path = os.path.join(tmp, "合同.docx")
d = Document()
d.add_paragraph("Word 正文 REFUND2026")
d.save(docx_path)

png = os.path.join(tmp, "图.png")
open(png, "wb").write(base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC"))

PNG_DATA = "data:image/png;base64," + base64.b64encode(open(png, "rb").read()).decode()
records = [
    {"seq": 1, "sender": "张三", "time": "2026-11-01 09:00:00",
     "text": "合同什么时候签", "type": "text", "media": "", "amount": ""},
    {"seq": 2, "sender": "李四", "time": "2026-11-01 09:01:00",
     "text": "", "type": "image", "media": PNG_DATA, "amount": ""},
]
ding_env = {"source": "钉钉", "conversation": "测试群", "messages": records}
dt_json = os.path.join(tmp, "钉钉聊天.json")
json.dump(ding_env, open(dt_json, "w", encoding="utf-8"), ensure_ascii=False)

check("/parse txt 来源", post_file(txt)["evidence"]["source"], "用户上传")
check("/parse docx 来源", post_file(docx_path)["evidence"]["source"], "用户上传")
check("/parse 图片 来源", post_file(png)["evidence"]["source"], "用户上传")

ev = post_file(dt_json)["evidence"]
check("/parse 钉钉信封 kind", ev["kind"], "chat")
check("/parse 钉钉信封 来源", ev["source"], "钉钉")
check("/parse 钉钉信封 含对话", "合同什么时候签" in ev["content"], True)

b = post_json({"records": records, "source": "钉钉"})
check("/parse_chat 钉钉 chat来源", b["evidences"][0]["source"], "钉钉")
check("/parse_chat 钉钉 媒体来源", b["evidences"][1]["source"], "钉钉")

check("/parse_chat 不传 source 默认用户上传",
      post_json({"records": records})["evidences"][0]["source"], "用户上传")

# 钉钉适配器产出的是信封 .json（不是裸数组），直接投 /parse_chat 也必须保住来源
check("/parse_chat 投钉钉信封", post_json(ding_env)["evidences"][0]["source"], "钉钉")

# /parse 的 ?source= 显式覆盖：手存 txt 没有信封，只能靠调用方声明
check("/parse?source=钉钉 覆盖", post_file(txt, "?source=" + quote("钉钉"))["evidence"]["source"], "钉钉")
check("/parse 无 source 参数仍为用户上传", post_file(txt)["evidence"]["source"], "用户上传")

print("\nRESULT:", "ALL PASS" if all(results) else f"{results.count(False)} FAILED")
sys.exit(0 if all(results) else 1)
