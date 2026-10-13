# 题库维护（自用）

扩展日常使用不需要碰这里。这份说明只讲题库是怎么来的、缺题怎么补、改完怎么验。

## 一、题库是怎么来的

```
../tiku.txt  ──build_bank.py──┐
asset/extra.json ─────────────┴──►  asset/questions.json  （扩展实际读的题库）
```

```bash
python3 tools/build_bank.py
```

当前产出：**2776 道唯一题**（单选 939、多选 389、判断 1448），其中 **442 条来自 `asset/extra.json`** ——真实试卷里题库没覆盖、由人工/模型作答补齐的题。`extra.json` 在最后合并，所以 `tiku.txt` 里已有的题以原文为准。

`tiku.txt` 里并存**两套格式**，脚本都处理：

| | 格式 A（前半部分） | 格式 B（后半部分） |
|---|---|---|
| 题头 | `58、[单选题] 题干 （分值1.0）` | `1 多选题 题干` |
| 选项 | `• A. 文本` 逐行 | `A 文本`，空格分隔，可能整段挤在一行 |
| 答案 | `你未作答 标准答案： B` | `正确答案： A,B` |

脚本还会处理各种排版噪音：题干跨行、答案行与下一题挤在同一行、项目符号单独占一行、多个选项拼在同一行、整段题目挤在同一行。构建时会报告答案互相矛盾的条目。

## 二、缺题怎么补

每次考完，`zida/` 下会有扩展导出的 `safetest-跳过题.txt` 和 `safetest-答题明细*.json`。

```bash
# 1. 在跳过题每题的 **答案：** 后填答案：单选 B。  多选 A,B,D。  判断 错。
#    没填答案的题会被自动忽略，可以分几次填
python3 tools/import_paper_answers.py --dry-run   # 先看会导入什么
python3 tools/import_paper_answers.py
python3 tools/build_bank.py
```

没在扩展面板上点下载也没关系，可以事后从 `zida/` 里的答题明细重新导出缺题清单：

```bash
python3 tools/export_skipped.py     # 扫描 zida/*.json，写出 zida/待补题目.txt
```

零散答案也可以写成「题干<TAB>答案」放 `tools/extra_answers.txt`：

```bash
python3 tools/import_answers.py tools/extra_answers.txt --dry-run
python3 tools/import_answers.py tools/extra_answers.txt
```

几条规矩：

- 导入器**只接受能落到实际选项上的答案**：单选/多选的字母必须在选项范围内，判断题必须是 正确/错误。对不上的直接报错跳过，不会猜。
- 答案文件用**题干做键而不是序号**——序号会随题库重建而位移，题干不会。
- **题型决定条目落在哪个匹配池，写错就永远匹配不上。** 扩展导出的跳过题带 `[单选]/[多选]/[判断]` 前缀，导入器优先采信；手写的文件没有前缀，才按答案里的字母个数推断，只有一个正确项的多选题会被推错。
- 宁可让扩展跳过，也不放一个可能错的答案进库——不确定的题就不补。
- > **注意执行顺序。** 导入脚本是按「已构建的题库」筛缺题的，所以改过归一化或想完全重建时，要先把 `extra.json` 移走、重建一次基础题库，再跑导入，最后再重建一次。否则筛出来是 0 道。

## 三、改完怎么验

```bash
export NODE_PATH=/tmp/safetest-test/node_modules   # 或自行 npm i jsdom
node tools/tests/margin.js         # 全库可作答？危险题对会不会选错？
node tools/tests/harness.js        # jsdom 仿真考试页跑端到端
node tools/tests/real-papers.test.js  # 拿 zida 里的真实试卷回归（基线 301/302）
node tools/tests/popup.test.js     # popup 失败分支不许跳转
python3 tools/tests/roundtrip.py   # 导出 -> 填答案 -> 导入 往返
```

改过导入逻辑后，复查「答案是多字母、却只落了第一个字母」的条目（这类会被当成单选，永远匹配不上多选页面）：

```bash
python3 tools/tests/audit_multiletter.py           # 对照真实试卷里的页面题型给出建议
python3 tools/tests/audit_multiletter.py --apply   # 确实要改时
```

`compare_answers.py` 用来把扩展的答案和另一份答案（大模型、平台公布的标准答案）比对：

```bash
python3 tools/compare_answers.py 答题明细.json 另一份答案.txt [标准答案.txt]
```
