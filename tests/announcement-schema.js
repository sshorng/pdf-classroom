// 公告多連結結構測試：正式後端已改為 Workers＋D1，本測試改驗 schema.sql 與 worker.js 的資料表定義。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const baseDir = path.join(__dirname, "..");
const schema = fs.readFileSync(path.join(baseDir, "schema.sql"), "utf8");
const worker = fs.readFileSync(path.join(baseDir, "worker.js"), "utf8");

const announcementsTable = (schema.match(/CREATE TABLE IF NOT EXISTS announcements \(([\s\S]*?)\n\)/) || [])[1] || "";
assert.match(announcementsTable, /\blinks\s+TEXT\b/, "schema.sql 的公告資料表缺少 links 欄位");

const context = {};
vm.createContext(context);
vm.runInContext(
  worker.replace(/export default/, "const WORKER_EXPORT =") +
    "\nthis.__announcementTable = TABLES.announcements; this.__cacheKey = DATABASE_READY_CACHE_KEY; this.__maxLinks = MAX_ANNOUNCEMENT_LINKS; this.__normalizeLinks = normalizeAnnouncementLinks_;",
  context
);

const table = context.__announcementTable;
assert.ok(table, "worker.js 缺少 announcements 資料表定義");
assert.ok(table.keys.includes("links"), "worker.js 公告 key 缺少 links");
assert.equal(table.columns.links, "links", "worker.js 公告欄位未對應 links");
assert.equal(context.__maxLinks, 8, "公告連結上限應為 8");
assert.equal(context.__cacheKey, "pdfw_database_ready_v5_announcement_links_schema", "公告結構版本未更新");

const links = [
  { label: "查字典", url: "https://example.com/dictionary" },
  { label: "參考影片", url: "https://example.com/video" }
];
const normalized = context.__normalizeLinks(JSON.stringify(links));
assert.equal(normalized.length, 2, "多連結 JSON 未正確解析");
assert.equal(normalized[0].url, links[0].url, "主要連結未保留");
assert.throws(
  () => context.__normalizeLinks(JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ label: "連結" + i, url: "https://example.com/" + i })))),
  /最多/,
  "超過 8 個連結必須被擋下"
);

console.log("announcement-schema=" + JSON.stringify({ linksColumn: true, maxLinks: context.__maxLinks, cacheVersion: context.__cacheKey }));
