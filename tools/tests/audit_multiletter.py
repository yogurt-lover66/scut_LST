#!/usr/bin/env python3
"""审计并修正：源答案是多个字母、却只落了第一个字母的题库条目。

起因：import_paper_answers.py 早先按「第一个左括号之前的文字」取答案字母，
于是 `ABC（解释）` 和 `A（解释）；B（解释）` 两种写法都只剩 A，题目被当成
单选题入库——题型分池后永远匹配不上真正的多选题（页面上是真多选）。

判定依据（三选一即可）：
  · 真实答题明细里这道题的页面题型；
  · 题库里已有同题干的正确多选条目；
  · 源文件里作答者给出的多字母答案。

处理：
  · 已有正确多选条目 → 删掉那条假的单选条目（它永远不会被用到）；
  · 只有假条目     → 改成多选，取齐源答案里的所有选项。

用法：
    python3 tools/tests/audit_multiletter.py            # 只报告
    python3 tools/tests/audit_multiletter.py --apply    # 写回 asset/extra.json
"""

import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from import_paper_answers import (  # noqa: E402
    LETTERS, TYPE_NAMES, answer_letters, normalize_stem, zida_dir,
)

PAGE_NAMES = TYPE_NAMES


def page_types():
    """真实答题明细记录的页面题型：题干 -> {题型}。"""
    seen = {}
    for path in zida_dir().glob("safetest-答题明细*.json"):
        report = json.loads(path.read_text(encoding="utf-8"))
        for question in report["questions"]:
            seen.setdefault(normalize_stem(question["stem"]), set()).add(question["type"])
    return seen


def source_answers():
    """zida/*.txt 里填好的多字母答案：题干 -> {题干原文, 字母集合}。"""
    found = {}
    for path in sorted(zida_dir().glob("*.txt")):
        text = path.read_text(encoding="utf-8")
        for block in re.split(r"(?m)^###\s+", text)[1:]:
            head = re.match(r"\d+\.\s*(?:\[(单选|多选|判断)\]\s*)?(.+)", block.split("\n", 1)[0])
            if not head:
                continue
            stem = re.sub(r"[（(]\s*[）)]$", "", head.group(2).strip())
            answer = re.search(r"答案\s*[:：]\s*\*{0,2}\s*([^\n*]+)", block)
            if not answer:
                continue
            raw = answer.group(1).strip().rstrip("。").strip()
            if not raw:
                continue
            if "选项：对" in block or re.match(r"^(对|错|正确|错误)", re.split(r"[（(]", raw)[0].strip()):
                continue
            letters = answer_letters(raw)
            if len(letters) < 2:
                continue
            found.setdefault(normalize_stem(stem), {"stem": stem, "letters": set()})["letters"] |= set(letters)
    return found


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="把修正写回 asset/extra.json")
    args = parser.parse_args()

    extra_path = ROOT / "asset/extra.json"
    extra = json.loads(extra_path.read_text(encoding="utf-8"))
    bank = json.loads((ROOT / "asset/questions.json").read_text(encoding="utf-8"))

    bank_types = {}
    for question in bank:
        bank_types.setdefault(normalize_stem(question["stem"]), set()).add(question["type"])
    extra_by_stem = {}
    for index, entry in enumerate(extra):
        extra_by_stem.setdefault(normalize_stem(entry["stem"]), []).append(index)

    sources = source_answers()
    pages = page_types()

    used_stems = {normalize_stem(e["stem"]) for e in extra}
    converts, drops, unclear = [], [], []
    for key, source in sorted(sources.items()):
        want = sorted(source["letters"], key=LETTERS.find)
        for index in extra_by_stem.get(key, []):
            entry = extra[index]
            if len(entry["correct"]) != 1 or entry["type"] != 1:
                continue
            # 题库里已经有同题干的正确多选条目吗？（extra 里别的条目，或 tiku 来的）
            has_real = any(
                extra[other]["type"] == 2 and len(extra[other]["correct"]) > 1
                for other in extra_by_stem.get(key, [])
                if other != index
            ) or 2 in bank_types.get(key, set())
            if not has_real:
                # 要把字母换成选项文本，先确认这条的 options 与源答案的字母对得上。
                picked = [
                    entry["options"][LETTERS.find(letter)]
                    for letter in want
                    if LETTERS.find(letter) < len(entry["options"])
                ]
                if len(picked) != len(want):
                    unclear.append((entry["stem"], f"字母超出选项范围：{want} 共 {len(entry['options'])} 项"))
                    continue
                if picked[0] != entry["correct"][0]:
                    unclear.append((entry["stem"], f"字母与选项对不上：{want} → {picked[0]!r}，条目里是 {entry['correct'][0]!r}"))
                    continue
            else:
                picked = []
            page = sorted(PAGE_NAMES[t] for t in pages.get(key, set()))
            record = {"index": index, "stem": entry["stem"], "letters": want, "picked": picked, "page": page}
            (drops if has_real else converts).append(record)
            break

    print(f"源答案是多个字母的题干：{len(sources)} 个")
    print(f"  改成多选：{len(converts)} 条")
    for item in converts:
        print(f"    {item['stem'][:46]}")
        print(f"        {'、'.join(item['letters'])}  →  {' / '.join(item['picked'])}   页面证据 {item['page'] or '无'}")
    print(f"  已有正确多选条目、删掉假的单选：{len(drops)} 条")
    for item in drops:
        print(f"    {item['stem'][:46]}   页面证据 {item['page'] or '无'}")
    if unclear:
        print(f"  没敢动的：{len(unclear)} 条")
        for stem, why in unclear:
            print(f"    {stem[:46]} —— {why}")

    if not args.apply:
        print("\n（未写入。加 --apply 落地）")
        return

    drop_indexes = {item["index"] for item in drops}
    for item in converts:
        entry = extra[item["index"]]
        entry["type"] = 2 if len(item["letters"]) > 1 else 1
        entry["correct"] = item["picked"]
    merged = [e for i, e in enumerate(extra) if i not in drop_indexes]
    extra_path.write_text(json.dumps(merged, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"\n已写回 {extra_path}：改 {len(converts)} 条，删 {len(drops)} 条，共 {len(used_stems)} → {len(merged)} 条")


if __name__ == "__main__":
    main()
