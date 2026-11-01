# -*- coding: utf-8 -*-
"""验证体积闸门「只治文档、不管图片」，且两条入口共用同一套规则。

口径（用户明确）：闸门存在的唯一理由是**防解析超时**。
  - PDF / Word / Excel / 文本：要抽正文或渲染页面，耗时随体积线性增长 → **受限**
  - 图片：不解析，只是 base64 塞进 content，不存在解析超时 → **不受限**

背景：闸门原先只写在 build_evidence（/parse 上传路径）里，
build_media_evidence（/parse_chat、/source/sync）完全没有——渠道取数整段绕过。
现已按同一口径补齐。

覆盖：
  1. 图片超过闸门 → 仍是 image，正常出 data URL（不受体积限制）
  2. 文本文档超过闸门 → 只回链接与原因，绝不塞正文
  3. PDF 超过闸门 → 同上
  4. 不误伤：阈值以内的文档照常解析
  5. 视觉提示阈值：图片超限只在 name 上标注，content 一字不改
  6. 音视频仍走占位
  7. 两条入口口径一致（上传侧图片同样不受限）

用缩小的阈值跑，走的是与线上完全相同的代码路径。
"""
import importlib.util
import os
import sys
import tempfile
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SERVER = os.path.join(ROOT, "server.py")

ok_all = True


def check(label, cond, detail=""):
    global ok_all
    ok_all = ok_all and bool(cond)
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}" + (f"   {detail}" if detail else ""))


def load_server():
    spec = importlib.util.spec_from_file_location("ingest_server_gate", SERVER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def write_bytes(directory, name, size):
    """写指定字节数的文件。图片内容随机即可：image/png 在 VISION_MIMES 里，
    image_data_url 会直接 base64，不需要真实解码。"""
    path = os.path.join(directory, name)
    with open(path, "wb") as f:
        f.write(os.urandom(size))
    return path


def main():
    print("=" * 78)
    print("闸门口径测试：只治文档，不管图片  (MAX_CONTENT_SIZE 缩到 1MB)")
    print("=" * 78)

    mod = load_server()
    mod.MAX_CONTENT_SIZE = 1 * 1024 * 1024
    mod.MAX_CONTENT_SIZE_MB = 1.0
    mod.VISION_IMAGE_HINT = 64 * 1024  # 提示阈值缩到 64KB，便于测标注

    GATE = mod.MAX_CONTENT_SIZE
    OVER = GATE + 300 * 1024  # 明确超过闸门
    tmp = tempfile.mkdtemp(prefix="chatgate_")
    u = uuid.uuid4().hex[:6]

    p_big_img = write_bytes(tmp, f"big_{u}.png", OVER)
    p_big_txt = write_bytes(tmp, f"big_{u}.txt", OVER)
    p_big_pdf = write_bytes(tmp, f"big_{u}.pdf", OVER)
    p_small_img = write_bytes(tmp, f"small_{u}.png", 20 * 1024)
    p_small_txt = write_bytes(tmp, f"small_{u}.txt", 20 * 1024)
    p_hint = write_bytes(tmp, f"hint_{u}.png", 100 * 1024)  # >64KB 但 <1MB
    p_audio = write_bytes(tmp, f"voice_{u}.mp3", 40 * 1024)

    def media(path, origin="钉钉"):
        return mod.build_media_evidence(
            {"name": os.path.basename(path), "media_ref": path},
            media_dir=os.path.dirname(path),
            origin=origin,
        )

    print("\n=== 1) 图片超过闸门：不受限，照常出图 ===")
    ev = media(p_big_img)
    check("图片不受体积闸门限制", ev["kind"] == "image", ev["kind"])
    check("图片 content 仍是 data URL", ev["content"].startswith("data:image/png;base64,"))
    check("图片没有「未解析」字样", "未解析" not in ev["content"])
    check("确实超过了闸门阈值（不是没测到）", os.path.getsize(p_big_img) > GATE)
    check("source 仍是聊天渠道", ev["source"] == "钉钉", ev["source"])

    print("\n=== 2) 文本文档超过闸门：只回链接与原因 ===")
    ev_txt = media(p_big_txt)
    check("超大 txt 判为 text（非正文）", ev_txt["kind"] == "text", ev_txt["kind"])
    check("说明了未解析的原因", "附件过大，未解析" in ev_txt["content"])
    check("content 里没有塞进正文", len(ev_txt["content"]) < 2000,
          f"{len(ev_txt['content'])} 字符")

    print("\n=== 3) PDF 超过闸门：同样只回链接 ===")
    ev_pdf = media(p_big_pdf)
    check("超大 PDF 不再走 pdf 解析", ev_pdf["kind"] == "text", ev_pdf["kind"])
    check("超大 PDF 说明未解析", "附件过大，未解析" in ev_pdf["content"])

    print("\n=== 4) 不误伤：阈值以内照常解析 ===")
    ev_s_img = media(p_small_img)
    ev_s_txt = media(p_small_txt)
    check("小图仍是 kind=image", ev_s_img["kind"] == "image", ev_s_img["kind"])
    check("小 txt 仍是 text 且未标超限",
          ev_s_txt["kind"] == "text" and "附件过大" not in ev_s_txt["content"])
    check("小图 name 未加体积标注", "[原图" not in ev_s_img["name"], ev_s_img["name"])

    print("\n=== 5) 视觉提示阈值：只标注名字，内容一字不改 ===")
    ev_hint = media(p_hint)
    check("超过提示阈值的图仍是 image（不拒绝）", ev_hint["kind"] == "image", ev_hint["kind"])
    check("name 上标注了原图体积", "[原图" in ev_hint["name"], ev_hint["name"])
    check("标注写明可能超出模型上限", "超出模型单图上限" in ev_hint["name"])
    check("content 原样保留 data URL（未改写）",
          ev_hint["content"].startswith("data:image/png;base64,"))

    print("\n=== 6) 音视频仍走占位 ===")
    ev_audio = media(p_audio)
    check("mp3 仍是 text 占位", ev_audio["kind"] == "text", ev_audio["kind"])
    check("mp3 不塞 base64", "base64," not in ev_audio["content"])
    check("mp3 是「未解析」而非「附件过大」",
          "未解析" in ev_audio["content"] and "附件过大" not in ev_audio["content"])

    print("\n=== 7) 两条入口口径一致（上传侧图片同样不受限）===")
    with open(p_big_img, "rb") as f:
        big_img_bytes = f.read()
    with open(p_big_txt, "rb") as f:
        big_txt_bytes = f.read()
    up_img = mod.build_evidence("big.png", "image/png", big_img_bytes, origin="用户上传")
    up_txt = mod.build_evidence("big.txt", "text/plain", big_txt_bytes, origin="用户上传")
    check("/parse 上传的大图仍是 image（不受限）", up_img["kind"] == "image", up_img["kind"])
    check("/parse 上传的大 txt 判为超限", up_txt["kind"] == "text"
          and "附件过大，未解析" in up_txt["content"])
    check("两侧对图片的口径一致", up_img["kind"] == "image" and ev["kind"] == "image")
    check("两侧对文档的口径一致",
          "附件过大，未解析" in up_txt["content"]
          and "附件过大，未解析" in ev_txt["content"])

    for p in (p_big_img, p_big_txt, p_big_pdf, p_small_img, p_small_txt, p_hint, p_audio):
        try:
            os.remove(p)
        except OSError:
            pass
    try:
        os.rmdir(tmp)
    except OSError:
        pass

    print()
    if ok_all:
        print("ALL PASS —— 闸门只治文档（PDF/Office/文本），图片不受体积限制")
    else:
        print("SOME CHECKS FAILED")
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())
