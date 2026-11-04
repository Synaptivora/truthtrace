# -*- coding: utf-8 -*-
"""验证大 PDF 的预算裁剪（A3 增强）。

覆盖：
  1. 小 PDF 原样透传（不裁剪、不加页标记）—— 保证老行为不变
  2. 300 页 PDF 裁到预算内，且含截断说明
  3. 关键页优先：藏着金额/卡号的那页必须被留下
  4. 首页、末页必留
  5. ?pages=100-120 只看指定范围
  6. ?max_chars=2000 自定义预算
  7. 保留下来的内容必须是原文子串（未改写 → B 的逐字引用校验仍成立）
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import security_test_auth
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SERVER = os.path.join(ROOT, "server.py")
PORT = 8014
BASE = f"http://127.0.0.1:{PORT}"

ok_all = True


def check(label, cond, detail=""):
    global ok_all
    ok_all = ok_all and bool(cond)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"   {detail}" if detail else ""))


def mk_multipage_pdf(path, page_texts):
    """page_texts: list[str]，每项一页正文。"""
    objs = {1: b"<</Type/Catalog/Pages 2 0 R>>",
            3: b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>"}
    kids = []
    idx = 4
    for text in page_texts:
        stream = f"BT /F1 10 Tf 72 760 Td ({text}) Tj ET".encode()
        pid, cid = idx, idx + 1
        idx += 2
        kids.append(f"{pid} 0 R")
        objs[pid] = (f"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]"
                     f"/Contents {cid} 0 R/Resources<</Font<</F1 3 0 R>>>>>>").encode()
        objs[cid] = b"<</Length %d>>\nstream\n" % len(stream) + stream + b"\nendstream"
    objs[2] = f"<</Type/Pages/Kids[{' '.join(kids)}]/Count {len(page_texts)}>>".encode()

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


def post(path, query=""):
    boundary = "----b" + uuid.uuid4().hex
    raw = open(path, "rb").read()
    name = os.path.basename(path)
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\n'
            f"Content-Type: application/pdf\r\n\r\n").encode() + raw + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(f"{BASE}/parse{query}", data=body, method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(r.read().decode("utf-8"))["evidence"]
    except urllib.error.HTTPError as e:
        return {"__err__": e.code, "body": e.read().decode("utf-8", "replace")[:200]}


def main():
    tmp = tempfile.mkdtemp(prefix="pdfbudget_")

    # 小 PDF：3 页，短文本
    small_pages = ["Page one: refund 500 CNY", "Page two: agreement signed", "Page three: 2026-03-22"]
    p_small = os.path.join(tmp, "small.pdf")
    mk_multipage_pdf(p_small, small_pages)

    # 大 PDF：300 页，每页约 2500 字符；第 40/150/260 页藏关键物证
    filler = ("普通条款内容 filler text for contract body. " * 60)[:2400]
    big_pages = []
    for i in range(1, 301):
        if i == 1:
            big_pages.append("COVER PAGE first page 甲方 Zhang 乙方 Li")
        elif i == 300:
            big_pages.append("LAST PAGE signature date 2026-03-22 盖章")
        elif i in (40, 150, 260):
            big_pages.append(f"KEY PAGE {i} 转账金额 500000 元 卡号 6222021234567890123 诈骗 MARK{i}X")
        else:
            big_pages.append(f"[p{i}] {filler}")
    p_big = os.path.join(tmp, "big.pdf")
    mk_multipage_pdf(p_big, big_pages)

    proc = subprocess.Popen([sys.executable, SERVER, "--port", str(PORT)],
                            cwd=ROOT,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(60):
            try:
                urllib.request.urlopen(f"{BASE}/health", timeout=1); break
            except Exception:
                time.sleep(0.1)

        print("=== 1) 小 PDF 原样透传（老行为不变）===")
        ev = post(p_small)
        check("kind=pdf", ev["kind"] == "pdf")
        check("无截断说明", "内容已裁剪" not in ev["content"])
        check("无页标记", "--- 第 1 页 ---" not in ev["content"])
        check("三页全文都在", all(s in ev["content"] for s in small_pages),
              f"len={len(ev['content'])}")
        check("name 未被加后缀", "保留" not in ev["name"], ev["name"])

        print("\n=== 2) 300 页 PDF 默认预算（30000 字符）===")
        t0 = time.time()
        ev = post(p_big)
        dt = time.time() - t0
        c = ev["content"]
        print(f"  原文档 300 页 / 构造正文约 {sum(len(x) for x in big_pages):,} 字符 "
              f"→ content {len(c):,} 字符，耗时 {dt:.2f}s")
        check("content 不超预算（含说明）", len(c) <= 32000, f"实际 {len(c)}")
        check("预算利用率 > 80%", len(c) >= 24000, f"实际 {len(c)}（{len(c)/30000:.0%}）")
        check("含截断说明", "内容已裁剪" in c)
        check("说明写明原页数", "300 页" in c, c[c.find("[内容已裁剪"):][:52])
        check("name 标注保留页数", "保留" in ev["name"], ev["name"])

        print("\n=== 3) 关键页必须留下 ===")
        for mark in ("MARK40X", "MARK150X", "MARK260X"):
            check(f"第 {mark[4:-1]} 页的关键物证被保留", mark in c)
        check("首页被保留", "COVER PAGE" in c)
        check("末页被保留（签字/日期）", "LAST PAGE" in c)

        print("\n=== 4) 保留内容必须是原文子串（A 未改写抽取结果）===")
        from pypdf import PdfReader
        reader = PdfReader(p_big)
        extracted_pages = [(p.extract_text() or "") for p in reader.pages]
        extracted_all = "\n".join(extracted_pages)
        m = re.search(r"KEY PAGE 150[^\n]*", c)
        check("找到第150页原文行", bool(m))
        if m:
            check("该行能在抽取原文中逐字定位", m.group(0) in extracted_pages[149])
        cover_line = re.search(r"COVER PAGE[^\n]*", c)
        check("首页原文能在抽取文本中定位",
              bool(cover_line) and cover_line.group(0) in extracted_pages[0],
              (cover_line.group(0)[:40] if cover_line else ""))
        blocks = re.findall(r"--- 第 \d+ 页 ---\n(.*?)(?=\n\n--- 第 |\n\n\[内容已裁剪)", c, re.S)
        blocks = [b.strip() for b in blocks if b.strip()]
        check("能切出多个页块", len(blocks) >= 5, f"{len(blocks)} 块")
        bad = [b[:40] for b in blocks if b not in extracted_all]
        check("每个页块都能在抽取原文中逐字定位（无凭空生成）", not bad, str(bad[:2]))

        print("\n=== 5) ?pages=100-120 指定范围 ===")
        ev = post(p_big, "?pages=100-120")
        c = ev["content"]
        nums = sorted({int(x) for x in re.findall(r"--- 第 (\d+) 页 ---", c)})
        print(f"  选中页: {nums}")
        check("只在 100-120 范围内", nums and all(100 <= n <= 120 for n in nums), str(nums))
        check("按顺序连续取（不跳页）", nums == list(range(nums[0], nums[0] + len(nums))) if nums else False,
              str(nums))
        check("不含范围外的第40页关键页", "MARK40X" not in c)

        print("\n=== 6) ?max_chars=2000 预算小于单页（兜底不能为空）===")
        ev = post(p_big, "?max_chars=2000")
        c = ev["content"]
        check("content 非空且有内容", len(c.strip()) > 50, f"实际 {len(c)}")
        check("content 压到 2000 量级", len(c) <= 2400, f"实际 {len(c)}")
        check("含截断说明", "内容已裁剪" in c)
        check("单页也被截断时有明确标注", "已截断" in c or "保留" in c)

        print("\n=== 7) 非法参数 ===")
        ev = post(p_big, "?max_chars=abc")
        check("max_chars 非整数返回 400", ev.get("__err__") == 400, str(ev)[:120])

        print("\n" + ("ALL PASS" if ok_all else "SOME FAILED"))
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
