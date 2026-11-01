# -*- coding: utf-8 -*-
"""实测：kind=image 的判定闸门到底拦住了谁。

回答一个问题：是不是「只有真正的图片才被标成 image，其他都不算」。
逐类上传，打印 kind / mimeType / content 开头，并校验 image 的 content 是否合法图片 data URL。
"""
import io
import json
import os
import re
import sys
import base64
import subprocess
import tempfile
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SERVER = os.path.join(ROOT, "server.py")
PORT = 8011
BASE = f"http://127.0.0.1:{PORT}"

VISION = {"image/png", "image/jpeg", "image/webp", "image/gif"}
ok_all = True


def check(label, cond, detail=""):
    global ok_all
    ok_all = ok_all and bool(cond)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))


def post(field_path, field_name="file", extra=None):
    boundary = "----b" + uuid.uuid4().hex
    with open(field_path, "rb") as f:
        raw = f.read()
    name = os.path.basename(field_path)
    ctype = "application/octet-stream"
    low = name.lower()
    for ext, m in ((".png", "image/png"), (".jpg", "image/jpeg"), (".bmp", "image/bmp"),
                   (".svg", "image/svg+xml"), (".pdf", "application/pdf"),
                   (".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
                   (".txt", "text/plain"), (".json", "application/json")):
        if low.endswith(ext):
            ctype = m
            break
    parts = []
    if extra:
        for k, v in extra.items():
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="{field_name}"; filename="{name}"\r\n'
        f"Content-Type: {ctype}\r\n\r\n".encode() + raw + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)
    req = urllib.request.Request(f"{BASE}/parse", data=body, method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))["evidence"]


def is_img_url(content):
    return bool(re.match(r"^data:image/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$", content or ""))


def main():
    tmp = tempfile.mkdtemp(prefix="imggate_")
    # 造样本
    from PIL import Image
    p_png = os.path.join(tmp, "photo.png")
    Image.new("RGB", (40, 40), (200, 60, 60)).save(p_png, "PNG")
    p_jpg = os.path.join(tmp, "photo.jpg")
    Image.new("RGB", (40, 40), (60, 120, 200)).save(p_jpg, "JPEG")
    p_bmp = os.path.join(tmp, "photo.bmp")
    Image.new("RGB", (40, 40), (90, 200, 90)).save(p_bmp, "BMP")
    p_svg = os.path.join(tmp, "vec.svg")
    open(p_svg, "w", encoding="utf-8").write(
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>')

    def mk_pdf(path, stream):
        objs = [b"<</Type/Catalog/Pages 2 0 R>>", b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
                b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
                b"<</Length %d>>\nstream\n" % len(stream) + stream + b"\nendstream",
                b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>"]
        out = b"%PDF-1.4\n"
        offs = []
        for i, o in enumerate(objs, 1):
            offs.append(len(out)); out += b"%d 0 obj " % i + o + b" endobj\n"
        x = len(out)
        out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
        for o in offs:
            out += b"%010d 00000 n \n" % o
        out += b"trailer\n<</Size %d/Root 1 0 R>>\nstartxref\n%d\n%%%%EOF" % (len(objs) + 1, x)
        open(path, "wb").write(out)

    p_pdf = os.path.join(tmp, "text.pdf")
    mk_pdf(p_pdf, b"BT /F1 14 Tf 72 720 Td (Refund REFUND2026 case) Tj ET")
    p_scan = os.path.join(tmp, "scan.pdf")
    mk_pdf(p_scan, b"0.6 0.6 0.6 RG 2 w 50 50 300 120 re S")

    from docx import Document
    p_docx = os.path.join(tmp, "合同.docx")
    d = Document(); d.add_paragraph("退款纠纷 REFUND2026"); d.save(p_docx)

    p_txt = os.path.join(tmp, "记录.txt")
    open(p_txt, "w", encoding="utf-8").write("张三: 在吗\n我: 在的")

    p_chat = os.path.join(tmp, "张三.json")
    json.dump([{"seq": 1, "sender": "张三", "time": "2026-11-01 09:00:00", "text": "退款 500 什么时候到"}],
              open(p_chat, "w", encoding="utf-8"), ensure_ascii=False)

    proc = subprocess.Popen([sys.executable, SERVER, "--port", str(PORT)],
                            cwd=ROOT,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        import time
        for _ in range(50):
            try:
                urllib.request.urlopen(f"{BASE}/health", timeout=1); break
            except Exception:
                time.sleep(0.1)

        cases = [
            ("真 PNG", p_png, "image"),
            ("真 JPG", p_jpg, "image"),
            ("BMP（Pillow 转 PNG）", p_bmp, "image"),
            ("SVG（转不了）", p_svg, "text"),
            ("文本型 PDF", p_pdf, "pdf"),
            ("扫描件 PDF（渲染成图）", p_scan, "image"),
            ("Word 文档", p_docx, "text"),
            ("纯文本", p_txt, "text"),
            ("聊天 JSON", p_chat, "chat"),
        ]
        print("=" * 78)
        print(f"{'输入':<26}{'kind':<8}{'mimeType':<20}{'content 开头'}")
        print("=" * 78)
        for label, path, expect in cases:
            ev = post(path)
            head = (ev.get("content") or "")[:34].replace("\n", "\\n")
            print(f"{label:<26}{ev['kind']:<8}{(ev.get('mimeType') or '')[:18]:<20}{head}")
            if expect:
                check(f"{label} -> kind={expect}", ev["kind"] == expect, f"实际={ev['kind']}")
            if ev["kind"] == "image":
                check(f"{label} 的 content 是合法图片 data URL", is_img_url(ev["content"]),
                      (ev["content"] or "")[:40])
            else:
                check(f"{label} 非 image，content 不是图片 URL", not ev["content"].startswith("data:image"))
        print("=" * 78)
        print("ALL PASS" if ok_all else "SOME FAILED")
        return 0 if ok_all else 1
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
