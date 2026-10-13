#!/usr/bin/env python3
"""把试卷里“跳过且题库未覆盖”的题导出成待补清单。

用法：
    python3 tools/export_skipped.py [--out zida/待补题目.txt]

输出格式与 zida/1.txt、2.txt 一致，答案处留空：

    ### 1. 题干

    - A. 选项甲
    - B. 选项乙

    **答案：**

所以补完答案后，直接跑 `python3 tools/import_paper_answers.py` 就能入库，
不需要再做任何格式转换。没填答案的题会被导入器自动忽略。

跳过原因写在每题的 `# 跳过原因：…` 行里——它不会被解析（选项正则只认
`- A.` 这种行），纯粹给你作参考。
"""

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TYPE_NAMES = {1: "单选", 2: "多选", 3: "判断"}


def normalize(text):
    text = str(text or "")
    chars = []
    for ch in text:
        code = ord(ch)
        if code == 0x3000:
            chars.append(" ")
        elif 0xFF01 <= code <= 0xFF5E:
            chars.append(chr(code - 0xFEE0))
        else:
            chars.append(ch)
    text = "".join(chars)
    for left, right in (("“", '"'), ("”", '"'), ("‘", "'"), ("’", "'")):
        text = text.replace(left, right)
    text = re.sub(r"[（(]\s*[）)]", "", text)
    text = re.sub(r"\s+", "", text).strip()
    return re.sub(r"[。.]$", "", text)


def normalize_stem(text):
    return re.sub(r"^(?:第)?\d+(?:题)?[.．、:：)）]?", "", normalize(text))


def find_zida():
    for candidate in (ROOT / "zida", ROOT.parent / "zida"):
        if candidate.is_dir():
            return candidate
    raise SystemExit("找不到 zida 目录（既不在项目内，也不在上一级）")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=None, help="输出路径，默认 zida/待补题目.txt")
    parser.add_argument("--force", action="store_true", help="即使目标文件里已填了答案也覆盖")
    args = parser.parse_args()

    zida = find_zida()
    out = Path(args.out) if args.out else zida / "待补题目.txt"

    # 这个文件是给人填答案的，覆盖会把已填的答案冲掉。
    # 踩过一次：填完还没导库时又跑了一次本脚本，答案全没了。
    if out.exists() and not args.force:
        filled = len(re.findall(r"(?m)^\*\*答案：(?!\*\*).+\*\*$", out.read_text(encoding="utf-8")))
        if filled:
            raise SystemExit(
                f"{out} 里已经有 {filled} 条填好的答案，覆盖会丢掉它们。\n"
                f"先把答案导进题库：python3 tools/import_paper_answers.py\n"
                f"确实要覆盖就加 --force。"
            )

    bank_path = ROOT / "asset/questions.json"
    have = set()
    if bank_path.exists():
        have = {
            (q["type"], normalize_stem(q["stem"]))
            for q in json.loads(bank_path.read_text(encoding="utf-8"))
        }

    reports = sorted(zida.glob("safetest-答题明细*.json"))
    if not reports:
        raise SystemExit(f"{zida} 下没有 safetest-答题明细*.json")

    seen = {}
    in_bank = []
    total_skipped = 0
    for path in reports:
        report = json.loads(path.read_text(encoding="utf-8"))
        for question in report["questions"]:
            if question.get("answered"):
                continue
            total_skipped += 1
            key = (question["type"], normalize_stem(question["stem"]))
            if key in seen:
                continue
            seen[key] = question
            if key in have:
                in_bank.append(question)

    todo = [q for key, q in seen.items() if key not in have]

    lines = [
        "# SafeTest 待补题目",
        "#",
        "# 用法：在每题的 **答案：** 后面填答案，然后跑",
        "#     python3 tools/import_paper_answers.py",
        "#",
        "# 填法：",
        "#   单选 → 字母，如  **答案：B。**",
        "#   多选 → 逗号分隔，如  **答案：A,B,D。**",
        "#   判断 → 对 或 错，如  **答案：错。**",
        "#",
        "# 不填或留着空的题会被导入器自动忽略，不会污染题库。",
        f"# 本清单共 {len(todo)} 题。",
        "",
        "",
    ]
    for index, question in enumerate(todo, start=1):
        stem = re.sub(r"[（(]\s*[）)]$", "", question["rawStem"].strip())
        # 带上题型：单选的池子和多选的池子是分开的，不能靠字母个数反推。
        lines.append(f"### {index}. [{TYPE_NAMES[question['type']]}] {stem}")
        lines.append("")
        if question["type"] == 3:
            lines.append("选项：对 / 错。")
        else:
            for option in question["options"]:
                lines.append(f"- {option['letter']}. {option['text']}")
        lines.append("")
        lines.append(f"# 跳过原因：{question['reason']}")
        lines.append("**答案：**")
        lines.append("")

    out.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(f"扫描 {len(reports)} 套卷子，跳过合计 {total_skipped} 题（去重后 {len(seen)} 题）")
    print(f"  已经覆盖、不用管的：{len(in_bank)} 题")
    print(f"  仍需补的：        {len(todo)} 题")
    kinds = Counter(TYPE_NAMES[q["type"]] for q in todo)
    if todo:
        print(f"    题型：{'，'.join(f'{k} {v}' for k, v in sorted(kinds.items()))}")
    print(f"\n已写出 {out}")

    if todo:
        print("\n仍需要补的题：")
        for index, question in enumerate(todo, start=1):
            print(f"  {index:3d}. [{TYPE_NAMES[question['type']]}] {question['stem'][:50]}")
            print(f"        {question['reason']}")


if __name__ == "__main__":
    main()
