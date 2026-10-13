#!/usr/bin/env python3
"""把人工/模型作答的结果转换成题库补充文件 asset/extra.json。

用法：
    python3 tools/import_answers.py tools/extra_answers.txt [--out asset/extra.json] [--dry-run]

题目来自 zida/ 下两套卷子的导出明细：取其中「未作答」且当前题库里没有的题，
按去重后的顺序编号，与答案文件里的序号一一对应。

答案只接受能落到实际选项上的：
  - 单选题：字母必须落在选项范围内
  - 多选题：每个字母都要落在范围内
  - 判断题：必须是 正确 / 错误
任何一条对不上都会报错并跳过该题，不会猜。
"""

import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
LETTERS = "ABCDEFGH"
TYPE_NAMES = {1: "单选", 2: "多选", 3: "判断"}


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


def collect_missing():
    """按 zida/ 导出顺序收集「未作答且题库里没有」的题，并去重。"""
    bank_path = ROOT / "asset/questions.json"
    have = set()
    if bank_path.exists():
        # 按「题型 + 题干」判重。同一道题可能在不同卷子里分别是单选和判断
        # （例如判断题被渲染成「是/否」的选择题），那是两条独立条目。
        have = {(q["type"], normalize_stem(q["stem"])) for q in json.loads(bank_path.read_text(encoding="utf-8"))}

    zida = next((p for p in (ROOT / "zida", ROOT.parent / "zida") if p.is_dir()), None)
    if zida is None:
        raise SystemExit("找不到 zida 目录（既不在项目内，也不在上一级）")
    questions = []
    seen = set()
    for path in sorted(zida.glob("*.json")):
        report = json.loads(path.read_text(encoding="utf-8"))
        for question in report["questions"]:
            if question.get("answered"):
                continue
            key = (question["type"], normalize_stem(question["stem"]))
            if key in have or key in seen:
                continue
            seen.add(key)
            questions.append(question)
    return questions


def parse_answers(path):
    """答案是「题干<TAB>答案」一行一条，用题干做键——序号会随题库变化而位移。"""
    answers = {}
    for number, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), start=1):
        if line.lstrip().startswith("#") or not line.strip():
            continue
        if "\t" not in line:
            raise SystemExit(f"答案文件第 {number} 行缺少制表符分隔：{line!r}")
        stem, value = line.rsplit("\t", 1)
        answers[normalize_stem(stem)] = value.strip()
    return answers


def resolve(question, raw):
    """把答案文本落到选项上，返回 (correct 列表, 说明) 或 (None, 错误原因)。"""
    kind = question["type"]
    options = [option["text"] for option in question.get("options", [])]

    if kind == 3:
        value = {"对": "正确", "错": "错误"}.get(raw, raw)
        if value not in ("正确", "错误"):
            return None, f"判断题答案应为 正确/错误，收到 {raw!r}"
        return [value], ""

    letters = re.findall(r"[A-Za-z]", raw)
    if not letters:
        return None, f"选项题答案里没有字母：{raw!r}"
    if kind == 1 and len(letters) != 1:
        return None, f"单选题只能有一个字母，收到 {raw!r}"
    if kind == 2 and len(letters) < 2:
        return None, f"多选题至少要两个字母，收到 {raw!r}"

    picked = []
    for letter in letters:
        position = LETTERS.find(letter.upper())
        if position < 0 or position >= len(options):
            return None, f"字母 {letter} 超出选项范围（共 {len(options)} 项）"
        picked.append(normalize(options[position]))
    if len(set(picked)) != len(picked):
        return None, f"答案里有重复选项：{raw!r}"
    return picked, ""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("answers", help="答案文件")
    parser.add_argument("--out", default=str(ROOT / "asset/extra.json"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    questions = collect_missing()
    answers = parse_answers(args.answers)
    print(f"待补题目 {len(questions)} 道，答案文件 {len(answers)} 条")

    entries = []
    problems = []
    used = set()
    print("\n将写入的条目：")
    for index, question in enumerate(questions, start=1):
        key = normalize_stem(question["stem"])
        raw = answers.get(key)
        if raw is None:
            continue  # 故意没给答案，跳过
        used.add(key)
        correct, error = resolve(question, raw)
        if correct is None:
            problems.append((index, question["stem"][:40], error))
            print(f"  !! {index:>3}. [{TYPE_NAMES[question['type']]}] {question['stem'][:34]:36} {error}")
            continue
        entry = {
            "type": question["type"],
            "stem": normalize(question["stem"]),
            "correct": correct,
        }
        if question["type"] in (1, 2):
            entry["options"] = [normalize(option["text"]) for option in question["options"]]
        entries.append(entry)
        print(f"  OK {index:>3}. [{TYPE_NAMES[question['type']]}] {question['stem'][:34]:36} {raw:9} -> {correct}")

    unused = set(answers) - used
    print(f"\n可用答案 {len(entries)} 条，无法解析 {len(problems)} 条，答案文件里没用上的 {len(unused)} 条")
    for key in list(unused)[:10]:
        print(f"  ! 答案文件里的题干在本次待补清单中找不到：{key[:50]}")

    if args.dry_run:
        print("\n--dry-run：未写入文件")
        return

    out = Path(args.out)
    if out.exists():
        existing = json.loads(out.read_text(encoding="utf-8"))
        known = {(e["type"], normalize_stem(e["stem"])) for e in existing}
        entries = [e for e in entries if (e["type"], normalize_stem(e["stem"])) not in known]
        entries = existing + entries
    out.write_text(json.dumps(entries, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"\n已写出 {out}（共 {len(entries)} 条，{out.stat().st_size} 字节）")


if __name__ == "__main__":
    main()
