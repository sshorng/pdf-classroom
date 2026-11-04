# PDF 互動講義批改系統，GAS 遷移至 Cloudflare 操作指南

本資料夾負責把現行 GAS 版（試算表＋Drive）的資料搬進 Cloudflare D1 與 R2。全程分四步：匯出、下載、模擬驗證、正式入庫。前兩步在 Apps Script 與雲端硬碟完成，後兩步在電腦本機用指令完成。

## 事前準備

- 本機已安裝 Node.js（跑遷移腳本）。
- 夫子自己的 Cloudflare 帳號（第四步才需要，免費方案即可）。
- GAS 專案維持現狀，不需要停用；雙軌並行期間它仍是退路。

## 第一步：從 GAS 匯出（在 Apps Script 操作）

1. 開啟現行 GAS 專案（與 Code.gs 同一專案）。
2. 新增指令碼檔案，命名為 `migration`，把本資料夾的 `export.gs` 內容貼進去儲存。
3. 在編輯器上方選擇函式 `migrateExportData`，按「執行」。授權後，雲端硬碟的「PDF互動講義檔案」資料夾內會多一個「migration-匯出」資料夾，並產生一份 `migration-全量資料-日期.json`。
4. 接著選擇函式 `migrateExportFiles` 重複執行。每次執行會打包一批實體檔案（單包上限 30MB），產生 `migration-檔案包-編號.zip`。
5. 重複執行直到訊息回覆「無剩餘檔案」，檔案匯出即完成。

## 第二步：下載到本機

1. 把「migration-匯出」資料夾裡的 JSON 與全部 zip 下載到本機同一個資料夾（例如桌面新增一個 `migration-export` 資料夾）。
2. 若已安裝桌面版雲端硬碟，等同步完成後直接記下該資料夾路徑也可以。

## 第三步：模擬驗證（本機，不需 Cloudflare 帳號）

在專案資料夾（本檔的上一層）開終端機執行：

```powershell
node migration/migrate.js --export-dir "<剛才的資料夾路徑>" --simulate
```

腳本會：

1. 解析 `worker.js` 自己的 TABLES 欄位映射，確認欄位名稱與 D1 表結構一致。
2. 解壓全部檔案包，逐檔與清單 MD5 對帳。
3. 產生 `migration/output/d1-seed.sql`（D1 種子資料）與 `r2-upload.ps1`／`r2-verify.ps1`／`r2-manifest.csv` 與 `r2-objects/`（逐檔 bytes）。
4. 以本機模擬環境完整重放 worker：套用 `schema.sql` 與種子 SQL，逐表逐欄讀回比對匯出原文，再以 worker 自身的 `getFile_` 抽驗每個檔案。

**驗證通過的標準**：終端機最後顯示「結論：模擬驗證通過」，且結束代碼為 0。若出現 ✗ 問題項目（缺件、MD5 不一致、讀回不一致），請依訊息處理後重跑；⚠ 附帶提醒為非阻擋項目（例如清單外多餘檔案、缺件教材）。

## 第四步：正式入庫（需 Cloudflare 帳號）

1. 登入：

```powershell
npx wrangler login
```

2. 建立資源（只需一次）：

```powershell
npx wrangler d1 create pdf-workbook-db
npx wrangler r2 bucket create pdf-workbook-files
```

3. 把 `d1 create` 輸出的 `database_id` 填進 `wrangler.toml` 的 `REPLACE_WITH_D1_DATABASE_ID`。
4. 套用資料表結構與種子資料：

```powershell
npx wrangler d1 execute pdf-workbook-db --remote --file=schema.sql
npx wrangler d1 execute pdf-workbook-db --remote --file=migration/output/d1-seed.sql
```

5. 上傳檔案並對帳：

```powershell
powershell -NoProfile -File migration/output/r2-upload.ps1
powershell -NoProfile -File migration/output/r2-verify.ps1
```

6. 部署 Worker：

```powershell
npx wrangler deploy
```

7. 部署成功後，把 Workers 網址（形如 `https://pdf-workbook-api.你的子網域.workers.dev`）填進 `index.html` 的 `DEFAULT_WORKER_URL`，系統即自動切換至串流下載與暖機。填入前，全站行為維持 GAS 現狀不受影響。

## 注意事項

- `migration/output/` 內含完整學生成績與設定（含管理員密碼與 Gemini API Key），屬敏感資料：不要提交到 Git（已列入 .gitignore），正式入庫完成並確認後即可刪除。
- 學年期間建議挑週末或放學後執行第四步；匯出（第一、二步）隨時可做，不影響現行使用。
- 匯出當下到正式入庫之間的新資料不會包含在內。入庫完成前請避免在同一時段新增版面或批改；若需補資料，重跑第一至第四步即可（種子 SQL 為整批覆蓋式）。
- GAS 版保留為退路：正式切換後若需回退，把前端 `DEFAULT_WORKER_URL` 清空即回到 GAS 端點，原試算表與 Drive 資料完全未動。

## 本資料夾檔案說明

| 檔案 | 用途 |
|------|------|
| `export.gs` | 貼到 GAS 專案執行的匯出腳本（表格 JSON＋檔案包） |
| `migrate.js` | 本機轉換與模擬驗證腳本（`--export-dir`＋`--simulate`） |
| `output/` | 產物資料夾（種子 SQL、R2 指令檔、摘要），不入 Git |
| `README.md` | 本指南 |
