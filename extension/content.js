(() => {
  const SCRIPT_VERSION = "2.0.0";
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
    let panel = document.getElementById(STATUS_PANEL_ID);
    if (panel) return panel;
    panel = document.createElement("div");
    panel.id = STATUS_PANEL_ID;
    Object.assign(panel.style, {
      position: "fixed",
      zIndex: "2147483647",
      top: "16px",
      right: "16px",
      maxWidth: "420px",
      padding: "12px 15px",
      borderRadius: "10px",
      boxShadow: "0 8px 28px rgba(0,0,0,.22)",
      color: "#fff",
      background: "#155eef",
      font: '14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
      whiteSpace: "pre-wrap",
      pointerEvents: "none",
    });
    document.documentElement.appendChild(panel);
    return panel;
  }

  function setStatus(message, kind = "working") {
    const panel = statusPanel();
    panel.textContent = message;
    panel.style.background =
      kind === "error" ? "#b42318" : kind === "done" ? "#267a42" : "#155eef";
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
          `\n${result.stem.slice(0, 42)}`
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
        page: location.href,
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
      "# 用法：在每题的 **答案：** 后填答案，然后跑",
      "#     python3 tools/import_paper_answers.py",
      "#     python3 tools/build_bank.py",
      "#",
      "# 填法：单选 B。   多选 A,B,D。   判断 错。",
      "# 没填答案的题会被导入器自动忽略。",
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
      `来源：${location.href}`,
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
    Object.assign(button.style, {
      // 面板本身 pointer-events:none 以免挡住页面，只让按钮可点。
      pointerEvents: "auto",
      marginTop: "8px",
      width: "100%",
      border: "0",
      borderRadius: "7px",
      padding: "8px 10px",
      color: "#155eef",
      background: "#fff",
      font: "inherit",
      fontWeight: "650",
      cursor: "pointer",
    });
    button.addEventListener("click", onClick);
    return button;
  }

  function showReportButtons(report, summary) {
    const panel = statusPanel();

    // 有跳过才给这个按钮——它导出的东西可以直接拿去补题库。
    if (summary.skipped > 0) {
      panel.appendChild(
        panelButton(`下载跳过题（${summary.skipped} 题，填答案后可直接入库）.txt`, () =>
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
        "done"
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
