# 完整網站交付

正式翻譯程序完成全部簡體分片後，會依序合併、以 OpenCC 產生繁體、嚴格建置及執行瀏覽器測試。只有 `generated/production/status.json` 的 `state` 為 `completed`，且目前檔案仍對應該次完整成果，才能打包。

交付前再執行 `node test/complete-site.mjs`，以最終真實資料巡覽全部流派／家族，比對簡繁介紹、導覽連結與原歌單，並檢查桌面和手機長標題、長文及窗格收合。報告與截圖保存在 `artifacts/complete-site-audit/`。`--code hou05` 只適合診斷單一項目，不能代替全站驗收；來源抽取未涵蓋的短片段會單獨列出，不等於零英文保證。

```bash
node test/complete-site.mjs
node scripts/package-release.mjs --check
node scripts/package-release.mjs
# 也可指定新檔名；不覆寫已有交付包。
node scripts/package-release.mjs --output artifacts/musicmap-zh-complete-reviewed.tar.gz
```

工具不呼叫 API，也不修改來源、譯文或 `dist/`。它重新驗證來源快照、凍結檔案、簡繁實際完整度、繁體轉換版本及四種 hash、建置內容與成功驗收紀錄；預覽、過期轉換、驗收後改動的建置檔或 `dist/` 裡額外混入的檔案都會拒絕打包。文字審訂或重新建置後，需重新完成並記錄正式驗收；不可手改完成標誌來繞過檢查。

預設輸出 `artifacts/musicmap-zh-complete-YYYY-MM-DD.tar.gz`（檔名日期為 UTC）及同名 `.sha256`。压縮檔只包含：

- `dist/`：原站地圖與本機資產、簡繁譯文及閱讀介面，保留英文與原站署名。
- `server.mjs`：僅使用 Node.js 內建模組的本機靜態伺服器。
- `README.md`、`SOURCE.txt`：啟動、檢查及來源說明。
- `RELEASE-MANIFEST.json`、`SHA256SUMS.txt`：交付版本、來源／譯文 hash、驗收時間與逐檔校驗值。

密鑰、`.env`、OAuth、快取、分片、完整請求紀錄與推理內文均不放入網站包。原始計費及交接資料若需留存，另作私下工作資料保管，不與靜態網站混用。完整網站包不自動上傳 GitHub 或公開發佈。

接收者先驗證压縮檔，再解壓啟動：

```bash
sha256sum -c musicmap-zh-complete-YYYY-MM-DD.tar.gz.sha256
tar -xzf musicmap-zh-complete-YYYY-MM-DD.tar.gz
cd musicmap-zh
sha256sum -c SHA256SUMS.txt
node server.mjs
```

使用 Node.js 22 或更新版本，不需 `npm install`，瀏覽器開啟 `http://localhost:4173`。沒有 Node.js 時，也可在解壓資料夾執行：

```bash
python3 -m http.server 4173 --bind 127.0.0.1 --directory dist
```

伺服器以 `dist/` 為網站根目錄；勿用 `file://` 或部署到子路徑。地圖及簡繁／英文切換不呼叫翻譯 API，外部音樂播放仍需網路。完整度與瀏覽器功能檢查不代表人工文字品質評分。
