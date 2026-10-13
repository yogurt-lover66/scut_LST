(() => {
  const SCRIPT_VERSION = "1.0.0-floating-ui-1";
  if (globalThis.__safeTestAutoAnswerLoaded === SCRIPT_VERSION) return;
  globalThis.__safeTestAutoAnswerLoaded = SCRIPT_VERSION;

  const AUTO_RUN_KEY = "safeTestAutoRun";
  const AUTO_RUN_MAX_AGE = 10 * 60 * 1000;
  const STATUS_PANEL_ID = "safe-test-status";
  const QUESTION_MATCH_THRESHOLD = 0.92;
  // 题库里存在“一字之差、答案相反”的近义题（例如“绝对压力/相对压力”、
  // “强酸/强碱”），相似度能到 0.96。光提高阈值治不了，必须要求最佳匹配
  // 明显领先次佳匹配，否则宁可不答。
  const QUESTION_MATCH_MARGIN = 0.02;
  const ANSWER_CLICK_DELAY = 250;
  const ANSWER_SAVE_DELAY = 600;
  const MAX_QUESTIONS = 300;
  const LETTERS = "ABCDEFGH";
  const FEEDBACK_EMAIL = "2744481242@qq.com";
  const TYPE_NAMES = { 1: "单选题", 2: "多选题", 3: "判断题" };
  const QUESTION_SELECTOR = ".question-bottom-line";
  const WAIT_FOR_EXAM = 10 * 60 * 1000;

  let examRunning = false;

  const sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

  // 归一化：全角转半角、统一引号、去掉所有空白。
  // 题库生成脚本 tools/build_bank.py 用的是同一套规则，两边必须保持一致。
  function normalize(value) {
    const text = String(value || "");
    let result = "";
    for (const character of text) {
      const code = character.codePointAt(0);
      if (code === 0x3000) result += " ";
      else if (code >= 0xff01 && code <= 0xff5e) result += String.fromCodePoint(code - 0xfee0);
      else result += character;
    }
    return result
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      // 试卷上的题干常在末尾多一个空占位符（“…正确的是?()”“…错误的是:()。”），
      // 题库里对应的题干没有。它不含任何信息，一律去掉再比对。
      .replace(/[（(]\s*[）)]/g, "")
      .replace(/\s+/g, "")
      // 选项尾部常多一个句号（页面“…迎风快跑。”题库是“…迎风快跑”），
      // 纯句读不携带信息，去掉再比。
      .replace(/[。.]$/, "")
      .trim();
  }

  // 去掉题号前缀，题库和页面两边都可能带 “1、”“第1题” 之类。
  function normalizeQuestionStem(value) {
    return normalize(value).replace(/^(?:第)?\d+(?:题)?[.．、:：)）]?/, "");
  }

  function textOf(element) {
    return element ? element.textContent || "" : "";
  }

  function statusPanel() {
    let root = document.getElementById(STATUS_PANEL_ID);
    if (root?.dataset.uiVersion === SCRIPT_VERSION && typeof root.reposition === "function") return root;
    // 扩展重载后，网页中可能仍留着旧面板或旧脚本上下文的 DOM。
    if (root) root.remove();
    root = document.createElement("div");
    root.id = STATUS_PANEL_ID;
    root.dataset.uiVersion = SCRIPT_VERSION;
    root.dataset.state = "working";
    Object.assign(root.style, { position: "fixed", inset: "0", zIndex: "2147483647", pointerEvents: "none" });
    const style = document.createElement("style");
    style.textContent = `
      #safe-test-status { font: 13px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; color: #26354b; text-align: left; }
      #safe-test-status * { box-sizing: border-box; }
      #safe-test-status [hidden] { display: none !important; }
      #safe-test-status button, #safe-test-status a { font-family: inherit; }
      #safe-test-status button { cursor: pointer; touch-action: manipulation; }
      #safe-test-status button:focus-visible, #safe-test-status a:focus-visible { outline: 3px solid #80b8ff; outline-offset: 3px; }
      #safe-test-status .scut-lst-ball { position: fixed; width: 56px; height: 56px; border: 2px solid #d8e8fa; border-radius: 50%; background: #fff; padding: 5px; box-shadow: 0 5px 22px #163d692b; touch-action: none; user-select: none; }
      #safe-test-status .scut-lst-ball:hover { border-color: #2575b7; box-shadow: 0 6px 24px #163d6940; }
      #safe-test-status .scut-lst-ball img { width: 100%; height: 100%; display: block; pointer-events: none; }
      #safe-test-status .scut-lst-badge { position: absolute; top: -4px; right: -4px; min-width: 19px; height: 19px; border: 2px solid #fff; border-radius: 10px; padding: 0 4px; background: #286ca5; color: #fff; font: 600 10px/15px system-ui; }
      #safe-test-status[data-state="done"] .scut-lst-badge { background: #16805c; }
      #safe-test-status[data-state="error"] .scut-lst-badge { background: #ba3a3a; }
      #safe-test-status .scut-lst-card { position: fixed; width: min(360px, calc(100vw - 24px)); max-height: calc(100dvh - 24px); border: 1px solid #dce5ee; border-radius: 18px; background: #fff; box-shadow: 0 16px 55px #20364a24, 0 2px 8px #20364a12; overflow: hidden; display: flex; flex-direction: column; }
      #safe-test-status .scut-lst-header { display: flex; align-items: center; gap: 10px; padding: 15px 16px; background: #13375b; color: #fff; cursor: grab; touch-action: none; user-select: none; flex-shrink: 0; }
      #safe-test-status .scut-lst-header:active { cursor: grabbing; }
      #safe-test-status .scut-lst-header img { width: 34px; height: 34px; background: #fff; border-radius: 50%; padding: 2px; pointer-events: none; }
      #safe-test-status .scut-lst-brand { flex: 1; min-width: 0; font-size: 15px; font-weight: 700; letter-spacing: .2px; }
      #safe-test-status .scut-lst-brand small { display: block; font-size: 11px; font-weight: 400; color: #c5d9ec; letter-spacing: 0; }
      #safe-test-status .scut-lst-collapse { display: grid; place-items: center; width: 30px; height: 30px; padding: 0; border: 1px solid #ffffff38; border-radius: 9px; background: #ffffff12; color: #fff; font-size: 22px; line-height: 1; }
      #safe-test-status .scut-lst-collapse:hover { background: #ffffff28; }
      #safe-test-status .scut-lst-body { padding: 16px; overflow: auto; overscroll-behavior: contain; min-height: 0; }
      #safe-test-status .scut-lst-state { margin-bottom: 11px; color: #2c709f; font-weight: 600; font-size: 12px; }
      #safe-test-status .scut-lst-state::before { content: ""; display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: currentColor; margin-right: 7px; }
      #safe-test-status[data-state="done"] .scut-lst-state { color: #16805c; }
      #safe-test-status[data-state="error"] .scut-lst-state { color: #ba3a3a; }
      #safe-test-status .scut-lst-counts { display: grid; grid-template-columns: repeat(3, 1fr); padding: 12px 0; border: 1px solid #e7edf3; border-radius: 12px; background: #f7f9fc; margin-bottom: 10px; }
      #safe-test-status .scut-lst-counts div { text-align: center; border-right: 1px solid #e3eaf2; }
      #safe-test-status .scut-lst-counts div:last-child { border: 0; }
      #safe-test-status .scut-lst-counts strong { display: block; font-size: 23px; line-height: 1.25; color: #14375b; font-weight: 700; }
      #safe-test-status .scut-lst-counts span { font-size: 11px; color: #718093; }
      #safe-test-status .scut-lst-counts div:last-child strong { color: #b77b24; }
      #safe-test-status .scut-lst-progress { height: 4px; border-radius: 4px; background: #eaf0f6; overflow: hidden; margin-bottom: 12px; }
      #safe-test-status .scut-lst-progress span { display: block; height: 100%; background: #347aaa; transition: width .2s; }
      #safe-test-status[data-state="done"] .scut-lst-progress span { background: #16805c; }
      #safe-test-status .scut-lst-message { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; color: #637286; line-height: 1.7; }
      #safe-test-status .scut-lst-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 14px; }
      #safe-test-status .scut-lst-actions:empty { display: none; }
      #safe-test-status .scut-lst-actions button { min-height: 40px; width: 100%; border: 1px solid #dde6f0; border-radius: 10px; padding: 9px 8px; color: #295b87; background: #f8fafd; font-size: 12px; line-height: 1.45; font-weight: 600; }
      #safe-test-status .scut-lst-actions button:hover { background: #edf4fb; border-color: #a5c3dd; }
      #safe-test-status .scut-lst-actions .scut-lst-primary { grid-column: 1 / -1; background: #1d629a; border-color: #1d629a; color: #fff; }
      #safe-test-status .scut-lst-actions .scut-lst-primary:hover { background: #154f7e; }
      #safe-test-status .scut-lst-actions .scut-lst-wide { grid-column: 1 / -1; }
      #safe-test-status .scut-lst-feedback { margin-top: 13px; padding-top: 12px; border-top: 1px solid #edf1f5; color: #7a8797; font-size: 11px; }
      #safe-test-status .scut-lst-feedback p { margin: 0 0 7px; line-height: 1.7; }
      #safe-test-status .scut-lst-feedback a { color: #1d629a; text-decoration: none; font-weight: 600; }
      #safe-test-status .scut-lst-feedback a:hover { text-decoration: underline; }
      @media (prefers-reduced-motion: reduce) { #safe-test-status .scut-lst-progress span { transition: none; } }
    `;
    const ball = document.createElement("button");
    ball.type = "button";
    ball.className = "scut-lst-ball";
    ball.style.pointerEvents = "auto";
    ball.setAttribute("aria-label", "展开或收起 scut_LST 面板，可拖动");
    ball.setAttribute("aria-expanded", "true");
    ball.setAttribute("aria-controls", "scut-lst-card");
    ball.title = "scut_LST · 点击展开/收起，拖动可移动";
    const emblem = document.createElement("img");
    emblem.src = chrome.runtime.getURL("asset/scut-emblem.svg");
    emblem.alt = "华南理工大学校徽";
    emblem.draggable = false;
    const badge = document.createElement("span");
    badge.className = "scut-lst-badge";
    badge.textContent = "…";
    ball.append(emblem, badge);
    const card = document.createElement("section");
    card.id = "scut-lst-card";
    card.className = "scut-lst-card";
    card.style.pointerEvents = "auto";
    card.setAttribute("aria-label", "scut_LST 答题状态与下载");
    card.innerHTML = `<div class="scut-lst-header">
      <div class="scut-lst-brand">scut_LST<small>实验室安全考试助手 · 拖动标题栏可移动</small></div>
      <button type="button" class="scut-lst-collapse" aria-label="收起面板" title="收起为悬浮球">−</button>
      </div><div class="scut-lst-body">
      <div class="scut-lst-state">正在处理</div>
      <div class="scut-lst-counts" hidden><div><strong>0</strong><span>总题数</span></div><div><strong>0</strong><span>已作答</span></div><div><strong>0</strong><span>跳过 / 待核对</span></div></div>
      <div class="scut-lst-progress" role="progressbar" aria-label="作答进度" aria-valuemin="0" aria-valuemax="100" hidden><span></span></div>
      <div class="scut-lst-message" role="status" aria-live="polite"></div>
      <div class="scut-lst-actions"></div><div class="scut-lst-feedback" hidden></div></div>`;
    const header = card.querySelector(".scut-lst-header");
    header.prepend(emblem.cloneNode(true));
    const collapse = card.querySelector(".scut-lst-collapse");
    collapse.style.pointerEvents = "auto";
    root.append(style, ball, card);
    document.documentElement.appendChild(root);

    const padding = 12;
    let ballX = window.innerWidth - 80;
    let ballY = 96;
    let cardX = ballX - 376;
    let cardY = ballY;
    let suppressBallClick = false;
    const place = () => {
      const width = Math.min(360, Math.max(0, window.innerWidth - padding * 2));
      const height = Math.min(card.offsetHeight || 420, Math.max(0, window.innerHeight - padding * 2));
      const clamp = (value, maximum) => Math.max(padding, Math.min(value, Math.max(padding, maximum)));
      ballX = clamp(ballX, window.innerWidth - 56 - padding);
      ballY = clamp(ballY, window.innerHeight - 56 - padding);
      cardX = clamp(cardX, window.innerWidth - width - padding);
      cardY = clamp(cardY, window.innerHeight - height - padding);
      Object.assign(ball.style, { left: `${ballX}px`, top: `${ballY}px` });
      Object.assign(card.style, { left: `${cardX}px`, top: `${cardY}px` });
    };
    const expanded = (value) => {
      card.hidden = !value;
      ball.setAttribute("aria-expanded", String(value));
      if (value) place();
    };
    ball.addEventListener("click", () => {
      if (suppressBallClick) { suppressBallClick = false; return; }
      expanded(card.hidden);
    });
    collapse.addEventListener("click", () => { expanded(false); ball.focus({ preventScroll: true }); });
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !card.hidden) {
        expanded(false);
        ball.focus({ preventScroll: true });
      }
    });
    const draggable = (handle, isBall) => {
      let drag = null;
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || (!isBall && event.target.closest("button, a"))) return;
        event.preventDefault();
        if (isBall) suppressBallClick = false;
        drag = { x: event.clientX, y: event.clientY, ballX, ballY, cardX, cardY, moved: false };
        handle.setPointerCapture?.(event.pointerId);
      });
      window.addEventListener("pointermove", (event) => {
        if (!drag) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 6) return;
        drag.moved = true;
        if (isBall) { ballX = drag.ballX + dx; ballY = drag.ballY + dy; }
        cardX = drag.cardX + dx;
        cardY = drag.cardY + dy;
        place();
      });
      const finish = () => {
        if (drag?.moved && isBall) suppressBallClick = true;
        drag = null;
      };
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    };
    draggable(ball, true);
    draggable(header, false);
    window.addEventListener("resize", place);
    root.reposition = place;
    place();
    return root;
  }

  function setStatus(message, kind = "working", summary) {
    const root = statusPanel();
    root.dataset.state = kind;
    root.querySelector(".scut-lst-message").textContent = message;
    root.querySelector(".scut-lst-state").textContent =
      kind === "error" ? "已停止 · 请查看提示" : kind === "done" ? "答题完成 · 请核对后手动提交" : "正在处理 · 不会自动交卷";
    const badge = root.querySelector(".scut-lst-badge");
    badge.textContent = kind === "error" ? "!" : kind === "done" ? (summary?.skipped || "✓") : "…";
    const counts = root.querySelector(".scut-lst-counts");
    const progress = root.querySelector(".scut-lst-progress");
    counts.hidden = progress.hidden = !summary;
    if (summary) {
      const values = [summary.total, summary.answered, summary.skipped];
      counts.querySelectorAll("strong").forEach((element, index) => { element.textContent = values[index]; });
      const percent = summary.total ? Math.min(100, Math.round((summary.answered + summary.skipped) / summary.total * 100)) : 0;
      progress.setAttribute("aria-valuenow", String(percent));
      progress.querySelector("span").style.width = `${percent}%`;
    }
    if (kind !== "done") {
      root.querySelector(".scut-lst-actions").replaceChildren();
      root.querySelector(".scut-lst-feedback").hidden = true;
    }
    root.reposition();
  }

  async function waitFor(check, timeout, interval = 250) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = check();
      if (result) return result;
      await sleep(interval);
    }
    return null;
  }

  async function loadQuestionBank() {
    const response = await fetch(chrome.runtime.getURL("asset/questions.json"));
    if (!response.ok) throw new Error(`题库读取失败：HTTP ${response.status}`);
    const questions = await response.json();
    const usable = questions.filter(
      (question) =>
        question &&
        question.stem &&
        Array.isArray(question.correct) &&
        question.correct.length &&
        (question.type === 3 ||
          ((question.type === 1 || question.type === 2) &&
            Array.isArray(question.options) &&
            question.options.length > 1))
    );
    if (!usable.length) throw new Error("题库为空或格式不正确");
    return usable;
  }

  function levenshtein(left, right) {
    if (left === right) return 0;
    if (!left.length) return right.length;
    if (!right.length) return left.length;
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let row = 1; row <= left.length; row += 1) {
      const current = [row];
      for (let column = 1; column <= right.length; column += 1) {
        current[column] = Math.min(
          current[column - 1] + 1,
          previous[column] + 1,
          previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1)
        );
      }
      previous = current;
    }
    return previous[right.length];
  }

  function similarity(left, right) {
    if (left === right) return 1;
    if (!left.length || !right.length) return 0;
    const longest = Math.max(left.length, right.length);
    // 长度差已经超过阈值允许的编辑距离时不必真的算 Levenshtein。
    if (Math.abs(left.length - right.length) / longest > 1 - QUESTION_MATCH_THRESHOLD) {
      return 0;
    }
    return 1 - levenshtein(left, right) / longest;
  }

  // 返回最佳与次佳。不能提前退出：次佳的分数是判断可靠性的依据。
  function bestMatch(target, candidates, key = (item) => item) {
    let best = null;
    let second = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const score = similarity(target, key(candidates[index]));
      if (!best || score > best.similarity) {
        second = best;
        best = { index, similarity: score };
      } else if (!second || score > second.similarity) {
        second = { index, similarity: score };
      }
    }
    return { best, second };
  }

  function answersEqual(left, right) {
    const a = [...new Set(left.map(normalize))].sort();
    const b = [...new Set(right.map(normalize))].sort();
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }

  function isDecisive(best, second, pool) {
    if (!best || best.similarity < QUESTION_MATCH_THRESHOLD) return false;
    if (!second || best.similarity - second.similarity >= QUESTION_MATCH_MARGIN) return true;
    // 选项目标文本的比对没有“正确答案”可比较，维持严格判据。
    if (!pool) return false;
    // 次优解与最优解答案相同时，选哪个结果都一样，不必因为间距小就放弃。
    return answersEqual(pool[best.index].correct, pool[second.index].correct);
  }

  // 按题型分池。页面上的题型是确定的，让题目只在同题型内竞争，
  // 既减少误匹配，也让“同题干不同题型”这类条目不再互相干扰。
  function buildPools(bank) {
    const pools = { 1: [], 2: [], 3: [] };
    for (const question of bank) {
      if (pools[question.type]) pools[question.type].push(question);
    }
    return pools;
  }

  // 页面结构来自试卷页懒加载分包 do-*.js：
  //   .question-bottom-line > .qeustion-item-box > .question-content
  //     > .question-title 题干
  //     > .question-options 里是 Element Plus 的 el-radio / el-checkbox
  function questionNodes() {
    return Array.from(document.querySelectorAll(QUESTION_SELECTOR));
  }

  // 1 单选 / 2 多选 / 3 判断；其它题型返回 0。
  function questionType(node) {
    if (node.querySelector(".el-checkbox-group")) return 2;
    const radios = Array.from(node.querySelectorAll('input[type="radio"]'));
    if (radios.length === 2) {
      const values = radios.map((radio) => radio.value).sort();
      if (values[0] === "false" && values[1] === "true") return 3;
    }
    if (node.querySelector(".el-radio-group")) return 1;
    return 0;
  }

  function questionStem(node) {
    return normalizeQuestionStem(textOf(node.querySelector(".question-title")));
  }

  // 保留原始措辞与标点，用于导出。
  function rawStem(node) {
    return textOf(node.querySelector(".question-title")).replace(/\s+/g, " ").trim();
  }

  function optionLabel(node) {
    return node.classList.contains("is-checked");
  }

  function pageOptions(node) {
    const labels = node.querySelectorAll(
      ".question-options label.el-radio, .question-options label.el-checkbox"
    );
    return Array.from(labels).map((label) => {
      const input = label.querySelector('input[type="radio"], input[type="checkbox"]');
      const optionText = label.querySelector(".option");
      const source = optionText ? textOf(optionText) : textOf(label);
      return {
        label,
        input,
        value: input ? input.value : "",
        // text 用于匹配，raw 保留原样用于导出给人/大模型看。
        text: normalize(source),
        raw: source.replace(/\s+/g, " ").trim(),
        selected: Boolean((input && input.checked) || optionLabel(label)),
      };
    });
  }

  async function setSelected(option, wanted) {
    if (option.selected === wanted) return true;
    const target = option.input || option.label;
    target.click();
    await sleep(ANSWER_CLICK_DELAY);
    const changed = Boolean(
      (option.input && option.input.checked) || optionLabel(option.label)
    );
    return changed === wanted;
  }

  function skipped(stem, reason, score, extra) {
    return { stem, skipped: true, reason, similarity: score || 0, ...extra };
  }

  async function answerQuestion(node, pools) {
    const stem = questionStem(node);
    const type = questionType(node);

    if (!stem) return skipped(stem, "题干为空或整题是图片");
    if (type === 0) return skipped(stem, "未能识别的题型");

    const pool = pools[type] || [];
    if (!pool.length) {
      return skipped(stem, `题库中没有${TYPE_NAMES[type] || "该类"}题目`);
    }

    const { best, second } = bestMatch(
      stem,
      pool,
      (question) => normalizeQuestionStem(question.stem)
    );
    if (!best || best.similarity < QUESTION_MATCH_THRESHOLD) {
      return skipped(
        stem,
        `题库未匹配（最高 ${Math.round((best ? best.similarity : 0) * 100)}%）`,
        best ? best.similarity : 0,
        { nearest: best ? pool[best.index].stem : "" }
      );
    }
    if (!isDecisive(best, second, pool)) {
      return skipped(
        stem,
        `题库中有答案冲突的相近题（${Math.round(best.similarity * 100)}% / ${Math.round(second.similarity * 100)}%），无法确定`,
        best.similarity,
        { nearest: pool[best.index].stem, rival: pool[second.index].stem }
      );
    }

    const entry = pool[best.index];
    const options = pageOptions(node);
    if (!options.length) return skipped(stem, "页面上没有找到任何选项", best.similarity);

    if (type === 3) {
      const wanted = entry.correct[0] === "正确" ? "true" : "false";
      const target = options.find((option) => option.value === wanted);
      if (!target) return skipped(stem, "页面上没有找到对/错选项", best.similarity);
      if (!(await setSelected(target, true))) {
        return skipped(stem, "选择未被页面确认", best.similarity);
      }
      await sleep(ANSWER_SAVE_DELAY);
      return { stem, skipped: false, similarity: best.similarity, picked: entry.correct[0], nearest: entry.stem };
    }

    // 选项一律按文本匹配：页面上的选项顺序可能与题库不同。
    // 单选取一个，多选取全部。
    const wanted = [];
    for (const text of entry.correct) {
      const expected = normalize(text);
      let target = options.find((option) => option.text === expected);
      if (!target) {
        const fuzzy = bestMatch(expected, options, (option) => option.text);
        if (isDecisive(fuzzy.best, fuzzy.second)) target = options[fuzzy.best.index];
      }
      if (!target) {
        return skipped(
          stem,
          `页面上没有找到正确选项：${text.slice(0, 16)}`,
          best.similarity
        );
      }
      wanted.push(target);
    }

    // 多选的答案可能少于页面上已选的项，先清掉不该选的再补该选的。
    if (type === 2) {
      for (const option of options) {
        if (wanted.includes(option) || !option.selected) continue;
        if (!(await setSelected(option, false))) {
          return skipped(stem, "无法清除已选中的错误选项", best.similarity);
        }
      }
    }

    for (const option of wanted) {
      if (!(await setSelected(option, true))) {
        return skipped(stem, "选择未被页面确认", best.similarity);
      }
    }
    await sleep(ANSWER_SAVE_DELAY);
    return {
      stem,
      skipped: false,
      similarity: best.similarity,
      picked: wanted.map((option) => option.text).join(" | "),
      nearest: entry.stem,
    };
  }

  async function answerAll(pools) {
    const nodes = questionNodes();
    let answered = 0;
    let skippedCount = 0;
    const report = [];

    for (let index = 0; index < nodes.length && index < MAX_QUESTIONS; index += 1) {
      const node = nodes[index];
      const result = await answerQuestion(node, pools);
      if (result.skipped) {
        skippedCount += 1;
        console.warn("SafeTest 跳过：", result.reason, result.stem.slice(0, 60));
      } else {
        answered += 1;
      }
      // 作答后再读一次页面，记录实际被选中的项（而不是相信返回值）。
      const options = pageOptions(node);
      const chosen = options
        .map((option, position) => ({ option, position }))
        .filter((entry) => entry.option.selected);
      report.push({
        number: node.id,
        type: questionType(node),
        stem: questionStem(node),
        rawStem: rawStem(node),
        options: options.map((option, position) => ({
          letter: LETTERS[position] || String(position),
          text: option.raw,
        })),
        answered: !result.skipped,
        picked: chosen.map((entry) => LETTERS[entry.position] || "?").join(","),
        pickedText: chosen.map((entry) => entry.option.raw).join(" | "),
        reason: result.reason || "",
        similarity: Number((result.similarity || 0).toFixed(4)),
        matchedStem: result.nearest || "",
        rivalStem: result.rival || "",
      });
      setStatus(
        `正在自动答题：${index + 1}/${nodes.length}\n` +
          `已作答 ${answered} 题，跳过 ${skippedCount} 题\n` +
          (result.skipped
            ? `本題跳过：${result.reason}`
            : `匹配度 ${Math.round(result.similarity * 100)}%`) +
          `\n${result.stem.slice(0, 42)}`,
        "working",
        { total: nodes.length, answered, skipped: skippedCount }
      );
    }

    if (nodes.length > MAX_QUESTIONS) {
      throw new Error(`题目超过 ${MAX_QUESTIONS} 道，已安全停止`);
    }
    return { total: nodes.length, answered, skipped: skippedCount, report };
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    document.documentElement.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
  }

  function reportPayload(report, summary) {
    return JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        site: location.origin,
        summary,
        questions: report,
      },
      null,
      1
    );
  }

  // 只导出被跳过的题，格式与 tools/import_paper_answers.py 认的一致：
  // 答案填回 **答案：** 后即可直接入库，不需要再做格式转换。
  function skippedPayload(report, summary) {
    const kinds = { 1: "单选", 2: "多选", 3: "判断" };
    const skipped = report.filter((item) => !item.answered);

    const lines = [
      "# SafeTest 跳过题",
      "#",
      `# 如知道正确答案，可填写后发送到 ${FEEDBACK_EMAIL}，由作者完善题库。`,
      "#",
      "# 填法：单选 B。   多选 A,B,D。   判断 错。",
      "# 不确定的答案请留空，也可直接将反馈包发给作者。",
      `# 本轮共 ${summary.total} 题，跳过 ${skipped.length} 题。`,
      "",
      "",
    ];

    skipped.forEach((item, index) => {
      const stem = item.rawStem.replace(/[（(]\s*[）)]\s*$/, "").trim();
      // 题型必须带上：单选题和多选题在银行里是分开匹配的，
      // 光看答案字母个数推题型，遇到“只有一个正确项的多选题”就会判错。
      lines.push(`### ${index + 1}. [${kinds[item.type] || "其它"}] ${stem}`);
      lines.push("");
      if (item.type === 3) {
        lines.push("选项：对 / 错。");
      } else {
        for (const option of item.options) {
          lines.push(`- ${option.letter}. ${option.text}`);
        }
      }
      lines.push("");
      lines.push(`# 跳过原因：${item.reason}`);
      lines.push("**答案：**");
      lines.push("");
    });

    return lines.join("\n");
  }

  // 给大模型用的纯文本：只有题干和选项，**不含扩展自己的答案**，
  // 否则模型会照着抄，比对就失去意义。
  function textPayload(report, summary) {
    const kinds = { 1: "单选", 2: "多选", 3: "判断" };
    const counts = {};
    for (const item of report) {
      const kind = kinds[item.type] || "其它";
      counts[kind] = (counts[kind] || 0) + 1;
    }
    const lines = [
      `SafeTest 题目导出（共 ${summary.total} 题：${Object.entries(counts)
        .map(([kind, count]) => `${kind} ${count}`)
        .join("，")}）`,
      `来源：${location.origin}`,
      "",
      "请逐题作答。单选题回复选项字母，判断题回复“正确”或“错误”，多选题回复多个字母。",
      "建议一行一题，格式：1.B  2.正确  3.AC",
      "",
    ];
    report.forEach((item, index) => {
      lines.push(`${index + 1}. [${kinds[item.type] || "其它"}] ${item.rawStem}`);
      for (const option of item.options) lines.push(`${option.letter}. ${option.text}`);
      lines.push("");
    });
    return lines.join("\n");
  }

  function panelButton(text, onClick) {
    const button = document.createElement("button");
    button.textContent = text;
    button.type = "button";
    button.style.pointerEvents = "auto";
    button.addEventListener("click", onClick);
    return button;
  }

  // ZIP 使用无压缩存储，UTF-8 文件名和 CRC-32，可直接用系统解压工具打开。
  function feedbackZip(report, summary) {
    const instructions = [
      "scut_LST 反馈说明",
      "",
      `请将此 ZIP 作为邮件附件发送到 ${FEEDBACK_EMAIL}。`,
      "建议主题：scut_LST 问题反馈 / 题库补充 / 功能建议。",
      "请描述遇到的问题、发生时间和复现步骤；如知道正确答案，也请注明。",
      "有更多建议也欢迎直接通过邮箱联系作者。",
      "",
      "文件说明：题目.txt 包含题干和选项；答题明细.json 包含扩展本轮的匹配及选项结果。",
      "存在跳过题时，跳过题.txt 预留答案填写位置，不确定的答案请留空。",
      "扩展选中的答案不等于标准答案，请核对后说明需要修正的题目。",
      "发送前请查看附件，勿添加姓名、学号、账号、密码等个人信息。",
      "扩展仅生成本地文件，不会自动发送邮件；请在邮箱中手动添加 ZIP 附件。",
    ].join("\n");
    const files = [
      ["scut_LST-题目.txt", textPayload(report, summary)],
      ["scut_LST-答题明细.json", reportPayload(report, summary)],
      ["反馈说明.txt", instructions],
    ];
    if (summary.skipped > 0) files.push(["scut_LST-跳过题.txt", skippedPayload(report, summary)]);

    const encoder = new TextEncoder();
    const localParts = [];
    const directoryParts = [];
    let offset = 0;
    let directorySize = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    for (const [filename, text] of files) {
      const name = encoder.encode(filename);
      const data = encoder.encode(text);
      let crc = 0xffffffff;
      for (const byte of data) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
      crc = (crc ^ 0xffffffff) >>> 0;
      const header = new Uint8Array(30 + name.length);
      const view = new DataView(header.buffer);
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 0x0800, true); // UTF-8
      view.setUint16(10, dosTime, true);
      view.setUint16(12, dosDate, true);
      view.setUint32(14, crc, true);
      view.setUint32(18, data.length, true);
      view.setUint32(22, data.length, true);
      view.setUint16(26, name.length, true);
      header.set(name, 30);
      localParts.push(header, data);

      const directory = new Uint8Array(46 + name.length);
      const central = new DataView(directory.buffer);
      central.setUint32(0, 0x02014b50, true);
      central.setUint16(4, 20, true);
      central.setUint16(6, 20, true);
      central.setUint16(8, 0x0800, true);
      central.setUint16(12, dosTime, true);
      central.setUint16(14, dosDate, true);
      central.setUint32(16, crc, true);
      central.setUint32(20, data.length, true);
      central.setUint32(24, data.length, true);
      central.setUint16(28, name.length, true);
      central.setUint32(42, offset, true);
      directory.set(name, 46);
      directoryParts.push(directory);
      directorySize += directory.length;
      offset += header.length + data.length;
    }
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, files.length, true);
    endView.setUint16(10, files.length, true);
    endView.setUint32(12, directorySize, true);
    endView.setUint32(16, offset, true);
    return new Blob([...localParts, ...directoryParts, end], { type: "application/zip" });
  }

  function showReportButtons(report, summary) {
    const root = statusPanel();
    const panel = root.querySelector(".scut-lst-actions");
    panel.replaceChildren();
    if (summary.skipped > 0) {
      panel.appendChild(
        panelButton(`下载跳过题（${summary.skipped} 题）.txt`, () =>
          download("safetest-跳过题.txt", skippedPayload(report, summary), "text/plain;charset=utf-8")
        )
      );
    }
    panel.appendChild(
      panelButton("下载题目（给大模型）.txt", () =>
        download("safetest-题目.txt", textPayload(report, summary), "text/plain;charset=utf-8")
      )
    );
    panel.appendChild(
      panelButton("下载答题明细.json", () =>
        download("safetest-答题明细.json", reportPayload(report, summary), "application/json")
      )
    );
    panel.appendChild(
      panelButton("下载反馈包 ZIP", () => {
        try {
          download("scut_LST-反馈包.zip", feedbackZip(report, summary), "application/zip");
        } catch (error) {
          console.error("SafeTest 反馈包下载失败：", error);
          alert("反馈包生成失败，请重试或通过邮箱联系作者。");
        }
      })
    );
    panel.lastElementChild.classList.add("scut-lst-primary");
    if (summary.skipped > 0) panel.children[2].classList.add("scut-lst-wide");
    const feedback = root.querySelector(".scut-lst-feedback");
    feedback.replaceChildren();
    feedback.hidden = false;
    const hint = document.createElement("p");
    hint.textContent = `请将 ZIP 作为附件发至 ${FEEDBACK_EMAIL}，由作者完善题库。问题和建议也欢迎邮件联系。`;
    feedback.appendChild(hint);
    const contact = document.createElement("a");
    contact.textContent = "邮件联系作者（请手动添加 ZIP 附件）";
    contact.href = `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent("scut_LST 问题反馈与建议")}`;
    feedback.appendChild(contact);
    root.reposition();
  }

  async function clearAutoRun() {
    await chrome.storage.local.remove(AUTO_RUN_KEY);
  }

  async function runExam() {
    if (examRunning) return;
    examRunning = true;
    try {
      setStatus("正在读取题库并等待考试页面……");
      const bank = await loadQuestionBank();

      if (!questionNodes().length) {
        setStatus("题库已就绪，正在等待试卷加载……\n请在平台中打开要作答的试卷。");
        const ready = await waitFor(() => questionNodes().length > 0, WAIT_FOR_EXAM, 500);
        if (!ready) throw new Error("等待试卷超时，请打开试卷后重试");
        await sleep(1000);
      }

      const result = await answerAll(buildPools(bank));
      await clearAutoRun();
      const summary = {
        total: result.total,
        answered: result.answered,
        skipped: result.skipped,
      };
      console.log("SafeTest 答题明细：", { summary, questions: result.report });
      setStatus(
        `答题完成：共 ${result.total} 题。\n` +
          `已作答 ${result.answered} 题，跳过 ${result.skipped} 题。\n` +
          `跳过的题目保持空白；不会自动交卷，请核对后手动提交。`,
        "done",
        summary
      );
      showReportButtons(result.report, summary);
    } catch (error) {
      await clearAutoRun();
      setStatus(`自动答题已停止：${error.message}`, "error");
      console.error("SafeTest:", error);
    } finally {
      examRunning = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "SAFE_TEST_AUTO_ANSWER_START") {
      runExam();
      sendResponse({ started: true });
      return false;
    }
    return false;
  });

  chrome.storage.local.get(AUTO_RUN_KEY).then((stored) => {
    const startedAt = stored[AUTO_RUN_KEY];
    if (typeof startedAt === "number" && Date.now() - startedAt < AUTO_RUN_MAX_AGE) {
      runExam();
    }
  });
})();
