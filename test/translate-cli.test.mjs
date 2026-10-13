import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBatches, parseArguments, runTranslation } from '../scripts/translate.mjs';

async function fixture(t, texts) {
  const rootDir = await mkdtemp(join(tmpdir(), 'musicmap-offline-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await mkdir(join(rootDir, '.cache/source'), { recursive: true });
  await writeFile(join(rootDir, '.cache/source/strings.json'), JSON.stringify(texts));
  return rootDir;
}

function fakeApi(seen = []) {
  return async (_url, options) => {
    const request = JSON.parse(options.body);
    const { texts } = JSON.parse(request.messages[1].content);
    const traditional = request.messages[0].content.includes('Traditional Chinese');
    seen.push({ texts, language: traditional ? 'zh-Hant' : 'zh-Hans' });
    return Response.json({ choices: [{
      finish_reason: 'stop',
      message: { content: JSON.stringify({ translations: texts.map((text) => `${traditional ? '繁體' : '简体'}：${text}`) }) },
    }] });
  };
}

async function readJson(rootDir, path) {
  return JSON.parse(await readFile(join(rootDir, path), 'utf8'));
}

test('dry run reports missing counts after normalized dictionary matching and writes nothing', async (t) => {
  const texts = ['  sEaRcH\n', 'Unlisted sentence one.', 'Unlisted sentence two.'];
  const rootDir = await fixture(t, texts);
  const lines = [];
  const result = await runTranslation({ rootDir, dryRun: true, log: (line) => lines.push(line), fetchImpl: () => assert.fail('Paid API call in dry run') });
  assert.equal(result.estimates['zh-Hans'].missing, 2);
  assert.equal(result.estimates['zh-Hant'].characters, texts[1].length + texts[2].length);
  assert.equal(result.status.sourceHash, createHash('sha256').update(JSON.stringify(texts)).digest('hex'));
  assert.equal(result.status.languages['zh-Hant'].complete, false);
  assert.ok(lines.some((line) => line.includes('DRY RUN')));
  await assert.rejects(readFile(join(rootDir, 'generated/translation-status.json')), { code: 'ENOENT' });
});

test('a global smoke limit persists honest partial status and a later run resumes missing work', async (t) => {
  const texts = ['Search', 'Unlisted sentence one.', 'Unlisted sentence two.'];
  const rootDir = await fixture(t, texts);
  const seen = [];
  const settings = { rootDir, apiKey: 'test-secret', fetchImpl: fakeApi(seen), log: () => {} };
  const partial = await runTranslation({ ...settings, limit: 1 });
  assert.equal(partial.processed, 1);
  assert.deepEqual(partial.status.languages['zh-Hans'], { translated: 2, total: 3, complete: false });
  assert.deepEqual(partial.status.languages['zh-Hant'], { translated: 1, total: 3, complete: false });
  assert.deepEqual(seen, [{ texts: [texts[1]], language: 'zh-Hans' }]);
  assert.equal((await readJson(rootDir, 'generated/locales/zh-Hant.json')).Search, '搜尋');

  seen.length = 0;
  const completed = await runTranslation(settings);
  assert.equal(completed.processed, 3);
  assert.equal(completed.status.languages['zh-Hans'].complete, true);
  assert.equal(completed.status.languages['zh-Hant'].complete, true);
  assert.deepEqual(seen, [
    { texts: [texts[2]], language: 'zh-Hans' },
    { texts: [texts[1], texts[2]], language: 'zh-Hant' },
  ]);
  assert.deepEqual(await readJson(rootDir, 'generated/translation-status.json'), completed.status);

  // If an export is removed, validated translator cache can rebuild it without a key or API calls.
  await rm(join(rootDir, 'generated/locales/zh-Hans.json'));
  await rm(join(rootDir, 'generated/locales/zh-Hant.json'));
  const restored = await runTranslation({ rootDir, apiKey: '', log: () => {}, fetchImpl: () => assert.fail('Cache restore called API') });
  assert.equal(restored.status.languages['zh-Hans'].complete, true);
  assert.equal(restored.status.languages['zh-Hant'].complete, true);
});

test('missing credentials fail after estimates and save only dictionary coverage', async (t) => {
  const rootDir = await fixture(t, ['Search', 'A longer untranslated description.']);
  const lines = [];
  await assert.rejects(runTranslation({
    rootDir, apiKey: '', log: (line) => lines.push(line), fetchImpl: () => assert.fail('Missing key called API'),
  }), { code: 'API_KEY_MISSING' });
  assert.ok(lines.some((line) => line.includes('1 missing texts')));
  const status = await readJson(rootDir, 'generated/translation-status.json');
  assert.deepEqual(status.languages['zh-Hans'], { translated: 1, total: 2, complete: false });
  assert.deepEqual(status.languages['zh-Hant'], { translated: 1, total: 2, complete: false });
  assert.deepEqual(await readJson(rootDir, 'generated/locales/zh-Hans.json'), { Search: '搜索' });
});

test('an interrupted later batch preserves earlier exports for the next run', async (t) => {
  const texts = Array.from({ length: 25 }, (_, index) => `Unique source paragraph number ${index}.`);
  const rootDir = await fixture(t, texts);
  let attempts = 0;
  const api = fakeApi();
  await assert.rejects(runTranslation({
    rootDir, languages: ['zh-Hant'], apiKey: 'test', log: () => {},
    fetchImpl: async (...args) => ++attempts === 1 ? api(...args) : new Response('', { status: 503, headers: { 'Retry-After': '0' } }),
  }), { code: 'UPSTREAM_ERROR' });
  const status = await readJson(rootDir, 'generated/translation-status.json');
  assert.deepEqual(status.languages['zh-Hant'], { translated: 20, total: 25, complete: false });
  assert.equal(Object.keys(await readJson(rootDir, 'generated/locales/zh-Hant.json')).length, 20);
  const seen = [];
  const result = await runTranslation({ rootDir, languages: ['zh-Hant'], apiKey: 'test', fetchImpl: fakeApi(seen), log: () => {} });
  assert.deepEqual(seen, [{ texts: texts.slice(20), language: 'zh-Hant' }]);
  assert.equal(result.status.languages['zh-Hant'].complete, true);
  assert.equal(result.status.languages['zh-Hans'].complete, false);
});

test('changed source recomputes coverage and reuses only exact matching source keys', async (t) => {
  const rootDir = await fixture(t, ['Search', 'Original paragraph.']);
  const initial = await runTranslation({ rootDir, apiKey: 'test', fetchImpl: fakeApi(), log: () => {} });
  await writeFile(join(rootDir, '.cache/source/strings.json'), JSON.stringify(['Search', 'Original paragraph.', 'New paragraph.']));
  const updated = await runTranslation({ rootDir, limit: 0, apiKey: '', log: () => {}, fetchImpl: () => assert.fail('Limit zero called API') });
  assert.notEqual(updated.status.sourceHash, initial.status.sourceHash);
  assert.deepEqual(updated.status.languages['zh-Hant'], { translated: 2, total: 3, complete: false });
});

test('batches respect both 20-text and 14000-character limits without dropping texts', () => {
  const texts = [...Array(25).fill('short'), ...Array(8).fill('x'.repeat(5000))];
  const batches = makeBatches(texts);
  assert.deepEqual(batches.flat(), texts);
  for (const batch of batches) {
    assert.ok(batch.length <= 20);
    assert.ok(batch.reduce((sum, text) => sum + text.length, 0) <= 14_000);
  }
});

test('invalid source entries are rejected before exports or API requests', async (t) => {
  for (const texts of [[null], ['x'.repeat(5001)], { text: 'not an array' }]) {
    const rootDir = await fixture(t, texts);
    await assert.rejects(runTranslation({ rootDir, log: () => {}, fetchImpl: () => assert.fail('Invalid input called API') }), /Source string/);
    await assert.rejects(readFile(join(rootDir, 'generated/translation-status.json')), { code: 'ENOENT' });
  }
});

test('command line arguments reject invalid language and ambiguous limits', () => {
  assert.deepEqual(parseArguments(['--language', 'zh-Hant', '--limit=3', '--dry-run']), { languages: ['zh-Hant'], limit: 3, dryRun: true });
  for (const args of [['--language', 'en'], ['--language'], ['--limit'], ['--limit=-1'], ['--limit', '1.5'], ['--wat']]) {
    assert.throws(() => parseArguments(args));
  }
});
