"""微信数据库密钥缓存运维工具（Synapse A6）

背景
----
wechat-ai-memory 原生取密流程（`wechat4_key_capture.capture_account_key`）每次导出都要
`taskkill /F /IM Weixin.exe` → 重启微信 → 用 Frida 卡住 SHA-512 派生瞬间拿密钥。
数据库密钥在磁盘上不存在、只在登录派生那一瞬以明文驻留内存，所以「重启」这一步是
上游算法的硬性要求，而不是可以绕过的实现细节。

但密钥对同一微信账号是**稳定**的（只有改密码 / 换设备 / 重装才变）。因此给上游打了一个
最小补丁：命中缓存且 `verify_account_key` 校验通过时直接返回密钥，微信保持运行、不再
要求扫码；校验失败则自动回落原生流程重新抓取。

缓存位置
--------
    %LOCALAPPDATA%\\Synapse\\wechat_db_keys.json     （可用 SYNAPSE_WECHAT_KEY_CACHE 覆盖）

文件权限收紧到仅当前用户可读写（icacls 去除继承）。格式：:

    {"version": 1,
     "keys": {"<account_dir sha256 前 16 位>": {
         "account_dir": "...", "raw_key_hex": "64 位十六进制",
         "captured_at": "...", "first_page_sha256": "..."}}}

本脚本职责
----------
只做查看 / 校验 / 导入 / 导出 / 清除，不参与取密，也不重启微信。
`--verify` 需要能 import wechat4_crypto（用 `--src` 指定上游 src 目录，或自动探测）。

用法
----
    python wechat_key_cache.py                          # 列出缓存（密钥掩码）
    python wechat_key_cache.py --verify                 # 用真实库首页校验是否仍有效
    python wechat_key_cache.py --import-hex key.txt     # 导入历史纯 hex 密钥文件
    python wechat_key_cache.py --export key.txt         # 导出明文 hex（兼容旧脚本）
    python wechat_key_cache.py --clear                  # 清空全部缓存
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

CACHE_ENV = "SYNAPSE_WECHAT_KEY_CACHE"
PAGE_SIZE = 4096

SRC_CANDIDATES = [
    Path(r"C:/Users/zhuke/wam_probe/src/wechat-ai-memory-main/src"),
    Path(__file__).resolve().parent / "wechat-ai-memory" / "src",
]


# ---------------------------------------------------------------- 缓存定位

def cache_path() -> Path:
    override = os.environ.get(CACHE_ENV)
    if override:
        return Path(override).expanduser()
    base = os.environ.get("LOCALAPPDATA") or str(Path.home())
    return Path(base) / "Synapse" / "wechat_db_keys.json"


def account_cache_id(account_dir: Path) -> str:
    try:
        normalized = str(account_dir.resolve()).lower()
    except OSError:
        normalized = str(account_dir).lower()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]


def read_cache() -> dict:
    path = cache_path()
    if not path.is_file():
        return {"version": 1, "keys": {}}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise SystemExit(f"[!] 缓存文件无法解析：{path}（{exc}）")
    if not isinstance(payload, dict) or payload.get("version") != 1:
        raise SystemExit(f"[!] 缓存文件版本不认识：{path}")
    payload.setdefault("keys", {})
    return payload


def write_cache(payload: dict) -> Path:
    path = cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    if os.name == "nt":
        user = os.environ.get("USERNAME") or ""
        if user:
            import subprocess

            subprocess.run(
                ["icacls", str(path), "/inheritance:r", "/grant:r", f"{user}:F"],
                capture_output=True,
                check=False,
            )
    else:
        os.chmod(path, 0o600)
    return path


# ---------------------------------------------------------------- 校验

def resolve_src(explicit: str | None) -> Path | None:
    if explicit:
        candidate = Path(explicit).expanduser()
        return candidate if (candidate / "wechat_context_exporter").is_dir() else None
    for candidate in SRC_CANDIDATES:
        if (candidate / "wechat_context_exporter").is_dir():
            return candidate
    return None


def verify_key(raw_key: bytes, db_path: Path, src: Path) -> tuple[bool, str]:
    if str(src) not in sys.path:
        sys.path.insert(0, str(src))
    try:
        from wechat_context_exporter.sources.wechat4_crypto import verify_account_key
    except ImportError as exc:
        return False, f"无法导入校验模块（{exc}）"
    with db_path.open("rb") as stream:
        first_page = stream.read(PAGE_SIZE)
    if len(first_page) < PAGE_SIZE:
        return False, "数据库首页读取不完整"
    return (True, "有效") if verify_account_key(raw_key, first_page) else (False, "已失效")


def find_db(account_dir: Path) -> Path | None:
    db = account_dir / "db_storage" / "message" / "message_0.db"
    return db if db.is_file() else None


# ---------------------------------------------------------------- 展示

def mask(raw_key: bytes) -> str:
    head = raw_key[:4].hex()
    tail = raw_key[-4:].hex()
    return f"{head}…{tail}（{len(raw_key)} 字节）"


def cmd_list(payload: dict) -> int:
    keys = payload.get("keys") or {}
    print(f"缓存文件：{cache_path()}")
    print(f"存在：{'是' if cache_path().is_file() else '否'} | 条目数：{len(keys)}")
    if not keys:
        print("\n暂无缓存。下次导出会走原生流程（重启微信 + 扫码），成功后自动写入。")
        return 0
    for cid, entry in keys.items():
        print(f"\n[{cid}]")
        print(f"  账户目录：{entry.get('account_dir')}")
        print(f"  抓取时间：{entry.get('captured_at')}")
        try:
            raw = bytes.fromhex(str(entry.get("raw_key_hex") or ""))
        except ValueError:
            print("  密钥：格式损坏")
            continue
        print(f"  密钥：{mask(raw)}" if len(raw) == 32 else f"  密钥：长度异常（{len(raw)}）")
        db = find_db(Path(str(entry.get("account_dir") or "")))
        print(f"  数据库：{db if db else '未找到 message_0.db'}")
    return 0


def cmd_verify(payload: dict, src_arg: str | None) -> int:
    src = resolve_src(src_arg)
    if src is None:
        print("[!] 找不到 wechat-ai-memory 的 src 目录，无法校验。用 --src 指定。")
        return 2
    keys = payload.get("keys") or {}
    if not keys:
        print("暂无缓存条目。")
        return 0
    rc = 0
    for cid, entry in keys.items():
        account_dir = Path(str(entry.get("account_dir") or ""))
        db = find_db(account_dir)
        label = f"[{cid}] {account_dir.name}"
        if db is None:
            print(f"{label} -> 跳过（找不到 message_0.db）")
            continue
        try:
            raw = bytes.fromhex(str(entry.get("raw_key_hex") or ""))
        except ValueError:
            print(f"{label} -> ✗ 密钥格式损坏")
            rc = 1
            continue
        ok, reason = verify_key(raw, db, src)
        print(f"{label} -> {'✓' if ok else '✗'} {reason}")
        rc = rc or (0 if ok else 1)
    return rc


def cmd_import(payload: dict, source: str, account_dir: Path, src_arg: str | None) -> int:
    origin = Path(source).expanduser()
    if origin.is_file():
        text = origin.read_text(encoding="utf-8", errors="replace")
    else:
        text = source
    raw_key_hex = "".join(ch for ch in text if ch in "0123456789abcdefABCDEF")
    if len(raw_key_hex) != 64:
        print(f"[!] 密钥应为 32 字节 / 64 位十六进制，实际解析出 {len(raw_key_hex)} 位")
        return 2
    raw_key = bytes.fromhex(raw_key_hex)
    db = find_db(account_dir)
    if db is None:
        print(f"[!] 账户目录下没有 db_storage/message/message_0.db：{account_dir}")
        return 2
    with db.open("rb") as stream:
        first_page = stream.read(PAGE_SIZE)
    src = resolve_src(src_arg)
    if src is not None:
        ok, reason = verify_key(raw_key, db, src)
        print(f"[*] 校验：{'✓' if ok else '✗'} {reason}")
        if not ok:
            print("[!] 密钥对该库无效，拒绝写入（避免缓存坏数据导致导出失败）")
            return 1
    else:
        print("[*] 未找到校验模块，跳过校验直接写入")
    payload.setdefault("keys", {})[account_cache_id(account_dir)] = {
        "account_dir": str(account_dir),
        "raw_key_hex": raw_key.hex(),
        "captured_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "first_page_sha256": hashlib.sha256(first_page).hexdigest(),
    }
    path = write_cache(payload)
    print(f"[✓] 已写入 {path}")
    return 0


def cmd_export(payload: dict, destination: Path, account_dir: Path | None) -> int:
    keys = payload.get("keys") or {}
    if account_dir is not None:
        entry = keys.get(account_cache_id(account_dir))
        if entry is None:
            print(f"[!] 缓存里没有该账户：{account_dir}")
            return 2
    elif len(keys) == 1:
        entry = next(iter(keys.values()))
    elif not keys:
        print("[!] 缓存为空")
        return 2
    else:
        print("[!] 缓存有多个账户，请用 --account 指定")
        return 2
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(str(entry.get("raw_key_hex") or ""), encoding="utf-8")
    print(f"[✓] 已导出明文密钥到 {destination}")
    print("[!] 这是明文密钥文件，用完请立即删除")
    return 0


def cmd_clear(payload: dict, account_dir: Path | None) -> int:
    keys = payload.get("keys") or {}
    if account_dir is None:
        payload["keys"] = {}
        print(f"[✓] 已清空全部 {len(keys)} 条缓存")
    else:
        cid = account_cache_id(account_dir)
        if cid not in keys:
            print("[!] 缓存里没有该账户")
            return 2
        keys.pop(cid)
        print(f"[✓] 已移除 [{cid}]")
    write_cache(payload)
    return 0


def default_account_dir() -> Path:
    root = Path(os.path.expanduser("~")) / "Documents" / "xwechat_files"
    if not root.is_dir():
        return root
    entries = [p for p in root.iterdir() if p.is_dir() and p.name.startswith("wxid_")]
    if not entries:
        return root
    entries.sort(key=lambda p: (p / "db_storage" / "message" / "message_0.db").stat().st_mtime
                 if (p / "db_storage" / "message" / "message_0.db").is_file() else 0, reverse=True)
    return entries[0]


def main() -> int:
    ap = argparse.ArgumentParser(description="微信数据库密钥缓存运维工具")
    ap.add_argument("--list", action="store_true", help="列出缓存（默认动作）")
    ap.add_argument("--verify", action="store_true", help="用真实数据库校验密钥是否仍有效")
    ap.add_argument("--import-hex", metavar="HEX_OR_FILE", help="导入 64 位十六进制密钥，或读自纯 hex 文件")
    ap.add_argument("--export", metavar="PATH", help="把明文十六进制密钥导出到文件")
    ap.add_argument("--clear", action="store_true", help="清除缓存")
    ap.add_argument("--account", metavar="DIR", help="指定微信账户目录（默认自动选最新）")
    ap.add_argument("--src", metavar="DIR", help="wechat-ai-memory 的 src 目录（用于校验）")
    args = ap.parse_args()

    account_dir = Path(args.account).expanduser() if args.account else default_account_dir()
    payload = read_cache()

    if args.import_hex:
        return cmd_import(payload, args.import_hex, account_dir, args.src)
    if args.export:
        return cmd_export(payload, Path(args.export).expanduser(),
                          Path(args.account).expanduser() if args.account else None)
    if args.clear:
        return cmd_clear(payload, Path(args.account).expanduser() if args.account else None)
    if args.verify:
        return cmd_verify(payload, args.src)
    return cmd_list(payload)


if __name__ == "__main__":
    sys.exit(main())
