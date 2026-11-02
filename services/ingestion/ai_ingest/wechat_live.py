#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""微信 4.x 免导出直读：复用 wechat-ai-memory 的本地数据源。

为什么微信也能「先读取、再挑会话」：
    wechat-ai-memory 的 `WeChat4LocalSource` 本身就实现了
        list_conversations()                       ← 等价于 dws 的会话列表
        get_messages(cid, start=None, end=None)    ← 等价于 dws 的按群按时间取消息
    「导出整份 Version 1 JSON」只是它的另一条用法。我们直接调这两个方法，
    读出来的消息再组装成同一份 Version 1 JSON，后面的预览/抽取完全复用现有链路。

两条硬约束（踩过就会很难查）：
  1. **必须传 raw_key**。不传时 `WeChat4LocalSource` 会走 capture_account_key()：
     taskkill 微信 → 重启 → Frida 截密钥。那是有副作用的（用户正在用微信），
     所以没有缓存密钥时我们直接报 need_auth，让人自己决定要不要抓。
  2. **不能让包的 __init__ 执行**。它会 chain 到 service → pdf_exporter → reportlab，
     而我们只用本地数据源；所以注入一个只有 __path__ 的空包，绕开顶层 __init__。
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
import types
from datetime import datetime
from pathlib import Path

SRC_ENV = "SYNAPSE_WECHAT_SRC"
CACHE_ENV = "SYNAPSE_WECHAT_KEY_CACHE"
# 设成 0 就不去取图片密钥（也就不用扫微信进程内存），图片退回「[图片]」占位
IMAGE_ENV = "SYNAPSE_WECHAT_IMAGE"
# 实例里有解密后的数据库缓存与表索引，重建一次约 7 秒；10 分钟内复用。
_TTL = 600.0

_lock = threading.Lock()
_state: dict = {"source": None, "account": "", "image": "", "at": 0.0}
_pkg_ready = False
# 图片解出来是临时文件（数据源关闭时整目录删除），必须拷到我们自己的目录再压一遍
_image_dir: str = ""
_image_stats: dict = {"downloaded": 0, "failed": 0, "key": False}
# 取不到密钥时别每次请求都去扫一遍进程内存（一次 8 秒），失败也记住一会儿
_key_fail_at: float = 0.0


class WeChatLiveError(RuntimeError):
    """带状态码的取数失败，直接映射成 /source/live 的响应。"""

    def __init__(self, detail: str, hint: str = "", status: str = "error",
                 action: str = "", code: int = 400) -> None:
        super().__init__(detail)
        self.detail = detail
        self.hint = hint
        self.status = status
        self.action = action
        self.code = code


# ---------------------------------------------------------------- 定位源码

def _src_candidates() -> list[Path]:
    here = Path(__file__).resolve().parent          # .../ai_ingest
    adapters = here.parent / "adapters"             # .../ingestion/adapters
    out: list[Path] = []
    env = os.environ.get(SRC_ENV)
    if env:
        out.append(Path(env).expanduser())
    out += [
        adapters / "wechat-ai-memory" / "src",
        here.parent / "wechat-ai-memory" / "src",
        Path.home() / "wam_probe" / "src" / "wechat-ai-memory-main" / "src",
    ]
    return out


def resolve_src() -> Path | None:
    for candidate in _src_candidates():
        try:
            if (candidate / "wechat_context_exporter" / "sources" / "wechat4_source.py").is_file():
                return candidate
        except OSError:
            continue
    return None


def _ensure_importable(src: Path) -> None:
    global _pkg_ready
    with _lock:
        if _pkg_ready:
            return
        text = str(src)
        if text not in sys.path:
            sys.path.insert(0, text)
        if "wechat_context_exporter" not in sys.modules:
            pkg = types.ModuleType("wechat_context_exporter")
            pkg.__path__ = [str(src / "wechat_context_exporter")]
            sys.modules["wechat_context_exporter"] = pkg
        _pkg_ready = True


# ---------------------------------------------------------------- 密钥缓存

def key_cache_path() -> Path:
    override = os.environ.get(CACHE_ENV)
    if override:
        return Path(override).expanduser()
    base = os.environ.get("LOCALAPPDATA") or str(Path.home())
    return Path(base) / "Synapse" / "wechat_db_keys.json"


def _db_mtime(account_dir: Path) -> float:
    db = account_dir / "db_storage" / "message" / "message_0.db"
    try:
        return db.stat().st_mtime
    except OSError:
        return 0.0


def _pick_account() -> dict:
    """从密钥缓存里挑「最近还在写」的账户；没有就报 need_auth（不自动抓密钥）。"""
    path = key_cache_path()
    if not path.is_file():
        raise WeChatLiveError(
            "未找到微信数据库密钥缓存",
            hint=f"首次需抓一次密钥（会重启微信）：python wechat_key_cache.py；缓存位置 {path}",
            status="need_auth", action="capture-key")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise WeChatLiveError(f"密钥缓存不可读：{exc}", status="need_auth") from exc
    best: tuple[float, str, str, str] | None = None
    for entry in (data.get("keys") or {}).values():
        account_dir = str(entry.get("account_dir") or "")
        hex_key = str(entry.get("raw_key_hex") or "")
        image_hex = str(entry.get("image_key_hex") or "")
        if not account_dir or len(hex_key) != 64:
            continue
        folder = Path(account_dir)
        if not (folder / "db_storage" / "message" / "message_0.db").is_file():
            continue
        stamp = _db_mtime(folder)
        if best is None or stamp > best[0]:
            best = (stamp, account_dir, hex_key, image_hex)
    if best is None:
        raise WeChatLiveError(
            "密钥缓存里没有可用的微信账户（缺 db_storage/message/message_0.db）",
            hint="确认微信已登录过；或重新抓一次密钥", status="need_auth", action="capture-key")
    return {"account_dir": best[1], "raw_key": bytes.fromhex(best[2]),
            "image_key_hex": best[3]}


def _cache_patch(account_dir: str, **fields) -> None:
    """把 image_key_hex 之类的补充信息写回密钥缓存（不动 raw_key）。"""
    path = key_cache_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return
    touched = False
    for entry in (data.get("keys") or {}).values():
        if str(entry.get("account_dir") or "") == account_dir:
            for key, value in fields.items():
                if entry.get(key) != value:
                    entry[key] = value
                    touched = True
    if touched:
        try:
            path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError:
            pass


def image_key(account: dict, force: bool = False) -> bytes | None:
    """拿到微信图片解密密钥（16 字节）。

    为什么单独一个密钥：数据库用 raw_key（SQLCipher），图片 .dat 用另一把 AES 密钥，
    两者不通用。没有它 `WeChat4LocalSource` 会把每条图片降级成 SYSTEM「[图片]」，
    于是整段聊天看起来「没有一张图」——这正是之前微信导入只剩一坨文字的原因。

    取法两条：缓存里有就直接用；没有就用 wechat-ai-memory 自己的
    `extract_image_key()` 扫一遍微信进程内存（约 8 秒，需微信在运行）。
    取不到不抛错：宁可少图，也不能让整次导入失败。
    """
    if os.environ.get(IMAGE_ENV, "1") in ("0", "false", "False"):
        return None
    global _key_fail_at
    hex_key = str(account.get("image_key_hex") or "")
    if len(hex_key) == 32 and not force:
        try:
            return bytes.fromhex(hex_key)
        except ValueError:
            pass
    if not force and time.time() - _key_fail_at < 60:
        return None
    try:
        from wechat_context_exporter.sources.wechat4_crypto import (  # noqa: PLC0415
            extract_image_key,
        )
    except ImportError:
        return None
    try:
        key = extract_image_key(Path(account["account_dir"]))
    except Exception:  # noqa: BLE001  扫内存可能被拒（非管理员）/微信未运行
        _key_fail_at = time.time()
        return None
    if not key:
        _key_fail_at = time.time()
        return None
    _cache_patch(account["account_dir"], image_key_hex=key.hex())
    return key



# ---------------------------------------------------------------- 数据源

def get_source(force: bool = False):
    """返回已就绪的本地数据源（进程内复用）。失败抛 WeChatLiveError。"""
    if os.name != "nt":
        raise WeChatLiveError("微信直读目前只支持 Windows 本机", status="unsupported", code=400)
    src = resolve_src()
    if src is None:
        raise WeChatLiveError(
            "未找到 wechat-ai-memory 源码",
            hint=f"设置 {SRC_ENV} 指向 wechat-ai-memory 的 src 目录（需含 wechat_context_exporter/）",
            status="unsupported", code=400)
    account = _pick_account()
    key = image_key(account)
    key_hex = key.hex() if key else ""
    now = time.time()
    with _lock:
        cached = _state["source"]
        # 密钥后来才取到（或换过）时要重建：老实例的 DecryptedImageCache 还是无密钥状态
        if (not force and cached is not None
                and _state["account"] == account["account_dir"]
                and _state["image"] == key_hex
                and now - _state["at"] < _TTL):
            return cached
    _ensure_importable(src)
    try:
        from wechat_context_exporter.sources.wechat4_source import (  # noqa: PLC0415
            WeChat4LocalSource,
        )
    except ImportError as exc:
        raise WeChatLiveError(
            f"无法导入 wechat-ai-memory 本地数据源：{exc}",
            hint="确认已安装其依赖（zstandard、pycryptodome）", status="unsupported") from exc
    try:
        # 显式传 raw_key：绝不触发 capture_account_key（那会 taskkill 微信再重启）
        source = WeChat4LocalSource(
            account["account_dir"], raw_key=account["raw_key"], image_key=key)
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        # 密钥失效和「库坏了」要分开：前者重新抓一次密钥就好（need_auth），
        # 报成 error 会让人以为整个渠道坏了、不知道下一步该做什么。
        stale = any(k in msg for k in ("key", "Key", "Encryption", "密钥", "decrypt"))
        raise WeChatLiveError(
            f"读取微信数据库失败：{msg}",
            hint=("密钥已失效（改密码/换设备/重装微信都会变）；重新抓一次密钥即可"
                  if stale else "确认微信数据目录完整；必要时重新抓一次密钥"),
            status="need_auth" if stale else "error",
            action="capture-key" if stale else "") from exc
    with _lock:
        _state.update({"source": source, "account": account["account_dir"],
                       "image": key_hex, "at": time.time()})
        _image_stats["key"] = bool(key)
    return source


def reset_cache() -> None:
    with _lock:
        _state.update({"source": None, "account": "", "image": "", "at": 0.0})


# ---------------------------------------------------------------- 快照

def _parse(value: str) -> datetime:
    text = str(value or "").strip().replace("T", " ")
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    raise WeChatLiveError(f"时间格式无法解析：{value}", status="need_range")


def _image_root() -> Path:
    """图片落地目录：数据源解密出来的是临时文件，源一关就没了，必须自己留一份。"""
    global _image_dir
    if not _image_dir:
        _image_dir = tempfile.mkdtemp(prefix="synapse_wx_images_")
    return Path(_image_dir)


def _save_image(source: Path, message) -> str | None:
    """把解密出的图片拷到我们的目录（并压到长边 1280），返回新路径。

    文件名带时间：证据标题直接用 basename，用户看到的应该是「图片 2026-10-31 22.38.03.jpg」
    而不是一串哈希。
    """
    stamp = message.timestamp.strftime("%Y-%m-%d %H.%M.%S") if message.timestamp else "未知时间"
    target = _image_root() / f"图片 {stamp}.jpg"
    try:
        raw = source.read_bytes()
    except OSError:
        return None
    try:
        from PIL import Image  # noqa: PLC0415
        import io  # noqa: PLC0415

        with Image.open(io.BytesIO(raw)) as img:
            img = img.convert("RGB") if img.mode not in ("RGB", "L") else img
            longest = max(img.size)
            if longest > 1280:
                ratio = 1280 / float(longest)
                img = img.resize((max(1, int(img.width * ratio)),
                                  max(1, int(img.height * ratio))), Image.LANCZOS)
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=82, optimize=True)
            data = buf.getvalue()
        if len(data) < len(raw) or target.suffix != source.suffix:
            raw = data
    except Exception:  # noqa: BLE001  Pillow 缺失/解码失败就存原图，不影响出证
        pass
    try:
        target.write_bytes(raw)
    except OSError:
        return None
    return str(target).replace("\\", "/")


def _materialize_images(messages) -> dict[str, str]:
    """批量为图片消息落盘；返回 {message.id: 本地路径}。"""
    out: dict[str, str] = {}
    for message in messages:
        if getattr(message.type, "value", "") != "image":
            continue
        path = message.image_path
        if path is None:
            continue
        saved = _save_image(Path(path), message)
        if saved:
            out[str(message.id)] = saved
            _image_stats["downloaded"] += 1
        else:
            _image_stats["failed"] += 1
    return out


def _to_v1(message, image_path: str | None = None) -> dict:
    """Message → wechat-ai-memory Version 1 的消息结构（后面走同一个适配器）。"""
    stamp = message.timestamp.strftime("%Y-%m-%d %H:%M:%S") if message.timestamp else ""
    content = message.content or ""
    if image_path:
        content = image_path  # 指向我们自己存的那份，别用数据源的临时文件
    return {
        "id": str(message.id or ""),
        "sender": message.sender or "未知",
        "timestamp": stamp,
        "type": getattr(message.type, "value", str(message.type)),
        "content": content,
        "is_outgoing": bool(message.is_outgoing),
        "reply_to": message.reply_to or "",
        "transcript": message.transcript or "",
    }


def verify_key() -> dict:
    """用缓存的密钥真的开一次库，确认「已就绪」不是骗人的。

    只检查 `wechat_db_keys.json` 存在是不够的：换设备 / 改密码 / 重装微信之后
    旧密钥就解不开了，面板却一路绿灯，用户点到「读取」才失败。
    这里读一次会话清单（本地库、不读正文），打不开就按 WeChatLiveError 抛出去。
    """
    source = get_source()
    rows = list(source.list_conversations())
    with _lock:
        account = str(_state.get("account") or "")
    return {"sessions": len(rows), "account": Path(account).name if account else ""}


def list_sessions() -> tuple[list[dict], dict]:
    """只列会话，不读消息：供「先勾选要读哪几段」用。

    微信这边是本地库，list_conversations() 一次就能给全（本机实测 79 段），
    但它不返回每段的消息条数——统计条数就得逐段查消息，那又变成「全读了」。
    所以这里只给身份信息，条数等用户勾选、真正读取时再算。
    """
    source = get_source()
    rows: list[dict] = []
    for conv in source.list_conversations():
        kind = getattr(conv.kind, "value", str(conv.kind))
        rows.append({
            "id": conv.id,
            "title": conv.name or "(未命名会话)",
            "single": kind != "group",
            "kind": kind,
            "count": None,
        })
    return rows, {"scanned": len(rows)}


def snapshot(time_start: str, time_end: str,
             ids: list[str] | None = None) -> tuple[dict, dict]:
    """按时间范围组装 Version 1 JSON；返回 (数据, 取数统计)。

    ids 给了就只读这几段会话——用户先勾了清单，没必要把没勾的群也解出来。
    """
    source = get_source()
    _image_stats.update({"downloaded": 0, "failed": 0})
    start, end = _parse(time_start), _parse(time_end)
    wanted = {str(i) for i in ids} if ids else None
    conversations = [c for c in source.list_conversations()
                     if wanted is None or c.id in wanted]
    payload: list[dict] = []
    skipped: list[str] = []
    total = 0
    for conv in conversations:
        try:
            messages = source.get_messages(conv.id, start=start, end=end)
        except Exception:  # noqa: BLE001
            # 单个会话读失败（比如表情/公众号库结构异常）不该拖垮整批
            skipped.append(conv.name)
            continue
        rows = _rows_of(messages)
        if not rows:
            continue
        payload.append({
            "id": conv.id,
            "name": conv.name,
            "kind": getattr(conv.kind, "value", str(conv.kind)),
            "messages": rows,
        })
        total += len(rows)
    payload.sort(key=lambda c: c["messages"][-1]["timestamp"], reverse=True)
    if not payload:
        raise WeChatLiveError(
            "该时间范围内没有可读消息",
            hint="换一个时间范围；或确认微信里这段时间确实有聊天", status="empty", code=404)
    return {"version": 1, "conversations": payload}, {
        "conversations": len(payload),
        "messages": total,
        "scanned": len(conversations),
        "picked": len(wanted) if wanted else 0,
        "skipped": skipped,
        # 字段名与钉钉保持一致（C 侧同一段文案读 downloaded/failed/skipped）
        "media": {**_image_stats, "skipped": 0},
    }


def _rows_of(messages) -> list[dict]:
    """消息 → Version 1 行（含图片落盘），按时间排好。"""
    images = _materialize_images(messages)
    rows = [_to_v1(m, images.get(str(m.id))) for m in messages if m.timestamp]
    rows.sort(key=lambda m: m["timestamp"])
    return rows


def conversation_messages(conversation_id: str, time_start: str, time_end: str) -> list[dict]:
    """单会话重读用：只取这一段的消息（不做全量扫描，几毫秒）。"""
    source = get_source()
    start, end = _parse(time_start), _parse(time_end)
    try:
        messages = source.get_messages(conversation_id, start=start, end=end)
    except Exception as exc:  # noqa: BLE001
        raise WeChatLiveError(f"读取该会话失败：{exc}") from exc
    rows = _rows_of(messages)
    return rows
