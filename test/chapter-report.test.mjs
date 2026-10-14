import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { renderChapterReport } from '../lib/chapter-report.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const source = "⟦p0⟧A ⟦m0⟧Hello⟦/m0⟧ ⟦m1⟧World⟦/m1⟧'s ⟦m2⟧The⟦/m2⟧.⟦/p0⟧";
const translated = '⟦p0⟧  ⟦m0⟧你好⟦/m0⟧，⟦m1⟧世界⟦/m1⟧的⟦m2⟧那個⟦/m2⟧。\n保留 & < > " 與空白。  ⟦/p0⟧';
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));

async function fixture(t, count = 10) {
  const root = await mkdtemp(join(tmpdir(), 'musicmap-chapter-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const baselineDir = join(root, 'baseline'), runDir = join(root, 'run');
  for (const name of ['generated/shards', 'generated/translation-requests/scope', 'generated/locales']) await mkdir(join(baselineDir, name), { recursive: true });
  const translations = { Hello: '哈囉', World: '世界', The: '这' };
  for (let index = 1; index <= 8; index++) await writeFile(join(baselineDir, `generated/shards/zh-Hans-${index}-of-8.json`), JSON.stringify({
    language: 'zh-Hans', sourceHash: 'frozen-source-v1', translations: index === 1 ? translations : {} }));
  const oldRequest = { requestId: 'old-max-request', type: 'completed', model: 'deepseek-v4-pro', reasoningEffort: 'max',
    textHashes: [hash('Hello'), hash('World')], translations: ['哈囉', '世界'] };
  await writeFile(join(baselineDir, 'generated/translation-requests/scope/old.json'), JSON.stringify(oldRequest));
  await writeFile(join(baselineDir, 'generated/locales/zh-Hans.json'), JSON.stringify({ The: '这' }));
  const registry = { units: Array.from({ length: count }, (_, i) => ({ id: `genre:${i}`, kind: 'genre', title: `Chapter ${i + 1}`, source,
    sourceHash: hash(source), html: "A <b>Hello</b> <a href='#world'>World</a>'s <span>The</span>.",
    paragraphs: [{ id: 'p0', english: "A Hello World's The." }] })) };
  const config = { selectedChapterIds: registry.units.map(unit => unit.id), baselineExpectedCount: 3 };
  return { root, baselineDir, runDir, registry, config, oldRequest };
}

function attempt(ordinal, overrides = {}) {
  return { ordinal, chapterId: `genre:${ordinal - 1}`, state: 'completed', journalFile: `requests/request-${ordinal}.json`,
    requestId: `request-${ordinal}`, source, translation: translated,
    rawUsage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180, prompt_cache_hit_tokens: 20,
      completion_tokens_details: { reasoning_tokens: 60 } },
    cost: { usd: { min: 0.001, max: 0.001 }, cny: { min: 0.006, max: 0.006 } }, latencyMs: 1500, ...overrides };
}

test('chapter report preserves model originals and reconstructs only the Max baseline with traceable omissions', async t => {
  const options = await fixture(t);
  const result = await renderChapterReport({ ...options, attempts: [attempt(1)] });
  assert.equal(result.chapters, 10);
  const data = await readJson(join(options.runDir, 'report-data.json'));
  const chapter = data.chapters[0];
  assert.equal(chapter.translation, translated);
  assert.equal(chapter.source, source);
  assert.equal(chapter.newText, '  你好，世界的那個。\n保留 & < > " 與空白。  ');
  assert.equal(chapter.baseline.text, "A 哈囉 世界's 这.");
  assert.equal(chapter.baseline.translatedFragments, 3);
  assert.equal(chapter.baseline.seedFragments, 1);
  assert.equal(chapter.baseline.unverifiedFragments, 0);
  assert.equal(chapter.baseline.missingFragments, 0);
  assert.equal(chapter.baseline.excludedFragments, 3);
  assert.deepEqual(chapter.baseline.requestIds, ['old-max-request']);
  assert.equal(data.chapters[9].state, 'pending');
  assert.equal(data.chapters[9].translation, null);
  const markdown = await readFile(join(options.runDir, 'report.md'), 'utf8');
  assert.ok(markdown.includes(translated));
  const csv = await readFile(join(options.runDir, 'metrics.csv'), 'utf8');
  assert.ok(csv.includes('"' + translated.replaceAll('"', '""') + '"'));
  assert.match(csv, /translationVerbatim/);
});

test('accounting deduplicates copied journals, includes failures and retains unknown reasoning and spend', async t => {
  const options = await fixture(t), first = attempt(1);
  const failed = attempt(2, { state: 'failed', translation: null, errorCode: 'INVALID_MARKERS', rawUsage: {
    prompt_tokens: 200, completion_tokens: 20, total_tokens: 220, prompt_cache_hit_tokens: 0 }, cost: { usd: { min: 0.002, max: 0.003 } } });
  const unknown = attempt(3, { state: 'unknown', translation: null, rawUsage: null, cost: null, errorCode: 'TIMEOUT' });
  await renderChapterReport({ ...options, attempts: [first, { ...first, journalFile: 'archive/copy.json' }, failed, unknown] });
  const data = await readJson(join(options.runDir, 'report-data.json')), summary = data.summary;
  assert.equal(summary.attempts, 3);
  assert.equal(summary.completed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.unknown, 1);
  assert.deepEqual(summary.usage.total, { total: null, knownSubtotal: 400, reported: 2, unknown: 1 });
  assert.deepEqual(summary.usage.reasoning, { total: null, knownSubtotal: 60, reported: 1, unknown: 2 });
  assert.deepEqual(summary.usage.cacheRead, { total: null, knownSubtotal: 20, reported: 2, unknown: 1 });
  assert.equal(summary.cost.usd.min, null);
  assert.equal(summary.cost.usd.knownMin, 0.003);
  assert.equal(summary.cost.usd.knownMax, 0.004);
  assert.equal(summary.cost.usd.unknown, 1);
  assert.equal(data.chapters[1].attempt.usage.reasoning, null);
});

test('embedded report data escapes HTML and script boundaries while retaining raw failure evidence', async t => {
  const options = await fixture(t);
  const unsafe = '</script><script>globalThis.reportInjection=true</script>\u2028\u2029';
  options.registry.units[0].title = '<img src=x onerror=alert(1)>';
  await renderChapterReport({ ...options, attempts: [attempt(1, { state: 'failed', translation: unsafe, errorCode: unsafe })] });
  const html = await readFile(join(options.runDir, 'report.html'), 'utf8');
  new Script(html.match(/<script>([\s\S]+?)<\/script>/)[1]);
  assert.ok(!html.includes(unsafe));
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
  assert.match(html, /\\u003c\/script>/);
  const embedded = html.match(/<script type="application\/json" id="report-data">([\s\S]+?)<\/script>/)[1];
  assert.equal(JSON.parse(embedded).chapters[0].translation, unsafe);
  assert.equal(JSON.parse(embedded).chapters[0].newText, null);
  assert.match(html, /textContent/);
  assert.doesNotMatch(html, /innerHTML\s*=/);
});

test('report rejects conflicting duplicate attempts, a changed source and an eleventh paid attempt', async t => {
  const options = await fixture(t);
  await assert.rejects(renderChapterReport({ ...options, attempts: [attempt(1), attempt(1, { translation: '⟦p0⟧不同⟦/p0⟧' })] }), /Conflicting duplicate/);
  await assert.rejects(renderChapterReport({ ...options, attempts: [attempt(1, { source: 'changed source' })] }), /source differs/);
  await assert.rejects(renderChapterReport({ ...options, attempts: [attempt(11)] }), /allowance exceeded/);
  await assert.rejects(renderChapterReport({ ...options, attempts: [attempt(1), attempt(2, { chapterId: 'genre:0' })] }), /sent more than once/);
  await assert.rejects(renderChapterReport({ ...options, attempts: [attempt(1)], config: { ...options.config, maxTokens: 1000 } }), /model settings/);
});

test('report refuses the wrong baseline and non-Max journal evidence', async t => {
  const options = await fixture(t);
  await assert.rejects(renderChapterReport({ ...options, attempts: [], config: { ...options.config, baselineExpectedCount: 5809 } }), /Expected 5809/);
  await writeFile(join(options.baselineDir, 'generated/translation-requests/scope/old.json'), JSON.stringify({ ...options.oldRequest, reasoningEffort: 'none' }));
  await assert.rejects(renderChapterReport({ ...options, attempts: [] }), /original Pro Max/);
});

test('report rejects inconsistent totals and never adds cache or reasoning to total tokens', async t => {
  const options = await fixture(t);
  await assert.rejects(renderChapterReport({ ...options, attempts: [attempt(1, { rawUsage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 181 } })] }), /Raw usage total/);
  await renderChapterReport({ ...options, attempts: [attempt(1)] });
  const data = await readJson(join(options.runDir, 'report-data.json'));
  assert.equal(data.summary.usage.total.total, 180);
  assert.equal(data.summary.usage.reasoning.total, 60);
  assert.equal(data.summary.usage.cacheRead.total, 20);
  assert.equal(data.summary.cost.usd.min, 0.001);
});

test('report resolves raw genre codes and canonical chapter IDs without ambiguous aliases', async t => {
  const options = await fixture(t);
  options.registry.units.forEach((unit, index) => { unit.genreId = String(index); });
  options.config.selectedChapterIds = options.registry.units.map(unit => unit.genreId);
  await renderChapterReport({ ...options, attempts: [attempt(1, { chapterId: '0' })] });
  const data = await readJson(join(options.runDir, 'report-data.json'));
  assert.equal(data.chapters[0].id, 'genre:0');
  assert.equal(data.chapters[0].attempt.chapterId, 'genre:0');
  assert.equal(data.chapters[0].translation, translated);
  await assert.rejects(renderChapterReport({ ...options, attempts: [], config: { ...options.config, selectedChapterIds: ['0', 'genre:0'] } }), /Invalid selected chapter list/);
  options.registry.units[1].genreId = '0';
  await assert.rejects(renderChapterReport({ ...options, attempts: [] }), /Ambiguous chapter alias/);
});

test('interrupted reservations consume report allowance without inventing request IDs or zero spend', async t => {
  const options = await fixture(t);
  await renderChapterReport({ ...options, attempts: [
    attempt(1, { state: 'reserved', requestId: null, journalFile: null, translation: null, rawUsage: null, cost: null }),
    attempt(2, { state: 'started', translation: null, rawUsage: null, cost: null }),
  ] });
  const data = await readJson(join(options.runDir, 'report-data.json'));
  assert.equal(data.summary.attempts, 2);
  assert.equal(data.summary.unknown, 2);
  assert.equal(data.summary.cost.usd.min, null);
  assert.equal(data.summary.usage.total.total, null);
  assert.equal(data.chapters[0].state, 'unknown');
  assert.equal(data.chapters[0].attempt.requestId, null);
  assert.equal(data.chapters[0].attempt.reservationState, 'reserved');
  assert.equal(data.chapters[1].attempt.reservationState, 'started');
  const html = await readFile(join(options.runDir, 'report.html'), 'utf8');
  assert.match(html, /已用名額/);
  assert.doesNotMatch(html, /已送出 <strong>/);
});

test('proved pre-send stops keep their slot but report zero API spend distinctly', async t => {
  const options = await fixture(t);
  const stopped = attempt(1, { state: 'not-sent', requestSent: false, rawUsage: null, cost: null, translation: null, errorCode: 'STOP_REQUESTED_BEFORE_SEND' });
  await renderChapterReport({ ...options, attempts: [stopped] });
  const data = await readJson(join(options.runDir, 'report-data.json'));
  assert.equal(data.summary.attempts, 1);
  assert.equal(data.summary.notSent, 1);
  assert.equal(data.summary.unknown, 0);
  assert.equal(data.summary.usage.total.total, 0);
  assert.equal(data.summary.cost.usd.min, 0);
  assert.equal(data.chapters[0].attempt.requestSent, false);
  await assert.rejects(renderChapterReport({ ...options, attempts: [{ ...stopped, requestSent: undefined }] }), /requestSent:false evidence/);
  await assert.rejects(renderChapterReport({ ...options, attempts: [{ ...stopped, rawUsage: attempt(1).rawUsage }] }), /cannot contain billed usage/);
});

test('an explicitly rejected inconsistent usage response remains inspectable and excluded from known sums', async t => {
  const options = await fixture(t), rawUsage = { prompt_tokens: 100, completion_tokens: 80, total_tokens: 181 };
  await renderChapterReport({ ...options, attempts: [attempt(1, { state: 'unknown', rawUsage, translation: null, errorCode: 'INCONSISTENT_USAGE' })] });
  const data = await readJson(join(options.runDir, 'report-data.json'));
  assert.deepEqual(data.chapters[0].attempt.rawUsage, rawUsage);
  assert.equal(data.chapters[0].attempt.usage.total, null);
  assert.match(data.chapters[0].attempt.accountingNote, /互相矛盾/);
  assert.equal(data.summary.usage.total.total, null);
  assert.equal(data.summary.usage.total.knownSubtotal, 0);
  assert.equal(data.summary.cost.usd.min, null);
  assert.equal(data.summary.cost.usd.knownMin, 0);
});

test('historical comparison deduplicates journals and counts whole associated requests including failures', async t => {
  const options = await fixture(t);
  const old = { ...options.oldRequest, sourceCount: 4,
    textHashes: [hash('Hello'), hash('World'), hash('Outside one'), hash('Outside two')], translations: ['哈囉', '世界', '外部一', '外部二'],
    rawUsage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_cache_hit_tokens: 20, completion_tokens_details: { reasoning_tokens: 30 } },
    cost: { usd: { min: 0.001, max: 0.001 } } };
  const failed = { requestId: 'old-failed', type: 'failed', model: 'deepseek-v4-pro', reasoningEffort: 'max', sourceCount: 2,
    textHashes: [hash('Hello'), hash('Outside three')], errorCode: 'INVALID_TRANSLATION',
    rawUsage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70, prompt_cache_hit_tokens: 0 },
    cost: { usd: { min: 0.0004, max: 0.0004 } } };
  const unrelated = { ...options.oldRequest, requestId: 'old-unrelated', sourceCount: 1, textHashes: [hash('Unrelated')], translations: ['無關'],
    rawUsage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, prompt_cache_hit_tokens: 0, completion_tokens_details: { reasoning_tokens: 5 } },
    cost: { usd: { min: 0.0001, max: 0.0001 } } };
  const directory = join(options.baselineDir, 'generated/translation-requests/scope');
  for (const [name, value] of Object.entries({ old, copied: old, failed, unrelated })) await writeFile(join(directory, `${name}.json`), JSON.stringify(value));
  await renderChapterReport({ ...options, attempts: [attempt(1)] });
  const data = await readJson(join(options.runDir, 'report-data.json'));
  const all = data.history.baseline, subset = data.history.selectedChapters;
  assert.equal(all.attempts, 3);
  assert.equal(all.completed, 2);
  assert.equal(all.failed, 1);
  assert.equal(all.sourceCount.total, 7);
  assert.equal(all.usage.total.total, 250);
  assert.equal(all.usage.reasoning.total, null);
  assert.equal(subset.attempts, 2);
  assert.equal(subset.sourceCount.total, 6);
  assert.equal(subset.usage.total.total, 220);
  assert.equal(subset.matchedUniqueSourceCount, 2);
  assert.deepEqual(subset.requestIds, ['old-failed', 'old-max-request']);
  assert.ok(Math.abs(subset.cost.usd.min - 0.0014) < 1e-12);
  assert.equal(subset.cost.cny.min, null);
  assert.equal(subset.requests.find(row => row.requestId === 'old-failed').sourceCount, 2);
  assert.deepEqual(subset.requests.find(row => row.requestId === 'old-failed').matchedSourceHashes, [hash('Hello')]);
  assert.match(subset.note, /沒有分攤成本/);
  const html = await readFile(join(options.runDir, 'report.html'), 'utf8');
  assert.match(html, /id="history-table"/);
  assert.match(html, /範圍不同，不能直接算節省率/);
  assert.match(html, /0\.00140000/);
  const markdown = await readFile(join(options.runDir, 'report.md'), 'utf8');
  assert.match(markdown, /基線歷史整輪/);
  assert.match(markdown, /涉及所選章節的歷史請求/);
});
