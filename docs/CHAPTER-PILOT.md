> **歷史首輪紀錄。** 原10次帳本與報告保持原樣；其有效成果經後續獨立授權復用。最新全站續作見 [FULL-SITE.md](FULL-SITE.md)，下方「待審／尚未採用」描述的是首輪原停點。

# 完整章節 Pro Max 首輪

使用者已批准：封存全部舊翻譯，以**優化前的整個專案基線**改為完整段落／章節翻譯，先做 10 批，呈現譯文和用量對照後停止。

## 基線與歸檔

- 基線：`artifacts/token-optimization/2026-10-13T14-12-30Z/baseline/`，Git `8e7eb67c5034d0e7a7b0d6f6044de23cb3b93a89`。原正式翻譯 5,809 條（包含字典種子）；不是最早的多模型 benchmark 報告設定。
- 歸檔：`artifacts/archives/v1-fragments-retired-2026-10-13T17-08-57Z/`。14,399 個檔案、69,311,975 bytes，包括 Max、無思考、已廢棄五批、失敗請求、未驗證 UI 草稿、報告、所有翻譯快取及原預覽。每個檔案複製前後 SHA-256 已核對；`manifest.json`、`SHA256SUMS.txt`、唯讀 tar.gz 和外部 SHA-256 一併保存。排除密鑰、`.env`、Git 內部資料及依賴目錄。
- tar.gz SHA-256：`374721fa06ad321bdb0ec4e5a5a0e2f0dd4d6e705e0caf1aeb3ae634768ec76d`。
- 舊 API 入口受 `generated/production/retired.json` 阻擋。歷史程式與產物只供查證，不可用於繞過本輪額度。原始檔案和預覽均保留；新稿尚未採用。

## 原架構與必要變動

維持離線翻簡體、八個 `SHA256(source) % 8 + 1` 分片、原 source→string wrapper／語言檔、請求 journal、快取、merge、OpenCC 本機轉繁體及靜態網站。API、模型與輸出上限固定：`deepseek-v4-pro`、`thinking:enabled`、`reasoning_effort:max`、`max_tokens:32768`、非串流、600 秒逾時。先前 `.env` 的 none 不會覆蓋本輪凍結設定。

每篇流派／家族介紹作**一個完整 source**，一次 API 收到整章的所有段落。段落使用 `⟦p0⟧…⟦/p0⟧`；內嵌格式／連結使用 `⟦m0⟧…⟦/m0⟧`；單換行使用 `⟦br0⟧`。標記不是翻譯單位，沒有按粗體或連結拆詞。原 DOM 節點和屬性保存在本機單位表，模型只回 JSON 文字，不回 HTML。段落順序固定，段內完整標記可依中文語序移動。

新 prompt/cache 版本為 `musicmap-whole-chapter-pro-max-v1`／`musicmap-chapters-v1`，不使用任何舊正文碎片快取。章級快取全中或整章送出。新的來源表共有 1,900 個唯一鍵（562 個正文鍵、1,338 個 UI 鍵）；572 個正文位置映射包括 268 個流派章及 304 個完整頁面段落／引用單位，合計 920 段。原本 7,801 個文字節點不能當作新完整度分母。

簡體輸出須通過完整標記檢查才能完成 journal 或寫入快取。OpenCC 只轉換文字葉，保留標記；轉換記錄和 build 加驗單位表 hash。未翻正文整章顯示英文，不回退到舊碎片拼接。網站仍保留原地圖、連結事件、中文搜尋與精確英文還原。

## 十批範圍與停止規則

固定順序：`alt02, met07, pop03, alt05, rnr03, met09, inl09, dtp, inl01, met`。共 10 章、30 段、22,072 帶標記來源字元；不含系統提示和術語。所有候選均有優化前基線舊譯可對照；基線原抽取漏掉的短字仍照實顯示。

八片上方共用全局鎖和持久化十次名額，**單工執行、不自動重試**。每次先 reserve，再保存 started journal，再送 HTTP。失敗和不確定是否送出的請求仍占名額。額度用完、重開程序、再次 prepare 都不能多買一次。已完成但尚未匯出的 journal 可免費恢復。用量／模型不明、帳務矛盾或本機持久化失敗立即停止待審。

停止訊號讓唯一在途請求完成；若在 HTTP 送出前收到停止訊號，不再送出。已保留但確定未送出的名額不退回，本轮仍不会突破十次。執行結束為 `awaiting-review`，沒有自動後續翻譯、正式採用或發布。凍結後更改程式、來源、提示、術語、價表或單位表會阻擋新請求。

## 操作与交付

```bash
npm test
node test/chapter-browser.mjs
npm run production -- --chapter-pilot --prepare
npm run production -- --chapter-pilot --execute
npm run production -- --chapter-pilot --status
npm run production -- --chapter-pilot --report
```

`--prepare`、`--status`、`--report` 不呼叫 API。唯一新輪次為 `artifacts/chapter-pilot/2026-10-14-pro-max-10/`，其工作資料與部分建置在 `workspace/`。`--report` 只在這裡 merge／convert／partial build，不觸碰專案根目錄 `dist/` 或 Tailnet 入口。

對照報告列英文、優化前 Max／種子基線的原始拼接稿、新整章 Pro Max 原稿；不套用人工潤色。提供逐章 tokens、快取／思考子項、耗時及 journal 保存的基線價表估算。思考已含在輸出、快取已含在輸入，不能重複加。舊請求跨多章時不按比例捏造同章成本，未知用量不當作零。所有版本只供對照；待使用者審閱後另行決定正式採用和下一輪範圍。

## 本輪實際結果

2026-10-14 首輪已停於 `awaiting-review`：10 次 API 全部成功，10 章／30 段，零失敗、零重試；十次額度已用完。輸入 11,775 tokens（含 3,072 cache read）；輸出 58,575（含 52,553 reasoning）；合計 70,350。依本輪 journal 保存價表估算 US$0.121790064／CNY 0.8303868，不代表帳單實扣。API 可見文字輸出為 6,022 tokens，思考仍按使用者指定開啟。

原基線整輪 302 次、3,141,914 tokens、US$4.78225836。所選十章涉及 73 個去重歷史請求，包含其他章節片段及 9 次失敗；其整批合計 845,409 tokens、US$1.27565130。這兩個歷史範圍都不是本次十章的精確對照成本，不計算節省百分比。

報告：`artifacts/chapter-pilot/2026-10-14-pro-max-10/report.html`。英／舊基線拼接／新整章原稿並列；報告資料、CSV、API journals、凍結 manifest、檢查證據均在同一輪次目錄。新稿尚未正式採用，根目錄原分片、語言檔及 dist 保持原樣。
