#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""跑齐 A 侧全部测试。

    python tests/run_all.py

只依赖标准库。逐个子进程跑 run_*.py（彼此用不同端口，互不干扰），
汇总 PASS / FAIL，任一失败则退出码非 0（方便接 CI）。
"""
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))

# check_evidence.py 是共用测试桩（被其他用例 import），不单独跑
SUITES = [
    "run_kind_test.py",
    "run_source_test.py",
    "run_multiplatform_test.py",
    "run_image_form_test.py",
    "run_image_gate_test.py",
    "run_scan_pdf_test.py",
    "run_text_budget_test.py",
    "run_pdf_budget_test.py",
    "run_size_gate_test.py",
    "run_file_gate_test.py",
    "run_a4_test.py",
    "run_source_api_test.py",
    "run_ai_ingest_test.py",
]


def main():
    ok, bad = [], []
    t0 = time.time()
    for s in SUITES:
        path = os.path.join(HERE, s)
        if not os.path.isfile(path):
            print(f"  [SKIP] {s}（不存在）")
            continue
        t = time.time()
        r = subprocess.run([sys.executable, s], cwd=HERE,
                           capture_output=True, text=True, timeout=600)
        out = (r.stdout or "") + (r.stderr or "")
        passed = r.returncode == 0 or "ALL PASS" in out or "ALL CHECKS" in out
        (ok if passed else bad).append(s)
        mark = "PASS" if passed else "FAIL"
        print(f"  [{mark}] {s:<28} {time.time() - t:5.1f}s")
        if not passed:
            for line in out.splitlines():
                if "FAIL" in line or "Error" in line or "Traceback" in line:
                    print(f"         {line[:120]}")
    dt = time.time() - t0
    print(f"\n{len(ok)} passed, {len(bad)} failed  ({dt:.0f}s)")
    if bad:
        print("FAILED:", bad)
        sys.exit(1)
    print("ALL PASS")


if __name__ == "__main__":
    main()
