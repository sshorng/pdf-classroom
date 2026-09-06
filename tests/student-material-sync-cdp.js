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
  await call("Page.navigate", { url: "http://127.0.0.1:4173/index.html?board=B-ecef9584f5874c" });
  await sleep(1400);

  const result = await evaluate(`(async () => {
    const waitFor = async (predicate, timeout) => {
      const deadline = Date.now() + (timeout || 15000);
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return false;
    };
    const ready = await waitFor(() => state.view === "student" && state.pdf && state.materials.length > 1 && document.getElementById("pageStage"), 15000);
    if (!ready) return JSON.stringify({ ready: false, view: state.view, materialCount: state.materials.length });
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }

    const original = {
      demo: state.demo,
      view: state.view,
      activeMaterialId: state.activeMaterialId,
      currentPage: state.currentPage,
      zoom: state.zoom,
      classroomStateRevision: state.classroomStateRevision,
      classroomStateVersion: state.classroomStateVersion,
      classroomCatalogVersion: state.classroomCatalogVersion,
      classroomPulseVersion: state.classroomPulseVersion,
      materials: state.materials,
      areas: state.areas,
      answerMasks: state.answerMasks,
      localRequest: window.localRequest,
      selectMaterial: window.selectMaterial
    };
    const scroll = document.querySelector(".student-workspace .pdf-scroll");
    const scrollDescriptor = scroll && Object.getOwnPropertyDescriptor(scroll, "scrollTop");
    const materialA = state.materials[0];
    const materialB = state.materials[1];
    const ownPage = state.pdf.numPages > 1 ? 2 : 1;
    const ownZoom = 1.35;
    const remotePage = state.pdf.numPages > ownPage ? ownPage + 1 : ownPage;
    const remoteZoom = 1.9;
    let responseMaterialId = materialA.id;
    let lastSyncPayload = null;
    let selection = null;
    state.demo = true;
    state.view = "student";
    state.classroomStateRevision = 0;
    state.activeMaterialId = materialA.id;
    state.currentPage = ownPage;
    state.zoom = ownZoom;
    if (scroll) {
      try { Object.defineProperty(scroll, "scrollTop", { configurable: true, writable: true, value: 173 }); } catch (error) {}
    }
    const ownScrollTop = scroll ? scroll.scrollTop : 0;
    window.localRequest = async function (action, payload) {
      if (action !== "classroomSync") return original.localRequest(action, payload);
      lastSyncPayload = payload;
      return {
        state: { id: "STATE-test", boardId: state.board.id, materialId: responseMaterialId, page: remotePage, zoom: remoteZoom, updatedAt: new Date().toISOString() },
        materials: state.materials,
        areas: state.areas,
        answerMasks: state.answerMasks,
        ink: [],
        inkChanged: false,
        submissionCounts: {}
      };
    };

    await loadClassroomSync({ pulse: false });
    const sameMaterialPreservesPosition = state.currentPage === ownPage && state.zoom === ownZoom && (!scroll || scroll.scrollTop === ownScrollTop);
    const sameMaterialUsesOwnPageForInk = lastSyncPayload && Number(lastSyncPayload.inkPage) === ownPage;

    window.selectMaterial = async function (materialId, options) {
      selection = { materialId, options: options || {} };
      return true;
    };
    responseMaterialId = materialB.id;
    state.activeMaterialId = materialA.id;
    state.currentPage = ownPage;
    state.zoom = ownZoom;
    await loadClassroomSync({ pulse: false });
    const materialSwitchKeepsRemotePositionOut = Boolean(selection && selection.materialId === materialB.id && selection.options.page === undefined && selection.options.zoom === undefined);
    const materialSwitchPreservesCurrentPosition = state.currentPage === ownPage && state.zoom === ownZoom;

    window.localRequest = original.localRequest;
    window.selectMaterial = original.selectMaterial;
    state.demo = original.demo;
    state.view = original.view;
    state.activeMaterialId = original.activeMaterialId;
    state.currentPage = original.currentPage;
    state.zoom = original.zoom;
    state.classroomStateRevision = original.classroomStateRevision;
    state.classroomStateVersion = original.classroomStateVersion;
    state.classroomCatalogVersion = original.classroomCatalogVersion;
    state.classroomPulseVersion = original.classroomPulseVersion;
    state.materials = original.materials;
    state.areas = original.areas;
    state.answerMasks = original.answerMasks;
    if (scroll) {
      try {
        if (scrollDescriptor) Object.defineProperty(scroll, "scrollTop", scrollDescriptor);
        else delete scroll.scrollTop;
      } catch (error) {}
    }
    return JSON.stringify({ ready: true, sameMaterialPreservesPosition, sameMaterialUsesOwnPageForInk, materialSwitchKeepsRemotePositionOut, materialSwitchPreservesCurrentPosition });
  })()`);

  const checks = JSON.parse(result);
  assert(checks.ready === true, "學生教材同步測試頁面未準備完成");
  assert(checks.sameMaterialPreservesPosition === true, "學生端被教師頁碼或縮放覆寫");
  assert(checks.sameMaterialUsesOwnPageForInk === true, "學生端筆跡同步沒有使用自己的頁碼");
  assert(checks.materialSwitchKeepsRemotePositionOut === true, "切換學生教材時仍把教師頁碼或縮放傳入");
  assert(checks.materialSwitchPreservesCurrentPosition === true, "學生教材切換錯誤改動目前頁碼或縮放");
  console.log("student-material-sync-cdp=" + JSON.stringify(checks));
  socket.close();
})().catch((error) => {
  console.error("student-material-sync-cdp-error=" + error.message);
  process.exit(1);
});
