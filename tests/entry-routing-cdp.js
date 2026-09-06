const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

(async () => {
  const targets = await (await fetch("http://127.0.0.1:9224/json")).json();
  const target = targets.find((item) => item.type === "page");
  if (!target) throw new Error("找不到 CDP page，請先啟動瀏覽器測試環境。");

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let sequence = 0;
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const item = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) item.reject(new Error(message.error.message));
    else item.resolve(message.result);
  };
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });

  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error((result.exceptionDetails.text || "runtime-evaluate-error") + ": " + ((result.exceptionDetails.exception && result.exceptionDetails.exception.description) || ""));
    }
    return result.result && result.result.value;
  };

  await call("Runtime.enable");
  await call("Page.enable");
  await call("Page.navigate", { url: "http://127.0.0.1:4173/index.html" });
  await sleep(700);

  const result = await evaluate(`(async () => {
    const boardId = "B-entry-cdp";
    const archivedId = "B-entry-cdp-archived";
    const originalDemo = state.demo;
    const waitFor = async (predicate) => {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      return Boolean(predicate());
    };
    state.demo = true;
    await localDelete("boards", boardId);
    await localDelete("boards", archivedId);
    await localPut("boards", { id: boardId, name: "入口測試版面", description: "公開學生入口測試", pdfFileId: "", pdfFileName: "", pdfMime: "application/pdf", materials: [], areas: [], answerMasks: [], status: "啟用", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await localPut("boards", { id: archivedId, name: "不應公開版面", description: "", pdfFileId: "", pdfFileName: "", pdfMime: "application/pdf", materials: [], areas: [], answerMasks: [], status: "封存", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

    history.replaceState({}, "", "/index.html");
    state.adminToken = "stale-token-from-previous-session";
    state.teacherAuthenticated = false;
    localStorage.setItem(APP_KEY + "admin_token", state.adminToken);
    await runRouteRender();
    const portalReady = state.view === "portal" && Boolean(document.querySelector("[data-announcement-surface=portal]")) && !document.getElementById("teacherEntryButton").hidden;
    const staleTokenStillShowsEntry = document.getElementById("teacherEntryButton").textContent === "教師入口";
    const portalHasNoDuplicateTeacherButton = !document.getElementById("portalTeacherButton");
    const publicBoardResult = await localRequest("listPublicBoards", {});
    const publicBoardIds = (publicBoardResult.data || []).map((item) => item.id);
    const publicListFiltersArchived = publicBoardIds.includes(boardId) && !publicBoardIds.includes(archivedId);
    const portalCardsHaveNoStudentLabel = !Array.from(document.querySelectorAll("#portalBoardGrid .meta-chip")).some((item) => item.textContent.trim() === "學生入口");
    const portalHasNoTeacherControls = !document.querySelector("#portalBoardGrid [data-edit-board]") && !document.querySelector("#portalBoardGrid [data-review-board]");
    const sortProbe = sortBoardsByUpdatedAt([{ id: "old", updatedAt: "2026-09-01T00:00:00.000Z" }, { id: "new", updatedAt: "2026-09-06T00:00:00.000Z" }]).map((item) => item.id).join(",");
    const boardsSortByUpdatedAt = sortProbe === "new,old";

    document.getElementById("teacherEntryButton").click();
    await routeRenderPromise;
    const teacherEntryOpensManager = await waitFor(() => state.view === "manager" && Boolean(document.getElementById("createBoardButton")));
    const teacherShowsLogout = document.getElementById("teacherEntryButton").textContent === "登出";
    const teacherAnnouncementAvailable = Boolean(document.querySelector("[data-announcement-surface=manager]"));
    document.getElementById("teacherEntryButton").click();
    await routeRenderPromise;
    const teacherLogoutReturnsPortal = await waitFor(() => state.view === "portal" && document.getElementById("teacherEntryButton").textContent === "教師入口");

    history.replaceState({}, "", "/index.html?view=student&board=" + encodeURIComponent(boardId));
    await runRouteRender();
    const studentHasPdfShell = state.view === "student" && Boolean(document.querySelector(".student-shell"));
    const studentHasNoAnnouncement = !document.querySelector("[data-announcement-surface]");
    const shareUrl = new URL(makeBoardUrl(boardId));
    const shareIsStudentOnly = shareUrl.searchParams.get("view") === "student" && shareUrl.searchParams.get("board") === boardId && !shareUrl.searchParams.has("manager");

    await localDelete("boards", boardId);
    await localDelete("boards", archivedId);
    state.demo = originalDemo;
    return JSON.stringify({ portalReady, staleTokenStillShowsEntry, portalHasNoDuplicateTeacherButton, publicListFiltersArchived, portalCardsHaveNoStudentLabel, portalHasNoTeacherControls, boardsSortByUpdatedAt, teacherEntryOpensManager, teacherShowsLogout, teacherAnnouncementAvailable, teacherLogoutReturnsPortal, studentHasPdfShell, studentHasNoAnnouncement, shareIsStudentOnly });
  })()`);

  const checks = JSON.parse(result);
  assert(checks.portalReady === true, "根網址未開啟公開入口或教師入口未顯示");
  assert(checks.staleTokenStillShowsEntry === true, "尚未完成登入驗證時不應顯示登出");
  assert(checks.portalHasNoDuplicateTeacherButton === true, "公開入口仍有重複的內容區教師入口");
  assert(checks.publicListFiltersArchived === true, "公開版面清單未排除封存版面");
  assert(checks.portalCardsHaveNoStudentLabel === true, "公開版面卡片仍顯示學生入口標籤");
  assert(checks.portalHasNoTeacherControls === true, "公開入口出現教師管理控制");
  assert(checks.boardsSortByUpdatedAt === true, "版面未依更新時間倒序排列");
  assert(checks.teacherEntryOpensManager === true, "教師入口未導向管理頁");
  assert(checks.teacherShowsLogout === true, "教師登入後右上角未改為登出");
  assert(checks.teacherAnnouncementAvailable === true, "教師端公告未保留");
  assert(checks.teacherLogoutReturnsPortal === true, "教師登出後未回到公開入口");
  assert(checks.studentHasPdfShell === true, "學生頁未正確開啟");
  assert(checks.studentHasNoAnnouncement === true, "學生頁仍顯示公告");
  assert(checks.shareIsStudentOnly === true, "分享網址未固定為學生版");
  console.log("entry-routing-cdp=" + JSON.stringify(checks));
  socket.close();
})().catch((error) => {
  console.error("entry-routing-cdp-error=" + error.message);
  process.exit(1);
});
