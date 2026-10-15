# Musicmap 中文閱讀版

Musicmap 的本機簡體／繁體中文閱讀版本，保留原站音樂地圖、縮放、流派導覽、播放清單及英文還原，提供中文搜尋。DeepSeek 只在建置前翻簡體；繁體由 OpenCC 與凍結術語產生，瀏覽網站與切換語言均不呼叫模型。

**完成狀態（2026-10-15）：562／562 個唯一正文（572 映射）＋1338／1338 個獨立介面／圖上標籤，共 1900 個來源，簡繁完整覆蓋。** 正式 build 為非 partial；三語雙裝置的1608次流派、1824次靜態映射、全部標籤／圖說、英文還原與原事件導航驗收通過。付費續作已在172次停止；私人完整成品見 [Releases](https://github.com/Mizimo/musicmap-zh/releases/latest)。操作見 [全站流程](docs/FULL-SITE.md)，代理接手先讀 [AGENTS.md](AGENTS.md)。

## 使用完整成品

倉庫維持私人可見；通過驗收的完整網站以私人 GitHub Release asset 提供。Git 原始碼不含原站資產、完整譯文、密鑰或付費 journals。下載成品與 `.sha256` 後：

```bash
sha256sum -c musicmap-zh-complete-2026-10-15.tar.gz.sha256
tar -xzf musicmap-zh-complete-2026-10-15.tar.gz
cd musicmap-zh
sha256sum -c SHA256SUMS.txt
node server.mjs
```

需要 Node.js 22 或更新版本，不需安裝依賴或 API Key，開啟 <http://localhost:4173>。也可使用 Python：

```bash
python3 -m http.server 4173 --bind 127.0.0.1 --directory dist
```

以 HTTP 從網站根目錄提供 `dist/`，勿直接以 `file://` 開啟 HTML。外部 YouTube／Spotify 播放仍需網路。

## 開發與驗證

```bash
npm ci
npm test
npx playwright install chromium
```

一般與 pilot／50%／80%／全站控制流程的254項測試均使用自編 synthetic fixture 與 mock API，不需私人來源／journals，不產生付費請求。10／271／224／172 cap、未知停止、重啟不重付費與 hash proof 仍為必要測試，新 clone 不會跳過這些門檻。

真實 450 份正文／25 筆復原證據的整合核對另行執行：

```bash
node test/historical-evidence.integration.mjs
```

此明確的本機整合檢查需要另保管的私人封存；缺資料時會報錯並標示未通過，不下載、靜默跳過或以 synthetic 結果冒充真實證據。實際發布仍須通過真實資料的完整建置與瀏覽器驗收。

本輪已完成並停止。下列命令供持有完整私人工作資料者核驗及重建；`--prepare`／`--execute` 不代表新的付費授權，也不會重置已用完的172次額度。新 clone 僅含程式與自編測試；原來源快照、450份父成果及新成果需另行私下保管，不能用新來源或退役碎片快取取代：

```bash
node scripts/complete-site.mjs --prepare
node scripts/complete-site.mjs --status
# 授權、prepare 與離線檢查通過後：
node scripts/complete-site.mjs --execute
# 全部 1900 source 有有效結果並停止後：
node scripts/complete-site.mjs --build
node test/full-site-browser.mjs
node test/full-site-navigation.mjs
node scripts/package-full-site.mjs --check
node scripts/package-full-site.mjs
```

固定 `deepseek-v4-pro`、thinking enabled、`reasoning_effort=max`、`max_tokens=32768`、非串流、600 秒逾時及單工。正文一次翻完整章節／段落，格式標記並非拆詞單位；獨立標籤最多 20 個或 14000 字元一組。字典／術語的確定性復用逐項保存 provenance。

請求先持久 reserve／started，再送 HTTP；模型與已知用量逐筆核驗。失敗及未知占名額，不自動付費重試；已保存成功回覆與核定的純格式復原可免費重匯。來源、prompt、術語、程式與父 run 都凍結，歷史未知用量維持未知。原網路失敗只核定一次新ID補發；三筆標籤缺項的54個原輸出以人工hash proof保留，6個缺項併入未送尾組20項後實際完成，沒有額外請求名額。完整歷史為613次續作，首輪10次另計；2筆歷史未知用量不算零。

正式 build 要求簡繁全部有效覆蓋及來源、簡體、繁體、術語四 hash 一致。兩處動態 SVG 圖說採正式 adapter 定位原 label，保留 SVG／label 節點與英文還原；原手機版面限制保留，以原 wheel zoom 驗證。

## 術語、來源與資料

`data/terminology.json` 定義英文別名及簡繁偏好；繁體用 `opencc-js` 1.4.2 `cn → tw` 再按英文語境校正，例如 Blues → 布鲁斯／藍調、Grunge → 垃圾摇滚／油漬搖滾。流派家族与術語表保留可見英文身分。

原站與地圖屬於 [Musicmap](https://musicmap.info/)，本專案為非官方本機閱讀工具。成品保留原站署名、來源與版權，私人交付不改變原內容授權。

密鑰僅透過本機 `DEEPSEEK_API_KEY_FILE`／`DEEPSEEK_API_KEY` 使用，不提交 `.env`。`.gitignore` 保護 `.cache/`、`generated/`、`dist/`、`artifacts/`、依賴與 journals；完整成品走驗證後的私人 Release asset。

## 歷史版本

舊 Pro Max 文字節點基線、撤回五批及關閉思考續作分別封存。完整章節十批原 10 章／30 段保留；50% run 實際在 226 正文／217 嘗試停止，末筆未知；80% run 完成 450 正文／460 映射、224 新嘗試，4 原 failed journals 的免費復原分列，歷史續作 441 次。此次新 run 復用 450，不重置舊額度或未知歷史。

見 [版本標記](docs/VERSION-MARKERS.md)、[歷史首輪](docs/CHAPTER-PILOT.md) 與 [交付](docs/DELIVERY.md)。舊碎片命令及恢復 worker 只供查證，已由 retirement guard 停用。
