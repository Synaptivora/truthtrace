# -*- coding: utf-8 -*-
"""量化实验：几百页 PDF 现在会发生什么？

造 300 页文本型 PDF，实测：
  1. 文件多大（会不会被 8MB 挡住）
  2. 抽出的 content 多长
  3. 估算 token / 是否超模型窗口
  4. 塞进 B 的 prompt 后总长度
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
import security_test_auth
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SERVER = os.path.join(ROOT, "server.py")
PORT = 8013
BASE = f"http://127.0.0.1:{PORT}"


def mk_multipage_pdf(path, pages, chars_per_page):
    """造一个 N 页、每页 chars_per_page 字符的文本 PDF（Helvetica，英文）。"""
    # 每页正文：把一行拆成多行以模拟真实排版
    line = "Refund dispute evidence REFUND2026 Zhang Li transfer amount 500 CNY. " * 4
    body = []
    for p in range(pages):
        lines = []
        for i in range(chars_per_page // 70 + 1):
            lines.append(line[:70])
            line = line[70:] + line[:70]
        txt = "".join(f"({ln}) Tj 0 -14 Td " for ln in lines)
        body.append(f"BT /F1 10 Tf 72 760 Td {txt} ET".encode())

    # 对象：1 catalog, 2 pages, 3 font, 之后每页 2 个对象
    objs = {}
    objs[1] = b"<</Type/Catalog/Pages 2 0 R>>"
    objs[3] = b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>"
    kids = []
    idx = 4
    for p, stream in enumerate(body):
        page_id, cont_id = idx, idx + 1
        idx += 2
        kids.append(f"{page_id} 0 R")
        objs[page_id] = (f"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]"
                         f"/Contents {cont_id} 0 R/Resources<</Font<</F1 3 0 R>>>>>>").encode()
        objs[cont_id] = b"<</Length %d>>\nstream\n" % len(stream) + stream + b"\nendstream"
    objs[2] = f"<</Type/Pages/Kids[{' '.join(kids)}]/Count {pages}>>".encode()

    out = b"%PDF-1.4\n"
    offs = {}
    for i in sorted(objs):
        offs[i] = len(out)
        out += b"%d 0 obj " % i + objs[i] + b" endobj\n"
    x = len(out)
    n = max(objs) + 1
    out += b"xref\n0 %d\n0000000000 65535 f \n" % n
    for i in range(1, n):
        out += (b"%010d 00000 n \n" % offs[i]) if i in offs else b"0000000000 65535 f \n"
    out += b"trailer\n<</Size %d/Root 1 0 R>>\nstartxref\n%d\n%%%%EOF" % (n, x)
    open(path, "wb").write(out)
    return len(out)


def post(path):
    boundary = "----b" + uuid.uuid4().hex
    raw = open(path, "rb").read()
    name = os.path.basename(path)
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\n'
            f"Content-Type: application/pdf\r\n\r\n").encode() + raw + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(f"{BASE}/parse", data=body, method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode("utf-8"))["evidence"]
    except urllib.error.HTTPError as e:
        return {"__http_error__": e.code, "body": e.read().decode("utf-8", "replace")[:200]}


def main():
    tmp = tempfile.mkdtemp(prefix="bigpdf_")
    p = os.path.join(tmp, "合同全集.pdf")
    size = mk_multipage_pdf(p, pages=300, chars_per_page=2500)
    print(f"PDF：300 页，每页约 2500 字符 → 文件 {size/1024/1024:.2f} MB")

    proc = subprocess.Popen([sys.executable, SERVER, "--port", str(PORT)],
                            cwd=ROOT,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(60):
            try:
                urllib.request.urlopen(f"{BASE}/health", timeout=1); break
            except Exception:
                time.sleep(0.1)
        t0 = time.time()
        ev = post(p)
        dt = time.time() - t0

        if "__http_error__" in ev:
            print(f"A 服务拒绝：HTTP {ev['__http_error__']}  {ev['body']}")
            print("→ 结论：大 PDF 根本进不来（8MB 限制）")
            return 0

        c = ev["content"]
        print(f"  解析耗时        ：{dt:.2f} 秒")
        print(f"  kind            ：{ev['kind']}")
        print(f"  content 字符数  ：{len(c):,}")
        print(f"  估算 token      ：约 {int(len(c)/1.6):,}（中文偏 1.5 字/token，英文约 4 字符/token）")
        print()
        print("  B 的 prompt 里这一条证据就要占约 "
              f"{int(len(c)/1.6):,} token")
        print("  gpt-4.1-mini 窗口 1,048,576 token → 单条能装下，但：")
        print("    · B 有 maxDuration=90s / timeout=90s，长 prompt 处理会超时")
        print("    · 换任意 128k 窗口的模型 → 直接 400 context_length_exceeded")
        print("    · 输入成本约 $%.2f/次（gpt-4.1-mini $0.40/1M）" % (len(c)/1.6/1_000_000*0.40))
        print()
        print("  content 开头 120 字：", c[:120].replace("\n", "\\n"))
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
    import urllib.error
    sys.exit(main())
