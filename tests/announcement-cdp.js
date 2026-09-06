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

    await localRequest("createAnnouncement", { id: ids[0], title: "一般入口", description: "提供學生查閱資料。", url: "https://example.com/normal", pinned: false, order: 1 });
    await localRequest("createAnnouncement", { id: ids[1], title: "置頂入口", url: "http://example.com/pinned", pinned: true, order: 2 });
    await localRequest("createAnnouncement", { id: ids[2], title: "第二個置頂入口", url: "https://example.com/second", pinned: true, order: 3 });
    const created = await localRequest("listAnnouncements", {});
    const initialSort = created.data.map((item) => item.id).join(",") === "AN-cdp-b,AN-cdp-c,AN-cdp-a";
    await localRequest("updateAnnouncement", { id: ids[0], title: "更新後入口", url: "https://example.com/updated", pinned: false });
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
    const managerHasControls = manager && manager.querySelectorAll("[data-announcement-edit]").length === 3 && manager.querySelectorAll("[data-announcement-delete]").length === 3;
    const managerDescriptionRemoved = manager && manager.querySelectorAll(".announcement-heading > div > p").length === 1;
    const studentDescriptionRemoved = student && student.querySelectorAll(".announcement-heading > div > p").length === 1;
    const descriptionDisplayed = manager && manager.querySelector(".announcement-description") && manager.querySelector(".announcement-description").textContent === "提供學生查閱資料。";
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
    const pinnedInput = document.querySelector("#modalContent .announcement-checkbox input");
    const pinnedCopy = document.querySelector("#modalContent .announcement-checkbox span");
    const pinnedInputRect = pinnedInput && pinnedInput.getBoundingClientRect();
    const pinnedCopyRect = pinnedCopy && pinnedCopy.getBoundingClientRect();
    const pinnedCheckboxLayout = Boolean(pinnedInputRect && pinnedCopyRect && pinnedInputRect.width <= 20 && pinnedInputRect.height <= 20 && pinnedCopyRect.left - pinnedInputRect.right <= 20);
    closeModal(false);

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
    return JSON.stringify({ ready: true, invalidUrlRejected, initialSort, reorderWorks, managerCards, managerHasControls, managerDescriptionRemoved, studentDescriptionRemoved, descriptionDisplayed, descriptionFieldOptional, horizontalCardLayout, studentIsReadOnly, linkIsSafe, classroomDrawerMounted, pinnedCheckboxLayout, deleteWorks });
  })()`);

  const checks = JSON.parse(result);
  assert(checks.ready === true, "公告測試頁面未準備完成");
  assert(checks.invalidUrlRejected === true, "公告未拒絕非 http／https 連結");
  assert(checks.initialSort === true, "公告置頂與初始排序錯誤");
  assert(checks.reorderWorks === true, "公告排序更新失敗");
  assert(checks.managerCards === true, "教師端公告卡片未正確渲染");
  assert(checks.managerHasControls === true, "教師端公告管理控制未出現");
  assert(checks.managerDescriptionRemoved === true, "公告標題下方說明文字未移除");
  assert(checks.studentDescriptionRemoved === true, "學生端公告標題下方說明文字未移除");
  assert(checks.descriptionDisplayed === true, "公告簡要說明未顯示在標題下方");
  assert(checks.descriptionFieldOptional === true, "公告簡要說明欄位未設為選填");
  assert(checks.horizontalCardLayout === true, "公告卡片未以橫向捲動排列");
  assert(checks.studentIsReadOnly === true, "學生端公告仍可見管理控制");
  assert(checks.linkIsSafe === true, "公告連結未以安全的新分頁開啟");
  assert(checks.classroomDrawerMounted === true, "教師課堂公告抽屜未正確掛載或錯誤提供管理控制");
  assert(checks.pinnedCheckboxLayout === true, "置頂 checkbox 版面跑版");
  assert(checks.deleteWorks === true, "公告刪除失敗");
  console.log("announcement-cdp=" + JSON.stringify(checks));
  socket.close();
})().catch((error) => {
  console.error("announcement-cdp-error=" + error.message);
  process.exit(1);
});
