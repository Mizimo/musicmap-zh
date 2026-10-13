import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateReport } from '../scripts/benchmark-report.mjs';

async function fixture(t, configurations) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'musicmap-benchmark-report-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'results'));
  const manifest = { id: 'report-test', configurations, passages: [{ id: 'sample', text: 'Music sample.' }] };
  const saveManifest = () => fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  await saveManifest();
  return { directory, manifest, saveManifest };
}

const config = (id, effort = 'low') => ({ id, provider: 'codex', model: 'gpt-6-astra', effort });
const json = async (directory, name) => JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));

test('supplemental configurations append anonymous labels without changing prior assignments', async (t) => {
  const { directory, manifest, saveManifest } = await fixture(t, Array.from({ length: 15 }, (_, index) => config(`initial-${index}`)));
  await generateReport(directory);
  const initial = await json(directory, 'anonymous-labels.json');
  manifest.configurations.push(...['xhigh', 'ultra', 'max'].map((effort) => config(`astra-${effort}`, effort)));
  manifest.configurationExtensions = [{ recordedAt: '2026-10-13T12:00:00Z', configurations: ['astra-xhigh', 'astra-ultra', 'astra-max'], previousManifestSha256: 'original-snapshot' }];
  await saveManifest();
  assert.equal((await generateReport(directory)).configurations, 18);
  const extended = await json(directory, 'anonymous-labels.json');
  assert.equal(extended.seed, initial.seed);
  assert.deepEqual(extended.assignments.slice(0, 15), initial.assignments);
  assert.deepEqual(extended.assignments.slice(15).map((row) => row.label), ['P', 'Q', 'R']);
  assert.deepEqual(new Set(extended.assignments.slice(15).map((row) => row.id)), new Set(['astra-xhigh', 'astra-ultra', 'astra-max']));
  await generateReport(directory);
  assert.deepEqual(await json(directory, 'anonymous-labels.json'), extended);
  const html = await fs.readFile(path.join(directory, 'report.html'), 'utf8');
  const note = html.match(/<p id="supplementation-note" class="muted">([^<]+)<\/p>/)[1];
  assert.match(note, /沿用原輪的英文片段、Prompt、術語表與價格/);
  assert.doesNotMatch(note, /astra|xhigh|ultra|max/);
  const data = JSON.parse(html.match(/<script type="application\/json" id="report-data">([\s\S]+?)<\/script>/)[1]);
  assert.deepEqual(data.configurationExtensions, manifest.configurationExtensions);
  const markdown = await fs.readFile(path.join(directory, 'report.md'), 'utf8');
  assert.ok(markdown.includes(note));
  assert.match(markdown, /original-snapshot/);
});

test('removing a previously labelled configuration is rejected without rewriting the labels', async (t) => {
  const { directory, manifest, saveManifest } = await fixture(t, [config('first'), config('second')]);
  await generateReport(directory);
  const original = await fs.readFile(path.join(directory, 'anonymous-labels.json'), 'utf8');
  manifest.configurations.pop();
  await saveManifest();
  await assert.rejects(generateReport(directory), /Existing anonymous-labels/);
  assert.equal(await fs.readFile(path.join(directory, 'anonymous-labels.json'), 'utf8'), original);
});

test('reports retain rejected efforts, unknown usage, and request/response mismatches', async (t) => {
  const { directory } = await fixture(t, [config('astra-xhigh', 'xhigh'), config('astra-ultra', 'ultra')]);
  const originalText = ' 音乐\n\n节奏（Rhythm）。 ';
  await fs.writeFile(path.join(directory, 'results/astra-xhigh.json'), JSON.stringify({
    id: 'astra-xhigh', status: 'success', returnedModel: 'gpt-6-astra', returnedEffort: 'high',
    translations: [{ id: 'sample', text: originalText }], rawUsage: { input_tokens: 10, output_tokens: 20 },
    usage: { input: 10, output: 20, total: 30 }, cost: { usd: { min: 0.0011, max: 0.0011 } },
  }));
  await fs.writeFile(path.join(directory, 'results/astra-ultra.json'), JSON.stringify({
    id: 'astra-ultra', status: 'error', error: 'REASONING_EFFORT_REJECTED', httpStatus: 400, startedAt: '2026-10-13T12:00:00Z',
  }));
  await generateReport(directory);
  const html = await fs.readFile(path.join(directory, 'report.html'), 'utf8');
  const data = JSON.parse(html.match(/<script type="application\/json" id="report-data">([\s\S]+?)<\/script>/)[1]);
  const mismatch = data.results.find((row) => row.id === 'astra-xhigh');
  const failure = data.results.find((row) => row.id === 'astra-ultra');
  assert.equal(mismatch.effort, 'xhigh');
  assert.equal(mismatch.returnedEffort, 'high');
  assert.equal(mismatch.responseMismatch, true);
  assert.equal(mismatch.translations[0].text, originalText);
  assert.equal(failure.effort, 'ultra');
  assert.equal(failure.error, 'REASONING_EFFORT_REJECTED');
  assert.equal(failure.httpStatus, 400);
  assert.equal(failure.failureNote, '後端拒絕此推理檔位（HTTP 400）；未取得譯文，用量未回傳。');
  assert.equal(failure.status, 'error');
  assert.deepEqual(failure.translations, []);
  assert.equal(failure.cost.usd.min, null);
  assert.equal(failure.usage.total, null);
  assert.equal(data.attemptSummary.total, 2);
  assert.equal(data.attemptSummary.failed, 1);
  assert.equal(data.attemptSummary.unknownSpend, 1);
  const markdown = await fs.readFile(path.join(directory, 'report.md'), 'utf8');
  assert.match(markdown, /回傳設定與請求不一致/);
  assert.ok(markdown.includes(failure.failureNote));
  const csv = await fs.readFile(path.join(directory, 'metrics.csv'), 'utf8');
  assert.match(csv, /"responseMismatch"/);
  assert.match(csv, /"REASONING_EFFORT_REJECTED"/);
});
