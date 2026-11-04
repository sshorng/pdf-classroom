const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const baseline = process.argv.includes('--baseline');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const gas = fs.readFileSync(path.join(__dirname, '../Code.gs'), 'utf8');
const section = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));

(async () => {
  const board = { id: 'b', updatedAt: 'v1' };
  const materials = [{ id: 'm', pdfFileId: 'pdf', updatedAt: 'v1' }];
  const areas = Array.from({ length: 100 }, (_, i) => ({ id: 'a' + i, updatedAt: 'v1', title: 'Question '.repeat(40) }));
  let masks = [{ id: 'mask', updatedAt: 'v1', materialId: 'm', page: 1, x: .1, y: .1, width: .2, height: .2 }];
  const shared = { boardId: 'b', materialId: 'm', page: 1, zoom: 1, updatedAt: 'v1' };
  const backend = {
    Utilities: { DigestAlgorithm: { MD5: 'md5' }, computeDigest: (_, raw) => crypto.createHash('md5').update(raw).digest(), base64EncodeWebSafe: bytes => bytes.toString('base64url') }
  };
  vm.createContext(backend);
  vm.runInContext(gas, backend);
  Object.assign(backend, {
    getBoard_: () => board, materialsForBoard_: () => materials, areasForBoard_: () => areas,
    answerMasksForBoard_: () => masks, publicClassroomState_: () => shared,
    readTable_: name => name === 'ink' ? [{ id: 'ink', boardId: 'b', materialId: 'm', page: 1, updatedAt: 'v2', strokes: [] }] : [shared],
    readJsonReference_: value => value, readClassroomPulseCache_: () => null,
    writeClassroomPulseCache_: () => {}, now_: () => 'now'
  });
  const request = { boardId: 'b', materialId: 'm', inkPage: 1, inkDelta: '1', includeSubmissionCounts: '0' };
  const initial = backend.classroomSync_(request);
  const known = { ...request, catalogVersion: initial.catalogVersion, catalogDelta: '1' };
  const delta = backend.classroomSync_(known);
  const legacy = backend.classroomSync_({ ...known, catalogDelta: undefined });
  const pulse = backend.classroomPulse_({ ...known, includeChanges: '1' });
  const bytes = value => Buffer.byteLength(JSON.stringify(value));
  console.log('MOCK payload ' + JSON.stringify({ initialBytes: bytes(initial), knownCatalogBytes: bytes(delta), legacyBytes: bytes(legacy), inkRows: delta.ink.length }));
  assert.deepEqual(delta.ink, legacy.ink, 'Catalog elision must not change ink deltas');
  assert.ok(Array.isArray(legacy.materials) && Array.isArray(legacy.answerMasks), 'Old clients keep the full response');
  assert.ok(Array.isArray(backend.classroomSync_({ ...request, catalogDelta: '1' }).answerMasks), 'Initial clients must receive masks');
  if (!baseline) {
    assert.equal(delta.catalogChanged, false);
    for (const field of ['materials', 'areas', 'answerMasks']) assert.equal(delta[field], null);
    assert.equal(pulse.materials, null, 'Ink-only combined pulse must also omit the known catalog');
    assert.deepEqual(pulse.ink, delta.ink);
    assert.ok(bytes(delta) < bytes(legacy) / 10);
  }
  for (const mutation of [() => { masks[0].updatedAt = 'v2'; }, () => { masks = []; }, () => { materials[0].pdfFileId = 'pdf2'; }, () => { areas[0].updatedAt = 'v2'; }]) {
    const before = backend.classroomSync_(request);
    mutation();
    const changed = backend.classroomSync_({ ...known, catalogVersion: before.catalogVersion });
    assert.notEqual(changed.catalogVersion, before.catalogVersion);
    assert.ok(Array.isArray(changed.materials) && Array.isArray(changed.areas) && Array.isArray(changed.answerMasks), 'Changed masks, PDF and areas must always be delivered');
  }
  console.log('PASS catalog: initial, legacy, unchanged, mask edit/delete, PDF replacement and area edit');

  let clones = 0;
  let changedInk = false;
  let calls = 0;
  let renders = 0;
  const strokes = Array.from({ length: 10000 }, (_, i) => ({ x: i / 10000, y: .5 }));
  const state = {
    boardId: 'b', board, view: 'student', activeMaterialId: 'm', materialSelectionToken: 1,
    classroomStateRevision: 0, currentPage: 2, zoom: 1.35, pdf: { numPages: 10 },
    lastClassroomCountsPollAt: Date.now(), teacherInk: new Map([['m|2', strokes]]),
    teacherInkVersions: new Map(), materials
  };
  const frontend = {
    state, CLASSROOM_SUBMISSIONS_POLL_INTERVAL: 60000, CLASSROOM_SYNC_TIMEOUT: 90000, CLASSROOM_PULSE_TIMEOUT: 90000,
    JSON: { stringify(value) { clones++; return JSON.stringify(value); }, parse: JSON.parse },
    legacyMaterialId: () => 'm', teacherInkVersionFor: () => 'i',
    gasGet: async () => { calls++; return { state: { materialId: 'm', page: 9, zoom: 2 }, inkChanged: changedInk, ink: changedInk ? [{ id: 'ink', materialId: 'm', page: 2, strokes: [] }] : null, inkDelta: true }; },
    isCurrentMaterialContext: () => true, hasPendingBoardMutation: async () => false,
    activeMaterial: () => materials[0], pendingInkRows: async () => [],
    teacherInkRevision: new Map([['m|2', 1]]), materialInkKey: (id, page) => id + '|' + page,
    cacheTeacherInkFromSync: async () => {}, clamp: (v, min, max) => Math.max(min, Math.min(max, v)),
    renderMaterialControls() {}, renderStudentAreaList() {}, renderZones() {}, renderTeacherInk() { renders++; }
  };
  vm.createContext(frontend);
  vm.runInContext(section(html, '     let classroomSyncInFlight', '    function scheduleClassroomStateSave('), frontend);
  for (let i = 0; i < 5; i++) await frontend.loadClassroomSync();
  console.log('MOCK unchanged sync ' + JSON.stringify({ calls, clones, clonedPoints: clones * strokes.length, renders }));
  if (!baseline) assert.equal(clones, 0, 'Unchanged ink must not be serialized');
  assert.equal(renders, 0);
  assert.equal(state.currentPage, 2);
  assert.equal(state.zoom, 1.35);
  clones = 0;
  changedInk = true;
  await frontend.loadClassroomSync();
  assert.equal(clones, 1, 'Changed ink still snapshots local unsaved strokes');
  assert.equal(state.teacherInk.get('m|2').length, strokes.length, 'Local drawing must survive a remote ink response');
  assert.equal(renders, 1);
  console.log('PASS ink: no-op skips work, changed response preserves local strokes, student page and zoom unchanged');
  changedInk = false;
  frontend.pendingInkRows = async () => [{ id: 'pending', materialId: 'm', page: 2, strokes }];
  clones = 0;
  await frontend.loadClassroomSync();
  assert.equal(clones, 1, 'Pending local ink must retain snapshot protection even when the server is unchanged');
  assert.equal(state.teacherInk.get('m|2').length, strokes.length);
  console.log('PASS pending ink: unchanged server response still protects queued local drawing');
  frontend.pendingInkRows = async () => [];
  frontend.hasPendingBoardMutation = async () => true;
  frontend.gasGet = async () => ({ state: { materialId: 'm' }, catalogVersion: 'unapplied', inkChanged: false });
  state.classroomCatalogVersion = 'applied';
  await frontend.loadClassroomSync();
  assert.equal(state.classroomCatalogVersion, 'applied', 'Pending catalog edits must not acknowledge a skipped remote version');
  frontend.hasPendingBoardMutation = async () => false;
  await frontend.loadClassroomSync();
  assert.equal(state.classroomCatalogVersion, 'unapplied');
  console.log('PASS catalog acknowledgement: queued edits retain the last applied version until safe to accept remote data');
})().catch(error => { console.error(error); process.exitCode = 1; });
