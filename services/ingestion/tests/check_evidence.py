#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
A 环节 · 成本最低测试桩 (check_evidence.py)
=========================================
纯标准库实现，零第三方依赖。用来验证「解析服务」产出的对象是否符合
TruthTrace 的 EvidenceSchema（见 truthtrace/src/lib/contracts.ts）。

三种用法（都不需要启动 Next.js / 不需要 GPU / 不需要 Windows 真机）：

1) 自检校验器本身（零网络、零依赖）：
   python check_evidence.py --self-test

2) 离线校验本地 JSON（支持 {evidence:{...}} 或直接是 evidence 对象）：
   python check_evidence.py --file path/to/evidence.json
   python check_evidence.py --file path/to/evidence.json --expect-kind chat

3) 向运行中的解析服务 POST 一个文件，校验它返回的 evidence：
   python check_evidence.py --url http://localhost:8000/parse --upload some.pdf
   python check_evidence.py --url http://localhost:8000/parse --upload x.png --expect-kind image

退出码：0=通过，1=失败，2=用法错误。可接进 CI / 批处理循环里逐环节验证。
"""

import sys
import json
import argparse
import base64
import re
import urllib.request
import urllib.error
import mimetypes

VALID_KINDS = {"text", "chat", "image", "pdf"}

# B 的 openai-compatible.ts 把 kind=image 的 content 原样当 image_url 发给视觉模型，
# 所以 content 必须是「模型能吃的图片 data URL」。这两个常量把该不变量固化下来。
VISION_MIMES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
IMAGE_DATA_URL_RE = re.compile(r"^data:(image/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$")


def check_image_payload(content):
    """校验 kind=image 的 content 是合法、可解码、模型可读的图片 data URL。

    这是真 bug 的护栏：A 曾对扫描件 PDF 发过 data:application/pdf、
    对缺失媒体发过一段中文占位文本——两者都会被模型 API 拒绝，导致 analyze 502。
    """
    m = IMAGE_DATA_URL_RE.match(content.strip())
    if not m:
        return ("kind=image 时 content 必须是 data:<image mime>;base64,<...>；"
                "不能是纯文本占位或非图片 data URL")
    mime, b64 = m.group(1).lower(), m.group(2)
    if mime not in VISION_MIMES:
        return f"视觉模型不支持 {mime}（只接受 png/jpeg/webp/gif），应转码或降级为 text"
    try:
        if not base64.b64decode(b64):
            return "base64 解码为空"
    except Exception as e:
        return f"base64 无法解码: {e}"
    return None


def validate(evidence):
    """镜像 contracts.ts 的 EvidenceSchema，返回错误列表（空=通过）。"""
    errors = []
    if not isinstance(evidence, dict):
        return ["evidence 不是 JSON 对象"]
    if not isinstance(evidence.get("id"), str) or not evidence["id"].strip():
        errors.append("id 必须是非空字符串")
    if not isinstance(evidence.get("name"), str) or not evidence["name"].strip():
        errors.append("name 必须是非空字符串")
    kind = evidence.get("kind")
    if kind not in VALID_KINDS:
        errors.append(f"kind 必须是 {sorted(VALID_KINDS)} 之一，收到: {kind!r}")
    if not isinstance(evidence.get("mimeType"), str) or not evidence["mimeType"].strip():
        errors.append("mimeType 必须是非空字符串")
    content = evidence.get("content")
    if not isinstance(content, str) or not content.strip():
        errors.append("content 必须是非空字符串")
    elif kind == "image":
        problem = check_image_payload(content)
        if problem:
            errors.append(problem)
    if "source" in evidence and evidence["source"] is not None \
            and not isinstance(evidence["source"], str):
        errors.append("source 若存在必须是字符串")
    return errors


def extract_evidence(data):
    """服务返回可能是 {evidence:{...}} 或直接是 evidence 对象（parser.ts 用 evidence ?? result）。"""
    if isinstance(data, dict) and "evidence" in data:
        return data["evidence"]
    return data


def print_result(ev, errors, expect_kind=None):
    if errors:
        print("FAIL x")
        for e in errors:
            print("  - " + e)
        return False
    if expect_kind and ev.get("kind") != expect_kind:
        print(f"FAIL x kind 期望 {expect_kind} 实际 {ev.get('kind')}")
        return False
    print("PASS OK")
    print(f"  id={ev.get('id')} | name={ev.get('name')} | kind={ev.get('kind')} | mimeType={ev.get('mimeType')}")
    c = ev.get("content", "")
    print(f"  content({len(c)} chars): {c[:80]}{'...' if len(c) > 80 else ''}")
    return True


def self_test():
    cases = [
        ({"id": "1", "name": "t", "kind": "text", "mimeType": "text/plain", "content": "hi"}, True),
        ({"id": "", "name": "t", "kind": "text", "mimeType": "x", "content": "hi"}, False),
        ({"id": "1", "name": "t", "kind": "unknown", "mimeType": "x", "content": "hi"}, False),
        ({"id": "1", "name": "t", "kind": "image", "mimeType": "image/png",
          "content": "data:image/png;base64,iVBORw0KGgo="}, True),
        ({"id": "1", "name": "t", "kind": "image", "mimeType": "application/pdf",
          "content": "data:application/pdf;base64,iVBORw0KGgo="}, False),
        ({"id": "1", "name": "t", "kind": "image", "mimeType": "image/bmp",
          "content": "data:image/bmp;base64,iVBORw0KGgo="}, False),
        ({"id": "1", "name": "t", "kind": "image", "mimeType": "text/plain",
          "content": "[媒体文件缺失: docs/hetong.pdf]"}, False),
        ({"id": "1", "name": "t", "kind": "chat", "mimeType": "text/plain",
          "content": "张三: 在吗\n我: 在的", "source": "微信"}, True),
    ]
    ok = True
    for ev, exp in cases:
        errs = validate(ev)
        got = (len(errs) == 0)
        mark = "ok" if got == exp else "MISMATCH"
        if got != exp:
            ok = False
        print(f"  [{mark}] expect_valid={exp} -> kind={ev.get('kind')} errors={errs}")
    print("SELF-TEST", "PASS OK" if ok else "FAIL x")
    return ok


def check_file(path, expect_kind=None):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    ev = extract_evidence(data)
    return print_result(ev, validate(ev), expect_kind)


def check_url(url, upload, expect_kind=None):
    mt = mimetypes.guess_type(upload)[0] or "application/octet-stream"
    boundary = "----aingesttestboundary"
    filename = upload.replace("\\", "/").split("/")[-1]
    with open(upload, "rb") as f:
        raw = f.read()
    head = (
        f"--{boundary}\r\n"
        f"Content-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n"
        f"Content-Type: {mt}\r\n\r\n"
    ).encode("utf-8")
    tail = f"\r\n--{boundary}--\r\n".encode("utf-8")
    data = head + raw + tail
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print("FAIL x HTTP", e.code, e.read().decode("utf-8", "ignore")[:200])
        return False
    except Exception as e:  # noqa: BLE001
        print("FAIL x", repr(e))
        return False
    ev = extract_evidence(payload)
    return print_result(ev, validate(ev), expect_kind)


def check_bundle(payload):
    """校验 {evidences:[...]}，逐条校验。返回 (all_ok, evidences)。"""
    evs = payload.get("evidences") if isinstance(payload, dict) else None
    if not isinstance(evs, list) or not evs:
        print("FAIL x 未找到非空 evidences 数组")
        return False, []
    all_ok = True
    for i, ev in enumerate(evs):
        errs = validate(ev)
        if errs:
            all_ok = False
            print(f"  [{i}] FAIL x kind={ev.get('kind')} errors={errs}")
        else:
            c = ev.get("content", "")
            print(f"  [{i}] PASS OK kind={ev.get('kind')} content({len(c)} chars)")
    return all_ok, evs


def check_bundle_file(path):
    with open(path, encoding="utf-8") as f:
        payload = json.load(f)
    ok, _ = check_bundle(payload)
    return ok


def check_bundle_url(url, chat_file, expect_kinds=None):
    with open(chat_file, encoding="utf-8") as f:
        records = json.load(f)
    data = json.dumps({"records": records}).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print("FAIL x HTTP", e.code, e.read().decode("utf-8", "ignore")[:200])
        return False
    except Exception as e:  # noqa: BLE001
        print("FAIL x", repr(e))
        return False
    ok, evs = check_bundle(payload)
    if ok and expect_kinds:
        kinds = [e.get("kind") for e in evs]
        missing = set(expect_kinds) - set(kinds)
        if missing:
            print(f"FAIL x 期望包含 kind {expect_kinds}，实际 {kinds}（缺 {sorted(missing)}）")
            return False
    return ok


def main():
    ap = argparse.ArgumentParser(description="A 环节 Evidence 契约测试桩")
    ap.add_argument("--self-test", action="store_true", help="自检校验器本身")
    ap.add_argument("--file", help="离线校验本地 JSON 文件（evidence 或 {evidence}）")
    ap.add_argument("--url", help="解析服务地址，如 http://localhost:8000/parse")
    ap.add_argument("--upload", help="要 POST 的文件路径")
    ap.add_argument("--expect-kind", help="断言返回的 kind（text/chat/image/pdf）")
    ap.add_argument("--bundle-url", help="聊天 bundle 服务地址，如 http://localhost:8000/parse_chat")
    ap.add_argument("--chat-file", help="聊天记录 JSON 文件（records 数组），配合 --bundle-url")
    ap.add_argument("--bundle-file", help="离线校验本地 bundle JSON（含 evidences 数组）")
    ap.add_argument("--expect-kinds", help="断言 bundle 包含的 kind 集合，逗号分隔，如 chat,image")
    args = ap.parse_args()

    if args.self_test:
        sys.exit(0 if self_test() else 1)
    if args.bundle_file:
        sys.exit(0 if check_bundle_file(args.bundle_file) else 1)
    if args.bundle_url and args.chat_file:
        eks = args.expect_kinds.split(",") if args.expect_kinds else None
        sys.exit(0 if check_bundle_url(args.bundle_url, args.chat_file, eks) else 1)
    if args.file:
        sys.exit(0 if check_file(args.file, args.expect_kind) else 1)
    if args.url and args.upload:
        sys.exit(0 if check_url(args.url, args.upload, args.expect_kind) else 1)
    ap.print_help()
    sys.exit(2)


if __name__ == "__main__":
    main()
