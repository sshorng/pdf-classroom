const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "Code.gs"), "utf8");
const context = {};
vm.createContext(context);
vm.runInContext(source + "\nthis.__announcementTables = TABLES; this.__databaseReadyCacheKey = DATABASE_READY_CACHE_KEY;", context);

const table = context.__announcementTables.announcements;
const linkColumn = table.headers.indexOf("連結資料");
assert(linkColumn >= 0, "公告資料表缺少連結資料欄位");
assert(table.keys[linkColumn] === "links", "連結資料欄位未對應 links 鍵");
assert(context.__databaseReadyCacheKey === "pdfw_database_ready_v5_announcement_links_schema", "公告資料表遷移版本未更新");

const links = [
  { label: "查字典", url: "https://example.com/dictionary" },
  { label: "參考影片", url: "https://example.com/video" }
];
const oldHeaders = table.headers.filter((header) => header !== "連結資料");
const addedHeaders = [];
const oldSheet = {
  getLastColumn: () => oldHeaders.length,
  getRange: (row, column, rows, cols) => ({
    getValues: () => [oldHeaders],
    setValue: (value) => addedHeaders.push({ row, column, value }),
    setValues: (values) => values[0].forEach((value, i) => addedHeaders.push({ row, column: column + i, value }))
  }),
  setFrozenRows: () => {}
};
context.getSpreadsheet_ = () => ({ getSheetByName: () => oldSheet });
context.ensureTable_("announcements");
assert(addedHeaders.some((item) => item.value === "連結資料"), "既有公告資料表未自動補上連結資料欄位");

const rows = [];
const currentSheet = {
  getLastColumn: () => table.headers.length,
  getRange: () => ({ getValues: () => [table.headers], setValues: () => {} }),
  appendRow: (row) => rows.push(row)
};
context.getSheet_ = () => currentSheet;
context.clearTableCache_ = () => {};
context.appendRow_("announcements", {
  id: "AN-schema",
  title: "多連結測試",
  description: "",
  url: links[0].url,
  links: JSON.stringify(links),
  pinned: false,
  order: 1,
  status: "啟用",
  createdAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z"
});
assert(rows.length === 1, "公告資料列未寫入");
assert(rows[0][table.headers.indexOf("連結")] === links[0].url, "主要連結未寫入");
assert(rows[0][linkColumn] === JSON.stringify(links), "多連結 JSON 未寫入連結資料欄位");

console.log("announcement-schema=" + JSON.stringify({ addedColumn: true, storedLinks: 2, cacheVersion: context.__databaseReadyCacheKey }));
