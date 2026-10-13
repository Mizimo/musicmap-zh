# 正式翻譯的持續跟進

`scripts/follow-through.mjs` 是獨立監看器，不改既有翻譯提示、模型設定、快取或凍結程式。它每 30 秒查詢現有 `musicmap-translation.service` 及實際分片進度；預設只讀，只有明確使用 `--execute` 才啟用有限恢復。

```bash
node scripts/follow-through.mjs --status
node scripts/follow-through.mjs --execute
```

只有服務已停止、正式狀態為 failed、所有分片鎖都不存在，且凍結檔案核對一致時，才會評估未解決的失敗。可自動補試的範圍固定如下：

- API 已回 HTTP 200、finish reason 為 stop，失敗碼只有 `INVALID_TRANSLATION`。
- 完整用量已知且一致；模型、檔位、提示、術語、上下文及來源均符合本輪凍結設定。
- 當前缺少的前 N 個片段與原失敗批次逐個 hash 相同；已付費成功的內容不再購買。
- 同一批次最多補試一次；曾有兩次失敗、未知用量、網路／逾時／認證問題或紀錄異常均轉為 needs-review。
- 同時最多兩個自動補試程序，整份持久 ledger 最多保留 20 個自動補試名額；重新啟動監看器不會重置此上限。人工診斷後另行授權的拆批補救，按每個實際請求保留 journal 與完整費用，不重置或退還自動補試名額。

每次補試先將名額及原紀錄 hash 寫入 `generated/production/follow-through.json`，再以同一分片、精確 `--limit N`、`--retry-failed` 執行。成功必須有且僅有一筆相同批次的新 completed 紀錄，用量仍完整一致，且譯文已保存。所有本輪補試成功後，再次查詢原來的 `musicmap-translation.service`；若服務已由其他操作者啟動，監看器繼續等待，否則執行 `systemctl --user start musicmap-translation.service` 續跑。`start` 對已在執行的服務不會重新啟動，避免打斷新工作。監看器不建立其他翻譯服務或修改主機設定。

歷史上由協調者審閱並縮小批次的請求，沿用 journal 的 `reviewedPreviousRequestIds` 記錄；不會因此把已解決的舊批次重新列為自動補試。監看器自身的补試始終維持原批次，不能自行拆分、換提示或換模型。

若程序在已保留名額之後中斷，重開時維持 needs-review，避免不確定狀態下重複付費。不得清空 ledger 來重置上限。人工檢查失敗紀錄、已完成譯文及服務狀態後，才另行決定後續處理。

自動補試已明確失敗、協調者人工拆批完成後，可在**主翻譯與監看器兩個服務均停止、所有分片鎖已釋放**時確認恢復：

```bash
node scripts/follow-through.mjs --acknowledge-manual-recovery ORIGINAL_FAILED_REQUEST_ID
```

參數是 ledger 該 attempt 的原始 `failedRequestId`，不是補試產生的新失敗 ID。命令取得監看器與 production 獨占鎖，核驗相同凍結 manifest、原失敗 hash、失敗補試的同批次來源與完整用量，以及後續 completed 紀錄對原批次所有 textHash 的唯一完整覆蓋（允許 10+10 拆批）。每個譯文必須等於分片保存值；全部分片 journal 都不得有未解決請求或未知用量。舊版未保存的新失敗 hash 在本次確認固定於證據中；新版自動補試會立即保存全部新紀錄 hash。

全部通過後，只在本機 ledger 附加 `manualResolution` 與證據 hash，恢復 ledger 的 `monitoring` 狀態。原 attempt 仍為 `needs-review`，原失敗紀錄、已保留名額與費用全部保留；不偽造自動補試成功。**本命令不呼叫 API、不啟動任何服務**，協調者確認後另行啟動既有服務。之後每次監看循環重新驗證人工恢復證據及分片譯文；任何修改或後續未解決失敗仍會按原政策停止／評估。

獨占鎖在 `generated/production/follow-through-lock/owner.json`。硬中斷留下的鎖不自動接管；先核對 PID 與機器。正常 SIGINT／SIGTERM 會停止新的補試，通知監看器自己啟動的補試子程序保存當前批次後退出。停止監看器不會停止正在運作的主翻譯服務。

只有正式狀態完成、服務已結束時才以 exit 0 結束。needs-review 或人工中止會以 exit 1 結束；已保留的請求紀錄與名額不刪除。最終網站交付另見 [DELIVERY.md](DELIVERY.md)。
