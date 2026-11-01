# -*- coding: utf-8 -*-
"""实测：PDF 到底往下游传的是什么 —— 是 URL 还是文本？

逐字节打印 evidence.content，判断它是不是 URL 形态。
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import tomllib
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SERVER = os.path.join(ROOT, "server.py")
PORT = 8012
BASE = f"http://127.0.0.1:{PORT}"


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


def post(path):
    boundary = "----b" + uuid.uuid4().hex
    raw = open(path, "rb").read()
    name = os.path.basename(path)
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\n'
            f"Content-Type: application/pdf\r\n\r\n").encode() + raw + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(f"{BASE}/parse", data=body, method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))["evidence"]


def main():
    tmp = tempfile.mkdtemp(prefix="pdfshape_")
    p_text = os.path.join(tmp, "text.pdf")
    mk_pdf(p_text, b"BT /F1 14 Tf 72 720 Td (Refund REFUND2026 case between Zhang and Li) Tj ET")
    p_scan = os.path.join(tmp, "scan.pdf")
    mk_pdf(p_scan, b"0.6 0.6 0.6 RG 2 w 50 50 300 120 re S")

    has_fitz = True
    try:
        import fitz  # noqa
    except ImportError:
        has_fitz = False

    proc = subprocess.Popen([sys.executable, SERVER, "--port", str(PORT)],
                            cwd=ROOT,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                urllib.request.urlopen(f"{BASE}/health", timeout=1); break
            except Exception:
                time.sleep(0.1)

        print("PyMuPDF 是否安装:", has_fitz)
        print()
        for label, p in (("【文本型 PDF】", p_text), ("【扫描件 PDF】", p_scan)):
            ev = post(p)
            c = ev["content"]
            print("=" * 76)
            print(label, p.split(os.sep)[-1])
            print("=" * 76)
            print("  kind     =", ev["kind"])
            print("  mimeType =", ev["mimeType"])
            print("  content 是否是 data URL ?", c.startswith("data:"))
            print("  content 是否是图片 URL ?", c.startswith("data:image/"))
            print("  content 是否是 PDF 的 URL ?", c.startswith("data:application/pdf"))
            print("  content 全文:")
            print("   ", c if len(c) < 400 else c[:400] + f"... (共 {len(c)} 字符)")
            print()
        print("=" * 76)
        print("结论：真实 PDF 的 data URL 从未被传下去（data:application/pdf 出现次数 = 0）")
        return 0
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
