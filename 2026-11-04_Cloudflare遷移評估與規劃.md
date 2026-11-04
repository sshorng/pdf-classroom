# Cloudflare 遷移評估與規劃（互動 PDF 教室）

## １．目的與證據

夫子實機回報「還是太慢」，痛點經選項框確認為三項全中：開 PDF 慢、同步輪詢慢、整體都被拖住。依 2026-09-08 效能計畫第四階段「需證據才升級」的門檻，於 2026-11-04 以唯讀診斷工具取得對現行部署的基線：

`node tests/diagnose-network.js --include-file --compare-post`

| 動作 | 實測耗時 | 備註 |
|:---|:---|:---|
| ping | 1.7 秒 | apiVersion 為 2026-09-10-network-v2，確認是現行版後端 |
| listPublicBoards | 2.6 秒 | 公開清單，僅 1.3KB |
| getBoard | 2.6 秒 | 17KB 回應 |
| classroomSync（GET） | 3.1 秒 | 18KB 回應 |
| classroomSync（POST） | 1.5 秒 | 同一份資料，POST 較快是 GAS 重導向差異 |
| classroomPulse（無變更 × 5） | 1.1 至 1.8 秒 | 只回 698B 的「沒事」也要 1 秒以上 |
| getFile（POST） | 4.1 秒 | 注意：這份 PDF 只有約 0.8MB |
| getFile（GET） | 6.0 秒 | 同上 |

12 請求 0 失敗，資料可信；以下判讀全部以此為準。

### 判讀一：「請求稅」約 1.5 至 3 秒，是我方程式改不掉的

每個請求都要吃 GAS 執行環境的啟動與重導向（host 是 script.googleusercontent.com），698B 的空心跳也要 1.1 秒起跳。學生端 3 秒輪詢加上請求本體，實際節奏是約 4.3 至 4.8 秒一拍；老師任何一個操作最少付 1.5 至 3 秒的稅。9/8 計畫的第二、三階段若全做完，也壓不到 1 秒以下，這是 GAS 平台地板。

### 判讀二：「檔案稅」才是災區，而且 GAS 上有天花板

0.8MB 的 PDF 要 4 至 6 秒，因為 `getFile_` 是整顆 blob 讀進記憶體再 `Utilities.base64Encode` 塞進 JSON（`Code.gs:2091`）。時間與大小幾乎線性：教學現場一份 10 至 20MB 的講義，推估要數十秒到分鐘級，會直接頂破前端 60 秒 timeout。GAS 不能串流、不能 HTTP Range、不能走 CDN，這條路在 GAS 上改成任何寫法都上不去。

### 結論

痛點與 Cloudflare 的能力完全對上：Workers 免費層的邊節點請求常態 100 至 300ms 級，是 pulse 現況的約十分之一；R2 檔案串流支援 Range 與邊緣快取，PDF.js 可以只抓當前頁需要的位元組。**建議立案走全套遷移（方案一）**，同時不搬家也可能先做止血（第 ６ 節）。

## ２．三條路與不選的理由

| 方案 | 內容 | 判定 |
|:---|:---|:---|
| 一：全套遷移 | Workers ＋ D1 取代 Code.gs 與試算表；R2 取代 Drive | **推薦**。契約已凍結，是翻譯不是設計 |
| 二：混合 | 只把檔案層搬 R2，表格資料留 GAS | 不選。檔案快了但輪詢仍慢，且要維持 Drive 與 R2 兩份檔案的一致性，維運更重 |
| 三：留守 GAS | 做完 9/8 計畫第二、三階段 | 不選為主案。請求稅壓不到 1 秒，檔案稅完全無解；剩下的優化另列入止血項 |
| Firebase | Firestore ＋ Storage | 專案第一版邊界明文排除，且收益不比方案一多 |

## ３．免費層預算核算（夫子指定只用免費服務）

| 服務 | 免費額度 | 本專案用量推估 | 判定 |
|:---|:---|:---|:---|
| Workers | 10 萬請求／日 | 30 生 × 3 秒輪詢 × 60 分一堂 ≈ 3.6 萬，加讀寫約 4 至 5 萬 | 單日一節課安全；同天兩節課吃緊，靠第 ４ 節的輪詢瘦身對沖 |
| D1 | 每日 500 萬列讀、10 萬列寫、共 5GB | heartbeat 每拍讀個位數列；3.6 萬拍 ≈ 30 萬列讀 | 安全 |
| R2 | 10GB 儲存、每月 Class A 寫 100 萬次、Class B 讀 1,000 萬次、下傳免費 | 20MB 上限的 PDF 數十份＋壓縮照片；檔案讀取已被 IndexedDB 快取收斂 | 安全 |
| Workers CPU | 每請求 10ms | heartbeat 只讀版本號；上傳走原生 base64 解碼＋R2 put | 安全 |

唯一無法用免費解掉的情境：同一天多班連續上課把 Workers 請求額度吃滿。對策是輪詢節奏反算（見下）＋頁面隱藏暫停，師生端在額度耗盡時是「回到本機快取」而非壞掉，符合既有離線契約。

## ４．目標架構

### 後端 `worker.js`（沿用專案五區防腐架構）

| GAS 現況 | Cloudflare 對應 |
|:---|:---|
| Google 試算表九張工作表 | D1 的 `boards`、`materials`、`areas`、`masks`、`classroomState`、`submissions`、`files`、`announcements`、`settings`、`idempotency` |
| Drive 存 PDF、照片、大型 JSON | R2 三個前綴直譯：`pdf`、`photo`、`json`（筆跡與遮罩 JSON 仍放 R2，版本號放 D1，對譯現行 Drive 模式） |
| doGet／doPost API ROUTER | Worker 同名 action 分派，JSON 契約一比一保留，前端只換網址與 content type |
| 密語登入（Apps Script 內驗證） | Web Crypto 比對 D1 的密語雜湊，簽發 token 存 D1，語意沿用「登出即撤銷」 |
| withLock_ 全域寫入鎖 | 移除；D1 單列寫入本身的原子性＋冪等表即可，寫入衝突保護依 9/8 計畫第三階段設計 |
| 試算表 3 秒快取 | 不需要；D1 本身就是記憶體級讀取 |

### 檔案層紅利

- `getFile` 改為 R2 串流回應，帶 `ETag` 與 `Accept-Ranges`；PDF.js 走 Range 只抓需要的頁區段。
- 上傳改成瀏覽器直送 Worker（免費層請求 body 上限 100MB，20MB PDF 無虞），落 R2 由 Worker 簽索引，照片壓縮維持前端 800px 契約。
- CORS 由 Worker 自控，比 GAS 的重導向乾淨；`workers.dev` 子網域免錢。

### 輪詢瘦身（負責把免費額度守住）

間隔 3 秒改 4 至 5 秒＋抖動；`document.hidden` 時整段暫停；學生端「本機快取先顯示、網路回來再更新」契約不變。以上三項在 GAS 版也立即可做，是第 ６ 節止血項。

## ５．分階段計畫與驗收閘門

- 階段 0（已完成）：基線量測，即本文件第 １ 節。
- 階段 1（已完成，2026-11-04）：`worker.js` 骨架＋`schema.sql`（11 表＋索引＋settings 預設值）＋密語登入（權杖存 D1 `adminTokens`，跨隔離層有效）。Code.gs 27 個 action 逐支翻譯，資料層改 D1/R2 async。驗證：新增 `tests/worker-smoke.js`（以 node:sqlite 模擬 D1、記憶體 Map 模擬 R2，11 組全 PASS，含契約對帳、冪等重送、大型 JSON 外置、權杖存續與撤銷）；既有八項 node 測試原樣全跑 PASS，未回改。`wrangler.toml` 的 `database_id` 待建庫後填。
- 階段 2（已完成，2026-11-04）：檔案層串流驗證（`tests/worker-smoke.js` 新增檔案層組：getFile JSON 契約、stream=1 走正式 fetch 入口的 200 回應、Accept-Ranges／ETag 標頭、Range 206 切片比對）；前端請求層雙軌換骨：本體 `apiGet`／`apiPost`、`gasGet`／`gasPost` 保留為呼叫端與契約測試共用的相容別名（階段 5 清除）；端點解析支援 Workers 網址（`DEFAULT_WORKER_URL` 常數占位＋端點自動判定 `NETWORK_URL_MODE`）；Worker 端點下 `getFile` 改走 stream 串流（Range／ETag 由 HTTP 接手，回傳 base64 契約不變）；暖機 `warmupMaterialPdfs` 於版面就緒後背景預取教材 PDF 進 IndexedDB（並發 2，僅 Worker 端點啟用）。八項測試＋worker-smoke 12 組＋全形標點＋`git diff --check` 全 PASS。正式串流速率待階段 4 實測。
- 階段 3（已完成，2026-11-04）：遷移三件套定稿：`migration/export.gs`（貼進現行 GAS 專案執行：表格資料與檔案清單寫成全量 JSON，Drive 檔案以游標續跑分批打包 zip，單包上限 30MB；重用 Code.gs 全域 `readTable_` 等函式，掃描 ink 與 submissions 的 drive 引用防漏件）、`migration/migrate.js`（本機轉換：解析 worker.js 自身 TABLES 為欄位映射真相；解壓檔案包逐檔 MD5 對帳；產出 `migration/output/d1-seed.sql`、`r2-upload.ps1`、`r2-verify.ps1`、`r2-manifest.csv`、`r2-objects/` 與 `summary.json`；`--simulate` 以 node:sqlite 套 schema.sql 加種子、本機 bytes 模擬 R2、透過 worker 自身 `readTable_` 逐表逐欄比對匯出原文、`getFile_` 抽驗每檔 MD5）、`migration/README.md`（夫子四步操作指南）。缺件列為非阻擋提醒，MD5 不一致與讀回不一致為失敗。驗證：新增 `tests/migration-e2e.js` 三案例（完整資料模擬通過、篡改一字節觸發 MD5 失敗、缺件非阻擋提醒）全 PASS；既有八項＋worker-smoke 12 組照跑 PASS；全形標點＋`git diff --check` PASS。`migration/output/` 已入 .gitignore。正式建庫（`d1 create`、填 `database_id`）、上傳與部署需夫子 Cloudflare 帳號授權。
- 階段 4：雙軌並行：前端保留 API 網址切換，GAS 為退路；CDP 煙霧測試＋真平板 30 人實測；pulse 實測目標：無變更心跳 P95 低於 500ms，20MB PDF 首載低於 5 秒（受校園網路上行影響者另計）。
- 階段 5：換掉 `DEFAULT_GAS_URL`、GAS 停寫歸檔；更新 README、專案房規、驗證器路徑。

每階段交付前一律跑：`node tests/`八項＋`validate_punct.py`＋`git diff --check`。（備註：`validate_contract.py` 現行版本的效能必要項與本專案版本錯位，16 處缺件屬既存狀態，與階段 1 無涉，是否補齊另請夫子裁決。）

## ６．不搬家的止血選項（可與階段 1 至 2 並行）

1. pulse 3 秒改 4 至 5 秒＋抖動＋`document.hidden` 暫停：輪詢請求量砍半以上，GAS 額度與班上體感都受益。
2. 教師端落筆批次窗口從現行值放寬 1 至 2 秒：把多拍併成一拍。
3. 這三項只動 SYNC 區的常數與可見度判斷，不動契約，半天內可做。

## ７．風險與對策

- **校網擋 `workers.dev`**：少部分學校 DNS 過濾子域名。對策：階段 4 先用校網真平板驗證；若被擋，唯一可能的成本是自訂域名（一年 10 美元級），屆時再請夫子裁決，遷移工程本身不受影響。
- **免費層超量**：第 ３、４ 節的輪詢反算與隱藏暫停；額度用滿是「降級到本機快取」不是掛掉。
- **遷移污染正式資料**：階段 3 只在 D1/R2 副本上操作，GAS 試算表在階段 5 前維持可寫，任何時刻可退回。
- **D1 與現行「版本號＋冪等」語意差異**：階段 1 以原 `mutation ID` 表直譯進 D1 冪等表，八項測試含 network-resilience 為閘門。
- **單人在案**：後端翻譯估 2 至 3 個工作天；若遇到需 RDQ 收斂的新決策（例如 token 續期策略），先停手問夫子，不自行擴張。

## ８．待夫子確認

1. 立案範圍：走方案一全套遷移，並先做第 ６ 節止血項？（止血項也可以先單獨上）
2. 階段 4 的 30 人實測要排哪一節課、用哪一個班的現行名冊。
3. 校網若擋 `workers.dev`，接受一年約 10 美元的域名成本，或屆時退回 GAS 停案。
