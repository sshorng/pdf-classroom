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
  await sleep(900);

  const result = await evaluate(`(async () => {
    const ids = ["AN-cdp-a", "AN-cdp-b", "AN-cdp-c"];
    const originalDemo = state.demo;
    const originalAnnouncements = state.announcements;
    state.demo = true;
    for (const id of ids) await localDelete("announcements", id);

    let invalidUrlRejected = false;
    try {
      await localRequest("createAnnouncement", { id: "AN-cdp-invalid", title: "不應建立", url: "javascript:alert(1)" });
    } catch (error) {
      invalidUrlRejected = true;
    }

    await localRequest("createAnnouncement", { id: ids[0], title: "一般入口", description: "提供學生查閱資料。", links: [{ label: "查字典", url: "https://example.com/normal" }, { label: "參考影片", url: "https://example.com/video" }], pinned: false, order: 1 });
    await localRequest("createAnnouncement", { id: ids[1], title: "置頂入口", url: "http://example.com/pinned", pinned: true, order: 2 });
    await localRequest("createAnnouncement", { id: ids[2], title: "第二個置頂入口", url: "https://example.com/second", pinned: true, order: 3 });
    const created = await localRequest("listAnnouncements", {});
    const initialSort = created.data.map((item) => item.id).join(",") === "AN-cdp-b,AN-cdp-c,AN-cdp-a";
    const multipleLinksStored = created.data.find((item) => item.id === ids[0]).links.length === 2 && created.data.find((item) => item.id === ids[0]).links[1].label === "參考影片";
    await localRequest("updateAnnouncement", { id: ids[0], title: "更新後入口", url: "https://example.com/updated", pinned: false });
    const updated = await localRequest("listAnnouncements", {});
    const legacyUrlUpdatePreservesLinks = updated.data.find((item) => item.id === ids[0]).links.length === 2 && updated.data.find((item) => item.id === ids[0]).links[0].url === "https://example.com/updated";
    const reordered = await localRequest("reorderAnnouncements", { items: [{ id: ids[2] }, { id: ids[1] }, { id: ids[0] }] });
    const reorderWorks = reordered.data.map((item) => item.id).join(",") === "AN-cdp-c,AN-cdp-b,AN-cdp-a";

    const host = document.createElement("div");
    host.id = "announcementCdpHost";
    host.innerHTML = announcementSurfaceHtml("manager-test", true, false) + announcementSurfaceHtml("student", false, true);
    document.body.appendChild(host);
    state.announcementLoading = false;
    state.announcements = normalizeAnnouncements(reordered.data);
    renderAnnouncementSurfaces();
    const manager = host.querySelector("[data-announcement-surface=manager-test]");
    const student = host.querySelector("[data-announcement-surface=student]");
    const managerCards = manager && manager.querySelectorAll(".announcement-card").length === 3;
    if (host.querySelector(".announcement-card:not(.is-pinned) .announcement-tag")) throw new Error("一般公告仍顯示分類膠囊");
    if (manager.querySelectorAll(".is-pinned .announcement-tag").length !== 2) throw new Error("置頂標記未保留");
    const managerHasControls = manager && manager.querySelectorAll("[data-announcement-edit]").length === 3 && manager.querySelectorAll("[data-announcement-delete]").length === 3;
    const managerDescriptionRemoved = manager && manager.querySelectorAll(".announcement-heading > div > p").length === 1;
    const studentDescriptionRemoved = student && student.querySelectorAll(".announcement-heading > div > p").length === 1;
    const descriptionDisplayed = manager && manager.querySelector(".announcement-description") && manager.querySelector(".announcement-description").textContent === "提供學生查閱資料。";
    const managerMultipleLinks = manager && manager.querySelectorAll(".announcement-link").length === 4 && manager.querySelector(".announcement-card-title").textContent === "第二個置頂入口";
    const managerList = manager && manager.querySelector(".announcement-list");
    const managerCard = manager && manager.querySelector(".announcement-card");
    const listStyle = managerList && getComputedStyle(managerList);
    const cardStyle = managerCard && getComputedStyle(managerCard);
    const horizontalCardLayout = Boolean(managerList && managerCard && listStyle.display === "flex" && listStyle.flexDirection === "row" && listStyle.flexWrap === "nowrap" && listStyle.overflowX === "auto" && cardStyle.flexBasis !== "auto");
    const studentIsReadOnly = student && !student.querySelector("[data-announcement-add]") && !student.querySelector(".announcement-card-actions");
    const link = student && student.querySelector(".announcement-link");
    const linkIsSafe = link && link.target === "_blank" && link.rel.includes("noopener") && link.rel.includes("noreferrer");
    const toolbar = document.createElement("div");
    toolbar.id = "teacherPdfToolbar";
    document.body.appendChild(toolbar);
    mountClassroomAnnouncementSurface();
    const classroomDrawer = document.getElementById("classroomAnnouncementDrawer");
    const classroomDrawerMounted = Boolean(document.getElementById("classroomAnnouncementButton") && classroomDrawer && classroomDrawer.querySelector("[data-announcement-surface=classroom]") && !classroomDrawer.querySelector("[data-announcement-add]") && !classroomDrawer.querySelector(".announcement-card-actions"));
    openAnnouncementForm();
    const descriptionFieldOptional = Boolean(document.querySelector("#modalContent #announcementDescriptionField") && !document.querySelector("#modalContent #announcementDescriptionField").required);
    const linkEditor = document.querySelector("#modalContent #announcementLinksEditor");
    const addLinkButton = document.querySelector("#modalContent #addAnnouncementLinkButton");
    const initialLinkRows = linkEditor && linkEditor.querySelectorAll("[data-announcement-link-row]").length === 1;
    if (addLinkButton) addLinkButton.click();
    const linkEditorAddsRows = linkEditor && linkEditor.querySelectorAll("[data-announcement-link-row]").length === 2;
    const secondLinkRemove = linkEditor && linkEditor.querySelectorAll("[data-announcement-link-row]")[1] && linkEditor.querySelectorAll("[data-announcement-link-row]")[1].querySelector("[data-remove-announcement-link]");
    if (secondLinkRemove) secondLinkRemove.click();
    const linkEditorRemovesRows = linkEditor && linkEditor.querySelectorAll("[data-announcement-link-row]").length === 1;
    const pinnedInput = document.querySelector("#modalContent .announcement-checkbox input");
    const pinnedCopy = document.querySelector("#modalContent .announcement-checkbox span");
    const pinnedInputRect = pinnedInput && pinnedInput.getBoundingClientRect();
    const pinnedCopyRect = pinnedCopy && pinnedCopy.getBoundingClientRect();
    const pinnedCheckboxLayout = Boolean(pinnedInputRect && pinnedCopyRect && pinnedInputRect.width <= 20 && pinnedInputRect.height <= 20 && pinnedCopyRect.left - pinnedInputRect.right <= 20);
    closeModal(false);

    const originalLocalRequest = localRequest;
    let submittedId;
    let retryAction;
    localRequest = async function (action, payload) {
      submittedId = payload.id;
      return { data: [{ ...payload, links: [payload.links[0]] }], announcement: payload };
    };
    const formPromise = openAnnouncementForm();
    document.getElementById("announcementTitleField").value = "表單保存測試";
    document.getElementById("addAnnouncementLinkButton").click();
    document.getElementById("addAnnouncementLinkButton").click();
    const formRows = [...document.querySelectorAll("[data-announcement-link-row]")];
    formRows.forEach((row, index) => {
      row.querySelector("[name=announcementLinkLabel]").value = "連結" + index;
      row.querySelector("[name=announcementLinkUrl]").value = "https://example.com/form/" + index;
    });
    formRows[1].querySelector("[data-remove-announcement-link]").click();
    const submittedForm = document.querySelector("#modalContent form");
    submittedForm.requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const incompleteSavePreservesForm = document.querySelector("#modalContent form") === submittedForm && document.getElementById("modalOverlay").classList.contains("show") && document.getElementById("modalMessage").textContent.includes("後端未確認完整保存") && !document.querySelector("#modalActions [type=submit]").disabled && submittedForm.querySelectorAll("[name=announcementLinkUrl]")[1].value === "https://example.com/form/2";
    if (!incompleteSavePreservesForm) throw new Error("不完整儲存未保留表單與錯誤訊息");
    await originalLocalRequest("createAnnouncement", { id: submittedId, title: "表單保存測試", url: "https://example.com/form/0" });
    localRequest = async function (action, payload) {
      retryAction = action;
      return originalLocalRequest(action, payload);
    };
    submittedForm.requestSubmit();
    await formPromise;
    localRequest = originalLocalRequest;
    await loadAnnouncements();
    const savedFormRow = state.announcements.find((item) => item.id === submittedId);
    const formSaveRoundTrip = retryAction === "updateAnnouncement" && savedFormRow.links.length === 2 && savedFormRow.links[1].label === "連結2" && savedFormRow.links[1].url === "https://example.com/form/2";
    if (!formSaveRoundTrip) throw new Error("表單重試或重新載入後連結遺失");
    openAnnouncementForm(savedFormRow);
    const reopenedLinksPreserved = document.querySelectorAll("#announcementLinksEditor [data-announcement-link-row]").length === 2 && document.querySelectorAll("[name=announcementLinkLabel]")[1].value === "連結2";
    if (!reopenedLinksPreserved) throw new Error("重新編輯後連結遺失");
    closeModal(false);
    let resolveOldLoad;
    localRequest = () => new Promise((resolve) => { resolveOldLoad = resolve; });
    const oldLoad = loadAnnouncements();
    applyAnnouncementResult({ data: [savedFormRow] });
    resolveOldLoad({ data: [] });
    await oldLoad;
    const staleLoadIgnored = state.announcements.length === 1 && state.announcements[0].id === submittedId && !state.announcementLoading;
    if (!staleLoadIgnored) throw new Error("舊查詢覆蓋新儲存結果");
    localRequest = originalLocalRequest;
    await localDelete("announcements", submittedId);

    const deleted = await localRequest("deleteAnnouncement", { id: ids[2] });
    const deleteWorks = deleted.deleted === 1 && deleted.data.length === 2;
    await Promise.all(ids.map((id) => localDelete("announcements", id)));
    await localDelete("announcements", "AN-cdp-invalid");
    host.remove();
    removeFloatingAnnouncementSurfaces();
    toolbar.remove();
    state.demo = originalDemo;
    state.announcements = originalAnnouncements;
    renderAnnouncementSurfaces();
    return JSON.stringify({ ready: true, incompleteSavePreservesForm, formSaveRoundTrip, reopenedLinksPreserved, staleLoadIgnored, invalidUrlRejected, initialSort, multipleLinksStored, legacyUrlUpdatePreservesLinks, reorderWorks, managerCards, managerHasControls, managerDescriptionRemoved, studentDescriptionRemoved, descriptionDisplayed, managerMultipleLinks, descriptionFieldOptional, initialLinkRows, linkEditorAddsRows, linkEditorRemovesRows, horizontalCardLayout, studentIsReadOnly, linkIsSafe, classroomDrawerMounted, pinnedCheckboxLayout, deleteWorks });
  })()`);

  const checks = JSON.parse(result);
  assert(checks.ready === true, "公告測試頁面未準備完成");
  assert(checks.invalidUrlRejected === true, "公告未拒絕非 http／https 連結");
  assert(checks.initialSort === true, "公告置頂與初始排序錯誤");
  assert(checks.multipleLinksStored === true, "單則公告未保存多個連結");
  assert(checks.legacyUrlUpdatePreservesLinks === true, "更新舊版單一網址時未保留其他連結");
  assert(checks.reorderWorks === true, "公告排序更新失敗");
  assert(checks.managerCards === true, "教師端公告卡片未正確渲染");
  assert(checks.managerHasControls === true, "教師端公告管理控制未出現");
  assert(checks.managerDescriptionRemoved === true, "公告標題下方說明文字未移除");
  assert(checks.studentDescriptionRemoved === true, "學生端公告標題下方說明文字未移除");
  assert(checks.descriptionDisplayed === true, "公告簡要說明未顯示在標題下方");
  assert(checks.managerMultipleLinks === true, "公告卡片未顯示多個連結");
  assert(checks.descriptionFieldOptional === true, "公告簡要說明欄位未設為選填");
  assert(checks.initialLinkRows === true, "公告表單未建立初始連結欄位");
  assert(checks.linkEditorAddsRows === true, "公告表單無法新增連結欄位");
  assert(checks.linkEditorRemovesRows === true, "公告表單無法移除連結欄位");
  assert(checks.horizontalCardLayout === true, "公告卡片未以橫向捲動排列");
  assert(checks.studentIsReadOnly === true, "學生端公告仍可見管理控制");
  assert(checks.linkIsSafe === true, "公告連結未以安全的新分頁開啟");
  assert(checks.classroomDrawerMounted === true, "教師課堂公告抽屜未正確掛載或錯誤提供管理控制");
  assert(checks.pinnedCheckboxLayout === true, "置頂 checkbox 版面跑版");
  assert(checks.deleteWorks === true, "公告刪除失敗");
  console.log("announcement-cdp=" + JSON.stringify(checks));
  for (const width of [1280, 375]) {
    await call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
    const layout = await evaluate(`(() => {
      const original = state.announcements;
      const host = document.createElement("div");
      host.style.cssText = "position:fixed;inset:0;z-index:9999;overflow:auto;background:white";
      host.innerHTML = announcementSurfaceHtml("layout-manager", true, false) + announcementSurfaceHtml("layout-student", false, true);
      document.body.appendChild(host);
      try {
        const links = Array.from({ length: 8 }, (_, i) => ({ label: "很長的公告連結名稱".repeat(5) + i, url: "https://example.com/" + i }));
        state.announcements = normalizeAnnouncements([{ id: "layout-one", title: "公告標題".repeat(20), description: "公告說明".repeat(30), updatedAt: "2026-09-08T02:45:00Z", pinned: true, links: links.slice(0, 1) }, { id: "layout-eight", title: "八個連結", updatedAt: "2026-09-08T02:45:00Z", links }]);
        renderAnnouncementSurfaces();
        return [...host.querySelectorAll("[data-announcement-surface]")].map(root => {
          const cards = [...root.querySelectorAll(".announcement-card")];
          const heights = cards.map(card => card.getBoundingClientRect().height);
          for (const card of cards) {
            const top = card.querySelector(".announcement-card-top");
            const title = top.querySelector(".announcement-card-title");
            const time = top.querySelector(".announcement-time");
            const tag = top.querySelector(".announcement-tag");
            const titleRect = title.getBoundingClientRect();
            const timeRect = time.getBoundingClientRect();
            if (Math.abs((titleRect.top + titleRect.bottom) / 2 - (timeRect.top + timeRect.bottom) / 2) > 1 || timeRect.left < titleRect.right || (tag && tag.nextElementSibling !== title)) throw new Error("標題、置頂與時間未在同一行依序排列");
          }
          const area = cards[1].querySelector(".announcement-links");
          area.scrollTop = area.scrollHeight;
          const last = area.lastElementChild.getBoundingClientRect();
          const bounds = area.getBoundingClientRect();
          const actions = cards[1].querySelector(".announcement-card-actions");
          return {
            heights,
            fixedHeight: heights[0] === heights[1] && heights[0] === (root.classList.contains("announcement-surface-compact") ? 220 : 240),
            scrolls: area.scrollTop > 0 && last.bottom <= bounds.bottom + 1,
            singleLine: [...root.querySelectorAll(".announcement-link")].every(link => getComputedStyle(link).flexDirection === "row" && link.getBoundingClientRect().height <= 40 && link.title.includes(link.href)),
            noHorizontalOverflow: area.scrollWidth === area.clientWidth,
            actionsVisible: !actions || actions.getBoundingClientRect().bottom <= cards[1].getBoundingClientRect().bottom,
            originalDeleteButton: !actions || actions.querySelector("[data-announcement-delete]").textContent === "×"
          };
        });
      } finally {
        state.announcements = original;
        host.remove();
        renderAnnouncementSurfaces();
      }
    })()`);
    for (const item of layout) {
      assert(item.fixedHeight && item.scrolls && item.singleLine && item.noHorizontalOverflow && item.actionsVisible && item.originalDeleteButton, "公告卡片版面驗證失敗：" + JSON.stringify({ width, ...item }));
    }
    console.log("announcement-layout=" + JSON.stringify({ width, surfaces: layout }));
  }
  await call("Emulation.clearDeviceMetricsOverride");
  socket.close();
})().catch((error) => {
  console.error("announcement-cdp-error=" + error.message);
  process.exit(1);
});
