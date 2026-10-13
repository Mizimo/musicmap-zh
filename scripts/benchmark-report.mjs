import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { calculateCost, normalizeUsage } from '../lib/benchmark-cost.mjs';

const usageFields = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning', 'total'];
const csvColumns = [
  'rowType', 'attemptFile', 'attemptRecorded', 'rawUsagePresent', 'label', 'id', 'provider', 'model', 'effort', 'status', 'sourceStatus', 'returnedModel', 'returnedEffort',
  'serviceTier', 'startedAt', 'finishedAt', 'latencyMs', ...usageFields,
  'usdMin', 'usdMax', 'cnyMin', 'cnyMax', 'costBasis', 'costNotes', 'error',
];

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function jsonForHtml(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function priceRange(value) {
  return { min: numberOrNull(value?.min), max: numberOrNull(value?.max) };
}

function rangeText(value, prefix = '', precision = 6) {
  if (value?.min == null || value?.max == null) return '—';
  const format = (number) => `${prefix}${number.toFixed(precision)}`;
  return value.min === value.max ? format(value.min) : `${format(value.min)}–${format(value.max)}`;
}

function csvCell(value) {
  if (value == null) return '';
  let text = String(value);
  // Keep spreadsheet software from treating model/provider text as a formula.
  if (typeof value !== 'number' && /^[\s]*[=+@-]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function csvFor(results) {
  const rows = results.map((result) => ({
    ...result,
    ...result.usage,
    usdMin: result.cost.usd.min, usdMax: result.cost.usd.max,
    cnyMin: result.cost.cny.min, cnyMax: result.cost.cny.max,
    costBasis: result.cost.basis, costNotes: result.cost.notes.join(' | '),
  }));
  return `\uFEFF${[csvColumns, ...rows.map((row) => csvColumns.map((key) => row[key]))]
    .map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function letterLabel(index) {
  let result = '';
  do {
    result = String.fromCharCode(65 + index % 26) + result;
    index = Math.floor(index / 26) - 1;
  } while (index >= 0);
  return result;
}

function shuffled(ids, seed) {
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0);
  const random = () => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ state >>> 15, state | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
  const output = [...ids];
  for (let index = output.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [output[index], output[other]] = [output[other], output[index]];
  }
  return output;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function labelsFor(directory, ids) {
  const file = path.join(directory, 'anonymous-labels.json');
  let labels;
  try {
    labels = await readJson(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const seed = randomBytes(16).toString('hex');
    labels = { version: 1, seed, assignments: shuffled(ids, seed).map((id, index) => ({ id, label: letterLabel(index) })) };
    await fs.writeFile(file, `${JSON.stringify(labels, null, 2)}\n`, { flag: 'wx' });
  }
  const assigned = labels.assignments;
  if (!Array.isArray(assigned) || assigned.length !== ids.length
    || new Set(assigned.map((row) => row.id)).size !== ids.length
    || new Set(assigned.map((row) => row.label)).size !== ids.length
    || !assigned.every((row) => ids.includes(row.id) && /^[A-Z]+$/.test(row.label))) {
    throw new Error('Existing anonymous-labels.json does not match this run. Preserve the old run and use a new run directory.');
  }
  return labels;
}

function sourcesFor(pricing) {
  return (Array.isArray(pricing?.sources) ? pricing.sources : []).flatMap((source) => {
    try {
      const url = new URL(typeof source === 'string' ? source : source.url);
      if (!['https:', 'http:'].includes(url.protocol)) return [];
      return [{ title: String(source.title || url.hostname), url: url.href }];
    } catch { return []; }
  });
}

function normalizeResult(config, result, label) {
  const sourceStatus = String(result?.status ?? 'pending');
  const status = sourceStatus === 'success' ? 'success'
    : !result || ['pending', 'received'].includes(sourceStatus) ? 'pending' : 'error';
  return {
    id: config.id, label, provider: String(config.provider ?? ''), model: String(config.model ?? ''),
    effort: String(config.effort ?? ''), status, sourceStatus,
    rowType: 'final_result', attemptFile: `results/${config.id}.json`,
    attemptRecorded: Boolean(result && (result.startedAt || ['success', 'error', 'received'].includes(sourceStatus))),
    rawUsagePresent: Boolean(result?.rawUsage && typeof result.rawUsage === 'object' && Object.keys(result.rawUsage).length),
    startedAt: result?.startedAt ?? null, finishedAt: result?.finishedAt ?? null,
    latencyMs: numberOrNull(result?.latencyMs), returnedModel: String(result?.returnedModel ?? ''),
    returnedEffort: String(result?.returnedEffort ?? ''), serviceTier: String(result?.serviceTier ?? ''),
    text: String(result?.text ?? ''),
    translations: (Array.isArray(result?.translations) ? result.translations : []).map((entry) => ({ id: String(entry.id), text: String(entry.text ?? '') })),
    usage: Object.fromEntries(usageFields.map((field) => [field, numberOrNull(result?.usage?.[field])])),
    cost: { usd: priceRange(result?.cost?.usd), cny: priceRange(result?.cost?.cny), band: String(result?.cost?.band ?? ''),
      basis: String(result?.cost?.basis ?? ''), notes: [...(result?.cost?.notes ?? []).map(String), ...(result?.cost?.band ? [`DeepSeek price band: ${result.cost.band}`] : [])] },
    error: String(result?.error ?? ''),
  };
}

const formulaNotes = [
  '所有單價以每百萬 token 計。I = 總輸入 token；R = 快取讀取 token；W = 快取寫入 token；O = 總輸出 token（已含推理）。',
  'DeepSeek：費用 = (M × 輸入未命中單價 + H × 快取命中單價 + O × 輸出單價) ÷ 1,000,000。M/H 取回傳的 prompt_cache_miss_tokens / prompt_cache_hit_tokens；欄位一致時 M = I − R、H = R。按請求發送時段套用尖峰或離峰價格。',
  'Codex API 等價：費用 = ((I − R − W) × 一般輸入單價 + R × 快取讀取單價 + W × 快取寫入單價 + O × 輸出單價) ÷ 1,000,000。快取讀、快取寫與未快取輸入是輸入的不同部分，不能再次加入 I。',
  '若 Codex 未回傳 W：以 W = 0 與 W = I − R 分別計算邊界，取較小值和較大值形成區間；本輪文件中的快取寫入價格高於一般輸入價格，因此兩者分別是下限與上限。區間不是實際訂閱扣款。',
  '推理 token 已包含在 O 中，不另計一次輸出費用；總 token = I + O。未回傳的 token 欄位保留未知，不以零代替。CNY 使用 DeepSeek 獨立人民幣價目，不由 USD 換匯；費用不含稅。',
];

const methodNotes = [
  '這是一組自寫的音樂領域測試片段，原定每個配置取得一份成功結果。失敗後的重試是補足結果，不是系統性的重複抽樣；無法估計輸出變異或穩定性，也不能由這一組結果推論全站翻譯品質或其他題材的表現。實際嘗試次數另行列出。',
  '快取狀態未受控，延遲亦會受服務負載與網路影響。不同供應商的 token 切分方式不同；彙總 token 僅是本輪用量記錄，不是跨供應商效率或品質分數。',
  '檔位欄位首先記錄請求所指定的 effort。API 若未回傳 effort，就無法僅憑回應確認後端是否使用該檔位；即使有回傳，也只是供應商的回應欄位，不是對實際推理計算量的獨立量測。',
  'DeepSeek 費用是官方價目與回傳用量的估算，Codex 費用是同用量的 API 等價估算；兩者不是同一種實際付款記錄，因此分開彙總。未回傳用量的失敗請求不能當成免費。',
];

function aggregatesFor(results, extraAttempts) {
  const providerIds = [...new Set(results.map((result) => result.provider))];
  const attempts = [...results.filter((result) => result.attemptRecorded), ...extraAttempts];
  return [...providerIds, 'all'].map((provider) => {
    const rows = attempts.filter((result) => provider === 'all' || result.provider === provider);
    const finalResults = results.filter((result) => provider === 'all' || result.provider === provider);
    const usage = Object.fromEntries(usageFields.map((field) => {
      const values = rows.map((row) => row.usage[field]).filter((value) => value != null);
      return [field, { sum: values.length ? values.reduce((sum, value) => sum + value, 0) : null, known: values.length }];
    }));
    const cost = {};
    for (const currency of ['usd', 'cny']) {
      const values = rows.map((row) => row.cost[currency]).filter((value) => value.min != null && value.max != null);
      cost[currency] = { min: values.length ? values.reduce((sum, value) => sum + value.min, 0) : null,
        max: values.length ? values.reduce((sum, value) => sum + value.max, 0) : null, known: values.length };
    }
    const label = provider === 'deepseek' ? 'DeepSeek 文件價格估算'
      : provider === 'codex' ? 'Codex API 等價估算' : provider === 'all' ? '全部供應商（僅記錄 token 總量）' : provider;
    return { provider, label, configurations: finalResults.length, completed: finalResults.filter((row) => row.status === 'success').length,
      attempts: rows.length, archivedAttempts: rows.filter((row) => row.rowType === 'archived_attempt').length,
      unknownSpend: rows.filter((row) => !row.rawUsagePresent || row.cost.usd.min == null || row.cost.usd.max == null).length, usage, cost };
  });
}

function aggregateValue(field, count) {
  return field.sum == null ? '—' : `${field.sum.toLocaleString('en-US')}${field.known < count ? `（${field.known}/${count} 已知）` : ''}`;
}

function deepseekScenariosFor(results, extraAttempts, manifest) {
  const price = (result, band) => {
    try {
      return calculateCost({ provider: 'deepseek', model: result.model, usage: result.usage,
        startedAt: result.startedAt, finishedAt: result.finishedAt, pricing: manifest.pricing, bandOverride: band });
    } catch { return null; }
  };
  const rows = results.filter((result) => result.provider === 'deepseek').map((result) => ({
    id: result.id, label: result.label, model: result.model, effort: result.effort, actualBand: result.cost.band,
    peak: price(result, 'peak'), offpeak: price(result, 'offpeak'),
  }));
  const attempts = [...results.filter((result) => result.attemptRecorded), ...extraAttempts].filter((result) => result.provider === 'deepseek');
  const total = {};
  for (const band of ['peak', 'offpeak']) {
    const values = attempts.map((result) => price(result, band)).filter((value) => value?.usd && value?.cny);
    total[band] = { known: values.length, unknown: attempts.length - values.length };
    for (const currency of ['usd', 'cny']) {
      total[band][currency] = { min: values.length ? values.reduce((sum, value) => sum + value[currency].min, 0) : null,
        max: values.length ? values.reduce((sum, value) => sum + value[currency].max, 0) : null };
    }
  }
  return { rows, total, attempts: attempts.length,
    note: '下表用同一份回傳 token 用量，分別假設整次按尖峰或離峰價格計算；不改動上方實際時段的估算，也不預測重新執行時的用量或快取狀態。',
    schedule: '官方時段：UTC 週一至週五 01:00–04:00、06:00–10:00 為尖峰（中國法定節假日除外），其他時段為離峰。CNY 採官方人民幣價目，沒有換匯。' };
}

function codeBlock(value) {
  const text = String(value ?? '');
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((match) => match.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

function markdownFor(data) {
  const lines = [
    '# Musicmap 翻譯模型對比報告', '',
    `執行：${data.id}；建立時間：${data.createdAt}`, '',
    '文字品質由閱讀者評判，本報告不提供品質分數或排名。下列為模型直接產生的簡體譯文，未經 OpenCC 轉換或人工潤飾。', '',
    '原文是為本次測試自寫的音樂領域評測片段，不是 Musicmap 原站引文。原定每個配置取得一份成功結果；失敗及後續重試另外記錄。快取狀態未受控，供應商的 token 切分方式也不同。', '',
    `實際紀錄：${data.attemptSummary.total} 次嘗試，其中 ${data.attemptSummary.additional} 次為封存的額外嘗試；${data.attemptSummary.successful}/${data.results.length} 個配置取得成功結果。${data.attemptSummary.unknownSpend} 次嘗試缺少原始用量或完整計價，實際費用仍有未知部分；已知成本區間不包含未知費用，不能當成整輪花費上限。`, '',
    '字母代號由本機隨機分配，同一 run 重新產生報告時保持不變。模型映射與用量位於本文末尾；若希望先隱藏它們，請使用 report.html。匿名僅是閱讀介面，檔案內仍含模型資料。', '',
  ];
  for (const passage of data.passages) {
    lines.push(`## ${passage.title}`, '', '英文原文：', '', codeBlock(passage.text), '');
    for (const result of data.results) {
      const translation = result.translations.find((entry) => entry.id === passage.id);
      lines.push(`### 譯本 ${result.label}`, '');
      if (translation) lines.push(codeBlock(translation.text), '');
      else lines.push(result.status === 'pending' ? '尚未取得結果。' : '沒有這個片段的可用譯文。', '');
      if (result.status === 'error') lines.push('請求或結果處理失敗：', '', codeBlock(result.error || '未提供錯誤細節'), '');
    }
  }
  lines.push('## 模型映射與用量（揭曉）', '',
    'DeepSeek 金額依文件價格與回傳用量估算；Codex 金額是 API 等價估算，不代表訂閱實際扣款。缺少 cache-write 資料等情況以成本區間顯示；缺少用量以「—」表示，不能當成零。推理 token 已含在輸出中，不能再次相加。', '',
    '| 譯本 | 模型 / 檔位 | 狀態 | 輸入 | 快取讀 | 快取寫 | 輸出 | 推理 | 總 token | 秒 | USD | CNY |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  const cell = (value) => String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ');
  for (const result of data.results) {
    const usage = result.usage;
    lines.push(`| ${[result.label, `${result.model} / ${result.effort}`, result.status, usage.input,
      usage.cacheRead, usage.cacheWrite, usage.output, usage.reasoning, usage.total,
      result.latencyMs == null ? null : (result.latencyMs / 1000).toFixed(2),
      rangeText(result.cost.usd), rangeText(result.cost.cny)].map(cell).join(' | ')} |`);
  }
  lines.push('', '回傳模型、計費依據與限制：', '');
  for (const result of data.results) {
    lines.push(`- ${result.label}: ${cell(result.model)} / ${cell(result.effort)}；回傳模型 ${cell(result.returnedModel || '未回傳')}，回傳檔位 ${cell(result.returnedEffort || '未回傳')}，service tier ${cell(result.serviceTier || '未回傳')}。${cell(result.cost.basis)} ${result.cost.notes.map(cell).join('；')}`);
  }
  lines.push('', '## 額外嘗試與重試紀錄', '',
    'results/ 保留每個配置最後的結果；attempts/ 保存被重試取代的額外呼叫。這裡的紀錄不是另一份用於品質比較的成功樣本；已知用量與費用會納入下方合計。', '');
  if (!data.extraAttempts.length) lines.push('沒有封存的額外嘗試。', '');
  else {
    lines.push('| 紀錄 | 配置 | 狀態 | 開始 | 結束 | 輸入 | 輸出 | 總 token | USD | CNY | 錯誤 |',
      '| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |');
    for (const attempt of data.extraAttempts) {
      lines.push(`| ${[attempt.attemptFile, `${attempt.label}: ${attempt.id}`, attempt.status, attempt.startedAt, attempt.finishedAt,
        attempt.usage.input, attempt.usage.output, attempt.usage.total, rangeText(attempt.cost.usd), rangeText(attempt.cost.cny), attempt.error].map(cell).join(' | ')} |`);
    }
    for (const attempt of data.extraAttempts) {
      lines.push('', `- ${cell(attempt.attemptFile)}：${attempt.rawUsagePresent ? '有原始用量欄位。' : '未取得原始用量；即使 HTTP 成功，也不能當成沒有產生費用。'} ${cell(attempt.cost.basis)} ${attempt.cost.notes.map(cell).join('；')}`,
        '', codeBlock(JSON.stringify({ usage: attempt.usage, cost: attempt.cost }, null, 2)), '');
    }
  }
  lines.push('', '## 本輪彙總', '', '金額按供應商分列；不同計費口徑不合成一個「實際花費」。包含最終結果及額外嘗試的已知用量與費用。只加總已回傳的數值，部分未知時標示已知筆數，未知部分不算零。', '',
    '| 計價口徑 | 完成配置 | 總嘗試 | USD 區間 | 已取得費用 | CNY 區間 |',
    '| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const aggregate of data.aggregates.filter((row) => row.provider !== 'all')) {
    lines.push(`| ${[aggregate.label, `${aggregate.completed}/${aggregate.configurations}`, aggregate.attempts, rangeText(aggregate.cost.usd), `${aggregate.cost.usd.known}/${aggregate.attempts}`, rangeText(aggregate.cost.cny)].map(cell).join(' | ')} |`);
  }
  lines.push('', '| 用量來源 | 輸入 | 快取讀 | 快取寫 | 輸出（含推理） | 推理 | 總 token |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const aggregate of data.aggregates) {
    lines.push(`| ${[aggregate.label, ...usageFields.map((field) => aggregateValue(aggregate.usage[field], aggregate.attempts))].map(cell).join(' | ')} |`);
  }
  lines.push('', '## DeepSeek 尖峰／離峰費用對照', '', data.deepseekScenarios.note, '', data.deepseekScenarios.schedule, '',
    '| 最終配置 | 實際時段 | 假設尖峰 USD | 假設離峰 USD | 假設尖峰 CNY | 假設離峰 CNY |',
    '| --- | --- | ---: | ---: | ---: | ---: |');
  for (const row of data.deepseekScenarios.rows) {
    lines.push(`| ${[`${row.label}: ${row.model} / ${row.effort}`, row.actualBand || '未取得',
      rangeText(row.peak?.usd, '', 9), rangeText(row.offpeak?.usd, '', 9), rangeText(row.peak?.cny, '', 9), rangeText(row.offpeak?.cny, '', 9)].map(cell).join(' | ')} |`);
  }
  const scenarioTotal = data.deepseekScenarios.total;
  lines.push(`| ${['已知用量合計（含額外嘗試）', '各紀錄原始時段另列', rangeText(scenarioTotal.peak.usd, '', 9), rangeText(scenarioTotal.offpeak.usd, '', 9), rangeText(scenarioTotal.peak.cny, '', 9), rangeText(scenarioTotal.offpeak.cny, '', 9)].map(cell).join(' | ')} |`, '',
    `尖峰情境有 ${scenarioTotal.peak.known}/${data.deepseekScenarios.attempts} 次可計價、${scenarioTotal.peak.unknown} 次未知；離峰情境有 ${scenarioTotal.offpeak.known}/${data.deepseekScenarios.attempts} 次可計價、${scenarioTotal.offpeak.unknown} 次未知。缺少用量的失敗呼叫在兩個情境都保持未知，沒有按零計入。`, '');
  lines.push('', '## 費用公式', '');
  for (const note of data.formulaNotes) lines.push(`- ${note}`);
  lines.push('', '## 方法與限制', '');
  for (const note of data.methodNotes) lines.push(`- ${note}`);
  lines.push('', '本輪記錄的方法設定：', '', codeBlock(JSON.stringify(data.methodology, null, 2)));
  lines.push('', '## 價格來源與重現資料', '', `文件查核時間：${data.pricing.checkedAt ?? '未記錄'}`, '');
  for (const source of data.sources) lines.push(`- [${source.title.replaceAll(']', '\\]')}](${source.url})`);
  lines.push('', `來源 hash：${data.sourceHash}`, '', `Prompt hash：${data.promptHash}`, '',
    `價格 hash：${data.pricingHash}`, '', `術語 hash：${data.glossaryHash}`, '',
    '價格設定：', '', codeBlock(JSON.stringify(data.pricing, null, 2)), '',
    '程式與執行來源補充紀錄：', '', codeBlock(JSON.stringify(data.executionProvenance, null, 2)), '',
    'System prompt：', '', codeBlock(data.systemPrompt), '',
    'User prompt：', '', codeBlock(data.prompt), '',
    'manifest.json 保存完整請求文字與配置；results/ 保存各配置最終回傳紀錄；attempts/ 保存額外嘗試；anonymous-labels.json 保存亂數種子和代號映射。metrics.csv 的 rowType 區分 final_result 與 archived_attempt，attemptFile 保留來源檔名；兩類都納入費用合計。HTML 亦內含本輪方法、完整請求文字、額外嘗試與價格設定，可單檔交付。', '');
  return lines.join('\n');
}

function htmlFor(data, csv) {
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<title>Musicmap 翻譯模型對比報告 · ${htmlEscape(data.id)}</title>
<style>
:root{color-scheme:light;--ink:#203333;--muted:#506767;--line:#cedbd9;--accent:#176659;--surface:#fff;--page:#eff4f1;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Noto Sans TC",sans-serif;font-size:16px}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);line-height:1.7}main{max-width:1560px;margin:auto;padding:28px 24px 70px}h1{font-size:clamp(1.65rem,3vw,2.4rem);margin:0 0 8px}h2{font-size:1.3rem;margin:0 0 14px}h3{font-size:1rem;margin:0}p{margin:0 0 12px}.muted,small{color:var(--muted)}.intro{max-width:1040px}.panel{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:20px;margin-top:20px}.toolbar{display:flex;gap:16px;align-items:center;flex-wrap:wrap}.toolbar label{display:flex;gap:8px;align-items:center}select,button{font:inherit;color:inherit;border:1px solid #9caeaa;border-radius:6px;padding:7px 11px;background:white}select{max-width:100%}button{cursor:pointer}button:hover{background:#e9f2ee}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid #df9827;outline-offset:3px}input{accent-color:var(--accent)}.chooser{margin:16px 0 0;padding:12px 0 0;border:0;border-top:1px solid var(--line)}.chooser legend{padding:0 8px 0 0}.choices{display:flex;flex-wrap:wrap;gap:8px}.choice{display:flex;align-items:center;gap:7px;padding:5px 10px;background:#f0f5f3;border:1px solid var(--line);border-radius:6px;cursor:pointer}.reading{display:grid;grid-template-columns:minmax(250px,.8fr) minmax(0,2fr);gap:18px;align-items:start;margin-top:20px}.original{position:sticky;top:18px}.original,.translation{padding:20px;background:white;border:1px solid var(--line);border-radius:12px;min-width:0}.original{border-top:4px solid var(--accent)}.translations{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.translation:only-child{grid-column:1/-1}.translation header{padding-bottom:12px;margin-bottom:14px;border-bottom:1px solid var(--line)}.copy{white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0 0}.english{font-family:Georgia,"Times New Roman",serif;font-size:1.075rem;line-height:1.8}.chinese{font-size:1.06rem;line-height:1.95}.badge{font-size:.8rem;color:var(--muted);font-weight:400}.empty{padding:24px;border:1px dashed #a5b8b1;border-radius:12px}.error{color:#873222}.metrics-scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:.87rem}th,td{border-bottom:1px solid var(--line);padding:9px 10px;text-align:right;white-space:nowrap}th{background:#f0f5f3}th:first-child,td:first-child,th:nth-child(2),td:nth-child(2){text-align:left}caption{text-align:left;color:var(--muted);padding:0 0 12px}.cost-notes{margin-top:18px;display:grid;gap:8px}.cost-note{padding:10px 12px;background:#f5f7f6;border-radius:6px}.cost-note p{margin:4px 0 0}details{margin-top:14px}summary{cursor:pointer;font-weight:600}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f0f5f3;padding:14px;border-radius:6px;font-size:.83rem}a{color:#095e54}.foot{margin-top:24px;font-size:.87rem}#run-summary{font-variant-numeric:tabular-nums}#announcer{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}[hidden]{display:none!important}
@media(max-width:1050px){.translations{grid-template-columns:1fr}.reading{grid-template-columns:minmax(240px,.8fr) minmax(0,1.3fr)}}
@media(max-width:700px){main{padding:20px 12px 44px}.reading{grid-template-columns:1fr}.original{position:static}.panel,.original,.translation{padding:16px}.toolbar{align-items:flex-start;gap:12px}.toolbar .sample-control{flex-direction:column;align-items:flex-start}select{width:100%}}
@media print{body{background:white}main{max-width:none;padding:0}.toolbar,.chooser,#download-csv{display:none}.reading,.translations{display:block}.original{position:static}.original,.translation{break-inside:avoid;margin:16px 0}.panel{border:0;padding:0}}
</style></head><body><main>
<header class="intro"><h1>Musicmap 翻譯模型對比報告</h1><p>先讀譯文，再揭曉模型。文字品質由你評判，這份報告沒有品質分數或排名。</p>
<p class="muted">譯文為模型直接輸出的簡體中文，未經簡繁轉換或人工潤飾。英文片段是本次測試自寫的音樂領域評測文字，不是 Musicmap 原站引文。</p><p id="run-summary" class="muted"></p></header>
<section class="panel" aria-label="閱讀設定"><div class="toolbar"><label class="sample-control" for="passage">英文片段 <select id="passage"></select></label><label><input id="reveal" type="checkbox">揭曉模型與檔位</label><label><input id="metrics-toggle" type="checkbox">顯示 token 與費用</label></div>
<fieldset class="chooser"><legend>選擇要並排閱讀的譯本</legend><div class="toolbar"><button id="select-all" type="button">全選</button><button id="select-none" type="button">清空</button><span class="muted">代號在同一輪測試中固定。</span></div><div id="choices" class="choices" style="margin-top:12px"></div></fieldset></section>
<div id="announcer" aria-live="polite"></div><section class="reading" aria-label="原文與譯文"><article class="original"><h2 id="original-title"></h2><div id="original-text" class="copy english" lang="en"></div></article><div id="translations" class="translations"></div></section>
<section id="metrics-panel" class="panel" aria-label="Token 與費用" hidden><h2>Token 與等價費用</h2><p>DeepSeek 金額按官方文件價格估算；Codex 金額為 API 等價估算，不是訂閱實際扣款。成本區間保留快取寫入等缺失欄位造成的不確定性。</p><p class="muted">原定每個配置取得一份成功結果；實際嘗試次數包含失敗與重試。快取狀態未受控，不同供應商的 token 切分方式不同，token 數不能單獨用來判斷效率或文字品質。</p><p id="attempt-summary"></p><p id="unknown-spend" class="error" hidden></p>
<h3>本輪合計</h3><p class="muted">金額按計價口徑分列；包含最終結果與額外嘗試的已知數值。部分未知時標示已知筆數，未知部分不算零。</p><div class="metrics-scroll"><table><thead><tr><th>計價口徑</th><th>完成配置</th><th>總嘗試</th><th>USD 區間</th><th>已取得費用</th><th>CNY 區間</th></tr></thead><tbody id="aggregate-cost-body"></tbody></table></div>
<div class="metrics-scroll" style="margin-top:16px"><table><caption>全部供應商的 token 合計僅記錄本輪用量；跨供應商的 token 不能作等值效率比較。</caption><thead><tr><th>用量來源</th><th>輸入</th><th>快取讀</th><th>快取寫</th><th>輸出（含推理）</th><th>推理</th><th>總 token</th></tr></thead><tbody id="aggregate-token-body"></tbody></table></div>
<h3 style="margin-top:24px">DeepSeek 尖峰／離峰費用對照</h3><p id="deepseek-scenario-note" class="muted"></p><p id="deepseek-schedule" class="muted"></p><div class="metrics-scroll"><table><thead><tr><th>最終配置</th><th>實際時段</th><th>假設尖峰 USD</th><th>假設離峰 USD</th><th>假設尖峰 CNY</th><th>假設離峰 CNY</th></tr></thead><tbody id="deepseek-scenario-body"></tbody></table></div><p id="deepseek-scenario-unknown" class="muted"></p>
<h3 style="margin-top:24px">各配置最終結果用量</h3><div class="metrics-scroll"><table><caption>輸入包含快取讀／寫部分；推理 token 已含在輸出中，不重複加總。「—」表示未回傳或不適用。</caption><thead><tr><th>譯本／配置</th><th>狀態</th><th>輸入</th><th>快取讀</th><th>快取寫</th><th>輸出</th><th>推理</th><th>總 token</th><th>秒</th><th>USD</th><th>CNY</th></tr></thead><tbody id="metrics-body"></tbody></table></div><div id="cost-notes" class="cost-notes"></div>
<h3 style="margin-top:24px">額外嘗試與重試紀錄</h3><p class="muted">這些紀錄保存被重試取代的額外呼叫，不作另一份成功譯文參與閱讀比較；已知費用仍納入本輪合計。CSV 以 rowType 區分 final_result 與 archived_attempt。</p><p id="no-extra-attempts" hidden>沒有封存的額外嘗試。</p><div class="metrics-scroll"><table id="extra-attempt-table"><thead><tr><th>紀錄／配置</th><th>狀態</th><th>開始</th><th>結束</th><th>輸入</th><th>輸出</th><th>總 token</th><th>USD</th><th>CNY</th><th>錯誤</th></tr></thead><tbody id="extra-attempt-body"></tbody></table></div><div id="extra-attempt-notes" class="cost-notes"></div>
<p style="margin-top:16px"><button id="download-csv" type="button">下載 metrics.csv（含模型與所有嘗試）</button></p><details><summary>費用公式、價格來源與設定</summary><ul id="formulas"></ul><p id="checked-at" style="margin-top:12px"></p><ul id="sources"></ul><pre id="pricing"></pre></details></section>
<footer class="foot muted"><p>這是方便閱讀的匿名模式，不是加密盲測：模型映射仍在 HTML 與 anonymous-labels.json 中。勾選揭曉、檢視檔案原始碼或開啟 CSV 會看到模型。</p><p>本頁可直接離線開啟，沒有遠端字型或腳本。價格來源連結只有點擊時才需要網路。每次產生報告都只讀取已有結果，不會呼叫模型 API。</p><details><summary>本輪方法與限制</summary><ul id="method-notes"></ul><pre id="methodology"></pre></details><details><summary>重現資料與完整 Prompt（含模型資料）</summary><pre id="reproducibility"></pre><h3>System prompt</h3><pre id="system-prompt"></pre><h3>User prompt</h3><pre id="user-prompt"></pre></details></footer>
</main><script type="application/json" id="report-data">${jsonForHtml({ ...data, csv })}</script><script>
(() => {
  'use strict';
  const data = JSON.parse(document.getElementById('report-data').textContent);
  const byId = id => document.getElementById(id);
  const selected = new Set(data.results.slice(0, 2).map(result => result.id));
  const node = (tag, text, className) => { const element = document.createElement(tag); if (text != null) element.textContent = String(text); if (className) element.className = className; return element; };
  const labelFor = result => byId('reveal').checked ? result.label + ' · ' + result.model + ' / ' + result.effort : '譯本 ' + result.label;
  const statusFor = result => result.status === 'pending' ? (result.sourceStatus === 'received' ? '已收到回應，待處理' : result.attemptRecorded ? '處理中' : '尚無結果') : ({ success: '完成', error: '失敗' })[result.status];
  const num = value => value == null ? '—' : value.toLocaleString('en-US');
  const money = value => value.min == null || value.max == null ? '—' : value.min === value.max ? value.min.toFixed(6) : value.min.toFixed(6) + '–' + value.max.toFixed(6);
  const returnedEffort = result => result.returnedEffort || '未回傳，無法由回應確認';
  byId('run-summary').textContent = '執行 ' + data.id + ' · ' + data.createdAt + ' · ' + data.results.filter(result => result.status === 'success').length + '/' + data.results.length + ' 個配置完成 · ' + data.attemptSummary.total + ' 次嘗試（含 ' + data.attemptSummary.additional + ' 次額外紀錄）';
  byId('attempt-summary').textContent = '實際紀錄：' + data.attemptSummary.total + ' 次嘗試，包含 ' + data.attemptSummary.additional + ' 次封存額外嘗試；失敗紀錄 ' + data.attemptSummary.failed + ' 次。';
  if (data.attemptSummary.unknownSpend) { byId('unknown-spend').hidden = false; byId('unknown-spend').textContent = data.attemptSummary.unknownSpend + ' 次嘗試缺少原始用量或完整計價，其費用仍有未知部分；下方已知成本區間不包含這些未知費用，不能當成整輪花費上限。HTTP 200 或沒有回傳 usage 都不代表免費。'; }
  for (const passage of data.passages) { const option = node('option', passage.title); option.value = passage.id; byId('passage').append(option); }
  function renderChoices() {
    byId('choices').replaceChildren();
    for (const result of data.results) {
      const label = node('label', null, 'choice');
      const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(result.id); checkbox.dataset.configuration = result.id;
      checkbox.addEventListener('change', () => { if (checkbox.checked) selected.add(result.id); else selected.delete(result.id); renderTranslations(); });
      label.append(checkbox, node('span', labelFor(result))); byId('choices').append(label);
    }
  }
  function renderTranslations() {
    const passage = data.passages.find(item => item.id === byId('passage').value);
    byId('original-title').textContent = passage.title + ' · 英文'; byId('original-text').textContent = passage.text;
    byId('translations').replaceChildren();
    for (const result of data.results.filter(item => selected.has(item.id))) {
      const article = node('article', null, 'translation'); const header = node('header'); header.append(node('h3', labelFor(result)));
      if (byId('reveal').checked) header.append(node('div', '請求檔位：' + result.effort + '；回傳模型：' + (result.returnedModel || '未回傳') + '；回傳檔位：' + returnedEffort(result), 'badge'));
      article.append(header);
      const translation = result.translations.find(item => item.id === passage.id);
      if (translation) { const copy = node('div', translation.text, 'copy chinese'); copy.lang = 'zh-Hans'; article.append(copy); }
      else article.append(node('p', result.status === 'pending' ? '尚未取得結果。' : '沒有這個片段的可用譯文。', 'muted'));
      if (result.status === 'error') article.append(node('p', '請求或結果處理失敗：' + (result.error || '未提供錯誤細節'), 'error'));
      if (!translation && result.text) { const details = node('details'); details.append(node('summary', '檢視未解析的模型原始輸出'), node('pre', result.text)); article.append(details); }
      byId('translations').append(article);
    }
    if (!selected.size) byId('translations').append(node('p', '請勾選上方譯本以閱讀。', 'empty'));
    byId('announcer').textContent = passage.title + '，顯示 ' + selected.size + ' 個譯本。';
  }
  function renderMetrics() {
    byId('metrics-body').replaceChildren(); byId('cost-notes').replaceChildren();
    byId('deepseek-scenario-body').replaceChildren();
    const scenarioMoney = value => value?.min == null || value?.max == null ? '—' : value.min === value.max ? value.min.toFixed(9) : value.min.toFixed(9) + '–' + value.max.toFixed(9);
    const appendScenario = values => { const row = node('tr'); for (const value of values) row.append(node('td', value)); byId('deepseek-scenario-body').append(row); };
    for (const scenario of data.deepseekScenarios.rows) appendScenario([labelFor(scenario), ({ peak: '尖峰', offpeak: '離峰', 'peak/offpeak': '跨時段', 'offpeak/peak': '跨時段' })[scenario.actualBand] || scenario.actualBand || '未取得', scenarioMoney(scenario.peak?.usd), scenarioMoney(scenario.offpeak?.usd), scenarioMoney(scenario.peak?.cny), scenarioMoney(scenario.offpeak?.cny)]);
    const scenarioTotal = data.deepseekScenarios.total;
    appendScenario(['已知用量合計（含額外嘗試）', '各紀錄原始時段另列', scenarioMoney(scenarioTotal.peak.usd), scenarioMoney(scenarioTotal.offpeak.usd), scenarioMoney(scenarioTotal.peak.cny), scenarioMoney(scenarioTotal.offpeak.cny)]);
    for (const result of data.results) {
      const usage = result.usage; const row = node('tr');
      for (const value of [labelFor(result), statusFor(result), num(usage.input), num(usage.cacheRead), num(usage.cacheWrite), num(usage.output), num(usage.reasoning), num(usage.total), result.latencyMs == null ? '—' : (result.latencyMs / 1000).toFixed(2), money(result.cost.usd), money(result.cost.cny)]) row.append(node('td', value));
      byId('metrics-body').append(row);
      const note = node('div', null, 'cost-note'); note.append(node('strong', labelFor(result)));
      note.append(node('p', result.cost.basis || '未取得計價依據'));
      for (const text of result.cost.notes) note.append(node('p', text));
      if (byId('reveal').checked) note.append(node('p', '請求檔位：' + result.effort + '；回傳模型：' + (result.returnedModel || '未回傳') + '；回傳檔位：' + returnedEffort(result) + '；service tier：' + (result.serviceTier || '未回傳')));
      byId('cost-notes').append(note);
    }
    byId('extra-attempt-body').replaceChildren(); byId('extra-attempt-notes').replaceChildren();
    byId('extra-attempt-table').hidden = data.extraAttempts.length === 0;
    byId('no-extra-attempts').hidden = data.extraAttempts.length !== 0;
    for (const [index, attempt] of data.extraAttempts.entries()) {
      const name = byId('reveal').checked ? attempt.attemptFile + ' · ' + attempt.id : '額外嘗試 ' + (index + 1) + ' · 譯本 ' + attempt.label;
      const row = node('tr');
      for (const value of [name, statusFor(attempt), attempt.startedAt || '—', attempt.finishedAt || '—', num(attempt.usage.input), num(attempt.usage.output), num(attempt.usage.total), money(attempt.cost.usd), money(attempt.cost.cny), attempt.error || '—']) row.append(node('td', value));
      byId('extra-attempt-body').append(row);
      const note = node('div', null, 'cost-note'); note.append(node('strong', name));
      if (!attempt.rawUsagePresent) note.append(node('p', '未取得原始用量，這次呼叫的費用未知，不能當成零。', 'error'));
      note.append(node('p', attempt.cost.basis || '未取得計價依據'));
      for (const text of attempt.cost.notes) note.append(node('p', text));
      const details = node('details'); details.append(node('summary', '用量與費用欄位'), node('pre', JSON.stringify({ usage: attempt.usage, cost: attempt.cost }, null, 2))); note.append(details);
      byId('extra-attempt-notes').append(note);
    }
  }
  byId('passage').addEventListener('change', renderTranslations);
  byId('reveal').addEventListener('change', () => { renderChoices(); renderTranslations(); renderMetrics(); });
  byId('metrics-toggle').addEventListener('change', () => { byId('metrics-panel').hidden = !byId('metrics-toggle').checked; });
  byId('select-all').addEventListener('click', () => { for (const result of data.results) selected.add(result.id); renderChoices(); renderTranslations(); });
  byId('select-none').addEventListener('click', () => { selected.clear(); renderChoices(); renderTranslations(); });
  byId('download-csv').addEventListener('click', () => { const url = URL.createObjectURL(new Blob([data.csv], { type: 'text/csv;charset=utf-8' })); const link = node('a'); link.href = url; link.download = 'metrics.csv'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
  byId('checked-at').textContent = '文件查核時間：' + (data.pricing.checkedAt || '未記錄');
  byId('deepseek-scenario-note').textContent = data.deepseekScenarios.note;
  byId('deepseek-schedule').textContent = data.deepseekScenarios.schedule;
  byId('deepseek-scenario-unknown').textContent = '尖峰情境有 ' + data.deepseekScenarios.total.peak.known + '/' + data.deepseekScenarios.attempts + ' 次可計價、' + data.deepseekScenarios.total.peak.unknown + ' 次未知；離峰情境有 ' + data.deepseekScenarios.total.offpeak.known + '/' + data.deepseekScenarios.attempts + ' 次可計價、' + data.deepseekScenarios.total.offpeak.unknown + ' 次未知。缺少用量的失敗呼叫在兩個情境都保持未知，沒有按零計入。';
  for (const source of data.sources) { const link = node('a', source.title); link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; const item = node('li'); item.append(link); byId('sources').append(item); }
  for (const aggregate of data.aggregates) {
    if (aggregate.provider !== 'all') {
      const row = node('tr');
      for (const value of [aggregate.label, aggregate.completed + '/' + aggregate.configurations, aggregate.attempts, money(aggregate.cost.usd), aggregate.cost.usd.known + '/' + aggregate.attempts, money(aggregate.cost.cny)]) row.append(node('td', value));
      byId('aggregate-cost-body').append(row);
    }
    const row = node('tr'); row.append(node('td', aggregate.label));
    for (const field of ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning', 'total']) {
      const usage = aggregate.usage[field];
      row.append(node('td', num(usage.sum) + (usage.sum != null && usage.known < aggregate.attempts ? '（' + usage.known + '/' + aggregate.attempts + ' 已知）' : '')));
    }
    byId('aggregate-token-body').append(row);
  }
  for (const note of data.formulaNotes) byId('formulas').append(node('li', note));
  for (const note of data.methodNotes) byId('method-notes').append(node('li', note));
  byId('pricing').textContent = JSON.stringify(data.pricing, null, 2);
  byId('methodology').textContent = JSON.stringify(data.methodology, null, 2);
  byId('reproducibility').textContent = JSON.stringify({ run: data.id, createdAt: data.createdAt, promptHash: data.promptHash, sourceHash: data.sourceHash, pricingHash: data.pricingHash, glossaryHash: data.glossaryHash, provenance: data.provenance, executionProvenance: data.executionProvenance, methodology: data.methodology, configurations: data.configurations, attemptSummary: data.attemptSummary, extraAttempts: data.extraAttempts, files: ['manifest.json', 'results/', 'attempts/', 'anonymous-labels.json', 'metrics.csv', 'report.md', 'execution-provenance.json'] }, null, 2);
  byId('system-prompt').textContent = data.systemPrompt;
  byId('user-prompt').textContent = data.prompt;
  renderChoices(); renderTranslations(); renderMetrics();
})();
</script></body></html>\n`;
}

export async function generateReport(runDirectory) {
  const directory = path.resolve(runDirectory);
  const manifest = await readJson(path.join(directory, 'manifest.json'));
  let executionProvenance = null;
  try { executionProvenance = await readJson(path.join(directory, 'execution-provenance.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!Array.isArray(manifest.configurations) || !manifest.configurations.length
    || !Array.isArray(manifest.passages) || !manifest.passages.length) {
    throw new Error('manifest.json must contain nonempty configurations and passages.');
  }
  const ids = manifest.configurations.map((config) => config.id);
  if (new Set(ids).size !== ids.length || !ids.every((id) => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id))) {
    throw new Error('Configuration IDs must be unique safe filenames.');
  }
  const passageIds = manifest.passages.map((passage) => passage.id);
  if (new Set(passageIds).size !== passageIds.length || !manifest.passages.every((passage) => typeof passage.id === 'string' && typeof passage.text === 'string')) {
    throw new Error('Passages must have unique string IDs and string text.');
  }
  const labels = await labelsFor(directory, ids);
  const results = [];
  for (const assignment of labels.assignments) {
    const config = manifest.configurations.find((item) => item.id === assignment.id);
    let result = null;
    try { result = await readJson(path.join(directory, 'results', `${config.id}.json`)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (result && result.id !== config.id) throw new Error(`Result ID mismatch for ${config.id}.`);
    results.push(normalizeResult(config, result, assignment.label));
  }
  let attemptFiles = [];
  try {
    attemptFiles = (await fs.readdir(path.join(directory, 'attempts'), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name).sort();
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const extraAttempts = [];
  for (const file of attemptFiles) {
    const attempt = await readJson(path.join(directory, 'attempts', file));
    const configurationId = attempt.configurationId ?? attempt.configId ?? attempt.id;
    const config = manifest.configurations.find((item) => item.id === configurationId);
    if (!config) throw new Error(`Archived attempt ${file} does not match a manifest configuration.`);
    // An archived failed call may retain raw usage before the runner calculates costs.
    // Reuse the same pure calculator and the frozen manifest prices; never send a request.
    if (!attempt.usage && attempt.rawUsage) attempt.usage = normalizeUsage(config.provider, attempt.rawUsage);
    if (!attempt.cost?.usd && attempt.usage) {
      try {
        attempt.cost = calculateCost({ provider: config.provider, model: config.model, usage: attempt.usage,
          startedAt: attempt.startedAt, finishedAt: attempt.finishedAt, serviceTier: attempt.serviceTier,
          pricing: manifest.pricing, bandOverride: manifest.bandOverride });
        if (attempt.cost) attempt.cost.notes = [...(attempt.cost.notes ?? []), 'Archived attempt cost reconstructed from recorded usage and manifest prices.'];
      } catch {
        attempt.cost = { notes: ['Archived usage exists, but cost could not be reconstructed from the recorded pricing/time fields. Cost remains unknown.'] };
      }
    }
    const label = labels.assignments.find((item) => item.id === config.id).label;
    extraAttempts.push({ ...normalizeResult(config, attempt, label), rowType: 'archived_attempt', attemptRecorded: true, attemptFile: `attempts/${file}` });
  }
  const attempts = [...results.filter((result) => result.attemptRecorded), ...extraAttempts];
  const attemptSummary = { total: attempts.length, canonical: results.filter((result) => result.attemptRecorded).length,
    additional: extraAttempts.length, successful: results.filter((result) => result.status === 'success').length,
    failed: attempts.filter((attempt) => attempt.status === 'error').length,
    unknownSpend: attempts.filter((attempt) => !attempt.rawUsagePresent || attempt.cost.usd.min == null || attempt.cost.usd.max == null).length };
  const data = {
    id: String(manifest.id ?? path.basename(directory)), createdAt: String(manifest.createdAt ?? ''),
    sourceHash: String(manifest.sourceHash ?? ''), promptHash: String(manifest.promptHash ?? ''),
    pricingHash: String(manifest.pricingHash ?? ''), glossaryHash: String(manifest.glossaryHash ?? ''),
    provenance: manifest.provenance ?? null, executionProvenance,
    methodology: manifest.methodology ?? {}, systemPrompt: String(manifest.systemPrompt ?? ''), prompt: String(manifest.prompt ?? ''),
    configurations: manifest.configurations.map(({ id, provider, model, effort }) => ({ id, provider, model, effort })),
    passages: manifest.passages.map((passage) => ({ id: passage.id, title: String(passage.title ?? passage.id), text: passage.text })),
    pricing: manifest.pricing ?? {}, sources: sourcesFor(manifest.pricing), results, extraAttempts, attemptSummary,
    aggregates: aggregatesFor(results, extraAttempts), deepseekScenarios: deepseekScenariosFor(results, extraAttempts, manifest), formulaNotes, methodNotes,
  };
  const csv = csvFor([...results, ...extraAttempts]);
  const outputs = { 'report.html': htmlFor(data, csv), 'report.md': markdownFor(data), 'metrics.csv': csv };
  for (const [name, content] of Object.entries(outputs)) await fs.writeFile(path.join(directory, name), content, 'utf8');
  return { directory, outputs: Object.keys(outputs), completed: results.filter((result) => result.status === 'success').length, configurations: results.length, attempts: attemptSummary.total, extraAttempts: extraAttempts.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argument = process.argv[2];
  if (!argument || ['--help', '-h'].includes(argument)) {
    console.log('Usage: node scripts/benchmark-report.mjs artifacts/translation-benchmark/<run>\nReads existing results only; creates report.html, report.md, metrics.csv, and persistent anonymous-labels.json.');
    if (!argument) process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await generateReport(argument), null, 2)); }
    catch (error) { console.error(`Benchmark report failed: ${error.message}`); process.exitCode = 1; }
  }
}
