-- PDF 互動講義批改系統，Cloudflare D1 資料表結構。
-- 欄位對譯自 Code.gs 的 TABLES 工作表欄位；value 一律以 TEXT 或數值保存，
-- 讀取時由 worker.js 的讀取層還原為字串物件，行為與 GAS readTable_ 相同。

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  pdfFileId TEXT NOT NULL DEFAULT '',
  pdfFileName TEXT NOT NULL DEFAULT '',
  pdfMime TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '啟用',
  createdAt TEXT NOT NULL DEFAULT '',
  updatedAt TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY,
  boardId TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  pdfFileId TEXT NOT NULL DEFAULT '',
  pdfFileName TEXT NOT NULL DEFAULT '',
  pdfMime TEXT NOT NULL DEFAULT '',
  sortOrder INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT '啟用',
  createdAt TEXT NOT NULL DEFAULT '',
  updatedAt TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_materials_board ON materials(boardId);

CREATE TABLE IF NOT EXISTS areas (
  id TEXT PRIMARY KEY,
  boardId TEXT NOT NULL DEFAULT '',
  materialId TEXT NOT NULL DEFAULT '',
  page REAL NOT NULL DEFAULT 1,
  x REAL NOT NULL DEFAULT 0,
  y REAL NOT NULL DEFAULT 0,
  width REAL NOT NULL DEFAULT 0.2,
  height REAL NOT NULL DEFAULT 0.12,
  title TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  sortOrder INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT '啟用',
  createdAt TEXT NOT NULL DEFAULT '',
  updatedAt TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_areas_board ON areas(boardId);

CREATE TABLE IF NOT EXISTS answerMasks (
  id TEXT PRIMARY KEY,
  boardId TEXT NOT NULL DEFAULT '',
  materialId TEXT NOT NULL DEFAULT '',
  page REAL NOT NULL DEFAULT 1,
  x REAL NOT NULL DEFAULT 0,
  y REAL NOT NULL DEFAULT 0,
  width REAL NOT NULL DEFAULT 0.2,
  height REAL NOT NULL DEFAULT 0.12,
  title TEXT NOT NULL DEFAULT '',
  sortOrder INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT '啟用',
  createdAt TEXT NOT NULL DEFAULT '',
  updatedAt TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_answerMasks_board ON answerMasks(boardId);

CREATE TABLE IF NOT EXISTS ink (
  id TEXT PRIMARY KEY,
  boardId TEXT NOT NULL DEFAULT '',
  materialId TEXT NOT NULL DEFAULT '',
  page INTEGER NOT NULL DEFAULT 1,
  strokes TEXT NOT NULL DEFAULT '',
  updatedAt TEXT NOT NULL DEFAULT '',
  mutationId TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ink_board ON ink(boardId, materialId, page);

CREATE TABLE IF NOT EXISTS classroomState (
  id TEXT PRIMARY KEY,
  boardId TEXT NOT NULL DEFAULT '',
  materialId TEXT NOT NULL DEFAULT '',
  page REAL NOT NULL DEFAULT 1,
  zoom REAL NOT NULL DEFAULT 1,
  updatedAt TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_classroomState_board ON classroomState(boardId);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  boardId TEXT NOT NULL DEFAULT '',
  materialId TEXT NOT NULL DEFAULT '',
  areaId TEXT NOT NULL DEFAULT '',
  nickname TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  imageFileIds TEXT NOT NULL DEFAULT '',
  imageFileNames TEXT NOT NULL DEFAULT '',
  teacherStrokes TEXT NOT NULL DEFAULT '',
  teacherComment TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '待批改',
  clientId TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL DEFAULT '',
  updatedAt TEXT NOT NULL DEFAULT '',
  mutationId TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_submissions_board ON submissions(boardId);
CREATE INDEX IF NOT EXISTS idx_submissions_area ON submissions(boardId, areaId);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL DEFAULT '',
  driveId TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  boardId TEXT NOT NULL DEFAULT '',
  materialId TEXT NOT NULL DEFAULT '',
  submissionId TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_files_driveId ON files(driveId);
CREATE INDEX IF NOT EXISTS idx_files_board ON files(boardId);
CREATE INDEX IF NOT EXISTS idx_files_submission ON files(boardId, submissionId);

CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  links TEXT NOT NULL DEFAULT '',
  pinned TEXT NOT NULL DEFAULT '',
  sortOrder INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT '啟用',
  createdAt TEXT NOT NULL DEFAULT '',
  updatedAt TEXT NOT NULL DEFAULT ''
);

-- 冪等結果快取：以 mutation 結果整串 JSON 保存，TTL 由 worker.js 檢查 createdAt 後機會性清理。
CREATE TABLE IF NOT EXISTS mutationResults (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL DEFAULT ''
);

-- 教師管理權杖：登入簽發、isAdminToken_ 查表驗證、登出撤銷。
CREATE TABLE IF NOT EXISTS adminTokens (
  token TEXT PRIMARY KEY,
  createdAt TEXT NOT NULL DEFAULT ''
);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('GeminiAPIKey', ''),
  ('GeminiModel', 'gemini-flash-lite-latest'),
  ('AdminPassword', ''),
  ('DriveRootFolderName', 'PDF互動講義檔案'),
  ('MaxImageBytes', '2097152'),
  ('MaxPdfBytes', '20971520');
