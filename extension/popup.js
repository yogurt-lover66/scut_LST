const EXAM_TARGET_URL = "https://zhsys.sb.scut.edu.cn/#/home/exam/index";
const SITE_HOST = "zhsys.sb.scut.edu.cn";
const AUTO_RUN_KEY = "safeTestAutoRun";
const startButton = document.getElementById("start");
const status = document.getElementById("status");

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isSiteUrl(url) {
  try {
    return new URL(url).hostname === SITE_HOST;
  } catch (_) {
    return false;
  }
}

async function notify(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "SAFE_TEST_AUTO_ANSWER_START",
    });
    return Boolean(response?.started);
  } catch (_) {
    return false;
  }
}

async function fail(message) {
  await chrome.storage.local.remove(AUTO_RUN_KEY);
  status.textContent = message;
  startButton.disabled = false;
}

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  status.textContent = "正在启动……";

  const tab = await activeTab();
  if (!tab?.id) {
    await fail("没有找到当前标签页。");
    return;
  }

  await chrome.storage.local.set({ [AUTO_RUN_KEY]: Date.now() });

  // 1) 页面上已经有 content script 在监听
  if (await notify(tab.id)) {
    status.textContent = "已开始，请查看网页右上角状态。";
    return;
  }

  const onSite = isSiteUrl(tab.url);

  // 2) 已在站点上但没有监听者：多半是页面在扩展安装/重载之前就打开了，
  //    此时 content script 已被回收。手动注入一次再通知。
  if (onSite) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["extension/content.js"],
      });
      if (await notify(tab.id)) {
        status.textContent = "已开始，请查看网页右上角状态。";
        return;
      }
    } catch (error) {
      console.error("SafeTest 注入失败：", error);
    }
    // 关键：用户正在看这个站点的页面，绝不能跳转走，否则会把试卷页面冲掉。
    await fail("无法在本页启动。请刷新当前页面后重试。");
    return;
  }

  // 3) 不在站点上，导航过去。登录后 content script 会自己接上。
  try {
    await chrome.tabs.update(tab.id, { url: EXAM_TARGET_URL });
    status.textContent = "正在打开考试列表；请登录并进入试卷，会自动继续。";
  } catch (error) {
    console.error("SafeTest 跳转失败：", error);
    await fail("无法打开考试页面，请手动访问平台。");
  }
});
