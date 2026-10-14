> **目前授權（2026-10-15，全站完成＋GitHub 同步；取代下方450停點）**：已 inspect 主要窗口核對人類原話「推進到全部完成並同步github」。主要窗口執行範圍為 562 唯一正文／572映射＋1338獨立UI／圖上標籤＝1900來源；正式 build 簡繁全覆蓋後才可稱完成。独立新入口 `node scripts/complete-site.mjs --prepare|--execute|--status|--recover|--build`，新 run `artifacts/full-site/2026-10-15-complete/`，帳本 `generated/production/full-site-complete.json`。復用450正文及25本機復原；原詞典／術語正規化可核驗prefill164，剩112正文＋1174標籤／59組，計畫新請求上限171（歷史續作612、pilot十次另計）。上述數字和private release成品安排屬主要窗口解讀，不冒充使用者逐字要求。原body prompt／來源／catalog／術語與Pro thinking/max/32768固定，label獨立身分／嚴格用量驗證、單工Restart=no；不自動付費重試，新增unknown即停並回報。保留所有舊run、ledger、journal與unknown；父run凍結後不再寫入或增檔。全面三語雙裝置與私有入口驗收後更新既有预覽，再同步Mizimo/musicmap-zh私人repo main及不含密鑰／journal／node_modules的本機成品release；逐項審閱變更，非force，不把私人網址、session ID或私人資料寫進通用repo文件。caption adapter納入正式build可追蹤程式，不改UI、不做新對照報告。授權工作證據在 `generated/production/full-site-authorization.json`。

> **目前執行狀態（2026-10-15，付費停止）**：有效正文 **487／562**、獨立標籤 **164／1338**，全站尚未完成。新帳本為 `review-required`，本輪 **38／171 次**（37 completed＋1 unknown）；第 #38 次連線失敗，原 HTTP／回傳模型／usage 都是 null，不得寫成零費用或成功。`musicmap-full-site.service` 的 `MainPID=0`、`Restart=no`。單次補發仍待人類決定，pending 草稿未授權、未安裝，不能據此恢復 API 或提高上限。已測試源碼與通用文件可先同步私人 GitHub；正式 complete 建置／驗收、完成狀態文件及完整私人成品 release 仍是本輪待完成事項，不得宣稱全站完成。

> **歷史停點（2026-10-14，80% 已交付；已由上方全站授權取代）**：正文恰好 **450／562 個唯一 source（460 處映射）**，帳本 `target-reached`；本次 **224／224 次**、歷史 **441 次**，原十批另計。224 筆原 journal 為 220 completed＋4 failed，4 筆均有本機復原 sidecar；舊 #217 unknown／usage null 與全部歷史保持原樣。翻譯服務 `musicmap-chapter-80pct.service` 已停止（`MainPID=0`、`Restart=no`），不得因接手、驗收或重建而繼續付費請求。merge／原術語 OpenCC／partial build 已完成；215 個回歸測試、348 次 genre 語言檢查、1824 次靜態映射檢查，以及 Tailnet 真實中文搜尋／原站隱私連結開關均通過。未翻正文維持整章英文回退，保留未完成標示，沒有 UI 改版或新對照報告。

> **歷史80%預覽與重建**：歷史私有／本機入口僅記錄於本機工作證據，建置位於 `artifacts/chapter-continuation/2026-10-14-body-80pct/workspace/dist/`。8444 僅限 Tailnet，其他 Serve 端口不變。兩處原站動態 SVG 圖說採版本化、僅作用於衍生 build 的 adapter；不改凍結來源、翻譯或原 renderer。若重新建置，依序執行 `node scripts/continue-chapters-80.mjs --build` 與 `node artifacts/chapter-continuation/2026-10-14-body-80pct/apply-preview-caption-fix.mjs`，重新驗收後才更新預覽。證據在同 run 的 `preview-runtime-amendment.json`、`browser-verification.json`、`preview-http-verification.json`、`tailnet-navigation-verification.json`、`preview-deployment-verification.json`。genre 正文沒有 inline anchor；實際連結點擊驗收使用原站 privacy link／原 close 按鈕，不能以空 anchor 清單宣稱 genre 內鏈點擊通過。

> **歷史授權（2026-10-14，80%續作）**：已在主要窗口原訊息核實使用者原話「可以繼續推進musicmap到80%」。主要窗口設定執行邊界為恰好 **450／562 個唯一正文 source**（約 80.1%），先核驗復用既有 **226** 個，最多新增 **224 次請求**；連同舊 217 次續作嘗試，歷史上限 **441 次**，原十批另計。這些精確數字與補發安排是主要窗口的執行解讀，不冒充使用者逐字原話。第一筆新請求可補發舊 #217 `genre:hou03`，使用新 ID 並連結舊 request；原未知用量／結果永遠保留，可能重複計費。不自動付費重試，失敗占名額；新增未知用量／身分、不確定語意修補、有效基數不同或無法在上限內到 450 即停止回報。沿用已驗證且可確定的本機格式復原。固定 `deepseek-v4-pro`／thinking enabled／`reasoning_effort=max`／`max_tokens=32768`／非串流／單工／`Restart=no`，原 prompt、來源、catalog、術語皆不變。新入口 `node scripts/continue-chapters-80.mjs --prepare|--execute|--status|--recover|--build`，獨立帳本 `generated/production/chapter-continuation-80pct.json`，run `artifacts/chapter-continuation/2026-10-14-body-80pct/`。原 50% run、帳本、停止快照、原十批與封存證據保持不變，另存完整父 run 快照。啟動前通過精確停點、額度、復用與未知停止等離線測試。450 後 merge、OpenCC、partial build、實際瀏覽器驗收並沿用私有預覽；保留整章英文回退，不做新報告、不改 UI、不恢復舊碎片入口。授權證據在 `generated/production/chapter-continuation-80-authorization.json`。

> **歷史授權（50%，已由上方 80% 取代；舊 run 不再執行）**：舊目標 281／562、最多 271 次。實際停止在有效 226、已嘗試 217，其中 #217 連線失敗且用量未知。帳本 `generated/production/chapter-continuation-50pct.json`、run `artifacts/chapter-continuation/2026-10-14-body-50pct/` 均保留原樣，不重置、不改成零費用或成功。

> **歷史首輪停點（2026-10-14）**：完整章節首輪已完成 **10/10 次、10 章／30 段**，零失敗、零重試，70,350 tokens（輸入 11,775；輸出 58,575，其中思考 52,553），保存價表估算 US$0.121790064。狀態 `awaiting-review`，十次名額已全部用完；不得續跑、重置額度或另建 run 繞過。原始程式基線／全部歷史已歸檔；新稿只在隔離工作目錄，未正式採用、未覆蓋原預覽。報告在 `artifacts/chapter-pilot/2026-10-14-pro-max-10/report.html`。後續只准本機驗證／報告整理；任何追加翻譯需要使用者新的範圍指示。

> **歷史首輪授權（2026-10-14）：舊碎片版已封存退役。** 使用者已批准以優化前基線實作完整段落／章節翻譯，首輪只准 10 次 API 嘗試（失敗亦占名額、不自動重試）。固定 `deepseek-v4-pro`、thinking enabled、reasoning_effort=max、max_tokens=32768。全部歷史成果在 `artifacts/archives/v1-fragments-retired-2026-10-13T17-08-57Z/`；唯一新入口為 `npm run production -- --chapter-pilot --prepare|--execute|--status|--report`。先通過離線測試才執行。十次完成後停止並作對照報告，不能续跑全站、採用舊碎片快取或覆蓋現有預覽。`generated/production/retired.json` 優先於下方全部歷史授權。新執行紀錄：`artifacts/chapter-pilot/2026-10-14-pro-max-10/`。

# 接手本專案的 Agent 請先閱讀

> **使用者暫停指示（2026-10-13）**：本輪在目前已送出的批次完成並保存後暫停。不得送出下一批、重試失敗批次、啟動任何翻譯／恢復服務，或自行恢復完整跟進。須等使用者明確要求續跑；本機暫停狀態見 `generated/production/independent-mode.json`。Pro / Max 與思考模式固定保留，尚未套用討論中的省 token 架構。


## 已確認的目標與目前狀態

使用者要的是**本機部署、全站預先翻譯完成的 Musicmap 簡體／繁體版本**，並可切回英文。不是逐頁現翻、不是 API 代理網站、不是另畫一張簡化音樂地圖。

目前階段：2026-10-13 使用者已選定 **`deepseek-v4-pro / max`**，並明確要求「開始推進」，授權正式簡體翻譯。採現有凍結來源、8 個固定分片；可在本機執行，亦可安全交接到不同機器。DeepSeek 只翻簡體一次，繁體由 OpenCC 與術語校正產生。完整度以 `npm run production -- --status` 為準，不要因程序已啟動就宣稱「全站已翻譯」。正式結果必須通過簡繁完整度、轉換版本檢查及瀏覽器驗證。

同日使用者進一步要求**完整跟進整個項目**。Agent 應持續檢查運行與失敗紀錄、處理有限重試，直到全站翻譯、簡繁轉換、正式建置、驗收、私下交付及 GitHub 文件整理完成；不能把背景程序啟動當作交付完成。已授權範圍內的格式錯誤重試不必反覆要求使用者確認，但每次保留原紀錄及費用；同批再次失敗時先診斷或縮小批次，不可無限重試。

本輪專用 API 密鑰在 `~/.ssh/musicmap_trans`，**它是 DeepSeek API key，不是 SSH 私鑰**。`.env` 使用 `DEEPSEEK_API_KEY_FILE` 指向它，優先於舊的 `DEEPSEEK_API_KEY`；不複製進 Git 或交接包。該檔及 `.env` 權限應為 0600。GitHub 仍使用 Mizimo 的既有登入。

GitHub 擁有者固定為 **Mizimo**，倉庫為 **Mizimo/musicmap-zh**。使用者明確禁止建在 kaede／Fukikaede 帳號。GitHub 寫入前核對 `gh api user --jq .login`；不得為方便而改用其他帳號。既有倉庫保持私人可見性，除非使用者另有指示。

## 不可破壞的架構

1. DeepSeek 只在 `scripts/translate.mjs` 的建置前流程翻譯 `zh-Hans`；`--language zh-Hant` 必須拒絕。繁體使用 `scripts/convert.mjs` 與 `lib/chinese-conversion.mjs` 在本機處理：`opencc-js` 的 `cn → tw` 加英文來源語境的術語校正，不呼叫模型、不增加 API 費用。`public/` 與靜態 `server.mjs` 不可加上執行期翻譯 API。
2. `dist/` 必須包含原站使用到的本機資產與兩種語言檔，不依賴原站才能閱讀。外部串流音樂、外站連結仍需要網路。
3. 保留 SVG 結構、`data-code`、座標、`tspan`、縮放拖曳、連線與事件處理。翻譯只改文字節點及可翻譯屬性。不要用整段 `innerHTML` 覆蓋流派介紹，會破壞內部可點擊連結。
4. 英文原文需可還原；中文搜尋必須能定位原站流派。不要僅改原站英文搜尋的畫面，原搜尋程式的 `\b` 比對不支援中文。
5. YouTube API 不存在或載入失敗時，地圖與介紹仍須運作。相容性補丁只作用在 build 產物，`generated/site/` 原始快照不得手改。
6. 未完成翻譯只可用 `--allow-partial` 產生明確標示的開發預覽。不可調整狀態檔、複製英文假裝譯文，或關閉正式建置檢查來假報完成。
7. `generated/conversion-status.json` 的 `sourceHash`、`simplifiedHash`、`traditionalHash`、`terminologyHash` 必須對應目前來源、簡體、繁體及術語表。簡體或術語改動後重新轉換；不得移除過期檢查來接受舊繁體。

## 每次接手的起手式

閱讀 `README.md`、本檔、`package.json`、`data/terminology.json`，檢查 `git status --short`。保留他人的未提交變更。先確認此次任務是程式開發、來源同步、某個簡體分片翻譯、合併、繁體轉換或驗收，避免未授權的全量付費翻譯。

翻譯任務先取得：

- 精確 Git commit、來源快照檔及來源 hash。
- 術語表的 `version` 與 `terminologyHash`，以及已凍結的字典、prompt、模型與 endpoint 設定。
- 語系固定為 `zh-Hans`；不要再分配繁體 API 翻譯。
- 分片：例如 `3/8`；分片總數整輪固定。
- 本次 `--limit`，或已授權完成該片。
- 工作機名稱及產物回收位置。

一般沒有使用者翻譯授權時，缺少任務分片只能先檢查與 dry-run。本次正式輪已獲授權，由 `scripts/production.mjs` 固定分配 `1/8` 至 `8/8`，不可重複要求同一授權，也不可在活躍分片旁另開重複程序。

## 本輪正式翻譯

**目前採獨立分片續跑模式（2026-10-13）**：為減少單片格式失敗造成的整體停等，原 `musicmap-translation` 與 `musicmap-follow-through` 服務已停用，改用 `musicmap-shard-1` 至 `musicmap-shard-8`，每個 unit 只處理固定的一片且 `Restart=no`。啟動器為 `scripts/run-production-shard.mjs`，每次先核对凍結 manifest 與原協調服務已停止，再執行原翻譯 CLI；模型、來源、提示與分片鎖不變。失敗只對所屬分片做已診斷的有限處理，不能重啟全局監看器。切換紀錄在 `generated/production/independent-mode.json`；原 production 狀態保留 interrupted，分片覆蓋數仍有效，實際活躍程序以分片 unit／鎖為準。八片全部完整且停止後，才啟原 production 執行合併、轉換、建置及驗收；完整分片會跳過付費翻譯。詳見 [操作文件](docs/PRODUCTION.md)。

先閱讀 [正式翻譯操作與交接](docs/PRODUCTION.md)。使用 `npm run production -- --prepare` 凍結設定並分配現有簡體成果；`--execute` 依 manifest 執行；不帶參數或 `--status` 只讀取進度，不會呼叫 API。凍結後不可直接改模型、提示、上下文工具、術語、字典、來源或分片數。

請求固定開啟 thinking、`reasoning_effort: max`，單批最多 20 個目標片段、14,000 個來源字元，`max_tokens: 32768`，逾時 600 秒。段落與流派背景由本機快照產生，作為唯讀參考；不可把整段背景重複放進片段譯文。快取區分模型、檔位、提示、術語及上下文，避免拿舊 Flash／無思考輸出冒充 Pro／Max。

`generated/translation-requests/<scope>/` 每個實際 API 請求各有一筆紀錄，保存安全的設定、回傳 usage、價格估算與通過格式檢查的譯文，不保存 reasoning 內文或密鑰。送出前先寫 started；缺少 usage 的失敗費用維持未知。翻譯器本身不自動重試；先檢查原因和原紀錄，確定需要新的付費嘗試後才使用 `--retry-failed`。completed 紀錄可修復中斷後尚未匯出的成果，不需再付費。

本次完整跟進授權另允許 [有限恢復監看器](docs/FOLLOW-THROUGH.md)：只對已知用量、HTTP 200／stop 的格式錯誤，在服務完全停止且來源、上下文、設定及首批缺失片段逐項一致時補試原批次一次。整輪持久上限為 20 次補試、同時最多 2 個；不能重置 ledger 規避。重複失敗、未知用量、認證／網路錯誤與任何不一致交回人工診斷，不自動拆批。Agent 仍須持續跟進到驗收交付，不能只留下監看器。

每個分片有獨立鎖；看到殘留鎖時先核對 PID 與工作機，確定程序已結束才移除。背景正式程序不設定自動重啟；所有分片成功後才依序 merge、convert、正式 build 與瀏覽器測試。工作程序 active、簡體完成、建置完成、瀏覽器驗收通過是不同狀態，交接時清楚區分。

## 協調機：凍結與發送來源

```bash
npm ci
npm run sync
npm run snapshot -- export --output artifacts/musicmap-source.tar.gz
```

把同一個 archive、Git commit、術語版本／hash 和翻譯設定發給所有工作機。工作機不得各自 `sync --force`；原站可能隨時間更新，會造成不同版本。來源 manifest 中 `stringsSha256` 驗證字串檔案的原始位元組；分片 `sourceHash` 驗證 `JSON.stringify(strings)` 的標準序列化結果。兩者用途不同，**不能直接拿這兩種 hash 相互比較**。

術語版本與 hash 可用下列只讀命令記錄，工作機啟動前需核對相同值：

```bash
node --input-type=module -e "import { TERMINOLOGY, TERMINOLOGY_HASH } from './lib/terminology.mjs'; console.log(JSON.stringify({ version: TERMINOLOGY.version, terminologyHash: TERMINOLOGY_HASH }));"
```

整輪凍結 `data/terminology.json`、`public/dictionary.js` 及 prompt。術語表含 `version`、`traditionalLocale` 與詞條的英文別名、簡繁偏好；不要在工作機私下修改後混回同一輪。分片 wrapper 目前不保證附帶術語 hash，因此必須在任務紀錄和交接資料中核對，不能只靠 merge 的來源檢查。

首輪來源有 268 筆流派資料、7,801 個字串、516,413 個來源字元。實際數字以當次 manifest 為準，不能硬編碼完整度。

在協調者的工作紀錄記下 `(sourceHash, terminologyVersion, terminologyHash, language, index, count, machine, status, result file)`。例如固定 8 片，只分派 `zh-Hans`，共 **8 份翻譯任務**，合併後由協調機產生繁體；每個 tuple 只分配一個活躍程序。分片使用原文字串 SHA-256 取模，與遍歷順序無關；不要擅自改演算法。

## 工作機：翻譯、續跑、交付

```bash
npm ci
npm run snapshot -- import /path/to/musicmap-source.tar.gz
cp .env.example .env
# 只在本機安全設定 DEEPSEEK_API_KEY。
npm run translate -- --language zh-Hans --shard 3/8 --dry-run
npm run translate -- --language zh-Hans --shard 3/8 --limit 100
```

`--language zh-Hans` 可省略，預設即為簡體。`--language zh-Hant` 會拒絕執行，應改用合併後的本機轉換流程。同一命令可以反覆執行；每次處理下一批缺失字串。去掉 `--limit` 表示完成已指派的整個分片。`--limit` 按新增匯出的文字片段計數，字典預填不計入、快取命中計入；它不是精確金額或 token 預算。

每批輸出即原子寫入。網路、API、schema 或額度失敗時停止並保留進度；恢復後執行同一分片命令。不要刪 `.cache/translations/` 來重試，也不要把錯誤訊息或空字串存成翻譯。

交付 `generated/shards/zh-Hans-3-of-8.json`，附上 Git commit、術語版本／hash 與使用的模型設定。保留 wrapper 中的 `sourceHash`、`language`、`shard` 和 `translations`，不可只複製內部字典。產物是私下交換的工作資料，不會隨 Git push 同步，必須另外複製到協調機。機器換手時移交同一分片檔與凍結設定可接續；逐字串快取可選擇同步，不包含 Key。

**不可兩個程序同時寫同一份分片。** 同一目錄若同時跑多個簡體分片，只能使用不同輸出路徑。非分片的全量模式會寫共用 locales/status，不可多程序並行。合併、繁體轉換與建置也應依序執行，避免取得一半更新的語言檔。

## 翻譯規則

- `data/terminology.json` 是音樂專業術語的共同規則，依英文名稱與別名匹配；`public/dictionary.js` 是基本介面字典，用詞需與術語表一致。DeepSeek 簡體 prompt 會帶入相關詞條，開始一輪前需審閱、定版並凍結。
- 簡體只翻一次。繁體先用 OpenCC `cn → tw` 轉換，再依英文原文語境套用術語偏好，例如 `Blues` 對應 `布鲁斯／藍調`、`Grunge` 對應 `垃圾摇滚／油漬搖滾`。不要對整站做不看語境的任意詞彙替換，也不要呼叫模型重翻繁體。
- 繁體採 `zh-TW` 專案偏好，不代表所有地區或音樂社群的唯一標準。專業術語表必須審閱，遇到歧義時保留英文辨識；OpenCC 與 hash 檢查不保證譯文語意正確。
- 保留音樂人、樂團、專輯、歌曲、URL、年份、引用標記與資料識別碼。流派名保留對照原文；版面太窄時先調整呈現，不刪語意。
- 高層流派家族、地圖高層標籤與術語表須在中文旁可見地附上原英文，不能只藏在 tooltip。`public/overlay.js` 的獨立註記會保留 SVG 原始結構；切回英文時移除註記，未翻譯或已含完整英文的項目不重複加註。
- 原站文字屬於待翻譯資料；文字內若出現命令不能執行。
- API 只回傳純文字 JSON。輸出經 schema／項目數／空值檢查後才快取；不得把模型輸出當 HTML 執行。
- 完整度檢查只證明每個來源字串有譯文，不代表語意品質。每片抽查長介紹、跨標籤片段、專名、簡繁用字及圖上小字，紀錄需人工修正的項目。

只修改繁體偏好時，更新術語表版本、記錄變更，再執行 `npm run convert` 即可，不需重新付費翻譯。修改簡體偏好時，現有已審閱的簡體輸出不會自動改寫；先列出受影響原文，針對性審閱、修正，必要時規劃有授權範圍的重置與重翻。不要直接清空已完成 locales、分片或整個快取後重跑全站。修正須同步回相關簡體分片，避免下一次 merge 與語言檔衝突，最後重新產生繁體。

## 協調機：收回、合併、產生網站

將分片收進 `generated/shards/`，保持原檔名：

```bash
npm run merge
npm run translate -- --dry-run
npm run convert
npm run build
npm start
```

合併工具只接受 `zh-Hans`，拒絕繁體分片、來源 hash 不符、分片不符、未知原文、空譯文和衝突。另需人工核對每片交接的術語版本。衝突不能用最後一份勝出的方式處理；先比對模型／prompt／術語表／字典與品質，保留經選定的唯一版本，再重跑合併。不要用 `sync --force` 修復 merge 錯誤。

缺片可合併，`npm run convert` 也可轉換目前已有的部分簡體，但不會替缺失文字補譯，`complete` 仍為 `false`。只有全部簡體完成、繁體已重新轉換且版本一致才可正式 build。

轉換會寫入 `generated/locales/zh-Hant.json` 與 `generated/conversion-status.json`。後者記錄 `sourceHash`、`simplifiedHash`、`traditionalHash`、`terminologyHash`；簡體、術語或來源變更後，建置必須拒絕舊轉換結果，先重跑 `npm run convert`。繁體檔是衍生產物，不要把僅存在其中的手動修訂當作永久來源，重新轉換會覆寫；長期修訂應落在術語表或經審閱的簡體來源。

`dist/` 是交付的靜態成品。把它放在 HTTP 站點根目錄部署即可，瀏覽端不需要 API Key。本機轉換、merge 與 build 也不用 API Key。

## 驗證與交接

程式變更後執行 `npm test`。有 UI／來源／補丁變更時也執行：

```bash
npx playwright install chromium
npm run convert
npm run build -- --allow-partial
npm run test:browser
```

正式成品驗收時用 `npm run build`（不加 partial）再測試。檢查桌面與手機版、簡繁／英文切換、中文搜尋定位、縮放拖曳、流派介紹與內部連結。封鎖外部網路時地圖仍能操作；不得發出任何 DeepSeek 請求。播放器在線播放需另行驗證，別把地圖離線通過當作外部音樂服務也通過。

正式程序完成後，交付前還需執行 `node test/complete-site.mjs`。它拒絕未完成或過期的 dist，使用真實資料巡覽所有流派／家族並產生完整 QA 證據。手機窗格採單窗格閱讀，須確認長標題、長文、家族／流派連結與收合控制可用，且閱讀工具列不遮住清單展開柄。來源抽取漏出的短語法片段需逐處審閱，不能全域刪除單字母或放寬空值驗證。

交接至少記錄 Git commit、來源 hash、術語版本與 hash、簡體分片、已完成／總字串、執行的命令、測試結果、產物路徑及未完成事項。網站驗收另附轉換狀態的四種 hash、繁體抽查結果。完整翻譯尚未做完就明確標示，不以「功能完成」含混帶過。

## 模型片段對比

使用者已授權本次（2026-10-13）15 組片段對比：DeepSeek V4.1 Flash／V4 Pro 各 low、high、max，Codex GPT-6.1 Sol／GPT-6 Astra／GPT-6 Sol 各 low、medium、high。這不授權全站付費翻譯或無限重試。一般 `npm test` 仍只用 mock。

同日使用者追加 Astra `xhigh`、`ultra`、`max` 三組補測，使用原四段、原提示、原術語與原計價快照。只執行這三個新配置，不能重跑前 15 組。官方 Astra 文件列有 xhigh/max，未列 ultra；請求與回傳檔位必須分別記錄，不能把拒絕或不同回傳值包裝成成功使用 ultra。`--only` 支援逗號分隔配置；`--append-configurations` 才允許既有 run 追加配置，並在 `manifest-history/` 保存舊 manifest。報告須保留原有 A–O 匿名標籤，新增 P–R。

`benchmarks/samples.json` 是自編的音樂翻譯測試文字，**不是 Musicmap 原文**。所有配置共用同一提示、術語表與英文片段；直接產生簡體，不經人工修改或 OpenCC。文字品質完全交由使用者判斷，不要產生品質分數或排名。

```bash
npm run benchmark
# 上面只預覽；以下明確消耗 API／訂閱用量。
npm run benchmark -- --execute --run-dir artifacts/translation-benchmark/my-run
npm run benchmark:report -- artifacts/translation-benchmark/my-run
```

執行器保存 prompt／source／pricing／glossary hash 與各組原始 usage。續跑會跳過所有已有嘗試，包括未完成／失敗，避免不明狀態下重複扣量。先檢查結果，必要的有限重試依現有授權範圍處理；原嘗試移至同一 run 的 `attempts/` 留存，不可刪除。報告會列出額外嘗試，合計已知用量及費用，未回傳用量的失敗保留為未知。沒有 quality evaluator，也沒有自動挑選最佳譯文。

2026-10-13 原輪與補測均已完成：18 個請求配置，其中17組成功，共68段譯文、19次請求。Astra Xhigh／Max 補測成功，Ultra 因 HTTP 400 檔位參數拒絕，沒有譯文或用量；不要替換檔位或重新嘗試。完整結果摘要見 [benchmarks/RESULTS-2026-10-13.md](benchmarks/RESULTS-2026-10-13.md)。Pro Max 首次未回傳有效 usage，第二次成功；不要將首次未知消耗算成零。本機產物在 `artifacts/translation-benchmark/2026-10-13-comparison/`，換機時另行移交整包，不能從 Git 推定本機產物存在。全部實測 DeepSeek 都是非串流；後加的可選串流 transport 只做 mock 驗證，沒有用來產生本次譯文。`execution-provenance.json` 保存原輪實際執行程式版本與 hash；`astra-supplement-provenance.json` 保存補測的獨立程式 hash、回傳結果與設定，`manifest-history/` 保存追加前的 manifest。

DeepSeek 從 `.env` 讀金鑰；Codex 從目前機器的 `~/.codex/auth.json` 讀已登入憑證（可用 `CODEX_AUTH_PATH` 指定），不把憑證保存進結果。Codex transport 使用本機 pi-ai adapter，可由 `MUSICMAP_CODEX_ADAPTER` 指定模組位置；更換機器後先確認相容版本與登入狀態。不得將 auth 檔案、金鑰、帳號資訊或完整 HTTP headers 加入報告。

費用以 `benchmarks/pricing.json` 與 [PRICING.md](benchmarks/PRICING.md) 的官方來源計算。未來重跑先更新價格、核對 DeepSeek 尖離峰及假日，必要時設定 `--deepseek-band peak|offpeak`。輸入總量包含 cache read/write；輸出已包含 reasoning，不能重複收費。缺少 cache-write 欄位時列上下界。Codex 是 **API 等價金額，不是訂閱實際扣款或額度百分比**。一次樣本無法代表整站品質、穩定延遲或精確全站預算。

`report.html` 預設匿名，使用者可自行揭示模型和費用。匿名標籤只是閱讀輔助，檔案仍嵌入模型對照；`report.md` 與 `metrics.csv` 含模型名稱。產物全部留在忽略的 `artifacts/`，可私下交付，不會自動修改正式翻譯語料。

## 密鑰保護

`.env`、`.cache/`、`generated/`、`dist/`、`artifacts/` 不提交 Git。不要 `git add -f` 繞過，也不要把 Key 放進 README、console、截圖或 issue。測試使用 mock，不消耗真實 API。

原站來源與完整譯文不自動公開發佈。GitHub 保存自寫程式、文件與測試；來源快照與工作成果透過本機檔案交換。保留原站署名及版權，不因這個工具推定取得原站重發布授權。
