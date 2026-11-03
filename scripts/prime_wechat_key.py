#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""微信首次取数据库密钥（只做一次，之后命中缓存，不再重启微信）。

由「一键配置」界面的「重新抓取微信密钥」按钮触发，**绝不自动执行**：
这个脚本会 taskkill Weixin.exe 并重新拉起，需要用户在手机上确认登录。

与仓库外 wam_probe/prime_key_cache.py 的区别：
  · 源码路径从 SYNAPSE_WECHAT_SRC / 内置候选目录解析，不写死任何机器的绝对路径；
  · 注入空的包壳，绕开 wechat_context_exporter 顶层 __init__（它会 chain 到
    reportlab 等导出依赖，而这里只用本地数据源）；
  · 兼容未打补丁的上游源码（没有 _key_cache_path 时不报错，只提示）。
"""
from __future__ import annotations

import os
import sys
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
HOME = Path.home()

CANDIDATES = [
    os.environ.get("SYNAPSE_WECHAT_SRC"),
    str(HOME / "wam_probe" / "src" / "wechat-ai-memory-main" / "src"),
    str(HOME / ".synapse" / "tools" / "wechat-ai-memory-main" / "src"),
    str(ROOT / "services" / "ingestion" / "adapters" / "wechat-ai-memory" / "src"),
]


def resolve_src() -> Path | None:
    for raw in CANDIDATES:
        if not raw:
            continue
        path = Path(raw).expanduser()
        if (path / "wechat_context_exporter" / "sources" / "wechat4_source.py").is_file():
            return path
    return None


def inject_package(src: Path) -> None:
    """只给包壳 __path__，不让上游 __init__ 执行（会拉起 reportlab 等导出依赖）。"""
    if str(src) not in sys.path:
        sys.path.insert(0, str(src))
    for name, folder in (
        ("wechat_context_exporter", src / "wechat_context_exporter"),
        ("wechat_context_exporter.sources", src / "wechat_context_exporter" / "sources"),
    ):
        if name not in sys.modules:
            module = types.ModuleType(name)
            module.__path__ = [str(folder)]
            sys.modules[name] = module


def main() -> int:
    src = resolve_src()
    if src is None:
        print("[×] 未找到 wechat-ai-memory 源码；先点「一键配置」，或设置 SYNAPSE_WECHAT_SRC", flush=True)
        return 1
    print(f"[源码] {src}", flush=True)
    inject_package(src)

    from wechat_context_exporter.sources.wechat4_discovery import (  # noqa: PLC0415
        discover_wechat4_accounts,
    )
    from wechat_context_exporter.sources import wechat4_key_capture as capture  # noqa: PLC0415

    alive = []
    for account in discover_wechat4_accounts():
        db = account.account_dir / "db_storage" / "message" / "message_0.db"
        if db.is_file():
            alive.append((db.stat().st_mtime, account))
    if not alive:
        print("[×] 没有发现已登录的微信 4.x 账户，请先登录微信桌面版", flush=True)
        return 1
    alive.sort(key=lambda item: item[0], reverse=True)
    account = alive[0][1]
    print(f"[账户] {account.id}", flush=True)
    cache = getattr(capture, "_key_cache_path", None)
    if cache:
        print(f"[缓存] {cache()}", flush=True)
    print("[!] 微信即将被关闭并重新拉起，请准备好手机确认登录", flush=True)

    def progress(step: int, total: int, label: str) -> None:
        print(f"    [{step}/{total}] {label}", flush=True)

    key = capture.capture_account_key(account.account_dir, progress=progress)
    print(f"[✓] 密钥 {len(key)} 字节 | {key[:4].hex()}…{key[-4:].hex()}", flush=True)
    if cache:
        print(f"[✓] 缓存已写入：{cache()}（存在={cache().is_file()}）", flush=True)
    else:
        print("[!] 当前源码未带密钥缓存补丁，请在一键配置里补打补丁后重试", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
