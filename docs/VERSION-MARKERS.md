# 翻譯版本標記

| marker | 切分／模型模式 | 採用狀態 |
| --- | --- | --- |
| `v0.1-pro-max-baseline` | 原文字節點；DeepSeek V4 Pro／Max 開啟思考；5,809 條含 seed | 已歸檔，作本輪舊稿對照 |
| `2026-10-13T14-12-30Z` 優化五批 | 98 條文字片段；Pro／Max 開啟思考 | 已撤回，繼續廢棄，费用紀錄保留 |
| `v0.1-pro-none-completion`／`v0.1-pro-none-paused-20261014` | 5,809 條舊稿＋1,483 條無思考續作，共 7,292；尚未完成 | 已歸檔，不能冒充全 Max 或本輪基線 |
| `v1-fragments-retired-2026-10-14` | 封存全部歷史與未提交草稿 | 舊付費入口停用；既有預覽保留 |
| `whole-chapter-pro-max-10-v1`／`v0.2-pro-max-whole-chapter-pilot` | 完整章節／段落；Pro／Max 開啟思考；32768 | 首輪 10/10 已完成並停止；試譯待審，不自動採用 |

## 後續獨立授權

| marker | 範圍與結果 | 證據界線 |
| --- | --- | --- |
| `whole-body-pro-max-50pct-v1` | 舊281目標；實際226正文、217續作嘗試，末筆unknown | 原帳本／failed journal／usage null不重寫 |
| `whole-body-pro-max-80pct-v1` | 450正文／460映射；224新增、歷史441次 | 220 raw completed＋4 raw failed免費復原；父run凍結 |
| `whole-site-pro-max-complete-v1` | 562正文＋1338獨立標籤，1900source全站目標，執行中 | 復用450／25復原，164 prefill；初定171新增，正文及label身分分列 |

後續授權不重置pilot或父run額度。全站新unknown立即停止交回；若另有核定補發，保留原unknown、用量null與新ID連結，再保存scope／cap修正，不能算成零費用。成品與程式只同步既有私人repo，操作見[FULL-SITE.md](FULL-SITE.md)。

程式基準為 2026-10-13 優化前保存的快照（Git `8e7eb67`），不是 `2026-10-13-comparison/report.html` 的 benchmark 配置。詳細歸檔、凍結身份、還原與執行規則見 [完整章節首輪](CHAPTER-PILOT.md)。歷史文件原貌均保存在歸檔中。若要回撤，從歸檔還原至獨立資料目錄並核對 SHA-256；不重置現有十次名額、不默默混合版本。
