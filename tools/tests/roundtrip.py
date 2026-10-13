#!/usr/bin/env python3
"""端到端校验「扩展导出跳过题 -> 填答案 -> 导入题库」这条链路。

扩展 content.js 里的 skippedPayload() 和 tools/import_paper_answers.py 的
parse_paper() 必须保持同一套格式。两边分别演进时很容易悄悄改坏，而且不会报错
——只会变成“导出的文件导不回去”。这个脚本就是守这条的。

用法：
    python3 tools/tests/roundtrip.py

需要先装好 jsdom（harness.js 用），装法见 tools/tests/README.md。
"""

import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "tools"))

from import_paper_answers import build_entry, parse_paper  # noqa: E402

RUN_DIR = Path("/tmp/safetest-test/last-run")
HARNESS = HERE / "harness.js"


def run_harness():
    """跑 harness，它会把自己的三份导出写到 RUN_DIR。"""
    env = dict(os.environ)
    node_path = env.get("NODE_PATH", "")
    for candidate in ("/tmp/safetest-test/node_modules",):
        if candidate not in node_path.split(":"):
            node_path = f"{candidate}:{node_path}" if node_path else candidate
    env["NODE_PATH"] = node_path

    result = subprocess.run(
        ["node", str(HARNESS)], cwd=ROOT, env=env, capture_output=True, text=True
    )
    if result.returncode != 0:
        print(result.stdout[-2000:])
        print(result.stderr[-2000:], file=sys.stderr)
        raise SystemExit("harness.js 运行失败；先确认 jsdom 已安装（见 tools/tests/README.md）")


def main():
    run_harness()

    exported = RUN_DIR / "safetest-跳过题.txt"
    if not exported.exists():
        raise SystemExit(f"harness 没有生成 {exported}")

    failures = 0

    def check(name, ok, detail=""):
        nonlocal failures
        if ok:
            print(f"  PASS  {name}")
        else:
            failures += 1
            print(f"  FAIL  {name}{f' — {detail}' if detail else ''}")

    text = exported.read_text(encoding="utf-8")
    print(f"扩展导出的跳过题文件：{exported}")
    print()

    check("扩展导出非空", len(text) > 100)
    check("含用法说明", "import_paper_answers.py" in text)
    check("题干用 ### 编号", bool(re.search(r"(?m)^### 1\. ", text)))
    check("选项是 - A. 形式", bool(re.search(r"(?m)^- A\. ", text)))
    check("带跳过原因", "# 跳过原因：" in text)
    check("答案位留空", "**答案：**" in text)

    # 留空时导入器必须忽略，否则会把没答案的题塞进题库
    check("答案留空时导入器解析出 0 题", len(parse_paper(exported)) == 0,
          f"实际 {len(parse_paper(exported))} 题")

    # 填上答案后必须能解析并落到选项文本
    filled = Path("/tmp/safetest-test/filled-skipped.txt")
    filled.write_text(text.replace("**答案：**", "**答案：B。**"), encoding="utf-8")
    parsed = parse_paper(filled)
    check("填了答案后能解析出题目", len(parsed) > 0, f"实际 {len(parsed)} 题")

    entries = []
    for question in parsed:
        entry, error = build_entry(question)
        if entry is None:
            check(f"能转成题库条目：{question['stem'][:30]}", False, error)
        else:
            entries.append(entry)
    check("每道填了答案的题都能转成条目", len(entries) == len(parsed))
    if entries:
        first = entries[0]
        check("答案落到了具体选项上", bool(first["correct"]) and all(first["correct"]))
        print(f"        样例：{first['stem'][:34]} -> {first['correct']}")

    print()
    print("全部通过" if failures == 0 else f"{failures} 项失败")
    sys.exit(0 if failures == 0 else 1)


if __name__ == "__main__":
    main()
