# -*- coding: utf-8 -*-
"""验证「超过 100MB 不读内容、只回链接 + 解释」这道唯一闸门。

覆盖：
  1. 唯一阈值常量：默认 100MB，且没有第二个 20MB 上限
  2. 超过阈值 → kind=text，content 含原因与下载链接（HTTP 200，不是 413）
  3. 链接真的能下载，且字节数与原件一致
  4. 目录穿越（/files/../server.py）拿不到源码
  5. 阈值以内 → 照常解析（不误伤正常文件）

为避免造 100MB 大文件，测试用 MAX_CONTENT_SIZE=1MB 启动服务，
走的是与线上完全相同的代码路径。
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SERVER = os.path.join(ROOT, "server.py")
PORT = 8016
BASE = f"http://127.0.0.1:{PORT}"

ok_all = True


def check(label, cond, detail=""):
    global ok_all
    ok_all = ok_all and bool(cond)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"   {detail}" if detail else ""))


def mk_pdf(path, text="TruthTrace size gate test 转账 金额 500000"):
    objs = [b"<</Type/Catalog/Pages 2 0 R>>",
            b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
            b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R"
            b"/Resources<</Font<</F1 5 0 R>>>>>>",
            b"<</Length %d>>\nstream\n" % len(
                b"BT /F1 12 Tf 72 720 Td (%s) Tj ET" % text.encode()) +
            b"BT /F1 12 Tf 72 720 Td (" + text.encode() + b") Tj ET\nendstream",
            b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>"]
    out = b"%PDF-1.4\n"
    offs = []
    for i, o in enumerate(objs, 1):
        offs.append(len(out))
        out += b"%d 0 obj " % i + o + b" endobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for off in offs:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<</Size %d/Root 1 0 R>>\nstartxref\n%d\n%%%%EOF" % (len(objs) + 1, xref)
    with open(path, "wb") as f:
        f.write(out)
    return len(out)


def pad_to(path, target_bytes):
    """在 PDF 末尾补注释，凑到目标大小（服务端在解析前就按体积拦截，不影响判定）。"""
    with open(path, "rb") as f:
        data = f.read()
    if len(data) < target_bytes:
        data += b"\n%" + b"P" * (target_bytes - len(data) - 2)
    with open(path, "wb") as f:
        f.write(data)
    return len(data)


def post(path, timeout=120):
    boundary = "----wb" + uuid.uuid4().hex
    with open(path, "rb") as f:
        data = f.read()
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{os.path.basename(path)}"\r\n'
        f"Content-Type: application/octet-stream\r\n\r\n"
    ).encode() + data + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        f"{BASE}/parse", data=body, method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())["evidence"]


def get(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return r.status, r.read()


def main():
    print("=== 0) 默认阈值常量 ===")
    spec = importlib.util.spec_from_file_location("a_server_probe", SERVER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    check("唯一阈值默认 100MB", round(mod.MAX_CONTENT_SIZE_MB) == 100,
          f"{mod.MAX_CONTENT_SIZE_MB}MB")
    check("没有遗留的 20MB 解析上限", not hasattr(mod, "MAX_PARSE_SIZE"))
    check("没有遗留的 100MB 拒收常量", not hasattr(mod, "MAX_FILE_SIZE"))

    tmp = tempfile.mkdtemp(prefix="sizegate_")
    p_small = os.path.join(tmp, "small.pdf")
    mk_pdf(p_small)

    p_big = os.path.join(tmp, "合同扫描件.pdf")
    mk_pdf(p_big)
    big_size = pad_to(p_big, 1_500_000)

    p_big_docx = os.path.join(tmp, "年报.docx")
    mk_pdf(p_big_docx)
    pad_to(p_big_docx, 1_400_000)

    p_huge = os.path.join(tmp, "超大附件.pdf")
    mk_pdf(p_huge)
    pad_to(p_huge, 2_400_000)

    env = dict(os.environ, MAX_CONTENT_SIZE=str(1024 * 1024),
               UPLOAD_DIR=os.path.join(tmp, "_uploads"))
    proc = subprocess.Popen([sys.executable, SERVER, "--port", str(PORT)],
                            cwd=ROOT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(80):
            try:
                urllib.request.urlopen(f"{BASE}/health", timeout=1)
                break
            except Exception:
                time.sleep(0.1)

        print("\n=== 1) 超过阈值的 PDF → 不读内容，只回链接 + 解释 ===")
        t0 = time.time()
        ev = post(p_big)
        dt = time.time() - t0
        c = ev["content"]
        print(f"  {big_size:,} 字节 → {dt:.2f}s，kind={ev['kind']}")
        check("kind=text（不走 pdf 通道）", ev["kind"] == "text")
        check("标注「未解析」", "未解析" in c)
        check("写出文件大小", f"{big_size / 1024 / 1024:.1f} MB" in c, c.split("\n")[0][:60])
        check("写出原因（超过单份附件上限）", "超过单份附件上限" in c)
        check("含下载链接", "下载链接：http://" in c)
        check("提示不要猜测内容", "不要猜测" in c)
        check("name 保留原文件名", ev["name"] == "合同扫描件.pdf", ev["name"])
        check("响应很快（未解析）", dt < 3, f"{dt:.2f}s")

        print("\n=== 2) 链接可下载且内容一致 ===")
        link = [l.split("下载链接：", 1)[1] for l in c.split("\n") if "下载链接：" in l][0].strip()
        check("链接是纯 ASCII（模型可直接转述）", all(ord(ch) < 128 for ch in link), link)
        st, body = get(link)
        check("HTTP 200", st == 200, str(st))
        check("字节数与原件一致", len(body) == big_size, f"{len(body):,} vs {big_size:,}")

        print("\n=== 3) 目录穿越防护 ===")
        for evil in ("../server.py", "..%2Fserver.py", "....//server.py"):
            try:
                st, body = get(f"{BASE}/files/{evil}")
                check(f"拒绝 {evil}", st != 200 or b"def do_POST" not in body, f"status={st}")
            except urllib.error.HTTPError as e:
                check(f"拒绝 {evil}", e.code == 404, f"status={e.code}")

        print("\n=== 4) 各种文档类型一视同仁（docx 也走同一道闸门）===")
        ev = post(p_big_docx)
        check("docx 超限同样不解析", ev["kind"] == "text" and "未解析" in ev["content"])
        check("docx 也带链接", "下载链接：http://" in ev["content"])

        print("\n=== 5) 远超阈值也是 200 + 链接（全程没有 413）===")
        try:
            ev = post(p_huge)
            check("HTTP 200，不拒收", True, f"kind={ev['kind']}")
            check("仍然给链接", "下载链接：http://" in ev["content"])
            check("仍然说清超限", "超过单份附件上限" in ev["content"])
        except urllib.error.HTTPError as e:
            check("HTTP 200，不拒收", False, f"status={e.code}")

        print("\n=== 6) 阈值以内照常解析（不误伤）===")
        ev = post(p_small)
        check("小 PDF 仍是 kind=pdf", ev["kind"] == "pdf", ev["kind"])
        check("小 PDF 抽到了正文", "500000" in ev["content"], ev["content"][:40])
        check("小 PDF 没有链接字样", "下载链接" not in ev["content"])
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()

    print()
    if ok_all:
        print("ALL PASS —— 超限只回链接与解释、不拒收；阈值内照常解析")
    else:
        print("SOME CHECKS FAILED")
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())
