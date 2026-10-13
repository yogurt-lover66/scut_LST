// 用 zida/ 里两套真实试卷的导出结果做回归：
// 把当时跳过的题重新喂给当前匹配逻辑，看能救回多少。
//
// 这两套卷子是真实数据，所以这个测试能反映“改了归一化/判据之后，实战有没有变好”。
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const EXT = path.join(ROOT, "extension/content.js");
const BANK = path.join(ROOT, "asset/questions.json");
const COMPARE_BASELINE = Number(process.env.BASELINE || 0);

let source = fs.readFileSync(EXT, "utf8");
source =
  source.slice(0, -"\n})();\n".length) +
  "\nglobalThis.__exports = { normalize, normalizeQuestionStem, bestMatch, isDecisive, buildPools };\n})();\n";

const sandbox = {
  chrome: {
    runtime: { getURL: (p) => p, onMessage: { addListener() {} } },
    storage: { local: { get: async () => ({}), remove: async () => {} } },
  },
  document: {},
  console,
  setTimeout,
  clearTimeout,
  fetch: async () => ({}),
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: EXT });

const { normalize, normalizeQuestionStem, bestMatch, isDecisive, buildPools } = sandbox.__exports;
const bank = JSON.parse(fs.readFileSync(BANK, "utf8"));
const pools = buildPools(bank);
const NAMES = { 1: "单选", 2: "多选", 3: "判断" };

// zida 目录可能在项目内，也可能在上一级。
const ZIDA = [path.join(ROOT, "zida"), path.join(ROOT, "..", "zida")].find((dir) =>
  fs.existsSync(dir)
);
if (!ZIDA) throw new Error("找不到 zida 目录");
const files = fs
  .readdirSync(ZIDA)
  .filter((name) => name.endsWith(".json"))
  .sort();

let total = 0;
let matched = 0;
const remaining = [];
const recovered = [];

for (const file of files) {
  const report = JSON.parse(fs.readFileSync(path.join(ZIDA, file), "utf8"));
  for (const question of report.questions) {
    if (question.answered) continue; // 当时已经答出来的不再评估
    total += 1;

    const pool = pools[question.type] || [];
    const { best, second } = bestMatch(
      normalizeQuestionStem(question.stem),
      pool,
      (entry) => normalizeQuestionStem(entry.stem)
    );

    if (!isDecisive(best, second, pool)) {
      remaining.push({
        stem: question.stem,
        reason:
          best && best.similarity >= 0.92
            ? "答案冲突"
            : `相似度 ${Math.round(((best && best.similarity) || 0) * 100)}%`,
        similarity: (best && best.similarity) || 0,
      });
      continue;
    }

    const entry = pool[best.index];
    // 导出里存的是页面原始文本（保留全角标点），题库里是归一化后的，
    // 两边都要归一化才能比。扩展本身走的也是归一化后的文本。
    const pageOptions = new Set(question.options.map((option) => normalize(option.text)));
    // 页面上判断题的选项文本是「对/错」，题库里存的是「正确/错误」，
    // 内容脚本是按 value 的 true/false 走这条分支的，这里做等价换算。
    const missing =
      question.type === 3
        ? entry.correct.filter((text) => {
            const expected = text === "正确" ? "对" : "错";
            return !pageOptions.has(text) && !pageOptions.has(expected);
          })
        : entry.correct.filter((text) => !pageOptions.has(text));
    if (missing.length) {
      // 题干匹配上了，但正确选项在页面上找不到——多选尤其容易这样
      remaining.push({
        stem: question.stem,
        reason: `选项对不上(${missing.length}/${entry.correct.length})`,
        similarity: best.similarity,
      });
      continue;
    }

    matched += 1;
    recovered.push({ stem: question.stem, similarity: best.similarity, answer: entry.correct });
  }
}

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

console.log(`真实试卷：${files.length} 套，当时跳过 ${total} 题\n`);

console.log("本次修复后新匹配上的：");
for (const row of recovered.slice(0, 15)) {
  console.log(`  ${(row.similarity * 100).toFixed(0)}%  ${row.stem.slice(0, 42)}  -> ${JSON.stringify(row.answer).slice(0, 40)}`);
}

const reasons = {};
for (const row of remaining) reasons[row.reason] = (reasons[row.reason] || 0) + 1;
console.log("\n仍跳过的原因分布：");
for (const [reason, count] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${reason}`);
}

const nearMiss = remaining.filter((row) => row.similarity >= 0.8);
console.log(`\n仍跳过但相似度 >=80% 的：${nearMiss.length} 道`);
for (const row of nearMiss.slice(0, 10)) {
  console.log(`  ${(row.similarity * 100).toFixed(0)}%  ${row.stem.slice(0, 46)}  (${row.reason})`);
}

console.log();
// 回归基线：归一化去掉空占位符后，这两套卷子应当至少救回 10 道。
// 这个数字掉下来说明匹配逻辑退化了。
check(`至少救回 10 道（回归基线）`, matched >= 10, `实际 ${matched} 道`);
// 判据宁可不答也不答错：高相似度的近失手必须是个位数，
// 否则说明阈值或间距判据放得太松。
check("相似度 80%~92% 的近失手不超过 3 道", nearMiss.length <= 3, `${nearMiss.length} 道`);

console.log(`\n匹配 ${matched}/${total} 题（${((matched / total) * 100).toFixed(1)}%）`);
console.log(`${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
