# Musicmap 中文閱讀版

在本機部署的 Musicmap 簡體／繁體中文版本。保留原站 SVG 音樂地圖、縮放拖曳、流派連線、介紹中的連結與播放清單，另加簡體／繁體／英文切換與中文流派搜尋。

**翻譯在建置前一次完成。瀏覽網站及切換語言不會呼叫 DeepSeek，也不需要 API Key。** DeepSeek 僅供離線批次翻譯及日後內容更新。YouTube／Spotify 播放仍需連網。

目前是可執行的建置工具與中文閱讀介面，尚未完成全站批次翻譯；不要將開發預覽視為完整中文譯本。代理接手前請先讀 [AGENTS.md](AGENTS.md)。

## 本機啟動

需要 Node.js 22 或更新版本。首次下載來源需要網路；完成後使用同一份來源快照。

```bash
npm ci
npm run sync
cp .env.example .env
# 在本機編輯 .env，填入 DEEPSEEK_API_KEY。不要把金鑰提交或貼進聊天。
npm run translate -- --dry-run
npm run translate
npm run build
npm start
```

開啟 <http://localhost:4173>。`npm run build` 會拒絕任何簡體或繁體文字未完成的版本。只想檢查介面時可用 `npm run build -- --allow-partial`；頁面會標示翻譯未完成。

完整產物在 `dist/`，可交由任意靜態 HTTP 伺服器從網站根目錄提供，不需要 Node 翻譯服務或 `.env`。不要用 `file://` 直接開 HTML；瀏覽器載入 JSON／ES modules 需要 HTTP。內附 `npm start` 僅綁定本機 `127.0.0.1`。

## 多台機器分批翻譯

詳見 [AGENTS.md](AGENTS.md) 中的工作分派、快照、斷點續跑與驗收規則。所有機器使用**同一個 Git commit、同一份來源快照、相同分片總數**。

協調機只做一次來源同步，再輸出快照：

```bash
npm run sync
npm run snapshot -- export --output artifacts/musicmap-source.tar.gz
```

將快照檔安全複製至工作機；各工作機 clone 本倉庫後：

```bash
npm ci
npm run snapshot -- import /path/to/musicmap-source.tar.gz
cp .env.example .env
# 本機自行設定金鑰。
npm run translate -- --language zh-Hant --shard 1/8 --dry-run
npm run translate -- --language zh-Hant --shard 1/8 --limit 100
# 反覆執行同一指令會接續缺少的項目；移除 --limit 可完成此分片。
```

`1/8` 表示第 1 個分片，共 8 片。其他工作機分別負責 `2/8` 至 `8/8`；簡體 `zh-Hans` 同樣分派 8 片，共 16 個工作。`--limit` 是本次新增翻譯的字串數上限，並非 token 或費用上限；字典預填不計入，快取復用的項目仍計入。**不要讓兩個程序同時寫同一個分片。**

把工作機的 `generated/shards/*.json` 收回協調機的 `generated/shards/`，再執行：

```bash
npm run merge
npm run translate -- --dry-run
npm run build
npm start
```

合併會驗證來源版本與分片歸屬；同一原文出現不同譯文時明確報錯，不會悄悄覆寫。缺片可先合併，完整度仍會誠實標示；正式建置直到簡繁都完整才通過。

## 目錄與資料

| 路徑 | 用途 | 提交 Git |
| --- | --- | --- |
| `public/` | 中文介面、基礎術語表 | 是 |
| `scripts/`、`lib/`、`test/` | 來源快照、批次翻譯、建置、驗證 | 是 |
| `.env` | 每台機器自己的 DeepSeek Key | 否 |
| `.cache/source/strings.json` | 固定來源字串清單 | 否，隨來源快照傳送 |
| `.cache/translations/` | 可續跑的逐字串翻譯快取 | 否 |
| `generated/site/` | 原站來源快照 | 否 |
| `generated/shards/` | 跨機器交換的翻譯分片 | 否，單獨傳送 |
| `generated/locales/` | 合併後的簡繁語言檔 | 否 |
| `generated/translation-status.json` | 實際翻譯完成度 | 否 |
| `dist/` | 本機可部署的完整靜態網站 | 否 |

來源更新時由協調機執行 `npm run sync -- --force`，重新凍結快照與分派工作。舊來源的分片不可直接混入新一輪；未變動原文的快取仍可復用。初始快照含 268 筆流派資料、7,801 個文字片段，約 51.6 萬英文來源字元；簡繁分開翻譯，這不是 token 數或收費估價。

## 驗證

```bash
npm test
npx playwright install chromium
npm run build -- --allow-partial
npm run test:browser
```

瀏覽器測試會自啟測試用靜態伺服器、封鎖外部網路，檢查簡繁／英文切換、中文搜尋、地圖操作及動態介紹，並確認沒有翻譯 API 請求。模型輸出使用 mock 驗證快取、斷點續跑與分片合併；不會在測試中消耗真實 DeepSeek 額度。

## 來源與設定

原始網站與地圖屬於 [Musicmap](https://musicmap.info/)，此專案是非官方本機閱讀工具。倉庫不包含原站資產或全文；同步產物不提交。若要公開發佈原站內容或其完整譯文，需自行確認原作者的授權條件。不要刪除來源與版權標示。

DeepSeek API 依[官方文件](https://api-docs.deepseek.com/)使用相容的 Chat Completions 介面，預設 `deepseek-flash`；可在 `.env` 改 `DEEPSEEK_MODEL` 與 `DEEPSEEK_BASE_URL`。兩種語系分開快取，模型與 endpoint 也納入快取鍵。
