// 用 jsdom 搭一个仿真的华工考试页，真实加载 extension/content.js 跑答题流程。
// DOM 结构来自试卷页分包 do-*.js 与 answer-form-*.js 的 render 函数还原。
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "..", "..");
const EXT = path.join(ROOT, "extension/content.js");
const BANK = path.join(ROOT, "asset/questions.json");

const bank = JSON.parse(fs.readFileSync(BANK, "utf8"));
const byStem = (fragment) => bank.find((q) => q.stem.includes(fragment));

// ---- 仿真页面里的 Element Plus 行为：点击 input 后切换选中态 ----
const EP_BEHAVIOR = `
  document.addEventListener("click", (event) => {
    const input = event.target.closest
      ? event.target.closest('input[type="radio"], input[type="checkbox"]')
      : null;
    if (!input) return;
    if (input.type === "radio") {
      const group = input.closest(".el-radio-group") || input.closest(".question-options");
      if (group) {
        for (const other of group.querySelectorAll('input[type="radio"]')) {
          other.checked = other === input;
          const label = other.closest("label");
          if (label) label.classList.toggle("is-checked", other === input);
        }
      }
    } else {
      // 复选框的 checked 已由浏览器原生翻转，这里只同步 Element Plus 的类名。
      const label = input.closest("label");
      if (label) label.classList.toggle("is-checked", input.checked);
    }
  }, true);
`;

function singleChoice(id, stem, options, base) {
  const items = options
    .map(
      (text, index) => `
      <label class="el-radio">
        <span class="el-radio__input"><input type="radio" class="el-radio__original" value="${base + index}"></span>
        <span class="el-radio__label"><div class="option-wrapper"><span>${String.fromCharCode(65 + index)}.</span><span class="option">${text}</span></div></span>
      </label>`
    )
    .join("");
  return shell(id, stem, `<div class="el-radio-group">${items}</div>`);
}

function judgement(id, stem) {
  return shell(
    id,
    stem,
    `<div class="el-radio-group">
      <label class="el-radio"><span class="el-radio__input"><input type="radio" class="el-radio__original" value="true"></span><span class="el-radio__label">对</span></label>
      <label class="el-radio"><span class="el-radio__input"><input type="radio" class="el-radio__original" value="false"></span><span class="el-radio__label">错</span></label>
    </div>`
  );
}

function multiChoice(id, stem, options, base) {
  const items = options
    .map(
      (text, index) => `
      <label class="el-checkbox">
        <span class="el-checkbox__input"><input type="checkbox" class="el-checkbox__original" value="${base + index}"></span>
        <span class="el-checkbox__label"><div class="option-wrapper"><span>${String.fromCharCode(65 + index)}.</span><span class="option">${text}</span></div></span>
      </label>`
    )
    .join("");
  return shell(id, stem, `<div class="el-checkbox-group">${items}</div>`);
}

function shell(id, stem, optionsHtml) {
  return `
  <div class="question-bottom-line test-questions" id="question-${id}">
    <div class="qeustion-item-box">
      <div class="question-order">${id}.</div>
      <div class="question-content">
        <div class="question-title">${stem}</div>
        <div class="question-options">${optionsHtml}</div>
      </div>
    </div>
  </div>`;
}

function page(body) {
  return `<!doctype html><html><body>
    <div class="test-container">
      <main class="test-content"><div class="el-card paper-question-card"><div class="el-form">
        <div class="el-row"><div class="test-title">单选题</div><div class="test-questions">${body}</div></div>
      </div></div></main>
      <button class="test-submit-btn" id="submit-paper">提交试卷</button>
    </div>
  </body></html>`;
}

// ---- 组装试卷：覆盖各种情况 ----
const q1 = byStem("电分强电和弱电");        // 题库中的单选
const q2 = byStem("各种电源是否有电");       // 题库中的判断，答案=错误
const q3 = byStem("铣床加工工作结束后");      // 题库中的判断，答案=正确

const shuffled = [q1.options[2], q1.options[0], q1.options[1], q1.options[3]]; // 故意打乱

const q4 = byStem("使用剧毒药品时应该"); // 题库中的多选，答案为两项

const questions = [
  {
    node: singleChoice(1, q1.stem, shuffled, 1001),
    expect: [String(1001 + shuffled.indexOf(q1.correct[0]))],
    label: "单选·选项顺序被打乱",
  },
  { node: judgement(2, "第2题 " + q2.stem + "  "), expect: ["false"], label: "判断·错误+题号前缀" },
  { node: judgement(3, q3.stem), expect: ["true"], label: "判断·正确" },
  { node: singleChoice(4, "这是一道完全无关的占位题目？", ["甲", "乙", "丙"], 2001), expect: [], label: "题库未匹配→跳过" },
  {
    // 页面上把正确项夹在干扰项之间，且第 2 项在扩展介入前已被选中，
    // 用来验证多选会同时“清掉不该选的”和“补上该选的”。
    node: multiChoice(5, q4.stem, [q4.correct[0], "随便乱放", q4.correct[1]], 3001),
    expectedValues: [3001, 3003],
    preselect: [3002],
    label: "多选·选中全部正确项并清掉已选的错误项",
  },
];

const dom = new JSDOM(page(questions.map((q) => q.node).join("")), {
  runScripts: "outside-only",
  url: "https://zhsys.sb.scut.edu.cn/#/exam/test/do/1234567890123456789",
});
const { window } = dom;
window.eval(EP_BEHAVIOR);

// 记录是否有人点过交卷按钮
let submitClicked = false;
window.document.getElementById("submit-paper").addEventListener("click", () => {
  submitClicked = true;
});

// 模拟“用户先前已经选了一些选项”，用来验证扩展会不会清掉错误项
for (const item of questions) {
  for (const value of item.preselect || []) {
    const input = window.document.querySelector(`input[value="${value}"]`);
    if (input) {
      input.checked = true;
      const label = input.closest("label");
      if (label) label.classList.add("is-checked");
    }
  }
}

// 截获下载内容，用来检查导出的格式
const downloads = [];
class FakeBlob {
  constructor(parts) {
    this.text = parts.join("");
  }
}

// ---- 桩件 ----
let messageListener = null;
const sandbox = {
  window,
  document: window.document,
  location: window.location,
  setTimeout,
  clearTimeout,
  console,
  Promise,
  Array,
  String,
  Boolean,
  Date,
  Math,
  Set,
  Map,
  JSON,
  fetch: async (url) => {
    const file = String(url).replace(/^chrome-extension:\/\/[^/]+\//, "");
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8")),
    };
  },
  chrome: {
    runtime: {
      getURL: (file) => `chrome-extension://test/${file}`,
      onMessage: { addListener: (fn) => { messageListener = fn; } },
    },
    storage: { local: { get: async () => ({}), remove: async () => {} } },
  },
  Blob: FakeBlob,
  URL: {
    createObjectURL: (blob) => {
      downloads.push(blob.text);
      return "blob:test";
    },
    revokeObjectURL: () => {},
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const source = fs.readFileSync(EXT, "utf8");
vm.runInContext(source, sandbox, { filename: EXT });

// ---- 断言 ----
let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function selectedValues(id) {
  const node = window.document.getElementById(`question-${id}`);
  return Array.from(node.querySelectorAll("input"))
    .filter((input) => input.checked)
    .map((input) => input.value);
}

async function main() {
  console.log(`题库共 ${bank.length} 题；试卷 ${questions.length} 题\n`);

  if (!messageListener) throw new Error("content.js 没有注册 onMessage 监听");
  messageListener({ type: "SAFE_TEST_AUTO_ANSWER_START" }, {}, () => {});

  // 等状态面板出现完成/错误提示
  const deadline = Date.now() + 60000;
  let panelText = "";
  while (Date.now() < deadline) {
    const panel = window.document.getElementById("safe-test-status");
    panelText = panel ? panel.textContent : "";
    if (/答题完成|已停止/.test(panelText)) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  console.log("状态面板：");
  console.log(panelText.split("\n").map((line) => "    " + line).join("\n"));
  console.log();

  for (const item of questions) {
    const id = item.node.match(/id="question-(\d+)"/)[1];
    const actual = selectedValues(id).sort();
    const expected = (item.expectedValues || item.expect || []).map(String).sort();
    check(
      item.label,
      actual.length === expected.length && actual.every((value, i) => value === expected[i]),
      `选中了 ${JSON.stringify(actual)}，期望 ${expected.length ? JSON.stringify(expected) : "空白"}`
    );
  }

  const buttons = Array.from(window.document.querySelectorAll("#safe-test-status button"));
  const findButton = (fragment) => buttons.find((button) => button.textContent.includes(fragment));

  check("跑完后面板提供三个导出按钮", buttons.length === 3, `实际 ${buttons.length} 个`);
  check(
    "按钮可点击（面板本身不挡页面）",
    buttons.every((button) => button.style.pointerEvents === "auto")
  );

  check("有跳过时才有「下载跳过题」按钮", Boolean(findButton("下载跳过题")));
  check(
    "跳过题按钮标出题数",
    (findButton("下载跳过题") || {}).textContent?.includes("1 题"),
    (findButton("下载跳过题") || {}).textContent
  );

  findButton("下载题目（给大模型）").click();
  findButton("下载答题明细").click();
  findButton("下载跳过题").click();
  const [txt, jsonText, skippedText] = downloads;

  check("三个按钮都产生了下载", downloads.length === 3, `实际 ${downloads.length} 次`);
  check("txt 版本带题号和题型", /1\. \[单选\]/.test(txt), (txt || "").slice(0, 60));
  check("txt 版本带选项字母", /\nA\. /.test(txt) && /\nB\. /.test(txt));
  check("txt 版本含判断题且无选项行", /\[判断\]/.test(txt));
  check(
    "txt 版本不含扩展自己的答案（避免大模型照抄）",
    !/匹配度|相似度|已作答|跳过|正确答案/.test(txt),
    (txt || "").match(/匹配度|相似度|已作答|跳过|正确答案/)?.[0]
  );

  const parsed = JSON.parse(jsonText);
  check("json 版本可解析且题目数一致", parsed.questions.length === questions.length);
  check(
    "json 版本记录了实际选中的选项",
    parsed.questions[0].picked === "C" && parsed.questions[0].pickedText.length > 0,
    JSON.stringify(parsed.questions[0].picked)
  );
  check(
    "json 版本保留了原始题干与选项文本",
    parsed.questions[0].rawStem.includes("电分强电和弱电") &&
      parsed.questions[0].options.length === 4
  );
  check(
    "跳过题在 json 里 answered=false 且带原因",
    parsed.questions[3].answered === false && parsed.questions[3].reason.length > 0
  );

  // 把导出结果落盘，交给 test-roundtrip 用真实导入器验证格式能被吃下。
  const outDir = "/tmp/safetest-test/last-run";
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(`${outDir}/safetest-题目.txt`, txt);
  fs.writeFileSync(`${outDir}/safetest-答题明细.json`, jsonText);
  fs.writeFileSync(`${outDir}/safetest-跳过题.txt`, skippedText);

  check("跳过题导出只含未作答的题", /^### 1\. /m.test(skippedText) && !/^### 2\. /m.test(skippedText));
  check("跳过题导出带选项字母", /\n- A\. /.test(skippedText));
  check("跳过题导出带跳过原因", /# 跳过原因：题库未匹配/.test(skippedText));
  check("跳过题导出留了答案位（可直接填完入库）", /\*\*答案：\*\*/.test(skippedText));
  check(
    "跳过题导出不含扩展自己的答案",
    !/(已作答|匹配度)/.test(skippedText),
    (skippedText || "").match(/已作答|匹配度/)?.[0]
  );

  check("全程从未点击交卷按钮", !submitClicked);
  check(
    "完成提示里说明了不会自动交卷",
    /不会自动交卷/.test(panelText),
    panelText.slice(0, 80)
  );

  console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("测试异常：", error);
  process.exit(1);
});
