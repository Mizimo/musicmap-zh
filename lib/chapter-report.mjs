import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { load } from 'cheerio';
import { normalizeUsage } from './benchmark-cost.mjs';
import { stripChapterMarkers } from './chapter-units.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const normal = text => text.replace(/\s+/g, ' ').trim();
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fields = ['input', 'cacheRead', 'output', 'reasoning', 'total'];
const stateLabel = state => ({ completed: '已完成', failed: '失敗', unknown: '結果未確認', 'not-sent': '送出前停止', pending: '尚未執行' })[state] ?? state;

async function filesBelow(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Baseline request history must not contain symlinks.');
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await filesBelow(path));
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(path);
  }
  return out.sort();
}

async function readBaseline(baselineDir, expectedCount) {
  const translations = new Map(), sourceHashes = new Set(), shardFiles = [];
  for (let index = 1; index <= 8; index++) {
    const relative = `generated/shards/zh-Hans-${index}-of-8.json`;
    const bytes = await readFile(join(baselineDir, relative));
    const shard = JSON.parse(bytes);
    if (!shard.translations || shard.language !== 'zh-Hans') throw new Error('Invalid baseline shard.');
    sourceHashes.add(shard.sourceHash);
    for (const [source, translation] of Object.entries(shard.translations)) {
      if (translations.has(source) || typeof translation !== 'string' || !translation.trim()) throw new Error('Conflicting or invalid baseline translation.');
      translations.set(source, translation);
    }
    shardFiles.push({ file: relative, sha256: hash(bytes) });
  }
  if (sourceHashes.size !== 1 || typeof [...sourceHashes][0] !== 'string') throw new Error('Baseline source hashes differ.');
  if (translations.size !== expectedCount) throw new Error(`Expected ${expectedCount} baseline translations; found ${translations.size}.`);
  const evidence = new Map(), requests = new Map();
  const directory = join(baselineDir, 'generated/translation-requests');
  for (const file of await filesBelow(directory)) {
    const record = await json(file);
    if (!record.requestId) throw new Error('Baseline request has no identity.');
    const identity = JSON.stringify(record);
    if (requests.has(record.requestId) && requests.get(record.requestId) !== identity) throw new Error('Conflicting duplicated baseline request.');
    requests.set(record.requestId, identity);
    if (record.type !== 'completed') continue;
    if (record.model !== 'deepseek-v4-pro' || record.reasoningEffort !== 'max') throw new Error('Baseline must contain original Pro Max output only.');
    if (!Array.isArray(record.textHashes) || !Array.isArray(record.translations) || record.textHashes.length !== record.translations.length) throw new Error('Invalid baseline request evidence.');
    record.textHashes.forEach((textHash, index) => {
      const key = `${textHash}:${hash(record.translations[index])}`;
      if (!evidence.has(key)) evidence.set(key, new Set());
      evidence.get(key).add(record.requestId);
    });
  }
  let seed = {};
  try { seed = await json(join(baselineDir, 'generated/locales/zh-Hans.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { translations, evidence, seed, records: [...requests.values()].map(value => JSON.parse(value)),
    metadata: { marker: 'v0.1-pro-max-baseline', directory: resolve(baselineDir),
    translated: translations.size, sourceHash: [...sourceHashes][0], shardFiles, journalRequests: requests.size,
    note: '原始 Max／字典種子基線；不含無思考續作及已廢棄五批。' } };
}

/** Reproduce V1 text-node stitching, including its original short-fragment omissions. */
function baselineChapter(unit, baseline) {
  const $ = load(String(unit.html ?? ''));
  const paragraphs = [], pieces = []; let nodes = [];
  const flush = () => { if (nodes.some(node => node.english.trim())) paragraphs.push({ english: nodes.map(n => n.english).join(''), text: nodes.map(n => n.text).join(''), pieces: nodes }); nodes = []; };
  function visit(node) {
    if (node.type === 'text') {
      const raw = node.data, source = normal(raw), eligible = /[a-zA-Z]{2}/.test(raw) && raw.trim().length > 1;
      const value = eligible ? baseline.translations.get(source) : undefined;
      const requestIds = value === undefined ? [] : [...(baseline.evidence.get(`${hash(source)}:${hash(value)}`) ?? [])].sort();
      const evidenceKind = value === undefined ? eligible ? 'missing' : 'excluded-original-fragment' : requestIds.length ? 'max-journal' : baseline.seed[source] === value ? 'seed' : 'baseline-only';
      const piece = { source, sourceHash: hash(source), english: raw, text: value === undefined ? raw : raw.replace(raw.trim(), () => value),
        translated: value !== undefined, evidenceKind, requestIds };
      nodes.push(piece); if (raw.trim()) pieces.push(piece); return;
    }
    if (['script', 'style', 'noscript', 'iframe', 'textarea'].includes(node.name)) return;
    if (node.name === 'br') { flush(); return; }
    const block = ['div', 'p', 'section', 'article', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(node.name);
    if (block) flush(); for (const child of node.children ?? []) visit(child); if (block) flush();
  }
  visit($.root()[0]); flush();
  return { text: paragraphs.map(p => p.text).join('\n\n'), paragraphs,
    requestIds: [...new Set(pieces.flatMap(piece => piece.requestIds))].sort(),
    translatedFragments: pieces.filter(p => p.translated).length,
    missingFragments: pieces.filter(p => p.evidenceKind === 'missing').length,
    excludedFragments: pieces.filter(p => p.evidenceKind === 'excluded-original-fragment').length,
    seedFragments: pieces.filter(p => p.evidenceKind === 'seed').length,
    unverifiedFragments: pieces.filter(p => p.evidenceKind === 'baseline-only').length };
}

function normalizedAttempt(attempt) {
  const state = ['reserved', 'started'].includes(attempt.state) ? 'unknown' : attempt.state;
  const inconsistentUsage = attempt.errorCode === 'INCONSISTENT_USAGE';
  if (!attempt.chapterId || !['completed', 'failed', 'unknown', 'not-sent'].includes(state)
    || (!attempt.requestId && !['unknown', 'not-sent'].includes(state))) throw new Error('Attempt requires chapterId and a request identity, or an unresolved reservation.');
  if (state === 'not-sent' && attempt.requestSent !== false) throw new Error('A not-sent reservation requires explicit requestSent:false evidence.');
  if (state === 'not-sent' && inconsistentUsage) throw new Error('A not-sent reservation cannot contain inconsistent billed usage.');
  if (!Number.isSafeInteger(attempt.ordinal) || attempt.ordinal < 1) throw new Error('Invalid attempt ordinal.');
  const raw = attempt.rawUsage ?? null, fromRaw = normalizeUsage('deepseek', raw), input = fromRaw ?? attempt.usage ?? {};
  const usage = Object.fromEntries(fields.map(field => [field, integer(input[field])]));
  if (inconsistentUsage) for (const field of fields) usage[field] = null;
  if (usage.input !== null && usage.output !== null) {
    if (usage.total !== null && usage.total !== usage.input + usage.output) throw new Error('Inconsistent recorded token total.');
    usage.total = usage.input + usage.output;
  }
  if (integer(raw?.total_tokens) !== null && usage.total !== null && raw.total_tokens !== usage.total) throw new Error('Raw usage total differs from input plus output.');
  if (usage.reasoning !== null && usage.output !== null && usage.reasoning > usage.output) throw new Error('Reasoning tokens exceed output.');
  if (usage.cacheRead !== null && usage.input !== null && usage.cacheRead > usage.input) throw new Error('Cache tokens exceed input.');
  if (state === 'not-sent') {
    if (fields.some(field => (usage[field] ?? 0) > 0)) throw new Error('A not-sent reservation cannot contain billed usage.');
    for (const field of fields) usage[field] = 0;
  }
  const cost = Object.fromEntries(['usd', 'cny'].map(currency => {
    const bounds = inconsistentUsage ? null : attempt.cost?.[currency];
    const value = { min: amount(bounds?.min), max: amount(bounds?.max) };
    if (value.min !== null && value.max !== null && value.min > value.max) throw new Error('Invalid cost bounds.');
    if (state === 'not-sent') {
      if ((value.min ?? 0) > 0 || (value.max ?? 0) > 0) throw new Error('A not-sent reservation cannot contain a billed cost.');
      value.min = 0; value.max = 0;
    }
    return [currency, value];
  }));
  if (state === 'completed' && (typeof attempt.translation !== 'string' || !attempt.translation.trim())) throw new Error('Completed chapter requires a translation.');
  return { ordinal: attempt.ordinal, chapterId: attempt.chapterId, state, requestId: attempt.requestId ?? null,
    requestSent: typeof attempt.requestSent === 'boolean' ? attempt.requestSent : null,
    reservationState: ['reserved', 'started'].includes(attempt.state) ? attempt.state : null,
    accountingNote: inconsistentUsage ? '供應商用量欄位互相矛盾；保留 rawUsage 查證，彙總用量及費用維持未知。' : null,
    journalFile: attempt.journalFile ?? null, source: attempt.source ?? null, translation: attempt.translation ?? null,
    rawUsage: raw, usage, cost, latencyMs: amount(attempt.latencyMs), errorCode: attempt.errorCode ?? null };
}

function uniqueAttempts(attempts, limit) {
  const requests = new Map();
  for (const raw of attempts) {
    const attempt = normalizedAttempt(raw), key = attempt.requestId ?? `reservation:${attempt.ordinal}:${attempt.chapterId}`;
    const previous = requests.get(key);
    const signature = value => JSON.stringify({ ...value, journalFile: undefined });
    if (previous && signature(previous) !== signature(attempt)) throw new Error('Conflicting duplicate request in report.');
    if (!previous) requests.set(key, attempt);
  }
  const result = [...requests.values()].sort((a, b) => a.ordinal - b.ordinal);
  if (result.length > limit || result.some(a => a.ordinal > limit)) throw new Error('Attempt allowance exceeded.');
  if (new Set(result.map(a => a.ordinal)).size !== result.length) throw new Error('Two requests share one allowance ordinal.');
  if (new Set(result.map(a => a.chapterId)).size !== result.length) throw new Error('Pilot chapter was sent more than once.');
  return result;
}

function summarize(attempts) {
  const tally = field => {
    const reported = attempts.filter(a => a.usage[field] !== null);
    const knownSubtotal = reported.reduce((sum, a) => sum + a.usage[field], 0);
    return { total: reported.length === attempts.length ? knownSubtotal : null, knownSubtotal, reported: reported.length, unknown: attempts.length - reported.length };
  };
  const costs = Object.fromEntries(['usd', 'cny'].map(currency => {
    const known = attempts.filter(a => a.cost[currency].min !== null && a.cost[currency].max !== null);
    const min = known.reduce((sum, a) => sum + a.cost[currency].min, 0), max = known.reduce((sum, a) => sum + a.cost[currency].max, 0);
    return [currency, { min: known.length === attempts.length ? min : null, max: known.length === attempts.length ? max : null,
      knownMin: min, knownMax: max, known: known.length, unknown: attempts.length - known.length }];
  }));
  return { attempts: attempts.length, completed: attempts.filter(a => a.state === 'completed').length,
    failed: attempts.filter(a => a.state === 'failed').length, unknown: attempts.filter(a => a.state === 'unknown').length,
    notSent: attempts.filter(a => a.state === 'not-sent').length,
    usage: Object.fromEntries(fields.map(field => [field, tally(field)])), cost: costs };
}

function summarizeHistory(records, { label, selectedHashes = null } = {}) {
  const attempts = records.map((record, index) => normalizedAttempt({ ordinal: index + 1, chapterId: 'historical-fragments',
    state: record.type === 'completed' ? 'completed' : record.type === 'failed' ? 'failed' : 'unknown',
    requestId: record.requestId, translation: record.type === 'completed' ? record.translations.join('\n') : null,
    rawUsage: record.rawUsage, usage: record.normalizedUsage, cost: record.cost, errorCode: record.errorCode }));
  const known = records.filter(record => integer(record.sourceCount) !== null);
  const knownSubtotal = known.reduce((sum, record) => sum + record.sourceCount, 0);
  return { label, ...summarize(attempts),
    sourceCount: { total: known.length === records.length ? knownSubtotal : null, knownSubtotal,
      reported: known.length, unknown: records.length - known.length },
    uniqueSourceCount: new Set(records.flatMap(record => record.textHashes ?? [])).size,
    matchedUniqueSourceCount: selectedHashes ? new Set(records.flatMap(record => (record.textHashes ?? []).filter(value => selectedHashes.has(value)))).size : null,
    requestIds: records.map(record => record.requestId).sort(),
    requests: attempts.map((attempt, index) => ({ requestId: attempt.requestId, state: attempt.state,
      sourceCount: integer(records[index].sourceCount), usage: attempt.usage, cost: attempt.cost,
      matchedSourceHashes: selectedHashes ? (records[index].textHashes ?? []).filter(value => selectedHashes.has(value)) : null })),
    note: selectedHashes ? '按原文 hash 關聯，包含成功及失敗請求；整批也包含其他章節片段。沒有分攤成本，不能當作同章精確成本。'
      : '基線歷史整輪，範圍不同，不能直接算節省率。包含成功及失敗，不含獨立模型 benchmark、廢棄五批或無思考續作。' };
}

function historyComparison(chapters, baseline) {
  const selectedHashes = new Set(chapters.flatMap(chapter => chapter.baseline.paragraphs.flatMap(paragraph => paragraph.pieces.map(piece => piece.sourceHash))));
  const associated = baseline.records.filter(record => (record.textHashes ?? []).some(value => selectedHashes.has(value)));
  return { baseline: summarizeHistory(baseline.records, { label: '基線歷史整輪' }),
    selectedChapters: summarizeHistory(associated, { label: '涉及所選章節的歷史請求（整批）', selectedHashes }) };
}

const num = value => value === null ? '未回報' : value.toLocaleString('en-US');
const money = (bounds, precision = 6) => bounds.min === null || bounds.max === null ? '未知' : bounds.min === bounds.max ? bounds.min.toFixed(precision) : `${bounds.min.toFixed(precision)}–${bounds.max.toFixed(precision)}`;
const csvQuote = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
const fenced = value => { const fence = '`'.repeat(Math.max(3, ...([...String(value).matchAll(/`+/g)].map(match => match[0].length + 1)))); return `${fence}text\n${value}\n${fence}`; };

function csvFor(report) {
  const headers = ['ordinal', 'chapterId', 'title', 'state', 'requestId', 'requestSent', 'journalFile', 'input', 'cacheRead', 'output', 'reasoning', 'total', 'usdMin', 'usdMax', 'latencyMs', 'errorCode', 'english', 'baseline', 'sourceMarked', 'translationVerbatim'];
  const rows = report.chapters.map(chapter => {
    const a = chapter.attempt;
    return [a?.ordinal, chapter.id, chapter.title, chapter.state, a?.requestId, a?.requestSent, a?.journalFile, ...fields.map(field => a?.usage[field]),
      a?.cost.usd.min, a?.cost.usd.max, a?.latencyMs, a?.errorCode, chapter.english, chapter.baseline.text, chapter.source, chapter.translation];
  });
  return '\ufeff' + [headers, ...rows].map(row => row.map(csvQuote).join(',')).join('\r\n');
}

function markdownFor(r) {
  const u = r.summary, total = u.usage.total;
  const lines = ['# Musicmap 完整章節 Pro Max 對照', '', `先閱讀 ${r.chapters.length} 章對照。已用名額 ${u.attempts}／${r.requestLimit}；成功 ${u.completed}、失敗 ${u.failed}、結果未確認 ${u.unknown}、送出前停止 ${u.notSent}。預留或中斷名額不代表已確認送出；有 requestSent:false 證據的送出前停止不產生 API 用量或費用。`, '',
    `設定：${r.config.model}；thinking enabled；reasoning_effort max；max_tokens ${r.config.maxTokens}。`, '',
    '舊欄為歸檔 5,809 條基線按原文字節點拼接；新欄為完整章節翻譯。未採用無思考續作或廢棄試跑。不是只改思考模式的單一變因比較。', '',
    `總 tokens：${num(total.total)}；已知小計 ${num(total.knownSubtotal)}，${total.unknown} 次未回報。USD 估算：${money(u.cost.usd)}。失敗請求已包含；未知費用不視為零。`, '',
    '思考 tokens 包含在 output，cacheRead 包含在 input。舊請求跨多章／片段，不按比例分攤為精確同文成本。', '',
    '## 歷史用量參照', '', '基線歷史整輪，範圍不同，不能直接算節省率。所選章節相關請求的整批用量也包含其他章節片段；sourceCount 是 API 送出片段數，重試會重複計入。以下費用沿用 journal 已保存的估算。', '',
    '| 範圍 | 請求 | 成功／失敗 | sourceCount | 輸入 | 輸出 | 其中思考 | 總 tokens | USD 估算 |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...Object.values(r.history).map(row => `| ${row.label} | ${row.attempts} | ${row.completed}／${row.failed} | ${num(row.sourceCount.total)} | ${num(row.usage.input.total)} | ${num(row.usage.output.total)} | ${num(row.usage.reasoning.total)} | ${num(row.usage.total.total)} | ${money(row.cost.usd, 8)} |`), '',
    `關聯規則：完整章節原文節點 hash 與歷史 request.textHashes 相交，同一 requestId 只計一次。相關請求涉及 ${r.history.selectedChapters.matchedUniqueSourceCount} 個所選章節來源片段；完整 request ID、用量、費用與匹配 hash 保存在 report-data.json。`, '',
    '## 本次各批用量', '',
    '| 批次 | 章節 | 狀態 | 輸入 | 輸出 | 其中思考 | 總量 | USD 估算 |', '|---:|---|---|---:|---:|---:|---:|---:|'];
  for (const chapter of r.chapters) {
    const a = chapter.attempt;
    lines.push(`| ${a?.ordinal ?? '—'} | ${chapter.title.replaceAll('|', '\\|').replace(/\r?\n/g, ' ')} | ${stateLabel(chapter.state)} | ${num(a?.usage.input ?? null)} | ${num(a?.usage.output ?? null)} | ${num(a?.usage.reasoning ?? null)} | ${num(a?.usage.total ?? null)} | ${a ? money(a.cost.usd) : '—'} |`);
  }
  for (const chapter of r.chapters) lines.push('', `## ${chapter.title.replace(/\r?\n/g, ' ')}`, '', `狀態：${stateLabel(chapter.state)}；request ${chapter.attempt?.requestId ?? '未送出'}。`, '',
    '### 英文完整章節', '', fenced(chapter.english), '', '### 舊 Max／種子基線拼接', '', fenced(chapter.baseline.text), '',
    `原先未翻片段 ${chapter.baseline.missingFragments}；原抽取規則跳過的短片段 ${chapter.baseline.excludedFragments}。這些保留原樣，不人工修補。`, '',
    '### 新 Pro Max 完整章節', '', chapter.newText === null ? `無可採用譯文：${chapter.attempt?.errorCode ?? stateLabel(chapter.state)}。` : fenced(chapter.newText), '',
    '### 新 API 原稿（含受控標記，未潤色）', '', chapter.translation === null ? '未取得。' : fenced(chapter.translation), '',
    `舊稿來源請求：${chapter.baseline.requestIds.join(', ') || '無；見逐片證據'}。`);
  return lines.join('\n') + '\n';
}

function htmlFor(r, csv) {
  const historyRows = Object.values(r.history).map(row => `<tr><th scope="row">${esc(row.label)}</th><td>${row.attempts}</td><td>${row.completed}／${row.failed}</td><td>${num(row.sourceCount.total)}</td><td>${num(row.usage.input.total)}</td><td>${num(row.usage.output.total)}</td><td>${num(row.usage.reasoning.total)}</td><td>${num(row.usage.total.total)}</td><td>$${money(row.cost.usd, 8)}</td></tr>`).join('');
  const payload = JSON.stringify(r).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const csvPayload = JSON.stringify(csv).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Musicmap｜完整章節 Pro Max 對照</title><style>
:root{color-scheme:light;--ink:#23323e;--muted:#536775;--line:#d8e0e5;--blue:#194f76}*{box-sizing:border-box}body{margin:0;background:#f4f6f7;color:var(--ink);font:16px/1.75 system-ui,sans-serif}main{max-width:1600px;margin:auto;padding:28px 28px 65px}h1{font-size:clamp(26px,3.5vw,42px);margin:8px 0}h2{font-size:23px}h3,h4{margin:0 0 12px}p{margin:8px 0}.small{font-size:14px;color:var(--muted)}.callout{border-left:3px solid #647d90;background:#eaf0f4;padding:12px 18px;margin:18px 0}.controls,nav{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0;align-items:center}button,input,select{font:inherit;color:inherit;border:1px solid var(--line);border-radius:6px;background:white;min-height:44px;padding:8px 12px}input[type=search]{flex:1;min-width:200px}input[type=checkbox]{min-height:20px}button{cursor:pointer}button[aria-pressed=true]{background:var(--blue);color:white}button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #78a2c4;outline-offset:2px}label{display:flex;align-items:center;gap:7px}.card{background:white;border:1px solid var(--line);border-radius:10px;padding:20px;margin:18px 0}.card-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;border-bottom:1px solid var(--line);margin-bottom:16px}.badge{font-size:13px;color:var(--muted)}.columns{display:grid;grid-template-columns:1fr 1fr 1fr}.column{min-width:0;padding:0 18px}.column:first-child{padding-left:0}.column:last-child{padding-right:0}.column+.column{border-left:1px solid var(--line)}.column h4{font-size:15px;color:var(--blue)}.translation,.english{white-space:pre-wrap;overflow-wrap:anywhere}.translation{font:17px/1.95 "Noto Serif SC","Songti SC",serif}.english{font:15px/1.8 Georgia,serif;color:#4b5e6b}mark{background:#e2edf5;color:inherit}details{margin-top:16px}summary{min-height:38px;cursor:pointer;color:var(--muted)}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f7;padding:12px;font:13px/1.7 ui-monospace,monospace}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;white-space:nowrap;font-size:14px}th,td{padding:10px;text-align:right;border-bottom:1px solid var(--line)}th:first-child,td:first-child{text-align:left}[hidden]{display:none!important}.status{background:#fff8e6;padding:12px}a{color:var(--blue)}@media(max-width:1000px){.columns{grid-template-columns:1fr}.column,.column:first-child,.column:last-child{padding:14px 0}.column+.column{border-left:0;border-top:1px solid var(--line)}}@media(max-width:680px){main{padding:20px 14px 40px}.card{padding:15px}.controls>label{width:100%}.card-head{display:block}}@media print{nav,.controls{display:none}.card{break-inside:avoid}main{padding:0}.columns{grid-template-columns:1fr 1fr 1fr}.column+.column{border-left:1px solid var(--line);border-top:0}}
</style></head><body><main><header><div class="small">MUSICMAP · 完整章節試跑</div><h1>對照這 ${r.chapters.length} 章完整譯文</h1><p>已用名額 <strong>${r.summary.attempts}／${r.requestLimit}</strong>；${r.summary.completed} 成功、${r.summary.failed} 失敗、${r.summary.unknown} 結果未確認、${r.summary.notSent} 送出前停止。預留或中斷名額不代表已確認送出。${esc(r.config.model)} · Max 思考開啟 · max_tokens ${r.config.maxTokens}。</p></header>
<div class="callout">左欄英文，中欄為<strong>原 Max／種子基線的片段拼接</strong>，右欄為<strong>新 Pro Max 完整章節翻譯</strong>。舊欄不含無思考續作及廢棄試跑；新欄沒有人工潤色。切分方式與提示已改變，不能單獨歸因於思考模式。</div>
<nav aria-label="報告視圖"><button data-view="chapters" aria-pressed="true">完整章節對照</button><button data-view="usage" aria-pressed="false">用量與來源</button><button id="download">下載對照 CSV</button></nav>
<section id="chapters"><div class="controls"><input id="query" type="search" aria-label="搜尋章節、原文或譯文" placeholder="搜尋章節、原文或譯文"><label>顯示 <select id="filter"><option value="all">全部批次</option><option value="different">譯文不同</option><option value="issues">失敗或尚未執行</option></select></label><label><input id="highlight" type="checkbox" checked>標示中文差異</label></div><p class="small">藍底僅標示文字差異，不代表品質評分。短詞漏譯、原始空格及拼接語病都照原稿保留；新欄只隱藏受控格式標記，原始 API 回應可展開查驗。</p><p id="count" class="small" aria-live="polite"></p><div id="cards"></div></section>
<section id="usage" hidden><h2>歷史用量參照</h2><p><strong>基線歷史整輪，範圍不同，不能直接算節省率。</strong>相關請求按所選章節的原文 hash 關聯，包含成功及失敗，同一 requestId 只計一次。整批也包含其他章節片段，沒有按比例分攤成本。</p><div class="table-wrap"><table id="history-table"><thead><tr><th>範圍</th><th>請求</th><th>成功／失敗</th><th>sourceCount</th><th>輸入</th><th>輸出</th><th>其中思考</th><th>總 tokens</th><th>USD 估算</th></tr></thead><tbody>${historyRows}</tbody></table></div><p class="small">sourceCount 是實際送出的片段數，重試會重複計入；相關歷史請求包含 ${r.history.selectedChapters.matchedUniqueSourceCount} 個所選章節來源片段。費用沿用 journal 已保存的估算。未知數值保持未知，完整 request ID 與用量證據可展開下方「版本與驗證資料」。</p><h2>本次實際請求</h2><p id="totals"></p><div class="table-wrap"><table><thead><tr><th>批次／章節</th><th>狀態</th><th>輸入</th><th>其中快取</th><th>輸出</th><th>其中思考</th><th>總 tokens</th><th>USD 估算</th><th>秒</th></tr></thead><tbody id="usage-rows"></tbody></table></div><p class="small">失敗請求已計入。有 requestSent:false 證據的送出前停止用量／費用為零，名額仍保留。其他未知欄位維持未知；思考包含在輸出、快取包含在輸入，不重複相加。費用沿用各 journal 已保存的估算，並非帳單實扣。舊請求混合多章片段，沒有按比例分攤成同文成本。</p><details><summary>版本與驗證資料</summary><pre id="metadata"></pre></details></section>
<footer class="small">${esc(r.baseline.marker)} → ${esc(r.marker)}。只供使用者對照審閱；本報告不自動更新正式語料或網站。</footer></main><script type="application/json" id="report-data">${payload}</script><script>
'use strict';const report=JSON.parse(document.getElementById('report-data').textContent),csv=${csvPayload};let view='chapters';
const el=(tag,text,css)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(css)e.className=css;return e};
const number=n=>n===null||n===undefined?'未回報':n.toLocaleString('en-US'),money=b=>b.min===null||b.max===null?'未知':b.min===b.max?'$'+b.min.toFixed(6):'$'+b.min.toFixed(6)+'–'+b.max.toFixed(6),label=s=>({completed:'已完成',failed:'失敗',unknown:'結果未確認','not-sent':'送出前停止',pending:'尚未執行'})[s]||s;
function marked(body,text,other){if(!document.getElementById('highlight').checked||other===null||text===other){body.textContent=text;return}let start=0,end=0;while(start<text.length&&start<other.length&&text[start]===other[start])start++;while(end<text.length-start&&end<other.length-start&&text[text.length-1-end]===other[other.length-1-end])end++;body.append(document.createTextNode(text.slice(0,start)),el('mark',text.slice(start,text.length-end)),document.createTextNode(end?text.slice(-end):''))}
function render(){document.getElementById('chapters').hidden=view!=='chapters';document.getElementById('usage').hidden=view!=='usage';if(view!=='chapters')return;const cards=document.getElementById('cards');cards.replaceChildren();const search=document.getElementById('query').value.trim().toLowerCase(),filter=document.getElementById('filter').value;const rows=report.chapters.filter(c=>(filter!=='different'||c.different===true)&&(filter!=='issues'||c.state!=='completed')&&(!search||[c.title,c.english,c.baseline.text,c.newText].join(String.fromCharCode(10)).toLowerCase().includes(search)));for(const c of rows){const card=el('article',undefined,'card');card.dataset.chapterId=c.id;const head=el('div',undefined,'card-head');head.append(el('h3',c.title),el('span',(c.attempt?'第 '+c.attempt.ordinal+' 批 · ':'')+label(c.state),'badge'));card.append(head);if(c.state!=='completed')card.append(el('p','無可採用的新譯文：'+(c.attempt?.errorCode||label(c.state)),'status'));const columns=el('div',undefined,'columns');for(const [title,value,other,css] of [['英文完整章節',c.english,null,'english'],['舊 Max／種子 · 片段拼接',c.baseline.text,c.newText,'translation'],['新 Pro Max · 完整章節',c.newText,null,'translation']]){const col=el('div',undefined,'column');col.append(el('h4',title));const body=el('div',undefined,css);if(value===null)body.textContent='未取得可採用譯文。';else marked(body,value,title.startsWith('新')?c.baseline.text:other);col.append(body);columns.append(col)}card.append(columns);card.append(el('p','舊欄：'+c.baseline.translatedFragments+' 個已翻片段；'+c.baseline.missingFragments+' 個缺譯；'+c.baseline.excludedFragments+' 個原抽取規則跳過的短片段。','small'));for(const [title,value] of [['新 API 原稿（含受控標記）',c.translation??'未取得。'],['實際送出的英文完整章節（含受控標記）',c.source],['來源證據',JSON.stringify({sourceHash:c.sourceHash,oldRequestIds:c.baseline.requestIds,newRequestId:c.attempt?.requestId,journalFile:c.attempt?.journalFile,accounting:{rawUsage:c.attempt?.rawUsage,usage:c.attempt?.usage,cost:c.attempt?.cost,note:c.attempt?.accountingNote},oldParagraphEvidence:c.baseline.paragraphs},null,2)]]){const d=el('details');d.append(el('summary',title),el('pre',value));card.append(d)}cards.append(card)}document.getElementById('count').textContent='顯示 '+rows.length+'／'+report.chapters.length+' 章。';if(!rows.length)cards.append(el('p','沒有符合條件的結果。'))}
const u=report.summary;document.getElementById('totals').textContent='總 tokens：'+number(u.usage.total.total)+'；已知小計 '+number(u.usage.total.knownSubtotal)+'，'+u.usage.total.unknown+' 次未回報。USD 估算：'+money(u.cost.usd)+'；已知費用小計 $'+u.cost.usd.knownMin.toFixed(6)+'–'+u.cost.usd.knownMax.toFixed(6)+'，'+u.cost.usd.unknown+' 次費用未知。';for(const c of report.chapters){const a=c.attempt,row=el('tr');for(const v of [(a?.ordinal??'—')+' · '+c.title,label(c.state),...['input','cacheRead','output','reasoning','total'].map(k=>number(a?.usage[k])),a?money(a.cost.usd):'—',a?.latencyMs===null||a?.latencyMs===undefined?'—':(a.latencyMs/1000).toFixed(2)])row.append(el('td',v));document.getElementById('usage-rows').append(row)}document.getElementById('metadata').textContent=JSON.stringify({marker:report.marker,config:report.config,baseline:report.baseline,summary:report.summary,history:report.history,notes:report.notes},null,2);
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{view=b.dataset.view;document.querySelectorAll('[data-view]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));render()}));for(const id of ['query','filter','highlight'])document.getElementById(id).addEventListener(id==='query'?'input':'change',render);document.getElementById('download').addEventListener('click',()=>{const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})),a=el('a');a.href=url;a.download='musicmap-chapter-comparison.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)});render();
</script></body></html>`;
}

export async function renderChapterReport({ runDir, baselineDir, registry, attempts, config = {} }) {
  const requestLimit = config.requestLimit ?? 10;
  if (requestLimit !== 10) throw new Error('This chapter pilot has a fixed ten-attempt allowance.');
  const settings = { model: config.model ?? 'deepseek-v4-pro', thinking: config.thinking ?? 'enabled',
    reasoningEffort: config.reasoningEffort ?? 'max', maxTokens: config.maxTokens ?? 32768 };
  if (settings.model !== 'deepseek-v4-pro' || settings.thinking !== 'enabled' || settings.reasoningEffort !== 'max' || settings.maxTokens !== 32768) throw new Error('Unexpected chapter pilot model settings.');
  if (!Array.isArray(registry?.units) || !Array.isArray(attempts)) throw new Error('Registry and attempts are required.');
  if (attempts.some(attempt => attempt.ordinal > requestLimit)) throw new Error('Attempt allowance exceeded.');
  const units = new Map(registry.units.map(unit => [unit.id, unit]));
  if (units.size !== registry.units.length) throw new Error('Duplicate chapter IDs.');
  const aliases = new Map(units);
  for (const unit of registry.units) if (unit.genreId) {
    if (aliases.has(unit.genreId) && aliases.get(unit.genreId) !== unit) throw new Error('Ambiguous chapter alias.');
    aliases.set(unit.genreId, unit);
  }
  const canonicalId = id => {
    const unit = aliases.get(id);
    if (!unit) throw new Error('Selected chapter lacks source evidence.');
    return unit.id;
  };
  const unique = uniqueAttempts(attempts.map(attempt => ({ ...attempt, chapterId: canonicalId(attempt.chapterId) })), requestLimit);
  const rawSelected = config.selectedChapterIds ?? unique.map(attempt => attempt.chapterId);
  if (!Array.isArray(rawSelected)) throw new Error('Invalid selected chapter list.');
  const selected = rawSelected.map(canonicalId);
  if (!Array.isArray(selected) || new Set(selected).size !== selected.length || selected.length > requestLimit) throw new Error('Invalid selected chapter list.');
  for (const attempt of unique) if (!selected.includes(attempt.chapterId)) throw new Error('Attempt is outside the selected pilot chapters.');
  const baseline = await readBaseline(resolve(baselineDir), config.baselineExpectedCount ?? 5809);
  const chapters = selected.map(id => {
    const unit = units.get(id); if (!unit || typeof unit.source !== 'string' || typeof unit.html !== 'string') throw new Error('Selected chapter lacks source evidence.');
    const attempt = unique.find(row => row.chapterId === id) ?? null;
    if (attempt?.source !== null && attempt?.source !== undefined && attempt.source !== unit.source) throw new Error('Attempt source differs from the frozen chapter.');
    const old = baselineChapter(unit, baseline), translation = attempt?.translation ?? null;
    const english = Array.isArray(unit.paragraphs) ? unit.paragraphs.map(paragraph => paragraph.english).join('\n\n') : stripChapterMarkers(unit.source);
    const newText = attempt?.state === 'completed' ? stripChapterMarkers(translation) : null;
    return { id, title: unit.title ?? id, kind: unit.kind, source: unit.source, sourceHash: unit.sourceHash ?? hash(unit.source),
      english, baseline: old, state: attempt?.state ?? 'pending', attempt, translation, newText, different: newText === null ? null : old.text !== newText };
  });
  const report = { schemaVersion: 1, marker: config.marker ?? 'v0.2-pro-max-whole-chapter-pilot', requestLimit,
    config: settings, baseline: baseline.metadata, summary: summarize(unique), history: historyComparison(chapters, baseline), chapters,
    notes: ['新稿按完整章節翻譯；舊稿按原文字節點拼接。', '原始 translation 與 source 完整保存；閱讀欄只移除受控格式標記。',
      '失敗與未知用量保留；reasoning/cacheRead 為子集，沒有重複計費。', '舊請求涵蓋其他片段，不能分攤成精確同章成本。', '報告不自動採用譯文、不更新網站。'] };
  const csv = csvFor(report), outputs = { 'report-data.json': JSON.stringify(report, null, 2) + '\n', 'metrics.csv': csv,
    'report.md': markdownFor(report), 'report.html': htmlFor(report, csv) };
  await mkdir(resolve(runDir), { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries(outputs)) {
    const target = join(resolve(runDir), name), temporary = join(dirname(target), `.${name}.${randomUUID()}.tmp`);
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' }); await rename(temporary, target);
  }
  return { runDir: resolve(runDir), files: Object.keys(outputs), chapters: chapters.length, attempts: unique.length,
    summary: report.summary };
}
