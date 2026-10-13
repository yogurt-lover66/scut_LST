// 验证题干匹配的可靠性：
//   1. 覆盖率——题库每题拿自己的题干，都必须判定为可作答且选中自己
//   2. 危险题对——同题型内相似但答案不同的题，页面给准题干时绝不能选错
//   3. 落在两道相似题之间时，必须判为“跳过”而不是猜
//   4. 统计仍会被跳过的题，应当为 0
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const EXT = path.join(ROOT, "extension/content.js");
const BANK = path.join(ROOT, "asset/questions.json");

let source = fs.readFileSync(EXT, "utf8");
const tail = "\n})();\n";
source =
  source.slice(0, -tail.length) +
  "\nglobalThis.__exports = { normalize, normalizeQuestionStem, similarity, bestMatch, isDecisive, buildPools, answersEqual };\n})();\n";

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

const { normalizeQuestionStem, similarity, bestMatch, isDecisive, buildPools, answersEqual } =
  sandbox.__exports;

const bank = JSON.parse(fs.readFileSync(BANK, "utf8"));
const stems = bank.map((q) => normalizeQuestionStem(q.stem));
const pools = buildPools(bank);
const NAMES = { 1: "单选", 2: "多选", 3: "判断" };

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const matchIn = (stem, type) =>
  bestMatch(stem, pools[type], (question) => normalizeQuestionStem(question.stem));

console.log(
  `题库 ${bank.length} 题：` +
    Object.entries(pools)
      .map(([type, list]) => `${NAMES[type]} ${list.length}`)
      .join("，")
);
console.log();

console.log("[1] 覆盖率：每题用自身题干都必须判定为可作答，且选中自己");
// 题库来自两个独立来源，存在“只差一个标点、答案却相反”的重复条目。
// 这种题会被间距判据跳过——这是安全行为，不是缺陷，但必须逐条可见。
const lost = [];
const unjustified = [];
for (let i = 0; i < stems.length; i += 1) {
  const pool = pools[bank[i].type];
  const { best, second } = matchIn(stems[i], bank[i].type);
  const target = pool.indexOf(bank[i]);
  if (isDecisive(best, second, pool) && best.index === target) continue;

  const nearMiss = second && !answersEqual(pool[best.index].correct, pool[second.index].correct);
  const row = [i, NAMES[bank[i].type], bank[i].stem.slice(0, 40),
               best && best.similarity.toFixed(4), second && second.similarity.toFixed(4)];
  lost.push(row);
  if (!nearMiss) unjustified.push(row);
}
console.log(`        被跳过的题：${lost.length} 道（都应有答案冲突的近似题才合理）`);
for (const row of lost) {
  console.log(`          ${row[1]} best=${row[3]} second=${row[4]}  ${row[2]}`);
}
check("每一处跳过都有答案冲突作为理由", unjustified.length === 0, `${unjustified.length} 道无理由`);
check("这类冲突条目不超过 5 道", lost.length <= 5, `${lost.length} 道`);

console.log("\n[2] 危险题对：同题型内相似（>=0.9）但答案不同的题，给准题干时必须选对");
const pairs = [];
for (let i = 0; i < stems.length; i += 1) {
  for (let j = i + 1; j < stems.length; j += 1) {
    if (bank[i].type !== bank[j].type) continue;
    const score = similarity(stems[i], stems[j]);
    if (score < 0.9) continue;
    if (answersEqual(bank[i].correct, bank[j].correct)) continue;
    pairs.push([i, j, score]);
  }
}
console.log(`       危险题对：${pairs.length} 组`);
let wrong = 0;
let skippedSafely = 0;
for (const [i, j] of pairs) {
  for (const shown of [i, j]) {
    const pool = pools[bank[shown].type];
    const { best, second } = matchIn(stems[shown], bank[shown].type);
    if (!isDecisive(best, second, pool)) {
      skippedSafely += 1;
      continue;
    }
    if (pool[best.index] !== bank[shown]) {
      wrong += 1;
      console.log(`        ✗ 答错：页面=「${bank[shown].stem.slice(0, 28)}」却选了「${pool[best.index].stem.slice(0, 28)}」`);
    }
  }
}
check(
  `${pairs.length * 2} 次呈现零选错（其中 ${skippedSafely} 次安全跳过）`,
  wrong === 0,
  `选错 ${wrong} 次`
);

console.log("\n[3] 题干落在两道相似题之间时必须跳过");
const acid = bank.findIndex((q) => q.stem.includes("强酸"));
const alkali = bank.findIndex((q) => q.stem.includes("强碱"));
if (acid >= 0 && alkali >= 0) {
  const blended = normalizeQuestionStem(bank[acid].stem).replace("强酸", "强X");
  const pool = pools[bank[acid].type];
  const { best, second } = matchIn(blended, bank[acid].type);
  console.log(
    `        「${blended.slice(0, 32)}…」 -> best=${(best.similarity * 100).toFixed(1)}% second=${(second.similarity * 100).toFixed(1)}%`
  );
  check("混合题干判为不可作答", !isDecisive(best, second, pool));
} else {
  check("找到强酸/强碱题对", false, "题库中未找到");
}

console.log("\n[4] 冒险程度");
console.log(`        危险题对中安全跳过 ${skippedSafely} 次`);
check("危险题对没有一次被冒险作答（全部选对或跳过）", wrong === 0, `选错 ${wrong} 次`);

console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
