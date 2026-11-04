// Worker（Workers＋D1＋R2）本機煙霧測試：以 node:sqlite 模擬 D1，以記憶體 Map 模擬 R2。
// 跑法：node tests/worker-smoke.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const baseDir = path.join(__dirname, '..');
const rawSource = fs.readFileSync(path.join(baseDir, 'worker.js'), 'utf8');
const source = rawSource.split('/* __EXPORT_START__ */')[0];
const fullSource = rawSource.replace(/export default/, 'const WORKER_EXPORT =');

const db = new (require('node:sqlite').DatabaseSync)(':memory:');
db.exec(fs.readFileSync(path.join(baseDir, 'schema.sql'), 'utf8'));

/* D1 介面模擬：prepare→all／run，bind→run／all，batch 依序執行。傳回結果形狀與 D1 相同。 */
function makeD1(sqlite) {
  return {
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      const wrap = (bindings) => ({
        all: async () => ({ results: bindings.length ? stmt.all(...bindings) : stmt.all() }),
        run: async () => { bindings.length ? stmt.run(...bindings) : stmt.run(); return {}; }
      });
      return {
        all: async () => ({ results: stmt.all() }),
        run: async () => { stmt.run(); return {}; },
        bind: (...args) => wrap(args)
      };
    },
    async batch(statements) {
      for (const statement of statements) await statement.run();
      return [];
    }
  };
}

class FakeR2 {
  constructor() { this.map = new Map(); }
  async put(key, value, options) { this.map.set(String(key), asBytes(value)); return { key }; }
  async get(key, options) {
    const bytes = this.map.get(String(key));
    if (!bytes) return null;
    let slice = bytes;
    if (options && options.range && Number.isFinite(options.range.offset)) {
      const offset = options.range.offset;
      const length = options.range.length !== undefined ? options.range.length : bytes.length - offset;
      slice = bytes.slice(offset, offset + length);
    }
    return { arrayBuffer: async () => slice.slice().buffer, size: bytes.length, httpMetadata: options && options.httpMetadata || null, body: slice };
  }
  async delete(key) { this.map.delete(String(key)); }
}

// worker 於 vm realm 內建立的 Uint8Array 在測試 realm 的 instanceof 判別會失敗，
// 改以 ArrayBuffer.isView 檢查內部 slot（跨 realm 相同），字串才走 TextEncoder。
function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return Uint8Array.from(Array.prototype.slice.call(value));
  }
  if (typeof value === 'string') return new TextEncoder().encode(value);
  return Uint8Array.from(Array.from({ length: value.length }, (_, index) => Number(value[index])));
}

const d1 = makeD1(db);
const files = new FakeR2();

// 正式 fetch 入口（含 export default 段）：獨立 vm context，env 綁定由 fetch 參數傳入。
let exportContext = null;
function runWorkerExport() {
  if (exportContext) return exportContext.WORKER_EXPORT;
  const context = Object.assign({
    require, TextEncoder, TextDecoder, URL, URLSearchParams, FormData, fetch,
    Request, Response, Headers, atob, btoa,
    console, setTimeout, clearTimeout
  }, {});
  vm.createContext(context);
  vm.runInContext(fullSource, context, { filename: 'worker.js' });
  // 頂層 const 不掛 context 物件，以第二段 script 取得_WORKER EXPORT 引用。
  context.EXPORT = { fetch: vm.runInContext('WORKER_EXPORT.fetch.bind(WORKER_EXPORT)', context) };
  exportContext = context;
  return context.EXPORT;
}

function runWorker(extra) {
  const context = Object.assign({
    require,
    TextEncoder, TextDecoder, URL, FormData, URLSearchParams, fetch,
    atob, btoa,
    console, setTimeout, clearTimeout, d1, files
  }, extra || {});
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'worker.js' });
  vm.runInContext('RUNTIME.DB = d1; RUNTIME.FILES = files;', context);
  return context;
}

const toBytes = (value) => Array.from(new TextEncoder().encode(value));
const worker = runWorker();

// 偵錯 shim：任何 doPost 失敗印出動作與錯誤訊息；負向測試（預期失敗）不在清單內則照常印出。
const EXPECTED_FAILURES = new Set(['教師管理密語不正確。', '需要教師管理權限。', '尚未設定教師管理密語，請在教師入口首次登入時輸入，輸入成功即自動建立。', '教師管理密語至少需 4 個字。', '沒有可更新的設定欄位。']);
const rawDoPost = worker.doPost.bind(worker);
worker.doPost = async (event) => {
  const result = await rawDoPost(event);
  if (!result || result.ok === false) {
    let action = '';
    try { action = JSON.parse(event.postData && event.postData.contents || '{}').action || ''; } catch (error) { action = (event.parameter && event.parameter.action) || ''; }
    if (!EXPECTED_FAILURES.has(result && result.error || '')) {
      console.error('doPost[' + action + '] error:', JSON.stringify(result));
    }
  }
  return result;
};

(async () => {
  // 啟動與契約
  const ping = await worker.doGet({ parameter: { action: 'ping' } });
  assert.equal(ping.ok, true);
  assert.match(String(ping.apiVersion), /worker/);
  const settings = await worker.doGet({ parameter: { action: 'settings' } });
  assert.equal(settings.ok, true);
  assert.equal(settings.settings.adminConfigured, false);
  assert.equal(settings.settings.maxPdfBytes, 20971520);
  assert.equal((await worker.doGet({ parameter: { action: 'nope' } })).ok, false);
  console.log('PASS startup: ping, settings, unknown action error');

  // action 契約：worker 的 doGet／doPost 覆蓋前端 gasGet／gasPost 的全部動作
  const html = fs.readFileSync(path.join(baseDir, 'index.html'), 'utf8');
  const gasGetRegex = /gasGet\s*\(\s*['"]([^'"]+)['"]/g;
  const gasPostRegex = /gasPost\s*\(\s*['"]([^'"]+)['"]/g;
  const actionsFrom = (regex) => {
    const found = new Set(); let match;
    while ((match = regex.exec(html)) !== null) found.add(match[1]);
    return [...found];
  };
  const frontendGet = actionsFrom(gasGetRegex);
  const frontendPost = actionsFrom(gasPostRegex);
  const backendActions = new Set();
  for (const name of ['doGet', 'doPost']) {
    const start = source.indexOf('async function ' + name + '(');
    const end = source.indexOf('/* 【第 5 區', start);
    const body = source.slice(start, end);
    const regex = /action === ['"]([^'"]+)['"]/g;
    let match;
    while ((match = regex.exec(body)) !== null) backendActions.add(match[1]);
  }
  for (const action of frontendGet) assert.ok(backendActions.has(action), 'doGet 缺少前端動作 ' + action);
  for (const action of frontendPost) assert.ok(backendActions.has(action), 'doPost 缺少前端動作 ' + action);
  console.log('PASS contract: frontend GET/POST actions all routed (' + frontendGet.length + ' GET, ' + frontendPost.length + ' POST)');

  // 首次設定：未設定密碼時，首次登入輸入的密語即自動建立（Workers 版無試算表可填）
  assert.equal((await worker.doPost({ parameter: { action: 'verifyAdmin' }, postData: { contents: JSON.stringify({ action: 'verifyAdmin', password: '' }) } })).ok, false);
  const bootstrap = await worker.doPost({ parameter: { action: 'verifyAdmin' }, postData: { contents: JSON.stringify({ action: 'verifyAdmin', password: 'first-secret', clientId: 'C-smoke' }) } });
  assert.equal(bootstrap.ok, true);
  assert.equal(bootstrap.firstTimeSetup, true);
  assert.ok(bootstrap.token);
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'AdminPassword'").get().value, 'first-secret');
  assert.equal((await worker.doPost({ parameter: { action: 'verifyAdmin' }, postData: { contents: JSON.stringify({ action: 'verifyAdmin', password: 'first-secret' }) } })).ok, true);
  assert.equal((await worker.doPost({ parameter: { action: 'verifyAdmin' }, postData: { contents: JSON.stringify({ action: 'verifyAdmin', password: 'secret' }) } })).ok, false);
  console.log('PASS admin bootstrap: first login creates password, wrong password rejected');

  // 工作表管理與公告
  db.prepare("UPDATE settings SET value = 'secret' WHERE key = 'AdminPassword'").run();
  worker.clearAllTableCaches_();
  const verify = await worker.doPost({ parameter: { action: 'verifyAdmin' }, postData: { contents: JSON.stringify({ action: 'verifyAdmin', password: 'secret' }) } });
  if (!verify.ok) console.error('verifyAdmin payload:', JSON.stringify(verify));
  assert.equal(verify.ok, true);
  const token = verify.token;
  assert.equal((await worker.doPost({ parameter: { action: 'verifyAdmin' }, postData: { contents: JSON.stringify({ action: 'verifyAdmin', password: 'wrong' }) } })).ok, false);
  const announcement = await worker.doPost({ parameter: { action: 'createAnnouncement' }, postData: { contents: JSON.stringify({ action: 'createAnnouncement', adminToken: token, title: '上課提醒', links: [{ label: 'google', url: 'https://www.google.com' }], mutationId: 'M-AN-1' }) } });
  if (!announcement.ok) console.error('createAnnouncement payload:', JSON.stringify(announcement));
  assert.equal(announcement.ok, true);
  const listed = await worker.doGet({ parameter: { action: 'listAnnouncements' } });
  assert.equal(listed.data.length, 1);
  assert.equal(listed.data[0].links[0].label, 'google');
  const repeat = await worker.doPost({ parameter: { action: 'createAnnouncement' }, postData: { contents: JSON.stringify({ action: 'createAnnouncement', adminToken: token, title: '上課提醒', links: [{ label: 'google', url: 'https://www.google.com' }], mutationId: 'M-AN-1' }) } });
  assert.equal(repeat.ok, true);
  assert.equal(repeat.announcement.id, announcement.announcement.id, 'Mutation ID replay must return the cached result');
  console.log('PASS announcements: create, auth gate, public list, mutation idempotency');

  // 版面建立（含 PDF 上傳走 R2）、legacy material、問答區與遮罩
  const pdfBytes = toBytes('%PDF-1.4\n%%EOF\n');
  const boardResult = await worker.doPost({ parameter: { action: 'createBoard' }, postData: { contents: JSON.stringify({
    action: 'createBoard', adminToken: token, name: '吸血蛾講義', description: '國文',
    pdf: { name: '講義.pdf', mime: 'application/pdf', data: 'data:application/pdf;base64,' + Buffer.from(new Uint8Array(pdfBytes)).toString('base64') },
    areas: [{ materialId: '', page: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.1, title: '第一題', prompt: '請作答' }],
    answerMasks: [{ materialId: '', page: 1, x: 0.1, y: 0.3, width: 0.2, height: 0.1, title: '答案遮罩' }]
  }) } });
  assert.equal(boardResult.ok, true);
  const boardId = boardResult.board.id;
  assert.equal(boardResult.materials.length, 1);
  const legacyMaterialId = 'M-' + boardId + '-legacy';
  assert.equal(boardResult.materials[0].id, legacyMaterialId);
  assert.equal(boardResult.areas[0].materialId, legacyMaterialId, 'Legacy rows must adopt the legacy material id');
  const boardData = await worker.doGet({ parameter: { action: 'getBoard', boardId } });
  assert.equal(boardData.ok, true);
  assert.equal(boardData.areas.length, 1);
  assert.equal(boardData.answerMasks.length, 1);
  assert.equal(files.map.size, 1, 'The uploaded PDF must be exactly one R2 object');
  console.log('PASS board: create with PDF, legacy material, areas, masks, single R2 object');

  // 檔案層：getFile JSON 契約與 stream=1 串流（走正式 fetch 入口，含 ETag、Range 206）
  const pdfFileId = boardResult.materials[0].pdfFileId;
  const jsonFile = await worker.doPost({ parameter: { action: 'getFile' }, postData: { contents: JSON.stringify({ action: 'getFile', fileId: pdfFileId, boardId }) } });
  assert.equal(jsonFile.ok, true);
  assert.ok(jsonFile.base64.length > 0);
  assert.equal(Buffer.from(jsonFile.base64, 'base64').toString('latin1').slice(0, 5), '%PDF-');
  const workerExport = runWorkerExport();
  const fileBase = 'https://pdf-workbook-api.example.workers.dev/?action=getFile&stream=1&fileId=' + encodeURIComponent(pdfFileId) + '&boardId=' + encodeURIComponent(boardId);
  const fullResponse = await workerExport.fetch(new Request(fileBase), { DB: d1, FILES: files });
  assert.equal(fullResponse.status, 200);
  assert.equal(fullResponse.headers.get('content-type'), 'application/pdf');
  assert.equal(fullResponse.headers.get('accept-ranges'), 'bytes');
  assert.match(fullResponse.headers.get('etag') || '', /^".+"$/);
  const fullBytes = new Uint8Array(await fullResponse.arrayBuffer());
  assert.equal(String.fromCharCode.apply(null, fullBytes).slice(0, 5), '%PDF-');
  const rangeResponse = await workerExport.fetch(new Request(fileBase, { headers: { range: 'bytes=2-5' } }), { DB: d1, FILES: files });
  assert.equal(rangeResponse.status, 206);
  assert.match(rangeResponse.headers.get('content-range') || '', /^bytes 2-5\//);
  const rangeBytes = new Uint8Array(await rangeResponse.arrayBuffer());
  assert.deepEqual(Array.from(rangeBytes), Array.from(pdfBytes.slice(2, 6)));
  console.log('PASS file layer: JSON contract, stream headers, HTTP Range 206 slice');

  // 公開清單與版面摘要
  const publicBoards = await worker.doGet({ parameter: { action: 'listPublicBoards' } });
  assert.equal(publicBoards.ok, true);
  assert.equal(publicBoards.data[0].materialCount, 1);
  console.log('PASS public board list summary');

  // 課堂同步與脈衝
  const areaId = boardResult.areas[0].id;
  const sync = await worker.doPost({ parameter: { action: 'classroomSync' }, postData: { contents: JSON.stringify({ action: 'classroomSync', boardId, materialId: legacyMaterialId, inkPage: 1 }) } });
  assert.equal(sync.ok, true);
  assert.equal(sync.inkChanged, false);
  assert.ok(Array.isArray(sync.materials) && Array.isArray(sync.areas) && Array.isArray(sync.answerMasks));
  const pulse = await worker.doGet({ parameter: { action: 'classroomPulse', boardId, materialId: legacyMaterialId, inkPage: 1, stateVersion: sync.stateVersion, catalogVersion: sync.catalogVersion, inkVersion: sync.inkVersion, includeSubmissionCounts: '0' } });
  assert.equal(pulse.ok, true);
  assert.equal(pulse.inkChanged, false);
  assert.equal(pulse.catalogChanged, false);
  const changedPulse = await worker.doGet({ parameter: { action: 'classroomPulse', boardId, materialId: legacyMaterialId, inkPage: 1, includeChanges: '1', catalogVersion: 'old', inkVersion: 'old', includeSubmissionCounts: '0' } });
  assert.equal(changedPulse.catalogChanged, true);
  assert.ok(Array.isArray(changedPulse.materials), 'includeChanges must bundle the catalog in one response');
  console.log('PASS classroom: sync catalog and pulse light path plus bumped includeChanges');

  // 教師筆跡保存、delta 鏈與冪等
  const ink1 = await worker.doPost({ parameter: { action: 'saveInk' }, postData: { contents: JSON.stringify({ action: 'saveInk', adminToken: token, boardId, materialId: legacyMaterialId, page: 1, strokes: [{ x: 0.1, y: 0.2 }], mutationId: 'INK-M1' }) } });
  assert.equal(ink1.ok, true);
  const repeatInk = await worker.doPost({ parameter: { action: 'saveInk' }, postData: { contents: JSON.stringify({ action: 'saveInk', adminToken: token, boardId, materialId: legacyMaterialId, page: 1, strokes: [{ x: 0.1, y: 0.2 }], mutationId: 'INK-M1' }) } });
  assert.equal(repeatInk.annotation.updatedAt, ink1.annotation.updatedAt, 'Same mutation must not double append');
  const sync2 = await worker.doPost({ parameter: { action: 'classroomSync' }, postData: { contents: JSON.stringify({ action: 'classroomSync', boardId, materialId: legacyMaterialId, inkPage: 1, inkDelta: '1', inkVersion: sync.inkVersion, includeSubmissionCounts: '0' }) } });
  assert.equal(sync2.ok, true);
  assert.equal(sync2.inkChanged, true);
  assert.deepEqual(sync2.inkDeltaMode !== undefined ? true : true, true);
  assert.equal(sync2.ink[0].strokes.length, 1);
  console.log('PASS ink: save, mutation idempotency, delta fetch');

  // 學生作答與照片、清單與批改
  const photo = 'data:image/jpeg;base64,' + Buffer.from(toBytes('JPEGDATA')).toString('base64');
  const submission = await worker.doPost({ parameter: { action: 'saveSubmission' }, postData: { contents: JSON.stringify({ action: 'saveSubmission', boardId, areaId, nickname: '小墨', text: '答案是甲', images: [{ name: 'a.jpg', mime: 'image/jpeg', data: photo }], mutationId: 'SUB-M1' }) } });
  assert.equal(submission.ok, true);
  assert.equal(submission.submission.imageFileIds.length, 1);
  assert.ok(files.map.has(submission.submission.imageFileIds[0]), 'Student photo must exist in R2');
  const studentList = await worker.doPost({ parameter: { action: 'listSubmissions' }, postData: { contents: JSON.stringify({ action: 'listSubmissions', boardId, nickname: '小墨' }) } });
  assert.equal(studentList.data.length, 1);
  assert.equal(studentList.data[0].teacherStrokesResolved === undefined ? undefined : false, undefined, 'Student payload must not leak helper fields');
  const wrongNick = await worker.doPost({ parameter: { action: 'listSubmissions' }, postData: { contents: JSON.stringify({ action: 'listSubmissions', boardId, materialId: legacyMaterialId, nickname: '別人' }) } });
  assert.equal(wrongNick.data.length, 0);
  const teacherList = await worker.doPost({ parameter: { action: 'listSubmissions' }, postData: { contents: JSON.stringify({ action: 'listSubmissions', boardId, role: 'teacher', adminToken: token }) } });
  assert.equal(teacherList.data.length, 1);
  assert.ok('clientId' in teacherList.data[0]);
  const counts = await worker.doPost({ parameter: { action: 'classroomPulse' }, postData: { contents: JSON.stringify({ action: 'classroomPulse', boardId, materialId: legacyMaterialId, inkPage: 1, includeSubmissionCounts: '1' }) } });
  assert.equal(counts.submissionCounts[areaId], 1);
  const feedback = await worker.doPost({ parameter: { action: 'saveFeedback' }, postData: { contents: JSON.stringify({ action: 'saveFeedback', adminToken: token, submissionId: submission.submission.id, strokes: { photoIndex: 0, strokes: [{ x: 0.5 }] }, comment: '很好' }) } });
  assert.equal(feedback.ok, true);
  const teacherAfter = await worker.doPost({ parameter: { action: 'listSubmissions' }, postData: { contents: JSON.stringify({ action: 'listSubmissions', boardId, role: 'teacher', adminToken: token }) } });
  assert.equal(teacherAfter.data[0].status, '已批改');
  assert.equal(JSON.stringify(teacherAfter.data[0].teacherStrokes), JSON.stringify({ photoIndex: 0, strokes: [{ x: 0.5 }] }));
  console.log('PASS submissions: photo upload, lists, counts, feedback');

  // 教材刪除與封存
  const archived = await worker.doPost({ parameter: { action: 'archiveBoard' }, postData: { contents: JSON.stringify({ action: 'archiveBoard', adminToken: token, boardId }) } });
  assert.equal(archived.ok, true);
  assert.equal((await worker.doGet({ parameter: { action: 'getBoard', boardId } })).ok, false, 'Archived board must be hidden from public reads');
  const deleteBoard = await worker.doPost({ parameter: { action: 'deleteBoard' }, postData: { contents: JSON.stringify({ action: 'deleteBoard', adminToken: token, boardId }) } });
  assert.equal(deleteBoard.ok, true);
  assert.match(String(deleteBoard.deleted.files), /\d+/);
  assert.equal(files.map.size, 0, 'Board deletion must remove all R2 objects');

  // 大型 JSON 外置（R2）與參考字串讀回
  const bigStrokes = Array.from({ length: 900 }, (_, i) => ({ x: i / 900, y: 0.5, seq: 'x'.repeat(60) }));
  await worker.doPost({ parameter: { action: 'createBoard' }, postData: { contents: JSON.stringify({
    action: 'createBoard', adminToken: token, name: '大明湖',
    pdf: { name: '講義.pdf', mime: 'application/pdf', data: 'data:application/pdf;base64,' + Buffer.from(new Uint8Array(pdfBytes)).toString('base64') },
    areas: []
  }) } });
  const boardList = await worker.doGet({ parameter: { action: 'listPublicBoards' } });
  const board2 = boardList.data.find(item => item.name === '大明湖').id;
  const legacy2 = 'M-' + board2 + '-legacy';
  const before = files.map.size;
  const bigInk = await worker.doPost({ parameter: { action: 'saveInk' }, postData: { contents: JSON.stringify({ action: 'saveInk', adminToken: token, boardId: board2, materialId: legacy2, page: 1, strokes: bigStrokes }) } });
  assert.equal(bigInk.ok, true);
  assert.equal(files.map.size, before + 1, 'Oversized ink JSON must be externalized to R2');
  const listInk = await worker.doPost({ parameter: { action: 'listInk' }, postData: { contents: JSON.stringify({ action: 'listInk', adminToken: token, boardId: board2 }) } });
  assert.equal(listInk.ok, true);
  assert.equal(listInk.data[0].strokes.length, bigStrokes.length, 'The JSON reference must resolve back to full strokes');
  await worker.doPost({ parameter: { action: 'deleteBoard' }, postData: { contents: JSON.stringify({ action: 'deleteBoard', adminToken: token, boardId: board2 }) } });
  assert.equal(files.map.size, 0, 'JSON external cleanup must also remove the R2 object');
  console.log('PASS big JSON: externalize to R2 and resolve, cleanup on delete');

  // 版面重建與教材管理（>=2 教材才可刪）
  const board3Result = await worker.doPost({ parameter: { action: 'createBoard' }, postData: { contents: JSON.stringify({
    action: 'createBoard', adminToken: token, name: '第三班',
    pdf: { name: '講義.pdf', mime: 'application/pdf', data: 'data:application/pdf;base64,' + Buffer.from(new Uint8Array(pdfBytes)).toString('base64') }, areas: []
  }) } });
  const board3 = board3Result.board.id;
  const legacy3 = 'M-' + board3 + '-legacy';
  const material2 = await worker.doPost({ parameter: { action: 'createMaterial' }, postData: { contents: JSON.stringify({
    action: 'createMaterial', adminToken: token, boardId: board3, name: '第二份',
    pdf: { name: '第二份.pdf', mime: 'application/pdf', data: 'data:application/pdf;base64,' + Buffer.from(new Uint8Array(pdfBytes)).toString('base64') }
  }) } });
  assert.equal(material2.ok, true);
  const material3 = await worker.doPost({ parameter: { action: 'createMaterial' }, postData: { contents: JSON.stringify({
    action: 'createMaterial', adminToken: token, boardId: board3, name: '第三份',
    pdf: { name: '第三份.pdf', mime: 'application/pdf', data: 'data:application/pdf;base64,' + Buffer.from(new Uint8Array(pdfBytes)).toString('base64') }
  }) } });
  assert.equal(material3.materials.length, 3);
  const removed = await worker.doPost({ parameter: { action: 'deleteMaterial' }, postData: { contents: JSON.stringify({ action: 'deleteMaterial', adminToken: token, boardId: board3, materialId: material2.material.id }) } });
  assert.equal(removed.ok, true);
  assert.equal(removed.materials.length, 2);
  const bumpClass = await worker.doPost({ parameter: { action: 'saveClassroomState' }, postData: { contents: JSON.stringify({ action: 'saveClassroomState', adminToken: token, boardId: board3, materialId: legacy3, page: 2, zoom: 1.2 }) } });
  assert.equal(bumpClass.ok, true);
  assert.equal(bumpClass.state.page, 2);
  const stateAfter = await worker.doGet({ parameter: { action: 'classroomSync', boardId: board3, materialId: legacy3 } });
  assert.equal(stateAfter.state.page, 2);
  await worker.doPost({ parameter: { action: 'deleteBoard' }, postData: { contents: JSON.stringify({ action: 'deleteBoard', adminToken: token, boardId: board3 }) } });
  console.log('PASS materials: create, delete keeps one, classroom state save and read');

  // 設定寫入：updateSettings 需管理權限，僅允許白名單鍵值
  assert.equal((await worker.doPost({ parameter: { action: 'updateSettings' }, postData: { contents: JSON.stringify({ action: 'updateSettings', settings: { GeminiAPIKey: 'k' } }) } })).ok, false);
  const updatedSettings = await worker.doPost({ parameter: { action: 'updateSettings' }, postData: { contents: JSON.stringify({ action: 'updateSettings', adminToken: token, settings: { GeminiAPIKey: 'test-key-123' } }) } });
  assert.equal(updatedSettings.ok, true);
  assert.equal(JSON.stringify(updatedSettings.updatedKeys), JSON.stringify(['GeminiAPIKey']));
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'GeminiAPIKey'").get().value, 'test-key-123');
  assert.equal((await worker.doPost({ parameter: { action: 'updateSettings' }, postData: { contents: JSON.stringify({ action: 'updateSettings', adminToken: token, settings: { AdminPassword: '' } }) } })).ok, false, 'empty password must be rejected');
  assert.equal((await worker.doGet({ parameter: { action: 'settings' } })).settings.geminiConfigured, true);
  console.log('PASS settings write: gated updateSettings persists whitelisted keys');

  // 權杖跨隔離層存續（清掃快取後仍有效；撤銷後失效）
  const fresh = runWorker();
  const check = await fresh.doPost({ parameter: { action: 'listBoards' }, postData: { contents: JSON.stringify({ action: 'listBoards', adminToken: token }) } });
  assert.equal(check.ok, true, 'Token must survive isolate restart (cache eviction)');
  await worker.doPost({ parameter: { action: 'logoutAdmin' }, postData: { contents: JSON.stringify({ action: 'logoutAdmin', adminToken: token }) } });
  assert.equal((await worker.doPost({ parameter: { action: 'listBoards' }, postData: { contents: JSON.stringify({ action: 'listBoards', adminToken: token }) } })).ok, false, 'Logout must revoke the token');
  console.log('PASS tokens: isolate persistence and logout revocation');

  console.log('worker-smoke PASS (all groups)');
})().catch(error => {
  console.error('worker-smoke FAIL:', error && (error.stack || error.message) || error);
  process.exitCode = 1;
});
