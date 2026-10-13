# 正式翻譯操作與交接

使用者於 2026-10-13 選定 `deepseek-v4-pro / max`，授權開始正式翻譯。只將英文翻成簡體一次，繁體由 OpenCC 與專業術語校正生成。原站快照、全部譯文與密鑰維持本機私有，不隨 GitHub 推送。

## 固定條件

- 來源：既有 7,801 個片段，來源 hash `bd953d18c41a7f5a18c6448882886578312885287bece9b376ca76c73dca861a`；不重新同步。
- 初始簡體：189 個既有字典／術語項，尚缺 7,612 個片段、514,250 個來源字元。
- 模型：`deepseek-v4-pro`，thinking enabled，`reasoning_effort: max`。
- 分片：固定 8 片，SHA-256 取模；每片只有一個活躍程序，最多 8 個工作程序。
- 請求：每批最多 20 個目標片段、14,000 個來源字元，另附有限的段落／流派參考；輸出上限 32,768 tokens，逾時 600 秒。這是輸出上限，不是預計消耗。
- 憑證：`.env` 中 `DEEPSEEK_API_KEY_FILE=/home/kaede/.ssh/musicmap_trans`；檔案只含 API key，權限 0600。換機時自行設定路徑和密鑰。
- 計價：以每次回傳 usage 及開始／結束時間套用尖離峰；reasoning 已包含在 output，不重複相加。缺少 usage 或日期未驗證時保留未知。

## 查詢與啟動

```bash
npm run production -- --status
npm run production -- --prepare
# 凍結並建立分片之後，可先驗證首批；同片不得已有工作程序。
npm run translate -- --shard 1/8 --limit 20
npm run production -- --execute --workers 8
```

`--prepare` 不呼叫 API；它凍結來源、程式、術語、提示相關檔案及模型設定，並把既有簡體依分片分配。`--execute` 先核對凍結設定，接续缺失項目。不要把 `--prepare` 當作清空重來的指令。全片成功後依序執行 merge、繁體轉換、完整建置與瀏覽器測試，只有全部成功才算執行完成。

本機長時間工作使用使用者層級 systemd transient service `musicmap-translation`，沒有 Restart 自動重試。查詢：

```bash
systemctl --user status musicmap-translation --no-pager
journalctl --user -u musicmap-translation -n 40 --no-pager
npm run production -- --status
```

不要在背景工作運行時重新執行相同分片。合併、繁體轉換與建置由協調程序在所有工作片結束後依序執行。

## 獨立分片模式

為避免一片格式錯誤令其餘七片停機，可由協調者明確記錄切換至獨立模式：保留原 manifest、journal 及 follow-through ledger，記下切換時間、manifest hash、原自動補試預留數與八個固定 unit 的分片對應。先讓正在執行的補試結束，再停妥 `musicmap-translation.service` 與 `musicmap-follow-through.service`；此模式期間兩者保持停止。

```bash
node scripts/run-production-shard.mjs                    # 只讀進度
node scripts/run-production-shard.mjs --execute --shard 3/8
# 僅在人工診斷並核對原失敗批次後，明確執行有限補試：
node scripts/run-production-shard.mjs --execute --shard 3/8 --limit 10 --retry-failed
```

每個 unit 固定一片、`Restart=no`、`KillMode=mixed`、`TimeoutStopSec=660`。包裝器每次核對凍結 manifest，固定模型、檔位、endpoint、token 上限、逾時及密鑰檔案來源；只執行原 CLI 一次，沿用其分片鎖和 journal 恢復。其他分片可繼續執行；同片不可重複啟動。SIGTERM 只通知自己的子程序保存當前批次後停止。一般 unit 不帶 `--retry-failed`；失敗片由協調者診斷後另行有限補試，所有實際用量與費用仍寫入原 journal。原自動 20 次上限不清空、不退還，也不把人工拆批偽裝為自動成功。

包裝器不啟動任何服務、不改寫 production 狀態；進度以實際分片和 unit 狀態核對，原協調程序的 `state` 可能仍為 interrupted／failed。八片完整、所有獨立 unit 均停止且鎖已釋放後，執行原 `npm run production -- --execute`：它會跳過完整分片，直接 merge、convert、build、test:browser。再完成全站 QA，才能報告交付完成。

本次使用者已要求完整跟進，可另外執行 [有限恢復監看器](FOLLOW-THROUGH.md)。它只在原服務停止後，對符合嚴格條件的已知用量格式錯誤補試一次；持久上限與原始紀錄不因重開而清除。這不改變主服務的 `Restart=no`，也不授權無限重試。驗收完成後見 [完整網站交付](DELIVERY.md)。

## 失敗與續跑

網路錯誤、逾時、HTTP 錯誤、JSON 或項目數不符都會停止該片，已完成的批次保留。遇到失敗或停止訊號，協調程序不再分派新工作，並通知其他片保存當前批次後退出；不自動重試。systemd 使用 `KillMode=mixed`、`TimeoutStopSec=660`，讓最長 600 秒的當前請求有時間收尾。

先檢查 `generated/translation-requests/zh-Hans-X-of-8/` 的失敗紀錄與 usage。對失敗或中斷的请求，新的付費嘗試必須明確加 `--retry-failed`；舊紀錄保留，未知消耗不能算成零。成功記錄包含經 schema 檢查的譯文，可用來恢复因本機中斷而未匯出的項目，不必重買。

殘留鎖位於 `generated/translation-locks/` 或正式執行器的 lock 目錄；先查 owner PID，確定原程序不再運行才清理，不可直接批量刪除鎖或快取。

## 換機交接

交接同一 Git commit、`artifacts/musicmap-source.tar.gz`、`generated/production/`、指定的 `generated/shards/` 分片及 `generated/translation-requests/` 紀錄，快取可選。不交接 `.env`、密鑰或其他帳號憑證。原機停止該片後，新機才接手；不要讓兩台機器同時翻同一片。

`generated/production/manifest.json` 是本輪凍結依據，`status.json` 與 `--status` 提供執行／覆盖資訊，`generated/translation-status.json` 是合併後的全站狀態。翻譯途中全站狀態可能尚未合併，應以分片查詢的最新成果為準。

最終驗收仍需檢查簡繁／英文切換、中文搜尋、SVG 縮放拖曳、流派介紹及內部連結；完整度和自動測試不等於人工文字品質評分。
