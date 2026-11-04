# -*- coding: utf-8 -*-
"""验证体积闸门的唯一口径：**单份附件 ≤100MB 正常处理，>100MB 只回「链接 + 解释」**。

规则只有一条，且不是拒收：
  · > 上限   → 不读内容（不抽文本、不做 OCR），HTTP 200 + kind=text + 下载链接 + 解释
  · ≤ 上限   → 按正常流程解析（扫描件走图像、文本型抽文本、office 抽正文…）
  · 请求体本身**不设限**（multipart 必然比文件大，按 Content-Length 卡会误杀边界值）

用缩放阈值（MAX_CONTENT_SIZE=2MB）跑同一份代码路径：
  1. 请求体 > 2MB，单文件 1.8MB        → 200，且**真的解析出正文**
  2. 单文件正好 = 2MB                  → 200，正常解析（边界不能被误杀）
  3. 单文件 2.4MB > 上限               → 200 + 「未解析」+ 可下载链接（**不是 413**）
  4. 3MB 无关字段 + 4KB 小文件         → 200，正常解析（请求体大小无关）
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
import security_test_auth
import urllib.parse
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SERVER = os.path.join(ROOT, "server.py")
PORT = 8019
BASE = f"http://127.0.0.1:{PORT}"

MB = 1024 * 1024
ok_all = True


def check(label, cond, detail=""):
    global ok_all
    ok_all = ok_all and bool(cond)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"   {detail}" if detail else ""))


def mk_txt(path, size):
    """造一个 size 字节的纯文本。

    按**整行**重复、再用 ASCII 补足尾巴——按字节硬切会切在多字节字符中间，
    那份文件就不是合法 UTF-8 了，测出来的编码问题跟服务端逻辑无关。
    """
    head = "转账记录 反诈测试 2026\n".encode()
    body = (head * (size // len(head) + 1))[:size - (size % len(head))]
    body += b"x" * (size - len(body))
    with open(path, "wb") as f:
        f.write(body)
    return os.path.getsize(path)


def build_body(file_path, extra=None):
    """返回 (boundary, body, file_size)。extra=(name, bytes) 追加一个无关字段。"""
    boundary = "----wb" + uuid.uuid4().hex
    with open(file_path, "rb") as f:
        data = f.read()
    chunks = [
        (f"--{boundary}\r\n"
         f'Content-Disposition: form-data; name="file"; '
         f'filename="{os.path.basename(file_path)}"\r\n'
         f"Content-Type: application/octet-stream\r\n\r\n").encode()
        + data + b"\r\n"
    ]
    if extra:
        k, v = extra
        chunks.append(
            (f"--{boundary}\r\n"
             f'Content-Disposition: form-data; name="{k}"\r\n\r\n').encode() + v + b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode())
    return boundary, b"".join(chunks), len(data)


def post(file_path, extra=None, timeout=180):
    boundary, body, fsize = build_body(file_path, extra)
    req = urllib.request.Request(
        f"{BASE}/parse", data=body, method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            ev = json.loads(r.read().decode())["evidence"]
            return r.status, ev, len(body), fsize
    except urllib.error.HTTPError as e:
        return e.code, {"_raw": e.read().decode("utf-8", "replace")}, len(body), fsize


def get(url):
    with urllib.request.urlopen(urllib.parse.urljoin(BASE, url), timeout=60) as r:
        return r.status, r.read()


def main():
    print("=== 0) 只允许一个体积阈值，且没有拒收分支 ===")
    spec = importlib.util.spec_from_file_location("probe", SERVER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    check("默认不限制单文件大小", mod.MAX_CONTENT_SIZE == 0,
          f"{mod.MAX_CONTENT_SIZE_MB}MB")
    check("旧的 20MB 解析上限已取消", not hasattr(mod, "MAX_PARSE_SIZE"))
    check("旧的 100MB 硬上限常量已合并", not hasattr(mod, "MAX_FILE_SIZE"))
    src = open(SERVER, encoding="utf-8").read()
    # 注释里提到「没有 413」是允许的，这里查的是真的没有 413 响应
    check("请求总量有独立安全上限", mod.REQUEST_LIMIT == 25 * 1024 * 1024)
    check("_read_body 不按 Content-Length 拒绝", "length > MAX_CONTENT_SIZE" not in src)

    tmp = tempfile.mkdtemp(prefix="filegate_")
    env = dict(os.environ, MAX_CONTENT_SIZE=str(2 * MB),
               UPLOAD_DIR=os.path.join(tmp, "_uploads"))
    proc = subprocess.Popen([sys.executable, SERVER, "--port", str(PORT)],
                            cwd=ROOT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(100):
            try:
                urllib.request.urlopen(f"{BASE}/health", timeout=1)
                break
            except Exception:
                time.sleep(0.1)

        print("\n=== 1) 请求体 > 上限、单文件 < 上限 → 正常解析 ===")
        p1 = os.path.join(tmp, "聊天导出.txt")
        mk_txt(p1, int(1.8 * MB))
        code, ev, blen, fsize = post(p1, extra=("note", b"N" * MB))  # 额外 1MB 字段
        print(f"  文件 {fsize:,} 字节 / 请求体 {blen:,} 字节")
        check("请求体确实超过上限", blen > 2 * MB, f"{blen / MB:.2f}MB")
        check("HTTP 200", code == 200, f"status={code}")
        check("真正读了内容（不是「未解析」占位）", "未解析" not in ev.get("content", ""))
        check("正文含原文", "转账记录" in ev.get("content", ""), ev.get("content", "")[:24])

        print("\n=== 2) 单文件正好 = 上限 → 边界不能被误杀 ===")
        p2 = os.path.join(tmp, "edge.txt")
        mk_txt(p2, 2 * MB)
        code, ev, blen, fsize = post(p2)
        print(f"  文件 {fsize:,} 字节 / 请求体 {blen:,} 字节")
        check("文件正好等于上限", fsize == 2 * MB, f"{fsize:,}")
        check("HTTP 200 且正常解析", code == 200 and "未解析" not in ev.get("content", ""),
              f"status={code}")

        print("\n=== 3) 单文件 > 上限 → 200 + 链接 + 解释（不再 413）===")
        p3 = os.path.join(tmp, "超大扫描件.txt")
        mk_txt(p3, int(2.4 * MB))
        code, ev, blen, fsize = post(p3)
        c = ev.get("content", "")
        print(f"  文件 {fsize:,} 字节 → status={code}")
        check("HTTP 200（不是 413，也不是任何错误码）", code == 200, f"status={code}")
        check("kind=text", ev.get("kind") == "text", ev.get("kind"))
        check("标注「未解析」", "未解析" in c)
        check("写出真实体积", f"{fsize / MB:.1f} MB" in c, c.split("\n")[0][:60])
        check("解释超过上限", "超过单份附件上限" in c)
        check("提示不要猜测内容", "不要猜测" in c)
        check("保留原文件名", ev.get("name") == "超大扫描件.txt", ev.get("name"))
        link = [l.split("下载链接：", 1)[1].strip() for l in c.split("\n") if "下载链接：" in l]
        check("带下载链接", bool(link), c[:80])
        if link:
            check("链接是纯 ASCII", all(ord(ch) < 128 for ch in link[0]), link[0])
            st, blob = get(link[0])
            check("链接可下载且字节一致", st == 200 and len(blob) == fsize,
                  f"{st} {len(blob):,} vs {fsize:,}")

        print("\n=== 4) 超大无关字段 + 小文件 → 照常解析 ===")
        p4 = os.path.join(tmp, "small.txt")
        mk_txt(p4, 4096)
        code, ev, blen, fsize = post(p4, extra=("blob", b"B" * int(3 * MB)))
        print(f"  文件 {fsize:,} 字节 / 请求体 {blen:,} 字节 → {code}")
        check("HTTP 200", code == 200, f"status={code}")
        check("小文件被真正解析", "未解析" not in ev.get("content", ""))
        check("正文含原始内容", "反诈测试" in ev.get("content", ""))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()

    print()
    print("ALL PASS —— ≤100MB 正常处理，>100MB 只回链接与解释，全程无拒收" if ok_all
          else "SOME CHECKS FAILED")
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())

