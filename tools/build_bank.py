#!/usr/bin/env python3
"""把 tiku.txt 转换成扩展使用的题库 asset/questions.json。

用法：
    python3 tools/build_bank.py [源文件] [输出文件]

源文件默认为 ../tiku.txt，输出默认为 ../asset/questions.json。

tiku.txt 里并存两套格式，本脚本都处理：

格式 A（前半部分）—— 逐行、带方括号与分值：

    58、[单选题] 电分强电和弱电。下列说法正确的是： （分值1.0）
    • A. 强电和弱电开关等元件可通用
    B. 弱电开关等元件不可用在强电电路
    你未作答 标准答案： B

格式 B（后半部分）—— 空格分隔、可能整段挤在一行、支持多选：

    1 多选题 从事结构破坏试验的过程中需按要求（ ）。 A 戴安全帽 B 穿长袖工作服
    C 穿绝缘鞋 正确答案： A,B
    2 判断题 举升机可以在机械锁止情况下长期举升重物。 正确答案： 错

已知的排版噪音，本脚本都会处理：题干跨行、答案行与下一题头挤在同一行、
项目符号单独占一行、多个选项拼在同一行、整段题目挤在同一行。
"""

import json
import re
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_SRC = HERE.parent.parent / "tiku.txt"
DEFAULT_OUT = HERE.parent / "asset" / "questions.json"

LETTERS = "ABCDEFGH"

# ---------- 格式 A ----------
A_HEADER = re.compile(
    r"(\d+)\s*[、.．]\s*\[(单选题|判断题|多选题)\]\s*(.*?)（分值[^）]*）",
    re.S,
)
A_ANSWER = re.compile(r"标准答案\s*[:：]\s*(正确|错误|对|错|[A-Za-z])")
A_OPTION_START = re.compile(r"[•·▪]?\s*([A-Za-z])\s*[、.．:：)）]?\s*")

# ---------- 格式 B ----------
B_HEADER = re.compile(
    r"(\d+)\s+(单选题|判断题|多选题)\s+(.*?)正确答案\s*[:：]\s*([^\s]+)",
    re.S,
)
# 选项边界：两侧都是空白的一个大写字母，且必须是 A、B、C… 依次出现
B_OPTION_BOUNDARY = re.compile(r"(?<=\s)([A-H])(?=\s)")

ANSWER_VALUES = {"对": "正确", "错": "错误", "正确": "正确", "错误": "错误"}


def normalize(text):
    """归一化文本以便与网页上抓到的题干/选项比对。"""
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
    # 去掉空占位符，与 extension/content.js 的 normalize 保持一致。
    text = re.sub(r"[（(]\s*[）)]", "", text)
    text = re.sub(r"\s+", "", text).strip()
    return re.sub(r"[。.]$", "", text)


def split_options_sequential(region, pattern):
    """按“字母依次出现”的规则切分选项区域。

    只在字母正好等于下一个期望字母时切分，避免题干里的
    “维生素A.” 之类被误判成选项边界。
    """
    starts = []
    for match in pattern.finditer(region):
        letter = match.group(1).upper()
        if letter != LETTERS[len(starts)]:
            continue
        starts.append((match.start(), match.end()))
    if not starts:
        return [region], []

    stem = region[: starts[0][0]]
    options = []
    for index, (_, end) in enumerate(starts):
        stop = starts[index + 1][0] if index + 1 < len(starts) else len(region)
        options.append(region[end:stop])
    return [stem], [normalize(option) for option in options if normalize(option)]


def parse_format_a(text):
    questions = []
    stats = Counter()
    headers = list(A_HEADER.finditer(text))

    for index, match in enumerate(headers):
        _number, kind, stem = match.group(1), match.group(2), match.group(3)
        block_end = headers[index + 1].start() if index + 1 < len(headers) else len(text)
        block = text[match.end():block_end]

        answer_match = A_ANSWER.search(block)
        if not answer_match:
            stats["A: 缺少答案行"] += 1
            continue
        answer = ANSWER_VALUES.get(answer_match.group(1), answer_match.group(1))
        stem = normalize(stem)
        if not stem:
            stats["A: 题干为空"] += 1
            continue

        if kind == "判断题":
            questions.append({"type": 3, "stem": stem, "correct": [answer]})
            continue

        # 答案行常与最后一个选项同行（“…严重窒息你未作答 标准答案： C”）
        region = block[: answer_match.start()]
        if "你未作答" in region:
            region = region.rsplit("你未作答", 1)[0]

        if kind == "多选题":
            # 格式 A 的题库里没有多选，真出现了按字母逐个取
            letters = re.findall(r"[A-Za-z]", answer)
        else:
            letters = [answer]

        _, options = split_options_sequential(region, A_OPTION_START)
        if len(options) < 2:
            stats["A: 选项不足 2"] += 1
            continue
        picked = []
        for letter in letters:
            position = LETTERS.find(letter.upper())
            if position < 0 or position >= len(options):
                break
            picked.append(options[position])
        if len(picked) != len(letters):
            stats["A: 答案字母超出选项范围"] += 1
            continue
        questions.append(
            {
                "type": 2 if len(picked) > 1 else 1,
                "stem": stem,
                "options": options,
                "correct": picked,
            }
        )
    return questions, stats


def parse_format_b(text):
    questions = []
    stats = Counter()

    for match in B_HEADER.finditer(text):
        _number, kind, body, answer = match.groups()
        answer = answer.strip().rstrip("，,、")

        if kind == "判断题":
            value = ANSWER_VALUES.get(answer)
            if not value:
                stats[f"B: 判断答案异常 {answer[:10]}"] += 1
                continue
            stem = normalize(body)
            if stem:
                questions.append({"type": 3, "stem": stem, "correct": [value]})
            else:
                stats["B: 题干为空"] += 1
            continue

        letters = re.findall(r"[A-Za-z]", answer)
        if not letters:
            stats[f"B: 答案异常 {answer[:10]}"] += 1
            continue

        stem_parts, options = split_options_sequential(body, B_OPTION_BOUNDARY)
        if kind == "多选题" and len(options) < 2:
            stats["B: 多选题选项不足 2"] += 1
            continue
        if kind == "单选题" and len(options) < 2:
            stats["B: 单选题选项不足 2"] += 1
            continue

        picked = []
        for letter in letters:
            position = LETTERS.find(letter.upper())
            if position < 0 or position >= len(options):
                break
            picked.append(options[position])
        if len(picked) != len(letters):
            stats["B: 答案字母超出选项范围"] += 1
            continue

        stem = normalize(stem_parts[0])
        if not stem:
            stats["B: 题干为空"] += 1
            continue
        questions.append(
            {
                "type": 2 if len(picked) > 1 else 1,
                "stem": stem,
                "options": options,
                "correct": picked,
            }
        )
    return questions, stats


def dedupe(questions):
    """同一题干保留第一条；记录答案互相矛盾的组。"""
    seen = {}
    conflicts = []
    for question in questions:
        key = (question["type"], question["stem"])
        if key not in seen:
            seen[key] = question
            continue
        if set(seen[key]["correct"]) != set(question["correct"]):
            conflicts.append((question["stem"], seen[key]["correct"], question["correct"]))
    return list(seen.values()), conflicts


def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SRC
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_OUT
    if not src.exists():
        raise SystemExit(f"找不到源文件：{src}")

    text = src.read_text(encoding="utf-8")

    # 两套格式的回答标记互不重叠，按最后一个格式 A 的答案行切开即可。
    markers = [m.start() for m in re.finditer(r"你未作答\s*标准答案", text)]
    if markers:
        cut = text.index("\n", markers[-1]) + 1
    else:
        cut = 0
    text_a, text_b = text[:cut], text[cut:]
    print(f"格式 A 区段 {len(text_a)} 字符，格式 B 区段 {len(text_b)} 字符")

    questions_a, stats_a = parse_format_a(text_a)
    questions_b, stats_b = parse_format_b(text_b)
    print(f"格式 A 解析出 {len(questions_a)} 题")
    print(f"格式 B 解析出 {len(questions_b)} 题")

    combined = questions_a + questions_b

    # 补充题库（人工或模型作答，由 tools/import_answers.py 生成）。
    # 放在后面，题库原文优先——同一题干以 tiku.txt 为准。
    extra_path = out.parent / "extra.json"
    if extra_path.exists():
        extra = json.loads(extra_path.read_text(encoding="utf-8"))
        print(f"补充题库 {extra_path.name}：{len(extra)} 条")
        combined = combined + extra

    unique, conflicts = dedupe(combined)

    kinds = Counter(question["type"] for question in unique)
    names = {1: "单选", 2: "多选", 3: "判断"}
    print(f"\n去重后 {len(unique)} 题：" + "  ".join(f"{names[k]} {v}" for k, v in sorted(kinds.items())))
    for stats, label in ((stats_a, "A"), (stats_b, "B")):
        if stats:
            print(f"格式 {label} 跳过：")
            for key, count in stats.most_common():
                print(f"  {count:6d}  {key}")
    print(f"答案矛盾的题干 {len(conflicts)} 组（保留第一条）")
    for stem, first, second in conflicts[:8]:
        print(f"  {stem[:34]}  已保留={first}  另见={second}")

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps(unique, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"\n已写出 {out}  ({out.stat().st_size} 字节)")


if __name__ == "__main__":
    main()
