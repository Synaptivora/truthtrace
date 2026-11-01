"""验证「扫描件 PDF 渲染成图片走视觉通道」这条路径。

背景：之前本机没装 PyMuPDF，扫描件 PDF 一律降级成一句
「[扫描件 PDF：… 无法渲染成图片]」，等于模型什么也看不到。
装上 pymupdf 之后应该恢复成 kind=image。

覆盖：
  1. 单页扫描件 → kind=image，content 是合法 PNG data URL，图像尺寸符合 zoom
  2. 多页扫描件 → name 标注「仅第 N 页 / 共 M 页」，避免被当成完整文档
  3. ?pages=N → 渲染指定页（第 N 页与第 1 页的图不同）
  4. 文本型 PDF 不被误伤 → 仍走 kind=pdf（抽文本，不渲染）
  5. 损坏 PDF → 优雅降级成文本说明，绝不吐出非法 data URL

运行：python run_scan_pdf_test.py
"""
import sys, os, io, base64, uuid, time, json, subprocess, tempfile, shutil
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SERVER = os.path.join(ROOT, "server.py")
PORT = 8041
BASE = f"http://127.0.0.1:{PORT}"

fails = []
def check(label, cond, detail=""):
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"  {detail}" if detail else ""))
    if not cond:
        fails.append(label)

try:
    import pymupdf
except ImportError:
    print("跳过：未安装 pymupdf（python -m pip install 'pymupdf>=1.24,<2.0'）")
    sys.exit(0)
from PIL import Image


def mk_scan_pdf(path, pages=1, w=600, h=800):
    """真实扫描件形态：整页是一张图，没有任何字体/文本对象。"""
    doc = pymupdf.open()
    for i in range(pages):
        img = Image.new("RGB", (w, h), (250 - i * 8, 246, 240))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=80)
        page = doc.new_page(width=w, height=h)
        page.insert_image(pymupdf.Rect(0, 0, w, h), stream=buf.getvalue())
    doc.save(path)
    doc.close()
    return os.path.getsize(path)


def mk_text_pdf(path):
    """有文本层的普通 PDF（应该走 kind=pdf，不能被当扫描件渲染）。"""
    doc = pymupdf.open()
    page = doc.new_page(width=600, height=800)
    page.insert_text((72, 120), "Refund REFUND2026 transfer 5000 CNY", fontsize=12)
    doc.save(path)
    doc.close()
    return os.path.getsize(path)


def post(path, query=""):
    bd = "----t" + uuid.uuid4().hex
    name = os.path.basename(path)
    raw = open(path, "rb").read()
    body = (f"--{bd}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
            f"Content-Type: application/pdf\r\n\r\n").encode() + raw + f"\r\n--{bd}--\r\n".encode()
    req = urllib.request.Request(BASE + "/parse" + query, data=body, method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={bd}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())["evidence"]


def png_of(ev):
    """从 data URL 里取出 PNG 字节；不是图片返回 None。"""
    c = ev.get("content") or ""
    if not c.startswith("data:image/png;base64,"):
        return None
    return base64.b64decode(c.split(",", 1)[1])


tmp = tempfile.mkdtemp(prefix="scan_")
env = dict(os.environ, UPLOAD_DIR=os.path.join(tmp, "_uploads"))
proc = subprocess.Popen([sys.executable, SERVER, "--port", str(PORT)],
                        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(150):
        try:
            urllib.request.urlopen(BASE + "/health", timeout=1)
            break
        except Exception:
            time.sleep(0.1)

    print("\n=== 1) 单页扫描件 → kind=image + 合法 PNG ===")
    p1 = os.path.join(tmp, "合同扫描件.pdf")
    print(f"  PDF {mk_scan_pdf(p1, pages=1):,} 字节")
    ev = post(p1)
    print(f"  kind={ev['kind']}  mimeType={ev['mimeType']}  name={ev['name']}")
    check("kind=image", ev["kind"] == "image", ev["kind"])
    check("mimeType=image/png", ev["mimeType"] == "image/png", ev["mimeType"])
    raw = png_of(ev)
    check("content 是合法 PNG data URL", raw is not None)
    if raw:
        check("PNG 魔数正确", raw[:8] == b"\x89PNG\r\n\x1a\n", raw[:8].hex())
        im = Image.open(io.BytesIO(raw))
        print(f"  渲染尺寸 {im.width}x{im.height}px（原页 600x800，zoom=2.0 → 1200x1600）")
        check("按 zoom=2.0 放大", (im.width, im.height) == (1200, 1600), f"{im.width}x{im.height}")
        check("不是空白占位图（体积 > 1KB）", len(raw) > 1024, f"{len(raw):,} 字节")

    print("\n=== 2) 多页扫描件 → name 标注页码 ===")
    p3 = os.path.join(tmp, "三页合同.pdf")
    print(f"  PDF {mk_scan_pdf(p3, pages=3):,} 字节 / 3 页")
    ev3 = post(p3)
    print(f"  kind={ev3['kind']}  name={ev3['name']}")
    check("kind=image", ev3["kind"] == "image", ev3["kind"])
    check("name 含「共 3 页」", "共 3 页" in ev3["name"], ev3["name"])
    check("name 含「仅第 1 页」", "仅第 1 页" in ev3["name"], ev3["name"])

    print("\n=== 3) ?pages=2 → 渲染第 2 页（图应与第 1 页不同）===")
    ev_p2 = post(p3, query="?pages=2")
    print(f"  name={ev_p2['name']}")
    check("name 含「第 2 页」", "第 2 页" in ev_p2["name"], ev_p2["name"])
    raw1, raw2 = png_of(ev3), png_of(ev_p2)
    check("第 2 页与第 1 页的图像不同", raw1 != raw2 if (raw1 and raw2) else False)

    print("\n=== 4) 文本型 PDF 不被误伤 ===")
    pt = os.path.join(tmp, "文本型.pdf")
    print(f"  PDF {mk_text_pdf(pt):,} 字节（有文字层）")
    evt = post(pt)
    print(f"  kind={evt['kind']}  content={evt['content'][:40]!r}")
    check("kind=pdf（抽文本，不渲染）", evt["kind"] == "pdf", evt["kind"])
    check("抽到了原文", "REFUND2026" in evt["content"])

    print("\n=== 5) 损坏 PDF → 降级说明，不吐非法 data URL ===")
    pb = os.path.join(tmp, "损坏的.pdf")
    open(pb, "wb").write(b"%PDF-1.4\n" + os.urandom(4000))
    evb = post(pb)
    print(f"  kind={evb['kind']}  content={evb['content'][:70]!r}")
    check("没有崩（拿到响应）", isinstance(evb, dict))
    check("不是 image", evb["kind"] != "image", evb["kind"])
    check("content 不是半截图片 URL", not evb["content"].startswith("data:image"))

    print()
    if fails:
        print(f"SOME CHECKS FAILED: {len(fails)} 项")
        for f in fails:
            print("  -", f)
        sys.exit(1)
    print("ALL PASS —— 扫描件 PDF 已恢复：渲染成 PNG 走 kind=image，文本型不受影响")
finally:
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except Exception:
        proc.kill()
    shutil.rmtree(tmp, ignore_errors=True)
