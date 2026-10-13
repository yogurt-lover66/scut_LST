#!/usr/bin/env python3
"""把大模型的答案与扩展的作答比对。

用法：
    python3 tools/compare_answers.py 答题明细.json 大模型答案.txt [标准答案.txt]

参数：
    答题明细.json   扩展导出的 safetest-答题明细.json
    大模型答案.txt  大模型的回答，形如 "1.B  2.正确  3.AC"，顺序不限、可换行
    标准答案.txt    可选。如果你有真实答案（例如交卷后平台显示的），
                    给出后可以算真正的正确率，而不只是两边的一致率。

注意：不给标准答案时，脚本只能报告“大模型与扩展的一致率”。
一致不等于正确——两边可能一起错。
"""

import json
import re
import sys
from collections import Counter
from pathlib import Path

# 匹配 "1.B" / "1、B" / "1 . B" / "2.正确" 等写法
ANSWER_PATTERN = re.compile(r"(\d+)\s*[.．、:：)）]\s*(正确|错误|对|错|[A-Fa-f]+)")


def load_llm_answers(path):
    text = Path(path).read_text(encoding="utf-8")
    answers = {}
    for number, value in ANSWER_PATTERN.findall(text):
        value = {"对": "正确", "错": "错误"}.get(value, value)
        answers[int(number)] = value.upper() if re.fullmatch(r"[A-Fa-f]+", value) else value
    return answers


def load_truth(path):
    if not path:
        return {}
    return load_llm_answers(path)


def canonical(value):
    """把多选答案的不同写法统一：'A,B'、'AB'、'A B'、'a、b' 都变成 'AB'。"""
    value = str(value or "").strip()
    if value and re.fullmatch(r"[A-Fa-f\s,，、]+", value):
        return "".join(sorted(set(re.findall(r"[A-Fa-f]", value.upper()))))
    return value


def extension_answer(question):
    """把扩展记录的选择转成与题库同构的表示。"""
    if not question.get("answered"):
        return ""
    if question.get("type") == 3:
        # 判断题在页面上是 A=对 / B=错
        return {"A": "正确", "B": "错误"}.get(question.get("picked", ""), "")
    return canonical(question.get("picked", ""))


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)

    payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    questions = payload["questions"]
    llm = load_llm_answers(sys.argv[2])
    truth = load_truth(sys.argv[3] if len(sys.argv) > 3 else None)

    print(f"扩展明细：{sys.argv[1]}")
    print(f"共 {len(questions)} 题，扩展作答 {sum(1 for q in questions if q['answered'])} 题")
    print(f"大模型答案：{len(llm)} 条")
    if truth:
        print(f"标准答案：{len(truth)} 条")

    kinds = Counter({1: "单选", 2: "多选", 3: "判断"})
    agree = disagree = missing = 0
    rows = []

    for index, question in enumerate(questions, start=1):
        mine = extension_answer(question)
        theirs = canonical(llm.get(index, ""))
        if not theirs:
            missing += 1
            continue
        if not mine:
            rows.append((index, "未作答", theirs, question))
            disagree += 1
            continue
        if mine == theirs:
            agree += 1
        else:
            disagree += 1
            rows.append((index, mine, theirs, question))

    compared = agree + disagree
    print()
    print(f"可比对 {compared} 题：一致 {agree}，不一致 {disagree}（大模型漏答 {missing}）")
    if compared:
        print(f"一致率 {agree / compared * 100:.1f}%")

    if truth:
        right_llm = right_mine = 0
        for index, question in enumerate(questions, start=1):
            expected = truth.get(index)
            if not expected:
                continue
            mine = extension_answer(question)
            if mine == canonical(expected):
                right_mine += 1
            if canonical(llm.get(index, "")) == canonical(expected):
                right_llm += 1
        graded = sum(1 for i in range(1, len(questions) + 1) if truth.get(i))
        if graded:
            print()
            print(f"有标准答案的 {graded} 题中：")
            print(f"  扩展  正确 {right_mine} 题，正确率 {right_mine / graded * 100:.1f}%")
            print(f"  大模型 正确 {right_llm} 题，正确率 {right_llm / graded * 100:.1f}%")

    if rows:
        print("\n不一致的题目：")
        for index, mine, theirs, question in rows[:40]:
            label = kinds.get(question["type"], "其它")
            print(f"\n  {index}. [{label}] {question['rawStem'][:58]}")
            print(f"     扩展：{mine or '（空）'}    大模型：{theirs}")
            if question.get("reason"):
                print(f"     扩展跳过原因：{question['reason']}")
        if len(rows) > 40:
            print(f"\n  ...另有 {len(rows) - 40} 条")


if __name__ == "__main__":
    main()
