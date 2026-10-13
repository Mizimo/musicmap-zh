import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBatches, parseArguments, runTranslation } from '../scripts/translate.mjs';

async function fixture(t, texts) {
  const rootDir = await mkdtemp(join(tmpdir(), 'musicmap-offline-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await mkdir(join(rootDir, '.cache/source'), { recursive: true });
  await writeFile(join(rootDir, '.cache/source/strings.json'), JSON.stringify(texts));
  await mkdir(join(rootDir, 'generated/site'), { recursive: true });
  await writeFile(join(rootDir, 'generated/site/index.html'), '');
  await writeFile(join(rootDir, 'generated/site/master-genrelist.json'), '{}');
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
  assert.equal(result.estimates['zh-Hans'].characters, texts[1].length + texts[2].length);
  assert.equal(result.estimates['zh-Hant'], undefined);
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
  assert.deepEqual(partial.status.languages['zh-Hant'], { translated: 0, total: 3, complete: false, derived: true });
  assert.deepEqual(seen, [{ texts: [texts[1]], language: 'zh-Hans' }]);
  await assert.rejects(readFile(join(rootDir, 'generated/locales/zh-Hant.json')), { code: 'ENOENT' });

  seen.length = 0;
  const completed = await runTranslation(settings);
  assert.equal(completed.processed, 1);
  assert.equal(completed.status.languages['zh-Hans'].complete, true);
  assert.equal(completed.status.languages['zh-Hant'].complete, false);
  assert.deepEqual(seen, [
    { texts: [texts[2]], language: 'zh-Hans' },
  ]);
  assert.deepEqual(await readJson(rootDir, 'generated/translation-status.json'), completed.status);

  // If an export is removed, validated translator cache can rebuild it without a key or API calls.
  await rm(join(rootDir, 'generated/locales/zh-Hans.json'));
  const cacheOnly = { rootDir, apiKey: '', log: () => {}, fetchImpl: () => assert.fail('Cache restore called API') };
  const limited = await runTranslation({ ...cacheOnly, limit: 1 });
  assert.equal(limited.processed, 1, 'cache hits count toward the export limit');
  assert.equal(limited.status.languages['zh-Hans'].complete, false);
  const restored = await runTranslation(cacheOnly);
  assert.equal(restored.status.languages['zh-Hans'].complete, true);
  assert.equal(restored.status.languages['zh-Hant'].complete, false);
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
  assert.deepEqual(status.languages['zh-Hant'], { translated: 0, total: 2, complete: false, derived: true });
  assert.deepEqual(await readJson(rootDir, 'generated/locales/zh-Hans.json'), { Search: '搜索' });
});

test('an interrupted later batch preserves earlier exports for the next run', async (t) => {
  const texts = Array.from({ length: 25 }, (_, index) => `Unique source paragraph number ${index}.`);
  const rootDir = await fixture(t, texts);
  let attempts = 0;
  const api = fakeApi();
  await assert.rejects(runTranslation({
    rootDir, languages: ['zh-Hans'], apiKey: 'test', log: () => {},
    fetchImpl: async (...args) => ++attempts === 1 ? api(...args) : new Response('', { status: 503, headers: { 'Retry-After': '0' } }),
  }), { code: 'UPSTREAM_ERROR' });
  const status = await readJson(rootDir, 'generated/translation-status.json');
  assert.deepEqual(status.languages['zh-Hans'], { translated: 20, total: 25, complete: false });
  assert.equal(Object.keys(await readJson(rootDir, 'generated/locales/zh-Hans.json')).length, 20);
  const seen = [];
  await assert.rejects(runTranslation({ rootDir, languages: ['zh-Hans'], apiKey: 'test', fetchImpl: fakeApi(seen), log: () => {} }), /require review/);
  const result = await runTranslation({ rootDir, languages: ['zh-Hans'], apiKey: 'test', retryFailed: true, fetchImpl: fakeApi(seen), log: () => {} });
  assert.deepEqual(seen, [{ texts: texts.slice(20), language: 'zh-Hans' }]);
  assert.equal(result.status.languages['zh-Hans'].complete, true);
  assert.equal(result.status.languages['zh-Hant'].complete, false);
});

test('changed source recomputes coverage and reuses only exact matching source keys', async (t) => {
  const rootDir = await fixture(t, ['Search', 'Original paragraph.']);
  const initial = await runTranslation({ rootDir, apiKey: 'test', fetchImpl: fakeApi(), log: () => {} });
  await writeFile(join(rootDir, '.cache/source/strings.json'), JSON.stringify(['Search', 'Original paragraph.', 'New paragraph.']));
  const updated = await runTranslation({ rootDir, limit: 0, apiKey: '', log: () => {}, fetchImpl: () => assert.fail('Limit zero called API') });
  assert.notEqual(updated.status.sourceHash, initial.status.sourceHash);
  assert.deepEqual(updated.status.languages['zh-Hans'], { translated: 2, total: 3, complete: false });
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
  assert.deepEqual(parseArguments(['--language', 'zh-Hans', '--limit=3', '--dry-run']), { languages: ['zh-Hans'], limit: 3, dryRun: true });
  for (const args of [['--language', 'en'], ['--language'], ['--limit'], ['--limit=-1'], ['--limit', '1.5'], ['--wat']]) {
    assert.throws(() => parseArguments(args));
  }
});

test('Traditional Chinese is rejected before any paid request and directs users to local conversion', async (t) => {
  const rootDir = await fixture(t, ['Untranslated source text.']);
  for (const languages of [['zh-Hant'], ['zh-Hans', 'zh-Hant']]) {
    await assert.rejects(runTranslation({
      rootDir, languages, apiKey: 'test', log: () => {}, fetchImpl: () => assert.fail('Traditional API translation must never run'),
    }), /npm run convert/);
  }
  assert.throws(() => parseArguments(['--language', 'zh-Hant']), /npm run convert/);
  assert.throws(() => parseArguments(['--language=zh-Hant', '--dry-run']), /npm run convert/);
  await assert.rejects(readFile(join(rootDir, 'generated/translation-status.json')), { code: 'ENOENT' });
});

test('Simplified completion leaves existing Traditional output untouched and reports derived coverage', async (t) => {
  const rootDir = await fixture(t, ['Search', 'A unique sentence.']);
  await mkdir(join(rootDir, 'generated/locales'), { recursive: true });
  const traditional = { Search: '搜尋' };
  await writeFile(join(rootDir, 'generated/locales/zh-Hant.json'), JSON.stringify(traditional));
  const lines = [];
  const seen = [];
  const result = await runTranslation({ rootDir, apiKey: 'test', fetchImpl: fakeApi(seen), log: (line) => lines.push(line) });
  assert.equal(result.status.languages['zh-Hans'].complete, true);
  assert.deepEqual(result.status.languages['zh-Hant'], { translated: 1, total: 2, complete: false, derived: true });
  assert.ok(seen.every((request) => request.language === 'zh-Hans'));
  assert.match(lines.at(-1), /^COMPLETE for zh-Hans/);
  assert.match(lines.at(-1), /npm run convert/);
  assert.deepEqual(await readJson(rootDir, 'generated/locales/zh-Hant.json'), traditional);
});

test('exact normalized terminology aliases precede dictionary defaults without rewriting completed exports', async (t) => {
  const rootDir = await fixture(t, ['TECHNO', '  rhythm & blues\n', 'An already translated paragraph.']);
  await mkdir(join(rootDir, 'generated/locales'), { recursive: true });
  await writeFile(join(rootDir, 'generated/locales/zh-Hans.json'), JSON.stringify({ 'An already translated paragraph.': '已有译文。' }));
  const settings = { rootDir, apiKey: '', log: () => {}, fetchImpl: () => assert.fail('Terminology prefill called API') };
  const result = await runTranslation(settings);
  assert.equal(result.processed, 0);
  assert.deepEqual(await readJson(rootDir, 'generated/locales/zh-Hans.json'), {
    'An already translated paragraph.': '已有译文。', TECHNO: '科技舞曲', '  rhythm & blues\n': '节奏布鲁斯',
  });
  await writeFile(join(rootDir, 'generated/locales/zh-Hans.json'), JSON.stringify({ TECHNO: '既有人工核准术语', '  rhythm & blues\n': '既有节奏布鲁斯', 'An already translated paragraph.': '已有译文。' }));
  await runTranslation(settings);
  assert.equal((await readJson(rootDir, 'generated/locales/zh-Hans.json')).TECHNO, '既有人工核准术语');
});

test('production CLI uses the dedicated key, explicit max effort, reference context, and recoverable paid output', async t => {
  const text = 'A genre grew from';
  const rootDir = await fixture(t, [text]);
  await writeFile(join(rootDir, 'generated/site/index.html'), `<p>${text} <a>older forms</a> in 1975.</p>`);
  const apiKeyFile = join(rootDir, 'dedicated-key');
  await writeFile(apiKeyFile, 'sk-dedicated-test\n');
  let calls = 0;
  const settings = { rootDir, apiKey: 'sk-old-test', apiKeyFile, log: () => {}, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(options.headers.Authorization, 'Bearer sk-dedicated-test');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'deepseek-v4-pro');
    assert.deepEqual(body.thinking, { type: 'enabled' });
    assert.equal(body.reasoning_effort, 'max');
    assert.equal(body.max_tokens, 32768);
    assert.match(JSON.parse(body.messages[1].content).contexts[0], /older forms.*1975/);
    return fakeApi()(url, options);
  } };
  await runTranslation(settings);
  assert.equal(calls, 1);
  const files = await readdir(join(rootDir, 'generated/translation-requests/zh-Hans'));
  const record = await readJson(rootDir, `generated/translation-requests/zh-Hans/${files[0]}`);
  assert.equal(record.type, 'completed');
  assert.equal(record.rawUsage, null);
  assert.equal(record.cost, null);
  assert.ok(!JSON.stringify(record).includes('sk-dedicated-test'));
  await rm(join(rootDir, '.cache/translations'), { recursive: true });
  await rm(join(rootDir, 'generated/locales/zh-Hans.json'));
  const recovered = await runTranslation({ ...settings, apiKey: '', apiKeyFile: undefined, fetchImpl: () => assert.fail('Recovered paid output must not be purchased again') });
  assert.equal(recovered.processed, 1);
  assert.equal(recovered.status.languages['zh-Hans'].complete, true);
});

test('graceful stop saves the active batch without purchasing the next batch', async t => {
  const texts = Array.from({ length: 25 }, (_, index) => `Stop-safe paragraph ${index}.`);
  const rootDir = await fixture(t, texts);
  let stopping = false;
  let calls = 0;
  const result = await runTranslation({ rootDir, apiKey: 'test', log: () => {}, shouldStop: () => stopping,
    fetchImpl: async (...args) => { calls++; stopping = true; return fakeApi()(...args); } });
  assert.equal(calls, 1);
  assert.equal(result.processed, 20);
  assert.equal(result.interrupted, true);
  assert.equal(result.status.languages['zh-Hans'].complete, false);
  assert.equal(Object.keys(await readJson(rootDir, 'generated/locales/zh-Hans.json')).length, 20);
});
