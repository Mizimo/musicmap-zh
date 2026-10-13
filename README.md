# Musicmap 中文閱讀版

在本機部署的 Musicmap 簡體／繁體中文版本。保留原站 SVG 音樂地圖、縮放拖曳、流派連線、介紹中的連結與播放清單，另加簡體／繁體／英文切換與中文流派搜尋。

**DeepSeek 只將英文翻成簡體一次，再用本機 OpenCC 產生繁體並校正音樂術語。瀏覽網站及切換語言不會呼叫 DeepSeek，也不需要 API Key。** 繁體轉換不用模型，不增加 API 費用；DeepSeek 僅供建置前的簡體批次翻譯及日後新增內容。YouTube／Spotify 播放仍需連網。

2026-10-13 已選定 **DeepSeek V4 Pro／Max**，進入全站正式翻譯階段，採 8 個可續傳分片；尚未通過完整驗收前，不要將開發預覽視為完整中文譯本。操作與狀態查詢見 [正式翻譯交接](docs/PRODUCTION.md)，代理接手前請先讀 [AGENTS.md](AGENTS.md)。

2026-10-13 模型片段對比與 Astra 補測已完成：18 個請求配置、17 組成功、68 段譯文；Ultra 被後端拒絕。詳見 [結果與交接紀錄](benchmarks/RESULTS-2026-10-13.md)。完整匿名報告與原始結果由本機資料包交付，不包含於 Git。

## 本機啟動

需要 Node.js 22 或更新版本。首次下載來源需要網路；完成後使用同一份來源快照。

```bash
npm ci
npm run sync
cp .env.example .env
# 在本機編輯 .env，填入 DEEPSEEK_API_KEY。不要把金鑰提交或貼進聊天。
npm run translate -- --dry-run
npm run translate
npm run convert
npm run build
npm start
```

開啟 <http://localhost:4173>。`npm run translate` 預設只處理 `zh-Hans`，也可明確加上 `--language zh-Hans`；`--language zh-Hant` 會被拒絕，繁體一律用 `npm run convert` 產生。

`npm run build` 會拒絕簡繁未完成的版本，也會檢查繁體是否仍對應目前的簡體、來源及術語表。修改簡體或術語後先重新 `npm run convert`。只想檢查介面時可對現有簡體執行轉換，再用 `npm run build -- --allow-partial`；轉換不會補出缺少的簡體內容，狀態仍為 `complete: false`，頁面會標示翻譯未完成。

完整產物在 `dist/`，可交由任意靜態 HTTP 伺服器從網站根目錄提供，不需要 Node 翻譯服務或 `.env`。不要用 `file://` 直接開 HTML；瀏覽器載入 JSON／ES modules 需要 HTTP。內附 `npm start` 僅綁定本機 `127.0.0.1`。

## 多台機器分批翻譯

詳見 [AGENTS.md](AGENTS.md) 中的工作分派、快照、斷點續跑與驗收規則。所有機器使用**同一個 Git commit、同一份來源快照、同一版術語表與翻譯設定、相同分片總數**。開始前記錄 `data/terminology.json` 的 `version` 與 `terminologyHash`，整輪凍結，交接時一併核對。

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
npm run translate -- --language zh-Hans --shard 1/8 --dry-run
npm run translate -- --language zh-Hans --shard 1/8 --limit 100
# 反覆執行同一指令會接續缺少的項目；移除 --limit 可完成此分片。
```

`1/8` 表示第 1 個分片，共 8 片。其他工作機分別負責 `2/8` 至 `8/8`；只分派簡體 `zh-Hans`，整輪共 **8 個翻譯工作**。`--limit` 是本次新增翻譯的字串數上限，並非 token 或費用上限；字典預填不計入，快取復用的項目仍計入。**不要讓兩個程序同時寫同一個分片。**

把工作機的 `generated/shards/*.json` 收回協調機的 `generated/shards/`，再執行：

```bash
npm run merge
npm run translate -- --dry-run
npm run convert
npm run build
npm start
```

合併只接受 `zh-Hans`，會驗證來源版本與分片歸屬；同一原文出現不同譯文時明確報錯，不會悄悄覆寫。術語版本需在交接時核對，不能只看分片可合併就認定用詞一致。缺片可先合併並轉換已有內容，完整度仍會誠實標示；正式建置直到簡體完整、繁體完整且未過期才通過。

## 簡繁用詞與術語審閱

`data/terminology.json` 以英文名稱與別名對照簡繁偏好詞。DeepSeek 翻簡體時會使用相關詞條；`lib/chinese-conversion.mjs` 先用 `opencc-js` 的 `cn → tw` 轉換，再依英文來源語境校正術語。例如：

| 英文 | 簡體偏好 | 繁體偏好 |
| --- | --- | --- |
| Blues | 布鲁斯 | 藍調 |
| Grunge | 垃圾摇滚 | 油漬搖滾 |
| Rap | 说唱 | 饒舌 |

繁體預設採 `zh-TW` 的專案用詞偏好，表中的譯名不是所有地區或音樂社群的唯一標準。正式使用前需審閱術語表與代表性段落；有歧義時保留英文辨識，不要只靠字形轉換推定流派含義。

流派家族、地圖高層標籤與術語表會在中文旁附上可見的原英文，方便辨識分類與地區用詞差異；切回英文會完整還原。

修改繁體術語後，重新 `npm run convert` 即可產生繁體，不必重跑付費翻譯。修改簡體術語不會自動改寫已完成、已審閱的簡體譯文；應先找出受影響文字，針對性審閱或規劃重置，再更新對應分片／語言檔與繁體。不要清空所有快取或盲目重跑全站付費任務。

`scripts/convert.mjs` 會寫出 `generated/locales/zh-Hant.json` 和 `generated/conversion-status.json`。狀態包含 `sourceHash`、`simplifiedHash`、`traditionalHash`、`terminologyHash`；建置以這些資料檢查輸入與產物一致，防止簡體或術語改了卻繼續使用舊繁體。繁體檔是可重建產物，長期修訂優先寫入術語表或簡體來源，再重新轉換。

## 目錄與資料

| 路徑 | 用途 | 提交 Git |
| --- | --- | --- |
| `public/` | 中文介面、基礎 UI 字典 | 是 |
| `data/terminology.json` | 英文別名、簡繁專業術語及版本 | 是 |
| `scripts/`、`lib/`、`test/` | 來源快照、簡體批次翻譯、繁體轉換、建置、驗證 | 是 |
| `.env` | 每台機器自己的 DeepSeek Key | 否 |
| `.cache/source/strings.json` | 固定來源字串清單 | 否，隨來源快照傳送 |
| `.cache/translations/` | 可續跑的逐字串翻譯快取 | 否 |
| `generated/site/` | 原站來源快照 | 否 |
| `generated/shards/` | 跨機器交換的簡體翻譯分片 | 否，單獨傳送 |
| `generated/locales/` | 簡體譯文與本機產生的繁體語言檔 | 否 |
| `generated/translation-status.json` | 實際翻譯完成度 | 否 |
| `generated/conversion-status.json` | 繁體轉換完整度及來源／簡繁／術語 hash | 否 |
| `dist/` | 本機可部署的完整靜態網站 | 否 |

來源更新時由協調機執行 `npm run sync -- --force`，重新凍結快照、術語版本與分派工作。舊來源的分片不可直接混入新一輪；符合相同翻譯設定的未變動原文快取可復用。初始快照含 268 筆流派資料、7,801 個文字片段，約 51.6 萬英文來源字元，只需安排簡體翻譯；這不是 token 數或收費估價。

## 片段翻譯對比

`npm run benchmark` 只預覽配置；`npm run benchmark -- --execute --run-dir artifacts/translation-benchmark/my-run` 才會呼叫模型並消耗用量。共 18 組請求配置：DeepSeek V4.1 Flash、V4 Pro 各 low/high/max；Codex GPT-6.1 Sol、GPT-6 Astra、GPT-6 Sol 各 low/medium/high，另加 Astra xhigh/ultra/max。Ultra 未列於官方模型文件；此項精確傳送使用者要求的值，以後端實際回傳或拒絕為準，不保證支援、不替換檔位。Codex 使用本機已有的 OAuth 登入與 pi-ai adapter；詳見 [AGENTS.md](AGENTS.md)。

補測可用 `--only` 指定一個或以逗號分隔的多個配置，例如 `--only gpt-6-astra-xhigh,gpt-6-astra-ultra,gpt-6-astra-max`。在既有 run 加入配置須另加 `--append-configurations`，保留舊 manifest 歷史與原有結果；提示、原文、術語及價格 hash 必須一致。匿名報告會保留已存在的代號，替新增配置追加代號。

每組翻譯同樣四段自編音樂領域英文，並保留原始簡體輸出，不是 Musicmap 原文，也不直接加入網站語料。執行 `npm run benchmark:report -- artifacts/translation-benchmark/my-run` 產生離線匿名比較頁、完整文字報告與用量 CSV。品質由使用者判斷，工具不評分、不排名。

用量包含輸入、輸出、快取與 API 有回報的推理 token。[計價文件](benchmarks/PRICING.md) 列出官方價格、來源與公式；Codex 金額只表示 API 等價，不表示訂閱帳單扣款。未回報的計費欄位保留為未知或費用上下界。之後重跑需重新核對當日價格及 DeepSeek 尖離峰。

## 程式驗證

```bash
npm test
npx playwright install chromium
npm run convert
npm run build -- --allow-partial
npm run test:browser
```

瀏覽器測試會自啟測試用靜態伺服器、封鎖外部網路，檢查簡繁／英文切換、中文搜尋、地圖操作及動態介紹，並確認沒有翻譯 API 請求。模型輸出使用 mock 驗證快取、斷點續跑與分片合併；不會在測試中消耗真實 DeepSeek 額度。

## 來源與設定

原始網站與地圖屬於 [Musicmap](https://musicmap.info/)，此專案是非官方本機閱讀工具。倉庫不包含原站資產或全文；同步產物不提交。若要公開發佈原站內容或其完整譯文，需自行確認原作者的授權條件。不要刪除來源與版權標示。

DeepSeek API 依[官方文件](https://api-docs.deepseek.com/)使用 Chat Completions 介面，預設 `deepseek-v4-pro`、開啟思考與 `reasoning_effort: max`。可用 `DEEPSEEK_API_KEY_FILE` 讀取本機專用密鑰，優先於 `DEEPSEEK_API_KEY`。正式輪的設定與來源在 manifest 凍結，不要途中切換模型。API 只負責簡體，繁體轉換及網站建置不需要 Key。
