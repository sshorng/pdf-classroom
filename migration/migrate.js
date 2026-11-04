#!/usr/bin/env node
/**
 * PDF 互動講義批改系統，遷移腳本：把 GAS 匯出的全量 JSON 與檔案包，
 * 轉成 D1 種子 SQL 與 R2 上傳指令檔，並可用 --simulate 在本機做全量模擬驗證。
 *
 * 用法：
 *   node migration/migrate.js --export-dir <資料夾> [--simulate]
 *
 * <資料夾> 內容（migration/export.gs 的產物）：
 *   - migration-全量資料-*.json：全部表格資料與檔案清單。
 *   - migration-檔案包-*.zip：實體檔案包（可無；有引用檔案時必須提供）。
 *
 * 模擬驗證（--simulate）以 node:sqlite 套 schema.sql 與種子 SQL，
 * 以本機 bytes 模擬 R2，透過 worker.js 自身的 readTable_ 逐表逐欄比對匯出原文，
 * 再以 getFile_ 抽驗每個有現檔 bytes 的檔案 MD5。
 *
 * 雲端操作（需夫子 Cloudflare 帳號）：
 *   npx wrangler d1 execute pdf-workbook-db --remote --file=migration/output/d1-seed.sql
 *   powershell -NoProfile -File migration/output/r2-upload.ps1
 *   powershell -NoProfile -File migration/output/r2-verify.ps1
 */

var fs = require("fs");
var path = require("path");
var os = require("os");
var crypto = require("crypto");
var vm = require("vm");
var { execFileSync } = require("child_process");

var projectDir = path.join(__dirname, "..");
var scratchDir = fs.realpathSync(os.tmpdir());
var OUTPUT_REL = path.join("migration", "output");

/* ============ 欄位映射真相：解析 worker.js 的 TABLES 與 schema.sql 欄位型別 ============ */

function parseWorkerTableMap() {
  var source = fs.readFileSync(path.join(projectDir, "worker.js"), "utf8");
  var start = source.indexOf("const TABLES = {");
  if (start < 0) throw new Error("worker.js 內找不到 TABLES 定義。");
  var end = source.indexOf("\n};", start);
  var block = source.slice(start, end);
  /* 每個表格項目都以「兩格縮排的鍵名」開頭，且第一行為 name 欄位。 */
  var entryRegex = /\n  ([A-Za-z]+): \{\n    name: "/g;
  var positions = [];
  var match;
  while ((match = entryRegex.exec(block)) !== null) positions.push({ name: match[1], offset: match.index });
  if (!positions.length) throw new Error("worker.js TABLES 解析失敗：找不到任何表格項目。");
  positions.push({ name: null, offset: block.length });
  var map = {};
  for (var index = 0; index < positions.length - 1; index += 1) {
    var slice = block.slice(positions[index].offset, positions[index + 1].offset);
    var keysMatch = /\n    keys: \[([^\]]+)\]/.exec(slice);
    var columnsMatch = /\n    columns: \{([^}]+)\}/.exec(slice);
    if (!keysMatch || !columnsMatch) throw new Error("worker.js TABLES 解析失敗：" + positions[index].name);
    var keys = keysMatch[1].match(/"([^"]+)"/g).map(function (value) { return value.slice(1, -1); });
    var columns = {};
    var pairs = columnsMatch[1].match(/([A-Za-z]+): "([^"]+)"/g) || [];
    pairs.forEach(function (pair) {
      var parts = /([A-Za-z]+): "([^"]+)"/.exec(pair);
      if (keys.indexOf(parts[1]) >= 0) columns[parts[1]] = parts[2];
    });
    keys.forEach(function (field) { if (!columns[field]) throw new Error("worker.js TABLES 缺少欄位映射：" + positions[index].name + "." + field); });
    map[positions[index].name] = { keys: keys, columns: columns };
  }
  return map;
}

/* schema.sql 欄位型別：INTEGER／REAL 為數值欄，比對時以數值對數值；其餘以字串對字串。 */
function parseSchemaTypes() {
  var sql = fs.readFileSync(path.join(projectDir, "schema.sql"), "utf8");
  var types = {};
  var tableRegex = /CREATE TABLE IF NOT EXISTS ([A-Za-z]+) \(([\s\S]*?)\);/g;
  var match;
  while ((match = tableRegex.exec(sql)) !== null) {
    var name = match[1];
    types[name] = {};
    match[2].split("\n").forEach(function (line) {
      var columnMatch = /^\s*([A-Za-z]+) (TEXT|INTEGER|REAL)/.exec(line);
      if (columnMatch) types[name][columnMatch[1]] = columnMatch[2];
    });
  }
  return types;
}

function isNumericType(type) { return type === "INTEGER" || type === "REAL"; }

/* ============ 匯出資料夾：找檔、解壓、MD5 ============ */

function findFiles(dir, prefix, suffix) {
  return fs.readdirSync(dir).filter(function (name) {
    return name.indexOf(prefix) === 0 && (suffix === "" ? true : name.slice(-suffix.length) === suffix);
  }).sort();
}

function md5Base64(bytes) { return crypto.createHash("md5").update(bytes).digest("base64"); }
function md5Hex(bytes) { return crypto.createHash("md5").update(bytes).digest("hex"); }

/* 解壓全部檔案包到暫存區，回傳以檔名（即 driveId）為鍵的 bytes。 */
function expandZipEntries(exportDir) {
  var zips = findFiles(exportDir, "migration-檔案包-", ".zip");
  if (!zips.length) return { entries: null, expandedDir: null };
  var target = path.join(scratchDir, "pdfw-migration-expanded-" + Date.now());
  fs.mkdirSync(target, { recursive: true });
  zips.forEach(function (zipName) {
    var destination = path.join(target, zipName.replace(/\.zip$/, ""));
    try {
      execFileSync("powershell", [
        "-NoProfile", "-Command",
        "Expand-Archive -LiteralPath '" + path.join(exportDir, zipName) + "' -DestinationPath '" + destination + "' -Force"
      ], { stdio: "pipe" });
    } catch (expandError) {
      throw new Error("檔案包解壓失敗：" + zipName + "：" + String(expandError && (expandError.stderr || expandError.message)));
    }
  });
  var entries = {};
  findFiles(target, "", "").forEach(function (dirName) {
    var dirPath = path.join(target, dirName);
    if (!fs.statSync(dirPath).isDirectory()) { entries[dirName] = fs.readFileSync(dirPath); return; }
    fs.readdirSync(dirPath).forEach(function (name) {
      if (name === "_migrate_manifest.json") return;
      var filePath = path.join(dirPath, name);
      if (fs.statSync(filePath).isFile()) entries[name] = fs.readFileSync(filePath);
    });
  });
  return { entries: entries, expandedDir: target };
}

/* ============ 資料規範化與種子 SQL 產生 ============ */

function sqlQuote(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }

function normalizeValue(field, column, type, value) {
  if (value === undefined || value === null) return isNumericType(type) ? 0 : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") value = JSON.stringify(value);
  if (isNumericType(type)) { var numeric = Number(value); return Number.isFinite(numeric) ? numeric : 0; }
  return String(value);
}

function normalizeTables(tableMap, schemaTypes, exportTables) {
  var normalized = {};
  Object.keys(tableMap).forEach(function (tableKey) {
    var table = tableMap[tableKey];
    var types = schemaTypes[tableKey] || {};
    var incoming = exportTables[tableKey] || [];
    normalized[tableKey] = incoming.map(function (row) {
      var output = {};
      table.keys.forEach(function (field) {
        output[field] = normalizeValue(field, table.columns[field], types[table.columns[field]], row[field]);
      });
      return output;
    });
  });
  return normalized;
}

function buildSeedSql(tableMap, schemaTypes, rows) {
  var lines = [
    "-- PDF 互動講義批改系統，遷移種子資料（由 migration/migrate.js 產生，勿手改）。",
    "-- 執行：npx wrangler d1 execute pdf-workbook-db --remote --file=migration/output/d1-seed.sql",
    ""
  ];
  Object.keys(tableMap).forEach(function (tableKey) {
    var table = tableMap[tableKey];
    var types = schemaTypes[tableKey] || {};
    var incoming = rows[tableKey];
    if (!incoming.length) { lines.push("-- " + tableKey + "：0 筆，略過。"); lines.push(""); return; }
    lines.push("-- " + tableKey + "：" + incoming.length + " 筆。");
    var columns = table.keys.map(function (field) { return table.columns[field]; });
    incoming.forEach(function (row) {
      var values = table.keys.map(function (field) {
        var value = row[field];
        return isNumericType(types[table.columns[field]]) ? String(Number(value)) : sqlQuote(value);
      });
      lines.push("INSERT OR REPLACE INTO " + tableKey + " (" + columns.join(", ") + ") VALUES (" + values.join(", ") + ");");
    });
    lines.push("");
  });
  return lines.join("\n");
}

/* ============ worker 模擬環境（手法與 tests/worker-smoke.js 相同） ============ */

function buildWorkerContext(d1, files) {
  var rawSource = fs.readFileSync(path.join(projectDir, "worker.js"), "utf8");
  var source = rawSource.split("/* __EXPORT_START__ */")[0];
  var context = {
    require: require, TextEncoder: TextEncoder, TextDecoder: TextDecoder, URL: URL,
    URLSearchParams: URLSearchParams, FormData: FormData, fetch: fetch,
    Request: Request, Response: Response, Headers: Headers, atob: atob, btoa: btoa,
    console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
    CacheService: { getScriptCache: function () { return { get: function () { return null; }, put: function () {}, remove: function () {} }; } },
    PropertiesService: { getScriptProperties: function () { return { getProperty: function () { return null; }, setProperty: function () {}, deleteProperty: function () {} }; } },
    __d1: d1, __files: files
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "worker.js" });
  vm.runInContext("RUNTIME.DB = __d1; RUNTIME.FILES = __files;", context, { filename: "migrate-bind.js" });
  return context;
}

function makeD1(sqlite) {
  return {
    prepare: function (sql) {
      var stmt = sqlite.prepare(sql);
      return {
        all: function () { return Promise.resolve({ results: stmt.all() }); },
        run: function () { stmt.run(); return Promise.resolve({}); },
        bind: function () {
          var bindings = Array.prototype.slice.call(arguments);
          return {
            all: function () { return Promise.resolve({ results: bindings.length ? stmt.all.apply(stmt, bindings) : stmt.all() }); },
            run: function () { if (bindings.length) stmt.run.apply(stmt, bindings); else stmt.run(); return Promise.resolve({}); }
          };
        }
      };
    },
    batch: function (statements) {
      statements.forEach(function (statement) { return statement.run(); });
      return Promise.resolve([]);
    }
  };
}

function FakeR2() {
  this.map = new Map();
}
FakeR2.prototype.put = function (key, bytes, contentType) {
  this.map.set(String(key), { bytes: bytes, contentType: contentType || "application/octet-stream" });
  return Promise.resolve({ key: String(key) });
};
FakeR2.prototype.get = function (key) {
  var entry = this.map.get(String(key));
  if (!entry) return Promise.resolve(null);
  var bytes = entry.bytes;
  /* Buffer 的小物件可能共用底層 pool，.buffer 會遠大於本筆長度；只回傳本筆範圍的 ArrayBuffer。 */
  return Promise.resolve({
    size: bytes.length,
    body: bytes,
    httpMetadata: { contentType: entry.contentType },
    arrayBuffer: function () { return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); }
  });
};
FakeR2.prototype.delete = function (key) { this.map.delete(String(key)); return Promise.resolve(); };

/* ============ R2 指令檔產生 ============ */

function writeR2Scripts(outputDir, bucketEntries, manifestById) {
  var objectsDir = path.join(outputDir, "r2-objects");
  fs.mkdirSync(objectsDir, { recursive: true });
  var manifestRows = [];
  Object.keys(bucketEntries).sort().forEach(function (driveId) {
    var entry = bucketEntries[driveId];
    fs.writeFileSync(path.join(objectsDir, driveId), entry.bytes);
    manifestRows.push({ driveId: driveId, md5: md5Hex(entry.bytes), size: String(entry.bytes.length), mime: entry.contentType || "" });
  });
  var csvLines = ["driveId,md5,size,mime"].concat(manifestRows.map(function (row) {
    return [row.driveId, row.md5, row.size, '"' + String(row.mime).replace(/"/g, '""') + '"'].join(",");
  }));
  fs.writeFileSync(path.join(outputDir, "r2-manifest.csv"), csvLines.join("\n") + "\n", "utf8");

  var upload = [
    "# PDF 互動講義批改系統，R2 上傳指令（由 migration/migrate.js 產生，勿手改）。",
    "# 前置：npx wrangler login，並確認 wrangler.toml 的 bucket 名稱為 pdf-workbook-files。",
    "# 執行：powershell -NoProfile -File migration/output/r2-upload.ps1",
    "$ErrorActionPreference = 'Stop'",
    "$objectsDir = Join-Path $PSScriptRoot 'r2-objects'",
    "$rows = Import-Csv (Join-Path $PSScriptRoot 'r2-manifest.csv')",
    "$done = 0",
    "foreach ($row in $rows) {",
    "  npx wrangler r2 object put \"pdf-workbook-files/$($row.driveId)\" --file=\"$(Join-Path $objectsDir $row.driveId)\" --content-type=\"$($row.mime)\"",
    "  $done += 1",
    "}",
    "Write-Host \"R2 上傳完成，共 $done 個物件。\""
  ].join("\n");
  var verify = [
    "# PDF 互動講義批改系統，R2 對帳指令（由 migration/migrate.js 產生，勿手改）。",
    "# 執行：powershell -NoProfile -File migration/output/r2-verify.ps1",
    "$ErrorActionPreference = 'Stop'",
    "$temp = Join-Path $env:TEMP 'pdfw-r2-verify'",
    "New-Item -ItemType Directory -Force -Path $temp | Out-Null",
    "Remove-Item (Join-Path $temp '*') -Force -ErrorAction SilentlyContinue",
    "$rows = Import-Csv (Join-Path $PSScriptRoot 'r2-manifest.csv')",
    "$failures = 0",
    "foreach ($row in $rows) {",
    "  $local = Join-Path $temp $row.driveId",
    "  npx wrangler r2 object get \"pdf-workbook-files/$($row.driveId)\" --file=\"$local\"",
    "  $hash = (Get-FileHash -Algorithm MD5 -LiteralPath $local).Hash.ToLower()",
    "  $size = (Get-Item -LiteralPath $local).Length",
    "  if ($hash -ne $row.md5 -or $size -ne [int64]$row.size) { Write-Host \"MD5 或大小不一致：$($row.driveId)\"; $failures += 1 }",
    "  Remove-Item -LiteralPath $local -Force",
    "}",
    "if ($failures -gt 0) { Write-Host \"R2 對帳失敗，共 $failures 個物件不一致。\"; exit 1 }",
    "Write-Host \"R2 對帳完成，$($rows.Count) 個物件全數一致。\""
  ].join("\n");
  fs.writeFileSync(path.join(outputDir, "r2-upload.ps1"), upload + "\n", "utf8");
  fs.writeFileSync(path.join(outputDir, "r2-verify.ps1"), verify + "\n", "utf8");
  return manifestRows.length;
}

/* ============ 主流程 ============ */

function main() {
  var args = process.argv.slice(2);
  var readFlag = function (name) { var index = args.indexOf("--" + name); return index >= 0 && args[index + 1] ? args[index + 1] : null; };
  var hasFlag = function (name) { return args.indexOf("--" + name) >= 0; };
  var exportDir = readFlag("export-dir");
  if (!exportDir || !fs.existsSync(exportDir)) {
    console.error("用法：node migration/migrate.js --export-dir <資料夾> [--simulate]");
    process.exit(2);
  }
  var simulate = hasFlag("simulate");
  var outputDir = path.join(projectDir, OUTPUT_REL);
  fs.mkdirSync(outputDir, { recursive: true });

  var jsonFiles = findFiles(exportDir, "migration-全量資料-", ".json");
  if (!jsonFiles.length) throw new Error("資料夾內找不到 migration-全量資料-*.json（export.gs 第一步的產物）。");
  var exportData = JSON.parse(fs.readFileSync(path.join(exportDir, jsonFiles[jsonFiles.length - 1]), "utf8"));
  if (exportData.format !== "pdfw-migration-v1") throw new Error("匯出 JSON 格式不是 pdfw-migration-v1，請確認 export.gs 版本。");

  var tableMap = parseWorkerTableMap();
  var schemaTypes = parseSchemaTypes();
  var manifest = exportData.files || [];
  var manifestById = {};
  manifest.forEach(function (entry) { manifestById[String(entry.id)] = entry; });

  var result = {
    format: "pdfw-migration-summary-v1",
    exportedAt: exportData.exportedAt || "",
    simulated: simulate,
    tables: {},
    files: { total: manifest.length, present: 0, missing: 0, md5Mismatch: 0 },
    tablesDiff: null,
    fileChecks: null,
    issues: [],
    warnings: []
  };

  /* 檔案包解壓與對帳：缺件列問題不擋流程；MD5 不一致擋流程。 */
  var zipResult = expandZipEntries(exportDir);
  var bytesEntries = zipResult.entries || {};
  var bucketEntries = {};
  manifest.forEach(function (entry) {
    var id = String(entry.id);
    var bytes = bytesEntries[id];
    if (!bytes) { result.files.missing += 1; result.issues.push("缺件（檔案包內無此檔）：" + id + "（名稱：" + (entry.name || "?") + "，來源：" + entry.source + "）"); return; }
    result.files.present += 1;
    if (entry.md5 && md5Base64(bytes) !== entry.md5) {
      result.files.md5Mismatch += 1;
      result.issues.push("MD5 不一致：" + id + "（預期 " + entry.md5 + "）");
    } else {
      bucketEntries[id] = { bytes: bytes, contentType: entry.mime || "" };
    }
  });
  Object.keys(bytesEntries).forEach(function (id) {
    if (!manifestById[id]) result.warnings.push("檔案包內有多餘檔案（清單外）：" + id);
  });

  /* 資料規範化並產出種子 SQL 與 R2 指令檔。 */
  var rows = normalizeTables(tableMap, schemaTypes, exportData.tables || {});
  Object.keys(rows).forEach(function (tableKey) { result.tables[tableKey] = rows[tableKey].length; });
  var seedSql = buildSeedSql(tableMap, schemaTypes, rows);
  fs.writeFileSync(path.join(outputDir, "d1-seed.sql"), seedSql, "utf8");
  var r2Count = Object.keys(bucketEntries).length;
  writeR2Scripts(outputDir, bucketEntries, manifestById);
  fs.writeFileSync(path.join(outputDir, "summary.json"), JSON.stringify({
    format: result.format, exportedAt: result.exportedAt, simulated: result.simulated,
    tables: result.tables, files: result.files, tablesDiff: result.tablesDiff,
    fileChecks: result.fileChecks, issues: result.issues, warnings: result.warnings
  }, null, 2), "utf8");

  printReport(result);

  if (simulate) {
    runSimulate(tableMap, schemaTypes, rows, bytesEntries, manifestById, result, seedSql, bucketEntries);
  }
}

/* 模擬驗證：node:sqlite 套 schema 與種子、FakeR2 載入本機 bytes、worker 自身逐表逐欄對帳。 */
async function runSimulate(tableMap, schemaTypes, rows, bytesEntries, manifestById, result, seedSql, bucketEntries) {
  var db = new (require("node:sqlite").DatabaseSync)(":memory:");
  db.exec(fs.readFileSync(path.join(projectDir, "schema.sql"), "utf8"));
  Object.keys(tableMap).forEach(function (tableKey) { db.exec("DELETE FROM " + tableKey + ";"); });
  db.exec(seedSql);
  var d1 = makeD1(db);
  var bucket = new FakeR2();
  Object.keys(bucketEntries).forEach(function (driveId) {
    bucket.put(driveId, bucketEntries[driveId].bytes, bucketEntries[driveId].contentType);
  });
  var context = buildWorkerContext(d1, bucket);

  var tableDiffs = 0;
  for (var tableKey of Object.keys(tableMap)) {
    var expected = rows[tableKey];
    var readBack = await context.readTable_(tableKey);
    if (readBack.length !== expected.length) {
      tableDiffs += 1;
      result.issues.push("讀回筆數不一致：" + tableKey + "（預期 " + expected.length + "、實際 " + readBack.length + "）");
      continue;
    }
    var tableTypes = schemaTypes[tableKey] || {};
    for (var rowIndex = 0; rowIndex < expected.length; rowIndex += 1) {
      var diffField = compareRow(tableMap[tableKey], tableTypes, expected[rowIndex], readBack[rowIndex]);
      if (diffField) {
        tableDiffs += 1;
        result.issues.push("讀回內容不一致：" + tableKey + " 第 " + (rowIndex + 1) + " 筆欄位 " + diffField);
      }
    }
  }
  result.tablesDiff = tableDiffs;

  /* getFile_ 抽驗：files 表有索引且本檔有 bytes 者，全數走 worker 自身 getFile_ 對 MD5。 */
  var fileChecks = { checked: 0, ok: 0, failed: 0, skipped: 0 };
  var filesIndex = rows.files;
  for (var index = 0; index < filesIndex.length; index += 1) {
    var driveId = String(filesIndex[index].driveId || "");
    if (!driveId) continue;
    var bytes = bytesEntries[driveId];
    if (!bytes) { fileChecks.skipped += 1; continue; }
    var expectedMd5 = manifestById[driveId] && manifestById[driveId].md5 || "";
    fileChecks.checked += 1;
    try {
      var fileResult = await context.getFile_({ fileId: driveId });
      var actualBytes = Buffer.from(String(fileResult.base64 || ""), "base64");
      if (!expectedMd5 || md5Base64(new Uint8Array(actualBytes)) === expectedMd5) fileChecks.ok += 1;
      else { fileChecks.failed += 1; result.issues.push("getFile_ MD5 對帳失敗：" + driveId); }
    } catch (error) {
      fileChecks.failed += 1;
      result.issues.push("getFile_ 驗證錯誤：" + driveId + "：" + String(error && error.message || error));
    }
  }
  result.fileChecks = fileChecks;

  /* 引用掃查：boards 與 materials 的 pdfFileId 若缺件且不在 files 索引，特別提醒。 */
  (rows.boards.concat(rows.materials)).forEach(function (row) {
    var id = String(row.pdfFileId || "");
    if (id && bytesEntries[id] === undefined && manifestById[id]) result.warnings.push("版面缺少教材 PDF：" + id + "（" + String(row.name || "") + "）");
  });

  fs.writeFileSync(path.join(projectDir, OUTPUT_REL, "summary.json"), JSON.stringify({
    format: result.format, exportedAt: result.exportedAt, simulated: true,
    tables: result.tables, files: result.files, tablesDiff: result.tablesDiff,
    fileChecks: result.fileChecks, issues: result.issues, warnings: result.warnings
  }, null, 2), "utf8");

  printReport(result);
  var fatal = tableDiffs > 0 || result.files.md5Mismatch > 0 || fileChecks.failed > 0;
  if (fatal) { console.log("結論：模擬驗證未通過，請依訊息處理後重跑。"); process.exitCode = 1; }
  else { console.log("結論：模擬驗證通過。下一步（需 Cloudflare 帳號）：wrangler d1 execute 後跑 r2-upload.ps1 再跑 r2-verify.ps1。"); }
}

/* 欄位級比對：數值欄以數值（容差 1e-9 相對）比對，其餘以字串比對；回傳第一個不一致的欄位或 null。 */
function compareRow(table, tableTypes, expected, actual) {
  for (var index = 0; index < table.keys.length; index += 1) {
    var field = table.keys[index];
    var column = table.columns[field];
    var type = tableTypes[column];
    var left = expected[field];
    var right = actual !== undefined && actual !== null ? actual[field] : undefined;
    if (isNumericType(type)) {
      var a = Number(left);
      var b = right === undefined || right === null || right === "" ? 0 : Number(right);
      if (!Number.isFinite(a)) a = 0;
      if (!Number.isFinite(b)) b = 0;
      var tolerance = Math.max(1, Math.abs(a), Math.abs(b)) * 1e-9;
      if (Math.abs(a - b) > tolerance) return field + "（數值 " + a + " 對 " + b + "）";
    } else {
      var leftText = left === undefined || left === null ? "" : String(left);
      var rightText = right === undefined || right === null ? "" : String(right);
      if (leftText !== rightText) return field + "（'" + truncate(leftText) + "' 對 '" + truncate(rightText) + "'）";
    }
  }
  return null;
}

function truncate(text) { return text.length > 60 ? text.slice(0, 57) + "…" : text; }

/* ============ 報表輸出 ============ */

function printReport(result) {
  var tableSummary = Object.keys(result.tables).map(function (key) { return key + "=" + result.tables[key]; }).join("、");
  console.log("匯出時間：" + (result.exportedAt || "-") + (result.simulated ? "（模擬驗證）" : ""));
  console.log("資料表：" + (tableSummary || "（空）"));
  console.log("實體檔案：現檔 " + result.files.present + "／總數 " + result.files.total + "（缺件 " + result.files.missing + "、MD5 不一致 " + result.files.md5Mismatch + "）");
  if (result.tablesDiff !== undefined && result.tablesDiff !== null) console.log("模擬讀回差異表：" + result.tablesDiff);
  if (result.fileChecks) console.log("getFile_ 抽驗：檢 " + result.fileChecks.checked + "、過 " + result.fileChecks.ok + "、跳過（缺件）" + result.fileChecks.skipped + "、敗 " + result.fileChecks.failed);
  if (result.issues.length) { console.log("問題："); result.issues.forEach(function (issue) { console.log("  ✗ " + issue); }); }
  if (result.warnings.length) { console.log("附帶提醒："); result.warnings.forEach(function (warning) { console.log("  ⚠ " + warning); }); }
}

main();
