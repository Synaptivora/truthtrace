#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""kind=image 形态合法性实测。

B 的 openai-compatible.ts 对 kind=image 一律：
    { type: "image_url", image_url: { url: item.content, detail: "high" } }
即把 content 原样当图片 URL 发给视觉模型。所以 kind=image 的 content 只能是
「模型能吃的图片 data URL」。这个脚本覆盖 A 侧所有可能产出 kind=image 的入口：

  1) png  -> image + data:image/png          （正常路径）
  2) jpg  -> image + data:image/jpeg         （正常路径）
  3) bmp  -> image + data:image/png          （Pillow 转码）
  4) svg  -> text 降级                        （Pillow 打不开，绝不算 image）
  5) 扫描件 PDF -> text 说明（未装 PyMuPDF）   （绝不再发 application/pdf）
  6) 聊天里缺失的附件 -> text 占位             （绝不是 image）

任何一条产出 kind=image，其 content 都必须通过 check_image_payload。
"""
import sys, os, threading, time, json, base64, uuid, mimetypes, io
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server
from check_evidence import check_image_payload

WS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "testdata")
PORT = 8015
BASE = f"http://127.0.0.1:{PORT}"

srv = server.ThreadingHTTPServer(("127.0.0.1", PORT), server.Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
time.sleep(1)


def post_file(path):
    mt = mimetypes.guess_type(path)[0] or "application/octet-stream"
    boundary = "----t%s" % uuid.uuid4().hex
    raw = open(path, "rb").read()
    head = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
            f"filename=\"{os.path.basename(path)}\"\r\nContent-Type: {mt}\r\n\r\n").encode()
    tail = f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(BASE + "/parse", data=head + raw + tail, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    return json.loads(urllib.request.urlopen(req, timeout=60).read())["evidence"]


def post_json(obj):
    req = urllib.request.Request(BASE + "/parse_chat",
                                 data=json.dumps(obj).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    return json.loads(urllib.request.urlopen(req, timeout=60).read())


results = []


def check(name, ok, detail=""):
    results.append((name, ok))
    print(f"[{'OK ' if ok else 'FAIL'}] {name}{'' if ok else '  <-- ' + str(detail)}")


def assert_image_legal(label, ev):
    """kind=image 时必须通过视觉通道校验；kind!=image 时不应带图片 data URL。"""
    if ev["kind"] == "image":
        problem = check_image_payload(ev["content"])
        check(f"{label} 视觉通道合法", problem is None, problem)
        check(f"{label} mimeType 是图片", ev["mimeType"].startswith("image/"), ev["mimeType"])
    else:
        check(f"{label} 未硬塞 image 通道", not ev["content"].startswith("data:"), ev["content"][:60])


tmp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_img")
os.makedirs(tmp, exist_ok=True)

from PIL import Image

# 1) png
p = os.path.join(tmp, "图.png")
Image.new("RGB", (4, 4), (200, 30, 30)).save(p, format="PNG")
ev = post_file(p)
check("png kind=image", ev["kind"] == "image", ev["kind"])
check("png content 前缀", ev["content"].startswith("data:image/png;base64,"), ev["content"][:40])
assert_image_legal("png", ev)

# 2) jpg
p = os.path.join(tmp, "凭证.jpg")
Image.new("RGB", (4, 4), (30, 30, 200)).save(p, format="JPEG")
ev = post_file(p)
check("jpg kind=image", ev["kind"] == "image", ev["kind"])
assert_image_legal("jpg", ev)

# 3) bmp（模型不支持，应转码成 png）
p = os.path.join(tmp, "截图.bmp")
Image.new("RGB", (4, 4), (30, 200, 30)).save(p, format="BMP")
ev = post_file(p)
check("bmp kind=image", ev["kind"] == "image", ev["kind"])
check("bmp 已转码为 png", ev["content"].startswith("data:image/png;base64,"), ev["mimeType"])
assert_image_legal("bmp", ev)

# 4) svg（Pillow 打不开 → 必须降级 text，不能算 image）
p = os.path.join(tmp, "图标.svg")
open(p, "w", encoding="utf-8").write(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
    '<rect width="10" height="10" fill="red"/></svg>')
ev = post_file(p)
check("svg 降级为 text", ev["kind"] == "text", ev["kind"])
assert_image_legal("svg", ev)

# 5) 扫描件 PDF（无文本层）
def make_pdf(path, stream):
    objs = [b"<</Type/Catalog/Pages 2 0 R>>",
            b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
            b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R>>",
            b"<</Length %d>>\nstream\n" % len(stream) + stream + b"\nendstream"]
    out = b"%PDF-1.4\n"; offs = []
    for i, o in enumerate(objs, 1):
        offs.append(len(out)); out += b"%d 0 obj " % i + o + b" endobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for off in offs:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<</Size %d/Root 1 0 R>>\nstartxref\n%d\n%%%%EOF" % (len(objs) + 1, xref)
    open(path, "wb").write(out)


p = os.path.join(tmp, "扫描合同.pdf")
make_pdf(p, b"0.6 0.6 0.6 RG 2 w 50 50 300 120 re S")
ev = post_file(p)
try:
    import fitz  # noqa: F401
    has_fitz = True
except ImportError:
    has_fitz = False
if has_fitz:
    check("扫描件PDF 渲染成 image", ev["kind"] == "image", ev["kind"])
else:
    check("扫描件PDF 降级为 text", ev["kind"] == "text", ev["kind"])
    check("扫描件PDF 不再发 application/pdf", "application/pdf;base64" not in ev["content"], ev["content"][:60])
assert_image_legal("扫描件PDF", ev)

# 6) 聊天里缺失的附件
recs = [
    {"seq": 1, "sender": "张三", "time": "2026-11-01 09:00:00", "text": "合同发你了", "type": "text"},
    {"seq": 2, "sender": "张三", "time": "2026-11-01 09:01:00", "text": "", "type": "file",
     "media": "docs/not_exist.pdf"},
]
evs = post_json({"records": recs, "name": "测试会话"})["evidences"]
miss = [e for e in evs if "媒体文件缺失" in e["content"]]
check("缺失附件产出 1 条占位", len(miss) == 1, [e["kind"] for e in evs])
if miss:
    check("缺失附件占位 kind=text", miss[0]["kind"] == "text", miss[0]["kind"])
    assert_image_legal("缺失附件", miss[0])

# 汇总：所有 kind=image 的证据都必须合法
all_evs = [e for e in evs]
print("\n--- bundle kinds:", [e["kind"] for e in all_evs], "---")

bad = [n for n, ok in results if not ok]
print("\nRESULT:", "ALL PASS" if not bad else f"{len(bad)} FAILED -> {bad}")

import shutil
shutil.rmtree(tmp, ignore_errors=True)
sys.exit(0 if not bad else 1)
