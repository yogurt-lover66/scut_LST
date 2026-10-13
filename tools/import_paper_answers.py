#!/usr/bin/env python3
"""把 zida/*.txt（带答案的整卷文本）导入题库补充文件 asset/extra.json。

文件格式：

    ### 18. 在作业场所液化气浓度较高时，应该佩戴（）。

    - A. 面罩
    - B. 口罩

    **答案：A（面罩，按考试系统答案）。**

判断题没有选项列表，写成：

    ### 41. 进入化学、化工、生物、医学类实验室，可以不穿实验服

    选项：对 / 错。

    **答案：错。**

用法：
    python3 tools/import_paper_answers.py [--dry-run]
"""

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
LETTERS = "ABCDEFGH"
TYPE_NAMES = {1: "单选", 2: "多选", 3: "判断"}
KIND_BY_NAME = {"单选": 1, "多选": 2, "判断": 3}


def zida_dir():
    """zida 目录可能在项目内，也可能在上一级（用户挪过位置）。"""
    for candidate in (ROOT / "zida", ROOT.parent / "zida"):
        if candidate.is_dir():
            return candidate
    raise SystemExit("找不到 zida 目录（既不在项目内，也不在上一级）")


def normalize(text):
    """与 extension/content.js、build_bank.py 保持一致。"""
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


def answer_letters(raw_answer):
    """从答案文本里取选项字母。

    写法很杂：「A」「ABC」「A,B,D」「A（面罩）；B（口罩）」。只认每段开头的字母，
    括号里的解释不参与——早先的写法是按第一个括号截断，于是
    「A（解释）；B（解释）」只剩 A，多选题被当成单选入库，永远匹配不上。
    """
    letters = []
    for segment in re.split(r"[；;，,、\s]+", str(raw_answer or "")):
        segment = segment.strip()
        if not segment:
            continue
        head = re.split(r"[（(]", segment, maxsplit=1)[0].strip()
        if re.fullmatch(r"[A-Ha-h]+", head):
            letters.extend(head.upper())
            continue
        match = re.match(r"([A-Ha-h])(?![A-Za-z])", head)
        if match:
            letters.append(match.group(1).upper())
    return letters


def parse_paper(path):
    """解析一份整卷文本，返回 [{stem, options, raw_answer, judge}]。"""
    text = path.read_text(encoding="utf-8")
    questions = []
    for block in re.split(r"^###\s+", text, flags=re.M)[1:]:
        first_line = block.split("\n", 1)[0]
        # 题型标记可选：扩展导出的跳过题里带 [多选] 这类前缀，
        # 早先的文件和手写的整卷文本没有，就靠答案字母个数推断。
        head = re.match(r"\d+\.\s*(?:\[(单选|多选|判断)\]\s*)?(.+)", first_line)
        if not head:
            continue
        kind = KIND_BY_NAME.get(head.group(1)) if head.group(1) else None
        stem = re.sub(r"[（(]\s*[）)]$", "", head.group(2).strip())

        answer_match = re.search(r"答案\s*[:：]\s*\*{0,2}\s*([^\n*]+)", block)
        if not answer_match:
            continue
        raw_answer = answer_match.group(1).strip().rstrip("。").strip()

        options = [
            normalize(match.group(2))
            for match in re.finditer(r"^\s*[-*•]?\s*([A-H])\s*[.、．)）]\s*(.+?)\s*$", block, re.M)
        ]
        judge = kind == 3 or bool(re.search(r"选项\s*[:：]\s*对\s*[/／]\s*错", block))
        questions.append(
            {
                "stem": stem,
                "options": options,
                "raw_answer": raw_answer,
                "judge": judge,
                "kind": kind,
            }
        )
    return questions


def build_entry(question):
    """转成题库条目，无法确定时返回 (None, 原因)。"""
    stem = normalize(question["stem"])
    # 答案常带括号注释，如「对（旧题库常见答案）」「A（面罩，按考试系统答案）」，
    # 只取括号前的部分。
    raw = re.split(r"[（(]", question["raw_answer"], maxsplit=1)[0].strip()

    if question["judge"] or not question["options"]:
        value = {"对": "正确", "错": "错误"}.get(raw, raw)
        if value not in ("正确", "错误"):
            return None, f"按判断题处理但答案是 {raw!r}"
        return {"type": 3, "stem": stem, "correct": [value]}, ""

    letters = answer_letters(question["raw_answer"])
    if not letters:
        return None, f"答案里没有选项字母：{raw!r}"
    options = question["options"]
    picked = []
    for letter in letters:
        position = LETTERS.find(letter.upper())
        if position < 0 or position >= len(options):
            return None, f"字母 {letter} 超出选项范围（共 {len(options)} 项）"
        picked.append(options[position])
    if len(set(picked)) != len(picked):
        return None, f"答案有重复选项：{raw!r}"

    # 有题型标记就以标记为准，没有才按字母个数推断。
    # 推断对“只有一个正确项的多选题”会判错，标记能避免这一点。
    declared = question.get("kind")
    if declared == 1 and len(picked) != 1:
        return None, f"标为单选却给了 {len(picked)} 个答案：{raw!r}"
    entry_type = declared if declared in (1, 2) else (2 if len(picked) > 1 else 1)

    return {
        "type": entry_type,
        "stem": stem,
        "options": options,
        "correct": picked,
    }, ""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    out = ROOT / "asset/extra.json"
    known = set()
    existing = []
    if out.exists():
        existing = json.loads(out.read_text(encoding="utf-8"))
        known = {(e["type"], normalize_stem(e["stem"])) for e in existing}
    bank_path = ROOT / "asset/questions.json"
    if bank_path.exists():
        known |= {
            (q["type"], normalize_stem(q["stem"]))
            for q in json.loads(bank_path.read_text(encoding="utf-8"))
        }

    files = sorted(zida_dir().glob("*.txt"))
    print(f"整卷文件：{[p.name for p in files]}")

    added = []
    problems = []
    skipped = 0
    for path in files:
        questions = parse_paper(path)
        print(f"\n{path.name}: 解析出 {len(questions)} 题")
        for question in questions:
            entry, error = build_entry(question)
            if entry is None:
                problems.append((question["stem"][:40], error))
                continue
            key = (entry["type"], normalize_stem(entry["stem"]))
            if key in known:
                skipped += 1
                continue
            known.add(key)
            added.append(entry)
            print(f"  + [{TYPE_NAMES[entry['type']]}] {entry['stem'][:38]:40} {question['raw_answer'][:20]:22} -> {entry['correct']}")

    print(f"\n新增 {len(added)} 条，题库已有跳过 {skipped} 条，无法解析 {len(problems)} 条")
    for stem, error in problems:
        print(f"  !! {stem} —— {error}")

    if args.dry_run:
        print("\n--dry-run：未写入文件")
        return

    merged = existing + added
    out.write_text(json.dumps(merged, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"\n已写出 {out}（共 {len(merged)} 条）")


if __name__ == "__main__":
    main()
