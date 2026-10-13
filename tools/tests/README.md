# 测试

这两个脚本会把 `extension/content.js` **真实加载**进 Node（用桩件顶替 `chrome`、`document`）后测试，而不是另写一份复制品。

## popup.test.js

无需额外依赖：

```bash
node tools/tests/popup.test.js
```

用桩件加载 `extension/popup.js`，覆盖点击后的四条分支：脚本已在监听、站点上但脚本已失效（补注入）、补注入也失败、不在站点上。

重点是回归：**在站点页面启动失败时绝不能跳转**——否则会把用户正在看的试卷页面冲掉。

## real-papers.test.js

无需额外依赖（需要 `zida/` 下真实试卷的导出明细）：

```bash
node tools/tests/real-papers.test.js
```

把真实试卷里当时**没答出来**的题重新喂给当前匹配逻辑，看能救回多少。这是唯一用真实数据测匹配的用例，改归一化或判据后一定要跑。

当前基线：**301/302（99.7%）**。剩下的题要么是题库确实没有的，要么是同一道题在不同卷子里选项排版不同（合并/缩短）导致的。

## roundtrip.py

需要 `jsdom`（会先跑一遍 harness.js 生成样本）：

```bash
python3 tools/tests/roundtrip.py
```

校验「扩展导出跳过题 → 填答案 → 导入题库」这条链路。扩展 `content.js` 里的 `skippedPayload()` 和 `tools/import_paper_answers.py` 里的 `parse_paper()` 必须保持同一套格式，两边分别演进时很容易悄悄改坏——而且不会报错，只会变成"导出的文件导不回去"。这个脚本就是守这条的。

## margin.js

无需额外依赖：

```bash
node tools/tests/margin.js
```

校验题干匹配的“最佳/次佳间距”判据：覆盖率无损失、危险题对不选错、混合题干判为跳过、全库最小间距高于阈值。

## harness.js

需要 `jsdom`（仅测试用，不是扩展的依赖）：

```bash
npm install jsdom          # 或在任意目录安装后设置 NODE_PATH
node tools/tests/harness.js
```

用 jsdom 搭一个仿真的考试页（DOM 结构按 `do-*.js`、`answer-form-*.js` 的 render 函数还原，并模拟 Element Plus 的选中态行为），跑完整答题流程：打乱的选项顺序、判断题的对/错、题号前缀、题库未匹配、多选题、以及“从不点击提交按钮”。
