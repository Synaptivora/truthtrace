#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""A4/A6 媒体感知 就地实测（同进程起服务，避免后台进程被回收）。"""
import sys, os, threading, time, json, base64, uuid
import urllib.request, urllib.error
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server

WS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "testdata")
PORT = 8011
BASE = f"http://127.0.0.1:{PORT}"

srv = server.ThreadingHTTPServer(("127.0.0.1", PORT), server.Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
time.sleep(1)


def post_file(url, path):
    mt = __import__("mimetypes").guess_type(path)[0] or "application/octet-stream"
    boundary = "----testb%s" % uuid.uuid4().hex
    fn = path.replace("\\", "/").split("/")[-1]
    with open(path, "rb") as f:
        raw = f.read()
    head = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
            f"filename=\"{fn}\"\r\nContent-Type: {mt}\r\n\r\n").encode()
    tail = f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(url, data=head + raw + tail, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    return json.loads(urllib.request.urlopen(req, timeout=60).read())


def post_json(url, obj):
    data = json.dumps(obj).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    return json.loads(urllib.request.urlopen(req, timeout=60).read())


results = []
def check(name, cond, extra=""):
    results.append(cond)
    print(f"[{'OK ' if cond else 'FAIL'}] {name}  {extra}")


RAW = f"{WS}/wechat_sample/raw_sample.txt"
CHAT = f"{os.path.dirname(os.path.abspath(__file__))}/chat_sample.json"
TINY = f"{os.path.dirname(os.path.abspath(__file__))}/_tiny.png"
with open(TINY, "wb") as f:
    f.write(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC"))

# 1) 文本回归
r = post_file(f"{BASE}/parse", RAW)
check("A1 文本 kind=text", r["evidence"]["kind"] == "text", r["evidence"]["kind"])

# 2) 图片回归
r = post_file(f"{BASE}/parse", TINY)
check("A2 图片 kind=image", r["evidence"]["kind"] == "image", r["evidence"]["kind"])

# 3) 聊天单条 (/parse 上传 chat_sample.json) —— 应含内联标记
r = post_file(f"{BASE}/parse", CHAT)
ev = r["evidence"]
c = ev["content"]
check("A4 /parse 聊天 kind=chat", ev["kind"] == "chat", ev["kind"])
check("  含 [图片@ 标记", "[图片@" in c)
check("  含 [文件: 标记", "[文件:" in c)
check("  含 [转账 ¥500@ 标记", "¥500" in c and "[转账" in c)
check("  含 [语音@ 标记", "[语音@" in c)
print("  --- chat 文本前 240 字 ---")
print("  " + c[:240].replace("\n", "\n  "))

# 4) /parse_chat bundle —— chat + 独立 image(截图) + 独立 text(文件缺失占位)
recs = json.load(open(CHAT, encoding="utf-8"))
b = post_json(f"{BASE}/parse_chat", {"records": recs, "name": "张三_2026-03-22"})
evs = b["evidences"]
kinds = [e["kind"] for e in evs]
check("A4/A6 bundle 共 3 条", len(evs) == 3, f"len={len(evs)}")
check("  bundle[0]=chat", evs[0]["kind"] == "chat")
check("  bundle[1]=image(截图dataURL)", evs[1]["kind"] == "image" and evs[1]["content"].startswith("data:image"))
# 占位必须是 text：kind=image 的 content 会被 B 当 image_url 发给视觉模型，
# 发一段中文占位文本必然被拒 → 整个 analyze 502。
check("  bundle[2]=text(文件缺失占位)", evs[2]["kind"] == "text" and evs[2]["content"].startswith("[媒体文件缺失"))
print("  --- bundle kinds:", kinds, "---")

# 5) 纯文本对话稿兼容（raw_sample.txt 当 chat 名上传）
#    先验证 build_chat_from_text 对纯文本直接返回文本
plain = server.build_chat_from_text("chat.txt", "[14:00] 张三: 你好\n[14:01] 我: 你好".encode())
check("纯文本对话稿兼容", "张三: 你好" in plain)

print("\nRESULT:", "ALL PASS" if all(results) else f"{results.count(False)} FAILED")
sys.exit(0 if all(results) else 1)
