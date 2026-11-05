# PDF互動講義批改系統

把教師的 PDF 講義變成可分版管理的線上互動教材。一個版面可加入多份 PDF 教材，各教材的問答區、筆跡、課堂狀態、作答與草稿彼此隔離。學生以暱稱進入，針對教師放置的問答圖釘輸入文字或拍照上傳；教師可在平板上以觸控筆直接閱讀 PDF、書寫、標記圖釘、查看答案與批改。

## 檔案

- `index.html`：原生 HTML、Vanilla CSS 與 Vanilla JavaScript 前端；內部依五層防腐架構切成 18 個分區，檔頭有架構索引（見「程式架構」）。
- `worker.js`：Cloudflare Workers API，以 D1 保存索引資料，以 R2 保存 PDF、照片與大型 JSON。
- `schema.sql`：D1 資料表結構，首次部署與結構變更時套用。
- `wrangler.toml`：Worker、D1 與 R2 的綁定設定。
- `migration/`：一次性 GAS 舊資料匯出與匯入工具，僅在需要搬移舊資料時使用。
- `rdq/`：已確認的 RDQ 需求規格卡。
- `assets/`、`css/`、`js/`：預留的靜態資源資料夾；目前前端維持單檔，方便 GitHub Pages 或本機開啟。

## 使用方式

### 本機示範

直接開啟 `index.html`，在連線設定視窗選擇「本機示範模式」。本機模式的 PDF、照片、版面與批改資料只保存在目前瀏覽器，適合先測試操作流程，不代表跨裝置同步已完成。

### Cloudflare 部署

1. 在 Cloudflare 建立 D1 資料庫 `pdf-workbook-db` 與 R2 bucket `pdf-workbook-files`，並把 ID 填入 `wrangler.toml`。
2. 套用資料表結構：`npx wrangler d1 execute pdf-workbook-db --remote --file schema.sql`。
3. 教師管理密語保存在 D1 的系統設定，不需要額外環境變數。第一次在教師入口輸入的密語會直接成為管理密語，之後以此驗證。`GeminiAPIKey` 等設定同樣可在系統設定中維護。
4. 部署 Worker：`npx wrangler deploy`，完成後把網址填入前端常數或連線設定。
5. 前端部署到 GitHub Pages；`index.html` 內的 `DEFAULT_WORKER_URL` 是唯一預設端點，換帳號或換網域時只需改這一處。
6. 學生端與教師端共用同一個 Worker；資料表會在第一次請求時自動建立，不需要手動初始化。
7. 改動 `schema.sql` 後，先套用結構再部署 Worker；R2 bucket 名稱或 D1 ID 變更時，同步更新 `wrangler.toml`。

### 公告多連結排查

1. 若儲存後只剩第一個連結，先確認前端實際連線的 Worker 網址，瀏覽器保存的設定會覆寫預設值。
2. 確認 D1 的 `announcements` 表有 `links` 欄位；舊資料庫可用 `npx wrangler d1 execute pdf-workbook-db --remote --file schema.sql` 補齊。
3. 重新編輯公告並填入多個連結，儲存後 `links` 欄應包含完整連結 JSON。
4. 前端會比對後端回傳清單與送出的連結。若不完整，表單會保留並提示檢查，不會顯示儲存成功；請勿關閉或重新整理尚未成功儲存的表單。

### 連線診斷與初始化

- 執行 `node tests/diagnose-network.js --include-file` 可依序量測公開清單、第一個版面、課堂同步與第一份 PDF。只執行讀取，不輸出教材或學生內容。若前端使用其他 Worker 網址，可先設定環境變數 `PDF_WORKER_URL`。
- 加上 `--compare-post` 可比較同一份公開資料的 GET 與 POST 讀取。每次請求上限九十秒，結果列出狀態碼、耗時與回應大小；這是診斷工具，不是多人負載測試。
- `ping` 回應包含 `apiVersion`，部署後可用這個欄位確認正在執行新版。
- 資料表結構變更時須同步更新 `worker.js` 的 `DATABASE_READY_CACHE_KEY`，讓前端快取知道要重新讀取。
- 前端唯讀請求最多嘗試兩次，寫入仍由既有補傳佇列處理。

### 入口分流

- 根網址是公開學生入口，免密碼顯示公告與所有啟用中的教材版面。
- 學生可直接使用 `?view=student&board=...` 分享網址進入，不需要帳號或密碼；個別學生頁不顯示公告。
- 教師由入口網站的「教師入口」開啟密語視窗；驗證成功後可使用管理、編輯與課堂頁，登入狀態會保留至登出。登出時會同時清除瀏覽器保存的 token 並撤銷 Worker token。
- 教師產生的分享網址與 QR Code 固定指向學生版，不提供教師管理網址。

## 程式架構

前端維持單檔 `index.html`，內部依五層防腐架構切成 18 個分區，檔頭有架構索引，每個分區都有橫幅標題。

| 層 | 分區 | 職責 |
|:---|:---|:---|
| CONFIG | 第 0 區 | 常數與外部資源位址 |
| STATE | 第 1 區 | 唯一集中式狀態與跨請求旗標 |
| PDF ENGINE | 第 2 區 | PDF.js 與 PDFium 文件快取 |
| PURE ENGINE | 第 3 區 | 零 DOM、零網路的座標、幾何、正規化與排序 |
| UI SHELL | 第 4 區 | Modal、Toast、連線狀態、設定與分享 |
| UI VIEW | 第 5、9、11、13、14、16 區 | 公告、編輯工具、教材切換、答案遮罩、學生作答與批改 |
| LOCAL | 第 6 區 | IndexedDB 與本機示範後端，以動作分派表路由 |
| API ADAPTER | 第 7 區 | 請求層、離線佇列、本機優先快取與檔案載入 |
| ROUTER | 第 8 區 | 入口分流與各頁外框 |
| SYNC | 第 10、15 區 | 教師筆跡、課堂狀態與 outbox 補傳 |
| INK ENGINE | 第 12 區 | 觸控分流、筆畫生命週期與繪製 |
| BOOTSTRAP | 第 17 區 | 初始化 |

三條規矩：

1. PURE ENGINE 的函式不得讀取 DOM、不得發網路請求、不得寫入 state。事件監聽器只取值與渲染，計算一律呼叫純函式。
2. 教師筆跡與批改筆跡共用同一套觸控原語（canvasPoint、pinchDistance、eraseStrokesAtPoint、bindInkSurface），只有狀態歸屬與儲存方式不同，不要各自複製一份。
3. 本機示範後端的 localRequest 只做分派，實際邏輯在 localAnnouncementActions、localInkAndClassroomActions、localBoardActions、localSubmissionActions。新增本機 action 時必須同步更新 LOCAL_ACTION_ROUTES，否則 tests/local-dispatch.js 會擋下來。

後端 `worker.js` 依同樣原則分成 CONFIG 與 SCHEMA、PURE ENGINE、DATA ACCESS ADAPTER、DOMAIN SERVICE、API ROUTER 五區，資料存取改用 D1 與 R2，重複的資料列查找與檔案回收各自收斂為單一私有函式。

## 測試

不需要瀏覽器的靜態與 VM 測試，改動前後都要跑：

```
node tests/action-contract.js
node tests/announcement-schema.js
node tests/sync-payload-efficiency.js
node tests/network-resilience.js
node tests/local-dispatch.js
node tests/runtime-smoke.js
node tests/worker-smoke.js
node tests/migration-e2e.js
```

`worker-smoke.js` 以 Node 內建的 `node:sqlite` 模擬 D1，需要 Node 22.5 以上；其餘測試只依賴檔案與 VM。

tests 目錄下的 *-cdp.js 需要真實瀏覽器：先以 --remote-debugging-port=9224 開啟已載入教材版面（網址含 board 參數）的頁面，再執行對應測試。沒有實際的 Worker 部署與版面資料時，這批測試無法執行，不能用靜態測試代替。

契約與標點檢查使用 gas-standalone-builder 的驗證器，標點驗證器一次只收一個檔案：

```
python -X utf8 <skill>/scripts/validate_contract.py index.html --branch frontend-db
python -X utf8 <skill>/scripts/validate_punct.py index.html
python -X utf8 <skill>/scripts/validate_punct.py worker.js
python -X utf8 <skill>/scripts/validate_punct.py README.md
```

## 資料設計

- 「教材版面」保存每一版的名稱、說明與版面層級索引；「課堂教材」保存同一版面下每份 PDF 的名稱、說明、排序與 R2 檔案索引。
- 「問答區」保存 `materialId` 及相對於 PDF 頁面的圖釘百分比座標，因此不同教材不會互相顯示，縮放後仍能對準原位置。
- 「答案遮罩」獨立保存 `materialId`、頁碼與矩形百分比座標；教師在編輯頁拖曳建立遮罩，課堂投影預設遮住且可由教師在目前裝置揭示，學生頁固定遮住不可自行撤下，編輯頁與批改彈窗維持原文可見。
- 學生點選問答圖釘後，PDF 上的目前圖釘會高亮，作答卡會自動聚焦；手機作答卡提供上一題／下一題導覽，依目前教材的頁碼與題目順序切換。
- 「教師手寫」與「課堂狀態」保存 `materialId`，教師切換教材時只讀取目前教材的頁面與筆跡；學生端約每 3 秒嘗試同步教師切換的教材，但頁碼、縮放與閱讀位置保留在學生自己的裝置，自己的作答清單約每 6 秒嘗試更新一次，實際更新速度仍受請求耗時影響。
- 「作答紀錄」與學生草稿保存 `materialId`，作答 ID 也依教材隔離；內容包含暱稱、文字答案、照片檔案索引、教師批改狀態與評語。
- 「公告連結」是公開入口共用的學生常用入口，保存標題、選填簡要說明、最多 8 個 `http`／`https` 連結及各連結名稱、置頂、排序與狀態；只有教師管理頁可新增、修改、刪除及調整順序，教師課堂公告抽屜只提供安全的新分頁開啟，個別學生頁不掛載公告。
- 線上模式的公告直接讀寫 Worker，不進入離線快取或背景補傳佇列；本機示範模式則沿用 IndexedDB 保存示範資料。
- 「檔案索引」保存 R2 物件鍵與 `materialId`。照片、PDF 與大型 JSON 不直接塞進 D1 資料表欄位。
- 教師可從版面卡片或編輯頁永久刪除版面；刪除時會一併清理 PDF、問答區、學生作答、照片、教師批改、手寫筆跡、JSON 附件、R2 物件與本機快取。
- 所有新增、修改、封存、刪除教材、刪除版面、作答與批改都先寫入瀏覽器 IndexedDB，再依序放入 outbox 背景傳送；傳送失敗會保留佇列，不用遠端回應覆蓋較新的本機內容，並以 mutation ID 讓 Worker 重試具備冪等性。
- 教師筆跡以相對座標 JSON 保存，課堂輪詢只在版本變更時讀取 R2；已讀過的 PDF 與照片也會以檔案 ID 快取在本機。
- 學生端課堂同步只下載目前頁面的教師筆跡，並先顯示本機快取的頁面內容；網路更新完成後再替換為最新版本。
- 學生端與課堂端呼叫 `classroomPulse` 取得版本與課堂狀態；新版以 `includeChanges` 要求有變更時在同一個回應附上資料，省去第二次請求，無變更時仍維持輕量回應。舊版後端則沿用兩段讀取。
- D1 查詢結果會短暫快取，因此直接手動修改資料表後，最多可能延遲數秒反映；作答計數另以較長快取降低課堂輪詢負載。

## 第一版邊界

- 主要目標為單班約 30 人的課堂使用。
- 教師端支援手寫筆、螢光筆、圖形、橡皮擦、本頁清除與全部清除；系統依輸入來源分流，觸控筆或滑鼠直接書寫，手指可用來滑動並捏合縮放 PDF。
- 課堂與批改區預設筆畫粗細為 2，可再選擇 4、6、8；手指預設用於捲動與縮放，也可由工具列切換為手指書寫；橡皮擦請由工具列或鍵盤 `E` 切換，避免提筆再落筆被誤判為雙擊。
- 學生不使用畫筆，學生答案以文字與壓縮照片為主。
- Workers 版採定時同步，不做多人同一畫布的即時共同書寫；學生端約每三秒嘗試取得教師目前教材與該教材的頁面筆跡，同一代只保留一個同步請求，失敗後延長重試間隔，教材切換或頁面隱藏時會取消過期請求。
- 教師課堂 PDF 的頁碼、縮放與手寫標記採落筆後批次同步；學生端只跟隨教師切換的教材，自己的頁碼、縮放與閱讀位置不被教師狀態覆寫，網路逾時或斷線時改用本機快取，恢復連線後再由 outbox 補傳。
- 不納入 Firebase、Google 帳號登入、AI 評分、語音回答與正式版本歷史。
- 學生照片預設在瀏覽器端壓縮至寬度 800px，並限制每題張數與大小。

## 注意事項

學生只填暱稱時，身分辨識屬於課堂活動等級，不是正式帳號系統。若日後要長期保存成績、跨班管理或公開提供服務，應追加真正的權限驗證、資料保留政策與更嚴格的檔案存取規則。
