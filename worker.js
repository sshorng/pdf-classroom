/**
 * PDF 互動講義批改系統，Cloudflare Workers API。
 *
 * 本檔把 Code.gs 的五區架構一比一搬到 Workers：資料層改為 D1（資料庫）與 R2（檔案），
 * 業務層函式名稱、參數與回應契約與 GAS 版完全相同。差異只有兩類：
 * 1. D1 與 R2 的存取是 async，因此資料層與其上的業務函式為 async function。
 * 2. Drive 的檔案以 R2 物件鍵保存，大型 JSON 的參考字串沿用 "drive:ID" 引用格式；
 *   遷移時以原 Drive 檔案 ID 作為 R2 物件鍵，因此舊參考字串不需改寫。
 *
 * 部署：先以 wrangler d1 migrations 套用 schema.sql，再 wrangler deploy。
 */

/* 【第 0 區 CONFIG 與 SCHEMA】資料表結構、設定預設值、快取鍵與 TTL 常數，與 Code.gs 一一對譯。 */

const TABLES = {
  settings: {
    name: "settings",
    keys: ["key", "value"],
    columns: { key: "key", value: "value" },
    boardScoped: false
  },
  announcements: {
    name: "announcements",
    keys: ["id", "title", "description", "url", "links", "pinned", "order", "status", "createdAt", "updatedAt"],
    columns: { id: "id", title: "title", description: "description", url: "url", links: "links", pinned: "pinned", order: "sortOrder", status: "status", createdAt: "createdAt", updatedAt: "updatedAt" },
    boardScoped: false
  },
  boards: {
    name: "boards",
    keys: ["id", "name", "description", "pdfFileId", "pdfFileName", "pdfMime", "status", "createdAt", "updatedAt"],
    columns: { id: "id", name: "name", description: "description", pdfFileId: "pdfFileId", pdfFileName: "pdfFileName", pdfMime: "pdfMime", status: "status", createdAt: "createdAt", updatedAt: "updatedAt" },
    boardScoped: false
  },
  materials: {
    name: "materials",
    keys: ["id", "boardId", "name", "description", "pdfFileId", "pdfFileName", "pdfMime", "order", "status", "createdAt", "updatedAt"],
    columns: { id: "id", boardId: "boardId", name: "name", description: "description", pdfFileId: "pdfFileId", pdfFileName: "pdfFileName", pdfMime: "pdfMime", order: "sortOrder", status: "status", createdAt: "createdAt", updatedAt: "updatedAt" },
    boardScoped: true
  },
  areas: {
    name: "areas",
    keys: ["id", "boardId", "materialId", "page", "x", "y", "width", "height", "title", "prompt", "order", "status", "createdAt", "updatedAt"],
    columns: { id: "id", boardId: "boardId", materialId: "materialId", page: "page", x: "x", y: "y", width: "width", height: "height", title: "title", prompt: "prompt", order: "sortOrder", status: "status", createdAt: "createdAt", updatedAt: "updatedAt" },
    boardScoped: true
  },
  answerMasks: {
    name: "answerMasks",
    keys: ["id", "boardId", "materialId", "page", "x", "y", "width", "height", "title", "order", "status", "createdAt", "updatedAt"],
    columns: { id: "id", boardId: "boardId", materialId: "materialId", page: "page", x: "x", y: "y", width: "width", height: "height", title: "title", order: "sortOrder", status: "status", createdAt: "createdAt", updatedAt: "updatedAt" },
    boardScoped: true
  },
  ink: {
    name: "ink",
    keys: ["id", "boardId", "materialId", "page", "strokes", "updatedAt", "mutationId"],
    columns: { id: "id", boardId: "boardId", materialId: "materialId", page: "page", strokes: "strokes", updatedAt: "updatedAt", mutationId: "mutationId" },
    boardScoped: true
  },
  classroomState: {
    name: "classroomState",
    keys: ["id", "boardId", "materialId", "page", "zoom", "updatedAt"],
    columns: { id: "id", boardId: "boardId", materialId: "materialId", page: "page", zoom: "zoom", updatedAt: "updatedAt" },
    boardScoped: true
  },
  submissions: {
    name: "submissions",
    keys: ["id", "boardId", "materialId", "areaId", "nickname", "text", "imageFileIds", "imageFileNames", "teacherStrokes", "teacherComment", "status", "clientId", "createdAt", "updatedAt", "mutationId"],
    columns: { id: "id", boardId: "boardId", materialId: "materialId", areaId: "areaId", nickname: "nickname", text: "text", imageFileIds: "imageFileIds", imageFileNames: "imageFileNames", teacherStrokes: "teacherStrokes", teacherComment: "teacherComment", status: "status", clientId: "clientId", createdAt: "createdAt", updatedAt: "updatedAt", mutationId: "mutationId" },
    boardScoped: true
  },
  files: {
    name: "files",
    keys: ["id", "purpose", "name", "mime", "driveId", "size", "boardId", "materialId", "submissionId", "createdAt"],
    columns: { id: "id", purpose: "purpose", name: "name", mime: "mime", driveId: "driveId", size: "size", boardId: "boardId", materialId: "materialId", submissionId: "submissionId", createdAt: "createdAt" },
    boardScoped: true
  }
};

const SETTINGS_DEFAULTS = [
  ["GeminiAPIKey", ""],
  ["GeminiModel", "gemini-flash-lite-latest"],
  ["AdminPassword", ""],
  ["DriveRootFolderName", "PDF互動講義檔案"],
  ["MaxImageBytes", "2097152"],
  ["MaxPdfBytes", "20971520"]
];

const MAX_TEXT = {
  name: 80,
  description: 300,
  announcementDescription: 160,
  announcementLinkLabel: 80,
  title: 100,
  url: 2048,
  prompt: 500,
  nickname: 40,
  answer: 5000,
  comment: 1000,
  fileName: 120
};

const MAX_ANNOUNCEMENT_LINKS = 8;
const MAX_SHEET_JSON_CHARS = 45000;
const DATABASE_READY_CACHE_KEY = "pdfw_database_ready_v5_announcement_links_schema";
const JSON_REFERENCE_CACHE_PREFIX = "pdfw_json_v1_";
const JSON_REFERENCE_CACHE_SECONDS = 300;
const INK_DELTA_CACHE_PREFIX = "pdfw_ink_delta_v1_";
const INK_DELTA_CACHE_SECONDS = 300;
const CLASSROOM_PULSE_PREFIX = "pdfw_classroom_pulse_v1_";
const CLASSROOM_PULSE_SECONDS = 30;
const TABLE_CACHE_VERSION_PREFIX = "pdfw_table_version_v1_";
const TABLE_CACHE_VERSION_SECONDS = 21600;
const SUBMISSION_COUNT_CACHE_KEY_PREFIX = "pdfw_submission_counts_v1_";
const SUBMISSION_COUNT_CACHE_SECONDS = 5;
const MUTATION_RESULT_CACHE_PREFIX = "pdfw_mutation_result_v1_";
const MUTATION_RESULT_CACHE_SECONDS = 21600;
const MUTATION_RESULT_CACHE_MAX_CHARS = 90000;
const ADMIN_TOKEN_CACHE_SECONDS = 21600;
const TABLE_CACHE_TTL_ = { settings: 300, announcements: 120, boards: 120, materials: 120, areas: 120, answerMasks: 120, files: 30, classroomState: 10, ink: 10, submissions: 5 };
const API_VERSION = "2026-11-04-worker-v1";
const CORS_ALLOWED_HEADERS = "Content-Type";
const TABLE_CACHE_PREFIX = "pdfw_table_v3_announcements_";
const TABLE_CACHE_MAX_CHARS = 90000;
const TABLE_CACHE_SECONDS = 3;

const CRYPTO = typeof require === "function" ? require("node:crypto") : null;

/* Workers 隔離層內的 TTL 快取：介面與 CacheService.getScriptCache 相同（get／put／remove）。
   正確性不依賴本快取：快取全部是效能最佳化，快取缺失時一律回到 D1 讀取。 */
const LOCAL_TTL_CACHE = (function () {
  const store = new Map();
  return {
    get(key) {
      const entry = store.get(String(key));
      if (!entry) return null;
      if (Date.now() > entry.expires) { store.delete(String(key)); return null; }
      return entry.value;
    },
    put(key, value, seconds) {
      const ttl = Number(seconds) > 0 ? Number(seconds) : 60;
      store.set(String(key), { value: String(value), expires: Date.now() + ttl * 1000 });
    },
    remove(key) { store.delete(String(key)); }
  };
})();

/* 依賴注入：正式請求由 fetch() 傳入 env 綁定；測試環境以資料層函式覆寫，不會用到這些變數。 */
const RUNTIME = { DB: null, FILES: null };
function setRuntimeBindings_(env) {
  if (env) {
    if (env.DB) RUNTIME.DB = env.DB;
    if (env.FILES) RUNTIME.FILES = env.FILES;
  }
  return RUNTIME;
}
function database_() {
  if (!RUNTIME.DB) throw new Error("未設定 D1 資料庫綁定。");
  return RUNTIME.DB;
}
function fileBucket_() {
  if (!RUNTIME.FILES) throw new Error("未設定 R2 檔案儲存綁定。");
  return RUNTIME.FILES;
}

/* 與 GAS 的 CacheService 同名同介面：正式環境走隔離層 TTL 快取，測試環境可共用mock。 */
const CacheService = { getScriptCache() { return LOCAL_TTL_CACHE; } };

/* 【第 1 區 PURE ENGINE：零資料庫與檔案儲存呼叫】與 Code.gs 完全相同。 */

function isActiveRow_(item) {
  return String(item.status || "啟用") === "啟用";
}

function materialIdOf_(item, boardId) {
  return String((item && item.materialId) || legacyMaterialId_(boardId));
}

function cleanText_(value, limit) {
  return String(value == null ? "" : value).trim().slice(0, limit);
}

function safeFileName_(value) {
  return cleanText_(String(value || "檔案").replace(/[\\/:*?"<>|]/g, "_"), MAX_TEXT.fileName) || "檔案";
}

function parseArray_(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function parseObject_(value, fallback) {
  if (value && typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch (error) {
    return fallback;
  }
}

/* Vulnerability 修正：base64 以內建 atob／btoa 處理，Node 與 Workers 都可用，不經 Buffer。 */
function b64EncodeBytes_(bytes) {
  let raw = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    raw += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
  }
  return btoa(raw);
}

function b64DecodeBytes_(value) {
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

/* MD5 主供版本字串與冪等鍵：與 GAS 的 Utilities.computeDigest(MD5) 同屬自一致雜湊，不需跨版互通。 */
function md5Base64WebSafe_(value) {
  if (!CRYPTO) throw new Error("缺少 node:crypto，無法計算 MD5。");
  return CRYPTO.createHash("md5").update(String(value), "utf8").digest("base64url");
}

function md5Raw_(value) {
  if (!CRYPTO) throw new Error("缺少 node:crypto，無法計算 MD5。");
  return CRYPTO.createHash("md5").update(String(value), "utf8").digest();
}

/* 【第 2 區 DATA ACCESS ADAPTER：D1 與 R2】所有 DB＿ 與 FILES＿ 呼叫集中在本區。
   函式名稱與 Code.gs 相同，改為 async；測試以覆寫本層函式注入資料，與 GAS 相同手法。 */

function tableCacheSeconds_(key) { const seconds = TABLE_CACHE_TTL_[key]; return typeof seconds === "number" && seconds > 0 ? seconds : TABLE_CACHE_SECONDS; }

function clearTableCache_(key) {
  CacheService.getScriptCache().remove(TABLE_CACHE_PREFIX + key);
  try {
    CacheService.getScriptCache().put(TABLE_CACHE_VERSION_PREFIX + key, now_() + "|" + makeId_("v"), TABLE_CACHE_VERSION_SECONDS);
  } catch (error) {}
}

function clearAllTableCaches_() {
  Object.keys(TABLES).forEach(function (key) { clearTableCache_(key); });
}

function rowToObject_(key, row) {
  const table = TABLES[key];
  const item = {};
  table.keys.forEach(function (field) {
    const column = table.columns[field];
    item[field] = Object.prototype.hasOwnProperty.call(row, column) ? serializeValue_(row[column]) : "";
  });
  return item;
}

function serializeValue_(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && /^'[=+\-@]/.test(value)) return value.slice(1);
  return typeof value === "number" || typeof value === "boolean" ? String(value) : value;
}

async function runAll_(statement) {
  const result = await statement.all();
  const rows = result && Array.isArray(result.results) ? result.results : [];
  return rows;
}

async function readTable_(key) {
  const table = TABLES[key];
  const cache = CacheService.getScriptCache();
  if (table.boardScoped === false || table.boardScoped === undefined) {
    const cached = cache.get(TABLE_CACHE_PREFIX + key);
    if (cached) {
      try { return parseObject_(cached, []); } catch (error) {}
    }
  }
  const rows = await runAll_(database_().prepare("SELECT * FROM " + table.name + " ORDER BY rowid"));
  const objects = rows.map(function (row) { return rowToObject_(key, row); });
  const serialized = JSON.stringify(objects);
  if (serialized.length <= TABLE_CACHE_MAX_CHARS) {
    try { cache.put(TABLE_CACHE_PREFIX + key, serialized, tableCacheSeconds_(key)); } catch (error) {
      // 大型資料表不寫入快取，避免超過隔離層記憶體負擔。
    }
  }
  return objects;
}

/* 版面範圍查詢：課堂輪詢的高頻路徑一律走本函式，避免整表掃描撐大 D1 讀取額度。 */
async function rowsForBoard_(key, boardId) {
  const table = TABLES[key];
  if (!table.boardScoped) throw new Error("資料表不屬於版面範圍查詢：" + key);
  let rows;
  if (key === "materials" || key === "areas" || key === "answerMasks") {
    rows = await runAll_(database_().prepare("SELECT * FROM " + table.name + " WHERE boardId = ?1 ORDER BY sortOrder, rowid").bind(String(boardId)));
  } else {
    rows = await runAll_(database_().prepare("SELECT * FROM " + table.name + " WHERE boardId = ?1 ORDER BY rowid").bind(String(boardId)));
  }
  return rows.map(function (row) { return rowToObject_(key, row); });
}

async function appendRow_(key, item) {
  const table = TABLES[key];
  const columns = table.keys.map(function (field) { return table.columns[field]; });
  const values = table.keys.map(function (field) {
    const value = item[field] !== undefined && item[field] !== null ? item[field] : "";
    if (typeof value === "boolean") return value ? "true" : "false";
    return typeof value === "object" ? JSON.stringify(value) : value;
  });
  const placeholders = table.keys.map(function (field, index) { return "?" + (index + 1); }).join(", ");
  const statement = database_().prepare(
    "INSERT INTO " + table.name + " (" + columns.join(", ") + ") VALUES (" + placeholders + ")"
  );
  await statement.bind.apply(statement, table.keys.map(function (field, index) { return values[index]; })).run();
  clearTableCache_(key);
}

async function updateRow_(key, id, fields) {
  const table = TABLES[key];
  const assignments = [];
  const bindings = [];
  Object.keys(fields).forEach(function (field) {
    const column = table.columns[field];
    if (!column || fields[field] === undefined) return;
    const value = fields[field];
    assignments.push(column + " = ?");
    let normalized = typeof value === "object" ? JSON.stringify(value) : value;
    if (typeof normalized === "boolean") normalized = normalized ? "true" : "false";
    if (field === "order" || (column === "sortOrder" && key !== "announcements")) normalized = Number(value) || 1;
    bindings.push(normalized);
  });
  if (!assignments.length) return;
  bindings.push(String(id));
  const statement = database_().prepare("UPDATE " + table.name + " SET " + assignments.join(", ") + " WHERE id = ?");
  await statement.bind.apply(statement, bindings).run();
  clearTableCache_(key);
}

async function deleteRows_(key, predicate) {
  const rows = await readTable_(key);
  const ids = rows.filter(predicate).map(function (item) { return String(item.id); });
  if (!ids.length) return 0;
  const placeholders = ids.map(function (item, index) { return "?" + (index + 1); }).join(", ");
  const statement = database_().prepare("DELETE FROM " + TABLES[key].name + " WHERE id IN (" + placeholders + ")");
  await statement.bind.apply(statement, ids).run();
  clearTableCache_(key);
  return ids.length;
}

async function findRowById_(key, id) {
  const rows = await readTable_(key);
  return rows.findIndex(function (item) { return String(item.id) === String(id); });
}

function findItemById_(rows, id) {
  for (let index = 0; index < rows.length; index += 1) {
    if (String(rows[index].id) === String(id)) return rows[index];
  }
  return null;
}

async function findTableItemById_(key, id) {
  return findItemById_(await readTable_(key), id);
}

async function deleteRowsForBoard_(key, boardId) {
  return deleteRows_(key, function (item) {
    return String(item.boardId) === String(boardId);
  });
}

function deleteRowsForBoardMaterial_(key, boardId, materialId) {
  return deleteRows_(key, function (item) {
    return String(item.boardId) === String(boardId) && materialIdOf_(item, boardId) === String(materialId);
  });
}

async function readSettings_() {
  const settings = {};
  (await readTable_("settings")).forEach(function (row) {
    settings[String(row.key || "").trim()] = String(row.value || "").trim();
  });
  return settings;
}

function loadSettings_() {
  return readSettings_();
}

async function getSetting_(key) {
  const settings = await loadSettings_();
  return settings[key] || "";
}

function now_() {
  return new Date().toISOString();
}

async function ensureDatabase_() {
  const cache = CacheService.getScriptCache();
  if (cache.get(DATABASE_READY_CACHE_KEY) === "1") return;
  const db = database_();
  const rows = await runAll_(db.prepare("SELECT key FROM settings"));
  const present = rows.map(function (row) { return String(row.key || ""); });
  const statements = SETTINGS_DEFAULTS.filter(function (item) { return present.indexOf(item[0]) < 0; }).map(function (item) {
    return db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)").bind(item[0], item[1]);
  });
  if (statements.length) await db.batch(statements);
  await migrateLegacyMaterials_();
  cache.put(DATABASE_READY_CACHE_KEY, "1", 21600);
}

function setSpreadsheetId() {
  throw new Error("Workers 版沒有試算表 ID，此動作僅存在於 GAS 版。");
}

function initDatabase() {
  CacheService.getScriptCache().remove(DATABASE_READY_CACHE_KEY);
  return ensureDatabase_().then(function () { return "資料表與 R2 綁定初始化完成。"; });
}

/* 脈衝快取：teachers 對譯 CacheService，介面同步；資料缺失時一律重算，正確性不受影響。 */
function classroomPulseKey_(boardId, suffix) {
  return CLASSROOM_PULSE_PREFIX + String(boardId || "") + "_" + String(suffix || "");
}

function classroomPulseInkKey_(boardId, materialId, page) {
  const safeMaterialId = String(materialId || "").replace(/[^A-Za-z0-9_.-]/g, "_");
  return classroomPulseKey_(boardId, "ink_" + safeMaterialId + "_" + (Number(page) || 1));
}

function readClassroomPulseCache_(key) {
  try {
    const value = CacheService.getScriptCache().get(key);
    return value === null ? null : String(value);
  } catch (error) {
    return null;
  }
}

function writeClassroomPulseCache_(key, value) {
  if (!key || value === undefined || value === null) return;
  try {
    CacheService.getScriptCache().put(key, String(value), CLASSROOM_PULSE_SECONDS);
  } catch (error) {
    // 脈衝快取失敗時，下一次請求會回到資料表查詢，不影響同步正確性。
  }
}

function ensureClassroomPulseVersion_(boardId, stateVersion, catalogVersion, inkVersion) {
  let pulseVersion = readClassroomPulseCache_(classroomPulseKey_(boardId, "token"));
  if (pulseVersion === null) {
    pulseVersion = [stateVersion, catalogVersion, inkVersion].join("¦");
    writeClassroomPulseCache_(classroomPulseKey_(boardId, "token"), pulseVersion);
  }
  return pulseVersion;
}

function classroomPulseToken_() {
  return now_() + "|" + makeId_("p");
}

function touchClassroomPulse_(boardId) {
  const token = classroomPulseToken_();
  writeClassroomPulseCache_(classroomPulseKey_(boardId, "token"), token);
  return token;
}

function makeId_(prefix) {
  const globalCrypto = (typeof crypto !== "undefined" && crypto && typeof crypto.randomUUID === "function") ? crypto : (CRYPTO && CRYPTO.webcrypto ? CRYPTO.webcrypto : null);
  const uuid = globalCrypto && globalCrypto.randomUUID ? globalCrypto.randomUUID() : String(Date.now()) + String(Math.random()).slice(2);
  return prefix + "-" + uuid.replace(/-/g, "").slice(0, 14);
}

function jsonOut_(payload) {
  return JSON.stringify(payload);
}

function parsePayload_(event) {
  const parameter = event && event.parameter ? event.parameter : {};
  let raw = parameter.data || "";
  if (!raw && event && event.postData && event.postData.contents) raw = event.postData.contents;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error("請求資料格式不正確。");
  }
}

/* 管理權杖：D1 保存跨隔離層有效；本快取只加速驗證。 */
async function persistAdminToken_(token) {
  const value = String(token || "").trim();
  if (!value) return;
  try {
    await database_().prepare("INSERT OR IGNORE INTO adminTokens (token, createdAt) VALUES (?1, ?2)").bind(value, now_()).run();
  } catch (error) {
    // 資料表可能尚未建立；快取仍可在本隔離層內生效，不影響登入。
  }
  CacheService.getScriptCache().put("pdfw_admin_" + value, "1", ADMIN_TOKEN_CACHE_SECONDS);
}

async function issueAdminToken_() {
  const token = makeId_("T") + makeId_("K").slice(2);
  await persistAdminToken_(token);
  return token;
}

async function isAdminToken_(token) {
  const value = String(token || "").trim();
  if (!value) return false;
  const cache = CacheService.getScriptCache();
  if (cache.get("pdfw_admin_" + value) === "1") return true;
  let valid = false;
  try {
    const row = await runAll_(database_().prepare("SELECT token FROM adminTokens WHERE token = ?1").bind(value));
    valid = row.length > 0;
  } catch (error) {
    valid = false;
  }
  if (valid) cache.put("pdfw_admin_" + value, "1", ADMIN_TOKEN_CACHE_SECONDS);
  return valid;
}

async function revokeAdminToken_(payload) {
  const value = String(payload && payload.adminToken || "").trim();
  if (value) {
    try {
      await database_().prepare("DELETE FROM adminTokens WHERE token = ?1").bind(value).run();
    } catch (error) {}
    CacheService.getScriptCache().remove("pdfw_admin_" + value);
  }
  return { ok: true, loggedOut: true };
}

function adminPasswordRequiredMessage_() {
  return "尚未設定教師管理密語，請在教師入口首次登入時輸入，輸入成功即自動建立。";
}

async function requireManager_(payload) {
  const password = await getSetting_("AdminPassword");
  if (!password) throw new Error(adminPasswordRequiredMessage_());
  if (!(await isAdminToken_(payload && payload.adminToken))) throw new Error("需要教師管理權限。");
}

async function verifyAdmin_(payload) {
  const configured = await getSetting_("AdminPassword");
  if (await isAdminToken_(payload && payload.adminToken)) {
    await persistAdminToken_(payload.adminToken);
    return { ok: true, token: String(payload.adminToken), persistent: true, configured: true };
  }
  const provided = String((payload && payload.password) || "");
  if (!configured) {
    /* Workers 版沒有試算表可填密碼：首次登入輸入的密語即自動建立為 AdminPassword。 */
    if (!provided) throw new Error(adminPasswordRequiredMessage_());
    await writeSetting_("AdminPassword", provided);
    return { ok: true, token: await issueAdminToken_(), persistent: true, configured: true, firstTimeSetup: true };
  }
  if (provided !== configured) throw new Error("教師管理密語不正確。");
  return { ok: true, token: await issueAdminToken_(), persistent: true, configured: true };
}

/* 設定寫入：Workers 版以設定動作取代 GAS 的試算表手動填寫，僅允許白名單鍵值。 */
const SETTINGS_WRITABLE_KEYS = ["AdminPassword", "GeminiAPIKey"];

async function writeSetting_(key, value) {
  const db = database_();
  await db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)").bind(String(key), "").run();
  await db.prepare("UPDATE settings SET value = ?2 WHERE key = ?1").bind(String(key), String(value || "")).run();
  clearAllTableCaches_();
}

async function updateSettings_(payload) {
  await requireManager_(payload);
  const updates = (payload && payload.settings) || {};
  const updatedKeys = [];
  for (let index = 0; index < SETTINGS_WRITABLE_KEYS.length; index += 1) {
    const key = SETTINGS_WRITABLE_KEYS[index];
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      const value = String(updates[key] || "").trim();
      if (key === "AdminPassword" && value.length < 4) throw new Error("教師管理密語至少需 4 個字。");
      await writeSetting_(key, value);
      updatedKeys.push(key);
    }
  }
  if (!updatedKeys.length) throw new Error("沒有可更新的設定欄位。");
  return { ok: true, updatedKeys: updatedKeys };
}

/* 冪等結果快取：GAS 用 CacheService，Workers 改以 D1 資料表保存，跨隔離層有效。 */
async function mutationResultCacheKey_(action, payload) {
  const data = Object.assign({}, payload || {});
  delete data.adminToken;
  delete data.action;
  const identity = data.mutationId || data.id || data.submissionId || data.materialId || data.boardId || data.clientBoardId;
  if (!identity) return "";
  if (data.mutationId) {
    return MUTATION_RESULT_CACHE_PREFIX + String(action || "mutation").slice(0, 40) + "_" + String(data.mutationId).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 100);
  }
  let raw = "";
  try {
    raw = JSON.stringify(data);
  } catch (error) {
    return "";
  }
  const digest = b64EncodeBytes_(md5Raw_(raw)).replace(/=+$/, "");
  const safeIdentity = String(identity).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
  return MUTATION_RESULT_CACHE_PREFIX + String(action || "mutation").slice(0, 40) + "_" + safeIdentity + "_" + digest;
}

async function readMutationResult_(action, payload) {
  const key = await mutationResultCacheKey_(action, payload);
  if (!key) return null;
  try {
    const rows = await runAll_(database_().prepare("SELECT value, createdAt FROM mutationResults WHERE key = ?1").bind(key));
    if (!rows.length) return null;
    const createdAt = String(rows[0].createdAt || "");
    const createdTime = Date.parse(createdAt);
    if (Number.isFinite(createdTime) && Date.now() - createdTime > MUTATION_RESULT_CACHE_SECONDS * 1000) return null;
    return parseObject_(rows[0].value, null);
  } catch (error) {
    return null;
  }
}

async function cacheMutationResult_(action, payload, result) {
  const key = await mutationResultCacheKey_(action, payload);
  if (!key || !result) return;
  try {
    const value = JSON.stringify(result);
    if (value.length > MUTATION_RESULT_CACHE_MAX_CHARS) return;
    const db = database_();
    try {
      await db.prepare("DELETE FROM mutationResults WHERE createdAt < ?1").bind(new Date(Date.now() - MUTATION_RESULT_CACHE_SECONDS * 1000).toISOString()).run();
    } catch (error) {}
    await db.prepare("INSERT OR REPLACE INTO mutationResults (key, value, createdAt) VALUES (?1, ?2, ?3)").bind(key, value, now_()).run();
  } catch (error) {
    // 冪等快取失敗時仍保留主要寫入結果。
  }
}

/* 作答計數快取：與 GAS 相同的 5 秒快取，介面同步。 */
function submissionCountCacheKey_(boardId) {
  return SUBMISSION_COUNT_CACHE_KEY_PREFIX + String(boardId || "").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 100);
}

function clearSubmissionCountCache_(boardId) {
  if (!boardId) return;
  try {
    CacheService.getScriptCache().remove(submissionCountCacheKey_(boardId));
  } catch (error) {}
}

function cachedSubmissionCounts_(boardId, materialId) {
  try {
    const value = CacheService.getScriptCache().get(submissionCountCacheKey_(boardId));
    const all = value ? parseObject_(value, {}) : {};
    const key = String(materialId || "*");
    return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : null;
  } catch (error) {
    return null;
  }
}

function cacheSubmissionCounts_(boardId, materialId, counts) {
  try {
    const cache = CacheService.getScriptCache();
    const value = cache.get(submissionCountCacheKey_(boardId));
    const all = value ? parseObject_(value, {}) : {};
    all[String(materialId || "*")] = counts || {};
    cache.put(submissionCountCacheKey_(boardId), JSON.stringify(all), SUBMISSION_COUNT_CACHE_SECONDS);
  } catch (error) {
    // 計數快取只是效能最佳化，失敗時直接讀取資料庫。
  }
}

/* R2 檔案層：driveId 語意保存，成為 R2 物件鍵；大型 JSON 的參考字串也不變。 */

async function saveDriveFile_(filePayload, purpose, boardId, submissionId, materialId) {
  const data = String(filePayload && (filePayload.data || filePayload.base64) || "");
  if (!data) throw new Error("檔案資料是空的。");
  const body = decodeBase64_(data);
  const mime = String(filePayload.mime || "application/octet-stream").slice(0, 120);
  const fileName = safeFileName_(filePayload.name || "教學檔案");
  const bytes = b64DecodeBytes_(body);
  const isImage = /^image\//i.test(mime);
  const limit = isImage ? Number(await getSetting_("MaxImageBytes")) || 2097152 : Number(await getSetting_("MaxPdfBytes")) || 20971520;
  if (bytes.length > limit) throw new Error((isImage ? "圖片" : "PDF") + "超過系統允許的大小限制。");
  const fileId = makeId_("F");
  await fileBucket_().put(fileId, bytes, { httpMetadata: { contentType: mime } });
  const index = {
    id: fileId,
    purpose: purpose,
    name: fileName,
    mime: mime,
    driveId: fileId,
    size: bytes.length,
    boardId: boardId || "",
    materialId: materialId || "",
    submissionId: submissionId || "",
    createdAt: now_()
  };
  await appendRow_("files", index);
  return { driveId: fileId, name: fileName, mime: mime, size: bytes.length };
}

async function trashDriveFiles_(driveIds, keepDriveIds) {
  let trashed = 0;
  (driveIds || []).forEach(function (driveId) {
    if (!driveId || (keepDriveIds && keepDriveIds[driveId])) return;
    fileBucket_().delete(String(driveId));
    trashed += 1;
  });
  return trashed;
}

async function storeJson_(value, purpose, boardId, submissionId, materialId) {
  const text = typeof value === "string" ? value : JSON.stringify(value || {});
  if (text.length <= MAX_SHEET_JSON_CHARS) return text;
  const file = await saveDriveFile_({
    name: purpose + "-" + (submissionId || boardId || "資料") + ".json",
    mime: "application/json",
    data: b64EncodeBytes_(new TextEncoder().encode(text))
  }, purpose, boardId, submissionId, materialId);
  const reference = "drive:" + file.driveId;
  await cacheJsonReference_(reference, text);
  return reference;
}

async function cacheJsonReference_(reference, text) {
  try {
    CacheService.getScriptCache().put(jsonReferenceCacheKey_(reference), String(text || ""), JSON_REFERENCE_CACHE_SECONDS);
  } catch (error) {
    // 大型 JSON 可能超過隔離層單筆限制，改由 R2 讀取。
  }
}

function jsonReferenceCacheKey_(reference) {
  return JSON_REFERENCE_CACHE_PREFIX + String(reference || "").slice(6);
}

async function readJsonReference_(value) {
  const text = String(value || "");
  if (text.indexOf("drive:") !== 0) return parseObject_(text, {});
  let cached = "";
  try {
    cached = CacheService.getScriptCache().get(jsonReferenceCacheKey_(text));
  } catch (error) {}
  if (cached) return parseObject_(cached, {});
  try {
    const object = await fileBucket_().get(text.slice(6));
    if (!object) return {};
    const parsed = parseObject_(new TextDecoder("utf-8").decode(object), {});
    await cacheJsonReference_(text, JSON.stringify(parsed));
    return parsed;
  } catch (error) {
    return {};
  }
}

function decodeBase64_(value) {
  const raw = String(value || "");
  const comma = raw.indexOf(",");
  return comma >= 0 ? raw.slice(comma + 1) : raw;
}

/* 【第 3 區 DOMAIN SERVICE】版面、教材、問答區、教師筆跡、作答、公告與課堂狀態的業務規則。
   與 Code.gs 逐支對譯，僅將資料呼叫改為 await；函式回傳契約不變。 */

async function getBoard_(boardId, includeArchived) {
  const board = await findTableItemById_("boards", boardId);
  if (!board) throw new Error("找不到指定教材版面。");
  if (!includeArchived && String(board.status || "啟用") !== "啟用") throw new Error("這個教材版面目前已封存。");
  return board;
}

function legacyMaterialId_(boardId) {
  return "M-" + String(boardId || "") + "-legacy";
}

function legacyMaterial_(board) {
  if (!board || !board.pdfFileId) return null;
  return {
    id: legacyMaterialId_(board.id),
    boardId: board.id,
    name: board.pdfFileName || "主要教材",
    description: "既有單一 PDF 教材",
    pdfFileId: board.pdfFileId,
    pdfFileName: board.pdfFileName,
    pdfMime: board.pdfMime || "application/pdf",
    order: 1,
    status: "啟用",
    createdAt: board.createdAt || "",
    updatedAt: board.updatedAt || "",
    legacy: true
  };
}

function publicMaterial_(item) {
  return {
    id: item.id,
    boardId: item.boardId,
    name: item.name || "未命名教材",
    description: item.description || "",
    pdfFileId: item.pdfFileId || "",
    pdfFileName: item.pdfFileName || "",
    pdfMime: item.pdfMime || "application/pdf",
    order: Number(item.order) || 1,
    status: item.status || "啟用",
    createdAt: item.createdAt || "",
    updatedAt: item.updatedAt || "",
    legacy: Boolean(item.legacy) || String(item.id) === legacyMaterialId_(item.boardId)
  };
}

async function materialsForBoard_(boardId, board) {
  const targetBoard = board || await getBoard_(boardId, false);
  const rows = (await rowsForBoard_("materials", targetBoard.id))
    .filter(isActiveRow_)
    .map(publicMaterial_)
    .sort(function (a, b) { return (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.id).localeCompare(String(b.id)); });
  if (rows.length || !targetBoard.pdfFileId) return rows;
  return [publicMaterial_(legacyMaterial_(targetBoard))];
}

async function findMaterialForBoard_(board, materialId) {
  const targetId = String(materialId || "");
  return (await materialsForBoard_(board.id, board)).find(function (item) { return String(item.id) === targetId; }) || null;
}

async function materialForBoard_(board, materialId) {
  const targetId = String(materialId || legacyMaterialId_(board.id));
  const material = await findMaterialForBoard_(board, targetId);
  if (!material) throw new Error("找不到指定課堂教材。");
  return material;
}

function materialIdForItem_(board, materialId) {
  return String(materialId || legacyMaterialId_(board.id));
}

function isLegacyMaterialId_(board, materialId) {
  return String(materialId || "") === legacyMaterialId_(board.id);
}

async function boardScopedRows_(key, board, comparator) {
  const legacyId = legacyMaterialId_(board.id);
  return (await rowsForBoard_(key, board.id))
    .filter(isActiveRow_)
    .map(function (item) { return Object.assign({}, item, { materialId: String(item.materialId || legacyId) }); })
    .sort(comparator);
}

async function areasForBoard_(boardId, board) {
  const targetBoard = board || await getBoard_(boardId, false);
  return boardScopedRows_("areas", targetBoard, compareAreasByPosition_);
}

async function answerMasksForBoard_(boardId, board) {
  const targetBoard = board || await getBoard_(boardId, false);
  return boardScopedRows_("answerMasks", targetBoard, compareAnswerMasksByPosition_);
}

function compareAreasByPosition_(a, b) {
  return (Number(a.page) || 1) - (Number(b.page) || 1) || (Number(a.y) || 0) - (Number(b.y) || 0) || (Number(a.x) || 0) - (Number(b.x) || 0) || (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.id || "").localeCompare(String(b.id || ""));
}

function compareAnswerMasksByPosition_(a, b) {
  return (Number(a.page) || 1) - (Number(b.page) || 1) || (Number(a.y) || 0) - (Number(b.y) || 0) || (Number(a.x) || 0) - (Number(b.x) || 0) || (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.id || "").localeCompare(String(b.id || ""));
}

function submissionDriveIds_(submission) {
  const ids = parseArray_(submission.imageFileIds).map(function (id) { return String(id || "").trim(); }).filter(Boolean);
  const feedback = String(submission.teacherStrokes || "");
  if (feedback.indexOf("drive:") === 0) ids.push(feedback.slice(6));
  return ids.filter(Boolean);
}

async function removeSubmissionsForAreas_(boardId, areaIds, materialId) {
  const targetAreas = {};
  (areaIds || []).forEach(function (areaId) { targetAreas[String(areaId)] = true; });
  const targetMaterialId = materialId ? String(materialId) : "";
  const submissions = (await rowsForBoard_("submissions", boardId)).filter(function (item) {
    if (targetAreas[String(item.areaId)]) return true;
    return Boolean(targetMaterialId) && materialIdOf_(item, boardId) === targetMaterialId;
  });
  if (!submissions.length) return 0;
  const targetSubmissions = {};
  const driveIds = {};
  submissions.forEach(function (submission) {
    targetSubmissions[String(submission.id)] = true;
    submissionDriveIds_(submission).forEach(function (driveId) { driveIds[driveId] = true; });
  });
  (await rowsForBoard_("files", boardId)).forEach(function (file) {
    if (targetSubmissions[String(file.submissionId)] && file.driveId) driveIds[String(file.driveId)] = true;
  });
  const remainingDriveIds = {};
  (await rowsForBoard_("submissions", boardId)).filter(function (item) { return !targetSubmissions[String(item.id)]; }).forEach(function (submission) {
    submissionDriveIds_(submission).forEach(function (driveId) { remainingDriveIds[driveId] = true; });
  });
  await trashDriveFiles_(Object.keys(driveIds), remainingDriveIds);
  await deleteRows_("files", function (file) { return targetSubmissions[String(file.submissionId)]; });
  const deleted = await deleteRows_("submissions", function (item) {
    if (targetAreas[String(item.areaId)]) return true;
    return Boolean(targetMaterialId) && materialIdOf_(item, boardId) === targetMaterialId;
  });
  clearSubmissionCountCache_(boardId);
  return deleted;
}

async function boardCatalogResult_(board) {
  return {
    ok: true,
    board: await publicBoard_(board),
    materials: await materialsForBoard_(board.id, board),
    areas: await areasForBoard_(board.id, board),
    answerMasks: await answerMasksForBoard_(board.id, board)
  };
}

async function publicBoard_(board) {
  return {
    id: board.id,
    name: board.name,
    description: board.description,
    pdfFileId: board.pdfFileId,
    pdfFileName: board.pdfFileName,
    pdfMime: board.pdfMime,
    status: board.status,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    materials: await materialsForBoard_(board.id, board),
    answerMasks: await answerMasksForBoard_(board.id, board)
  };
}

async function publicBoardSummary_(board) {
  return {
    id: board.id,
    name: board.name,
    description: board.description,
    pdfFileName: board.pdfFileName,
    materialCount: (await materialsForBoard_(board.id, board)).length,
    status: board.status,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt
  };
}

function compareBoardsByUpdatedAt_(a, b) {
  const aTime = Date.parse(String(a.updatedAt || ""));
  const bTime = Date.parse(String(b.updatedAt || ""));
  const aValue = isNaN(aTime) ? 0 : aTime;
  const bValue = isNaN(bTime) ? 0 : bTime;
  return bValue - aValue || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")) || String(a.id || "").localeCompare(String(b.id || ""));
}

async function publicInk_(item, strokesOverride) {
  return {
    id: item.id,
    boardId: item.boardId,
    materialId: item.materialId || legacyMaterialId_(item.boardId),
    page: Number(item.page) || 1,
    strokes: strokesOverride === undefined ? await readJsonReference_(item.strokes) : strokesOverride,
    updatedAt: item.updatedAt
  };
}

function inkVersion_(rows) {
  return rows.map(function (item) { return String(item.id || "") + ":" + String(item.updatedAt || ""); }).sort().join("|");
}

function classroomCatalogVersion_(board, materials, areas, answerMasks) {
  const targetMaterials = materials;
  const targetAreas = areas;
  const targetAnswerMasks = answerMasks;
  const materialVersion = targetMaterials.map(function (item) {
    return String(item.id || "") + ":" + String(item.updatedAt || "") + ":" + String(item.pdfFileId || "");
  }).join(",");
  const areaVersion = targetAreas.map(function (item) {
    return String(item.id || "") + ":" + String(item.updatedAt || "");
  }).join(",");
  const answerMaskVersion = targetAnswerMasks.map(function (item) {
    return String(item.id || "") + ":" + String(item.updatedAt || "");
  }).join(",");
  const raw = [String(board.updatedAt || ""), materialVersion, areaVersion, answerMaskVersion].join("|");
  return b64EncodeBytes_(md5Raw_(raw));
}

function cacheClassroomPulseState_(state) {
  if (!state || !state.boardId) return;
  writeClassroomPulseCache_(classroomPulseKey_(state.boardId, "state"), JSON.stringify(state));
}

function cacheClassroomPulseCatalog_(boardId, version) {
  writeClassroomPulseCache_(classroomPulseKey_(boardId, "catalog"), version);
}

function touchClassroomPulseCatalog_(board, materials, areas, answerMasks) {
  if (!board || !board.id) return;
  cacheClassroomPulseCatalog_(board.id, classroomCatalogVersion_(board, materials, areas, answerMasks));
  touchClassroomPulse_(board.id);
}

function cacheClassroomPulseInk_(boardId, materialId, page, rows) {
  writeClassroomPulseCache_(classroomPulseInkKey_(boardId, materialId, page), inkVersion_(rows || []));
}

function touchClassroomPulseInk_(item) {
  const materialId = item.materialId || legacyMaterialId_(item.boardId);
  const page = Number(item.page) || 1;
  cacheClassroomPulseInk_(item.boardId, materialId, page, [item]);
  touchClassroomPulse_(item.boardId);
}

function inkVersionMap_(value) {
  const output = {};
  String(value || "").split("|").forEach(function (entry) {
    const delimiter = entry.indexOf(":");
    if (delimiter < 1) return;
    output[entry.slice(0, delimiter)] = entry.slice(delimiter + 1);
  });
  return output;
}

function inkDeltaCacheKey_(inkId) {
  return INK_DELTA_CACHE_PREFIX + String(inkId || "");
}

function readInkDeltaRecords_(inkId) {
  try {
    return parseArray_(CacheService.getScriptCache().get(inkDeltaCacheKey_(inkId))).filter(function (record) { return record && typeof record === "object"; });
  } catch (error) {
    return [];
  }
}

function clearInkDeltaRecords_(inkId) {
  try {
    CacheService.getScriptCache().remove(inkDeltaCacheKey_(inkId));
  } catch (error) {}
}

function writeInkDeltaRecord_(inkId, baseVersion, version, strokes) {
  try {
    const records = readInkDeltaRecords_(inkId);
    const last = records[records.length - 1];
    const chain = !last || String(last.version || "") === String(baseVersion || "") ? records : [];
    chain.push({ baseVersion: String(baseVersion || ""), version: String(version || ""), strokes: Array.isArray(strokes) ? strokes : [] });
    CacheService.getScriptCache().put(inkDeltaCacheKey_(inkId), JSON.stringify(chain.slice(-12)), INK_DELTA_CACHE_SECONDS);
  } catch (error) {
    // 筆跡增量過大時改回傳完整筆跡，不影響保存結果。
  }
}

function inkAppendDelta_(item, clientVersion) {
  const targetVersion = String(clientVersion || "");
  const currentVersion = String(item.updatedAt || "");
  if (targetVersion === currentVersion) return null;
  const records = readInkDeltaRecords_(item.id);
  if (!records.length) return null;
  const seen = {};
  const strokes = [];
  let version = targetVersion;
  while (version !== currentVersion) {
    if (seen[version]) return null;
    seen[version] = true;
    const record = records.find(function (candidate) { return String(candidate.baseVersion || "") === version; });
    if (!record || String(record.version || "") === version || !Array.isArray(record.strokes)) return null;
    record.strokes.forEach(function (stroke) { strokes.push(stroke); });
    version = String(record.version || "");
  }
  return { strokes: strokes };
}

async function publicInkDelta_(item, clientVersions) {
  const delta = inkAppendDelta_(item, clientVersions[String(item.id)] || "");
  if (!delta) return null;
  const output = await publicInk_(item, delta.strokes);
  output.strokesMode = "append";
  return output;
}

function compactPublicInk_(item) {
  return {
    id: item.id,
    boardId: item.boardId,
    materialId: item.materialId || legacyMaterialId_(item.boardId),
    page: Number(item.page) || 1,
    updatedAt: item.updatedAt
  };
}

function strokesHavePrefix_(prefix, strokes) {
  if (!Array.isArray(prefix) || !Array.isArray(strokes) || prefix.length > strokes.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (JSON.stringify(prefix[index]) !== JSON.stringify(strokes[index])) return false;
  }
  return true;
}

async function publicSubmission_(item, includePrivate, fallbackMaterialId) {
  const output = {
    id: item.id,
    boardId: item.boardId,
    materialId: item.materialId || fallbackMaterialId || "",
    areaId: item.areaId,
    nickname: item.nickname,
    text: item.text,
    imageFileIds: parseArray_(item.imageFileIds),
    imageFileNames: parseArray_(item.imageFileNames),
    teacherStrokes: await readJsonReference_(item.teacherStrokes),
    teacherComment: item.teacherComment,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
  if (includePrivate) {
    output.clientId = item.clientId;
  }
  return output;
}

function announcementPinned_(value) {
  return value === true || String(value || "").toLowerCase() === "true" || String(value || "") === "1" || String(value || "") === "是";
}

function normalizeAnnouncementUrl_(value) {
  const raw = String(value == null ? "" : value).trim();
  if (raw.length > MAX_TEXT.url) throw new Error("公告連結不可超過 2048 個字元。");
  const url = cleanText_(raw, MAX_TEXT.url);
  if (!/^https?:\/\/[^\s/]+(?:[/?#][^\s]*)?$/i.test(url)) throw new Error("公告連結只接受有效的 http 或 https 網址。");
  return url;
}

function normalizeAnnouncementLink_(value) {
  const item = value && typeof value === "object" && !Array.isArray(value) ? value : { url: value };
  const labelValue = item.label !== undefined ? item.label : item.name;
  return {
    label: cleanText_(labelValue, MAX_TEXT.announcementLinkLabel),
    url: normalizeAnnouncementUrl_(item.url)
  };
}

function normalizeAnnouncementLinks_(value, fallbackUrl) {
  let rows = parseArray_(value);
  if (!rows.length && fallbackUrl) rows = [{ url: fallbackUrl }];
  if (!rows.length) throw new Error("公告至少要有一個連結。");
  if (rows.length > MAX_ANNOUNCEMENT_LINKS) throw new Error("一則公告最多可新增 " + MAX_ANNOUNCEMENT_LINKS + " 個連結。");
  return rows.map(normalizeAnnouncementLink_);
}

function storedAnnouncementLinks_(item) {
  const rows = parseArray_(item && item.links);
  const links = [];
  rows.forEach(function (value) {
    try {
      links.push(normalizeAnnouncementLink_(value));
    } catch (error) {}
  });
  if (!links.length && item && item.url) {
    try {
      links.push(normalizeAnnouncementLink_({ url: item.url }));
    } catch (error) {}
  }
  return links;
}

function normalizeAnnouncementOrder_(value, fallback) {
  const candidate = Number(value);
  const defaultValue = Number(fallback) || 1;
  return Math.max(1, Math.min(1000, Math.floor(Number.isFinite(candidate) && candidate > 0 ? candidate : defaultValue)));
}

function publicAnnouncement_(item) {
  const links = storedAnnouncementLinks_(item);
  return {
    id: String(item.id || ""),
    title: String(item.title || ""),
    description: String(item.description || ""),
    url: links.length ? links[0].url : "",
    links: links,
    pinned: announcementPinned_(item.pinned),
    order: normalizeAnnouncementOrder_(item.order, 1),
    status: String(item.status || "啟用"),
    createdAt: String(item.createdAt || ""),
    updatedAt: String(item.updatedAt || "")
  };
}

async function announcementsForPublic_() {
  return (await readTable_("announcements"))
    .filter(isActiveRow_)
    .map(publicAnnouncement_)
    .sort(function (a, b) {
      return Number(b.pinned) - Number(a.pinned) || a.order - b.order || String(b.updatedAt).localeCompare(String(a.updatedAt)) || String(a.id).localeCompare(String(b.id));
    });
}

async function announcementResult_(announcement) {
  return { ok: true, announcement: publicAnnouncement_(announcement), data: await announcementsForPublic_(), serverTime: now_() };
}

async function listAnnouncements_(payload) {
  return { ok: true, data: await announcementsForPublic_(), serverTime: now_() };
}

async function createAnnouncement_(payload) {
  await requireManager_(payload || {});
  const title = cleanText_(payload.title, MAX_TEXT.title);
  if (!title) throw new Error("請填寫公告標題。");
  const description = cleanText_(payload.description, MAX_TEXT.announcementDescription);
  const links = normalizeAnnouncementLinks_(payload.links, payload.url);
  const url = links[0].url;
  const id = cleanText_(payload.id, 120) || makeId_("AN");
  const existing = await findTableItemById_("announcements", id);
  if (existing) return announcementResult_(existing);
  const activeRows = (await readTable_("announcements")).filter(isActiveRow_);
  const now = now_();
  const item = {
    id: id,
    title: title,
    description: description,
    url: url,
    links: JSON.stringify(links),
    pinned: announcementPinned_(payload.pinned),
    order: normalizeAnnouncementOrder_(payload.order, activeRows.length + 1),
    status: "啟用",
    createdAt: now,
    updatedAt: now
  };
  await appendRow_("announcements", item);
  return announcementResult_(item);
}

async function updateAnnouncement_(payload) {
  await requireManager_(payload || {});
  const id = cleanText_(payload.id, 120);
  if (!id) throw new Error("缺少公告 ID。");
  const existing = await findTableItemById_("announcements", id);
  if (!existing) throw new Error("找不到指定公告。");
  const fields = { updatedAt: now_() };
  if (payload.title !== undefined) {
    fields.title = cleanText_(payload.title, MAX_TEXT.title);
    if (!fields.title) throw new Error("公告標題不可為空白。");
  }
  if (payload.description !== undefined) fields.description = cleanText_(payload.description, MAX_TEXT.announcementDescription);
  if (payload.links !== undefined) {
    const links = normalizeAnnouncementLinks_(payload.links, payload.url);
    fields.url = links[0].url;
    fields.links = JSON.stringify(links);
  } else if (payload.url !== undefined) {
    const url = normalizeAnnouncementUrl_(payload.url);
    const links = storedAnnouncementLinks_(existing);
    if (links.length) links[0].url = url;
    else links.push({ label: "", url: url });
    fields.url = url;
    fields.links = JSON.stringify(links);
  }
  if (payload.pinned !== undefined) fields.pinned = announcementPinned_(payload.pinned);
  if (payload.order !== undefined) fields.order = normalizeAnnouncementOrder_(payload.order, existing.order);
  await updateRow_("announcements", id, fields);
  return announcementResult_(Object.assign({}, existing, fields));
}

async function reorderAnnouncements_(payload) {
  await requireManager_(payload || {});
  const rows = (await readTable_("announcements")).filter(isActiveRow_);
  const items = parseArray_(payload.items);
  if (items.length !== rows.length) throw new Error("公告排序資料不完整。");
  const rowMap = {};
  rows.forEach(function (item) { rowMap[String(item.id)] = item; });
  const seen = {};
  const updatedAt = now_();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const id = cleanText_(item && item.id, 120);
    if (!id || !rowMap[id] || seen[id]) throw new Error("公告排序資料不正確。");
    seen[id] = true;
    await updateRow_("announcements", id, { order: index + 1, updatedAt: updatedAt });
  }
  return { ok: true, data: await announcementsForPublic_(), serverTime: now_() };
}

async function deleteAnnouncement_(payload) {
  await requireManager_(payload || {});
  const id = cleanText_(payload.id, 120);
  if (!id) throw new Error("缺少公告 ID。");
  const deleted = await deleteRows_("announcements", function (item) { return String(item.id) === id; });
  return { ok: true, id: id, deleted: deleted, data: await announcementsForPublic_(), serverTime: now_() };
}

async function listBoards_(payload) {
  await requireManager_(payload || {});
  const rows = (await readTable_("boards")).filter(isActiveRow_);
  const pendingCounts = {};
  (await readTable_("submissions")).forEach(function (item) {
    if (!isActiveRow_(item)) return;
    if (String(item.status || "") === "已批改") return;
    const key = String(item.boardId || "");
    if (key) pendingCounts[key] = (pendingCounts[key] || 0) + 1;
  });
  const data = await Promise.all(rows.map(async function (board) {
    const item = await publicBoard_(board);
    item.pendingCount = pendingCounts[String(board.id)] || 0;
    return item;
  }));
  return {
    ok: true,
    data: data.sort(compareBoardsByUpdatedAt_),
    serverTime: now_()
  };
}

async function listPublicBoards_() {
  const boards = (await readTable_("boards")).filter(isActiveRow_);
  const materialRows = await readTable_("materials");
  const counts = {};
  materialRows.forEach(function (item) {
    if (!isActiveRow_(item)) return;
    const key = String(item.boardId || "");
    if (key) counts[key] = (counts[key] || 0) + 1;
  });
  const data = await Promise.all(boards.map(async function (board) {
    const summary = await publicBoardSummary_(board);
    const key = String(board.id || "");
    if (counts[key]) summary.materialCount = counts[key];
    else if (board.pdfFileId) summary.materialCount = 1;
    else summary.materialCount = 0;
    return summary;
  }));
  data.sort(compareBoardsByUpdatedAt_);
  return { ok: true, data: data, serverTime: now_() };
}

async function getBoardData_(payload) {
  const board = await getBoard_(payload.boardId, false);
  return {
    ok: true,
    board: await publicBoard_(board),
    materials: await materialsForBoard_(board.id, board),
    areas: await areasForBoard_(board.id, board),
    answerMasks: await answerMasksForBoard_(board.id, board),
    serverTime: now_()
  };
}

async function listInk_(payload) {
  await requireManager_(payload);
  const board = await getBoard_(payload.boardId, false);
  const materialId = payload.materialId ? (await materialForBoard_(board, payload.materialId)).id : "";
  const rows = (await rowsForBoard_("ink", board.id)).filter(function (item) {
    const itemMaterialId = materialIdOf_(item, board.id);
    return !materialId || itemMaterialId === materialId;
  });
  return {
    ok: true,
    data: await Promise.all(rows.map(function (item) { return publicInk_(item); })),
    inkVersion: inkVersion_(rows),
    serverTime: now_()
  };
}

async function saveInk_(payload) {
  await requireManager_(payload);
  const board = await getBoard_(payload.boardId, true);
  const material = await materialForBoard_(board, payload.materialId);
  const materialId = material.id;
  const page = Math.max(1, Number(payload.page) || 1);
  const strokes = Array.isArray(payload.strokes) ? payload.strokes : [];
  const id = isLegacyMaterialId_(board, materialId) ? "INK-" + board.id + "-" + page : "INK-" + board.id + "-" + materialId + "-" + page;
  const existing = await findTableItemById_("ink", id);
  const previousValue = existing ? await readJsonReference_(existing.strokes) : [];
  const previousStrokes = Array.isArray(previousValue) ? previousValue : [];
  const explicitReplace = payload && (payload.replaceInk === true || String(payload.replaceInk || "") === "1");
  const mutationId = cleanText_(payload.mutationId, 120);
  if (existing && mutationId && String(existing.mutationId || "") === mutationId) {
    return { ok: true, annotation: payload.compact ? compactPublicInk_(existing) : await publicInk_(existing) };
  }
  if (existing && materialIdOf_(existing, board.id) === String(materialId) && Number(existing.page) === page && JSON.stringify(previousStrokes) === JSON.stringify(strokes)) {
    return { ok: true, annotation: payload.compact ? compactPublicInk_(existing) : await publicInk_(existing) };
  }
  if (existing && !explicitReplace && previousStrokes.length > strokes.length) {
    return { ok: true, annotation: await publicInk_(existing), preserved: true };
  }
  const appendOnly = strokesHavePrefix_(previousStrokes, strokes);
  const previousVersion = existing ? String(existing.updatedAt || "") : "";
  let updatedAt = now_();
  const previousTime = Date.parse(previousVersion);
  const currentTime = Date.parse(updatedAt);
  if (Number.isFinite(previousTime) && Number.isFinite(currentTime) && currentTime <= previousTime) updatedAt = new Date(previousTime + 1).toISOString();
  const reference = await storeJson_(strokes, "教師頁面手寫", board.id, id, materialId);
  const item = { id: id, boardId: board.id, materialId: materialId, page: page, strokes: reference, updatedAt: updatedAt, mutationId: mutationId };
  if (existing) await updateRow_("ink", id, item);
  else await appendRow_("ink", item);
  if (appendOnly) writeInkDeltaRecord_(id, previousVersion, updatedAt, strokes.slice(previousStrokes.length));
  else clearInkDeltaRecords_(id);
  touchClassroomPulseInk_(item);
  return { ok: true, annotation: payload.compact ? compactPublicInk_(item) : await publicInk_(item) };
}

async function findClassroomStateRow_(boardId) {
  return (await rowsForBoard_("classroomState", boardId)).find(function (item) { return String(item.boardId) === String(boardId); }) || null;
}

function publicClassroomState_(item, boardId) {
  return {
    id: item ? item.id : "STATE-" + boardId,
    boardId: boardId,
    materialId: item && item.materialId ? item.materialId : legacyMaterialId_(boardId),
    page: Math.max(1, Number(item && item.page) || 1),
    zoom: Math.max(0.6, Math.min(2.2, Number(item && item.zoom) || 1)),
    updatedAt: item ? item.updatedAt : ""
  };
}

async function cleanAnswerMasks_(board, masks) {
  const materialIds = new Set((await materialsForBoard_(board.id, board)).map(function (item) { return String(item.id); }));
  return parseArray_(masks).slice(0, 200).map(function (mask, index) {
    const materialId = materialIdForItem_(board, mask && mask.materialId);
    if (!materialIds.has(materialId)) throw new Error("答案遮罩所屬教材不存在。");
    const width = Math.max(0.01, Math.min(1, Number(mask && mask.width) || 0.2));
    const height = Math.max(0.01, Math.min(1, Number(mask && mask.height) || 0.12));
    const x = Math.max(0, Math.min(1 - width, Number(mask && mask.x) || 0));
    const y = Math.max(0, Math.min(1 - height, Number(mask && mask.y) || 0));
    return {
      id: cleanText_(mask && mask.id, 100) || makeId_("AM"),
      boardId: board.id,
      materialId: materialId,
      page: Math.max(1, Number(mask && mask.page) || 1),
      x: x,
      y: y,
      width: width,
      height: height,
      title: cleanText_(mask && mask.title || "答案遮罩 " + (index + 1), MAX_TEXT.title),
      order: index + 1,
      status: "啟用",
      createdAt: cleanText_(mask && mask.createdAt, 40) || now_(),
      updatedAt: now_()
    };
  }).sort(compareAnswerMasksByPosition_);
}

async function saveAnswerMasks_(boardId, masks) {
  const board = await getBoard_(boardId, true);
  const cleanedMasks = await cleanAnswerMasks_(board, masks);
  await deleteRowsForBoard_("answerMasks", board.id);
  for (const mask of cleanedMasks) {
    await appendRow_("answerMasks", mask);
  }
  touchClassroomPulseCatalog_(board, await materialsForBoard_(board.id, board), await areasForBoard_(board.id, board), cleanedMasks);
  return answerMasksForBoard_(board.id, board);
}

function touchClassroomPulseState_(item, boardId) {
  const state = publicClassroomState_(item, boardId);
  cacheClassroomPulseState_(state);
  touchClassroomPulse_(boardId);
}

async function submissionCountsForBoard_(boardId, materialId, board, areas) {
  const targetBoard = board || await getBoard_(boardId, false);
  const cached = cachedSubmissionCounts_(targetBoard.id, materialId);
  if (cached !== null) return cached;
  const targetAreas = areas || await areasForBoard_(targetBoard.id, targetBoard);
  const areaMap = {};
  targetAreas.forEach(function (area) { areaMap[String(area.id)] = area; });
  const counts = {};
  (await rowsForBoard_("submissions", targetBoard.id)).forEach(function (item) {
    const area = areaMap[String(item.areaId)];
    if (!area || (materialId && String(area.materialId) !== String(materialId))) return;
    counts[String(item.areaId)] = (counts[String(item.areaId)] || 0) + 1;
  });
  cacheSubmissionCounts_(targetBoard.id, materialId, counts);
  return counts;
}

async function classroomSync_(payload) {
  const board = await getBoard_(payload.boardId, false);
  const materials = await materialsForBoard_(board.id, board);
  const state = await findClassroomStateRow_(board.id);
  const requestedMaterial = payload.materialId ? materials.find(function (item) { return String(item.id) === String(payload.materialId); }) : null;
  const stateMaterialId = state && state.materialId ? String(state.materialId) : legacyMaterialId_(board.id);
  const requestedMaterialId = (requestedMaterial && requestedMaterial.id) || (materials.find(function (item) { return String(item.id) === stateMaterialId; }) || materials[0] || { id: legacyMaterialId_(board.id) }).id;
  const allInkRows = (await rowsForBoard_("ink", board.id)).filter(function (item) {
    return materialIdOf_(item, board.id) === requestedMaterialId;
  });
  const rawInkPage = Number(payload.inkPage);
  const inkPage = Number.isFinite(rawInkPage) && rawInkPage > 0 ? Math.max(1, Math.floor(rawInkPage)) : 0;
  const inkRows = inkPage ? allInkRows.filter(function (item) { return (Number(item.page) || 1) === inkPage; }) : allInkRows;
  const inkVersion = inkVersion_(inkRows);
  const clientInkVersion = String(payload.inkVersion || "");
  const inkChanged = clientInkVersion !== inkVersion;
  const useInkDelta = String(payload.inkDelta || "") === "1";
  const clientInkVersions = inkVersionMap_(clientInkVersion);
  const currentInkIds = {};
  inkRows.forEach(function (item) { currentInkIds[String(item.id)] = true; });
  const pageReset = inkPage > 0 && (!clientInkVersion || Object.keys(clientInkVersions).some(function (id) { return !currentInkIds[id]; }));
  const changedInkRows = inkChanged ? inkRows.filter(function (item) {
    return String(clientInkVersions[String(item.id)] || "") !== String(item.updatedAt || "");
  }) : [];
  let inkResult = null;
  if (inkChanged) {
    if (useInkDelta && !pageReset) {
      inkResult = await Promise.all(changedInkRows.map(function (item) { return publicInkRowOrDelta_(item, clientInkVersions); }));
    } else {
      inkResult = await Promise.all(inkRows.map(function (item) { return publicInk_(item); }));
    }
  }
  const areas = await areasForBoard_(board.id, board);
  const answerMasks = await answerMasksForBoard_(board.id, board);
  const includeSubmissionCounts = String(payload.includeSubmissionCounts || "1") !== "0";
  const sharedState = publicClassroomState_(state, board.id);
  if (materials.length && !materials.some(function (item) { return String(item.id) === String(sharedState.materialId); })) sharedState.materialId = materials[0].id;
  const stateVersion = String(sharedState.updatedAt || "");
  const catalogVersion = classroomCatalogVersion_(board, materials, areas, answerMasks);
  const catalogChanged = String(payload.catalogVersion || "") !== catalogVersion;
  const includeCatalog = String(payload.catalogDelta || "") !== "1" || catalogChanged;
  const pulseVersion = ensureClassroomPulseVersion_(board.id, stateVersion, catalogVersion, inkVersion);
  if (readClassroomPulseCache_(classroomPulseKey_(board.id, "state")) === null) cacheClassroomPulseState_(sharedState);
  if (readClassroomPulseCache_(classroomPulseKey_(board.id, "catalog")) === null) cacheClassroomPulseCatalog_(board.id, catalogVersion);
  if (inkPage > 0 && readClassroomPulseCache_(classroomPulseInkKey_(board.id, requestedMaterialId, inkPage)) === null) cacheClassroomPulseInk_(board.id, requestedMaterialId, inkPage, inkRows);
  return {
    ok: true,
    state: sharedState,
    stateVersion: stateVersion,
    catalogVersion: catalogVersion,
    pulseVersion: pulseVersion,
    inkVersion: inkVersion,
    inkChanged: inkChanged,
    ink: inkResult,
    inkDelta: useInkDelta,
    inkReset: useInkDelta && (inkPage > 0 ? pageReset : !clientInkVersion),
    inkPage: inkPage,
    materialId: requestedMaterialId,
    catalogChanged: catalogChanged,
    materials: includeCatalog ? materials : null,
    areas: includeCatalog ? areas : null,
    answerMasks: includeCatalog ? answerMasks : null,
    submissionCounts: includeSubmissionCounts ? await submissionCountsForBoard_(board.id, requestedMaterialId, board, areas) : null,
    serverTime: now_()
  };
}

async function classroomPulse_(payload) {
  const board = await getBoard_(payload.boardId, false);
  const stateKey = classroomPulseKey_(board.id, "state");
  let stateValue = readClassroomPulseCache_(stateKey);
  let sharedState = stateValue ? parseObject_(stateValue, null) : null;
  if (!sharedState || !sharedState.boardId) {
    const stateRow = await findClassroomStateRow_(board.id);
    sharedState = publicClassroomState_(stateRow, board.id);
    cacheClassroomPulseState_(sharedState);
  }

  let catalogVersion = readClassroomPulseCache_(classroomPulseKey_(board.id, "catalog"));
  let materials = null;
  let areas = null;
  if (catalogVersion === null) {
    materials = await materialsForBoard_(board.id, board);
    areas = await areasForBoard_(board.id, board);
    catalogVersion = classroomCatalogVersion_(board, materials, areas, await answerMasksForBoard_(board.id, board));
    cacheClassroomPulseCatalog_(board.id, catalogVersion);
  }

  let requestedMaterialId = String(payload.materialId || sharedState.materialId || legacyMaterialId_(board.id));
  if (materials) {
    const requestedMaterial = materials.find(function (item) { return String(item.id) === requestedMaterialId; });
    if (!requestedMaterial) requestedMaterialId = String((materials.find(function (item) { return String(item.id) === String(sharedState.materialId); }) || materials[0] || { id: legacyMaterialId_(board.id) }).id);
  }
  const rawInkPage = Number(payload.inkPage);
  const inkPage = Number.isFinite(rawInkPage) && rawInkPage > 0 ? Math.max(1, Math.floor(rawInkPage)) : 0;
  const inkKey = classroomPulseInkKey_(board.id, requestedMaterialId, inkPage || 1);
  let inkVersion = inkPage > 0 ? readClassroomPulseCache_(inkKey) : null;
  if (inkPage > 0 && inkVersion === null) {
    const inkRows = (await rowsForBoard_("ink", board.id)).filter(function (item) {
      return materialIdOf_(item, board.id) === requestedMaterialId && (Number(item.page) || 1) === inkPage;
    });
    inkVersion = inkVersion_(inkRows);
    cacheClassroomPulseInk_(board.id, requestedMaterialId, inkPage, inkRows);
  }
  if (inkPage === 0) inkVersion = "";

  const pulseVersion = ensureClassroomPulseVersion_(board.id, String(sharedState.updatedAt || ""), catalogVersion, inkVersion);
  const stateVersion = String(sharedState.updatedAt || "");
  const clientStateVersion = String(payload.stateVersion || "");
  const clientCatalogVersion = String(payload.catalogVersion || "");
  const clientInkVersion = String(payload.inkVersion || "");
  const includeSubmissionCounts = String(payload.includeSubmissionCounts || "0") !== "0";
  if (String(payload.includeChanges || "") === "1" && (clientCatalogVersion !== catalogVersion || clientInkVersion !== inkVersion)) {
    const full = await classroomSync_(payload);
    full.catalogChanged = clientCatalogVersion !== String(full.catalogVersion || "");
    full.stateChanged = clientStateVersion !== String(full.stateVersion || "");
    return full;
  }
  if (includeSubmissionCounts && !areas) areas = await areasForBoard_(board.id, board);
  return {
    ok: true,
    state: sharedState,
    stateVersion: stateVersion,
    catalogVersion: catalogVersion,
    pulseVersion: pulseVersion,
    stateChanged: clientStateVersion !== stateVersion,
    catalogChanged: clientCatalogVersion !== catalogVersion,
    inkVersion: inkVersion,
    inkChanged: clientInkVersion !== inkVersion,
    ink: null,
    inkDelta: true,
    inkReset: false,
    inkPage: inkPage,
    materialId: requestedMaterialId,
    materials: null,
    areas: null,
    submissionCounts: includeSubmissionCounts ? await submissionCountsForBoard_(board.id, requestedMaterialId, board, areas) : null,
    serverTime: now_()
  };
}

async function saveClassroomState_(payload) {
  await requireManager_(payload);
  const board = await getBoard_(payload.boardId, true);
  const materialId = (await materialForBoard_(board, payload.materialId)).id;
  const item = {
    id: "STATE-" + board.id,
    boardId: board.id,
    materialId: materialId,
    page: Math.max(1, Number(payload.page) || 1),
    zoom: Math.max(0.6, Math.min(2.2, Number(payload.zoom) || 1)),
    updatedAt: now_()
  };
  const existing = await findTableItemById_("classroomState", item.id);
  if (existing) await updateRow_("classroomState", item.id, item);
  else await appendRow_("classroomState", item);
  touchClassroomPulseState_(item, board.id);
  return { ok: true, state: publicClassroomState_(item, board.id) };
}

async function assignLegacyMaterialToRows_(key, board, legacyId) {
  const rows = (await rowsForBoard_(key, board.id)).filter(function (item) { return !item.materialId; });
  for (const item of rows) {
    await updateRow_(key, item.id, { materialId: legacyId });
  }
}

async function materializeLegacyMaterial_(board) {
  const legacyId = legacyMaterialId_(board.id);
  const existing = await findTableItemById_("materials", legacyId);
  const legacy = existing || legacyMaterial_(board);
  if (!legacy) return null;
  if (!existing) await appendRow_("materials", legacy);
  await assignLegacyMaterialToRows_("areas", board, legacyId);
  await assignLegacyMaterialToRows_("ink", board, legacyId);
  await assignLegacyMaterialToRows_("classroomState", board, legacyId);
  const submissionMaterialIds = {};
  const submissions = await rowsForBoard_("submissions", board.id);
  for (const item of submissions) {
    const area = findItemById_(await readTable_("areas"), item.areaId);
    const materialId = item.materialId || (area && area.materialId) || legacyId;
    submissionMaterialIds[String(item.id)] = materialId;
    if (!item.materialId) await updateRow_("submissions", item.id, { materialId: materialId });
  }
  const files = (await rowsForBoard_("files", board.id)).filter(function (item) { return !item.materialId; });
  for (const item of files) {
    const materialId = String(item.driveId) === String(board.pdfFileId) ? legacyId : submissionMaterialIds[String(item.submissionId)] || "";
    if (materialId) await updateRow_("files", item.id, { materialId: materialId });
  }
  return legacy;
}

async function migrateLegacyMaterials_() {
  const boards = (await readTable_("boards")).filter(function (board) { return board && board.pdfFileId; });
  for (const board of boards) {
    await materializeLegacyMaterial_(board);
  }
}

async function createBoard_(payload) {
  await requireManager_(payload);
  const name = cleanText_(payload.name, MAX_TEXT.name);
  if (!name) throw new Error("請填寫教材版面名稱。");
  const clientBoardId = cleanText_(payload.clientBoardId, 80);
  if (clientBoardId) {
    const existing = await findTableItemById_("boards", clientBoardId);
    if (existing) return boardCatalogResult_(existing);
  }
  const now = now_();
  const boardId = clientBoardId || makeId_("B");
  const board = {
    id: boardId,
    name: name,
    description: cleanText_(payload.description, MAX_TEXT.description),
    pdfFileId: "",
    pdfFileName: "",
    pdfMime: "",
    status: "啟用",
    createdAt: now,
    updatedAt: now
  };
  if (payload.pdf && payload.pdf.data) {
    const pdfName = safeFileName_(name + "_" + (payload.pdf.name || "講義.pdf"));
    const materialId = legacyMaterialId_(board.id);
    const file = await saveDriveFile_(Object.assign({}, payload.pdf, { name: pdfName }), "PDF教材", board.id, "", materialId);
    board.updatedAt = now_();
    board.pdfFileId = file.driveId;
    board.pdfFileName = file.name;
    board.pdfMime = file.mime;
    await appendRow_("materials", { id: materialId, boardId: board.id, name: payload.pdf.name || "主要教材", description: "", pdfFileId: file.driveId, pdfFileName: file.name, pdfMime: file.mime, order: 1, status: "啟用", createdAt: now, updatedAt: now });
  }
  await appendRow_("boards", board);
  await saveAreas_(board.id, payload.areas || []);
  await saveAnswerMasks_(board.id, payload.answerMasks || []);
  return boardCatalogResult_(board);
}

async function duplicateBoard_(payload) {
  await requireManager_(payload);
  const board = await getBoard_(payload.boardId, false);
  const now = now_();
  const newBoard = {
    id: makeId_("B"),
    name: cleanText_(board.name + "（副本）", MAX_TEXT.name),
    description: board.description || "",
    pdfFileId: board.pdfFileId || "",
    pdfFileName: board.pdfFileName || "",
    pdfMime: board.pdfMime || "",
    status: "啟用",
    createdAt: now,
    updatedAt: now
  };
  await appendRow_("boards", newBoard);
  const materials = await materialsForBoard_(board.id, board);
  const materialIdMap = {};
  for (let index = 0; index < materials.length; index += 1) {
    const material = materials[index];
    const newId = makeId_("M");
    materialIdMap[String(material.id)] = newId;
    await appendRow_("materials", { id: newId, boardId: newBoard.id, name: material.name || "教材 " + (index + 1), description: material.description || "", pdfFileId: material.pdfFileId || "", pdfFileName: material.pdfFileName || "", pdfMime: material.pdfMime || "application/pdf", order: material.order || index + 1, status: "啟用", createdAt: now, updatedAt: now });
  }
  if (!materials.length && (board.pdfFileId || newBoard.pdfFileId)) {
    const legacyId = legacyMaterialId_(newBoard.id);
    materialIdMap[legacyMaterialId_(board.id)] = legacyId;
    await appendRow_("materials", { id: legacyId, boardId: newBoard.id, name: board.pdfFileName || "主要教材", description: "既有單一 PDF 教材", pdfFileId: newBoard.pdfFileId, pdfFileName: newBoard.pdfFileName, pdfMime: newBoard.pdfMime || "application/pdf", order: 1, status: "啟用", createdAt: now, updatedAt: now });
  }
  const fallbackMaterialId = materials.length ? String(materials[0].id) : legacyMaterialId_(newBoard.id);
  const mapMaterialId = function (value) {
    const key = String(value || "");
    if (materialIdMap[key]) return materialIdMap[key];
    if (key.indexOf(legacyMaterialId_(board.id)) === 0) return legacyMaterialId_(newBoard.id);
    return materialIdMap[fallbackMaterialId] || legacyMaterialId_(newBoard.id);
  };
  const areas = await rowsForBoard_("areas", board.id);
  for (const area of areas) {
    await appendRow_("areas", {
      id: area.id,
      boardId: newBoard.id,
      materialId: mapMaterialId(area.materialId),
      page: area.page,
      x: area.x,
      y: area.y,
      width: area.width,
      height: area.height,
      title: area.title,
      prompt: area.prompt,
      order: area.order,
      status: "啟用",
      createdAt: now,
      updatedAt: now
    });
  }
  const masks = await rowsForBoard_("answerMasks", board.id);
  for (const mask of masks) {
    await appendRow_("answerMasks", {
      id: mask.id,
      boardId: newBoard.id,
      materialId: mapMaterialId(mask.materialId),
      page: mask.page,
      x: mask.x,
      y: mask.y,
      width: mask.width,
      height: mask.height,
      title: mask.title,
      order: mask.order,
      status: "啟用",
      createdAt: now,
      updatedAt: now
    });
  }
  clearSubmissionCountCache_(newBoard.id);
  return boardCatalogResult_(newBoard);
}

async function saveAreas_(boardId, areas) {
  const board = await getBoard_(boardId, true);
  const materialIds = new Set((await materialsForBoard_(board.id, board)).map(function (item) { return String(item.id); }));
  const incomingAreas = parseArray_(areas).slice(0, 80);
  const incomingIds = {};
  incomingAreas.forEach(function (area) { if (area && area.id) incomingIds[String(area.id)] = true; });
  const removedAreaIds = (await rowsForBoard_("areas", boardId))
    .filter(function (item) { return !incomingIds[String(item.id)]; })
    .map(function (item) { return item.id; });
  incomingAreas.forEach(function (area) {
    if (!materialIds.has(materialIdForItem_(board, area.materialId))) throw new Error("問答區所屬教材不存在。");
  });
  await removeSubmissionsForAreas_(boardId, removedAreaIds);
  await deleteRowsForBoard_("areas", boardId);
  const now = now_();
  incomingAreas.sort(compareAreasByPosition_);
  for (let index = 0; index < incomingAreas.length; index += 1) {
    const area = incomingAreas[index];
    const materialId = materialIdForItem_(board, area.materialId);
    if (!materialIds.has(materialId)) throw new Error("問答區所屬教材不存在。");
    const width = Math.max(0.01, Math.min(1, Number(area.width) || 0.2));
    const height = Math.max(0.01, Math.min(1, Number(area.height) || 0.12));
    const x = Math.max(0, Math.min(1 - width, Number(area.x) || 0));
    const y = Math.max(0, Math.min(1 - height, Number(area.y) || 0));
    await appendRow_("areas", {
      id: cleanText_(area.id, 80) || makeId_("Q"),
      boardId: boardId,
      materialId: materialId,
      page: Math.max(1, Number(area.page) || 1),
      x: x,
      y: y,
      width: width,
      height: height,
      title: cleanText_(area.title || "問答區 " + (index + 1), MAX_TEXT.title),
      prompt: cleanText_(area.prompt || "請輸入你的答案，或拍照上傳。", MAX_TEXT.prompt),
      order: index + 1,
      status: "啟用",
      createdAt: now,
      updatedAt: now
    });
  }
  clearSubmissionCountCache_(board.id);
  touchClassroomPulseCatalog_(board, await materialsForBoard_(board.id, board), incomingAreas, await answerMasksForBoard_(board.id, board));
}

async function updateBoard_(payload) {
  await requireManager_(payload);
  const board = await getBoard_(payload.boardId, true);
  const fields = { updatedAt: now_() };
  if (payload.name !== undefined) {
    fields.name = cleanText_(payload.name, MAX_TEXT.name);
    if (!fields.name) throw new Error("教材版面名稱不可為空白。");
  }
  if (payload.description !== undefined) fields.description = cleanText_(payload.description, MAX_TEXT.description);
  if (payload.pdf && payload.pdf.data) {
    const materialId = payload.materialId ? String(payload.materialId) : legacyMaterialId_(board.id);
    const material = await findMaterialForBoard_(board, materialId);
    if (!material && !isLegacyMaterialId_(board, materialId)) throw new Error("找不到指定課堂教材。");
    const pdfName = safeFileName_(((material && material.name) || fields.name || board.name || "教材") + "_" + (payload.pdf.name || "講義.pdf"));
    const file = await saveDriveFile_(Object.assign({}, payload.pdf, { name: pdfName }), "PDF教材", board.id, "", materialId);
    const materialRow = await findTableItemById_("materials", materialId);
    if (materialRow) {
      await updateRow_("materials", materialId, { pdfFileId: file.driveId, pdfFileName: file.name, pdfMime: file.mime, updatedAt: now_() });
    } else if (isLegacyMaterialId_(board, materialId)) {
      await appendRow_("materials", { id: materialId, boardId: board.id, name: payload.pdf.name || board.pdfFileName || "主要教材", description: "", pdfFileId: file.driveId, pdfFileName: file.name, pdfMime: file.mime, order: 1, status: "啟用", createdAt: board.createdAt || now_(), updatedAt: now_() });
    }
    if (isLegacyMaterialId_(board, materialId)) {
      fields.pdfFileId = file.driveId;
      fields.pdfFileName = file.name;
      fields.pdfMime = file.mime;
    }
  }
  await updateRow_("boards", board.id, fields);
  if (payload.areas !== undefined) await saveAreas_(board.id, payload.areas);
  if (payload.answerMasks !== undefined) await saveAnswerMasks_(board.id, payload.answerMasks);
  const updatedBoard = Object.assign({}, board, fields);
  const updatedMaterials = await materialsForBoard_(board.id, updatedBoard);
  const updatedAreas = await areasForBoard_(board.id, updatedBoard);
  const updatedAnswerMasks = await answerMasksForBoard_(board.id, updatedBoard);
  touchClassroomPulseCatalog_(updatedBoard, updatedMaterials, updatedAreas, updatedAnswerMasks);
  return { ok: true, board: await publicBoard_(updatedBoard), materials: updatedMaterials, areas: updatedAreas, answerMasks: updatedAnswerMasks };
}

async function createMaterial_(payload) {
  await requireManager_(payload);
  const board = await getBoard_(payload.boardId, false);
  const name = cleanText_(payload.name, MAX_TEXT.name);
  if (!name) throw new Error("請填寫教材名稱。");
  if (!payload.pdf || !payload.pdf.data) throw new Error("請選擇 PDF 教材。");
  await materializeLegacyMaterial_(board);
  const id = cleanText_(payload.id, 100) || makeId_("M");
  const existing = await findTableItemById_("materials", id);
  if (existing) {
    if (String(existing.boardId) !== String(board.id)) throw new Error("教材 ID 已存在。");
    return Object.assign({ ok: true, material: publicMaterial_(existing) }, await boardCatalogResult_(board));
  }
  const now = now_();
  const order = (await materialsForBoard_(board.id, board)).length + 1;
  const fileName = safeFileName_(name + "_" + (payload.pdf.name || "講義.pdf"));
  const file = await saveDriveFile_(Object.assign({}, payload.pdf, { name: fileName }), "PDF教材", board.id, "", id);
  const material = { id: id, boardId: board.id, name: name, description: cleanText_(payload.description, MAX_TEXT.description), pdfFileId: file.driveId, pdfFileName: file.name, pdfMime: file.mime, order: order, status: "啟用", createdAt: now, updatedAt: now };
  await appendRow_("materials", material);
  await updateRow_("boards", board.id, { updatedAt: now });
  const updatedBoard = Object.assign({}, board, { updatedAt: now });
  const updatedMaterials = await materialsForBoard_(board.id, updatedBoard);
  const updatedAreas = await areasForBoard_(board.id, updatedBoard);
  touchClassroomPulseCatalog_(updatedBoard, updatedMaterials, updatedAreas, await answerMasksForBoard_(board.id, updatedBoard));
  return { ok: true, material: publicMaterial_(material), board: await publicBoard_(updatedBoard), materials: updatedMaterials, areas: updatedAreas, answerMasks: await answerMasksForBoard_(board.id, updatedBoard) };
}

async function updateMaterial_(payload) {
  await requireManager_(payload);
  const board = await getBoard_(payload.boardId, true);
  const material = await materialForBoard_(board, payload.materialId);
  const materialId = material.id;
  const fields = { updatedAt: now_() };
  if (payload.name !== undefined) {
    fields.name = cleanText_(payload.name, MAX_TEXT.name);
    if (!fields.name) throw new Error("教材名稱不可為空白。");
  }
  if (payload.description !== undefined) fields.description = cleanText_(payload.description, MAX_TEXT.description);
  if (payload.pdf && payload.pdf.data) {
    const pdfName = safeFileName_((fields.name || material.name || board.name || "教材") + "_" + (payload.pdf.name || "講義.pdf"));
    const file = await saveDriveFile_(Object.assign({}, payload.pdf, { name: pdfName }), "PDF教材", board.id, "", materialId);
    fields.pdfFileId = file.driveId;
    fields.pdfFileName = file.name;
    fields.pdfMime = file.mime;
  }
  const row = await findTableItemById_("materials", materialId);
  if (!row) {
    if (!isLegacyMaterialId_(board, materialId)) throw new Error("找不到指定課堂教材。");
    const legacy = await materializeLegacyMaterial_(board);
    if (!legacy) throw new Error("找不到可更新的 PDF 教材。");
    await updateRow_("materials", materialId, Object.assign({}, fields, {
      name: fields.name || material.name,
      description: fields.description || material.description,
      pdfFileId: fields.pdfFileId || material.pdfFileId,
      pdfFileName: fields.pdfFileName || material.pdfFileName,
      pdfMime: fields.pdfMime || material.pdfMime
    }));
  } else {
    await updateRow_("materials", materialId, fields);
  }
  const boardFields = { updatedAt: fields.updatedAt };
  if (isLegacyMaterialId_(board, materialId)) {
    boardFields.pdfFileId = fields.pdfFileId || material.pdfFileId;
    boardFields.pdfFileName = fields.pdfFileName || material.pdfFileName;
    boardFields.pdfMime = fields.pdfMime || material.pdfMime;
  }
  await updateRow_("boards", board.id, boardFields);
  const updatedBoard = Object.assign({}, board, boardFields);
  const updatedMaterials = await materialsForBoard_(board.id, updatedBoard);
  const updatedAreas = await areasForBoard_(board.id, updatedBoard);
  const updatedAnswerMasks = await answerMasksForBoard_(board.id, updatedBoard);
  touchClassroomPulseCatalog_(updatedBoard, updatedMaterials, updatedAreas, updatedAnswerMasks);
  return { ok: true, material: publicMaterial_(Object.assign({}, material, fields)), board: await publicBoard_(updatedBoard), materials: updatedMaterials, areas: updatedAreas, answerMasks: updatedAnswerMasks };
}

async function deleteMaterial_(payload) {
  await requireManager_(payload);
  const board = await getBoard_(payload.boardId, true);
  await materializeLegacyMaterial_(board);
  const material = await materialForBoard_(board, payload.materialId);
  const materials = await materialsForBoard_(board.id, board);
  if (materials.length <= 1) throw new Error("至少要保留一份課堂教材。");
  const materialId = material.id;
  const areaIds = (await areasForBoard_(board.id, board)).filter(function (area) { return String(area.materialId) === materialId; }).map(function (area) { return area.id; });
  await removeSubmissionsForAreas_(board.id, areaIds, materialId);
  const driveIds = {};
  if (material.pdfFileId) driveIds[String(material.pdfFileId)] = true;
  (await rowsForBoard_("files", board.id)).forEach(function (file) { if (String(file.materialId || "") === materialId && file.driveId) driveIds[String(file.driveId)] = true; });
  const remainingDriveIds = {};
  (await readTable_("materials")).forEach(function (item) { if ((String(item.boardId) !== String(board.id) || String(item.id) !== materialId) && item.pdfFileId) remainingDriveIds[String(item.pdfFileId)] = true; });
  (await readTable_("boards")).forEach(function (item) { if (String(item.id) !== String(board.id) && item.pdfFileId) remainingDriveIds[String(item.pdfFileId)] = true; });
  await trashDriveFiles_(Object.keys(driveIds), remainingDriveIds);
  await deleteRows_("files", function (file) { return String(file.boardId) === String(board.id) && String(file.materialId || "") === materialId; });
  await deleteRowsForBoardMaterial_("ink", board.id, materialId);
  await deleteRowsForBoardMaterial_("areas", board.id, materialId);
  await deleteRowsForBoardMaterial_("answerMasks", board.id, materialId);
  await deleteRows_("materials", function (item) { return String(item.id) === materialId; });
  const remainingMaterials = materials.filter(function (item) { return String(item.id) !== materialId; });
  const replacement = remainingMaterials[0];
  const stateRow = await findClassroomStateRow_(board.id);
  if (stateRow && materialIdOf_(stateRow, board.id) === materialId && replacement) {
    const stateUpdatedAt = now_();
    const nextState = Object.assign({}, stateRow, { materialId: replacement.id, page: 1, zoom: 1, updatedAt: stateUpdatedAt });
    await updateRow_("classroomState", stateRow.id, { materialId: replacement.id, page: 1, zoom: 1, updatedAt: stateUpdatedAt });
    touchClassroomPulseState_(nextState, board.id);
  }
  const boardFields = { updatedAt: now_() };
  if (isLegacyMaterialId_(board, materialId) && replacement) {
    boardFields.pdfFileId = replacement.pdfFileId || "";
    boardFields.pdfFileName = replacement.pdfFileName || "";
    boardFields.pdfMime = replacement.pdfMime || "";
  }
  await updateRow_("boards", board.id, boardFields);
  const updatedBoard = Object.assign({}, board, boardFields);
  const updatedAreas = await areasForBoard_(board.id, updatedBoard);
  touchClassroomPulseCatalog_(updatedBoard, remainingMaterials, updatedAreas, await answerMasksForBoard_(board.id, updatedBoard));
  return { ok: true, materialId: materialId, materials: remainingMaterials, areas: updatedAreas, answerMasks: await answerMasksForBoard_(board.id, updatedBoard), board: await publicBoard_(updatedBoard) };
}

async function archiveBoard_(payload) {
  await requireManager_(payload);
  const board = await getBoard_(payload.boardId, true);
  await updateRow_("boards", board.id, { status: "封存", updatedAt: now_() });
  return { ok: true };
}

async function deleteBoard_(payload) {
  await requireManager_(payload);
  const boardId = cleanText_(payload.boardId, 80);
  if (!boardId) throw new Error("缺少教材版面 ID。");
  const board = await findTableItemById_("boards", boardId);
  const materials = await rowsForBoard_("materials", boardId);
  const submissions = await rowsForBoard_("submissions", boardId);
  const inkRows = await rowsForBoard_("ink", boardId);
  const files = (await rowsForBoard_("files", boardId)).concat((await readTable_("files")).filter(function (item) { return submissions.some(function (submission) { return String(submission.id) === String(item.submissionId); }); }));
  const driveIds = {};
  if (board && board.pdfFileId) driveIds[String(board.pdfFileId)] = true;
  materials.forEach(function (material) { if (material.pdfFileId) driveIds[String(material.pdfFileId)] = true; });
  files.forEach(function (file) { if (file.driveId) driveIds[String(file.driveId)] = true; });
  submissions.forEach(function (submission) { submissionDriveIds_(submission).forEach(function (driveId) { driveIds[driveId] = true; }); });
  inkRows.forEach(function (item) { const reference = String(item.strokes || ""); if (reference.indexOf("drive:") === 0) driveIds[reference.slice(6)] = true; });
  const remainingDriveIds = {};
  (await readTable_("boards")).forEach(function (item) { if (String(item.id) !== boardId && item.pdfFileId) remainingDriveIds[String(item.pdfFileId)] = true; });
  (await readTable_("files")).forEach(function (item) { if (String(item.boardId) !== boardId && item.driveId) remainingDriveIds[String(item.driveId)] = true; });
  (await readTable_("submissions")).forEach(function (submission) { if (String(submission.boardId) !== boardId) { submissionDriveIds_(submission).forEach(function (driveId) { remainingDriveIds[driveId] = true; }); } });
  const trashedDriveFiles = await trashDriveFiles_(Object.keys(driveIds), remainingDriveIds);
  const relatedSubmissionIds = {};
  submissions.forEach(function (submission) { relatedSubmissionIds[String(submission.id)] = true; });
  const deleted = {
    files: await deleteRows_("files", function (item) { return String(item.boardId) === boardId || relatedSubmissionIds[String(item.submissionId)]; }),
    submissions: await deleteRowsForBoard_("submissions", boardId),
    areas: await deleteRowsForBoard_("areas", boardId),
    answerMasks: await deleteRowsForBoard_("answerMasks", boardId),
    ink: await deleteRowsForBoard_("ink", boardId),
    classroomState: await deleteRowsForBoard_("classroomState", boardId),
    materials: await deleteRowsForBoard_("materials", boardId),
    boards: await deleteRows_("boards", function (item) { return String(item.id) === boardId; })
  };
  return { ok: true, boardId: boardId, deleted: deleted, trashedDriveFiles: trashedDriveFiles, trashedBoardFolder: false };
}

async function saveSubmission_(payload) {
  const board = await getBoard_(payload.boardId, false);
  const area = (await areasForBoard_(board.id, board)).find(function (item) { return String(item.id) === String(payload.areaId); });
  if (!area) throw new Error("找不到指定問答區。");
  const materialId = area.materialId || legacyMaterialId_(board.id);
  const nickname = cleanText_(payload.nickname, MAX_TEXT.nickname);
  if (!nickname) throw new Error("請先輸入暱稱。");
  const id = cleanText_(payload.id, 120) || makeId_("S");
  const existing = await findTableItemById_("submissions", id);
  const mutationId = cleanText_(payload.mutationId, 120);
  if (existing && mutationId && String(existing.mutationId || "") === mutationId) return { ok: true, submission: await publicSubmission_(existing, false, materialId) };
  const imageIds = parseArray_(payload.keepImageFileIds).slice(0, 2);
  const imageNames = parseArray_(payload.keepImageFileNames).slice(0, 2);
  const rawImages = parseArray_(payload.images);
  const remainingSlots = Math.max(0, 2 - imageIds.length);
  for (let index = 0; index < Math.min(remainingSlots, rawImages.length); index += 1) {
    const image = rawImages[index];
    const customName = nickname + "_" + (cleanText_(area.title, 30) || "問答") + "_第" + (imageIds.length + 1) + "張.jpg";
    const filePayload = Object.assign({}, image, { name: customName });
    const file = await saveDriveFile_(filePayload, "學生答案照片", board.id, id, materialId);
    imageIds.push(file.driveId);
    imageNames.push(file.name);
  }
  const now = now_();
  const item = {
    id: id,
    boardId: board.id,
    materialId: materialId,
    areaId: area.id,
    nickname: nickname,
    text: cleanText_(payload.text, MAX_TEXT.answer),
    imageFileIds: JSON.stringify(imageIds.slice(0, 2)),
    imageFileNames: JSON.stringify(imageNames.slice(0, 2)),
    teacherStrokes: existing ? existing.teacherStrokes : "",
    teacherComment: existing ? existing.teacherComment : "",
    status: existing ? existing.status : "待批改",
    clientId: cleanText_(payload.clientId, 100),
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
    mutationId: mutationId
  };
  if (!item.text && !imageIds.length) throw new Error("請輸入文字或上傳至少一張照片。");
  if (existing) await updateRow_("submissions", id, item);
  else await appendRow_("submissions", item);
  clearSubmissionCountCache_(board.id);
  return { ok: true, submission: await publicSubmission_(item, false, materialId) };
}

async function listSubmissions_(payload) {
  const board = await getBoard_(payload.boardId, false);
  const isTeacher = String(payload.role || "") === "teacher";
  if (isTeacher) await requireManager_(payload);
  const nickname = cleanText_(payload.nickname, MAX_TEXT.nickname);
  const materials = await materialsForBoard_(board.id, board);
  const materialId = payload.materialId ? String((materials.find(function (item) { return String(item.id) === String(payload.materialId); }) || {}).id || "") : "";
  if (payload.materialId && !materialId) return { ok: true, data: [], serverTime: now_() };
  const areaMap = {};
  (await areasForBoard_(board.id, board)).forEach(function (area) { areaMap[String(area.id)] = area; });
  const rows = (await rowsForBoard_("submissions", board.id)).filter(function (item) {
    if (materialId) {
      const itemMaterialId = String(item.materialId || (areaMap[String(item.areaId)] && areaMap[String(item.areaId)].materialId) || legacyMaterialId_(board.id));
      if (itemMaterialId !== materialId) return false;
    }
    return isTeacher || (nickname && String(item.nickname) === nickname);
  });
  rows.sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
  const data = [];
  for (const row of rows) {
    const fallbackMaterialId = (areaMap[String(row.areaId)] && areaMap[String(row.areaId)].materialId) || legacyMaterialId_(board.id);
    data.push(await publicSubmission_(row, isTeacher, fallbackMaterialId));
  }
  return { ok: true, data: data, serverTime: now_() };
}

async function saveFeedback_(payload) {
  await requireManager_(payload);
  const rows = await readTable_("submissions");
  const item = findItemById_(rows, payload.submissionId);
  if (!item) throw new Error("找不到指定作答紀錄。");
  const feedback = payload.strokes || { photoIndex: 0, strokes: [] };
  const comment = cleanText_(payload.comment, MAX_TEXT.comment);
  if (String(item.teacherComment || "") === comment && String(item.status || "") === "已批改" && JSON.stringify(await readJsonReference_(item.teacherStrokes)) === JSON.stringify(feedback)) {
    return { ok: true, submissionId: item.id, feedback: feedback, updatedAt: item.updatedAt };
  }
  const reference = await storeJson_(feedback, "教師批改筆跡", item.boardId, item.id, item.materialId || legacyMaterialId_(item.boardId));
  const updatedAt = now_();
  await updateRow_("submissions", item.id, {
    teacherStrokes: reference,
    teacherComment: comment,
    status: "已批改",
    updatedAt: updatedAt
  });
  return { ok: true, submissionId: item.id, feedback: feedback, updatedAt: updatedAt };
}

async function deleteSubmission_(payload) {
  await requireManager_(payload);
  const submissionId = cleanText_(payload.submissionId, 120);
  if (!submissionId) throw new Error("缺少作答紀錄 ID。");
  const rows = await readTable_("submissions");
  const item = findItemById_(rows, submissionId);
  if (!item) return { ok: true, submissionId: submissionId, deleted: 0 };

  const driveIds = submissionDriveIds_(item);
  (await rowsForBoard_("files", item.boardId)).forEach(function (file) {
    if (String(file.submissionId) === submissionId && file.driveId) driveIds.push(String(file.driveId));
  });

  const remainingSubmissions = rows.filter(function (row) { return String(row.id) !== submissionId; });
  const remainingDriveIds = {};
  remainingSubmissions.forEach(function (sub) {
    submissionDriveIds_(sub).forEach(function (dId) { remainingDriveIds[dId] = true; });
  });

  await trashDriveFiles_(driveIds, remainingDriveIds);

  await deleteRows_("files", function (file) {
    return String(item.boardId) === String(file.boardId) && String(file.submissionId) === submissionId;
  });

  const deleted = await deleteRows_("submissions", function (row) {
    return String(row.id) === submissionId;
  });

  clearSubmissionCountCache_(item.boardId);
  return { ok: true, submissionId: submissionId, boardId: item.boardId, areaId: item.areaId, deleted: deleted };
}

async function getFile_(payload) {
  const fileId = cleanText_(payload.fileId, 160);
  if (!fileId) throw new Error("缺少檔案 ID。");
  const index = (await readTable_("files")).find(function (item) { return String(item.driveId) === fileId; });
  if (!index) throw new Error("找不到檔案索引。");
  if (payload.boardId && String(index.boardId) !== String(payload.boardId)) throw new Error("檔案與版面不一致。");
  if (payload.materialId && materialIdOf_(index, index.boardId) !== String(payload.materialId)) throw new Error("檔案與教材不一致。");
  const object = await fileBucket_().get(fileId);
  if (!object) throw new Error("檔案索引存在，但 R2 中找不到實體。");
  const bytes = new Uint8Array(await object.arrayBuffer());
  return {
    ok: true,
    fileId: fileId,
    name: index.name,
    mime: object.httpMetadata && object.httpMetadata.contentType || index.mime || "application/octet-stream",
    size: bytes.length,
    base64: b64EncodeBytes_(bytes)
  };
}

async function settingsInfo_() {
  const settings = await loadSettings_();
  return {
    adminConfigured: Boolean(settings.AdminPassword),
    geminiConfigured: Boolean(settings.GeminiAPIKey),
    maxImageBytes: Number(settings.MaxImageBytes) || 2097152,
    maxPdfBytes: Number(settings.MaxPdfBytes) || 20971520,
    driveRootFolderName: settings.DriveRootFolderName || "PDF互動講義檔案"
  };
}

/* classroomSync_ 增量筆跡的同步版輔助：publicInkDelta_ 為 null 時退回完整筆跡。 */
async function publicInkRowOrDelta_(item, clientVersions) {
  const delta = await publicInkDelta_(item, clientVersions);
  if (delta) return delta;
  return publicInk_(item);
}

/* 【第 4 區 API ROUTER】doGet／doPost 與冪等判斷。action 名稱與回傳 JSON 為對外契約。 */

function withLock_(callback) {
  return callback();
}

function isIdempotentAction_(action) {
  return ["createBoard", "updateBoard", "archiveBoard", "deleteBoard", "createMaterial", "updateMaterial", "deleteMaterial", "createAnnouncement", "updateAnnouncement", "reorderAnnouncements", "deleteAnnouncement", "saveInk", "saveClassroomState", "saveSubmission", "deleteSubmission", "saveFeedback"].indexOf(String(action || "")) > -1;
}

async function canReadMutationResult_(action, payload) {
  const protectedActions = ["createBoard", "updateBoard", "archiveBoard", "deleteBoard", "createMaterial", "updateMaterial", "deleteMaterial", "createAnnouncement", "updateAnnouncement", "reorderAnnouncements", "deleteAnnouncement", "saveInk", "saveClassroomState", "deleteSubmission", "saveFeedback"];
  if (protectedActions.indexOf(String(action || "")) < 0) return true;
  return isAdminToken_(payload && payload.adminToken);
}

async function doGet(e) {
  try {
    await ensureDatabase_();
    const parameter = e && e.parameter ? e.parameter : {};
    const action = String(parameter.action || "ping");
    if (action === "settings") return { ok: true, settings: await settingsInfo_() };
    if (action === "listAnnouncements") return await listAnnouncements_(parameter);
    if (action === "listPublicBoards") return await listPublicBoards_();
    if (action === "listBoards") return await listBoards_(parameter);
    if (action === "getBoard") return await getBoardData_(parameter);
    if (action === "classroomPulse") return await classroomPulse_(parameter);
    if (action === "classroomSync") return await classroomSync_(parameter);
    if (action === "getFile") return await getFile_(parameter);
    if (action === "listSubmissions") return await listSubmissions_(parameter);
    if (action === "sheetUrl") return { ok: true, url: "" };
    if (action === "ping") return { ok: true, message: "PDF 互動講義 API 已啟動。", apiVersion: API_VERSION, serverTime: now_() };
    throw new Error("未知的 API 動作：「" + action + "」。");
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

async function doPost(e) {
  try {
    await ensureDatabase_();
    const payload = parsePayload_(e);
    const action = String((e && e.parameter && e.parameter.action) || payload.action || "");
    const process = async function () {
      if (isIdempotentAction_(action) && (await canReadMutationResult_(action, payload))) {
        const cachedResult = await readMutationResult_(action, payload);
        if (cachedResult) return cachedResult;
      }
      let result;
      if (action === "verifyAdmin") result = await verifyAdmin_(payload);
      else if (action === "updateSettings") result = await updateSettings_(payload);
      else if (action === "logoutAdmin") result = await revokeAdminToken_(payload);
      else if (action === "listAnnouncements") result = await listAnnouncements_(payload);
      else if (action === "listPublicBoards") result = await listPublicBoards_();
      else if (action === "createAnnouncement") result = await createAnnouncement_(payload);
      else if (action === "updateAnnouncement") result = await updateAnnouncement_(payload);
      else if (action === "reorderAnnouncements") result = await reorderAnnouncements_(payload);
      else if (action === "deleteAnnouncement") result = await deleteAnnouncement_(payload);
      else if (action === "listBoards") result = await listBoards_(payload);
      else if (action === "getBoard") result = await getBoardData_(payload);
      else if (action === "createBoard") result = await createBoard_(payload);
      else if (action === "duplicateBoard") result = await duplicateBoard_(payload);
      else if (action === "updateBoard") result = await updateBoard_(payload);
      else if (action === "archiveBoard") result = await archiveBoard_(payload);
      else if (action === "deleteBoard") result = await deleteBoard_(payload);
      else if (action === "createMaterial") result = await createMaterial_(payload);
      else if (action === "updateMaterial") result = await updateMaterial_(payload);
      else if (action === "deleteMaterial") result = await deleteMaterial_(payload);
      else if (action === "listInk") result = await listInk_(payload);
      else if (action === "saveInk") result = await saveInk_(payload);
      else if (action === "classroomPulse") result = await classroomPulse_(payload);
      else if (action === "classroomSync") result = await classroomSync_(payload);
      else if (action === "saveClassroomState") result = await saveClassroomState_(payload);
      else if (action === "saveSubmission") result = await saveSubmission_(payload);
      else if (action === "deleteSubmission") result = await deleteSubmission_(payload);
      else if (action === "listSubmissions") result = await listSubmissions_(payload);
      else if (action === "saveFeedback") result = await saveFeedback_(payload);
      else if (action === "getFile") result = await getFile_(payload);
      else if (action === "sheetUrl") {
        await requireManager_(payload);
        result = { ok: true, url: "" };
      } else {
        throw new Error("未知的 API 動作：「" + action + "」。");
      }
      if (isIdempotentAction_(action)) await cacheMutationResult_(action, payload, result);
      return result;
    };
    const result = await process();
    return result;
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

/* ClassroomSync_ 的 ink 路徑使用 await Promise.all 前述分支；此 helper 提供正式定義。 */

/* 【第 5 區 HTTP 入口】fetch 入口：CORS、GET／POST 分流與檔案串流。 */

function corsHeaders_() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS,
    "Access-Control-Max-Age": "86400"
  };
}

function jsonResponse_(payload) {
  return new Response(jsonOut_(payload), {
    status: payload && payload.ok === false ? 200 : 200,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, corsHeaders_())
  });
}

async function getFileStreamMeta_(payload) {
  const fileId = cleanText_(payload.fileId, 160);
  if (!fileId) throw new Error("缺少檔案 ID。");
  const index = (await readTable_("files")).find(function (item) { return String(item.driveId) === fileId; });
  if (!index) throw new Error("找不到檔案索引。");
  if (payload.boardId && String(index.boardId) !== String(payload.boardId)) throw new Error("檔案與版面不一致。");
  if (payload.materialId && materialIdOf_(index, index.boardId) !== String(payload.materialId)) throw new Error("檔案與教材不一致。");
  return {
    key: fileId,
    name: index.name,
    mime: index.mime || "application/octet-stream",
    size: Number(index.size) || 0
  };
}

function parseRangeHeader_(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return null;
  const start = match[1] === "" ? null : Number(match[1]);
  const end = match[2] === "" ? null : Number(match[2]);
  if (size && Number.isFinite(start) && start >= size) return null;
  if (Number.isFinite(start) && Number.isFinite(end)) return { offset: start, length: Math.max(1, end - start + 1) };
  if (Number.isFinite(start)) return { offset: start, length: size ? Math.max(1, size - start) : undefined };
  if (Number.isFinite(end)) return { offset: size ? Math.max(0, size - end) : 0, length: size ? Math.max(1, size - Math.max(0, size - end)) : undefined };
  return null;
}

async function handleGetFileStream_(applyBindings, request, params) {
  applyBindings();
  const meta = await getFileStreamMeta_(params);
  const range = parseRangeHeader_(request.headers.get("range"), meta.size);
  const object = await fileBucket_().get(meta.key, range ? { range: range } : undefined);
  if (!object) throw new Error("檔案索引存在，但 R2 中找不到實體。");
  const headers = Object.assign({
    "Content-Type": meta.mime,
    "Content-Disposition": "inline; filename*=UTF-8''" + encodeURIComponent(meta.name),
    "ETag": '"' + meta.key + '"',
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=86400"
  }, corsHeaders_());
  if (range) {
    const sliceSize = range.length !== undefined ? range.length : undefined;
    if (sliceSize !== undefined) headers["Content-Length"] = String(sliceSize);
    headers["Content-Range"] = "bytes " + range.offset + "-" + (range.length !== undefined ? range.offset + range.length - 1 : Math.max(0, (object.size || meta.size) - 1)) + "/" + (object.size || meta.size);
    return new Response(object.body, { status: 206, headers: headers });
  }
  return new Response(object.body, { status: 200, headers: headers });
}

async function readPostEvent_(request) {
  const contentType = String(request.headers.get("content-type") || "");
  let event = { parameter: {} };
  if (contentType.indexOf("application/json") === 0) {
    const raw = await request.text();
    event = { parameter: {}, postData: { contents: raw } };
    return event;
  }
  try {
    const formData = await request.formData();
    const parameter = {};
    formData.forEach(function (value, key) { parameter[key] = value; });
    event = { parameter: parameter };
    return event;
  } catch (error) {
    const raw = await request.text();
    return { parameter: {}, postData: { contents: raw } };
  }
}

/* __EXPORT_START__ */
export default {
  async fetch(request, env, ctx) {
    setRuntimeBindings_(env);
    const applyBindings = function () { setRuntimeBindings_(env); };
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders_() });
      }
      const url = new URL(request.url);
      const params = {};
      url.searchParams.forEach(function (value, key) { params[key] = value; });
      if (request.method === "GET") {
        const action = String(params.action || "ping");
        if (action === "getFile" && String(params.stream || "") === "1") {
          return await handleGetFileStream_(applyBindings, request, params);
        }
        const result = await doGet({ parameter: params });
        return jsonResponse_(result);
      }
      if (request.method === "POST") {
        const event = await readPostEvent_(request);
        let action = String((event.parameter && event.parameter.action) || "");
        if (!action) {
          try { action = String(JSON.parse(event.postData && event.postData.contents || "{}").action || ""); } catch (e) { action = ""; }
        }
        if (action === "getFile" && String((event.parameter && event.parameter.stream) || "") === "1") {
          return await handleGetFileStream_(applyBindings, request, event.parameter);
        }
        const result = await doPost(event);
        return jsonResponse_(result);
      }
      return jsonResponse_({ ok: false, error: "僅支援 GET 與 POST。", method: request.method });
    } catch (error) {
      return jsonResponse_({ ok: false, error: String(error.message || error) });
    }
  }
};
/* __EXPORT_END__ */
