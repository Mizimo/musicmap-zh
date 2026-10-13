# 翻譯對照測試：價格來源與計算

查核日期：**2026-10-13**。以下單價均為每 **1,000,000 tokens**，機器可讀版本為 [pricing.json](pricing.json)。價格只用來比較消耗，譯文品質由使用者評判。日後重跑前重新查閱官方文件，保留該次價格快照與 hash。

## 模型、檔位與價格

OpenAI 以下為 Standard API、輸入不超過 272,000 tokens 的美元單價。`Codex` 表示本次使用的呼叫入口；計價模型名稱仍是表中的官方模型 ID。

| 模型 ID／官方來源 | 本次思考檔位 | 輸入 | 快取讀取 | 快取寫入 | 輸出 |
| --- | --- | ---: | ---: | ---: | ---: |
| [gpt-6.1-sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) | low / medium / high | $2 | $0.10 | $2.50 | $10 |
| [gpt-6-astra](https://developers.openai.com/api/docs/models/gpt-6-astra) | low / medium / high | $10 | $1 | $12.50 | $50 |
| [gpt-6-sol](https://developers.openai.com/api/docs/models/gpt-6-sol) | low / medium / high | $2 | $0.20 | $2.50 | $10 |

三個模型均支援本次 low、medium、high。Responses API 以 `reasoning.effort` 設定；`high` 不是 Fast service tier。輸入超過 272,000 tokens 時，整個請求的輸入、快取讀取及寫入單價乘 2，輸出乘 1.5；本片段測試的計價工具遇到這種長輸入會拒絕計價，不能沿用表內短上下文單價。Fast 為相應 Standard 單價的 2 倍；本次統一計算 Standard 等價費用，回傳其他服務檔位時需另加註記。詳見上列模型頁及 [OpenAI 價格表](https://developers.openai.com/api/docs/pricing)。

DeepSeek 的兩個模型均測 low、high、max；Chat Completions 以 `reasoning_effort` 設定，Responses 以 `reasoning.effort` 設定。官方預設 high，medium／xhigh 會映射為 high，不能把它們當成額外的獨立檔位。思考模式下 `temperature` 不生效，本次省略。[思考模式文件](https://api-docs.deepseek.com/guides/thinking_mode/)

| 官方模型 ID／版本 | 時段 | USD 輸入未命中 | USD 輸入命中 | USD 輸出 |
| --- | --- | ---: | ---: | ---: |
| `deepseek-flash`／DeepSeek-V4.1-Flash | 離峰 | $0.15 | $0.003 | $0.60 |
| 同上 | 高峰 | $0.30 | $0.006 | $1.20 |
| `deepseek-v4-pro`／DeepSeek-V4-Pro-0813 | 離峰 | $0.66 | $0.022 | $1.98 |
| 同上 | 高峰 | $1.32 | $0.044 | $3.96 |

美元來源：[DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)。DeepSeek 未另列快取寫入收費。

| 模型 | 時段 | CNY 輸入未命中 | CNY 輸入命中 | CNY 輸出 |
| --- | --- | ---: | ---: | ---: |
| V4.1 Flash | 離峰 | ¥1 | ¥0.02 | ¥4 |
| V4.1 Flash | 高峰 | ¥2 | ¥0.04 | ¥8 |
| V4 Pro | 離峰 | ¥4.5 | ¥0.15 | ¥13.5 |
| V4 Pro | 高峰 | ¥9 | ¥0.30 | ¥27 |

人民幣來源：[DeepSeek 中文價格表](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。這是獨立公布的人民幣價目，並非美元即時匯率換算；報表不計匯差、稅費或帳戶優惠。

`deepseek-flash` 是 V4.1 Flash 的官方呼叫名稱；舊名稱 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 目前也路由至 V4.1 Flash。本次使用正式名稱，不將別名當成不同模型。早期公告曾提及停用 V4 Pro，但目前[官方更新日誌](https://api-docs.deepseek.com/updates/)已明確說明 2026-09-14 之後繼續提供 V4 Pro、計費不變；目前價格表列出的版本仍為 V4-Pro-0813。每次保存請求與回傳模型名，不自行把 Pro 替換成 Flash。

## 高峰與離峰

DeepSeek 高峰為 UTC 週一至週五 **01:00–04:00、06:00–10:00**，中國法定節假日除外；等同北京時間 09:00–12:00、14:00–18:00。其餘時間及週末、法定節假日全天為離峰，單價減半。[官方時段規則](https://api-docs.deepseek.com/quick_start/pricing)

本次預定 2026-10-13 09:xx UTC，屬高峰。10 月 13 日為週二，且不在[國務院 2026 年假期安排（北京市政府刊載）](https://www.beijing.gov.cn/zhengce/zhengcefagui/202511/t20251104_4258873.html)的 10 月 1–7 日國慶假期內。未查核的日期必須先核對當年日曆；不得把這次的日期例外永久沿用。

保存請求開始與完成時間。若跨時段邊界，文件未確立該請求具體採哪一刻決定單價，報表以兩種單價形成上下界，不聲稱是帳單實扣。

## Tokens 與費用公式

以 API 回傳的 usage 為準，不用字數或模型自行估計的 token 數。不同模型的 tokenizer 不同，相同原文不保證相同 input tokens。

定義 `I` 為全部輸入、`C` 為快取讀取、`W` 為快取寫入、`O` 為全部輸出、`R` 為其中推理 tokens；`Pi`、`Pc`、`Pw`、`Po` 為對應的每百萬 token 單價。

```text
OpenAI Standard API 等價費用
= ((I - C - W) × Pi + C × Pc + W × Pw + O × Po) / 1,000,000

DeepSeek 公布價格估算
= ((I - C) × Pi + C × Pc + O × Po) / 1,000,000

總 tokens = I + O
非推理輸出 tokens = O - R（只在 R 有回傳時列出）
```

OpenAI 使用 `input_tokens`、`input_tokens_details.cached_tokens`、`input_tokens_details.cache_write_tokens`、`output_tokens`、`output_tokens_details.reasoning_tokens`。快取寫入按完整的寫入單價計費，先從普通輸入扣除，不能再重複加一次普通輸入費。[官方快取計算公式](https://developers.openai.com/api/docs/guides/prompt-caching)

DeepSeek Chat Completions 使用 `prompt_tokens`、`prompt_cache_hit_tokens`、`prompt_cache_miss_tokens`、`completion_tokens`、`completion_tokens_details.reasoning_tokens`，並核對 `prompt_tokens = hit + miss`。[官方 usage schema](https://api-docs.deepseek.com/api/create-chat-completion/)

兩家推理 tokens 都包含在 `O`，按輸出價計費，**不能再加一次 `R`**。`O - R` 可能包含 JSON／格式等非正文內容，不能稱為純譯文字數或 tokens。[OpenAI reasoning 計量](https://developers.openai.com/api/docs/guides/reasoning)、[DeepSeek Responses 計量](https://api-docs.deepseek.com/guides/responses_api/)

## 缺失欄位與帳戶扣額

缺失的 usage 欄位保留 `null`，不冒充測得的零。`I` 或 `O` 缺失時不提供完整金額。快取欄位缺失時，在 `C ≥ 0`、`W ≥ 0`、`C + W ≤ I` 的可行範圍內計算最小及最大費用：

- `C` 已知、`W` 未知：下界取 `W = 0`；上界取 `W = I - C`。
- `W` 已知、`C` 未知：下界取 `C = I - W`；上界取 `C = 0`。
- OpenAI 兩者都未知：下界視全部輸入為快取讀取；上界視全部輸入為快取寫入。
- DeepSeek `C` 未知：下界視全部輸入命中；上界視全部未命中。

這些界限依據目前 `Pw > Pi > Pc` 的價格關係，不是快取命中率的預測。只缺 `R` 不影響總輸出費用，但不可推算思考／非思考比例。失敗或截斷請求若已回傳 usage，也需保留並計入已知消耗；usage 缺失則標示費用未知，不能記作免費。

Codex 經本機登入憑證呼叫，報表中的美元是**按官方 Standard API 價格換算的等價費用**，不是訂閱帳戶實扣金額、訂閱額度百分比或追加帳單。公開 API 單價與 token usage 無法推出訂閱扣額；只有實際帳戶用量／帳單資料能確認後者。DeepSeek 的美元與人民幣也只是相應價目下的估算，最終扣費以帳戶帳單為準。
