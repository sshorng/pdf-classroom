const assert = require('node:assert/strict');
(async () => {
  const targets = await (await fetch('http://127.0.0.1:9224/json')).json();
  const target = targets.find(item => item.type === 'page');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let sequence = 0;
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  try {
    await call('Network.enable');
    await call('Network.setBlockedURLs', { urls: ['*://script.google.com/*', '*://script.googleusercontent.com/*'] });
    await call('Page.enable');
    await call('Page.navigate', { url: 'http://127.0.0.1:4173/index.html' });
    await new Promise(resolve => setTimeout(resolve, 1500));
    const evaluated = await call('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
      const original = { loadAnnouncements, publicApi, ensurePdfJs, getFileWithCache, localRequest, gasGet, demo: state.demo };
      let releaseAnnouncements;
      let boardsRequested = false;
      let releaseEngine;
      let fileStarted = false;
      try {
        state.demo = true;
        loadAnnouncements = () => new Promise(resolve => { releaseAnnouncements = resolve; });
        publicApi = async () => { boardsRequested = true; return { ok: true, data: [] }; };
        state.view = 'portal'; state.boardId = '';
        const generation = ++routeLoadGeneration;
        const rendering = renderPortalView(generation);
        await new Promise(resolve => setTimeout(resolve, 100));
        const announcementDoesNotBlock = boardsRequested && !!document.getElementById('portalBoardGrid');
        releaseAnnouncements([]);
        await rendering;
        ensurePdfJs = () => new Promise(resolve => { releaseEngine = resolve; });
        getFileWithCache = async () => { fileStarted = true; return { base64: 'AA==' }; };
        state.materials = [{ id: 'network-test', pdfFileId: 'network-test-file' }];
        const loading = loadMaterialPdf('network-test');
        await new Promise(resolve => setTimeout(resolve, 20));
        const downloadDoesNotWaitForEngine = fileStarted;
        releaseEngine({ getDocument: () => ({ promise: Promise.resolve({ numPages: 1, destroy() {} }) }) });
        await loading;
        state.view = 'student'; state.boardId = 'network-board'; state.board = { id: 'network-board' };
        state.activeMaterialId = 'network-test'; state.currentPage = 1; state.zoom = 1.25;
        localRequest = async (action, payload) => action === 'classroomSync' ? {
          state: { materialId: 'network-test', page: 4, zoom: 1.9 }, inkChanged: false, catalogChanged: false
        } : original.localRequest(action, payload);
        await loadClassroomSync();
        const studentPositionPreserved = state.currentPage === 1 && state.zoom === 1.25;
        state.answerMasks = normalizeAnswerMasks([{ id: 'network-mask', boardId: 'network-board', materialId: 'network-test', page: 1, x: .1, y: .1, width: .2, height: .2 }], 'network-board');
        state.revealedAnswerMaskIds = new Set();
        revealAnswerMask('network-mask');
        const studentCannotRevealAnswer = !state.revealedAnswerMaskIds.has('network-mask');
        const calls = [];
        let legacy = false;
        state.demo = false;
        gasGet = async action => {
          calls.push(action);
          return { ok: true, state: { materialId: 'network-test', page: 1, zoom: 1.25 }, pulseVersion: 'p', stateVersion: 's', catalogVersion: 'c', inkVersion: 'i', inkChanged: true, catalogChanged: false, ink: legacy && action === 'classroomPulse' ? null : [], inkDelta: true };
        };
        await loadClassroomSync({ pulse: true });
        const combinedSyncUsesOneRequest = calls.join(',') === 'classroomPulse';
        calls.length = 0; legacy = true;
        await loadClassroomSync({ pulse: true });
        const legacySyncStillWorks = calls.join(',') === 'classroomPulse,classroomSync';
        return { announcementDoesNotBlock, downloadDoesNotWaitForEngine, studentPositionPreserved, studentCannotRevealAnswer, combinedSyncUsesOneRequest, legacySyncStillWorks };
      } finally {
        loadAnnouncements = original.loadAnnouncements; publicApi = original.publicApi;
        ensurePdfJs = original.ensurePdfJs; getFileWithCache = original.getFileWithCache;
        localRequest = original.localRequest;
        gasGet = original.gasGet;
        clearMaterialPdfCache(); state.pdf = null; state.demo = original.demo;
      }
    })()` });
    if (evaluated.exceptionDetails) throw new Error(JSON.stringify(evaluated.exceptionDetails));
    const result = evaluated.result.value;
    assert.equal(result.announcementDoesNotBlock, true);
    assert.equal(result.downloadDoesNotWaitForEngine, true);
    assert.equal(result.studentPositionPreserved, true);
    assert.equal(result.studentCannotRevealAnswer, true);
    assert.equal(result.combinedSyncUsesOneRequest, true);
    assert.equal(result.legacySyncStillWorks, true);
    console.log('network-browser=' + JSON.stringify(result));
  } finally { socket.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
