const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const gas = fs.readFileSync(path.join(__dirname, '../Code.gs'), 'utf8');
const section = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));

(async () => {
  let failures = 0;
  let successes = 0;
  let calls = 0;
  let aborts = 0;
  const sandbox = {
    window: { AbortController, setTimeout, clearTimeout }, AbortController, FormData, URLSearchParams, URL,
    GAS_URL: 'https://example.invalid/exec', GAS_POST_TIMEOUT: 25, GAS_REQUEST_TIMEOUT: 25,
    GAS_GET_MAX_ATTEMPTS: 2, GAS_GET_RETRY_DELAY: 1,
    markNetworkSuccess() { successes++; }, markNetworkFailure() { failures++; },
    fetch: async (url, options) => {
      calls++;
      return { ok: true, json: () => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          aborts++;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      }) };
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(section(html, '    class ApiError', '    async function api('), sandbox);
  await assert.rejects(sandbox.gasGet('classroomPulse', {}, { maxAttempts: 1 }), e => e.network && !e.aborted);
  assert.equal(aborts, 1, 'A stalled response body must be aborted');
  await assert.rejects(sandbox.gasPost('saveInk', {}), e => e.network && !e.aborted);
  assert.equal(calls, 2, 'Writes must not be automatically replayed');
  const controller = new AbortController();
  const request = sandbox.gasGet('classroomSync', {}, { signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(request, e => e.aborted);
  assert.equal(calls, 3, 'Cancelled reads must not retry');
  assert.equal(failures, 2, 'Cancellation must not mark the network unhealthy');
  sandbox.fetch = async () => ({ ok: true, json: async () => ({ ok: true, data: [] }) });
  assert.equal((await sandbox.gasGet('listPublicBoards', {})).ok, true);
  assert.equal(successes, 1);
  sandbox.fetch = async () => ({ ok: true, json: async () => ({ ok: false, error: 'Denied' }) });
  await assert.rejects(sandbox.gasGet('listPublicBoards', {}), e => !e.network);
  assert.equal(failures, 2, 'Application errors must not mark the network unhealthy');
  const retryUrls = [];
  sandbox.fetch = async url => {
    retryUrls.push(url);
    return retryUrls.length === 1 ? { ok: false, status: 404 } : { ok: true, json: async () => ({ ok: true }) };
  };
  await sandbox.gasGet('getFile', {}, { maxAttempts: 2 });
  assert.equal(retryUrls.length, 2, 'Transient read failures must retry');
  assert.notEqual(retryUrls[0], retryUrls[1], 'Retries must not reuse a failed response URL');
  console.log('PASS transport: stalled GET/POST bodies, cancellation, no write replay, success and application errors');

  let cacheReads = 0;
  let initialized = 0;
  let released = 0;
  const backend = {
    DATABASE_READY_CACHE_KEY: 'ready', TABLES: { boards: {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    CacheService: { getScriptCache: () => ({ get: () => ++cacheReads === 1 ? null : '1' }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => released++ }) },
    ensureTable_: () => initialized++
  };
  vm.createContext(backend);
  vm.runInContext(section(gas, 'function ensureDatabase_()', 'function ensureTable_('), backend);
  backend.ensureDatabase_();
  assert.equal(initialized, 0, 'A waiting request must reuse initialization completed by the previous lock holder');
  assert.equal(released, 1);
  console.log('PASS initialization: queued request skips repeated setup and releases lock');

  let syncCalls = 0;
  const poll = {
    classroomSyncGeneration: 1, classroomSyncPromise: null, classroomSyncPromiseGeneration: 0,
    classroomSyncAbortController: null, classroomSyncInFlight: 0, classroomSyncRetryAt: Date.now() + 30000,
    window: { AbortController }, AbortController,
    loadClassroomSync: async () => { syncCalls++; }
  };
  vm.createContext(poll);
  vm.runInContext(section(html, '     function startClassroomSyncPoll()', '    function startClassroomSubmissionPoll('), poll);
  assert.equal(poll.startClassroomSyncPoll(), null);
  assert.equal(syncCalls, 0);
  poll.classroomSyncRetryAt = 0;
  const first = poll.startClassroomSyncPoll();
  assert.equal(poll.startClassroomSyncPoll(), first, 'Concurrent polling must share one request');
  await first;
  assert.equal(syncCalls, 1);
  assert.equal(poll.classroomSyncInFlight, 0);
  console.log('PASS polling: backoff suppresses requests, recovery resumes, overlapping ticks share one request');
})().catch(error => { console.error(error); process.exitCode = 1; });
