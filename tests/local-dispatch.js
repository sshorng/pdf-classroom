const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// 本機示範後端的分派表回歸測試：確認 350 行單體拆成具名處理器之後，
// 每個 action 都還有人接、沒有人被重複接、未知 action 仍然被擋下。
const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
const start = html.indexOf("    const LOCAL_ACTION_ROUTES");
const end = html.indexOf("    class ApiError", start);
assert.ok(start > 0 && end > start, "找不到本機後端分派區塊");

const constants = { MAX_IMAGE_BYTES: 2 * 1024 * 1024, MAX_PDF_BYTES: 20 * 1024 * 1024 };
const sandbox = Object.assign({}, constants, { console });
vm.createContext(sandbox);
// const 宣告不會掛到 vm 的 global，明確匯出分派表再斷言。
vm.runInContext(html.slice(start, end) + "\n;globalThis.__routes = LOCAL_ACTION_ROUTES;", sandbox);

const routes = sandbox.__routes;
assert.ok(Array.isArray(routes) && routes.length >= 5, "分派表不存在或數量不足");

const seen = new Map();
routes.forEach((route) => {
  assert.ok(Array.isArray(route.actions) && route.actions.length, "分派表的 actions 不可為空");
  assert.equal(typeof route.handler, "function", "分派表的 handler 必須是函式");
  route.actions.forEach((action) => {
    assert.ok(!seen.has(action), `action 重複分派：${action}`);
    seen.set(action, route.handler);
  });
});

// 前端實際送出的每一個本機 action 都必須命中分派表。
const caller = [...html.matchAll(/localRequest\(\s*["']([^"']+)["']/g)].map((match) => match[1]);
assert.ok(caller.length >= 5, "沒有抓到前端呼叫的 action");
const missing = [...new Set(caller)].filter((action) => !seen.has(action));
assert.deepEqual(missing, [], `前端呼叫但分派表沒有接的 action：${missing.join(", ")}`);

(async () => {
  const settings = await sandbox.localRequest("settings", {});
  assert.equal(settings.ok, true, "settings 沒有回傳 ok");
  assert.equal(settings.settings.maxImageBytes, constants.MAX_IMAGE_BYTES, "settings 的圖片上限不符");

  const admin = await sandbox.localRequest("verifyAdmin", {});
  assert.equal(admin.token, "local-admin", "本機示範模式不需要密語，應直接放行");

  const sheet = await sandbox.localRequest("sheetUrl", {});
  assert.equal(sheet.url, "", "本機模式沒有試算表網址");

  await assert.rejects(
    () => sandbox.localRequest("noSuchLocalAction", {}),
    /未知的本機操作/,
    "未知 action 必須被擋下"
  );

  console.log(`local-dispatch=PASS actions=${seen.size} callers=${new Set(caller).size}`);
})().catch((error) => {
  console.error(error && error.message || error);
  process.exit(1);
});
