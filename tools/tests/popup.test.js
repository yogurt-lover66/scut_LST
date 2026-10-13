// 用桩件加载 extension/popup.js，验证点击后的四种分支。
// 重点是回归：在站点页面启动失败时，绝不能把用户正在看的页面跳转走。
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..");
const POPUP = path.join(ROOT, "extension/popup.js");
const EXAM_URL = "https://zhsys.sb.scut.edu.cn/#/exam/test/do/1234567890123456789";

let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// 跑一次 popup.js，返回点击后的调用记录。
async function runPopup({ url, sendMessage, executeScript }) {
  const calls = { update: [], inject: 0, removed: 0, sets: 0 };
  let clickHandler = null;

  const startElement = {
    disabled: false,
    addEventListener: (type, handler) => {
      if (type === "click") clickHandler = handler;
    },
  };
  const statusElement = { textContent: "" };

  const sandbox = {
    console,
    document: {
      getElementById: (id) => (id === "start" ? startElement : statusElement),
    },
    URL,
    chrome: {
      tabs: {
        query: async () => [{ id: 7, url }],
        sendMessage: async (...args) => sendMessage(...args),
        update: async (tabId, options) => {
          calls.update.push({ tabId, ...options });
        },
      },
      scripting: {
        executeScript: async (options) => {
          calls.inject += 1;
          if (executeScript === "throw") throw new Error("Cannot access contents of the page");
          return [{ result: null }];
        },
      },
      storage: {
        local: {
          set: async () => {
            calls.sets += 1;
          },
          remove: async () => {
            calls.removed += 1;
          },
        },
      },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(POPUP, "utf8"), sandbox, { filename: POPUP });

  if (!clickHandler) throw new Error("popup.js 没有注册按钮点击回调");
  await clickHandler();
  return { calls, status: statusElement.textContent };
}

async function main() {
  console.log("[1] 页面上已有 content script");
  {
    const { calls, status } = await runPopup({
      url: EXAM_URL,
      sendMessage: async () => ({ started: true }),
    });
    check("提示已开始", /已开始/.test(status), status);
    check("不注入脚本", calls.inject === 0);
    check("不跳转页面", calls.update.length === 0);
  }

  console.log("\n[2] 在站点上但脚本已失效（扩展重载过）——注入后应成功");
  {
    let attempt = 0;
    const { calls, status } = await runPopup({
      url: EXAM_URL,
      sendMessage: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("Could not establish connection");
        return { started: true };
      },
    });
    check("注入了一次脚本", calls.inject === 1, `注入 ${calls.inject} 次`);
    check("提示已开始", /已开始/.test(status), status);
    check("不跳转页面", calls.update.length === 0, JSON.stringify(calls.update));
  }

  console.log("\n[3] 回归：站点页面注入也失败时，绝不能跳转走");
  {
    const { calls, status } = await runPopup({
      url: EXAM_URL,
      sendMessage: async () => {
        throw new Error("Could not establish connection");
      },
      executeScript: "throw",
    });
    check("没有调用 tabs.update（不会冲掉试卷页面）", calls.update.length === 0, JSON.stringify(calls.update));
    check("提示用户刷新页面", /刷新/.test(status), status);
    check("清掉了运行标记，避免留下悬空状态", calls.removed === 1, `remove ${calls.removed} 次`);
  }

  console.log("\n[4] 不在站点上时导航过去");
  {
    const { calls, status } = await runPopup({
      url: "https://example.com/",
      sendMessage: async () => {
        throw new Error("Could not establish connection");
      },
    });
    check("跳转到考试列表", calls.update.length === 1 && calls.update[0].url.includes("/home/exam/index"), JSON.stringify(calls.update));
    check("不注入脚本", calls.inject === 0);
    check("提示登录后自动继续", /登录/.test(status), status);
  }

  console.log("\n[5] sendMessage 返回空值也算失败");
  {
    const { calls, status } = await runPopup({
      url: EXAM_URL,
      sendMessage: async () => undefined,
      executeScript: "throw",
    });
    check("按失败处理且不跳转", calls.update.length === 0);
    check("提示刷新", /刷新/.test(status), status);
  }

  console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("测试异常：", error);
  process.exit(1);
});
