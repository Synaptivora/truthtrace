# -*- coding: utf-8 -*-
"""验证文本类（Word / Excel / 纯文本 / 聊天）的预算裁剪。

背景：PDF 有页边界可整页取舍，但 Word/Excel 抽出来是一大串行，
几十万字符同样会击穿 B 的上下文窗口（B 对 content 长度零限制）。

覆盖：
  1. 小文档原样透传（老行为不变，不加任何标记）
  2. 大 docx 裁到预算内，含省略标记与截断说明，name 标注保留行数
  3. 关键行优先：藏着金额/卡号的那段必须留下
  4. 开头、结尾必留
  5. 大 xlsx 裁剪，且 # Sheet: 标题行必留
  6. 大纯文本 / 大聊天记录同样受预算约束
  7. ?max_chars= 自定义预算生效
  8. 保留内容逐字来自原文（未改写 → B 的引用校验仍成立）
  9. 预算比单行还小 → 不返回空 content
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
PORT = 8015
BASE = f"http://127.0.0.1:{PORT}"

ok_all = True


def check(label, cond, detail=""):
    global ok_all
    ok_all = ok_all and bool(cond)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"   {detail}" if detail else ""))


def post(path, query="", field="file"):
    url = f"{BASE}/parse{query}"
    boundary = "----wb" + uuid.uuid4().hex
    filename = os.path.basename(path)
    with open(path, "rb") as f:
        data = f.read()
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'
        f"Content-Type: application/octet-stream\r\n\r\n"
    ).encode() + data + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode())["evidence"]


def marker_lines(content):
    """去掉 A 自己加的标记行，剩下的都是原文行。"""
    out = []
    for line in content.split("\n"):
        s = line.strip()
        if s.startswith("[…… 已省略") or s.startswith("[内容已裁剪"):
            continue
        out.append(line)
    return out


def main():
    tmp = tempfile.mkdtemp(prefix="textbudget_")

    # ---------- 构造样本 ----------
    from docx import Document

    def make_docx(path, paras):
        d = Document()
        for p in paras:
            d.add_paragraph(p)
        d.save(path)

    plain = ["普通条款内容 filler paragraph for contract body. " * 3 for _ in range(3)]
    p_small = os.path.join(tmp, "small.docx")
    make_docx(p_small, plain)

    filler = "普通条款内容 filler paragraph for contract body. " * 3
    big_paras = []
    for i in range(1, 6001):
        if i == 1:
            big_paras.append("COVER 合同正文 甲方 Zhang 乙方 Li 编号 HT-2026-001")
        elif i == 6000:
            big_paras.append("LAST 落款 签字 盖章 日期 2026-03-22")
        elif i in (1200, 3800, 5200):
            big_paras.append(f"KEY ROW {i} 转账金额 500000 元 卡号 6222021234567890123 诈骗 MARK{i}X")
        else:
            big_paras.append(f"[p{i}] {filler}")
    p_big = os.path.join(tmp, "big.docx")
    make_docx(p_big, big_paras)

    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "交易明细"
    ws.append(["日期", "金额", "对方", "备注"])
    for i in range(1, 6001):
        if i == 3000:
            ws.append(["2026-03-22", 500000, "李四", f"KEYCELL{i}X 转账 诈骗"])
        else:
            ws.append([f"2026-03-{(i % 28) + 1:02d}", i, "某人", "普通货款记录"])
    p_xlsx = os.path.join(tmp, "big.xlsx")
    wb.save(p_xlsx)

    p_txt = os.path.join(tmp, "big.txt")
    with open(p_txt, "w", encoding="utf-8") as f:
        f.write("\n".join(f"第 {i} 行：普通说明文字 filler line {i}" for i in range(1, 20001)))

    msgs = [{"seq": i,
             "sender": "张三" if i % 2 else "我",
             "time": f"2026-03-22 {(i // 60) % 24:02d}:{i % 60:02d}:00",
             "text": (f"第 {i} 条：退款 500 元什么时候到账" if i == 2500 else f"第 {i} 条：普通聊天内容")}
            for i in range(1, 3001)]
    p_chat = os.path.join(tmp, "张三.json")
    with open(p_chat, "w", encoding="utf-8") as f:
        json.dump(msgs, f, ensure_ascii=False)

    proc = subprocess.Popen([sys.executable, SERVER, "--port", str(PORT)],
                            cwd=ROOT,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(80):
            try:
                urllib.request.urlopen(f"{BASE}/health", timeout=1)
                break
            except Exception:
                time.sleep(0.1)

        print("=== 1) 小 docx 原样透传（老行为不变）===")
        ev = post(p_small)
        check("kind=text", ev["kind"] == "text")
        check("无裁剪说明", "内容已裁剪" not in ev["content"])
        check("无省略标记", "已省略" not in ev["content"])
        check("name 未加后缀", "保留" not in ev["name"], ev["name"])
        check("三段全文都在", all(p in ev["content"] for p in plain))

        print("\n=== 2) 6000 段大 docx 默认预算（30000 字符）===")
        t0 = time.time()
        ev = post(p_big)
        dt = time.time() - t0
        c = ev["content"]
        orig_chars = sum(len(p) + 1 for p in big_paras)
        print(f"  原文 {len(big_paras):,} 段 / 约 {orig_chars:,} 字符 "
              f"→ content {len(c):,} 字符，耗时 {dt:.2f}s")
        check("content 不超预算（含说明）", len(c) <= 31000, f"实际 {len(c):,}")
        check("预算利用率 > 80%", len(c) >= 24000, f"实际 {len(c):,}（{len(c)/30000:.0%}）")
        check("含裁剪说明", "内容已裁剪" in c)
        check("说明写明原行数", "6000 行" in c, c[c.find("[内容已裁剪"):][:60])
        check("name 标注保留行数", "保留" in ev["name"], ev["name"])

        print("\n=== 3) 关键行 / 首尾必须留下 ===")
        for mark in ("MARK1200X", "MARK3800X", "MARK5200X"):
            check(f"关键行 {mark} 被保留", mark in c)
        check("开头被保留", "COVER 合同正文" in c)
        check("结尾被保留（签字/日期）", "LAST 落款" in c)

        print("\n=== 4) 保留内容必须逐字来自原文（A 未改写）===")
        orig_set = set(big_paras)
        kept = marker_lines(c)
        bad = [l for l in kept if l and l not in orig_set]
        check("所有保留行都能在原文中逐字找到", not bad, str(bad[:2]))

        print("\n=== 5) 大 xlsx 裁剪（Sheet 标题行必留）===")
        ev = post(p_xlsx)
        c = ev["content"]
        print(f"  xlsx → content {len(c):,} 字符")
        check("kind=text", ev["kind"] == "text")
        check("content 不超预算", len(c) <= 31000, f"实际 {len(c):,}")
        check("含裁剪说明", "内容已裁剪" in c)
        check("Sheet 标题行被保留", "# Sheet: 交易明细" in c)
        check("关键单元格行被保留", "KEYCELL3000X" in c)
        check("表头行被保留", "日期\t金额\t对方\t备注" in c)

        print("\n=== 6) 大纯文本 / 大聊天记录同样受约束 ===")
        ev = post(p_txt)
        check("txt: content 不超预算", len(ev["content"]) <= 31000, f"实际 {len(ev['content']):,}")
        check("txt: 含裁剪说明", "内容已裁剪" in ev["content"])
        ev = post(p_chat)
        check("chat: kind=chat", ev["kind"] == "chat")
        check("chat: content 不超预算", len(ev["content"]) <= 31000, f"实际 {len(ev['content']):,}")
        check("chat: 含裁剪说明", "内容已裁剪" in ev["content"])
        check("chat: 关键消息被保留", "退款 500 元什么时候到账" in ev["content"])

        print("\n=== 7) ?max_chars=3000 自定义预算 ===")
        ev = post(p_big, "?max_chars=3000")
        c = ev["content"]
        check("content 压到 3000 量级", len(c) <= 3400, f"实际 {len(c):,}")
        check("仍含裁剪说明", "内容已裁剪" in c)

        print("\n=== 8) 预算比单行还小 → 不返回空 ===")
        ev = post(p_big, "?max_chars=1000")
        c = ev["content"]
        check("content 非空", bool(c.strip()), f"len={len(c)}")
        check("有截断标记", "已截断" in c or "已省略" in c)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()

    print()
    if ok_all:
        print("ALL PASS —— 文本类预算裁剪生效，且未改写保留内容")
    else:
        print("SOME CHECKS FAILED")
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())
