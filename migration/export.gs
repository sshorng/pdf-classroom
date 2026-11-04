/**
 * PDF 互動講義批改系統，遷移匯出腳本。
 *
 * 使用方式：
 * 1. 將本檔內容貼到與 Code.gs 相同的 Apps Script 專案（新增指令碼檔案）。
 * 2. 執行 migrateExportData 產生全量 JSON。
 * 3. 重複執行 migrateExportFiles，每批產生一個檔案 zip（<= 30MB），回覆「無剩餘檔案」即全部完成。
 * 4. 從雲端硬碟的「migration-匯出」資料夾把 JSON 與全部 zip 下載或同步到本機，
 *    交給 migration/migrate.js 做資料入庫與 MD5 對帳。
 *
 * 表格資料直接呼叫 Code.gs 的全域 readTable_，匯出格式與後端原始碼所見完全一致。
 */

var MIGRATION_EXPORT_FOLDER_NAME = "migration-匯出";
var MIGRATION_FILE_CHUNK_BYTES = 30 * 1024 * 1024;

function migrateExportFolder_() {
  return getOrCreateFolder_(MIGRATION_EXPORT_FOLDER_NAME, getOrCreateRootFolder_());
}

/* 掃描表格內的所有 Drive 引用（ink 筆跡、批改筆跡、作答照片），確保實體檔案清單不漏件。 */
function migrateReferencedDriveIds_() {
  var referenced = {};
  readTable_("ink").forEach(function (row) {
    var value = String(row.strokes || "");
    if (value.indexOf("drive:") === 0) {
      var id = value.slice(6).trim();
      if (id) referenced[id] = true;
    }
  });
  readTable_("submissions").forEach(function (row) {
    var strokes = String(row.teacherStrokes || "").trim();
    if (strokes.indexOf("drive:") === 0) {
      var id = strokes.slice(6).trim();
      if (id) referenced[id] = true;
    }
    parseArray_(row.imageFileIds).forEach(function (id) {
      if (id) referenced[String(id)] = true;
    });
  });
  return Object.keys(referenced);
}

/* MD5 對帳基準：與 migrate.js 的 crypto MD5 同為標準 MD5，base64 形式互比。 */
function migrateFileMd5_(file) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, file.getBlob().getBytes());
  return Utilities.base64Encode(digest);
}

/* 匯出清單：先以 files 表為準，再補上有引用但目前不存在的遺失 driveId。 */
function migrateManifestRows_() {
  var indexed = {};
  var manifest = [];
  readTable_("files").forEach(function (row) {
    var driveId = String(row.driveId || "").trim();
    if (!driveId || indexed[driveId]) return;
    indexed[driveId] = true;
    manifest.push({ id: driveId, name: String(row.name || ""), mime: String(row.mime || ""), source: "files" });
  });
  migrateReferencedDriveIds_().forEach(function (driveId) {
    if (indexed[driveId]) return;
    indexed[driveId] = true;
    manifest.push({ id: driveId, name: "", mime: "", source: "reference" });
  });
  manifest.forEach(function (entry) {
    try {
      var file = DriveApp.getFileById(entry.id);
      entry.name = safeFileName_(file.getName()) || entry.name;
      entry.mime = file.getMimeType();
      entry.size = file.getSize();
      entry.md5 = migrateFileMd5_(file);
    } catch (error) {
      entry.error = String(error && error.message || error);
    }
  });
  return manifest;
}

/* 第一步：全量表格資料與檔案清單寫成單一 JSON。 */
function migrateExportData() {
  resetRequestCache_();
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd-HHmm");
  var spreadsheet = getSpreadsheet_();
  var payload = {
    format: "pdfw-migration-v1",
    exportedAt: now_(),
    spreadsheet: { id: spreadsheet.getId(), url: spreadsheet.getUrl() },
    rootFolder: (function () {
      var folder = getOrCreateRootFolder_();
      return { name: folder.getName(), url: folder.getUrl() };
    })(),
    tables: {},
    files: migrateManifestRows_()
  };
  Object.keys(TABLES).forEach(function (key) { payload.tables[key] = readTable_(key); });
  var blob = Utilities.newBlob(JSON.stringify(payload, null, 2), "application/json", "migration-全量資料-" + stamp + ".json");
  var file = migrateExportFolder_().createFile(blob);
  return "全量 JSON 已匯出：" + file.getUrl() + "（資料表 " + Object.keys(payload.tables).length + " 張、實體檔案 " + payload.files.length + " 個）。接著重複執行 migrateExportFiles 產生檔案包。";
}

/* 第二步：每次執行打包一批檔案（<= 30MB），以 ScriptProperties 游標續跑，直到無剩餘檔案。 */
function migrateExportFiles() {
  resetRequestCache_();
  var properties = PropertiesService.getScriptProperties();
  var cursor = Number(properties.getProperty("MIGRATE_FILES_CURSOR")) || 0;
  var manifest = migrateManifestRows_();
  var pending = [];
  var bytes = 0;
  var index = cursor;
  while (index < manifest.length && bytes < MIGRATION_FILE_CHUNK_BYTES) {
    var entry = manifest[index];
    try {
      DriveApp.getFileById(entry.id).getBlob().getBytes();
    } catch (error) {
      // 缺件不入包，由 migrate.js 對帳時回報缺件清單。
      index += 1;
      continue;
    }
    pending.push(entry);
    bytes += Number(entry.size) || 0;
    index += 1;
  }
  if (!pending.length) {
    properties.setProperty("MIGRATE_FILES_CURSOR", String(manifest.length));
    return "無剩餘檔案，檔案包匯出全部完成。";
  }
  var blobs = [Utilities.newBlob(JSON.stringify({ format: "pdfw-migration-chunk-v1", files: pending }, null, 2), "application/json", "_migrate_manifest.json")];
  pending.forEach(function (item) {
    blobs.push(Utilities.newBlob(DriveApp.getFileById(item.id).getBlob().getBytes(), item.mime || "application/octet-stream", item.id));
  });
  var zip = Utilities.zip(blobs, "migration-檔案包-" + cursor + ".zip");
  var file = migrateExportFolder_().createFile(zip);
  properties.setProperty("MIGRATE_FILES_CURSOR", String(index));
  return "檔案包已匯出：" + file.getName() + "（" + pending.length + " 個檔案）。繼續執行 migrateExportFiles 直到回覆「無剩餘檔案」。";
}
