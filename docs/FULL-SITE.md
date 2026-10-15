# 完整章節全站續作

2026-10-15 使用者原話：「推進到全部完成並同步github」。主要窗口將「全部」解讀為凍結 catalog 的 562 唯一正文／572 映射＋1338 獨立介面／圖上標籤＝1900 source。精確請求上限、私人 repo 與 Release asset 成品是執行安排，不冒充使用者逐字指示。

入口 `scripts/complete-site.mjs`；run `artifacts/full-site/2026-10-15-complete/`；帳本 `generated/production/full-site-complete.json`；ID `whole-site-pro-max-complete-v1`。工作證據不提交 Git。

## 已完成停點

2026-10-15全1900來源簡繁有效覆蓋，8分片與原核驗證據逐字一致；正式build `allowPartial:false`、conversion四hash一致。新run恰172次、歷史613次、pilot10次另計，付費已停止。新帳本168 completed＋3 recovered-partial＋1 unknown；raw167 completed＋5 failed，原unknown及failed不重寫。最後20項真實輸出補齊6個漏項，3筆partial的54個原輸出均保留。原450正文、25歷史復原與本輪4個復原sidecar、父tree及凍結程式皆通過核驗。

完整瀏覽器通過1608流派／1824靜態映射／6組1338標籤與實際DOM／6組caption、原事件與中文搜尋、EN逐章HTML還原，零pageerror／DeepSeek。本機及私有預覽19個成品檔案逐檔hash相同；實際TLS瀏覽器privacy原事件及中文搜尋後正文精確比對通過。253項自編mock測試在無私人資料的乾淨checkout全PASS、零跳過。完成停點不授權新的API執行；重建、打包與核驗均不需模型。

## 準備與計數

prepare 逐筆核對父 run 的 450 有效正文、25 歷史免費復原、模型與 usage、source/request/response/journal/candidate hashes，再保存完整父 tree／ledger 快照並凍結。後續證據只能寫入新 run。

依原實作做空白折疊、trim、lowercase：135 exact dictionary、163 normalized dictionary、30 normalized terminology，聯集 164 個可確定性 prefill。每項保留匹配 key、來源、輸出及 hash；不能複製未翻英文灌完整度。

剩 112 正文逐章／段落送出；1174 標籤分 59 組，最多 20 項或 14000 字元。新持久上限 171 次，失敗亦占名額；加舊續作 441 次，計畫歷史上限 612，十批 pilot 另計。原 #217 unknown／usage null 與80%的新ID補發關係永久保留。

2026-10-15 第38筆送出後連線失敗，未收到回覆，HTTP／模型／usage均null；在487正文、164標籤停止。人類隨後明確回覆「補、把項目做完交付」。執行邊界只增加這一筆新ID補發：上限171→172、歷史612→613，原171個jobs不變，插入同source/context/prompt/settings的replacement。原未知journal與用量null永久保留，不灌成功數；補發後的新unknown仍立即停止。完整manifest／live與quota帳本／原程式先保存版本歷史，核定sidecar以request/source/journal/approval hash綁定。此精確額度是主要窗口的執行安排，不冒充人類逐字原話。

固定 Pro thinking/max/32768、非串流、600 秒、單工與 `Restart=no`；body 沿用十批 prompt，label 沿用既有模板但使用獨立 job 身分及嚴格已知 usage／模型驗證。模型輸出僅為資料，保留專名、URL、年份、流派英文身分與原事件。

```bash
npm test
node scripts/complete-site.mjs --prepare
node scripts/complete-site.mjs --status
node scripts/complete-site.mjs --execute
```

reserve／started 先落盤才送 HTTP，每個名額僅一個請求。重啟不能重置 cap；未完成／未知名額阻擋下一筆。成功但未匯出的 journal 可免費重匯，停止訊號讓當筆完成後停止。

只有上述已核定原#38可在逐位元組核對後保留unknown並跨越；不能把pending草稿或其他未知請求視為授權。replacement使用新job／request ID並連結supersedesRequestId，重啟不得重送已匯入結果。

## 失敗與歷史

已知格式失敗先套用既有可確定的本機 envelope 復原。人工核定需綁定該筆完整 hash proof，保留所有字句，用原驗證器檢查後另存 sidecar，不改原 failed journal。`registerFullSiteReview()` 保存 manifest／ledger 版本歷史後只接受指定候選，再以 `--recover` 免費匯入。

此流程不能變成任意猜補 nested 標記或語意改寫。新增模型／用量／送出狀態不明立即停止回報；需要新的付費嘗試時先診斷、保留原歷史並交回協調窗口，不自動重試。

本輪第120筆標籤回覆只有19項、來源為20項；原transport仍判定失敗。主要窗口技術核定：以逐項來源索引與原回覆hash保留19個原字串，狀態分列 `recovered-partial`，不將未回覆的項目灌入完成數。唯一缺項移到尚未送出的末批，使14項成15項／309字元，仍在20／14000限制與172／613上限內，未增加API請求名額。這只改最後一個未送job，所有已送job與原failed journal保留；不是變更原parser或補寫譯文，也不代表實際token費用固定相等。`registerFullSiteLabelDeferral()` 先保存manifest／帳本歷史，凍結主窗口核定與request/source/response/journal/output hashes；重啟核驗partial原字串，最後15項必須取得真實模型輸出才能完成1900。其他缺項或unknown不因此自動放行。

第133筆其後同樣缺4項：20個來源回16個，逐一核對為原索引0–13、18、19。主要窗口另核定第二個專用profile，16個原輸出不改；4個缺項追加到尚未送的尾組，15→19項／360字元，仍是172／613、無新增請求名額。兩筆partial及其5個缺項分列，尾組取得真實輸出前不算完成。程式只接受這兩筆request的獨立hash proof，不自動推廣其他缺項；兩筆原failed journals均保持原位元組。

第148筆再缺1項術語定義，20來源回19個，對應原索引0–13、15–19。主要窗口逐句核對後另核定第三專用profile，19個字串原樣保留；缺少的14追加未送尾組19→20項／467字元，總172／613不變，無新增request reservation。三筆partial共54個有效原輸出，6個缺項仍須尾批真實輸出；所有原failed journals、前兩筆proof及已送jobs均保留。253個離線回歸包含三partial→尾20→1900、完成重啟零呼叫與新unknown立即停止。此核定不推廣為其他缺項自動放行。

## 正式建置與驗收

```bash
node scripts/complete-site.mjs --build
node test/full-site-browser.mjs
node test/full-site-navigation.mjs
```

完整 1900 source 才執行 merge、原術語 OpenCC 與正式 build（`allowPartial:false`）。簡繁各1900 key、全部正文標記、catalog 及conversion來源／簡体／繁体／術語四 hash 都必須一致。

圖說 adapter 是 repo 可追蹤的 `public/chapter-caption-renderer.js`，overlay直接匯入，build自動带入，不需事後改 dist。它只定位兩個原 caption label，保留原 SVG／label 身分、屬性、事件與英文 text nodes；旧 frozen renderer／catalog／譯文歷史原樣保存。

完整 browser 對桌面／手機、EN／Hans／Hant巡覽全部268流派（1608次）及六次304靜態映射（1824次）。全部標籤經真實observer的隱藏資料fixture驗證，同時核對原站實際text nodes與屬性；fixture不冒充原站功能。

兩個圖說另在六種裝置／語言組合逐字核對，斷言原SVG／label節點同一身分、屬性和child順序保留，切回EN時還原原label HTML與同一組text nodes。打包門檻要求這六筆實際驗收紀錄。

實際點擊使用原privacy link與close按鈕，等原map ready後中文搜尋Noise Rock。genre正文原HTML無inline anchor，不能把空清單稱作點擊通過。驗證中文圖說、SVG、英文還原、原縮放及零pageerror／browser DeepSeek；原手機zoom-in被工具列遮住的限制保留，使用原wheel zoom。

全PASS後才更新既有本機／Tailnet預覽，其他port不動、無Funnel。私人網址、個人session ID及機器資訊僅放本機紀錄。

## 同步與成品

逐項審閱既有變更、測試後正常commit／非force push至已核對的 `Mizimo/musicmap-zh` PRIVATE main。不得 `git add .` 或force-add被忽略的來源、譯文、journals、密鑰與成品。

```bash
node scripts/package-full-site.mjs --check
node scripts/package-full-site.mjs
```

Verifier核對帳本、父證據、全部source、四hash、正式build、1608／1824驗收及browser完成時相同的逐檔build hash。只封裝allowlist靜態網站、內建模組server、啟動與來源文件、release manifest、校驗表；原始付費journals、密鑰、快取與node_modules排除。

成品與外部 `.sha256` 作私人repo的Release assets，發布前後核對repo private、commit/tag與實際下載hash，保留原站署名／版權。工作證據另留本機，不混入網站包。
