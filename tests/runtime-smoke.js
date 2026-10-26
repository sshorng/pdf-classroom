const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 執行期冒煙測試：自己啟動 headless Chrome 開 index.html，收集 JS 例外並檢查重構後的關鍵原語。
// 需要本機已安裝 Chrome 或 Edge；沒有瀏覽器時直接跳過，不以其他檢查冒充。
const CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
].filter(Boolean);
const browserPath = CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (!browserPath) {
  console.log("runtime-smoke=SKIP（找不到 Chrome 或 Edge）");
  process.exit(0);
}

const PORT = Number(process.env.CDP_PORT || 9225);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "pdfw-smoke-"));
const targetPath = process.argv[2] || path.join(__dirname, "../index.html");
const pageUrl = "file:///" + path.resolve(targetPath).replace(/\\/g, "/");
const BODY = `
  const report = {};
  report.localRequest = typeof localRequest === "function";
  report.localRoutes = (typeof LOCAL_ACTION_ROUTES !== "undefined") ? LOCAL_ACTION_ROUTES.length : -1;
  report.inkSurface = typeof bindInkSurface === "function";
  report.canvasPointPure = String(canvasPoint).indexOf("normalizedPointFromRect") > -1;
  report.zoomRounded = roundedZoom(1.23456, .5, 3) === 1.23;
  report.pinchDistance = Math.round(pinchDistance([{clientX:0,clientY:0},{clientX:3,clientY:4}])) === 5;
  report.eraseHit = eraseStrokesAtPoint([{ tool: "pen", width: .005, points: [{x:0,y:0},{x:1,y:1}] }], {x:0.5,y:0.5}).length === 0;
  report.eraseMiss = eraseStrokesAtPoint([{ tool: "pen", width: .005, points: [{x:0,y:0},{x:1,y:1}] }], {x:0.5,y:0.9}).length === 1;
  report.unknownActionRejected = await localRequest("noSuchAction", {}).then(() => false).catch((error) => /未知的本機操作/.test(error.message));
  // 註解只能待在 script 內，跑版會直接出現在教材頁面上。
  report.noVisibleCommentLeak = !/架構索引|第 [0-9]+ 區｜/.test(document.body.innerText);
  return report;
`;
const EXPRESSION = "(async () => JSON.stringify(await (async () => {" + BODY + "})()))()";
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

(async () => {
  const browser = spawn(browserPath, [
    "--headless=new",
    "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + profile,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "about:blank"
  ], { stdio: "ignore" });

  let target = null;
  for (let attempt = 0; attempt < 40 && !target; attempt += 1) {
    await sleep(250);
    try {
      const targets = await (await fetch("http://127.0.0.1:" + PORT + "/json")).json();
      target = targets.find((item) => item.type === "page");
    } catch (error) { /* 瀏覽器還沒起來 */ }
  }
  assert.ok(target, "瀏覽器沒有在時限內啟動");

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  const exceptions = [];
  let sequence = 0;
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails || {};
      exceptions.push((details.exception && details.exception.description) || details.text || "unknown");
    }
    if (!message.id || !pending.has(message.id)) return;
    const item = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) item.reject(new Error(message.error.message));
    else item.resolve(message.result);
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      const text = (result.exceptionDetails.exception && result.exceptionDetails.exception.description) || result.exceptionDetails.text || "evaluate failed";
      throw new Error(text);
    }
    return result.result && result.result.value;
  };

  try {
    await call("Runtime.enable");
    await call("Page.enable");
    await call("Page.navigate", { url: pageUrl });
    await sleep(3500);
    const checks = JSON.parse(await evaluate(EXPRESSION));
    console.log("runtime-exceptions=" + JSON.stringify(exceptions));
    console.log("checks=" + JSON.stringify(checks));
    assert.deepEqual(exceptions, [], "頁面載入期間出現 JS 例外");
    Object.keys(checks).forEach((key) => assert.ok(checks[key] && checks[key] !== -1, key + " 檢查失敗"));
    console.log("runtime-smoke=PASS");
  } finally {
    socket.close();
    browser.kill();
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (error) { /* 瀏覽器尚未釋放暫存設定檔，留給系統清理 */ }
  }
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
