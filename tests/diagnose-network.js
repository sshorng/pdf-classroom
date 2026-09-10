// Read-only live diagnostics. No credentials, student answers or file contents are printed.
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const endpoint = process.env.PDF_GAS_URL || html.match(/const DEFAULT_GAS_URL = "([^"]+)"/)[1];
const observations = [];
async function probe(action, params = {}, method = 'GET') {
  const started = performance.now();
  const url = new URL(endpoint);
  Object.entries({ action, ...params, _ts: Date.now() }).forEach(([key, value]) => url.searchParams.set(key, value));
  try {
    const options = { signal: AbortSignal.timeout(90000), redirect: 'follow' };
    if (method === 'POST') {
      options.method = 'POST';
      options.body = new URLSearchParams({ action, data: JSON.stringify(params) });
    }
    const response = await fetch(method === 'POST' ? endpoint : url, options);
    const headersMs = Math.round(performance.now() - started);
    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch { result = { ok: false, error: 'Non-JSON response' }; }
    const record = { action, method, status: response.status, headersMs, totalMs: Math.round(performance.now() - started), bytes: Buffer.byteLength(text), ok: result.ok, error: result.error || null, host: new URL(response.url).hostname, title: result.error === 'Non-JSON response' ? (text.match(/<title[^>]*>(.*?)<\/title>/is) || [])[1] : undefined };
    observations.push(record);
    if (action === 'ping') record.apiVersion = result.apiVersion || 'unversioned';
    console.log(JSON.stringify(record));
    return result;
  } catch (error) {
    const record = { action, totalMs: Math.round(performance.now() - started), error: error.message, cause: error.cause && error.cause.code };
    observations.push(record);
    console.log(JSON.stringify(record));
    return null;
  }
}
(async () => {
  await probe('ping');
  const boards = await probe('listPublicBoards');
  if (!boards || !boards.ok || !boards.data || !boards.data.length) return;
  const boardId = boards.data[0].id;
  const board = await probe('getBoard', { boardId });
  const materials = board && (board.materials || (board.board && board.board.materials));
  const material = materials && materials[0];
  if (!material) return;
  const params = { boardId, materialId: material.id, inkPage: 1, includeSubmissionCounts: '0' };
  const sync = await probe('classroomSync', params);
  if (process.argv.includes('--compare-post')) await probe('classroomSync', params, 'POST');
  if (sync && sync.ok) {
    ['stateVersion', 'catalogVersion', 'inkVersion', 'pulseVersion'].forEach(key => { params[key] = sync[key] || ''; });
  }
  for (let i = 0; i < 5; i++) await probe('classroomPulse', params);
  if (process.argv.includes('--include-file') && material.pdfFileId) await probe('getFile', { boardId, materialId: material.id, fileId: material.pdfFileId });
  if (process.argv.includes('--compare-post') && material.pdfFileId) await probe('getFile', { boardId, materialId: material.id, fileId: material.pdfFileId }, 'POST');
  console.log('summary=' + JSON.stringify({ requests: observations.length, failures: observations.filter(item => !item.ok).length, pulseOverCurrent5s: observations.filter(item => item.action === 'classroomPulse' && item.totalMs > 5000).length }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
