#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
media_decode.py  ——  A6 媒体懒解码钩子（草稿）
============================================================================
agent 需要把聊天里的图片 / 语音当成证据「看 / 听」时，按需调用本脚本解码。
对应选型结论：文档 / 视频直接按路径读（不解码）；图片 / 语音在此解码。

  - 图片：
      * 老版 3.x .dat（单字节 XOR）：纯标准库，自动识别 JPG/PNG/GIF/BMP，毫秒级。
      * 4.x V2（AES-128-ECB + XOR）：需「图片密钥」（运行 find_image_key 从微信内存取），
        用 pycryptodome 解密；无密钥则给出明确提示。
  - 语音 SILK：调用外部 silk_v3_decoder / ffmpeg 转 WAV/MP3（keyless，秒级）。
  - 文档 / 视频：无需解码，直接返回原路径。

用法：
  python media_decode.py <path> --type image --out out.jpg
  python media_decode.py <path> --type voice --out out.wav
  # 4.x 图片（需先取得图片密钥，见微信端选型结论.md 第 6 节）
  python media_decode.py img.dat --type image --key image_key.bin --out out.jpg

依赖（按需）：
  - 图片 4.x V2 解码：pip install pycryptodome
  - 语音 SILK 解码：安装 silk_v3_decoder（kn007/silk-v3-decoder，内含 ffmpeg）并确保在 PATH
"""

import sys
import os
import argparse

# 常见图片文件头 magic，用于 XOR 解码后判断真实格式
IMG_MAGICS = {
    0xFF: ("jpg", b"\xff\xd8\xff"),   # JPEG
    0x89: ("png", b"\x89\x50\x4e\x47"),  # PNG
    0x47: ("gif", b"\x47\x49\x46"),   # GIF
    0x42: ("bmp", b"\x42\x4d"),       # BMP
}


def decode_image_xor(data: bytes):
    """老版 .dat：单字节 XOR。从首字节反推密钥，尝试各 magic，命中即全量解码。"""
    first = data[0]
    for key, (ext, magic) in IMG_MAGICS.items():
        xor = first ^ key
        # 校验前若干字节解码后是否匹配该 magic
        ok = True
        for i, mb in enumerate(magic):
            if (data[i] ^ xor) != mb:
                ok = False
                break
        if ok:
            dec = bytes(b ^ xor for b in data)
            return dec, ext
    return None, None


def decode_image_aes(data: bytes, image_key: bytes):
    """4.x V2：AES-128-ECB + XOR。需要图片密钥（16 字节）。"""
    try:
        from Crypto.Cipher import AES
    except ImportError:
        raise RuntimeError("4.x 图片解码需要 pycryptodome，请先: pip install pycryptodome")
    if len(image_key) != 16:
        raise RuntimeError(f"图片密钥长度应为 16 字节，实际 {len(image_key)}")
    # 微信 V2：先 AES-128-ECB 解密，再逐字节 XOR 固定值（实践中常用 0x01 或按文件头部）
    cipher = AES.new(image_key, AES.MODE_ECB)
    decrypted = cipher.decrypt(data)
    # XOR 步：用解密后首字节再与各 magic 反推（与 XOR 流程一致）
    first = decrypted[0]
    for key, (ext, magic) in IMG_MAGICS.items():
        xor = first ^ key
        ok = all((decrypted[i] ^ xor) == mb for i, mb in enumerate(magic))
        if ok:
            out = bytes(b ^ xor for b in decrypted)
            return out, ext
    # 没法识别就原样返回解密结果，让上层人工查看
    return decrypted, "bin"


def decode_image(path: str, out_path: str = None, image_key_path: str = None):
    with open(path, "rb") as f:
        data = f.read()

    # 1) 已经是标准图片，直接拷贝
    head = data[:4]
    if head[:3] == b"\xff\xd8\xff" or head[:4] == b"\x89\x50\x4e\x47" or head[:3] == b"\x47\x49\x46":
        ext = "jpg" if head[:3] == b"\xff\xd8\xff" else ("png" if head[:4] == b"\x89\x50\x4e\x47" else "gif")
        out = out_path or (os.path.splitext(path)[0] + f".{ext}")
        with open(out, "wb") as f:
            f.write(data)
        return out

    # 2) 4.x V2（头部 07 08 / 08 07 视为 AES 变体）
    if data[:2] in (b"\x07\x08", b"\x08\x07") and image_key_path:
        with open(image_key_path, "rb") as f:
            key = f.read()
        out_bytes, ext = decode_image_aes(data, key)
        out = out_path or (os.path.splitext(path)[0] + f".{ext}")
        with open(out, "wb") as f:
            f.write(out_bytes)
        return out

    # 3) 老版 XOR .dat
    out_bytes, ext = decode_image_xor(data)
    if out_bytes is None:
        raise RuntimeError(f"无法识别图片格式（非标准头、也非已知 .dat）。"
                           f"若是 4.x V2 请加 --key <图片密钥文件>。path={path}")
    out = out_path or (os.path.splitext(path)[0] + f".{ext}")
    with open(out, "wb") as f:
        f.write(out_bytes)
    return out


def decode_voice(path: str, out_path: str = None):
    """SILK -> WAV/MP3。优先 silk_v3_decoder，其次 ffmpeg。"""
    out = out_path or (os.path.splitext(path)[0] + ".wav")
    # kn007/silk-v3-decoder 的入口通常是 decoder 或 silk2wav
    candidates = ["silk_v3_decoder", "silk2wav", "ffmpeg"]
    import shutil
    import subprocess
    tool = next((t for t in candidates if shutil.which(t)), None)
    if tool is None:
        raise RuntimeError("未找到 SILK 解码器。请安装 silk_v3_decoder(kn007) 或 ffmpeg 并加入 PATH。")
    if tool == "ffmpeg":
        cmd = ["ffmpeg", "-y", "-i", path, out]
    else:
        cmd = [tool, path, out]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"SILK 解码失败: {r.stderr[:300]}")
    return out


def decode_passthrough(path: str):
    """文档 / 视频：无需解码，直接返回原路径。"""
    return path


def main():
    ap = argparse.ArgumentParser(description="微信媒体按需解码（图片/语音）")
    ap.add_argument("path", help="媒体文件路径")
    ap.add_argument("--type", required=True, choices=["image", "voice", "file", "video"])
    ap.add_argument("--out", help="输出路径（默认同名 + 正确扩展名）")
    ap.add_argument("--key", help="4.x 图片密钥文件路径（16 字节）")
    args = ap.parse_args()

    if args.type in ("file", "video"):
        out = decode_passthrough(args.path)
        print(f"[ok] 无需解码，直接消费原文件: {out}")
        return

    if args.type == "image":
        out = decode_image(args.path, args.out, args.key)
    else:  # voice
        out = decode_voice(args.path, args.out)

    print(f"[ok] 已解码: {args.path} -> {out}")


if __name__ == "__main__":
    main()
