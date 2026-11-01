#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
wechat_voice_transcribe.py
--------------------------
给 wechat-ai-memory 的 Version 1 导出**补语音转写**（可换模型、可调参、带缓存）。

为什么单独一步，而不是用 wechat-ai-memory 内置转写：
  真机实测它的内置调用参数（language=zh，无 initial_prompt）会把普通话转成**繁体**，
  还会在噪声片段上冒出英文幻觉（如 "我死了 quite a bit today"）。
  加上 initial_prompt="以下是普通话的句子。" 后稳定输出简体；换 medium 模型后
  "社团上的干涉网" → "社团上面的干事" 这类错误也修掉了。
  转写质量直接影响证据可信度，所以这一步由我们自己控制。

输入：export.json（version=1）+ 同级 `_assets` 目录（里面是 .silk / .wav / .mp3）
输出：新的 export JSON，voice 消息多一个 `transcript` 字段（原 content 不动，仍指向音频）

用法：
  python wechat_voice_transcribe.py export.json --out export.transcribed.json
  python wechat_voice_transcribe.py export.json --model D:/models/faster-whisper-medium
  python wechat_voice_transcribe.py export.json --model small --fast   # 快但略糙

依赖：faster-whisper、pysilk（解微信 SILK）。注意 ctranslate2 目前没有 Python 3.14 轮子，
      请用 Python 3.10~3.13 运行（例如独立的 3.13 venv）。
"""
import argparse
import hashlib
import json
import os
import sys
import tempfile
import wave
from pathlib import Path

DEFAULT_PROMPT = "以下是普通话的句子。"
CACHE_DIR = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "WeChatAIMemory" / "voice-transcripts"


def sanitize(name: str) -> str:
    import re
    s = re.sub(r'[\\/:*?"<>|\r\n]+', "_", name or "chat").strip(" ._")
    return s[:60] or "chat"


def find_assets(json_path: str, explicit: str | None) -> Path | None:
    if explicit:
        return Path(explicit)
    stem = Path(json_path).stem
    for cand in (f"{stem}_assets", "assets"):
        p = Path(json_path).parent / cand
        if p.is_dir():
            return p
    return None


def decode_silk(src: Path, dst: Path, sample_rate: int = 24000) -> bool:
    try:
        import pysilk
    except ImportError:
        return False
    pcm = tempfile.SpooledTemporaryFile(max_size=16 * 1024 * 1024)
    try:
        with src.open("rb") as f:
            pysilk.decode(f, pcm, sample_rate)
        pcm.seek(0)
        data = pcm.read()
    except Exception:
        return False
    finally:
        pcm.close()
    if not data:
        return False
    with wave.open(str(dst), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(data)
    return True


def audio_ready(src: Path, workdir: Path) -> Path | None:
    """统一成 faster-whisper 能直接读的音频。"""
    if src.suffix.lower() in (".wav", ".mp3", ".m4a", ".flac", ".ogg"):
        return src
    if src.suffix.lower() in (".silk", ".amr") or src.suffix == "":
        out = workdir / (src.stem + ".wav")
        return out if decode_silk(src, out) else None
    return src


def cache_path(audio: Path, tag: str) -> Path:
    h = hashlib.sha256(audio.read_bytes()).hexdigest()
    return CACHE_DIR / f"{h}-{tag}.json"


def main() -> int:
    ap = argparse.ArgumentParser(description="给 wechat-ai-memory 导出补语音转写")
    ap.add_argument("input", help="wechat-ai-memory Version 1 导出 JSON")
    ap.add_argument("--out", default=None, help="输出 JSON（默认 <输入名>.transcribed.json）")
    ap.add_argument("--assets", default=None, help="附件的 _assets 目录（默认自动查找）")
    ap.add_argument("--model", default=os.environ.get("WECHAT_AI_MEMORY_WHISPER_MODEL", "small"),
                    help="模型名或本地模型目录（默认 small；中文推荐 medium）")
    ap.add_argument("--prompt", default=DEFAULT_PROMPT, help="initial_prompt，用于锁定简体普通话")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--compute", default="int8")
    ap.add_argument("--limit", type=int, default=0, help="最多转写多少条（0=全部，调试用）")
    ap.add_argument("--force", action="store_true",
                    help="覆盖已有的 transcript。必用于纠正上游内置转写（它会输出繁体+英文幻觉）")
    args = ap.parse_args()

    src_path = Path(args.input)
    data = json.loads(src_path.read_text(encoding="utf-8"))
    if data.get("version") != 1:
        raise SystemExit(f"[!] 仅支持 version=1 的导出，当前 {data.get('version')!r}")
    assets = find_assets(args.input, args.assets)
    if assets is None:
        raise SystemExit("[!] 找不到 _assets 目录，请用 --assets 指定")

    # 收集待转写语音
    pending = []
    for conv in data.get("conversations") or []:
        for msg in conv.get("messages") or []:
            if str(msg.get("type")) != "voice":
                continue
            if (msg.get("transcript") or "").strip() and not args.force:
                continue
            ref = msg.get("content") or ""
            if not ref or ref.lstrip().startswith("["):
                continue
            p = Path(ref)
            p = p if p.is_absolute() else assets / ref
            if p.is_file():
                pending.append((conv.get("name") or "", msg, p))
    if args.limit:
        pending = pending[: args.limit]
    print(f"[1] 待转写语音 {len(pending)} 条 | 模型 {args.model}")
    if not pending:
        print("[1] 无需转写")
        out = Path(args.out) if args.out else src_path.with_suffix(".transcribed.json")
        out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        return 0

    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise SystemExit(
            "[!] 缺少 faster-whisper。安装：pip install faster-whisper\n"
            "    注意 ctranslate2 暂无 Python 3.14 轮子，请用 3.10~3.13 运行。"
        ) from exc

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    tag = Path(args.model).name + "-" + hashlib.sha256(args.prompt.encode()).hexdigest()[:8]
    model = WhisperModel(args.model, device=args.device, compute_type=args.compute)

    ok = hit = fail = 0
    with tempfile.TemporaryDirectory(prefix="wx-voice-") as td:
        workdir = Path(td)
        for i, (cname, msg, audio) in enumerate(pending, start=1):
            cp = cache_path(audio, tag)
            text = None
            if cp.is_file():
                try:
                    text = (json.loads(cp.read_text(encoding="utf-8")).get("transcript") or "").strip()
                    hit += 1
                except Exception:
                    text = None
            if not text:
                ready = audio_ready(audio, workdir)
                if ready is None:
                    fail += 1
                    print(f"    [{i}/{len(pending)}] 解码失败: {audio.name}")
                    continue
                try:
                    segs, _ = model.transcribe(
                        str(ready), language="zh", beam_size=5, vad_filter=True,
                        initial_prompt=args.prompt, condition_on_previous_text=False,
                    )
                    text = "".join(s.text.strip() for s in segs).strip()
                except Exception as exc:
                    fail += 1
                    print(f"    [{i}/{len(pending)}] 转写失败: {type(exc).__name__}: {exc}")
                    continue
                if text:
                    cp.write_text(json.dumps({"transcript": text, "model": str(args.model)},
                                             ensure_ascii=False, indent=2), encoding="utf-8")
            if not text:
                fail += 1
                continue
            msg["transcript"] = text
            ok += 1
            print(f"    [{i}/{len(pending)}] {cname}: {text}")

    out = Path(args.out) if args.out else src_path.with_suffix(".transcribed.json")
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[2] ✅ {out} | 转写 {ok} 条（缓存命中 {hit}，失败 {fail}）")
    print(f"[2]    缓存目录 {CACHE_DIR}")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
