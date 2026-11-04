/* 遷移流程端到端測試：以偽造匯出資料（步驟：export JSON＋檔案包 zip）走完整 migrate.js --simulate，
   並驗證 MD5 不一致與缺件兩種失敗／提醒路徑。 */
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var os = require("node:os");
var crypto = require("node:crypto");
var { execFileSync } = require("node:child_process");

var projectDir = path.join(__dirname, "..");
var outputFileDir = path.join(projectDir, "migration", "output");

function md5Base64(bytes) { return crypto.createHash("md5").update(bytes).digest("base64"); }

/* 台灣學期字的測試假資料建置。 */
function buildFixture(layoutName) {
  var root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pdfw-e2e-"));
  var staging = path.join(root, "staging");
  var exportDir = path.join(root, "export");
  fs.mkdirSync(staging);
  fs.mkdirSync(exportDir);

  var pdfBytes = Buffer.from("%PDF-1.4\n%測試講義內容\n%%EOF\n", "utf8");
  var imageBytes = Buffer.from("89504E470D0A1A0A0000000D49484452" + "AB".repeat(64), "hex");
  fs.writeFileSync(path.join(staging, "f_pdf"), pdfBytes);
  fs.writeFileSync(path.join(staging, "f_img"), imageBytes);

  var source = {
    format: "pdfw-migration-v1",
    exportedAt: "2026-11-04T10:00:00+08:00",
    spreadsheet: { id: "test-sheet", url: "https://docs.google.com/spreadsheets/d/test-sheet" },
    rootFolder: { name: "PDF互動講義檔案", url: "https://drive.google.com/none" },
    tables: {
      settings: [
        { key: "DriveRootFolderName", value: "PDF互動講義檔案" },
        { key: "MaxPdfBytes", value: "20971520" }
      ],
      announcements: [
        { id: "a1", title: "開學公告", description: "請帶講義", url: "", links: "[]", pinned: true, order: 2, status: "啟用", createdAt: "2026-09-01T07:30:00+08:00", updatedAt: "2026-09-01T07:30:00+08:00" },
        { id: "a2", title: "舊公告", description: "", url: "", links: "[\"https://example.com/x\"]", pinned: false, order: 1, status: "停用", createdAt: "2026-09-02T07:30:00+08:00", updatedAt: "2026-09-02T07:30:00+08:00" }
      ],
      boards: [
        { id: "b1", name: layoutName, description: "三年二班的測試版面", pdfFileId: "f_pdf", pdfFileName: "講義.pdf", pdfMime: "application/pdf", status: "啟用", createdAt: "2026-09-01T07:30:00+08:00", updatedAt: "2026-09-01T07:31:00+08:00" }
      ],
      materials: [
        { id: "m1", boardId: "b1", name: "第一課", description: "", pdfFileId: "f_pdf", pdfFileName: "講義.pdf", pdfMime: "application/pdf", order: 1, status: "啟用", createdAt: "2026-09-01T07:30:00+08:00", updatedAt: "2026-09-01T07:31:00+08:00" }
      ],
      areas: [
        { id: "ar1", boardId: "b1", materialId: "m1", page: 2, x: 0.25, y: 0.125, width: 0.5, height: 0.2, title: "問答一", prompt: "用自己的話回答", order: 1, status: "啟用", createdAt: "2026-09-01T07:30:00+08:00", updatedAt: "2026-09-01T07:30:00+08:00" }
      ],
      answerMasks: [],
      ink: [
        { id: "i1", boardId: "b1", materialId: "m1", page: 1, strokes: "[{\"points\":[1,2,3],\"color\":\"#111111\"}]", updatedAt: "2026-09-03T08:00:00+08:00", mutationId: "mu1" }
      ],
      classroomState: [
        { id: "cs1", boardId: "b1", materialId: "m1", page: 2, zoom: 1.5, updatedAt: "2026-09-03T08:00:00+08:00" }
      ],
      submissions: [
        { id: "s1", boardId: "b1", materialId: "m1", areaId: "ar1", nickname: "小明", text: "我的答案", imageFileIds: "[\"f_img\"]", imageFileNames: "[\"作答.png\"]", teacherStrokes: "", teacherComment: "", status: "待批改", clientId: "c1", createdAt: "2026-09-03T08:00:00+08:00", updatedAt: "2026-09-03T08:00:00+08:00", mutationId: "" }
      ],
      files: [
        { id: "d1", purpose: "board-pdf", name: "講義.pdf", mime: "application/pdf", driveId: "f_pdf", size: String(pdfBytes.length), boardId: "b1", materialId: "", submissionId: "", createdAt: "2026-09-01T07:30:00+08:00" },
        { id: "d2", purpose: "submission-photo", name: "作答.png", mime: "image/png", driveId: "f_img", size: String(imageBytes.length), boardId: "b1", materialId: "m1", submissionId: "s1", createdAt: "2026-09-03T08:00:00+08:00" }
      ]
    },
    files: [
      { id: "f_pdf", name: "講義.pdf", mime: "application/pdf", size: pdfBytes.length, md5: md5Base64(pdfBytes), source: "files" },
      { id: "f_img", name: "作答.png", mime: "image/png", size: imageBytes.length, md5: md5Base64(imageBytes), source: "files" }
    ]
  };
  fs.writeFileSync(path.join(exportDir, "migration-全量資料-20261104-1000.json"), JSON.stringify(source, null, 2), "utf8");

  var chunkManifest = { format: "pdfw-migration-chunk-v1", files: source.files };
  fs.writeFileSync(path.join(staging, "_migrate_manifest.json"), JSON.stringify(chunkManifest, null, 2), "utf8");
  execFileSync("powershell", [
    "-NoProfile", "-Command",
    "Compress-Archive -Path '" + staging + "\\*' -DestinationPath '" + path.join(exportDir, "migration-檔案包-0.zip") + "' -Force"
  ], { stdio: "pipe" });
  return exportDir;
}

function wipeOutput() { fs.rmSync(outputFileDir, { recursive: true, force: true }); }

function runMigrate(exportDir) {
  try {
    var stdout = execFileSync("node", ["migration/migrate.js", "--export-dir", exportDir, "--simulate"], {
      cwd: projectDir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"]
    });
    return { code: 0, stdout: stdout };
  } catch (error) {
    return { code: error.status || 1, stdout: String(error.stdout || "") + String(error.stderr || "") };
  }
}

function seedFileExists(name) { return fs.existsSync(path.join(outputFileDir, name)); }

(async () => {
  var failures = [];

  /* 場景一：完整正確資料，模擬驗證應全過。 */
  wipeOutput();
  var goodDir = buildFixture("三年二班國文講義", null);
  var good = runMigrate(goodDir);
  if (good.code !== 0 || good.stdout.indexOf("結論：模擬驗證通過") < 0) {
    failures.push("案例一：模擬驗證應通過；結束代碼 " + good.code + "\n" + good.stdout);
  } else {
    assert.ok(good.stdout.indexOf("資料表：") >= 0 && good.stdout.indexOf("getFile_ 抽驗") >= 0);
    assert.ok(good.stdout.indexOf("實體檔案：現檔 2／總數 2") >= 0, "實體檔案行不符，實際輸出：\n" + good.stdout);
    assert.ok(seedFileExists("d1-seed.sql") && seedFileExists("r2-upload.ps1") && seedFileExists("r2-verify.ps1") && seedFileExists("r2-manifest.csv") && seedFileExists("summary.json"));
    var seed = fs.readFileSync(path.join(outputFileDir, "d1-seed.sql"), "utf8");
    assert.ok(seed.indexOf("INSERT OR REPLACE INTO boards (id, name, description, pdfFileId, pdfFileName, pdfMime, status, createdAt, updatedAt)") >= 0, "boards 欄位序應依 TABLES");
    assert.ok(seed.indexOf("'f_pdf'") >= 0, "種子應含 driveId");
    assert.ok(seed.indexOf("sortOrder, status, createdAt, updatedAt") >= 0 && seed.indexOf(", 1, '") >= 0, "數值欄 sortOrder 應未加引號");
    assert.ok(fs.readFileSync(path.join(outputFileDir, "r2-manifest.csv"), "utf8").split("\n").length >= 3, "r2 清單應含兩個檔案");
    var summary = JSON.parse(fs.readFileSync(path.join(outputFileDir, "summary.json"), "utf8"));
    assert.equal(summary.files.present, 2);
    assert.equal(summary.tablesDiff, 0);
    assert.equal(summary.fileChecks.ok, 2);
    assert.equal(summary.fileChecks.failed, 0);
    var objectsDir = path.join(outputFileDir, "r2-objects");
    var seedSqlPinned = seed.indexOf("INSERT OR REPLACE INTO announcements") >= 0 && seed.indexOf("'true'") >= 0;
    assert.ok(seedSqlPinned, "公告 pinned 應轉為 true 字串");
    assert.ok(fs.existsSync(path.join(objectsDir, "f_pdf")) && fs.existsSync(path.join(objectsDir, "f_img")));
    // 布林 true 欄位轉字串已由種子 SQL 驗證；good 案例尾聲。
  }
  console.log(failures.length ? "FAIL case1" : "PASS case1: full pipeline simulate (seed SQL, R2 scripts, table compare, getFile MD5)");

  /* 場景二：篡改一個檔案的一個字節，MD5 應不一致且結束代碼非零。 */
  wipeOutput();
  var tamperedDir = buildFixture("三年二班國文講義");
  // 重建 zip：抽出 pdf bytes 篡改一字節後重打包。
  var staging2 = path.join(path.dirname(tamperedDir), "staging2");
  fs.mkdirSync(staging2);
  var badBytes = fs.readFileSync(path.join(path.dirname(tamperedDir), "staging", "f_pdf"));
  badBytes[5] = (badBytes[5] + 1) % 256;
  fs.writeFileSync(path.join(staging2, "f_pdf"), badBytes);
  var imageBytes2 = fs.readFileSync(path.join(path.dirname(tamperedDir), "staging", "f_img"));
  fs.writeFileSync(path.join(staging2, "f_img"), imageBytes2);
  fs.writeFileSync(path.join(staging2, "_migrate_manifest.json"), fs.readFileSync(path.join(path.dirname(tamperedDir), "staging", "_migrate_manifest.json")));
  execFileSync("powershell", ["-NoProfile", "-Command",
    "Compress-Archive -Path '" + staging2 + "\\*' -DestinationPath '" + path.join(tamperedDir, "migration-檔案包-0.zip") + "' -Force"], { stdio: "pipe" });
  var tampered = runMigrate(tamperedDir);
  if (tampered.code === 0 || tampered.stdout.indexOf("MD5 不一致") < 0) {
    failures.push("案例二：MD5 破壞應導致失敗；結束代碼 " + tampered.code + "\n" + tampered.stdout);
  }
  console.log(failures.length > 1 ? "FAIL case2" : "PASS case2: corrupted byte triggers MD5 mismatch failure");

  /* 場景三：缺件（清單有 f_img 但檔案包沒有）→ 非阻擋，但必須列缺件。 */
  wipeOutput();
  var missingDir = buildFixture("三年二班國文講義");
  var staging3 = path.join(path.dirname(missingDir), "staging3");
  fs.mkdirSync(staging3);
  fs.writeFileSync(path.join(staging3, "f_pdf"), fs.readFileSync(path.join(path.dirname(missingDir), "staging", "f_pdf")));
  fs.writeFileSync(path.join(staging3, "_migrate_manifest.json"), JSON.stringify({
    format: "pdfw-migration-chunk-v1",
    files: [{ id: "f_pdf", name: "講義.pdf", mime: "application/pdf", source: "files" }]
  }, null, 2), "utf8");
  execFileSync("powershell", ["-NoProfile", "-Command",
    "Compress-Archive -Path '" + staging3 + "\\*' -DestinationPath '" + path.join(missingDir, "migration-檔案包-0.zip") + "' -Force"], { stdio: "pipe" });
  var missing = runMigrate(missingDir);
  if (missing.stdout.indexOf("缺件") < 0 || missing.stdout.indexOf("f_img") < 0) {
    failures.push("案例三：缺件應列出 f_img\n" + missing.stdout);
  }
  if (missing.code !== 0) {
    failures.push("案例三：缺件屬提醒、不阻擋流程；結束代碼應為 0，實際 " + missing.code + "\n" + missing.stdout);
  }
  console.log(failures.some(function (message) { return message.indexOf("案例三") === 0; }) ? "FAIL case3" : "PASS case3: missing file listed as non-blocking issue");

  wipeOutput();
  if (failures.length) {
    failures.forEach(function (message) { console.error("FAIL " + message); });
    process.exitCode = 1;
  } else {
    console.log("migration-e2e PASS (all cases)");
  }
})();
